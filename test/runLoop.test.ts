import { describe, it, expect, vi } from "vitest";
import { finalizeR7 } from "../src/runLoop.js";
import child_process from "node:child_process";
import * as finalization from "../src/finalization.js";

vi.mock("node:child_process");

describe("runLoop", () => {
  it("finalizeR7 calls verifyFinalization and spawns check", () => {
    const mockSpawn = child_process.spawnSync as unknown as ReturnType<typeof vi.fn>;
    mockSpawn.mockReturnValueOnce({ status: 0 });
    
    vi.spyOn(finalization, "verifyFinalization").mockReturnValueOnce({
      ok: true, issue: 1, consensusSha: "", finalSha: "", deletedPaths: []
    });
    
    expect(() => finalizeR7("/tmp", 1, "c", "f", ["echo", "test"])).not.toThrow();
    expect(mockSpawn).toHaveBeenCalled();
  });
  
  it("finalizeR7 blocks if check fails", () => {
    const mockSpawn = child_process.spawnSync as unknown as ReturnType<typeof vi.fn>;
    mockSpawn.mockReturnValueOnce({ status: 1 }); // check fails
    
    vi.spyOn(finalization, "verifyFinalization").mockReturnValueOnce({
      ok: true, issue: 1, consensusSha: "", finalSha: "", deletedPaths: []
    });
    
    expect(() => finalizeR7("/tmp", 1, "c", "f", ["echo", "test"])).toThrow(/blocking PR creation/);
  });
});
