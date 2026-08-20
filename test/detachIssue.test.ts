import { describe, expect, it } from "vitest";
import { detachAllOwnerUiSync, detachIssue, discoverCoordIssues } from "../src/detachIssue.js";
import { MANUAL_SESSION_KEY } from "../src/tmux.js";
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

describe("manual owner UI teardown", () => {
  const group = "abc1234567";
  const other = "def7654321";
  const liveSessions = [
    `coord-manual-${group}`,
    `coord-manual-${group}-claude`,
    `coord-manual-${other}`,
    `coord-manual-${other}-claude`,
    "coord-3",
    `coord-3-${group}`
  ];

  it("closes manual Terminal titles before killing the manual tmux session", async () => {
    const order: string[] = [];
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "list-sessions") return ok(`coord-manual-${group}\n`);
      if (args[0] === "kill-session") {
        order.push(`kill:${args[2] ?? ""}`);
        return ok();
      }
      return ok();
    };
    await detachIssue({
      issue: MANUAL_SESSION_KEY,
      agentIds: ["claude"],
      terminalGroup: group,
      tmuxRunner: runner,
      terminalCloser: (titles) => {
        order.push(`close:${titles.join(",")}`);
      },
      log: () => undefined
    });
    expect(order).toEqual([`close:coord-manual-${group}/claude`, `kill:coord-manual-${group}`]);
  });

  it("kills only this workspace's manual sessions, never a peer product's", async () => {
    const killed: string[] = [];
    const runner: TmuxRunner = async (args) => {
      if (args[0] === "list-sessions") return ok(liveSessions.join("\n"));
      if (args[0] === "kill-session") {
        killed.push(args[2] ?? "");
        return ok();
      }
      return ok();
    };
    const outcome = await detachIssue({
      issue: MANUAL_SESSION_KEY,
      agentIds: ["claude", "codex"],
      terminalGroup: group,
      tmuxRunner: runner,
      terminalCloser: () => undefined,
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual([`coord-manual-${group}`, `coord-manual-${group}-claude`]);
    expect(killed).toEqual([`coord-manual-${group}`, `coord-manual-${group}-claude`]);
    expect(outcome.closedTerminalTitles).toEqual([
      `coord-manual-${group}/claude`,
      `coord-manual-${group}/codex`
    ]);
  });

  it("refuses to tear down an ungrouped manual session", async () => {
    await expect(
      detachIssue({
        issue: MANUAL_SESSION_KEY,
        agentIds: ["claude"],
        terminalGroup: null,
        tmuxRunner: async () => ok(),
        terminalCloser: () => undefined,
        log: () => undefined
      })
    ).rejects.toThrow("workspace group");
  });

  it("uninstall clears manual UI for a workspace with no issue directories", () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude", "codex"],
      terminalGroup: group,
      issues: [],
      includeManual: true,
      listSessions: () => liveSessions,
      killSession: (name) => killed.push(name),
      terminalCloser: (titles) => closed.push(...titles),
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual([`coord-manual-${group}`, `coord-manual-${group}-claude`]);
    expect(killed).toEqual([`coord-manual-${group}`, `coord-manual-${group}-claude`]);
    expect(closed).toEqual([`coord-manual-${group}/claude`, `coord-manual-${group}/codex`]);
  });

  it("does not touch another product's manual session", () => {
    const killed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude"],
      terminalGroup: group,
      issues: [],
      includeManual: true,
      listSessions: () => [`coord-manual-${other}`, `coord-manual-${other}-claude`],
      killSession: (name) => killed.push(name),
      terminalCloser: () => undefined,
      log: () => undefined
    });
    expect(outcome.killedSessions).toEqual([]);
    expect(killed).toEqual([]);
  });

  it("skips manual teardown when no workspace group is known", () => {
    const killed: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude"],
      terminalGroup: null,
      issues: [],
      includeManual: true,
      listSessions: () => liveSessions,
      killSession: (name) => killed.push(name),
      terminalCloser: () => undefined,
      log: () => undefined
    });
    expect(outcome).toEqual({ killedSessions: [], closedTerminalTitles: [], terminalClose: "skipped" });
    expect(killed).toEqual([]);
  });

  it("reports a manual dry run without acting", () => {
    const killed: string[] = [];
    const closed: string[] = [];
    const messages: string[] = [];
    const outcome = detachAllOwnerUiSync({
      agentIds: ["claude"],
      terminalGroup: group,
      issues: [],
      includeManual: true,
      dryRun: true,
      listSessions: () => liveSessions,
      killSession: (name) => killed.push(name),
      terminalCloser: (titles) => closed.push(...titles),
      log: (message) => messages.push(message)
    });
    expect(killed).toEqual([]);
    expect(closed).toEqual([]);
    expect(outcome.killedSessions).toEqual([`coord-manual-${group}`, `coord-manual-${group}-claude`]);
    expect(messages.join("")).toContain(`would kill tmux session coord-manual-${group}`);
    expect(messages.join("")).toContain("would close Terminal window(s)");
  });

  it("still tears down issues alongside manual UI, and keeps issue discovery digits-only", () => {
    const killed: string[] = [];
    detachAllOwnerUiSync({
      agentIds: ["claude"],
      terminalGroup: group,
      issues: [3],
      includeManual: true,
      listSessions: () => liveSessions,
      killSession: (name) => killed.push(name),
      terminalCloser: () => undefined,
      log: () => undefined
    });
    expect(killed).toEqual(["coord-3", `coord-3-${group}`, `coord-manual-${group}`, `coord-manual-${group}-claude`]);
    // A manual session is not an issue and must never be discovered as one.
    expect(discoverCoordIssues(liveSessions)).toEqual([3]);
    expect(discoverCoordIssues(liveSessions, group)).toEqual([3]);
  });
});
