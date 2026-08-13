import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearCompletion } from "../src/action.js";
import { computeInputSetHash } from "../src/evidence.js";
import { BareMirror } from "../src/mirror.js";
import { agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { buildOrder, CoordinatorRunLoop } from "../src/runLoop.js";
import {
  appendJournal,
  dropAgent,
  initializeOperationalState,
  readCursorsState,
  readStartState,
  writeCursorsState
} from "../src/state.js";
import type { InternalOrder, WorkflowStepId } from "../src/steps.js";

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

      const checkArgv: string[][] = [];
      const mirror = new BareMirror(paths.mirror, origin);
      const loop = new CoordinatorRunLoop(paths, {
        tmux: null,
        mirror,
        pullRequestOpener: async (input) => {
          expect(input.draft).toBe(true);
          expect(input.head).toBe("issue-1/cursor-final");
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
        writeFileSync(agentRuntimePaths(paths, agent).complete, `${submission}\n`);
        return submission;
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
            ...commonArtifact(order, "join"),
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
      for (const agent of activeAfterDrop) {
        const order = currentOrder(agent);
        submit(
          agent,
          JSON.stringify({
            ...commonArtifact(order, "plan-ballot"),
            inputSetHash: computeInputSetHash(order.inputs),
            plans: order.inputs.filter((input) => input.kind === "plan").map(({ agent: citedAgent, commitSha, path }) => ({ agent: citedAgent, commitSha, path })),
            reviews: order.inputs.filter((input) => input.kind === "review").map(({ agent: citedAgent, commitSha, path }) => ({ agent: citedAgent, commitSha, path })),
            choice: "codex",
            rationale: "The plans are mechanically complete."
          })
        );
      }
      await loop.runTick();

      expectStep("R3.publish-selection");
      {
        const order = currentOrder("claude");
        submit(
          "claude",
          JSON.stringify({
            ...commonArtifact(order, "selection"),
            inputSetHash: computeInputSetHash(order.inputs),
            selectedAgents: ["codex"],
            ballots: order.inputs.map(({ agent, commitSha, path }) => ({ agent, commitSha, path }))
          })
        );
      }
      await loop.runTick();

      expectStep("R4.implement");
      expect(readCursorsState(paths).selection.planAgents).toEqual(["codex"]);
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
        const order = currentOrder(agent);
        submit(
          agent,
          JSON.stringify({
            ...commonArtifact(order, "comparison-ballot"),
            inputSetHash: computeInputSetHash(order.inputs),
            implementations: order.inputs.map(({ agent: citedAgent, commitSha, path }) => ({ agent: citedAgent, commitSha, path })),
            choice: "cursor",
            rationale: "Select the Cursor implementation."
          })
        );
      }
      await loop.runTick();

      expectStep("R5.reviser-auth");
      {
        const order = currentOrder("claude");
        const selectedPin = order.inputs.find(
          (input) => input.kind === "implementation" && input.agent === "cursor"
        )?.commitSha;
        if (selectedPin === undefined) throw new Error("No selected implementation pin.");
        submit(
          "claude",
          JSON.stringify({
            ...commonArtifact(order, "reviser-authorization"),
            inputSetHash: computeInputSetHash(order.inputs),
            reviser: "cursor",
            implementationCommitSha: selectedPin
          })
        );
      }
      await loop.runTick();

      expectStep("R6.revise");
      expect(readCursorsState(paths).selection).toMatchObject({
        implementationAgent: "cursor",
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
        const order = currentOrder(agent);
        submit(
          agent,
          JSON.stringify({
            ...commonArtifact(order, "consensus-ballot"),
            inputSetHash: computeInputSetHash(order.inputs),
            round: 1,
            revisionCommitSha: revisionPin,
            disposition: "approve",
            rationale: "The revision satisfies the plan."
          })
        );
      }
      await loop.runTick();

      expectStep("R6.declare");
      {
        const order = currentOrder("cursor");
        submit(
          "cursor",
          JSON.stringify({
            ...commonArtifact(order, "consensus-declaration"),
            inputSetHash: computeInputSetHash(order.inputs),
            round: 1,
            consensusCommitSha: revisionPin,
            ballots: order.inputs
              .filter((input) => input.kind === "consensus-ballot")
              .map(({ agent, commitSha, path }) => ({ agent, commitSha, path }))
          })
        );
      }
      await loop.runTick();

      expectStep("R7.finalize");
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
