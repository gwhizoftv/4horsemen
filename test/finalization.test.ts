import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { verifyFinalization } from "../src/finalization.js";

function createTempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "final-test-"));
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

const fakeSha = "a".repeat(40);
const fakeSha2 = "b".repeat(40);

describe("verifyFinalization", () => {
  describe("input validation", () => {
    it("rejects issue 0", () => {
      const result = verifyFinalization({ root: "/tmp", issue: 0, consensusSha: fakeSha, finalSha: fakeSha2 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-commit");
    });

    it("rejects negative issue", () => {
      const result = verifyFinalization({ root: "/tmp", issue: -1, consensusSha: fakeSha, finalSha: fakeSha2 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-commit");
    });

    it("rejects non-integer issue", () => {
      const result = verifyFinalization({ root: "/tmp", issue: 1.5, consensusSha: fakeSha, finalSha: fakeSha2 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-commit");
    });

    it("rejects invalid SHA format", () => {
      const result = verifyFinalization({ root: "/tmp", issue: 1, consensusSha: "bad", finalSha: fakeSha2 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid-commit");
    });
  });

  describe("git-based checks", () => {
    it("returns missing-consensus when consensus commit does not exist", () => {
      const dir = createTempRepo();
      const finalSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha: fakeSha, finalSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("missing-consensus");
      rmSync(dir, { recursive: true, force: true });
    });

    it("returns missing-final when final commit does not exist", () => {
      const dir = createTempRepo();
      const consensusSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha, finalSha: fakeSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("missing-final");
      rmSync(dir, { recursive: true, force: true });
    });

    it("returns history-rewrite when final is not descendant of consensus", () => {
      const dir = createTempRepo();
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      getSha(dir); // initial commit
      run("git checkout -b other");
      writeFileSync(path.join(dir, "other.txt"), "x");
      run("git add -A && git commit -m other");
      run("git checkout -");
      writeFileSync(path.join(dir, "main.txt"), "y");
      run("git add -A && git commit -m main");
      const finalSha = getSha(dir);
      // finalSha is descendant of consensus, but let's use otherTip as final
      run("git checkout other");
      const otherSha = getSha(dir);
      // main tip is not ancestor of other tip
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha: finalSha, finalSha: otherSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("history-rewrite");
      rmSync(dir, { recursive: true, force: true });
    });

    it("returns ok with deletedPaths for coordination-only deletions", () => {
      const dir = createTempRepo();
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      execSync("mkdir -p .plans/issue-1", { cwd: dir, stdio: "pipe" });
      writeFileSync(path.join(dir, ".plans/issue-1/plan.md"), "plan");
      run("git add -A && git commit -m add-plan");
      const consensusSha = getSha(dir);
      run("git rm .plans/issue-1/plan.md");
      run('git commit -m "cleanup"');
      const finalSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha, finalSha });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.deletedPaths).toEqual([".plans/issue-1/plan.md"]);
      }
      rmSync(dir, { recursive: true, force: true });
    });

    it("rejects addition after consensus", () => {
      const dir = createTempRepo();
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      const consensusSha = getSha(dir);
      writeFileSync(path.join(dir, "new-file.ts"), "code");
      run("git add -A && git commit -m add");
      const finalSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha, finalSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("non-cleanup-change");
      rmSync(dir, { recursive: true, force: true });
    });

    it("rejects modification after consensus", () => {
      const dir = createTempRepo();
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      const consensusSha = getSha(dir);
      writeFileSync(path.join(dir, "init.txt"), "modified");
      run("git add -A && git commit -m modify");
      const finalSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha, finalSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("non-cleanup-change");
      rmSync(dir, { recursive: true, force: true });
    });

    it("rejects deletion of wrong-issue coordination file", () => {
      const dir = createTempRepo();
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      execSync("mkdir -p .plans/issue-99", { cwd: dir, stdio: "pipe" });
      writeFileSync(path.join(dir, ".plans/issue-99/plan.md"), "plan");
      run("git add -A && git commit -m add-wrong-issue");
      const consensusSha = getSha(dir);
      run("git rm .plans/issue-99/plan.md");
      run('git commit -m "cleanup-wrong"');
      const finalSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha, finalSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("non-cleanup-change");
      rmSync(dir, { recursive: true, force: true });
    });

    it("rejects product file deletion", () => {
      const dir = createTempRepo();
      const run = (cmd: string) => execSync(cmd, { cwd: dir, stdio: "pipe" });
      writeFileSync(path.join(dir, "src-file.ts"), "code");
      run("git add -A && git commit -m add-src");
      const consensusSha = getSha(dir);
      run("git rm src-file.ts");
      run('git commit -m "delete-src"');
      const finalSha = getSha(dir);
      const result = verifyFinalization({ root: dir, issue: 1, consensusSha, finalSha });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("non-cleanup-change");
      rmSync(dir, { recursive: true, force: true });
    });
  });
});
