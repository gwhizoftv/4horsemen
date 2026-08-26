import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAction, writeAction } from "../src/action.js";
import { decideLifecycleNudge, observeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { BareMirror } from "../src/mirror.js";
import { agentResponsePath, agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  buildOrder,
  computeDerivedInputSetHash,
  computePlanSelectionDerived,
  CoordinatorRunLoop,
  derivedDecisionJournalDetails,
  deterministicWinner,
  githubRepositoryFromOrigin,
  NUDGE_RETRY_MS,
  resolveApprovedPaths,
  resolveChangeScope,
  CHANGE_SCOPE_PATH_LIMIT
} from "../src/runLoop.js";
import {
  cursorsStateSchema,
  appendJournal,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readCursorsState,
  readJournal,
  readStartState,
  setPaused,
  writeCursorsState
} from "../src/state.js";
import { TmuxController } from "../src/tmux.js";
import { writeAgentResponse } from "../src/ballotResponse.js";
import type { ConsensusBallotResponse } from "../src/protocol.js";
import type { AcceptedResponse, BallotBatch } from "../src/state.js";
import { createHash } from "node:crypto";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const responseDigestFixture = (seed: string): string =>
  createHash("sha256").update(seed, "utf8").digest("hex");
const gitShaFixture = (seed: string): string =>
  createHash("sha256").update(`git:${seed}`, "utf8").digest("hex").slice(0, 40);
const actionIdFor = (agent: string, index = 0): string => {
  const nibble = (agent.charCodeAt(0) % 10).toString();
  const suffix = `${nibble}${index}`.padStart(12, "0").slice(-12);
  return `10000000-0000-4000-8000-${suffix}`;
};
const acceptedResponseFixture = (input: {
  stepId: AcceptedResponse["stepId"];
  agent: string;
  round?: number | null;
  choice?: string;
  disposition?: AcceptedResponse["disposition"];
  acceptedAt?: string;
  actionId?: string;
  responseSha256?: string;
  rationale?: string;
  path?: string;
}): AcceptedResponse => {
  const actionId = input.actionId ?? actionIdFor(input.agent);
  return {
    stepId: input.stepId,
    agent: input.agent,
    actionId,
    round: input.round === undefined ? null : input.round,
    responseSha256: input.responseSha256 ?? responseDigestFixture(input.agent),
    rationale: input.rationale ?? "fixture rationale",
    path: input.path ?? `/runtime/accepted-responses/${input.agent}/${actionId}.json`,
    acceptedAt: input.acceptedAt ?? "2026-08-11T12:00:00.000Z",
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    ...(input.disposition === undefined ? {} : { disposition: input.disposition })
  };
};
const publishedBallotBatchFixture = (input: {
  kind: BallotBatch["kind"];
  activeRoster: readonly string[];
  round?: number | null;
  commitSha?: string;
  parentSha?: string;
  inputSetHash?: string;
  createdAt?: string;
  status?: BallotBatch["status"];
  batchId?: string;
}): BallotBatch => {
  const now = input.createdAt ?? "2026-08-11T12:00:00.000Z";
  const round = input.round === undefined ? null : input.round;
  return {
    batchId: input.batchId ?? "20000000-0000-4000-8000-000000000001",
    kind: input.kind,
    round,
    inputSetHash: input.inputSetHash ?? responseDigestFixture("batch"),
    activeRoster: [...input.activeRoster],
    responses: input.activeRoster.map((agent) => ({
      agent,
      actionId: actionIdFor(agent),
      responseSha256: responseDigestFixture(agent)
    })),
    paths: input.activeRoster.map((agent) =>
      input.kind === "plan-ballot-batch"
        ? `.plans/issue-1/ballot-${agent}.json`
        : input.kind === "comparison-ballot-batch"
          ? `.code-reviews/issue-1/ballot-${agent}.json`
          : `.code-reviews/issue-1/consensus-ballot-${agent}-round-${round ?? 1}.json`
    ),
    branch: "issue-1/coordinator-evidence",
    parentSha: input.parentSha ?? gitShaFixture("a"),
    commitSha: input.commitSha ?? gitShaFixture("b"),
    status: input.status ?? "published",
    attempts: 1,
    error: null,
    supersedes: null,
    createdAt: now,
    updatedAt: now
  };
};

const fixture = (options: { prPolicy?: "owner-only" | "coord-open-unmerged" | "coord-merged"; origin?: string } = {}) => {
  const workspace = mkdtempSync(join(tmpdir(), "coord-loop-"));
  roots.push(workspace);
  // Coord root and mailbox both inside the fixture's own directory, so the
  // receipts this test writes and clears cannot be seen by a parallel worker
  // and are removed with the rest of the fixture.
  const root = join(workspace, "coord-runtime");
  mkdirSync(root, { recursive: true });
  const paths = issueRuntimePaths(root, 1, join(workspace, "completes"));
  createIssueRuntime(paths, ["claude", "codex"]);
  initializeOperationalState(paths, {
    issue: 1,
    issueSessionId: `issue-1:${"a".repeat(40)}`,
    baselineSha: "a".repeat(40),
    profile: "consensus",
    originalRoster: ["claude", "codex"],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: options.prPolicy ?? "owner-only",
    automationDigest: "b".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
    trustedSourceCommit: "c".repeat(40),
    origin: options.origin ?? "/origin.git",
    coordRoot: root,
    configPath: join(root, "config.json"),
    agents: [
      { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "pull" },
      { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
    ],
    checks: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
    pollIntervalMs: 100
  });
  return { root, paths };
};

const seedPendingPublication = (paths: ReturnType<typeof fixture>["paths"], finalSha = "f".repeat(40)) => {
  const now = "2026-08-11T17:00:00.000Z";
  writeFileSync(
    paths.issueSnapshot,
    `${JSON.stringify(
      {
        repository: "example/project",
        number: 1,
        title: "Improve coordinator PR text",
        body: "Make the PR useful.",
        url: "https://github.com/example/project/issues/1"
      },
      null,
      2
    )}\n`
  );
  const current = readCursorsState(paths);
  writeCursorsState(
    paths,
    cursorsStateSchema.parse({
      ...current,
      issueCursor: { stepId: "R7.finalize", gateId: "gate-7-finalized", round: null },
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "b".repeat(64),
          activeRoster: current.activeRoster,
          inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "d".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "e".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"b".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "codex",
          implementationPin: "e".repeat(40),
          reviser: "codex"
        },
        consensus: null
      },
      accepted: [
        {
          stepId: "R7.finalize",
          agent: "codex",
          round: null,
          submissionSha: "e".repeat(40),
          productPin: finalSha,
          checkResults: [{ name: "check", argv: ["pnpm", "check"], exitCode: 0 }],
          path: ".signals/issue-1/finalization-ready-codex.json",
          acceptedAt: now
        }
      ],
      publication: {
        status: "pending",
        finalSha,
        branch: "issue-1/codex-final",
        url: null,
        error: null,
        attempts: 0
      },
      updatedAt: now
    })
  );
  return { finalSha, now };
};

describe("effectful run loop", () => {
  it("derives an explicit GitHub PR target from supported origin forms", () => {
    expect(githubRepositoryFromOrigin("https://github.com/example/project.git")).toBe("example/project");
    expect(githubRepositoryFromOrigin("git@github.com:example/project.git")).toBe("example/project");
    expect(githubRepositoryFromOrigin("/tmp/origin.git")).toBeNull();
  });

  it("uses active roster order as a deterministic ballot tie-break", () => {
    const { paths } = fixture();
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const ballots = cursorsStateSchema.parse({
      ...current,
      acceptedResponses: [
        acceptedResponseFixture({
          stepId: "R3.plan-ballot",
          agent: "claude",
          choice: "claude",
          acceptedAt: now
        }),
        acceptedResponseFixture({
          stepId: "R3.plan-ballot",
          agent: "codex",
          choice: "codex",
          acceptedAt: now
        })
      ]
    });
    expect(deterministicWinner(ballots, "R3.plan-ballot", ["claude", "codex"])).toBe("claude");
    const reduced = dropAgent(ballots, "claude");
    expect(deterministicWinner(reduced, "R3.plan-ballot", ["codex"])).toBe("codex");
  });

  it("hashes the decision policy, roster, and exact accepted plan citations", () => {
    const { paths } = fixture();
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const accepted = current.activeRoster.map((agent, index) => ({
      stepId: "R2.plan" as const,
      agent,
      round: null,
      submissionSha: String(index + 1).repeat(40),
      path: `.plans/issue-1/plan-${agent}.md`,
      acceptedAt: now
    }));
    const acceptedResponses = current.activeRoster.map((agent) =>
      acceptedResponseFixture({
        stepId: "R3.plan-ballot",
        agent,
        choice: agent,
        acceptedAt: now,
        responseSha256: responseDigestFixture(agent)
      })
    );
    const state = cursorsStateSchema.parse({
      ...current,
      accepted,
      acceptedResponses,
      ballotBatches: [
        publishedBallotBatchFixture({
          kind: "plan-ballot-batch",
          activeRoster: current.activeRoster,
          createdAt: now,
          commitSha: "9".repeat(40)
        })
      ],
      evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) }
    });
    const decision = computePlanSelectionDerived(state, now);
    expect(decision?.inputs.map((input) => input.kind)).toEqual([
      "plan",
      "plan",
      "plan-ballot",
      "plan-ballot"
    ]);
    expect(decision?.selectedAgents).toEqual(["claude"]);
    expect(
      computeDerivedInputSetHash("plan-selection", [...state.activeRoster].reverse(), decision?.inputs ?? [])
    ).not.toBe(decision?.inputSetHash);
    expect(
      computeDerivedInputSetHash("implementation-selection", state.activeRoster, decision?.inputs ?? [])
    ).not.toBe(decision?.inputSetHash);
  });

  it("deduplicates a derived journal append left durable before cursor replacement", async () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R3.plan-ballot", gateId: "gate-3-selection", round: null },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: `.plans/issue-1/plan-${agent}.md`,
          acceptedAt: now
        })),
        acceptedResponses: current.activeRoster.map((agent) =>
          acceptedResponseFixture({
            stepId: "R3.plan-ballot",
            agent,
            choice: "codex",
            acceptedAt: now
          })
        ),
        ballotBatches: [
          publishedBallotBatchFixture({
            kind: "plan-ballot-batch",
            activeRoster: current.activeRoster,
            createdAt: now,
            commitSha: "9".repeat(40)
          })
        ],
        evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) }
      })
    );
    const record = computePlanSelectionDerived(readCursorsState(paths), now);
    expect(record).not.toBeNull();
    appendJournal(paths, { type: "decision-derived", details: derivedDecisionJournalDetails(record!) }, now);

    const after = await new CoordinatorRunLoop(paths, { tmux: null, now: () => now }).runTick();
    expect(after.issueCursor.stepId).toBe("R4.implement");
    expect(after.derived.planSelection?.decidedAt).toBe(now);
    expect(readJournal(paths).filter((event) => event.type === "decision-derived")).toHaveLength(1);
  });

  it("re-extracts brace-expanded plan paths when binding implement actions", async () => {
    const { paths } = fixture();
    const plan = `# Plan
## Exact File Map
- \`scripts/setup_{claude,codex}.sh\`
- \`src/product.ts\`
`;
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
        derived: {
          ...current.derived,
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "e".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "plan",
                agent: "codex",
                submissionSha: "b".repeat(40),
                path: ".plans/issue-1/plan.md"
              }
            ],
            decisionId: `plan-selection:${"e".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["codex"]
          }
        },
        accepted: [
          {
            stepId: "R2.plan",
            agent: "codex",
            round: null,
            submissionSha: "c".repeat(40),
            path: ".plans/issue-1/plan.md",
            approvedPaths: ["src/product.ts"],
            acceptedAt: now
          }
        ]
      })
    );
    const cursors = readCursorsState(paths);
    const approved = await resolveApprovedPaths({ readBlob: async () => plan }, cursors, "R4.implement");
    expect(approved).toEqual(["scripts/setup_claude.sh", "scripts/setup_codex.sh", "src/product.ts"]);
    const order = buildOrder(paths, readStartState(paths), cursors, "codex", "R4.implement", null, undefined, [], approved);
    expect(order.approvedPaths).toEqual(approved);
  });

  it("refreshes in-flight approved paths and reinjects only after positive idle evidence", async () => {
    const { paths } = fixture();
    const plan = `# Plan
## Exact File Map
- \`scripts/setup_{claude,codex}.sh\`
- \`src/product.ts\`
`;
    const now = "2026-08-11T17:00:00.000Z";
    const actionId = "10000000-0000-4000-8000-000000000001";
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
        derived: {
          ...current.derived,
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "e".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "plan",
                agent: "codex",
                submissionSha: "b".repeat(40),
                path: ".plans/issue-1/plan.md"
              }
            ],
            decisionId: `plan-selection:${"e".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["codex"]
          }
        },
        agents: {
          ...current.agents,
          claude: {
            ...current.agents.claude!,
            stepId: "R4.implement",
            evidenceId: "implementation-pinned",
            actionId: null,
            status: "waiting-peer",
            attempt: 1,
            submissionSha: null,
            outstanding: [],
            updatedAt: now
          },
          codex: {
            ...current.agents.codex!,
            stepId: "R4.implement",
            evidenceId: "implementation-pinned",
            actionId,
            status: "ordered",
            attempt: 1,
            submissionSha: null,
            outstanding: ["implementation changes paths outside the approved file map: scripts/setup_codex.sh"],
            updatedAt: now
          }
        },
        accepted: [
          {
            stepId: "R2.plan",
            agent: "codex",
            round: null,
            submissionSha: "c".repeat(40),
            path: ".plans/issue-1/plan.md",
            approvedPaths: ["src/product.ts"],
            acceptedAt: now
          }
        ]
      })
    );
    const stale = buildOrder(
      paths,
      readStartState(paths),
      readCursorsState(paths),
      "codex",
      "R4.implement",
      null,
      actionId,
      ["implementation changes paths outside the approved file map: scripts/setup_codex.sh"],
      ["src/product.ts"]
    );
    writeAction(paths.coordRoot, agentRuntimePaths(paths, "codex").action, stale);
    expect(readAction(agentRuntimePaths(paths, "codex").action).body).toMatch(
      /"approvedPaths": \[\s*"src\/product\.ts"\s*\]/
    );
    observeAgentLifecycle(paths, "codex", {
      kind: "session-start",
      eventName: "SessionStart",
      sessionId: "session-1"
    });

    const mirror = {
      path: paths.mirror,
      async initialize() {},
      async fetchBranch() {
        return { ok: false as const, details: "unused" };
      },
      async readBlob() {
        return plan;
      },
      async changedPaths() {
        return [];
      },
      async materializeWorktree() {},
      async removeWorktree() {},
      async publishBranch() {}
    };
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, mirror: mirror as never });
    await loop.runTick();
    const body = readAction(agentRuntimePaths(paths, "codex").action).body;
    expect(body).toContain("scripts/setup_claude.sh");
    expect(body).toContain("scripts/setup_codex.sh");
    expect(literalNudges).toBeGreaterThan(0);
  });

  it("prepares opaque actions for simultaneous agents", async () => {
    const { paths } = fixture();
    const loop = new CoordinatorRunLoop(paths, { tmux: null });
    const cursors = await loop.runTick();
    expect(cursors.agents.claude?.status).toBe("ordered");
    expect(cursors.agents.codex?.status).toBe("ordered");
    const action = readAction(agentRuntimePaths(paths, "codex").action);
    expect(action.submissionMode).not.toBe("response");
    if (action.submissionMode !== "response") {
      expect(action.requiredPath).toBe(".signals/issue-1/participation-ready-codex.json");
    }
    expect(action.body).not.toContain("gate-1-join");
    expect(action.body).toContain('"artifact": "participation-ready"');
    expect(action.body).toContain("```json");
    const start = readStartState(paths);
    expect(action.body).toContain(`"baselineSha": "${start.baselineSha}"`);
    expect(action.body).toContain(`"automationDigest": "${start.automationDigest}"`);
  });

  it("logs RN phase changes on the default log sink", async () => {
    const { paths } = fixture();
    const messages: string[] = [];
    const loop = new CoordinatorRunLoop(paths, {
      tmux: null,
      log: (message) => messages.push(message)
    });
    await loop.runTick();
    expect(messages).toEqual(["Issue 1: R1.join"]);

    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        accepted: current.activeRoster.map((agent) => ({
          stepId: "R1.join" as const,
          agent,
          round: null,
          submissionSha: "c".repeat(40),
          path: `.signals/issue-1/participation-ready-${agent}.json`,
          acceptedAt: now
        })),
        agents: Object.fromEntries(
          current.activeRoster.map((agent) => {
            const cursor = current.agents[agent];
            if (cursor === undefined) throw new Error(`missing cursor ${agent}`);
            return [
              agent,
              { ...cursor, status: "waiting-peer", actionId: null, submissionSha: null, outstanding: [] }
            ];
          })
        )
      })
    );
    await loop.runTick();
    expect(messages).toEqual(["Issue 1: R1.join", "Issue 1: R1.join → R2.plan"]);
  });

  it("reopens missing Terminal windows when resuming a live issue", async () => {
    const { paths } = fixture();
    const launched: string[] = [];
    const messages: string[] = [];
    const tmux = new TmuxController(
      async (args) => {
        if (args[0] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
        if (args[0] === "list-windows") return { exitCode: 0, stdout: "claude\ncodex\n", stderr: "" };
        if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tclaude\t0\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      null,
      async (launches) => {
        launched.push(...launches.map((launch) => launch.agentId));
      },
      null,
      async () => undefined,
      null,
      () => []
    );
    await new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) }).initializeEffects();
    expect(launched).toEqual(["claude", "codex"]);
    expect(messages.join("\n")).toContain("Opened 2 Terminal window(s)");
  });

  it("clears malformed completion and reissues the same action with a concrete correction", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux });
    await loop.runTick();
    const firstNudges = literalNudges;
    expect(firstNudges).toBeGreaterThan(0);
    const runtime = agentRuntimePaths(paths, "codex");
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    writeFileSync(runtime.complete, "not-a-sha\n");
    await loop.runTick();
    expect(readCursorsState(paths).agents.codex).toMatchObject({ actionId, status: "ordered", attempt: 2 });
    expect(readAction(runtime.action).body).toContain("complete must contain a 40-character lowercase Git SHA");
    expect(readJournal(paths).some((event) => event.type === "verify-result")).toBe(true);
    expect(readJournal(paths).some((event) => event.type === "nudged" && event.details.reissue === true)).toBe(true);
    expect(literalNudges).toBeGreaterThan(firstNudges);
  });


  it("journals a reason code for every deferred delivery and keeps repeats off normal output", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    const messages: string[] = [];
    const foreground = "bash";
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: `0\t${foreground}\t0\t0\n`, stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: "some output", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) });
    await loop.runTick();
    const first = readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex");
    expect(first).toHaveLength(1);
    expect(first[0]?.details).toMatchObject({
      layer: "scrape",
      code: "foreground-mismatch",
      detail: "bash",
      // The action is out and unanswered, so the workflow is blocked on it.
      gateWaiting: true
    });
    expect(first[0]?.details.human).toBe("the foreground process is not this agent's harness");
    const printedOnce = messages.filter((message) => message.includes("foreground-mismatch"));
    expect(printedOnce).toHaveLength(1);
    // A second tick with an unchanged reason journals again but does not repeat on stdout.
    await loop.runTick();
    expect(
      readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex").length
    ).toBeGreaterThan(1);
    expect(messages.filter((message) => message.includes("foreground-mismatch"))).toHaveLength(1);
  });

  it("records hooks and pane on one event when they disagree", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    const messages: string[] = [];
    let paneReady = true;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") {
        return { exitCode: 0, stdout: `0\t${paneReady ? "codex" : "bash"}\t0\t0\n`, stderr: "" };
      }
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: "❯ ", stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) });
    await loop.runTick();
    const action = readAgentLifecycle(paths).agents.codex?.action;
    expect(action).not.toBeNull();
    // Hooks say the agent finished and is idle; the pane says it cannot be typed into.
    observeAgentLifecycle(paths, "codex", {
      kind: "prompt-submitted",
      eventName: "UserPromptSubmit",
      sessionId: "session-1",
      turnId: "turn-1",
      actionId: action!.actionId,
      actionDigest: action!.actionDigest
    });
    observeAgentLifecycle(paths, "codex", {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "turn-1",
      backgroundActive: false
    });
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({ execution: "idle", health: "healthy" });
    paneReady = false;
    await loop.runTick();
    const split = readJournal(paths).filter(
      (event) => event.type === "nudge-deferred" && event.details.splitBrain === true
    );
    expect(split).toHaveLength(1);
    expect(split[0]?.details).toMatchObject({
      layer: "scrape",
      code: "foreground-mismatch",
      hooks: { execution: "idle", health: "healthy" }
    });
    expect(messages.some((message) => message.includes("looks idle to its lifecycle hooks"))).toBe(true);
  });

  it("blames correlation lag rather than the CLI when lifecycle hooks are live", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let paneText = "";
    const messages: string[] = [];
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS,
      log: (message) => messages.push(message)
    });
    // The session announced itself, so the bridge is demonstrably up.
    observeAgentLifecycle(
      paths,
      "codex",
      { kind: "session-start", eventName: "SessionStart", sessionId: "session-1" },
      new Date(nowMs).toISOString()
    );
    nowMs += 1_000;
    await loop.runTick();
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    paneText = actionId as string;
    nowMs += NUDGE_RETRY_MS + 1;
    await loop.runTick();
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({
      health: "degraded",
      degradedCause: "correlation-lagged"
    });
    const text = messages.join("\n");
    expect(text).toContain("no lifecycle signal correlated with the last delivery");
    expect(text).not.toContain("Restart");
    const degraded = readJournal(paths).find((event) => event.type === "agent-observability-degraded");
    expect(degraded?.details).toMatchObject({ cause: "correlation-lagged" });
  });

  it("uses 45 seconds only as a health watchdog and nudges once after a positive idle transition", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let literalNudges = 0;
    let paneText = "";
    const messages: string[] = [];
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS,
      log: (message) => messages.push(message)
    });
    await loop.runTick();
    expect(literalNudges).toBe(1);
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    expect(actionId).toMatch(/^[0-9a-f-]{36}$/);
    paneText = actionId as string;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    nowMs += NUDGE_RETRY_MS - 1;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    nowMs += 1;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    expect(readAgentLifecycle(paths).agents.codex?.health).toBe("degraded");
    expect(messages.join("\n")).toContain("Restart codex's CLI");
    const action = readAgentLifecycle(paths).agents.codex?.action;
    expect(action).not.toBeNull();
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "prompt-submitted",
        eventName: "UserPromptSubmit",
        sessionId: "session-1",
        turnId: "turn-1",
        actionId: action!.actionId,
        actionDigest: action!.actionDigest
      },
      new Date(nowMs + 1).toISOString()
    );
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "stopped",
        eventName: "Stop",
        sessionId: "session-1",
        turnId: "turn-1",
        backgroundActive: false
      },
      new Date(nowMs + 2).toISOString()
    );
    await loop.runTick();
    expect(literalNudges).toBe(2);
    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readCursorsState(paths).agents.codex).toMatchObject({ actionId, status: "ordered" });
    const nudged = readJournal(paths).filter((event) => event.type === "nudged" && event.agent === "codex");
    expect(nudged).toHaveLength(2);
    expect(nudged[1]?.details).toMatchObject({ idle: true, actionDigest: action!.actionDigest });
  });

  it("retries an action that a busy pane never injected", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let busy = true;
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") {
        return { exitCode: 0, stdout: busy ? "0\tcodex\t1\n" : "0\tcodex\t0\n", stderr: "" };
      }
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux });
    await loop.runTick();
    expect(literalNudges).toBe(0);
    expect(readAgentLifecycle(paths).agents.codex?.action?.delivery).toBe("ordered");

    busy = false;
    await loop.runTick();
    expect(literalNudges).toBe(1);
    expect(readAgentLifecycle(paths).agents.codex?.action?.delivery).toBe("injected");
    await loop.runTick();
    expect(literalNudges).toBe(1);
  });

  it("retries an idle-exhausted action only when the pane proves the action is absent", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    let literalNudges = 0;
    let paneText = "";
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS
    });
    await loop.runTick();
    expect(literalNudges).toBe(1);
    const action = readAgentLifecycle(paths).agents.codex?.action;
    const actionId = action!.actionId;
    paneText = `❯ ${actionId}`;

    // A real turn ran and stopped: that positive idle transition authorizes the
    // one ordinary resend, which spends it.
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "prompt-submitted",
        eventName: "UserPromptSubmit",
        sessionId: "session-1",
        turnId: "turn-1",
        actionId,
        actionDigest: action!.actionDigest
      },
      new Date(nowMs + 1).toISOString()
    );
    observeAgentLifecycle(
      paths,
      "codex",
      {
        kind: "stopped",
        eventName: "Stop",
        sessionId: "session-1",
        turnId: "turn-1",
        backgroundActive: false
      },
      new Date(nowMs + 2).toISOString()
    );
    // The resend happens after that acceptance, so it is a fresh delivery
    // awaiting acceptance rather than an already-accepted one.
    nowMs += 10;
    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readAgentLifecycle(paths).agents.codex?.action).toMatchObject({
      delivery: "injected",
      turnId: null
    });
    const exhausted = readAgentLifecycle(paths).agents.codex!;
    expect(decideLifecycleNudge(exhausted, actionId, action!.actionDigest).code).toBe(
      "idle-transition-already-used"
    );

    // Elapsed time alone is not authority: the action is still on screen, so
    // the send was not lost and nothing may resend.
    nowMs += NUDGE_RETRY_MS + 1;
    await loop.runTick();
    expect(literalNudges).toBe(2);

    // A ready prompt with no trace of the action is the positive proof.
    paneText = "❯ ready";
    await loop.runTick();
    expect(literalNudges).toBe(3);

    // The opportunity is consumed; a further tick sends nothing more.
    await loop.runTick();
    expect(literalNudges).toBe(3);
  });

  it("retracts a degraded warning once the agent's work reaches the workflow", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    const messages: string[] = [];
    let paneText = "❯ ";
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: paneText, stderr: "" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, {
      tmux,
      now: () => new Date(nowMs).toISOString(),
      nudgeRetryMs: NUDGE_RETRY_MS,
      log: (message) => messages.push(message)
    });
    await loop.runTick();
    const codex = readCursorsState(paths).agents.codex;
    const actionId = codex?.actionId as string;
    // The action is on screen, so the delivery was not lost and the watchdog
    // alert stands until workflow truth disproves it.
    paneText = `❯ ${actionId}`;
    nowMs += NUDGE_RETRY_MS + 1;
    await loop.runTick();
    expect(readAgentLifecycle(paths).agents.codex?.health).toBe("degraded");

    // Workflow truth arrives late: the agent had the action all along.
    const { markActionWorkflowComplete } = await import("../src/agentLifecycle.js");
    const cleared = markActionWorkflowComplete(paths, "codex", actionId, new Date(nowMs).toISOString());
    expect(cleared.clearedDegraded).toBe(true);
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({
      health: "healthy",
      degradedCause: null
    });
  });

  it("retries once when a later ready prompt proves an injected action is absent", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    writeFileSync(
      paths.start,
      `${JSON.stringify(
        {
          ...start,
          agents: start.agents.map((agent) =>
            agent.id === "codex" ? { ...agent, delivery: "both", harnessProcess: "codex" } : agent
          )
        },
        null,
        2
      )}\n`
    );
    let literalNudges = 0;
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
      if (args[0] === "capture-pane") return { exitCode: 0, stdout: "Codex\nready\n", stderr: "" };
      if (args[0] === "send-keys" && args.includes("-l")) literalNudges += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { tmux });
    await loop.runTick();
    expect(literalNudges).toBe(1);
    const action = readAgentLifecycle(paths).agents.codex!.action!;
    observeAgentLifecycle(paths, "codex", {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "unrelated-turn",
      backgroundActive: false
    });
    expect(readAgentLifecycle(paths).agents.codex?.execution).toBe("queued");

    await loop.runTick();
    expect(literalNudges).toBe(2);
    expect(readAgentLifecycle(paths).agents.codex?.action).toMatchObject({
      actionId: action.actionId,
      actionDigest: action.actionDigest,
      delivery: "injected"
    });
    await loop.runTick();
    expect(literalNudges).toBe(2);
  });

  it("does not degrade pull-only agents that are intentionally never injected", async () => {
    const { paths } = fixture();
    let nowMs = Date.parse("2026-08-18T00:00:00.000Z");
    const tmux = new TmuxController(async (args) =>
      args[0] === "display-message"
        ? { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" }
        : { exitCode: 0, stdout: "", stderr: "" }
    );
    const loop = new CoordinatorRunLoop(paths, { tmux, now: () => new Date(nowMs).toISOString() });
    await loop.runTick();
    nowMs += NUDGE_RETRY_MS;
    await loop.runTick();
    expect(readAgentLifecycle(paths).agents.codex?.health).toBe("unknown");
    expect(readJournal(paths).some((event) => event.type === "agent-observability-degraded")).toBe(false);
  });

  it("preserves completion and emits no artifact verdict on transient fetch failure", async () => {
    const { paths } = fixture();
    const mirror = new BareMirror(paths.mirror, "/origin.git", async () => ({
      exitCode: 1,
      stdout: Buffer.alloc(0),
      stderr: "fatal: network timeout"
    }));
    const loop = new CoordinatorRunLoop(paths, { tmux: null, mirror });
    await loop.runTick();
    const runtime = agentRuntimePaths(paths, "codex");
    writeFileSync(runtime.complete, `${"d".repeat(40)}\n`);
    await loop.runTick();
    expect(readFileSync(runtime.complete, "utf8")).toBe(`${"d".repeat(40)}\n`);
    expect(readCursorsState(paths).agents.codex).toMatchObject({ status: "intent" });
    expect(readJournal(paths).filter((event) => event.type === "verify-result")).toHaveLength(0);
  });

  it("recovers a complete origin tip when a harness disappears before writing completion", async () => {
    const { paths } = fixture();
    let branch = "";
    const tip = "d".repeat(40);
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2];
      if (command === "fetch") {
        branch = args.at(-1)?.includes("claude") === true ? "claude" : "codex";
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      }
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${tip}\n`), stderr: "" };
      if (command === "merge-base") return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      if (command === "show") {
        return {
          exitCode: 0,
          stdout: Buffer.from(
            JSON.stringify({
              protocolVersion: 1,
              artifact: "participation-ready",
              issue: 1,
              issueSessionId: `issue-1:${"a".repeat(40)}`,
              agent: branch,
              baselineSha: "a".repeat(40),
              automationDigest: "b".repeat(64)
            })
          ),
          stderr: ""
        };
      }
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const tmux = new TmuxController(async (args) => {
      const target = args[args.indexOf("-t") + 1] ?? "";
      return target.includes("claude")
        ? { exitCode: 1, stdout: "", stderr: "gone" }
        : { exitCode: 0, stdout: "0\tcodex\t0\n", stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux });
    await loop.runTick();
    const cursors = await loop.runTick();
    expect(cursors.accepted).toContainEqual(expect.objectContaining({ stepId: "R1.join", agent: "claude", submissionSha: tip }));
    expect(cursors.agents.codex?.status).toBe("ordered");
    expect(readJournal(paths).some((event) => event.details.pushedThenDied === true)).toBe(true);
  });

  it.each(["pause", "abandon", "drop"] as const)(
    "does not overwrite a concurrent %s control while a fetch is in flight",
    async (control) => {
      const { paths } = fixture();
      let releaseFetch: (() => void) | undefined;
      let announceFetch: (() => void) | undefined;
      const fetchStarted = new Promise<void>((resolve) => (announceFetch = resolve));
      const fetchRelease = new Promise<void>((resolve) => (releaseFetch = resolve));
      const commands: string[] = [];
      const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
        const command = args[2] ?? "";
        commands.push(command);
        if (command === "fetch") {
          announceFetch?.();
          await fetchRelease;
          return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
        }
        if (command === "rev-parse") {
          return { exitCode: 0, stdout: Buffer.from(`${"d".repeat(40)}\n`), stderr: "" };
        }
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      });
      const loop = new CoordinatorRunLoop(paths, { tmux: null, mirror });
      await loop.runTick();
      const completion = agentRuntimePaths(paths, "codex").complete;
      // The receipt is the one runtime file an agent writes, and it must not be
      // inside the tree that holds cursors.json and every peer's action.md.
      expect(completion.startsWith(`${paths.completesRoot}/`)).toBe(true);
      expect(completion.startsWith(`${paths.coordRoot}/`)).toBe(false);
      writeFileSync(completion, `${"d".repeat(40)}\n`);
      const pendingTick = loop.runTick();
      await fetchStarted;
      mutateCursorsState(paths, (current) => {
        if (control === "pause") return setPaused(current, true);
        if (control === "drop") return dropAgent(current, "claude");
        return cursorsStateSchema.parse({ ...current, abandoned: true, updatedAt: new Date().toISOString() });
      });
      releaseFetch?.();
      const after = await pendingTick;
      if (control === "pause") expect(after.paused).toBe(true);
      if (control === "abandon") expect(after.abandoned).toBe(true);
      if (control === "drop") expect(after.activeRoster).toEqual(["codex"]);
      expect(after.accepted.some((submission) => submission.agent === "codex" && submission.stepId === "R1.join")).toBe(false);
      expect(readFileSync(completion, "utf8")).toBe(`${"d".repeat(40)}\n`);
      expect(commands).not.toContain("show");
    }
  );

  it("accepts an in-flight completion while an owner question remains open", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const actionId = "ce80f31a-6884-42cf-b0ff-b0fb27fc6cc8";
    const revisionPin = "e".repeat(40);
    const seeded = cursorsStateSchema.parse({
      ...current,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "b".repeat(64),
          activeRoster: current.activeRoster,
          inputs: [
            {
              kind: "implementation",
              agent: "codex",
              submissionSha: "d".repeat(40),
              path: ".signals/issue-1/implementation-ready-codex.json",
              productPin: "f".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"b".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "codex",
          implementationPin: "f".repeat(40),
          reviser: "codex"
        },
        consensus: null
      },
      ownerQuestion: {
        id: "10000000-0000-4000-8000-000000000001",
        kind: "ballot-escalation",
        round: 1,
        allowedAnswers: ["retry", "revise", "abandon"],
        createdAt: now
      },
      agents: {
        ...current.agents,
        claude: {
          ...current.agents.claude,
          stepId: "R6.ballot",
          evidenceId: "consensus-response-accepted",
          submissionMode: "response",
          actionId,
          status: "ordered",
          updatedAt: now
        }
      },
      accepted: [
        {
          stepId: "R6.revise",
          agent: "codex",
          round: 1,
          submissionSha: "c".repeat(40),
          productPin: revisionPin,
          path: ".signals/issue-1/revision-ready-codex-round-1.json",
          acceptedAt: now
        }
      ],
      updatedAt: now
    });
    writeCursorsState(paths, seeded);
    const order = buildOrder(paths, start, seeded, "claude", "R6.ballot", 1, actionId);
    writeAction(paths.coordRoot, agentRuntimePaths(paths, "claude").action, order);
    const response: ConsensusBallotResponse = {
      actionId,
      disposition: "approve",
      rationale: "The revision is ready."
    };
    const responsePath = agentResponsePath(paths, "claude", actionId);
    writeAgentResponse(responsePath, paths.issueRoot, response);
    writeFileSync(agentRuntimePaths(paths, "claude").complete, `response ${actionId}\n`);

    const after = await new CoordinatorRunLoop(paths, { tmux: null }).runTick();
    expect(after.ownerQuestion?.id).toBe("10000000-0000-4000-8000-000000000001");
    expect(after.acceptedResponses).toContainEqual(
      expect.objectContaining({
        stepId: "R6.ballot",
        agent: "claude",
        round: 1,
        disposition: "approve",
        actionId
      })
    );
    expect(after.agents.claude?.status).toBe("waiting-peer");
    expect(existsSync(agentRuntimePaths(paths, "claude").complete)).toBe(false);
    expect(existsSync(responsePath)).toBe(false);
  });

  it("publishes exactly from durable accepted R7 outbox state and records retryable failure", async () => {
    const { paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "https://github.com/example/project.git" });
    const now = "2026-08-11T17:00:00.000Z";
    const finalSha = "f".repeat(40);
    writeFileSync(
      paths.issueSnapshot,
      `${JSON.stringify(
        {
          repository: "example/project",
          number: 1,
          title: "Improve coordinator PR text",
          body: "Make the PR useful.",
          url: "https://github.com/example/project/issues/1"
        },
        null,
        2
      )}\n`
    );
    const current = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R7.finalize", gateId: "gate-7-finalized", round: null },
        derived: {
          planSelection: null,
          implementationSelection: {
            kind: "implementation-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "b".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "implementation",
                agent: "codex",
                submissionSha: "d".repeat(40),
                path: ".signals/issue-1/implementation-ready-codex.json",
                productPin: "e".repeat(40)
              }
            ],
            decisionId: `implementation-selection:${"b".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            winner: "codex",
            implementationPin: "e".repeat(40),
            reviser: "codex"
          },
          consensus: null
        },
        accepted: [
          {
            stepId: "R7.finalize",
            agent: "codex",
            round: null,
            submissionSha: "e".repeat(40),
            productPin: finalSha,
            checkResults: [{ name: "check", argv: ["pnpm", "check"], exitCode: 0 }],
            path: ".signals/issue-1/finalization-ready-codex.json",
            acceptedAt: now
          }
        ],
        publication: {
          status: "pending",
          finalSha,
          branch: "issue-1/codex-final",
          url: null,
          error: null,
          attempts: 0
        },
        updatedAt: now
      })
    );
    let pushes = 0;
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async (args) => {
      if (args[2] === "push") pushes += 1;
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    let opens = 0;
    const failing = new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async () => {
        opens += 1;
        expect(readCursorsState(paths).accepted.some((submission) => submission.stepId === "R7.finalize")).toBe(true);
        throw new Error("GitHub unavailable");
      }
    });
    const failed = await failing.runTick();
    expect(failed.publication).toMatchObject({ status: "failed", error: "GitHub unavailable", attempts: 1 });
    expect(failed.accepted.some((submission) => submission.stepId === "R7.finalize")).toBe(true);

    const recovered = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async () => {
        opens += 1;
        return { url: "https://github.com/example/project/pull/1" };
      }
    }).runTick();
    expect(recovered.publication).toMatchObject({
      status: "completed",
      url: "https://github.com/example/project/pull/1",
      attempts: 2
    });
    expect(recovered.completed).toBe(true);
    expect(pushes).toBe(2);
    expect(opens).toBe(2);
    expect(readJournal(paths).filter((event) => event.type === "pr-created")).toHaveLength(1);
  });

  it("opens a draft PR under legacy owner-only", async () => {
    const { paths } = fixture({ prPolicy: "owner-only", origin: "https://github.com/example/project.git" });
    seedPendingPublication(paths);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));
    const opened: Array<{ draft: boolean; title: string; body: string }> = [];
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async (input) => {
        opened.push({ draft: input.draft, title: input.title, body: input.body });
        return { url: "https://github.com/example/project/pull/2" };
      }
    }).runTick();
    expect(opened).toEqual([
      {
        draft: true,
        title: "Issue 1: Improve coordinator PR text",
        body: "Closes #1\n\nDraft PR for issue 1. Owner merges. Final pin: ffffffffffffffffffffffffffffffffffffffff."
      }
    ]);
    expect(result.publication).toMatchObject({
      status: "completed",
      url: "https://github.com/example/project/pull/2",
      branch: "issue-1/codex-final"
    });
  });

  it("opens a ready PR and merges it under coord-merged", async () => {
    const { paths } = fixture({ prPolicy: "coord-merged", origin: "https://github.com/example/project.git" });
    seedPendingPublication(paths);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));
    let merges = 0;
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async (input) => {
        expect(input.draft).toBe(false);
        expect(input.title).toBe("Issue 1: Improve coordinator PR text");
        expect(input.body).toContain("Closes #1");
        expect(input.body).toContain("Coordinator merges");
        return { url: "https://github.com/example/project/pull/3" };
      },
      pullRequestMerger: async (input) => {
        expect(input.url).toBe("https://github.com/example/project/pull/3");
        merges += 1;
      }
    }).runTick();
    expect(merges).toBe(1);
    expect(result.publication.status).toBe("completed");
    expect(readJournal(paths).map((event) => event.type)).toEqual(
      expect.arrayContaining(["pr-created", "pr-merged"])
    );
  });

  it("keeps the PR URL when coord-merged merge fails so the owner can finish it", async () => {
    const { paths } = fixture({ prPolicy: "coord-merged", origin: "https://github.com/example/project.git" });
    seedPendingPublication(paths);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git", async () => ({
      exitCode: 0,
      stdout: Buffer.alloc(0),
      stderr: ""
    }));
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      pullRequestOpener: async () => ({ url: "https://github.com/example/project/pull/4" }),
      pullRequestMerger: async () => {
        throw new Error("protected branch");
      }
    }).runTick();
    expect(result.publication).toMatchObject({
      status: "failed",
      url: "https://github.com/example/project/pull/4",
      error: "protected branch"
    });
  });

  it("records an invalid persisted publication origin as a retryable failure", async () => {
    const { paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "/unsupported/origin.git" });
    const finalSha = "f".repeat(40);
    const current = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        publication: {
          status: "pending",
          finalSha,
          branch: "issue-1/codex-final",
          url: null,
          error: null,
          attempts: 0
        }
      })
    );
    let pushes = 0;
    const mirror = new BareMirror(paths.mirror, "/unsupported/origin.git");
    mirror.publishBranch = async () => {
      pushes += 1;
    };
    const messages: string[] = [];
    const result = await new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      log: (message) => messages.push(message)
    }).runTick();
    expect(result.publication).toMatchObject({
      status: "failed",
      finalSha,
      branch: "issue-1/codex-final",
      error: "Cannot derive a GitHub repository from origin /unsupported/origin.git.",
      attempts: 1
    });
    expect(pushes).toBe(0);
    expect(messages.join(" ")).toContain("Owner action required: finalization publication failed");
    expect(readJournal(paths).at(-1)?.type).toBe("publication-failed");
  });

  it("keeps failed final checks in verification and performs no publication effect", async () => {
    const { root, paths } = fixture({ prPolicy: "coord-open-unmerged", origin: "https://github.com/example/project.git" });
    const seed = join(root, "final-seed");
    execFileSync("git", ["init", "-q", seed]);
    mkdirSync(join(seed, ".signals/issue-1"), { recursive: true });
    writeFileSync(join(seed, ".signals/issue-1/revision-ready-codex.json"), "{}\n");
    execFileSync("git", ["-C", seed, "add", "."]);
    execFileSync("git", ["-C", seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "revision"]);
    const revisionSha = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    rmSync(join(seed, ".signals/issue-1"), { recursive: true });
    execFileSync("git", ["-C", seed, "add", "-A"]);
    execFileSync("git", ["-C", seed, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "cleanup"]);
    const finalSha = execFileSync("git", ["-C", seed, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    execFileSync("git", ["clone", "--bare", "-q", seed, paths.mirror]);
    const mirror = new BareMirror(paths.mirror, "https://github.com/example/project.git");
    let pushes = 0;
    mirror.publishBranch = async () => {
      pushes += 1;
    };
    let opens = 0;
    const loop = new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      processRunner: async () => ({ exitCode: 1, stdout: "", stderr: "test failed" }),
      pullRequestOpener: async () => {
        opens += 1;
        return { url: "https://github.com/example/project/pull/1" };
      }
    });
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const baseOrder = buildOrder(paths, start, cursors, "codex", "R7.finalize", null);
    const order = {
      ...baseOrder,
      inputs: [
        {
          agent: "codex",
          commitSha: revisionSha,
          path: ".signals/issue-1/revision-ready-codex.json",
          kind: "consensus"
        }
      ]
    };
    const observation = await loop.verifyFinalizationChecks(
      start,
      order,
      {
        agent: "codex",
        actionId: order.actionId,
        submissionSha: "e".repeat(40),
        status: "satisfied",
        outstanding: [],
        productPin: finalSha
      },
      cursors
    );
    expect(observation.status).toBe("rejected");
    expect(observation.outstanding.join(" ")).toContain("finalization check (tier: checks) check failed");
    // Which tier failed must be legible in the journal: the agent's own clone
    // runs the declared `verify` before a commit exists, and only the hermetic
    // `checks` at the approved commit reach here.
    const finalCheck = readJournal(paths).find((event) => event.type === "final-check");
    expect(finalCheck?.details).toMatchObject({ tier: "checks", name: "check", exitCode: 1 });
    expect(pushes).toBe(0);
    expect(opens).toBe(0);
    expect(readCursorsState(paths).publication.status).toBe("not-required");
  });
});

describe("coordinator-resolved change scope", () => {
  const pinnedInputs = (pins: readonly [string, string][]) =>
    pins.map(([agent, commitSha]) => ({
      agent,
      commitSha,
      path: `.signals/issue-1/implementation-ready-${agent}.json`,
      kind: "implementation"
    }));

  const countingMirror = (paths: readonly string[]) => {
    const calls: string[] = [];
    return {
      calls,
      changedPaths: async (base: string, tip: string) => {
        calls.push(`${base}..${tip}`);
        return [...paths];
      }
    };
  };

  it("resolves one entry per pinned input", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const mirror = countingMirror(["src/b.ts", "src/a.ts"]);
    const scope = await resolveChangeScope(
      mirror,
      start,
      pinnedInputs([
        ["claude", "1".repeat(40)],
        ["codex", "2".repeat(40)]
      ])
    );
    expect(scope.map((entry) => entry.agent)).toEqual(["claude", "codex"]);
    expect(scope[0]?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(scope[0]?.truncated).toBe(false);
  });

  /**
   * The whole point of resolving centrally: four agents comparing the same pins
   * must cost one diff per pin, not one per agent per pin.
   */
  it("reads each distinct pin once even when several inputs share it", async () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const mirror = countingMirror(["src/a.ts"]);
    const shared = "3".repeat(40);
    await resolveChangeScope(
      mirror,
      start,
      pinnedInputs([
        ["claude", shared],
        ["codex", shared],
        ["cursor", "4".repeat(40)]
      ])
    );
    expect(mirror.calls).toEqual([`${start.baselineSha}..${shared}`, `${start.baselineSha}..${"4".repeat(40)}`]);
  });

  it("does no git work for a step with no pinned inputs", async () => {
    const { paths } = fixture();
    const mirror = countingMirror(["src/a.ts"]);
    const scope = await resolveChangeScope(mirror, readStartState(paths), [
      { agent: "claude", commitSha: "5".repeat(40), path: ".plans/issue-1/plan.md", kind: "plan" }
    ]);
    expect(scope).toEqual([]);
    expect(mirror.calls).toEqual([]);
  });

  it("caps a large diff and marks it truncated", async () => {
    const { paths } = fixture();
    const many = Array.from({ length: CHANGE_SCOPE_PATH_LIMIT + 5 }, (_, index) =>
      `src/f${String(index).padStart(4, "0")}.ts`
    );
    const scope = await resolveChangeScope(countingMirror(many), readStartState(paths), pinnedInputs([["claude", "6".repeat(40)]]));
    expect(scope[0]?.paths).toHaveLength(CHANGE_SCOPE_PATH_LIMIT);
    expect(scope[0]?.truncated).toBe(true);
  });

  /**
   * Advisory scope must never be able to stall a step: an unreadable pin is
   * omitted, and the action is still prepared.
   */
  it("omits a pin whose diff cannot be read rather than failing preparation", async () => {
    const { paths } = fixture();
    const failing = {
      changedPaths: async () => {
        throw new Error("unknown revision");
      }
    };
    const scope = await resolveChangeScope(failing, readStartState(paths), pinnedInputs([["claude", "7".repeat(40)]]));
    expect(scope).toEqual([]);
  });

  /**
   * The memoisation guarantee has to hold on the failure path too. Caching only
   * successes meant four agents bound to one unreadable pin produced four
   * failing git invocations per tick — the exact per-agent repetition this
   * feature exists to remove, surviving in the branch no test covered.
   */
  it("attempts an unreadable pin once per tick, not once per input", async () => {
    const { paths } = fixture();
    let attempts = 0;
    const failing = {
      changedPaths: async () => {
        attempts += 1;
        throw new Error("unknown revision");
      }
    };
    const broken = "8".repeat(40);
    const scope = await resolveChangeScope(
      failing,
      readStartState(paths),
      pinnedInputs([
        ["claude", broken],
        ["codex", broken],
        ["cursor", broken]
      ])
    );
    expect(scope).toEqual([]);
    expect(attempts).toBe(1);
  });

  // The branch is prepared before any agent starts, but an agent that compacts
  // or restarts only has the action in front of it. It used to be told once, on
  // the first action of the run.
  it("tells every action that the branch is already checked out", () => {
    const { paths } = fixture();
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    for (const stepId of ["R1.join", "R2.plan", "R4.implement", "R7.finalize"] as const) {
      const order = buildOrder(paths, start, cursors, "claude", stepId, null);
      expect(order.task, stepId).toContain("already checked this clone out");
      expect(order.task, stepId).toContain("Do not create that branch");
      // Said once, not twice, on the step that used to carry it inline.
      expect(order.task.split("already checked this clone out").length - 1, stepId).toBe(1);
    }
  });

  it("carries configured context paths from start state into every order", () => {
    const { paths } = fixture();
    const start = { ...readStartState(paths), contextPaths: ["docs/repo-map.md"] };
    const order = buildOrder(paths, start, readCursorsState(paths), "claude", "R2.plan", null);
    expect(order.contextPaths).toEqual(["docs/repo-map.md"]);
    expect(order.changeScope).toEqual([]);
  });
});
