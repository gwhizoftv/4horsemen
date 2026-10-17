import { constants, accessSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { AgentConfig } from "./state.js";
import { assertNoSymlink, containedPath, isPathInside } from "./paths.js";
import { agentNudgeKeyDefaults, agentOwnerUiDefaults } from "./setupWorkspace.js";
import { shellQuote } from "./agentHookSync.js";
import { sha256 } from "./hash.js";

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
  // Muse reports its versioned binary: `muse-bin-1.4.10`, or `muse-bin-1.4.7-R6101.1`.
  if (expected === "muse" && /^muse-bin-\d[\w.-]*$/.test(foreground)) return true;
  return false;
};

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
  | "codex-composer-not-ready"
  | "muse-turn-chrome"
  | "muse-no-prompt"
  | "muse-composer-not-ready"
  | "pane-capture-unavailable";

export type PromptReadiness =
  | { ready: true; reason: "vendor-prompt" }
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

/**
 * Codex's live status line, `• Working (12s • esc to interrupt)`, near the
 * bottom of the pane. Anchored like `inFlightStatusLine`, so a quoted or
 * bulleted mention in an agent's own prose does not read as chrome.
 */
const codexTurnChrome = (plain: string): boolean =>
  plain.split("\n").filter((line) => line.trim() !== "").slice(-8)
    .some((line) => /^[\s•⠀-⣿]*Working \(.*esc to interrupt/.test(line));

const CODEX_FOOTER = /^(?:(?:←\s+for agents\s+·\s+)?\?\s+for shortcuts|Context \d+% left|\d+% context left)/;

/**
 * True when the composer after `›` holds nothing but the placeholder Codex
 * paints dim (SGR 2). Undimmed text is a draft the owner has not sent, and a
 * nudge typed after it would be appended to it and submitted with it.
 */
const composerLineEmpty = (rawLine: string): boolean => {
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
 * Codex's composer (which may wrap) and the known footer lines below it;
 * anything else after the composer — a dialog, a new transcript item — fails
 * closed.
 */
const codexTail = (paneText: string): { composer: PaneLine[]; footer: PaneLine[] } | null => {
  const lines = paneLines(paneText);
  const composerAt = lines.map((line) => line.plain.startsWith("›")).lastIndexOf(true);
  if (composerAt < 0) return null;
  const after = lines.slice(composerAt);
  const footerAt = after.findIndex((line) => CODEX_FOOTER.test(line.plain));
  const composer = footerAt < 0 ? after : after.slice(0, footerAt);
  const footer = footerAt < 0 ? [] : after.slice(footerAt);
  return composer[0]?.plain.startsWith("›") === true && footer.every((line) => CODEX_FOOTER.test(line.plain))
    ? { composer, footer }
    : null;
};

/** An empty Codex composer: an owner draft would be submitted with the prompt. */
const codexComposerEmpty = (paneText: string): boolean => {
  const tail = codexTail(paneText);
  return tail !== null && tail.composer.length === 1 && composerLineEmpty(tail.composer[0]!.raw);
};

/** Codex's footer names its vim mode; the `i` prelude is only needed to leave NORMAL. */
const codexVimNormal = (paneText: string): boolean =>
  codexTail(paneText)?.footer.some((line) => /Vim: Normal/.test(line.plain)) === true;

const MUSE_RULE = /^─+$/;
/** The status footer names the model first: `muse-wonder-1.0 · high · <path> · Launch overrides`. */
const MUSE_FOOTER = /^muse-[\w.-]+ · /;

/**
 * Muse's live composer: the last `❯` line and any wrapped input above a pure
 * `─` rule, followed by exactly its one-line status footer. Submitted
 * prompts stay above it as `❯ …` history. Any other tail (splash, menu,
 * dialog, a missing or replaced footer) is unknown and fails closed as `null`.
 */
const museComposer = (paneText: string): PaneLine[] | null => {
  const lines = paneLines(paneText);
  const composerAt = lines.map((line) => line.plain.startsWith("❯")).lastIndexOf(true);
  if (composerAt < 0) return null;
  const ruleAt = lines.findIndex((line, index) => index > composerAt && MUSE_RULE.test(line.plain));
  return ruleAt < 0 || lines.length !== ruleAt + 2 || !MUSE_FOOTER.test(lines[ruleAt + 1]!.plain)
    ? null : lines.slice(composerAt, ruleAt);
};

const museComposerEmpty = (paneText: string): boolean => {
  const composer = museComposer(paneText);
  return composer !== null && composer.length === 1 && composer[0]!.plain === "❯";
};

/**
 * Muse keeps an empty composer painted during a turn; its status line just
 * above it (`◈ Thinking (3s · esc to interrupt)`) is the busy signal. Enter
 * would steer that turn, so this blocks every key. Narrow panes shorten that
 * line (`runn… (24s · esc to interrupt)`) or clip it (`◇ Thinking (0s · esc to
 * interr`), so the elapsed timer is matched, not the glyph or the full suffix.
 * Finished items show their duration without the parenthesis (`· 20s · ctrl+o`).
 */
const museTurnChrome = (paneText: string): boolean => {
  const lines = paneLines(paneText);
  const composerAt = lines.map((line) => line.plain.startsWith("❯")).lastIndexOf(true);
  return (composerAt < 0 ? lines : lines.slice(0, composerAt))
    .filter((line) => !line.plain.startsWith("─")).slice(-4)
    .some((line) => /\((?:\d+[hm] )*\d+s ·|esc to interr/.test(line.plain));
};

/**
 * Muse submit-only recovery requires the whole current prompt in the live
 * composer, not just its action ID: an owner draft quoting the ID, or the
 * prompt for an older digest of the same action, must not be submitted.
 */
const musePromptPending = (paneText: string, actionPath: string, actionId: string, actionDigest?: string): boolean => {
  const typed = museComposer(paneText)?.map((line) => line.plain).join("").replace(/^❯/, "").replace(/\s+/g, "");
  return typed !== undefined && [false, true].some((resend) =>
    renderNudgeText(actionPath, actionId, actionDigest, resend).replace(/\s+/g, "") === typed);
};

/** Active unquoted terminal lines, not prose discussing a past limit. Fail closed. */
const claudeUsageWait = (plain: string): boolean => {
  const tail = plain.split("\n").slice(-12).join("\n");
  // Keep the line anchor to reject quoted prose, but admit TUI spinners/boxes.
  const prefix = String.raw`${SPINNER_PREFIX}(?:[│┃⏸⏳!⎿●]${SPINNER_PREFIX})*`;
  return new RegExp(String.raw`^${prefix}(?:Usage limit (?:reached|reset)|(?:You've|You’ve|You have) hit your(?: .+)? limit|continuing (?:automatically|shortly)|Your usage limit has reset|Automatic continue (?:cancelled|canceled|stopped)|Wait here, then continue automatically)`, "im").test(tail);
};

/** A composer input line: `❯` (Claude), `›` (Codex), `>` (Antigravity), `→` (Cursor). */
const COMPOSER_LINE = /^[❯›>→]/;

/**
 * True when this action's prompt is still sitting unsent in the composer, so a
 * resend submits it instead of typing it a second time. Codex's composer is
 * parsed; other vendors use the lines from the last composer line down, so
 * already-submitted history above it never counts. Wrapping can split the
 * UUID, so whitespace is ignored.
 */
export const pendingPromptInComposer = (paneText: string, agentId: string, actionId: string): boolean => {
  const lines = paneLines(paneText);
  const composerAt = lines.map((line) => COMPOSER_LINE.test(line.plain)).lastIndexOf(true);
  const composer = agentId === "codex" ? codexTail(paneText)?.composer ?? [] : composerAt < 0 ? [] : lines.slice(composerAt);
  return composer.map((line) => line.plain).join("").replace(/\s+/g, "").includes(actionId);
};

/**
 * Watchdog activity: a digest of the pane above its last composer line. The
 * owner's draft and the vendor footer/status line below the composer are
 * ignored; spinners and elapsed-time chrome above it still change the digest.
 */
export const paneActivityDigest = (paneText: string): string => {
  const lines = stripAnsi(paneText).split("\n");
  const composerAt = lines.map((line) => COMPOSER_LINE.test(line.trim())).lastIndexOf(true);
  return sha256((composerAt < 0 ? lines : lines.slice(0, composerAt)).join("\n"));
};

/**
 * Whether the TUI has an idle prompt that can accept typed input, and why not.
 *
 * Process-name readiness alone is not enough: Antigravity/`agy` can be
 * foreground during splash while keys are discarded; Claude may still be on the
 * trust dialog. These are keystroke-safety checks, not idle detection.
 */
export const harnessPromptReadiness = (
  paneText: string,
  agentId: string
): PromptReadiness => {
  const plain = stripAnsi(paneText);
  const ready = (): PromptReadiness => ({ ready: true, reason: "vendor-prompt" });
  // Match Cursor's dialog lines (including its box and warning icon), not
  // phrases quoted in prose above an idle prompt.
  if (/trust this folder/i.test(plain) ||
    /^[ \t]*(?:│[ \t]*)?(?:⚠\uFE0F?[ \t]*)?(?:workspace trust required|do you trust the contents of this directory\?|trust this workspace\??)[ \t]*│?[ \t]*$/im.test(plain)) {
    return { ready: false, reason: "trust-dialog" };
  }
  switch (agentId) {
    case "claude":
      if (claudeUsageWait(plain)) return { ready: false, reason: "claude-usage-wait" };
      if (/❯|auto mode|-- INSERT --|-- NORMAL --|-- VISUAL/i.test(plain)) return ready();
      return { ready: false, reason: "claude-no-prompt" };
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
      return { ready: false, reason: "antigravity-no-prompt" };
    case "codex":
      // Codex accepts keys once the process is up; block only on its live turn status.
      if (codexTurnChrome(plain)) return { ready: false, reason: "codex-turn-chrome" };
      return ready();
    case "muse":
      if (museTurnChrome(paneText)) return { ready: false, reason: "muse-turn-chrome" };
      if (museComposer(paneText) === null) return { ready: false, reason: "muse-no-prompt" };
      return ready();
    default:
      return ready();
  }
};

/**
 * Vim-mode TUIs swallow the first nudge character in NORMAL. Enter insert with
 * `a` when INSERT is not visible. Codex keeps its configured `i` prelude.
 * Antigravity and Muse use no vim prelude. Cursor uses `a` only when `editor.vimMode` is on
 * (see `readCursorVimMode`). Claude often omits a mode indicator — still send
 * `a` unless INSERT is shown. resolveNudgeKeys skips this fallback when the
 * installed Claude settings explicitly disable vim.
 */
export const vimInsertPrelude = (paneText: string, agentId: string): readonly string[] => {
  if (agentId === "antigravity" || agentId === "codex" || agentId === "muse") return [];
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

const readClaudeEditorMode = (agentRoot: string): unknown => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentRoot, ".claude/settings.local.json"), "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as { editorMode?: unknown }).editorMode : undefined;
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
  const prelude = configuredPrelude.length > 0 ? configuredPrelude
    : agent.id === "claude" && readClaudeEditorMode(agent.root) === "normal" ? []
      : vimInsertPrelude(paneText, agent.id);
  let rawSubmit = agent.nudgeSubmit ?? defaults.nudgeSubmit;
  if (agent.id === "codex") {
    const legacy = (rawSubmit.length === 2 && rawSubmit[0] === "C-j" && rawSubmit[1] === "C-m") ||
      (rawSubmit.length === 1 && rawSubmit[0] === "C-m");
    return { prelude, submit: legacy ? ["Enter"] : rawSubmit };
  }
  // Escape interrupts a running Muse turn; never send it, even from stale config.
  if (agent.id === "muse") {
    const submit = rawSubmit.filter((key) => key !== "Escape");
    return { prelude: prelude.filter((key) => key !== "Escape"), submit: submit.length > 0 ? submit : defaults.nudgeSubmit };
  }
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

/** Let the TUI finish recognizing pasted text before its first submit key. */
export const NUDGE_AFTER_TEXT_MS = 300;
/** Keep Escape and Enter separate so the TUI does not interpret Alt+Enter. */
export const NUDGE_BETWEEN_SUBMIT_MS = 150;
/** Let a vim mode key (`i`, `a`, Escape) land as its own event before the next key or text. */
export const NUDGE_AFTER_PRELUDE_MS = 150;
/**
 * Antigravity under tmux often paints `⚠ Verifying your account...` a beat after
 * the idle `>` prompt. Typing then discards the nudge. Wait, then recapture.
 */
export const NUDGE_BEFORE_ANTIGRAVITY_MS = 2500;

/** The resend prefix precedes the identity: the prompt parser reads `at <path>` to end of line. */
export const RESEND_PREFIX = "If you already wrote complete for this action, only write its ready file. ";

export const renderNudgeText = (actionPath: string, actionId?: string, actionDigest?: string, resend = false): string =>
  (resend ? RESEND_PREFIX : "") + (actionId === undefined
    ? `Read and execute your current coordinator action at ${actionPath}`
    : actionDigest === undefined
      ? `Read and execute coordinator action ${actionId} at ${actionPath}`
      : `Read and execute coordinator action ${actionId} digest ${actionDigest} at ${actionPath}`);

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

export type OwnerReminderOutcome = {
  status: "sent" | "failed" | "uncertain";
  reason: string;
  stage: "gate" | "mid-send" | "complete";
  detail?: string;
};

/** Resolve macOS Terminal.app profile name for an owner attach window. */
export const resolveTerminalProfile = (agent: AgentConfig): string =>
  agent.terminalProfile ?? agentOwnerUiDefaults(agent.id).terminalProfile;

/** @deprecated Prefer resolveNudgeKeys(agent). */
export const nudgePreludeKeys = (agentId: string): readonly string[] => agentNudgeKeyDefaults(agentId).nudgePrelude;

const mouseScrollingAgent = (agentId: string): boolean => ["claude", "cursor", "codex"].includes(agentId);

const sessionScrollOptions = (session: string, mouse = true): string[][] => [
  ["set-option", "-t", session, "history-limit", "50000"],
  ...(mouse ? [["set-option", "-t", session, "mouse", "on"]] : [])
];

// Older tmux lacks scrollbars; -q ignores only unknown/ambiguous options.
const windowScrollOptions = (target: string, agentId: string): string[][] =>
  ["claude", "cursor"].includes(agentId)
    ? [["set-option", "-w", "-q", "-t", target, "pane-scrollbars", "on"]] : [];

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
    "set-option destroy-unattached on",
    ...sessionScrollOptions(client, mouseScrollingAgent(agentId)).map((args) => args.join(" ")),
    ...windowScrollOptions(`${client}:${window}`, agentId).map((args) => args.join(" "))
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

/** Directory that receives one agent's per-run terminal logs. */
export type TerminalLogDir = (agentId: string) => string;

/** A fresh log path per run, so a relaunch can never overwrite earlier evidence. */
const newTerminalLog = (dir: string): string => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  for (let suffix = 0; ; suffix += 1) {
    const log = join(dir, `run-${stamp}${suffix === 0 ? "" : `-${suffix}`}.log`);
    if (!existsSync(log)) return log;
  }
};

/**
 * Holds a new or dead pane, silently, while coord configures it. Bounded so a
 * launch interrupted before the agent replaces it leaves a pane that exits and
 * is relaunched by the next recovery.
 */
const LAUNCH_PLACEHOLDER = "sleep 60";

/** Timestamp the first byte of each line, flushing even prompts without a newline. */
const pipeToLog = (log: string): string => {
  const stamp = String.raw`$|=1; my $start=1; while (sysread(STDIN, my $chunk, 65536)>0) { for my $part (split(/(?<=\n)/, $chunk)) { if ($start) { my $t=time; print strftime("%Y-%m-%dT%H:%M:%S", gmtime(int($t))), sprintf(".%03dZ ", int(($t-int($t))*1000)); } print $part; $start=substr($part,-1) eq "\n"; } }`;
  // pipe-pane expands both tmux formats and strftime, including in quoted paths.
  return `if command -v perl >/dev/null 2>&1; then exec perl -MPOSIX=strftime -MTime::HiRes=time -e ${shellQuote(stamp)}; else exec cat; fi >> ${shellQuote(log)}`
    .replaceAll("#", "##").replaceAll("%", "%%");
};

const describeExit = (status: string, signal: string): string =>
  signal !== "" ? `signal ${signal}` : status !== "" ? `status ${status}` : "exit details unavailable";

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
      await this.recordPaneExits(["-s", "-t", name]);
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

  async startSession(issue: number, agents: readonly AgentConfig[], terminalLogDir?: TerminalLogDir): Promise<void> {
    await this.preflight(agents);
    const session = this.sessionName(issue);
    const exists = await this.runner(["has-session", "-t", session]);
    if (exists.exitCode === 0) throw new Error(`tmux session ${session} already exists; resume or remove it explicitly.`);
    const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
    if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    try {
      await this.configureSessionScrolling(session);
      const environment = await this.runner(["set-environment", "-t", session, "COORD_ISSUE", String(issue)]);
      if (environment.exitCode !== 0) {
        throw new Error(`cannot set coordinator issue environment in ${session}: ${environment.stderr}`);
      }
      await this.removeInheritedMode(session, "COORD_MANUAL");
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
          LAUNCH_PLACEHOLDER
        ]);
        const launched = window.exitCode === 0 ? await this.launchAgent(target, agent, launcher, terminalLogDir?.(agent.id)) : window;
        if (launched.exitCode !== 0) throw new Error(`cannot launch ${agent.id} in ${target}: ${launched.stderr}`);
      }
    } catch (error) {
      await this.runner(["kill-session", "-t", session]);
      throw error;
    }
  }

  private async configureSessionScrolling(session: string, mouse = true): Promise<void> {
    const commands = sessionScrollOptions(session, mouse);
    const result = await this.runner(commands.flatMap((args, index) => index === 0 ? args : [";", ...args]));
    if (result.exitCode !== 0) throw new Error(`cannot configure scrolling in ${session}: ${result.stderr}`);
  }

  /** The git shim disarms on COORD_MANUAL=1, so an automated session must never pass one on. */
  private async removeInheritedMode(session: string, name: string): Promise<void> {
    const removed = await this.runner(["set-environment", "-r", "-t", session, name]);
    if (removed.exitCode !== 0) throw new Error(`cannot remove ${name} from ${session}: ${removed.stderr}`);
  }

  /**
   * Read-only startup check that each agent window exists, is alive, and was
   * started in its own clone. The start path is fixed at creation, unlike the
   * foreground command, so a slow harness start cannot make it look wrong; an
   * empty value (older tmux) is reported as unknown rather than a mismatch.
   */
  async agentPlacementDiagnostics(key: SessionKey, agents: readonly AgentConfig[]): Promise<string[]> {
    const session = this.sessionName(key);
    const lines: string[] = [];
    for (const agent of agents) {
      const target = this.target(key, agent.id);
      const result = await this.runner([
        "display-message",
        "-p",
        "-t",
        target,
        "#{pane_dead}\t#{pane_start_path}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{@coord-log}"
      ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
      const [dead = "1", startPath = "", status = "", signal = "", log = ""] = result.stdout.replace(/\n$/, "").split("\t");
      const logNote = log === "" ? "" : `; output log: ${log}`;
      if (result.exitCode !== 0 || result.stdout.trim() === "") {
        lines.push(`[WARN] ${agent.id}: no window in tmux session ${session}; run coord attach or restart the agent through coord.`);
      } else if (dead === "1") {
        lines.push(
          `[WARN] ${agent.id}: the pane in ${target} has exited (${describeExit(status, signal)}; this alone does not show why)` +
            `${logNote}; inspect it, then restart the agent through coord.`
        );
      } else if (startPath !== "" && resolve(startPath) !== resolve(agent.root)) {
        lines.push(`[WARN] ${agent.id}: the pane in ${target} started in ${startPath}, not its clone ${resolve(agent.root)}.`);
      } else {
        lines.push(`[OK] ${agent.id}: running in ${target}${startPath === "" ? " (start directory unknown)" : ""}${logNote}.`);
      }
    }
    if (this.titleProbe !== null) {
      const launches = this.agentAttachLaunches(key, agents);
      const present = this.titleProbe(launches.map((launch) => launch.windowTitle));
      for (const launch of launches) {
        if (!present.includes(launch.windowTitle)) {
          lines.push(`[WARN] ${launch.agentId}: no Terminal window titled ${launch.windowTitle}; run coord attach${key === "manual" ? "" : ` ${key}`} to reopen it.`);
        }
      }
    }
    return lines;
  }

  async stopSession(key: SessionKey): Promise<void> {
    await this.recordPaneExits(["-s", "-t", this.sessionName(key)]);
    await this.runner(["kill-session", "-t", this.sessionName(key)]);
  }

  /**
   * Save tmux's exit status and signal beside each dead pane's run log before
   * the pane is respawned or destroyed. Best effort: a diagnostics failure must
   * never block recovery, and an existing record is never overwritten.
   */
  private async recordPaneExits(scope: readonly string[]): Promise<void> {
    const listed = await this.runner([
      "list-panes",
      ...scope,
      "-F",
      "#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_dead_time}\t#{@coord-log}"
    ]).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
    if (listed.exitCode !== 0) return;
    for (const line of listed.stdout.split("\n")) {
      const [dead, status = "", signal = "", time = "", log = ""] = line.split("\t");
      if (dead !== "1" || !log.endsWith(".log")) continue;
      const record = {
        status: status === "" ? null : Number(status),
        signal: signal === "" ? null : signal,
        deadAt: /^\d+$/.test(time) ? new Date(Number(time) * 1000).toISOString() : null,
        recordedAt: new Date().toISOString(),
        note: "tmux exit details only; they do not show why the agent exited. Read the output log."
      };
      try {
        writeFileSync(`${log.slice(0, -".log".length)}.exit.json`, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      } catch {
        // Already recorded, or the runtime is gone; never block the respawn or teardown.
      }
    }
  }

  async ensureSession(
    key: SessionKey,
    agents: readonly AgentConfig[],
    assertAuthority: () => void = () => undefined,
    terminalLogDir?: TerminalLogDir
  ): Promise<void> {
    const session = this.sessionName(key);
    const exists = await this.runner(["has-session", "-t", session]);
    assertAuthority();
    if (exists.exitCode !== 0) {
      const created = await this.runner(["new-session", "-d", "-s", session, "-n", "control"]);
      assertAuthority();
      if (created.exitCode !== 0) throw new Error(`tmux session creation failed: ${created.stderr}`);
    }
    // Set history before creating agent panes; repair existing sessions on resume too.
    await this.configureSessionScrolling(session);
    assertAuthority();
    // `-r` removes the variable from every process the session starts, even one
    // the tmux server's global environment still carries; `-u` would only drop
    // the session value and let that global value through.
    const environment =
      key === "manual"
        ? await this.runner(["set-environment", "-r", "-t", session, "COORD_ISSUE"])
        : await this.runner(["set-environment", "-t", session, "COORD_ISSUE", String(key)]);
    assertAuthority();
    if (environment.exitCode !== 0) {
      throw new Error(
        `${key === "manual" ? "cannot clear coordinator issue environment" : "cannot set coordinator issue environment"} ` +
          `in ${session}: ${environment.stderr}`
      );
    }
    if (key !== "manual") {
      await this.removeInheritedMode(session, "COORD_MANUAL");
      assertAuthority();
    }
    if (key === "manual") {
      const manualEnvironment = await this.runner(["set-environment", "-t", session, "COORD_MANUAL", "1"]);
      assertAuthority();
      if (manualEnvironment.exitCode !== 0) {
        throw new Error(`cannot set manual environment in ${session}: ${manualEnvironment.stderr}`);
      }
    }
    for (const agent of agents) {
      const target = `${session}:${safeName(agent.id)}`;
      const client = `${session}-${safeName(agent.id)}`;
      const attached = await this.runner(["has-session", "-t", `=${client}`]);
      assertAuthority();
      if (attached.exitCode === 0) {
        // Grouped clients have independent session options and may stay open on resume.
        await this.configureSessionScrolling(client, mouseScrollingAgent(agent.id));
        assertAuthority();
      }
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
        if (pane.alive) {
          for (const command of windowScrollOptions(target, agent.id)) {
            const configured = await this.runner(command);
            assertAuthority();
            if (configured.exitCode !== 0) throw new Error(`cannot configure scrolling in ${target}: ${configured.stderr}`);
          }
          continue;
        }
        const launcher = resolveAgentLauncher(agent);
        await this.recordPaneExits(["-t", target]);
        assertAuthority();
        // tmux refuses to pipe a dead pane, so hold it on the placeholder first.
        const held = await this.runner(["respawn-pane", "-k", "-t", target, "-c", resolve(agent.root), LAUNCH_PLACEHOLDER]);
        const respawned = held.exitCode === 0 ? await this.launchAgent(target, agent, launcher, terminalLogDir?.(agent.id)) : held;
        assertAuthority();
        if (respawned.exitCode !== 0) throw new Error(`cannot relaunch ${agent.id} in ${target}: ${respawned.stderr}`);
        continue;
      }
      const launcher = resolveAgentLauncher(agent);
      const window = await this.runner([
        "new-window",
        "-d",
        "-t",
        session,
        "-n",
        safeName(agent.id),
        "-c",
        resolve(agent.root),
        LAUNCH_PLACEHOLDER
      ]);
      const created = window.exitCode === 0 ? await this.launchAgent(target, agent, launcher, terminalLogDir?.(agent.id)) : window;
      assertAuthority();
      if (created.exitCode !== 0) throw new Error(`cannot launch ${agent.id} in ${target}: ${created.stderr}`);
    }
  }

  /**
   * Replace the placeholder running in `target` with the agent. Retention and
   * recording are set on the placeholder first and `respawn-pane` keeps the
   * pipe, so nothing the tmux configuration runs (a hook may block the command
   * queue) can let the agent print or exit before both are in place.
   */
  private async launchAgent(target: string, agent: AgentConfig, launcher: string, logDir: string | undefined): Promise<TmuxResult> {
    const log = logDir === undefined ? null : newTerminalLog(logDir);
    return this.runner([
      "set-option", "-w", "-t", target, "remain-on-exit", "on",
      ...windowScrollOptions(target, agent.id).flatMap((args) => [";", ...args]),
      ...(log === null ? [] : [
        ";", "set-option", "-w", "-t", target, "@coord-log", log,
        ";", "pipe-pane", "-t", target, pipeToLog(log)
      ]),
      ";", "respawn-pane", "-k", "-t", target, "-c", resolve(agent.root), launcher
    ]);
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

  /** An explicit owner instruction uses the transport without automatic readiness policy. */
  async remind(
    issue: number, agent: AgentConfig, text: string,
    assertAuthority: () => void = () => undefined,
    onBegin: () => void = () => undefined
  ): Promise<OwnerReminderOutcome> {
    let began = false;
    try {
      const target = this.target(issue, agent.id);
      assertAuthority();
      const pane = await this.inspectPane(target);
      assertAuthority();
      if (!pane.alive) return { status: "failed", reason: "pane-dead", stage: "gate" };
      if (pane.ownerTyping) {
        const cancelled = await this.runner(["send-keys", "-t", target, "-X", "cancel"]);
        assertAuthority();
        if (cancelled.exitCode !== 0) throw new Error(`tmux copy-mode exit failed: ${cancelled.stderr}`);
      }
      // Capture is only a hint for vim key selection, never permission to send.
      let paneText = "";
      try { paneText = await this.capturePane(target); } catch { /* Use configured keys. */ }
      assertAuthority();
      const { prelude, submit } = resolveNudgeKeys(agent, paneText);
      const preludeKeys = agent.id === "codex" && !codexVimNormal(paneText) ? [] : prelude;
      await this.typeAndSubmit(target, agent, text, preludeKeys, submit, async (args) => {
        assertAuthority();
        if (!began) { onBegin(); began = true; }
        const result = await this.runner(args);
        // Recheck before any remaining key, not after the final successful
        // submit: a completion racing the return does not undo terminal delivery.
        if (result.exitCode !== 0) throw new Error(`tmux send-keys failed: ${result.stderr}`);
        return null;
      }, assertAuthority);
      return { status: "sent", reason: "sent", stage: "complete" };
    } catch (error) {
      return { status: began ? "uncertain" : "failed", reason: "delivery-error",
        stage: began ? "mid-send" : "gate", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  async nudge(
    issue: number,
    agent: AgentConfig,
    actionPath: string,
    assertAuthority: () => void = () => undefined,
    actionId?: string,
    actionDigest?: string,
    reserveSend: () => void = () => undefined,
    options: { resend?: boolean } = {}
  ): Promise<NudgeOutcome> {
    if (agent.delivery !== "nudge" && agent.delivery !== "both") {
      return { status: "disabled", reason: "delivery-disabled", stage: "config" };
    }
    const target = this.target(issue, agent.id);
    const initial = await this.injectionGate(target, agent, assertAuthority);
    if (initial.status !== "ok") {
      return { status: initial.status, reason: initial.reason, stage: "gate", ...(initial.detail === undefined ? {} : { detail: initial.detail }) };
    }
    const promptPending = (text: string): boolean => actionId !== undefined && (agent.id === "muse"
      ? musePromptPending(text, actionPath, actionId, actionDigest) : pendingPromptInComposer(text, agent.id, actionId));
    // Keystroke safety only. Codex and Cursor queue a prompt typed mid-turn, so
    // their turn chrome vetoes only keys that include Escape, which cancels a turn.
    // Muse is not among them: Enter steers its running turn.
    const readinessFor = (text: string): PromptReadiness => {
      if (stripAnsi(text).trim() === "") return { ready: false, reason: "pane-capture-unavailable" };
      const readiness = harnessPromptReadiness(text, agent.id);
      const { prelude, submit } = resolveNudgeKeys(agent, text);
      return !readiness.ready && ["codex-turn-chrome", "cursor-turn-chrome"].includes(readiness.reason) &&
        ![...prelude, ...submit].includes("Escape") ? { ready: true, reason: "vendor-prompt" } : readiness;
    };
    const proofRefusal = (text: string): PromptBlockedReason | null => {
      const readiness = readinessFor(text);
      if (!readiness.ready) return readiness.reason;
      if (agent.id === "codex" && !codexComposerEmpty(text) && !promptPending(text)) return "codex-composer-not-ready";
      return agent.id === "muse" && !museComposerEmpty(text) && !promptPending(text) ? "muse-composer-not-ready" : null;
    };
    let paneText = await this.capturePane(target);
    assertAuthority();
    const refused = proofRefusal(paneText);
    if (refused !== null) return { status: "busy", reason: refused, stage: "prompt" };
    if (agent.id === "antigravity") {
      await this.sleep(NUDGE_BEFORE_ANTIGRAVITY_MS);
      assertAuthority();
      paneText = await this.capturePane(target);
      assertAuthority();
      const refused = proofRefusal(paneText);
      if (refused !== null) return { status: "busy", reason: refused, stage: "antigravity-recapture" };
    }
    // A prompt still sitting in the composer is submitted, not typed again.
    const submitOnly = promptPending(paneText);
    const text = submitOnly ? null : renderNudgeText(actionPath, actionId, actionDigest, options.resend === true);
    const { prelude, submit } = resolveNudgeKeys(agent, paneText);
    const preludeKeys = submitOnly || (agent.id === "codex" && !codexVimNormal(paneText)) ? [] : prelude;
    let began = false;
    const send = async (args: readonly string[]): Promise<NudgeOutcome | null> => {
      const gate = await this.injectionGate(target, agent, assertAuthority);
      if (gate.status !== "ok") return { status: gate.status, reason: gate.reason,
        stage: began ? "mid-send" : "gate", ...(gate.detail === undefined ? {} : { detail: gate.detail }) };
      if (agent.id === "claude" || agent.id === "codex" || agent.id === "muse") {
        const latest = await this.capturePane(target);
        assertAuthority();
        const readiness = readinessFor(latest);
        const refused = began ? (!readiness.ready ? readiness.reason : null) : proofRefusal(latest);
        if (refused !== null) return { status: "busy", reason: refused, stage: began ? "mid-send" : "prompt" };
        // The batch was chosen from the first capture. A prompt that appeared or was
        // submitted since would be typed twice or answered with a bare Enter: defer
        // before spending credit and choose again on the next poll.
        if (agent.id === "muse" && !began && promptPending(latest) !== submitOnly) {
          return { status: "busy", reason: "muse-composer-not-ready", stage: "prompt" };
        }
      }
      if (!began) { reserveSend(); began = true; }
      const result = await this.runner(args);
      assertAuthority();
      if (result.exitCode !== 0) throw new Error(`tmux send-keys failed: ${result.stderr}`);
      return null;
    };
    const refusedDuringSend = await this.typeAndSubmit(target, agent, text, preludeKeys, submit, send, assertAuthority);
    if (refusedDuringSend !== null) return refusedDuringSend;
    // This is transport success only. A matching vendor prompt-submit hook
    // acknowledges acceptance, even if it arrives after this method returns.
    return { status: "sent", reason: "sent", stage: "complete", ...(submitOnly ? { detail: "pending-prompt-submitted" } : {}) };
  }

  /** Share vendor key layout and text/key timing between automatic and owner delivery. */
  private async typeAndSubmit(
    target: string, agent: AgentConfig, text: string | null, preludeKeys: readonly string[], submit: readonly string[],
    send: (args: readonly string[]) => Promise<NudgeOutcome | null>, assertAuthority: () => void
  ): Promise<NudgeOutcome | null> {
    if (agent.id === "antigravity") {
      // Preserve AGY's working delivery, which has no prompt-submit callback.
      for (const key of preludeKeys) {
        const refused = await send(["send-keys", "-t", target, key]);
        if (refused !== null) return refused;
      }
      if (text !== null) {
        const refused = await send(["send-keys", "-l", "-t", target, text]);
        if (refused !== null) return refused;
      }
      await this.sleep(NUDGE_AFTER_TEXT_MS);
      assertAuthority();
      for (const [index, key] of submit.entries()) {
        if (index > 0) { await this.sleep(NUDGE_BETWEEN_SUBMIT_MS); assertAuthority(); }
        const refused = await send(["send-keys", "-t", target, key]);
        if (refused !== null) return refused;
      }
    } else {
      // Blocking run-shell commands keep the TUI's text/key gaps inside one
      // tmux operation. Without them, a vim prelude key joins the text burst
      // and INSERT is missed (issue 206), Enter can join the paste as a newline,
      // or Escape+Enter can become Alt+Enter. Never use run-shell -b here.
      const commands = [
        ...preludeKeys.flatMap((key) => [
          ["send-keys", "-t", target, key],
          ["run-shell", `sleep ${NUDGE_AFTER_PRELUDE_MS / 1000}`]
        ]),
        // If a prelude key lands in the composer anyway, keep it apart from the prompt.
        ...(text === null ? [] : [["send-keys", "-l", "-t", target, preludeKeys.length > 0 ? ` ${text}` : text]]),
        ...submit.flatMap((key, index) => [
          ["run-shell", `sleep ${(index === 0 ? NUDGE_AFTER_TEXT_MS : NUDGE_BETWEEN_SUBMIT_MS) / 1000}`],
          ["send-keys", "-t", target, key]
        ])
      ];
      const refused = await send(commands.flatMap((command, index) => index === 0 ? command : [";", ...command]));
      if (refused !== null) return refused;
    }
    return null;
  }
}
