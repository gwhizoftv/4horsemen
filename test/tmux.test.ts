import { describe, it, expect, afterEach } from "vitest";
import { tmuxAvailable, defaultNudgePolicy, sessionExists } from "../src/tmux.js";
import { spawnSync } from "node:child_process";

describe("tmux", () => {
  describe("defaultNudgePolicy", () => {
    it("returns allowed:false for cursor harness", () => {
      expect(defaultNudgePolicy("cursor")).toEqual({ harness: "cursor", allowed: false });
    });
    it("returns allowed:false for codex harness", () => {
      expect(defaultNudgePolicy("codex")).toEqual({ harness: "codex", allowed: false });
    });
    it("returns allowed:false for claude-code harness", () => {
      expect(defaultNudgePolicy("claude-code")).toEqual({ harness: "claude-code", allowed: false });
    });
  });

  describe("tmuxAvailable", () => {
    it("returns a boolean", () => {
      const result = tmuxAvailable();
      expect(typeof result).toBe("boolean");
    });
  });

  const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;

  describe.skipIf(!hasTmux)("real tmux", () => {
    const testSession = `test-coord-${Date.now()}`;

    afterEach(() => {
      spawnSync("tmux", ["kill-session", "-t", testSession], { encoding: "utf8", stdio: "ignore" });
    });

    it("createSession creates and sessionExists finds it", () => {
      spawnSync("tmux", ["new-session", "-d", "-s", testSession], { encoding: "utf8", stdio: "ignore" });
      expect(sessionExists(testSession)).toBe(true);
    });

    it("sessionExists returns false for non-existent session", () => {
      expect(sessionExists("nonexistent-session-xyz")).toBe(false);
    });
  });
});
