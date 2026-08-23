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

describe("version bump gate decision", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com"
  };

  const git = (cwd: string, ...args: string[]): void => {
    execFileSync("git", args, { cwd, env: gitEnv, stdio: "ignore" });
  };

  const writeVersion = (cwd: string, version: string): void => {
    writeFileSync(join(cwd, "package.json"), `${JSON.stringify({ name: "fixture", version }, null, 2)}\n`);
  };

  /** Temp repo: main @ 0.0.1, then branch issue-fixture (working tree starts at 0.0.1). */
  const fixtureRepo = (): string => {
    const cwd = mkdtempSync(join(tmpdir(), "coord-version-bump-"));
    roots.push(cwd);
    git(cwd, "init", "-q", "-b", "main");
    writeVersion(cwd, "0.0.1");
    git(cwd, "add", "package.json");
    git(cwd, "commit", "-qm", "base");
    git(cwd, "checkout", "-qb", "issue-fixture");
    return cwd;
  };

  it("rejects a non-advancing branch version", () => {
    const cwd = fixtureRepo();
    const result = checkVersionBump(cwd, { baseRef: "main", headRef: "issue-fixture" });
    expect(result.enforce).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.headVersion).toBe("0.0.1");
    expect(result.baseVersion).toBe("0.0.1");
  });

  it("accepts a strictly greater branch version", () => {
    const cwd = fixtureRepo();
    writeVersion(cwd, "0.0.2");
    const result = checkVersionBump(cwd, { baseRef: "main", headRef: "issue-fixture" });
    expect(result.enforce).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.headVersion).toBe("0.0.2");
    expect(result.baseVersion).toBe("0.0.1");
  });

  it("does not enforce on the base branch", () => {
    const cwd = fixtureRepo();
    const result = checkVersionBump(cwd, { baseRef: "main", headRef: "main" });
    expect(result.enforce).toBe(false);
    expect(result.ok).toBe(true);
  });
});
