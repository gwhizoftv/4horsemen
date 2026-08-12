import { constants, accessSync, lstatSync, realpathSync } from "node:fs";
import { spawn } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { AgentConfig } from "./state.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";

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

/** True when the pane looks ready for a short action paste. */
export const harnessLooksReady = (foreground: string, expected?: string): boolean => {
  if (expected === undefined || expected === "") return true;
  if (foreground === expected) return true;
  // Claude Code sometimes reports its version string as the pane command.
  if (expected === "claude" && /^\d+(?:\.\d+)*$/.test(foreground)) return true;
  // Cursor's `agent` CLI often appears as `node` in tmux.
  if (expected === "agent" && foreground === "node") return true;
  return false;
};

/**
 * Keys to send before the nudge text. Happy-path harnesses (Claude Code,
 * Cursor agent, Codex, Antigravity) are not vim-normal prompts — a leading
 * `a` is typed literally ("aRead and execute…"). Keep this empty unless an
 * agent is known to need a vim append prelude.
 */
export const nudgePreludeKeys = (agentId: string): readonly string[] => {
  void agentId;
  return [];
};

export const resolveAgentLauncher = (agent: AgentConfig): string => {
  const root = resolve(agent.root);
  if (isAbsolute(agent.launcher)) throw new Error(`Launcher for ${agent.id} must be relative to its agent clone.`);
  const launcher = containedPath(root, agent.launcher);
  assertNoSymlink(root, launcher);
  let realLauncher: string;
  try {
    if (!lstatSync(launcher).isFile()) throw new Error("launcher is not a regular file");
    accessSync(launcher, constants.X_OK);
    realLauncher = realpathSync(launcher);
  } catch (error) {
    throw new Error(
      `Missing or non-executable launcher for ${agent.id}: ${launcher}${
        error instanceof Error && error.message !== "" ? ` (${error.message})` : ""
      }`
    );
  }
  if (!isPathInside(realpathSync(root), realLauncher)) {
    throw new Error(`Launcher for ${agent.id} escapes agent root: ${launcher}`);
  }
  return launcher;
};

export class TmuxController {
  constructor(
    private readonly runner: TmuxRunner = runTmux,
    private readonly namespace: string | null = null
  ) {}

  sessionName(issue: number): string {
    return `coord-${issue}${this.namespace === null ? "" : `-${safeName(this.namespace)}`}`;
  }

  target(issue: number, agent: string): string {
    return `${this.sessionName(issue)}:${safeName(agent)}.0`;
  }

  async preflight(agents: readonly AgentConfig[]): Promise<void> {
    for (const agent of agents) resolveAgentLauncher(agent);
    const available = await this.runner(["-V"]);
    if (available.exitCode !== 0) throw new Error(`tmux is unavailable: ${available.stderr}`);
  }

  async startSession(issue: number, agents: readonly AgentConfig[]): Promise<void> {
    await this.preflight(agents);
    const session = this.sessionName(issue);
    const exists = await this.runner(["has-session", "-t", session]);
    if (exists.exitCode === 0) throw new Error(`tmux session ${session} already exists; resume or remove it explicitly.`);
    const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
    if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    try {
      for (const agent of agents) {
        const launcher = resolveAgentLauncher(agent);
        const target = `${session}:${safeName(agent.id)}`;
        const window = await this.runner([
          "new-window",
          "-d",
          "-t",
          session,
          "-n",
          safeName(agent.id),
          "-c",
          resolve(agent.root),
          launcher
        ]);
        if (window.exitCode !== 0) throw new Error(`cannot launch ${agent.id} in ${target}: ${window.stderr}`);
      }
    } catch (error) {
      await this.runner(["kill-session", "-t", session]);
      throw error;
    }
  }

  async stopSession(issue: number): Promise<void> {
    await this.runner(["kill-session", "-t", this.sessionName(issue)]);
  }

  async ensureSession(
    issue: number,
    agents: readonly AgentConfig[],
    assertAuthority: () => void = () => undefined
  ): Promise<void> {
    const session = this.sessionName(issue);
    const exists = await this.runner(["has-session", "-t", session]);
    assertAuthority();
    if (exists.exitCode !== 0) {
      const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
      assertAuthority();
      if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    }
    for (const agent of agents) {
      const target = `${session}:${safeName(agent.id)}`;
      const present = await this.runner(["list-windows", "-t", session, "-F", "#{window_name}"]);
      assertAuthority();
      if (present.exitCode !== 0) throw new Error(`cannot inspect tmux session ${session}: ${present.stderr}`);
      if (present.stdout.split("\n").includes(safeName(agent.id))) continue;
      const launcher = resolveAgentLauncher(agent);
      const created = await this.runner(["new-window", "-d", "-t", session, "-n", safeName(agent.id), "-c", resolve(agent.root), launcher]);
      assertAuthority();
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

  async nudge(
    issue: number,
    agent: AgentConfig,
    actionPath: string,
    assertAuthority: () => void = () => undefined
  ): Promise<"sent" | "disabled" | "busy" | "gone"> {
    if (agent.delivery !== "nudge" && agent.delivery !== "both") return "disabled";
    const target = this.target(issue, agent.id);
    const pane = await this.inspectPane(target);
    assertAuthority();
    if (!pane.alive) return "gone";
    if (pane.ownerTyping) return "busy";
    if (!harnessLooksReady(pane.foreground, agent.harnessProcess)) return "busy";
    const text = `Read and execute your current coordinator action at ${actionPath}`;
    // Some harnesses (notably agy) ignore tmux paste-buffer; literal send-keys
    // reaches the input widget. Optional prelude enters insert/append for vim UIs.
    for (const key of nudgePreludeKeys(agent.id)) {
      const prelude = await this.runner(["send-keys", "-t", target, key]);
      assertAuthority();
      if (prelude.exitCode !== 0) throw new Error(`tmux send-keys prelude failed: ${prelude.stderr}`);
    }
    const typed = await this.runner(["send-keys", "-l", "-t", target, text]);
    assertAuthority();
    if (typed.exitCode !== 0) throw new Error(`tmux send-keys text failed: ${typed.stderr}`);
    const enter = await this.runner(["send-keys", "-t", target, "Enter"]);
    if (enter.exitCode !== 0) throw new Error(`tmux send-keys Enter failed: ${enter.stderr}`);
    return "sent";
  }
}
