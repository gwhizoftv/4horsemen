import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  EXIT_OK,
  EXIT_REFUSED,
  EXIT_STATE,
  EXIT_USAGE,
  parseArgs,
  runCli,
  usage,
  type CliDeps
} from "../src/cli.js";
import { runTick } from "../src/runLoop.js";
import { activeAgents, readJournal, saveCursors } from "../src/state.js";
import { createWorkspace, loopDeps, type Workspace } from "./harness.js";

const workspaces: Workspace[] = [];
const scratch: string[] = [];

const newWorkspace = (...args: Parameters<typeof createWorkspace>): Workspace => {
  const workspace = createWorkspace(...args);

  workspaces.push(workspace);

  return workspace;
};

afterEach(() => {
  while (workspaces.length > 0) {
    workspaces.pop()?.cleanup();
  }

  while (scratch.length > 0) {
    const dir = scratch.pop();

    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

type Captured = { out: string; err: string; deps: CliDeps };

const capture = (): Captured => {
  const captured: Captured = {
    out: "",
    err: "",
    deps: {
      io: {
        stdout: (text) => {
          captured.out += text;
        },
        stderr: (text) => {
          captured.err += text;
        }
      },
      now: () => "2026-08-11T04:00:00Z",
      git: () => ({ status: 0, stdout: Buffer.from("a".repeat(40)), stderr: "" })
    }
  };

  return captured;
};

const base = (workspace: Workspace): string[] => ["--coord-root", workspace.root, "--issue", "1"];

describe("argument parsing", () => {
  it("prints usage with no arguments", async () => {
    const captured = capture();

    expect(await runCli([], captured.deps)).toBe(EXIT_OK);
    expect(captured.out).toContain("coord — owner-side workflow driver");
  });

  it("states that the coordinator can never merge", () => {
    expect(usage()).toContain("never merge");
  });

  it("rejects an unknown flag", () => {
    expect(parseArgs(["run", "--wat", "x"])).toEqual({ ok: false, error: "unknown flag --wat" });
  });

  it("rejects a flag with no value", () => {
    expect(parseArgs(["run", "--issue"])).toEqual({ ok: false, error: "--issue requires a value" });
    expect(parseArgs(["run", "--issue", "--agent"])).toEqual({ ok: false, error: "--issue requires a value" });
  });

  it("separates positionals from flags", () => {
    const parsed = parseArgs(["drop", "codex", "--issue", "1"]);

    expect(parsed.ok).toBe(true);

    if (parsed.ok) {
      expect(parsed.value).toEqual({ command: "drop", positional: ["codex"], flags: { issue: "1" } });
    }
  });

  it("exits with a usage code on an unknown command", async () => {
    const captured = capture();

    expect(await runCli(["frobnicate"], captured.deps)).toBe(EXIT_USAGE);
    expect(captured.err).toContain("unknown command");
  });
});

describe("required --coord-root", () => {
  it("refuses every stateful command without it", async () => {
    for (const command of ["run", "next", "answer", "drop", "pause", "resume", "restart-action", "abandon"]) {
      const captured = capture();

      expect(await runCli([command, "--issue", "1"], captured.deps)).toBe(EXIT_USAGE);
      expect(captured.err).toContain("--coord-root");
    }
  });

  it("refuses start without it", async () => {
    const captured = capture();

    expect(await runCli(["start", "1", "--profile", "solo", "--config", "x.json"], captured.deps)).toBe(
      EXIT_USAGE
    );
  });

  it("refuses a control root inside a configured clone", async () => {
    const parent = mkdtempSync(join(tmpdir(), "coord-cli-"));

    scratch.push(parent);

    const clone = join(parent, "coordination-claude");
    const configPath = join(parent, "config.json");

    writeFileSync(
      configPath,
      JSON.stringify({ project: "coordination", agents: [{ id: "claude", root: clone }] })
    );

    const captured = capture();
    const code = await runCli(
      ["start", "1", "--profile", "solo", "--config", configPath, "--coord-root", join(clone, "coord")],
      captured.deps
    );

    expect(code).toBe(EXIT_REFUSED);
    expect(captured.err).toContain("inside the configured clone");
  });

  it("reports missing state rather than creating it", async () => {
    const empty = mkdtempSync(join(tmpdir(), "coord-empty-"));

    scratch.push(empty);

    const captured = capture();

    expect(await runCli(["pause", "--coord-root", empty, "--issue", "1"], captured.deps)).toBe(EXIT_STATE);
  });

  it("rejects a non-positive issue", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["pause", "--coord-root", workspace.root, "--issue", "0"], captured.deps)).toBe(
      EXIT_USAGE
    );
  });
});

describe("coord next", () => {
  it("prints 'none yet' before an action exists", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["next", ...base(workspace), "--agent", "claude"], captured.deps)).toBe(EXIT_OK);
    expect(captured.out.trim()).toBe("none yet");
  });

  it("prints the calling agent's action once it exists", async () => {
    const workspace = newWorkspace();

    runTick(workspace.state, loopDeps(workspace));

    const captured = capture();

    expect(await runCli(["next", ...base(workspace), "--agent", "claude"], captured.deps)).toBe(EXIT_OK);
    expect(captured.out).toContain("agent: claude");
    expect(captured.out).toContain(".signals/issue-1/joined-claude.json");
  });

  it("exposes no peer, step, gate, evidence, or global phase state", async () => {
    const workspace = newWorkspace();

    runTick(workspace.state, loopDeps(workspace));

    const captured = capture();

    await runCli(["next", ...base(workspace), "--agent", "claude"], captured.deps);

    for (const forbidden of ["R1.join", "gate-1-join", "join-published", "stepId", "gateId", "attempt"]) {
      expect(captured.out).not.toContain(forbidden);
    }

    for (const peer of ["codex", "cursor", "antigravity"]) {
      expect(captured.out).not.toContain(peer);
    }
  });

  it("requires an agent identity", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["next", ...base(workspace)], captured.deps)).toBe(EXIT_USAGE);
    expect(captured.err).toContain("--agent");
  });

  it("refuses an agent that is not part of the run", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["next", ...base(workspace), "--agent", "stranger"], captured.deps)).toBe(EXIT_USAGE);
  });
});

describe("coord drop", () => {
  it("drops an agent and reports who remains", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["drop", "codex", ...base(workspace)], captured.deps)).toBe(EXIT_OK);
    expect(captured.out).toContain("dropped codex");
    expect(captured.out).toContain("antigravity, claude, cursor");

    const reloaded = workspace.reload();

    expect(reloaded.cursors.droppedAgents).toEqual(["codex"]);
    expect(activeAgents(reloaded.start, reloaded.cursors)).not.toContain("codex");
  });

  it("journals the drop", async () => {
    const workspace = newWorkspace();

    await runCli(["drop", "codex", ...base(workspace)], capture().deps);

    const events = readJournal(workspace.state.paths.journal);

    expect(events.some((event) => event.kind === "owner-drop" && event.agent === "codex")).toBe(true);
  });

  it("reports that it is ignoring a pending completion from the dropped agent", async () => {
    const workspace = newWorkspace();

    writeFileSync(workspace.state.paths.completeFile("codex"), `${"a".repeat(40)}\n`);

    const captured = capture();

    await runCli(["drop", "codex", ...base(workspace)], captured.deps);

    expect(captured.out).toContain("ignoring a pending completion from codex");
  });

  it("refuses to drop the final active agent", async () => {
    const workspace = newWorkspace({ roster: ["claude", "codex"] });

    await runCli(["drop", "codex", ...base(workspace)], capture().deps);

    const captured = capture();

    expect(await runCli(["drop", "claude", ...base(workspace)], captured.deps)).toBe(EXIT_REFUSED);
    expect(captured.err).toContain("last active agent");

    const reloaded = workspace.reload();

    expect(activeAgents(reloaded.start, reloaded.cursors)).toEqual(["claude"]);
  });

  it("supports a run that started with one agent", async () => {
    const workspace = newWorkspace({ roster: ["claude"], profile: "solo" });
    const captured = capture();

    expect(await runCli(["drop", "claude", ...base(workspace)], captured.deps)).toBe(EXIT_REFUSED);
  });

  it("is idempotent for an already-dropped agent", async () => {
    const workspace = newWorkspace();

    await runCli(["drop", "codex", ...base(workspace)], capture().deps);

    const captured = capture();

    expect(await runCli(["drop", "codex", ...base(workspace)], captured.deps)).toBe(EXIT_OK);
    expect(captured.out).toContain("already dropped");
  });

  it("refuses to drop an agent that is not part of the run", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["drop", "stranger", ...base(workspace)], captured.deps)).toBe(EXIT_USAGE);
  });

  it("names the agent to drop", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["drop", ...base(workspace)], captured.deps)).toBe(EXIT_USAGE);
  });
});

describe("pause, resume, restart-action, abandon, answer", () => {
  it("pauses and resumes durably", async () => {
    const workspace = newWorkspace();

    expect(await runCli(["pause", ...base(workspace)], capture().deps)).toBe(EXIT_OK);
    expect(workspace.reload().cursors.paused).toBe(true);

    expect(await runCli(["resume", ...base(workspace)], capture().deps)).toBe(EXIT_OK);
    expect(workspace.reload().cursors.paused).toBe(false);
  });

  it("leaves actions, cursors, and mirror state in place when pausing", async () => {
    const workspace = newWorkspace();

    runTick(workspace.state, loopDeps(workspace));

    const action = readFileSync(workspace.state.paths.actionFile("claude"), "utf8");

    await runCli(["pause", ...base(workspace)], capture().deps);

    expect(readFileSync(workspace.state.paths.actionFile("claude"), "utf8")).toBe(action);
    expect(workspace.reload().cursors.agents["claude"]?.stepId).toBe("R1.join");
  });

  it("restart-action clears only the calling agent's current action state", async () => {
    const workspace = newWorkspace();

    runTick(workspace.state, loopDeps(workspace));

    expect(await runCli(["restart-action", ...base(workspace), "--agent", "claude"], capture().deps)).toBe(
      EXIT_OK
    );

    const reloaded = workspace.reload();

    expect(reloaded.cursors.agents["claude"]?.stepId).toBeNull();
    expect(reloaded.cursors.agents["codex"]?.stepId).toBe("R1.join");
  });

  it("abandon marks the run and says state is left in place", async () => {
    const workspace = newWorkspace();
    const captured = capture();

    expect(await runCli(["abandon", ...base(workspace)], captured.deps)).toBe(EXIT_OK);
    expect(captured.out).toContain("left in place");
    expect(workspace.reload().cursors.abandoned).toBe(true);
  });

  it("answer records the owner's message in the journal", async () => {
    const workspace = newWorkspace();

    expect(
      await runCli(["answer", ...base(workspace), "--message", "use codex's plan"], capture().deps)
    ).toBe(EXIT_OK);

    const events = readJournal(workspace.state.paths.journal);
    const answer = events.find((event) => event.kind === "owner-answer");

    expect(answer?.detail["message"]).toBe("use codex's plan");
  });

  it("answer requires a message", async () => {
    const workspace = newWorkspace();

    expect(await runCli(["answer", ...base(workspace)], capture().deps)).toBe(EXIT_USAGE);
  });
});

describe("coord run", () => {
  it("stops after the requested number of ticks", async () => {
    const workspace = newWorkspace();
    const captured = capture();
    const deps: CliDeps = { ...captured.deps, loopDeps: () => loopDeps(workspace) };

    expect(
      await runCli(["run", ...base(workspace), "--max-ticks", "1", "--poll-ms", "0"], deps)
    ).toBe(EXIT_OK);
    expect(captured.out).toContain("stopped");
  });

  it("reports awaiting owner when the run is abandoned", async () => {
    const workspace = newWorkspace();

    workspace.state.cursors = { ...workspace.state.cursors, abandoned: true };
    saveCursors(workspace.state, "2026-08-11T04:00:00Z");

    const captured = capture();
    const deps: CliDeps = { ...captured.deps, loopDeps: () => loopDeps(workspace) };

    expect(await runCli(["run", ...base(workspace), "--max-ticks", "1", "--poll-ms", "0"], deps)).toBe(
      EXIT_OK
    );
    expect(captured.out).toContain("awaiting owner");
  });
});

describe("no merge capability", () => {
  it("has no merge command", async () => {
    const captured = capture();

    expect(await runCli(["merge"], captured.deps)).toBe(EXIT_USAGE);
  });

  it("never invokes a merge", () => {
    // The word "merge" appears in the usage text that documents the
    // prohibition, so assert on invocations rather than on the word.
    for (const file of ["../src/cli.ts", "../src/runLoop.ts", "../src/mirror.ts"]) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");

      expect(source).not.toMatch(/["']merge["']/);
      expect(source).not.toMatch(/git\s+merge\b/);
      expect(source).not.toMatch(/pr\s+merge/i);
      expect(source).not.toMatch(/mergePullRequest|merge_pull_request/);
    }
  });
});
