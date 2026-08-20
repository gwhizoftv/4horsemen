import { describe, expect, it } from "vitest";
import { detachAllOwnerUiSync, detachIssue, discoverCoordIssues } from "../src/detachIssue.js";
import type { TmuxResult, TmuxRunner } from "../src/tmux.js";

const ok = (stdout = ""): TmuxResult => ({ exitCode: 0, stdout, stderr: "" });

describe("detachIssue", () => {
  it("closes Terminal windows before killing tmux so titles still match", async () => {
    const order: string[] = [];
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "list-sessions") return ok("coord-2\n");
      if (args[0] === "kill-session") {
        order.push(`kill:${args[2] ?? ""}`);
        return ok();
      }
      return ok();
    };
    await detachIssue({
      issue: 2,
      agentIds: ["claude"],
      tmuxRunner: runner,
      terminalCloser: (titles) => {
        order.push(`close:${titles.join(",")}`);
      },
      log: () => undefined
    });
    expect(order).toEqual(["close:coord-2/claude", "kill:coord-2"]);
  });

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
  it("discovers issues from tmux only when a namespace scopes the names", () => {
    expect(discoverCoordIssues(["coord-1", "coord-1-claude", "coord-2-cursor", "other"])).toEqual([1, 2]);
    const killed: string[] = [];
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor"],
      tmuxNamespace: "abc12def00",
      listSessions: () => ["coord-1-abc12def00", "coord-1-abc12def00-claude", "coord-1-abc12def00-cursor"],
      killSession: (name) => {
        killed.push(name);
      },
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(killed).toEqual(["coord-1-abc12def00", "coord-1-abc12def00-claude", "coord-1-abc12def00-cursor"]);
    expect(outcome.killedSessions).toEqual(killed);
    expect(closed).toEqual(["coord-1-abc12def00/claude", "coord-1-abc12def00/cursor"]);
    expect(outcome.terminalClose).toBe("closed");
  });

  it("does not kill another product's un-namespaced sessions when issues are listed", () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "codex", "cursor", "antigravity"],
      terminalGroup: "625172f2b5",
      issues: [1],
      listSessions: () => [
        "coord-1",
        "coord-1-claude",
        "coord-385",
        "coord-385-claude",
        "coord-385-codex",
        "coord-385-cursor",
        "coord-385-antigravity"
      ],
      killSession: (name) => {
        killed.push(name);
      },
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual(["coord-1", "coord-1-claude"]);
    expect(closed).toEqual([
      "coord-1-625172f2b5/claude",
      "coord-1-625172f2b5/codex",
      "coord-1-625172f2b5/cursor",
      "coord-1-625172f2b5/antigravity"
    ]);
    expect(closed.join(" ")).not.toContain("coord-385");
  });

  it("does not discover un-namespaced coord sessions when no issue list is given", () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor"],
      listSessions: () => ["coord-385", "coord-385-claude"],
      killSession: (name) => {
        killed.push(name);
      },
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(killed).toEqual([]);
    expect(closed).toEqual([]);
    expect(outcome.killedSessions).toEqual([]);
    expect(outcome.terminalClose).toBe("skipped");
  });

  it("closes only unique grouped title ids when terminalGroup is set", () => {
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor"],
      terminalGroup: "abc12def00",
      issues: [1],
      listSessions: () => ["coord-1", "coord-1-claude"],
      killSession: () => undefined,
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(closed).toEqual(["coord-1-abc12def00/claude", "coord-1-abc12def00/cursor"]);
    expect(closed).not.toContain("claude");
    expect(closed).not.toContain("coord-1/claude");
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

describe("manual detach", () => {
  it("closes manual titles before killing exact grouped sessions", async () => {
    const order: string[] = [];
    const runner: import("../src/tmux.js").TmuxRunner = async (args) => {
      if (args[0] === "list-sessions") {
        return {
          exitCode: 0,
          stdout: "coord-manual-abc123\ncoord-manual-abc123-claude\ncoord-manual-def456\ncoord-76-abc123\n",
          stderr: ""
        };
      }
      if (args[0] === "kill-session") {
        order.push(`kill:${args[2]}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const outcome = await detachIssue({
      issue: "manual",
      agentIds: ["claude", "cursor"],
      terminalGroup: "abc123",
      tmuxRunner: runner,
      terminalCloser: (titles) => {
        order.push(`close:${titles.join(",")}`);
      },
      log: () => undefined
    });
    expect(order[0]?.startsWith("close:")).toBe(true);
    expect(outcome.closedTerminalTitles).toEqual([
      "coord-manual-abc123/claude",
      "coord-manual-abc123/cursor"
    ]);
    expect(outcome.killedSessions).toEqual(["coord-manual-abc123", "coord-manual-abc123-claude"]);
    expect(outcome.killedSessions.join(" ")).not.toContain("def456");
    expect(outcome.killedSessions.join(" ")).not.toContain("coord-76");
  });

  it("tears down manual UI on uninstall with no issue directories", () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "cursor"],
      terminalGroup: "abc123",
      issues: [],
      includeManual: true,
      listSessions: () => ["coord-manual-abc123", "coord-manual-abc123-claude", "coord-manual-other"],
      killSession: (name) => {
        killed.push(name);
      },
      terminalCloser: (titles) => {
        closed.push(...titles);
      },
      log: () => undefined
    });
    expect(killed).toEqual(["coord-manual-abc123", "coord-manual-abc123-claude"]);
    expect(closed).toEqual(["coord-manual-abc123/claude", "coord-manual-abc123/cursor"]);
    expect(killed.join(" ")).not.toContain("other");
    expect(outcome.terminalClose).toBe("closed");
  });

  it("keeps discoverCoordIssues digits-only when manual sessions are present", () => {
    expect(
      discoverCoordIssues(["coord-1", "coord-manual-abc123", "coord-2-abc", "coord-manual-abc123-claude"])
    ).toEqual([1, 2]);
  });
});
