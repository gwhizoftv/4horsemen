import childProcess from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { git, localConfigGet, worktreeRoot } from "../src/gitExec.js";
import {
  OWNER_WORKSPACE_CONFIG_KEY,
  nestedConfigPath,
  recordOwnerWorkspace,
  resolveWorkspaceFromProduct,
  resolveWorkspaceFromWorktree,
  resolveWorkspaceLocation,
  selectWorkspaceLocation,
  listIssueNumbersInWorkspace
} from "../src/workspace.js";
import { makeProduct, type ProductFixture } from "./support/workspaceFixture.js";

const roots: string[] = [];
const products: ProductFixture[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const product of products.splice(0)) product.cleanup();
});

const config = (project: string, productRoot?: string) => ({
  project,
  origin: `https://github.com/example/${project}.git`,
  agents: [{ id: "claude", root: `/tmp/${project}-claude`, launcher: "start-claude.sh" }],
  branch: "issue-{issue}/{agent}",
  checks: [{ name: "ok", argv: ["true"] }],
  ...(productRoot === undefined
    ? {}
    : {
        coordination: {
          installRoot: "/tmp/coordination",
          cliEntry: "/tmp/coordination/dist/main.js",
          version: "0.1.0",
          commit: "a".repeat(40),
          canonicalDigest: "b".repeat(64),
          installedAt: "2026-08-11T17:40:00.000Z",
          productRoot,
          cloneRoot: "/tmp",
          vendored: false,
          bootstrapped: false,
          ownsInstallRoot: false,
          wroteProductIgnore: false,
          wroteAgentsMd: false
        }
      })
});

const writeConfig = (path: string, project: string, productRoot?: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(config(project, productRoot), null, 2)}\n`);
};

describe("workspace layout", () => {
  it("diagnoses missing and non-directory working paths without a spawn error", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-path-"));
    roots.push(root);
    const missing = join(root, "missing");
    const deleted = join(root, "deleted");
    mkdirSync(deleted);
    rmSync(deleted, { recursive: true });
    const file = join(root, "file");
    writeFileSync(file, "not a directory\n");
    const dangling = join(root, "dangling");
    symlinkSync(missing, dangling, "dir");

    for (const [path, reason] of [
      [missing, "working directory does not exist"],
      [deleted, "working directory does not exist"],
      [dangling, "working directory does not exist"],
      [file, "working directory is not a directory"],
      [join(file, "child"), "working directory is not a directory"]
    ] as const) {
      expect(() => resolveWorkspaceFromProduct(path)).toThrow(`${path}: ${reason}`);
      expect(() => resolveWorkspaceFromProduct(path)).not.toThrow(/spawnSync/);
    }
    // An existing directory remains an ordinary Git discovery failure.
    expect(worktreeRoot(root)).toBeNull();
    expect(() => resolveWorkspaceFromProduct(root)).toThrow("is not inside a Git repository");
  });

  it("distinguishes a missing Git executable from a missing working directory", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-path-"));
    roots.push(root);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = root;
      expect(() => worktreeRoot(root)).toThrow(
        `Cannot run git rev-parse --show-toplevel in ${root}: could not find or launch git; check PATH; detail: spawnSync git ENOENT`
      );
      expect(() => worktreeRoot(root)).not.toThrow("working directory does not exist");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "identifies inaccessible working directories without calling them missing",
    () => {
      const root = mkdtempSync(join(tmpdir(), "coord-path-"));
      roots.push(root);
      const child = join(root, "child");
      mkdirSync(child);
      try {
        chmodSync(root, 0o000);
        expect(() => worktreeRoot(child)).toThrow("working directory is inaccessible");
        expect(() => worktreeRoot(child)).toThrow("EACCES");
      } finally {
        chmodSync(root, 0o700);
      }
    }
  );

  it("rechecks a disappeared working directory and preserves other launch errors", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-path-"));
    roots.push(root);
    const spawn = vi.spyOn(childProcess, "spawnSync");
    syncBuiltinESMExports();
    const failed = (code: string) => ({
      pid: 0, output: [], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, signal: null,
      error: Object.assign(new Error(`spawnSync git ${code}`), { code })
    });
    try {
      spawn.mockImplementationOnce(() => {
        rmSync(root, { recursive: true });
        return failed("ENOENT");
      });
      expect(() => git(root, "rev-parse", "--show-toplevel")).toThrow(
        `Cannot run git rev-parse --show-toplevel in ${root}: working directory does not exist; detail: spawnSync git ENOENT`
      );
      expect(spawn).toHaveBeenCalledTimes(1);
      mkdirSync(root);
      spawn.mockImplementationOnce(() => failed("EACCES"));
      expect(() => git(root, "rev-parse", "--show-toplevel")).toThrow(
        `Cannot run git rev-parse --show-toplevel in ${root}: spawnSync git EACCES`
      );
    } finally {
      spawn.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it("uses flat for a fresh product and preserves it when a second product is added", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-layout-"));
    roots.push(root);
    const first = selectWorkspaceLocation(root, "alpha");
    expect(first).toMatchObject({ layout: "flat", configPath: join(root, "config.json") });
    writeConfig(first.configPath, "alpha");

    const second = selectWorkspaceLocation(root, "beta");
    expect(second).toMatchObject({ layout: "nested", configPath: nestedConfigPath(root, "beta") });
    expect(resolveWorkspaceLocation(root, "alpha")?.configPath).toBe(first.configPath);
  });

  it("resolves flat before nested for the same project and reuses old nested installs", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-layout-"));
    roots.push(root);
    const nested = nestedConfigPath(root, "alpha");
    writeConfig(nested, "alpha");
    expect(resolveWorkspaceLocation(root, "alpha")?.configPath).toBe(nested);
    expect(selectWorkspaceLocation(root, "alpha").configPath).toBe(nested);

    const flat = join(root, "config.json");
    writeConfig(flat, "alpha");
    expect(resolveWorkspaceLocation(root, "alpha")?.configPath).toBe(flat);
  });

  it("treats a malformed flat config as occupied rather than overwriting it", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-layout-"));
    roots.push(root);
    writeFileSync(join(root, "config.json"), "{broken");
    expect(selectWorkspaceLocation(root, "beta")).toMatchObject({
      layout: "nested",
      configPath: nestedConfigPath(root, "beta")
    });
    expect(resolveWorkspaceLocation(root, "beta")).toBeNull();
    expect(resolveWorkspaceLocation(root, "beta", { acceptUnreadableFlat: true })?.configPath).toBe(
      join(root, "config.json")
    );
  });

  it("nests when flat runtime state remains after its config is removed", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-layout-"));
    roots.push(root);
    mkdirSync(join(root, "issue-1"));
    mkdirSync(join(root, "mirror.git"));
    expect(selectWorkspaceLocation(root, "beta")).toMatchObject({
      layout: "nested",
      configPath: nestedConfigPath(root, "beta")
    });
    expect(listIssueNumbersInWorkspace(root)).toEqual([1]);
  });

  it("uses a safe owner-only locator rather than an agent-wiring key", () => {
    const product = makeProduct("plain");
    products.push(product);
    const configPath = join(product.coordRoot, "config.json");
    writeConfig(configPath, "myserver", product.productRoot);
    recordOwnerWorkspace(product.productRoot, configPath);

    expect(localConfigGet(product.productRoot, OWNER_WORKSPACE_CONFIG_KEY)).toBe(configPath);
    for (const key of ["coord.installRoot", "coord.cliEntry", "coord.workspaceConfig"]) {
      expect(localConfigGet(product.productRoot, key)).toBeNull();
    }
    expect(resolveWorkspaceFromProduct(product.productRoot)).toMatchObject({ configPath, layout: "flat" });
    const subdirectory = join(product.productRoot, "subdirectory");
    const alias = join(product.workspaceRoot, "product-alias");
    mkdirSync(subdirectory);
    symlinkSync(product.productRoot, alias, "dir");
    for (const path of [subdirectory, alias]) {
      expect(resolveWorkspaceFromProduct(path)).toMatchObject({ configPath, layout: "flat" });
    }
  });

  it("resolves the current worktree as the owner repository or a registered agent clone only", () => {
    const product = makeProduct("plain");
    products.push(product);
    const configPath = join(product.coordRoot, "config.json");
    const clone = join(product.workspaceRoot, "clone-claude");
    mkdirSync(clone);
    git(clone, "init", "-q");
    writeFileSync(configPath, `${JSON.stringify({ ...config("myserver", product.productRoot),
      agents: [{ id: "claude", root: clone, launcher: "start-claude.sh" }] }, null, 2)}\n`);
    recordOwnerWorkspace(product.productRoot, configPath);
    const key = "coord.workspaceConfig";
    const subdirectory = join(product.productRoot, "nested");
    mkdirSync(subdirectory);
    expect(resolveWorkspaceFromWorktree(subdirectory, key)).toMatchObject({ configPath });

    git(clone, "config", "--local", key, configPath);
    git(clone, "config", "--local", "consensus.agentId", "claude");
    expect(resolveWorkspaceFromWorktree(clone, key)).toMatchObject({ configPath });
    // A crossed identity, a stale locator or a conflicting owner locator is refused, never guessed.
    git(clone, "config", "--local", "consensus.agentId", "codex");
    expect(() => resolveWorkspaceFromWorktree(clone, key)).toThrow("is not the registered clone for agent 'codex'");
    git(clone, "config", "--local", "consensus.agentId", "claude");
    const other = join(product.coordRoot, "other.json");
    writeConfig(other, "other", product.productRoot);
    git(clone, "config", "--local", OWNER_WORKSPACE_CONFIG_KEY, other);
    expect(() => resolveWorkspaceFromWorktree(clone, key)).toThrow("both an owner and an agent workspace locator");
    git(clone, "config", "--local", "--unset", OWNER_WORKSPACE_CONFIG_KEY);
    git(clone, "config", "--local", key, join(product.coordRoot, "missing.json"));
    expect(() => resolveWorkspaceFromWorktree(clone, key)).toThrow("points at missing workspace config");
    const outside = mkdtempSync(join(tmpdir(), "coord-not-a-repo-"));
    roots.push(outside);
    expect(() => resolveWorkspaceFromWorktree(outside, key)).toThrow("is not inside a Git repository");
  });

  it("keeps same-named products registered in their own canonical worktrees", () => {
    const first = makeProduct("plain", "api");
    const second = makeProduct("plain", "api");
    products.push(first, second);
    const firstConfig = join(first.coordRoot, "config.json");
    const secondConfig = join(second.coordRoot, "config.json");
    writeConfig(firstConfig, "api", first.productRoot);
    writeConfig(secondConfig, "api", second.productRoot);
    recordOwnerWorkspace(first.productRoot, firstConfig);
    recordOwnerWorkspace(second.productRoot, secondConfig);

    expect(resolveWorkspaceFromProduct(first.productRoot).configPath).toBe(firstConfig);
    expect(resolveWorkspaceFromProduct(second.productRoot).configPath).toBe(secondConfig);
  });
});
