import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  harnessLooksReady,
  harnessPromptReady,
  harnessPromptReadiness,
  idleSentinelAfterAction,
  CODEX_SUBMIT_RETRIES,
  COORD_IDLE_SENTINEL,
  nudgePreludeKeys,
  ownerTerminalCloseAppleScript,
  ownerTerminalOpenAppleScript,
  ownerTerminalWindowTitle,
  ownerTerminalTitlesToClose,
  readCursorVimMode,
  resolveAgentLauncher,
  NUDGE_BEFORE_ANTIGRAVITY_MS,
  resolveNudgeKeys,
  runTmux,
  TmuxController,
  vimInsertPrelude,
  type TmuxResult,
  type TmuxRunner
} from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });
const noopSleep = async (): Promise<void> => undefined;

it("reports issue environment wiring without claiming child-process trust", async () => {
  const calls: string[][] = [];
  let environment = "COORD_ISSUE=161\n";
  const tmux = new TmuxController(async (args) => { calls.push([...args]); return ok(environment); });
  expect(await tmux.issueEnvironmentDiagnostic(161)).toContain("existing child processes still need current-issue hook confirmation");
  environment = "COORD_ISSUE=139\n";
  expect(await tmux.issueEnvironmentDiagnostic(161)).toContain("[WARN]");
  environment = "";
  expect(await tmux.issueEnvironmentDiagnostic(161)).toContain("binding is missing or differs");
  expect(calls.every((args) => args[0] === "show-environment")).toBe(true);
});
it("reports pane placement and owner titles separately, without claiming unavailable checks succeeded", async () => {
  const agents = ["correct", "dead", "wrong", "missing", "unknown"].map((id) => ({ id, root: `/clones/${id}`, launcher: "launch", delivery: "pull" as const }));
  const calls: string[][] = [];
  const tmux = new TmuxController(async (args) => {
    calls.push([...args]);
    const target = args[3] ?? "";
    if (target.includes("missing")) return { exitCode: 1, stdout: "", stderr: "missing pane" };
    const id = target.split(":")[1]!.split(".")[0]!;
    return ok(`${id === "dead" ? "1" : "0"}\t${id === "unknown" ? "" : id === "wrong" ? "/elsewhere" : `/clones/${id}`}\n`);
  }, null, null, null, noopSleep, null, (titles) => titles.filter((title) => title.includes("correct")));
  const messages = await tmux.agentPlacementDiagnostics(172, agents);
  expect(messages).toContain("[OK] correct: pane coord-172:correct.0 started in /clones/correct.");
  for (const id of ["dead", "missing", "unknown"]) expect(messages.some((line) => line.startsWith(`[WARN] ${id}: live pane`))).toBe(true);
  expect(messages.some((line) => line.includes("[WARN] wrong: pane") && line.includes("/elsewhere"))).toBe(true);
  expect(messages.some((line) => line.includes("[WARN] wrong: owner Terminal title missing"))).toBe(true);
  expect(calls.every((args) => args[0] === "display-message")).toBe(true);
  const noProbe = new TmuxController(async () => ok("0\t/clones/correct\n"), null, null, null, noopSleep, null, null);
  expect((await noProbe.agentPlacementDiagnostics(172, agents.slice(0, 1))).some((line) => line.includes("could not be checked"))).toBe(true);
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const promptFor = (agentId: string): string => {
  switch (agentId) {
    case "claude":
      return "❯ \nauto mode on\n";
    case "cursor":
      return "Auto · 1%\nRun Everything\n";
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

describe("Claude usage-wait veto", () => {
  // Vendor strings: https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset
  // and https://code.claude.com/docs/en/errors#youve-hit-your-session-limit.
  // Spinner/box prefixes below are terminal-decoration variants, not vendor prose.
  it.each([
    "Usage limit reached · continuing automatically at 3:45pm · esc to cancel",
    "You've hit your Opus limit · resets 3:45pm",
    "Usage limit reset · continuing automatically",
    "continuing shortly",
    "Your usage limit has reset · press enter to continue",
    "Automatic continue cancelled",
    "Automatic continue stopped after repeated usage-limit hits · /rate-limit-options to try again",
    "⠧ Usage limit reached · continuing automatically at 3:45pm",
    "│ Usage limit reached · continuing automatically at 3:45pm │"
  ])("vetoes %s despite a prompt, mode and idle sentinel", (banner) => {
    expect(harnessPromptReadiness(`${banner}\n❯ auto mode -- INSERT --\n${COORD_IDLE_SENTINEL}`, "claude"))
      .toEqual({ ready: false, reason: "claude-usage-wait" });
  });

  it("does not confuse quoted prose with active chrome", () => {
    expect(harnessPromptReadiness("> Usage limit reached\n- `Continuing automatically`\n❯", "claude").ready).toBe(true);
    expect(harnessPromptReadiness(`Usage limit reached\n${"old history\n".repeat(15)}❯`, "claude").ready).toBe(true);
  });

  it.each([2, 3])("rechecks before keys and never submits if the wait appears at capture %s", async (blockedCapture) => {
    let captures = 0;
    let reservations = 0;
    const keys: string[] = [];
    const tmux = new TmuxController(async (args) => {
      if (args[0] === "display-message") return ok("0\tclaude\t0\t0");
      if (args[0] === "capture-pane") return ok(++captures >= blockedCapture ? "Usage limit reached\n❯" : "❯");
      if (args[0] === "send-keys") keys.push(args.at(-1)!);
      return ok();
    }, undefined, undefined, undefined, noopSleep);
    const result = await tmux.nudge(1, { id: "claude", root: "/clone", launcher: "claude", delivery: "both",
      harnessProcess: "claude", nudgePrelude: [], nudgeSubmit: ["Enter"] }, "/action.md", () => undefined,
    undefined, undefined, () => { reservations++; });
    expect(result).toMatchObject({ status: "busy", reason: "claude-usage-wait", stage: blockedCapture === 2 ? "prompt" : "mid-send" });
    expect(keys).not.toContain("Enter");
    expect(reservations).toBe(blockedCapture === 2 ? 0 : 1);
  });
});

describe("tmux boundary", () => {
  it("keeps flat session names stable and namespaces nested workspaces", () => {
    const runner: TmuxRunner = async () => ok();
    expect(new TmuxController(runner).sessionName(42)).toBe("coord-42");
    expect(new TmuxController(runner, "a1b2c3").sessionName(42)).toBe("coord-42-a1b2c3");
  });

  it("always scopes manual session names and Terminal titles by workspace group", () => {
    const runner: TmuxRunner = async () => ok();
    const first = new TmuxController(runner, null, null, null, noopSleep, "a1b2c3d4e5");
    const second = new TmuxController(runner, null, null, null, noopSleep, "f6e7d8c9b0");
    expect(first.sessionName("manual")).toBe("coord-manual-a1b2c3d4e5");
    expect(second.sessionName("manual")).toBe("coord-manual-f6e7d8c9b0");
    expect(first.sessionName(42)).toBe("coord-42");
    expect(ownerTerminalWindowTitle("manual", "claude", "a1b2c3d4e5")).toBe(
      "coord-manual-a1b2c3d4e5/claude"
    );
    expect(ownerTerminalTitlesToClose("manual", ["claude", "codex"], "a1b2c3d4e5")).toEqual([
      "coord-manual-a1b2c3d4e5/claude",
      "coord-manual-a1b2c3d4e5/codex"
    ]);
    expect(() => new TmuxController(runner).sessionName("manual")).toThrow("workspace group id");
    expect(() => ownerTerminalWindowTitle("manual", "claude")).toThrow("workspace group id");
  });

  it("types the nudge with send-keys -l and Enter for Cursor", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const slept: number[] = [];
    const controller = new TmuxController(runnerWithPrompt(calls), null, null, null, async (ms) => {
      slept.push(ms);
    });
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md",
        () => undefined,
        "11111111-1111-4111-8111-111111111111",
        "a".repeat(64)
      )
    ).toMatchObject({ status: "sent" });
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "display-message",
      "send-keys",
      "display-message",
      "send-keys"
    ]);
    expect(calls[3]?.args).toEqual([
      "send-keys",
      "-l",
      "-t",
      "coord-1:cursor.0",
      `Read and execute coordinator action 11111111-1111-4111-8111-111111111111 digest ${"a".repeat(64)} at /runtime/action.md`
    ]);
    expect(calls[5]?.args.slice(-1)).toEqual(["Enter"]);
    expect(slept).not.toContain(NUDGE_BEFORE_ANTIGRAVITY_MS);
  });

  it("submits Cursor vim INSERT with Escape then Enter, not a bare Enter", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cursor-vim-nudge-"));
    roots.push(root);
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor/cli.json"), `${JSON.stringify({ editor: { vimMode: true } })}\n`);
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tagent\t0\t0\n", "Auto ·\n-- INSERT --\n"),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root, launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toMatchObject({ status: "sent" });
    const sent = calls.filter((call) => call.args[0] === "send-keys");
    expect(sent.map((call) => call.args.slice(-1)[0])).toEqual([
      "Read and execute your current coordinator action at /runtime/action.md",
      "Escape",
      "Enter"
    ]);
    expect(sent.some((call) => call.args.includes("a"))).toBe(false);
  });

  it("sends vim a for Cursor only when editor.vimMode is on and the pane is not INSERT", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cursor-vim-"));
    roots.push(root);
    mkdirSync(join(root, ".cursor"));
    const agent = { id: "cursor" as const, root, launcher: "start-cursor.sh", delivery: "both" as const };
    expect(readCursorVimMode(root)).toBe(false);
    expect(resolveNudgeKeys(agent, "Auto ·")).toEqual({ prelude: [], submit: ["Enter"] });
    writeFileSync(join(root, ".cursor/cli.json"), `${JSON.stringify({ editor: { vimMode: true } })}\n`);
    expect(readCursorVimMode(root)).toBe(true);
    expect(resolveNudgeKeys(agent, "Auto ·")).toEqual({ prelude: ["a"], submit: ["Escape", "Enter"] });
    expect(resolveNudgeKeys(agent, "-- INSERT --")).toEqual({ prelude: [], submit: ["Escape", "Enter"] });
    writeFileSync(join(root, ".cursor/cli.json"), `${JSON.stringify({ editor: { vimMode: false } })}\n`);
    expect(resolveNudgeKeys(agent, "Auto ·")).toEqual({ prelude: [], submit: ["Enter"] });
    expect(
      resolveNudgeKeys({ ...agent, nudgePrelude: ["a"] }, "Auto ·")
    ).toEqual({ prelude: ["a"], submit: ["Escape", "Enter"] });
  });

  it("uses per-agent nudgePrelude and nudgeSubmit for Codex vim", async () => {
    expect(nudgePreludeKeys("claude")).toEqual([]);
    expect(nudgePreludeKeys("codex")).toEqual(["i"]);
    expect(nudgePreludeKeys("antigravity")).toEqual([]);
    expect(vimInsertPrelude("❯\n-- NORMAL --", "claude")).toEqual(["a"]);
    expect(vimInsertPrelude("❯\n-- INSERT --", "claude")).toEqual([]);
    expect(vimInsertPrelude("❯\n-- VISUAL --", "claude")).toEqual(["Escape", "a"]);
    expect(vimInsertPrelude("❯ auto mode", "claude")).toEqual(["a"]);
    expect(vimInsertPrelude("whatever the composer says", "cursor")).toEqual(["a"]);
    expect(vimInsertPrelude("-- INSERT --", "cursor")).toEqual([]);
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
    ).toMatchObject({ status: "sent" });
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "display-message",
      "send-keys",
      "display-message",
      "send-keys",
      "display-message",
      "send-keys",
      "display-message",
      "send-keys"
    ]);
    expect(calls[3]?.args.slice(-1)).toEqual(["i"]);
    expect(calls[5]?.args[1]).toBe("-l");
    expect(calls[7]?.args.slice(-1)).toEqual(["C-j"]);
    expect(calls[9]?.args.slice(-1)).toEqual(["C-m"]);
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
      "display-message",
      "send-keys",
      "display-message",
      "send-keys",
      "display-message",
      "send-keys"
    ]);
    expect(calls[3]?.args[1]).toBe("-l");
    expect(calls[5]?.args.slice(-1)).toEqual(["C-j"]);
    expect(calls[7]?.args.slice(-1)).toEqual(["C-m"]);
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

  it("opens only missing owner terminals on resume", async () => {
    const launched: string[] = [];
    const controller = new TmuxController(
      async () => ok(),
      null,
      async (launches) => {
        for (const launch of launches) launched.push(launch.agentId);
      },
      null,
      noopSleep,
      null,
      (titles) => titles.filter((title) => title.endsWith("/claude"))
    );
    await expect(
      controller.openOwnerAgentClients(
        1,
        [
          { id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both" },
          { id: "cursor", root: "/u", launcher: "start-cursor.sh", delivery: "both" }
        ],
        { onlyMissing: true }
      )
    ).resolves.toEqual({ status: "opened", count: 1 });
    expect(launched).toEqual(["cursor"]);
  });

  it("skips Terminal open when every resume title is already present", async () => {
    const launched: string[] = [];
    const controller = new TmuxController(
      async () => ok(),
      null,
      async (launches) => {
        for (const launch of launches) launched.push(launch.agentId);
      },
      null,
      noopSleep,
      null,
      (titles) => [...titles]
    );
    await expect(
      controller.openOwnerAgentClients(
        1,
        [{ id: "claude", root: "/c", launcher: "start-claude.sh", delivery: "both" }],
        { onlyMissing: true }
      )
    ).resolves.toEqual({ status: "already-open", count: 1 });
    expect(launched).toEqual([]);
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

  it("ensureSession recreates missing agent windows and respawns a dead pane", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ensure-"));
    roots.push(root);
    const clone = join(root, "clone");
    mkdirSync(clone);
    writeFileSync(join(clone, "start-claude.sh"), "#!/bin/sh\n", { mode: 0o700 });
    const calls: string[][] = [];
    let windows = "";
    let sessionPresent = false;
    let paneDead = "1";
    const runner: TmuxRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "has-session") return { exitCode: sessionPresent ? 0 : 1, stdout: "", stderr: "" };
      if (args[0] === "new-session") sessionPresent = true;
      if (args[0] === "list-windows") return ok(windows);
      if (args[0] === "display-message") return ok(`${paneDead}\tclaude\t0\n`);
      if (args[0] === "new-window") {
        windows = "claude";
        return ok();
      }
      if (args[0] === "respawn-pane") {
        paneDead = "0";
        return ok();
      }
      return ok();
    };
    const controller = new TmuxController(runner, null, null, null);
    const agent = { id: "claude", root: clone, launcher: "start-claude.sh", delivery: "both" as const };
    await controller.startSession(3, [agent]);
    expect(calls).toContainEqual(["set-environment", "-r", "-t", "coord-3", "COORD_MANUAL"]);
    calls.length = 0;
    windows = "";
    await controller.ensureSession(3, [agent]);
    expect(calls.some((args) => args[0] === "new-window")).toBe(true);
    expect(calls).toContainEqual(["set-environment", "-t", "coord-3", "COORD_ISSUE", "3"]);
    expect(calls).toContainEqual(["set-environment", "-r", "-t", "coord-3", "COORD_MANUAL"]);
    calls.length = 0;
    await controller.ensureSession(3, [agent]);
    expect(calls.some((args) => args[0] === "respawn-pane")).toBe(true);
    calls.length = 0;
    await controller.ensureSession(3, [agent]);
    expect(calls.some((args) => args[0] === "new-window" || args[0] === "respawn-pane")).toBe(false);
  });

  it("creates and repairs manual sessions without exposing COORD_ISSUE", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-manual-ensure-"));
    roots.push(root);
    const clone = join(root, "clone");
    mkdirSync(clone);
    writeFileSync(join(clone, "start-claude.sh"), "#!/bin/sh\n", { mode: 0o700 });
    const calls: string[][] = [];
    let sessionPresent = false;
    let windowPresent = false;
    let paneDead = "0";
    const runner: TmuxRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "has-session") return sessionPresent ? ok() : { exitCode: 1, stdout: "", stderr: "missing" };
      if (args[0] === "new-session") {
        sessionPresent = true;
        return ok();
      }
      if (args[0] === "list-windows") return ok(windowPresent ? "claude\n" : "");
      if (args[0] === "display-message") return ok(`${paneDead}\tclaude\t0\t0\n`);
      if (args[0] === "new-window") windowPresent = true;
      if (args[0] === "respawn-pane") paneDead = "0";
      return ok();
    };
    const controller = new TmuxController(runner, null, null, null, noopSleep, "abc12def00");
    const agent = { id: "claude", root: clone, launcher: "start-claude.sh", delivery: "both" as const };
    await controller.ensureSession("manual", [agent]);
    expect(calls).toContainEqual([
      "set-environment",
      "-r",
      "-t",
      "coord-manual-abc12def00",
      "COORD_ISSUE"
    ]);
    expect(calls).toContainEqual([
      "set-environment",
      "-t",
      "coord-manual-abc12def00",
      "COORD_MANUAL",
      "1"
    ]);
    expect(calls.some((args) => args.includes("COORD_ISSUE") && !args.includes("-r"))).toBe(false);
    expect(calls.filter((args) => args[0] === "new-window")).toHaveLength(1);

    calls.length = 0;
    paneDead = "1";
    await controller.ensureSession("manual", [agent]);
    expect(calls.filter((args) => args[0] === "respawn-pane")).toHaveLength(1);
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
  });

  it("lists only the configured linked clients for manual teardown", async () => {
    const runner: TmuxRunner = async (args) =>
      args[0] === "list-sessions"
        ? ok(
            "coord-manual-abc12def00\n" +
              "coord-manual-abc12def00-claude\n" +
              "coord-manual-abc12def00-stale\n" +
              "coord-manual-def34abc00\n"
          )
        : ok();
    const controller = new TmuxController(runner, null, null, null, noopSleep, "abc12def00");
    await expect(controller.listIssueSessions("manual", ["claude"])).resolves.toEqual([
      "coord-manual-abc12def00",
      "coord-manual-abc12def00-claude"
    ]);
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
    expect(
      await controller.nudge(1, { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "pull" }, "/a")
    ).toMatchObject({ status: "disabled", reason: "delivery-disabled" });
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

  it("does not read prose about in-flight chrome as in-flight chrome", () => {
    // A1: the coordinator's own agents write these words while planning.
    expect(harnessPromptReady("I am thinking about the alternatives and their stats\n> ", "cursor")).toBe(true);
    expect(harnessPromptReady("status/thinking/stats\nAuto · 1%", "cursor")).toBe(true);
    // Markdown quoting is prose, and an ellipsis alone does not make it chrome.
    expect(harnessPromptReady("- `Thinking…` is the chrome we match\nAuto · 1%", "cursor")).toBe(true);
    expect(harnessPromptReady("> Thinking... appears while a turn runs\nAuto · 1%", "cursor")).toBe(true);
    expect(harnessPromptReady("* Working... is vendor chrome\nAuto · 1%", "cursor")).toBe(true);
    expect(harnessPromptReady("plans mention `Running...` a lot\nAuto · 1%", "cursor")).toBe(true);
    // A middle dot starts an ordinary markdown bullet, not a spinner frame.
    expect(harnessPromptReady("· Thinking… in a bulleted note\nAuto · 1%", "cursor")).toBe(true);
    expect(harnessPromptReady("• Working... in a bulleted note\nAuto · 1%", "cursor")).toBe(true);
    // Real chrome still blocks, anchored or with the interrupt hint.
    expect(harnessPromptReady("Thinking…\nesc to cancel", "cursor")).toBe(false);
    expect(harnessPromptReady("Thinking...", "cursor")).toBe(false);
    expect(harnessPromptReady("⠋ Generating...", "cursor")).toBe(false);
    expect(harnessPromptReady("  Working... (12s)", "cursor")).toBe(false);
    // Elapsed-timer forms are live chrome too: reading them as ready would type
    // into a running turn, which costs more than deferring one tick.
    expect(harnessPromptReady("Thinking for 12s", "cursor")).toBe(false);
    expect(harnessPromptReady("⠹ Working for 3s · esc to interrupt", "cursor")).toBe(false);
    expect(harnessPromptReady("Working (12s)", "cursor")).toBe(false);
    expect(harnessPromptReady("Generating (3s)", "antigravity")).toBe(false);
    // ...but a sentence that merely opens with the word is still prose.
    expect(harnessPromptReady("Thinking about the timer forms for this issue\n> ", "cursor")).toBe(true);
  });

  it("names the predicate that refused a prompt", () => {
    expect(harnessPromptReadiness("Do you trust this folder?", "claude")).toEqual({
      ready: false,
      reason: "trust-dialog"
    });
    expect(harnessPromptReadiness("Auto · 1%\nThinking…", "cursor")).toEqual({
      ready: false,
      reason: "cursor-turn-chrome"
    });
    expect(
      harnessPromptReadiness(
        "⚠ Verifying your account...\n> Accept-edits mode: file edits auto-approved · Gemini",
        "antigravity"
      )
    ).toEqual({ ready: false, reason: "antigravity-verify-overlay" });
    expect(harnessPromptReadiness("Antigravity CLI\nnvm use…", "antigravity")).toEqual({
      ready: false,
      reason: "antigravity-no-prompt"
    });
    expect(harnessPromptReadiness("some output", "claude")).toEqual({
      ready: false,
      reason: "claude-no-prompt"
    });
    expect(harnessPromptReadiness("❯ \nauto mode on", "claude")).toEqual({
      ready: true,
      reason: "vendor-prompt"
    });
  });

  it("treats the idle sentinel as evidence only when it is current and nothing blocks", () => {
    const action = "11111111-2222-3333-4444-555555555555";
    // Positive: a pane no vendor pattern matched, with a fresh sentinel.
    expect(harnessPromptReadiness(`working on ${action}\n${COORD_IDLE_SENTINEL}`, "claude", action)).toEqual({
      ready: true,
      reason: "idle-sentinel"
    });
    // Stale: the sentinel predates this action, so it proves nothing.
    expect(
      harnessPromptReadiness(`${COORD_IDLE_SENTINEL}\nRead and execute ${action}`, "claude", action)
    ).toEqual({ ready: false, reason: "claude-no-prompt" });
    // A positive hint never clears a blocker.
    expect(
      harnessPromptReadiness(
        `⚠ Verifying your account...\n${COORD_IDLE_SENTINEL}`,
        "antigravity",
        action
      )
    ).toEqual({ ready: false, reason: "antigravity-verify-overlay" });
    expect(harnessPromptReadiness(`Thinking…\n${COORD_IDLE_SENTINEL}`, "cursor", action)).toEqual({
      ready: false,
      reason: "cursor-turn-chrome"
    });
    expect(harnessPromptReadiness(`Do you trust this folder?\n${COORD_IDLE_SENTINEL}`, "claude", action)).toEqual({
      ready: false,
      reason: "trust-dialog"
    });
    expect(idleSentinelAfterAction(`${action}\n${COORD_IDLE_SENTINEL}`, action)).toBe(true);
    expect(idleSentinelAfterAction(`${COORD_IDLE_SENTINEL}\n${action}`, action)).toBe(false);
    expect(idleSentinelAfterAction("no sentinel here", action)).toBe(false);
  });

  // Modelled on the live Codex capture in issue 181: dim placeholder composer, two footer lines.
  const esc = String.fromCharCode(0x1b);
  const codexComposer = (draft: string) =>
    `${esc}[1m›${esc}[0m${esc}[48;2;30;158;159m ${draft === "" ? `${esc}[2mAsk Codex to do anything${esc}[0m` : draft}`;
  const codexFooter =
    "  Context 71% left · weekly 96% left · 258K window · 84.6K used · Vim: Insert\n" +
    "  ← for agents · ? for shortcuts                       ⚠ 1 warning · f2 to view";
  const turnSummary = "  Worked for 5m 21s • 5:42 AM";
  const codexPane = (body: string, draft = "", vim = "Insert") =>
    `• Explored\n  └ Read action.md\n\n${body}\n\n${codexComposer(draft)}\n\n${codexFooter.replace("Vim: Insert", `Vim: ${vim}`)}`;

  it("vetoes a live Codex turn and reads its idle sentinel only above an empty composer", () => {
    const action = "11111111-2222-3333-4444-555555555555";
    expect(harnessPromptReadiness(codexPane("• Working (2m 27s • esc to interrupt)\n  └ Tip: run ! commands"), "codex", action))
      .toEqual({ ready: false, reason: "codex-turn-chrome" });
    // Prose quoting the status line is not chrome.
    expect(harnessPromptReadiness(codexPane("• I saw `Working (2s • esc to interrupt)` earlier."), "codex", action))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}`), "codex", action))
      .toEqual({ ready: true, reason: "idle-sentinel" });
    // An unsent owner draft, a dialog line, or the action after the sentinel is not idle proof.
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}`, "Please inspect my changes"), "codex", action))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}\n  2. No, continue without the server`), "codex", action))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}`, `Read and execute ${action}`), "codex", action))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    // Codex's end-of-turn summary may sit between the sentinel and the composer; the legacy footer still counts.
    // Rendered dim, as Codex paints it, and in the older `─` rule form.
    for (const summary of [turnSummary, `${esc}[2m${turnSummary}${esc}[0m`, "─ Worked for 12s ─────"]) {
      expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}\n\n${summary}`), "codex", action))
        .toEqual({ ready: true, reason: "idle-sentinel" });
    }
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}`).replace("← for agents · ", ""), "codex", action))
      .toEqual({ ready: true, reason: "idle-sentinel" });
    expect(harnessPromptReadiness(codexPane(`${turnSummary}\n\n• ${COORD_IDLE_SENTINEL}`), "codex", action))
      .toEqual({ ready: true, reason: "idle-sentinel" });
    // Only one summary line is skipped; prose or a dialog after it still fails closed, and a live turn still vetoes.
    for (const after of [`${turnSummary}\n  2. No, continue without the server`, "  Worked for the reviewer: pick 1 or 2",
      "• I printed Worked for 5m earlier", `${turnSummary}\n  Worked for 3s`, "  Worked for 3s • 5:42 AM then pick 1 or 2",
      `${turnSummary}\n› another request`]) {
      expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}\n\n${after}`), "codex", action))
        .toEqual({ ready: true, reason: "vendor-prompt" });
    }
    // An unknown line below the footer still fails closed.
    expect(harnessPromptReadiness(`${codexPane(`• ${COORD_IDLE_SENTINEL}\n\n${turnSummary}`)}\n  unknown footer`, "codex", action))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}\n\n  Worked for 3s\n• Working (1s • esc to interrupt)`), "codex", action))
      .toEqual({ ready: false, reason: "codex-turn-chrome" });
  });

  it.each(["idle-sentinel", "ready-file"] as const)("sends a %s nudge only while the idle proof holds at each key", async (source) => {
    const composerReason = source === "idle-sentinel" ? "no-idle-sentinel" : "codex-composer-not-ready";
    const agent = { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "both" as const, harnessProcess: "codex" };
    const action = "11111111-2222-3333-4444-555555555555";
    // A minimal Codex: typed text lands in the composer; `onCapture` lets a test change the pane between keys.
    const attempt = async (options: {
      body?: string; draft?: string; vim?: string; submitOnCtrlJ?: boolean; gate?: string;
      lifecycle?: (check: number) => "unchanged" | "accepted" | "changed";
      onCapture?: (index: number, pane: { body: string; draft: string }) => void;
    } = {}) => {
      const pane = { body: options.body ?? (source === "idle-sentinel" ? `• ${COORD_IDLE_SENTINEL}\n\n${turnSummary}` : "• done"), draft: options.draft ?? "" };
      const keys: string[] = [];
      let captures = 0;
      const controller = new TmuxController(async (args) => {
        if (args[0] === "display-message") return ok(options.gate ?? "0\tcodex\t0\t0\n");
        if (args[0] === "capture-pane") {
          options.onCapture?.(captures++, pane);
          return ok(codexPane(pane.body, pane.draft, options.vim));
        }
        if (args[0] === "send-keys") {
          if (args.includes("-l")) pane.draft += args.at(-1)!;
          if ((options.submitOnCtrlJ === true && args.at(-1) === "C-j") || args.at(-1) === "C-m") {
            pane.body += `\n\n› ${pane.draft}\n\n• Working (0s • esc to interrupt)`;
            pane.draft = "";
          }
          keys.push(args.includes("-l") ? "-l" : args.at(-1)!);
        }
        return ok();
      }, null, null, null, noopSleep);
      let checks = 0;
      const outcome = await controller.nudge(1, agent, "/a", undefined, action, undefined, undefined,
        { source, lifecycle: () => options.lifecycle?.(checks++) ?? "unchanged" });
      return { outcome, keys };
    };
    if (source === "idle-sentinel") {
      expect(await attempt({ body: "• done" })).toMatchObject({ outcome: { status: "busy", reason: "no-idle-sentinel", stage: "prompt" }, keys: [] });
    }
    expect(await attempt({ draft: "Owner draft" })).toMatchObject({ outcome: { status: "busy", reason: composerReason }, keys: [] });
    expect(await attempt({ body: "Trust this folder?" })).toMatchObject({ outcome: { status: "busy", reason: "trust-dialog" }, keys: [] });
    for (const [gate, reason] of [["0\tbash\t0\t0\n", "foreground-mismatch"], ["0\tcodex\t1\t0\n", "owner-typing"], ["0\tcodex\t0\t1\n", "input-off"]]) {
      expect(await attempt({ gate })).toMatchObject({ outcome: { status: "busy", reason }, keys: [] });
    }
    // The owner starts a turn, or a lifecycle hook reports activity, before the first key: nothing is typed.
    expect(await attempt({ onCapture: (index, pane) => { if (index === 1) pane.body = "• Working (1s • esc to interrupt)"; } }))
      .toMatchObject({ outcome: { status: "busy", reason: "codex-turn-chrome", stage: "prompt" }, keys: [] });
    expect(await attempt({ lifecycle: () => "changed" }))
      .toMatchObject({ outcome: { status: "busy", reason: "lifecycle-changed", stage: "prompt" }, keys: [] });
    // Already in INSERT: no `i` is typed into the composer.
    expect(await attempt()).toMatchObject({ outcome: { status: "sent", detail: source }, keys: ["-l", "C-j", "C-m"] });
    expect(await attempt({ vim: "Normal" })).toMatchObject({ outcome: { status: "sent" }, keys: ["i", "-l", "C-j", "C-m"] });
    // An owner draft after the prelude, or an edit after the paste, stops the send before it is submitted.
    expect(await attempt({ vim: "Normal", onCapture: (index, pane) => { if (index === 2) pane.draft = "owner draft"; } }))
      .toMatchObject({ outcome: { status: "busy", reason: composerReason, stage: "mid-send" }, keys: ["i"] });
    expect(await attempt({ onCapture: (index, pane) => { if (index === 2) pane.draft += " and more"; } }))
      .toMatchObject({ outcome: { status: "busy", reason: composerReason, stage: "mid-send" }, keys: ["-l"] });
    // Between the submit keys the same proof holds: an edit or new lifecycle activity stops C-m.
    expect(await attempt({ onCapture: (index, pane) => { if (index === 3) pane.draft += " and more"; } }))
      .toMatchObject({ outcome: { status: "busy", reason: composerReason, stage: "mid-send" }, keys: ["-l", "C-j"] });
    expect(await attempt({ lifecycle: (check) => (check === 2 ? "changed" : "unchanged") }))
      .toMatchObject({ outcome: { status: "busy", reason: "lifecycle-changed", stage: "mid-send" }, keys: ["-l", "C-j"] });
    // An unrelated turn between the submit keys, with the nudge still in the composer, is not acceptance.
    expect(await attempt({
      lifecycle: (check) => (check === 2 ? "changed" : "unchanged"),
      onCapture: (index, pane) => { if (index === 3) pane.body += "\n\n• Working (3s • esc to interrupt)"; }
    })).toMatchObject({ outcome: { status: "busy", reason: "codex-turn-chrome", stage: "mid-send" }, keys: ["-l", "C-j"] });
    // If C-j already submitted the nudge, its turn or its correlated prompt hook ends the send: no fallback C-m.
    expect(await attempt({ submitOnCtrlJ: true }))
      .toMatchObject({ outcome: { status: "sent", detail: source }, keys: ["-l", "C-j"] });
    expect(await attempt({ lifecycle: (check) => (check === 2 ? "accepted" : "unchanged") }))
      .toMatchObject({ outcome: { status: "sent", detail: source }, keys: ["-l", "C-j"] });
  });

  // Issue 186: a minimal Codex whose Enter can be lost and whose typed text can paint late.
  const codexSubmit = async (options: {
    vim?: string; lostEnters?: number; lateCaptures?: number; source?: "ready-file";
    /** Pane changes at the Nth display-message gate (1-based). */
    onGate?: (gates: number, pane: { body: string; draft: string; inputOff: boolean }) => void;
    /** Pane changes once the first Enter has been lost. */
    afterLostEnter?: (pane: { body: string; draft: string; captureLost: boolean }) => void;
  } = {}) => {
    const agent = { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "both" as const, harnessProcess: "codex" };
    const pane = { body: "• done", draft: "", hidden: 0, inputOff: false, captureLost: false };
    let lostEnters = options.lostEnters ?? 0;
    let gates = 0;
    const keys: string[] = [];
    const controller = new TmuxController(async (args) => {
      if (args[0] === "display-message") {
        options.onGate?.(++gates, pane);
        return ok(`0\tcodex\t0\t${pane.inputOff ? 1 : 0}\n`);
      }
      if (args[0] === "capture-pane") {
        if (pane.captureLost) return { exitCode: 1, stdout: "", stderr: "" };
        const painted = pane.hidden > 0 ? "" : pane.draft;
        if (pane.hidden > 0) pane.hidden -= 1;
        return ok(codexPane(pane.body, painted, options.vim));
      }
      if (args[0] === "send-keys") {
        keys.push(args.includes("-l") ? "-l" : args.at(-1)!);
        if (args.includes("-l")) { pane.draft += args.at(-1)!; pane.hidden = options.lateCaptures ?? 0; }
        if (args.at(-1) === "C-m" && lostEnters-- <= 0) {
          pane.body += `\n\n› ${pane.draft}\n\n• Working (0s • esc to interrupt)`;
          pane.draft = "";
        } else if (args.at(-1) === "C-m" && keys.filter((key) => key === "C-m").length === 1) {
          options.afterLostEnter?.(pane);
        }
      }
      return ok();
    }, null, null, null, noopSleep);
    const outcome = await controller.nudge(1, agent, "/a", undefined, "11111111-2222-3333-4444-555555555555", undefined, undefined,
      options.source === undefined ? undefined : { source: options.source, lifecycle: () => "unchanged" });
    return { outcome, keys };
  };

  it("types Codex's `i` prelude only when INSERT is not visible", async () => {
    expect(await codexSubmit()).toMatchObject({ outcome: { status: "sent" }, keys: ["-l", "C-j", "C-m"] });
    expect(await codexSubmit({ vim: "Normal" })).toMatchObject({ outcome: { status: "sent" }, keys: ["i", "-l", "C-j", "C-m"] });
  });

  it("re-presses Enter, bounded, while the Codex composer still holds the nudge", async () => {
    expect(await codexSubmit({ lostEnters: 1 }))
      .toMatchObject({ outcome: { status: "sent" }, keys: ["-l", "C-j", "C-m", "C-m"] });
    expect((await codexSubmit({ lostEnters: 9 })).keys)
      .toEqual(["-l", "C-j", "C-m", ...Array<string>(CODEX_SUBMIT_RETRIES).fill("C-m")]);
    // A late paint of the typed text is waited for, not refused mid-send.
    expect(await codexSubmit({ source: "ready-file", lateCaptures: 2 }))
      .toMatchObject({ outcome: { status: "sent", detail: "ready-file" }, keys: ["-l", "C-j", "C-m"] });
  });

  it("re-checks the pane at every Codex retry and after a settle wait", async () => {
    const midSend = (reason: string) => ({ status: "busy", reason, stage: "mid-send" });
    // A turn starts with the nudge still in the composer: no Enter is pressed into it.
    expect(await codexSubmit({ lostEnters: 9, afterLostEnter: (pane) => { pane.body += "\n\n• Working (1s • esc to interrupt)"; } }))
      .toMatchObject({ outcome: midSend("codex-turn-chrome"), keys: ["-l", "C-j", "C-m"] });
    // The owner edits the composer during the retry key's own gate.
    expect(await codexSubmit({ lostEnters: 9, onGate: (gates, pane) => { if (gates === 5) pane.draft = "owner draft"; } }))
      .toMatchObject({ outcome: midSend("codex-composer-not-ready"), keys: ["-l", "C-j", "C-m"] });
    // A lost capture is not evidence that the nudge was submitted.
    expect(await codexSubmit({ lostEnters: 9, afterLostEnter: (pane) => { pane.captureLost = true; } }))
      .toMatchObject({ outcome: midSend("pane-capture-unavailable"), keys: ["-l", "C-j", "C-m"] });
    // Input turns off while the override waits for a late paint: the earlier gate no longer authorizes C-j.
    expect(await codexSubmit({ source: "ready-file", lateCaptures: 1, onGate: (gates, pane) => { if (gates === 4) pane.inputOff = true; } }))
      .toMatchObject({ outcome: midSend("input-off"), keys: ["-l"] });
    // The owner edits the draft during that re-gate: the proof re-reads the pane, so C-j never lands on it.
    expect(await codexSubmit({ source: "ready-file", lateCaptures: 1, onGate: (gates, pane) => { if (gates === 4) pane.draft = "owner draft"; } }))
      .toMatchObject({ outcome: midSend("codex-composer-not-ready"), keys: ["-l"] });
  });

  it.each([1, 2, 3])("refuses file-backed delivery when capture %s is unavailable", async (failedCapture) => {
    for (const exitCode of [0, 1]) {
      const calls: Array<readonly string[]> = [];
      let captures = 0;
      const controller = new TmuxController(async (args) => {
        calls.push(args);
        if (args[0] === "display-message") return ok("0\tagent\t0\t0\n");
        if (args[0] === "capture-pane") {
          if (++captures === failedCapture) return { exitCode, stdout: "", stderr: "" };
          return ok(promptFor("cursor"));
        }
        return ok();
      }, null, null, null, noopSleep);
      const result = await controller.nudge(1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/a", undefined, undefined, undefined, undefined, { source: "ready-file", lifecycle: () => "unchanged" });
      expect(result).toMatchObject({ status: "busy", reason: "pane-capture-unavailable",
        stage: failedCapture === 3 ? "mid-send" : "prompt" });
      expect(calls.filter((args) => args[0] === "send-keys")).toHaveLength(failedCapture === 3 ? 1 : 0);
    }
  });

  it("reports which pane predicate deferred a delivery", async () => {
    const gate = async (fields: string) => {
      const controller = new TmuxController(async (args) => {
        if (args[0] === "display-message") return { exitCode: 0, stdout: fields, stderr: "" };
        if (args[0] === "capture-pane") return { exitCode: 0, stdout: "❯ ", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      return controller.nudge(
        1,
        { id: "codex", root: "/clone", launcher: "x", delivery: "both", harnessProcess: "codex" },
        "/a"
      );
    };
    expect(await gate("0\tbash\t0\t0\n")).toMatchObject({
      status: "busy",
      reason: "foreground-mismatch",
      stage: "gate",
      detail: "bash"
    });
    expect(await gate("0\tcodex\t0\t1\n")).toMatchObject({ status: "busy", reason: "input-off" });
    expect(await gate("0\tcodex\t1\t0\n")).toMatchObject({ status: "busy", reason: "owner-typing" });
    expect(await gate("1\tcodex\t0\t0\n")).toMatchObject({ status: "gone", reason: "pane-dead" });
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
    expect(harnessPromptReady("Auto · 1%\nRun Everything", "cursor")).toBe(true);
    expect(harnessPromptReady("Generating...\nAuto · 1%\nRun Everything", "cursor")).toBe(false);
    expect(harnessPromptReady("esc to cancel", "cursor")).toBe(false);
    expect(
      resolveNudgeKeys(
        { id: "cursor", root: "/c", launcher: "x", delivery: "both", nudgeSubmit: ["Escape", "Enter"] },
        "any composer placeholder"
      )
    ).toEqual({ prelude: [], submit: ["Enter"] });
  });

  it("submits Antigravity nudges with Enter only", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const slept: number[] = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tagy\t0\n", promptFor("antigravity")),
      null,
      null,
      null,
      async (ms) => {
        slept.push(ms);
      }
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
    ).toMatchObject({ status: "sent" });
    expect(slept[0]).toBe(NUDGE_BEFORE_ANTIGRAVITY_MS);
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "capture-pane",
      "capture-pane",
      "display-message",
      "send-keys",
      "display-message",
      "send-keys"
    ]);
    expect(calls[4]?.args).toEqual([
      "send-keys",
      "-l",
      "-t",
      "coord-1:antigravity.0",
      expect.stringContaining("/runtime/action.md")
    ]);
    expect(calls[6]?.args.slice(-1)).toEqual(["Enter"]);
  });

  it("returns busy when Antigravity verify overlay appears during the pre-nudge wait", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const slept: number[] = [];
    let captures = 0;
    const runner: TmuxRunner = async (args) => {
      calls.push({ args });
      if (args[0] === "display-message") return ok("0\tagy\t0\n");
      if (args[0] === "capture-pane") {
        captures += 1;
        if (captures === 1) return ok(promptFor("antigravity"));
        return ok(
          "⚠ Verifying your account...\nWe're finishing verifying your account eligibility.\nPlease try again shortly.\n> Accept-edits mode: file edits auto-approved\n"
        );
      }
      return ok();
    };
    const controller = new TmuxController(runner, null, null, null, async (ms) => {
      slept.push(ms);
    });
    expect(
      await controller.nudge(
        1,
        { id: "antigravity", root: "/clone", launcher: "start-antigravity.sh", delivery: "both", harnessProcess: "agy" },
        "/runtime/action.md"
      )
    ).toMatchObject({ status: "busy" });
    expect(slept).toEqual([NUDGE_BEFORE_ANTIGRAVITY_MS]);
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "capture-pane", "capture-pane"]);
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
    ).toMatchObject({ status: "busy" });
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
    ).toMatchObject({ status: "busy" });
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
    ).toMatchObject({ status: "busy" });
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
    ).toMatchObject({ status: "sent" });
  });

  it("does not insert while the owner is in pane mode or the harness is gone", async () => {
    const busy = new TmuxController(async () => ok("0\tclaude\t1\n"), null, null, null, noopSleep);
    expect(
      await busy.nudge(
        1,
        { id: "claude", root: "/clone", launcher: "start-claude.sh", delivery: "nudge", harnessProcess: "claude" },
        "/a"
      )
    ).toMatchObject({ status: "busy" });
    const gone = new TmuxController(async () => ({ exitCode: 1, stdout: "", stderr: "missing" }), null, null, null, noopSleep);
    expect(
      await gone.nudge(1, { id: "claude", root: "/clone", launcher: "start-claude.sh", delivery: "nudge" }, "/a")
    ).toMatchObject({ status: "gone" });
  });

  it("does not inject when pane_input_off is set", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(async (args) => {
      calls.push({ args });
      if (args[0] === "display-message") return ok("0\tagent\t0\t1\n");
      return ok();
    }, null, null, null, noopSleep);
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/a"
      )
    ).toMatchObject({ status: "busy" });
    expect(calls.some((call) => call.args[0] === "send-keys")).toBe(false);
  });

  it("rechecks pane mode before each key and stops if it changes", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    let inspects = 0;
    const controller = new TmuxController(
      async (args) => {
        calls.push({ args });
        if (args[0] === "display-message") {
          inspects += 1;
          // Initial readiness and the gate before the text succeed; the gate
          // before Enter sees copy-mode.
          if (inspects >= 3) return ok("0\tagent\t1\t0\n");
          return ok("0\tagent\t0\t0\n");
        }
        if (args[0] === "capture-pane") return ok(promptFor("cursor"));
        return ok();
      },
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        { id: "cursor", root: "/clone", launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toMatchObject({ status: "busy" });
    const sent = calls.filter((call) => call.args[0] === "send-keys");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.args[1]).toBe("-l");
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

describe("runTmux", () => {
  it("resolves when tmux exits before reading stdin", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-tmux-epipe-"));
    roots.push(root);
    writeFileSync(join(root, "tmux"), "#!/bin/sh\nexit 3\n", { mode: 0o700 });
    const previousPath = process.env.PATH;
    process.env.PATH = `${root}${previousPath === undefined ? "" : `:${previousPath}`}`;
    try {
      const result = await runTmux(["-V"], "x".repeat(4 * 1024 * 1024));
      expect(result.exitCode).toBe(3);
      expect(result.stderr).toContain("EPIPE");
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });
});
