import { constants, accessSync, lstatSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { platform } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { AgentConfig } from "./state.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";
import { agentNudgeKeyDefaults, agentOwnerUiDefaults } from "./setupWorkspace.js";

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

/** Strip CSI / OSC sequences so readiness checks can match visible TUI text. */
export const stripAnsi = (text: string): string => {
  const esc = String.fromCharCode(0x1b);
  const bel = String.fromCharCode(0x07);
  return text
    .replace(new RegExp(`${esc}\\[[0-9;?]*[ -/]*[@-~]`, "g"), "")
    .replace(new RegExp(`${esc}\\][^${bel}${esc}]*(?:${bel}|${esc}\\\\)`, "g"), "")
    .replace(new RegExp(`${esc}.`, "g"), "");
};
/** True when the pane looks ready for a short action paste. */
export const harnessLooksReady = (foreground: string, expected?: string): boolean => {
  if (expected === undefined || expected === "") return true;
  if (foreground === expected) return true;
  // Claude Code sometimes reports its version string as the pane command.
  if (expected === "claude" && /^\d+(?:\.\d+)*$/.test(foreground)) return true;
  // Cursor's `agent` CLI often appears as `node` in tmux.
  if (expected === "agent" && foreground === "node") return true;
  // Antigravity may show as agy, antigravity, or node (nvm / verify UI).
  if (expected === "agy" && (foreground === "agy" || foreground === "antigravity" || foreground === "node")) {
    return true;
  }
  return false;
};

/**
 * True when the TUI has an idle prompt that can accept typed input.
 * Process-name readiness alone is not enough: Antigravity/`agy` can be foreground
 * during splash while keys are discarded; Claude may still be on the trust dialog.
 */
export const harnessPromptReady = (paneText: string, agentId: string): boolean => {
  const plain = stripAnsi(paneText);
  if (/trust this folder/i.test(plain)) return false;
  switch (agentId) {
    case "claude":
      return /❯|auto mode|-- INSERT --/i.test(plain);
    case "cursor":
      return /Add a follow-up|Run Everything|Auto ·/i.test(plain);
    case "antigravity":
      // Escape cancels an in-flight turn; do not nudge while working.
      if (/esc to cancel|Generating\.\.\.|Running\.\.\.|Working\.\.\./i.test(plain)) return false;
      // Account-verify overlay still shows `>` / Accept-edits; keys are discarded.
      if (/Verifying your account|account eligibility|Please try again shortly/i.test(plain)) return false;
      return (/>|shortcuts|Accept-edits/i.test(plain) && /Antigravity|Gemini|accept-edits/i.test(plain));
    case "codex":
      // Codex accepts keys once the process is up; avoid blocking on transient UI.
      return true;
    default:
      return true;
  }
};

/** Resolve configured or default prelude/submit keys for an agent nudge. */
export const resolveNudgeKeys = (
  agent: AgentConfig
): { prelude: readonly string[]; submit: readonly string[] } => {
  const defaults = agentOwnerUiDefaults(agent.id);
  const prelude = agent.nudgePrelude ?? defaults.nudgePrelude;
  let rawSubmit = agent.nudgeSubmit ?? defaults.nudgeSubmit;
  // #28 applied Escape+Enter to Antigravity; there Escape cancels.
  if (
    agent.id === "antigravity" &&
    rawSubmit.length === 2 &&
    rawSubmit[0] === "Escape" &&
    rawSubmit[1] === "Enter"
  ) {
    rawSubmit = defaults.nudgeSubmit;
  }
  // #26/#27 left many Claude/Cursor runtimes on bare Enter/C-m.
  // Antigravity wants bare Enter; only upgrade stale C-m there.
  const staleBareSubmit =
    rawSubmit.length === 1 &&
    (agent.id === "antigravity"
      ? rawSubmit[0] === "C-m"
      : rawSubmit[0] === "Enter" || rawSubmit[0] === "C-m");
  const submit = staleBareSubmit ? defaults.nudgeSubmit : rawSubmit;
  return { prelude, submit };
};

/** Delay after typing nudge text before the first submit key (lets autocomplete engage). */
export const NUDGE_AFTER_TEXT_MS = 300;
/** Delay between successive submit keys (Escape must land before Enter). */
export const NUDGE_BETWEEN_SUBMIT_MS = 150;

/** Resolve macOS Terminal.app profile name for an owner attach window. */
export const resolveTerminalProfile = (agent: AgentConfig): string =>
  agent.terminalProfile ?? agentOwnerUiDefaults(agent.id).terminalProfile;

/** @deprecated Prefer resolveNudgeKeys(agent). */
export const nudgePreludeKeys = (agentId: string): readonly string[] => agentNudgeKeyDefaults(agentId).nudgePrelude;

/**
 * Shell command that attaches a dedicated tmux client focused on one agent window.
 *
 * Uses a linked session name per agent so each Terminal keeps its own current
 * window. Semicolons are single-quoted (`';`) so macOS Terminal/do-script
 * cannot turn them into shell command separators (which would skip select-window
 * and leave every client on the last window, usually antigravity).
 */
export const agentClientAttachCommand = (session: string, agentId: string): string => {
  const window = safeName(agentId);
  const client = `${session}-${window}`;
  return [
    `tmux new-session -A -s ${client} -t ${session}`,
    `select-window -t ${window}`,
    "set-option destroy-unattached on"
  ].join(" ';' ");
};

export type OwnerTerminalLaunch = {
  agentId: string;
  command: string;
  terminalProfile: string;
  /**
   * Unique tab custom title including workspace group id
   * (`coord-N-<group>/<agent>`). Close scans only for these exact strings.
   */
  windowTitle: string;
};
export type OwnerTerminalOpener = (launches: readonly OwnerTerminalLaunch[]) => Promise<void>;
/** Close tabs whose custom title is in this exact list (unique group ids). */
export type OwnerTerminalCloser = (titles: readonly string[]) => void;

const appleScriptString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Stable Terminal.app custom title for an issue's owner agent tab.
 * Always pass `group` (= workspace terminalGroup) so titles are unique across
 * products; close must match these exact strings only.
 */
export const ownerTerminalWindowTitle = (
  issue: number,
  agentId: string,
  group: string | null = null
): string => {
  const session =
    group === null || group === ""
      ? `coord-${issue}`
      : `coord-${issue}-${safeName(group)}`;
  return `${session}/${safeName(agentId)}`;
};

/**
 * Exact titles to close for an issue. Only the unique grouped form when `group`
 * is set — never bare agent names and never ungrouped `coord-N/<agent>`
 * (those collide across products).
 */
export const ownerTerminalTitlesToClose = (
  issue: number,
  agentIds: readonly string[],
  group: string | null = null
): string[] => {
  const titles: string[] = [];
  const seen = new Set<string>();
  const add = (title: string): void => {
    if (seen.has(title)) return;
    seen.add(title);
    titles.push(title);
  };
  for (const agentId of agentIds) {
    add(ownerTerminalWindowTitle(issue, agentId, group));
  }
  return titles;
};

/**
 * Open one attach tab via `do script` and set that tab's custom title to the
 * unique group id title. Does not use `make new window` (-10000),
 * `window of newTab` (-10006), or `front window`.
 */
export const ownerTerminalOpenAppleScript = (launch: OwnerTerminalLaunch): string => {
  const title = launch.windowTitle.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const profile = launch.terminalProfile.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [
    'tell application "Terminal"',
    `  set newTab to do script ${appleScriptString(launch.command)}`,
    `  set custom title of newTab to "${title}"`,
    "  try",
    `    set current settings of newTab to settings set "${profile}"`,
    "  end try",
    "end tell"
  ].join("\n");
};

export const openDarwinTerminalWindows: OwnerTerminalOpener = async (launches) => {
  for (const launch of launches) {
    const script = ownerTerminalOpenAppleScript(launch);
    const result = await new Promise<TmuxResult>((resolvePromise, reject) => {
      const child = spawn("osascript", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.once("error", reject);
      child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr: stderr.trim() }));
    });
    if (result.exitCode !== 0) {
      throw new Error(`osascript failed for ${launch.agentId}: ${result.stderr || `exit ${result.exitCode}`}`);
    }
  }
};

/**
 * Close tabs whose custom title is exactly in `titles` (must be unique group
 * ids from ownerTerminalTitlesToClose). Never matches bare agent names.
 */
export const ownerTerminalCloseAppleScript = (titles: readonly string[]): string => {
  const list = titles.map((title) => appleScriptString(title)).join(", ");
  return [
    'tell application "Terminal"',
    `  set wanted to {${list}}`,
    "  set tabsToClose to {}",
    "  repeat with w in windows",
    "    try",
    "      repeat with tb in tabs of w",
    "        try",
    "          set t to custom title of tb",
    "          if wanted contains t then set end of tabsToClose to tb",
    "        end try",
    "      end repeat",
    "    end try",
    "  end repeat",
    "  repeat with tb in tabsToClose",
    "    try",
    "      close tb",
    "    end try",
    "  end repeat",
    "end tell"
  ].join("\n");
};

export const closeDarwinTerminalWindows: OwnerTerminalCloser = (titles) => {
  if (titles.length === 0) return;
  const script = ownerTerminalCloseAppleScript(titles);
  const result = spawnSync("osascript", ["-e", script], { encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(`osascript failed to close Terminal tabs: ${(result.stderr ?? "").trim() || `exit ${result.status}`}`);
  }
};

export type OpenOwnerAgentClientsResult =
  | { status: "opened"; count: number }
  | { status: "unsupported"; commands: readonly string[] }
  | { status: "failed"; error: string; commands: readonly string[] };

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
    private readonly namespace: string | null = null,
    private readonly ownerTerminalOpener: OwnerTerminalOpener | null =
      platform() === "darwin" ? openDarwinTerminalWindows : null,
    private readonly ownerTerminalCloser: OwnerTerminalCloser | null =
      platform() === "darwin" ? closeDarwinTerminalWindows : null,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolvePromise) => setTimeout(resolvePromise, ms)),
    /** Workspace fingerprint for Terminal titles; defaults to tmux namespace. */
    private readonly titleGroup: string | null = null
  ) {}

  /** Group id embedded in Terminal custom titles for this workspace. */
  private terminalTitleGroup(): string | null {
    return this.titleGroup ?? this.namespace;
  }

  sessionName(issue: number): string {
    return `coord-${issue}${this.namespace === null ? "" : `-${safeName(this.namespace)}`}`;
  }

  target(issue: number, agent: string): string {
    return `${this.sessionName(issue)}:${safeName(agent)}.0`;
  }

  agentAttachLaunches(issue: number, agents: readonly AgentConfig[]): OwnerTerminalLaunch[] {
    const session = this.sessionName(issue);
    const group = this.terminalTitleGroup();
    return agents.map((agent) => ({
      agentId: agent.id,
      command: agentClientAttachCommand(session, agent.id),
      terminalProfile: resolveTerminalProfile(agent),
      windowTitle: ownerTerminalWindowTitle(issue, agent.id, group)
    }));
  }

  ownerTerminalTitles(issue: number, agentIds: readonly string[]): string[] {
    return ownerTerminalTitlesToClose(issue, agentIds, this.terminalTitleGroup());
  }

  /** List the primary issue session and any linked per-agent client sessions. */
  async listIssueSessions(issue: number): Promise<string[]> {
    const session = this.sessionName(issue);
    const listed = await this.runner(["list-sessions", "-F", "#{session_name}"]);
    if (listed.exitCode !== 0) return [];
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => name === session || name.startsWith(`${session}-`));
  }

  async killIssueSessions(issue: number): Promise<string[]> {
    const names = await this.listIssueSessions(issue);
    for (const name of names) {
      await this.runner(["kill-session", "-t", name]);
    }
    return names;
  }

  /**
   * Close owner Terminal.app tabs whose custom titles match this issue's unique
   * group ids. Failures are returned so detach/wipe can continue after tmux teardown.
   */
  closeOwnerAgentClients(
    issue: number,
    agentIds: readonly string[]
  ): { status: "closed" | "unsupported" | "failed"; titles: readonly string[]; error?: string } {
    const titles = ownerTerminalTitlesToClose(issue, agentIds, this.terminalTitleGroup());
    if (this.ownerTerminalCloser === null) return { status: "unsupported", titles };
    try {
      this.ownerTerminalCloser(titles);
      return { status: "closed", titles };
    } catch (error) {
      return {
        status: "failed",
        titles,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Open one owner OS terminal per agent, each attached to that agent's window.
   * Failures are returned (not thrown) so issue startup can continue detached.
   */
  async openOwnerAgentClients(issue: number, agents: readonly AgentConfig[]): Promise<OpenOwnerAgentClientsResult> {
    const launches = this.agentAttachLaunches(issue, agents);
    const commands = launches.map((launch) => launch.command);
    if (this.ownerTerminalOpener === null) return { status: "unsupported", commands };
    try {
      await this.ownerTerminalOpener(launches);
      return { status: "opened", count: launches.length };
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        commands
      };
    }
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

  async capturePane(target: string): Promise<string> {
    const captured = await this.runner(["capture-pane", "-ep", "-t", target, "-S", "-40"]);
    if (captured.exitCode !== 0) return "";
    return captured.stdout;
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
    const paneText = await this.capturePane(target);
    assertAuthority();
    if (!harnessPromptReady(paneText, agent.id)) return "busy";
    const text = `Read and execute your current coordinator action at ${actionPath}`;
    // Some harnesses (notably agy) ignore tmux paste-buffer; literal send-keys
    // reaches the input widget. Prelude/submit keys come from agent config.
    const { prelude: preludeKeys, submit: submitKeys } = resolveNudgeKeys(agent);
    for (const key of preludeKeys) {
      const prelude = await this.runner(["send-keys", "-t", target, key]);
      assertAuthority();
      if (prelude.exitCode !== 0) throw new Error(`tmux send-keys prelude failed: ${prelude.stderr}`);
    }
    const typed = await this.runner(["send-keys", "-l", "-t", target, text]);
    assertAuthority();
    if (typed.exitCode !== 0) throw new Error(`tmux send-keys text failed: ${typed.stderr}`);
    // Autocomplete/multiline handlers need a beat before Escape; then gap before Enter.
    await this.sleep(NUDGE_AFTER_TEXT_MS);
    assertAuthority();
    for (const [index, key] of submitKeys.entries()) {
      if (index > 0) {
        await this.sleep(NUDGE_BETWEEN_SUBMIT_MS);
        assertAuthority();
      }
      const submit = await this.runner(["send-keys", "-t", target, key]);
      assertAuthority();
      if (submit.exitCode !== 0) throw new Error(`tmux send-keys submit failed: ${submit.stderr}`);
    }
    return "sent";
  }
}
