import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export type TerminalInput = Readable & {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (raw: boolean) => unknown;
};
export type TerminalOutput = Writable & { isTTY?: boolean; columns?: number };
export type OwnerQuestion = { id: string; kind: string; round: number; allowedAnswers: readonly ("retry" | "revise" | "abandon")[] };
export type InteractiveCommands = {
  status(): string;
  togglePause(): string;
  attach(): Promise<void>;
  agents(): readonly string[];
  drop(agent: string): void;
  holds(): readonly { id: string; agent: string; reason: string }[];
  /** `resetBudget` is true only for a confirmed reminder-limit (nudge-loop) hold. */
  releaseHold(id: string, resetBudget: boolean): void;
  /** Active agents with an unfinished action coord could remind them about. */
  remindable(): readonly string[];
  /** Queue a reminder; returns the sentence to show. */
  remind(agent: string): string;
  steer(text: string): void;
  answer(id: string, choice: "retry" | "revise" | "abandon"): void;
};
export type InteractiveSession = { print(message: string): void; close(): void; settled(): Promise<void> };

type Menu = { kind: "drop" | "hold" | "remind" | "question"; id?: string; items: { label: string; run(): void; confirm?: boolean }[] };
const help = "Controls: s status · p/Space pause · n remind agent · r release hold · a attach · d drop · /steer <text> · q quit · ?/h help\n";
const verboseHelp = `Controls (press the key; no Enter needed):
  s              Show the status snapshot: what coord is doing, whether it needs you, each agent's state, and any holds.
  p / Space      Pause or unpause coord. Pausing stops new work from being sent to agents; it never releases a hold.
  n              Remind an agent to finish its current action. coord types the reminder only if that agent's
                 terminal is provably idle, and prints what happened.
  r              Release a hold after you have looked at the agent. A reminder-limit hold asks you to confirm
                 that coord may send that action 4 more times.
  a              Reopen the agent Terminal windows.
  d              Drop an agent from this issue (asks you to confirm). Its unfinished work is no longer used.
  /steer <text>  Queue one line of guidance for every active agent. It is added to each agent's next action;
                 it is not typed into their terminals now.
  q              Quit this coordinator window. Agents keep running and coord N resumes later
                 (coord detach N closes everything).
  Enter          Print a fresh prompt, to check that coord is responsive.
  ? / h          Show this help.
Terms: an action is the task coord writes to an agent's action.md; a turn is one prompt-and-reply cycle in the
agent's terminal; a hold means coord stopped sending work to one agent until you release it.
There is no key to force the next stage: coord advances only when agents publish work that passes its checks.
If an agent is stuck, use n, r, or coord restart-action.
`;
/** Visible, bounded echo of what the owner typed; control bytes never reach the terminal. */
const visible = (text: string): string => {
  const shown = Array.from(text.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, "?"));
  return shown.length > 40 ? `${shown.slice(0, 40).join("")}…` : shown.join("");
};

/** Owns this terminal only; workflow policy stays in the supplied commands. */
export const startInteractiveSession = (options: {
  input: TerminalInput;
  output: TerminalOutput;
  commands: InteractiveCommands;
  readQuestion(): OwnerQuestion | null;
  signal: AbortSignal;
  stop(reason: "quit" | "interrupt" | "terminate" | "eof" | "error"): void;
}): InteractiveSession | null => {
  const { input, output, commands, signal } = options;
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function" || signal.aborted) return null;
  const wasRaw = input.isRaw ?? false;
  const wasFlowing = input.readableFlowing === true;
  const decoder = new StringDecoder("utf8");
  let closed = false;
  let mode: "keys" | "line" | "menu" | "confirm" = "keys";
  let buffer = "";
  let menu: Menu | null = null;
  let confirmation: Menu["items"][number] | null = null;
  let shownQuestion: string | null = null;
  let pending = Promise.resolve();
  let interval: ReturnType<typeof setInterval> | undefined;
  let escape = "";
  let paste: string | null = null;
  let escapeTimer: ReturnType<typeof setTimeout> | undefined;

  const raw = (text: string) => { output.write(text); };
  const clear = () => raw("\r\x1b[2K");
  const prompt = () => {
    const value = mode === "line" ? buffer : mode === "menu" ? `Select number + Enter (Esc cancels) > ${buffer}` :
      mode === "confirm" ? `${confirmation?.label}? [y/N] > ` : "coord [? help] > ";
    // Conservative width for non-ASCII input avoids wrapping a prompt that we
    // subsequently clear with a single-line escape sequence.
    const chars = Array.from(value);
    const width = (char: string) => char.codePointAt(0)! > 127 ? 2 : 1;
    let size = chars.reduce((total, char) => total + width(char), 0);
    const limit = Math.max(1, (output.columns ?? 80) - 1);
    while (size > limit && chars.length > 0) size -= width(chars.shift()!);
    return chars.join("");
  };
  const draw = () => { if (!closed) { clear(); raw(prompt()); } };
  const reset = () => { mode = "keys"; buffer = ""; menu = null; confirmation = null; };
  const say = (text: string) => { clear(); raw(text.endsWith("\n") ? text : `${text}\n`); };
  const showMenu = (value: Menu, title: string) => {
    menu = value; mode = "menu"; buffer = "";
    say(`${title}\n${value.items.map((item, index) => `  [${index + 1}] ${item.label}`).join("\n")}`);
  };
  const refreshQuestion = () => {
    if (closed) return;
    const question = options.readQuestion();
    if (menu?.kind === "question" && menu.id !== question?.id) {
      reset(); say("The displayed owner question is no longer pending.");
    }
    if (question === null) { shownQuestion = null; return; }
    // Never replace text being composed or a different menu with a prompt.
    if (mode !== "keys" || shownQuestion === question.id) return;
    shownQuestion = question.id;
    showMenu({ kind: "question", id: question.id, items: question.allowedAnswers.map((choice) => ({
      label: choice, confirm: choice === "abandon", run: () => commands.answer(question.id, choice)
    })) }, `Owner question: ${question.kind}, round ${question.round}`);
  };
  const refresh = () => {
    try { refreshQuestion(); } catch (error) { say(`coord: ${error instanceof Error ? error.message : String(error)}`); }
    draw();
  };
  const dispatch = (work: () => void | Promise<void>) => {
    pending = pending.then(async () => {
      if (closed) return;
      try { await work(); }
      catch (error) { if (!closed) say(`coord: ${error instanceof Error ? error.message : String(error)}`); }
      if (!closed) refresh();
    });
  };
  const stop = (reason: Parameters<typeof options.stop>[0]) => {
    if (closed) return;
    close();
    options.stop(reason);
  };
  const interrupt = () => stop("interrupt");
  const terminate = () => stop("terminate");
  const end = () => stop("eof");
  const error = () => stop("error");
  const cancel = () => { reset(); draw(); };

  const key = (value: string) => {
    if (closed) return;
    if (value === "\x03") { stop("interrupt"); return; }
    if (value === "\x04") { stop("eof"); return; }
    if (value === "\x1b") { cancel(); return; }
    if (value === "q" && mode !== "line") { stop("quit"); return; }
    if (mode === "confirm") {
      const selected = confirmation;
      reset();
      if (value.toLowerCase() === "y" && selected !== null) dispatch(selected.run);
      else draw();
      return;
    }
    if (mode === "line" || mode === "menu") {
      if (value === "\r" || value === "\n") {
        const text = buffer;
        const selected = menu;
        const line = mode === "line";
        reset();
        if (line) {
          const match = /^\/steer\s+(.+)$/.exec(text);
          if (match === null) { say("Usage: /steer <nonblank single-line guidance>"); draw(); }
          else dispatch(() => { commands.steer(match[1]!); say("Guidance queued; every active agent sees it in its next action."); });
        } else {
          const item = /^\d+$/.test(text) ? selected?.items[Number(text) - 1] : undefined;
          if (item === undefined) { say("No such selection."); draw(); }
          else if (item.confirm) { mode = "confirm"; confirmation = item; draw(); }
          else dispatch(item.run);
        }
      } else if (value === "\x7f" || value === "\b") {
        buffer = Array.from(buffer).slice(0, -1).join(""); draw();
      } else if (!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) && (mode === "line" || /^\d$/.test(value))) {
        if (buffer.length + value.length <= 2007) buffer += value;
        draw();
      }
      return;
    }
    if (value === "/") { mode = "line"; buffer = "/"; draw(); return; }
    // Return is a liveness check: keep the old prompt line and draw a new one.
    if (value === "\r" || value === "\n") { raw("\n"); draw(); return; }
    if (!"spa ?hdrn".includes(value)) {
      if (!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) { say(`Unknown command '${visible(value)}'.\n${verboseHelp}`); draw(); }
      return;
    }
    dispatch(async () => {
      if (value === "s") { say(commands.status()); shownQuestion = null; }
      else if (value === "p" || value === " ") say(commands.togglePause());
      else if (value === "a") await commands.attach();
      else if (value === "?" || value === "h") say(verboseHelp);
      else if (value === "n") {
        const agents = commands.remindable();
        if (agents.length === 0) say("No agent has an unfinished action that coord can remind it about.");
        else showMenu({ kind: "remind", items: agents.map((agent) => ({
          label: `Remind ${agent} to finish its current action`, run: () => { say(commands.remind(agent)); }
        })) }, "Select an agent to remind:");
      }
      else if (value === "d") showMenu({ kind: "drop", items: commands.agents().map((agent) => ({
        label: `Drop ${agent}`, confirm: true, run: () => { commands.drop(agent); say(`Dropped ${agent}.`); }
      })) }, "Select an active agent to drop:");
      else if (value === "r") {
        const holds = commands.holds();
        if (holds.length === 0) say("No active holds.");
        else showMenu({ kind: "hold", items: holds.map((hold) => hold.reason === "nudge-loop" ? {
          // A reminder-limit release also resets the allowance, so it is confirmed separately.
          label: `${hold.agent}: reminder limit reached — release it and allow 4 more sends`, confirm: true,
          run: () => { commands.releaseHold(hold.id, true); say(`Released hold ${hold.id}; coord may send ${hold.agent} its action 4 more times.`); }
        } : {
          label: `${hold.agent}: ${hold.reason}`, run: () => { commands.releaseHold(hold.id, false); say(`Released hold ${hold.id}.`); }
        }) }, "Look at the agent's terminal first, then select the hold to release:");
      }
    });
  };

  const data = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text.length === 0) return;
    const multiple = Array.from(text).length > 1;
    // Plain pasted chunks cannot expand into quick controls or confirmations.
    if ((mode === "keys" || mode === "confirm") && escape === "" && paste === null &&
        multiple && !text.includes("\x1b")) {
      if (mode === "keys" && /^[\r\n]+$/.test(text)) { key("\r"); return; }
      if (mode === "keys") { say(`Ignored pasted text '${visible(text)}'; nothing was run. Press / first to paste guidance.`); draw(); }
      return;
    }
    if (mode === "menu" && escape === "" && paste === null && multiple &&
        !/^\d+$/.test(text) && !text.includes("\x1b")) return;
    for (const char of text) {
      if (char === "\x1b") {
        escape = char;
        clearTimeout(escapeTimer);
        escapeTimer = setTimeout(() => { if (escape === "\x1b") { escape = ""; key("\x1b"); } }, 40);
        continue;
      }
      if (escape !== "") {
        escape += char;
        if (escape === "\x1b[") continue;
        if (escape.startsWith("\x1b[") && /^[0-9;]*$/.test(escape.slice(2)) && escape.length < 24) continue;
        if (escape === "\x1b[200~") paste = "";
        else if (escape === "\x1b[201~" && paste !== null) {
          if (mode === "line") buffer = (buffer + paste.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ")).slice(0, 2007);
          paste = null; draw();
        }
        escape = ""; clearTimeout(escapeTimer);
        continue;
      }
      if (paste !== null) { if (paste.length < 2007) paste += char; continue; }
      // Even a plain multi-line paste (or an escape-bearing chunk) must not
      // submit an edit and execute the remaining bytes as quick controls.
      if (multiple && (mode === "keys" || mode === "confirm")) continue;
      if (multiple && mode === "menu" && !/^\d$/.test(char)) continue;
      if (multiple && mode === "line" && /[\p{Cc}\p{Zl}\p{Zp}]/u.test(char)) { key(" "); continue; }
      key(char);
    }
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(interval); clearTimeout(escapeTimer);
    input.off("data", data); input.off("end", end); input.off("error", error);
    process.off("SIGINT", interrupt); process.off("SIGTERM", terminate);
    signal.removeEventListener("abort", close);
    try { input.setRawMode!(wasRaw); }
    finally { if (!wasFlowing) input.pause(); clear(); raw("\x1b[?2004l\n"); }
  };
  try {
    input.setRawMode(true);
    input.on("data", data); input.on("end", end); input.on("error", error);
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    signal.addEventListener("abort", close, { once: true });
    input.resume();
    raw("\x1b[?2004h");
    say(help); refresh();
    interval = setInterval(refresh, 1000);
    interval.unref();
  } catch (cause) { close(); throw cause; }
  return {
    print: (message) => { if (closed) raw(message); else { say(message); refresh(); } },
    close,
    settled: () => pending
  };
};
