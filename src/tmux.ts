import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface TmuxTarget {
  session: string;
  window: string;
  pane: number;
}

/** Check if tmux is available. */
export function tmuxAvailable(): boolean {
  const r = spawnSync("tmux", ["-V"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000 });
  return r.status === 0;
}

/** Create a tmux session for the coordination issue. */
export function createSession(issue: number): string {
  const session = `consensus-${issue}`;
  const r = spawnSync("tmux", ["new-session", "-d", "-s", session], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000
  });
  if (r.status !== 0 && !r.stderr?.includes("duplicate session")) {
    throw new Error(`Failed to create tmux session: ${r.stderr?.trim() ?? r.error?.message}`);
  }
  return session;
}

/** Check if a session exists. */
export function sessionExists(session: string): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", session], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000
  });
  return r.status === 0;
}

/** Create a window for an agent in the session. */
export function createAgentWindow(session: string, agent: string): TmuxTarget {
  const r = spawnSync("tmux", ["new-window", "-t", session, "-n", agent], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000
  });
  if (r.status !== 0) {
    throw new Error(`Failed to create window for ${agent}: ${r.stderr?.trim()}`);
  }
  return { session, window: agent, pane: 0 };
}

/** Launch an agent's harness using its start script. */
export function launchAgent(agentRoot: string, agent: string, target: TmuxTarget): void {
  const launcher = resolve(agentRoot, `start-${agent}.sh`);
  if (!existsSync(launcher)) {
    throw new Error(`Launcher not found: ${launcher}. The agent clone must have an executable start-${agent}.sh.`);
  }
  const cmd = `bash ${JSON.stringify(launcher)}`;
  spawnSync("tmux", ["send-keys", "-t", `${target.session}:${target.window}.${target.pane}`, cmd, "Enter"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000
  });
}

/** Check if the foreground process in a pane is running. */
export function paneHasProcess(target: TmuxTarget): boolean {
  const r = spawnSync("tmux", ["list-panes", "-t", `${target.session}:${target.window}`, "-F", "#{pane_current_command}"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000
  });
  if (r.status !== 0) return false;
  const cmd = r.stdout?.trim() ?? "";
  return cmd !== "" && cmd !== "bash" && cmd !== "zsh" && cmd !== "sh";
}

/** Insert text into an agent pane via tmux load-buffer + paste-buffer. */
export function insertText(target: TmuxTarget, text: string): void {
  const loadResult = spawnSync("tmux", ["load-buffer", "-"], {
    input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000
  });
  if (loadResult.status !== 0) {
    throw new Error(`tmux load-buffer failed: ${loadResult.stderr?.trim()}`);
  }
  spawnSync("tmux", ["paste-buffer", "-t", `${target.session}:${target.window}.${target.pane}`], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 5000
  });
}

export interface NudgePolicy {
  harness: string;
  allowed: boolean;
}

/** Default nudge policies per harness type. All non-Claude are pull-only until idle fixtures prove safe. */
export function defaultNudgePolicy(harness: string): NudgePolicy {
  return { harness, allowed: false };
}
