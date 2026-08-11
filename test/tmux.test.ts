import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  assertLauncherUsable,
  createTmuxController,
  harnessAllowsAutomaticNudge,
  launcherPath,
  nudgeText,
  sessionName,
  shouldNudge,
  type TmuxRun,
  type TmuxRunner
} from "../src/tmux.js";

const cleanups: (() => void)[] = [];

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

const ok = (stdout = ""): TmuxRun => ({ status: 0, stdout, stderr: "" });
const fail = (stderr = "no server running"): TmuxRun => ({ status: 1, stdout: "", stderr });

/** Records every tmux invocation so delivery mechanics can be asserted. */
const recordingRunner = (
  responses: (args: readonly string[]) => TmuxRun
): { runner: TmuxRunner; calls: string[][] } => {
  const calls: string[][] = [];

  return {
    calls,
    runner: (args) => {
      calls.push([...args]);

      return responses(args);
    }
  };
};

describe("nudge policy", () => {
  it("allows automatic nudging only for Claude", () => {
    expect(harnessAllowsAutomaticNudge("claude")).toBe(true);
    expect(harnessAllowsAutomaticNudge("Claude")).toBe(true);

    for (const harness of ["codex", "cursor", "antigravity", "unknown"]) {
      expect(harnessAllowsAutomaticNudge(harness)).toBe(false);
    }
  });

  const base = {
    harness: "claude",
    configured: true,
    paneExists: true,
    harnessRunning: true,
    paneInMode: false
  };

  it("nudges Claude when every condition holds", () => {
    expect(shouldNudge(base)).toEqual({ nudge: true });
  });

  it("refuses to nudge a non-Claude harness even when configured", () => {
    for (const harness of ["codex", "cursor", "antigravity"]) {
      const decision = shouldNudge({ ...base, harness });

      expect(decision.nudge).toBe(false);

      if (!decision.nudge) {
        expect(decision.reason).toContain("pull-only");
      }
    }
  });

  it("refuses when the owner has not enabled nudging for the agent", () => {
    expect(shouldNudge({ ...base, configured: false }).nudge).toBe(false);
  });

  it("refuses when the pane is gone", () => {
    const decision = shouldNudge({ ...base, paneExists: false });

    expect(decision.nudge).toBe(false);

    if (!decision.nudge) {
      expect(decision.reason).toContain("pane does not exist");
    }
  });

  it("refuses when the harness is not the foreground process", () => {
    const decision = shouldNudge({ ...base, harnessRunning: false });

    expect(decision.nudge).toBe(false);

    if (!decision.nudge) {
      expect(decision.reason).toContain("foreground");
    }
  });

  it("refuses while the owner is interacting with the pane", () => {
    const decision = shouldNudge({ ...base, paneInMode: true });

    expect(decision.nudge).toBe(false);

    if (!decision.nudge) {
      expect(decision.reason).toContain("copy mode");
    }
  });

  it("carries no workflow state in the nudge text", () => {
    const text = nudgeText("/owner/coord/issue-1/agents/claude/action.md");

    expect(text).toContain("action.md");
    expect(text).not.toMatch(/gate|step|round|ballot|peer/i);
  });
});

describe("launcher requirements", () => {
  it("accepts an executable launcher", () => {
    const clone = newDir("coord-clone-");
    const script = launcherPath(clone, "claude");

    writeFileSync(script, "#!/usr/bin/env bash\nexec sleep 1\n");
    chmodSync(script, 0o755);

    expect(assertLauncherUsable(clone, "claude")).toEqual({ ok: true });
  });

  it("names a missing launcher as a startup failure rather than falling back", () => {
    const clone = newDir("coord-clone-");
    const outcome = assertLauncherUsable(clone, "claude");

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.error).toContain("start-claude.sh");
      expect(outcome.error).toContain("missing or not executable");
    }
  });

  it("rejects a launcher that is present but not executable", () => {
    const clone = newDir("coord-clone-");

    writeFileSync(launcherPath(clone, "codex"), "#!/usr/bin/env bash\n");
    chmodSync(launcherPath(clone, "codex"), 0o644);

    expect(assertLauncherUsable(clone, "codex").ok).toBe(false);
  });
});

describe("controller with a fake runner", () => {
  it("targets pane 0 of the agent's window in the issue session", () => {
    const { runner } = recordingRunner(() => ok());

    expect(createTmuxController(runner).paneTarget(1, "claude")).toBe("consensus-1:claude.0");
    expect(sessionName(42)).toBe("consensus-42");
  });

  it("creates the session only when it is absent", () => {
    const existing = recordingRunner((args) => (args[0] === "has-session" ? ok() : ok()));
    const controller = createTmuxController(existing.runner);

    expect(controller.ensureSession(1)).toEqual({ ok: true });
    expect(existing.calls.some((call) => call[0] === "new-session")).toBe(false);

    const absent = recordingRunner((args) => (args[0] === "has-session" ? fail() : ok()));

    expect(createTmuxController(absent.runner).ensureSession(1)).toEqual({ ok: true });
    expect(absent.calls.some((call) => call[0] === "new-session")).toBe(true);
  });

  it("launches the agent through its own start script", () => {
    const clone = newDir("coord-clone-");

    writeFileSync(launcherPath(clone, "claude"), "#!/usr/bin/env bash\n");
    chmodSync(launcherPath(clone, "claude"), 0o755);

    const { runner, calls } = recordingRunner(() => ok());

    expect(createTmuxController(runner).launchAgent(1, "claude", clone)).toEqual({ ok: true });

    const newWindow = calls.find((call) => call[0] === "new-window");

    expect(newWindow).toBeDefined();
    expect(newWindow?.join(" ")).toContain(join(clone, "start-claude.sh"));
  });

  it("refuses to launch when the launcher is unusable and never opens a bare shell", () => {
    const clone = newDir("coord-clone-");
    const { runner, calls } = recordingRunner(() => ok());
    const outcome = createTmuxController(runner).launchAgent(1, "claude", clone);

    expect(outcome.ok).toBe(false);
    expect(calls.some((call) => call[0] === "new-window")).toBe(false);
  });

  it("delivers text with load-buffer and paste-buffer, never send-keys", () => {
    const { runner, calls } = recordingRunner(() => ok());

    expect(createTmuxController(runner).insert("consensus-1:claude.0", "read your action\n")).toEqual({
      ok: true
    });

    const commands = calls.map((call) => call[0]);

    expect(commands).toContain("load-buffer");
    expect(commands).toContain("paste-buffer");
    expect(commands).not.toContain("send-keys");
  });

  it("never uses tmux wait-for", () => {
    const { runner, calls } = recordingRunner(() => ok());
    const controller = createTmuxController(runner);

    controller.ensureSession(1);
    controller.insert("consensus-1:claude.0", "hello");
    controller.paneExists("consensus-1:claude.0");
    controller.harnessDisappeared("consensus-1:claude.0", "claude");

    expect(calls.some((call) => call[0] === "wait-for")).toBe(false);
  });

  it("reports a paste failure instead of claiming delivery", () => {
    const { runner } = recordingRunner((args) => (args[0] === "paste-buffer" ? fail("no such pane") : ok()));
    const outcome = createTmuxController(runner).insert("consensus-1:gone.0", "hello");

    expect(outcome.ok).toBe(false);

    if (!outcome.ok) {
      expect(outcome.error).toContain("no such pane");
    }
  });

  it("detects a disappeared harness when the pane is gone", () => {
    const { runner } = recordingRunner(() => fail());

    expect(createTmuxController(runner).harnessDisappeared("consensus-1:claude.0", "claude")).toBe(true);
  });

  it("detects a disappeared harness when the pane fell back to a shell", () => {
    const { runner } = recordingRunner((args) =>
      args[0] === "display-message" && args.includes("#{pane_current_command}") ? ok("bash") : ok("%1")
    );

    expect(createTmuxController(runner).harnessDisappeared("consensus-1:claude.0", "claude")).toBe(true);
  });

  it("treats a running harness as present", () => {
    const { runner } = recordingRunner((args) =>
      args[0] === "display-message" && args.includes("#{pane_current_command}") ? ok("claude") : ok("%1")
    );

    expect(createTmuxController(runner).harnessDisappeared("consensus-1:claude.0", "claude")).toBe(false);
  });
});

/**
 * Real-tmux coverage on a throwaway socket. Skipped when tmux is unavailable so
 * the suite stays runnable everywhere.
 */
const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!tmuxAvailable)("controller against a real tmux server", () => {
  const socketRunner = (socket: string): TmuxRunner => (args) => {
    const result = spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 15_000 });

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.error?.message ?? (result.stderr ?? "").trim()
    };
  };

  it("creates a session, launches through the script, and inserts into the pane", () => {
    const socket = `coord-test-${process.pid.toString(36)}-${Date.now().toString(36)}`;
    const runner = socketRunner(socket);
    const controller = createTmuxController(runner);
    const clone = newDir("coord-clone-");
    const marker = join(clone, "harness-started");

    cleanups.push(() => {
      runner(["kill-server"]);
    });

    // A fake harness that records that it ran, then idles so the pane persists.
    writeFileSync(
      launcherPath(clone, "claude"),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(marker)}\nexec sleep 30\n`
    );
    chmodSync(launcherPath(clone, "claude"), 0o755);

    expect(controller.ensureSession(1)).toEqual({ ok: true });
    expect(controller.launchAgent(1, "claude", clone)).toEqual({ ok: true });

    const target = controller.paneTarget(1, "claude");

    expect(controller.paneExists(target)).toBe(true);
    expect(controller.insert(target, "hello from the coordinator\n")).toEqual({ ok: true });
    expect(controller.foregroundCommand(target)).not.toBeNull();

    controller.killSession(1);

    expect(controller.paneExists(target)).toBe(false);
  });

  it("reports a missing pane rather than throwing", () => {
    const socket = `coord-test-${process.pid.toString(36)}-${Date.now().toString(36)}-b`;
    const runner = socketRunner(socket);
    const controller = createTmuxController(runner);

    cleanups.push(() => {
      runner(["kill-server"]);
    });

    expect(controller.paneExists("consensus-99:nobody.0")).toBe(false);
    expect(controller.harnessDisappeared("consensus-99:nobody.0", "claude")).toBe(true);
  });
});
