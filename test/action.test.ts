import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  generateActionId,
  renderActionMd,
  parseActionFrontMatter,
  writeAction,
  readAction,
  readComplete,
  clearComplete,
} from "../src/action.js";
import type { InternalAction } from "../src/action.js";
import { completePath } from "../src/paths.js";
import { existsSync } from "node:fs";
import { ensureIssueStructure } from "../src/state.js";

const sha = "a".repeat(40);

function makeAction(overrides?: Partial<InternalAction>): InternalAction {
  return {
    actionId: "issue-1:alice:R1.join:1",
    agent: "alice",
    stepId: "R1.join",
    evidenceId: "join-published",
    requiredPath: ".signals/issue-1/joined-alice.json",
    issue: 1,
    attempt: 1,
    inputCommits: {},
    outstanding: [],
    ...overrides,
  };
}

describe("generateActionId", () => {
  it("produces expected format", () => {
    expect(generateActionId(1, "alice", "R1.join", 1)).toBe("issue-1:alice:R1.join:1");
  });
});

describe("renderActionMd", () => {
  it("includes actionId, agent, requiredPath in front-matter", () => {
    const md = renderActionMd(makeAction(), "/tmp/complete");
    expect(md).toContain("actionId: issue-1:alice:R1.join:1");
    expect(md).toContain("agent: alice");
    expect(md).toContain("requiredPath: .signals/issue-1/joined-alice.json");
  });

  it("never includes stepId, gateId, evidenceId, phase", () => {
    const md = renderActionMd(makeAction(), "/tmp/complete");
    expect(md).not.toMatch(/^stepId:/m);
    expect(md).not.toMatch(/^gateId:/m);
    expect(md).not.toMatch(/^evidenceId:/m);
    expect(md).not.toMatch(/^phase:/m);
  });
});

describe("parseActionFrontMatter", () => {
  it("round-trips with renderActionMd", () => {
    const action = makeAction();
    const md = renderActionMd(action, "/tmp/complete");
    const parsed = parseActionFrontMatter(md);
    expect(parsed).toEqual({
      actionId: action.actionId,
      agent: action.agent,
      requiredPath: action.requiredPath,
    });
  });

  it("returns null for malformed", () => {
    expect(parseActionFrontMatter("no front matter here")).toBeNull();
  });
});

describe("file I/O", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "coord-action-test-"));
    ensureIssueStructure(tmp, 1, ["alice"]);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("writeAction / readAction round-trip", () => {
    const action = makeAction();
    writeAction(tmp, 1, action);
    const read = readAction(tmp, 1, "alice");
    expect(read).toEqual({
      actionId: action.actionId,
      agent: action.agent,
      requiredPath: action.requiredPath,
    });
  });

  it("readComplete returns null for missing file", () => {
    expect(readComplete(tmp, 1, "alice")).toBeNull();
  });

  it("readComplete returns null for malformed content", () => {
    writeFileSync(completePath(tmp, 1, "alice"), "not-a-sha\n");
    expect(readComplete(tmp, 1, "alice")).toBeNull();
  });

  it("readComplete parses bare 40-hex SHA", () => {
    writeFileSync(completePath(tmp, 1, "alice"), sha + "\n");
    expect(readComplete(tmp, 1, "alice")).toBe(sha);
  });

  it('readComplete parses "commit <sha>" format', () => {
    writeFileSync(completePath(tmp, 1, "alice"), `commit ${sha}\n`);
    expect(readComplete(tmp, 1, "alice")).toBe(sha);
  });

  it("clearComplete removes the file", () => {
    writeFileSync(completePath(tmp, 1, "alice"), sha);
    clearComplete(tmp, 1, "alice");
    expect(existsSync(completePath(tmp, 1, "alice"))).toBe(false);
  });
});
