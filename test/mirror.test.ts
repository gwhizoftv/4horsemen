import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BareMirror, isTransientGitFailure } from "../src/mirror.js";
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

  it("prefixes account credential -c args before --git-dir when auth is bound", async () => {
    const calls: string[][] = [];
    const mirror = new BareMirror(
      join(mkdtempSync(join(tmpdir(), "coord-mirror-auth-")), "mirror.git"),
      "https://github.com/example/fixture.git",
      async (args) => {
        calls.push([...args]);
        if (args.includes("init")) return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
        if (args.includes("remote")) return { exitCode: 0, stdout: Buffer.from("https://github.com/example/fixture.git\n"), stderr: "" };
        if (args.includes("fetch")) return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
        if (args.includes("rev-parse")) return { exitCode: 0, stdout: Buffer.from(`${"a".repeat(40)}\n`), stderr: "" };
        if (args.includes("push")) return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      },
      { account: "acct", cliEntry: "/tmp/coord/dist/main.js" }
    );
    await mirror.initialize();
    await mirror.fetchBranch("main");
    await mirror.publishBranch("a".repeat(40), "issue-1/claude");
    const network = calls.filter((argv) => argv.includes("fetch") || argv.includes("push"));
    expect(network.length).toBeGreaterThan(0);
    for (const argv of network) {
      expect(argv[0]).toBe("-c");
      expect(argv[1]).toBe("credential.https://github.com.helper=");
      expect(argv[2]).toBe("-c");
      expect(argv[3]).toContain("auth git-credential");
      expect(argv.indexOf("--git-dir")).toBeGreaterThan(3);
    }
    const plain = new BareMirror(join(mkdtempSync(join(tmpdir(), "coord-mirror-plain-")), "mirror.git"), "https://github.com/example/fixture.git",
      async (args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: Buffer.alloc(0), stderr: "" };
      });
    await plain.initialize();
    expect(calls.at(-1)?.[0]).not.toBe("-c");
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
