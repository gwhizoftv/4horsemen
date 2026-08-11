import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Minimal throwaway Git repositories for tests. Deliberately standalone: the
 * legacy automation fixture pulls in a dependency graph this package does not
 * have, and the seed helpers under test only need real commits and real refs.
 */

export type GitFixture = {
  readonly root: string;
  /** Run git in the fixture, throwing with stderr on failure. */
  git: (...args: string[]) => string;
  /** Write files (paths relative to root), stage them, commit, return the SHA. */
  commit: (message: string, files: Record<string, string>) => string;
  /** Stage a deletion of each path, commit, return the SHA. */
  remove: (message: string, paths: readonly string[]) => string;
  /** Resolve any revision to a full 40-hex SHA. */
  rev: (revision: string) => string;
  cleanup: () => void;
};

const runGit = (root: string, args: readonly string[]): string => {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid"
    }
  });

  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  }

  return result.stdout;
};

export const createGitFixture = (prefix = "coord-fixture-"): GitFixture => {
  const root = mkdtempSync(join(tmpdir(), prefix));

  runGit(root, ["init", "--quiet", "--initial-branch", "main"]);
  runGit(root, ["config", "user.name", "Fixture"]);
  runGit(root, ["config", "user.email", "fixture@example.invalid"]);
  runGit(root, ["config", "commit.gpgsign", "false"]);

  const git = (...args: string[]): string => runGit(root, args);

  const rev = (revision: string): string => git("rev-parse", revision).trim();

  const commit = (message: string, files: Record<string, string>): string => {
    for (const [relative, contents] of Object.entries(files)) {
      const absolute = join(root, relative);

      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, contents);
      git("add", "--", relative);
    }

    git("commit", "--quiet", "--allow-empty", "-m", message);

    return rev("HEAD");
  };

  const remove = (message: string, paths: readonly string[]): string => {
    for (const relative of paths) {
      git("rm", "--quiet", "--", relative);
    }

    git("commit", "--quiet", "-m", message);

    return rev("HEAD");
  };

  return {
    root,
    git,
    commit,
    remove,
    rev,
    cleanup: () => rmSync(root, { recursive: true, force: true })
  };
};

/**
 * Create a bare repository that can serve as an `origin` for mirror tests.
 */
export const createBareOrigin = (prefix = "coord-origin-"): { path: string; cleanup: () => void } => {
  const path = mkdtempSync(join(tmpdir(), prefix));

  runGit(path, ["init", "--quiet", "--bare", "--initial-branch", "main"]);

  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
};
