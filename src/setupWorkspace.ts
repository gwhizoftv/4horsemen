import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  git,
  gitOrThrow,
  hasUncommittedChanges,
  localConfigGet,
  localConfigSet,
  localConfigUnset,
  worktreeRoot
} from "./gitExec.js";
import { CLI_ENTRY_KEY, INSTALL_ROOT_KEY, WORKSPACE_CONFIG_KEY } from "./hookPolicy.js";
import { containedPath, isPathInside } from "./paths.js";
import { DEFAULT_CLONE_IGNORES, writeManagedIgnoreFile, clearManagedIgnoreFile } from "./productIgnore.js";
import {
  atomicWriteJson,
  coordinatorConfigSchema,
  type CheckCommand,
  type CoordinatorConfig,
  type WorkspaceDeclaration
} from "./state.js";

/**
 * Everything `coord install` does to an agent clone and to the owner runtime.
 *
 * The division of labour this module encodes: the product's tracked tree gets
 * nothing, the agent clones get identity and wiring in per-clone untracked
 * state, and the declared policy the hooks read lives under `coord-root`, where
 * no agent can write argv that another clone would execute.
 */

export type Logger = (message: string) => void;

/**
 * `changes` is what makes "a second install is a no-op" checkable: every
 * mutation records itself here whether or not `dryRun` suppressed it, so an
 * already-installed workspace produces an empty list.
 */
export type EffectOptions = { dryRun: boolean; log: Logger; changes: string[] };

export const effectOptions = (log: Logger, dryRun: boolean): EffectOptions => ({ dryRun, log, changes: [] });

const act = (options: EffectOptions, description: string, effect: () => void): void => {
  options.changes.push(description);
  if (options.dryRun) {
    options.log(`would ${description}\n`);
    return;
  }
  effect();
  options.log(`${description}\n`);
};

/** Display labels for the agents whose launchers this package knows how to write. */
const KNOWN_AGENT_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  antigravity: "Antigravity",
  gemini: "Gemini"
};

export const agentLabel = (agent: string): string =>
  KNOWN_AGENT_LABELS[agent] ?? `${agent.charAt(0).toUpperCase()}${agent.slice(1)}`;

export const workspaceDirectory = (coordRoot: string, project: string): string =>
  containedPath(resolve(coordRoot), "workspaces", project);

export const workspaceConfigPath = (coordRoot: string, project: string): string =>
  join(workspaceDirectory(coordRoot, project), "config.json");

export const agentCloneDirectory = (cloneRoot: string, project: string, agent: string): string =>
  join(resolve(cloneRoot), `${project}-${agent}`);

// --------------------------------------------------------------- proposals --

export type ProjectPolicyProposal = {
  toolchain?: string;
  verify?: { precommit: CheckCommand[]; prepush: CheckCommand[] };
  checks?: CheckCommand[];
  workflowCriticalPrefixes: string[];
  workflowCriticalFiles: string[];
};

const nodeScripts = (productRoot: string): Set<string> => {
  try {
    const parsed = JSON.parse(readFileSync(join(productRoot, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    return new Set(Object.keys(parsed.scripts ?? {}));
  } catch {
    return new Set<string>();
  }
};

const makeTargets = (productRoot: string): Set<string> => {
  try {
    const content = readFileSync(join(productRoot, "Makefile"), "utf8");
    return new Set([...content.matchAll(/^([A-Za-z0-9_.-]+):/gm)].map((match) => match[1] as string));
  } catch {
    return new Set<string>();
  }
};

/**
 * A proposal only carries `verify` when it actually found something to run.
 *
 * Emitting `{ precommit: [], prepush: [] }` because nothing was recognised
 * writes the operator's explicit opt-out on their behalf: the hooks then read a
 * deliberate "this project has no local checks" and allow every commit. Missing
 * must stay missing so the hooks fail closed and say what to declare.
 */
const proposedVerify = (
  precommit: CheckCommand[],
  prepush: CheckCommand[]
): { verify?: { precommit: CheckCommand[]; prepush: CheckCommand[] } } =>
  precommit.length === 0 && prepush.length === 0 ? {} : { verify: { precommit, prepush } };

/**
 * Scaffold a project's declared policy from what its tree obviously is.
 *
 * This is the ONLY place ecosystem detection is allowed, and its output is
 * written into the workspace config for an operator to review. No hook body
 * ever sniffs: a proposal made once and recorded is reviewable, whereas a
 * decision remade silently on every commit is the drift this issue exists to
 * remove.
 */
export const proposeProjectPolicy = (productRoot: string): ProjectPolicyProposal => {
  const has = (relative: string): boolean => existsSync(join(productRoot, relative));

  if (has("Cargo.toml")) {
    return {
      toolchain: "cargo",
      verify: {
        precommit: [{ name: "check", argv: ["cargo", "check", "--all-targets"] }],
        prepush: [{ name: "test", argv: ["cargo", "test"] }]
      },
      checks: [{ name: "test", argv: ["cargo", "test"] }],
      workflowCriticalPrefixes: ["src/", "tests/"],
      workflowCriticalFiles: ["Cargo.toml", "Cargo.lock"]
    };
  }

  if (has("go.mod")) {
    return {
      toolchain: "go",
      verify: {
        precommit: [{ name: "vet", argv: ["go", "vet", "./..."] }],
        prepush: [{ name: "test", argv: ["go", "test", "./..."] }]
      },
      checks: [
        { name: "build", argv: ["go", "build", "./..."] },
        { name: "test", argv: ["go", "test", "./..."] }
      ],
      workflowCriticalPrefixes: ["cmd/", "internal/", "pkg/"],
      workflowCriticalFiles: ["go.mod", "go.sum"]
    };
  }

  if (has("package.json")) {
    const scripts = nodeScripts(productRoot);
    const manager = has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : "npm";
    const runScript = (name: string): CheckCommand => ({
      name,
      argv: manager === "npm" ? ["npm", "run", "--silent", name] : [manager, "run", name]
    });
    const precommit = ["check:fast", "check", "lint"].filter((name) => scripts.has(name)).slice(0, 1);
    const prepush = ["test:e2e"].filter((name) => scripts.has(name));
    const finalization = ["check", "test"].filter((name) => scripts.has(name)).slice(0, 1);
    return {
      toolchain: manager,
      ...proposedVerify(precommit.map(runScript), prepush.map(runScript)),
      checks: finalization.length === 0 ? undefined : finalization.map(runScript),
      workflowCriticalPrefixes: ["src/", "test/", "scripts/", "githooks/"],
      workflowCriticalFiles: ["package.json", has("pnpm-lock.yaml") ? "pnpm-lock.yaml" : has("yarn.lock") ? "yarn.lock" : "package-lock.json"]
    };
  }

  const targets = makeTargets(productRoot);
  if (targets.size > 0) {
    const target = (name: string): CheckCommand => ({ name, argv: ["make", name] });
    return {
      toolchain: "make",
      ...proposedVerify(targets.has("check") ? [target("check")] : [], []),
      checks: targets.has("test") ? [target("test")] : undefined,
      workflowCriticalPrefixes: [],
      workflowCriticalFiles: ["Makefile"]
    };
  }

  return { workflowCriticalPrefixes: [], workflowCriticalFiles: [] };
};

// ------------------------------------------------------------------ config --

export type WorkspaceConfigInput = {
  project: string;
  origin: string;
  baseBranch: string;
  agents: readonly string[];
  cloneRoot: string;
  workspaceDir: string;
  declared: WorkspaceDeclaration | null;
  proposal: ProjectPolicyProposal;
};

/**
 * Build the config `coord start` will consume. It is a single file: the same
 * schema, the same parser, so an installed workspace cannot be one the driver
 * refuses.
 */
export const buildWorkspaceConfig = (input: WorkspaceConfigInput, stamp: CoordinatorConfig["coordination"]): CoordinatorConfig => {
  const declared = input.declared ?? {};
  const checks = declared.checks ?? input.proposal.checks;
  if (checks === undefined || checks.length === 0) {
    throw new Error(
      `Cannot infer finalization checks for ${input.project}. Declare them explicitly and re-run:\n` +
        "  coord install … --declare <file.json>\n" +
        "  where the file contains at least: { \"checks\": [{ \"name\": \"test\", \"argv\": [\"…\"] }] }\n" +
        "  See config.product.example.json in the coordination install."
    );
  }
  const verify = declared.verify ?? input.proposal.verify;
  const toolchain = declared.toolchain ?? input.proposal.toolchain;

  return coordinatorConfigSchema.parse({
    project: input.project,
    origin: input.origin,
    agents: input.agents.map((agent) => ({
      id: agent,
      // Config-relative, so a workspace directory can be moved with its clones.
      root: relativeFrom(input.workspaceDir, agentCloneDirectory(input.cloneRoot, input.project, agent)),
      launcher: `start-${agent}.sh`,
      delivery: agent === "claude" ? "nudge" : "pull",
      harnessProcess: agent
    })),
    branch: declared.branch ?? "issue-{issue}/{agent}",
    baseBranch: input.baseBranch,
    maxRevisionRounds: 3,
    prPolicy: declared.prPolicy ?? "owner-only",
    digestPaths: declared.digestPaths ?? [".plans/issue-{issue}/plan.md"],
    checks,
    pollIntervalMs: declared.pollIntervalMs ?? 1_000,
    ...(toolchain === undefined ? {} : { toolchain }),
    ...(verify === undefined ? {} : { verify }),
    workflowCriticalPrefixes: declared.workflowCriticalPrefixes ?? input.proposal.workflowCriticalPrefixes,
    workflowCriticalFiles: declared.workflowCriticalFiles ?? input.proposal.workflowCriticalFiles,
    coordination: stamp
  });
};

const relativeFrom = (from: string, to: string): string => {
  const relative = resolve(to).startsWith(resolve(from)) ? resolve(to).slice(resolve(from).length + 1) : null;
  if (relative !== null && relative !== "") return relative;
  // Clone roots are normally siblings of the product, not of the runtime, so a
  // relative path would be a long ../.. chain with no benefit. Absolute is
  // honest, and `coord start` resolves both.
  return resolve(to);
};

export const writeWorkspaceConfig = (
  coordRoot: string,
  config: CoordinatorConfig,
  options: EffectOptions
): string => {
  const directory = workspaceDirectory(coordRoot, config.project);
  const path = workspaceConfigPath(coordRoot, config.project);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  const rendered = `${JSON.stringify(config, null, 2)}\n`;
  if (existing === rendered) {
    options.log(`workspace config already current at ${path}\n`);
    return path;
  }
  act(options, `write workspace config ${path}`, () => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    atomicWriteJson(coordRoot, path, config);
  });
  return path;
};

// ------------------------------------------------------------------ clones --

export type CloneOutcome = { clone: string; created: boolean; synced: boolean };

/** Normalise remote URLs enough to compare a local path against its clone's. */
const sameRemote = (left: string, right: string): boolean => {
  const strip = (value: string): string => value.replace(/\.git$/, "").replace(/\/+$/, "");
  return strip(left) === strip(right) || strip(resolve(left)) === strip(resolve(right));
};

/**
 * Adopt or create the agent clone.
 *
 * An existing clone is never reset. `coord install` is idempotent and gets
 * re-run to repair wiring, and an installer that discarded an agent's in-flight
 * work as a side effect of repairing a hook would be the most expensive kind of
 * surprise. But existence alone is not adoption: the directory must be a git
 * worktree whose origin is this product, or coordination would wire identity,
 * policy, hooks, and a launcher into an unrelated repository — and, when the
 * directory was not a repository at all, fabricate a `.git` on the way to
 * failing.
 *
 * Where the clone is clean and on the shared branch, it is fast-forwarded so a
 * reinstall does not leave an agent working from a stale baseline. Dirty or
 * diverged clones are reported, never rewritten.
 */
export const ensureAgentClone = (input: {
  productRoot: string;
  origin: string;
  clone: string;
  baseBranch: string;
  options: EffectOptions;
}): CloneOutcome => {
  if (existsSync(input.clone)) {
    const toplevel = worktreeRoot(input.clone);
    if (toplevel === null || resolve(toplevel) !== resolve(input.clone)) {
      throw new Error(
        `${input.clone} already exists but is not the root of a git worktree.\n` +
          "  Refusing to wire coordination into it. Move it aside, or pass --clone-root to choose another location."
      );
    }
    const remote = localConfigGet(input.clone, "remote.origin.url");
    if (remote === null || !(sameRemote(remote, input.origin) || sameRemote(remote, input.productRoot))) {
      throw new Error(
        `${input.clone} is a clone of '${remote ?? "<no origin>"}', not of ${input.origin}.\n` +
          "  Refusing to wire this product's identity, policy, and hooks into an unrelated repository."
      );
    }
    input.options.log(`clone already present at ${input.clone} (worktree left untouched)\n`);
    return { clone: input.clone, created: false, synced: syncAgentClone(input) };
  }
  act(input.options, `clone ${input.productRoot} into ${input.clone}`, () => {
    mkdirSync(dirname(input.clone), { recursive: true });
    gitOrThrow(dirname(input.clone), "clone", "--branch", input.baseBranch, input.productRoot, input.clone);
    gitOrThrow(input.clone, "remote", "set-url", "origin", input.origin);
  });
  return { clone: input.clone, created: true, synced: false };
};

/** Fast-forward a clean clone sitting on the shared branch; never rewrite. */
const syncAgentClone = (input: {
  clone: string;
  baseBranch: string;
  options: EffectOptions;
}): boolean => {
  if (hasUncommittedChanges(input.clone)) {
    input.options.log(`clone ${input.clone} has uncommitted work; not syncing\n`);
    return false;
  }
  const branch = git(input.clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (branch !== input.baseBranch) {
    input.options.log(`clone ${input.clone} is on '${branch}', not '${input.baseBranch}'; not syncing\n`);
    return false;
  }
  if (input.options.dryRun) {
    // Report only work that is actually pending: a dry run must not fetch, and
    // claiming a fast-forward that the real run would find unnecessary breaks
    // the "second install is a no-op" guarantee it exists to check.
    const head = git(input.clone, "rev-parse", "HEAD").stdout.trim();
    const tracked = git(input.clone, "rev-parse", `origin/${input.baseBranch}`);
    if (tracked.exitCode !== 0 || tracked.stdout.trim() === head) return false;
    input.options.changes.push(`fast-forward ${input.clone} to origin/${input.baseBranch}`);
    input.options.log(`would fast-forward ${input.clone} to origin/${input.baseBranch}\n`);
    return true;
  }
  const fetched = git(input.clone, "fetch", "--quiet", "origin", input.baseBranch);
  if (fetched.exitCode !== 0) {
    input.options.log(`could not fetch origin/${input.baseBranch} for ${input.clone}; leaving it as is\n`);
    return false;
  }
  const merged = git(input.clone, "merge", "--ff-only", "--quiet", `origin/${input.baseBranch}`);
  if (merged.exitCode !== 0) {
    input.options.log(
      `clone ${input.clone} has diverged from origin/${input.baseBranch}; integrate it yourself (coordination never rewrites a clone)\n`
    );
    return false;
  }
  const moved = git(input.clone, "rev-parse", "HEAD").stdout.trim();
  input.options.log(`fast-forwarded ${input.clone} to ${moved.slice(0, 12)}\n`);
  return true;
};

/**
 * Write `start-<agent>.sh` through the shell template in the coordination
 * install, which `githooks/post-merge` also sources. One template, two callers:
 * a second copy of it drifted from the first within a day the last time this
 * project kept two.
 */
export const writeAgentLauncher = (input: {
  installRoot: string;
  clone: string;
  agent: string;
  label: string;
  baseBranch: string;
  options: EffectOptions;
}): void => {
  const library = join(input.installRoot, "scripts", "lib", "launcher.sh");
  if (!existsSync(library)) {
    throw new Error(`Launcher template ${library} is missing from the coordination install.`);
  }
  const target = join(input.clone, `start-${input.agent}.sh`);
  // Render through the template first and compare, so re-running the installer
  // to repair something else is not reported as a launcher change.
  // Staged outside the worktree: rendering inside it made `--dry-run` write a
  // file, and a crash between render and cleanup left a dotfile the managed
  // exclude does not match, which then made the clone dirty.
  const stagingDir = mkdtempSync(join(tmpdir(), "coord-launcher-"));
  const staging = join(stagingDir, `start-${input.agent}.sh`);
  const render = spawnSync(
    "bash",
    ["-c", '. "$1"; write_launcher "$2" "$3" "$4" "$5"', "_", library, staging, input.agent, input.label, input.baseBranch],
    { encoding: "utf8" }
  );
  if ((render.status ?? 1) !== 0) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw new Error(
      `No launch command is defined for agent '${input.agent}'. Add one to launcher_command() in ${library}. ` +
        `${render.stderr ?? ""}`.trim()
    );
  }
  const rendered = readFileSync(staging, "utf8");
  rmSync(stagingDir, { recursive: true, force: true });

  if (existsSync(target) && readFileSync(target, "utf8") === rendered) {
    input.options.log(`launcher already current at ${target}\n`);
    return;
  }
  act(input.options, `write launcher ${target}`, () => {
    writeFileSync(target, rendered, "utf8");
    chmodSync(target, 0o755);
  });
};

export const writeCloneExclude = (clone: string, options: EffectOptions): void => {
  const excludePath = join(clone, ".git", "info", "exclude");
  const outcome = writeManagedIgnoreFile(excludePath, DEFAULT_CLONE_IGNORES, { dryRun: options.dryRun });
  if (!outcome.changed) {
    options.log(`clone exclude already current at ${excludePath}\n`);
    return;
  }
  options.changes.push(`update ${excludePath}`);
  options.log(`${options.dryRun ? "would update" : "updated"} ${excludePath}\n`);
};

export const clearCloneExclude = (clone: string, options: EffectOptions): void => {
  const excludePath = join(clone, ".git", "info", "exclude");
  const outcome = clearManagedIgnoreFile(excludePath, { dryRun: options.dryRun });
  if (!outcome.changed) return;
  options.changes.push(`remove the managed block from ${excludePath}`);
  options.log(`${options.dryRun ? "would remove" : "removed"} the managed block from ${excludePath}\n`);
};

export type CloneIdentity = {
  agent: string;
  label: string;
  baseBranch: string;
  remoteName: string;
  /**
   * Null for a vendored clone, whose hook bodies are copies rather than shims.
   * Leaving the key set there would give `githooks/post-merge` two candidate
   * launcher templates and no rule for choosing between them — exactly the
   * "which copy is authoritative" ambiguity this design exists to remove.
   */
  installRoot: string | null;
  cliEntry: string;
  workspaceConfig: string;
};

const IDENTITY_KEYS: readonly string[] = [
  "consensus.agentId",
  "consensus.agentLabel",
  "consensus.sharedBranch",
  "consensus.remoteName",
  INSTALL_ROOT_KEY,
  CLI_ENTRY_KEY,
  WORKSPACE_CONFIG_KEY
];

export const configureCloneIdentity = (clone: string, identity: CloneIdentity, options: EffectOptions): void => {
  const desired: Array<[string, string | null]> = [
    ["consensus.agentId", identity.agent],
    ["consensus.agentLabel", identity.label],
    ["consensus.sharedBranch", identity.baseBranch],
    ["consensus.remoteName", identity.remoteName],
    [INSTALL_ROOT_KEY, identity.installRoot],
    [CLI_ENTRY_KEY, identity.cliEntry],
    [WORKSPACE_CONFIG_KEY, identity.workspaceConfig]
  ];
  const stale = desired.filter(([key, value]) => localConfigGet(clone, key) !== value);
  if (stale.length === 0) {
    options.log(`clone identity already current in ${clone}\n`);
    return;
  }
  act(options, `record ${stale.map(([key]) => key).join(", ")} in ${clone}`, () => {
    for (const [key, value] of stale) {
      if (value === null) localConfigUnset(clone, key);
      else localConfigSet(clone, key, value);
    }
  });
};

export const clearCloneIdentity = (clone: string, options: EffectOptions): void => {
  const present = IDENTITY_KEYS.filter((key) => localConfigGet(clone, key) !== null);
  if (present.length === 0) return;
  act(options, `clear ${present.join(", ")} in ${clone}`, () => {
    for (const key of present) localConfigUnset(clone, key);
  });
};

export type CloneDeletion = { clone: string; deleted: boolean; reason?: string };

export const cloneIsDirty = (clone: string): boolean => existsSync(clone) && hasUncommittedChanges(clone);

export const productTrackedTreeIsClean = (productRoot: string): boolean =>
  git(productRoot, "status", "--porcelain").stdout.trim() === "";

/** Reject layouts `coord start` would later refuse, before anything is written. */
export const assertContainment = (input: {
  productRoot: string;
  coordRoot: string;
  cloneRoot: string;
}): void => {
  const product = resolve(input.productRoot);
  const coord = resolve(input.coordRoot);
  const clones = resolve(input.cloneRoot);
  if (isPathInside(coord, product) || isPathInside(product, coord)) {
    throw new Error(
      `The owner runtime ${coord} and the product ${product} must not contain each other. Choose an external --coord-root.`
    );
  }
  // The clone root is only a parent directory to put clones in, and the normal
  // layout puts the runtime beside the clones under one workspace directory.
  // What must not overlap is the runtime and an individual agent clone, which
  // `resolveSafeCoordRoot` checks against the resolved clone paths themselves.
  if (isPathInside(clones, coord) && isPathInside(coord, clones)) {
    throw new Error(`--clone-root ${clones} and the owner runtime ${coord} must not be the same directory.`);
  }
  if (isPathInside(product, clones)) {
    throw new Error(`--clone-root ${clones} must not live inside the product ${product}.`);
  }
};

export const productName = (productRoot: string): string => basename(resolve(productRoot));
