import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BareMirror, hermeticGitEnv, isTransientGitFailure } from "../src/mirror.js";
import { assertNoSymlink, resolveSafeCoordRoot } from "../src/paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const repository = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-mirror-"));
  roots.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "--bare", "-q", origin]);
  execFileSync("git", ["init", "-q", work]);
  writeFileSync(join(work, "README.md"), "base\n");
  git(work, "add", ".");
  git(work, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "base");
  git(work, "branch", "-M", "main");
  git(work, "remote", "add", "origin", origin);
  git(work, "push", "-q", "origin", "main");
  git(work, "checkout", "-qb", "issue-1/codex");
  mkdirSync(join(work, ".plans/issue-1"), { recursive: true });
  writeFileSync(join(work, ".plans/issue-1/plan.md"), "# Plan\n");
  git(work, "add", ".");
  git(work, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "plan");
  const sha = git(work, "rev-parse", "HEAD");
  git(work, "push", "-q", "origin", "issue-1/codex");
  return { root, origin, work, sha };
};

describe("owner bare mirror", () => {
  it("attributes ordinary detached commits and repairs mirrors that already have linked worktrees", async () => {
    const fixture = repository();
    const mirror = new BareMirror(join(fixture.root, "mirror.git"), fixture.origin);
    const profile = { login: "gwhizofss", id: 155764113 };
    const email = "155764113+gwhizofss@users.noreply.github.com";
    await mirror.initialize(profile);
    await mirror.fetchBranch("issue-1/codex");
    const checkout = join(fixture.root, "checkout");
    await mirror.materializeWorktree(checkout, fixture.sha);
    execFileSync("git", ["commit", "--allow-empty", "-qm", "check attribution"], { cwd: checkout, env: hermeticGitEnv() });
    expect(git(checkout, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe([profile.login, email, profile.login, email].join("|"));

    git(mirror.path, "config", "--local", "user.email", "stale@example.com");
    await mirror.initialize(profile);
    expect(git(checkout, "config", "user.email")).toBe(email);
  });

  it("retains the issue author in its worktree after another issue changes the mirror defaults", async () => {
    const fixture = repository();
    const path = join(fixture.root, "mirror.git");
    const first = new BareMirror(path, fixture.origin, undefined, { account: "first", cliEntry: "/coord/dist/main.js" });
    const second = new BareMirror(path, fixture.origin, undefined, { account: "second", cliEntry: "/coord/dist/main.js" });
    await first.initialize({ login: "first", id: 1 });
    await first.fetchBranch("issue-1/codex");
    const a = join(fixture.root, "one", "same-name");
    const b = join(fixture.root, "two", "same-name");
    await second.initialize({ login: "second", id: 2 });
    await Promise.all([first.materializeWorktree(a, fixture.sha), second.materializeWorktree(b, fixture.sha)]);
    await first.initialize({ login: "first", id: 1 });
    for (const [checkout, login, id] of [[a, "first", 1], [b, "second", 2]] as const) {
      execFileSync("git", ["commit", "--allow-empty", "-qm", "check attribution"], { cwd: checkout, env: hermeticGitEnv() });
      const email = `${id}+${login}@users.noreply.github.com`;
      expect(git(checkout, "log", "-1", "--format=%an|%ae|%cn|%ce")).toBe([login, email, login, email].join("|"));
    }
    await new BareMirror(path, fixture.origin).initialize(null);
    expect(git(a, "config", "--worktree", "user.name")).toBe("first");
    expect(git(b, "config", "--worktree", "user.name")).toBe("second");
    const ambient = join(fixture.root, "ambient");
    await new BareMirror(path, fixture.origin).materializeWorktree(ambient, fixture.sha);
    expect(git(ambient, "config", "--worktree", "--list")).not.toContain("user.name");
    expect(git(path, "config", "--local", "--list")).not.toContain("user.email");
    expect(git(path, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(git(ambient, "rev-parse", "--is-inside-work-tree")).toBe("true");
    await first.removeWorktree(a);
    await second.removeWorktree(b);
  });

  it("constrains proposal reads to ordinary tracked files at the exact pin", async () => {
    const fixture = repository();
    mkdirSync(join(fixture.work, ".ci"));
    writeFileSync(join(fixture.work, ".ci/check.sh"), "exit 0\n");
    chmodSync(join(fixture.work, ".ci/check.sh"), 0o755);
    symlinkSync(".ci/check.sh", join(fixture.work, "check-link"));
    git(fixture.work, "add", ".");
    git(fixture.work, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "check entry points");
    const pin = git(fixture.work, "rev-parse", "HEAD");
    git(fixture.work, "push", "-q", "origin", "issue-1/codex");
    const mirror = new BareMirror(join(fixture.root, "runtime/mirror.git"), fixture.origin);
    await mirror.initialize();
    await mirror.fetchBranch("issue-1/codex");
    const regularFileOnly = { regularFileOnly: true };
    expect(await mirror.readBlob(pin, "README.md", regularFileOnly)).toBe("base\n");
    expect(await mirror.readBlob(pin, ".ci/check.sh", regularFileOnly)).toBe("exit 0\n");
    for (const path of [".ci", "check-link", "missing", ".ci/*.sh"]) {
      expect(await mirror.readBlob(pin, path, regularFileOnly)).toBeNull();
    }
    expect(await mirror.readBlob(fixture.sha, ".ci/check.sh", regularFileOnly)).toBeNull();
    expect(await mirror.readBlob(pin, "check-link")).toBe(".ci/check.sh");
    expect(await mirror.readBlob(pin, ".ci")).toContain("check.sh");
  });

  it("fetches explicit origin refs and reads exact-commit blobs", async () => {
    const fixture = repository();
    const mirror = new BareMirror(join(fixture.root, "runtime/mirror.git"), fixture.origin);
    await mirror.initialize();
    const fetched = await mirror.fetchBranch("issue-1/codex");
    expect(fetched).toMatchObject({ ok: true, tip: fixture.sha });
    if (!fetched.ok) throw new Error(fetched.error);
    expect(await mirror.isReachable(fixture.sha, fetched.ref)).toBe(true);
    expect(await mirror.readBlob(fixture.sha, ".plans/issue-1/plan.md")).toBe("# Plan\n");
    expect(await mirror.changedPaths(git(fixture.work, "rev-parse", "main"), fixture.sha)).toContain(".plans/issue-1/plan.md");
  });

  it("ignores ambient Git repository and config redirectors", async () => {
    const fixture = repository();
    const poisoned = join(fixture.root, "poison.git");
    execFileSync("git", ["init", "--bare", "-q", poisoned]);
    const previous = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL
    };
    process.env.GIT_DIR = poisoned;
    process.env.GIT_WORK_TREE = join(fixture.root, "wrong-worktree");
    process.env.GIT_CONFIG_GLOBAL = join(fixture.root, "missing-config");
    try {
      const mirror = new BareMirror(join(fixture.root, "runtime-hermetic/mirror.git"), fixture.origin);
      await mirror.initialize();
      const fetched = await mirror.fetchBranch("issue-1/codex");
      expect(fetched).toMatchObject({ ok: true, tip: fixture.sha });
      expect(await mirror.readBlob(fixture.sha, ".plans/issue-1/plan.md")).toBe("# Plan\n");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("binds every mirror Git call to a selected GitHub account without persisting it", async () => {
    const calls: (readonly string[])[] = [];
    const runner = async (args: readonly string[]) => {
      calls.push(args);
      const failed = args.includes("push");
      return { exitCode: failed ? 128 : 0, stdout: Buffer.from(`${"a".repeat(40)}\n`),
        stderr: failed ? "fatal: Authentication failed for 'https://github.com/acme/app.git/'" : "" };
    };
    const helper = "credential.https://github.com.helper";
    const bound = new BareMirror("/runtime/mirror.git", "https://github.com/acme/app.git", runner, { account: "acct", cliEntry: "/coord/dist/main.js" });
    expect(await bound.fetchBranch("issue-1/codex")).toMatchObject({ ok: true });
    await expect(bound.publishBranch("a".repeat(40), "issue-1/codex-final")).rejects.toThrow(
      "GitHub authentication for acct has expired or been revoked.\nRun: coord auth login"
    );
    for (const args of calls) {
      expect(args.slice(0, 4)).toEqual(["-c", `${helper}=`, "-c", `${helper}=!'/coord/scripts/lib/node-runtime.sh' --fallback-node '${process.execPath}' '/coord/dist/main.js' auth git-credential --account acct`]);
      expect(args[4]).toBe("--git-dir");
    }

    calls.length = 0;
    await new BareMirror("/runtime/mirror.git", "https://github.com/acme/app.git", runner).fetchBranch("issue-1/codex");
    expect(calls.every((args) => args[0] === "--git-dir")).toBe(true);
  });

  it("distinguishes transient network failures", () => {
    expect(isTransientGitFailure("fatal: Could not resolve host: example.invalid")).toBe(true);
    expect(isTransientGitFailure("fatal: couldn't find remote ref missing")).toBe(false);
  });

  it("refuses runtime roots that overlap a clone and rejects runtime symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-paths-"));
    roots.push(root);
    const clone = join(root, "clone");
    mkdirSync(clone);
    expect(() => resolveSafeCoordRoot({ coordRoot: join(clone, "runtime"), agentRoots: [clone] })).toThrow("overlaps");
    const runtime = join(root, "runtime");
    mkdirSync(runtime);
    symlinkSync(join(root, "target"), join(runtime, "link"));
    expect(() => assertNoSymlink(runtime, join(runtime, "link/file"))).toThrow("symlink");
  });
});
