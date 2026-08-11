import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { HOOK_NAMES, expectedHookShim, hookDigest, vendorStampPath } from "./hookSync.js";
import { isPathInside } from "./paths.js";
import { missingDeclaredCommands, workspaceConfigPath } from "./setupWorkspace.js";
import { readConfig, type CoordinatorConfig } from "./state.js";

export type DoctorCode =
  | "CONFIG_INCOMPATIBLE"
  | "MISSING_INSTALL_ROOT"
  | "INSTALL_DRIFT"
  | "BAD_HOOKS"
  | "STALE_VENDOR"
  | "MISSING_LAUNCHER"
  | "BAD_IDENTITY"
  | "MISSING_COMMAND";

export type DoctorIssue = { code: DoctorCode; message: string; agent?: string };
export type DoctorResult = { ok: boolean; configPath: string; issues: DoctorIssue[] };

const git = (root: string, args: readonly string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const localConfig = (root: string, key: string): string => {
  try { return git(root, ["config", "--local", "--get", key]); } catch { return ""; }
};

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const doctorWorkspace = (options: {
  product: string;
  coordRoot: string;
  configPath?: string;
}): DoctorResult => {
  let productRoot: string;
  try {
    productRoot = realpathSync(git(resolve(options.product), ["rev-parse", "--show-toplevel"]));
  } catch (error) {
    return {
      ok: false,
      configPath: resolve(options.configPath ?? workspaceConfigPath(options.coordRoot, options.product)),
      issues: [{ code: "CONFIG_INCOMPATIBLE", message: `Product is not a readable Git worktree: ${error instanceof Error ? error.message : String(error)}` }]
    };
  }
  const configPath = resolve(options.configPath ?? workspaceConfigPath(options.coordRoot, productRoot));
  const issues: DoctorIssue[] = [];
  let config: CoordinatorConfig;
  try {
    config = readConfig(configPath);
  } catch (error) {
    return {
      ok: false,
      configPath,
      issues: [{ code: "CONFIG_INCOMPATIBLE", message: error instanceof Error ? error.message : String(error) }]
    };
  }
  if (config.productRoot !== undefined) {
    try {
      if (realpathSync(config.productRoot) !== productRoot) {
        issues.push({ code: "CONFIG_INCOMPATIBLE", message: `Workspace belongs to ${config.productRoot}, not ${productRoot}.` });
      }
    } catch {
      issues.push({ code: "CONFIG_INCOMPATIBLE", message: `Recorded product root is missing: ${config.productRoot}.` });
    }
  }
  if (config.verify === undefined) {
    issues.push({
      code: "CONFIG_INCOMPATIBLE",
      message: 'Workspace has no verify declaration; add precommit/prepush arrays (use [] for an explicit opt-out).'
    });
  }
  const stamp = config.coordination;
  if (stamp === undefined || !existsSync(stamp.installRoot)) {
    issues.push({ code: "MISSING_INSTALL_ROOT", message: `Install root is missing: ${stamp?.installRoot ?? "<unset>"}.` });
  } else {
    try {
      const commit = git(stamp.installRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
      const pkg = JSON.parse(readFileSync(join(stamp.installRoot, "package.json"), "utf8")) as { version?: unknown };
      if (commit !== stamp.commit || pkg.version !== stamp.version) {
        issues.push({
          code: "INSTALL_DRIFT",
          message: `Install stamp is ${stamp.version}@${stamp.commit}, current install is ${String(pkg.version)}@${commit}.`
        });
      }
    } catch (error) {
      issues.push({ code: "INSTALL_DRIFT", message: `Install root cannot be inspected: ${error instanceof Error ? error.message : String(error)}` });
    }
  }

  for (const agent of config.agents) {
    const root = isAbsolute(agent.root) ? agent.root : resolve(dirname(configPath), agent.root);
    if (!existsSync(root)) {
      issues.push({ code: "BAD_IDENTITY", agent: agent.id, message: `Agent clone is missing: ${root}.` });
      continue;
    }
    if (
      localConfig(root, "consensus.agentId") !== agent.id ||
      !/^[A-Za-z][A-Za-z0-9 ._-]*$/.test(localConfig(root, "consensus.agentLabel"))
    ) {
      issues.push({ code: "BAD_IDENTITY", agent: agent.id, message: `Clone ${root} has missing or malformed local identity.` });
    }
    if (stamp?.hookMode === "shim" && localConfig(root, "coord.installRoot") !== stamp.installRoot) {
      issues.push({ code: "MISSING_INSTALL_ROOT", agent: agent.id, message: `Clone ${root} has missing or drifted coord.installRoot.` });
    }
    if (localConfig(root, "coord.workspaceConfig") !== configPath) {
      issues.push({ code: "CONFIG_INCOMPATIBLE", agent: agent.id, message: `Clone ${root} does not point at ${configPath}.` });
    }
    const launcher = resolve(root, agent.launcher);
    if (!isPathInside(root, launcher)) {
      issues.push({ code: "CONFIG_INCOMPATIBLE", agent: agent.id, message: `Launcher escapes agent clone: ${agent.launcher}.` });
    } else if (!executable(launcher)) {
      issues.push({ code: "MISSING_LAUNCHER", agent: agent.id, message: `Launcher is missing or not executable: ${launcher}.` });
    }
    let cloneGitDir = "";
    try { cloneGitDir = git(root, ["rev-parse", "--absolute-git-dir"]); } catch { /* reported below */ }
    const hooksGood = cloneGitDir !== "" && stamp !== undefined && existsSync(stamp.installRoot) && HOOK_NAMES.every((hook) => {
      const path = join(cloneGitDir, "hooks", hook);
      return executable(path) && readFileSync(path, "utf8") === expectedHookShim({
        cloneRoot: root,
        gitDir: cloneGitDir,
        agent: agent.id,
        installRoot: stamp.installRoot,
        workspaceConfig: configPath,
        mode: stamp.hookMode
      }, hook);
    });
    if (!hooksGood) issues.push({ code: "BAD_HOOKS", agent: agent.id, message: `Managed hook shims are missing or stale in ${root}.` });
    let effectiveHooksPath = "";
    try { effectiveHooksPath = git(root, ["config", "--get", "core.hooksPath"]); } catch { /* default path */ }
    if (effectiveHooksPath !== "") {
      const expected = join(cloneGitDir, "hooks");
      const effective = isAbsolute(effectiveHooksPath) ? resolve(effectiveHooksPath) : resolve(root, effectiveHooksPath);
      if (effective !== expected) issues.push({ code: "BAD_HOOKS", agent: agent.id, message: `core.hooksPath bypasses managed shims: ${effectiveHooksPath}.` });
    }
    if (stamp?.hookMode === "vendor" && cloneGitDir !== "") {
      try {
        const vendor = JSON.parse(readFileSync(vendorStampPath(cloneGitDir), "utf8")) as { commit?: unknown; hookDigest?: unknown };
        const currentDigest = stamp.installRoot && existsSync(stamp.installRoot) ? hookDigest(stamp.installRoot) : null;
        const copiedDigest = hookDigest(join(cloneGitDir, "hooks", ".coord-vendor"));
        if (vendor.commit !== stamp.commit || vendor.hookDigest !== currentDigest || copiedDigest !== vendor.hookDigest) {
          issues.push({ code: "STALE_VENDOR", agent: agent.id, message: `Vendored hooks in ${root} do not match the install stamp.` });
        }
      } catch (error) {
        issues.push({ code: "STALE_VENDOR", agent: agent.id, message: `Vendor stamp cannot be verified: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  }

  for (const missing of missingDeclaredCommands(config, productRoot)) {
    issues.push({ code: "MISSING_COMMAND", message: `Declared command is unavailable on PATH (${missing}).` });
  }
  return { ok: issues.length === 0, configPath, issues };
};
