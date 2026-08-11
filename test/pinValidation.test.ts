import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  parseNameStatusRecordsZ,
  parseNameStatusZ,
  displayGitPaths,
  currentIssueCoordinationPrefixes,
  isCurrentIssueCoordinationPath,
  isCoordinationPath,
  inspectCommitRange,
  validatePhasePin,
} from "../src/pinValidation.js";

describe("parseNameStatusRecordsZ", () => {
  it("returns empty array for empty buffer", () => {
    expect(parseNameStatusRecordsZ(Buffer.alloc(0))).toEqual([]);
  });

  it("parses a single add", () => {
    // Format: "A\0path\0"
    const buf = Buffer.from("A\0src/foo.ts\0");
    const result = parseNameStatusRecordsZ(buf);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("A");
    expect(result[0]!.paths[0]!.toString()).toBe("src/foo.ts");
  });

  it("parses a single delete", () => {
    const buf = Buffer.from("D\0old.ts\0");
    const result = parseNameStatusRecordsZ(buf);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("D");
    expect(result[0]!.paths[0]!.toString()).toBe("old.ts");
  });

  it("parses a rename (R100) with two paths", () => {
    const buf = Buffer.from("R100\0src/a.ts\0src/b.ts\0");
    const result = parseNameStatusRecordsZ(buf);
    expect(result).toHaveLength(1);
    expect(result[0]!.status).toBe("R100");
    expect(result[0]!.paths).toHaveLength(2);
    expect(result[0]!.paths[0]!.toString()).toBe("src/a.ts");
    expect(result[0]!.paths[1]!.toString()).toBe("src/b.ts");
  });

  it("parses mixed records", () => {
    const buf = Buffer.from("A\0new.ts\0D\0old.ts\0R100\0a.ts\0b.ts\0");
    const result = parseNameStatusRecordsZ(buf);
    expect(result).toHaveLength(3);
    expect(result[0]!.status).toBe("A");
    expect(result[1]!.status).toBe("D");
    expect(result[2]!.status).toBe("R100");
  });

  it("throws on malformed input", () => {
    // Status with no following path (just a trailing NUL producing empty field)
    const buf = Buffer.from("A\0foo.ts\0\0");
    expect(() => parseNameStatusRecordsZ(buf)).toThrow("malformed");
  });
});

describe("parseNameStatusZ", () => {
  it("flattens rename paths", () => {
    const buf = Buffer.from("R100\0src/a.ts\0src/b.ts\0");
    const result = parseNameStatusZ(buf);
    expect(result).toHaveLength(2);
    expect(result[0]!.toString()).toBe("src/a.ts");
    expect(result[1]!.toString()).toBe("src/b.ts");
  });
});

describe("isCurrentIssueCoordinationPath", () => {
  it("matches .plans/issue-5/foo", () => {
    expect(isCurrentIssueCoordinationPath(Buffer.from(".plans/issue-5/foo"), 5)).toBe(true);
  });

  it("matches .signals/issue-5/bar", () => {
    expect(isCurrentIssueCoordinationPath(Buffer.from(".signals/issue-5/bar"), 5)).toBe(true);
  });

  it("matches .code-reviews/issue-5/x", () => {
    expect(isCurrentIssueCoordinationPath(Buffer.from(".code-reviews/issue-5/x"), 5)).toBe(true);
  });

  it("rejects .plans/issue-6/foo for issue 5", () => {
    expect(isCurrentIssueCoordinationPath(Buffer.from(".plans/issue-6/foo"), 5)).toBe(false);
  });

  it("rejects src/foo.ts", () => {
    expect(isCurrentIssueCoordinationPath(Buffer.from("src/foo.ts"), 5)).toBe(false);
  });
});

describe("isCoordinationPath", () => {
  it("matches any .plans/ prefix", () => {
    expect(isCoordinationPath(Buffer.from(".plans/issue-99/x"))).toBe(true);
  });

  it("matches any .signals/ prefix", () => {
    expect(isCoordinationPath(Buffer.from(".signals/issue-1/y"))).toBe(true);
  });

  it("matches any .code-reviews/ prefix", () => {
    expect(isCoordinationPath(Buffer.from(".code-reviews/issue-2/z"))).toBe(true);
  });

  it("rejects product files", () => {
    expect(isCoordinationPath(Buffer.from("src/index.ts"))).toBe(false);
  });
});

describe("displayGitPaths", () => {
  it("formats paths as JSON strings joined by comma-space", () => {
    const paths = [Buffer.from("a.ts"), Buffer.from("b.ts")];
    expect(displayGitPaths(paths)).toBe('"a.ts", "b.ts"');
  });
});

describe("currentIssueCoordinationPrefixes", () => {
  it("returns three prefixes for an issue", () => {
    const result = currentIssueCoordinationPrefixes(3);
    expect(result).toEqual([
      ".plans/issue-3/",
      ".signals/issue-3/",
      ".code-reviews/issue-3/",
    ]);
  });
});

// --- git-based tests ---

function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pin-test-"));
  const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
  run("git init");
  run("git config user.email test@test.com");
  run("git config user.name Test");
  writeFileSync(path.join(dir, "init.txt"), "init");
  run("git add -A && git commit -m init");
  return dir;
}

function getSha(dir: string): string {
  return execSync("git rev-parse HEAD", { cwd: dir, encoding: "utf8" }).trim();
}

describe("inspectCommitRange", () => {
  let dir: string;

  it("returns missing-base for unknown base", () => {
    dir = createTempRepo();
    const tip = getSha(dir);
    const result = inspectCommitRange(dir, "0000000000000000000000000000000000000000", tip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing-base");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns missing-tip for unknown tip", () => {
    dir = createTempRepo();
    const base = getSha(dir);
    const result = inspectCommitRange(dir, base, "0000000000000000000000000000000000000000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing-tip");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns not-ancestor when base is not ancestor of tip", () => {
    dir = createTempRepo();
    getSha(dir); // initial commit
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
    run("git checkout -b other");
    writeFileSync(path.join(dir, "other.txt"), "other");
    run("git add -A && git commit -m other");
    const otherTip = getSha(dir);
    run("git checkout -");
    writeFileSync(path.join(dir, "main.txt"), "main");
    run("git add -A && git commit -m main");
    const mainTip = getSha(dir);
    // mainTip is not ancestor of otherTip and vice versa
    const result = inspectCommitRange(dir, mainTip, otherTip);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not-ancestor");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns ok with changes for valid range", () => {
    dir = createTempRepo();
    const base = getSha(dir);
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
    writeFileSync(path.join(dir, "new.txt"), "new");
    run("git add -A && git commit -m add-new");
    const tip = getSha(dir);
    const result = inspectCommitRange(dir, base, tip);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.changes.length).toBeGreaterThan(0);
      expect(result.changes[0]!.status).toBe("A");
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("validatePhasePin", () => {
  it("returns ok when only coordination changes follow pin", () => {
    const dir = createTempRepo();
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
    // Create implementation commit (the pin)
    writeFileSync(path.join(dir, "src-file.ts"), "code");
    run("git add -A && git commit -m impl");
    const pin = getSha(dir);
    // Add coordination file
    execSync("mkdir -p .plans/issue-5", { cwd: dir, stdio: "pipe" });
    writeFileSync(path.join(dir, ".plans/issue-5/review.md"), "review");
    run("git add -A && git commit -m coordination");
    const tip = getSha(dir);
    const result = validatePhasePin({
      root: dir, ref: "origin/issue-5/cursor", pin, tip, issue: 5, subject: "test",
    });
    expect(result.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns post-pin-implementation-change when product files change after pin", () => {
    const dir = createTempRepo();
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
    writeFileSync(path.join(dir, "src-file.ts"), "code");
    run("git add -A && git commit -m impl");
    const pin = getSha(dir);
    writeFileSync(path.join(dir, "src-file.ts"), "modified");
    run("git add -A && git commit -m bad-change");
    const tip = getSha(dir);
    const result = validatePhasePin({
      root: dir, ref: "origin/issue-5/cursor", pin, tip, issue: 5, subject: "test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("post-pin-implementation-change");
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns history-rewrite when pin is not ancestor of tip", () => {
    const dir = createTempRepo();
    const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
    writeFileSync(path.join(dir, "a.ts"), "a");
    run("git add -A && git commit -m branch-a");
    const pin = getSha(dir);
    // Diverge: go back and create a different branch
    run("git checkout HEAD~1");
    writeFileSync(path.join(dir, "b.ts"), "b");
    run("git add -A && git commit -m branch-b");
    const tip = getSha(dir);
    const result = validatePhasePin({
      root: dir, ref: "origin/issue-5/cursor", pin, tip, issue: 5, subject: "test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("history-rewrite");
    rmSync(dir, { recursive: true, force: true });
  });
});
