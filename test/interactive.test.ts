import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  startInteractiveSession,
  type InteractiveCommands,
  type InteractiveInput,
  type OwnerQuestionView
} from "../src/interactive.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  rawModes: boolean[] = [];
  paused = false;
  setRawMode(mode: boolean): void {
    this.rawModes.push(mode);
  }
  resume(): void {
    this.paused = false;
  }
  pause(): void {
    this.paused = true;
  }
  type(...chunks: string[]): void {
    for (const chunk of chunks) this.emit("data", Buffer.from(chunk, "utf8"));
  }
}

const harness = (overrides: Partial<InteractiveCommands> = {}, ttys = { input: true, output: true }) => {
  const input = new FakeInput();
  input.isTTY = ttys.input;
  const written: string[] = [];
  const calls: string[] = [];
  const signals = new EventEmitter();
  let question: OwnerQuestionView | null = null;
  const commands: InteractiveCommands = {
    status: () => "Issue 1: R2.plan",
    togglePause: () => "Manual pause on.",
    attach: async () => "Opened 2 Terminal window(s).",
    activeAgents: () => ["claude", "codex"],
    drop: (agent) => {
      calls.push(`drop ${agent}`);
      return `Dropped ${agent}.`;
    },
    holds: () => [],
    releaseHold: (id) => `Released ${id}.`,
    steer: (text) => {
      calls.push(`steer ${text}`);
      return "Queued.";
    },
    question: () => question,
    answer: (id, answer) => {
      calls.push(`answer ${id} ${answer}`);
      return `Owner answer ${answer} applied.`;
    },
    stop: () => calls.push("stop"),
    ...overrides
  };
  const session = startInteractiveSession({
    input: input as unknown as InteractiveInput,
    output: { isTTY: ttys.output, write: (chunk) => written.push(chunk) },
    commands,
    signals,
    pollMs: 60_000
  });
  return {
    input,
    session,
    calls,
    signals,
    text: () => written.join(""),
    setQuestion: (next: OwnerQuestionView | null) => {
      question = next;
    }
  };
};

const QUESTION: OwnerQuestionView = {
  id: "40000000-0000-4000-8000-000000000001",
  kind: "ballot-escalation",
  round: 2,
  allowedAnswers: ["retry", "revise", "abandon"]
};

describe("interactive coordinator session", () => {
  it.each([
    { input: false, output: true },
    { input: true, output: false }
  ])("stays off unless both ends are terminals (%o)", (ttys) => {
    const h = harness({}, ttys);
    expect(h.session).toBeNull();
    expect(h.input.rawModes).toEqual([]);
    expect(h.input.listenerCount("data")).toBe(0);
  });

  it("maps quick keys to owner commands and ignores a pasted burst", () => {
    const h = harness();
    h.input.type("s", "p", " ", "?");
    expect(h.text()).toContain("Issue 1: R2.plan");
    expect(h.text().match(/Manual pause on\./g)).toHaveLength(2);
    expect(h.text()).toContain("/steer <text>");
    h.input.type("pdq");
    expect(h.calls).toEqual([]);
    h.session?.close();
  });

  it("drops an agent only after a numbered choice and confirmation", () => {
    const h = harness();
    h.input.type("d", "2", "n");
    expect(h.calls).toEqual([]);
    h.input.type("d", "\u001b");
    expect(h.calls).toEqual([]);
    h.input.type("d", "2", "y");
    expect(h.calls).toEqual(["drop codex"]);
    h.session?.close();
  });

  it("queues /steer text and keeps a half-typed line intact across runner logs", () => {
    const h = harness();
    h.input.type("/", "steer keep Go");
    h.session?.print("Issue 1: R3.review");
    expect(h.text().endsWith("\r\u001b[2KIssue 1: R3.review\n> /steer keep Go")).toBe(true);
    h.input.type(" 1.22", "\r");
    expect(h.calls).toEqual(["steer keep Go 1.22"]);
    h.input.type("/", "steer", "\r", "/", "bogus x", "\r");
    expect(h.text()).toContain("Usage: /steer <text>");
    expect(h.text()).toContain("Unknown command. Use /steer <text>.");
    expect(h.calls).toHaveLength(1);
    h.session?.close();
  });

  it("answers the displayed owner question and refuses one replaced elsewhere", () => {
    const h = harness();
    h.setQuestion(QUESTION);
    h.session?.print("Owner action required: consensus ballot round 2 requested escalation.");
    expect(h.text()).toContain("[?] Ballot split in round 2:\n    [1] Retry ballot\n    [2] Move to next revision round\n    [3] Abandon");
    h.input.type("1");
    expect(h.calls).toEqual([`answer ${QUESTION.id} retry`]);

    const replaced = { ...QUESTION, id: "40000000-0000-4000-8000-000000000002" };
    h.setQuestion(replaced);
    h.session?.print("Owner action required again.");
    h.setQuestion({ ...QUESTION, id: "40000000-0000-4000-8000-000000000003" });
    h.input.type("2");
    expect(h.calls).toHaveLength(1);
    expect(h.text()).toContain("resolved elsewhere; nothing was applied");
    h.session?.close();
  });

  it("shows a command error instead of throwing", () => {
    const h = harness({ togglePause: () => { throw new Error("state lock timed out"); } });
    h.input.type("p");
    expect(h.text()).toContain("coord: state lock timed out");
    h.session?.close();
  });

  it.each([
    ["q", (h: ReturnType<typeof harness>) => h.input.type("q")],
    ["Ctrl-C", (h: ReturnType<typeof harness>) => h.input.type("\u0003")],
    ["EOF", (h: ReturnType<typeof harness>) => h.input.emit("end")],
    ["input error", (h: ReturnType<typeof harness>) => {
      if (h.input.listenerCount("error") > 0) h.input.emit("error", new Error("EIO"));
    }],
    ["SIGTERM", (h: ReturnType<typeof harness>) => h.signals.emit("SIGTERM")]
  ])("stops once and restores the terminal on %s", (_name, trigger) => {
    const h = harness();
    trigger(h);
    trigger(h);
    expect(h.calls).toEqual(["stop"]);
    expect(h.input.rawModes).toEqual([true, false]);
    expect(h.input.paused).toBe(true);
    expect(h.input.listenerCount("data")).toBe(0);
    expect(h.signals.listenerCount("SIGINT")).toBe(0);
    h.session?.close();
    expect(h.input.rawModes).toEqual([true, false]);
  });
});
