import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";

import { parseActionMarkdown, readCompletion } from "../src/action.js";
import { boundInputsFor, expandArgv, finalize, runLoop, runTick } from "../src/runLoop.js";
import { readJournal, saveCursors } from "../src/state.js";
import { stepById } from "../src/steps.js";
import { createWorkspace, joinSignal, loopDeps, validPlan, type Workspace } from "./harness.js";

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

describe("ordering and delivery", () => {
  it("writes an action for every agent on the first tick", () => {
    const workspace = newWorkspace();

    runTick(workspace.state, loopDeps(workspace));

    for (const agent of workspace.state.start.originalRoster) {
      expect(existsSync(workspace.state.paths.actionFile(agent))).toBe(true);
    }
  });

  it("writes an action that exposes no internal state", () => {
    const workspace = newWorkspace();

    runTick(workspace.state, loopDeps(workspace));

    const contents = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");
    const parsed = parseActionMarkdown(contents);

    expect(parsed.ok).toBe(true);
    expect(contents).not.toContain("R1.join");
    expect(contents).not.toContain("gate-1-join");
    expect(contents).not.toContain("join-published");
  });

  it("is idempotent: a second tick does not rewrite an outstanding action", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const first = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");

    runTick(workspace.state, deps);

    expect(readFileSync(workspace.state.paths.actionFile("claude"), "utf8")).toBe(first);

    const prepared = readJournal(workspace.state.paths.journal).filter(
      (event) => event.kind === "action-prepared" && event.agent === "claude"
    );

    expect(prepared).toHaveLength(1);
  });

  it("nudges only the Claude pane and leaves the others pull-only", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace, { tmux: { ...loopDeps(workspace).tmux, available: true } });
    const inserts: { target: string; text: string }[] = [];
    const tmux = { ...deps.tmux, available: true, insert: (target: string, text: string) => {
      inserts.push({ target, text });

      return { ok: true as const };
    } };

    runTick(workspace.state, { ...deps, tmux });

    expect(inserts.map((insert) => insert.target)).toEqual(["consensus-1:claude.0"]);
  });
});

describe("verification", () => {
  it("accepts a valid submission, clears complete, and removes the action", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const sha = workspace.publish("claude", "join", {
      ".signals/issue-1/joined-claude.json": joinSignal(workspace, "claude")
    });

    workspace.submit("claude", sha);
    runTick(workspace.state, deps);

    expect(readCompletion(workspace.state.paths.completeFile("claude"))).toEqual({
      ok: false,
      reason: "absent"
    });
    expect(existsSync(workspace.state.paths.actionFile("claude"))).toBe(false);
    expect(workspace.state.cursors.agents["claude"]?.satisfied).toContain("R1.join");
    expect(workspace.state.cursors.agents["claude"]?.published["R1.join"]).toBe(sha);
  });

  it("clears complete and re-orders with concrete detail on failing evidence", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const sha = workspace.publish("claude", "wrong artifact", { "notes.md": "hello\n" });

    workspace.submit("claude", sha);
    runTick(workspace.state, deps);

    expect(readCompletion(workspace.state.paths.completeFile("claude")).ok).toBe(false);

    const action = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");

    expect(action).toContain("did not satisfy this action");
    expect(action).toContain(".signals/issue-1/joined-claude.json");
    expect(workspace.state.cursors.agents["claude"]?.attempt).toBe(2);
  });

  it("rejects a SHA that is real but on another agent's branch", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const codexSha = workspace.publish("codex", "join", {
      ".signals/issue-1/joined-codex.json": joinSignal(workspace, "codex")
    });

    workspace.submit("claude", codexSha);
    runTick(workspace.state, deps);

    expect(workspace.state.cursors.agents["claude"]?.satisfied).not.toContain("R1.join");
  });

  it("ignores an unparseable completion file entirely", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);
    writeFileSync(workspace.state.paths.completeFile("claude"), "done!\n");
    runTick(workspace.state, deps);

    // Not intent: no verdict, no attempt increment, action untouched.
    expect(workspace.state.cursors.agents["claude"]?.attempt).toBe(1);
    expect(existsSync(workspace.state.paths.actionFile("claude"))).toBe(true);
  });

  it("preserves complete and emits no verdict on a transient fetch failure", () => {
    const workspace = newWorkspace();
    const base = loopDeps(workspace);

    runTick(workspace.state, base);

    const sha = workspace.publish("claude", "join", {
      ".signals/issue-1/joined-claude.json": joinSignal(workspace, "claude")
    });

    workspace.submit("claude", sha);

    const offline = loopDeps(workspace, {
      mirror: {
        ...workspace.mirror,
        fetchBranch: () => ({ ok: false, kind: "transient", detail: "Could not resolve host: origin" })
      }
    });

    runTick(workspace.state, offline);

    // The submission survives the outage and no artifact verdict is recorded.
    expect(readCompletion(workspace.state.paths.completeFile("claude"))).toEqual({ ok: true, sha });
    expect(
      readJournal(workspace.state.paths.journal).some((event) => event.kind === "verify-result")
    ).toBe(false);
    expect(
      readJournal(workspace.state.paths.journal).some((event) => event.kind === "verify-deferred")
    ).toBe(true);

    // And once origin is reachable again it verifies normally.
    runTick(workspace.state, base);

    expect(workspace.state.cursors.agents["claude"]?.satisfied).toContain("R1.join");
  });

  it("verifies simultaneous submissions from several agents in one tick", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    for (const agent of workspace.state.start.originalRoster) {
      const sha = workspace.publish(agent, "join", {
        [`.signals/issue-1/joined-${agent}.json`]: joinSignal(workspace, agent)
      });

      workspace.submit(agent, sha);
    }

    runTick(workspace.state, deps);

    for (const agent of workspace.state.start.originalRoster) {
      expect(workspace.state.cursors.agents[agent]?.satisfied).toContain("R1.join");
    }
  });
});

describe("gate advancement and bound inputs", () => {
  const completeJoinGate = (workspace: Workspace, deps: ReturnType<typeof loopDeps>): void => {
    runTick(workspace.state, deps);

    for (const agent of workspace.state.start.originalRoster) {
      const sha = workspace.publish(agent, "join", {
        [`.signals/issue-1/joined-${agent}.json`]: joinSignal(workspace, agent)
      });

      workspace.submit(agent, sha);
    }

    runTick(workspace.state, deps);
  };

  it("advances to the plan gate once every agent has joined", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    completeJoinGate(workspace, deps);

    expect(workspace.state.cursors.issueCursor.gateId).toBe("gate-2-plans");
  });

  it("binds peer plan commits as exact inputs for the review step", () => {
    const workspace = newWorkspace({ firstGate: "gate-2-plans" });
    const deps = loopDeps(workspace);
    const shas: Record<string, string> = {};

    runTick(workspace.state, deps);

    for (const agent of workspace.state.start.originalRoster) {
      shas[agent] = workspace.publish(agent, "plan", { ".plans/issue-1/plan.md": validPlan });
      workspace.submit(agent, shas[agent] as string);
    }

    runTick(workspace.state, deps);

    expect(workspace.state.cursors.issueCursor.gateId).toBe("gate-3-selection");

    const inputs = boundInputsFor(workspace.state, stepById("R3.review"), "claude");

    expect(inputs.map((input) => input.agent).sort()).toEqual(["antigravity", "codex", "cursor"]);
    expect(inputs.find((input) => input.agent === "codex")?.commitSha).toBe(shas["codex"]);

    runTick(workspace.state, deps);

    const action = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");

    expect(action).toContain(shas["codex"] as string);
  });

  it("omits a dropped agent from bound inputs without announcing the drop", () => {
    const workspace = newWorkspace({ firstGate: "gate-2-plans" });
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    for (const agent of workspace.state.start.originalRoster) {
      const sha = workspace.publish(agent, "plan", { ".plans/issue-1/plan.md": validPlan });

      workspace.submit(agent, sha);
    }

    runTick(workspace.state, deps);

    workspace.state.cursors = { ...workspace.state.cursors, droppedAgents: ["codex"] };
    saveCursors(workspace.state, "2026-08-11T03:00:00Z");
    runTick(workspace.state, deps);

    const inputs = boundInputsFor(workspace.state, stepById("R3.review"), "claude");
    const action = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");

    expect(inputs.map((input) => input.agent)).not.toContain("codex");
    expect(action).not.toContain("codex");
    expect(action).not.toMatch(/dropped|removed|no longer/i);
  });

  it("ignores a completion written by a dropped agent", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const sha = workspace.publish("codex", "join", {
      ".signals/issue-1/joined-codex.json": joinSignal(workspace, "codex")
    });

    workspace.state.cursors = { ...workspace.state.cursors, droppedAgents: ["codex"] };
    saveCursors(workspace.state, "2026-08-11T03:00:00Z");
    workspace.submit("codex", sha);
    runTick(workspace.state, deps);

    expect(workspace.state.cursors.agents["codex"]?.satisfied).not.toContain("R1.join");
    expect(readCompletion(workspace.state.paths.completeFile("codex")).ok).toBe(false);
  });
});

describe("owner controls", () => {
  it("does nothing while paused and resumes cleanly", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    workspace.state.cursors = { ...workspace.state.cursors, paused: true };
    saveCursors(workspace.state, "2026-08-11T03:00:00Z");
    runTick(workspace.state, deps);

    expect(existsSync(workspace.state.paths.actionFile("claude"))).toBe(false);

    workspace.state.cursors = { ...workspace.state.cursors, paused: false };
    saveCursors(workspace.state, "2026-08-11T03:00:00Z");
    runTick(workspace.state, deps);

    expect(existsSync(workspace.state.paths.actionFile("claude"))).toBe(true);
  });

  it("stops the loop when abandoned", async () => {
    const workspace = newWorkspace();

    workspace.state.cursors = { ...workspace.state.cursors, abandoned: true };
    saveCursors(workspace.state, "2026-08-11T03:00:00Z");

    const result = await runLoop(workspace.state, loopDeps(workspace), { maxTicks: 5 });

    expect(result.awaitingOwner).toBe(true);
  });

  it("waits across ticks without finalizing when work is outstanding", async () => {
    const workspace = newWorkspace();
    const result = await runLoop(workspace.state, loopDeps(workspace), { maxTicks: 3, pollIntervalMs: 0 });

    expect(result.finalized).toBe(false);
    expect(result.awaitingOwner).toBe(false);
  });
});

describe("restart recovery", () => {
  it("reconstructs from disk and does not duplicate an outstanding action", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const before = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");
    const reloaded = workspace.reload();

    runTick(reloaded, loopDeps(workspace));

    expect(readFileSync(reloaded.paths.actionFile("claude"), "utf8")).toBe(before);
    expect(
      readJournal(reloaded.paths.journal).filter(
        (event) => event.kind === "action-prepared" && event.agent === "claude"
      )
    ).toHaveLength(1);
  });

  it("re-verifies a pending submission after a restart", () => {
    const workspace = newWorkspace();
    const deps = loopDeps(workspace);

    runTick(workspace.state, deps);

    const sha = workspace.publish("claude", "join", {
      ".signals/issue-1/joined-claude.json": joinSignal(workspace, "claude")
    });

    workspace.submit("claude", sha);

    const reloaded = workspace.reload();

    runTick(reloaded, loopDeps(workspace));

    expect(reloaded.cursors.agents["claude"]?.satisfied).toContain("R1.join");
  });
});

describe("finalization", () => {
  it("expands a placeholder in exactly one argv element and never builds a shell string", () => {
    expect(expandArgv(["scripts/test.sh", "{baselineSha}"], { baselineSha: "abc" })).toEqual([
      "scripts/test.sh",
      "abc"
    ]);
    expect(expandArgv(["echo", "a; rm -rf /"], {})).toEqual(["echo", "a; rm -rf /"]);
    expect(expandArgv(["pnpm", "{unknown}"], {})).toEqual(["pnpm", "{unknown}"]);
  });

  it("refuses to finalize without a selected implementation", () => {
    const workspace = newWorkspace();
    const outcome = finalize(workspace.state, loopDeps(workspace));

    expect(outcome.ok).toBe(false);
    expect(outcome.prOpened).toBe(false);
  });

  it("runs the configured checks and can open an unmerged PR", () => {
    const workspace = newWorkspace({
      finalChecks: [{ argv: ["pnpm", "install", "--frozen-lockfile"] }, { argv: ["pnpm", "check"] }],
      prPolicy: "coord-open-unmerged"
    });
    const pin = workspace.publish("claude", "implementation", { "src/feature.ts": "export const f = 1;\n" });

    workspace.mirror.fetchBranch("issue-1/claude");

    const claude = workspace.state.cursors.agents["claude"];

    if (claude === undefined) {
      throw new Error("expected a claude cursor");
    }

    workspace.state.cursors = {
      ...workspace.state.cursors,
      selected: "claude",
      agents: { ...workspace.state.cursors.agents, claude: { ...claude, published: { "R4.implement": pin } } }
    };

    let opened = 0;
    const deps = loopDeps(workspace, {
      openPullRequest: () => {
        opened += 1;

        return { ok: true, detail: "opened" };
      }
    });
    const outcome = finalize(workspace.state, deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.checks.map((check) => check.argv.join(" "))).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm check"
    ]);
    expect(opened).toBe(1);
    expect(outcome.prOpened).toBe(true);
  });

  it("blocks PR creation when a configured check fails", () => {
    const workspace = newWorkspace({
      finalChecks: [{ argv: ["pnpm", "check"] }],
      prPolicy: "coord-open-unmerged"
    });
    const pin = workspace.publish("claude", "implementation", { "src/feature.ts": "export const f = 1;\n" });

    workspace.mirror.fetchBranch("issue-1/claude");

    const claude = workspace.state.cursors.agents["claude"];

    if (claude === undefined) {
      throw new Error("expected a claude cursor");
    }

    workspace.state.cursors = {
      ...workspace.state.cursors,
      selected: "claude",
      agents: { ...workspace.state.cursors.agents, claude: { ...claude, published: { "R4.implement": pin } } }
    };

    let opened = 0;
    const deps = loopDeps(workspace, {
      runCheck: (argv) => ({ argv, exitCode: 1, detail: "tests failed" }),
      openPullRequest: () => {
        opened += 1;

        return { ok: true, detail: "opened" };
      }
    });
    const outcome = finalize(workspace.state, deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.prOpened).toBe(false);
    expect(opened).toBe(0);
    expect(outcome.detail).toContain("check failed");
  });

  it("never exposes a merge capability", () => {
    const source = readFileSync(new URL("../src/runLoop.ts", import.meta.url), "utf8");

    expect(source).not.toMatch(/\bgit\s+merge\b/);
    expect(source).not.toMatch(/pr\s+merge/i);
    expect(source).not.toMatch(/mergePullRequest/);
  });
});
