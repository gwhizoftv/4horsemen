import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureSession, ensureWindow, isHarnessActive, deliverNudge } from "../src/tmux.js";
import child_process from "node:child_process";

vi.mock("node:child_process");

describe("tmux", () => {
  const mockSpawn = child_process.spawnSync as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("creates session if missing", () => {
    mockSpawn.mockReturnValueOnce({ status: 1, stdout: "" }); // has-session fails
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "" }); // new-session
    
    ensureSession("coord-session");
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it("creates window if missing", () => {
    mockSpawn.mockReturnValueOnce({ status: 1, stdout: "" }); // list-panes fails
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "" }); // new-window
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "" }); // send-keys
    
    ensureWindow("coord-session", "claude", "/tmp", "claude");
    expect(mockSpawn).toHaveBeenCalledTimes(3);
  });

  it("checks harness active", () => {
    mockSpawn.mockReturnValueOnce({ status: 0, stdout: "bash\\n" });
    expect(isHarnessActive("coord-session", "claude")).toBe(true);
  });

  it("delivers nudge only to claude", () => {
    deliverNudge("coord-session", "codex", "codex", "a1");
    expect(mockSpawn).toHaveBeenCalledTimes(0); // No calls

    mockSpawn.mockReturnValue({ status: 0, stdout: "" });
    deliverNudge("coord-session", "claude", "claude", "a1");
    expect(mockSpawn).toHaveBeenCalledTimes(2); // set-buffer, paste-buffer
  });
});
