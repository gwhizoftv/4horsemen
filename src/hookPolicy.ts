import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { git, localConfigGet } from "./gitExec.js";
import { issueRuntimePaths } from "./paths.js";
import {
  readConfig,
  readCursorsState,
  readStartState,
  type CheckCommand,
  type CoordinatorConfig,
  type VerifyConfig,
  type VerifyPhase
} from "./state.js";
import { selectVerification, type ChangeInput } from "./changeClassification.js";
import { verificationMeasurement, type VerificationMeasurement } from "./verificationLog.js";
import { workspaceLocationFromConfig } from "./workspace.js";

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
        "  Fix: coord install --product <product> --coord-root <runtime> --agents <agents>"
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

export type HookBinding =
  | { bound: true; issue: number; commands: VerifyConfig }
  | { bound: false; reason: string };

/** The branch this hook invocation is actually about, from Git, never from HEAD guesses. */
const hookBranch = (input: { clone: string; phase: VerifyPhase; refs?: string }): { branch: string } | { reason: string } => {
  if (input.phase === "precommit") {
    const head = git(input.clone, "symbolic-ref", "--quiet", "--short", "HEAD");
    if (head.exitCode !== 0) return { reason: "HEAD is detached" };
    const branch = head.stdout.trim();
    return branch === "" ? { reason: "HEAD names no branch" } : { branch };
  }
  const lines = (input.refs ?? "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) return { reason: "no outgoing refs were supplied" };
  // One push can update several branches; a single issue's coordinated list
  // cannot speak for all of them, so the local lists run instead.
  if (lines.length > 1) return { reason: "multi-ref push" };
  const fields = (lines[0] as string).split(/\s+/);
  const matched = /^refs\/heads\/(.+)$/.exec(fields[2] ?? "");
  if (fields.length !== 4 || matched?.[1] === undefined) return { reason: "unrecognized outgoing ref line" };
  return { branch: matched[1] };
};

/**
 * Whether this clone's hooks may run the coordinated (cheap) lists instead of
 * the local ones.
 *
 * Binding requires a provably active coordinator run that owns this exact
 * clone on this exact branch. Every failure — a missing runtime, a corrupt
 * state file, a completed issue, a manual branch, a multi-ref push, any
 * exception at all — falls back to the local lists with a printed reason. A
 * missing runtime never means "skip the checks".
 */
export const resolveHookBinding = (input: {
  clone: string;
  configPath: string;
  phase: VerifyPhase;
  refs?: string;
}): HookBinding => {
  try {
    const agent = localConfigGet(input.clone, "consensus.agentId");
    if (agent === null) return { bound: false, reason: "this clone declares no consensus.agentId" };
    const branch = hookBranch(input);
    if (!("branch" in branch)) return { bound: false, reason: branch.reason };
    const matched = /^issue-(\d+)\/([a-z0-9-]+)$/.exec(branch.branch);
    if (matched === null) return { bound: false, reason: `${branch.branch} is not an issue branch` };
    if (matched[2] !== agent) return { bound: false, reason: "the branch agent is not this clone's agent" };
    const issue = Number(matched[1]);
    const paths = issueRuntimePaths(workspaceLocationFromConfig(input.configPath).workspaceRoot, issue);
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    if (!start.agents.some((entry) => entry.id === agent && resolve(entry.root) === resolve(input.clone))) {
      return { bound: false, reason: `issue ${issue} does not run ${agent} from this clone` };
    }
    if (start.verification?.mode !== "coordinator") {
      return { bound: false, reason: `issue ${issue} did not freeze coordinator verification` };
    }
    const commands = start.verification.coordinated;
    if (commands === undefined) return { bound: false, reason: `issue ${issue} declares no coordinated hook lists` };
    if (cursors.completed) return { bound: false, reason: `issue ${issue} is completed` };
    if (cursors.abandoned) return { bound: false, reason: `issue ${issue} is abandoned` };
    if (!cursors.activeRoster.includes(agent)) return { bound: false, reason: `${agent} is not on issue ${issue}'s active roster` };
    return { bound: true, issue, commands };
  } catch (error) {
    return { bound: false, reason: `no readable coordinator run (${error instanceof Error ? error.message : String(error)})` };
  }
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
  /**
   * Coordinated lists for a bound coordinator run. Present only when
   * `resolveHookBinding` proved the run owns this clone and branch; the
   * undeclared-`verify` refusal does not apply, because the issue declared
   * what runs here.
   */
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
