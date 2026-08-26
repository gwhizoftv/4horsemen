import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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


  it("creates a real evidence commit whose tree actually contains every ballot", async () => {
    const fixture = repository();
    const baseline = git(fixture.work, "rev-parse", "main");
    const mirror = new BareMirror(join(fixture.root, "runtime/mirror.git"), fixture.origin);
    await mirror.initialize();
    await mirror.fetchBranch("main");

    const files = [
      { path: ".plans/issue-1/ballot-claude.json", content: '{"agent":"claude"}\n' },
      { path: ".code-reviews/issue-1/consensus-ballot-codex-round-1.json", content: '{"agent":"codex"}\n' }
    ];
    const sha = await mirror.createEvidenceCommit({
      worktree: join(fixture.root, "runtime", "evidence-1"),
      parentSha: baseline,
      files,
      message: "Coordinator: publish issue 1 plan ballot batch",
      identity: { name: "coord coordination driver", email: "coord@coordination.invalid" }
    });

    // The failure this guards against is silent: a commit path that produced an
    // empty tree would still return a SHA and still push successfully.
    const listed = execFileSync("git", ["--git-dir", join(fixture.root, "runtime/mirror.git"), "ls-tree", "-r", "--name-only", sha], {
      encoding: "utf8"
    });
    for (const file of files) expect(listed).toContain(file.path);
    expect(
      execFileSync("git", ["--git-dir", join(fixture.root, "runtime/mirror.git"), "show", `${sha}:${files[0]?.path}`], {
        encoding: "utf8"
      })
    ).toBe(files[0]?.content);

    // Coordinator identity, baseline parent, and no leftover worktree.
    const meta = execFileSync(
      "git",
      ["--git-dir", join(fixture.root, "runtime/mirror.git"), "show", "-s", "--format=%an|%ae|%cn|%ce|%P|%s", sha],
      { encoding: "utf8" }
    ).trim();
    expect(meta).toBe(
      `coord coordination driver|coord@coordination.invalid|coord coordination driver|coord@coordination.invalid|${baseline}|Coordinator: publish issue 1 plan ballot batch`
    );
    expect(existsSync(join(fixture.root, "runtime", "evidence-1"))).toBe(false);
  });

  it("accumulates evidence by fast-forward and refuses a diverged origin tip", async () => {
    const fixture = repository();
    const baseline = git(fixture.work, "rev-parse", "main");
    const mirrorPath = join(fixture.root, "runtime/mirror.git");
    const mirror = new BareMirror(mirrorPath, fixture.origin);
    await mirror.initialize();
    await mirror.fetchBranch("main");
    const identity = { name: "coord coordination driver", email: "coord@coordination.invalid" };

    // Before anything is published there is no branch, so the first commit
    // parents at the issue baseline.
    expect(await mirror.remoteTip("issue-1/coordinator-evidence")).toEqual({ ok: true, sha: null });

    const first = await mirror.createEvidenceCommit({
      worktree: join(fixture.root, "runtime", "evidence-a"),
      parentSha: baseline,
      files: [{ path: ".plans/issue-1/ballot-claude.json", content: "{}\n" }],
      message: "Coordinator: publish issue 1 plan ballot batch",
      identity
    });
    await mirror.publishBranch(first, "issue-1/coordinator-evidence");
    expect(await mirror.remoteTip("issue-1/coordinator-evidence")).toEqual({ ok: true, sha: first });

    // A later round fast-forwards from the persisted tip and keeps the first
    // commit in history.
    const second = await mirror.createEvidenceCommit({
      worktree: join(fixture.root, "runtime", "evidence-b"),
      parentSha: first,
      files: [{ path: ".code-reviews/issue-1/ballot-claude.json", content: "{}\n" }],
      message: "Coordinator: publish issue 1 comparison ballot batch",
      identity
    });
    await mirror.publishBranch(second, "issue-1/coordinator-evidence");
    const history = execFileSync("git", ["--git-dir", mirrorPath, "log", "--format=%H", `${second}`], {
      encoding: "utf8"
    })
      .trim()
      .split("\n");
    expect(history).toContain(first);
    expect(history[0]).toBe(second);

    // A commit built from a stale parent is not a fast-forward. It must fail
    // closed rather than being forced over whatever origin now holds.
    const diverged = await mirror.createEvidenceCommit({
      worktree: join(fixture.root, "runtime", "evidence-c"),
      parentSha: baseline,
      files: [{ path: ".plans/issue-1/ballot-codex.json", content: "{}\n" }],
      message: "Coordinator: publish issue 1 plan ballot batch",
      identity
    });
    await expect(mirror.publishBranch(diverged, "issue-1/coordinator-evidence")).rejects.toThrow();
    // Origin still holds the good tip: nothing was rewritten.
    expect(await mirror.remoteTip("issue-1/coordinator-evidence")).toEqual({ ok: true, sha: second });
  });

  it("stamps the driver identity even when the environment exports its own", async () => {
    // `GIT_AUTHOR_*` outranks `-c user.name`, so a coordinator invoked from a
    // git hook or a shell that exported an identity would otherwise attribute
    // its own evidence commit to that person.
    const fixture = repository();
    const mirror = new BareMirror(join(fixture.root, "runtime/mirror.git"), fixture.origin);
    await mirror.initialize();
    await mirror.fetchBranch("main");
    const previous = { ...process.env };
    process.env.GIT_AUTHOR_NAME = "Somebody Else";
    process.env.GIT_AUTHOR_EMAIL = "somebody@example.com";
    process.env.GIT_COMMITTER_NAME = "Somebody Else";
    process.env.GIT_COMMITTER_EMAIL = "somebody@example.com";
    try {
      const sha = await mirror.createEvidenceCommit({
        worktree: join(fixture.root, "runtime", "evidence-identity"),
        parentSha: git(fixture.work, "rev-parse", "main"),
        files: [{ path: ".plans/issue-1/ballot-claude.json", content: "{}\n" }],
        message: "Coordinator: publish issue 1 plan ballot batch",
        identity: { name: "coord coordination driver", email: "coord@coordination.invalid" }
      });
      expect(
        execFileSync(
          "git",
          ["--git-dir", join(fixture.root, "runtime/mirror.git"), "show", "-s", "--format=%an|%ae|%cn|%ce", sha],
          { encoding: "utf8" }
        ).trim()
      ).toBe(
        "coord coordination driver|coord@coordination.invalid|coord coordination driver|coord@coordination.invalid"
      );
    } finally {
      process.env = previous;
    }
  });

  it("refuses to build an evidence commit with no ballots in it", async () => {
    const fixture = repository();
    const mirror = new BareMirror(join(fixture.root, "runtime/mirror.git"), fixture.origin);
    await mirror.initialize();
    await mirror.fetchBranch("main");
    await expect(
      mirror.createEvidenceCommit({
        worktree: join(fixture.root, "runtime", "evidence-empty"),
        parentSha: git(fixture.work, "rev-parse", "main"),
        files: [],
        message: "empty",
        identity: { name: "coord", email: "coord@invalid" }
      })
    ).rejects.toThrow(/at least one ballot/);
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
