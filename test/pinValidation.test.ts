import { describe, it, expect, vi, beforeEach } from "vitest";
import { validatePhasePin } from "../src/pinValidation.js";
import child_process from "node:child_process";

vi.mock("node:child_process");

describe("pinValidation", () => {
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

  const mockGitFailure = (stderr = "") => {
    mockSpawn.mockReturnValueOnce({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from(stderr),
      error: null
    });
  };

  it("fails if base is missing", () => {
    mockGitFailure("fatal: Not a valid object name"); // cat-file base
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("missing-pin");
    }
  });

  it("fails if tip is missing", () => {
    mockGitSuccess(); // cat-file base
    mockGitFailure("fatal: Not a valid object name"); // cat-file tip
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("history-rewrite"); // It maps missing tip to history rewrite because inspection fails
    }
  });

  it("fails if pin is not ancestor of tip", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitFailure(); // merge-base --is-ancestor
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("history-rewrite");
    }
  });

  it("fails if diff fails", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    mockGitFailure(); // diff
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(false);
  });

  it("passes if no changes", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    // git diff --name-status -z output for no changes is empty
    mockGitSuccess("");
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(true);
  });

  it("fails if product files changed", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    const out = Buffer.concat([
      Buffer.from("M\0"),
      Buffer.from("src/index.ts\0")
    ]);
    mockGitSuccess(out.toString("binary"));
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("post-pin-implementation-change");
    }
  });

  it("passes if only current issue coordination files changed", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    const out = Buffer.concat([
      Buffer.from("A\0"),
      Buffer.from(".plans/issue-1/plan.md\0")
    ]);
    mockGitSuccess(out.toString("binary"));
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(true);
  });
  
  it("fails if other issue coordination files changed", () => {
    mockGitSuccess(); // cat-file base
    mockGitSuccess(); // cat-file tip
    mockGitSuccess(); // merge-base --is-ancestor
    
    const out = Buffer.concat([
      Buffer.from("A\0"),
      Buffer.from(".plans/issue-2/plan.md\0")
    ]);
    mockGitSuccess(out.toString("binary"));
    
    const res = validatePhasePin({
      root: "/tmp",
      ref: "origin/issue-1/agent",
      pin: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      tip: "cafebabecafebabecafebabecafebabecafebabe",
      issue: 1,
      subject: "Test subject"
    });
    
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe("cross-issue-coordination-change");
    }
  });
});
