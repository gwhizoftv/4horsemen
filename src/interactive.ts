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
  releaseHold(id: string, resetBudget?: boolean): void;
  reminders?(): readonly { label: string; request(): string }[];
  steer(text: string): void;
  answer(id: string, choice: "retry" | "revise" | "abandon"): void;
};
export type InteractiveSession = { print(message: string): void; close(): void; settled(): Promise<void> };

type Menu = { kind: "drop" | "hold" | "question" | "reminder"; id?: string; items: { label: string; run(): void; confirm?: boolean }[] };
const banner = "Controls: s status · p/Space manual pause · a attach · d drop · n remind · r release hold · /steer <text> · q quit · ?/h help\n";
const help = `${banner}
s: Show status, accepted commits, warnings and recovery commands.
p / Space: Toggle your manual pause; this never releases an agent hold.
a: Open missing agent terminal windows so you can inspect them or type directly.
d: Select an agent to drop; a separate confirmation is required.
n: Request a reminder for one current task or all agents; readiness checks and send limits still apply.
r: Release one inspected hold; resetting its reminder allowance requires confirmation.
/steer <text>: Queue guidance for every recipient of the next assigned cohort, not an immediate broadcast.
q: Stop this foreground coordinator only; agent terminals remain open.
Enter: Print a new prompt to confirm this terminal is responsive.
? / h: Show this help.
An action is a task in action.md; a turn is one agent prompt/reply cycle; a pin is a commit.
Idle is not completion: the agent must submit valid work before coord advances.
If a reminder is refused, inspect the agent terminal and type there if needed.
`;

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
          else dispatch(() => { commands.steer(match[1]!); say("Guidance queued for the next workflow boundary."); });
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
    if (value === "\r" || value === "\n") { raw("\n"); draw(); return; }
    dispatch(async () => {
      if (value === "s") { say(commands.status()); shownQuestion = null; }
      else if (value === "p" || value === " ") say(commands.togglePause());
      else if (value === "a") await commands.attach();
      else if (value === "?" || value === "h") say(help);
      else if (value === "n") {
        const reminders = commands.reminders?.() ?? [];
        if (reminders.length === 0) say("No outstanding task is available to remind.");
        else {
          const items = reminders.map((item) => ({ label: item.label, run: () => say(item.request()) }));
          if (reminders.length > 1) items.push({ label: "All agents", run: () => {
            for (const item of reminders) {
              try { say(item.request()); }
              catch (error) { say(`${item.label}: ${error instanceof Error ? error.message : String(error)}`); }
            }
          } });
          showMenu({ kind: "reminder", items }, "Select an agent to remind about its current task (not restart it):");
        }
      }
      else if (value === "d") showMenu({ kind: "drop", items: commands.agents().map((agent) => ({
        label: `Drop ${agent}`, confirm: true, run: () => { commands.drop(agent); say(`Dropped ${agent}.`); }
      })) }, "Select an active agent to drop:");
      else if (value === "r") {
        const holds = commands.holds();
        if (holds.length === 0) say("No active holds.");
        else showMenu({ kind: "hold", items: holds.map((hold) => ({
          label: hold.reason === "nudge-loop" ? `${hold.agent}: allow four more reminders after inspection` : `${hold.agent}: ${hold.reason}`,
          confirm: hold.reason === "nudge-loop",
          run: () => {
            if (hold.reason === "nudge-loop") commands.releaseHold(hold.id, true);
            else commands.releaseHold(hold.id);
            say(`Released hold ${hold.id}; other holds and manual pause are unchanged.`);
          }
        })) }, "Inspect the agent before releasing its hold:");
      }
      else if (!/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) say(`Unknown command ${JSON.stringify(value)}.\n${help}`);
    });
  };

  const data = (chunk: Buffer | string) => {
    const text = typeof chunk === "string" ? chunk : decoder.write(chunk);
    if (text.length === 0) return;
    const multiple = Array.from(text).length > 1;
    // Plain pasted chunks cannot expand into quick controls or confirmations.
    if ((mode === "keys" || mode === "confirm") && escape === "" && paste === null &&
        multiple && !text.includes("\x1b")) {
      if (mode === "keys") {
        if (/^[\r\n]+$/.test(text)) { raw("\n"); draw(); }
        else { say(`Unknown command ${JSON.stringify(text)} (pasted input is not executed).\n${help}`); draw(); }
      }
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
    say(banner); refresh();
    interval = setInterval(refresh, 1000);
    interval.unref();
  } catch (cause) { close(); throw cause; }
  return {
    print: (message) => { if (closed) raw(message); else { say(message); refresh(); } },
    close,
    settled: () => pending
  };
};
