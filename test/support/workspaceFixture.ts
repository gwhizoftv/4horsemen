

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixtures for the installer tests.
 *
 * The install root is this repository, because that is what an operator's
 * install root actually is: a coordination checkout with `githooks/`,
 * `templates/`, `scripts/lib/launcher.sh`, and a build. Substituting a
 * hand-built stand-in would leave the real hook bodies untested, which is where
 * the failures this issue is about have historically lived.
 */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * The hooks resolve declared verification through the built CLI entry point, so
 * these tests exercise `dist/`, not the sources vitest transforms. A stale build
 * makes every hook fail against the previous schema, so it is rebuilt whenever a
 * source file is newer — the same rule the `coord` wrapper applies.
 */
export const ensureBuilt = (): string => {
  const entry = join(repoRoot, "dist", "main.js");
  const builtAt = existsSync(entry) ? statSync(entry).mtimeMs : 0;
  const newest = (dir: string): number =>
    readdirSync(dir, { withFileTypes: true }).reduce((latest, item) => {
      const path = join(dir, item.name);
      return Math.max(latest, item.isDirectory() ? newest(path) : statSync(path).mtimeMs);
    }, 0);
  if (builtAt === 0 || newest(join(repoRoot, "src")) > builtAt) {
    execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
  }
  return entry;
};

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com"
    }
  }).trim();

process.env.COORD_TEST_REGISTRY = join(tmpdir(), "coord-test-registry.json");

export type GitAttempt = { exitCode: number; stdout: string; stderr: string };

/** Run git without throwing, so a hook's refusal can be asserted on. */
export const tryGit = (cwd: string, ...args: string[]): GitAttempt => {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com"
    }
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export type ProductFixture = {
  workspaceRoot: string;
  productRoot: string;
  originPath: string;
  coordRoot: string;
  cleanup: () => void;
};

export type ProductKind = "go" | "plain";

/**
 * A product repository in a language coordination has no opinion about, with a
 * bare origin beside it. The Go variant exists to keep the non-Node path
 * exercised: it is the case where the old lockfile-sniffing hooks ran nothing
 * at all and reported success.
 */
export const makeProduct = (kind: ProductKind = "go", name = "myserver"): ProductFixture => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), "coord-product-"));
  const coordRoot = mkdtempSync(join(tmpdir(), "coord-runtime-"));
  const productRoot = join(workspaceRoot, name);
  const originPath = join(workspaceRoot, `${name}-origin.git`);

  mkdirSync(productRoot, { recursive: true });
  git(productRoot, "init", "-q", "--initial-branch=main");
  git(productRoot, "config", "user.name", "Fixture");
  git(productRoot, "config", "user.email", "fixture@example.com");
  if (kind === "go") {
    writeFileSync(join(productRoot, "go.mod"), `module example.com/${name}\n\ngo 1.24\n`);
    mkdirSync(join(productRoot, "cmd"), { recursive: true });
    writeFileSync(join(productRoot, "cmd", "main.go"), "package main\n\nfunc main() {}\n");
  } else {
    writeFileSync(join(productRoot, "README.md"), `# ${name}\n`);
  }
  git(productRoot, "add", "-A");
  git(productRoot, "commit", "-qm", "initial");

  execFileSync("git", ["init", "-q", "--bare", originPath]);
  git(productRoot, "remote", "add", "origin", originPath);
  git(productRoot, "push", "-q", "origin", "main");

  return {
    workspaceRoot,
    productRoot,
    originPath,
    coordRoot,
    cleanup: () => {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(coordRoot, { recursive: true, force: true });
    }
  };
};

/** A declaration file for `--declare`, so tests never depend on a real toolchain. */
export const writeDeclaration = (dir: string, value: unknown, name = "declare"): string => {
  const path = join(dir, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return path;
};

export const passingVerify = {
  precommit: [{ name: "ok", argv: ["true"] }],
  prepush: [{ name: "ok", argv: ["true"] }]
};

export const failingPrecommit = {
  precommit: [{ name: "must-fail", argv: ["false"] }],
  prepush: [] as Array<{ name: string; argv: string[] }>
};

export const declaredChecks = [{ name: "test", argv: ["true"] }];

export const silence = (): { log: (message: string) => void; lines: string[] } => {
  const lines: string[] = [];
  return { log: (message) => lines.push(message), lines };
};
