import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  appendJournal,
  atomicWriteJson,
  cursorsStateSchema,
  derivedStateSchema,
  dropAgent,
  initializeOperationalState,
  invalidateDerivedForDrop,
  mutateCursorsState,
  readCursorsState,
  readJournal,
  readStartState,
  RUNTIME_FORMAT_VERSION,
  setPaused,
  StateConflictError,
  startStateSchema,
  coordinatorConfigSchema,
  writeCursorsState,
  type DerivedState
} from "../src/state.js";

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
  it("writes strict versioned start, cursor, and journal state atomically", () => {
    const { paths } = initialize();
    expect(RUNTIME_FORMAT_VERSION).toBe(3);
    expect(readStartState(paths)).toMatchObject({ formatVersion: 3, maxRevisionRounds: 3 });
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
    expect(cursorsStateSchema.safeParse({ ...cursors, formatVersion: 2 }).success).toBe(false);
    expect(startStateSchema.safeParse({ ...start, maxRevisionRounds: 4 }).success).toBe(false);
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

const planSelection = (selected: string, roster: readonly string[] = ["claude", "codex"]) => ({
  identity: { kind: "plan-selection" as const, inputSetHash: "1".repeat(64), round: null },
  algorithm: "plurality-active-roster-v1" as const,
  activeRoster: [...roster],
  inputs: [
    {
      kind: "plan-ballot" as const,
      agent: "claude",
      submissionSha: "a".repeat(40),
      path: ".plans/issue-1/ballot-claude.json"
    }
  ],
  selectedAgents: [selected],
  decidedAt: "2026-08-11T10:03:00.000Z",
  supersedes: null
});

const implementationSelection = (agent: string) => ({
  identity: { kind: "implementation-selection" as const, inputSetHash: "2".repeat(64), round: null },
  algorithm: "plurality-active-roster-v1" as const,
  activeRoster: ["claude", "codex"],
  inputs: [
    {
      kind: "implementation" as const,
      agent,
      submissionSha: "b".repeat(40),
      path: `.signals/issue-1/implementation-ready-${agent}.json`,
      productPin: "c".repeat(40)
    }
  ],
  implementationAgent: agent,
  implementationPin: "c".repeat(40),
  reviser: agent,
  decidedAt: "2026-08-11T10:04:00.000Z",
  supersedes: null
});

const consensusDecision = (agent: string) => ({
  identity: { kind: "consensus" as const, inputSetHash: "3".repeat(64), round: 1 },
  algorithm: "unanimous-active-roster-v1" as const,
  activeRoster: ["claude", "codex"],
  inputs: [
    {
      kind: "revision" as const,
      agent,
      submissionSha: "d".repeat(40),
      path: `.signals/issue-1/revision-ready-${agent}-round-1.json`,
      productPin: "e".repeat(40)
    }
  ],
  round: 1,
  consensusAgent: agent,
  consensusPin: "e".repeat(40),
  decidedAt: "2026-08-11T10:05:00.000Z",
  supersedes: null
});

describe("canonical derived decisions", () => {
  it("initializes every decision slot empty", () => {
    const { cursors } = initialize();
    expect(cursors.derived).toEqual({ planSelection: null, implementationSelection: null, consensus: null });
  });

  it("requires an identity, roster, citations, and a result on every record", () => {
    const decision = planSelection("codex");
    expect(
      derivedStateSchema.parse({ planSelection: decision, implementationSelection: null, consensus: null })
        .planSelection
    ).toEqual(decision);
    for (const missing of [
      "identity",
      "algorithm",
      "activeRoster",
      "inputs",
      "selectedAgents",
      "decidedAt",
      "supersedes"
    ]) {
      const broken: Record<string, unknown> = { ...decision };
      delete broken[missing];
      expect(
        derivedStateSchema.safeParse({ planSelection: broken, implementationSelection: null, consensus: null }).success,
        `missing ${missing} must not parse`
      ).toBe(false);
    }
    expect(
      derivedStateSchema.safeParse({
        planSelection: { ...decision, surprise: true },
        implementationSelection: null,
        consensus: null
      }).success
    ).toBe(false);
    expect(
      derivedStateSchema.safeParse({
        planSelection: { ...decision, inputs: [] },
        implementationSelection: null,
        consensus: null
      }).success
    ).toBe(false);
  });

  it("records the identity a decision superseded", () => {
    const replaced = {
      ...planSelection("claude", ["claude"]),
      supersedes: { kind: "plan-selection" as const, inputSetHash: "9".repeat(64), round: null }
    };
    const parsed = derivedStateSchema.parse({
      planSelection: replaced,
      implementationSelection: null,
      consensus: null
    });
    expect(parsed.planSelection?.supersedes).toEqual({
      kind: "plan-selection",
      inputSetHash: "9".repeat(64),
      round: null
    });
  });

  it("clears the decisions a drop falsifies, and everything downstream of them", () => {
    const full: DerivedState = derivedStateSchema.parse({
      planSelection: planSelection("codex"),
      implementationSelection: implementationSelection("codex"),
      consensus: consensusDecision("codex")
    });
    // Dropping the plan winner voids the implementation and the consensus built
    // on top of it, not only the plan selection itself.
    expect(invalidateDerivedForDrop(full, "codex")).toEqual({
      planSelection: null,
      implementationSelection: null,
      consensus: null
    });
    // Dropping an agent named in no result leaves every decision standing.
    expect(invalidateDerivedForDrop(full, "claude")).toEqual(full);
  });

  it("carries drop invalidation through dropAgent", () => {
    const { cursors } = initialize();
    const seeded = cursorsStateSchema.parse({
      ...cursors,
      derived: derivedStateSchema.parse({
        planSelection: planSelection("codex"),
        implementationSelection: null,
        consensus: null
      })
    });
    expect(dropAgent(seeded, "codex", "2026-08-11T10:06:00.000Z").derived.planSelection).toBeNull();
  });
});

describe("runtime format rollout", () => {
  it("refuses version-2 start, cursor, and journal state with a wipe/restart remedy", () => {
    const { paths, start, cursors } = initialize();
    atomicWriteJson(paths.coordRoot, paths.start, { ...start, formatVersion: 2 });
    expect(() => readStartState(paths)).toThrow(/format version 2.*coord wipe-issue/s);

    const fresh = initialize();
    atomicWriteJson(fresh.paths.coordRoot, fresh.paths.cursors, { ...cursors, formatVersion: 2 });
    expect(() => readCursorsState(fresh.paths)).toThrow(/format version 2.*coord wipe-issue/s);

    const journal = initialize();
    writeFileSync(
      journal.paths.journal,
      `${JSON.stringify({ formatVersion: 2, sequence: 0, at: "2026-08-11T10:00:00.000Z", type: "started", details: {} })}\n`,
      "utf8"
    );
    expect(() => readJournal(journal.paths)).toThrow(/format version 2.*coord wipe-issue/s);
    expect(() => appendJournal(journal.paths, { type: "paused", details: {} })).toThrow(/format version 2/);
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
