import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import {
  appendJournal,
  coordinatorConfigSchema,
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
  type StartState,
  workspaceDeclarationSchema,
  writeCursorsState
} from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const initialize = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-state-"));
  roots.push(root);
  const paths = issueRuntimePaths(root, 1);
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
    expect(readStartState(paths)).toMatchObject({ formatVersion: 2, maxRevisionRounds: 3 });
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

  it("validates contextPaths in coordinatorConfigSchema, workspaceDeclarationSchema, and startStateSchema", () => {
    const validConfig = {
      project: "myserver",
      origin: "https://github.com/example/myserver.git",
      agents: [{ id: "claude", root: "/clones/claude", launcher: "start-claude.sh", delivery: "nudge" }],
      branch: "issue-{issue}/{agent}",
      checks: [{ name: "check", argv: ["pnpm", "check"] }],
      contextPaths: ["docs/repo-map.md", "docs/architecture.md"]
    };
    expect(coordinatorConfigSchema.safeParse(validConfig).success).toBe(true);

    // Absolute path
    expect(coordinatorConfigSchema.safeParse({ ...validConfig, contextPaths: ["/docs/repo-map.md"] }).success).toBe(
      false
    );
    // Path with ..
    expect(coordinatorConfigSchema.safeParse({ ...validConfig, contextPaths: ["docs/../secret.md"] }).success).toBe(
      false
    );
    // Duplicate path
    expect(
      coordinatorConfigSchema.safeParse({ ...validConfig, contextPaths: ["docs/repo-map.md", "docs/repo-map.md"] })
        .success
    ).toBe(false);

    // workspaceDeclarationSchema
    expect(workspaceDeclarationSchema.safeParse({ contextPaths: ["docs/repo-map.md"] }).success).toBe(true);
    expect(workspaceDeclarationSchema.safeParse({ contextPaths: ["/docs/repo-map.md"] }).success).toBe(false);
    expect(workspaceDeclarationSchema.safeParse({ contextPaths: ["../secret.md"] }).success).toBe(false);

    // startStateSchema with omitted contextPaths defaults to []
    const { start } = initialize();
    const withoutContextPaths: Partial<StartState> = { ...start };
    delete withoutContextPaths.contextPaths;
    const parsed = startStateSchema.parse(withoutContextPaths);
    expect(parsed.contextPaths).toEqual([]);
  });
});
