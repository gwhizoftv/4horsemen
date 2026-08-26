import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { assertNoSymlink, containedPath } from "./paths.js";
import { gitShaSchema, repositoryPathSchema } from "./protocol.js";
import { validatePhasePin, type PinValidationResult } from "./pinValidation.js";

export type CommandResult = { exitCode: number; stdout: Buffer; stderr: string };
export type GitRunner = (
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
) => Promise<CommandResult>;

const repositoryRedirectors = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM"
]);

export const hermeticGitEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (repositoryRedirectors.has(key) || key === "GIT_CONFIG" || key.startsWith("GIT_CONFIG_")) delete env[key];
  }
  return env;
};

export const runGitCommand: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd ?? tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: hermeticGitEnv(options.env ?? process.env)
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString("utf8").trim()
      })
    );
  });

export class GitCommandError extends Error {
  override readonly name = "GitCommandError";
  constructor(
    message: string,
    readonly result: CommandResult,
    readonly transient: boolean
  ) {
    super(message);
  }
}

export const isTransientGitFailure = (stderr: string): boolean =>
  /timed out|timeout|could not resolve host|connection reset|connection refused|network is unreachable|remote end hung up|http 5\d\d|429|529|temporary failure|tls/i.test(
    stderr
  );

const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

export type FetchResult = { ok: true; ref: string; tip: string } | { ok: false; transient: boolean; error: string };

export class BareMirror {
  constructor(
    readonly path: string,
    readonly origin: string,
    private readonly runner: GitRunner = runGitCommand
  ) {}

  private async git(args: readonly string[], allowFailure = false): Promise<CommandResult> {
    const result = await this.runner(["--git-dir", this.path, ...args]);
    if (!allowFailure && result.exitCode !== 0) {
      throw new GitCommandError(`git ${args[0] ?? "command"} failed: ${result.stderr}`, result, isTransientGitFailure(result.stderr));
    }
    return result;
  }

  private async worktreeGit(
    target: string,
    args: readonly string[],
    options: { allowFailure?: boolean; env?: NodeJS.ProcessEnv } = {}
  ): Promise<CommandResult> {
    const result = await this.runner(["-C", target, ...args], { env: options.env });
    if (options.allowFailure !== true && result.exitCode !== 0) {
      throw new GitCommandError(
        `git ${args[0] ?? "command"} failed: ${result.stderr}`,
        result,
        isTransientGitFailure(result.stderr)
      );
    }
    return result;
  }

  async initialize(): Promise<void> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) {
      const initialized = await this.runner(["init", "--bare", this.path]);
      if (initialized.exitCode !== 0) {
        throw new GitCommandError(`cannot initialize bare mirror: ${initialized.stderr}`, initialized, false);
      }
      await this.git(["remote", "add", "origin", this.origin]);
      return;
    }
    const remote = await this.git(["remote", "get-url", "origin"], true);
    if (remote.exitCode !== 0) await this.git(["remote", "add", "origin", this.origin]);
    else if (remote.stdout.toString("utf8").trim() !== this.origin) await this.git(["remote", "set-url", "origin", this.origin]);
  }

  async fetchBranch(branch: string): Promise<FetchResult> {
    if (!branchPattern.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      return { ok: false, transient: false, error: `invalid branch name ${branch}` };
    }
    const ref = `refs/remotes/origin/${branch}`;
    const fetched = await this.git(
      ["fetch", "--no-tags", "--prune", "origin", `+refs/heads/${branch}:${ref}`],
      true
    );
    if (fetched.exitCode !== 0) {
      return { ok: false, transient: isTransientGitFailure(fetched.stderr), error: fetched.stderr };
    }
    const tip = await this.git(["rev-parse", "--verify", `${ref}^{commit}`], true);
    if (tip.exitCode !== 0) return { ok: false, transient: false, error: tip.stderr };
    return { ok: true, ref, tip: tip.stdout.toString("utf8").trim() };
  }

  async remoteTip(branch: string): Promise<string | null> {
    if (!branchPattern.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      throw new Error(`Invalid publication branch ${branch}.`);
    }
    const result = await this.git(["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
    const rows = result.stdout
      .toString("utf8")
      .trim()
      .split("\n")
      .filter((row) => row !== "");
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new Error(`Origin returned multiple tips for ${branch}.`);
    const [sha, ref] = (rows[0] as string).split("\t");
    if (ref !== `refs/heads/${branch}`) throw new Error(`Origin returned an unexpected ref for ${branch}.`);
    return gitShaSchema.parse(sha);
  }

  async commitExists(sha: string): Promise<boolean> {
    gitShaSchema.parse(sha);
    return (await this.git(["cat-file", "-e", `${sha}^{commit}`], true)).exitCode === 0;
  }

  async isReachable(sha: string, ref: string): Promise<boolean> {
    gitShaSchema.parse(sha);
    if (!ref.startsWith("refs/remotes/origin/")) throw new Error("Reachability must use an origin tracking ref.");
    return (await this.git(["merge-base", "--is-ancestor", sha, ref], true)).exitCode === 0;
  }

  async isAncestor(base: string, tip: string): Promise<boolean> {
    gitShaSchema.parse(base);
    gitShaSchema.parse(tip);
    return (await this.git(["merge-base", "--is-ancestor", base, tip], true)).exitCode === 0;
  }

  async readBlob(sha: string, path: string): Promise<string | null> {
    gitShaSchema.parse(sha);
    repositoryPathSchema.parse(path);
    const result = await this.git(["show", `${sha}:${path}`], true);
    if (result.exitCode !== 0) return null;
    return result.stdout.toString("utf8");
  }

  async changedPaths(base: string, tip: string): Promise<string[]> {
    gitShaSchema.parse(base);
    gitShaSchema.parse(tip);
    const result = await this.git(["diff", "--no-ext-diff", "--name-only", "-z", base, tip, "--"]);
    return result.stdout
      .toString("utf8")
      .split("\0")
      .filter((path) => path !== "");
  }

  async validatePhasePin(params: {
    pin: string;
    tip: string;
    issue: number;
    subject: string;
    ref: string;
  }): Promise<PinValidationResult> {
    return validatePhasePin({ root: this.path, ...params });
  }

  async materializeWorktree(target: string, sha: string): Promise<void> {
    gitShaSchema.parse(sha);
    await this.git(["worktree", "add", "--detach", target, sha]);
  }

  async removeWorktree(target: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", target], true);
    await this.git(["worktree", "prune"], true);
  }

  async createEvidenceCommit(input: {
    target: string;
    parentSha: string;
    files: ReadonlyMap<string, string | Uint8Array>;
    removePaths?: readonly string[];
    message: string;
    identity: { name: string; email: string };
    at?: string;
  }): Promise<string> {
    gitShaSchema.parse(input.parentSha);
    if (input.files.size === 0) throw new Error("An evidence commit must publish at least one file.");
    const touched = new Set<string>();
    for (const path of [...input.files.keys(), ...(input.removePaths ?? [])]) {
      repositoryPathSchema.parse(path);
      touched.add(path);
    }
    await this.materializeWorktree(input.target, input.parentSha);
    try {
      for (const path of input.removePaths ?? []) {
        const destination = containedPath(input.target, path);
        assertNoSymlink(input.target, destination);
        rmSync(destination, { force: true, recursive: true });
      }
      for (const [path, bytes] of input.files) {
        const destination = containedPath(input.target, path);
        assertNoSymlink(input.target, destination);
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        assertNoSymlink(input.target, dirname(destination));
        writeFileSync(destination, bytes, { mode: 0o600 });
      }
      await this.worktreeGit(input.target, ["add", "-A", "--", ...[...touched].sort()]);
      const date = input.at ?? new Date().toISOString();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_AUTHOR_NAME: input.identity.name,
        GIT_AUTHOR_EMAIL: input.identity.email,
        GIT_COMMITTER_NAME: input.identity.name,
        GIT_COMMITTER_EMAIL: input.identity.email,
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date
      };
      await this.worktreeGit(
        input.target,
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "--no-gpg-sign",
          "-m",
          input.message
        ],
        { env }
      );
      const tip = await this.worktreeGit(input.target, ["rev-parse", "--verify", "HEAD^{commit}"]);
      return gitShaSchema.parse(tip.stdout.toString("utf8").trim());
    } finally {
      await this.removeWorktree(input.target);
      rmSync(input.target, { recursive: true, force: true });
    }
  }

  async publishBranch(sha: string, branch: string): Promise<void> {
    gitShaSchema.parse(sha);
    if (!branchPattern.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      throw new Error(`Invalid publication branch ${branch}.`);
    }
    await this.git(["push", "origin", `${sha}:refs/heads/${branch}`]);
  }
}
