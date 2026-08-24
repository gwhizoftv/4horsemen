import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentRuntimePaths,
  createIssueRuntime,
  defaultCompletesRoot,
  issueCompletesDir,
  issueRuntimePaths,
  PathSafetyError,
  resolveSafeCompletesRoot
} from "../src/paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("completesRoot resolution", () => {
  it("defaults to a sibling named completes", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    mkdirSync(coordRoot);
    expect(defaultCompletesRoot(coordRoot)).toBe(join(workspace, "completes"));
  });

  it("rejects a completesRoot inside coordRoot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    mkdirSync(coordRoot);
    expect(() =>
      resolveSafeCompletesRoot({ coordRoot, completesRoot: join(coordRoot, "inside") })
    ).toThrow(PathSafetyError);
  });

  it("rejects a coordRoot inside completesRoot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const completesRoot = join(workspace, "completes");
    mkdirSync(completesRoot);
    const coordRoot = join(completesRoot, "nested");
    mkdirSync(coordRoot);
    expect(() => resolveSafeCompletesRoot({ coordRoot, completesRoot })).toThrow(PathSafetyError);
  });

  it("rejects a completesRoot overlapping an agent clone", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    const clone = join(workspace, "clone");
    mkdirSync(coordRoot);
    mkdirSync(clone);
    expect(() =>
      resolveSafeCompletesRoot({ coordRoot, completesRoot: clone, agentRoots: [clone] })
    ).toThrow(PathSafetyError);
  });

  it("rejects a symlinked completesRoot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    const real = join(workspace, "real-completes");
    const link = join(workspace, "completes");
    mkdirSync(coordRoot);
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() => resolveSafeCompletesRoot({ coordRoot, completesRoot: link })).toThrow(PathSafetyError);
  });
});

describe("agentRuntimePaths mailbox", () => {
  it("places complete under completesRoot, not coordRoot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    const completesRoot = join(workspace, "completes");
    mkdirSync(coordRoot);
    mkdirSync(completesRoot);
    const paths = issueRuntimePaths(coordRoot, 5, completesRoot);
    const runtime = agentRuntimePaths(paths, "codex");
    expect(runtime.complete).toBe(join(completesRoot, "issue-5", "codex", "complete"));
    expect(runtime.action).toContain(coordRoot);
    expect(runtime.renderLog).toContain(coordRoot);
    expect(runtime.complete).not.toContain(coordRoot);
  });

  it("still rejects an invalid agent id", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    mkdirSync(coordRoot);
    const paths = issueRuntimePaths(coordRoot, 1);
    expect(() => agentRuntimePaths(paths, "../peer")).toThrow(PathSafetyError);
  });
});

describe("createIssueRuntime", () => {
  it("creates per-agent completes directories", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    const completesRoot = join(workspace, "completes");
    mkdirSync(coordRoot);
    const paths = issueRuntimePaths(coordRoot, 3, completesRoot);
    createIssueRuntime(paths, ["claude", "codex"]);
    const claudeComplete = agentRuntimePaths(paths, "claude").complete;
    const codexComplete = agentRuntimePaths(paths, "codex").complete;
    expect(dirname(claudeComplete)).toBe(join(completesRoot, "issue-3", "claude"));
    expect(dirname(codexComplete)).toBe(join(completesRoot, "issue-3", "codex"));
    // The directories exist (mkdir was called)
    expect(() => mkdirSync(dirname(claudeComplete))).toThrow(); // already exists
  });

  it("keeps issueCompletesDir under completesRoot", () => {
    const workspace = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(workspace);
    const coordRoot = join(workspace, "coord-runtime");
    const completesRoot = join(workspace, "completes");
    mkdirSync(coordRoot);
    const paths = issueRuntimePaths(coordRoot, 7, completesRoot);
    expect(issueCompletesDir(paths)).toBe(join(completesRoot, "issue-7"));
  });
});
