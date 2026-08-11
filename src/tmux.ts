import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * tmux integration.
 *
 * tmux is used only as an external client that can create attachable agent
 * panes and, where the harness policy allows it, insert a short nudge. It is
 * never a source of workflow authority and never a completion signal:
 * completion is detected by polling the `complete` file. `tmux wait-for` is
 * not used anywhere — its `-S` toggles when no waiter is present, which can
 * wedge the next wait forever.
 */

export type TmuxRun = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

/** Injected boundary: tests drive a fake runner or a throwaway real socket. */
export type TmuxRunner = (args: readonly string[]) => TmuxRun;

export const spawnTmux: TmuxRunner = (args) => {
  const result = spawnSync("tmux", [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: 15_000
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? (result.stderr ?? "").trim()
  };
};

/**
 * Automatic insertion policy by harness.
 *
 * Only Claude Code can absorb a mid-turn insertion safely today. Codex,
 * Cursor, and Antigravity stay pull-only until a harness-specific idle fixture
 * proves insertion safe; the owner can always type a nudge by hand.
 */
export const harnessAllowsAutomaticNudge = (harness: string): boolean => harness.toLowerCase() === "claude";

export type NudgeDecision =
  | { readonly nudge: true }
  | { readonly nudge: false; readonly reason: string };

export type NudgeConditions = {
  readonly harness: string;
  /** Owner opt-in from configuration. Both this and the policy must agree. */
  readonly configured: boolean;
  readonly paneExists: boolean;
  readonly harnessRunning: boolean;
  readonly paneInMode: boolean;
};

export const shouldNudge = (conditions: NudgeConditions): NudgeDecision => {
  if (!harnessAllowsAutomaticNudge(conditions.harness)) {
    return { nudge: false, reason: `${conditions.harness} is pull-only until an idle fixture proves insertion safe` };
  }

  if (!conditions.configured) {
    return { nudge: false, reason: "automatic nudging is not enabled for this agent" };
  }

  if (!conditions.paneExists) {
    return { nudge: false, reason: "pane does not exist" };
  }

  if (!conditions.harnessRunning) {
    return { nudge: false, reason: "harness is not the foreground process in that pane" };
  }

  if (conditions.paneInMode) {
    return { nudge: false, reason: "pane is in copy mode or the owner is interacting with it" };
  }

  return { nudge: true };
};

export type TmuxOutcome = { readonly ok: true } | { readonly ok: false; readonly error: string };

export const sessionName = (issue: number): string => `consensus-${issue}`;

export const launcherPath = (clonePath: string, agent: string): string =>
  join(clonePath, `start-${agent}.sh`);

/**
 * A missing or non-executable launcher is a named startup failure. It is never
 * silently replaced by a bare shell — an agent pane without its harness looks
 * alive while doing nothing.
 */
export const assertLauncherUsable = (clonePath: string, agent: string): TmuxOutcome => {
  const path = launcherPath(clonePath, agent);

  try {
    accessSync(path, constants.X_OK);

    return { ok: true };
  } catch {
    return {
      ok: false,
      error: `launcher ${path} is missing or not executable; create it and mark it executable before starting ${agent}`
    };
  }
};

export type TmuxController = {
  readonly available: boolean;
  paneTarget: (issue: number, agent: string) => string;
  ensureSession: (issue: number) => TmuxOutcome;
  /** Create the agent's window and start its harness through start-<agent>.sh. */
  launchAgent: (issue: number, agent: string, clonePath: string) => TmuxOutcome;
  paneExists: (target: string) => boolean;
  foregroundCommand: (target: string) => string | null;
  paneInMode: (target: string) => boolean;
  /** True when the pane is gone or no longer running its harness. */
  harnessDisappeared: (target: string, harness: string) => boolean;
  /** Deliver text through load-buffer/paste-buffer rather than send-keys. */
  insert: (target: string, text: string) => TmuxOutcome;
  killSession: (issue: number) => void;
};

const failed = (run: TmuxRun, context: string): TmuxOutcome => ({
  ok: false,
  error: `${context}: ${run.stderr === "" ? `exit ${String(run.status)}` : run.stderr}`
});

export const createTmuxController = (runner: TmuxRunner = spawnTmux): TmuxController => {
  const available = runner(["-V"]).status === 0;

  const paneTarget = (issue: number, agent: string): string => `${sessionName(issue)}:${agent}.0`;

  const display = (target: string, format: string): string | null => {
    const run = runner(["display-message", "-p", "-t", target, format]);

    return run.status === 0 ? run.stdout.trim() : null;
  };

  const paneExists = (target: string): boolean =>
    runner(["has-session", "-t", target.split(":")[0] ?? target]).status === 0 &&
    display(target, "#{pane_id}") !== null;

  const foregroundCommand = (target: string): string | null => display(target, "#{pane_current_command}");

  return {
    available,
    paneTarget,
    paneExists,
    foregroundCommand,
    paneInMode: (target) => display(target, "#{pane_in_mode}") === "1",
    harnessDisappeared: (target, harness) => {
      if (!paneExists(target)) {
        return true;
      }

      const command = foregroundCommand(target);

      return command === null || !command.toLowerCase().includes(harness.toLowerCase());
    },
    ensureSession: (issue) => {
      const session = sessionName(issue);

      if (runner(["has-session", "-t", session]).status === 0) {
        return { ok: true };
      }

      const run = runner(["new-session", "-d", "-s", session, "-n", "control"]);

      return run.status === 0 ? { ok: true } : failed(run, `could not create tmux session ${session}`);
    },
    launchAgent: (issue, agent, clonePath) => {
      const usable = assertLauncherUsable(clonePath, agent);

      if (!usable.ok) {
        return usable;
      }

      const session = sessionName(issue);
      const run = runner([
        "new-window",
        "-d",
        "-t",
        session,
        "-n",
        agent,
        "-c",
        clonePath,
        launcherPath(clonePath, agent)
      ]);

      return run.status === 0 ? { ok: true } : failed(run, `could not launch ${agent}`);
    },
    insert: (target, text) => {
      // A file-backed buffer avoids shell quoting and argument-length limits
      // entirely; send-keys would re-interpret the payload.
      const scratch = mkdtempSync(join(tmpdir(), "coord-tmux-"));
      const file = join(scratch, "buffer");
      const bufferName = `coord-${Date.now().toString(36)}`;

      try {
        writeFileSync(file, text);

        const loaded = runner(["load-buffer", "-b", bufferName, file]);

        if (loaded.status !== 0) {
          return failed(loaded, "could not load tmux buffer");
        }

        const pasted = runner(["paste-buffer", "-b", bufferName, "-t", target, "-d"]);

        return pasted.status === 0 ? { ok: true } : failed(pasted, `could not paste into ${target}`);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    killSession: (issue) => {
      runner(["kill-session", "-t", sessionName(issue)]);
    }
  };
};

/** Short nudge text. It carries no workflow state — only "go read your action". */
export const nudgeText = (actionPath: string): string =>
  `Your next action is ready. Read ${actionPath} and follow it.\n`;
