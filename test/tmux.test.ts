import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessLooksReady,
  harnessPromptReady,
  nudgePreludeKeys,
  ownerTerminalCloseAppleScript,
  ownerTerminalOpenAppleScript,
  ownerTerminalTitlesToClose,
  resolveAgentLauncher,
  resolveNudgeKeys,
  TmuxController,
  vimInsertPrelude,
  type TmuxResult,
  type TmuxRunner
} from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });
const noopSleep = async (): Promise<void> => undefined;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const promptFor = (agentId: string): string => {
  switch (agentId) {
    case "claude":
      return "❯ \nauto mode on\n";
    case "cursor":
      return "→ Add a follow-up\nAuto · 1%\nRun Everything\n";
    case "antigravity":
      return "Antigravity CLI\n> \n? for shortcuts accept-edits · Gemini\n";
    case "codex":
      return "codex ready\n";
    default:
      return "ready\n";
  }
};

const runnerWithPrompt = (
  calls: Array<{ args: readonly string[] }>,
  display = "0\tagent\t0\n",
  prompt = promptFor("cursor")
): TmuxRunner => {
  return async (args) => {
    calls.push({ args });
    if (args[0] === "display-message") return ok(display);
    if (args[0] === "capture-pane") return ok(prompt);
    return ok();
  };
};

describe("tmux boundary", () => {
  it("keeps flat session names stable and namespaces nested workspaces", () => {
    const runner: TmuxRunner = async () => ok();
    expect(new TmuxController(runner).sessionName(42)).toBe("coord-42");
    expect(new TmuxController(runner, "a1b2c3").sessionName(42)).toBe("coord-42-a1b2c3");
  });

  it("types the nudge with send-keys -l and Escape+Enter for Cursor", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(runnerWithPrompt(calls), null, null, null, noopSleep);
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toBe("sent");
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "send-keys",
      "send-keys",
      "send-keys",
      "send-keys"
    ]);
    expect(calls[2]?.args.slice(-1)).toEqual(["a"]);
    expect(calls[3]?.args).toEqual(["send-keys", "-l", "-t", "coord-1:cursor.0", expect.stringContaining("/runtime/action.md")]);
    expect(calls[4]?.args.slice(-1)).toEqual(["Escape"]);
    expect(calls[5]?.args.slice(-1)).toEqual(["Enter"]);
  });

  it("uses per-agent nudgePrelude and nudgeSubmit for Codex vim", async () => {
    expect(nudgePreludeKeys("claude")).toEqual([]);
    expect(nudgePreludeKeys("codex")).toEqual(["i"]);
    expect(nudgePreludeKeys("antigravity")).toEqual([]);
    expect(vimInsertPrelude("❯\n-- NORMAL --", "claude")).toEqual(["a"]);
    expect(vimInsertPrelude("❯\n-- INSERT --", "claude")).toEqual([]);
    expect(vimInsertPrelude("❯\n-- VISUAL --", "claude")).toEqual(["Escape", "a"]);
    expect(vimInsertPrelude("❯ auto mode", "claude")).toEqual(["a"]);
    expect(vimInsertPrelude("Add a follow-up", "cursor")).toEqual(["a"]);
    expect(vimInsertPrelude(">", "antigravity")).toEqual([]);
    expect(vimInsertPrelude("Vim: Normal", "codex")).toEqual([]);
    expect(resolveNudgeKeys({ id: "claude", root: "/c", launcher: "x", delivery: "both" }, "❯").prelude).toEqual([
      "a"
    ]);
    expect(
      resolveNudgeKeys({ id: "claude", root: "/c", launcher: "x", delivery: "both" }, "❯\n-- INSERT --").prelude
    ).toEqual([]);
    expect(resolveNudgeKeys({ id: "antigravity", root: "/a", launcher: "x", delivery: "both" }, ">").prelude).toEqual(
      []
    );
    expect(resolveNudgeKeys({ id: "claude", root: "/c", launcher: "x", delivery: "both" }).submit).toEqual([
      "Escape",
      "Enter"
    ]);
    expect(resolveNudgeKeys({ id: "claude", root: "/c", launcher: "x", delivery: "both", nudgeSubmit: ["C-m"] }).submit).toEqual([
      "Escape",
      "Enter"
    ]);
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tcodex\t0\n", promptFor("codex")),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        {
          id: "codex",
          root: "/clone",
          launcher: "start-codex.sh",
          delivery: "both",
          harnessProcess: "codex",
          nudgePrelude: ["i"],
          nudgeSubmit: ["C-j", "C-m"],
          terminalProfile: "Grass"
        },
        "/runtime/action.md"
      )
    ).toBe("sent");
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "send-keys",
      "send-keys",
      "send-keys",
      "send-keys"
    ]);
    expect(calls[2]?.args.slice(-1)).toEqual(["i"]);
    expect(calls[3]?.args[1]).toBe("-l");
    expect(calls[4]?.args.slice(-1)).toEqual(["C-j"]);
    expect(calls[5]?.args.slice(-1)).toEqual(["C-m"]);
  });

  it("honors explicit empty prelude over Codex defaults", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tcodex\t0\n", promptFor("codex")),
      null,
      null,
      null,
      noopSleep
    );
    await controller.nudge(
      1,
      {
        id: "codex",
        root: "/clone",
        launcher: "start-codex.sh",
        delivery: "both",
        nudgePrelude: [],
        nudgeSubmit: ["C-j", "C-m"]
      },
      "/a"
    );
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "send-keys",
      "send-keys",
      "send-keys"
    ]);
    expect(calls[2]?.args[1]).toBe("-l");
    expect(calls[3]?.args.slice(-1)).toEqual(["C-j"]);
    expect(calls[4]?.args.slice(-1)).toEqual(["C-m"]);
  });

  it("builds one attach command per agent window with terminal profiles", () => {
    const controller = new TmuxController(async () => ok(), null, async () => undefined);
    expect(controller.agentAttachLaunches(7, [
      { id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both", terminalProfile: "Pro" },
      { id: "codex", root: "/x", launcher: "start-codex.sh", delivery: "both", terminalProfile: "Grass" }
    ])).toEqual([
      {
        agentId: "claude",
        command:
          "tmux new-session -A -s coord-7-claude -t coord-7 ';' select-window -t claude ';' set-option destroy-unattached on",
        terminalProfile: "Pro",
        windowTitle: "coord-7/claude"
      },
      {
        agentId: "codex",
        command:
          "tmux new-session -A -s coord-7-codex -t coord-7 ';' select-window -t codex ';' set-option destroy-unattached on",
        terminalProfile: "Grass",
        windowTitle: "coord-7/codex"
      }
    ]);
  });

  it("opens owner terminals through the injected opener", async () => {
    const launched: string[] = [];
    const controller = new TmuxController(async () => ok(), null, async (launches) => {
      for (const launch of launches) launched.push(launch.agentId);
    });
    await expect(
      controller.openOwnerAgentClients(1, [
        { id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both" },
        { id: "cursor", root: "/u", launcher: "start-cursor.sh", delivery: "both" }
      ])
    ).resolves.toEqual({ status: "opened", count: 2 });
    expect(launched).toEqual(["claude", "cursor"]);
  });

  it("returns unsupported when no opener is configured", async () => {
    const controller = new TmuxController(async () => ok(), null, null);
    const result = await controller.openOwnerAgentClients(1, [
      { id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both" }
    ]);
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") {
      expect(result.commands[0]).toContain("select-window -t claude");
      expect(result.commands[0]).toContain("coord-1-claude");
    }
  });

  it("lists and kills primary plus linked issue sessions", async () => {
    const calls: string[][] = [];
    const runner: TmuxRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "list-sessions") {
        return ok("coord-3\ncoord-3-claude\ncoord-3-codex\ncoord-9\n");
      }
      return ok();
    };
    const controller = new TmuxController(runner, null, null, null);
    expect(await controller.listIssueSessions(3)).toEqual(["coord-3", "coord-3-claude", "coord-3-codex"]);
    expect(await controller.killIssueSessions(3)).toEqual(["coord-3", "coord-3-claude", "coord-3-codex"]);
    expect(calls.filter((args) => args[0] === "kill-session").map((args) => args[2])).toEqual([
      "coord-3",
      "coord-3-claude",
      "coord-3-codex"
    ]);
  });

  it("closes owner Terminal windows by issue title via injected closer", () => {
    const closed: string[] = [];
    const controller = new TmuxController(async () => ok(), null, null, (titles) => {
      closed.push(...titles);
    });
    expect(controller.closeOwnerAgentClients(4, ["claude", "cursor"])).toEqual({
      status: "closed",
      titles: ["coord-4/claude", "coord-4/cursor"]
    });
    expect(closed).toEqual(["coord-4/claude", "coord-4/cursor"]);
  });

  it("closeOwnerAgentClients uses the unique group ids when titleGroup is set", () => {
    const closed: string[] = [];
    const controller = new TmuxController(
      async () => ok(),
      null,
      null,
      (titles) => {
        closed.push(...titles);
      },
      async () => undefined,
      "abc12def00"
    );
    expect(controller.closeOwnerAgentClients(4, ["claude", "cursor"])).toEqual({
      status: "closed",
      titles: ["coord-4-abc12def00/claude", "coord-4-abc12def00/cursor"]
    });
    expect(closed).toEqual(["coord-4-abc12def00/claude", "coord-4-abc12def00/cursor"]);
  });

  it("scopes Terminal titles with workspace group id and closes only those exact ids", () => {
    expect(ownerTerminalTitlesToClose(1, ["claude", "antigravity"], "abc12def00")).toEqual([
      "coord-1-abc12def00/claude",
      "coord-1-abc12def00/antigravity"
    ]);
    // Ungrouped / bare names must never be in the close list when a group is set.
    expect(ownerTerminalTitlesToClose(1, ["claude"], "abc12def00")).not.toContain("coord-1/claude");
    expect(ownerTerminalTitlesToClose(1, ["claude"], "abc12def00")).not.toContain("claude");
    const nested = new TmuxController(async () => ok(), "abc12def00", async () => undefined);
    expect(nested.agentAttachLaunches(7, [
      { id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both", terminalProfile: "Pro" }
    ])[0]?.windowTitle).toBe("coord-7-abc12def00/claude");
    const flatGrouped = new TmuxController(
      async () => ok(),
      null,
      async () => undefined,
      null,
      async () => undefined,
      "flatgroup01"
    );
    expect(flatGrouped.sessionName(1)).toBe("coord-1");
    expect(flatGrouped.agentAttachLaunches(1, [
      { id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both", terminalProfile: "Pro" }
    ])[0]?.windowTitle).toBe("coord-1-flatgroup01/claude");
    expect(flatGrouped.ownerTerminalTitles(1, ["claude", "cursor"])).toEqual([
      "coord-1-flatgroup01/claude",
      "coord-1-flatgroup01/cursor"
    ]);
  });

  it("builds Terminal open AppleScript that titles the new tab with the unique id", () => {
    const script = ownerTerminalOpenAppleScript({
      agentId: "claude",
      command: "tmux new-session -A -s coord-1-claude -t coord-1",
      terminalProfile: "Pro",
      windowTitle: "coord-1-abc12def00/claude"
    });
    expect(script).toContain('set newTab to do script "tmux new-session -A -s coord-1-claude -t coord-1"');
    expect(script).toContain('set custom title of newTab to "coord-1-abc12def00/claude"');
    expect(script).not.toContain("make new window");
    expect(script).not.toContain("front window");
    expect(script).not.toContain("window of newTab");
  });

  it("builds Terminal close AppleScript that closes matching windows by id", () => {
    const titles = ownerTerminalTitlesToClose(1, ["claude", "cursor"], "abc12def00");
    const script = ownerTerminalCloseAppleScript(titles);
    expect(script).toContain('set wanted to {"coord-1-abc12def00/claude", "coord-1-abc12def00/cursor"}');
    expect(script).toContain("set t to custom title of tb as text");
    expect(script).toContain("if wname contains (titleText as text) then set shouldClose to true");
    expect(script).toContain("set end of windowIds to wid");
    expect(script).toContain("close (first window whose id is wid)");
    expect(script).not.toContain("close tb");
    expect(script).not.toContain('"claude"');
    expect(script).not.toContain("coord-1/claude");
    expect(script).not.toContain("front window");
  });

  it("treats pull-only agents as nudge-disabled", async () => {
    let called = false;
    const controller = new TmuxController(async () => {
      called = true;
      return ok();
    });
    expect(await controller.nudge(1, { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "pull" }, "/a")).toBe(
      "disabled"
    );
    expect(called).toBe(false);
  });

  it("accepts Claude version strings and Cursor/Antigravity node as ready harnesses", () => {
    expect(harnessLooksReady("2.1.228", "claude")).toBe(true);
    expect(harnessLooksReady("claude", "claude")).toBe(true);
    expect(harnessLooksReady("node", "claude")).toBe(false);
    expect(harnessLooksReady("node", "agent")).toBe(true);
    expect(harnessLooksReady("agent", "agent")).toBe(true);
    expect(harnessLooksReady("node", "agy")).toBe(true);
    expect(harnessLooksReady("antigravity", "agy")).toBe(true);
    expect(harnessLooksReady("agy", "agy")).toBe(true);
  });

  it("defers nudge until the TUI shows an idle prompt", () => {
    expect(harnessPromptReady("❯ \nauto mode on", "claude")).toBe(true);
    expect(harnessPromptReady("Do you trust this folder?\n❯ 1. Yes", "claude")).toBe(false);
    expect(harnessPromptReady("❯\n-- NORMAL --", "claude")).toBe(true);
    expect(harnessPromptReady("Antigravity CLI\nnvm use…", "antigravity")).toBe(false);
    expect(harnessPromptReady("Antigravity CLI\n> \n? for shortcuts · Gemini", "antigravity")).toBe(true);
    expect(
      harnessPromptReady(
        "Antigravity CLI\n> \nGenerating...\nesc to cancel · Gemini",
        "antigravity"
      )
    ).toBe(false);
    expect(
      harnessPromptReady("Antigravity CLI\n> \nWorking...\nesc to cancel · Gemini", "antigravity")
    ).toBe(false);
    expect(
      harnessPromptReady("Antigravity CLI\n> \nRunning...\nesc to cancel · Gemini", "antigravity")
    ).toBe(false);
    expect(
      harnessPromptReady(
        "⚠ Verifying your account...\nWe're finishing verifying your account eligibility.\nThis usually takes a moment. Please try again shortly.\n> Accept-edits mode: file edits auto-approved",
        "antigravity"
      )
    ).toBe(false);
    expect(resolveNudgeKeys({ id: "antigravity", root: "/a", launcher: "x", delivery: "both" }).submit).toEqual([
      "Enter"
    ]);
    expect(
      resolveNudgeKeys({
        id: "antigravity",
        root: "/a",
        launcher: "x",
        delivery: "both",
        nudgeSubmit: ["Escape", "Enter"]
      }).submit
    ).toEqual(["Enter"]);
    expect(
      resolveNudgeKeys({
        id: "antigravity",
        root: "/a",
        launcher: "x",
        delivery: "both",
        nudgeSubmit: ["C-m"]
      }).submit
    ).toEqual(["Enter"]);
    expect(harnessPromptReady("Add a follow-up\nAuto ·\nRun Everything", "cursor")).toBe(true);
  });

  it("submits Antigravity nudges with Enter only", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tagy\t0\n", promptFor("antigravity")),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        {
          id: "antigravity",
          root: "/clone",
          launcher: "start-antigravity.sh",
          delivery: "both",
          harnessProcess: "agy",
          nudgeSubmit: ["Escape", "Enter"]
        },
        "/runtime/action.md"
      )
    ).toBe("sent");
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "send-keys",
      "send-keys"
    ]);
    expect(calls[2]?.args).toEqual([
      "send-keys",
      "-l",
      "-t",
      "coord-1:antigravity.0",
      expect.stringContaining("/runtime/action.md")
    ]);
    expect(calls[3]?.args.slice(-1)).toEqual(["Enter"]);
  });

  it("returns busy when Antigravity process is up but splash has no prompt yet", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tagy\t0\n", "Antigravity CLI\nnvm…\n"),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        { id: "antigravity", root: "/clone", launcher: "start-antigravity.sh", delivery: "both", harnessProcess: "agy" },
        "/runtime/action.md"
      )
    ).toBe("busy");
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "capture-pane"]);
  });

  it("returns busy while Antigravity is verifying the account", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(
        calls,
        "0\tagy\t0\n",
        "⚠ Verifying your account...\nWe're finishing verifying your account eligibility.\nPlease try again shortly.\n> Accept-edits mode: file edits auto-approved\n"
      ),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        { id: "antigravity", root: "/clone", launcher: "start-antigravity.sh", delivery: "both", harnessProcess: "agy" },
        "/runtime/action.md"
      )
    ).toBe("busy");
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "capture-pane"]);
  });

  it("returns busy while Antigravity shows esc to cancel", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(
        calls,
        "0\tagy\t0\n",
        "Antigravity CLI\n> \nGenerating...\nesc to cancel · Gemini\n"
      ),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        { id: "antigravity", root: "/clone", launcher: "start-antigravity.sh", delivery: "both", harnessProcess: "agy" },
        "/runtime/action.md"
      )
    ).toBe("busy");
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "capture-pane"]);
  });

  it("nudges Cursor when tmux reports the pane command as node", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(runnerWithPrompt(calls, "0\tnode\t0\n"), null, null, null, noopSleep);
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toBe("sent");
  });

  it("does not insert while the owner is in pane mode or the harness is gone", async () => {
    const busy = new TmuxController(async () => ok("0\tclaude\t1\n"), null, null, null, noopSleep);
    expect(
      await busy.nudge(
        1,
        { id: "claude", root: "/clone", launcher: "start-claude.sh", delivery: "nudge", harnessProcess: "claude" },
        "/a"
      )
    ).toBe("busy");
    const gone = new TmuxController(async () => ({ exitCode: 1, stdout: "", stderr: "missing" }), null, null, null, noopSleep);
    expect(
      await gone.nudge(1, { id: "claude", root: "/clone", launcher: "start-claude.sh", delivery: "nudge" }, "/a")
    ).toBe("gone");
  });

  it("confines executable launchers to the real agent clone", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-launcher-"));
    roots.push(root);
    const clone = join(root, "clone");
    mkdirSync(clone);
    const launcher = join(clone, "start-codex.sh");
    writeFileSync(launcher, "#!/bin/sh\n", { mode: 0o700 });
    const base = { id: "codex", root: clone, launcher: "start-codex.sh", delivery: "pull" as const };
    expect(resolveAgentLauncher(base)).toBe(launcher);
    expect(() => resolveAgentLauncher({ ...base, launcher: "../outside.sh" })).toThrow("outside coordinator root");
    expect(() => resolveAgentLauncher({ ...base, launcher })).toThrow("must be relative");
    const outside = join(root, "outside.sh");
    writeFileSync(outside, "#!/bin/sh\n", { mode: 0o700 });
    symlinkSync(outside, join(clone, "linked.sh"));
    expect(() => resolveAgentLauncher({ ...base, launcher: "linked.sh" })).toThrow("symlink");
    const notExecutable = join(clone, "not-executable.sh");
    writeFileSync(notExecutable, "#!/bin/sh\n");
    chmodSync(notExecutable, 0o600);
    expect(() => resolveAgentLauncher({ ...base, launcher: "not-executable.sh" })).toThrow("non-executable");
  });
});
