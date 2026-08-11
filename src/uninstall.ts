import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { uninstallHooks } from "./hookSync.js";
import { isPathInside } from "./paths.js";
import { removeCloneExclude, removeProductIgnore } from "./productIgnore.js";
import { isManagedLauncher, workspaceConfigPath } from "./setupWorkspace.js";
import { readConfig } from "./state.js";

export type UninstallOptions = {
  product: string;
  coordRoot: string;
  configPath?: string;
  deleteClones?: boolean;
  force?: boolean;
  wipeRuntime?: boolean;
  deleteCoordination?: boolean;
  dryRun?: boolean;
  log?: (message: string) => void;
};

export type UninstallResult = { changed: boolean; actions: string[] };

const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const unsetIfOwned = (root: string, key: string, expected?: string): boolean => {
  let current = "";
  try { current = git(root, ["config", "--local", "--get", key]); } catch { return false; }
  if (expected !== undefined && current !== expected) return false;
  execFileSync("git", ["-C", root, "config", "--local", "--unset-all", key], { stdio: "ignore" });
  return true;
};

export const uninstallWorkspace = (options: UninstallOptions): UninstallResult => {
  const productRoot = realpathSync(git(resolve(options.product), ["rev-parse", "--show-toplevel"]));
  const coordRoot = resolve(options.coordRoot);
  const configPath = resolve(options.configPath ?? workspaceConfigPath(coordRoot, productRoot));
  if (!existsSync(configPath)) throw new Error(`Workspace config does not exist: ${configPath}.`);
  const config = readConfig(configPath);
  if (config.productRoot !== undefined && realpathSync(config.productRoot) !== productRoot) {
    throw new Error(`Workspace config belongs to ${config.productRoot}, not ${productRoot}.`);
  }
  const actions: string[] = [];
  const emit = (message: string): void => {
    actions.push(message);
    options.log?.(`${options.dryRun === true ? "DRY-RUN: " : ""}${message}\n`);
  };
  const roots = config.agents.map((agent) => isAbsolute(agent.root) ? agent.root : resolve(dirname(configPath), agent.root));

  if (options.deleteClones === true && options.force !== true) {
    for (const root of roots) {
      if (!existsSync(root)) continue;
      const status = git(root, ["status", "--porcelain", "--untracked-files=all"]);
      if (status !== "") throw new Error(`Refusing to delete dirty clone ${root}; commit/stash work or pass --force.`);
    }
  }
  if (options.deleteCoordination === true && config.coordination?.bootstrapOwned !== true) {
    throw new Error("Refusing --delete-coordination: this install did not record bootstrap ownership.");
  }

  let changed = false;
  for (const [index, agent] of config.agents.entries()) {
    const root = roots[index] as string;
    if (!existsSync(root)) continue;
    emit(`remove coordination wiring from ${root}`);
    if (options.dryRun === true) continue;
    const gitDir = git(root, ["rev-parse", "--absolute-git-dir"]);
    changed = uninstallHooks(gitDir) || changed;
    changed = removeCloneExclude(join(gitDir, "info", "exclude"), agent.id) || changed;
    const launcher = join(root, `start-${agent.id}.sh`);
    if (isManagedLauncher(launcher)) {
      unlinkSync(launcher);
      changed = true;
    }
    const ownsIdentity = (() => {
      try { return git(root, ["config", "--local", "--get", "consensus.agentId"]) === agent.id; } catch { return false; }
    })();
    for (const [key, expected] of [
      ["coord.installRoot", config.coordination?.installRoot],
      ["coord.workspaceConfig", configPath],
      ["coord.hookMode", config.coordination?.hookMode]
    ] as const) changed = unsetIfOwned(root, key, expected) || changed;
    changed = unsetIfOwned(root, "core.hooksPath", join(gitDir, "hooks")) || changed;
    if (ownsIdentity) {
      for (const key of ["consensus.agentId", "consensus.agentLabel", "consensus.sharedBranch", "consensus.remoteName"]) {
        changed = unsetIfOwned(root, key) || changed;
      }
    }
  }

  if (config.coordination?.writeProduct === true) {
    emit(`remove managed product ignore block from ${productRoot}`);
    if (options.dryRun !== true) changed = removeProductIgnore(join(productRoot, ".gitignore")) || changed;
  }

  if (options.deleteClones === true) {
    for (const root of roots) {
      if (!existsSync(root)) continue;
      emit(`delete agent clone ${root}`);
      if (options.dryRun !== true) {
        rmSync(root, { recursive: true, force: true });
        changed = true;
      }
    }
  }

  if (options.wipeRuntime === true && existsSync(coordRoot)) {
    for (const entry of readdirSync(coordRoot)) {
      if (entry === "mirror.git" || /^issue-[0-9]+$/.test(entry)) {
        const target = join(coordRoot, entry);
        if (!isPathInside(coordRoot, target)) throw new Error(`Refusing runtime path ${target}.`);
        emit(`delete runtime state ${target}`);
        if (options.dryRun !== true) {
          rmSync(target, { recursive: true, force: true });
          changed = true;
        }
      }
    }
  }

  emit(`delete workspace config ${configPath}`);
  if (options.dryRun !== true && existsSync(configPath)) {
    unlinkSync(configPath);
    changed = true;
  }

  if (options.deleteCoordination === true) {
    const installRoot = config.coordination?.installRoot;
    if (
      installRoot === undefined ||
      basename(installRoot) === "" ||
      resolve(installRoot) === dirname(resolve(installRoot)) ||
      isPathInside(installRoot, productRoot) ||
      isPathInside(productRoot, installRoot) ||
      isPathInside(installRoot, coordRoot) ||
      isPathInside(coordRoot, installRoot) ||
      roots.some((root) => isPathInside(installRoot, root) || isPathInside(root, installRoot))
    ) {
      throw new Error("Recorded coordination install root is unsafe to delete.");
    }
    emit(`delete bootstrap-owned coordination install ${installRoot}`);
    if (options.dryRun !== true) {
      rmSync(installRoot, { recursive: true, force: true });
      changed = true;
    }
  }

  return { changed, actions };
};
