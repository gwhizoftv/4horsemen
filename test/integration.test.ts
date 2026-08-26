import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCompletion } from "../src/action.js";
import { observeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { computeInputSetHash } from "../src/evidence.js";
import { BareMirror } from "../src/mirror.js";
import { agentResponsePath, agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder, CoordinatorRunLoop } from "../src/runLoop.js";
import {
  appendJournal,
  dropAgent,
  initializeOperationalState,
  readCursorsState,
  readJournal,
  readStartState,
  writeCursorsState
} from "../src/state.js";
import type { InternalOrder, WorkflowStepId } from "../src/steps.js";
import { TmuxController } from "../src/tmux.js";

const agents = ["claude", "codex", "cursor", "antigravity"] as const;
const activeAfterDrop = ["claude", "codex", "cursor"] as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const commonArtifact = (order: InternalOrder, artifact: string) => ({
  protocolVersion: 1,
  artifact,
  issue: order.issue,
  issueSessionId: order.issueSessionId,
  agent: order.agent
});

describe("four-agent coordinator canary", () => {
  it(
    "drives exact-SHA evidence, a drop, one revision, consensus, and finalization without merging",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "coord-e2e-"));
      roots.push(root);
      const origin = join(root, "origin.git");
      const seed = join(root, "seed");
      execFileSync("git", ["init", "--bare", "-q", origin]);
      execFileSync("git", ["init", "-q", seed]);
      writeFileSync(join(seed, "README.md"), "fixture\n");
      git(seed, "add", ".");
      git(seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "baseline");
      git(seed, "branch", "-M", "main");
      git(seed, "remote", "add", "origin", origin);
      git(seed, "push", "-q", "origin", "main");
      execFileSync("git", ["--git-dir", origin, "symbolic-ref", "HEAD", "refs/heads/main"]);
      const baselineSha = git(seed, "rev-parse", "HEAD");

      const clones = new Map<string, string>();
      for (const agent of agents) {
        const clone = join(root, `clone-${agent}`);
        execFileSync("git", ["clone", "-q", origin, clone]);
        git(clone, "checkout", "-qb", `issue-1/${agent}`, "origin/main");
        clones.set(agent, clone);
      }

      const runtimeRoot = join(root, "runtime");
      const paths = issueRuntimePaths(runtimeRoot, 1);
      createIssueRuntime(paths, agents);
      const githubOrigin = "https://github.com/example/fixture.git";
      initializeOperationalState(paths, {
        issue: 1,
        issueSessionId: `issue-1:${baselineSha}`,
        baselineSha,
        profile: "consensus",
        originalRoster: [...agents],
        branchTemplate: "issue-{issue}/{agent}",
        baseBranch: "main",
        maxRevisionRounds: 3,
        prPolicy: "owner-only",
        automationDigest: "b".repeat(64),
        automationDigestScheme: "sha256-length-prefixed-v1",
        automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
        trustedSourceCommit: "c".repeat(40),
        // Publication needs a github.com origin for gh; fetch/push still use the local bare via the injected mirror.
        origin: githubOrigin,
        coordRoot: runtimeRoot,
        configPath: join(root, "config.json"),
        agents: agents.map((id) => ({ id, root: clones.get(id) as string, launcher: `start-${id}.sh`, delivery: "pull" })),
        checks: [{ name: "fixture-check", argv: ["node", "-e", "process.exit(0)"] }],
        pollIntervalMs: 100
      });
      writeFileSync(
        paths.issueSnapshot,
        `${JSON.stringify(
          {
            repository: "example/fixture",
            number: 1,
            title: "Four-agent coordinator canary",
            body: "Drive consensus through finalization.",
            url: "https://github.com/example/fixture/issues/1"
          },
          null,
          2
        )}\n`
      );

      const checkArgv: string[][] = [];
      const mirror = new BareMirror(paths.mirror, origin);
      const loop = new CoordinatorRunLoop(paths, {
        tmux: null,
        mirror,
        pullRequestOpener: async (input) => {
          expect(input.draft).toBe(true);
          expect(input.head).toBe("issue-1/cursor-final");
          expect(input.title).toBe("Issue 1: Four-agent coordinator canary");
          expect(input.body).toContain("Closes #1");
          return { url: "https://github.com/example/fixture/pull/1" };
        },
        processRunner: async (argv) => {
          checkArgv.push([...argv]);
          return { exitCode: 0, stdout: "", stderr: "" };
        }
      });
      await loop.initializeEffects();
      await loop.runTick();

      const currentOrder = (agent: string): InternalOrder => {
        const start = readStartState(paths);
        const cursors = readCursorsState(paths);
        const cursor = cursors.agents[agent];
        if (cursor?.stepId === null || cursor?.stepId === undefined || cursor.actionId === null) {
          throw new Error(`No current action for ${agent}.`);
        }
        return buildOrder(
          paths,
          start,
          cursors,
          agent,
          cursor.stepId,
          cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null,
          cursor.actionId,
          cursor.outstanding
        );
      };

      const commitAndPush = (agent: string, path: string, content: string, message: string): string => {
        const clone = clones.get(agent);
        if (clone === undefined) throw new Error(`Missing clone ${agent}.`);
        const target = join(clone, path);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content);
        git(clone, "add", "-A");
        git(clone, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message);
        const commit = git(clone, "rev-parse", "HEAD");
        git(clone, "push", "-q", "origin", `HEAD:refs/heads/issue-1/${agent}`);
        return commit;
      };

      const submit = (agent: string, content: string): string => {
        const order = currentOrder(agent);
        const submission = commitAndPush(agent, order.requiredPath, content, `${order.stepId} ${agent}`);
        const receipt = agentRuntimePaths(paths, agent).complete;
        // End to end, through the mailbox: every agent publishes its SHA to its
        // own drop and the workflow still advances on it.
        expect(receipt).toBe(join(paths.completesRoot, "issue-1", agent, "complete"));
        writeFileSync(receipt, `${submission}\n`);
        return submission;
      };

      /**
       * Answer a ballot the way an agent does: the judgment to the response
       * path the action names, then the action-bound marker. No commit, no
       * push, no repository artifact.
       */
      const respond = (agent: string, judgment: Record<string, unknown>): void => {
        const order = currentOrder(agent);
        expect(order.submissionMode).toBe("response");
        const raw = readFileSync(agentRuntimePaths(paths, agent).action, "utf8");
        expect(raw).not.toContain("Push the commit");
        expect(raw).not.toContain("requiredPath:");
        const responsePath = agentResponsePath(paths, agent, order.actionId);
        // The granted directory, a child of this agent's runtime root.
        expect(responsePath).toBe(
          join(paths.agents, agent, "responses", `${order.actionId}.json`)
        );
        writeFileSync(responsePath, `${JSON.stringify({ actionId: order.actionId, ...judgment })}\n`);
        writeFileSync(agentRuntimePaths(paths, agent).complete, `response ${order.actionId}\n`);
      };

      const expectStep = (stepId: WorkflowStepId): void => {
        expect(readCursorsState(paths).issueCursor.stepId).toBe(stepId);
      };

      /**
       * Coordinator commits added past the issue baseline, oldest first. The
       * baseline itself is excluded: the first evidence commit descends from
       * it, so a plain log would count the product history as evidence.
       */
      const evidenceCommits = (): string[] => {
        const listed = git(seed, "ls-remote", origin, "refs/heads/issue-1/coordinator-evidence");
        if (listed.trim() === "") return [];
        git(seed, "fetch", "-q", origin, "+refs/heads/issue-1/coordinator-evidence:refs/heads/evidence-check");
        return git(seed, "log", "--reverse", "--format=%H", `${baselineSha}..refs/heads/evidence-check`)
          .split("\n")
          .filter(Boolean);
      };

      expectStep("R1.join");
      for (const agent of agents) {
        const order = currentOrder(agent);
        submit(
          agent,
          JSON.stringify({
            ...commonArtifact(order, "participation-ready"),
            baselineSha,
            automationDigest: order.automationDigest
          })
        );
      }
      await loop.runTick();

      expectStep("R2.plan");
      const plan = `# Implementation Plan

## Exact File Map
- \`src/product-claude.txt\`
- \`src/product-codex.txt\`
- \`src/product-cursor.txt\`
- \`src/product-antigravity.txt\`
- \`src/revision.txt\`

## Tests
Run the integration canary.

## Alternatives Rejected
Do not trust moving branch tips.

## Risks and Mitigations
Bind every input commit.

## Conclusion
Implement the selected product files.
`;
      for (const agent of ["claude", "codex"] as const) submit(agent, plan);
      await loop.runTick();
      expect(readCursorsState(paths).accepted.filter((submission) => submission.stepId === "R2.plan")).toHaveLength(2);
      submit("cursor", plan);
      const cursorPendingPlan = agentRuntimePaths(paths, "cursor").complete;
      expect(existsSync(cursorPendingPlan)).toBe(true);
      let cursors = readCursorsState(paths);
      appendJournal(paths, { type: "agent-dropped", agent: "antigravity", details: { reason: "fixture unavailable" } });
      cursors = dropAgent(cursors, "antigravity");
      const droppedRuntime = agentRuntimePaths(paths, "antigravity");
      clearCompletion(droppedRuntime.complete);
      if (existsSync(droppedRuntime.action)) unlinkSync(droppedRuntime.action);
      writeCursorsState(paths, cursors);
      await loop.runTick();
      expect(readCursorsState(paths).accepted.filter((submission) => submission.stepId === "R2.plan")).toHaveLength(3);
      expect(existsSync(cursorPendingPlan)).toBe(false);

      expectStep("R3.review");
      for (const agent of activeAfterDrop) {
        const order = currentOrder(agent);
        expect(order.inputs.every((input) => input.agent !== "antigravity")).toBe(true);
        submit(
          agent,
          `# Review\n\n## Findings\n${order.inputs.map((input) => `- ${input.commitSha}`).join("\n")}\n\n## Verdict\nProceed.\n`
        );
      }
      await loop.runTick();

      expectStep("R3.plan-ballot");
      expect(evidenceCommits()).toEqual([]);
      for (const agent of activeAfterDrop) {
        respond(agent, { choice: "codex", rationale: "The plans are mechanically complete." });
      }
      await loop.runTick();

      // One coordinator commit for N responses, on its own branch, containing
      // one canonical ballot per active agent.
      const afterPlanBallots = evidenceCommits();
      expect(afterPlanBallots).toHaveLength(1);
      const planBallotTree = git(seed, "ls-tree", "-r", "--name-only", afterPlanBallots[0] as string).split("\n");
      for (const agent of activeAfterDrop) {
        expect(planBallotTree).toContain(`.plans/issue-1/ballot-${agent}.json`);
      }
      const publishedBallot = JSON.parse(
        git(seed, "show", `${afterPlanBallots[0] as string}:.plans/issue-1/ballot-codex.json`)
      ) as Record<string, unknown>;
      expect(publishedBallot.protocolVersion).toBe(2);
      expect(publishedBallot.responseSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(publishedBallot.choice).toBe("codex");
      // Authored by the driver, not by any agent that voted.
      expect(git(seed, "show", "-s", "--format=%an", afterPlanBallots[0] as string)).toContain("coord");
      expect(git(seed, "show", "-s", "--format=%s", afterPlanBallots[0] as string)).toBe(
        "Coordinator: publish issue 1 plan ballot batch"
      );

      expectStep("R4.implement");
      expect(readCursorsState(paths).derived.planSelection?.selectedAgents).toEqual(["codex"]);
      expect(readJournal(paths).some((event) => event.type === "decision-derived")).toBe(true);
      for (const agent of activeAfterDrop) {
        const order = currentOrder(agent);
        expect(order.inputs.map((input) => input.agent)).toEqual(["codex"]);
        const pin = commitAndPush(agent, `src/product-${agent}.txt`, `${agent} product\n`, `product ${agent}`);
        submit(
          agent,
          JSON.stringify({
            ...commonArtifact(order, "implementation-ready"),
            inputSetHash: computeInputSetHash(order.inputs),
            implementationCommitSha: pin,
            approvedPaths: order.approvedPaths
          })
        );
      }
      await loop.runTick();

      expectStep("R5.compare");
      for (const agent of activeAfterDrop) {
        const order = currentOrder(agent);
        submit(agent, `# Comparison\n\n## Findings\n${order.inputs.map((input) => input.commitSha).join("\n")}\n`);
      }
      await loop.runTick();

      expectStep("R5.compare-ballot");
      for (const agent of activeAfterDrop) {
        respond(agent, { choice: "cursor", rationale: "Select the Cursor implementation." });
      }
      await loop.runTick();

      // A second commit, fast-forwarding from the first: evidence accumulates.
      const afterCompareBallots = evidenceCommits();
      expect(afterCompareBallots).toHaveLength(2);
      expect(afterCompareBallots[0]).toBe(afterPlanBallots[0]);

      expectStep("R6.revise");
      expect(readCursorsState(paths).derived.implementationSelection).toMatchObject({
        winner: "cursor",
        reviser: "cursor"
      });
      expect(existsSync(agentRuntimePaths(paths, "claude").action)).toBe(false);
      expect(existsSync(agentRuntimePaths(paths, "codex").action)).toBe(false);
      let revisionPin = "";
      {
        const order = currentOrder("cursor");
        revisionPin = commitAndPush("cursor", "src/revision.txt", "revision one\n", "revision product");
        submit(
          "cursor",
          JSON.stringify({
            ...commonArtifact(order, "revision-ready"),
            inputSetHash: computeInputSetHash(order.inputs),
            round: 1,
            revisedBranchHead: revisionPin,
            basedOn: order.inputs.map((input) => input.commitSha)
          })
        );
      }
      await loop.runTick();

      expectStep("R6.ballot");
      for (const agent of activeAfterDrop) {
        respond(agent, { disposition: "approve", rationale: "The revision satisfies the plan." });
      }
      await loop.runTick();

      // A third commit: one per consensus round, cumulative on the same branch.
      const afterConsensusBallots = evidenceCommits();
      expect(afterConsensusBallots).toHaveLength(3);
      expect(afterConsensusBallots.slice(0, 2)).toEqual(afterCompareBallots);
      expect(
        git(seed, "ls-tree", "-r", "--name-only", afterConsensusBallots[2] as string).split("\n")
      ).toContain(".code-reviews/issue-1/consensus-ballot-cursor-round-1.json");
      // Agents committed nothing for any of the three ballot gates: no ballot
      // file exists anywhere on any agent branch.
      for (const agent of activeAfterDrop) {
        git(seed, "fetch", "-q", origin, `+refs/heads/issue-1/${agent}:refs/heads/branch-check-${agent}`);
        const tree = git(seed, "ls-tree", "-r", "--name-only", `refs/heads/branch-check-${agent}`).split("\n");
        expect(tree).not.toContain(`.plans/issue-1/ballot-${agent}.json`);
        expect(tree).not.toContain(`.code-reviews/issue-1/ballot-${agent}.json`);
        expect(tree).not.toContain(`.code-reviews/issue-1/consensus-ballot-${agent}-round-1.json`);
      }

      expectStep("R7.finalize");
      expect(readCursorsState(paths).derived.consensus).toMatchObject({
        round: 1,
        consensusPin: revisionPin
      });
      const cursorClone = clones.get("cursor") as string;
      for (const directory of [".plans/issue-1", ".signals/issue-1", ".code-reviews/issue-1"]) {
        rmSync(join(cursorClone, directory), { recursive: true, force: true });
      }
      git(cursorClone, "add", "-A");
      git(cursorClone, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "cleanup only");
      const finalSha = git(cursorClone, "rev-parse", "HEAD");
      git(cursorClone, "push", "-q", "origin", "HEAD:refs/heads/issue-1/cursor");
      {
        const order = currentOrder("cursor");
        submit(
          "cursor",
          JSON.stringify({
            ...commonArtifact(order, "finalization"),
            consensusSha: revisionPin,
            finalSha,
            checks: [{ argv: ["node", "-e", "process.exit(0)"], exitCode: 0 }]
          })
        );
      }
      const final = await loop.runTick();
      // The evidence branch is reported and retained, and the product PR head
      // carries none of it.
      expect(final.evidence).toMatchObject({ branch: "issue-1/coordinator-evidence" });
      expect(final.evidence.tip).toBe(afterConsensusBallots[2]);
      expect(final.ballotBatches.filter((batch) => batch.status === "published")).toHaveLength(3);
      expect(final.completed).toBe(true);
      expect(final.publication).toMatchObject({
        status: "completed",
        finalSha,
        branch: "issue-1/cursor-final",
        url: "https://github.com/example/fixture/pull/1"
      });
      expect(checkArgv).toEqual([["node", "-e", "process.exit(0)"]]);
      expect(final.accepted.find((submission) => submission.stepId === "R7.finalize")?.productPin).toBe(finalSha);
    },
    30_000
  );
});

describe("lifecycle nudge canary", () => {
  it("does not pile a second prompt after 45 seconds and permits one after the matching turn stops", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-lifecycle-e2e-"));
    roots.push(workspace);
    const root = join(workspace, "coord-runtime");
    mkdirSync(root, { recursive: true });
    const paths = issueRuntimePaths(root, 1, join(workspace, "completes"));
    createIssueRuntime(paths, ["codex"]);
    initializeOperationalState(paths, {
      issue: 1,
      issueSessionId: `issue-1:${"a".repeat(40)}`,
      baselineSha: "a".repeat(40),
      profile: "solo",
      originalRoster: ["codex"],
      branchTemplate: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      automationDigest: "b".repeat(64),
      automationDigestScheme: "sha256-length-prefixed-v1",
      automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
      trustedSourceCommit: "c".repeat(40),
      origin: "https://github.com/example/fixture.git",
      coordRoot: root,
      configPath: join(root, "config.json"),
      agents: [
        {
          id: "codex",
          root: join(root, "clone-codex"),
          launcher: "start-codex.sh",
          delivery: "both",
          harnessProcess: "codex"
        }
      ],
      checks: [{ name: "true", argv: ["true"] }],
      pollIntervalMs: 100
    });
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let submittedPrompts = 0;
    let paneText = "";
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) submittedPrompts += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, now: () => new Date(nowMs).toISOString() });
    await loop.runTick();
    expect(submittedPrompts).toBe(1);
    paneText = readAgentLifecycle(paths).agents.codex!.action!.actionId;
    nowMs += 45_000;
    await loop.runTick();
    expect(submittedPrompts).toBe(1);

    const action = readAgentLifecycle(paths).agents.codex!.action!;
    observeAgentLifecycle(paths, "codex", {
      kind: "prompt-submitted",
      eventName: "UserPromptSubmit",
      sessionId: "session-1",
      turnId: "turn-1",
      actionId: action.actionId,
      actionDigest: action.actionDigest
    });
    observeAgentLifecycle(paths, "codex", {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "turn-1",
      backgroundActive: false
    });
    await loop.runTick();
    expect(submittedPrompts).toBe(2);
    await loop.runTick();
    expect(submittedPrompts).toBe(2);
  });
});
