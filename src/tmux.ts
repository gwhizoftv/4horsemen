import { constants, accessSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { AgentConfig } from "./state.js";

export type TmuxResult = { exitCode: number; stdout: string; stderr: string };
export type TmuxRunner = (args: readonly string[], input?: string) => Promise<TmuxResult>;

export const runTmux: TmuxRunner = (args, input) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("tmux", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr: stderr.trim() }));
    child.stdin.end(input ?? "");
  });

export type PaneState = { alive: boolean; foreground: string; ownerTyping: boolean };

const safeName = (value: string): string => value.replace(/[^A-Za-z0-9_-]/g, "-");

export class TmuxController {
  constructor(private readonly runner: TmuxRunner = runTmux) {}

  sessionName(issue: number): string {
    return `coord-${issue}`;
  }

  target(issue: number, agent: string): string {
    return `${this.sessionName(issue)}:${safeName(agent)}.0`;
  }

  async ensureSession(issue: number, agents: readonly AgentConfig[]): Promise<void> {
    const session = this.sessionName(issue);
    const exists = await this.runner(["has-session", "-t", session]);
    if (exists.exitCode !== 0) {
      const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
      if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    }
    for (const agent of agents) {
      const target = `${session}:${safeName(agent.id)}`;
      const present = await this.runner(["list-windows", "-t", session, "-F", "#{window_name}"]);
      if (present.exitCode !== 0) throw new Error(`cannot inspect tmux session ${session}: ${present.stderr}`);
      if (present.stdout.split("\n").includes(safeName(agent.id))) continue;
      const launcher = resolve(agent.root, agent.launcher);
      try {
        accessSync(launcher, constants.X_OK);
      } catch {
        throw new Error(`Missing or non-executable launcher for ${agent.id}: ${launcher}`);
      }
      const created = await this.runner(["new-window", "-d", "-t", session, "-n", safeName(agent.id), "-c", resolve(agent.root), launcher]);
      if (created.exitCode !== 0) throw new Error(`cannot launch ${agent.id} in ${target}: ${created.stderr}`);
    }
  }

  async inspectPane(target: string): Promise<PaneState> {
    const inspected = await this.runner([
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_dead}\t#{pane_current_command}\t#{pane_in_mode}"
    ]);
    if (inspected.exitCode !== 0) return { alive: false, foreground: "", ownerTyping: false };
    const [dead = "1", foreground = "", inMode = "0"] = inspected.stdout.trim().split("\t");
    return { alive: dead !== "1", foreground, ownerTyping: inMode === "1" };
  }

  async nudge(issue: number, agent: AgentConfig, actionPath: string): Promise<"sent" | "disabled" | "busy" | "gone"> {
    if (agent.id !== "claude" || (agent.delivery !== "nudge" && agent.delivery !== "both")) return "disabled";
    const target = this.target(issue, agent.id);
    const pane = await this.inspectPane(target);
    if (!pane.alive) return "gone";
    if (pane.ownerTyping) return "busy";
    if (agent.harnessProcess !== undefined && pane.foreground !== agent.harnessProcess) return "busy";
    const buffer = `coord-${issue}-${safeName(agent.id)}`;
    const text = `Read your current coordinator action at ${actionPath}`;
    const loaded = await this.runner(["load-buffer", "-b", buffer, "-"], text);
    if (loaded.exitCode !== 0) throw new Error(`tmux load-buffer failed: ${loaded.stderr}`);
    const pasted = await this.runner(["paste-buffer", "-b", buffer, "-d", "-t", target]);
    if (pasted.exitCode !== 0) throw new Error(`tmux paste-buffer failed: ${pasted.stderr}`);
    const enter = await this.runner(["send-keys", "-t", target, "Enter"]);
    if (enter.exitCode !== 0) throw new Error(`tmux send-keys failed: ${enter.stderr}`);
    return "sent";
  }
}
