import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { issueRuntimePaths } from "../src/paths.js";
import {
  flatWorkspace,
  nestedWorkspace,
  resolveInstalledWorkspace,
  selectWorkspaceForInstall,
  workspaceFromConfigPath
} from "../src/workspace.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runtime = (): string => {
  const root = mkdtempSync(join(tmpdir(), "coord-workspace-"));
  roots.push(root);
  return root;
};

const writeConfig = (path: string, project: string): void => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ project }, null, 2)}\n`);
};

describe("workspace layout", () => {
  it("puts a fresh single product flat, with no workspaces/ indirection", () => {
    const coordRoot = runtime();
    const location = selectWorkspaceForInstall(coordRoot, "app");
    expect(location.layout).toBe("flat");
    expect(location.configPath).toBe(join(coordRoot, "config.json"));
    expect(location.workspaceRoot).toBe(coordRoot);
  });

  it("resolves an existing nested install without relocating it", () => {
    const coordRoot = runtime();
    writeConfig(nestedWorkspace(coordRoot, "app").configPath, "app");
    expect(resolveInstalledWorkspace(coordRoot, "app")?.layout).toBe("nested");
    // A reinstall repairs wiring; moving the runtime out from under in-flight
    // issue state would be a far larger effect than the operator asked for.
    expect(selectWorkspaceForInstall(coordRoot, "app").layout).toBe("nested");
  });

  it("nests a second product rather than overwriting the first product's flat config", () => {
    const coordRoot = runtime();
    writeConfig(flatWorkspace(coordRoot).configPath, "app-one");
    const second = selectWorkspaceForInstall(coordRoot, "app-two");
    expect(second.layout).toBe("nested");
    expect(second.configPath).toBe(join(coordRoot, "workspaces", "app-two", "config.json"));
    // The first product is untouched and still resolves.
    expect(resolveInstalledWorkspace(coordRoot, "app-one")?.configPath).toBe(flatWorkspace(coordRoot).configPath);
  });

  it("keeps nesting once a runtime nests, so layout does not depend on install order", () => {
    const coordRoot = runtime();
    writeConfig(nestedWorkspace(coordRoot, "app-one").configPath, "app-one");
    expect(selectWorkspaceForInstall(coordRoot, "app-two").layout).toBe("nested");
  });

  it("gives two products on one runtime separate issue state and separate mirrors", () => {
    const coordRoot = runtime();
    writeConfig(flatWorkspace(coordRoot).configPath, "app-one");
    const one = resolveInstalledWorkspace(coordRoot, "app-one");
    const two = selectWorkspaceForInstall(coordRoot, "app-two");
    // GitHub issue numbers are repository-local. Both products can legitimately
    // have an issue 42, and they must not share cursors, journal, or mirror.
    const pathsOne = issueRuntimePaths((one as { workspaceRoot: string }).workspaceRoot, 42);
    const pathsTwo = issueRuntimePaths(two.workspaceRoot, 42);
    expect(pathsOne.issueRoot).not.toBe(pathsTwo.issueRoot);
    expect(pathsOne.mirror).not.toBe(pathsTwo.mirror);
    expect(pathsOne.start).not.toBe(pathsTwo.start);
  });

  it("prefers a flat config for its own project over a nested one", () => {
    const coordRoot = runtime();
    writeConfig(flatWorkspace(coordRoot).configPath, "app");
    writeConfig(nestedWorkspace(coordRoot, "app").configPath, "app");
    expect(resolveInstalledWorkspace(coordRoot, "app")?.layout).toBe("flat");
  });

  it("does not adopt another product's flat config", () => {
    const coordRoot = runtime();
    writeConfig(flatWorkspace(coordRoot).configPath, "other");
    expect(resolveInstalledWorkspace(coordRoot, "app")).toBeNull();
  });

  it("locates an unparseable flat config only for callers that ask to diagnose it", () => {
    const coordRoot = runtime();
    writeFileSync(flatWorkspace(coordRoot).configPath, "{ not json");
    expect(resolveInstalledWorkspace(coordRoot, "app")).toBeNull();
    expect(resolveInstalledWorkspace(coordRoot, "app", { acceptUnreadableFlat: true })?.layout).toBe("flat");
  });

  it("refuses a project id that would escape the runtime", () => {
    const coordRoot = runtime();
    expect(() => nestedWorkspace(coordRoot, "../../escape")).toThrow(/outside coordinator root/);
  });

  describe("explicit --config", () => {
    it("treats a config inside the runtime as describing its own workspace root", () => {
      const coordRoot = runtime();
      const flat = workspaceFromConfigPath(join(coordRoot, "config.json"), coordRoot);
      expect(flat).toMatchObject({ layout: "flat", workspaceRoot: coordRoot });
      const nested = workspaceFromConfigPath(join(coordRoot, "workspaces", "app", "config.json"), coordRoot);
      expect(nested).toMatchObject({ layout: "nested", workspaceRoot: join(coordRoot, "workspaces", "app") });
    });

    it("puts run state under --coord-root when the config is kept elsewhere", () => {
      // The long-supported advanced form: a hand-maintained config outside the
      // runtime. --coord-root has always named where run state goes.
      const coordRoot = runtime();
      const elsewhere = runtime();
      const location = workspaceFromConfigPath(join(elsewhere, "config.json"), coordRoot);
      expect(location.workspaceRoot).toBe(coordRoot);
      expect(location.coordRoot).toBe(coordRoot);
    });

    it("infers the layout from the path when no --coord-root is given", () => {
      const coordRoot = runtime();
      expect(workspaceFromConfigPath(join(coordRoot, "workspaces", "app", "config.json"))).toMatchObject({
        layout: "nested",
        coordRoot
      });
      expect(workspaceFromConfigPath(join(coordRoot, "config.json"))).toMatchObject({ layout: "flat", coordRoot });
    });
  });
});
