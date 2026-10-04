import { spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { hermeticGitEnv } from "./mirror.js";

export type GitResult = { exitCode: number; stdout: string; stderr: string };

/** Follow directory symlinks; do not confuse a bad cwd with a missing Git binary. */
const workingDirectoryProblem = (cwd: string): string | null => {
  try {
    if (!statSync(cwd).isDirectory()) return "working directory is not a directory";
    accessSync(cwd, constants.X_OK);
    return null;
  } catch (error) {
    const { code, message } = error as NodeJS.ErrnoException;
    if (code === "ENOENT") return "working directory does not exist";
    if (code === "ENOTDIR") return "working directory is not a directory";
    if (code === "EACCES" || code === "EPERM") return `working directory is inaccessible: ${message}`;
    return `cannot inspect working directory: ${message}`;
  }
};

/**
 * Synchronous git for the installer. `coord install` is an operator-driven,
 * one-shot command with a strictly ordered set of effects; the run loop's async
 * runner exists to interleave agents, which is not what this needs.
 *
 * The environment is scrubbed exactly as the mirror and run loop scrub theirs.
 * An inherited `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG_*` would redirect
 * worktree detection, remote discovery, and local-config writes away from the
 * explicit paths the installer was given, which is how containment checks come
 * to pass while the wrong repository gets wired.
 */
export const git = (cwd: string, ...args: readonly string[]): GitResult => {
  const context = `Cannot run git ${args.join(" ")} in ${cwd}`;
  const problem = workingDirectoryProblem(cwd);
  if (problem !== null) throw new Error(`${context}: ${problem}`);
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: hermeticGitEnv() });
  if (result.error !== undefined) {
    // Best-effort recheck: cwd may have disappeared after preflight. Never retry
    // in another directory. Keep OS detail secondary to the path/PATH diagnosis.
    const reason = workingDirectoryProblem(cwd) ??
      ((result.error as NodeJS.ErrnoException).code === "ENOENT" ? "could not find or launch git; check PATH" : null);
    throw new Error(`${context}: ${reason === null ? "" : `${reason}; detail: `}${result.error.message}`);
  }
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
};

export const gitOrThrow = (cwd: string, ...args: readonly string[]): string => {
  const result = git(cwd, ...args);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return result.stdout.trim();
};

/**
 * Read one key from a clone's LOCAL config. `--local` is deliberate throughout
 * the installer for the same reason the hooks use it: a machine-wide setting
 * must never be able to supply an agent identity or an install root.
 */
export const localConfigGet = (clone: string, key: string): string | null => {
  const result = git(clone, "config", "--local", "--get", key);
  if (result.exitCode !== 0) return null;
  const value = result.stdout.trim();
  return value === "" ? null : value;
};

export const localConfigSet = (clone: string, key: string, value: string): void => {
  gitOrThrow(clone, "config", "--local", key, value);
};

export const localConfigUnset = (clone: string, key: string): void => {
  const result = git(clone, "config", "--local", "--unset-all", key);
  // Exit code 5 is "key did not exist", which is the state we are asking for.
  if (result.exitCode !== 0 && result.exitCode !== 5) {
    throw new Error(`git config --unset ${key} failed in ${clone}: ${result.stderr.trim()}`);
  }
};

export const isGitWorktree = (path: string): boolean =>
  git(path, "rev-parse", "--is-inside-work-tree").stdout.trim() === "true";

export const worktreeRoot = (path: string): string | null => {
  const result = git(path, "rev-parse", "--show-toplevel");
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

export const gitDir = (clone: string): string => gitOrThrow(clone, "rev-parse", "--absolute-git-dir");

export const hasUncommittedChanges = (clone: string): boolean =>
  git(clone, "status", "--porcelain").stdout.trim() !== "";
