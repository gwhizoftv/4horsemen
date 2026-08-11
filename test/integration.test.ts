import { existsSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { readCompletion } from "../src/action.js";
import { finalize, runTick } from "../src/runLoop.js";
import { activeAgents, readJournal, saveCursors } from "../src/state.js";
import { computeInputSetHash } from "../src/protocol.js";
import { createWorkspace, joinSignal, loopDeps, validPlan, type Workspace } from "./harness.js";

/**
 * Four-agent canary.
 *
 * Real bare origin, real per-agent clones, real mirror, real Git evidence, a
 * control root outside every clone, and fake harnesses. It walks the whole
 * workflow: start, action delivery, exact-SHA completion, dropping one
 * unavailable agent, actions that omit it, gate advancement, one revision
 * round, consensus, and finalization without a merge.
 */

const workspaces: Workspace[] = [];

const newWorkspace = (...args: Parameters<typeof createWorkspace>): Workspace => {
  const workspace = createWorkspace(...args);

  workspaces.push(workspace);

  return workspace;
};

afterEach(() => {
  while (workspaces.length > 0) {
    workspaces.pop()?.cleanup();
  }
});

const envelope = (workspace: Workspace, agent: string): Record<string, unknown> => ({
  issue: 1,
  issueSessionId: workspace.state.start.issueSessionId,
  agent,
  createdAt: "2026-08-11T01:30:00Z"
});

describe("four-agent canary", () => {
  it("runs join through finalization, dropping one agent on the way", () => {
    const workspace = newWorkspace({
      finalChecks: [{ argv: ["pnpm", "install", "--frozen-lockfile"] }, { argv: ["pnpm", "check"] }],
      prPolicy: "coord-open-unmerged"
    });
    const deps = loopDeps(workspace);
    const roster = workspace.state.start.originalRoster;
    const state = workspace.state;

    /* ---------------------------------------------------------------- */
    /* Gate 1 — join                                                     */
    /* ---------------------------------------------------------------- */

    runTick(state, deps);

    for (const agent of roster) {
      expect(existsSync(state.paths.actionFile(agent))).toBe(true);
    }

    // An intermediate push that is not the required artifact must not count,
    // and neither must branch-tip movement on its own.
    workspace.publish("claude", "work in progress", { "notes.md": "thinking\n" });
    runTick(state, deps);

    expect(state.cursors.agents["claude"]?.satisfied).not.toContain("R1.join");

    for (const agent of roster) {
      const sha = workspace.publish(agent, "join", {
        [`.signals/issue-1/joined-${agent}.json`]: joinSignal(workspace, agent)
      });

      workspace.submit(agent, sha);
    }

    runTick(state, deps);

    expect(state.cursors.issueCursor.gateId).toBe("gate-2-plans");

    /* ---------------------------------------------------------------- */
    /* Gate 2 — plans, with one agent going unavailable                  */
    /* ---------------------------------------------------------------- */

    const planShas: Record<string, string> = {};

    for (const agent of roster) {
      if (agent === "antigravity") {
        // Unavailable: publishes nothing and submits nothing, ever.
        continue;
      }

      planShas[agent] = workspace.publish(agent, "plan", { ".plans/issue-1/plan.md": validPlan });
      workspace.submit(agent, planShas[agent] as string);
    }

    runTick(state, deps);

    // The shared gate waits indefinitely for the missing agent. Repeated ticks
    // never advance it and never drop anyone.
    for (let tick = 0; tick < 5; tick += 1) {
      runTick(state, deps);
    }

    expect(state.cursors.issueCursor.gateId).toBe("gate-2-plans");
    expect(state.cursors.droppedAgents).toEqual([]);
    expect(existsSync(state.paths.actionFile("antigravity"))).toBe(true);

    // The owner drops the unavailable agent. One local state change.
    state.cursors = { ...state.cursors, droppedAgents: ["antigravity"] };
    saveCursors(state, "2026-08-11T05:00:00Z");
    runTick(state, deps);

    expect(state.cursors.issueCursor.gateId).toBe("gate-3-selection");
    expect(activeAgents(state.start, state.cursors)).toEqual(["claude", "codex", "cursor"]);

    /* ---------------------------------------------------------------- */
    /* Gate 3 — reviews and ballots that omit the dropped agent          */
    /* ---------------------------------------------------------------- */

    const reviewAction = readFileSync(state.paths.actionFile("claude"), "utf8");

    expect(reviewAction).toContain(planShas["codex"] as string);
    expect(reviewAction).toContain(planShas["cursor"] as string);
    // A's work is ineligible as an input, and no drop is announced.
    expect(reviewAction).not.toContain("antigravity");
    expect(reviewAction).not.toMatch(/dropped|removed|no longer/i);

    for (const agent of ["claude", "codex", "cursor"]) {
      const sha = workspace.publish(agent, "review", {
        [`.plans/issue-1/review-${agent}.md`]: "## Findings\n\nlooks reasonable\n\n## Conclusion\n\nproceed\n"
      });

      workspace.submit(agent, sha);
    }

    runTick(state, deps);

    const citations = ["claude", "codex", "cursor"].map((agent) => ({
      agent,
      path: ".plans/issue-1/plan.md",
      commitSha: planShas[agent] as string
    }));

    for (const agent of ["claude", "codex", "cursor"]) {
      const sha = workspace.publish(agent, "ballot", {
        [`.plans/issue-1/ballot-${agent}.json`]: JSON.stringify({
          ...envelope(workspace, agent),
          inputSetHash: computeInputSetHash(citations),
          citations,
          choice: "claude",
          rationale: "clearest file map"
        })
      });

      workspace.submit(agent, sha);
    }

    runTick(state, deps);

    expect(state.cursors.issueCursor.gateId).toBe("gate-4-implementation");
    expect(state.cursors.selected).not.toBeNull();

    /* ---------------------------------------------------------------- */
    /* Gate 4 — implementation, with a rejected submission first         */
    /* ---------------------------------------------------------------- */

    const implementations: Record<string, string> = {};

    for (const agent of ["claude", "codex", "cursor"]) {
      implementations[agent] = workspace.publish(agent, "implementation", {
        "src/feature.ts": `export const feature = "${agent}";\n`
      });
    }

    // A signal naming a pin that is not on origin must be rejected, the
    // completion cleared, and the same action reissued with concrete detail.
    const badSignal = workspace.publish("codex", "signal with an unpublished pin", {
      ".signals/issue-1/implementation-ready-codex.json": JSON.stringify({
        ...envelope(workspace, "codex"),
        baselineSha: workspace.baselineSha,
        implementationCommitSha: "0".repeat(40)
      })
    });

    workspace.submit("codex", badSignal);
    runTick(state, deps);

    expect(state.cursors.agents["codex"]?.satisfied).not.toContain("R4.implement");
    expect(readCompletion(state.paths.completeFile("codex")).ok).toBe(false);
    expect(state.cursors.agents["codex"]?.attempt).toBe(2);

    const reissued = readFileSync(state.paths.actionFile("codex"), "utf8");

    expect(reissued).toContain("did not satisfy this action");
    expect(reissued).toContain("not present on origin");

    for (const agent of ["claude", "codex", "cursor"]) {
      const sha = workspace.publish(agent, "implementation signal", {
        [`.signals/issue-1/implementation-ready-${agent}.json`]: JSON.stringify({
          ...envelope(workspace, agent),
          baselineSha: workspace.baselineSha,
          implementationCommitSha: implementations[agent] as string
        })
      });

      workspace.submit(agent, sha);
    }

    runTick(state, deps);

    expect(state.cursors.issueCursor.gateId).toBe("gate-5-comparison");

    /* ---------------------------------------------------------------- */
    /* Gate 5 — comparison and ballots                                   */
    /* ---------------------------------------------------------------- */

    for (const agent of ["claude", "codex", "cursor"]) {
      const sha = workspace.publish(agent, "comparison", {
        [`.code-reviews/issue-1/comparison-${agent}.md`]:
          "## Comparison\n\nall three build\n\n## Conclusion\n\ntake claude's\n"
      });

      workspace.submit(agent, sha);
    }

    runTick(state, deps);

    const implementationCitations = ["claude", "codex", "cursor"].map((agent) => ({
      agent,
      path: `.signals/issue-1/implementation-ready-${agent}.json`,
      commitSha: state.cursors.agents[agent]?.published["R4.implement"] as string
    }));
    const pins = Object.fromEntries(
      implementationCitations.map((citation) => [citation.agent, citation.commitSha])
    );

    for (const agent of ["claude", "codex", "cursor"]) {
      const sha = workspace.publish(agent, "comparison ballot", {
        [`.code-reviews/issue-1/comparison-ballot-${agent}.json`]: JSON.stringify({
          ...envelope(workspace, agent),
          inputSetHash: computeInputSetHash(implementationCitations),
          pins,
          choice: "claude",
          rationale: "cleanest"
        })
      });

      workspace.submit(agent, sha);
    }

    runTick(state, deps);

    expect(state.cursors.issueCursor.gateId).toBe("gate-6-consensus");
    expect(state.cursors.issueCursor.round).toBe(1);

    /* ---------------------------------------------------------------- */
    /* Gate 6 — one revision round, then consensus                       */
    /* ---------------------------------------------------------------- */

    const reviser = state.cursors.selected;

    expect(reviser).not.toBeNull();

    const basePin = state.cursors.agents[reviser as string]?.published["R4.implement"] as string;
    const revisionPin = workspace.publish(reviser as string, "revision", {
      "src/feature.ts": "export const feature = \"revised\";\n"
    });
    const revisionSignal = workspace.publish(reviser as string, "revision signal", {
      [`.signals/issue-1/revision-ready-${reviser as string}.json`]: JSON.stringify({
        ...envelope(workspace, reviser as string),
        round: 1,
        basePin,
        revisionCommitSha: revisionPin
      })
    });

    workspace.submit(reviser as string, revisionSignal);
    runTick(state, deps);

    expect(state.cursors.agents[reviser as string]?.satisfied).toContain("R6.revise");

    for (const agent of ["claude", "codex", "cursor"]) {
      const sha = workspace.publish(agent, "consensus ballot", {
        [`.code-reviews/issue-1/consensus-ballot-${agent}.json`]: JSON.stringify({
          ...envelope(workspace, agent),
          round: 1,
          pin: revisionSignal,
          disposition: "approve",
          rationale: "revision addresses the feedback"
        })
      });

      workspace.submit(agent, sha);
    }

    const result = runTick(state, deps);

    expect(state.cursors.issueCursor.gateId).toBe("gate-7-finalized");
    expect(result.decisions.some((decision) => decision.kind === "finalize")).toBe(true);

    /* ---------------------------------------------------------------- */
    /* Gate 7 — finalization without a merge                             */
    /* ---------------------------------------------------------------- */

    let opened = 0;
    const finalizeDeps = loopDeps(workspace, {
      openPullRequest: () => {
        opened += 1;

        return { ok: true, detail: "opened" };
      }
    });
    const outcome = finalize(state, finalizeDeps);

    expect(outcome.ok).toBe(true);
    expect(outcome.checks.map((check) => check.argv.join(" "))).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm check"
    ]);
    expect(outcome.prOpened).toBe(true);
    expect(opened).toBe(1);

    /* ---------------------------------------------------------------- */
    /* The record                                                        */
    /* ---------------------------------------------------------------- */

    const journal = readJournal(state.paths.journal);
    const kinds = new Set(journal.map((event) => event.kind));

    expect(kinds.has("action-prepared")).toBe(true);
    expect(kinds.has("verify-result")).toBe(true);
    expect(kinds.has("gate-advanced")).toBe(true);
    expect(kinds.has("check-result")).toBe(true);
    expect(kinds.has("finalized")).toBe(true);

    // The dropped agent keeps the gate it completed before the drop —
    // completed history is never recomputed — but satisfied nothing after it
    // and was never ordered again.
    expect(state.cursors.agents["antigravity"]?.satisfied).toEqual(["R1.join"]);
    expect(state.cursors.agents["antigravity"]?.published["R2.plan"]).toBeUndefined();

    const antigravityOrders = journal.filter(
      (event) => event.kind === "action-prepared" && event.agent === "antigravity"
    );
    const lastOrder = antigravityOrders.at(-1);

    expect(lastOrder?.detail["stepId"]).toBe("R2.plan");

    // No completion file is left behind anywhere.
    for (const agent of roster) {
      expect(readCompletion(state.paths.completeFile(agent)).ok).toBe(false);
    }
  });

  it("refuses to finalize when a configured check fails, and opens no PR", () => {
    const workspace = newWorkspace({
      roster: ["claude"],
      profile: "solo",
      finalChecks: [{ argv: ["pnpm", "check"] }],
      prPolicy: "coord-open-unmerged"
    });
    const state = workspace.state;
    const pin = workspace.publish("claude", "implementation", { "src/feature.ts": "export const f = 1;\n" });

    workspace.mirror.fetchBranch("issue-1/claude");

    const claude = state.cursors.agents["claude"];

    if (claude === undefined) {
      throw new Error("expected a claude cursor");
    }

    state.cursors = {
      ...state.cursors,
      selected: "claude",
      agents: { ...state.cursors.agents, claude: { ...claude, published: { "R4.implement": pin } } }
    };

    let opened = 0;
    const outcome = finalize(
      state,
      loopDeps(workspace, {
        runCheck: (argv) => ({ argv, exitCode: 1, detail: "tests failed" }),
        openPullRequest: () => {
          opened += 1;

          return { ok: true, detail: "opened" };
        }
      })
    );

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("check failed");
    expect(outcome.prOpened).toBe(false);
    expect(opened).toBe(0);
  });
});
