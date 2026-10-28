import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { readAction, type PublicAction } from "./action.js";
import { git, localConfigGet } from "./gitExec.js";
import { agentRuntimePaths, issueRuntimePaths, type IssueRuntimePaths } from "./paths.js";
import {
  readConfig,
  readCursorsState,
  readStartState,
  type CheckCommand,
  type CoordinatorConfig,
  type CursorsState,
  type StartState,
  type VerifyConfig,
  type VerifyPhase
} from "./state.js";
import { workspaceLocationFromConfig } from "./workspace.js";
import { selectVerification, type ChangeInput } from "./changeClassification.js";
import { verificationMeasurement, type VerificationMeasurement } from "./verificationLog.js";

/**
 * The bridge between the shell hook bodies and the workspace config.
 *
 * The hooks used to decide what to run by sniffing for `package.json`, a
 * lockfile, and a script *name*, which silently ran nothing at all on a Rust or
 * Go product — a guard that is skipped reports success. Now every hook body
 * asks this module, which reads argument vectors the project declared, and
 * which fails closed when the project declared nothing.
 *
 * Parsing JSON here rather than in bash is the point: one parser, covered by
 * `pnpm check`, shared with `coord start`, so the hooks and the driver cannot
 * disagree about what a workspace config means.
 */

export const WORKSPACE_CONFIG_KEY = "coord.workspaceConfig";
export const INSTALL_ROOT_KEY = "coord.installRoot";
export const CLI_ENTRY_KEY = "coord.cliEntry";

export class HookPolicyError extends Error {
  override readonly name = "HookPolicyError";
}

export type ResolvedWorkspace = { configPath: string; config: CoordinatorConfig };

/** Locate and parse the workspace config a clone was installed against. */
export const resolveWorkspaceConfig = (clone: string): ResolvedWorkspace => {
  const configPath = localConfigGet(clone, WORKSPACE_CONFIG_KEY);
  if (configPath === null) {
    throw new HookPolicyError(
      `This clone has no local ${WORKSPACE_CONFIG_KEY}, so the project's declared verification cannot be located.\n` +
        "  Coordination hooks are present here, so this is an agent clone and must not commit without running the project's declared checks.\n" +
        "  Fix: coord install --product <product> --coord-runtime <runtime> --agents <agents>"
    );
  }
  if (!isAbsolute(configPath)) {
    throw new HookPolicyError(`${WORKSPACE_CONFIG_KEY} must be an absolute path; got '${configPath}'.`);
  }
  if (!existsSync(configPath)) {
    throw new HookPolicyError(
      `${WORKSPACE_CONFIG_KEY} points at '${configPath}', which does not exist.\n` +
        "  The owner runtime was moved or removed. Fix: coord install … or coord uninstall … for this clone."
    );
  }
  return { configPath, config: readConfig(configPath) };
};

/**
 * Commands for one hook phase.
 *
 * An absent `verify` is an error, not a skip: a project with no local checks
 * must say so with explicit empty arrays, so that "nothing runs here" is a
 * recorded decision rather than an accident of file layout. This governs agent
 * clones only — a human clone has no coordination hooks and never reaches here.
 */
export const verifyCommands = (config: CoordinatorConfig, phase: VerifyPhase): readonly CheckCommand[] => {
  if (config.verify === undefined) {
    throw new HookPolicyError(
      "The workspace config declares no `verify`, so this clone cannot know how to check the project.\n" +
        "  Declare argument vectors, for example:\n" +
        '    "verify": { "precommit": [{ "name": "test", "argv": ["go", "test", "./..."] }], "prepush": [] }\n' +
        '  To opt out deliberately, declare both lists empty: "verify": { "precommit": [], "prepush": [] }'
    );
  }
  return config.verify[phase];
};

const isExecutableFile = (path: string): boolean => {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
};

/**
 * Resolve a declared command exactly as the hook will spawn it: with the clone
 * as the working directory, and requiring an executable file.
 *
 * Checking mere existence against the caller's own directory reported a
 * relative `./scripts/check.sh` as missing when run from the runtime, and
 * accepted a directory or a non-executable file that the first hook then failed
 * to spawn.
 */
const resolves = (command: string, cwd: string): boolean => {
  if (command.includes("/")) return isExecutableFile(resolve(cwd, command));
  const entries = (process.env.PATH ?? "").split(delimiter).filter((entry) => entry !== "");
  return entries.some((entry) => isExecutableFile(join(entry, command)));
};

/**
 * Which declared `argv[0]` values cannot be resolved right now, checked against
 * the clone the hooks will run in.
 */
export const unresolvableCommands = (config: CoordinatorConfig, cwd: string): string[] => {
  const commands = [
    ...(config.verify?.precommit ?? []),
    ...(config.verify?.prepush ?? []),
    ...(config.documentation?.verify.precommit ?? []),
    ...(config.documentation?.verify.prepush ?? []),
    ...(config.documentation?.checks ?? []),
    ...(config.verification?.coordinated?.precommit ?? []),
    ...(config.verification?.coordinated?.prepush ?? []),
    ...(config.verification?.candidate?.checks ?? []),
    ...config.checks
  ];
  const missing = new Set<string>();
  for (const command of commands) {
    const executable = command.argv[0] as string;
    if (!resolves(executable, cwd)) missing.add(executable);
  }
  return [...missing].sort();
};

export type HookBinding = { bound: true; issue: number; commands: VerifyConfig } | { bound: false; reason: string };

type IssueBranchContext = {
  issue: number;
  agent: string;
  paths: IssueRuntimePaths;
  start: StartState;
  cursors: CursorsState;
};

/** `branch` is this agent's issue branch, on an issue whose start state runs this exact clone. Throws on unreadable state. */
const issueBranchContext = (clone: string, configPath: string, branch: string): IssueBranchContext | { reason: string } => {
  const agent = localConfigGet(clone, "consensus.agentId");
  const match = /^issue-([1-9][0-9]*)\/([a-z0-9-]+)$/.exec(branch);
  if (match === null || agent === null || match[2] !== agent) return { reason: `branch ${branch} is not this agent's issue branch` };
  const issue = Number(match[1]);
  const paths = issueRuntimePaths(workspaceLocationFromConfig(configPath).workspaceRoot, issue);
  const start = readStartState(paths);
  const cursors = readCursorsState(paths);
  if (!start.agents.some((entry) => entry.id === agent && resolve(entry.root) === resolve(clone))) {
    return { reason: `issue ${issue} does not run this clone` };
  }
  return { issue, agent, paths, start, cursors };
};

/**
 * Coordinated hook lists apply only to a provably active coordinator run for
 * this exact clone: the committed or single pushed branch is this agent's
 * issue branch, that issue's frozen policy is coordinator mode, the run is
 * neither completed nor abandoned, and the agent is still on the roster. Any
 * other answer, including unreadable runtime state, keeps the local lists.
 */
export const resolveHookBinding = (input: {
  clone: string;
  configPath: string;
  phase: VerifyPhase;
  /** Pre-push ref lines exactly as Git supplied them on stdin. */
  refs?: string;
}): HookBinding => {
  try {
    let branch: string;
    if (input.phase === "precommit") {
      const head = git(input.clone, "symbolic-ref", "--quiet", "--short", "HEAD");
      if (head.exitCode !== 0) return { bound: false, reason: "detached HEAD" };
      branch = head.stdout.trim();
    } else {
      const lines = (input.refs ?? "").split("\n").filter((line) => line.trim() !== "");
      if (lines.length !== 1) return { bound: false, reason: lines.length === 0 ? "no outgoing ref" : "multi-ref push" };
      const remoteRef = lines[0]!.trim().split(/\s+/)[2] ?? "";
      if (!remoteRef.startsWith("refs/heads/")) return { bound: false, reason: "outgoing ref is not a branch" };
      branch = remoteRef.slice("refs/heads/".length);
    }
    const context = issueBranchContext(input.clone, input.configPath, branch);
    if ("reason" in context) return { bound: false, reason: context.reason };
    const { issue, agent, start, cursors } = context;
    const coordinated = start.verification?.mode === "coordinator" ? start.verification.coordinated : undefined;
    if (coordinated === undefined) return { bound: false, reason: `issue ${issue} is not in coordinator verification mode` };
    if (cursors.completed || cursors.abandoned) return { bound: false, reason: `issue ${issue} is no longer active` };
    if (!cursors.activeRoster.includes(agent)) return { bound: false, reason: `${agent} is not on issue ${issue}'s active roster` };
    return { bound: true, issue, commands: coordinated };
  } catch (error) {
    return { bound: false, reason: `runtime state unavailable (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
  }
};

export type ArtifactCheck = { ok: true } | { ok: false; message: string };

/** Cursor states in which the agent still owes the current Git action's artifact. */
const OWED_ACTION_STATUSES: ReadonlySet<string> = new Set(["ordered", "intent", "verifying", "failed", "paused"]);
/** These steps push the product commit before the signal that pins it exists. */
const PRODUCT_BEFORE_SIGNAL_STEPS: ReadonlySet<string> = new Set(["R4.implement", "R6.revise"]);
const ZERO_SHA = "0".repeat(40);

/** Path-scoped plumbing: `--literal-pathspecs` keeps a glob-like artifact name from matching other paths. */
const plumbing = (clone: string, ...args: string[]): string => {
  const result = git(clone, "--literal-pathspecs", ...args);
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  return result.stdout;
};

const nulRecords = (stdout: string): string[] => stdout.split("\0").filter((record) => record !== "");

/** What is wrong with `path` as the artifact published by pushing `sha`, or null when it is exactly committed. */
const artifactProblem = (clone: string, sha: string, path: string, stepId: string | null): string | null => {
  const tree = nulRecords(plumbing(clone, "ls-tree", "-z", "--full-tree", sha, "--", path))
    .map((record) => /^(\d+) (\w+) ([0-9a-f]+)\t([\s\S]*)$/.exec(record))
    .find((match) => match?.[4] === path) ?? null;
  const index = nulRecords(plumbing(clone, "ls-files", "-z", "--stage", "--", path))
    .map((record) => /^(\d+) ([0-9a-f]+) (\d)\t([\s\S]*)$/.exec(record))
    .filter((match): match is RegExpExecArray => match?.[4] === path);
  let worktree: "absent" | "file" | "other" = "absent";
  try {
    worktree = lstatSync(join(clone, path)).isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (tree === null) {
    // An intermediate product push precedes the signal; an existing signal must already be committed.
    if (index.length === 0 && worktree === "absent" && stepId !== null && PRODUCT_BEFORE_SIGNAL_STEPS.has(stepId)) return null;
    if (index.length > 0) return "it is staged but not committed";
    return worktree === "absent" ? "it is missing" : "it is untracked";
  }
  if (tree[2] !== "blob" || !["100644", "100755"].includes(tree[1]!)) return "the pushed commit holds it as something other than a regular file";
  if (index.some((match) => match[3] !== "0")) return "it has an unresolved merge conflict in the index";
  const staged = index[0];
  if (staged === undefined) return "its deletion is staged";
  if (staged[2] !== tree[3]) return "the index holds a different version than the pushed commit (staged changes, or the pushed commit is not the one you just made)";
  if (worktree === "absent") return "it is deleted from the working tree";
  if (worktree === "other") return "the working tree holds it as something other than a regular file";
  if (plumbing(clone, "hash-object", "--", path).trim() !== staged[2]) return "it has unstaged changes";
  return null;
};

/**
 * Pre-push publication guard for the current Git action.
 *
 * Applies to each outgoing update of this agent's own issue branch while the
 * issue's cursor says the agent owes a Git action, in either verification
 * mode. Everything else (manual branches, deletions, response actions,
 * inactive runs, unreadable runtime) keeps the hook's existing behaviour.
 * Once an owed action is established, an unreadable or mismatched action.md
 * and any inspection failure refuse the push rather than pass it.
 */
export const checkRequiredArtifact = (input: { clone: string; configPath: string; refs: string }): ArtifactCheck => {
  for (const line of input.refs.split("\n")) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/);
    if (localSha === undefined || remoteRef === undefined || localSha === ZERO_SHA || !remoteRef.startsWith("refs/heads/")) continue;
    let context: IssueBranchContext | { reason: string };
    try {
      context = issueBranchContext(input.clone, input.configPath, remoteRef.slice("refs/heads/".length));
    } catch {
      continue;
    }
    if ("reason" in context) continue;
    const { agent, paths, cursors } = context;
    const cursor = cursors.agents[agent];
    if (cursors.completed || cursors.abandoned || !cursors.activeRoster.includes(agent) || cursor === undefined ||
      cursor.actionId === null || cursor.submissionMode !== "git" || !OWED_ACTION_STATUSES.has(cursor.status)) continue;
    const refuse = (detail: string): ArtifactCheck => ({ ok: false, message: `${detail}\n` +
      "  Commit the required artifact, push that commit, and only after the push succeeds write its SHA to complete.\n" });
    let action: PublicAction;
    try {
      action = readAction(agentRuntimePaths(paths, agent).action);
    } catch (error) {
      return refuse(`current action ${cursor.actionId} could not be read: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}.`);
    }
    if (action.actionId.toLowerCase() !== cursor.actionId.toLowerCase() || action.agent !== agent || action.submissionMode !== "git") {
      return refuse(`action.md does not match current Git action ${cursor.actionId}; re-read it before publishing.`);
    }
    let problem: string | null;
    try {
      problem = artifactProblem(input.clone, localSha, action.requiredPath, cursor.stepId);
    } catch (error) {
      problem = `it could not be inspected (${error instanceof Error ? error.message.split("\n")[0] : String(error)})`;
    }
    if (problem !== null) {
      return refuse(`action ${action.actionId} requires ${JSON.stringify(action.requiredPath)} in pushed commit ${localSha}, but ${problem}.`);
    }
  }
  return { ok: true };
};

export type VerifyRunResult = { ok: true } | { ok: false; failed: CheckCommand; exitCode: number };

export type VerifyRunner = (command: CheckCommand, cwd: string) => number;

const inheritRunner: VerifyRunner = (command, cwd) => {
  const [executable, ...args] = command.argv;
  const result = spawnSync(executable as string, args, { cwd, stdio: "inherit" });
  if (result.error !== undefined) {
    throw new HookPolicyError(
      `Declared verify command '${command.name}' could not run: ${result.error.message}.\n` +
        `  argv: ${command.argv.join(" ")}\n` +
        "  Fix the declaration in the workspace config, or install the tool it names."
    );
  }
  return result.status ?? 1;
};

/** Run one phase's declared commands in order, stopping at the first failure. */
export const runVerifyPhase = (input: {
  clone: string;
  config: CoordinatorConfig;
  phase: VerifyPhase;
  log: (message: string) => void;
  runner?: VerifyRunner;
  changes?: ChangeInput;
  record?: (measurement: VerificationMeasurement) => void;
  /** Coordinated lists from a bound, active coordinator run (see resolveHookBinding). */
  bound?: VerifyConfig;
}): VerifyRunResult => {
  const runner = input.runner ?? inheritRunner;
  const selected = selectVerification(input.changes ?? { changes: null, identity: "unknown" }, input.config, input.phase,
    // The evidence exemption does not require a product verification declaration.
    input.bound?.[input.phase] ?? input.config.verify?.[input.phase] ?? []);
  if (selected.kind === "product" && input.bound === undefined) verifyCommands(input.config, input.phase);
  const { commands } = selected;
  const record = (command: CheckCommand | null, startedAt: string, exitCode: number, error?: string) => {
    input.record?.(verificationMeasurement({ trigger: "hook", phase: input.phase,
      inputIdentity: selected.inputIdentity, classification: selected.kind, reason: selected.reason,
      command, startedAt, completedAt: new Date().toISOString(), exitCode,
      skipReason: command === null ? selected.kind === "coordination" ? "coordination evidence only" : "explicit empty profile" : null,
      ...(error === undefined ? {} : { error }) }));
  };
  if (commands.length === 0) {
    input.log(`coord ${input.phase}: skipping declared checks — ${selected.reason} (no commands).\n`);
    record(null, new Date().toISOString(), 0);
    return { ok: true };
  }
  for (const command of commands) {
    input.log(`coord ${input.phase}: ${command.name} — ${command.argv.join(" ")}\n`);
    const startedAt = new Date().toISOString();
    let exitCode: number;
    try { exitCode = runner(command, input.clone); }
    catch (error) {
      record(command, startedAt, 1, String(error));
      throw error;
    }
    record(command, startedAt, exitCode);
    if (exitCode !== 0) return { ok: false, failed: command, exitCode };
  }
  return { ok: true };
};

/**
 * Legacy hook-scope wire format, retained for already-installed hook bodies.
 * Current hooks use selectVerification; do not reintroduce this older filter.
 */
export const renderHookScope = (config: CoordinatorConfig): string => {
  const lines = [
    ...config.workflowCriticalPrefixes.map((prefix) => `prefix\t${prefix}`),
    ...config.workflowCriticalFiles.map((file) => `file\t${file}`)
  ];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
};
