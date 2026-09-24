import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  appendJournal,
  consensusDerivedSchema,
  cursorsStateSchema,
  dropAgent,
  implementationSelectionDerivedSchema,
  initializeOperationalState,
  mutateCursorsState,
  planSelectionDerivedSchema,
  readCursorsState,
  readJournal,
  readStartState,
  setPaused,
  releaseHold,
  releaseResourceHold,
  agentConfigSchema,
  StateConflictError,
  startStateSchema,
  coordinatorConfigSchema,
  writeCursorsState
} from "../src/state.js";
import { unknownEvidence } from "../src/resourceEvidence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const initialize = () => {
  const workspace = mkdtempSync(join(tmpdir(), "coord-state-"));
  roots.push(workspace);
  const root = join(workspace, "coord-runtime");
  mkdirSync(root, { recursive: true });
  const paths = issueRuntimePaths(root, 1, join(workspace, "completes"));
  createIssueRuntime(paths, ["claude", "codex"]);
  return {
    paths,
    ...initializeOperationalState(
      paths,
      {
        issue: 1,
        issueSessionId: `issue-1:${"a".repeat(40)}`,
        baselineSha: "a".repeat(40),
        profile: "consensus",
        originalRoster: ["claude", "codex"],
        branchTemplate: "issue-{issue}/{agent}",
        baseBranch: "main",
        maxRevisionRounds: 3,
        prPolicy: "owner-only",
        automationDigest: "b".repeat(64),
        automationDigestScheme: "sha256-length-prefixed-v1",
        automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
        trustedSourceCommit: "c".repeat(40),
        origin: "file:///origin.git",
        coordRoot: root,
        configPath: join(root, "config.json"),
        agents: [
          { id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "nudge" },
          { id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }
        ],
        checks: [{ name: "check", argv: ["pnpm", "check"] }],
        pollIntervalMs: 1000
      },
      "2026-08-11T10:00:00.000Z"
    )
  };
};

describe("operational state", () => {
  it("validates explicit Codex bindings and releases resource holds without changing safety or other holds", () => {
    const config = { id: "codex", root: "/clone", launcher: "launcher", codexQuota: { codexHome: "/home/codex", accountId: "account" } };
    expect(agentConfigSchema.safeParse(config).success).toBe(true);
    expect(agentConfigSchema.safeParse({ ...config, id: "claude" }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...config, codexQuota: { ...config.codexQuota, codexHome: "relative" } }).success).toBe(false);
    const { paths } = initialize(); const original = readCursorsState(paths);
    const now = "2026-09-22T12:00:00.000Z";
    const actionId = "10000000-0000-4000-8000-000000000001";
    const id = "20000000-0000-4000-8000-000000000001";
    const hold = { id, agent: "codex", actionId, sessionId: "session", reason: "vendor-failure", evidenceId: "quota",
      observedAt: now, resetsAt: null, confidence: "unknown", retryOwner: "owner",
      resource: { ...unknownEvidence("codex"), failureClass: "usage-window" } };
    const held = cursorsStateSchema.parse({ ...original, paused: true,
      agents: { ...original.agents, codex: { ...original.agents.codex, actionId } },
      actionSafety: { codex: { actionId, sends: 4, reserved: true, activityAt: now,
        quotaProbe: { binding: "key", starts: 6, failures: 0, inFlight: false, lastStartAt: now, nextAt: null, consumed: [], terminal: true } } },
      holds: [hold, { ...hold, id: "20000000-0000-4000-8000-000000000002", reason: "nudge-loop" }] });
    const released = releaseResourceHold(held, id, now);
    expect(released.holds).toHaveLength(1); expect(released.paused).toBe(true);
    expect(released.actionSafety).toEqual(held.actionSafety);
    expect(() => releaseResourceHold({ ...held, manualPaused: true }, id, now)).toThrow();
    expect(() => releaseResourceHold(held, held.holds[1]!.id, now)).toThrow();
    expect(releaseHold(held, id, false, now).actionSafety.codex?.quotaProbe).toEqual(held.actionSafety.codex?.quotaProbe);
  });
  it("keeps manual and independent holds separate and requires an explicit breaker reset", () => {
    const { paths } = initialize();
    const now = "2026-09-22T12:00:00.000Z";
    const actionId = "10000000-0000-4000-8000-000000000001";
    const id = "20000000-0000-4000-8000-000000000001";
    const otherId = "20000000-0000-4000-8000-000000000002";
    const original = readCursorsState(paths);
    const hold = { id, agent: "codex", actionId, sessionId: null, reason: "nudge-loop", evidenceId: "budget",
      observedAt: now, resetsAt: null, confidence: "unknown", retryOwner: "owner" };
    const held = cursorsStateSchema.parse({ ...original, paused: true, manualPaused: true,
      agents: { ...original.agents, codex: { ...original.agents.codex, actionId } },
      actionSafety: { codex: { actionId, sends: 4, lastSendAt: now, activityAt: now } },
      holds: [hold, { ...hold, id: otherId, reason: "unobservable", evidenceId: "missing" }] });
    expect(() => releaseHold(held, id, false, now)).toThrow(/reset-nudge-budget/);
    expect(() => releaseHold(held, otherId, true, now)).toThrow(/Only a nudge-loop/);
    expect(() => releaseHold({ ...held, abandoned: true }, id, true, now)).toThrow(/retired/);
    expect(() => releaseHold({ ...held, agents: original.agents }, id, true, now)).toThrow(/retired/);
    const plain = setPaused(held, false, now);
    expect(plain.paused).toBe(true);
    expect(plain.holds).toHaveLength(2);
    const released = releaseHold(held, id, true, now);
    expect(released.paused).toBe(true);
    expect(released.manualPaused).toBe(true);
    expect(released.holds.map((entry) => entry.id)).toEqual([otherId]);
    expect(released.actionSafety.codex).toMatchObject({ sends: 0, reserved: false, holdGeneration: 1 });
    expect(released.agents).toEqual(held.agents);
    const last = releaseHold(released, otherId, false, now);
    expect(last.paused).toBe(true); // still manually paused
    expect(setPaused(last, false, now).paused).toBe(false);
  });
  it("writes strict versioned start, cursor, and journal state atomically", () => {
    const { paths } = initialize();
    expect(readStartState(paths)).toMatchObject({ formatVersion: 4, maxRevisionRounds: 3 });
    expect(readCursorsState(paths).activeRoster).toEqual(["claude", "codex"]);
    expect(readJournal(paths).map((event) => event.type)).toEqual(["started"]);
    appendJournal(paths, { type: "paused", details: {} }, "2026-08-11T10:01:00.000Z");
    expect(readJournal(paths).at(-1)?.sequence).toBe(1);
  });

  it("persists pause and drop state but refuses a zero-agent workflow", () => {
    const { paths, cursors } = initialize();
    let next = setPaused(cursors, true, "2026-08-11T10:01:00.000Z");
    next = dropAgent(next, "codex", "2026-08-11T10:02:00.000Z");
    writeCursorsState(paths, next);
    expect(readCursorsState(paths)).toMatchObject({ paused: true, activeRoster: ["claude"], droppedAgents: ["codex"] });
    expect(() => dropAgent(next, "claude")).toThrow("final active agent");
  });

  it("fails closed on an unsupported revision limit or unknown state fields", () => {
    const { cursors, start } = initialize();
    expect(cursorsStateSchema.safeParse({ ...cursors, mystery: true }).success).toBe(false);
    expect(cursorsStateSchema.safeParse({ ...cursors, formatVersion: 1 }).success).toBe(false);
    expect(startStateSchema.safeParse({ ...start, maxRevisionRounds: 4 }).success).toBe(false);
  });

  it("rejects runtime format version 2 with wipe and restart guidance", () => {
    const { paths } = initialize();
    writeFileSync(
      paths.cursors,
      `${JSON.stringify({ ...readCursorsState(paths), formatVersion: 2 }, null, 2)}\n`
    );
    expect(() => readCursorsState(paths)).toThrow(/Wipe this issue/);
  });

  it("rejects runtime format version 3 with wipe and restart guidance", () => {
    const { paths } = initialize();
    writeFileSync(
      paths.cursors,
      `${JSON.stringify({ ...readCursorsState(paths), formatVersion: 3 }, null, 2)}\n`
    );
    expect(() => readCursorsState(paths)).toThrow(/Wipe this issue/);
  });

  it("rejects stale whole-state writes after an owner control revision", () => {
    const { paths } = initialize();
    const stale = readCursorsState(paths);
    const paused = mutateCursorsState(paths, (current) => setPaused(current, true, "2026-08-11T10:01:00.000Z"));
    expect(paused.state.stateRevision).toBe(stale.stateRevision + 1);
    const staleWrite = mutateCursorsState(paths, () => stale, stale.stateRevision);
    expect(staleWrite.applied).toBe(false);
    expect(staleWrite.state.paused).toBe(true);
    expect(new StateConflictError("conflict").name).toBe("StateConflictError");
  });
});

describe("derived decision state", () => {
  const inputSetHash = "d".repeat(64);
  const decidedAt = "2026-08-11T10:00:00.000Z";
  const base = {
    inputSetHash,
    activeRoster: ["claude", "codex"],
    inputs: [
      {
        kind: "plan" as const,
        agent: "codex",
        submissionSha: "a".repeat(40),
        path: ".plans/issue-1/plan.md"
      }
    ],
    supersedes: null,
    decidedAt
  };

  it("requires a cited input and a hash-bound identity for every derived decision", () => {
    const records = [
      {
        schema: planSelectionDerivedSchema,
        value: {
          ...base,
          kind: "plan-selection" as const,
          algorithm: "plurality-active-roster-v1" as const,
          decisionId: `plan-selection:${inputSetHash}`,
          selectedAgents: ["codex"]
        }
      },
      {
        schema: implementationSelectionDerivedSchema,
        value: {
          ...base,
          kind: "implementation-selection" as const,
          algorithm: "plurality-active-roster-v1" as const,
          decisionId: `implementation-selection:${inputSetHash}`,
          winner: "codex",
          implementationPin: "b".repeat(40),
          reviser: "codex"
        }
      },
      {
        schema: consensusDerivedSchema,
        value: {
          ...base,
          kind: "consensus" as const,
          algorithm: "unanimous-active-roster-v1" as const,
          decisionId: `consensus:${inputSetHash}:r2`,
          round: 2,
          consensusPin: "b".repeat(40)
        }
      }
    ];

    for (const { schema, value } of records) {
      expect(schema.safeParse(value).success).toBe(true);
      expect(schema.safeParse({ ...value, inputs: [] }).success).toBe(false);
      expect(schema.safeParse({ ...value, decisionId: "arbitrary" }).success).toBe(false);
      expect(schema.safeParse({ ...value, decisionId: value.decisionId.replace(inputSetHash, "e".repeat(64)) }).success).toBe(
        false
      );
    }
  });

  it("binds consensus decision identities to their persisted round", () => {
    const value = {
      ...base,
      kind: "consensus" as const,
      algorithm: "unanimous-active-roster-v1" as const,
      decisionId: `consensus:${inputSetHash}:r2`,
      round: 1,
      consensusPin: "b".repeat(40)
    };
    expect(consensusDerivedSchema.safeParse(value).success).toBe(false);
  });
});

const configFixture = (contextPaths?: unknown) => ({
  project: "coordination",
  origin: "https://github.com/example/coordination.git",
  agents: [{ id: "claude", root: "../coordination-claude", launcher: "start-claude.sh" }],
  branch: "issue-{issue}/{agent}",
  checks: [{ name: "check", argv: ["pnpm", "check"] }],
  ...(contextPaths === undefined ? {} : { contextPaths })
});

describe("context paths", () => {
  it("defaults to an empty list and accepts confined product-relative files", () => {
    expect(coordinatorConfigSchema.parse(configFixture()).contextPaths).toEqual([]);
    expect(coordinatorConfigSchema.parse(configFixture(["docs/repo-map.md"])).contextPaths).toEqual([
      "docs/repo-map.md"
    ]);
  });

  it("refuses escapes and duplicates the way digest paths are refused", () => {
    expect(coordinatorConfigSchema.safeParse(configFixture(["/etc/passwd"])).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse(configFixture(["../secrets.md"])).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse(configFixture(["a/../../b.md"])).success).toBe(false);
    expect(coordinatorConfigSchema.safeParse(configFixture(["docs/x.md", "docs/x.md"])).success).toBe(false);
  });

  /**
   * An issue started before this field existed must keep running after the
   * upgrade: start.json is strict, so a missing key has to parse, not fail.
   */
  it("parses a start state written before the field existed", () => {
    const { start } = initialize();
    const legacy: Record<string, unknown> = { ...start };
    delete legacy.contextPaths;
    const parsed = startStateSchema.safeParse(legacy);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues)).toBe(true);
    expect(parsed.success && parsed.data.contextPaths).toEqual([]);
  });

  /**
   * The defaulted field must not become a required constructor argument: every
   * existing `initializeOperationalState` call site omits it.
   */
  it("keeps the field optional at the typed initializer boundary", () => {
    const { start } = initialize();
    expect(start.contextPaths).toEqual([]);
  });
});
