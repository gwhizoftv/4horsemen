import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseWorkspaceLocation,
  clearOwnerWorkspaceConfig,
  OWNER_WORKSPACE_CONFIG_KEY,
  readOwnerWorkspaceConfig,
  resolveInstalledWorkspace,
  writeOwnerWorkspaceConfig
} from "../src/workspace.js";
import { git } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const writeConfig = (configPath: string, project: string): void => {
  mkdirSync(join(configPath, ".."), { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify({
      project,
      origin: `https://github.com/example/${project}.git`,
      agents: [{ id: "codex", root: "/tmp/x", launcher: "start-codex.sh", delivery: "pull" }],
      branch: "issue-{issue}/{agent}",
      checks: [{ name: "t", argv: ["true"] }],
      digestPaths: []
    })
  );
};

describe("workspace location", () => {
  it("selects flat for a fresh unoccupied runtime", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ws-"));
    roots.push(root);
    const chosen = chooseWorkspaceLocation(root, "app");
    expect(chosen).toMatchObject({ layout: "flat", workspaceRoot: root, configPath: join(root, "config.json") });
  });

  it("resolves flat before nested when both match", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ws-"));
    roots.push(root);
    writeConfig(join(root, "config.json"), "app");
    writeConfig(join(root, "workspaces", "app", "config.json"), "app");
    const resolved = resolveInstalledWorkspace(root, "app");
    expect(resolved?.layout).toBe("flat");
    expect(resolved?.configPath).toBe(join(root, "config.json"));
  });

  it("falls back to nested when flat belongs to another project", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ws-"));
    roots.push(root);
    writeConfig(join(root, "config.json"), "other");
    writeConfig(join(root, "workspaces", "app", "config.json"), "app");
    expect(resolveInstalledWorkspace(root, "app")?.layout).toBe("nested");
    expect(chooseWorkspaceLocation(root, "second").layout).toBe("nested");
  });

  it("nests a second product without moving the first", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ws-"));
    roots.push(root);
    writeConfig(join(root, "config.json"), "first");
    const second = chooseWorkspaceLocation(root, "second");
    expect(second.layout).toBe("nested");
    expect(second.workspaceRoot).toBe(join(root, "workspaces", "second"));
  });

  it("reads and clears the owner locator", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ws-"));
    roots.push(root);
    const product = join(root, "product");
    mkdirSync(product);
    git(product, "init", "-q");
    const configPath = join(root, "runtime", "config.json");
    writeOwnerWorkspaceConfig(product, configPath);
    expect(readOwnerWorkspaceConfig(product)).toBe(configPath);
    expect(git(product, "config", "--local", "--get", OWNER_WORKSPACE_CONFIG_KEY)).toBe(configPath);
    clearOwnerWorkspaceConfig(product);
    expect(readOwnerWorkspaceConfig(product)).toBeNull();
  });

  it("refuses a symlink coord-root", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ws-"));
    roots.push(root);
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    expect(() => chooseWorkspaceLocation(link, "app")).toThrow(/symlink/);
  });
});
