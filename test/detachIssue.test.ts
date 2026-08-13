import { describe, expect, it } from "vitest";
import { detachAllOwnerUiSync, detachIssue, discoverCoordIssues } from "../src/detachIssue.js";
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

describe("detachAllOwnerUiSync", () => {
  it("discovers issues from tmux and closes only scoped coord-N titles", () => {
    expect(discoverCoordIssues(["coord-1", "coord-1-claude", "coord-2-cursor", "other"])).toEqual([1, 2]);
    const killed: string[] = [];
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor"],
      listSessions: () => ["coord-1", "coord-1-claude", "coord-1-cursor"],
      killSession: (name) => {
        killed.push(name);
      },
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(killed).toEqual(["coord-1", "coord-1-claude", "coord-1-cursor"]);
    expect(outcome.killedSessions).toEqual(killed);
    expect(closed).toEqual(["coord-1/claude", "coord-1/cursor"]);
    expect(outcome.terminalClose).toBe("closed");
  });

  it("does not close Terminal windows when no tmux sessions remain", () => {
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor"],
      listSessions: () => [],
      killSession: () => undefined,
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual([]);
    expect(closed).toEqual([]);
    expect(outcome.closedTerminalTitles).toEqual([]);
    expect(outcome.terminalClose).toBe("skipped");
  });

  it("does not discover or kill live tmux when injectors are omitted under Vitest", () => {
    expect(process.env.VITEST).toBeTruthy();
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor", "antigravity"],
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual([]);
    expect(outcome.closedTerminalTitles).toEqual([]);
    expect(outcome.terminalClose).toBe("skipped");
  });
});

describe("detachIssue Vitest safety", () => {
  it("does not call live tmux when tmuxRunner is omitted under Vitest", async () => {
    expect(process.env.VITEST).toBeTruthy();
    const outcome = await detachIssue({
      issue: 99,
      agentIds: ["claude"],
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual([]);
    expect(outcome.terminalClose).toBe("unsupported");
  });
});
