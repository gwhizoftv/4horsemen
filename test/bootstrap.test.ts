import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { git, repoRoot } from "./support/workspaceFixture.js";

/**
 * `scripts/bootstrap.sh` against a local fixture origin.
 *
 * `--source` points at a throwaway repository and `--no-build` skips the pnpm
 * install, so these run in the fast tier without a network and without paying
 * for a full build per case. What is under test here is the install-root
 * lifecycle — clone, idempotent update, refusal to rewrite local work, and the
 * PATH wrapper — not the build itself.
 */

const script = join(repoRoot, "scripts", "bootstrap.sh");
const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

const temp = (prefix: string): string => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
};

/** A tiny repository that stands in for the coordination remote. */
const fixtureSource = (): string => {
  const root = temp("coord-bootstrap-src-");
  const source = join(root, "source");
  execFileSync("git", ["init", "-q", "--initial-branch=main", source]);
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "user.email", "fixture@example.com");
  writeFileSync(join(source, "README.md"), "# fixture\n");
  git(source, "add", "-A");
  git(source, "commit", "-qm", "initial");
  return source;
};

type Run = { status: number; stdout: string; stderr: string };

const bootstrap = (args: readonly string[], env: NodeJS.ProcessEnv = {}): Run => {
  const home = temp("coord-bootstrap-home-");
  const result = spawnSync("sh", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, ...env }
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

describe("scripts/bootstrap.sh", () => {
  it("clones a complete checkout into the requested root", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const run = bootstrap(["--root", root, "--source", source, "--no-build", "--no-path"]);

    expect(run.status).toBe(0);
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(existsSync(join(root, "README.md"))).toBe(true);
    // Bootstrap records that it created this checkout, inside .git/ so the
    // worktree stays clean and the next run's dirty check still passes.
    expect(readFileSync(join(root, ".git", "coord-bootstrap"), "utf8")).toContain("created-by-bootstrap");
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("is idempotent: a clean re-run fast-forwards and changes nothing else", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const args = ["--root", root, "--source", source, "--no-build", "--no-path"];
    expect(bootstrap(args).status).toBe(0);
    const first = git(root, "rev-parse", "HEAD");

    const again = bootstrap(args);
    expect(again.status).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(first);

    // A new upstream commit is adopted by fast-forward.
    writeFileSync(join(source, "NEW.md"), "new\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "second");
    expect(bootstrap(args).status).toBe(0);
    expect(git(root, "rev-parse", "HEAD")).toBe(git(source, "rev-parse", "HEAD"));
  });

  it("refuses to update a dirty checkout, and does not rewrite it", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const args = ["--root", root, "--source", source, "--no-build", "--no-path"];
    expect(bootstrap(args).status).toBe(0);
    const before = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "README.md"), "# locally edited\n");

    writeFileSync(join(source, "NEW.md"), "new\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "second");

    const run = bootstrap(args);
    expect(run.status).toBe(4);
    expect(run.stderr).toMatch(/uncommitted changes/);
    // The operator's edit and the original commit both survive: bootstrap never
    // resets, cleans, or force-checks-out.
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("# locally edited\n");
    expect(git(root, "rev-parse", "HEAD")).toBe(before);
  });

  it("refuses a diverged checkout rather than merging it", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const args = ["--root", root, "--source", source, "--no-build", "--no-path"];
    expect(bootstrap(args).status).toBe(0);

    git(root, "config", "user.name", "Fixture");
    git(root, "config", "user.email", "fixture@example.com");
    writeFileSync(join(root, "LOCAL.md"), "local\n");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "local work");
    writeFileSync(join(source, "NEW.md"), "new\n");
    git(source, "add", "-A");
    git(source, "commit", "-qm", "upstream work");

    const run = bootstrap(args);
    expect(run.status).toBe(4);
    expect(run.stderr).toMatch(/diverged/);
    expect(existsSync(join(root, "LOCAL.md"))).toBe(true);
  });

  it("refuses a root that exists but is not a git worktree", () => {
    const source = fixtureSource();
    const root = temp("coord-bootstrap-notrepo-");
    writeFileSync(join(root, "something"), "here\n");
    const run = bootstrap(["--root", root, "--source", source, "--no-build", "--no-path"]);
    expect(run.status).toBe(4);
    expect(run.stderr).toMatch(/not a git worktree/);
    expect(existsSync(join(root, "something"))).toBe(true);
  });

  it("installs an executable PATH wrapper that points at the install root", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const home = temp("coord-bootstrap-home-");
    const result = spawnSync("sh", [script, "--root", root, "--source", source, "--no-build"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PATH: process.env.PATH ?? "" }
    });
    expect(result.status).toBe(0);

    const launcher = join(home, ".local", "bin", "coord");
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    const body = readFileSync(launcher, "utf8");
    expect(body).toContain(root);
    // Not a rebuild-on-demand wrapper: an installed root must not make pnpm a
    // runtime dependency. An unbuilt root says what to re-run instead.
    expect(body).not.toContain("pnpm");
    const unbuilt = spawnSync("sh", [launcher], { encoding: "utf8" });
    expect(unbuilt.status).toBe(1);
    expect(unbuilt.stderr).toMatch(/Re-run scripts\/bootstrap\.sh/);
  });

  it("skips the PATH wrapper with --no-path", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const home = temp("coord-bootstrap-home-");
    const result = spawnSync("sh", [script, "--root", root, "--source", source, "--no-build", "--no-path"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home }
    });
    expect(result.status).toBe(0);
    expect(existsSync(join(home, ".local", "bin", "coord"))).toBe(false);
  });

  it("refuses to overwrite a coord on PATH that bootstrap did not install", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    const home = temp("coord-bootstrap-home-");
    execFileSync("mkdir", ["-p", join(home, ".local", "bin")]);
    const launcher = join(home, ".local", "bin", "coord");
    writeFileSync(launcher, "#!/bin/sh\necho someone else's tool\n", { mode: 0o755 });

    const result = spawnSync("sh", [script, "--root", root, "--source", source, "--no-build"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home }
    });
    expect(result.status).toBe(6);
    expect(readFileSync(launcher, "utf8")).toContain("someone else's tool");
  });

  it("prefers --root over COORD_INSTALL_ROOT", () => {
    const source = fixtureSource();
    const chosen = join(temp("coord-bootstrap-root-"), "chosen");
    const ignored = join(temp("coord-bootstrap-root-"), "ignored");
    const run = bootstrap(["--root", chosen, "--source", source, "--no-build", "--no-path"], {
      COORD_INSTALL_ROOT: ignored
    });
    expect(run.status).toBe(0);
    expect(existsSync(join(chosen, ".git"))).toBe(true);
    expect(existsSync(ignored)).toBe(false);
  });

  it("honours COORD_INSTALL_ROOT when --root is absent", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "from-env");
    const run = bootstrap(["--source", source, "--no-build", "--no-path"], { COORD_INSTALL_ROOT: root });
    expect(run.status).toBe(0);
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("gives one concise hint per missing tool, before touching anything", () => {
    const source = fixtureSource();
    const root = join(temp("coord-bootstrap-root-"), "install");
    // An empty PATH plus a stub directory holding only git: node is missing.
    const stubs = temp("coord-bootstrap-stubs-");
    writeFileSync(join(stubs, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // Absolute interpreter, so the stripped PATH governs only what the script
    // itself can find.
    const run = spawnSync("/bin/sh", [script, "--root", root, "--source", source, "--no-path"], {
      encoding: "utf8",
      env: { PATH: stubs, HOME: temp("coord-bootstrap-home-") }
    });
    expect(run.status).toBe(3);
    expect(run.stderr).toMatch(/node is required/);
    expect(existsSync(root)).toBe(false);
  });

  it("rejects an unknown option instead of ignoring it", () => {
    const run = bootstrap(["--nope"]);
    expect(run.status).toBe(2);
    expect(run.stderr).toMatch(/unknown option/);
  });

  it("is POSIX sh, because the documented invocation pipes into sh", () => {
    expect(spawnSync("sh", ["-n", script]).status).toBe(0);
    const dash = spawnSync("dash", ["-n", script]);
    if (dash.error === undefined) expect(dash.status).toBe(0);
  });
});
