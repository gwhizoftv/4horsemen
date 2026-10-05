import type { OwnerAnswer } from "./ownerControls.js";

/*
 * Owner keys for the foreground coordinator. It owns only the coordinator's
 * own terminal: agent tmux panes are separate terminals and keep taking typed
 * input directly. Workflow effects stay behind the injected commands.
 */

export type InteractiveInput = {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  on(event: "end" | "close", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "end" | "close", listener: () => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
};

export type InteractiveOutput = { isTTY?: boolean; write(chunk: string): unknown };

export type SignalSource = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export type OwnerQuestionView = {
  id: string;
  kind: "ballot-escalation" | "revision-limit";
  round: number;
  allowedAnswers: readonly OwnerAnswer[];
};

/** Each command returns the line to show; a thrown error is shown, never rethrown. */
export type InteractiveCommands = {
  status(): string;
  togglePause(): string;
  attach(): Promise<string>;
  activeAgents(): readonly string[];
  drop(agent: string): string;
  holds(): readonly { id: string; label: string }[];
  releaseHold(id: string): string;
  steer(text: string): string;
  question(): OwnerQuestionView | null;
  answer(questionId: string, answer: OwnerAnswer): string;
  /** Stop the foreground runner only; tmux sessions and runtime state stay. */
  stop(): void;
};

export type InteractiveSession = {
  /** Log-safe output: clears an open prompt, writes, and redraws it. */
  print(message: string): void;
  close(): void;
};

export const HOTKEY_HELP = [
  "Keys: s status · p/Space pause or resume · a attach agent windows · d drop an agent",
  "      r release a hold · /steer <text> queue guidance for the next step · ? help · q stop",
  "Agent tmux panes still accept typing directly; q leaves them running (resume with coord run)."
].join("\n");

const ANSWER_LABELS: Record<OwnerAnswer, string> = {
  retry: "Retry ballot",
  revise: "Move to next revision round",
  abandon: "Abandon"
};

const MAX_LINE = 2000;
const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const ESC = "\u001b";

type Choice = { label: string; run: () => void };
type Mode =
  | { kind: "keys" }
  | { kind: "line"; buffer: string }
  | { kind: "menu"; title: string; choices: Choice[]; questionId?: string }
  | { kind: "confirm"; question: string; run: () => void };

export const startInteractiveSession = (options: {
  input: InteractiveInput;
  output: InteractiveOutput;
  commands: InteractiveCommands;
  signals?: SignalSource;
  /** How often to look for a new owner question between runner log lines. */
  pollMs?: number;
}): InteractiveSession | null => {
  const { input, output, commands } = options;
  // Strict gating: CI, pipes and redirected output keep the plain log stream.
  if (input.isTTY !== true || output.isTTY !== true || typeof input.setRawMode !== "function") return null;
  const signals = options.signals ?? process;

  let mode: Mode = { kind: "keys" };
  let closed = false;
  let shownQuestion: string | null = null;

  const promptText = (): string => {
    if (mode.kind === "line") return `> ${mode.buffer}`;
    if (mode.kind === "menu") return `Select (1-${mode.choices.length}, Esc cancels) > `;
    if (mode.kind === "confirm") return `${mode.question} [y/N] > `;
    return "";
  };
  const clearPrompt = (): void => {
    if (mode.kind !== "keys") output.write("\r\u001b[2K");
  };
  const drawPrompt = (): void => {
    if (mode.kind !== "keys") output.write(promptText());
  };
  const writeLine = (message: string): void => {
    clearPrompt();
    output.write(message.endsWith("\n") ? message : `${message}\n`);
    drawPrompt();
  };
  const attempt = (action: () => string): void => {
    try {
      writeLine(action());
    } catch (error) {
      writeLine(`coord: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const setMode = (next: Mode): void => {
    clearPrompt();
    mode = next;
    drawPrompt();
  };
  const openMenu = (title: string, choices: Choice[], questionId?: string): void => {
    clearPrompt();
    output.write(`${title}\n${choices.map((choice, index) => `    [${index + 1}] ${choice.label}`).join("\n")}\n`);
    mode = questionId === undefined ? { kind: "menu", title, choices } : { kind: "menu", title, choices, questionId };
    drawPrompt();
  };
  const confirm = (question: string, run: () => void): void => setMode({ kind: "confirm", question, run });

  const showQuestion = (): void => {
    if (mode.kind !== "keys") return;
    let question: OwnerQuestionView | null;
    try {
      question = commands.question();
    } catch {
      return;
    }
    if (question === null || question.id === shownQuestion) return;
    shownQuestion = question.id;
    const id = question.id;
    const title =
      question.kind === "ballot-escalation"
        ? `[?] Ballot split in round ${question.round}:`
        : `[?] Revision limit reached in round ${question.round}:`;
    openMenu(
      title,
      question.allowedAnswers.map((answer) => ({
        label: ANSWER_LABELS[answer],
        run: () => {
          const apply = (): void => attempt(() => commands.answer(id, answer));
          if (answer === "abandon") confirm("Abandon this workflow?", apply);
          else apply();
        }
      })),
      id
    );
  };

  /** A question answered or replaced elsewhere must not take this keypress. */
  const closeStaleQuestion = (): void => {
    if (mode.kind !== "menu" || mode.questionId === undefined) return;
    let current: OwnerQuestionView | null = null;
    try {
      current = commands.question();
    } catch {
      return;
    }
    if (current?.id === mode.questionId) return;
    setMode({ kind: "keys" });
    writeLine("The owner question was resolved elsewhere; nothing was applied.");
  };

  const quickKey = (key: string): void => {
    switch (key) {
      case "s":
        attempt(commands.status);
        // A cancelled owner question reopens after a status check.
        shownQuestion = null;
        return;
      case "p":
      case " ":
        attempt(commands.togglePause);
        return;
      case "a":
        commands.attach().then(
          (message) => {
            if (!closed && message !== "") writeLine(message);
          },
          (error: unknown) => {
            if (!closed) writeLine(`coord: ${error instanceof Error ? error.message : String(error)}`);
          }
        );
        return;
      case "d": {
        const agents = commands.activeAgents();
        openMenu(
          "Select agent to drop:",
          agents.map((agent) => ({ label: agent, run: () => confirm(`Drop ${agent}?`, () => attempt(() => commands.drop(agent))) }))
        );
        return;
      }
      case "r": {
        const holds = commands.holds();
        if (holds.length === 0) {
          writeLine("No active holds.");
          return;
        }
        openMenu("Select hold to release:", holds.map((hold) => ({ label: hold.label, run: () => attempt(() => commands.releaseHold(hold.id)) })));
        return;
      }
      case "/":
        setMode({ kind: "line", buffer: "/" });
        return;
      case "?":
      case "h":
        writeLine(HOTKEY_HELP);
        return;
      case "q":
        stop();
        return;
      default:
        return;
    }
  };

  const submitLine = (line: string): void => {
    setMode({ kind: "keys" });
    const match = /^\/steer(?:\s+(.*))?$/.exec(line.trim());
    if (match === null) {
      writeLine("Unknown command. Use /steer <text>.");
      return;
    }
    const text = (match[1] ?? "").trim();
    if (text === "") {
      writeLine("Usage: /steer <text>");
      return;
    }
    attempt(() => commands.steer(text));
  };

  const lineInput = (chunk: string): void => {
    for (const character of chunk) {
      if (mode.kind !== "line") return;
      if (character === "\r" || character === "\n") {
        submitLine(mode.buffer);
        return;
      }
      if (character === "\u007f" || character === "\b") {
        const buffer = mode.buffer.slice(0, -1);
        setMode(buffer === "" ? { kind: "keys" } : { kind: "line", buffer });
        continue;
      }
      // Control characters never reach guidance text.
      if (character < " ") continue;
      if (mode.buffer.length >= MAX_LINE) continue;
      clearPrompt();
      mode = { kind: "line", buffer: mode.buffer + character };
      drawPrompt();
    }
  };

  const onData = (raw: Buffer | string): void => {
    if (closed) return;
    const chunk = typeof raw === "string" ? raw : raw.toString("utf8");
    if (chunk === CTRL_C || chunk === CTRL_D) {
      stop();
      return;
    }
    if (chunk === ESC) {
      if (mode.kind !== "keys") {
        setMode({ kind: "keys" });
        writeLine("Cancelled.");
      }
      return;
    }
    // Arrow keys and other escape sequences are not controls here.
    if (chunk.startsWith(ESC)) return;
    if (mode.kind === "line") {
      lineInput(chunk);
      return;
    }
    // A pasted burst must not turn into a series of quick controls.
    if ([...chunk].length !== 1) return;
    if (mode.kind === "menu") {
      closeStaleQuestion();
      if (mode.kind !== "menu") return;
      const index = Number.parseInt(chunk, 10) - 1;
      const choice = Number.isInteger(index) ? mode.choices[index] : undefined;
      if (choice === undefined) return;
      setMode({ kind: "keys" });
      choice.run();
      showQuestion();
      return;
    }
    if (mode.kind === "confirm") {
      const run = mode.run;
      setMode({ kind: "keys" });
      if (chunk === "y" || chunk === "Y") run();
      else writeLine("Cancelled.");
      showQuestion();
      return;
    }
    quickKey(chunk);
    showQuestion();
  };

  const onEnd = (): void => stop();
  const onError = (): void => stop();
  const timer = setInterval(() => {
    closeStaleQuestion();
    showQuestion();
  }, options.pollMs ?? 1000);
  timer.unref?.();

  const close = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearPrompt();
    mode = { kind: "keys" };
    input.off("data", onData);
    input.off("end", onEnd);
    input.off("close", onEnd);
    input.off("error", onError);
    signals.off("SIGINT", stop);
    signals.off("SIGTERM", stop);
    try {
      input.setRawMode?.(false);
    } finally {
      input.pause();
    }
  };
  function stop(): void {
    if (closed) return;
    try {
      commands.stop();
    } finally {
      close();
    }
  }

  input.setRawMode(true);
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.on("error", onError);
  signals.on("SIGINT", stop);
  signals.on("SIGTERM", stop);
  input.resume();
  output.write(`${HOTKEY_HELP}\n`);
  showQuestion();

  return {
    print: (message) => {
      if (closed) {
        output.write(message.endsWith("\n") ? message : `${message}\n`);
        return;
      }
      writeLine(message);
      showQuestion();
    },
    close
  };
};
