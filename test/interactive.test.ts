import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startInteractiveSession, type InteractiveSession, type OwnerQuestion, type TerminalInput, type TerminalOutput } from "../src/interactive.js";

const sessions: InteractiveSession[] = [];
afterEach(() => { for (const session of sessions.splice(0)) session.close(); vi.useRealTimers(); });

const fixture = (tty = true, holds: { id: string; agent: string; reason: string }[] = [{ id: "hold-1", agent: "codex", reason: "unobservable" }]) => {
  const input: TerminalInput = new PassThrough();
  const output: TerminalOutput = new PassThrough();
  input.isTTY = tty; output.isTTY = tty; input.isRaw = false;
  input.setRawMode = vi.fn((raw: boolean) => { input.isRaw = raw; });
  let printed = "";
  output.on("data", (chunk) => { printed += String(chunk); });
  let question: OwnerQuestion | null = null;
  const commands = { status: vi.fn(() => "status snapshot"), togglePause: vi.fn(() => "pause toggled"), attach: vi.fn(async () => {}),
    agents: () => ["claude", "codex"], drop: vi.fn(), holds: () => holds,
    releaseHold: vi.fn(), remindable: vi.fn(() => ["codex"]), remind: vi.fn(() => "Reminder requested for codex."),
    steer: vi.fn(), answer: vi.fn() };
  const controller = new AbortController();
  const stop = vi.fn(() => controller.abort());
  const session = startInteractiveSession({ input, output, commands, readQuestion: () => question, signal: controller.signal, stop });
  if (session) sessions.push(session);
  const send = async (text: string) => { input.emit("data", text); await session?.settled(); };
  return { input, output, commands, controller, stop, session, send, printed: () => printed,
    question: (value: OwnerQuestion | null) => { question = value; session?.print("workflow log"); } };
};

describe("foreground owner terminal", () => {
  it("does not touch input in non-TTY mode", () => {
    const f = fixture(false);
    expect(f.session).toBeNull();
    expect(f.input.setRawMode).not.toHaveBeenCalled();
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.printed()).toBe("");
  });

  it("routes controls, keeps editing across logs and ignores pasted destructive hotkeys", async () => {
    const f = fixture();
    for (const key of ["s", "p", " ", "a", "?", "h"]) await f.send(key);
    expect(f.commands.status).toHaveBeenCalledOnce();
    expect(f.commands.togglePause).toHaveBeenCalledTimes(2);
    expect(f.commands.attach).toHaveBeenCalledOnce();
    await f.send("dqyp");
    await f.send("\x1b[200~dqyp\x1b[201~");
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.commands.drop).not.toHaveBeenCalled();
    await f.send("/");
    await f.send("steer keep helperx");
    f.session!.print("tick completed\n");
    expect(f.printed()).toContain("tick completed\n\r\x1b[2K/steer keep helperx");
    await f.send("\x7f"); await f.send("\r");
    expect(f.commands.steer).toHaveBeenCalledWith("keep helper");
    await f.send("d"); await f.send("2\ny");
    expect(f.commands.drop).not.toHaveBeenCalled();
    await f.send("2"); await f.send("\r");
    expect(f.commands.drop).not.toHaveBeenCalled();
    await f.send("y");
    expect(f.commands.drop).toHaveBeenCalledWith("codex");
    await f.send("r"); await f.send("1"); await f.send("\r");
    expect(f.commands.releaseHold).toHaveBeenCalledWith("hold-1", false);
  });

  it("answers Return, unknown keys and pasted hotkeys visibly without running anything", async () => {
    const f = fixture();
    await f.send("\r");
    expect(f.printed()).toContain("coord [? help] > \n\r\x1b[2Kcoord [? help] > ");
    await f.send("x");
    expect(f.printed()).toContain("Unknown command 'x'.");
    expect(f.printed()).toContain("Remind an agent to finish its current action");
    await f.send("sdq");
    expect(f.printed()).toContain("Ignored pasted text 'sdq'; nothing was run.");
    await f.send("?");
    expect(f.printed()).toContain("a turn is one prompt-and-reply cycle");
    for (const command of [f.commands.status, f.commands.drop, f.commands.remind, f.commands.releaseHold]) {
      expect(command).not.toHaveBeenCalled();
    }
    expect(f.stop).not.toHaveBeenCalled();
  });

  it("queues a reminder for a selected agent with an unfinished action", async () => {
    const f = fixture();
    await f.send("n");
    expect(f.printed()).toContain("[1] Remind codex to finish its current action");
    await f.send("1"); await f.send("\r");
    expect(f.commands.remind).toHaveBeenCalledWith("codex");
    expect(f.printed()).toContain("Reminder requested for codex.");
    f.commands.remindable.mockReturnValue([]);
    await f.send("n");
    expect(f.printed()).toContain("No agent has an unfinished action");
    expect(f.commands.remind).toHaveBeenCalledOnce();
  });

  it("resets a reminder-limit allowance only after a separate confirmation", async () => {
    const f = fixture(true, [{ id: "hold-2", agent: "codex", reason: "nudge-loop" }]);
    await f.send("r"); await f.send("1"); await f.send("\r");
    expect(f.printed()).toContain("codex: reminder limit reached — release it and allow 4 more sends? [y/N]");
    await f.send("n");
    expect(f.commands.releaseHold).not.toHaveBeenCalled();
    await f.send("r"); await f.send("1"); await f.send("\r"); await f.send("y");
    expect(f.commands.releaseHold).toHaveBeenCalledWith("hold-2", true);
  });

  it("uses only allowed answers and captured question IDs, with explicit abandon confirmation", async () => {
    const f = fixture();
    const question = { id: "old", kind: "no-consensus", round: 2, allowedAnswers: ["retry", "abandon"] as const };
    f.question(question);
    expect(f.printed()).toContain("[1] retry\n  [2] abandon");
    await f.send("2"); await f.send("\r");
    expect(f.commands.answer).not.toHaveBeenCalled();
    // An external owner replaces the question during confirmation. The callback
    // must keep the old ID so the locked owner operation rejects it as stale.
    f.question({ ...question, id: "new" });
    f.commands.answer.mockImplementation((id: string) => { if (id === "old") throw new Error("stale question"); });
    await f.send("y");
    expect(f.commands.answer).toHaveBeenCalledWith("old", "abandon");
    expect(f.printed()).toContain("stale question");
    await f.send("1"); await f.send("\r");
    expect(f.commands.answer).toHaveBeenLastCalledWith("new", "retry");
  });

  it("cancels edits on Escape and treats bracketed paste as text, never commands", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.send("/"); await f.send("steer ");
    await f.send("\x1b[200~one\ntwo\x1b[201~");
    expect(f.commands.steer).not.toHaveBeenCalled();
    await f.send("\r");
    expect(f.commands.steer).toHaveBeenCalledWith("one two");
    await f.send("/"); await f.send("steer plain\nq");
    expect(f.commands.steer).toHaveBeenCalledTimes(1);
    expect(f.stop).not.toHaveBeenCalled();
    await f.send("\r");
    expect(f.commands.steer).toHaveBeenLastCalledWith("plain q");
    await f.send("/"); await f.send("steer discard"); await f.send("\x1b");
    await vi.advanceTimersByTimeAsync(40);
    await f.send("s");
    expect(f.commands.status).toHaveBeenCalledOnce();
    expect(f.commands.steer).toHaveBeenCalledTimes(2);
  });

  it.each(["q", "\x03", "\x04", "end", "error", "abort", "SIGTERM"])("restores terminal and removes its listeners on %j", async (reason) => {
    const before = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    const f = fixture();
    expect(f.input.isRaw).toBe(true);
    if (reason === "abort") f.controller.abort();
    else if (reason === "end" || reason === "error") f.input.emit(reason);
    else if (reason === "SIGTERM") process.emit("SIGTERM");
    else await f.send(reason);
    expect(f.input.isRaw).toBe(false);
    expect(f.input.isPaused()).toBe(true);
    expect(f.input.listenerCount("data")).toBe(0);
    expect(f.input.listenerCount("end")).toBe(0);
    expect(f.input.listenerCount("error")).toBe(0);
    expect([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")]).toEqual(before);
    expect(f.printed()).toContain("\x1b[?2004l");
    expect(f.stop).toHaveBeenCalledTimes(reason === "abort" ? 0 : 1);
    f.session!.close();
    expect(f.input.setRawMode).toHaveBeenCalledTimes(2);
  });
});
