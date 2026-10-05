import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startInteractiveSession, type InteractiveCommands } from "../src/interactive.js";

class FakeTty extends PassThrough {
  isTTY = true;
  raw = false;
  setRawMode(mode: boolean): void {
    this.raw = mode;
  }
}

const flush = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe("interactive session", () => {
  const controllers: AbortController[] = [];
  afterEach(() => {
    for (const controller of controllers.splice(0)) {
      if (!controller.signal.aborted) controller.abort();
    }
  });

  const stubCommands = (overrides: Partial<InteractiveCommands> = {}): InteractiveCommands & {
    calls: string[];
  } => {
    const calls: string[] = [];
    return {
      calls,
      status: () => {
        calls.push("status");
      },
      togglePause: () => {
        calls.push("pause");
      },
      attach: () => {
        calls.push("attach");
      },
      dropAgent: (agent) => {
        calls.push(`drop:${agent}`);
      },
      releaseHold: (id) => {
        calls.push(`hold:${id}`);
      },
      queueGuidance: (text) => {
        calls.push(`steer:${text}`);
      },
      answerQuestion: (id, answer) => {
        calls.push(`answer:${id}:${answer}`);
      },
      listActiveAgents: () => ["claude", "codex", "cursor"],
      listActiveHolds: () => [],
      ...overrides
    };
  };

  const emitKey = (input: FakeTty, name: string, sequence = name, ctrl = false): void => {
    (input as unknown as EventEmitter).emit("keypress", sequence, { name, sequence, ctrl });
  };

  it("returns null for non-TTY input without enabling raw mode", () => {
    const input = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
    input.isTTY = false;
    const setRawMode = vi.fn();
    input.setRawMode = setRawMode;
    const controller = new AbortController();
    controllers.push(controller);
    expect(
      startInteractiveSession({
        input,
        output: new PassThrough(),
        commands: stubCommands(),
        readQuestion: () => null,
        signal: controller
      })
    ).toBeNull();
    expect(setRawMode).not.toHaveBeenCalled();
  });

  it("dispatches hotkeys, drop selection, steer, and quit with raw-mode restore", async () => {
    const input = new FakeTty();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    const commands = stubCommands();
    const controller = new AbortController();
    controllers.push(controller);
    const session = startInteractiveSession({
      input,
      output,
      commands,
      readQuestion: () => null,
      signal: controller
    });
    expect(session).not.toBeNull();
    expect(input.raw).toBe(true);

    emitKey(input, "s");
    emitKey(input, "p");
    emitKey(input, "space", " ");
    emitKey(input, "a");
    emitKey(input, "h");
    await flush();
    expect(commands.calls).toEqual(["status", "pause", "pause", "attach"]);

    emitKey(input, "d");
    emitKey(input, "2");
    await flush();
    expect(commands.calls).toContain("drop:codex");

    emitKey(input, "/", "/");
    for (const ch of "steer keep Go 1.22") {
      emitKey(input, ch, ch);
    }
    emitKey(input, "return", "\r");
    await flush();
    expect(commands.calls).toContain("steer:keep Go 1.22");

    emitKey(input, "q");
    await flush();
    expect(controller.signal.aborted).toBe(true);
    expect(input.raw).toBe(false);
  });

  it("answers a pending owner question by displayed id and prints stale errors", async () => {
    const input = new FakeTty();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk) => {
      out += String(chunk);
    });
    const questionId = "10000000-0000-4000-8000-000000000001";
    const commands = stubCommands({
      answerQuestion: () => {
        throw new Error(`Owner question ${questionId} is stale or unknown.`);
      }
    });
    const controller = new AbortController();
    controllers.push(controller);
    startInteractiveSession({
      input,
      output,
      commands,
      readQuestion: () => ({
        id: questionId,
        kind: "ballot-escalation",
        allowedAnswers: ["retry", "revise", "abandon"]
      }),
      signal: controller
    });
    await flush();
    emitKey(input, "1");
    await flush();
    expect(out).toContain("stale or unknown");
    expect(input.raw).toBe(true);
    emitKey(input, "q");
    await flush();
    expect(input.raw).toBe(false);
  });

  it("redraws a partial line after print()", async () => {
    const input = new FakeTty();
    const output = new PassThrough();
    let out = "";
    output.on("data", (chunk) => {
      out += String(chunk);
    });
    const controller = new AbortController();
    controllers.push(controller);
    const session = startInteractiveSession({
      input,
      output,
      commands: stubCommands(),
      readQuestion: () => null,
      signal: controller
    });
    emitKey(input, "/", "/");
    for (const ch of "steer hi") emitKey(input, ch, ch);
    session!.print("phase log");
    expect(out).toContain("phase log");
    expect(out).toContain("> /steer hi");
    emitKey(input, "q");
    await flush();
  });
});
