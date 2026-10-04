import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCompletion } from "../src/action.js";
import { observeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { writeAgentResponse } from "../src/ballotResponse.js";
import { computeInputSetHash } from "../src/evidence.js";
import { BareMirror } from "../src/mirror.js";
import { agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder, CoordinatorRunLoop, type RunLoopDependencies } from "../src/runLoop.js";
import {
  appendJournal,
  dropAgent,
  initializeOperationalState,
  readCursorsState,
  readJournal,
  readStartState,
  mutateCursorsState,
  setPaused,
  writeCursorsState
} from "../src/state.js";
import { roundForStep, type InternalOrder, type WorkflowStepId } from "../src/steps.js";
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
      const dependencies: RunLoopDependencies = {
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
      };
      let loop = new CoordinatorRunLoop(paths, dependencies);
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
          roundForStep(cursor.stepId, cursors.issueCursor.round),
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
        git(clone, "add", path);
        git(clone, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message);
        const commit = git(clone, "rev-parse", "HEAD");
        git(clone, "push", "-q", "origin", `HEAD:refs/heads/issue-1/${agent}`);
        return commit;
      };

      const submit = (agent: string, content: string): string => {
        const order = currentOrder(agent);
        expect(order.submissionMode).toBe("git");
        const submission = commitAndPush(agent, order.requiredPath, content, `${order.stepId} ${agent}`);
        const receipt = agentRuntimePaths(paths, agent).complete;
        // End to end, through the mailbox: every agent publishes its SHA to its
        // own drop and the workflow still advances on it.
        expect(receipt).toBe(join(paths.completesRoot, "issue-1", agent, "complete"));
        writeFileSync(receipt, `${submission}\n`);
        return submission;
      };

      const respond = (
        agent: string,
        body: { choice: string; rationale: string } | { disposition: "approve" | "revise" | "escalate"; rationale: string }
      ): void => {
        const order = currentOrder(agent);
        expect(order.submissionMode).toBe("response");
        expect(order.responsePath).toBeTruthy();
        writeAgentResponse(order.responsePath as string, paths.issueRoot, {
          actionId: order.actionId,
          ...body
        });
        const receipt = agentRuntimePaths(paths, agent).complete;
        expect(receipt).toBe(join(paths.completesRoot, "issue-1", agent, "complete"));
        writeFileSync(receipt, `response ${order.actionId}\n`);
      };

      const expectStep = (stepId: WorkflowStepId): void => {
        expect(readCursorsState(paths).issueCursor.stepId).toBe(stepId);
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
      expect(currentOrder("claude").task).toContain("smallest change that fully solves it");
      const plan = `# Implementation Plan

## Exact File Map
- \`src/product-claude.txt\`
- \`src/product-codex.txt\`
- \`src/product-cursor.txt\`
- \`src/product-antigravity.txt\`
- \`src/revision.txt\`

## Reuse and Scope
Reuse the existing product-file submission helpers; no new modules or fixtures are required.

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
      for (const agent of activeAfterDrop) {
        respond(agent, {
          choice: "codex",
          rationale: "The plans are mechanically complete."
        });
      }
      await loop.runTick();

      expectStep("R4.implement");
      expect(currentOrder("codex").task).toContain("smallest change that fully solves it");
      {
        const afterBallot = readCursorsState(paths);
        expect(afterBallot.derived.planSelection?.selectedAgents).toEqual(["codex"]);
        expect(afterBallot.evidence.branch).toBe("issue-1/coordinator-evidence");
        expect(afterBallot.evidence.tip).toMatch(/^[a-f0-9]{40}$/);
        expect(
          afterBallot.ballotBatches.some(
            (batch) => batch.kind === "plan-ballot-batch" && batch.status === "published"
          )
        ).toBe(true);
      }
      expect(readJournal(paths).some((event) => event.type === "decision-derived")).toBe(true);
      expect(readJournal(paths).some((event) => event.type === "ballot-batch-published")).toBe(true);
      const claudeOrder = currentOrder("claude");
      const claudePin = commitAndPush("claude", "src/product-claude.txt", "claude product\n", "product claude");
      submit("claude", JSON.stringify({ ...commonArtifact(claudeOrder, "implementation-ready"),
        inputSetHash: computeInputSetHash(claudeOrder.inputs), implementationCommitSha: claudePin,
        approvedPaths: claudeOrder.approvedPaths }));
      await loop.runTick();
      const originalOrder = currentOrder("codex");
      const wip = join(clones.get("codex")!, "src/product-codex.txt");
      mkdirSync(dirname(wip), { recursive: true });
      writeFileSync(wip, "unfinished product\n");
      const request = (agent: string, path: string): string => {
        const order = currentOrder(agent);
        return submit(agent, JSON.stringify({ ...commonArtifact(order, "plan-amendment-request"),
          actionId: order.actionId, inputSetHash: computeInputSetHash(order.inputs), scopeHash: order.scopeHash,
          rationale: "A necessary regression test was omitted from the original map.",
          additionalPaths: [{ path, reason: "Test the approved behavior." }] }));
      };
      const proposalSha = request("codex", "test/product.test.ts");
      await loop.runTick();
      expectStep("R4.amend-ballot");
      expect(currentOrder("claude").inputs.some((input) => input.commitSha === proposalSha)).toBe(true);
      expect(readCursorsState(paths).accepted.find((entry) => entry.agent === "claude" && entry.stepId === "R4.implement")?.productPin).toBe(claudePin);
      expect(readFileSync(wip, "utf8")).toBe("unfinished product\n");
      respond("claude", { disposition: "approve", rationale: "Necessary test." });
      await loop.runTick();
      loop = new CoordinatorRunLoop(paths, dependencies); // resume a partial ballot
      for (const agent of ["codex", "cursor"]) respond(agent, { disposition: "approve", rationale: "Necessary test." });
      const publish = mirror.publishBranch.bind(mirror);
      mirror.publishBranch = async () => { throw new Error("network timeout"); };
      await loop.runTick();
      expectStep("R4.amend-ballot");
      expect(readCursorsState(paths).amendments).toEqual([]);
      const frozen = readCursorsState(paths).ballotBatches.find((batch) => batch.kind === "amendment-ballot-batch")!;
      expect(frozen.status).toBe("failed");
      mirror.publishBranch = async (sha, branch) => {
        await publish(sha, branch);
        // A concurrent owner pause after the push must win over acceptance.
        mutateCursorsState(paths, (state) => setPaused(state, true));
      };
      loop = new CoordinatorRunLoop(paths, dependencies); // retry the exact frozen publication
      await loop.runTick();
      expect(readCursorsState(paths).paused).toBe(true);
      expect(readCursorsState(paths).amendments).toEqual([]);
      expectStep("R4.amend-ballot");
      mirror.publishBranch = publish;
      mutateCursorsState(paths, (state) => setPaused(state, false));
      loop = new CoordinatorRunLoop(paths, dependencies);
      await loop.runTick(); // reconcile the already-pushed commit, then resolve once
      expectStep("R4.implement");
      expect(readCursorsState(paths).amendments).toHaveLength(1);
      expect(readCursorsState(paths).amendments?.[0]?.evidenceSha).toBe(frozen.commitSha);
      expect(existsSync(agentRuntimePaths(paths, "claude").action)).toBe(false);
      expect(currentOrder("codex").actionId).not.toBe(originalOrder.actionId);
      expect(currentOrder("codex").scopeHash).not.toBe(originalOrder.scopeHash);
      expect(currentOrder("codex").inputs).toEqual(originalOrder.inputs);
      expect(currentOrder("codex").approvedPaths).toContain("test/product.test.ts");
      expect(readFileSync(agentRuntimePaths(paths, "codex").action, "utf8")).toContain("Approved file-map amendments");
      for (const agent of ["codex", "cursor"] as const) {
        const order = currentOrder(agent);
        expect(order.inputs.map((input) => input.agent)).toEqual(["codex"]);
        commitAndPush(agent, "test/product.test.ts", "regression\n", "missing regression test");
        const pin = commitAndPush(agent, `src/product-${agent}.txt`, `${agent} product\n`, `product ${agent}`);
        submit(
          agent,
          JSON.stringify({
            ...commonArtifact(order, "implementation-ready"),
            inputSetHash: computeInputSetHash(order.inputs),
            scopeHash: order.scopeHash,
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
        respond(agent, {
          choice: "cursor",
          rationale: "Select the Cursor implementation."
        });
      }
      await loop.runTick();

      expectStep("R6.revise");
      expect(currentOrder("cursor").task).toContain("smallest change that fully solves it");
      expect(readCursorsState(paths).derived.implementationSelection).toMatchObject({
        winner: "cursor",
        reviser: "cursor"
      });
      expect(
        readCursorsState(paths).ballotBatches.some(
          (batch) => batch.kind === "comparison-ballot-batch" && batch.status === "published"
        )
      ).toBe(true);
      expect(existsSync(agentRuntimePaths(paths, "claude").action)).toBe(false);
      expect(existsSync(agentRuntimePaths(paths, "codex").action)).toBe(false);
      const revisionBefore = currentOrder("cursor");
      request("cursor", "test/unnecessary.test.ts");
      await loop.runTick();
      expectStep("R4.amend-ballot");
      expect(readCursorsState(paths).pendingAmendment?.sequence).toBe(2);
      expect(readCursorsState(paths).pendingAmendment?.resume).toEqual({ stepId: "R6.revise", round: 1 });
      for (const agent of activeAfterDrop) respond(agent, {
        disposition: agent === "codex" ? "revise" : "approve", rationale: "Use the already approved regression file."
      });
      await loop.runTick();
      expectStep("R6.revise");
      expect(currentOrder("cursor").round).toBe(1);
      expect(currentOrder("cursor").inputs).toEqual(revisionBefore.inputs);
      expect(currentOrder("cursor").inputs).toHaveLength(1);
      expect(currentOrder("cursor").scopeHash).toBe(revisionBefore.scopeHash);
      expect(currentOrder("cursor").approvedPaths).not.toContain("test/unnecessary.test.ts");
      expect(currentOrder("cursor").task).toContain("last amendment was rejected");
      request("cursor", "test/revision.test.ts");
      await loop.runTick();
      expectStep("R4.amend-ballot");
      expect(readCursorsState(paths).pendingAmendment?.sequence).toBe(3);
      for (const agent of activeAfterDrop) respond(agent, { disposition: "approve", rationale: "Necessary revision regression." });
      await loop.runTick();
      expectStep("R6.revise");
      expect(currentOrder("cursor").inputs).toEqual(revisionBefore.inputs);
      expect(currentOrder("cursor").scopeHash).not.toBe(revisionBefore.scopeHash);
      expect(currentOrder("cursor").approvedPaths).toContain("test/revision.test.ts");
      expect(readCursorsState(paths).amendments?.map((entry) => entry.outcome)).toEqual(["approved", "rejected", "approved"]);
      commitAndPush("cursor", "test/revision.test.ts", "revision regression\n", "revision regression");
      let revisionPin = "";
      {
        const order = currentOrder("cursor");
        revisionPin = commitAndPush("cursor", "src/revision.txt", "revision one\n", "revision product");
        submit(
          "cursor",
          JSON.stringify({
            ...commonArtifact(order, "revision-ready"),
            inputSetHash: computeInputSetHash(order.inputs),
            scopeHash: order.scopeHash,
            round: 1,
            revisedBranchHead: revisionPin,
            basedOn: order.inputs.map((input) => input.commitSha)
          })
        );
      }
      await loop.runTick();

      expectStep("R6.ballot");
      for (const agent of activeAfterDrop) {
        respond(agent, {
          disposition: "approve",
          rationale: "The revision satisfies the plan."
        });
      }
      await loop.runTick();

      expectStep("R7.finalize");
      expect(readCursorsState(paths).derived.consensus).toMatchObject({
        round: 1,
        consensusPin: revisionPin
      });
      expect(
        readCursorsState(paths).ballotBatches.some(
          (batch) => batch.kind === "consensus-ballot-batch" && batch.status === "published" && batch.round === 1
        )
      ).toBe(true);
      const cursorClone = clones.get("cursor") as string;
      // Ballot evidence lives on the coordinator evidence branch, not agent clones.
      for (const agent of activeAfterDrop) {
        expect(existsSync(join(cursorClone, `.plans/issue-1/ballot-${agent}.json`))).toBe(false);
        expect(existsSync(join(cursorClone, `.code-reviews/issue-1/ballot-${agent}.json`))).toBe(false);
        expect(existsSync(join(cursorClone, `.code-reviews/issue-1/consensus-ballot-${agent}-round-1.json`))).toBe(
          false
        );
      }
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
    120_000
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
    expect(submittedPrompts).toBe(1); // a Stop cannot bypass the 60-second minimum
    nowMs += 15_000;
    await loop.runTick();
    expect(submittedPrompts).toBe(2);
    await loop.runTick();
    expect(submittedPrompts).toBe(2);
  });
});
