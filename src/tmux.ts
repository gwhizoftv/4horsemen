import { constants, accessSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
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

export type PaneState = {
  alive: boolean;
  foreground: string;
  ownerTyping: boolean;
  inputOff: boolean;
};

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
      return /❯|auto mode|-- INSERT --|-- NORMAL --|-- VISUAL/i.test(plain);
    case "cursor":
      // Composer placeholder copy changes; do not match it. Block only on
      // in-flight turn chrome. Process readiness is `harnessLooksReady`.
      if (/esc to cancel|Generating|Running\.\.\.|Working\.\.\.|Thinking/i.test(plain)) return false;
      return true;
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

/**
 * Vim-mode TUIs swallow the first nudge character in NORMAL. Enter insert with
 * `a` when INSERT is not visible. Codex keeps its configured `i` prelude.
 * Antigravity has no vim mode. Cursor uses `a` only when `editor.vimMode` is on
 * (see `readCursorVimMode`). Claude often omits a mode indicator — still send
 * `a` unless INSERT is shown. Do not toggle the operator's vim setting.
 */
export const vimInsertPrelude = (paneText: string, agentId: string): readonly string[] => {
  if (agentId === "antigravity" || agentId === "codex") return [];
  const plain = stripAnsi(paneText);
  if (/--\s*INSERT\s*--/i.test(plain) || /Vim:\s*Insert/i.test(plain)) return [];
  if (/--\s*VISUAL(?:\s+LINE)?\s*--/i.test(plain)) return ["Escape", "a"];
  return ["a"];
};

const readVimModeFlag = (path: string): boolean | undefined => {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const editor = (parsed as { editor?: unknown }).editor;
    if (editor === null || typeof editor !== "object" || Array.isArray(editor)) return undefined;
    const vimMode = (editor as { vimMode?: unknown }).vimMode;
    return typeof vimMode === "boolean" ? vimMode : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Cursor CLI `editor.vimMode` from the home config, then clone overlays.
 * Tests (`VITEST`) skip the home file so the suite does not depend on the host.
 */
export const readCursorVimMode = (agentRoot: string): boolean => {
  let vimMode = false;
  if (process.env.VITEST === undefined) {
    vimMode = readVimModeFlag(join(homedir(), ".cursor/cli-config.json")) ?? vimMode;
  }
  vimMode = readVimModeFlag(join(agentRoot, ".cursor/cli-config.json")) ?? vimMode;
  vimMode = readVimModeFlag(join(agentRoot, ".cursor/cli.json")) ?? vimMode;
  return vimMode;
};

const cursorNudgePrelude = (agent: AgentConfig, paneText: string): readonly string[] => {
  const configured = agent.nudgePrelude;
  if (configured !== undefined && configured.length > 0) return configured;
  if (!readCursorVimMode(agent.root)) return [];
  return vimInsertPrelude(paneText, "cursor");
};

/** Vim INSERT treats bare Enter as a newline; leave insert, then submit. */
const cursorUsesVimKeys = (agent: AgentConfig): boolean =>
  readCursorVimMode(agent.root) || (agent.nudgePrelude !== undefined && agent.nudgePrelude.length > 0);

/** Resolve configured or default prelude/submit keys for an agent nudge. */
export const resolveNudgeKeys = (
  agent: AgentConfig,
  paneText = ""
): { prelude: readonly string[]; submit: readonly string[] } => {
  // Without vim, Escape dismisses Cursor's composer (issue 384). With vim,
  // Enter is a newline in INSERT — Escape then Enter (issue 84). vim `a`
  // comes from `editor.vimMode` / a non-empty `nudgePrelude`.
  if (agent.id === "cursor") {
    return {
      prelude: cursorNudgePrelude(agent, paneText),
      submit: cursorUsesVimKeys(agent) ? ["Escape", "Enter"] : ["Enter"]
    };
  }
  const defaults = agentOwnerUiDefaults(agent.id);
  const configuredPrelude = agent.nudgePrelude ?? defaults.nudgePrelude;
  const prelude = configuredPrelude.length === 0 ? vimInsertPrelude(paneText, agent.id) : configuredPrelude;
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
  // #26/#27 left many Claude runtimes on bare Enter/C-m.
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
/**
 * Antigravity under tmux often paints `⚠ Verifying your account...` a beat after
 * the idle `>` prompt. Typing then discards the nudge. Wait, then recapture.
 */
export const NUDGE_BEFORE_ANTIGRAVITY_MS = 2500;

export const renderNudgeText = (actionPath: string, actionId?: string, actionDigest?: string): string =>
  actionId === undefined
    ? `Read and execute your current coordinator action at ${actionPath}`
    : actionDigest === undefined
      ? `Read and execute coordinator action ${actionId} at ${actionPath}`
      : `Read and execute coordinator action ${actionId} digest ${actionDigest} at ${actionPath}`;

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

export type SessionKey = number | "manual";

const appleScriptString = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/**
 * Stable Terminal.app custom title for an issue or manual owner agent tab.
 * Always pass `group` (= workspace terminalGroup) so titles are unique across
 * products; close must match these exact strings only.
 */
export const ownerTerminalWindowTitle = (
  sessionKey: SessionKey,
  agentId: string,
  group: string | null = null
): string => {
  const session =
    typeof sessionKey === "number"
      ? group === null || group === ""
        ? `coord-${sessionKey}`
        : `coord-${sessionKey}-${safeName(group)}`
      : group === null || group === ""
        ? "coord-manual"
        : `coord-manual-${safeName(group)}`;
  return `${session}/${safeName(agentId)}`;
};

/**
 * Exact titles to close for an issue or manual session. Only the unique grouped
 * form when `group` is set — never bare agent names and never ungrouped
 * `coord-N/<agent>` or `coord-manual/<agent>` (those collide across products).
 */
export const ownerTerminalTitlesToClose = (
  sessionKey: SessionKey,
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
    add(ownerTerminalWindowTitle(sessionKey, agentId, group));
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
 * Close whole Terminal windows that own our unique titles.
 *
 * Matching only `custom title of tab` + `close tb` is unreliable: after the
 * attached tmux client exits, Terminal keeps an idle shell and often clears or
 * ignores the custom title while the window name still shows
 * `coord-N-<group>/<agent>`. Closing the window by id (after collecting matches)
 * tears down that leftover shell. Never matches bare agent names.
 */
export const ownerTerminalCloseAppleScript = (titles: readonly string[]): string => {
  const list = titles.map((title) => appleScriptString(title)).join(", ");
  return [
    'tell application "Terminal"',
    `  set wanted to {${list}}`,
    "  set windowIds to {}",
    "  repeat with w in windows",
    "    try",
    "      set wid to id of w",
    "      set wname to name of w as text",
    "      set shouldClose to false",
    "      repeat with tb in tabs of w",
    "        try",
    "          set t to custom title of tb as text",
    "          if wanted contains t then set shouldClose to true",
    "        end try",
    "      end repeat",
    "      if shouldClose is false then",
    "        repeat with titleText in wanted",
    "          if wname contains (titleText as text) then set shouldClose to true",
    "        end repeat",
    "      end if",
    "      if shouldClose then set end of windowIds to wid",
    "    end try",
    "  end repeat",
    "  repeat with wid in windowIds",
    "    try",
    "      close (first window whose id is wid)",
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

export const ownerTerminalListOpenAppleScript = (titles: readonly string[]): string => {
  const list = titles.map((title) => appleScriptString(title)).join(", ");
  return [
    'tell application "Terminal"',
    `  set wanted to {${list}}`,
    "  set found to {}",
    "  repeat with w in windows",
    "    try",
    "      set wname to name of w as text",
    "      repeat with tb in tabs of w",
    "        try",
    "          set t to custom title of tb as text",
    "          if wanted contains t then set end of found to t",
    "        end try",
    "      end repeat",
    "      repeat with titleText in wanted",
    "        if wname contains (titleText as text) then set end of found to (titleText as text)",
    "      end repeat",
    "    end try",
    "  end repeat",
    "  set AppleScript's text item delimiters to linefeed",
    "  return found as text",
    "end tell"
  ].join("\n");
};

export const listOpenDarwinTerminalTitles: OwnerTerminalTitleProbe = (titles) => {
  if (titles.length === 0) return [];
  const result = spawnSync("osascript", ["-e", ownerTerminalListOpenAppleScript(titles)], { encoding: "utf8" });
  if ((result.status ?? 1) !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((title) => title !== "" && titles.includes(title));
};

const defaultOwnerTerminalTitleProbe = (): OwnerTerminalTitleProbe | null => {
  if (process.env.VITEST !== undefined) return (titles) => [...titles];
  return platform() === "darwin" ? listOpenDarwinTerminalTitles : null;
};

export type OpenOwnerAgentClientsResult =
  | { status: "opened"; count: number }
  | { status: "already-open"; count: number }
  | { status: "unsupported"; commands: readonly string[] }
  | { status: "failed"; error: string; commands: readonly string[] };

/** Return the subset of `titles` that currently exist as Terminal.app windows/tabs. */
export type OwnerTerminalTitleProbe = (titles: readonly string[]) => string[];

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
    private readonly titleGroup: string | null = null,
    private readonly titleProbe: OwnerTerminalTitleProbe | null = defaultOwnerTerminalTitleProbe()
  ) {}

  /** Group id embedded in Terminal custom titles for this workspace. */
  private terminalTitleGroup(): string | null {
    return this.titleGroup ?? this.namespace;
  }

  sessionName(sessionKey: SessionKey): string {
    if (typeof sessionKey === "number") {
      return `coord-${sessionKey}${this.namespace === null ? "" : `-${safeName(this.namespace)}`}`;
    }
    const group = this.terminalTitleGroup();
    return group === null || group === "" ? "coord-manual" : `coord-manual-${safeName(group)}`;
  }

  target(sessionKey: SessionKey, agent: string): string {
    return `${this.sessionName(sessionKey)}:${safeName(agent)}.0`;
  }

  agentAttachLaunches(sessionKey: SessionKey, agents: readonly AgentConfig[]): OwnerTerminalLaunch[] {
    const session = this.sessionName(sessionKey);
    const group = this.terminalTitleGroup();
    return agents.map((agent) => ({
      agentId: agent.id,
      command: agentClientAttachCommand(session, agent.id),
      terminalProfile: resolveTerminalProfile(agent),
      windowTitle: ownerTerminalWindowTitle(sessionKey, agent.id, group)
    }));
  }

  ownerTerminalTitles(sessionKey: SessionKey, agentIds: readonly string[]): string[] {
    return ownerTerminalTitlesToClose(sessionKey, agentIds, this.terminalTitleGroup());
  }

  async hasSession(sessionKey: SessionKey): Promise<boolean> {
    const session = this.sessionName(sessionKey);
    const checked = await this.runner(["has-session", "-t", session]);
    return checked.exitCode === 0;
  }

  /** List the primary issue session and any linked per-agent client sessions. */
  async listIssueSessions(sessionKey: SessionKey, agentIds?: readonly string[]): Promise<string[]> {
    const session = this.sessionName(sessionKey);
    const listed = await this.runner(["list-sessions", "-F", "#{session_name}"]);
    if (listed.exitCode !== 0) return [];
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) =>
        name === session ||
        (agentIds !== undefined
          ? agentIds.some((id) => name === `${session}-${safeName(id)}`)
          : name.startsWith(`${session}-`))
      );
  }

  async killIssueSessions(sessionKey: SessionKey, agentIds?: readonly string[]): Promise<string[]> {
    const names = await this.listIssueSessions(sessionKey, agentIds);
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
    sessionKey: SessionKey,
    agentIds: readonly string[]
  ): { status: "closed" | "unsupported" | "failed"; titles: readonly string[]; error?: string } {
    const titles = ownerTerminalTitlesToClose(sessionKey, agentIds, this.terminalTitleGroup());
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
   * `onlyMissing` skips titles already open so resume does not duplicate windows.
   */
  async openOwnerAgentClients(
    sessionKey: SessionKey,
    agents: readonly AgentConfig[],
    options: { onlyMissing?: boolean } = {}
  ): Promise<OpenOwnerAgentClientsResult> {
    const launches = this.agentAttachLaunches(sessionKey, agents);
    const commands = launches.map((launch) => launch.command);
    if (this.ownerTerminalOpener === null) return { status: "unsupported", commands };
    const toOpen = (() => {
      if (options.onlyMissing !== true) return launches;
      const present = this.titleProbe?.(launches.map((item) => item.windowTitle)) ?? [];
      return launches.filter((launch) => !present.includes(launch.windowTitle));
    })();
    if (toOpen.length === 0) return { status: "already-open", count: launches.length };
    try {
      await this.ownerTerminalOpener(toOpen);
      return { status: "opened", count: toOpen.length };
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

  async startSession(sessionKey: SessionKey, agents: readonly AgentConfig[]): Promise<void> {
    await this.preflight(agents);
    const session = this.sessionName(sessionKey);
    const exists = await this.runner(["has-session", "-t", session]);
    if (exists.exitCode === 0) throw new Error(`tmux session ${session} already exists; resume or remove it explicitly.`);
    const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
    if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    try {
      if (typeof sessionKey === "number") {
        const environment = await this.runner(["set-environment", "-t", session, "COORD_ISSUE", String(sessionKey)]);
        if (environment.exitCode !== 0) {
          throw new Error(`cannot set coordinator issue environment in ${session}: ${environment.stderr}`);
        }
      } else {
        await this.runner(["set-environment", "-u", "-t", session, "COORD_ISSUE"]);
      }
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

  async stopSession(sessionKey: SessionKey): Promise<void> {
    await this.runner(["kill-session", "-t", this.sessionName(sessionKey)]);
  }

  async ensureSession(
    sessionKey: SessionKey,
    agents: readonly AgentConfig[],
    assertAuthority: () => void = () => undefined
  ): Promise<void> {
    const session = this.sessionName(sessionKey);
    const exists = await this.runner(["has-session", "-t", session]);
    assertAuthority();
    if (exists.exitCode !== 0) {
      const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
      assertAuthority();
      if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    }
    if (typeof sessionKey === "number") {
      const environment = await this.runner(["set-environment", "-t", session, "COORD_ISSUE", String(sessionKey)]);
      assertAuthority();
      if (environment.exitCode !== 0) {
        throw new Error(`cannot set coordinator issue environment in ${session}: ${environment.stderr}`);
      }
    } else {
      await this.runner(["set-environment", "-u", "-t", session, "COORD_ISSUE"]);
      assertAuthority();
    }
    for (const agent of agents) {
      const target = `${session}:${safeName(agent.id)}`;
      const present = await this.runner(["list-windows", "-t", session, "-F", "#{window_name}"]);
      assertAuthority();
      if (present.exitCode !== 0) throw new Error(`cannot inspect tmux session ${session}: ${present.stderr}`);
      const windowNames = present.stdout
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name !== "");
      if (windowNames.includes(safeName(agent.id))) {
        const pane = await this.inspectPane(target);
        assertAuthority();
        if (pane.alive) continue;
        const launcher = resolveAgentLauncher(agent);
        const respawned = await this.runner([
          "respawn-pane",
          "-k",
          "-t",
          target,
          "-c",
          resolve(agent.root),
          launcher
        ]);
        assertAuthority();
        if (respawned.exitCode !== 0) throw new Error(`cannot relaunch ${agent.id} in ${target}: ${respawned.stderr}`);
        continue;
      }
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
      "#{pane_dead}\t#{pane_current_command}\t#{pane_in_mode}\t#{pane_input_off}"
    ]);
    if (inspected.exitCode !== 0) {
      return { alive: false, foreground: "", ownerTyping: false, inputOff: false };
    }
    const [dead = "1", foreground = "", inMode = "0", inputOff = "0"] = inspected.stdout.trim().split("\t");
    return {
      alive: dead !== "1",
      foreground,
      ownerTyping: inMode === "1",
      inputOff: inputOff === "1"
    };
  }

  /**
   * tmux copy-mode / disabled input can appear after the original readiness
   * check. Re-read before every send-keys so we never inject into a pane that
   * will drop or mis-route the key.
   */
  private async injectionGate(
    target: string,
    agent: AgentConfig,
    assertAuthority: () => void
  ): Promise<"ok" | "busy" | "gone"> {
    const pane = await this.inspectPane(target);
    assertAuthority();
    if (!pane.alive) return "gone";
    if (pane.ownerTyping || pane.inputOff) return "busy";
    if (!harnessLooksReady(pane.foreground, agent.harnessProcess)) return "busy";
    return "ok";
  }

  async capturePane(target: string): Promise<string> {
    const captured = await this.runner(["capture-pane", "-ep", "-t", target, "-S", "-40"]);
    if (captured.exitCode !== 0) return "";
    return captured.stdout;
  }

  /** Positive recovery evidence: a live, ready prompt whose viewport lacks this action UUID. */
  async actionAbsentAtReadyPrompt(
    issue: number,
    agent: AgentConfig,
    actionId: string,
    assertAuthority: () => void = () => undefined
  ): Promise<boolean> {
    const target = this.target(issue, agent.id);
    const gate = await this.injectionGate(target, agent, assertAuthority);
    if (gate !== "ok") return false;
    const captured = await this.runner(["capture-pane", "-ep", "-t", target, "-S", "-40"]);
    assertAuthority();
    if (captured.exitCode !== 0) return false;
    return harnessPromptReady(captured.stdout, agent.id) && !captured.stdout.includes(actionId);
  }

  async nudge(
    issue: number,
    agent: AgentConfig,
    actionPath: string,
    assertAuthority: () => void = () => undefined,
    actionId?: string,
    actionDigest?: string
  ): Promise<"sent" | "disabled" | "busy" | "gone"> {
    if (agent.delivery !== "nudge" && agent.delivery !== "both") return "disabled";
    const target = this.target(issue, agent.id);
    const initial = await this.injectionGate(target, agent, assertAuthority);
    if (initial !== "ok") return initial;
    let paneText = await this.capturePane(target);
    assertAuthority();
    if (!harnessPromptReady(paneText, agent.id)) return "busy";
    if (agent.id === "antigravity") {
      await this.sleep(NUDGE_BEFORE_ANTIGRAVITY_MS);
      assertAuthority();
      paneText = await this.capturePane(target);
      assertAuthority();
      if (!harnessPromptReady(paneText, agent.id)) return "busy";
    }
    const text = renderNudgeText(actionPath, actionId, actionDigest);
    // Some harnesses (notably agy) ignore tmux paste-buffer; literal send-keys
    // reaches the input widget. Prelude/submit keys come from agent config.
    const { prelude: preludeKeys, submit: submitKeys } = resolveNudgeKeys(agent, paneText);
    const send = async (args: readonly string[], fail: string): Promise<"sent" | "busy" | "gone"> => {
      const gate = await this.injectionGate(target, agent, assertAuthority);
      if (gate !== "ok") return gate;
      const result = await this.runner(["send-keys", ...args]);
      assertAuthority();
      if (result.exitCode !== 0) throw new Error(`${fail}${result.stderr}`);
      return "sent";
    };
    for (const key of preludeKeys) {
      const prelude = await send(["-t", target, key], "tmux send-keys prelude failed: ");
      if (prelude !== "sent") return prelude;
    }
    const typed = await send(["-l", "-t", target, text], "tmux send-keys text failed: ");
    if (typed !== "sent") return typed;
    // Autocomplete/multiline handlers need a beat before Escape; then gap before Enter.
    await this.sleep(NUDGE_AFTER_TEXT_MS);
    assertAuthority();
    for (const [index, key] of submitKeys.entries()) {
      if (index > 0) {
        await this.sleep(NUDGE_BETWEEN_SUBMIT_MS);
        assertAuthority();
      }
      const submit = await send(["-t", target, key], "tmux send-keys submit failed: ");
      if (submit !== "sent") return submit;
    }
    return "sent";
  }
}
