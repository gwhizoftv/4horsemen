import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAction, writeAction } from "../src/action.js";
import { decideLifecycleNudge, initialAgentLifecycle, observeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { BareMirror } from "../src/mirror.js";
import { agentResponsePath, agentRuntimePaths, createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  materializeBoundInputs,
  pruneSupersededWorktrees,
  worktreeLabelsFor
} from "../src/materializedInputs.js";
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
  releaseHold,
  writeCursorsState
} from "../src/state.js";
import { TmuxController } from "../src/tmux.js";
import type { CodexQuotaReader, CodexQuotaResult } from "../src/codexQuota.js";
import { readBindingRecord } from "../src/codexQuota.js";
import { parseClaudeRateLimits, parseCodexRateLimits } from "../src/resourceEvidence.js";
import { resourceBindingPaths } from "../src/paths.js";
import type { RunLoopDependencies } from "../src/runLoop.js";
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

const safetyFixture = (vendor = "codex", dependencies: RunLoopDependencies = {}) => {
  const { paths } = fixture();
  let nowMs = Date.parse("2026-09-22T12:00:00.000Z");
  const now = () => new Date(nowMs).toISOString();
  const start = readStartState(paths);
  writeFileSync(paths.start, JSON.stringify({ ...start, profile: "solo", originalRoster: [vendor],
    agents: [{ ...start.agents[0], id: vendor, delivery: "both", harnessProcess: "harness", nudgePrelude: [], nudgeSubmit: ["Enter"] }] }));
  createIssueRuntime(paths, [vendor]);
  const current = readCursorsState(paths);
  writeCursorsState(paths, cursorsStateSchema.parse({ ...current, activeRoster: [vendor], agents: { [vendor]: current.agents.codex } }));
  writeFileSync(paths.agentLifecycle, JSON.stringify(initialAgentLifecycle([vendor], now())));
  const ui = { foreground: "harness", busy: false, dead: false, text: "❯ Antigravity Gemini >", failSubmit: false,
    waitAtCapture: Infinity, sends: 0, captures: 0 };
  const messages: string[] = [];
  const tmux = new TmuxController(async (args) => {
    if (args[0] === "display-message") return { exitCode: 0, stdout: `${ui.dead ? 1 : 0}\t${ui.foreground}\t${ui.busy ? 1 : 0}\t0\n`, stderr: "" };
    if (args[0] === "capture-pane") {
      ui.captures++;
      return { exitCode: 0, stdout: ui.captures >= ui.waitAtCapture ? "Usage limit reset · continuing automatically\n❯" : ui.text, stderr: "" };
    }
    if (args[0] === "send-keys" && args.includes("-l")) ui.sends++;
    if (args[0] === "send-keys" && !args.includes("-l") && ui.sends > 0 && ui.failSubmit) throw new Error("connection lost");
    return { exitCode: 0, stdout: "", stderr: "" };
  }, undefined, undefined, undefined, async () => undefined);
  // Every tick uses a new coordinator: all protections must be durable.
  const makeLoop = (extra: RunLoopDependencies = {}) => new CoordinatorRunLoop(paths, { tmux, now, nudgeRetryMs: 1,
    log: (message) => messages.push(message), ...dependencies, ...extra });
  const tick = () => makeLoop().runTick();
  let turn = 0;
  const working = () => {
    const action = readAgentLifecycle(paths).agents[vendor]!.action!;
    observeAgentLifecycle(paths, vendor, { kind: "prompt-submitted", eventName: "prompt", sessionId: "session", turnId: `turn-${++turn}`,
      actionId: action.actionId, actionDigest: action.actionDigest }, now());
  };
  const stop = () => observeAgentLifecycle(paths, vendor, { kind: "stopped", eventName: "stop", sessionId: "session",
    turnId: `turn-${turn}`, backgroundActive: false }, now());
  return { paths, ui, messages, now, tick, makeLoop, working, stop, advance: (ms: number) => { nowMs += ms; } };
};

const QUOTA_BASE = Date.parse("2026-09-22T12:00:00.000Z");
const hoursFromBase = (hours: number): number => QUOTA_BASE / 1000 + hours * 3600;
const codexLimits = (weeklyPercent: number, resetHours: number, extra: Record<string, unknown> = {}, buckets?: Record<string, unknown>) => {
  const bucket = { limitId: "codex", limitName: null, normalModelSlug: null, credits: { hasCredits: false, unlimited: false, balance: "0" },
    individualLimit: null, spendControlReached: false, planType: "plus",
    rateLimitReachedType: weeklyPercent >= 100 ? "rate_limit_reached" : null,
    primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: hoursFromBase(2) },
    secondary: { usedPercent: weeklyPercent, windowDurationMins: 10_080, resetsAt: hoursFromBase(resetHours) } };
  return { status: "ok" as const, reaped: true as const, helper: { userAgent: "codex_cli_rs/0.156.1 (fake)", codexHome: "/owner/.codex" },
    limits: parseCodexRateLimits({ ordinaryUsageAllowed: weeklyPercent < 100,
    rateLimits: bucket, rateLimitsByLimitId: buckets ?? { codex: bucket }, rateLimitResetCredits: null, accountId: "acct-1",
    rateLimitUpsell: null, ...extra }) };
};

/** A codex safety fixture bound to one owner-confirmed home/account, with a scripted reader. */
const quotaFixture = (results: CodexQuotaResult[], during?: () => void, validatedVersion: string | null = "0.156.1") => {
  const reads: string[] = [];
  let clock: () => string = () => "";
  const reader: CodexQuotaReader = async () => {
    reads.push(clock());
    during?.();
    return results.shift() ?? { status: "failed", error: "unscripted", reaped: true };
  };
  const f = safetyFixture("codex", { codexQuota: reader });
  clock = f.now;
  const start = readStartState(f.paths);
  writeFileSync(f.paths.start, JSON.stringify({ ...start, agents: [{ ...start.agents[0], codexQuota: {
    codexHome: "/owner/.codex", accountId: "acct-1", ...(validatedVersion === null ? {} : { validatedVersion }) } }] }));
  return { ...f, reads };
};

describe("vendor resource evidence and recovery", () => {
  const claudeFailure = (f: ReturnType<typeof safetyFixture>, error: string, details: string | null, fiveHour: number) => {
    observeAgentLifecycle(f.paths, "claude", { kind: "telemetry", eventName: "status-line", sessionId: "session",
      rateLimits: parseClaudeRateLimits({ rate_limits: { five_hour: { used_percentage: fiveHour, resets_at: hoursFromBase(2) } } })! }, f.now());
    f.advance(1_000);
    observeAgentLifecycle(f.paths, "claude", { kind: "failed", eventName: "StopFailure", sessionId: "session", backgroundActive: false,
      failure: { vendor: "claude", error, errorDetails: details, lastAssistantMessage: null } }, f.now());
  };

  it("holds a matching Claude window with its exact deadline and rechecks once through run() without a prompt", async () => {
    const f = safetyFixture("claude");
    await f.tick();
    f.advance(1); f.working();
    claudeFailure(f, "rate_limit", null, 100);
    const held = await f.tick();
    expect(held.holds).toEqual([expect.objectContaining({ reason: "vendor-failure", retryOwner: "owner", confidence: "exact",
      resetsAt: new Date(hoursFromBase(2) * 1000).toISOString(), evidence: expect.objectContaining({ failureClass: "usage-window" }) })]);
    expect(held.actionSafety.claude?.sends).toBe(1);
    const journal = readFileSync(f.paths.journal, "utf8");
    const cursors = readFileSync(f.paths.cursors, "utf8");
    const untilRecheck = Date.parse(held.holds[0]!.resetsAt!) + 29_000 - Date.parse(f.now());
    for (let i = 0; i < 1000; i++) { f.advance(untilRecheck / 1000); await f.tick(); }
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(cursors);
    let sleeps = 0;
    // A held runner stays alive only for the scheduled recheck; it never initializes effects here.
    await f.makeLoop({ sleep: async () => { sleeps++; f.advance(1_000); } }).run();
    expect(sleeps).toBeGreaterThan(0);
    const after = readCursorsState(f.paths);
    expect(after.holds).toEqual(held.holds);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-updated")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ outcome: "owner-release-required" }) })
    ]);
    expect(f.messages.at(-1)).toContain("owner release required");
    expect(f.ui.sends).toBe(1);
    // An owner release is not re-held by the same failure episode.
    mutateCursorsState(f.paths, (current) => releaseHold(current, held.holds[0]!.id, false, f.now()));
    expect((await f.tick()).holds.filter((hold) => hold.reason === "vendor-failure")).toEqual([]);
  });

  it.each([
    ["a model-family restriction", "rate_limit", "Opus weekly limit reached", 100, "usage-window"],
    ["a spend restriction", "billing_error", null, 100, "billing"]
  ])("keeps %s at an unknown reset and lets run() return at once", async (_label, error, details, fiveHour, failureClass) => {
    const f = safetyFixture("claude");
    await f.tick();
    f.advance(1); f.working();
    claudeFailure(f, error, details, fiveHour);
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-failure", resetsAt: null, confidence: "unknown", evidence: { failureClass } });
    let sleeps = 0;
    await f.makeLoop({ sleep: async () => { sleeps++; } }).run();
    expect(sleeps).toBe(0);
    const journal = readFileSync(f.paths.journal, "utf8");
    f.advance(7 * 86400_000);
    for (let i = 0; i < 200; i++) await f.tick();
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
  });

  it("leaves throttling and unknown Claude failures on the budgeted #126 path", async () => {
    const f = safetyFixture("claude");
    await f.tick();
    f.advance(1); f.working();
    claudeFailure(f, "rate_limit", null, 20);
    expect((await f.tick()).holds).toEqual([]);
    expect(readAgentLifecycle(f.paths).agents.claude?.lastFailure?.evidence.failureClass).toBe("throttled");
  });

  it("bounds Codex reads across restarts: spacing, delayed retries, shifted deadlines and six starts", async () => {
    const f = quotaFixture([
      codexLimits(20, 50),
      codexLimits(100, 50),
      { status: "failed", error: "exit 1", reaped: true },
      codexLimits(100, 60),
      codexLimits(100, 70),
      codexLimits(100, 80)
    ]);
    await f.tick(); // prepares and sends the action
    expect(f.ui.sends).toBe(1);
    await f.tick(); // one persisted initial binding check
    expect(f.reads).toHaveLength(1);
    for (let i = 0; i < 20; i++) await f.tick();
    expect(f.reads).toHaveLength(1); // no idle polling
    f.ui.dead = true;
    f.advance(60_000);
    await f.tick(); // #126 harness-gone hold is the watchdog trigger
    for (let i = 0; i < 5000; i++) { f.advance(60_000); await f.tick(); }
    expect(f.reads).toHaveLength(6);
    const gaps = f.reads.slice(1).map((at, index) => Date.parse(at) - Date.parse(f.reads[index]!));
    expect(gaps.every((gap) => gap >= 300_000)).toBe(true);
    // The failed read retried after five minutes, not at the next tick.
    expect(Date.parse(f.reads[3]!) - Date.parse(f.reads[2]!)).toBe(300_000);
    expect(Date.parse(f.reads[2]!)).toBeGreaterThanOrEqual(hoursFromBase(50) * 1000 + 30_000);
    const final = readCursorsState(f.paths);
    expect(final.actionSafety.codex?.resource).toMatchObject({ starts: 6, terminal: "the quota observation budget for this action is spent" });
    expect(final.holds.map((hold) => hold.reason)).toEqual(["harness-gone", "vendor-failure"]);
    expect(final.actionSafety.codex?.sends).toBe(1);
    const events = readJournal(f.paths);
    expect(events.filter((event) => event.type === "hold-created")).toHaveLength(2);
    expect(events.filter((event) => event.type === "resource-observation")).toHaveLength(1);
    expect(events.filter((event) => event.type === "hold-updated")).toHaveLength(3); // one per shifted deadline
  });

  it.each([
    ["releases only its resource hold on complete fresh clearance", codexLimits(30, 200), undefined, false],
    ["keeps the hold when a previously blocked window is missing", (() => {
      const other = { limitId: "other", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: null }, secondary: null };
      return codexLimits(30, 200, { rateLimits: other }, { other });
    })(), undefined, true],
    ["keeps the hold when the deadline did not advance", codexLimits(100, 50), undefined, true],
    ["keeps the hold when a manual pause arrives during the read", codexLimits(30, 200), "pause", true],
    ["keeps the hold when the agent's lifecycle changes during the read", codexLimits(30, 200), "lifecycle", true],
    ["keeps the hold when the binding changes during the read", codexLimits(30, 200), "rebind", true]
  ])("%s", async (_label, second, during, stillHeld) => {
    let pause = false;
    const f = quotaFixture([codexLimits(100, 50), second], () => {
      if (!pause) return;
      if (during === "pause") mutateCursorsState(f.paths, (current) => setPaused(current, true, f.now()));
      if (during === "lifecycle") observeAgentLifecycle(f.paths, "codex", { kind: "stopped", eventName: "Stop", sessionId: "session" }, f.now());
      if (during === "rebind") {
        const start = readStartState(f.paths);
        writeFileSync(f.paths.start, JSON.stringify({ ...start, agents: [{ ...start.agents[0], codexQuota: {
          ...start.agents[0]!.codexQuota, codexHome: "/other/.codex" } }] }));
      }
    });
    await f.tick();
    const held = await f.tick();
    expect(held.holds).toEqual([expect.objectContaining({ reason: "vendor-failure", confidence: "exact",
      evidence: expect.objectContaining({ vendor: "codex", failureClass: "usage-window" }) })]);
    expect(f.ui.sends).toBe(1);
    pause = during !== undefined;
    f.advance(hoursFromBase(50) * 1000 + 30_000 - Date.parse(f.now()));
    const after = await f.tick();
    expect(f.reads).toHaveLength(2);
    expect(after.holds.length === 1).toBe(stillHeld);
    if (during === "lifecycle" || during === "rebind") {
      // A stale snapshot neither holds nor releases; it re-queues a read under the binding spacing.
      expect(after.actionSafety.codex?.resource).toMatchObject({ terminal: null, nextAt: f.now() });
    }
    const released = readJournal(f.paths).filter((event) => event.type === "hold-released");
    expect(released).toHaveLength(stillHeld ? 0 : 1);
    if (!stillHeld) {
      expect(released[0]?.details).toMatchObject({ automatic: true });
      expect(after.paused).toBe(false);
      expect(after.actionSafety.codex).toEqual(held.actionSafety.codex && { ...held.actionSafety.codex,
        resource: after.actionSafety.codex?.resource }); // the send budget was never refilled
    }
  });

  const bucketLimits = (windows: Record<string, [percent: number, resetHours: number]>) => {
    const buckets = Object.fromEntries(Object.entries(windows).map(([limitId, [usedPercent, hours]]) => [limitId, {
      limitId, spendControlReached: false, rateLimitReachedType: null, secondary: null,
      primary: { usedPercent, windowDurationMins: 300, resetsAt: hoursFromBase(hours) } }]));
    return { status: "ok" as const, reaped: true as const, helper: { userAgent: "codex_cli_rs/0.156.1", codexHome: "/owner/.codex" },
      limits: parseCodexRateLimits({ ordinaryUsageAllowed: Object.values(windows).every(([percent]) => percent < 100),
        rateLimits: Object.values(buckets)[0], rateLimitsByLimitId: buckets, accountId: "acct-1" }) };
  };

  it("retains an earlier blocker that a later partial snapshot omits, so it can never clear by absence", async () => {
    const f = quotaFixture([
      bucketLimits({ a: [100, 50], b: [100, 40] }),
      bucketLimits({ a: [100, 70] }), // b omitted, a's deadline advanced
      bucketLimits({ a: [10, 90] }) // a clear, b still omitted
    ]);
    await f.tick();
    await f.tick();
    for (const hours of [50, 70]) {
      f.advance(hoursFromBase(hours) * 1000 + 30_000 - Date.parse(f.now()));
      await f.tick();
      if (hours === 50) {
        const hold = readCursorsState(f.paths).holds[0]!;
        expect(hold.evidence?.windows.map((window) => window.limitId).sort()).toEqual(["a", "b"]);
        expect(hold.resetsAt).toBe(new Date(hoursFromBase(70) * 1000).toISOString());
      }
    }
    expect(f.reads).toHaveLength(3);
    expect(readCursorsState(f.paths).holds).toHaveLength(1);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(0);
  });

  it("fails closed when a read reports more blockers than evidence can carry", async () => {
    const f = quotaFixture([bucketLimits(Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`b${index}`, [100, 50]])))]);
    await f.tick();
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ resetsAt: null, confidence: "unknown" });
    expect(held.holds[0]?.evidence?.windows).toHaveLength(16);
    expect(held.actionSafety.codex?.resource.terminal).toBe("more blocked windows than can be tracked");
    for (let i = 0; i < 200; i++) { f.advance(600_000); await f.tick(); }
    expect(f.reads).toHaveLength(1);
  });

  it.each([
    ["no owner-validated version", null, codexLimits(30, 200)],
    ["a helper reporting another version", "0.156.1", { ...codexLimits(30, 200), helper: { userAgent: "codex_cli_rs/0.157.0", codexHome: "/owner/.codex" } }],
    ["a helper that does not state its version", "0.156.1", { ...codexLimits(30, 200), helper: { userAgent: null, codexHome: "/owner/.codex" } }]
  ])("keeps a cleared usage-window hold for the owner with %s", async (_label, validatedVersion, second) => {
    const f = quotaFixture([codexLimits(100, 50), second], undefined, validatedVersion);
    await f.tick();
    await f.tick();
    f.advance(hoursFromBase(50) * 1000 + 30_000 - Date.parse(f.now()));
    const after = await f.tick();
    expect(f.reads).toHaveLength(2);
    expect(after.holds).toHaveLength(1);
    expect(after.actionSafety.codex?.resource.terminal).toBe("automatic recovery is not validated for this Codex installation");
    expect(readJournal(f.paths).filter((event) => event.type === "hold-released")).toHaveLength(0);
  });

  it.each([
    ["a different account", codexLimits(20, 50, { accountId: "acct-2" })],
    ["no account id", codexLimits(20, 50, { accountId: null })],
    ["a non-ChatGPT account", { status: "identity" as const, error: "api key", reaped: true }]
  ])("sends %s to the owner as an account hold without further reads", async (_label, result) => {
    const f = quotaFixture([result]);
    await f.tick();
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-failure", evidence: { failureClass: "auth-account" } });
    for (let i = 0; i < 500; i++) { f.advance(600_000); await f.tick(); }
    expect(f.reads).toHaveLength(1);
  });

  it("never starts a second helper over one that was not proved reaped", async () => {
    const f = quotaFixture([{ status: "failed", error: "helper timed out", reaped: false }]);
    await f.tick();
    await f.tick();
    const binding = readBindingRecord(resourceBindingPaths(f.paths.coordRoot, "/owner/.codex", "acct-1"));
    expect(binding?.inFlight).not.toBeNull();
    f.ui.dead = true;
    for (let i = 0; i < 200; i++) { f.advance(600_000); await f.tick(); }
    expect(f.reads).toHaveLength(1);
    expect(readCursorsState(f.paths).actionSafety.codex?.resource.terminal).toMatch(/not proved reaped/);
  });
});

describe("durable delivery safety", () => {
  it("keeps healthy minute-boundary probes out of durable cursor state", async () => {
    const f = safetyFixture();
    await f.tick(); f.advance(1); f.working();
    const loop = f.makeLoop();
    await loop.runTick();
    const before = readFileSync(f.paths.cursors, "utf8");
    for (let minute = 0; minute < 4; minute++) {
      f.advance(60_000);
      await loop.runTick();
      expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
    }
    await f.tick(); // even a restarted advisory probe must not rewrite authority
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
    f.advance(60_000);
    expect((await loop.runTick()).actionSafety.codex?.observationChecks).toBe(1);
  });

  it("retains distinct unknown deferral diagnostics with a bounded overflow record", async () => {
    const f = safetyFixture();
    await f.tick();
    const start = readStartState(f.paths);
    const action = readAgentLifecycle(f.paths).agents.codex!.action!;
    let current = readCursorsState(f.paths);
    for (let index = 0; index < 12; index++) {
      current = f.makeLoop()["journalDeferral"](start, current, "codex", action.actionId, action.actionDigest,
        "scrape", `new-reason-${index}`, "unknown refusal", `diagnostic-${index}`);
    }
    const events = readJournal(f.paths).filter((event) => event.type === "nudge-deferred");
    expect(events).toHaveLength(9); // eight distinct unknown codes plus one overflow
    expect(events[0]?.details).toMatchObject({ code: "new-reason-0", detail: "diagnostic-0" });
    expect(events[1]?.details).toMatchObject({ code: "new-reason-1", detail: "diagnostic-1" });
    expect(events.at(-1)?.details.furtherUnknownCodesSuppressed).toBe(true);
    expect(current.actionSafety.codex?.deferrals).toHaveLength(9);
    const before = readFileSync(f.paths.cursors, "utf8");
    f.makeLoop()["journalDeferral"](start, current, "codex", action.actionId, action.actionDigest,
      "scrape", "new-reason-1", "changed wording", "changed diagnostic");
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
  });

  it("deduplicates A/B/A and append-before-cursor recovery without repeated writes", async () => {
    const f = safetyFixture();
    f.ui.foreground = "bash";
    await f.tick();
    await f.tick(); // initial local observation
    const before = readFileSync(f.paths.cursors, "utf8");
    const lifecycleBefore = readFileSync(f.paths.agentLifecycle, "utf8");
    for (let i = 0; i < 30; i++) await f.tick();
    expect(readFileSync(f.paths.cursors, "utf8")).toBe(before);
    expect(readFileSync(f.paths.agentLifecycle, "utf8")).toBe(lifecycleBefore);
    f.ui.busy = true;
    await f.tick();
    f.ui.busy = false;
    await f.tick();
    const events = () => readJournal(f.paths).filter((event) => event.type === "nudge-deferred");
    expect(events().map((event) => event.details.code)).toEqual(["foreground-mismatch", "owner-typing"]);
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { codex: { ...current.actionSafety.codex!, deferrals: [] } } }));
    await f.tick(); // journal append already durable; cursor replacement had not happened
    expect(events()).toHaveLength(2);
    expect(readCursorsState(f.paths).actionSafety.codex?.sends).toBe(0);
  });

  it.each(["codex", "claude", "cursor", "antigravity"])("bounds %s across restarts, fresh idle epochs and the diagnostic knob", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick();
    expect(f.ui.sends).toBe(1);
    for (const [i, delay] of [60_000, 120_000, 240_000].entries()) {
      f.advance(1); f.working(); f.stop();
      f.advance(delay - 2);
      await f.tick();
      expect(f.ui.sends).toBe(i + 1);
      f.advance(1);
      await f.tick();
      expect(f.ui.sends).toBe(i + 2);
    }
    f.advance(1); f.working();
    expect((await f.tick()).paused).toBe(false); // do not interrupt the last working attempt
    f.advance(1); f.stop();
    const held = await f.tick();
    expect(held.holds).toEqual([expect.objectContaining({ reason: "nudge-loop", agent: vendor, confidence: "unknown", resetsAt: null })]);
    const journal = readFileSync(f.paths.journal, "utf8");
    const action = readFileSync(agentRuntimePaths(f.paths, vendor).action, "utf8");
    writeFileSync(agentRuntimePaths(f.paths, vendor).complete, "incoming bytes\n");
    f.advance(7 * 86400_000);
    for (let i = 0; i < 1000; i++) await f.tick();
    expect(readFileSync(f.paths.journal, "utf8")).toBe(journal);
    expect(readFileSync(agentRuntimePaths(f.paths, vendor).action, "utf8")).toBe(action);
    expect(readFileSync(agentRuntimePaths(f.paths, vendor).complete, "utf8")).toBe("incoming bytes\n");
    expect(f.ui.sends).toBe(4);
    expect(held.activeRoster).toEqual([vendor]);
    expect(held.actionSafety[vendor]?.sends).toBe(4);
  });

  it("charges partial sends and does not retry them on restart", async () => {
    const f = safetyFixture(); f.ui.failSubmit = true;
    const held = await f.tick();
    expect(held.holds[0]?.reason).toBe("delivery-uncertain");
    expect(held.actionSafety.codex).toMatchObject({ sends: 1, reserved: true });
    f.ui.failSubmit = false;
    f.advance(60_000); await f.tick();
    expect(f.ui.sends).toBe(1);
    const released = releaseHold(held, held.holds[0]!.id, false, f.now());
    expect(released.actionSafety.codex).toMatchObject({ sends: 1, reserved: false });
  });

  it("restores a crashed reservation as a hold instead of authorizing another send", async () => {
    const f = safetyFixture();
    await f.tick();
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { codex: {
      ...current.actionSafety.codex!, sends: 2, reserved: true
    } } }));
    const held = await f.tick();
    expect(held.holds[0]?.reason).toBe("delivery-uncertain");
    expect(held.actionSafety.codex?.sends).toBe(2);
    expect(f.ui.sends).toBe(1);
  });

  it("does not repeat a third observation reserved before a crash", async () => {
    const f = safetyFixture();
    await f.tick();
    mutateCursorsState(f.paths, (current) => ({ ...current, actionSafety: { codex: {
      ...current.actionSafety.codex!, observationChecks: 3, nextObservationAt: f.now()
    } } }));
    const captures = f.ui.captures;
    expect((await f.tick()).holds[0]?.reason).toBe("unobservable");
    expect(f.ui.captures).toBe(captures);
  });

  it("recovers the original hold ID after append-before-cursor failure", async () => {
    const f = safetyFixture();
    await f.tick();
    const before = readCursorsState(f.paths);
    f.ui.dead = true;
    const held = await f.tick();
    writeCursorsState(f.paths, before);
    const recovered = await f.tick();
    expect(recovered.holds).toEqual(held.holds);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-created")).toHaveLength(1);
    expect(readJournal(f.paths).filter((event) => event.type === "paused")).toHaveLength(1);
  });

  it("does not let simultaneous coordinators send duplicate initial prompts", async () => {
    const f = safetyFixture();
    await Promise.all([f.tick(), f.tick()]);
    expect(f.ui.sends).toBe(1);
    expect(readCursorsState(f.paths).actionSafety.codex?.sends).toBe(1);
  });

  it("holds a Claude native wait without touching the send budget", async () => {
    const f = safetyFixture("claude");
    f.ui.text = "Usage limit reached\nContinuing automatically\n❯";
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-wait", retryOwner: "vendor", resetsAt: null });
    expect(held.actionSafety.claude?.sends).toBe(0);
    f.ui.text = "❯";
    expect((await f.tick()).paused).toBe(true); // banner disappearance is not release
    expect(f.ui.sends).toBe(0);
  });

  it("keeps native ownership and the charge when a Claude wait appears mid-send", async () => {
    const f = safetyFixture("claude");
    f.ui.waitAtCapture = 3; // the prelude has been sent; literal text has not
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "vendor-wait", retryOwner: "vendor" });
    expect(held.actionSafety.claude).toMatchObject({ sends: 1, reserved: true });
    expect(f.ui.sends).toBe(0);
    expect((await f.tick()).holds).toEqual(held.holds);
  });

  it.each([false, true])("holds silent Cursor with stale working=%s after three bounded inspections", async (working) => {
    const f = safetyFixture("cursor");
    await f.tick();
    // Keep the action visible: lack of hooks must not turn into a prompt probe.
    f.ui.text = readCursorsState(f.paths).agents.cursor!.actionId!;
    if (working) { f.advance(1); f.working(); await f.tick(); }
    f.advance(300_000);
    for (let i = 0; i < 2; i++) {
      expect((await f.tick()).paused).toBe(false);
      const checks = readCursorsState(f.paths).actionSafety.cursor!.observationChecks;
      for (let j = 0; j < 20; j++) await f.tick();
      expect(readCursorsState(f.paths).actionSafety.cursor!.observationChecks).toBe(checks);
      f.advance(60_000);
    }
    const held = await f.tick();
    expect(held.holds[0]).toMatchObject({ reason: "unobservable", confidence: "unknown", resetsAt: null });
    expect(held.actionSafety.cursor?.observationChecks).toBe(3);
    expect(f.ui.sends).toBe(1);
  });

  it.each(["cursor", "claude"])("re-holds a still-broken %s after release without needing new hooks", async (vendor) => {
    const f = safetyFixture(vendor);
    await f.tick();
    if (vendor === "cursor") f.ui.dead = true;
    else f.ui.text = "Usage limit reached · continuing automatically at 3:45pm · esc to cancel\n❯";
    const held = await f.tick();
    const reason = vendor === "cursor" ? "harness-gone" : "vendor-wait";
    expect(held.holds[0]?.reason).toBe(reason);
    const lifecycle = readFileSync(f.paths.agentLifecycle, "utf8");
    mutateCursorsState(f.paths, (current) => releaseHold(current, held.holds[0]!.id, false, f.now()));
    const released = readCursorsState(f.paths);
    const reheld = await f.tick();
    expect(reheld.holds[0]?.reason).toBe(reason);
    expect(reheld.holds[0]?.id).not.toBe(held.holds[0]?.id);
    expect(reheld.actionSafety[vendor]?.sends).toBe(held.actionSafety[vendor]?.sends);
    expect(readFileSync(f.paths.agentLifecycle, "utf8")).toBe(lifecycle);
    writeCursorsState(f.paths, released); // a crash during the new hold still reuses that hold
    expect((await f.tick()).holds).toEqual(reheld.holds);
    expect(readJournal(f.paths).filter((event) => event.type === "hold-created")).toHaveLength(2);
  });
});

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
    let nowMs = Date.now();
    const loop = new CoordinatorRunLoop(paths, { now: () => new Date(nowMs).toISOString(), tmux });
    await loop.runTick();
    const firstNudges = literalNudges;
    expect(firstNudges).toBeGreaterThan(0);
    const runtime = agentRuntimePaths(paths, "codex");
    const actionId = readCursorsState(paths).agents.codex?.actionId;
    nowMs += 60_000;
    writeFileSync(runtime.complete, "not-a-sha\n");
    await loop.runTick();
    expect(readCursorsState(paths).agents.codex).toMatchObject({ actionId, status: "ordered", attempt: 2 });
    expect(readAction(runtime.action).body).toContain("complete must contain a 40-character lowercase Git SHA");
    expect(readJournal(paths).some((event) => event.type === "verify-result")).toBe(true);
    expect(readJournal(paths).some((event) => event.type === "nudged" && event.details.reissue === true)).toBe(true);
    expect(literalNudges).toBeGreaterThan(firstNudges);
  });


  it("journals each deferred reason once across repeated ticks and restarts", async () => {
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
    // The durable key suppresses journal and console repeats, including restart.
    await loop.runTick();
    expect(
      readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex").length
    ).toBe(1);
    await new CoordinatorRunLoop(paths, { tmux, log: (message) => messages.push(message) }).runTick();
    expect(readJournal(paths).filter((event) => event.type === "nudge-deferred" && event.agent === "codex")).toHaveLength(1);
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
    let nowMs = Date.now();
    const loop = new CoordinatorRunLoop(paths, { now: () => new Date(nowMs).toISOString(), tmux, log: (message) => messages.push(message) });
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
    nowMs += 60_000;
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
    nowMs += 15_000;
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
    nowMs += 60_000;
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
    nowMs += 120_000 - NUDGE_RETRY_MS - 1;
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
    let nowMs = Date.now();
    const loop = new CoordinatorRunLoop(paths, { now: () => new Date(nowMs).toISOString(), tmux });
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
    nowMs += 60_000;

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

  it("holds rather than accepting an origin tip when a harness disappears without completion", async () => {
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
    expect(cursors.accepted).toEqual([]);
    expect(cursors.paused).toBe(true);
    expect(cursors.holds).toEqual([expect.objectContaining({ agent: "claude", reason: "harness-gone", resetsAt: null })]);
    expect(readJournal(paths).some((event) => event.details.pushedThenDied === true)).toBe(false);
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
    let checkNowMs = Date.parse("2026-08-21T00:00:00.000Z");
    const loop = new CoordinatorRunLoop(paths, {
      tmux: null,
      mirror,
      now: () => {
        const value = new Date(checkNowMs).toISOString();
        checkNowMs += 2500;
        return value;
      },
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
    expect(finalCheck?.details).toMatchObject({ tier: "checks", name: "check", exitCode: 1, durationMs: 2500 });
    expect(pushes).toBe(0);
    expect(opens).toBe(0);
    expect(readCursorsState(paths).publication.status).toBe("not-required");
  });
});

/**
 * The coordinator already holds every bound artifact in its mirror. Exporting
 * them once per issue is what lets an agent read a peer's plan or browse a
 * peer's implementation as ordinary files, instead of each of N agents fetching
 * and `git show`-ing the same blobs.
 */
describe("materialized bound inputs", () => {
  const documents = (pins: readonly [string, string, string][]) =>
    pins.map(([agent, commitSha, kind]) => ({
      agent,
      commitSha,
      path: `.plans/issue-1/${kind === "review" ? "review" : "plan"}.md`,
      kind
    }));

  const readingMirror = (contents: Record<string, string> = {}) => {
    const calls: string[] = [];
    return {
      calls,
      readBlob: async (sha: string, path: string) => {
        calls.push(`${sha}:${path}`);
        return contents[`${sha}:${path}`] ?? `body of ${sha}:${path}\n`;
      },
      materializeWorktree: async () => undefined,
      removeWorktree: async () => undefined
    };
  };

  it("writes one content-addressed packet with a manifest that matches the files", async () => {
    const { paths } = fixture();
    const mirror = readingMirror();
    const inputs = documents([
      ["claude", "1".repeat(40), "plan"],
      ["codex", "2".repeat(40), "plan"],
      ["codex", "3".repeat(40), "review"]
    ]);

    const result = await materializeBoundInputs({ mirror, paths, inputs });

    expect(result.inputSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.packetDir).toBe(join(paths.issueInputsRoot, result.inputSetHash as string));
    expect(result.entries).toHaveLength(3);
    expect(result.omitted).toEqual([]);

    for (const entry of result.entries) {
      // Every path the action will list has to exist, and hold exactly the
      // bytes the cited pin holds.
      const onDisk = readFileSync(entry.localPath, "utf8");
      expect(onDisk).toBe(`body of ${entry.commitSha}:${entry.path}\n`);
      expect(entry.sha256).toBe(createHash("sha256").update(onDisk).digest("hex"));
    }

    const manifest = JSON.parse(readFileSync(result.manifestPath as string, "utf8")) as {
      inputSetHash: string;
      entries: { commitSha: string; localPath: string; sha256: string }[];
    };
    expect(manifest.inputSetHash).toBe(result.inputSetHash);
    expect(manifest.entries.map((entry) => entry.localPath).sort()).toEqual(
      result.entries.map((entry) => entry.localPath).sort()
    );
  });

  /**
   * A packet is immutable and named by what it holds, so re-preparing the same
   * action must cost nothing. Re-reading the blobs would move the very
   * per-read cost this change removes from the agents onto the coordinator,
   * once per action rather than once per issue.
   */
  it("reuses an existing packet without reading the mirror again", async () => {
    const { paths } = fixture();
    const inputs = documents([["claude", "4".repeat(40), "plan"]]);

    const first = readingMirror();
    const before = await materializeBoundInputs({ mirror: first, paths, inputs });
    expect(first.calls).toHaveLength(1);

    const second = readingMirror();
    const after = await materializeBoundInputs({ mirror: second, paths, inputs });
    expect(second.calls).toEqual([]);
    expect(after.packetDir).toBe(before.packetDir);
    expect(after.entries.map((entry) => entry.localPath)).toEqual(
      before.entries.map((entry) => entry.localPath)
    );
  });

  /**
   * Convenience state must never be able to stall an issue: the action still
   * cites the pin, and the pinned `git show` fallback still reaches it.
   */
  it("omits an unreadable document instead of failing preparation", async () => {
    const { paths } = fixture();
    const mirror = {
      readBlob: async () => null,
      materializeWorktree: async () => undefined,
      removeWorktree: async () => undefined
    };
    const result = await materializeBoundInputs({
      mirror,
      paths,
      inputs: documents([["claude", "5".repeat(40), "plan"]])
    });
    expect(result.entries).toEqual([]);
    expect(result.omitted).toHaveLength(1);
    expect(result.omitted[0]).toContain("unreadable");
  });

  it("materializes one worktree per distinct pin and prunes superseded ones", async () => {
    const { paths } = fixture();
    const created: [string, string][] = [];
    const removed: string[] = [];
    const shared = "6".repeat(40);
    const mirror = {
      readBlob: async () => null,
      materializeWorktree: async (target: string, sha: string) => {
        created.push([target, sha]);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "marker"), sha);
      },
      removeWorktree: async (target: string) => {
        removed.push(target);
      }
    };
    const pins = [
      { agent: "claude", commitSha: shared, path: ".signals/x.json", kind: "implementation" },
      { agent: "codex", commitSha: shared, path: ".signals/y.json", kind: "implementation" },
      { agent: "codex", commitSha: "7".repeat(40), path: ".signals/z.json", kind: "implementation" }
    ];

    const result = await materializeBoundInputs({ mirror, paths, inputs: pins });

    // Two distinct pins, three inputs: the shared pin is checked out once.
    expect(created).toHaveLength(2);
    expect(created.map(([, sha]) => sha)).toEqual([shared, "7".repeat(40)]);
    expect(result.worktrees).toHaveLength(2);
    expect(result.worktrees[0]?.localPath).toBe(join(paths.issueWorktreesRoot, `claude-${shared.slice(0, 8)}`));

    // A later action binding only the second pin retires the first.
    const keep = worktreeLabelsFor(paths, [pins[2] as (typeof pins)[number]]);
    const pruned = await pruneSupersededWorktrees({ mirror, paths, keep });
    expect(pruned).toEqual([join(paths.issueWorktreesRoot, `claude-${shared.slice(0, 8)}`)]);
    // Unregistered through the mirror before the directory goes: pruning a
    // registration whose directory still exists collects nothing.
    expect(removed).toEqual(pruned);
    expect(existsSync(join(paths.issueWorktreesRoot, `claude-${shared.slice(0, 8)}`))).toBe(false);
    expect(existsSync(join(paths.issueWorktreesRoot, `codex-${"7".repeat(8)}`))).toBe(true);
  });

  /**
   * The wiring, not just the module: an action that names a file must not be
   * published before that file exists, or the first agent to read it is worse
   * off than before.
   */
  it("publishes an action whose listed bound-input paths already exist", async () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R3.review", gateId: "gate-3-selection", round: null },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: `.plans/issue-1/plan.md`,
          acceptedAt: now
        })),
        agents: Object.fromEntries(
          current.activeRoster.map((agent) => [
            agent,
            { ...current.agents[agent], stepId: "R3.review", status: "idle", actionId: null }
          ])
        ),
        updatedAt: now
      })
    );

    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2] ?? "";
      if (command === "show") {
        return { exitCode: 0, stdout: Buffer.from(`# plan for ${args[3] ?? ""}\n`), stderr: "" };
      }
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${"d".repeat(40)}\n`), stderr: "" };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    await new CoordinatorRunLoop(paths, { mirror, tmux: null }).runTick();

    const body = readFileSync(agentRuntimePaths(paths, "claude").action, "utf8");
    expect(body).toContain("## Bound input files");
    const listed = [...body.matchAll(/: "([^"]+)"$/gm)].map((match) => match[1] as string);
    expect(listed.length).toBeGreaterThan(0);
    for (const path of listed) {
      expect(existsSync(path), path).toBe(true);
      expect(path.startsWith(paths.issueInputsRoot) || path.startsWith(paths.issueWorktreesRoot)).toBe(true);
    }
  });

  /**
   * A rejected artifact is re-issued as the same action with corrections. That
   * is the worst moment to lose the exported paths: the agent is being asked to
   * fix something, and the shim still refuses the reads the files replaced.
   */
  it("keeps the bound-input paths when an action is re-issued with corrections", async () => {
    const { paths } = fixture();
    const now = "2026-08-11T17:00:00.000Z";
    mutateCursorsState(paths, (current) =>
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R3.review", gateId: "gate-3-selection", round: null },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: ".plans/issue-1/plan.md",
          acceptedAt: now
        })),
        agents: Object.fromEntries(
          current.activeRoster.map((agent) => [
            agent,
            { ...current.agents[agent], stepId: "R3.review", status: "idle", actionId: null }
          ])
        ),
        updatedAt: now
      })
    );
    const mirror = new BareMirror(paths.mirror, "/origin.git", async (args) => {
      const command = args[2] ?? "";
      if (command === "show") return { exitCode: 0, stdout: Buffer.from("# a plan\n"), stderr: "" };
      if (command === "rev-parse") return { exitCode: 0, stdout: Buffer.from(`${"d".repeat(40)}\n`), stderr: "" };
      return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
    });
    const loop = new CoordinatorRunLoop(paths, { mirror, tmux: null });
    await loop.runTick();

    const actionPath = agentRuntimePaths(paths, "claude").action;
    const first = readFileSync(actionPath, "utf8");
    expect(first).toContain("## Bound input files");

    // Force the correction path with a malformed completion marker.
    writeFileSync(agentRuntimePaths(paths, "claude").complete, "not-a-sha\n");
    await loop.runTick();

    const reissued = readFileSync(actionPath, "utf8");
    expect(reissued).toContain("Correct these outstanding items");
    expect(reissued).toContain("## Bound input files");
    for (const path of [...reissued.matchAll(/: "([^"]+)"$/gm)].map((match) => match[1] as string)) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  /**
   * A packet is content-addressed and handed to every agent on the step as
   * verified peer input. Checking only that a file is present would let one
   * whose bytes were replaced be served under a pin that still looks right.
   */
  it("rebuilds a packet whose recorded digest no longer matches its bytes", async () => {
    const { paths } = fixture();
    const inputs = [
      { agent: "claude", commitSha: "8".repeat(40), path: ".plans/issue-1/plan.md", kind: "plan" }
    ];
    const mirror = {
      readBlob: async () => "the real plan\n",
      materializeWorktree: async () => undefined,
      removeWorktree: async () => undefined
    };

    const first = await materializeBoundInputs({ mirror, paths, inputs });
    const entry = first.entries[0] as { localPath: string; sha256: string };

    // Tamper: same path, different bytes.
    chmodSync(entry.localPath, 0o600);
    writeFileSync(entry.localPath, "substituted\n");

    const second = await materializeBoundInputs({ mirror, paths, inputs });
    expect(second.omitted.join(" ")).toContain("failed validation and was rebuilt");
    expect(readFileSync(entry.localPath, "utf8")).toBe("the real plan\n");
    expect(second.entries[0]?.sha256).toBe(entry.sha256);
  });

  /**
   * `<agent>-<sha8>` is not a unique function of the pin. Reusing on the path
   * alone lets an action cite one commit and point every reader at another
   * tree, with nothing in the action looking wrong.
   */
  it("replaces a worktree whose checkout does not match the bound pin", async () => {
    const { paths } = fixture();
    const pin = "9".repeat(40);
    const created: string[] = [];
    const removed: string[] = [];
    const mirror = {
      readBlob: async () => null,
      materializeWorktree: async (target: string, sha: string) => {
        created.push(sha);
        mkdirSync(target, { recursive: true });
        execFileSync("git", ["init", "-q", target]);
        writeFileSync(join(target, "marker"), sha);
      },
      removeWorktree: async (target: string) => {
        removed.push(target);
      }
    };
    const inputs = [{ agent: "claude", commitSha: pin, path: ".signals/x.json", kind: "implementation" }];

    const first = await materializeBoundInputs({ mirror, paths, inputs });
    const localPath = first.worktrees[0]?.localPath as string;
    expect(existsSync(localPath)).toBe(true);
    // The stub tree's HEAD is not the pin, which is exactly the collision shape:
    // the directory exists and holds the wrong commit.
    const second = await materializeBoundInputs({ mirror, paths, inputs });
    expect(removed).toEqual([localPath]);
    expect(created).toEqual([pin, pin]);
    expect(second.worktrees[0]?.localPath).toBe(localPath);
  });

  it("leaves nothing to materialize for a step that binds no artifacts", async () => {
    const { paths } = fixture();
    const mirror = readingMirror();
    const result = await materializeBoundInputs({ mirror, paths, inputs: [] });
    expect(result).toMatchObject({ inputSetHash: null, packetDir: null, entries: [], worktrees: [] });
    expect(mirror.calls).toEqual([]);
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
