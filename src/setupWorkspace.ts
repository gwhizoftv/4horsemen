import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearAgentHooks, vendorHookBodies, writeHookShims } from "./hookSync.js";
import { isPathInside, resolveSafeCoordRoot } from "./paths.js";
import { clearCloneExcludeManaged, ensureCloneExclude } from "./productIgnore.js";
import {
  coordinatorConfigSchema,
  type CoordinatorConfig,
  type CoordinationInstall
} from "./state.js";

export const KNOWN_AGENTS: Record<
  string,
  { label: string; delivery: "pull" | "nudge"; harnessProcess?: string }
> = {
  claude: { label: "Claude", delivery: "nudge", harnessProcess: "claude" },
  codex: { label: "Codex", delivery: "pull", harnessProcess: "codex" },
  cursor: { label: "Cursor", delivery: "pull" },
  antigravity: { label: "Antigravity", delivery: "pull" },
  gemini: { label: "Gemini", delivery: "pull" }
};

export const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export type SetupWorkspaceOptions = {
  productRoot: string;
  coordRoot: string;
  agents: readonly string[];
  installRoot: string;
  cloneRoot?: string;
  configTemplatePath?: string;
  writeProduct?: boolean;
  vendor?: boolean;
  dryRun?: boolean;
  sharedBranch?: string;
  remoteName?: string;
};

export type SetupWorkspaceResult = {
  configPath: string;
  config: CoordinatorConfig;
  cloneRoots: Record<string, string>;
  productStatusClean: boolean;
  noop: boolean;
};

const runGit = (args: readonly string[], cwd: string): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const packageVersion = (): string => {
  const raw = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { version?: string };
  return raw.version ?? "0.0.0";
};

const installCommit = (installRoot: string): string => runGit(["rev-parse", "HEAD"], installRoot);

const launcherCommand = (agentId: string): string => {
  switch (agentId) {
    case "claude":
      return "exec claude --permission-mode auto\n";
    case "codex":
      return "exec codex\n";
    case "antigravity":
      return 'export PATH="$HOME/.local/bin:$PATH"\nexec agy --mode accept-edits\n';
    case "gemini":
      return "exec gemini\n";
    case "cursor":
      return "exec agent\n";
    default:
      throw new Error(`No launcher command for agent ${agentId}.`);
  }
};

export const writeAgentLauncher = (
  cloneRoot: string,
  agentId: string,
  label: string,
  sharedBranch: string,
  options: { dryRun?: boolean } = {}
): string => {
  const path = join(cloneRoot, `start-${agentId}.sh`);
  if (options.dryRun === true) return path;
  const body = [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    'cd "$(dirname "${BASH_SOURCE[0]}")"',
    "",
    "# Optional Node toolchain when the product declares .nvmrc (coordination itself",
    "# requires Node; arbitrary products may not).",
    "if [[ -f .nvmrc ]]; then",
    '  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"',
    '  if [[ -s "$NVM_DIR/nvm.sh" ]]; then',
    "    # shellcheck disable=SC1090",
    '    . "$NVM_DIR/nvm.sh"',
    "    nvm use >/dev/null",
    "  fi",
    "  if [[ -f pnpm-lock.yaml ]] && command -v corepack >/dev/null; then",
    "    corepack enable pnpm >/dev/null 2>&1 || true",
    "  fi",
    "fi",
    "",
    `echo "=== ${label} agent | branch scheme issue-<n>/${agentId} | shared: ${sharedBranch} ==="`,
    "git status -sb || true",
    "",
    launcherCommand(agentId).trimEnd()
  ].join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
};

const setLocalConfig = (cloneRoot: string, key: string, value: string, dryRun: boolean): void => {
  if (dryRun) return;
  runGit(["config", "--local", key, value], cloneRoot);
};

export const unsetLocalConfig = (cloneRoot: string, key: string, dryRun: boolean): void => {
  if (dryRun) return;
  try {
    runGit(["config", "--local", "--unset-all", key], cloneRoot);
  } catch {
    // absent is fine
  }
};

export const resolveProductOrigin = (productRoot: string, remoteName: string): string => {
  const url = runGit(["config", "--get", `remote.${remoteName}.url`], productRoot);
  if (url === "") throw new Error(`Product has no ${remoteName} remote.`);
  return url;
};

export const assertInstallContainment = (input: {
  productRoot: string;
  coordRoot: string;
  agentRoots: readonly string[];
}): void => {
  const product = resolve(input.productRoot);
  const coord = resolve(input.coordRoot);

  if (isPathInside(product, coord) || isPathInside(coord, product)) {
    throw new Error(`Product root and coord-root must not nest: ${product} vs ${coord}`);
  }
  for (const agentRoot of input.agentRoots) {
    const agent = resolve(agentRoot);
    if (isPathInside(agent, product) || isPathInside(product, agent)) {
      throw new Error(`Agent clone ${agent} overlaps product ${product}`);
    }
    if (isPathInside(agent, coord) || isPathInside(coord, agent)) {
      throw new Error(`Agent clone ${agent} overlaps coord-root ${coord}`);
    }
  }
  resolveSafeCoordRoot({ coordRoot: coord, agentRoots: input.agentRoots, create: false });
};

const loadTemplate = (path: string | undefined): CoordinatorConfig => {
  const templatePath = path ?? join(packageRoot, "config.product.example.json");
  const raw = JSON.parse(readFileSync(templatePath, "utf8")) as unknown;
  return coordinatorConfigSchema.parse(raw);
};

/** Compare configs ignoring install stamp churn (commit / installedAt). */
export const sameInstallPayload = (left: CoordinatorConfig, right: CoordinatorConfig): boolean => {
  const strip = (config: CoordinatorConfig): unknown => {
    const { coordination: stamp, ...rest } = config;
    if (stamp === undefined) return rest;
    return {
      ...rest,
      coordination: {
        installRoot: stamp.installRoot,
        version: stamp.version,
        productRoot: stamp.productRoot,
        wroteProduct: stamp.wroteProduct,
        vendor: stamp.vendor,
        bootstrappedCoordination: stamp.bootstrappedCoordination,
        managedGitignore: stamp.managedGitignore
      }
    };
  };
  return JSON.stringify(strip(left)) === JSON.stringify(strip(right));
};

export const setupWorkspace = (options: SetupWorkspaceOptions): SetupWorkspaceResult => {
  const dryRun = options.dryRun === true;
  const productRoot = resolve(options.productRoot);
  const sharedBranch = options.sharedBranch ?? "main";
  const remoteName = options.remoteName ?? "origin";
  const projectName = basename(productRoot);
  const cloneRoot = resolve(options.cloneRoot ?? dirname(productRoot));
  const installRoot = resolve(options.installRoot);
  const agents = options.agents.map((id) => {
    if (!(id in KNOWN_AGENTS)) throw new Error(`Unknown agent id ${id}.`);
    return id;
  });

  if (!existsSync(join(productRoot, ".git"))) {
    throw new Error(`Product path is not a git repository: ${productRoot}`);
  }

  const cloneRoots: Record<string, string> = {};
  for (const agentId of agents) {
    cloneRoots[agentId] = join(cloneRoot, `${projectName}-${agentId}`);
  }

  const coordRoot = resolveSafeCoordRoot({
    coordRoot: resolve(options.coordRoot),
    agentRoots: Object.values(cloneRoots),
    create: !dryRun
  });

  assertInstallContainment({
    productRoot,
    coordRoot,
    agentRoots: Object.values(cloneRoots)
  });

  const origin = resolveProductOrigin(productRoot, remoteName);
  const template = loadTemplate(options.configTemplatePath);
  const stamp: CoordinationInstall = {
    installRoot,
    version: packageVersion(),
    commit: installCommit(installRoot),
    installedAt: new Date().toISOString(),
    productRoot,
    wroteProduct: options.writeProduct === true,
    vendor: options.vendor === true,
    bootstrappedCoordination: false,
    managedGitignore: options.writeProduct === true
  };

  const agentConfigs = agents.map((id) => {
    const meta = KNOWN_AGENTS[id]!;
    const root = cloneRoots[id]!;
    return {
      id,
      root,
      launcher: `start-${id}.sh`,
      delivery: meta.delivery,
      ...(meta.harnessProcess !== undefined ? { harnessProcess: meta.harnessProcess } : {})
    };
  });

  const config: CoordinatorConfig = coordinatorConfigSchema.parse({
    ...template,
    project: projectName,
    origin,
    baseBranch: sharedBranch,
    agents: agentConfigs,
    verify: template.verify ?? { precommit: [], prepush: [] },
    workflowCriticalPrefixes: template.workflowCriticalPrefixes,
    workflowCriticalFiles: template.workflowCriticalFiles,
    coordination: stamp
  });

  const configPath = join(coordRoot, "config.json");
  let noop = false;
  if (existsSync(configPath)) {
    const existing = coordinatorConfigSchema.parse(JSON.parse(readFileSync(configPath, "utf8")));
    if (sameInstallPayload(existing, config)) noop = true;
  }

  if (!dryRun) mkdirSync(coordRoot, { recursive: true, mode: 0o700 });

  for (const agentId of agents) {
    const root = cloneRoots[agentId]!;
    const label = KNOWN_AGENTS[agentId]!.label;
    if (!existsSync(root)) {
      noop = false;
      if (!dryRun) {
        execFileSync("git", ["clone", productRoot, root], { encoding: "utf8" });
        runGit(["remote", "set-url", remoteName, origin], root);
      }
    } else if (!dryRun) {
      const dirty = runGit(["status", "--porcelain"], root) !== "";
      if (dirty) {
        throw new Error(`Agent clone ${root} has uncommitted changes; commit/stash or recreate it.`);
      }
    }

    ensureCloneExclude(root, agentId, { dryRun });
    writeAgentLauncher(root, agentId, label, sharedBranch, { dryRun });
    setLocalConfig(root, "consensus.agentId", agentId, dryRun);
    setLocalConfig(root, "consensus.agentLabel", label, dryRun);
    setLocalConfig(root, "consensus.sharedBranch", sharedBranch, dryRun);
    setLocalConfig(root, "consensus.remoteName", remoteName, dryRun);
    setLocalConfig(root, "coord.installRoot", installRoot, dryRun);
    setLocalConfig(root, "coord.workspaceConfig", configPath, dryRun);
    // Prefer .git/hooks shims; do not set core.hooksPath (missing path silently disables hooks).
    unsetLocalConfig(root, "core.hooksPath", dryRun);

    if (options.vendor === true) {
      vendorHookBodies(root, installRoot, { dryRun });
    } else {
      writeHookShims(root, { dryRun });
    }
  }

  if (!dryRun) {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  }

  const productStatus = dryRun ? "" : runGit(["status", "--porcelain"], productRoot);
  return {
    configPath,
    config,
    cloneRoots,
    productStatusClean: productStatus === "",
    noop
  };
};

export const teardownAgentCloneWiring = (
  cloneRoot: string,
  agentId: string,
  options: { dryRun?: boolean } = {}
): void => {
  const dryRun = options.dryRun === true;
  clearAgentHooks(cloneRoot, { dryRun });
  clearCloneExcludeManaged(cloneRoot, agentId, { dryRun });
  unsetLocalConfig(cloneRoot, "consensus.agentId", dryRun);
  unsetLocalConfig(cloneRoot, "consensus.agentLabel", dryRun);
  unsetLocalConfig(cloneRoot, "consensus.sharedBranch", dryRun);
  unsetLocalConfig(cloneRoot, "consensus.remoteName", dryRun);
  unsetLocalConfig(cloneRoot, "coord.installRoot", dryRun);
  unsetLocalConfig(cloneRoot, "coord.workspaceConfig", dryRun);
  unsetLocalConfig(cloneRoot, "core.hooksPath", dryRun);
  const launcher = join(cloneRoot, `start-${agentId}.sh`);
  if (existsSync(launcher) && !dryRun) unlinkSync(launcher);
};
