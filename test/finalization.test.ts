import { describe, it, expect, vi, beforeEach } from "vitest";
import { verifyFinalization } from "../src/finalization.js";
import child_process from "node:child_process";

vi.mock("node:child_process");

describe("verifyFinalization", () => {
  const mockSpawn = child_process.spawnSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const mockGitSuccess = (stdout = "") => {
    mockSpawn.mockReturnValueOnce({
      status: 0,
      stdout: Buffer.from(stdout),
      stderr: Buffer.from(""),
      error: null
    });
  };

  it("passes when only deleting current issue files", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    const out = Buffer.concat([
      Buffer.from("D\0"),
      Buffer.from(".plans/issue-1/plan.md\0")
    ]);
    mockGitSuccess(out.toString("binary"));
    
    const res = verifyFinalization({
      root: "/tmp",
      issue: 1,
      consensusSha: "0000000000000000000000000000000000000000",
      finalSha: "1111111111111111111111111111111111111111"
    });
    
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.deletedPaths).toEqual([".plans/issue-1/plan.md"]);
    }
  });

  it("fails if adding current issue files", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    const out = Buffer.concat([
      Buffer.from("A\0"),
      Buffer.from(".plans/issue-1/plan.md\0")
    ]);
    mockGitSuccess(out.toString("binary"));
    
    const res = verifyFinalization({
      root: "/tmp",
      issue: 1,
      consensusSha: "0000000000000000000000000000000000000000",
      finalSha: "1111111111111111111111111111111111111111"
    });
    
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("non-cleanup-change");
    }
  });

  it("fails if modifying product files", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    const out = Buffer.concat([
      Buffer.from("M\0"),
      Buffer.from("src/index.ts\0")
    ]);
    mockGitSuccess(out.toString("binary"));
    
    const res = verifyFinalization({
      root: "/tmp",
      issue: 1,
      consensusSha: "0000000000000000000000000000000000000000",
      finalSha: "1111111111111111111111111111111111111111"
    });
    
    expect(res.ok).toBe(false);
  });
});
