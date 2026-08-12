import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { harnessLooksReady, resolveAgentLauncher, TmuxController, type TmuxResult, type TmuxRunner } from "../src/tmux.js";

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

  it("nudges any agent with nudge or both delivery using a buffer paste", async () => {
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
    expect(calls.map((call) => call.args[0])).toEqual([
      "display-message",
      "send-keys",
      "load-buffer",
      "paste-buffer",
      "send-keys"
    ]);
    expect(calls[1]?.args.slice(1)).toEqual(["-t", "coord-1:cursor.0", "a"]);
    expect(calls[2]?.input).toContain("/runtime/action.md");
    expect(calls[4]?.args.slice(-1)).toEqual(["Enter"]);
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

  it("accepts Claude version strings and Cursor node as ready harnesses", () => {
    expect(harnessLooksReady("2.1.228", "claude")).toBe(true);
    expect(harnessLooksReady("claude", "claude")).toBe(true);
    expect(harnessLooksReady("node", "claude")).toBe(false);
    expect(harnessLooksReady("node", "agent")).toBe(true);
    expect(harnessLooksReady("agent", "agent")).toBe(true);
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
