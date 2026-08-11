import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initializeState, updateCursors, appendJournal, StartState } from "../src/state.js";
import { mkdtempSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("state", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "state-test-")));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("initializes state", () => {
    const start: StartState = {
      formatVersion: 1,
      issue: 42,
      originalRoster: ["Alice"],
      branchTemplate: "issue-{n}/{agent}",
      digest: "abcd",
      sourceCommit: "1234",
      prPolicy: "none",
      revisionLimit: 3
    };
    
    initializeState(tmpRoot, start);
    
    const root = join(tmpRoot, "issue-42");
    expect(existsSync(join(root, "start.json"))).toBe(true);
    expect(existsSync(join(root, "cursors.json"))).toBe(true);
    expect(existsSync(join(root, "journal.jsonl"))).toBe(true);
    
    const readStart = JSON.parse(readFileSync(join(root, "start.json"), "utf8"));
    expect(readStart.revisionLimit).toBe(3);
  });
  
  it("updates cursors and appends journal", () => {
    const start: StartState = {
      formatVersion: 1, issue: 1, originalRoster: [], branchTemplate: "", digest: "", sourceCommit: "", prPolicy: "none", revisionLimit: 3
    };
    initializeState(tmpRoot, start);
    
    updateCursors(tmpRoot, 1, { "Alice": "plan" });
    const root = join(tmpRoot, "issue-1");
    const cursors = JSON.parse(readFileSync(join(root, "cursors.json"), "utf8"));
    expect(cursors["Alice"]).toBe("plan");
    
    appendJournal(tmpRoot, 1, { timestamp: "2026-08-11", action: "test", payload: {} });
    const journal = readFileSync(join(root, "journal.jsonl"), "utf8");
    expect(journal).toContain("2026-08-11");
  });
});
