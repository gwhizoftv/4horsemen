import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PathSafetyError,
  agentRuntimePaths,
  createIssueRuntime,
  defaultCompletesRoot,
  issueRuntimePaths,
  resolveSafeCompletesRoot
} from "../src/paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-paths-"));
  roots.push(root);
  const coordRoot = join(root, "coord-runtime");
  const completesRoot = join(root, "completes");
  const clone = join(root, "app-codex");
  mkdirSync(coordRoot);
  mkdirSync(clone);
  return { root, coordRoot, completesRoot, clone };
};

describe("completion mailbox paths", () => {
  it("keeps actions in coordinator state and puts completion under issue then agent", () => {
    const { coordRoot, completesRoot } = fixture();
    const paths = issueRuntimePaths(coordRoot, 98, completesRoot);
    const runtime = agentRuntimePaths(paths, "codex");

    expect(runtime.action).toBe(join(coordRoot, "issue-98", "agents", "codex", "action.md"));
    expect(runtime.renderLog).toBe(join(coordRoot, "issue-98", "agents", "codex", "render.log"));
    expect(runtime.completeDir).toBe(join(completesRoot, "issue-98", "codex"));
    expect(runtime.complete).toBe(join(completesRoot, "issue-98", "codex", "complete"));
  });

  it("derives the flat default as a sibling named completes", () => {
    const { coordRoot } = fixture();
    expect(defaultCompletesRoot(coordRoot)).toBe(join(dirname(coordRoot), "completes"));
    expect(issueRuntimePaths(coordRoot, 2).completesRoot).toBe(join(dirname(coordRoot), "completes"));
  });

  it("creates owner-only per-issue and per-agent drop directories", () => {
    const { coordRoot, completesRoot } = fixture();
    const paths = issueRuntimePaths(coordRoot, 7, completesRoot);
    createIssueRuntime(paths, ["claude", "codex"]);

    expect(lstatSync(join(completesRoot, "issue-7", "claude")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(completesRoot, "issue-7", "codex")).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(coordRoot, "issue-7", "agents", "codex")).mode & 0o777).toBe(0o700);
  });

  it("rejects overlap with coordinator state or an agent clone", () => {
    const { coordRoot, clone } = fixture();
    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: join(coordRoot, "completes"), protectedRoots: [coordRoot, clone] })
    ).toThrow(PathSafetyError);
    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: dirname(coordRoot), protectedRoots: [coordRoot, clone] })
    ).toThrow(PathSafetyError);
    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: join(clone, "drop"), protectedRoots: [coordRoot, clone] })
    ).toThrow(PathSafetyError);
  });

  it("rejects symlinked mailbox roots and agent escapes", () => {
    const { root, coordRoot, clone } = fixture();
    const target = join(root, "real-completes");
    const linked = join(root, "linked-completes");
    mkdirSync(target);
    symlinkSync(target, linked);

    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: linked, protectedRoots: [coordRoot, clone] })
    ).toThrow(PathSafetyError);
    const paths = issueRuntimePaths(coordRoot, 1, target);
    expect(() => agentRuntimePaths(paths, "../peer")).toThrow(PathSafetyError);
  });

  it("requires an absolute root and rejects a symlink in any parent component", () => {
    const { root, coordRoot, clone } = fixture();
    expect(() =>
      resolveSafeCompletesRoot({ completesRoot: "relative/completes", protectedRoots: [coordRoot, clone] })
    ).toThrow(/must be absolute/);

    const realParent = join(root, "real-parent");
    const linkedParent = join(root, "linked-parent");
    mkdirSync(realParent);
    symlinkSync(realParent, linkedParent);
    expect(() =>
      resolveSafeCompletesRoot({
        completesRoot: join(linkedParent, "completes"),
        protectedRoots: [coordRoot, clone]
      })
    ).toThrow(PathSafetyError);
  });
});
