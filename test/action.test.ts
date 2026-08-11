import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { renderAction, readCompleteFile, clearCompleteFile } from "../src/action.js";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("action", () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "action-test-")));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("renders action", () => {
    renderAction(tmpRoot, {
      actionId: "act-1",
      agent: "Alice",
      task: "Do something",
      inputs: ["hash1"],
      requiredPath: ".plans/issue-1/foo.md"
    });
    
    const content = readFileSync(join(tmpRoot, "action.md"), "utf8");
    expect(content).toContain("Action: act-1");
    expect(content).toContain("- hash1");
  });

  it("reads and clears complete file", () => {
    expect(readCompleteFile(tmpRoot)).toBe(null);
    
    writeFileSync(join(tmpRoot, "complete"), "  some-sha  \n", "utf8");
    expect(readCompleteFile(tmpRoot)).toBe("some-sha");
    
    clearCompleteFile(tmpRoot);
    expect(readCompleteFile(tmpRoot)).toBe(null);
  });
});
