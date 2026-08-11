import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { coordPaths } from "../src/paths.js";
import {
  activeAgents,
  appendJournal,
  coordConfigSchema,
  cursorsSchema,
  ensureRuntimeLayout,
  initialCursors,
  loadRuntimeState,
  readJournal,
  readJsonValidated,
  saveCursors,
  startRecordSchema,
  writeFileAtomic,
  writeJsonAtomic,
  writeStartRecord,
  type StartRecord
} from "../src/state.js";
import { DEFAULT_MAX_REVISION_ROUNDS, RUNTIME_FORMAT_VERSION } from "../src/steps.js";

const roots: string[] = [];

const newRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "coord-state-"));

  roots.push(root);

  return root;
};

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();

    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

const now = "2026-08-11T01:00:00Z";
const sha = (fill: string): string => fill.repeat(40).slice(0, 40);

const roster = ["antigravity", "claude", "codex", "cursor"];

const makeStart = (overrides: Partial<StartRecord> = {}): StartRecord => ({
  runtimeFormatVersion: RUNTIME_FORMAT_VERSION,
  issue: 1,
  issueSessionId: `issue-1:${sha("a")}`,
  baselineSha: sha("a"),
  profile: "consensus",
  originalRoster: roster,
  agentRoots: Object.fromEntries(roster.map((agent) => [agent, `/clones/${agent}`])),
  harnesses: Object.fromEntries(roster.map((agent) => [agent, agent])),
  nudgeAllowed: Object.fromEntries(roster.map((agent) => [agent, agent === "claude"])),
  baseBranch: "main",
  branchTemplate: "issue-{issue}/{agent}",
  maxRevisionRounds: DEFAULT_MAX_REVISION_ROUNDS,
  prPolicy: "owner-only",
  automationDigest: "digest",
  automationDigestScheme: "v3",
  trustedSourceCommit: sha("b"),
  finalChecks: [{ argv: ["pnpm", "check"] }],
  createdAt: now,
  ...overrides
});

describe("config schema", () => {
  it("defaults maxRevisionRounds to 3", () => {
    const parsed = coordConfigSchema.parse({
      project: "coordination",
      agents: [{ id: "claude", root: "../coordination-claude" }]
    });

    expect(parsed.maxRevisionRounds).toBe(3);
    expect(DEFAULT_MAX_REVISION_ROUNDS).toBe(3);
  });

  it("defaults every harness to pull-only", () => {
    const parsed = coordConfigSchema.parse({
      project: "coordination",
      agents: [{ id: "claude", root: "../coordination-claude" }]
    });

    expect(parsed.agents[0]?.nudge).toBe(false);
  });

  it("rejects an unknown configuration key", () => {
    expect(
      coordConfigSchema.safeParse({
        project: "coordination",
        agents: [{ id: "claude", root: "../c" }],
        defaultCoordRoot: "../coord-runtime"
      }).success
    ).toBe(false);
  });

  it("rejects a shell string in place of an argument vector", () => {
    expect(
      coordConfigSchema.safeParse({
        project: "coordination",
        agents: [{ id: "claude", root: "../c" }],
        finalChecks: [{ argv: "pnpm check" }]
      }).success
    ).toBe(false);
  });

  it("rejects a revision limit below 1", () => {
    expect(
      coordConfigSchema.safeParse({
        project: "coordination",
        agents: [{ id: "claude", root: "../c" }],
        maxRevisionRounds: 0
      }).success
    ).toBe(false);
  });
});

describe("start record schema", () => {
  it("accepts a well-formed record", () => {
    expect(startRecordSchema.safeParse(makeStart()).success).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(startRecordSchema.safeParse({ ...makeStart(), extra: 1 }).success).toBe(false);
  });

  it("fails closed on a foreign runtime format version", () => {
    const result = startRecordSchema.safeParse({ ...makeStart(), runtimeFormatVersion: 99 });

    expect(result.success).toBe(false);
  });

  it("rejects an empty roster", () => {
    expect(startRecordSchema.safeParse({ ...makeStart(), originalRoster: [] }).success).toBe(false);
  });
});

describe("cursors schema", () => {
  it("accepts the initial cursors document", () => {
    expect(cursorsSchema.safeParse(initialCursors(makeStart(), "gate-1-join", now)).success).toBe(true);
  });

  it("starts every agent idle with zero attempts and no drops", () => {
    const cursors = initialCursors(makeStart(), "gate-1-join", now);

    expect(cursors.droppedAgents).toEqual([]);
    expect(cursors.paused).toBe(false);
    expect(cursors.selected).toBeNull();
    expect(Object.values(cursors.agents).every((cursor) => cursor.status === "idle")).toBe(true);
    expect(Object.values(cursors.agents).every((cursor) => cursor.attempt === 0)).toBe(true);
  });

  it("gives nudge-allowed harnesses both delivery and others pull-only", () => {
    const cursors = initialCursors(makeStart(), "gate-1-join", now);

    expect(cursors.agents["claude"]?.delivery).toBe("both");
    expect(cursors.agents["codex"]?.delivery).toBe("pull");
    expect(cursors.agents["cursor"]?.delivery).toBe("pull");
    expect(cursors.agents["antigravity"]?.delivery).toBe("pull");
  });

  it("rejects a negative attempt count", () => {
    const cursors = initialCursors(makeStart(), "gate-1-join", now);
    const broken = {
      ...cursors,
      agents: { ...cursors.agents, claude: { ...cursors.agents["claude"], attempt: -1 } }
    };

    expect(cursorsSchema.safeParse(broken).success).toBe(false);
  });
});

describe("atomic writes", () => {
  it("leaves no temporary file behind", () => {
    const root = newRoot();
    const target = join(root, "nested", "start.json");

    writeJsonAtomic(target, { a: 1 });

    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ a: 1 });
    expect(existsSync(`${target}.tmp`)).toBe(false);
  });

  it("replaces existing contents rather than appending", () => {
    const root = newRoot();
    const target = join(root, "cursors.json");

    writeFileAtomic(target, "first\n");
    writeFileAtomic(target, "second\n");

    expect(readFileSync(target, "utf8")).toBe("second\n");
  });
});

describe("readJsonValidated", () => {
  it("reports a missing file concretely", () => {
    const result = readJsonValidated(join(newRoot(), "absent.json"), startRecordSchema);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors[0]).toMatch(/cannot read/);
    }
  });

  it("reports invalid JSON concretely", () => {
    const root = newRoot();
    const target = join(root, "cursors.json");

    writeFileSync(target, "{oops");

    const result = readJsonValidated(target, cursorsSchema);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors[0]).toMatch(/invalid JSON/);
    }
  });

  it("names the offending field on a schema failure", () => {
    const root = newRoot();
    const target = join(root, "start.json");

    writeJsonAtomic(target, { ...makeStart(), baselineSha: "short" });

    const result = readJsonValidated(target, startRecordSchema);

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("baselineSha");
    }
  });
});

describe("journal", () => {
  it("appends events and reads them back in order", () => {
    const root = newRoot();
    const path = join(root, "journal.jsonl");

    appendJournal(path, { at: now, kind: "started", detail: { issue: 1 } });
    appendJournal(path, { at: now, kind: "action-prepared", agent: "claude", detail: { stepId: "R1.join" } });
    appendJournal(path, { at: now, kind: "intent-seen", agent: "claude", detail: { sha: sha("c") } });

    const events = readJournal(path);

    expect(events.map((event) => event.kind)).toEqual(["started", "action-prepared", "intent-seen"]);
    expect(events[2]?.detail["sha"]).toBe(sha("c"));
  });

  it("returns an empty list when no journal exists yet", () => {
    expect(readJournal(join(newRoot(), "journal.jsonl"))).toEqual([]);
  });

  it("survives a partial trailing line from an interrupted append", () => {
    const root = newRoot();
    const path = join(root, "journal.jsonl");

    appendJournal(path, { at: now, kind: "started", detail: {} });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"at":"2026`, { flag: "w" });

    expect(() => readJournal(path)).toThrow();
  });

  it("rejects an unknown event kind", () => {
    const root = newRoot();

    expect(() =>
      appendJournal(join(root, "journal.jsonl"), {
        at: now,
        kind: "invented" as never,
        detail: {}
      })
    ).toThrow();
  });
});

describe("runtime state round trip", () => {
  it("writes and reloads start.json and cursors.json", () => {
    const root = newRoot();
    const paths = coordPaths(root, 1);
    const start = makeStart();

    ensureRuntimeLayout(paths, start.originalRoster);
    writeStartRecord(paths, start);
    writeJsonAtomic(paths.cursorsJson, initialCursors(start, "gate-1-join", now));

    const loaded = loadRuntimeState(root, 1);

    expect(loaded.ok).toBe(true);

    if (loaded.ok) {
      expect(loaded.value.start.maxRevisionRounds).toBe(3);
      expect(loaded.value.cursors.issueCursor.gateId).toBe("gate-1-join");
      expect(Object.keys(loaded.value.cursors.agents)).toEqual(roster);
    }
  });

  it("creates one directory per roster agent", () => {
    const root = newRoot();
    const paths = coordPaths(root, 1);

    ensureRuntimeLayout(paths, roster);

    for (const agent of roster) {
      expect(existsSync(paths.agentDir(agent))).toBe(true);
    }
  });

  it("fails to load when start.json is absent", () => {
    expect(loadRuntimeState(newRoot(), 1).ok).toBe(false);
  });
});

describe("dropped agents and pause", () => {
  const setup = (): { root: string; start: StartRecord } => {
    const root = newRoot();
    const paths = coordPaths(root, 1);
    const start = makeStart();

    ensureRuntimeLayout(paths, start.originalRoster);
    writeStartRecord(paths, start);
    writeJsonAtomic(paths.cursorsJson, initialCursors(start, "gate-1-join", now));

    return { root, start };
  };

  it("persists a drop and removes the agent from the active roster", () => {
    const { root, start } = setup();
    const loaded = loadRuntimeState(root, 1);

    expect(loaded.ok).toBe(true);

    if (!loaded.ok) {
      return;
    }

    loaded.value.cursors = { ...loaded.value.cursors, droppedAgents: ["codex"] };
    saveCursors(loaded.value, now);

    const reloaded = loadRuntimeState(root, 1);

    expect(reloaded.ok).toBe(true);

    if (reloaded.ok) {
      expect(reloaded.value.cursors.droppedAgents).toEqual(["codex"]);
      expect(activeAgents(start, reloaded.value.cursors)).toEqual(["antigravity", "claude", "cursor"]);
    }
  });

  it("keeps the original roster intact after a drop", () => {
    const { root, start } = setup();
    const loaded = loadRuntimeState(root, 1);

    if (!loaded.ok) {
      throw new Error("expected state to load");
    }

    loaded.value.cursors = { ...loaded.value.cursors, droppedAgents: ["codex", "cursor"] };
    saveCursors(loaded.value, now);

    const reloaded = loadRuntimeState(root, 1);

    if (!reloaded.ok) {
      throw new Error("expected state to reload");
    }

    expect(reloaded.value.start.originalRoster).toEqual(roster);
    expect(activeAgents(start, reloaded.value.cursors)).toEqual(["antigravity", "claude"]);
  });

  it("persists pause across a reload and clears on resume", () => {
    const { root } = setup();
    const paused = loadRuntimeState(root, 1);

    if (!paused.ok) {
      throw new Error("expected state to load");
    }

    paused.value.cursors = { ...paused.value.cursors, paused: true };
    saveCursors(paused.value, now);

    const afterPause = loadRuntimeState(root, 1);

    expect(afterPause.ok && afterPause.value.cursors.paused).toBe(true);

    if (!afterPause.ok) {
      return;
    }

    afterPause.value.cursors = { ...afterPause.value.cursors, paused: false };
    saveCursors(afterPause.value, now);

    const afterResume = loadRuntimeState(root, 1);

    expect(afterResume.ok && afterResume.value.cursors.paused).toBe(false);
  });

  it("preserves an outstanding action across pause and resume", () => {
    const { root } = setup();
    const loaded = loadRuntimeState(root, 1);

    if (!loaded.ok) {
      throw new Error("expected state to load");
    }

    const claude = loaded.value.cursors.agents["claude"];

    if (claude === undefined) {
      throw new Error("expected a claude cursor");
    }

    loaded.value.cursors = {
      ...loaded.value.cursors,
      paused: true,
      agents: {
        ...loaded.value.cursors.agents,
        claude: { ...claude, status: "ordered", stepId: "R2.plan", actionId: "abc", attempt: 7 }
      }
    };
    saveCursors(loaded.value, now);

    const reloaded = loadRuntimeState(root, 1);

    if (!reloaded.ok) {
      throw new Error("expected state to reload");
    }

    // Indefinite waiting: a high attempt count is retained and means nothing
    // beyond diagnostics — the action is still outstanding.
    expect(reloaded.value.cursors.agents["claude"]?.attempt).toBe(7);
    expect(reloaded.value.cursors.agents["claude"]?.status).toBe("ordered");
    expect(reloaded.value.cursors.agents["claude"]?.stepId).toBe("R2.plan");
  });
});
