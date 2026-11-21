import { spawn } from "node:child_process";
import { constants, copyFileSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { gitShaSchema, repositoryPathSchema } from "./protocol.js";
import { validatePhasePin, type PinValidationResult } from "./pinValidation.js";
import { explainGitHubAuthFailure, gitCredentialArgs, AUTHOR_KEYS, AUTHOR_RECEIPT_KEY, gitAuthorSettings, gitAuthorEdits, type GitHubProfile } from "./githubAuth.js";

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

const identityEnvKeys = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_DATE",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_DATE"
] as const;

export const hermeticGitEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (repositoryRedirectors.has(key) || key === "GIT_CONFIG" || key.startsWith("GIT_CONFIG_")) delete env[key];
  }
  // Ambient identity overrides `-c user.*` and would poison evidence authorship.
  for (const key of identityEnvKeys) delete env[key];
  return env;
};

export const runGitCommand: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd ?? tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...hermeticGitEnv(), ...options.env }
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
  private issueProfile?: GitHubProfile;

  /**
   * `auth` binds every mirror Git call to a workspace's GitHub account (#227)
   * through one-shot `-c` helper settings, so an existing mirror needs no
   * re-initialisation and a resumed issue keeps the account it started with.
   */
  constructor(
    readonly path: string,
    readonly origin: string,
    private readonly runner: GitRunner = runGitCommand,
    private readonly auth: { account: string; cliEntry: string; profile?: GitHubProfile } | null = null
  ) {
    this.issueProfile = auth?.profile;
  }

  private async git(args: readonly string[], allowFailure = false): Promise<CommandResult> {
    const authArgs = this.auth === null ? [] : gitCredentialArgs(this.auth.account, this.auth.cliEntry);
    const raw = await this.runner([...authArgs, "--git-dir", this.path, ...args]);
    const result = this.auth === null || raw.exitCode === 0
      ? raw
      : { ...raw, stderr: explainGitHubAuthFailure(this.auth.account, raw.stderr) };
    if (!allowFailure && result.exitCode !== 0) {
      throw new GitCommandError(`git ${args[0] ?? "command"} failed: ${result.stderr}`, result, isTransientGitFailure(result.stderr));
    }
    return result;
  }

  private async configValue(args: string[]): Promise<string | null> {
    const result = await this.git(["config", ...args], true);
    if (result.exitCode === 1) return null;
    if (result.exitCode !== 0) throw new GitCommandError(`Cannot read Git config: ${result.stderr}`, result, false);
    return result.stdout.toString("utf8").replace(/\n$/, "");
  }

  /** Undefined keeps existing workspace defaults; null restores ambient attribution. */
  async initialize(profile?: GitHubProfile | null): Promise<void> {
    this.issueProfile = this.auth?.profile ?? profile ?? undefined;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) {
      const initialized = await this.runner(["init", "--bare", this.path]);
      if (initialized.exitCode !== 0) {
        throw new GitCommandError(`cannot initialize bare mirror: ${initialized.stderr}`, initialized, false);
      }
      await this.git(["remote", "add", "origin", this.origin]);
    } else {
      const remote = await this.git(["remote", "get-url", "origin"], true);
      if (remote.exitCode !== 0) await this.git(["remote", "add", "origin", this.origin]);
      else if (remote.stdout.toString("utf8").trim() !== this.origin) await this.git(["remote", "set-url", "origin", this.origin]);
    }
    if (profile !== undefined) {
      const saved = await this.configValue(["--local", "--get", AUTHOR_RECEIPT_KEY]);
      if (!profile && !saved) return;
      const current = new Map<string, string | null>([[AUTHOR_RECEIPT_KEY, saved]]);
      for (const key of AUTHOR_KEYS) current.set(key, await this.configValue(["--local", "--get", key]));
      for (const [key, value] of gitAuthorEdits(profile ?? undefined, current)) {
        if (value === null) await this.git(["config", "--local", "--unset-all", key]);
        else await this.git(["config", "--local", key, value]);
      }
    }
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

  async readBlob(sha: string, path: string, options: { regularFileOnly?: boolean } = {}): Promise<string | null> {
    gitShaSchema.parse(sha);
    repositoryPathSchema.parse(path);
    if (options.regularFileOnly) {
      const entry = await this.git(["--literal-pathspecs", "ls-tree", "-z", sha, "--", path], true);
      if (entry.exitCode !== 0 || !/^(100644|100755) blob [a-f0-9]{40}\t[^\0]+\0$/.test(entry.stdout.toString("utf8"))) return null;
    }
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

  private async enableWorktreeConfig(): Promise<void> {
    // Git applies core.bare to every checkout once the extension is enabled.
    // Stage the common config under Git's normal writer lock so other readers
    // see the original or the migrated config, including all unrelated keys.
    const config = join(this.path, "config");
    const lock = `${config}.lock`;
    const deadline = Date.now() + 5000;
    for (;;) {
      // A competing issue can finish the migration while we wait for Git's lock.
      if (await this.configValue(["--local", "--bool", "--get", "extensions.worktreeConfig"]) === "true") return;
      try {
        copyFileSync(config, lock, constants.COPYFILE_EXCL);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() >= deadline) throw error;
        await delay(20);
      }
    }
    try {
      for (const key of ["core.bare", "core.worktree"]) {
        const value = await this.configValue(["--file", lock, "--get", key]);
        if (value === null) continue;
        await this.git(["config", "--file", join(this.path, "config.worktree"), key, value]);
        await this.git(["config", "--file", lock, "--unset-all", key]);
      }
      const version = await this.configValue(["--file", lock, "--int", "--get", "core.repositoryformatversion"]);
      if (version === null || version === "0") {
        await this.git(["config", "--file", lock, "core.repositoryformatversion", "1"]);
      }
      await this.git(["config", "--file", lock, "extensions.worktreeConfig", "true"]);
      renameSync(lock, config);
    } catch (error) {
      rmSync(lock, { force: true });
      throw error;
    }
  }

  async materializeWorktree(target: string, sha: string): Promise<void> {
    gitShaSchema.parse(sha);
    const profile = this.auth ? this.issueProfile : undefined;
    if (profile) await this.enableWorktreeConfig();
    await this.git(["worktree", "add", "--detach", target, sha]);
    if (!profile) return;
    try {
      // This issue keeps its verified author if onboarding later changes the
      // workspace defaults shared by linked worktrees.
      for (const [key, value] of gitAuthorSettings(profile)) {
        const result = await this.runner(["-C", target, "config", "--worktree", key, value]);
        if (result.exitCode !== 0) throw new GitCommandError(`Cannot configure ${key}: ${result.stderr}`, result, false);
      }
    } catch (error) {
      await this.removeWorktree(target);
      throw error;
    }
  }

  async removeWorktree(target: string): Promise<void> {
    await this.git(["worktree", "remove", "--force", target], true);
    await this.git(["worktree", "prune"], true);
  }

  async publishBranch(sha: string, branch: string): Promise<void> {
    gitShaSchema.parse(sha);
    if (!branchPattern.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      throw new Error(`Invalid publication branch ${branch}.`);
    }
    await this.git(["push", "origin", `${sha}:refs/heads/${branch}`]);
  }
}
