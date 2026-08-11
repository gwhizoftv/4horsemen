import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  initMirror,
  fetchRef,
  fetchAgentBranch,
  isReachable,
  readBlob,
  commitExists,
  isAncestor,
  changedPaths,
  MirrorFetchError,
} from "../src/mirror.js";
import { resolveCoordRoot, PathConfinementError } from "../src/paths.js";

const AGENT = "testagent";
const BRANCH = `issue-1/${AGENT}`;

let tmp: string;
let originUrl: string;
let coordRoot: string;
let commitA: string;
let commitB: string;

function git(cwd: string, ...args: string[]): string {
  return execSync("git " + args.map(a => `'${a}'`).join(" "), {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  }).trim();
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "mirror-test-"));
  const originDir = join(tmp, "origin.git");
  const workDir = join(tmp, "work");
  coordRoot = join(tmp, "coord");

  execSync(`git init --bare '${originDir}'`, { encoding: "utf8" });
  execSync(`git clone '${originDir}' '${workDir}'`, { encoding: "utf8" });

  git(workDir, "checkout", "-b", BRANCH);
  writeFileSync(join(workDir, "hello.txt"), "hello");
  git(workDir, "add", ".");
  git(workDir, "commit", "-m", "first");
  commitA = git(workDir, "rev-parse", "HEAD");

  writeFileSync(join(workDir, "world.txt"), "world");
  git(workDir, "add", ".");
  git(workDir, "commit", "-m", "second");
  commitB = git(workDir, "rev-parse", "HEAD");

  git(workDir, "push", "origin", BRANCH);

  originUrl = originDir;
  initMirror(coordRoot, originUrl);
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("resolveCoordRoot containment", () => {
  it("rejects a path inside an agent root", () => {
    const agentRoot = tmp;
    const inside = join(tmp, "coord");
    expect(() => resolveCoordRoot(inside, [agentRoot])).toThrow(PathConfinementError);
  });

  it("accepts a path outside all agent roots", () => {
    const agentRoot = join(tmp, "work");
    const outside = join(tmp, "coord");
    const result = resolveCoordRoot(outside, [agentRoot]);
    expect(result).toContain("coord");
  });
});

describe("initMirror", () => {
  it("creates mirror.git directory", () => {
    const mirror = join(coordRoot, "mirror.git");
    expect(execSync(`test -d ${mirror} && echo yes`, { encoding: "utf8" }).trim()).toBe("yes");
  });
});

describe("fetchRef / fetchAgentBranch", () => {
  it("fetches successfully", () => {
    expect(() => fetchAgentBranch(coordRoot, 1, AGENT)).not.toThrow();
  });

  it("throws MirrorFetchError for non-existent ref", () => {
    expect(() => fetchRef(coordRoot, "refs/heads/no-such-branch:refs/heads/no-such-branch")).toThrow(MirrorFetchError);
  });
});

describe("isReachable", () => {
  it("true for a commit on the branch", () => {
    expect(isReachable(coordRoot, commitA, BRANCH)).toBe(true);
  });

  it("false for a random SHA", () => {
    expect(isReachable(coordRoot, "f".repeat(40), BRANCH)).toBe(false);
  });
});

describe("readBlob", () => {
  it("returns file content at a commit", () => {
    const content = readBlob(coordRoot, commitA, "hello.txt");
    expect(content).toBe("hello");
  });

  it("returns null for missing path", () => {
    expect(readBlob(coordRoot, commitA, "nope.txt")).toBeNull();
  });
});

describe("commitExists", () => {
  it("true for existing commit", () => {
    expect(commitExists(coordRoot, commitA)).toBe(true);
  });

  it("false for random SHA", () => {
    expect(commitExists(coordRoot, "f".repeat(40))).toBe(false);
  });
});

describe("isAncestor", () => {
  it("true when ancestor relationship holds", () => {
    expect(isAncestor(coordRoot, commitA, commitB)).toBe(true);
  });

  it("false otherwise", () => {
    expect(isAncestor(coordRoot, commitB, commitA)).toBe(false);
  });
});

describe("changedPaths", () => {
  it("returns changed file paths between commits", () => {
    const paths = changedPaths(coordRoot, commitA, commitB);
    expect(paths).toContain("world.txt");
  });
});
