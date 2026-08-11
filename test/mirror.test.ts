import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupMirror, fetchOriginRef, isReachable, readBlob } from "../src/mirror.js";
import { ensureContained, refuseInsideClones, resolveIssueRoot } from "../src/paths.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import child_process from "node:child_process";

vi.mock("node:child_process");

describe("paths (external-root refusal)", () => {
  it("refuses coord root inside clone root", () => {
    expect(() => refuseInsideClones("/tmp/coord", ["/tmp/coord/agent1"])).not.toThrow();
    expect(() => refuseInsideClones("/tmp/agent1/coord", ["/tmp/agent1"])).toThrow(/inside agent clone/);
  });
  
  it("resolves issue root correctly", () => {
    expect(resolveIssueRoot("/tmp/coord", 1)).toBe(resolve("/tmp/coord/issue-1"));
  });
  
  it("ensureContained rejects paths outside root", () => {
    expect(() => ensureContained("/tmp/root", "../escape")).toThrow(/escapes/);
    expect(ensureContained("/tmp/root", "safe")).toBe(resolve("/tmp/root/safe"));
  });
});

describe("mirror", () => {
  let tmpRoot: string;
  const mockSpawn = child_process.spawnSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "mirror-test-")));
    vi.resetAllMocks();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  const mockGitSuccess = (stdout = "") => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(""),
      error: null
    });
  };
  
  const mockGitFailure = (stderr = "") => {
    mockSpawn.mockReturnValueOnce({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(stderr),
      error: null
    });
  };

  it("sets up bare mirror", () => {
    mockGitSuccess(); // git init --bare
    const mirror = setupMirror(tmpRoot, 1, []);
    expect(mirror.root).toBe(join(tmpRoot, "issue-1", "mirror.git"));
  });

  it("fetches origin ref", () => {
    mockGitSuccess(); // git init
    const mirror = setupMirror(tmpRoot, 1, []);
    
    mockGitSuccess();
    expect(fetchOriginRef(mirror, "http://remote", "main")).toBe("success");
    
    mockGitFailure("fatal: couldn't find remote ref");
    expect(fetchOriginRef(mirror, "http://remote", "missing")).toBe("missing");
    
    mockGitFailure("fatal: unable to access");
    expect(fetchOriginRef(mirror, "http://remote", "main")).toBe("transient-failure");
  });

  it("checks reachability", () => {
    mockGitSuccess(); // git init
    const mirror = setupMirror(tmpRoot, 1, []);
    
    mockGitSuccess();
    expect(isReachable(mirror, "sha1", "main")).toBe(true);
    
    mockGitFailure();
    expect(isReachable(mirror, "sha2", "main")).toBe(false);
  });

  it("reads blob", () => {
    mockGitSuccess(); // git init
    const mirror = setupMirror(tmpRoot, 1, []);
    
    mockGitSuccess("blob content");
    const content = readBlob(mirror, "sha1", "file.txt");
    expect(content?.toString()).toBe("blob content");
    
    mockGitFailure();
    expect(readBlob(mirror, "sha1", "missing.txt")).toBeNull();
  });
});
