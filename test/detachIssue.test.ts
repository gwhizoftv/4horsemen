import { describe, expect, it } from "vitest";
import { detachIssue } from "../src/detachIssue.js";
import type { TmuxResult, TmuxRunner } from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });

describe("detachIssue", () => {
  it("kills issue tmux sessions and closes matching Terminal titles", async () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "list-sessions") {
        return ok("coord-2\ncoord-2-claude\ncoord-5\n");
      }
      if (args[0] === "kill-session") {
        killed.push(args[2] ?? "");
        return ok();
      }
      return ok();
    };
    const outcome = await detachIssue({
      issue: 2,
      agentIds: ["claude", "codex"],
      tmuxRunner: runner,
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual(["coord-2", "coord-2-claude"]);
    expect(killed).toEqual(["coord-2", "coord-2-claude"]);
    expect(outcome.closedTerminalTitles).toEqual(["coord-2/claude", "coord-2/codex"]);
    expect(closed).toEqual(["coord-2/claude", "coord-2/codex"]);
    expect(outcome.terminalClose).toBe("closed");
  });

  it("dry-run lists sessions and titles without killing or closing", async () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "list-sessions") return ok("coord-2\n");
      if (args[0] === "kill-session") {
        killed.push(args[2] ?? "");
        return ok();
      }
      return ok();
    };
    const outcome = await detachIssue({
      issue: 2,
      agentIds: ["claude"],
      dryRun: true,
      tmuxRunner: runner,
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual(["coord-2"]);
    expect(killed).toEqual([]);
    expect(closed).toEqual([]);
    expect(outcome.terminalClose).toBe("skipped");
  });
});
