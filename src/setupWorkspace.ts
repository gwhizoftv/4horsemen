import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { HOOK_NAMES, installHooks, hookDigest, type HookMode, writeVendorStamp } from "./hookSync.js";
import { isPathInside, resolveSafeCoordRoot } from "./paths.js";
import { updateCloneExclude, updateProductIgnore } from "./productIgnore.js";
import { coordinatorConfigSchema, readConfig, type CoordinatorConfig } from "./state.js";

const agentPattern = /^[a-z][a-z0-9-]{0,63}$/;
const launcherMarker = "# coord-managed-launcher-v1";

const agentDefaults: Record<string, { label: string; command: readonly string[]; ignores: readonly string[] }> = {
  claude: { label: "Claude", command: ["claude", "--permission-mode", "auto"], ignores: [".claude/"] },
  codex: { label: "Codex", command: ["codex"], ignores: [".codex/", "AGENTS.override.md"] },
  cursor: { label: "Cursor", command: ["agent"], ignores: [".cursor/"] },
  antigravity: { label: "Antigravity", command: ["agy", "--mode", "accept-edits"], ignores: [".antigravity/"] },
  gemini: { label: "Gemini", command: ["gemini"], ignores: [".gemini/"] }
};

export type InstallOptions = {
  product: string;
  coordRoot: string;
  agents: readonly string[];
  profile: "solo" | "reviewed" | "consensus";
  installRoot: string;
  cloneRoot?: string;
  configSource?: string;
  baseBranch?: string;
  remoteName?: string;
  dryRun?: boolean;
  vendor?: boolean;
  writeProduct?: boolean;
  bootstrapCoordination?: boolean;
  now?: () => string;
  log?: (message: string) => void;
};

export type InstalledWorkspace = {
  configPath: string;
  config: CoordinatorConfig;
  cloneRoots: string[];
  changed: boolean;
  actions: string[];
};

const commandOutput = (command: string, args: readonly string[], cwd?: string): string =>
  execFileSync(command, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const git = (root: string, args: readonly string[]): string => commandOutput("git", ["-C", root, ...args]);

const writeIfChanged = (path: string, content: string, mode = 0o600): boolean => {
  if (existsSync(path) && readFileSync(path, "utf8") === content) {
    chmodSync(path, mode);
    return false;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { encoding: "utf8", mode });
  chmodSync(path, mode);
  return true;
};

const slug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "product";

export const workspaceConfigPath = (coordRoot: string, productRoot: string): string => {
  const canonicalProduct = existsSync(productRoot) ? realpathSync(productRoot) : resolve(productRoot);
  const digest = createHash("sha256").update(canonicalProduct).digest("hex").slice(0, 12);
  return join(resolve(coordRoot), "workspaces", `${slug(basename(productRoot))}-${digest}.json`);
};

export const executableOnPath = (command: string, cwd: string, env: NodeJS.ProcessEnv = process.env): boolean => {
  const candidates = command.includes("/")
    ? [isAbsolute(command) ? command : resolve(cwd, command)]
    : (env.PATH ?? "").split(delimiter).map((entry) => resolve(entry || ".", command));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
};

export const missingDeclaredCommands = (config: CoordinatorConfig, cwd: string): string[] => {
  const commands = [
    ...(config.verify?.precommit ?? []),
    ...(config.verify?.prepush ?? []),
    ...config.checks
  ];
  return commands
    .filter((command) => !executableOnPath(command.argv[0] as string, cwd))
    .map((command) => `${command.name}: ${command.argv[0] as string}`);
};

const launcher = (agent: string, label: string, command: readonly string[], sharedBranch: string): string => {
  const encoded = command.map((part) => `'${part.replaceAll("'", `'"'"'`)}'`).join(" ");
  return `#!/usr/bin/env bash\n${launcherMarker}\nset -euo pipefail\ncd "$(dirname "\${BASH_SOURCE[0]}")"\necho "=== ${label} agent | issue-<n>/${agent} | shared: ${sharedBranch} ==="\ngit status -sb || true\nexec ${encoded}\n`;
};

export const isManagedLauncher = (path: string): boolean =>
  existsSync(path) && readFileSync(path, "utf8").includes(launcherMarker);

const gitDir = (root: string): string => git(root, ["rev-parse", "--absolute-git-dir"]);

const ensureClone = (
  remote: string,
  remoteName: string,
  clone: string,
  baseBranch: string,
  dryRun: boolean,
  refresh: boolean,
  action: (value: string) => void
): void => {
  if (!existsSync(clone)) {
    action(`clone ${remote} -> ${clone}`);
    if (!dryRun) execFileSync("git", ["clone", "--origin", remoteName, "--branch", baseBranch, remote, clone], { stdio: "inherit" });
    return;
  }
  let top: string;
  try {
    top = realpathSync(git(clone, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new Error(`Existing clone path ${clone} is not a Git worktree.`);
  }
  if (top !== realpathSync(clone)) throw new Error(`Existing clone path ${clone} resolves to unexpected worktree ${top}.`);
  const actualRemote = git(clone, ["remote", "get-url", remoteName]);
  if (actualRemote !== remote) throw new Error(`Clone ${clone} has ${remoteName} URL ${actualRemote}, expected ${remote}.`);
  if (!refresh) {
    action(`reuse current managed clone ${clone}`);
    return;
  }
  action(`refresh ${remoteName}/${baseBranch} in existing clone ${clone}`);
  if (dryRun) return;
  git(clone, ["fetch", remoteName, baseBranch]);
  const branch = git(clone, ["branch", "--show-current"]);
  const dirty = git(clone, ["status", "--porcelain", "--untracked-files=no"]) !== "";
  if (branch === baseBranch && !dirty) {
    git(clone, ["merge", "--ff-only", `${remoteName}/${baseBranch}`]);
  }
};

const copyProductVendor = (productRoot: string, installRoot: string, commit: string): boolean => {
  const destination = join(productRoot, "githooks");
  let changed = false;
  for (const relativePath of [
    ...HOOK_NAMES,
    "lib/identity.sh",
    "lib/verify.mjs"
  ]) {
    const source = join(installRoot, "githooks", relativePath);
    const target = join(destination, relativePath);
    const content = readFileSync(source);
    if (existsSync(target)) {
      if (!readFileSync(target).equals(content)) {
        throw new Error(`Refusing to replace existing product hook file ${target}; opt-in writes are additive only.`);
      }
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, { mode: relativePath.startsWith("lib/") ? 0o644 : 0o755 });
    changed = true;
  }
  const stamp = `${JSON.stringify({ commit, hookDigest: hookDigest(installRoot) }, null, 2)}\n`;
  changed = writeIfChanged(join(destination, ".coord-vendor-stamp.json"), stamp, 0o644) || changed;
  return changed;
};

const installProductFiles = (productRoot: string, installRoot: string, vendor: boolean, commit: string): boolean => {
  const template = readFileSync(join(installRoot, "templates", "product", "gitignore.coordination.block"), "utf8");
  const lines = template
    .trim()
    .split("\n")
    .slice(1, -1);
  let changed = updateProductIgnore(join(productRoot, ".gitignore"), lines);
  const agentsPath = join(productRoot, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    writeFileSync(agentsPath, readFileSync(join(installRoot, "templates", "product", "AGENTS.md"), "utf8"), "utf8");
    changed = true;
  }
  if (vendor) changed = copyProductVendor(productRoot, installRoot, commit) || changed;
  return changed;
};

const sameStamp = (existing: CoordinatorConfig | null, next: Omit<NonNullable<CoordinatorConfig["coordination"]>, "installedAt">): string | null => {
  const stamp = existing?.coordination;
  if (stamp === undefined) return null;
  return stamp.installRoot === next.installRoot &&
    stamp.version === next.version &&
    stamp.commit === next.commit &&
    stamp.hookMode === next.hookMode &&
    stamp.writeProduct === next.writeProduct &&
    stamp.bootstrapOwned === next.bootstrapOwned &&
    stamp.cloneRoot === next.cloneRoot
    ? stamp.installedAt
    : null;
};

export const installWorkspace = (options: InstallOptions): InstalledWorkspace => {
  const actions: string[] = [];
  const emit = (message: string): void => {
    actions.push(message);
    options.log?.(`${options.dryRun === true ? "DRY-RUN: " : ""}${message}\n`);
  };
  const productRequested = resolve(options.product);
  const productRoot = realpathSync(git(productRequested, ["rev-parse", "--show-toplevel"]));
  const installRoot = realpathSync(options.installRoot);
  const remoteName = options.remoteName ?? "origin";
  const remote = git(productRoot, ["remote", "get-url", remoteName]);
  const currentBranch = git(productRoot, ["branch", "--show-current"]) || "main";
  if (!options.agents.length) throw new Error("At least one agent is required.");
  if (new Set(options.agents).size !== options.agents.length) throw new Error("Agent ids must be unique.");
  for (const agent of options.agents) {
    if (!agentPattern.test(agent)) throw new Error(`Invalid agent id ${agent}.`);
    if (agentDefaults[agent] === undefined) throw new Error(`No launcher command is defined for agent ${agent}.`);
  }
  if (options.profile === "consensus" && options.agents.length < 2) throw new Error("The consensus profile requires at least two agents.");

  const cloneRoot = resolve(options.cloneRoot ?? dirname(productRoot));
  const cloneRoots = options.agents.map((agent) => join(cloneRoot, `${basename(productRoot)}-${agent}`));
  const coordRoot = resolveSafeCoordRoot({
    coordRoot: resolve(options.coordRoot),
    agentRoots: [productRoot, ...cloneRoots],
    create: options.dryRun !== true
  });
  for (const clone of cloneRoots) {
    if (isPathInside(productRoot, clone) || isPathInside(clone, productRoot)) {
      throw new Error(`Agent clone ${clone} overlaps product worktree ${productRoot}.`);
    }
    if (isPathInside(coordRoot, clone) || isPathInside(clone, coordRoot)) {
      throw new Error(`Agent clone ${clone} overlaps coord root ${coordRoot}.`);
    }
  }

  if (options.bootstrapCoordination === true) {
    emit(`bootstrap coordination at ${installRoot}`);
    if (options.dryRun !== true) {
      execFileSync("pnpm", ["install", "--frozen-lockfile"], { cwd: installRoot, stdio: "inherit" });
      execFileSync("pnpm", ["build"], { cwd: installRoot, stdio: "inherit" });
    }
  }

  const packageJson = JSON.parse(readFileSync(join(installRoot, "package.json"), "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version === "") throw new Error("Coordination package version is missing.");
  const commit = git(installRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const configPath = workspaceConfigPath(coordRoot, productRoot);
  const installed = existsSync(configPath) ? readConfig(configPath) : null;
  const policy = options.configSource === undefined ? installed : readConfig(resolve(options.configSource));
  const alreadyInstalled = installed?.coordination !== undefined;
  const baseBranch = options.baseBranch ?? installed?.baseBranch ?? policy?.baseBranch ?? currentBranch;
  const hookMode: HookMode = options.vendor === true ? "vendor" : "shim";
  const stampWithoutTime = {
    installRoot,
    version: packageJson.version,
    commit,
    hookMode,
    writeProduct: options.writeProduct === true,
    bootstrapOwned: false,
    cloneRoot
  } as const;
  const installedAt = sameStamp(installed, stampWithoutTime) ?? (options.now?.() ?? new Date().toISOString());
  const configuredAgents: CoordinatorConfig["agents"] = options.agents.map((agent, index) => ({
    id: agent,
    root: cloneRoots[index] as string,
    launcher: `start-${agent}.sh`,
    delivery: agent === "claude" ? "nudge" : "pull",
    ...(agent === "claude" || agent === "codex" ? { harnessProcess: agent } : {})
  }));
  const candidate = {
    project: policy?.project ?? basename(productRoot),
    productRoot,
    origin: remote,
    agents: configuredAgents,
    branch: policy?.branch ?? "issue-{issue}/{agent}",
    baseBranch,
    maxRevisionRounds: policy?.maxRevisionRounds ?? 3,
    prPolicy: policy?.prPolicy ?? "owner-only",
    digestPaths: policy?.digestPaths ?? [],
    verify: policy?.verify ?? { precommit: [], prepush: [] },
    workflowCriticalPrefixes: policy?.workflowCriticalPrefixes ?? [],
    workflowCriticalFiles: policy?.workflowCriticalFiles ?? [],
    checks: policy?.checks ?? [],
    coordination: { ...stampWithoutTime, installedAt },
    pollIntervalMs: policy?.pollIntervalMs ?? 1_000
  };
  const config = coordinatorConfigSchema.parse(candidate);
  const missing = missingDeclaredCommands(config, productRoot);
  if (missing.length > 0) throw new Error(`Declared commands are not executable on PATH: ${missing.join(", ")}.`);

  emit(`write workspace config ${configPath}`);
  let changed = false;
  if (options.dryRun !== true) {
    changed = writeIfChanged(configPath, `${JSON.stringify(config, null, 2)}\n`) || changed;
  }

  for (const [index, agent] of options.agents.entries()) {
    const clone = cloneRoots[index] as string;
    ensureClone(remote, remoteName, clone, baseBranch, options.dryRun === true, !alreadyInstalled, emit);
    const defaults = agentDefaults[agent] as NonNullable<(typeof agentDefaults)[string]>;
    emit(`configure ${agent} clone at ${clone}`);
    if (options.dryRun === true) continue;
    const cloneGitDir = gitDir(clone);
    const localHooksPath = (() => {
      try { return git(clone, ["config", "--local", "--get", "core.hooksPath"]); } catch { return ""; }
    })();
    if (localHooksPath === "githooks" || localHooksPath === ".githooks") {
      try { git(clone, ["config", "--local", "--unset-all", "core.hooksPath"]); } catch { /* already absent */ }
    } else if (localHooksPath !== "") {
      throw new Error(`Clone ${clone} has unrelated local core.hooksPath=${localHooksPath}; refusing to replace it.`);
    }
    const effectiveHooksPath = (() => {
      try { return git(clone, ["config", "--get", "core.hooksPath"]); } catch { return ""; }
    })();
    if (effectiveHooksPath !== "") {
      git(clone, ["config", "--local", "core.hooksPath", join(cloneGitDir, "hooks")]);
    }
    for (const [key, value] of [
      ["consensus.agentId", agent],
      ["consensus.agentLabel", defaults.label],
      ["consensus.sharedBranch", baseBranch],
      ["consensus.remoteName", remoteName],
      ["coord.installRoot", installRoot],
      ["coord.workspaceConfig", configPath],
      ["coord.hookMode", hookMode]
    ] as const) git(clone, ["config", "--local", key, value]);
    const exclude = join(cloneGitDir, "info", "exclude");
    changed = updateCloneExclude(exclude, agent, [
      `start-${agent}.sh`,
      ...defaults.ignores,
      "tags",
      "directory_tree.md"
    ]) || changed;
    const launcherPath = join(clone, `start-${agent}.sh`);
    changed = writeIfChanged(launcherPath, launcher(agent, defaults.label, defaults.command, baseBranch), 0o755) || changed;
    const installedHooks = installHooks({ cloneRoot: clone, gitDir: cloneGitDir, agent, installRoot, workspaceConfig: configPath, mode: hookMode });
    changed = installedHooks.changed || changed;
    if (hookMode === "vendor") writeVendorStamp(cloneGitDir, commit, hookDigest(installRoot));
  }

  if (options.writeProduct === true) {
    emit(`write opt-in product bootstrap files under ${productRoot}`);
    if (options.dryRun !== true) changed = installProductFiles(productRoot, installRoot, options.vendor === true, commit) || changed;
  }

  emit(`next: coord start <issue> --profile ${options.profile} --config ${configPath} --coord-root ${coordRoot}`);
  emit(`next: coord run --issue <issue> --coord-root ${coordRoot}`);
  return { configPath, config, cloneRoots, changed, actions };
};
