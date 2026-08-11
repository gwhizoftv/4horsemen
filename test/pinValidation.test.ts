import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseNameStatusRecordsZ, validatePhasePin } from "../src/pinValidation.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-pin-"));
  roots.push(root);
  git(root, "init", "-q");
  writeFileSync(join(root, "product.txt"), "one\n");
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "pin");
  return { root, pin: git(root, "rev-parse", "HEAD") };
};

const commit = (root: string, path: string, value: string): string => {
  mkdirSync(join(root, path, ".."), { recursive: true });
  writeFileSync(join(root, path), value);
  git(root, "add", ".");
  git(root, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", path);
  return git(root, "rev-parse", "HEAD");
};

describe("phase pin validation", () => {
  it("parses rename records without line-based path assumptions", () => {
    const bytes = Buffer.from("R100\0old name\0new\nname\0M\0plain\0");
    expect(parseNameStatusRecordsZ(bytes)).toEqual([
      { status: "R100", paths: [Buffer.from("old name"), Buffer.from("new\nname")] },
      { status: "M", paths: [Buffer.from("plain")] }
    ]);
  });

  it("allows only current-issue coordination commits after a pin", () => {
    const { root, pin } = fixture();
    const tip = commit(root, ".signals/issue-1/ready.json", "{}\n");
    expect(validatePhasePin({ root, ref: "origin/issue-1/codex", pin, tip, issue: 1, subject: "implementation" })).toEqual({ ok: true });
  });

  it("rejects post-pin product and cross-issue changes", () => {
    const product = fixture();
    const productTip = commit(product.root, "src/new.ts", "export {};\n");
    expect(validatePhasePin({ root: product.root, ref: "origin/x", pin: product.pin, tip: productTip, issue: 1, subject: "pin" })).toMatchObject({
      ok: false,
      reason: "post-pin-implementation-change"
    });

    const cross = fixture();
    const crossTip = commit(cross.root, ".plans/issue-2/plan.md", "# Plan\n");
    expect(validatePhasePin({ root: cross.root, ref: "origin/x", pin: cross.pin, tip: crossTip, issue: 1, subject: "pin" })).toMatchObject({
      ok: false,
      reason: "cross-issue-coordination-change"
    });
  });
});
