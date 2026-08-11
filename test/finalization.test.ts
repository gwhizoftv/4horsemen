import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyFinalization } from "../src/finalization.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const commit = (root: string, message: string): string => {
  git(root, "add", "-A");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", message);
  return git(root, "rev-parse", "HEAD");
};

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-final-"));
  roots.push(root);
  git(root, "init", "-q");
  mkdirSync(join(root, ".plans/issue-1"), { recursive: true });
  mkdirSync(join(root, ".signals/issue-1"), { recursive: true });
  writeFileSync(join(root, "product.txt"), "accepted\n");
  writeFileSync(join(root, ".plans/issue-1/plan.md"), "# Plan\n");
  writeFileSync(join(root, ".signals/issue-1/ready.json"), "{}\n");
  return { root, consensusSha: commit(root, "consensus") };
};

describe("finalization verification", () => {
  it("accepts deletion-only cleanup for the current issue", () => {
    const { root, consensusSha } = fixture();
    rmSync(join(root, ".plans/issue-1"), { recursive: true });
    rmSync(join(root, ".signals/issue-1"), { recursive: true });
    const finalSha = commit(root, "cleanup");
    expect(verifyFinalization({ root, issue: 1, consensusSha, finalSha })).toMatchObject({
      ok: true,
      deletedPaths: [".plans/issue-1/plan.md", ".signals/issue-1/ready.json"]
    });
  });

  it("rejects product changes and rewritten history", () => {
    const changed = fixture();
    writeFileSync(join(changed.root, "product.txt"), "changed\n");
    const changedSha = commit(changed.root, "not cleanup");
    expect(verifyFinalization({ root: changed.root, issue: 1, consensusSha: changed.consensusSha, finalSha: changedSha })).toMatchObject({
      ok: false,
      reason: "non-cleanup-change"
    });

    const unrelated = fixture();
    const otherRoot = mkdtempSync(join(tmpdir(), "coord-unrelated-"));
    roots.push(otherRoot);
    git(otherRoot, "init", "-q");
    writeFileSync(join(otherRoot, "x"), "x");
    const otherSha = commit(otherRoot, "other");
    expect(verifyFinalization({ root: unrelated.root, issue: 1, consensusSha: unrelated.consensusSha, finalSha: otherSha })).toMatchObject({
      ok: false,
      reason: "missing-final"
    });
  });
});
