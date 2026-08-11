import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMirror, isTransientGitFailure, mirrorRef, type GitRun, type GitRunner } from "../src/mirror.js";
import { CoordPathError, coordPaths, isContainedIn, resolveCoordRoot } from "../src/paths.js";
import { createBareOrigin, createGitFixture, type GitFixture } from "./gitFixture.js";

const cleanups: (() => void)[] = [];

const track = <T extends { cleanup: () => void }>(value: T): T => {
  cleanups.push(value.cleanup);

  return value;
};

const newDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));

  return dir;
};

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

/**
 * A real origin with one issue branch, plus a second unrelated branch, so
 * reachability can be proven rather than assumed.
 */
const seedOrigin = (): { originPath: string; fixture: GitFixture; planSha: string; otherSha: string } => {
  const origin = track(createBareOrigin());
  const fixture = track(createGitFixture());

  fixture.git("remote", "add", "origin", origin.path);
  fixture.commit("baseline", { "README.md": "# base\n" });
  fixture.git("push", "--quiet", "origin", "main");

  fixture.git("checkout", "--quiet", "-b", "issue-1/claude");

  const planSha = fixture.commit("publish plan", {
    ".plans/issue-1/plan.md": "# Plan\n\n## Exact file map\n\n- src/a.ts\n"
  });

  fixture.git("push", "--quiet", "origin", "issue-1/claude");

  fixture.git("checkout", "--quiet", "main");
  fixture.git("checkout", "--quiet", "-b", "issue-1/codex");

  const otherSha = fixture.commit("codex plan", { ".plans/issue-1/plan.md": "# Codex plan\n" });

  fixture.git("push", "--quiet", "origin", "issue-1/codex");

  return { originPath: origin.path, fixture, planSha, otherSha };
};

describe("external control root refusal", () => {
  it("refuses a relative --coord-root", () => {
    expect(() => resolveCoordRoot("../coord-runtime", ["/clones/claude"])).toThrow(CoordPathError);
  });

  it("refuses a control root inside a configured clone", () => {
    const clone = newDir("coord-clone-");

    try {
      resolveCoordRoot(join(clone, "coord"), [clone]);
      expect.unreachable("expected refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(CoordPathError);
      expect((error as CoordPathError).code).toBe("inside-agent-clone");
    }
  });

  it("refuses a control root equal to a configured clone", () => {
    const clone = newDir("coord-clone-");

    expect(() => resolveCoordRoot(clone, [clone])).toThrow(CoordPathError);
  });

  it("refuses a control root that encloses a configured clone", () => {
    const parent = newDir("coord-parent-");
    const clone = join(parent, "coordination-claude");

    try {
      resolveCoordRoot(parent, [clone]);
      expect.unreachable("expected refusal");
    } catch (error) {
      expect((error as CoordPathError).code).toBe("contains-agent-clone");
    }
  });

  it("accepts a control root that is a sibling of every clone", () => {
    const parent = newDir("coord-parent-");
    const root = join(parent, "coord-runtime");
    const clone = join(parent, "coordination-claude");
    const resolved = resolveCoordRoot(root, [clone]);

    // The returned root is the real path — resolving before the containment
    // check is what stops an aliased root from reaching inside a clone.
    expect(resolved).toBe(join(realpathSync(parent), "coord-runtime"));
    expect(isContainedIn(realpathSync(parent), resolved)).toBe(true);
  });

  it("resolves a symlinked root before checking containment", () => {
    const parent = newDir("coord-parent-");
    const clone = join(parent, "coordination-claude");

    // The macOS temp dir is itself reached through /var -> /private/var, so a
    // link above the root must not be treated as a policy violation.
    expect(() => resolveCoordRoot(join(parent, "coord-runtime"), [clone])).not.toThrow();
  });

  it("keeps every derived path under the root", () => {
    const root = newDir("coord-root-");
    const paths = coordPaths(root, 1);

    for (const path of [
      paths.issueDir,
      paths.startJson,
      paths.cursorsJson,
      paths.journal,
      paths.mirror,
      paths.agentDir("claude"),
      paths.actionFile("claude"),
      paths.completeFile("claude")
    ]) {
      expect(isContainedIn(root, path)).toBe(true);
    }
  });

  it("refuses an agent id that would traverse out of the control root", () => {
    const paths = coordPaths(newDir("coord-root-"), 1);

    expect(() => paths.agentDir("../../etc")).toThrow(CoordPathError);
  });

  it("refuses a non-positive issue number", () => {
    expect(() => coordPaths(newDir("coord-root-"), 0)).toThrow(CoordPathError);
  });
});

describe("transient failure classification", () => {
  it("classifies network and transport errors as transient", () => {
    for (const message of [
      "fatal: could not resolve host: github.com",
      "ssh: connect to host github.com port 22: Connection refused",
      "fatal: unable to access 'https://example/': Operation timed out",
      "error: RPC failed; curl 56 recv failure",
      "fatal: the remote end hung up unexpectedly",
      "fatal: early EOF"
    ]) {
      expect(isTransientGitFailure(message)).toBe(true);
    }
  });

  it("does not classify a genuinely absent ref as transient", () => {
    for (const message of [
      "fatal: couldn't find remote ref refs/heads/issue-1/claude",
      "fatal: Not a valid object name",
      "error: pathspec 'nope' did not match any file(s) known to git"
    ]) {
      expect(isTransientGitFailure(message)).toBe(false);
    }
  });
});

describe("mirror against a real bare origin", () => {
  it("creates the mirror and fetches one branch into its own namespace", () => {
    const { originPath, planSha } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    expect(mirror.ensure(originPath)).toEqual({ ok: true });
    expect(mirror.fetchBranch("issue-1/claude")).toEqual({ ok: true });
    expect(mirror.hasCommit(planSha)).toBe(true);
  });

  it("is idempotent across repeated ensure calls", () => {
    const { originPath } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    expect(mirror.ensure(originPath)).toEqual({ ok: true });
    expect(mirror.ensure(originPath)).toEqual({ ok: true });
  });

  it("reports a missing ref rather than a transient failure", () => {
    const { originPath } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    mirror.ensure(originPath);

    const outcome = mirror.fetchBranch("issue-1/nobody");

    expect(outcome).toMatchObject({ ok: false, kind: "missing-ref" });
  });

  it("classifies an unreachable origin as transient, not as absent work", () => {
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    mirror.ensure("https://127.0.0.1:1/nonexistent.git");

    const outcome = mirror.fetchBranch("issue-1/claude");

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.kind).toBe("transient");
    }
  });

  it("proves a submission SHA belongs to the submitting agent's branch", () => {
    const { originPath, planSha, otherSha } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    mirror.ensure(originPath);
    mirror.fetchBranch("issue-1/claude");
    mirror.fetchBranch("issue-1/codex");

    expect(mirror.isReachableFrom(planSha, "issue-1/claude")).toBe(true);
    // A real commit on the wrong branch is not this agent's submission.
    expect(mirror.isReachableFrom(otherSha, "issue-1/claude")).toBe(false);
  });

  it("rejects a SHA that does not exist at all", () => {
    const { originPath } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    mirror.ensure(originPath);
    mirror.fetchBranch("issue-1/claude");

    expect(mirror.isReachableFrom("0".repeat(40), "issue-1/claude")).toBe(false);
  });

  it("reads a blob at an exact commit", () => {
    const { originPath, planSha } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    mirror.ensure(originPath);
    mirror.fetchBranch("issue-1/claude");

    const blob = mirror.readBlob(planSha, ".plans/issue-1/plan.md");

    expect(blob.ok).toBe(true);

    if (blob.ok) {
      expect(blob.contents).toContain("Exact file map");
    }
  });

  it("distinguishes a missing path from a missing commit", () => {
    const { originPath, planSha } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    mirror.ensure(originPath);
    mirror.fetchBranch("issue-1/claude");

    expect(mirror.readBlob(planSha, ".plans/issue-1/absent.md")).toMatchObject({
      ok: false,
      kind: "missing-path"
    });
    expect(mirror.readBlob("0".repeat(40), ".plans/issue-1/plan.md")).toMatchObject({
      ok: false,
      kind: "missing-commit"
    });
  });

  it("evaluates the submitted commit, not the branch tip", () => {
    const { originPath, fixture, planSha } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    fixture.git("checkout", "--quiet", "issue-1/claude");
    fixture.commit("later work that removes the plan", { ".plans/issue-1/plan.md": "" });
    fixture.git("rm", "--quiet", "--", ".plans/issue-1/plan.md");
    fixture.git("commit", "--quiet", "-m", "delete plan");
    fixture.git("push", "--quiet", "origin", "issue-1/claude");

    mirror.ensure(originPath);
    mirror.fetchBranch("issue-1/claude");

    // The tip no longer has the file; the submitted commit still does.
    expect(mirror.readBlob(planSha, ".plans/issue-1/plan.md").ok).toBe(true);
    expect(mirror.readBlob(fixture.rev("issue-1/claude"), ".plans/issue-1/plan.md").ok).toBe(false);
  });

  it("reports ancestry and changed paths for a pinned range", () => {
    const { originPath, fixture, planSha } = seedOrigin();
    const mirror = createMirror(join(newDir("coord-mirror-"), "mirror.git"));

    fixture.git("checkout", "--quiet", "issue-1/claude");

    const laterSha = fixture.commit("signal", { ".signals/issue-1/x.json": "{}\n" });

    fixture.git("push", "--quiet", "origin", "issue-1/claude");

    mirror.ensure(originPath);
    mirror.fetchBranch("issue-1/claude");

    expect(mirror.isAncestor(planSha, laterSha)).toBe(true);
    expect(mirror.isAncestor(laterSha, planSha)).toBe(false);

    const inspected = mirror.inspectRange(planSha, laterSha);

    expect(inspected.ok).toBe(true);

    if (inspected.ok) {
      expect(inspected.changes.map((change) => change.paths[0]?.toString("utf8"))).toEqual([
        ".signals/issue-1/x.json"
      ]);
    }
  });

  it("names the fetched ref in its own namespace", () => {
    expect(mirrorRef("issue-1/claude")).toBe("refs/coord-origin/issue-1/claude");
  });
});

describe("mirror with an injected runner", () => {
  const fakeRunner = (responses: Record<string, GitRun>): GitRunner => {
    return (args) => {
      const key = args.filter((arg) => arg !== "-C").slice(1).join(" ");

      return (
        responses[key] ?? { status: 0, stdout: Buffer.alloc(0), stderr: "" }
      );
    };
  };

  it("preserves a transient fetch failure without inventing absence", () => {
    const mirror = createMirror(
      "/tmp/does-not-need-to-exist",
      fakeRunner({
        "fetch --quiet --no-tags --prune origin +refs/heads/issue-1/claude:refs/coord-origin/issue-1/claude": {
          status: 128,
          stdout: Buffer.alloc(0),
          stderr: "fatal: unable to access 'https://origin/': Could not resolve host: origin"
        }
      })
    );

    const outcome = mirror.fetchBranch("issue-1/claude");

    expect(outcome).toMatchObject({ ok: false, kind: "transient" });

    if (!outcome.ok) {
      expect(outcome.detail).toContain("Could not resolve host");
    }
  });
});
