import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { evaluateEvidence } from "../src/evidence.js";
import { setupMirror } from "../src/mirror.js";
import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import child_process from "node:child_process";

vi.mock("node:child_process");

describe("evidence", () => {
  let tmpRoot: string;
  const mockSpawn = child_process.spawnSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    tmpRoot = realpathSync(mkdtempSync(join(tmpdir(), "evidence-test-")));
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
  
  const mockGitFailure = () => {
    mockSpawn.mockReturnValueOnce({
      status: 1,
      stdout: Buffer.from(""),
      stderr: Buffer.from("fatal"),
      error: null
    });
  };

  it("fails if blob missing", () => {
    mockGitSuccess(); // init
    const mirror = setupMirror(tmpRoot, 1, []);
    
    mockGitFailure(); // cat-file
    const obs = evaluateEvidence(mirror, { actionId: "a1", agent: "Alice", task: "", inputs: [], requiredPath: "p" }, "step-1", "sha");
    expect(obs.satisfied).toBe(false);
    expect(obs.outstanding[0]).toMatch(/missing/);
  });
  
  it("passes if blob has valid JSON artifact", () => {
    mockGitSuccess(); // init
    const mirror = setupMirror(tmpRoot, 1, []);
    
    mockGitSuccess(JSON.stringify({ type: "plan", issue: 1, agent: "Alice", content: "Plan" }));
    const obs = evaluateEvidence(mirror, { actionId: "a1", agent: "Alice", task: "", inputs: [], requiredPath: "p" }, "step-1", "sha");
    expect(obs.satisfied).toBe(true);
  });
});
