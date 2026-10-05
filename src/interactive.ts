import { emitKeypressEvents } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type InteractiveOwnerQuestion = {
  id: string;
  kind: string;
  allowedAnswers: readonly string[];
};

export type InteractiveCommands = {
  status: () => void | Promise<void>;
  togglePause: () => void | Promise<void>;
  attach: () => void | Promise<void>;
  dropAgent: (agent: string) => void | Promise<void>;
  releaseHold: (holdId: string) => void | Promise<void>;
  queueGuidance: (text: string) => void | Promise<void>;
  answerQuestion: (questionId: string, answer: string) => void | Promise<void>;
  listActiveAgents: () => readonly string[];
  listActiveHolds: () => readonly { id: string; agent: string; reason: string }[];
};

export type InteractiveTerminal = {
  input: Readable & {
    isTTY?: boolean;
    setRawMode?: (mode: boolean) => void;
  };
  output: Writable;
};

export type InteractiveSession = {
  print: (line: string) => void;
  close: () => void;
};

type Mode =
  | { kind: "keys" }
  | { kind: "line"; buffer: string }
  | { kind: "drop"; agents: readonly string[] }
  | { kind: "hold"; holds: readonly { id: string; agent: string; reason: string }[] }
  | { kind: "question"; question: InteractiveOwnerQuestion };

const CHEATSHEET = [
  "Interactive hotkeys: s status | p/Space pause | a attach | d drop | r release-hold",
  "  /steer | ?/h help | q quit foreground (tmux stays up)"
].join("\n");

const clearLine = (output: Writable): void => {
  output.write("\r\x1b[2K");
};

const writePrompt = (output: Writable, text: string): void => {
  clearLine(output);
  output.write(text);
};

/**
 * Start a TTY-gated interactive session, or return null when stdin is not a TTY.
 * Owns raw mode, prompt redraw, and teardown; mutations stay in `commands`.
 */
export const startInteractiveSession = (input: {
  input: InteractiveTerminal["input"];
  output: InteractiveTerminal["output"];
  commands: InteractiveCommands;
  readQuestion: () => InteractiveOwnerQuestion | null;
  signal: AbortController;
}): InteractiveSession | null => {
  const { input: stdin, output, commands, readQuestion, signal } = input;
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== "function") return null;

  let closed = false;
  let mode: Mode = { kind: "keys" };
  let busy = false;
  let lastQuestionId: string | null = null;
  const queue: Array<() => Promise<void>> = [];

  const restore = (): void => {
    try {
      stdin.setRawMode?.(false);
    } catch {
      // ignore restore failures on already-destroyed streams
    }
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    stdin.off("keypress", onKeypress);
    stdin.off("end", onEnd);
    stdin.off("error", onError);
    if (questionTimer !== null) clearInterval(questionTimer);
    restore();
    clearLine(output);
  };

  const abort = (): void => {
    close();
    if (!signal.signal.aborted) signal.abort();
  };

  const promptText = (): string => {
    if (mode.kind === "line") return `> ${mode.buffer}`;
    if (mode.kind === "drop") {
      const list = mode.agents.map((agent, index) => `[${index + 1}] ${agent}`).join(", ");
      return `Select agent to drop: ${list} (Esc cancel) > `;
    }
    if (mode.kind === "hold") {
      const list = mode.holds
        .map((hold, index) => `[${index + 1}] ${hold.agent}/${hold.reason} ${hold.id.slice(0, 8)}`)
        .join(", ");
      return `Select hold to release: ${list} (Esc cancel) > `;
    }
    if (mode.kind === "question") {
      const list = mode.question.allowedAnswers
        .map((answer, index) => `[${index + 1}] ${answer}`)
        .join(", ");
      return `[?] ${mode.question.kind}: ${list} > `;
    }
    return "";
  };

  const redraw = (): void => {
    const text = promptText();
    if (text !== "") writePrompt(output, text);
  };

  const print = (line: string): void => {
    clearLine(output);
    output.write(line.endsWith("\n") ? line : `${line}\n`);
    redraw();
  };

  const runExclusive = (task: () => Promise<void>): void => {
    queue.push(task);
    if (busy) return;
    busy = true;
    void (async () => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (next === undefined) break;
        try {
          await next();
        } catch (error) {
          print(`coord: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      busy = false;
    })();
  };

  const showQuestionIfNeeded = (): void => {
    if (mode.kind !== "keys" && mode.kind !== "question") return;
    const question = readQuestion();
    if (question === null) {
      if (mode.kind === "question") {
        mode = { kind: "keys" };
        clearLine(output);
      }
      lastQuestionId = null;
      return;
    }
    if (question.id === lastQuestionId && mode.kind === "question") return;
    lastQuestionId = question.id;
    mode = { kind: "question", question };
    print(`[?] Owner question (${question.kind}):`);
    redraw();
  };

  const onKeypress = (_: string | undefined, key: { name?: string; ctrl?: boolean; sequence?: string } | undefined): void => {
    if (closed || key === undefined) return;
    if (key.ctrl === true && key.name === "c") {
      abort();
      return;
    }
    if (mode.kind === "line") {
      if (key.name === "escape") {
        mode = { kind: "keys" };
        clearLine(output);
        return;
      }
      if (key.name === "return") {
        const line = mode.buffer.trim();
        mode = { kind: "keys" };
        clearLine(output);
        if (line.startsWith("/steer ")) {
          const text = line.slice("/steer ".length).trim();
          if (text === "") {
            print("Usage: /steer <text>");
          } else {
            runExclusive(async () => {
              await commands.queueGuidance(text);
              print(`Queued owner guidance (${text.length} chars).`);
            });
          }
        } else if (line === "/steer") {
          print("Usage: /steer <text>");
        } else if (line.startsWith("/")) {
          print(`Unknown command ${line.split(/\s+/)[0]}. Try /steer <text>.`);
        }
        return;
      }
      if (key.name === "backspace") {
        mode = { kind: "line", buffer: mode.buffer.slice(0, -1) };
        redraw();
        return;
      }
      if (key.sequence !== undefined && key.sequence.length === 1 && !key.ctrl) {
        mode = { kind: "line", buffer: mode.buffer + key.sequence };
        redraw();
      }
      return;
    }

    if (mode.kind === "drop" || mode.kind === "hold" || mode.kind === "question") {
      if (key.name === "escape") {
        mode = { kind: "keys" };
        clearLine(output);
        return;
      }
      const digit = key.name !== undefined && /^[1-9]$/.test(key.name) ? Number(key.name) : NaN;
      if (Number.isNaN(digit)) return;
      if (mode.kind === "drop") {
        const agent = mode.agents[digit - 1];
        mode = { kind: "keys" };
        clearLine(output);
        if (agent === undefined) {
          print("Invalid drop selection.");
          return;
        }
        runExclusive(async () => {
          await commands.dropAgent(agent);
          print(`Dropped ${agent}.`);
        });
        return;
      }
      if (mode.kind === "hold") {
        const hold = mode.holds[digit - 1];
        mode = { kind: "keys" };
        clearLine(output);
        if (hold === undefined) {
          print("Invalid hold selection.");
          return;
        }
        runExclusive(async () => {
          await commands.releaseHold(hold.id);
          print(`Released hold ${hold.id}.`);
        });
        return;
      }
      const answer = mode.question.allowedAnswers[digit - 1];
      const questionId = mode.question.id;
      mode = { kind: "keys" };
      clearLine(output);
      if (answer === undefined) {
        print("Invalid answer selection.");
        return;
      }
      runExclusive(async () => {
        await commands.answerQuestion(questionId, answer);
        print(`Owner answer ${answer} applied.`);
      });
      return;
    }

    // Quick-control mode: ignore multi-character pastes that would chain hotkeys.
    if (key.sequence !== undefined && key.sequence.length > 1 && key.name === undefined) return;

    if (key.sequence === "/" || key.name === "/") {
      mode = { kind: "line", buffer: "/" };
      redraw();
      return;
    }
    if (key.name === "s") {
      runExclusive(async () => {
        await commands.status();
      });
      return;
    }
    if (key.name === "p" || key.name === "space") {
      runExclusive(async () => {
        await commands.togglePause();
      });
      return;
    }
    if (key.name === "a") {
      runExclusive(async () => {
        await commands.attach();
      });
      return;
    }
    if (key.name === "d") {
      const agents = commands.listActiveAgents();
      if (agents.length === 0) {
        print("No active agents to drop.");
        return;
      }
      mode = { kind: "drop", agents };
      redraw();
      return;
    }
    if (key.name === "r") {
      const holds = commands.listActiveHolds();
      if (holds.length === 0) {
        print("No active holds.");
        return;
      }
      mode = { kind: "hold", holds };
      redraw();
      return;
    }
    if (key.name === "q") {
      abort();
      return;
    }
    if (key.sequence === "?" || key.name === "h") {
      print(CHEATSHEET);
    }
  };

  const onEnd = (): void => {
    abort();
  };
  const onError = (): void => {
    abort();
  };

  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.on("keypress", onKeypress);
  stdin.on("end", onEnd);
  stdin.on("error", onError);

  const questionTimer = setInterval(() => {
    if (!closed) showQuestionIfNeeded();
  }, 1000);

  print(CHEATSHEET);
  showQuestionIfNeeded();

  return { print, close };
};
