import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessLooksReady,
  nudgePreludeKeys,
  resolveAgentLauncher,
  TmuxController,
  type TmuxResult,
  type TmuxRunner
} from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("tmux boundary", () => {
  it("keeps flat session names stable and namespaces nested workspaces", () => {
    const runner: TmuxRunner = async () => ok();
    expect(new TmuxController(runner).sessionName(42)).toBe("coord-42");
    expect(new TmuxController(runner, "a1b2c3").sessionName(42)).toBe("coord-42-a1b2c3");
  });

  it("types the nudge with send-keys -l and no vim prelude for Cursor", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: TmuxRunner = async (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      if (args[0] === "display-message") return ok("0\tagent\t0\n");
      return ok();
    };
    const controller = new TmuxController(runner);
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toBe("sent");
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "send-keys", "send-keys"]);
    expect(calls[1]?.args).toEqual(["send-keys", "-l", "-t", "coord-1:cursor.0", expect.stringContaining("/runtime/action.md")]);
    expect(calls[2]?.args.slice(-1)).toEqual(["C-m"]);
  });

  it("uses per-agent nudgePrelude and nudgeSubmit for Codex vim", async () => {
    expect(nudgePreludeKeys("claude")).toEqual([]);
    expect(nudgePreludeKeys("codex")).toEqual(["i"]);
    expect(nudgePreludeKeys("antigravity")).toEqual([]);
    const calls: Array<{ args: readonly string[] }> = [];
    const runner: TmuxRunner = async (args) => {
      calls.push({ args });
      if (args[0] === "display-message") return ok("0\tcodex\t0\n");
      return ok();
    };
    const controller = new TmuxController(runner);
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
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "send-keys", "send-keys", "send-keys", "send-keys"]);
    expect(calls[1]?.args.slice(-1)).toEqual(["i"]);
    expect(calls[2]?.args[1]).toBe("-l");
    expect(calls[3]?.args.slice(-1)).toEqual(["C-j"]);
    expect(calls[4]?.args.slice(-1)).toEqual(["C-m"]);
  });

  it("honors explicit empty prelude over Codex defaults", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const runner: TmuxRunner = async (args) => {
      calls.push({ args });
      if (args[0] === "display-message") return ok("0\tcodex\t0\n");
      return ok();
    };
    const controller = new TmuxController(runner);
    await controller.nudge(
      1,
      {
        id: "codex",
        root: "/clone",
        launcher: "start-codex.sh",
        delivery: "both",
        nudgePrelude: [],
        nudgeSubmit: ["C-m"]
      },
      "/a"
    );
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "send-keys", "send-keys"]);
    expect(calls[1]?.args[1]).toBe("-l");
    expect(calls[2]?.args.slice(-1)).toEqual(["C-m"]);
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

  it("nudges Cursor when tmux reports the pane command as node", async () => {
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "display-message") return ok("0\tnode\t0\n");
      return ok();
    };
    const controller = new TmuxController(runner);
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toBe("sent");
  });

  it("does not insert while the owner is in pane mode or the harness is gone", async () => {
    const busy = new TmuxController(async () => ok("0\tclaude\t1\n"));
    expect(
      await busy.nudge(
        1,
        { id: "claude", root: "/clone", launcher: "start-claude.sh", delivery: "nudge", harnessProcess: "claude" },
        "/a"
      )
    ).toBe("busy");
    const gone = new TmuxController(async () => ({ exitCode: 1, stdout: "", stderr: "missing" }));
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
