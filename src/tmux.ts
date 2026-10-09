import { constants, accessSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentConfig } from "./state.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";
import { agentNudgeKeyDefaults, agentOwnerUiDefaults } from "./setupWorkspace.js";

export type TmuxResult = { exitCode: number; stdout: string; stderr: string };
export type TmuxRunner = (args: readonly string[], input?: string) => Promise<TmuxResult>;
export type SessionKey = number | "manual";

export const runTmux: TmuxRunner = (args, input) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn("tmux", [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr: stderr.trim() }));
    child.stdin.once("error", (error: NodeJS.ErrnoException) => {
      stderr += `${stderr === "" ? "" : "\n"}${error.code ?? error.message}`;
    });
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
 * The exact line an agent prints once it has written `complete` and found no
 * replacement action. It is *additive* positive evidence: it can confirm an
 * otherwise-ready pane, and it can never clear a blocker (see
 * `harnessPromptReadiness`). Agents are told to print it by the protocol block
 * in `templates/product/AGENTS.protocol.md`.
 */
export const COORD_IDLE_SENTINEL = "COORD-IDLE: waiting for the next coordinator action file";

/** Why a pane refused a paste. A closed union so journal consumers can match it. */
export type PromptBlockedReason =
  | "trust-dialog"
  | "claude-no-prompt"
  | "claude-usage-wait"
  | "cursor-turn-chrome"
  | "antigravity-turn-chrome"
  | "antigravity-verify-overlay"
  | "antigravity-no-prompt"
  | "codex-turn-chrome"
  | "no-idle-sentinel"
  | "codex-composer-not-ready"
  | "pane-capture-unavailable"
  | "lifecycle-changed";

/** The lifecycle record since an override send began: untouched, showing this nudge accepted, or anything else. */
export type OverrideLifecycle = "unchanged" | "accepted" | "changed";
export type IdleOverride = { source: "idle-sentinel" | "ready-file"; lifecycle: () => OverrideLifecycle };

export type PromptReadiness =
  | { ready: true; reason: "vendor-prompt" | "idle-sentinel" }
  | { ready: false; reason: PromptBlockedReason };

/**
 * In-flight status chrome, as opposed to prose that merely contains the word.
 *
 * Requiring only an ellipsis is not enough: agents on this workflow routinely
 * render `Thinking…` and `Working...` inside their own plans and reviews, so
 * the match is anchored to a line that *starts* with the status word. A quoted
 * or bulleted line (`- \`Thinking…\``, `> Thinking...`, `* Thinking...`) is
 * prose and must not match, which is why the anchor admits only whitespace and
 * the braille spinner frames a TUI actually paints — never `-`, `*`, `>`, a
 * backtick, or a middle dot, each of which starts an ordinary markdown bullet.
 *
 * The suffix covers every live form the vendors render: an ellipsis, and the
 * elapsed-timer variants `Thinking for 12s` and `Working (12s)`. Matching only
 * the ellipsis would read a running timer line as an idle prompt and type into
 * the turn — a false ready, which costs more than a false busy.
 */
const SPINNER_PREFIX = String.raw`[\s\u2800-\u28ff]*`;
const STATUS_SUFFIX = String.raw`(?:\.\.\.|\u2026|\s+for\s+\d|\s*\(\d)`;

const inFlightStatusLine = (plain: string, words: string): boolean =>
  new RegExp(String.raw`^${SPINNER_PREFIX}(?:${words})${STATUS_SUFFIX}`, "im").test(plain);

/** True when the sentinel is the last thing the pane rendered. */
const sentinelAtTail = (plain: string): boolean => {
  const lines = plain.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return lines[lines.length - 1] === COORD_IDLE_SENTINEL;
};

/**
 * Codex's live status line, `• Working (12s • esc to interrupt)`, near the
 * bottom of the pane. Anchored like `inFlightStatusLine`, so a quoted or
 * bulleted mention in an agent's own prose does not read as chrome.
 */
const codexTurnChrome = (plain: string): boolean =>
  plain.split("\n").filter((line) => line.trim() !== "").slice(-8)
    .some((line) => /^[\s•⠀-⣿]*Working \(.*esc to interrupt/.test(line));

const CODEX_FOOTER = /^(?:(?:←\s+for agents\s+·\s+)?\?\s+for shortcuts|Context \d+% left|\d+% context left)/;

/** The dim summary Codex paints once a turn ends: `Worked for 5m 21s • 5:42 AM`, or a `─` rule around it. */
const CODEX_TURN_SUMMARY = /^[─\s]*Worked for \d+[hms](?:\s*\d+[hms])*(?:\s*•\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?[─\s]*$/;

/**
 * True when the composer after `›` holds nothing but the placeholder Codex
 * paints dim (SGR 2). Undimmed text is a draft the owner has not sent, and a
 * nudge typed after it would be appended to it and submitted with it.
 */
const codexComposerEmpty = (rawLine: string): boolean => {
  const esc = String.fromCharCode(0x1b);
  let dim = false;
  let visible = "";
  for (const part of rawLine.slice(rawLine.indexOf("›") + 1).split(new RegExp(`(${esc}\\[[0-9;]*m)`))) {
    const sgr = new RegExp(`^${esc}\\[([0-9;]*)m$`).exec(part);
    if (sgr === null) {
      if (!dim) visible += stripAnsi(part);
      continue;
    }
    const codes = sgr[1] === "" ? ["0"] : sgr[1]!.split(";");
    for (let index = 0; index < codes.length; index += 1) {
      const code = codes[index];
      // Extended colours carry operands (`38;2;r;g;b`, `38;5;n`) that are not attributes.
      if (code === "38" || code === "48" || code === "58") index += codes[index + 1] === "5" ? 2 : 4;
      else if (code === "2") dim = true;
      else if (code === "0" || code === "22") dim = false;
    }
  }
  return visible.trim() === "";
};

type PaneLine = { raw: string; plain: string };

const paneLines = (paneText: string): PaneLine[] => paneText.split("\n")
  .map((raw) => ({ raw, plain: stripAnsi(raw).trim() }))
  .filter((line) => line.plain !== "");

/**
 * Codex renders the sentinel as an assistant item (`• COORD-IDLE: …`) above
 * its composer and footer, so it is never the last line. Below the last
 * sentinel only one turn-summary line, the composer (which may wrap) and known
 * footer lines may follow; anything else — a new transcript item, a dialog —
 * fails closed.
 */
/** Non-blank pane lines below Codex's last rendered sentinel, or null without one. */
const linesAfterCodexSentinel = (paneText: string): PaneLine[] | null => {
  const lines = paneLines(paneText);
  const sentinel = lines.map((line) => line.plain.replace(/^•\s*/, "")).lastIndexOf(COORD_IDLE_SENTINEL);
  if (sentinel < 0) return null;
  const after = lines.slice(sentinel + 1);
  return after[0] !== undefined && CODEX_TURN_SUMMARY.test(after[0].plain) ? after.slice(1) : after;
};

const compactText = (value: string): string => value.replace(/\s/g, "");

const codexTail = (paneText: string, requireSentinel = true): { composer: PaneLine[]; footer: PaneLine[] } | null => {
  const lines = paneLines(paneText);
  const composerAt = lines.map((line) => line.plain.startsWith("›")).lastIndexOf(true);
  const after = requireSentinel ? linesAfterCodexSentinel(paneText) : composerAt < 0 ? null : lines.slice(composerAt);
  if (after === null) return null;
  const footerAt = after.findIndex((line) => CODEX_FOOTER.test(line.plain));
  const composer = footerAt < 0 ? after : after.slice(0, footerAt);
  const footer = footerAt < 0 ? [] : after.slice(footerAt);
  return composer[0]?.plain.startsWith("›") === true && footer.every((line) => CODEX_FOOTER.test(line.plain))
    ? { composer, footer }
    : null;
};

/** An empty composer, additionally requiring the sentinel for legacy proof. */
const codexSentinelAtTail = (paneText: string, requireSentinel = true): boolean => {
  const tail = codexTail(paneText, requireSentinel);
  return tail !== null && tail.composer.length === 1 && codexComposerEmpty(tail.composer[0]!.raw);
};

/** True when the composer holds exactly `text`, however it wrapped. */
const codexComposerHolds = (paneText: string, text: string, requireSentinel = true): boolean => {
  const tail = codexTail(paneText, requireSentinel);
  return tail !== null && compactText(tail.composer.map((line) => line.plain).join("").slice(1)) === compactText(text);
};

/**
 * After a submit key, positive proof that this nudge was submitted: below the
 * sentinel the first transcript message is exactly `text`, a live turn is
 * running, and the composer above the footer is empty again. Further fallback
 * submit keys would land in that turn. An unrelated Working line with the
 * nudge still in the composer is not proof.
 */
const codexNudgeSubmitted = (paneText: string, text: string, requireSentinel = true): boolean => {
  const after = requireSentinel ? linesAfterCodexSentinel(paneText) : paneLines(paneText);
  if (after === null) return false;
  let end = after.length;
  while (end > 0 && CODEX_FOOTER.test(after[end - 1]!.plain)) end -= 1;
  const composer = after[end - 1];
  if (composer === undefined || !composer.plain.startsWith("›") || !codexComposerEmpty(composer.raw)) return false;
  let transcript = after.slice(0, end - 1);
  if (!requireSentinel) {
    const messageAt = transcript.map((line) => line.plain.startsWith("›")).lastIndexOf(true);
    if (messageAt < 0) return false;
    transcript = transcript.slice(messageAt);
  }
  if (transcript[0]?.plain.startsWith("›") !== true) return false;
  const nextItem = transcript.findIndex((line) => line.plain.startsWith("•"));
  const message = transcript.slice(0, nextItem < 0 ? transcript.length : nextItem);
  return compactText(message.map((line) => line.plain).join("").slice(1)) === compactText(text) &&
    codexTurnChrome(transcript.map((line) => line.plain).join("\n"));
};

/** Codex's footer names its vim mode; the `i` prelude is only needed to leave NORMAL. */
const codexVimNormal = (paneText: string, requireSentinel = true): boolean =>
  codexTail(paneText, requireSentinel)?.footer.some((line) => /Vim: Normal/.test(line.plain)) === true;

/** In visible INSERT an `i` prelude would be typed into the message itself. */
const codexVimInsert = (paneText: string): boolean =>
  codexTail(paneText, false)?.footer.some((line) => /Vim: Insert/.test(line.plain)) === true;

/** Active unquoted terminal lines, not prose discussing a past limit. Fail closed. */
const claudeUsageWait = (plain: string): boolean => {
  const tail = plain.split("\n").slice(-12).join("\n");
  // Keep the line anchor to reject quoted prose, but admit TUI spinners/boxes.
  const prefix = String.raw`${SPINNER_PREFIX}(?:[│┃⏸⏳!⎿●]${SPINNER_PREFIX})*`;
  return new RegExp(String.raw`^${prefix}(?:Usage limit (?:reached|reset)|(?:You've|You’ve|You have) hit your(?: .+)? limit|continuing (?:automatically|shortly)|Your usage limit has reset|Automatic continue (?:cancelled|canceled|stopped)|Wait here, then continue automatically)`, "im").test(tail);
};

/**
 * True when the sentinel appears *after* the last mention of `actionId`.
 *
 * The capture buffer keeps 40 lines, so the sentinel an agent printed for the
 * previous action can still be on screen while it works on the current one.
 * Only a sentinel newer than the current action proves present-tense idleness.
 */
export const idleSentinelAfterAction = (paneText: string, actionId: string): boolean => {
  const plain = stripAnsi(paneText);
  const sentinel = plain.lastIndexOf(COORD_IDLE_SENTINEL);
  if (sentinel < 0) return false;
  return sentinel > plain.lastIndexOf(actionId);
};

/**
 * Whether the TUI has an idle prompt that can accept typed input, and why not.
 *
 * Process-name readiness alone is not enough: Antigravity/`agy` can be
 * foreground during splash while keys are discarded; Claude may still be on the
 * trust dialog. Every blocking check runs *before* the sentinel is consulted —
 * a positive hint may add a reason to send, never remove one, or a stale
 * sentinel would let the coordinator type into an account-verify overlay that
 * silently drops the keystrokes.
 */
export const harnessPromptReadiness = (
  paneText: string,
  agentId: string,
  actionId?: string
): PromptReadiness => {
  const plain = stripAnsi(paneText);
  // A sentinel older than the current action is stale scrollback, not evidence.
  const sentinel =
    (agentId === "codex" ? codexSentinelAtTail(paneText) : sentinelAtTail(plain)) &&
    (actionId === undefined || idleSentinelAfterAction(plain, actionId));
  const ready = (): PromptReadiness => ({ ready: true, reason: sentinel ? "idle-sentinel" : "vendor-prompt" });
  if (/trust this folder/i.test(plain)) return { ready: false, reason: "trust-dialog" };
  switch (agentId) {
    case "claude":
      if (claudeUsageWait(plain)) return { ready: false, reason: "claude-usage-wait" };
      if (/❯|auto mode|-- INSERT --|-- NORMAL --|-- VISUAL/i.test(plain)) return ready();
      return sentinel ? { ready: true, reason: "idle-sentinel" } : { ready: false, reason: "claude-no-prompt" };
    case "cursor":
      // Composer placeholder copy changes; do not match it. Block only on
      // in-flight turn chrome. Process readiness is `harnessLooksReady`.
      if (/esc to cancel/i.test(plain) || inFlightStatusLine(plain, "Generating|Running|Working|Thinking")) {
        return { ready: false, reason: "cursor-turn-chrome" };
      }
      return ready();
    case "antigravity":
      // Escape cancels an in-flight turn; do not nudge while working.
      if (/esc to cancel/i.test(plain) || inFlightStatusLine(plain, "Generating|Running|Working")) {
        return { ready: false, reason: "antigravity-turn-chrome" };
      }
      // Account-verify overlay still shows `>` / Accept-edits; keys are discarded.
      if (/Verifying your account|account eligibility|Please try again shortly/i.test(plain)) {
        return { ready: false, reason: "antigravity-verify-overlay" };
      }
      if (/>|shortcuts|Accept-edits/i.test(plain) && /Antigravity|Gemini|accept-edits/i.test(plain)) return ready();
      return sentinel
        ? { ready: true, reason: "idle-sentinel" }
        : { ready: false, reason: "antigravity-no-prompt" };
    case "codex":
      // Codex accepts keys once the process is up; block only on its live turn status.
      if (codexTurnChrome(plain)) return { ready: false, reason: "codex-turn-chrome" };
      return ready();
    default:
      return ready();
  }
};

/** True when the TUI has an idle prompt that can accept typed input. */
export const harnessPromptReady = (paneText: string, agentId: string, actionId?: string): boolean =>
  harnessPromptReadiness(paneText, agentId, actionId).ready;

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
/** Captures allowed for Codex to paint the typed nudge before the first submit key. */
export const CODEX_SUBMIT_SETTLE_CHECKS = 4;
/** Extra `C-m` presses while the Codex composer still holds exactly the nudge. */
export const CODEX_SUBMIT_RETRIES = 2;
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

/** Why the pane gate refused. A closed union, like `PromptBlockedReason`. */
export type GateReason = "ok" | "pane-dead" | "owner-typing" | "input-off" | "foreground-mismatch";

export type GateOutcome = {
  status: "ok" | "busy" | "gone";
  reason: GateReason;
  detail?: string;
};

/**
 * The result of one delivery attempt.
 *
 * `reason` stays a closed union value; where in the attempt it was refused
 * lives in `stage` rather than being composed into the reason string, so a
 * consumer matching `reason === "foreground-mismatch"` sees every occurrence.
 */
export type NudgeOutcome = {
  status: "sent" | "disabled" | "busy" | "gone";
  reason: GateReason | PromptBlockedReason | "delivery-disabled" | "sent";
  stage: "config" | "gate" | "prompt" | "antigravity-recapture" | "mid-send" | "complete";
  detail?: string;
};

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
  key: SessionKey,
  agentId: string,
  group: string | null = null
): string => {
  if (key === "manual" && (group === null || group === "")) {
    throw new Error("Manual Terminal titles require a workspace group id.");
  }
  const session = key === "manual"
    ? `coord-manual-${safeName(group as string)}`
    : group === null || group === ""
      ? `coord-${key}`
      : `coord-${key}-${safeName(group)}`;
  return `${session}/${safeName(agentId)}`;
};

/**
 * Exact titles to close for an issue. Only the unique grouped form when `group`
 * is set — never bare agent names and never ungrouped `coord-N/<agent>`
 * (those collide across products).
 */
export const ownerTerminalTitlesToClose = (
  key: SessionKey,
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
    add(ownerTerminalWindowTitle(key, agentId, group));
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

  sessionName(key: SessionKey): string {
    if (key === "manual") {
      const group = this.terminalTitleGroup();
      if (group === null || group === "") throw new Error("Manual tmux sessions require a workspace group id.");
      return `coord-manual-${safeName(group)}`;
    }
    return `coord-${key}${this.namespace === null ? "" : `-${safeName(this.namespace)}`}`;
  }

  target(key: SessionKey, agent: string): string {
    return `${this.sessionName(key)}:${safeName(agent)}.0`;
  }

  agentAttachLaunches(key: SessionKey, agents: readonly AgentConfig[]): OwnerTerminalLaunch[] {
    const session = this.sessionName(key);
    const group = this.terminalTitleGroup();
    return agents.map((agent) => ({
      agentId: agent.id,
      command: agentClientAttachCommand(session, agent.id),
      terminalProfile: resolveTerminalProfile(agent),
      windowTitle: ownerTerminalWindowTitle(key, agent.id, group)
    }));
  }

  ownerTerminalTitles(key: SessionKey, agentIds: readonly string[]): string[] {
    return ownerTerminalTitlesToClose(key, agentIds, this.terminalTitleGroup());
  }

  /** List the primary issue session and any linked per-agent client sessions. */
  async listIssueSessions(key: SessionKey, agentIds?: readonly string[]): Promise<string[]> {
    const session = this.sessionName(key);
    const listed = await this.runner(["list-sessions", "-F", "#{session_name}"]);
    if (listed.exitCode !== 0) return [];
    const exactManualNames =
      key === "manual" && agentIds !== undefined
        ? new Set([session, ...agentIds.map((agentId) => `${session}-${safeName(agentId)}`)])
        : null;
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((name) => exactManualNames?.has(name) ?? (name === session || name.startsWith(`${session}-`)));
  }

  async killIssueSessions(key: SessionKey, agentIds?: readonly string[]): Promise<string[]> {
    const names = await this.listIssueSessions(key, agentIds);
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
    key: SessionKey,
    agentIds: readonly string[]
  ): { status: "closed" | "unsupported" | "failed"; titles: readonly string[]; error?: string } {
    const titles = ownerTerminalTitlesToClose(key, agentIds, this.terminalTitleGroup());
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
    key: SessionKey,
    agents: readonly AgentConfig[],
    options: { onlyMissing?: boolean } = {}
  ): Promise<OpenOwnerAgentClientsResult> {
    const launches = this.agentAttachLaunches(key, agents);
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

  async issueEnvironmentDiagnostic(issue: number): Promise<string> {
    const result = await this.runner(["show-environment", "-t", this.sessionName(issue), "COORD_ISSUE"])
      .catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    return result.exitCode === 0 && result.stdout.trim() === `COORD_ISSUE=${issue}`
      ? `[WAIT] Terminal session targets issue ${issue}; existing child processes still need current-issue hook confirmation.`
      : `[WARN] Terminal session issue binding is missing or differs from ${issue}; inspect/restart the agent terminals through coord before retrying work.`;
  }

  /**
   * Read-only placement check per agent pane. Empty pane_start_path is unknown
   * (older tmux), not a mismatch. Never kills or relaunches.
   */
  async agentPlacementDiagnostics(issue: number, agents: readonly AgentConfig[]): Promise<string[]> {
    const lines: string[] = [];
    const launches = this.agentAttachLaunches(issue, agents);
    const expectedTitles = new Set(launches.map((launch) => launch.windowTitle));
    const presentTitles =
      this.titleProbe === null ? null : new Set(this.titleProbe([...expectedTitles]));
    for (const agent of agents) {
      const target = this.target(issue, agent.id);
      const display = await this.runner([
        "display-message",
        "-p",
        "-t",
        target,
        "#{pane_dead}\t#{pane_start_path}"
      ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "missing" }));
      if (display.exitCode !== 0) {
        lines.push(`[WARN] ${agent.id}: tmux pane ${target} is missing; run coord attach ${issue}.`);
        continue;
      }
      const [deadRaw = "", startPathRaw = ""] = display.stdout.trim().split("\t");
      if (deadRaw === "1") {
        lines.push(`[WARN] ${agent.id}: tmux pane ${target} is dead; run coord attach ${issue}.`);
        continue;
      }
      const startPath = startPathRaw.trim();
      // Empty start path means the format is unavailable — do not warn.
      if (startPath !== "" && resolve(startPath) !== resolve(agent.root)) {
        lines.push(
          `[WARN] ${agent.id}: pane start path ${startPath} is not ${resolve(agent.root)}; run coord attach ${issue}.`
        );
        continue;
      }
      const launch = launches.find((item) => item.agentId === agent.id);
      if (presentTitles !== null && launch !== undefined && !presentTitles.has(launch.windowTitle)) {
        lines.push(
          `[WARN] ${agent.id}: Terminal window ${launch.windowTitle} is not open; run coord attach ${issue}.`
        );
        continue;
      }
      lines.push(`[OK] ${agent.id}: pane ${target} is placed in ${resolve(agent.root)}.`);
    }
    return lines;
  }

  async startSession(issue: number, agents: readonly AgentConfig[]): Promise<void> {
    await this.preflight(agents);
    const session = this.sessionName(issue);
    const exists = await this.runner(["has-session", "-t", session]);
    if (exists.exitCode === 0) throw new Error(`tmux session ${session} already exists; resume or remove it explicitly.`);
    const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
    if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    try {
      const environment = await this.runner(["set-environment", "-t", session, "COORD_ISSUE", String(issue)]);
      if (environment.exitCode !== 0) {
        throw new Error(`cannot set coordinator issue environment in ${session}: ${environment.stderr}`);
      }
      const clearManual = await this.runner(["set-environment", "-r", "-t", session, "COORD_MANUAL"]);
      if (clearManual.exitCode !== 0) {
        throw new Error(`cannot clear manual environment in ${session}: ${clearManual.stderr}`);
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

  async stopSession(key: SessionKey): Promise<void> {
    await this.runner(["kill-session", "-t", this.sessionName(key)]);
  }

  async ensureSession(
    key: SessionKey,
    agents: readonly AgentConfig[],
    assertAuthority: () => void = () => undefined
  ): Promise<void> {
    const session = this.sessionName(key);
    const exists = await this.runner(["has-session", "-t", session]);
    assertAuthority();
    if (exists.exitCode !== 0) {
      const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
      assertAuthority();
      if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    }
    if (key === "manual") {
      // -r removes the variable from future child environments; -u only unsets
      // the session value and can leave a global COORD_ISSUE visible to panes.
      const environment = await this.runner(["set-environment", "-r", "-t", session, "COORD_ISSUE"]);
      assertAuthority();
      if (environment.exitCode !== 0) {
        throw new Error(`cannot clear coordinator issue environment in ${session}: ${environment.stderr}`);
      }
      const manualEnvironment = await this.runner(["set-environment", "-t", session, "COORD_MANUAL", "1"]);
      assertAuthority();
      if (manualEnvironment.exitCode !== 0) {
        throw new Error(`cannot set manual environment in ${session}: ${manualEnvironment.stderr}`);
      }
    } else {
      const environment = await this.runner(["set-environment", "-t", session, "COORD_ISSUE", String(key)]);
      assertAuthority();
      if (environment.exitCode !== 0) {
        throw new Error(`cannot set coordinator issue environment in ${session}: ${environment.stderr}`);
      }
      const clearManual = await this.runner(["set-environment", "-r", "-t", session, "COORD_MANUAL"]);
      assertAuthority();
      if (clearManual.exitCode !== 0) {
        throw new Error(`cannot clear manual environment in ${session}: ${clearManual.stderr}`);
      }
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
  ): Promise<GateOutcome> {
    const pane = await this.inspectPane(target);
    assertAuthority();
    if (!pane.alive) return { status: "gone", reason: "pane-dead" };
    if (pane.ownerTyping) return { status: "busy", reason: "owner-typing" };
    if (pane.inputOff) return { status: "busy", reason: "input-off" };
    if (!harnessLooksReady(pane.foreground, agent.harnessProcess)) {
      return { status: "busy", reason: "foreground-mismatch", detail: pane.foreground };
    }
    return { status: "ok", reason: "ok" };
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
    if (gate.status !== "ok") return false;
    const captured = await this.runner(["capture-pane", "-ep", "-t", target, "-S", "-40"]);
    assertAuthority();
    if (captured.exitCode !== 0) return false;
    // The UUID check stays on the full 40-line capture: a ready prompt is not
    // proof on its own, only a ready prompt that never showed this action.
    return harnessPromptReady(captured.stdout, agent.id, actionId) && !captured.stdout.includes(actionId);
  }

  async nudge(
    issue: number,
    agent: AgentConfig,
    actionPath: string,
    assertAuthority: () => void = () => undefined,
    actionId?: string,
    actionDigest?: string,
    reserveSend: () => void = () => undefined,
    /**
     * A file authorizes the first send; a sentinel can also authorize an
     * explicit owner reminder despite stale lifecycle state. Revalidate the
     * proof until submission is confirmed.
     */
    staleOverride?: IdleOverride
  ): Promise<NudgeOutcome> {
    if (agent.delivery !== "nudge" && agent.delivery !== "both") {
      return { status: "disabled", reason: "delivery-disabled", stage: "config" };
    }
    const target = this.target(issue, agent.id);
    const initial = await this.injectionGate(target, agent, assertAuthority);
    if (initial.status !== "ok") {
      return { status: initial.status, reason: initial.reason, stage: "gate", ...(initial.detail === undefined ? {} : { detail: initial.detail }) };
    }
    const requireSentinel = staleOverride?.source !== "ready-file";
    const readinessForSend = (text: string): PromptReadiness =>
      !requireSentinel && stripAnsi(text).trim() === ""
        ? { ready: false, reason: "pane-capture-unavailable" }
        : harnessPromptReadiness(text, agent.id, actionId);
    let paneText = await this.capturePane(target);
    assertAuthority();
    const readiness = readinessForSend(paneText);
    if (!readiness.ready) return { status: "busy", reason: readiness.reason, stage: "prompt" };
    if (staleOverride !== undefined && requireSentinel && readiness.reason !== "idle-sentinel") {
      return { status: "busy", reason: "no-idle-sentinel", stage: "prompt" };
    }
    if (!requireSentinel && agent.id === "codex" && !codexSentinelAtTail(paneText, false)) {
      return { status: "busy", reason: "codex-composer-not-ready", stage: "prompt" };
    }
    if (agent.id === "antigravity") {
      await this.sleep(NUDGE_BEFORE_ANTIGRAVITY_MS);
      assertAuthority();
      paneText = await this.capturePane(target);
      assertAuthority();
      const recaptured = readinessForSend(paneText);
      if (!recaptured.ready) return { status: "busy", reason: recaptured.reason, stage: "antigravity-recapture" };
    }
    const text = renderNudgeText(actionPath, actionId, actionDigest);
    // Some harnesses (notably agy) ignore tmux paste-buffer; literal send-keys
    // reaches the input widget. Prelude/submit keys come from agent config.
    const { prelude: resolvedPrelude, submit: submitKeys } = resolveNudgeKeys(agent, paneText);
    // On an override the composer must stay empty until the nudge is typed,
    // and Codex's `i` types itself unless vim is in NORMAL. Otherwise skip it
    // only on positive INSERT evidence, so an unreadable footer still gets `i`.
    const preludeKeys = agent.id === "codex" &&
      (staleOverride !== undefined ? !codexVimNormal(paneText, requireSentinel) : codexVimInsert(paneText))
      ? [] : resolvedPrelude;
    // A Codex submit is confirmed only where its composer can be read.
    const confirmCodex = agent.id === "codex" && codexTail(paneText, false) !== null;
    /** Codex paints typed text a beat late; wait (bounded) for the composer to show it. */
    const settled = async (latest: string, sentinel: boolean): Promise<string> => {
      for (let check = 1; check < CODEX_SUBMIT_SETTLE_CHECKS && !codexComposerHolds(latest, text, sentinel); check += 1) {
        await this.sleep(NUDGE_BETWEEN_SUBMIT_MS);
        assertAuthority();
        latest = await this.capturePane(target);
        assertAuthority();
      }
      return latest;
    };
    let began = false;
    let typedText = false;
    let submitting = false;
    let retrying = false;
    const gated = async (): Promise<NudgeOutcome | null> => {
      const gate = await this.injectionGate(target, agent, assertAuthority);
      return gate.status === "ok" ? null
        : { status: gate.status, reason: gate.reason, stage: began ? "mid-send" : "gate", ...(gate.detail === undefined ? {} : { detail: gate.detail }) };
    };
    const send = async (args: readonly string[], fail: string): Promise<NudgeOutcome> => {
      const gate = await gated();
      if (gate !== null) return gate;
      if (agent.id === "claude") {
        const latest = await this.capturePane(target);
        assertAuthority();
        if (claudeUsageWait(stripAnsi(latest))) return { status: "busy", reason: "claude-usage-wait", stage: began ? "mid-send" : "prompt" };
      }
      if (staleOverride !== undefined) {
        // Idle proof overrules a lifecycle veto, so it must still hold at
        // every key: the proof unchanged, the composer empty until
        // the nudge is typed and holding exactly the nudge after that. Once a
        // submit key is out, proof that the nudge was accepted ends the send.
        let latest = await this.capturePane(target);
        assertAuthority();
        if (confirmCodex && typedText && !submitting && !codexComposerHolds(latest, text, requireSentinel)) {
          await settled(latest, requireSentinel);
          // The gate above predates the settle wait; it cannot authorize this
          // key. Gate again, then prove against a capture taken after it.
          const regate = await gated();
          if (regate !== null) return regate;
          latest = await this.capturePane(target);
          assertAuthority();
        }
        const lifecycle = staleOverride.lifecycle();
        if (submitting && (lifecycle === "accepted" ||
          (agent.id === "codex" && codexNudgeSubmitted(latest, text, requireSentinel)))) {
          return { status: "sent", reason: "sent", stage: "complete", detail: "accepted" };
        }
        const current = readinessForSend(latest);
        const refused = !current.ready ? current.reason
          : lifecycle !== "unchanged" ? "lifecycle-changed"
          : !typedText ? (requireSentinel ? (current.reason === "idle-sentinel" ? null : "no-idle-sentinel")
            : agent.id === "codex" && !codexSentinelAtTail(latest, false) ? "codex-composer-not-ready" : null)
          : agent.id === "codex" && !codexComposerHolds(latest, text, requireSentinel)
            ? (requireSentinel ? "no-idle-sentinel" : "codex-composer-not-ready")
          : null;
        if (refused !== null) return { status: "busy", reason: refused, stage: began ? "mid-send" : "prompt" };
      } else if (retrying) {
        // An ordinary send has no override proof, so a retry key re-reads the
        // pane after its gate: the composer must still hold exactly the nudge.
        const latest = await this.capturePane(target);
        assertAuthority();
        const current = readinessForSend(latest);
        if (!current.ready) return { status: "busy", reason: current.reason, stage: "mid-send" };
        if (!codexComposerHolds(latest, text, false)) return { status: "busy", reason: "codex-composer-not-ready", stage: "mid-send" };
      }
      if (!began) { reserveSend(); began = true; }
      const result = await this.runner(["send-keys", ...args]);
      assertAuthority();
      if (result.exitCode !== 0) throw new Error(`${fail}${result.stderr}`);
      return { status: "sent", reason: "sent", stage: "complete" };
    };
    for (const key of preludeKeys) {
      const prelude = await send(["-t", target, key], "tmux send-keys prelude failed: ");
      if (prelude.status !== "sent") return prelude;
    }
    const typed = await send(["-l", "-t", target, text], "tmux send-keys text failed: ");
    if (typed.status !== "sent") return typed;
    typedText = true;
    // Autocomplete/multiline handlers need a beat before Escape; then gap before Enter.
    await this.sleep(NUDGE_AFTER_TEXT_MS);
    assertAuthority();
    if (confirmCodex && staleOverride === undefined) await settled(await this.capturePane(target), false);
    let accepted = false;
    for (const [index, key] of submitKeys.entries()) {
      if (index > 0) {
        submitting = true;
        await this.sleep(NUDGE_BETWEEN_SUBMIT_MS);
        assertAuthority();
      }
      const submit = await send(["-t", target, key], "tmux send-keys submit failed: ");
      if (submit.status !== "sent") return submit;
      if (submit.detail === "accepted") { accepted = true; break; }
    }
    // A tmux write is not a submit: while the composer still holds exactly
    // this nudge, press Enter again, at most CODEX_SUBMIT_RETRIES times.
    for (let retry = 0; confirmCodex && !accepted; retry += 1) {
      submitting = true;
      await this.sleep(NUDGE_BETWEEN_SUBMIT_MS);
      assertAuthority();
      const latest = await this.capturePane(target);
      assertAuthority();
      // A lost capture is no evidence that the nudge left the composer.
      if (stripAnsi(latest).trim() === "") return { status: "busy", reason: "pane-capture-unavailable", stage: "mid-send" };
      if (!codexComposerHolds(latest, text, false) || retry === CODEX_SUBMIT_RETRIES) break;
      retrying = true;
      const again = await send(["-t", target, "C-m"], "tmux send-keys submit failed: ");
      if (again.status !== "sent") return again;
      accepted = again.detail === "accepted";
    }
    return { status: "sent", reason: "sent", stage: "complete",
      ...(staleOverride !== undefined ? { detail: staleOverride.source }
        : readiness.reason === "idle-sentinel" ? { detail: "idle-sentinel" } : {}) };
  }
}
