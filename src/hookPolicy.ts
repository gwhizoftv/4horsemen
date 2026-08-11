import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { localConfigGet } from "./gitExec.js";
import { readConfig, type CheckCommand, type CoordinatorConfig, type VerifyPhase } from "./state.js";

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
        "  Coordination hooks are present here, so this is an agent clone and must not commit ungated.\n" +
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
        '  To opt out deliberately, declare both phases empty: "verify": { "precommit": [], "prepush": [] }'
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
}): VerifyRunResult => {
  const runner = input.runner ?? inheritRunner;
  const commands = verifyCommands(input.config, input.phase);
  if (commands.length === 0) {
    input.log(`coord ${input.phase}: no commands declared for this project (explicit empty verify).\n`);
    return { ok: true };
  }
  for (const command of commands) {
    input.log(`coord ${input.phase}: ${command.name} — ${command.argv.join(" ")}\n`);
    const exitCode = runner(command, input.clone);
    if (exitCode !== 0) return { ok: false, failed: command, exitCode };
  }
  return { ok: true };
};

/**
 * The pre-push scope filter, as line-oriented output the hook can read without
 * a JSON parser. An empty declaration means no narrowing is declared, so every
 * push is in scope — absence must never quietly shrink what gets gated.
 */
export const renderHookScope = (config: CoordinatorConfig): string => {
  const lines = [
    ...config.workflowCriticalPrefixes.map((prefix) => `prefix\t${prefix}`),
    ...config.workflowCriticalFiles.map((file) => `file\t${file}`)
  ];
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
};
