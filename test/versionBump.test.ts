import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
  it("rejects an equal feature version, accepts an advance, and exempts the base branch", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-version-bump-"));
    const git = (...args: string[]): void => {
      execFileSync("git", args, {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Fixture",
          GIT_AUTHOR_EMAIL: "fixture@example.com",
          GIT_COMMITTER_NAME: "Fixture",
          GIT_COMMITTER_EMAIL: "fixture@example.com"
        }
      });
    };
    const writePackage = (version: string): void => {
      writeFileSync(join(root, "package.json"), `${JSON.stringify({ version }, null, 2)}\n`);
    };

    try {
      git("init", "-q", "--initial-branch=main");
      writePackage("0.0.1");
      git("add", "package.json");
      git("commit", "-qm", "baseline");
      git("checkout", "-qb", "issue-fixture");

      expect(checkVersionBump(root, { baseRef: "main", headRef: "issue-fixture" })).toMatchObject({
        enforce: true,
        ok: false,
        headVersion: "0.0.1",
        baseVersion: "0.0.1"
      });

      writePackage("0.0.2");
      expect(checkVersionBump(root, { baseRef: "main", headRef: "issue-fixture" })).toMatchObject({
        enforce: true,
        ok: true,
        headVersion: "0.0.2",
        baseVersion: "0.0.1"
      });
      expect(checkVersionBump(root, { baseRef: "main", headRef: "main" })).toMatchObject({
        enforce: false,
        ok: true
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
