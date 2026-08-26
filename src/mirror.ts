import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gitShaSchema, repositoryPathSchema } from "./protocol.js";
import { validatePhasePin, type PinValidationResult } from "./pinValidation.js";

export type CommandResult = { exitCode: number; stdout: Buffer; stderr: string };
export type GitRunner = (args: readonly string[], options?: { cwd?: string }) => Promise<CommandResult>;

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

/**
 * Ambient identity, stripped alongside the repository redirectors.
 *
 * `GIT_AUTHOR_*` and `GIT_COMMITTER_*` outrank `-c user.name` / `-c user.email`,
 * so a coordinator running anywhere those are exported — a git hook, a CI step,
 * a shell that set them once — would stamp that identity onto its own evidence
 * commits. The whole point of a coordinator-authored commit is that it is
 * attributable to the driver and not to any person or voting agent, so the
 * identity has to come from this process rather than from its environment.
 */
const identityOverrides = ["NAME", "EMAIL", "DATE"].flatMap((field) => [
  `GIT_AUTHOR_${field}`,
  `GIT_COMMITTER_${field}`
]);

export const hermeticGitEnv = (source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = { ...source, GIT_TERMINAL_PROMPT: "0" };
  for (const key of Object.keys(env)) {
    if (
      repositoryRedirectors.has(key) ||
      identityOverrides.includes(key) ||
      key === "GIT_CONFIG" ||
      key.startsWith("GIT_CONFIG_")
    ) {
      delete env[key];
    }
  }
  return env;
};

export const runGitCommand: GitRunner = (args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd: options.cwd ?? tmpdir(),
      stdio: ["ignore", "pipe", "pipe"],
      env: hermeticGitEnv()
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

  /**
   * Origin's current tip for a branch, or null when the branch does not exist.
   *
   * `fetchBranch` cannot answer this: a missing remote ref and a network
   * failure both come back as `ok: false`, and guessing between them from the
   * stderr text is exactly the kind of inference that would make a transient
   * outage look like "the evidence branch has not been created yet" and reset
   * the parent to the baseline.
   */
  async remoteTip(
    branch: string
  ): Promise<{ ok: true; sha: string | null } | { ok: false; transient: boolean; error: string }> {
    if (!branchPattern.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      return { ok: false, transient: false, error: `invalid branch name ${branch}` };
    }
    const result = await this.git(["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], true);
    // 2 is ls-remote's documented "no matching refs": a definite answer, not a
    // failure.
    if (result.exitCode === 2) return { ok: true, sha: null };
    if (result.exitCode !== 0) {
      return { ok: false, transient: isTransientGitFailure(result.stderr), error: result.stderr };
    }
    const sha = result.stdout.toString("utf8").split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      return { ok: false, transient: false, error: `unreadable ls-remote output for ${branch}` };
    }
    return { ok: true, sha };
  }

  /**
   * Create one commit in a coordinator-owned detached worktree.
   *
   * A worktree rather than `hash-object`/`mktree` plumbing: those read their
   * input on stdin, which `runGitCommand` opens as `ignore`, so `mktree` would
   * see EOF, return the *empty tree*, and produce a commit that pushes
   * successfully while containing none of the ballots. A worktree also supplies
   * the index that nested canonical paths need.
   *
   * The worktree is always inside the coordinator runtime and never an agent
   * clone, and it is removed on every path including failure.
   */
  async createEvidenceCommit(input: {
    worktree: string;
    parentSha: string;
    files: readonly { path: string; content: string }[];
    message: string;
    identity: { name: string; email: string };
  }): Promise<string> {
    gitShaSchema.parse(input.parentSha);
    if (input.files.length === 0) throw new Error("An evidence commit must contain at least one ballot.");
    for (const file of input.files) repositoryPathSchema.parse(file.path);
    await this.materializeWorktree(input.worktree, input.parentSha);
    try {
      for (const file of input.files) {
        const absolute = join(input.worktree, file.path);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, file.content, "utf8");
      }
      const paths = input.files.map((file) => file.path);
      const added = await this.runner(["add", "--", ...paths], { cwd: input.worktree });
      if (added.exitCode !== 0) {
        throw new GitCommandError(`cannot stage evidence ballots: ${added.stderr}`, added, false);
      }
      const committed = await this.runner(
        [
          "-c",
          `user.name=${input.identity.name}`,
          "-c",
          `user.email=${input.identity.email}`,
          "commit",
          "-m",
          input.message
        ],
        { cwd: input.worktree }
      );
      if (committed.exitCode !== 0) {
        throw new GitCommandError(`cannot create the evidence commit: ${committed.stderr}`, committed, false);
      }
      const head = await this.runner(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: input.worktree });
      if (head.exitCode !== 0) {
        throw new GitCommandError(`cannot read the evidence commit: ${head.stderr}`, head, false);
      }
      const sha = head.stdout.toString("utf8").trim();
      gitShaSchema.parse(sha);
      // An empty tree is what a broken commit path produces while every exit
      // code still reports success, so the created object is proved to contain
      // the ballots rather than assumed to.
      const listed = await this.git(["ls-tree", "-r", "--name-only", sha], true);
      if (listed.exitCode !== 0) {
        throw new GitCommandError(`cannot inspect the evidence commit: ${listed.stderr}`, listed, false);
      }
      const present = new Set(listed.stdout.toString("utf8").split("\n").filter((line) => line !== ""));
      const missing = paths.filter((path) => !present.has(path));
      if (missing.length > 0) throw new Error(`The evidence commit is missing ${missing.join(", ")}.`);
      return sha;
    } finally {
      await this.removeWorktree(input.worktree);
      rmSync(input.worktree, { recursive: true, force: true });
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
