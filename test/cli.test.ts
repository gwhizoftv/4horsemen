import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAction } from "../src/action.js";
import { runCli, type CliRunLoop } from "../src/cli.js";
import { agentRuntimePaths, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import { readCursorsState, readStartState } from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-cli-"));
  roots.push(root);
  for (const agent of ["codex", "claude"]) mkdirSync(join(root, `clone-${agent}`));
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      project: "fixture",
      origin: join(root, "origin.git"),
      agents: [
        { id: "codex", root: "clone-codex", launcher: "start-codex.sh", delivery: "pull" },
        { id: "claude", root: "clone-claude", launcher: "start-claude.sh", delivery: "pull" }
      ],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      checks: [{ name: "check", argv: ["node", "-e", "process.exit(0)"] }],
      pollIntervalMs: 100
    })
  );
  return { root, configPath, runtime: join(root, "runtime") };
};

const fakeLoop = (paths: ReturnType<typeof issueRuntimePaths>): CliRunLoop => ({
  initializeEffects: async () => undefined,
  runTick: async () => readCursorsState(paths),
  run: async () => undefined
});

describe("CLI", () => {
  it("requires an explicit external coord root at start", async () => {
    const fixture = setup();
    const messages: string[] = [];
    const result = await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath], {
      io: { stderr: (message) => messages.push(message) }
    });
    expect(result).toBe(2);
    expect(messages.join("")).toContain("--coord-root is required");
  });

  it("starts from the exact origin baseline and exposes only the caller action", async () => {
    const fixture = setup();
    const output: string[] = [];
    const result = await runCli(
      ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime],
      {
        io: { cwd: process.cwd(), stdout: (message) => output.push(message) },
        processRunner: async () => ({ exitCode: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n`, stderr: "" }),
        makeRunLoop: fakeLoop
      }
    );
    expect(result).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    expect(readStartState(paths).baselineSha).toBe("a".repeat(40));
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const runtime = agentRuntimePaths(paths, "codex");
    writeAction(paths.coordRoot, runtime.action, buildOrder(paths, start, cursors, "codex", "R1.join", null));

    output.length = 0;
    expect(
      await runCli(["next", "--issue", "1", "--coord-root", fixture.runtime, "--agent", "codex"], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    const action = output.join("");
    expect(action).toContain("requiredPath: .signals/issue-1/joined-codex.json");
    expect(action).not.toContain("stepId:");
    expect(action).not.toContain("evidence:");
    expect(action).not.toContain("gate-");
    expect(readFileSync(runtime.action, "utf8")).toBe(action);
  });

  it("refuses to drop the final active agent", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: async () => ({ exitCode: 0, stdout: `${"a".repeat(40)}\trefs/heads/main\n`, stderr: "" }),
      makeRunLoop: fakeLoop
    });
    const errors: string[] = [];
    const result = await runCli(["drop", "codex", "--issue", "1", "--coord-root", fixture.runtime], {
      io: { stderr: (message) => errors.push(message) },
      makeRunLoop: fakeLoop
    });
    expect(result).toBe(2);
    expect(errors.join("")).toContain("final active agent");
  });
});
