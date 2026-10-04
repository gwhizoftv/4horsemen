import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, localConfigGet, worktreeRoot } from "../src/gitExec.js";
import {
  OWNER_WORKSPACE_CONFIG_KEY,
  nestedConfigPath,
  recordOwnerWorkspace,
  resolveWorkspaceFromProduct,
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

    const nested = join(product.productRoot, "nested");
    mkdirSync(nested);
    expect(resolveWorkspaceFromProduct(nested)).toMatchObject({ configPath, layout: "flat" });

    const link = join(product.workspaceRoot, "product-link");
    symlinkSync(product.productRoot, link);
    expect(resolveWorkspaceFromProduct(link)).toMatchObject({ configPath, layout: "flat" });
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

  it("names missing and non-directory git working directories without spawnSync wrappers", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-git-cwd-"));
    roots.push(root);
    const missing = join(root, "missing-product");
    const filePath = join(root, "not-a-dir");
    writeFileSync(filePath, "regular file\n");
    const dangling = join(root, "dangling-link");
    symlinkSync(join(root, "no-such-target"), dangling);

    for (const path of [missing, dangling]) {
      expect(() => git(path, "rev-parse", "--show-toplevel")).toThrow(/does not exist/);
      expect(() => git(path, "rev-parse", "--show-toplevel")).not.toThrow(/spawnSync/);
      expect(() => worktreeRoot(path)).toThrow(/does not exist/);
      expect(() => resolveWorkspaceFromProduct(path)).toThrow(/does not exist/);
    }

    expect(() => git(filePath, "rev-parse", "--show-toplevel")).toThrow(/is not a directory/);
    expect(() => git(filePath, "rev-parse", "--show-toplevel")).not.toThrow(/spawnSync/);
    expect(() => resolveWorkspaceFromProduct(filePath)).toThrow(/is not a directory/);
  });

  it("reports a missing git executable separately from a missing working directory", () => {
    const product = makeProduct("plain");
    products.push(product);
    const emptyPath = mkdtempSync(join(tmpdir(), "coord-empty-path-"));
    roots.push(emptyPath);
    // Build fixtures before scrubbing PATH; hermeticGitEnv copies process.env.
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = emptyPath;
      expect(() => git(product.productRoot, "rev-parse", "--show-toplevel")).toThrow(
        /git executable not found on PATH/
      );
      expect(() => git(product.productRoot, "rev-parse", "--show-toplevel")).not.toThrow(/does not exist/);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
