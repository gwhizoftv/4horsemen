import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StartSchema, CursorsSchema, writeJsonAtomic, writeStart, readStart, writeCursors, readCursors, appendJournal, readJournal, ensureIssueStructure } from "../src/state.js";
import type { StartConfig, Cursors, JournalEntry } from "../src/state.js";

const sha = "a".repeat(40);
const sessionId = "issue-1:" + sha;
const now = "2026-01-01T00:00:00Z";

const makeStart = (overrides?: Partial<StartConfig>): StartConfig => ({
  formatVersion: 1 as const,
  issue: 1,
  issueSessionId: sessionId,
  baselineSha: sha,
  profile: "consensus",
  roster: ["alice", "bob"],
  baseBranch: "main",
  maxRevisionRounds: 3,
  prPolicy: "owner-only",
  automationDigest: "digest123",
  automationDigestScheme: "v3",
  trustedSourceCommit: "b".repeat(40),
  createdAt: now,
  ...overrides,
});

describe("StartSchema", () => {
  it("validates correctly", () => {
    expect(StartSchema.parse(makeStart())).toEqual(makeStart());
  });

  it("rejects missing fields", () => {
    expect(() => StartSchema.parse({ formatVersion: 1 })).toThrow();
  });

  it("default maxRevisionRounds is 3", () => {
    const input = { ...makeStart() };
    delete (input as Record<string, unknown>)["maxRevisionRounds"];
    const parsed = StartSchema.parse(input);
    expect(parsed.maxRevisionRounds).toBe(3);
  });
});

describe("CursorsSchema", () => {
  it("validates with droppedAgents default to []", () => {
    const input = {
      issueCursor: { gateId: "gate-1-join", round: null },
      agents: {},
    };
    const parsed = CursorsSchema.parse(input);
    expect(parsed.droppedAgents).toEqual([]);
    expect(parsed.paused).toBe(false);
  });
});

describe("file I/O", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "coord-state-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeJsonAtomic + read cycle", () => {
    const path = join(tmp, "sub", "test.json");
    const data = { hello: "world", n: 42 };
    writeJsonAtomic(path, data);
    const read = JSON.parse(readFileSync(path, "utf8"));
    expect(read).toEqual(data);
  });

  it("writeStart / readStart round-trip", () => {
    const config = makeStart();
    writeStart(tmp, 1, config);
    const read = readStart(tmp, 1);
    expect(read).toEqual(config);
  });

  it("writeCursors / readCursors round-trip", () => {
    const cursors: Cursors = {
      issueCursor: { gateId: "gate-1-join", round: null },
      agents: {},
      droppedAgents: [],
      paused: false,
    };
    writeCursors(tmp, 1, cursors);
    const read = readCursors(tmp, 1);
    expect(read).toEqual(cursors);
  });

  it("appendJournal / readJournal round-trip", () => {
    const e1: JournalEntry = { timestamp: now, event: "started" };
    const e2: JournalEntry = { timestamp: now, event: "advanced", gate: "gate-1" };
    appendJournal(tmp, 1, e1);
    appendJournal(tmp, 1, e2);
    const entries = readJournal(tmp, 1);
    expect(entries).toEqual([e1, e2]);
  });

  it("ensureIssueStructure creates directory tree", () => {
    ensureIssueStructure(tmp, 1, ["alice", "bob"]);
    expect(existsSync(join(tmp, "issue-1"))).toBe(true);
    expect(existsSync(join(tmp, "issue-1", "agents", "alice"))).toBe(true);
    expect(existsSync(join(tmp, "issue-1", "agents", "bob"))).toBe(true);
  });
});
