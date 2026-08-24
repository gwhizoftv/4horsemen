import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentRuntimePaths,
  createIssueRuntime,
  defaultCompletesRoot,
  issueRuntimePaths,
  PathSafetyError,
  removeIssueMailbox,
  resolveSafeCompletesRoot
} from "../src/paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * Every root is nested inside one temp directory the test owns. A fixture that
 * mkdtemps the coord root directly in `tmpdir()` would derive a mailbox beside
 * every other test file's, and parallel workers would then read and clear each
 * other's receipts.
 */
const workspace = (): { root: string; coordRoot: string; completesRoot: string } => {
  const root = mkdtempSync(join(tmpdir(), "coord-paths-"));
  roots.push(root);
  const coordRoot = join(root, "coord-runtime");
  mkdirSync(coordRoot, { recursive: true });
  return { root, coordRoot, completesRoot: join(root, "completes") };
};

describe("completion mailbox paths", () => {
  it("puts the receipt in the mailbox and leaves the order under the coord root", () => {
    const { coordRoot, completesRoot } = workspace();
    const paths = issueRuntimePaths(coordRoot, 98, completesRoot);
    const runtime = agentRuntimePaths(paths, "claude");

    expect(runtime.complete).toBe(join(completesRoot, "issue-98", "claude", "complete"));
    expect(runtime.completeDir).toBe(join(completesRoot, "issue-98", "claude"));
    expect(runtime.action).toBe(join(coordRoot, "issue-98", "agents", "claude", "action.md"));
    expect(runtime.renderLog).toBe(join(coordRoot, "issue-98", "agents", "claude", "render.log"));
  });

  it("gives each agent its own drop so a peer cannot overwrite a receipt", () => {
    const { coordRoot, completesRoot } = workspace();
    const paths = issueRuntimePaths(coordRoot, 98, completesRoot);
    expect(agentRuntimePaths(paths, "claude").complete).not.toBe(agentRuntimePaths(paths, "codex").complete);
  });

  it("gives each issue its own drop so a later issue cannot replay an earlier receipt", () => {
    const { coordRoot, completesRoot } = workspace();
    const first = agentRuntimePaths(issueRuntimePaths(coordRoot, 98, completesRoot), "claude").complete;
    const second = agentRuntimePaths(issueRuntimePaths(coordRoot, 99, completesRoot), "claude").complete;
    expect(first).not.toBe(second);
  });

  it("derives a sibling named for the workspace, never a bare shared completes/", () => {
    const { root, coordRoot } = workspace();
    expect(defaultCompletesRoot(coordRoot)).toBe(join(root, "completes", "coord-runtime"));
    expect(defaultCompletesRoot(coordRoot, "beta")).toBe(join(root, "completes", "coord-runtime", "beta"));
    // Two products under one outer root must not share the tree: without the
    // project segment both would resolve issue-42/claude/complete to one file.
    expect(defaultCompletesRoot(coordRoot, "alpha")).not.toBe(defaultCompletesRoot(coordRoot, "beta"));
    // And the project alone is not enough: two outer roots beside each other can
    // each hold a product called `beta`.
    const other = workspace();
    expect(defaultCompletesRoot(other.coordRoot, "beta")).not.toBe(defaultCompletesRoot(coordRoot, "beta"));
  });

  it("refuses a mailbox inside the coordinator runtime", () => {
    const { coordRoot } = workspace();
    expect(() => issueRuntimePaths(coordRoot, 98, join(coordRoot, "completes"))).toThrow(PathSafetyError);
    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: join(coordRoot, "completes"), coordRoot })
    ).toThrow(/overlaps the coordinator runtime/);
  });

  it("refuses a coordinator runtime inside the mailbox", () => {
    const { root, coordRoot } = workspace();
    expect(() => resolveSafeCompletesRoot({ completesRoot: root, coordRoot })).toThrow(PathSafetyError);
  });

  it("refuses a mailbox inside a configured agent clone", () => {
    const { root, coordRoot } = workspace();
    const clone = join(root, "clone");
    mkdirSync(clone, { recursive: true });
    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: join(clone, "completes"), coordRoot, agentRoots: [clone] })
    ).toThrow(/overlaps configured agent clone/);
  });

  it("refuses a symlinked mailbox root", () => {
    const { root, coordRoot } = workspace();
    const real = join(root, "elsewhere");
    mkdirSync(real, { recursive: true });
    const link = join(root, "completes-link");
    symlinkSync(real, link);
    expect(() => resolveSafeCompletesRoot({ completesRoot: link, coordRoot })).toThrow(PathSafetyError);
  });

  it("refuses a symlinked agent drop directory", () => {
    const { root, coordRoot, completesRoot } = workspace();
    const paths = issueRuntimePaths(coordRoot, 98, completesRoot);
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere, { recursive: true });
    mkdirSync(paths.completesIssueRoot, { recursive: true });
    symlinkSync(elsewhere, join(paths.completesIssueRoot, "claude"));
    // Without this the coordinator would read a receipt written outside the
    // mailbox as that agent's intent.
    expect(() => createIssueRuntime(paths, ["claude"])).toThrow(PathSafetyError);
  });

  it("rejects an agent id that would escape the mailbox", () => {
    const { coordRoot, completesRoot } = workspace();
    const paths = issueRuntimePaths(coordRoot, 98, completesRoot);
    expect(() => agentRuntimePaths(paths, "../peer")).toThrow(PathSafetyError);
  });

  it("creates both trees owner-only and nothing else under the mailbox", () => {
    const { coordRoot, completesRoot } = workspace();
    const paths = issueRuntimePaths(coordRoot, 98, completesRoot);
    createIssueRuntime(paths, ["claude", "codex"]);

    for (const agent of ["claude", "codex"]) {
      const runtime = agentRuntimePaths(paths, agent);
      expect(existsSync(runtime.completeDir)).toBe(true);
      expect(existsSync(runtime.root)).toBe(true);
      expect(statSync(runtime.completeDir).mode & 0o777).toBe(0o700);
    }
    expect(existsSync(join(completesRoot, "issue-98"))).toBe(true);
    expect(existsSync(join(completesRoot, "issue-99"))).toBe(false);
  });

  it("removes only this issue's mailbox, so a rerun cannot read a stale receipt", () => {
    const { coordRoot, completesRoot } = workspace();
    const wiped = issueRuntimePaths(coordRoot, 98, completesRoot);
    const kept = issueRuntimePaths(coordRoot, 99, completesRoot);
    createIssueRuntime(wiped, ["claude"]);
    createIssueRuntime(kept, ["claude"]);
    writeFileSync(agentRuntimePaths(wiped, "claude").complete, `${"a".repeat(40)}\n`);

    expect(removeIssueMailbox(wiped)).toBe(true);
    expect(existsSync(wiped.completesIssueRoot)).toBe(false);
    expect(existsSync(kept.completesIssueRoot)).toBe(true);
    // Idempotent: wipe runs after a failed start that may not have created it.
    expect(removeIssueMailbox(wiped)).toBe(false);
  });

  it("keeps the mailbox root outside the coord root for the derived default", () => {
    const { coordRoot } = workspace();
    const paths = issueRuntimePaths(coordRoot, 98);
    expect(resolve(paths.completesRoot).startsWith(resolve(coordRoot))).toBe(false);
    expect(paths.issue).toBe(98);
  });
});
