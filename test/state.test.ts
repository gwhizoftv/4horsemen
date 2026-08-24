import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  appendJournal,
  cursorsStateSchema,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readCursorsState,
  readJournal,
  readStartState,
  setPaused,
  StateConflictError,
  startStateSchema,
  coordinatorConfigSchema,
  writeCursorsState
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
