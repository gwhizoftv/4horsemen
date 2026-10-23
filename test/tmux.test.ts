import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentClientAttachCommand,
  harnessLooksReady,
  harnessPromptReadiness,
  nudgePreludeKeys,
  paneActivityDigest,
  pendingPromptInComposer,
  ownerTerminalCloseAppleScript,
  ownerTerminalOpenAppleScript,
  ownerTerminalWindowTitle,
  ownerTerminalTitlesToClose,
  readCursorVimMode,
  resolveAgentLauncher,
  NUDGE_BEFORE_ANTIGRAVITY_MS,
  renderNudgeText,
  resolveNudgeKeys,
  runTmux,
  TmuxController,
  vimInsertPrelude,
  type TmuxResult,
  type TmuxRunner
} from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });
const commandsIn = (args: readonly string[]): string[][] => {
  const commands: string[][] = [[]];
  for (const arg of args) {
    if (arg === ";") commands.push([]);
    else commands.at(-1)!.push(arg);
  }
  return commands;
};
const noopSleep = async (): Promise<void> => undefined;
const harnessPromptReady = (paneText: string, agentId: string): boolean => harnessPromptReadiness(paneText, agentId).ready;
/** Measured Muse Code 1.4.10 tail: transcript, voice-input rule, composer, rule and status footer. */
const musePane = (above: string, composer = ""): string =>
  `  Muse Code 1.4.10\n${above}── Voice input (alt(option)+v to start) ──────────\n❯${composer === "" ? "" : ` ${composer}`}\n` +
  "──────────────────────────────────────────────────\n  muse-wonder-1.0 · high · /clone · Launch overrides\n";
/** The idle line agents used to print; it is no longer evidence of anything. */
const COORD_IDLE_SENTINEL = "COORD-IDLE: waiting for the next coordinator action file";

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
it("reports per-agent tmux placement and missing Terminal windows read-only", async () => {
  const calls: string[][] = [];
  const panes: Record<string, string> = {
    "coord-7:claude.0": "0\t/clones/claude\n",
    "coord-7:codex.0": "1\t/clones/codex\t\tKILL\t/logs/codex/run-1.log\n",
    "coord-7:cursor.0": "0\t/elsewhere\n",
    "coord-7:antigravity.0": "0\t\n"
  };
  const runner: TmuxRunner = async (args) => {
    calls.push([...args]);
    const output = panes[args[3] ?? ""];
    return output === undefined ? { exitCode: 1, stdout: "", stderr: "can't find pane" } : ok(output);
  };
  const agents = ["claude", "codex", "cursor", "antigravity", "gemini"].map((id) =>
    ({ id, root: `/clones/${id}`, launcher: `start-${id}.sh`, delivery: "both" as const }));
  const tmux = new TmuxController(runner, null, null, null, noopSleep, "grp", (titles) => titles.filter((title) => !title.includes("codex")));
  const lines = await tmux.agentPlacementDiagnostics(7, agents);
  expect(lines).toContain("[OK] claude: running in coord-7:claude.0.");
  const exited = lines.find((line) => line.startsWith("[WARN] codex: the pane"));
  expect(exited).toContain("has exited (signal KILL; this alone does not show why)");
  expect(exited).toContain("output log: /logs/codex/run-1.log");
  expect(lines.find((line) => line.startsWith("[WARN] cursor"))).toContain("started in /elsewhere, not its clone /clones/cursor");
  expect(lines).toContain("[OK] antigravity: running in coord-7:antigravity.0 (start directory unknown).");
  expect(lines.find((line) => line.startsWith("[WARN] gemini"))).toContain("no window in tmux session coord-7");
  expect(lines.find((line) => line.startsWith("[WARN] codex: no Terminal window"))).toContain("coord attach 7");
  expect(calls.every((args) => args[0] === "display-message")).toBe(true);
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
      return "codex ready\n› \n? for shortcuts\n";
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

  it("rechecks usage wait before the batch without reserving a send", async () => {
    const blockedCapture = 2;
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
    expect(result).toMatchObject({ status: "busy", reason: "claude-usage-wait", stage: "prompt" });
    expect(keys).not.toContain("Enter");
    expect(reservations).toBe(0);
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
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "capture-pane", "display-message", "send-keys"]);
    expect(calls[3]?.args).toEqual([
      "send-keys", "-l", "-t", "coord-1:cursor.0",
      `Read and execute coordinator action 11111111-1111-4111-8111-111111111111 digest ${"a".repeat(64)} at /runtime/action.md`,
      ";", "run-shell", "sleep 0.3",
      ";", "send-keys", "-t", "coord-1:cursor.0", "Enter"
    ]);
    expect(slept).toEqual([]);
  });

  it.each(["claude", "cursor"])("submits %s vim INSERT with gaps after text and Escape in one batch", async (id) => {
    const root = mkdtempSync(join(tmpdir(), "coord-cursor-vim-nudge-"));
    roots.push(root);
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor/cli.json"), `${JSON.stringify({ editor: { vimMode: true } })}\n`);
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(
      runnerWithPrompt(calls, "0\tagent\t0\t0\n", `${id === "claude" ? "❯" : "Auto ·"}\n-- INSERT --\n`),
      null,
      null,
      null,
      noopSleep
    );
    expect(
      await controller.nudge(
        1,
        { id, root, launcher: `start-${id}.sh`, delivery: "both", harnessProcess: "agent" },
        "/runtime/action.md"
      )
    ).toMatchObject({ status: "sent" });
    const sent = calls.filter((call) => call.args[0] === "send-keys");
    expect(sent).toHaveLength(1);
    expect(commandsIn(sent[0]!.args)).toEqual([
      ["send-keys", "-l", "-t", `coord-1:${id}.0`, "Read and execute your current coordinator action at /runtime/action.md"],
      ["run-shell", "sleep 0.3"],
      ["send-keys", "-t", `coord-1:${id}.0`, "Escape"],
      ["run-shell", "sleep 0.15"],
      ["send-keys", "-t", `coord-1:${id}.0`, "Enter"]
    ]);
    expect(calls.at(-1)).toBe(sent[0]);
    expect(sent.some((call) => call.args.includes("a"))).toBe(false);
  });

  it("gives Cursor's vim a its own gap before the text when the pane is not INSERT", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-cursor-vim-prelude-"));
    roots.push(root);
    mkdirSync(join(root, ".cursor"));
    writeFileSync(join(root, ".cursor/cli.json"), `${JSON.stringify({ editor: { vimMode: true } })}\n`);
    const calls: Array<{ args: readonly string[] }> = [];
    const controller = new TmuxController(runnerWithPrompt(calls, "0\tagent\t0\t0\n", "Auto ·\n"), null, null, null, noopSleep);
    expect(
      await controller.nudge(1, { id: "cursor", root, launcher: "start-cursor.sh", delivery: "both", harnessProcess: "agent" }, "/runtime/action.md")
    ).toMatchObject({ status: "sent" });
    const sent = calls.filter((call) => call.args[0] === "send-keys");
    expect(sent).toHaveLength(1);
    expect(commandsIn(sent[0]!.args)).toEqual([
      ["send-keys", "-t", "coord-1:cursor.0", "a"],
      ["run-shell", "sleep 0.15"],
      ["send-keys", "-l", "-t", "coord-1:cursor.0", " Read and execute your current coordinator action at /runtime/action.md"],
      ["run-shell", "sleep 0.3"],
      ["send-keys", "-t", "coord-1:cursor.0", "Escape"],
      ["run-shell", "sleep 0.15"],
      ["send-keys", "-t", "coord-1:cursor.0", "Enter"]
    ]);
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

  it("keeps Muse nudges and owner reminders free of vim preludes and Escape", () => {
    const agent = { id: "muse", root: "/m", launcher: "start-muse.sh", delivery: "both" as const };
    expect(vimInsertPrelude("> ", "muse")).toEqual([]);
    expect(resolveNudgeKeys(agent, "> ")).toEqual({ prelude: [], submit: ["Enter"] });
    expect(resolveNudgeKeys({ ...agent, nudgePrelude: [], nudgeSubmit: ["Enter"] }, "> "))
      .toEqual({ prelude: [], submit: ["Enter"] });
    // Escape interrupts a Muse turn, so stale or hand-written config never sends it.
    expect(resolveNudgeKeys({ ...agent, nudgePrelude: ["Escape"], nudgeSubmit: ["Escape", "Enter"] }, "> "))
      .toEqual({ prelude: [], submit: ["Enter"] });
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
    const batches = calls.filter((call) => call.args[0] === "send-keys");
    expect(batches).toHaveLength(1);
    expect(commandsIn(batches[0]!.args).map((args) => args.at(-1))).toEqual([
      "Read and execute your current coordinator action at /runtime/action.md", "sleep 0.3", "Enter"
    ]);
    for (const nudgeSubmit of [["Enter"], ["C-m"], ["C-j", "C-m"]]) {
      expect(resolveNudgeKeys({ id: "codex", root: "/c", launcher: "x", delivery: "both", nudgeSubmit }).submit).toEqual(["Enter"]);
    }
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
    const batches = calls.filter((call) => call.args[0] === "send-keys");
    expect(batches).toHaveLength(1);
    expect(commandsIn(batches[0]!.args)).toEqual([
      ["send-keys", "-l", "-t", "coord-1:codex.0", "Read and execute your current coordinator action at /a"],
      ["run-shell", "sleep 0.3"],
      ["send-keys", "-t", "coord-1:codex.0", "Enter"]
    ]);
  });

  it("uses Claude's installed editor mode without typing a literal prelude in normal mode", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-claude-editor-"));
    roots.push(root);
    const agent = { id: "claude", root, launcher: "start-claude.sh", delivery: "both" as const };
    const path = join(root, ".claude/settings.local.json");
    expect(resolveNudgeKeys(agent, "❯").prelude).toEqual(["a"]);
    mkdirSync(join(root, ".claude"));
    writeFileSync(path, JSON.stringify({ editorMode: "normal" }));
    expect(resolveNudgeKeys(agent, "❯")).toEqual({ prelude: [], submit: ["Escape", "Enter"] });
    expect(resolveNudgeKeys({ ...agent, nudgePrelude: ["Escape"] }, "❯").prelude).toEqual(["Escape"]);
    writeFileSync(path, JSON.stringify({ editorMode: "vim" }));
    expect(resolveNudgeKeys(agent, "❯").prelude).toEqual(["a"]);
    expect(resolveNudgeKeys(agent, "❯\n-- INSERT --").prelude).toEqual([]);
    writeFileSync(path, "invalid json");
    expect(resolveNudgeKeys(agent, "❯").prelude).toEqual(["a"]);
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
          "tmux new-session -A -s coord-7-claude -t coord-7 ';' select-window -t claude ';' set-option destroy-unattached on" +
          " ';' set-option -t coord-7-claude history-limit 50000 ';' set-option -t coord-7-claude mouse on" +
          " ';' set-option -w -q -t coord-7-claude:claude pane-scrollbars on",
        terminalProfile: "Pro",
        windowTitle: "coord-7/claude"
      },
      {
        agentId: "codex",
        command:
          "tmux new-session -A -s coord-7-codex -t coord-7 ';' select-window -t codex ';' set-option destroy-unattached on" +
          " ';' set-option -t coord-7-codex history-limit 50000 ';' set-option -t coord-7-codex mouse on",
        terminalProfile: "Grass",
        windowTitle: "coord-7/codex"
      }
    ]);
    expect(agentClientAttachCommand("coord-7", "cursor")).toContain("set-option -w -q -t coord-7-cursor:cursor pane-scrollbars on");
    for (const id of ["antigravity", "gemini"]) {
      const command = agentClientAttachCommand("coord-7", id);
      expect(command).toContain(`set-option -t coord-7-${id} history-limit 50000`);
      expect(command).not.toMatch(/mouse|pane-scrollbars| -g /);
    }
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
    let paneDead = "1";
    const runner: TmuxRunner = async (args) => {
      calls.push([...args]);
      if (args[0] === "has-session") return { exitCode: 0, stdout: "", stderr: "" };
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
    await controller.ensureSession(3, [agent]);
    expect(calls.some((args) => args[0] === "new-window")).toBe(true);
    // The window starts on a silent placeholder; the agent replaces it only after retention is set.
    expect(calls.find((args) => args[0] === "new-window")!.at(-1)).toBe("sleep 60");
    const launch = commandsIn(calls.find((args) => args.includes("respawn-pane"))!);
    expect(launch[0]).toEqual(["set-option", "-w", "-t", "coord-3:claude", "remain-on-exit", "on"]);
    expect(launch).toContainEqual(["set-option", "-w", "-q", "-t", "coord-3:claude", "pane-scrollbars", "on"]);
    expect(launch.at(-1)).toEqual(["respawn-pane", "-k", "-t", "coord-3:claude", "-c", clone, join(clone, "start-claude.sh")]);
    expect(calls).toContainEqual(["set-environment", "-t", "coord-3", "COORD_ISSUE", "3"]);
    // A COORD_MANUAL=1 leaked from the tmux server would disarm the git shim.
    expect(calls).toContainEqual(["set-environment", "-r", "-t", "coord-3", "COORD_MANUAL"]);
    const fresh: string[][] = [];
    await new TmuxController(async (args) => {
      fresh.push([...args]);
      return args[0] === "has-session" ? { exitCode: 1, stdout: "", stderr: "missing" } : ok();
    }, null, null, null).startSession(4, [agent]);
    expect(fresh).toContainEqual(["set-environment", "-r", "-t", "coord-4", "COORD_MANUAL"]);
    expect(fresh.findIndex((args) => args.includes("history-limit"))).toBeLessThan(fresh.findIndex((args) => args[0] === "new-window"));
    expect(fresh.flatMap(commandsIn)).toContainEqual(["set-option", "-t", "coord-4", "history-limit", "50000"]);
    calls.length = 0;
    await controller.ensureSession(3, [agent]);
    // Exit details are read before the dead pane is held on the placeholder, then relaunched.
    expect(calls.filter((args) => ["list-panes", "respawn-pane"].includes(args[0]!) || args.includes("remain-on-exit")).map((args) => args[0]))
      .toEqual(["list-panes", "respawn-pane", "set-option"]);
    expect(calls.find((args) => args[0] === "respawn-pane")!.at(-1)).toBe("sleep 60");
    calls.length = 0;
    await controller.ensureSession(3, [agent]);
    expect(calls.some((args) => args[0] === "new-window" || args[0] === "respawn-pane")).toBe(false);
    expect(calls.flatMap(commandsIn)).toEqual(expect.arrayContaining([
      ["set-option", "-t", "coord-3", "history-limit", "50000"],
      ["set-option", "-t", "coord-3", "mouse", "on"],
      ["set-option", "-t", "coord-3-claude", "history-limit", "50000"],
      ["set-option", "-t", "coord-3-claude", "mouse", "on"],
      ["set-option", "-w", "-q", "-t", "coord-3:claude", "pane-scrollbars", "on"]
    ]));
    expect(calls.some((args) => args.includes("-g") || args[0] === "bind-key")).toBe(false);
  });

  it("ignores unavailable scrollbars but fails required scrolling options", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-scroll-"));
    roots.push(root);
    writeFileSync(join(root, "start-claude.sh"), "#!/bin/sh\n", { mode: 0o700 });
    const agent = { id: "claude", root, launcher: "start-claude.sh", delivery: "both" as const };
    const calls: string[][] = [];
    let failHistory = false;
    const controller = new TmuxController(async (args) => {
      calls.push([...args]);
      if (args[0] === "has-session") return { exitCode: 1, stdout: "", stderr: "missing" };
      if (args.includes("history-limit") && failHistory) return { exitCode: 1, stdout: "", stderr: "cannot set history" };
      for (const command of commandsIn(args)) {
        if (command.includes("pane-scrollbars") && !command.includes("-q")) return { exitCode: 1, stdout: "", stderr: "invalid option" };
      }
      return ok();
    }, null, null, null);
    await controller.startSession(4, [agent]);
    expect(calls.some((args) => args.includes("respawn-pane"))).toBe(true);
    calls.length = 0;
    failHistory = true;
    await expect(controller.startSession(5, [agent])).rejects.toThrow("cannot set history");
    expect(calls).toContainEqual(["kill-session", "-t", "coord-5"]);
    expect(calls.some((args) => args[0] === "new-window")).toBe(false);
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
    expect(calls.flatMap(commandsIn)).toContainEqual(["set-option", "-t", "coord-manual-abc12def00", "history-limit", "50000"]);
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
    expect(calls.some((args) => args.includes("COORD_MANUAL") && args.includes("-r"))).toBe(false);
    expect(calls.filter((args) => args[0] === "new-window")).toHaveLength(1);
    // Manual sessions have no issue runtime: panes are retained but not piped.
    const manualLaunch = commandsIn(calls.find((args) => args.includes("respawn-pane"))!);
    expect(manualLaunch).toContainEqual(["set-option", "-w", "-t", "coord-manual-abc12def00:claude", "remain-on-exit", "on"]);
    expect(manualLaunch.some((command) => command[0] === "pipe-pane")).toBe(false);

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
    expect(harnessLooksReady("muse-bin-1.4.10", "muse")).toBe(true);
    expect(harnessLooksReady("muse-bin-1.4.7-R6101.1", "muse")).toBe(true);
    expect(harnessLooksReady("node", "muse")).toBe(false);
    expect(harnessLooksReady("bash", "muse")).toBe(false);
  });

  it("reads measured Muse panes: a running turn keeps its composer but is not ready", () => {
    expect(harnessPromptReadiness(musePane(""), "muse")).toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReady(musePane("❯ earlier prompt\n◆ Ran command · Sleep · ✓ · 20s · ctrl+o\n◆ done\n"), "muse")).toBe(true);
    for (const chrome of ["◈ Thinking (0s · esc to interrupt)\n",
      "◇ Running command · Sleep for twenty seconds — running (7s · esc to interrupt)\n└ (ctrl+alt(option)+b to send to background)\n"]) {
      expect(harnessPromptReadiness(musePane(`❯ earlier prompt\n${chrome}`), "muse")).toEqual({ ready: false, reason: "muse-turn-chrome" });
    }
    expect(harnessPromptReadiness("  Muse Code 1.4.10\nLoading…\n", "muse")).toEqual({ ready: false, reason: "muse-no-prompt" });
    // Anything below the status footer, such as a menu, is an unknown tail.
    expect(harnessPromptReadiness(`${musePane("")}/help   Show help\n/model  Switch model\n`, "muse"))
      .toEqual({ ready: false, reason: "muse-no-prompt" });
    // So is a missing or replaced footer, including Muse's transient steering notice.
    const tail = "── Voice input (alt(option)+v to start) ──\n❯\n──────────────────────────────\n";
    for (const footer of ["", "Press Enter to confirm deletion\n", "  muse-wonder-1.0 steering th…\n"]) {
      expect(harnessPromptReadiness(`  Muse Code 1.4.10\n${tail}${footer}`, "muse")).toEqual({ ready: false, reason: "muse-no-prompt" });
    }
  });

  it("reads Muse's shortened and clipped busy lines in a measured 30-column pane", () => {
    const narrow = (above: string): string => `❯ Run exactly: sleep 12 ; then\n  reply ok.\n${above}── Voice input (alt(option)+…\n` +
      "❯\n──────────────────────────────\n  muse-wonder-1.0 · high · na…\n";
    expect(harnessPromptReadiness(narrow("◆ done\n"), "muse")).toEqual({ ready: true, reason: "vendor-prompt" });
    for (const busy of ["◇ Thinking (0s · esc to interr\n", "runn… (24s · esc to interrupt)\n└ (ctrl+b to send to backgrou…\n",
      "◇ Thinking (1m 04s · esc to interrupt)\n"]) {
      expect(harnessPromptReadiness(narrow(busy), "muse")).toEqual({ ready: false, reason: "muse-turn-chrome" });
    }
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
    // A finished Muse reply that mentions the interrupt hint is prose; only the live timer is chrome.
    expect(harnessPromptReady(musePane("◆ Completed the review; use esc to interrupt a running turn\n"), "muse")).toBe(true);
    expect(harnessPromptReady(musePane("◆ Muse paints `esc to interrupt` while a turn runs\n"), "muse")).toBe(true);
    expect(harnessPromptReady(musePane("◇ Thinking (0s\n"), "muse")).toBe(false);
  });

  it("names the predicate that refused a prompt", () => {
    expect(harnessPromptReadiness(`Workspace Trust Required\nDo you trust the contents of this directory?\n` +
      `a Trust this workspace\nq Quit\n${COORD_IDLE_SENTINEL}`, "cursor"))
      .toEqual({ ready: false, reason: "trust-dialog" });
    // Cursor 2026.10 renders a rounded box, a warning icon, and keyed options.
    expect(harnessPromptReadiness(`  │  ⚠ Workspace Trust Required  │\n` +
      `  │  Do you trust the contents of this directory?  │\n  │  ▶ [a] Trust this workspace  │\n` +
      `  │    [q] Quit  │\n${COORD_IDLE_SENTINEL}`, "cursor"))
      .toEqual({ ready: false, reason: "trust-dialog" });
    expect(harnessPromptReadiness("Do you trust this folder?", "claude")).toEqual({
      ready: false,
      reason: "trust-dialog"
    });
    // An idle agent that quoted the dialog in prose is not on the dialog.
    expect(harnessPromptReadiness("The tmux check now matches workspace trust required screens.\n" +
      `> \n${COORD_IDLE_SENTINEL}`, "cursor").reason).not.toBe("trust-dialog");
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

  it("no longer treats the retired idle line as evidence of a prompt", () => {
    const action = "11111111-2222-3333-4444-555555555555";
    expect(harnessPromptReadiness(`working on ${action}\n${COORD_IDLE_SENTINEL}`, "claude")).toEqual({
      ready: false,
      reason: "claude-no-prompt"
    });
    expect(harnessPromptReadiness(`Antigravity CLI\n${COORD_IDLE_SENTINEL}`, "antigravity")).toEqual({
      ready: false,
      reason: "antigravity-no-prompt"
    });
  });

  it("digests only the pane above the composer, so drafts and footers are not activity", () => {
    const pane = (spinner: string, draft: string, footer: string) =>
      `⏺ Reviewing the plan\n${spinner}\n────\n❯ ${draft}\n────\n  ${footer}`;
    const base = paneActivityDigest(pane("✻ Thinking… (45s)", "", "? for shortcuts"));
    expect(paneActivityDigest(pane("✻ Thinking… (45s)", "owner draft", "12:01 · context 40%"))).toBe(base);
    expect(paneActivityDigest(`${esc}[2m${pane("✻ Thinking… (45s)", "", "? for shortcuts")}${esc}[0m`)).toBe(base);
    expect(paneActivityDigest(pane("✻ Thinking… (46s)", "", "? for shortcuts"))).not.toBe(base);
    expect(paneActivityDigest("no composer\nline")).not.toBe(paneActivityDigest("no composer\nline 2"));
  });

  it("finds this action's unsent prompt in the Codex composer or the pane tail", () => {
    const action = "11111111-2222-3333-4444-555555555555";
    const prompt = `Read and execute coordinator action ${action} digest ${"a".repeat(64)} at /a`;
    expect(pendingPromptInComposer(codexPane("• done", prompt), "codex", action)).toBe(true);
    expect(pendingPromptInComposer(codexPane("• done", "owner draft"), "codex", action)).toBe(false);
    // An action mentioned only above the composer was already submitted.
    expect(pendingPromptInComposer(codexPane(`› ${prompt}\n• Working on it`, ""), "codex", action)).toBe(false);
    // Cursor wraps the prompt across lines, splitting the UUID.
    expect(pendingPromptInComposer(`Auto · 1%\n→ Read and execute coordinator action 11111111-2222-\n  3333-4444-555555555555 at /a\nRun Everything`,
      "cursor", action)).toBe(true);
    expect(pendingPromptInComposer(`${prompt}\n1\n2\n3\n4\n5\n6`, "cursor", action)).toBe(false);
    // An already-submitted prompt above an empty composer is history, not a pending prompt.
    expect(pendingPromptInComposer(`❯ ${prompt}\n⎿ API Error: overloaded\n❯ \n  ? for shortcuts`, "claude", action)).toBe(false);
    expect(pendingPromptInComposer(`→ ${prompt}\nRequest failed\n→ Plan, search, build anything\nAuto · 1%`, "cursor", action)).toBe(false);
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

  it("vetoes a live Codex turn but not prose about one, and ignores the retired idle line", () => {
    expect(harnessPromptReadiness(codexPane("• Working (2m 27s • esc to interrupt)\n  └ Tip: run ! commands"), "codex"))
      .toEqual({ ready: false, reason: "codex-turn-chrome" });
    expect(harnessPromptReadiness(codexPane("• I saw `Working (2s • esc to interrupt)` earlier."), "codex"))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}\n\n${turnSummary}`), "codex"))
      .toEqual({ ready: true, reason: "vendor-prompt" });
    expect(harnessPromptReadiness(codexPane(`• ${COORD_IDLE_SENTINEL}\n\n  Worked for 3s\n• Working (1s • esc to interrupt)`), "codex"))
      .toEqual({ ready: false, reason: "codex-turn-chrome" });
  });

  it("sends a Codex nudge only while keystroke safety holds before its batch", async () => {
    const agent = { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "both" as const, harnessProcess: "codex" };
    const action = "11111111-2222-3333-4444-555555555555";
    // A minimal Codex: typed text lands in the composer; `onCapture` lets a test change the pane between keys.
    const attempt = async (options: {
      body?: string; draft?: string; vim?: string; gate?: string; resend?: boolean;
      onCapture?: (index: number, pane: { body: string; draft: string }) => void;
    } = {}) => {
      const pane = { body: options.body ?? "• done", draft: options.draft ?? "" };
      const keys: string[] = [];
      let captures = 0;
      const controller = new TmuxController(async (args) => {
        if (args[0] === "display-message") return ok(options.gate ?? "0\tcodex\t0\t0\n");
        if (args[0] === "capture-pane") {
          options.onCapture?.(captures++, pane);
          return ok(codexPane(pane.body, pane.draft, options.vim));
        }
        if (args.includes("send-keys")) {
          for (const command of commandsIn(args)) {
            if (command[0] === "send-keys") keys.push(command.at(-1)!);
          }
        }
        return ok();
      }, null, null, null, noopSleep);
      const outcome = await controller.nudge(1, agent, "/a", undefined, action, "a".repeat(64), undefined, { resend: options.resend });
      return { outcome, keys };
    };
    const prompt = `Read and execute coordinator action ${action} digest ${"a".repeat(64)} at /a`;
    expect(await attempt({ draft: "Owner draft" })).toMatchObject({ outcome: { status: "busy", reason: "codex-composer-not-ready" }, keys: [] });
    expect(await attempt({ body: "Trust this folder?" })).toMatchObject({ outcome: { status: "busy", reason: "trust-dialog" }, keys: [] });
    for (const [gate, reason] of [["0\tbash\t0\t0\n", "foreground-mismatch"], ["0\tcodex\t1\t0\n", "owner-typing"], ["0\tcodex\t0\t1\n", "input-off"]]) {
      expect(await attempt({ gate })).toMatchObject({ outcome: { status: "busy", reason }, keys: [] });
    }
    // Codex queues a prompt typed mid-turn: its Enter-only submit is sent despite live turn chrome.
    expect(await attempt({ onCapture: (index, pane) => { if (index === 1) pane.body = "• Working (1s • esc to interrupt)"; } }))
      .toMatchObject({ outcome: { status: "sent" }, keys: [prompt, "Enter"] });
    // The owner starts a draft before the first key: nothing is typed.
    expect(await attempt({ onCapture: (index, pane) => { if (index === 1) pane.draft = "owner draft"; } }))
      .toMatchObject({ outcome: { status: "busy", reason: "codex-composer-not-ready", stage: "prompt" }, keys: [] });
    expect(await attempt()).toMatchObject({ outcome: { status: "sent" }, keys: [prompt, "Enter"] });
    expect((await attempt()).outcome).not.toHaveProperty("detail");
    // A vim prelude key that lands in the composer anyway stays apart from the prompt.
    expect(await attempt({ vim: "Normal" })).toMatchObject({ outcome: { status: "sent" }, keys: ["i", ` ${prompt}`, "Enter"] });
    // A resend names the shortcut; a prompt still in the composer is submitted, never typed twice.
    expect((await attempt({ resend: true })).keys[0]).toBe(`If you already wrote complete for this action, only write its ready file. ${prompt}`);
    expect(await attempt({ draft: prompt, vim: "Normal", resend: true }))
      .toMatchObject({ outcome: { status: "sent", detail: "pending-prompt-submitted" }, keys: ["Enter"] });
  });

  it.each(["Insert", "Normal"])("sends Codex text and Enter once in %s mode without waiting for paint", async (vim) => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const controller = new TmuxController(async (args) => {
      calls.push([...args]);
      if (args[0] === "display-message") return ok("0\tcodex\t0\t0");
      if (args[0] === "capture-pane") return ok(codexPane("done", "", vim));
      return ok();
    }, null, null, null, async (ms) => { sleeps.push(ms); });
    expect(await controller.nudge(1, { id: "codex", root: "/clone", launcher: "codex", delivery: "both" }, "/a"))
      .toMatchObject({ status: "sent" });
    const sends = calls.filter((args) => args[0] === "send-keys");
    expect(sends).toHaveLength(1);
    expect(commandsIn(sends[0]!).map((args) => args.includes("-l") ? "-l" : args.at(-1)))
      .toEqual(vim === "Normal" ? ["i", "sleep 0.15", "-l", "sleep 0.3", "Enter"] : ["-l", "sleep 0.3", "Enter"]);
    expect(calls.at(-1)).toBe(sends[0]);
    expect(sleeps).toEqual([]);
  });

  it.each(["claude", "cursor"])("types a %s resend when its earlier prompt is only history above an empty composer", async (id) => {
    const action = "11111111-2222-3333-4444-555555555555";
    const sent: string[] = [];
    const controller = new TmuxController(async (args) => {
      if (args[0] === "display-message") return ok(`0\t${id}\t0\t0`);
      if (args[0] === "capture-pane") return ok(`❯ Read and execute coordinator action ${action} at /a\nRequest failed\n${promptFor(id)}❯ \n`);
      if (args.includes("send-keys")) sent.push(...commandsIn(args).filter((command) => command.includes("-l")).map((command) => command.at(-1)!));
      return ok();
    }, null, null, null, noopSleep);
    expect(await controller.nudge(1, { id, root: "/clone", launcher: id, delivery: "both", nudgePrelude: [] },
      "/a", undefined, action, undefined, undefined, { resend: true })).toMatchObject({ status: "sent" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain(`coordinator action ${action}`);
  });

  it.each([
    { id: "cursor", pane: "Thinking…\nAuto · 1%\nRun Everything", vim: false, sent: true },
    { id: "cursor", pane: "Thinking…\nAuto · 1%\nRun Everything", vim: true, sent: false },
    { id: "cursor", pane: "", vim: false, sent: false }
  ])("sends to $id mid-turn only when no Escape is typed and the pane is readable (vim=$vim, pane=$pane)", async ({ id, pane, vim, sent }) => {
    const calls: string[][] = [];
    const controller = new TmuxController(async (args) => {
      calls.push([...args]);
      if (args[0] === "display-message") return ok(`0\t${id}\t0\t0`);
      if (args[0] === "capture-pane") return pane === "" ? { exitCode: 1, stdout: "", stderr: "no pane" } : ok(pane);
      return ok();
    }, null, null, null, noopSleep);
    const outcome = await controller.nudge(1, { id, root: "/clone", launcher: id, delivery: "both", ...(vim ? { nudgePrelude: ["a"] } : {}) }, "/a");
    expect(outcome).toMatchObject(sent ? { status: "sent" }
      : { status: "busy", reason: pane === "" ? "pane-capture-unavailable" : "cursor-turn-chrome" });
    expect(calls.some((args) => args.includes("send-keys"))).toBe(sent);
  });

  it.each(["claude", "cursor"])("submits a %s prompt still sitting in the pane tail without typing it again", async (id) => {
    const action = "11111111-2222-3333-4444-555555555555";
    const calls: string[][] = [];
    const controller = new TmuxController(async (args) => {
      calls.push([...args]);
      if (args[0] === "display-message") return ok(`0\t${id}\t0\t0`);
      if (args[0] === "capture-pane") return ok(`${promptFor(id)}❯ Read and execute coordinator action ${action} at /a\n`);
      return ok();
    }, null, null, null, noopSleep);
    expect(await controller.nudge(1, { id, root: "/clone", launcher: id, delivery: "both", nudgePrelude: [] },
      "/a", undefined, action, undefined, undefined, { resend: true }))
      .toMatchObject({ status: "sent", detail: "pending-prompt-submitted" });
    // A submit-only batch begins with its pre-submit sleep.
    const keys = calls.filter((args) => args.includes("send-keys")).flatMap(commandsIn).filter((command) => command[0] === "send-keys");
    expect(keys.some((command) => command.includes("-l"))).toBe(false);
    expect(keys.at(-1)?.at(-1)).toBe("Enter");
  });

  describe("Muse automatic delivery", () => {
    const action = "11111111-2222-3333-4444-555555555555";
    const digest = "f".repeat(64);
    const current = renderNudgeText("/a", action, digest);
    const hint = "Ask to monitor a running build or log and get pinged on changes";
    const placeholder = `${esc}[38;2;103;108;116m${hint}${esc}[39m`;
    const placeholderPane = musePane("", placeholder).replace("❯ ", `${esc}[0m${esc}[38;2;90;160;255m❯ `);
    /** Later captures repeat the last one; the second is the final pre-send recapture. */
    const museNudge = async (...captures: string[]) => {
      const calls: string[][] = [];
      const controller = new TmuxController(async (args) => {
        calls.push([...args]);
        if (args[0] === "display-message") return ok("0\tmuse-bin-1.4.10\t0\t0");
        if (args[0] === "capture-pane") return ok(captures.length > 1 ? captures.shift()! : captures[0]!);
        return ok();
      }, null, null, null, noopSleep);
      const outcome = await controller.nudge(1, { id: "muse", root: "/clone", launcher: "start-muse.sh", delivery: "both",
        harnessProcess: "muse", nudgePrelude: [], nudgeSubmit: ["Enter"] }, "/a", undefined, action, digest);
      return { outcome, keys: calls.filter((args) => args.includes("send-keys")).flatMap(commandsIn),
        captures: calls.filter((args) => args[0] === "capture-pane").length };
    };

    it.each([
      { state: "an empty composer", pane: musePane("❯ earlier prompt\n◆ done\n") },
      { state: "the measured placeholder", pane: placeholderPane },
      { state: "a wrapped placeholder", pane: placeholderPane.replace("build or log", "build\n  or log") },
      { state: "a placeholder with background and underline colors", pane: placeholderPane.replace(hint,
        `${esc}[48;2;0;2;0m${esc}[58;5;0m${hint}`) }
    ])("types the action and Enter over $state, with no prelude or Escape", async ({ pane }) => {
      const { outcome, keys } = await museNudge(pane);
      expect(outcome).toMatchObject({ status: "sent", reason: "sent" });
      expect(keys.map((args) => args.includes("-l") ? "-l" : args.at(-1))).toEqual(["-l", "sleep 0.3", "Enter"]);
      expect(keys.find((args) => args.includes("-l"))?.at(-1)).toBe(current);
    });

    it.each([
      { style: "normal foreground", sgr: "38;2;204;211;219" },
      { style: "no ANSI", sgr: null },
      { style: "dim only", sgr: "2" },
      { style: "an unmeasured gray", sgr: "38;2;104;108;116" },
      { style: "placeholder RGB as background", sgr: "48;2;103;108;116" },
      { style: "placeholder RGB as underline color", sgr: "58;2;103;108;116" }
    ])("protects the same hint typed with $style", async ({ sgr }) => {
      const draft = sgr === null ? hint : `${esc}[${sgr}m${hint}${esc}[0m`;
      const { outcome, keys } = await museNudge(musePane("", draft));
      expect(outcome).toMatchObject({ status: "busy", reason: "muse-composer-not-ready" });
      expect(keys).toEqual([]);
    });

    it.each(["39", "0", "", "37", "97", "38;5;2", "38;2;204;211;219", "38;2;0;2;0"])(
      "protects a draft after a placeholder and SGR %s", async (sgr) => {
        const pane = placeholderPane.replace(`${esc}[39m`, `\n  ${esc}[${sgr}mowner draft text`);
        const { outcome, keys } = await museNudge(pane);
        expect(outcome).toMatchObject({ status: "busy", reason: "muse-composer-not-ready" });
        expect(keys).toEqual([]);
      }
    );

    it("recaptures the placeholder before sending and protects a replacement draft", async () => {
      const { outcome, keys, captures } = await museNudge(placeholderPane, musePane("", "owner draft text"));
      expect(captures).toBe(2);
      expect(outcome).toMatchObject({ status: "busy", reason: "muse-composer-not-ready", stage: "prompt" });
      expect(keys).toEqual([]);
    });

    it.each([
      { state: "an owner draft", pane: musePane("", "owner draft text"), reason: "muse-composer-not-ready" },
      { state: "a draft before placeholder-colored text", pane: musePane("", `owner draft text ${placeholder}`),
        reason: "muse-composer-not-ready" },
      { state: "a draft quoting the action id", pane: musePane("", `please look at ${action} later`), reason: "muse-composer-not-ready" },
      { state: "this action's prompt for an older digest", pane: musePane("", renderNudgeText("/a", action, "0".repeat(64))),
        reason: "muse-composer-not-ready" },
      { state: "a running turn", pane: musePane("◈ Thinking (2s · esc to interrupt)\n"), reason: "muse-turn-chrome" },
      { state: "a running turn with a placeholder", pane: musePane("◈ Thinking (2s · esc to interrupt)\n", placeholder),
        reason: "muse-turn-chrome" },
      { state: "a draft typed before the final recapture", pane: [musePane(""), musePane("", "owner draft text")],
        reason: "muse-composer-not-ready" },
      { state: "a turn started before the final recapture", pane: [musePane(""), musePane("◈ Thinking (0s · esc to interrupt)\n")],
        reason: "muse-turn-chrome" },
      // The batch chosen from the first capture would retype the prompt, or press a bare Enter.
      { state: "this action's prompt typed before the final recapture", pane: [musePane(""), musePane("", current)],
        reason: "muse-composer-not-ready" },
      { state: "a pending prompt submitted before the final recapture", pane: [musePane("", current), musePane("")],
        reason: "muse-composer-not-ready" }
    ])("sends nothing over $state", async ({ pane, reason }) => {
      const { outcome, keys } = await museNudge(...(Array.isArray(pane) ? pane : [pane]));
      expect(outcome).toMatchObject({ status: "busy", reason });
      expect(keys).toEqual([]);
    });

    it.each([false, true])("submits this action's pending prompt without retyping it (wrapped=%s)", async (wrapped) => {
      const pending = wrapped ? current.replace(" digest ", "\n  digest ") : current;
      const { outcome, keys } = await museNudge(musePane("", pending));
      expect(outcome).toMatchObject({ status: "sent", detail: "pending-prompt-submitted" });
      expect(keys.some((args) => args.includes("-l"))).toBe(false);
      expect(keys.at(-1)?.at(-1)).toBe("Enter");
    });
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

  it("rechecks pane mode before the batch and stops if it changes", async () => {
    const calls: Array<{ args: readonly string[] }> = [];
    let inspects = 0;
    const controller = new TmuxController(
      async (args) => {
        calls.push({ args });
        if (args[0] === "display-message") {
          inspects += 1;
          // Copy-mode appears between initial readiness and the batch.
          if (inspects >= 2) return ok("0\tagent\t1\t0\n");
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
    expect(sent).toHaveLength(0);
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

const tmuxInstalled = spawnSync("tmux", ["-V"]).status === 0;

it("flushes partial terminal chunks and keeps bytes ordered between timestamp prefixes", async () => {
  const root = mkdtempSync(join(tmpdir(), "coord-log-chunks-"));
  roots.push(root);
  writeFileSync(join(root, "start-claude.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  let pipe = "";
  const controller = new TmuxController(async (args) => {
    if (args[0] === "has-session") return { exitCode: 1, stdout: "", stderr: "" };
    for (const command of commandsIn(args)) {
      if (command[0] === "pipe-pane") pipe = command.at(-1)!;
    }
    return ok();
  }, null, null, null, noopSleep);
  const logs = join(root, "logs");
  await controller.startSession(3, [{ id: "claude", root, launcher: "start-claude.sh", delivery: "both" }], () => logs);
  // Exercise the actual recorder command after tmux's quoting expansion. The
  // isolated tmux test below checks that expansion through the real server.
  const child = spawn("/bin/sh", ["-c", pipe.replaceAll("%%", "%").replaceAll("##", "#")]);
  const closed = new Promise<number | null>((resolveClose) => child.on("close", resolveClose));
  const output = () => readFileSync(join(logs, readdirSync(logs)[0]!), "utf8");
  try {
    child.stdin.write("prompt without newline");
    await expect.poll(output).toMatch(/\.\d{3}Z prompt without newline$/);
    child.stdin.write(" continued\r\nnext\n\n\u001b[2J");
    child.stdin.end();
    expect(await closed).toBe(0);
    const recorded = output();
    const stamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /gm;
    expect(recorded.match(stamp)).toHaveLength(4);
    expect(recorded.replace(stamp, "")).toBe("prompt without newline continued\r\nnext\n\n\u001b[2J");
  } finally {
    child.kill();
  }
});

describe.skipIf(!tmuxInstalled)("isolated tmux exit diagnostics", () => {
  it("keeps cleared startup output and exit details across relaunch and teardown", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-tmux-diag-"));
    roots.push(root);
    const clone = join(root, "clone");
    // A legal directory name that tmux would expand as a format if it reached pipe-pane unescaped.
    const logs = join(root, "terminal-#{pane_id}-%Y");
    mkdirSync(clone);
    const socket = `coord-test-${process.pid}-${Date.now()}`;
    const runner: TmuxRunner = (args, input) => runTmux(["-L", socket, "-f", "/dev/null", ...args], input);
    const controller = new TmuxController(runner, null, null, null, noopSleep, "grp", null);
    const agent = { id: "claude", root: clone, launcher: "start-claude.sh", delivery: "both" as const };
    const logDir = () => logs;
    const pause = (ms: number) => new Promise((resolvePause) => setTimeout(resolvePause, ms));
    const run = async (name: string, exit: string, launch: () => Promise<void>): Promise<void> => {
      // Print a startup dialogue, then wipe it from the screen the way a TUI does before exiting.
      writeFileSync(
        join(clone, "start-claude.sh"),
        `#!/bin/sh\nexec /bin/sh -c 'printf "${name} startup dialogue"; while [ ! -f "${root}/${name}.continue" ]; do sleep 0.05; done; printf "\\n\\033[?1049h\\033[2J\\033[H"; ${exit}'\n`,
        { mode: 0o700 }
      );
      await launch();
      // A live prompt must reach the log before a newline or process exit.
      await expect.poll(() => readFileSync(runLog(name), "utf8"), { timeout: 4000 })
        .toMatch(new RegExp(`\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z ${name} startup dialogue$`));
      writeFileSync(join(root, `${name}.continue`), "");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (!(await controller.inspectPane(controller.target(3, agent.id))).alive) return;
        await pause(50);
      }
      throw new Error(`${name} run did not exit`);
    };
    const runLog = (name: string): string => {
      const file = readdirSync(logs).find((entry) => entry.endsWith(".log") && readFileSync(join(logs, entry), "utf8").includes(`${name} startup dialogue`));
      if (file === undefined) throw new Error(`no log for the ${name} run`);
      return join(logs, file);
    };
    let advertisedLog = "";
    const exitOf = (name: string) => JSON.parse(readFileSync(runLog(name).replace(/\.log$/, ".exit.json"), "utf8")) as { status: number | null; signal: string | null };
    try {
      // An inherited hook that blocks the command queue must not let a fast agent escape recording.
      await runner(["new-session", "-d", "-s", "hook-holder"]);
      const unrelated = ["display-message", "-p", "-t", "hook-holder", "#{mouse} #{history_limit} #{pane-scrollbars}"];
      const unrelatedBefore = await runner(unrelated);
      await runner(["set-hook", "-g", "after-new-window", "run-shell 'sleep 0.2'"]);
      await run("first", "exit 0", () => controller.startSession(3, [agent], logDir));
      expect((await runner(["display-message", "-p", "-t", "coord-3:claude", "#{mouse} #{history_limit}"])).stdout.trim()).toBe("1 50000");
      // A pre-upgrade linked client stays open during resume and must be repaired too.
      await runner(["new-session", "-d", "-s", "coord-3-claude", "-t", "coord-3"]);
      await runner(["set-option", "-t", "coord-3-claude", "mouse", "off"]);
      await run("second", "exit 3", () => controller.ensureSession(3, [agent], undefined, logDir));
      expect((await runner(["show-options", "-v", "-t", "coord-3-claude", "mouse"])).stdout.trim()).toBe("on");
      expect((await runner(["show-options", "-v", "-t", "coord-3-claude", "history-limit"])).stdout.trim()).toBe("50000");
      const scrollbar = await runner(["show-options", "-wqv", "-t", "coord-3:claude", "pane-scrollbars"]);
      if (scrollbar.stdout.trim() !== "") expect(scrollbar.stdout.trim()).toBe("on");
      expect(await runner(unrelated)).toEqual(unrelatedBefore);
      await run("third", "kill -KILL $$", () => controller.ensureSession(3, [agent], undefined, logDir));
      const advertised = (await controller.agentPlacementDiagnostics(3, [agent])).join("\n").match(/output log: (.+?\.log);/)?.[1];
      expect(advertised).toBe(join(logs, advertised!.slice(logs.length + 1)));
      advertisedLog = advertised!;
      await controller.killIssueSessions(3);
      // The recorder drains each pipe asynchronously; wait for all three runs.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          ["first", "second", "third"].forEach(runLog);
          break;
        } catch {
          await pause(50);
        }
      }
    } finally {
      await runner(["kill-server"]);
    }
    expect(readdirSync(logs).filter((entry) => entry.endsWith(".log"))).toHaveLength(3);
    // Each relaunch wrote a new log; the earlier runs keep their dialogue and the clear that followed it.
    for (const name of ["first", "second", "third"]) {
      const contents = readFileSync(runLog(name), "utf8");
      expect(contents).toContain("\u001b[2J");
      for (const line of contents.split("\n").filter(Boolean)) {
        expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
      }
    }
    expect(readFileSync(advertisedLog, "utf8")).toContain("third startup dialogue");
    expect(exitOf("first")).toMatchObject({ status: 0, signal: null });
    expect(exitOf("second")).toMatchObject({ status: 3, signal: null });
    expect(exitOf("third")).toMatchObject({ status: null, signal: expect.any(String) });
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

describe("explicit owner reminder transport", () => {
  it.each([undefined, "Insert", "Normal"])("sends Codex's insert key only with a visible Normal footer (%s)", async (mode) => {
    const calls: Array<{ args: readonly string[] }> = [];
    const pane = `› \n? for shortcuts${mode === undefined ? "" : ` · Vim: ${mode}`}\n`;
    const controller = new TmuxController(runnerWithPrompt(calls, "0\tcodex\t0\t0\n", pane), null, null, null, noopSleep);
    const agent = { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "both" as const };
    expect(await controller.remind(1, agent, "owner reminder")).toMatchObject({ status: "sent" });
    const keys = calls.filter((call) => call.args[0] === "send-keys").flatMap((call) => commandsIn(call.args));
    expect(keys.some((args) => args.at(-1) === "i")).toBe(mode === "Normal");
    expect(keys.find((args) => args.includes("-l"))?.at(-1)).toBe(mode === "Normal" ? " owner reminder" : "owner reminder");
  });

  it.each(["claude", "codex", "cursor", "antigravity"])("sends to %s despite automatic configuration and pane vetoes", async (id) => {
    const calls: string[][] = [];
    const controller = new TmuxController(async (args) => {
      calls.push([...args]);
      if (args[0] === "display-message") return ok("0\tbash\t1\t1");
      if (args[0] === "capture-pane") return ok("trust this folder\nWorking... esc to cancel\nVerifying your account\n› unfinished draft");
      return ok();
    }, undefined, undefined, undefined, noopSleep);
    const agent = { id, root: "/clone", launcher: id, delivery: "pull" as const, harnessProcess: id, nudgePrelude: [] };
    expect(await controller.nudge(1, agent, "/action.md")).toMatchObject({ status: "disabled" });
    const text = "The operator requested this literal reminder.";
    expect(await controller.remind(1, agent, text)).toEqual({ status: "sent", reason: "sent", stage: "complete" });
    const keys = calls.filter((args) => args[0] === "send-keys").flatMap(commandsIn);
    expect(keys[0]?.slice(-2)).toEqual(["-X", "cancel"]);
    expect(keys.filter((args) => args.includes("-l"))).toHaveLength(1);
    // Only Claude gets a vim prelude here (`a`), so only its text is space-separated.
    expect(keys.find((args) => args.includes("-l"))?.at(-1)).toBe(id === "claude" ? ` ${text}` : text);
    expect(keys.at(-1)?.at(-1)).toBe("Enter");
    if (id !== "antigravity") expect(keys).toContainEqual(["run-shell", "sleep 0.3"]);
  });

  it("uses configured keys when capture is unavailable", async () => {
    const calls: string[][] = [];
    const controller = new TmuxController(async (args) => {
      calls.push([...args]);
      if (args[0] === "display-message") return ok("0\tnode\t0\t0");
      if (args[0] === "capture-pane") throw new Error("capture unavailable");
      return ok();
    }, undefined, undefined, undefined, noopSleep);
    expect(await controller.remind(1, { id: "cursor", root: "/clone", launcher: "agent", delivery: "both", nudgePrelude: ["a"] }, "owner reminder"))
      .toMatchObject({ status: "sent" });
    const keys = calls.filter((args) => args[0] === "send-keys").flatMap(commandsIn);
    expect(keys[0]?.at(-1)).toBe("a");
    expect(keys.map((args) => args.at(-1))).toEqual(["a", "sleep 0.15", " owner reminder", "sleep 0.3", "Escape", "sleep 0.15", "Enter"]);
  });

  it.each(["dead", "inspection-error", "send-error", "authority-change"])("reports %s without claiming acceptance", async (failure) => {
    let began = false;
    const controller = new TmuxController(async (args) => {
      if (args[0] === "display-message") {
        if (failure === "inspection-error") throw new Error("inspection unavailable");
        return ok(`${failure === "dead" ? 1 : 0}\tnode\t0\t0`);
      }
      if (args[0] === "send-keys" && failure === "send-error") return { exitCode: 1, stdout: "", stderr: "target disappeared" };
      return ok();
    }, undefined, undefined, undefined, noopSleep);
    const result = await controller.remind(1, { id: failure === "authority-change" ? "antigravity" : "cursor", root: "/clone", launcher: "agent", delivery: "both" }, "owner reminder",
      () => { if (failure === "authority-change" && began) throw new Error("task changed"); }, () => { began = true; });
    expect(result.status).toBe(["send-error", "authority-change"].includes(failure) ? "uncertain" : "failed");
    expect(result.reason).toBe(failure === "dead" ? "pane-dead" : "delivery-error");
    if (failure === "inspection-error") expect(result.detail).toBe("inspection unavailable");
    if (failure === "send-error") expect(result.detail).toContain("target disappeared");
    if (failure === "authority-change") expect(result.detail).toBe("task changed");
  });
});
