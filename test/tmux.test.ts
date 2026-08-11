import { describe, expect, it } from "vitest";
import { TmuxController, type TmuxResult, type TmuxRunner } from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });

describe("tmux boundary", () => {
  it("uses a buffer-based nudge only for the supported Claude harness", async () => {
    const calls: Array<{ args: readonly string[]; input?: string }> = [];
    const runner: TmuxRunner = async (args, input) => {
      calls.push({ args, ...(input === undefined ? {} : { input }) });
      if (args[0] === "display-message") return ok("0\tclaude\t0\n");
      return ok();
    };
    const controller = new TmuxController(runner);
    expect(
      await controller.nudge(
        1,
        { id: "claude", root: "/clone", launcher: "start-claude.sh", delivery: "nudge", harnessProcess: "claude" },
        "/runtime/action.md"
      )
    ).toBe("sent");
    expect(calls.map((call) => call.args[0])).toEqual(["display-message", "load-buffer", "paste-buffer", "send-keys"]);
    expect(calls[1]?.input).toContain("/runtime/action.md");
  });

  it("keeps Codex, Cursor, and Antigravity pull-only", async () => {
    let called = false;
    const controller = new TmuxController(async () => {
      called = true;
      return ok();
    });
    expect(await controller.nudge(1, { id: "codex", root: "/clone", launcher: "start-codex.sh", delivery: "both" }, "/a")).toBe(
      "disabled"
    );
    expect(called).toBe(false);
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
});
