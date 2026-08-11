import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";

import { inspectCommitRange, type CommitRangeInspection } from "./pinValidation.js";

/**
 * Owner-side bare mirror. This is the only place origin bytes enter the
 * coordinator, and it never touches an agent clone.
 *
 * Two failure classes are kept strictly apart:
 *
 * - **transient** — the mirror could not talk to origin. The action and the
 *   submitted `complete` file are preserved and the fetch is retried. A
 *   transient failure must never become a missing-artifact verdict.
 * - **absent / unreachable** — origin answered, and the ref or commit is not
 *   there. That is real evidence about the agent's work.
 */

export type GitRun = {
  readonly status: number | null;
  readonly stdout: Buffer;
  readonly stderr: string;
};

/** Injected boundary so the run loop can be tested without a network. */
export type GitRunner = (args: readonly string[], cwd?: string) => GitRun;

const defaultTimeoutMs = 30_000;

export const spawnGit: GitRunner = (args, cwd) => {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: defaultTimeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });

  return {
    status: result.status,
    stdout: result.stdout === null ? Buffer.alloc(0) : Buffer.from(result.stdout),
    stderr: result.error?.message ?? (result.stderr === null ? "" : result.stderr.toString("utf8").trim())
  };
};

/**
 * Messages that mean "we could not reach or read from origin", as opposed to
 * "origin answered and the thing is not there". Matched case-insensitively.
 */
const transientPatterns: readonly RegExp[] = [
  /could not resolve host/i,
  /connection (refused|reset|timed out)/i,
  /could not read from remote repository/i,
  /unable to access/i,
  /operation timed out/i,
  /timed out/i,
  /early eof/i,
  /rpc failed/i,
  /the remote end hung up/i,
  /ssl|tls handshake/i,
  /temporary failure in name resolution/i,
  /network is unreachable/i,
  /remote error: internal server error/i,
  /spawnsync .*etimedout/i
];

export const isTransientGitFailure = (stderr: string): boolean =>
  transientPatterns.some((pattern) => pattern.test(stderr));

export type FetchOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: "transient"; readonly detail: string }
  | { readonly ok: false; readonly kind: "missing-ref"; readonly detail: string };

export type BlobOutcome =
  | { readonly ok: true; readonly contents: string }
  | { readonly ok: false; readonly kind: "missing-path"; readonly detail: string }
  | { readonly ok: false; readonly kind: "missing-commit"; readonly detail: string };

export type Mirror = {
  readonly path: string;
  /** Create the bare mirror if absent and point it at origin. */
  ensure: (originUrl: string) => FetchOutcome;
  /** Fetch exactly one branch into `refs/origin/<branch>`. */
  fetchBranch: (branch: string) => FetchOutcome;
  /** True when `sha` is reachable from the fetched ref for `branch`. */
  isReachableFrom: (sha: string, branch: string) => boolean;
  /** Read one path at one exact commit. Never reads a tip. */
  readBlob: (sha: string, path: string) => BlobOutcome;
  hasCommit: (sha: string) => boolean;
  isAncestor: (ancestor: string, descendant: string) => boolean;
  inspectRange: (base: string, tip: string) => CommitRangeInspection;
  /** Materialise a detached worktree at an exact commit, for final checks. */
  addWorktree: (target: string, sha: string) => FetchOutcome;
  removeWorktree: (target: string) => void;
};

/**
 * Local ref namespace inside the mirror. Fetching into an explicit namespace
 * keeps "what origin says" separate from anything the coordinator computes.
 */
export const mirrorRef = (branch: string): string => `refs/coord-origin/${branch}`;

const classify = (run: GitRun, detail: string): FetchOutcome =>
  isTransientGitFailure(run.stderr)
    ? { ok: false, kind: "transient", detail: `${detail}: ${run.stderr}` }
    : { ok: false, kind: "missing-ref", detail: `${detail}: ${run.stderr}` };

export const createMirror = (path: string, runner: GitRunner = spawnGit): Mirror => {
  const git = (...args: string[]): GitRun => runner(["-C", path, ...args]);

  const ensure = (originUrl: string): FetchOutcome => {
    if (!existsSync(path)) {
      mkdirSync(path, { recursive: true });

      const init = runner(["init", "--bare", "--quiet", path]);

      if (init.status !== 0) {
        return classify(init, `could not initialise mirror at ${path}`);
      }
    }

    const existing = git("remote", "get-url", "origin");

    if (existing.status === 0) {
      if (existing.stdout.toString("utf8").trim() === originUrl) {
        return { ok: true };
      }

      const updated = git("remote", "set-url", "origin", originUrl);

      return updated.status === 0 ? { ok: true } : classify(updated, "could not update origin url");
    }

    const added = git("remote", "add", "origin", originUrl);

    return added.status === 0 ? { ok: true } : classify(added, "could not add origin");
  };

  const fetchBranch = (branch: string): FetchOutcome => {
    const run = git(
      "fetch",
      "--quiet",
      "--no-tags",
      "--prune",
      "origin",
      `+refs/heads/${branch}:${mirrorRef(branch)}`
    );

    return run.status === 0 ? { ok: true } : classify(run, `could not fetch ${branch}`);
  };

  const hasCommit = (sha: string): boolean => git("cat-file", "-e", `${sha}^{commit}`).status === 0;

  const isAncestor = (ancestor: string, descendant: string): boolean =>
    git("merge-base", "--is-ancestor", ancestor, descendant).status === 0;

  return {
    path,
    ensure,
    fetchBranch,
    hasCommit,
    isAncestor,
    isReachableFrom: (sha, branch) => hasCommit(sha) && isAncestor(sha, mirrorRef(branch)),
    readBlob: (sha, blobPath) => {
      if (!hasCommit(sha)) {
        return { ok: false, kind: "missing-commit", detail: `commit ${sha} is not in the mirror` };
      }

      const run = git("cat-file", "-p", `${sha}:${blobPath}`);

      if (run.status !== 0) {
        return { ok: false, kind: "missing-path", detail: `${blobPath} does not exist in ${sha}` };
      }

      return { ok: true, contents: run.stdout.toString("utf8") };
    },
    inspectRange: (base, tip) => inspectCommitRange(path, base, tip),
    addWorktree: (target, sha) => {
      const run = git("worktree", "add", "--detach", "--force", target, sha);

      return run.status === 0 ? { ok: true } : classify(run, `could not create worktree at ${target}`);
    },
    removeWorktree: (target) => {
      git("worktree", "remove", "--force", target);
      git("worktree", "prune");
    }
  };
};
