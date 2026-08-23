import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  checkVersionBump,
  isStrictlyGreater,
  parseDotVersion
} from "../src/versionBump.js";

describe("version bump compare", () => {
  it("parses dotted triples and rejects other shapes", () => {
    expect(parseDotVersion("0.0.3")).toEqual([0, 0, 3]);
    expect(parseDotVersion("1.2.10")).toEqual([1, 2, 10]);
    expect(parseDotVersion("0.0.3-beta")).toBeNull();
    expect(parseDotVersion("v0.0.3")).toBeNull();
  });

  it("orders versions strictly", () => {
    expect(isStrictlyGreater([0, 0, 4], [0, 0, 3])).toBe(true);
    expect(isStrictlyGreater([0, 1, 0], [0, 0, 9])).toBe(true);
    expect(isStrictlyGreater([0, 0, 3], [0, 0, 3])).toBe(false);
    expect(isStrictlyGreater([0, 0, 2], [0, 0, 3])).toBe(false);
  });
});

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true });
});

const writeManifest = (root: string, version: string): void => {
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "version-bump-fixture", version }, null, 2)}\n`
  );
};

/**
 * A throwaway repository whose `main` carries `baseVersion` and whose worktree
 * manifest carries `headVersion`. The gate reads head from the file and base
 * through `git show`, so the head version needs no commit of its own.
 */
const fixture = (baseVersion: string, headVersion: string): string => {
  const root = mkdtempSync(join(tmpdir(), "coord-versionbump-"));
  repos.push(root);
  const git = (...args: string[]): void => {
    execFileSync("git", args, { cwd: root, stdio: "pipe" });
  };
  git("init", "-q", "-b", "main", ".");
  git("config", "user.email", "fixture@example.com");
  git("config", "user.name", "fixture");
  writeManifest(root, baseVersion);
  git("add", "package.json");
  git("commit", "-qm", "base");
  if (headVersion !== baseVersion) writeManifest(root, headVersion);
  return root;
};

describe("version bump gate decision", () => {
  it("rejects a branch whose version has not advanced past the base", () => {
    const root = fixture("0.0.1", "0.0.1");
    const result = checkVersionBump(root, { baseRef: "main", headRef: "issue-95/fixture" });
    expect(result.enforce).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("accepts a branch whose version is strictly greater than the base", () => {
    const root = fixture("0.0.1", "0.0.2");
    const result = checkVersionBump(root, { baseRef: "main", headRef: "issue-95/fixture" });
    expect(result.enforce).toBe(true);
    expect(result.ok).toBe(true);
  });

  it("exempts the base branch itself so main never requires an advance", () => {
    const root = fixture("0.0.1", "0.0.1");
    const result = checkVersionBump(root, { baseRef: "main", headRef: "main" });
    expect(result.enforce).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("rejects a head version that is not a dotted triple", () => {
    const root = fixture("0.0.1", "0.0.2-beta");
    const result = checkVersionBump(root, { baseRef: "main", headRef: "issue-95/fixture" });
    expect(result.enforce).toBe(true);
    expect(result.ok).toBe(false);
  });
});
