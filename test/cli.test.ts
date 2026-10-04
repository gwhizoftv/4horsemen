import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAction } from "../src/action.js";
import { automationDigestMaterial, runCli, type CliRunLoop } from "../src/cli.js";
import { agentRuntimePaths, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import {
  cursorsStateSchema,
  readConfig,
  readCursorsState,
  readJournal,
  readStartState,
  writeCursorsState
} from "../src/state.js";
import { DOCTOR_CODES } from "../src/doctor.js";
import { renderGitHubIssueSnapshot } from "../src/githubIssue.js";
import { ensureBuilt, makeProduct, repoRoot, writeDeclaration, type ProductFixture } from "./support/workspaceFixture.js";
import { createHash } from "node:crypto";
import type { AcceptedResponse, BallotBatch } from "../src/state.js";

const roots: string[] = [];
const productFixtures: ProductFixture[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const fixture of productFixtures.splice(0)) fixture.cleanup();
});

const responseDigest = (seed: string): string => createHash("sha256").update(seed, "utf8").digest("hex");
const gitSha = (seed: string): string =>
  createHash("sha256").update(`git:${seed}`, "utf8").digest("hex").slice(0, 40);
const actionIdFor = (agent: string): string => {
  const nibble = (agent.charCodeAt(0) % 10).toString();
  return `10000000-0000-4000-8000-${`${nibble}0`.padStart(12, "0")}`;
};
const acceptedResponseFixture = (input: {
  stepId: AcceptedResponse["stepId"];
  agent: string;
  choice?: string;
  disposition?: AcceptedResponse["disposition"];
  acceptedAt?: string;
  round?: number | null;
}): AcceptedResponse => {
  const actionId = actionIdFor(input.agent);
  return {
    stepId: input.stepId,
    agent: input.agent,
    actionId,
    round: input.round === undefined ? null : input.round,
    responseSha256: responseDigest(input.agent),
    rationale: "fixture rationale",
    path: `/runtime/accepted-responses/${input.agent}/${actionId}.json`,
    acceptedAt: input.acceptedAt ?? "2026-08-11T12:00:00.000Z",
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    ...(input.disposition === undefined ? {} : { disposition: input.disposition })
  };
};
const publishedBallotBatchFixture = (input: {
  kind: BallotBatch["kind"];
  activeRoster: readonly string[];
  round?: number | null;
  commitSha?: string;
  status?: BallotBatch["status"];
  createdAt?: string;
}): BallotBatch => {
  const now = input.createdAt ?? "2026-08-11T12:00:00.000Z";
  const round = input.round === undefined ? null : input.round;
  return {
    batchId: "20000000-0000-4000-8000-000000000001",
    kind: input.kind,
    round,
    inputSetHash: responseDigest("batch"),
    activeRoster: [...input.activeRoster],
    responses: input.activeRoster.map((agent) => ({
      agent,
      actionId: actionIdFor(agent),
      responseSha256: responseDigest(agent)
    })),
    paths: input.activeRoster.map((agent) =>
      input.kind === "plan-ballot-batch"
        ? `.plans/issue-1/ballot-${agent}.json`
        : input.kind === "comparison-ballot-batch"
          ? `.code-reviews/issue-1/ballot-${agent}.json`
          : `.code-reviews/issue-1/consensus-ballot-${agent}-round-${round ?? 1}.json`
    ),
    branch: "issue-1/coordinator-evidence",
    parentSha: gitSha("a"),
    commitSha: input.commitSha ?? gitSha("b"),
    status: input.status ?? "published",
    attempts: 1,
    error: null,
    supersedes: null,
    createdAt: now,
    updatedAt: now
  };
};

const installFormat4JournalFixture = (journalPath: string): void => {
  const raw = readFileSync(join(process.cwd(), "test", "support", "fixtures", "analytics-journal.jsonl"), "utf8");
  writeFileSync(
    journalPath,
    raw
      .split("\n")
      .map((line) => {
        if (line.trim() === "") return line;
        const value = JSON.parse(line) as { formatVersion?: number };
        return JSON.stringify({
          ...value,
          formatVersion: value.formatVersion === 3 ? 4 : value.formatVersion
        });
      })
      .join("\n")
  );
};

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-cli-"));
  roots.push(root);
  for (const agent of ["codex", "claude", "cursor"]) {
    const clone = join(root, `clone-${agent}`);
    mkdirSync(clone);
    writeFileSync(join(clone, `start-${agent}.sh`), "#!/usr/bin/env bash\n", { mode: 0o700 });
  }
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      project: "fixture",
      origin: "https://github.com/example/fixture.git",
      agents: [
        { id: "codex", root: "clone-codex", launcher: "start-codex.sh", delivery: "pull" },
        { id: "claude", root: "clone-claude", launcher: "start-claude.sh", delivery: "pull" },
        { id: "cursor", root: "clone-cursor", launcher: "start-cursor.sh", delivery: "pull" }
      ],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      profile: "consensus",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [],
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

const baselineSha = "a".repeat(40);
const trustedSourceSha = "d".repeat(40);
const issueSnapshot = (issue: number, body = `Body for issue ${issue}`) => ({
  repository: "example/fixture",
  number: issue,
  title: `Issue ${issue}`,
  body,
  url: `https://github.com/example/fixture/issues/${issue}`
});
const successfulStartGit = async (argv: readonly string[]) => {
  if (argv[0] === "gh") {
    const issue = Number(argv[3]);
    const snapshot = issueSnapshot(issue);
    return {
      exitCode: 0,
      stdout: JSON.stringify({ number: snapshot.number, title: snapshot.title, body: snapshot.body, url: snapshot.url }),
      stderr: ""
    };
  }
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  if (argv.includes("rev-parse")) return { exitCode: 0, stdout: `${trustedSourceSha}\n`, stderr: "" };
  return { exitCode: 1, stdout: "", stderr: `unexpected command: ${argv.join(" ")}` };
};
const resolvableStartGit = async (argv: readonly string[], cwd: string) => {
  if (argv[0] === "gh") return successfulStartGit(argv);
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  const [command, ...args] = argv;
  if (command === undefined) return { exitCode: 1, stdout: "", stderr: "empty command" };
  return { exitCode: 0, stdout: execFileSync(command, args, { cwd, encoding: "utf8" }), stderr: "" };
};

describe("CLI version", () => {
  it("prints package.json version for --version, -V, and version", async () => {
    // Read the manifest here rather than through `packageVersion`: the CLI prints
    // that helper's return value, so calling it would compare it with itself.
    const expected = (JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string })
      .version;
    for (const argv of [["--version"], ["-V"], ["version"]] as const) {
      const lines: string[] = [];
      expect(await runCli([...argv], { io: { stdout: (message) => lines.push(message) } })).toBe(0);
      expect(lines.join("").trim()).toBe(expected);
    }
  });
});

describe("CLI manual mode", () => {
  it("launches every configured agent without GitHub, runtime, or run-loop effects", async () => {
    const fixture = setup();
    const launches: Array<{ namespace: string | null; group: string; agents: string[] }> = [];
    const output: string[] = [];
    const code = await runCli(["manual", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      io: { stdout: (message) => output.push(message) },
      processRunner: async () => {
        throw new Error("manual mode must not query GitHub or git");
      },
      sessionExists: async () => false,
      makeRunLoop: () => {
        throw new Error("manual mode must not construct the run loop");
      },
      manualUi: async (input) => {
        launches.push({
          namespace: input.tmuxNamespace,
          group: input.terminalGroup,
          agents: input.agents.map((agent) => agent.id)
        });
        return { status: "opened", count: input.agents.length };
      }
    });
    expect(code).toBe(0);
    expect(launches).toEqual([
      {
        namespace: null,
        group: expect.stringMatching(/^[a-f0-9]{10}$/),
        agents: ["codex", "claude", "cursor"]
      }
    ]);
    expect(output.join("")).toContain("Manual mode ready in coord-manual-");
    expect(existsSync(fixture.runtime)).toBe(false);
  });

  it("is idempotent and reports already-open owner clients", async () => {
    const fixture = setup();
    let launches = 0;
    const output: string[] = [];
    const dependencies = {
      io: { stdout: (message: string) => output.push(message) },
      sessionExists: async () => false,
      manualUi: async () => {
        launches += 1;
        return launches === 1 ? ({ status: "opened", count: 3 } as const) : ({ status: "already-open", count: 3 } as const);
      }
    };
    const argv = ["manual", "--config", fixture.configPath, "--coord-root", fixture.runtime];
    expect(await runCli(argv, dependencies)).toBe(0);
    expect(await runCli(argv, dependencies)).toBe(0);
    expect(launches).toBe(2);
    expect(output.join("").match(/Manual mode ready/g)).toHaveLength(2);
  });

  it("rejects manual launch while this workspace has a live issue session", async () => {
    const fixture = setup();
    mkdirSync(issueRuntimePaths(fixture.runtime, 7).issueRoot, { recursive: true });
    const errors: string[] = [];
    let launched = false;
    const code = await runCli(["manual", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      io: { stderr: (message) => errors.push(message) },
      sessionExists: async (name) => name === "coord-7",
      manualUi: async () => {
        launched = true;
        return { status: "already-open", count: 0 };
      }
    });
    expect(code).toBe(2);
    expect(launched).toBe(false);
    expect(errors.join("")).toContain("coord detach 7");
  });

  it("ignores a live issue session durably owned by another config", async () => {
    const fixture = setup();
    expect(
      await runCli(["start", "7", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stdout: () => undefined },
        sessionExists: async () => false,
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 7);
    const start = JSON.parse(readFileSync(paths.start, "utf8")) as Record<string, unknown>;
    writeFileSync(paths.start, JSON.stringify({ ...start, configPath: join(fixture.root, "other-config.json") }));

    let launched = false;
    expect(
      await runCli(["manual", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stdout: () => undefined },
        sessionExists: async (name) => name === "coord-7",
        manualUi: async () => {
          launched = true;
          return { status: "already-open", count: 3 };
        }
      })
    ).toBe(0);
    expect(launched).toBe(true);
  });

  it("rejects new and resumed automated entry points while manual UI is live", async () => {
    const fixture = setup();
    const isManual = async (name: string) => name.startsWith("coord-manual-");
    const errors: string[] = [];
    expect(
      await runCli(["start", "7", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        sessionExists: isManual,
        processRunner: async () => {
          throw new Error("conflict must fail before issue lookup");
        }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("coord detach manual");

    expect(
      await runCli(["start", "8", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stdout: () => undefined },
        sessionExists: async () => false,
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    errors.length = 0;
    let resumed = false;
    expect(
      await runCli(["run", "--issue", "8", "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        sessionExists: isManual,
        makeRunLoop: () => ({
          initializeEffects: async () => undefined,
          runTick: async () => readCursorsState(issueRuntimePaths(fixture.runtime, 8)),
          run: async () => {
            resumed = true;
          }
        })
      })
    ).toBe(2);
    expect(resumed).toBe(false);
    expect(errors.join("")).toContain("coord detach manual");

    for (const argv of [
      ["8", "--config", fixture.configPath, "--coord-root", fixture.runtime],
      ["attach", "8", "--config", fixture.configPath, "--coord-root", fixture.runtime]
    ]) {
      errors.length = 0;
      expect(
        await runCli(argv, {
          io: { stderr: (message) => errors.push(message) },
          sessionExists: isManual,
          makeRunLoop: () => {
            throw new Error("conflict must fail before automated resume");
          }
        })
      ).toBe(2);
      expect(errors.join("")).toContain("coord detach manual");
    }
  });

  it("dispatches exact manual teardown and advertises both manual commands", async () => {
    const fixture = setup();
    const output: string[] = [];
    expect(
      await runCli(["detach", "manual", "--config", fixture.configPath, "--coord-root", fixture.runtime, "--dry-run"], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Detached manual mode");

    output.length = 0;
    expect(await runCli(["--help"], { io: { stdout: (message) => output.push(message) } })).toBe(0);
    expect(output.join("")).toContain("coord manual");
    expect(output.join("")).toContain("coord detach manual");
    expect(output.join("")).toContain("coord analytics --issue");
  });
});

describe("CLI", () => {
  it("requires the external coord root explicitly rather than accepting COORD_ROOT", async () => {
    const fixture = setup();
    const messages: string[] = [];
    const result = await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath], {
      io: { stderr: (message) => messages.push(message) }
    });
    expect(result).toBe(2);
    expect(messages.join("")).toContain("--config and --coord-root");

    messages.length = 0;
    expect(
      await runCli(["run", "--issue", "1"], {
        io: {
          env: { COORD_ROOT: fixture.runtime },
          stderr: (message) => messages.push(message)
        }
      })
    ).toBe(2);
    expect(messages.join("")).toContain("--coord-root is required");
  });

  it("starts from the exact origin baseline and exposes only the caller action", async () => {
    const fixture = setup();
    const output: string[] = [];
    const result = await runCli(
      ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime],
      {
        io: { cwd: process.cwd(), stdout: (message) => output.push(message) },
        processRunner: resolvableStartGit,
        makeRunLoop: fakeLoop
      }
    );
    expect(result).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const trustedSourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    expect(readStartState(paths)).toMatchObject({ baselineSha, trustedSourceCommit });
    expect(() => execFileSync("git", ["cat-file", "-e", `${trustedSourceCommit}^{commit}`])).not.toThrow();
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
    expect(action).toContain("requiredPath: .signals/issue-1/participation-ready-codex.json");
    expect(action).not.toContain("stepId:");
    expect(action).not.toContain("evidence:");
    expect(action).not.toContain("gate-");
    expect(readFileSync(runtime.action, "utf8")).toBe(action);
  });

  it("prints chosen pin and PR fields from coord status", async () => {
    const fixture = setup();
    expect(
      await runCli(
        ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime],
        { processRunner: resolvableStartGit, makeRunLoop: fakeLoop }
      )
    ).toBe(0);
    const output: string[] = [];
    expect(
      await runCli(["status", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Issue 1:");
    expect(output.join("")).toContain("Final pin (PR head):");
    expect(output.join("")).toContain("Policy: owner-only");
  });

  it("resumes only the selected hold, audits budget resets, and reports remaining pauses", async () => {
    const fixture = setup();
    expect(await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime],
      { processRunner: resolvableStartGit, makeRunLoop: fakeLoop })).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const current = readCursorsState(paths);
    const actionId = actionIdFor("codex");
    const id = "20000000-0000-4000-8000-000000000001";
    writeCursorsState(paths, cursorsStateSchema.parse({ ...current, manualPaused: true, paused: true,
      agents: { ...current.agents, codex: { ...current.agents.codex, actionId } },
      actionSafety: { codex: { actionId, sends: 4, lastSendAt: current.updatedAt, activityAt: current.updatedAt } },
      holds: [{ id, agent: "codex", actionId, sessionId: null, reason: "nudge-loop", evidenceId: "budget",
        observedAt: current.updatedAt, resetsAt: null, confidence: "unknown", retryOwner: "owner" }] }));
    const output: string[] = [];
    const errors: string[] = [];
    const io = { stdout: (s: string) => output.push(s), stderr: (s: string) => errors.push(s) };
    const args = ["--issue", "1", "--coord-root", fixture.runtime];
    expect(await runCli(["resume", ...args], { io })).toBe(0);
    expect(readCursorsState(paths).paused).toBe(true);
    expect(output.join("")).toContain("1 active hold");
    expect(await runCli(["restart-action", ...args], { io })).toBe(2);
    expect(await runCli(["resume", ...args, "--reset-nudge-budget"], { io })).toBe(2);
    expect(await runCli(["resume", ...args, "--hold", id], { io })).toBe(2);
    expect(await runCli(["resume", ...args, "--hold", id, "--reset-nudge-budget"], { io })).toBe(0);
    expect(readCursorsState(paths)).toMatchObject({ paused: false, holds: [], actionSafety: { codex: { sends: 0 } } });
    expect(readJournal(paths).filter((event) => event.type === "hold-released")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ hold: id, resetNudgeBudget: true }) })
    ]);
    expect(readJournal(paths).filter((event) => event.type === "resumed")).toHaveLength(1);
  });

  it("resolves scoped agent recovery under the lock and runs only on explicit request", async () => {
    const f = setup();
    await runCli(["start", "1", "--config", f.configPath, "--coord-root", f.runtime],
      { processRunner: resolvableStartGit, makeRunLoop: fakeLoop });
    const paths = issueRuntimePaths(f.runtime, 1);
    const current = readCursorsState(paths);
    const holds = ["codex", "claude"].map((agent, index) => ({
      id: `20000000-0000-4000-8000-00000000000${index + 1}`, agent, actionId: actionIdFor(agent), sessionId: null,
      reason: index === 0 ? "nudge-loop" : "unobservable", evidenceId: agent, observedAt: current.updatedAt,
      resetsAt: null, confidence: "unknown", retryOwner: "owner"
    }));
    const held = cursorsStateSchema.parse({ ...current, paused: true, manualPaused: true, holds,
      agents: { ...current.agents, ...Object.fromEntries(holds.map((hold) =>
        [hold.agent, { ...current.agents[hold.agent], actionId: hold.actionId }])) },
      actionSafety: Object.fromEntries(holds.map((hold) => [hold.agent,
        { actionId: hold.actionId, sends: 4, lastSendAt: current.updatedAt, activityAt: current.updatedAt }])) });
    writeCursorsState(paths, held);
    let runs = 0;
    const errors: string[] = [];
    const deps = { io: { stdout: () => undefined, stderr: (s: string) => errors.push(s) },
      makeRunLoop: () => ({ ...fakeLoop(paths), run: async () => { runs++; } }) };
    const args = ["resume", "--issue", "1", "--coord-root", f.runtime];
    const rejectUnchanged = async (flags: string[], sessionExists?: (name: string) => Promise<boolean>) => {
      const before = readFileSync(paths.cursors, "utf8");
      const journal = readFileSync(paths.journal, "utf8");
      expect(await runCli([...args, ...flags], { ...deps, ...(sessionExists ? { sessionExists } : {}) })).toBe(2);
      expect(readFileSync(paths.cursors, "utf8")).toBe(before);
      expect(readFileSync(paths.journal, "utf8")).toBe(journal);
      expect(runs).toBe(0);
    };
    for (const flags of [
      ["--agent", "unknown"], ["--agent", "cursor"],
      ["--agent", "codex", "--hold", holds[0]!.id], ["--agent", "codex"],
      ["--agent", "claude", "--reset-nudge-budget"]
    ]) await rejectUnchanged(flags);

    writeCursorsState(paths, cursorsStateSchema.parse({ ...held,
      holds: [...held.holds, { ...held.holds[0], id: "20000000-0000-4000-8000-000000000003" }] }));
    await rejectUnchanged(["--agent", "codex", "--reset-nudge-budget"]);
    expect(errors.join("")).toContain("2 active holds");
    expect(errors.join("")).toContain("20000000-0000-4000-8000-000000000003");
    writeCursorsState(paths, cursorsStateSchema.parse({ ...held,
      agents: { ...held.agents, codex: { ...held.agents.codex, actionId: "10000000-0000-4000-8000-000000000099" } } }));
    await rejectUnchanged(["--agent", "codex", "--reset-nudge-budget"]);
    expect(errors.join("")).toContain("retired work");
    writeCursorsState(paths, held);
    await rejectUnchanged(["--agent", "codex", "--reset-nudge-budget", "--run"], async () => true);
    expect(errors.join("")).toContain("coord detach manual");

    expect(await runCli([...args, "--agent", "codex", "--reset-nudge-budget"], deps)).toBe(0);
    expect(runs).toBe(0);
    expect(readCursorsState(paths)).toMatchObject({ manualPaused: true, paused: true,
      holds: [expect.objectContaining({ agent: "claude" })], actionSafety: { codex: { sends: 0 } } });
    expect(readJournal(paths).filter((event) => event.type === "hold-released")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ hold: holds[0]!.id, resetNudgeBudget: true }) })
    ]);
    expect(await runCli([...args, "--agent", "claude", "--run"], deps)).toBe(0);
    expect(runs).toBe(1);
    expect(readCursorsState(paths)).toMatchObject({ manualPaused: true, paused: true, holds: [] });
    expect(await runCli([...args, "--run"], deps)).toBe(0);
    expect(runs).toBe(2);
    expect(readCursorsState(paths)).toMatchObject({ manualPaused: false, paused: false, holds: [] });
  });

  it("prints all four analytics sections, rejects unknown flags, and fails clearly without a journal", async () => {
    const fixture = setup();
    expect(
      await runCli(
        ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime],
        { processRunner: resolvableStartGit, makeRunLoop: fakeLoop }
      )
    ).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    installFormat4JournalFixture(paths.journal);
    const home = join(fixture.root, "home");
    const transcript = join(
      home,
      ".codex",
      "sessions",
      "2026",
      "08",
      "21",
      "rollout-fixture-session-codex.jsonl"
    );
    mkdirSync(join(transcript, ".."), { recursive: true });
    copyFileSync(join(process.cwd(), "test", "support", "fixtures", "transcript-codex.jsonl"), transcript);

    const output: string[] = [];
    expect(
      await runCli(["analytics", "--issue", "1", "--coord-root", fixture.runtime], {
        home,
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Time\n");
    expect(output.join("")).toContain("Phase count\n");
    expect(output.join("")).toContain("Token count\n");
    expect(output.join("")).toContain("Tool count\n");

    const errors: string[] = [];
    expect(
      await runCli(["analytics", "--issue", "1", "--coord-root", fixture.runtime, "--json", "true"], {
        io: { stderr: (message) => errors.push(message) }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Unknown option --json");

    rmSync(paths.journal);
    errors.length = 0;
    expect(
      await runCli(["analytics", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("No journal exists for issue 1");
  });

  it("reports completed format-2 analytics read-only while run remains fail-closed", async () => {
    const fixture = setup();
    expect(
      await runCli(
        ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime],
        { processRunner: resolvableStartGit, makeRunLoop: fakeLoop }
      )
    ).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    writeFileSync(
      paths.start,
      `${JSON.stringify({ ...JSON.parse(readFileSync(paths.start, "utf8")), formatVersion: 2 }, null, 2)}\n`
    );
    writeFileSync(
      paths.cursors,
      `${JSON.stringify({ ...JSON.parse(readFileSync(paths.cursors, "utf8")), formatVersion: 2, completed: true }, null, 2)}\n`
    );
    copyFileSync(
      join(process.cwd(), "test", "support", "fixtures", "analytics-journal-format2.jsonl"),
      paths.journal
    );

    const output: string[] = [];
    expect(
      await runCli(["analytics", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Source: runtime format 2 (legacy read-only); skipped journal records=1");
    expect(output.join("")).toContain("elapsed=0.13 min paused=0.02 min unpaused=0.12 min");
    expect(output.join("")).toContain("duration=unavailable");
    expect(output.join("")).not.toContain("Token count");

    const errors: string[] = [];
    expect(
      await runCli(["run", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Runtime format versions 2 and 3 are no longer supported");
  });

  it("binds the digest to the mandatory GitHub issue independently of optional paths", async () => {
    const fixture = setup();
    const config = readConfig(fixture.configPath);
    const issue1 = automationDigestMaterial(
      fixture.configPath,
      config,
      1,
      renderGitHubIssueSnapshot(issueSnapshot(1))
    );
    const issue7 = automationDigestMaterial(
      fixture.configPath,
      config,
      7,
      renderGitHubIssueSnapshot(issueSnapshot(7))
    );
    const editedIssue1 = automationDigestMaterial(
      fixture.configPath,
      config,
      1,
      renderGitHubIssueSnapshot(issueSnapshot(1, "Edited body"))
    );
    expect(issue7.digest).not.toBe(issue1.digest);
    expect(editedIssue1.digest).not.toBe(issue1.digest);
    expect(issue7.sources.map((source) => source.id)).toEqual(["config", "github-issue"]);

    const elsewhere = mkdtempSync(join(tmpdir(), "coord-other-cwd-"));
    roots.push(elsewhere);
    expect(
      await runCli(["start", "7", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { cwd: elsewhere },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(readStartState(issueRuntimePaths(fixture.runtime, 7))).toMatchObject({
      automationDigest: issue7.digest,
      automationDigestScheme: "sha256-length-prefixed-v1"
    });
    expect(JSON.parse(readFileSync(issueRuntimePaths(fixture.runtime, 7).issueSnapshot, "utf8"))).toEqual(issueSnapshot(7));
  });

  it("rejects incompatible PR publication before creating issue state", async () => {
    const fixture = setup();
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as Record<string, unknown>;
    config.prPolicy = "coord-open-unmerged";
    config.origin = join(fixture.root, "not-github.git");
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const errors: string[] = [];
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("not a supported github.com repository");
    expect(existsSync(join(fixture.runtime, "issue-1"))).toBe(false);
  });

  it("fails an unreadable GitHub issue before runtime or launch effects", async () => {
    const fixture = setup();
    const errors: string[] = [];
    let effectsCalled = false;
    expect(
      await runCli(["start", "999", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: async (argv) =>
          argv[0] === "gh"
            ? { exitCode: 1, stdout: "", stderr: "issue not found" }
            : { exitCode: 1, stdout: "", stderr: "must not continue after issue lookup" },
        startEffects: async () => {
          effectsCalled = true;
          return { cleanup: async () => undefined };
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toMatch(/Create GitHub issue 999.*gh auth status/);
    expect(effectsCalled).toBe(false);
    expect(existsSync(join(fixture.runtime, "issue-999"))).toBe(false);
  });

  it("fails closed when the running coordinator source commit cannot be resolved", async () => {
    const fixture = setup();
    const errors: string[] = [];
    let effectsCalled = false;
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: async (argv) => {
          if (argv[0] === "gh") return successfulStartGit(argv);
          return argv.includes("ls-remote")
            ? { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" }
            : { exitCode: 128, stdout: "", stderr: "not a Git checkout" };
        },
        startEffects: async () => {
          effectsCalled = true;
          return { cleanup: async () => undefined };
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Cannot resolve trusted coordinator source commit");
    expect(effectsCalled).toBe(false);
    expect(existsSync(join(fixture.runtime, "issue-1"))).toBe(false);
  });

  it("leaves no active run when startup effects fail", async () => {
    const fixture = setup();
    const errors: string[] = [];
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        startEffects: async () => {
          throw new Error("mirror preflight failed");
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("mirror preflight failed");
    expect(existsSync(join(fixture.runtime, "issue-1"))).toBe(false);
  });

  it("materializes lifecycle state before launching agents and removes it when launch fails", async () => {
    const fixture = setup();
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const errors: string[] = [];
    expect(
      await runCli(["start", "1", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        startEffects: async () => {
          expect(existsSync(paths.start)).toBe(true);
          expect(existsSync(paths.agentLifecycle)).toBe(true);
          throw new Error("launch after lifecycle handshake failed");
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("launch after lifecycle handshake failed");
    expect(existsSync(paths.issueRoot)).toBe(false);
  });

  it("retains resumable state and launched effects when the first tick fails", async () => {
    const fixture = setup();
    const errors: string[] = [];
    let cleanups = 0;
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        startEffects: async () => ({
          cleanup: async () => {
            cleanups += 1;
          }
        }),
        makeRunLoop: () => ({
          initializeEffects: async () => undefined,
          runTick: async () => {
            throw new Error("initial nudge failed");
          },
          run: async () => undefined
        })
      })
    ).toBe(2);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    expect(readStartState(paths)).toMatchObject({ trustedSourceCommit: trustedSourceSha });
    expect(readCursorsState(paths).abandoned).toBe(false);
    expect(cleanups).toBe(0);
    expect(errors.join("")).toContain("was started durably");
    expect(errors.join("")).toContain("resume with coord 1");
  });

  it("rejects an escaping launcher before startup effects", async () => {
    const fixture = setup();
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
      agents: Array<Record<string, unknown>>;
    };
    if (config.agents[0] !== undefined) config.agents[0].launcher = "../outside.sh";
    writeFileSync(fixture.configPath, JSON.stringify(config));
    let effectsCalled = false;
    const errors: string[] = [];
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        startEffects: async () => {
          effectsCalled = true;
          return { cleanup: async () => undefined };
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(effectsCalled).toBe(false);
    expect(errors.join("")).toContain("outside coordinator root");
    expect(existsSync(join(fixture.runtime, "issue-1"))).toBe(false);
  });

  it("resolves coord next from an agent clone without --coord-root", async () => {
    const fixture = setup();
    const runtimeConfig = join(fixture.runtime, "config.json");
    mkdirSync(fixture.runtime, { recursive: true });
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
      agents: Array<{ id: string; root: string; launcher: string; delivery: string }>;
    };
    config.agents = config.agents.map((agent) => ({ ...agent, root: join(fixture.root, agent.root) }));
    writeFileSync(runtimeConfig, JSON.stringify(config));
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", runtimeConfig, "--coord-root", fixture.runtime], {
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const start = readStartState(paths);
    const cursors = readCursorsState(paths);
    const order = buildOrder(paths, start, cursors, "codex", "R1.join", null);
    writeAction(fixture.runtime, agentRuntimePaths(paths, "codex").action, order);

    const clone = join(fixture.root, "clone-codex");
    execFileSync("git", ["init", "-q"], { cwd: clone });
    execFileSync("git", ["config", "coord.workspaceConfig", runtimeConfig], { cwd: clone });
    execFileSync("git", ["config", "consensus.agentId", "codex"], { cwd: clone });

    const chunks: string[] = [];
    expect(
      await runCli(["next", "--issue", "1"], {
        io: { cwd: clone, stdout: (message) => chunks.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(chunks.join("")).toContain(order.actionId);
    expect(chunks.join("")).toContain("codex");
  });

  it("detaches tmux/Terminal UI after a completed coord N run", async () => {
    const fixture = setup();
    const product = join(fixture.root, "product");
    const origin = join(fixture.root, "origin.git");
    const clone = join(fixture.root, "clone-codex");
    rmSync(clone, { recursive: true, force: true });
    mkdirSync(product);
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: product });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: product });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: product });
    writeFileSync(join(product, ".gitignore"), "/start-*.sh\n");
    writeFileSync(join(product, "AGENTS.md"), "# product\n");
    writeFileSync(join(product, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: product });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: product });
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: product });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: product });
    execFileSync("git", ["clone", "-q", origin, clone]);
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: clone });
    writeFileSync(join(clone, "start-codex.sh"), "#!/usr/bin/env bash\n", { mode: 0o700 });

    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    writeFileSync(join(clone, "published.txt"), "published\n");
    execFileSync("git", ["add", "published.txt"], { cwd: clone });
    execFileSync("git", ["commit", "-qm", "Codex: published"], { cwd: clone });
    execFileSync("git", ["push", "-q", "-u", "origin", "issue-1/codex"], { cwd: clone });
    const issueTip = execFileSync("git", ["rev-parse", "HEAD"], { cwd: clone, encoding: "utf8" }).trim();
    const commitCount = execFileSync("git", ["rev-list", "--all", "--count"], {
      cwd: clone,
      encoding: "utf8"
    }).trim();
    writeFileSync(join(clone, "published.txt"), "unfinished\n");
    execFileSync("git", ["add", "published.txt"], { cwd: clone });
    mkdirSync(join(clone, ".plans", "issue-1"), { recursive: true });
    writeFileSync(join(clone, ".plans", "issue-1", "plan.md"), "unfinished\n");
    const current = readCursorsState(paths);
    writeCursorsState(paths, cursorsStateSchema.parse({ ...current, completed: true }));
    const output: string[] = [];
    expect(
      await runCli(["1", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stdout: (message) => output.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(output.join("")).toContain("Issue 1 complete: killed");
    expect(output.join("")).toContain("Clone readiness: cleaned 1");
    expect(output.join("")).not.toContain("Tip: coord attach");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: clone, encoding: "utf8" }).trim()).toBe("");
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone, encoding: "utf8" }).trim()).toBe(
      "main"
    );
    expect(execFileSync("git", ["rev-parse", "issue-1/codex"], { cwd: clone, encoding: "utf8" }).trim()).toBe(
      issueTip
    );
    expect(execFileSync("git", ["rev-list", "--all", "--count"], { cwd: clone, encoding: "utf8" }).trim()).toBe(
      commitCount
    );
    expect(existsSync(join(clone, ".plans"))).toBe(false);
    expect(
      execFileSync("git", ["ls-remote", "origin", "refs/heads/issue-1/codex"], { cwd: clone, encoding: "utf8" })
    ).toContain(issueTip);

    const runOutput: string[] = [];
    expect(
      await runCli(["resume", "--run", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stdout: (message) => runOutput.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(runOutput.join("")).toContain("already base 1");

    writeFileSync(join(clone, "owner.txt"), "keep\n");
    const refusedOutput: string[] = [];
    const refusedErrors: string[] = [];
    expect(
      await runCli(["run", "--issue", "1", "--coord-root", fixture.runtime], {
        io: {
          stdout: (message) => refusedOutput.push(message),
          stderr: (message) => refusedErrors.push(message)
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(1);
    expect(refusedOutput.join("")).toContain("refused 1");
    expect(refusedErrors.join("")).toContain("refused codex");
    expect(refusedErrors.join("")).toContain("coord reset-clones 1");
    expect(refusedErrors.join("")).toContain("Do not run git checkout main by hand");
    expect(readFileSync(join(clone, "owner.txt"), "utf8")).toBe("keep\n");
    const journal = readFileSync(paths.journal, "utf8");
    expect(journal).toContain("clone-readiness-refused");

    rmSync(join(clone, "owner.txt"));
    execFileSync("git", ["checkout", "-q", "issue-1/codex"], { cwd: clone });
    writeFileSync(join(clone, "late-wip.txt"), "discard before checkout failure\n");
    writeFileSync(
      join(clone, ".git", "hooks", "post-checkout"),
      "#!/bin/sh\necho 'blocked checkout for audit test' >&2\nexit 1\n",
      { mode: 0o700 }
    );
    const failedCheckoutOutput: string[] = [];
    const failedCheckoutErrors: string[] = [];
    expect(
      await runCli(["run", "--issue", "1", "--coord-root", fixture.runtime], {
        io: {
          stdout: (message) => failedCheckoutOutput.push(message),
          stderr: (message) => failedCheckoutErrors.push(message)
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(1);
    expect(failedCheckoutOutput.join("")).toContain("discarded 1 path(s)");
    expect(failedCheckoutOutput.join("")).toContain("Clone readiness: cleaned 1");
    expect(failedCheckoutOutput.join("")).toContain("refused 1");
    expect(failedCheckoutErrors.join("")).toContain("coord reset-clones 1");
    expect(existsSync(join(clone, "late-wip.txt"))).toBe(false);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone, encoding: "utf8" }).trim()).toBe(
      "main"
    );
  });

  it("reset-clones makes agent clones base-ready without wiping runtime", async () => {
    const fixture = setup();
    const product = join(fixture.root, "product");
    const origin = join(fixture.root, "origin.git");
    const clone = join(fixture.root, "clone-codex");
    rmSync(clone, { recursive: true, force: true });
    mkdirSync(product);
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: product });
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: product });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: product });
    writeFileSync(join(product, ".gitignore"), "/start-*.sh\n");
    writeFileSync(join(product, "AGENTS.md"), "# product\n");
    writeFileSync(join(product, "base.txt"), "base\n");
    execFileSync("git", ["add", "."], { cwd: product });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: product });
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: product });
    execFileSync("git", ["push", "-q", "origin", "main"], { cwd: product });
    execFileSync("git", ["clone", "-q", origin, clone]);
    execFileSync("git", ["config", "user.name", "Fixture"], { cwd: clone });
    execFileSync("git", ["config", "user.email", "fixture@example.com"], { cwd: clone });
    writeFileSync(join(clone, "start-codex.sh"), "#!/usr/bin/env bash\n", { mode: 0o700 });

    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    writeFileSync(join(clone, "wip.txt"), "leftover\n");
    const output: string[] = [];
    expect(
      await runCli(["reset-clones", "1", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stdout: (message) => output.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(output.join("")).toContain("Reset clones for issue 1");
    expect(output.join("")).toContain("Runtime left intact");
    expect(existsSync(paths.issueRoot)).toBe(true);
    expect(existsSync(join(clone, "wip.txt"))).toBe(false);
    expect(execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: clone, encoding: "utf8" }).trim()).toBe(
      "main"
    );
  });

  it("refuses to drop the final active agent", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
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

  it("refuses to silently rebind an authorized reviser on drop", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "consensus", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R6.revise", gateId: "gate-6-consensus", round: 1 },
        derived: {
          planSelection: null,
          implementationSelection: {
            kind: "implementation-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "b".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "implementation",
                agent: "cursor",
                submissionSha: "d".repeat(40),
                path: ".signals/issue-1/implementation-ready-cursor.json",
                productPin: "e".repeat(40)
              }
            ],
            decisionId: `implementation-selection:${"b".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            winner: "cursor",
            implementationPin: "e".repeat(40),
            reviser: "cursor"
          },
          consensus: null
        },
        accepted: [],
        updatedAt: now
      })
    );
    const errors: string[] = [];
    expect(
      await runCli(["drop", "cursor", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    const after = readCursorsState(paths);
    expect(after.activeRoster).toContain("cursor");
    expect(after.derived.implementationSelection?.reviser).toBe("cursor");
    expect(errors.join("")).toContain("Cannot drop authorized reviser cursor");
  });

  it("resets to plan-ballot after a drop when the published evidence roster no longer matches", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "consensus", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const current = readCursorsState(paths);
    const now = "2026-08-11T17:00:00.000Z";
    const priorDecisionId = `plan-selection:${"f".repeat(64)}`;
    const priorBatch = publishedBallotBatchFixture({
      kind: "plan-ballot-batch",
      activeRoster: current.activeRoster,
      createdAt: now,
      commitSha: "9".repeat(40)
    });
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
        derived: {
          ...current.derived,
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "f".repeat(64),
            activeRoster: current.activeRoster,
            inputs: [
              {
                kind: "plan",
                agent: "codex",
                submissionSha: "1".repeat(40),
                path: ".plans/issue-1/plan-codex.md"
              }
            ],
            decisionId: priorDecisionId,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["codex"]
          }
        },
        accepted: current.activeRoster.map((agent, index) => ({
          stepId: "R2.plan" as const,
          agent,
          round: null,
          submissionSha: String(index + 1).repeat(40),
          path: `.plans/issue-1/plan-${agent}.md`,
          acceptedAt: now
        })),
        acceptedResponses: current.activeRoster.map((agent) =>
          acceptedResponseFixture({
            stepId: "R3.plan-ballot",
            agent,
            choice: agent === "claude" ? "claude" : "codex",
            acceptedAt: now
          })
        ),
        ballotBatches: [priorBatch],
        evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) },
        updatedAt: now
      })
    );

    expect(
      await runCli(["drop", "cursor", "--issue", "1", "--coord-root", fixture.runtime], {
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    const after = readCursorsState(paths);
    expect(after.activeRoster).toEqual(["codex", "claude"]);
    expect(after.issueCursor.stepId).toBe("R3.plan-ballot");
    expect(after.derived.planSelection).toBeNull();
    expect(after.ballotBatches).toContainEqual(
      expect.objectContaining({
        batchId: priorBatch.batchId,
        status: "published",
        commitSha: "9".repeat(40)
      })
    );
  });

  it("preserves peer acceptance and pending intent when another agent is dropped", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "reviewed", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const now = "2026-08-11T17:00:00.000Z";
    const current = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R2.plan", gateId: "gate-2-plans", round: null },
        agents: {
          ...current.agents,
          codex: { ...current.agents.codex, stepId: "R2.plan", status: "waiting-peer", updatedAt: now },
          claude: { ...current.agents.claude, stepId: "R2.plan", status: "ordered", updatedAt: now },
          cursor: { ...current.agents.cursor, stepId: "R2.plan", status: "ordered", updatedAt: now }
        },
        accepted: [
          {
            stepId: "R2.plan",
            agent: "codex",
            round: null,
            submissionSha: "b".repeat(40),
            approvedPaths: ["src/product.ts"],
            path: ".plans/issue-1/plan.md",
            acceptedAt: now
          }
        ],
        updatedAt: now
      })
    );
    const pending = agentRuntimePaths(paths, "claude").complete;
    writeFileSync(pending, `${"c".repeat(40)}\n`);

    expect(
      await runCli(["drop", "cursor", "--issue", "1", "--coord-root", fixture.runtime], { makeRunLoop: fakeLoop })
    ).toBe(0);
    const after = readCursorsState(paths);
    expect(after.accepted).toContainEqual(expect.objectContaining({ stepId: "R2.plan", agent: "codex" }));
    expect(after.activeRoster).toEqual(["codex", "claude"]);
    expect(readFileSync(pending, "utf8")).toBe(`${"c".repeat(40)}\n`);
    expect(after.agents.claude?.actionId).toBeNull();
  });

  it("cancels pending amendment ballot and invalidates unpublished batches on drop", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "reviewed", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const now = "2026-08-11T17:00:00.000Z";
    const current = readCursorsState(paths);
    const pendingAmend = {
      sequence: 1,
      agent: "claude" as const,
      actionId: actionIdFor("claude"),
      submissionSha: "b".repeat(40),
      sourceStep: "R4.implement" as const,
      sourceRound: null,
      scopeHash: "a".repeat(64),
      explanation: "need extra test",
      additionalPaths: [{ path: "test/extra.test.ts", reason: "unit tests" }],
      proposedAt: now
    };
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: 1 },
        pendingAmendment: pendingAmend,
        amendmentSequence: 1,
        agents: {
          ...current.agents,
          claude: { ...current.agents.claude, stepId: "R4.amend-ballot", status: "ordered", updatedAt: now },
          codex: { ...current.agents.codex, stepId: "R4.amend-ballot", status: "ordered", updatedAt: now },
          cursor: { ...current.agents.cursor, stepId: "R4.amend-ballot", status: "ordered", updatedAt: now }
        },
        acceptedResponses: [
          acceptedResponseFixture({ stepId: "R4.amend-ballot", agent: "codex", round: 1, disposition: "approve" })
        ],
        updatedAt: now
      })
    );

    expect(
      await runCli(["drop", "cursor", "--issue", "1", "--coord-root", fixture.runtime], { makeRunLoop: fakeLoop })
    ).toBe(0);
    const after = readCursorsState(paths);
    expect(after.pendingAmendment).toBeNull();
    expect(after.issueCursor.stepId).toBe("R4.implement");
    expect(after.acceptedResponses.filter((r) => r.stepId === "R4.amend-ballot")).toHaveLength(0);
  });

  it("resets approved scope amendments when dropped agent causes plan reselection", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "reviewed", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const now = "2026-08-11T17:00:00.000Z";
    const current = readCursorsState(paths);
    const scopeAmendment = {
      kind: "scope-amendment" as const,
      sequence: 1,
      decisionId: `scope-amendment:1:${"a".repeat(64)}`,
      proposal: {
        sequence: 1,
        agent: "claude" as const,
        actionId: actionIdFor("claude"),
        submissionSha: "b".repeat(40),
        sourceStep: "R4.implement" as const,
        sourceRound: null,
        scopeHash: "a".repeat(64),
        explanation: "need extra test",
        additionalPaths: [{ path: "test/extra.test.ts", reason: "unit tests" }],
        proposedAt: now
      },
      batchCommitSha: "c".repeat(40),
      addedPaths: ["test/extra.test.ts"],
      decidedAt: now
    };
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
        derived: {
          ...current.derived,
          planSelection: {
            kind: "plan-selection",
            algorithm: "plurality-active-roster-v1",
            inputSetHash: "d".repeat(64),
            activeRoster: ["claude", "codex", "cursor"],
            inputs: [
              { kind: "plan", agent: "cursor", submissionSha: "e".repeat(40), path: ".plans/issue-1/plan.md" }
            ],
            decisionId: `plan-selection:${"d".repeat(64)}`,
            supersedes: null,
            decidedAt: now,
            selectedAgents: ["cursor"]
          },
          scopeAmendments: [scopeAmendment]
        },
        updatedAt: now
      })
    );

    expect(
      await runCli(["drop", "cursor", "--issue", "1", "--coord-root", fixture.runtime], { makeRunLoop: fakeLoop })
    ).toBe(0);
    const after = readCursorsState(paths);
    expect(after.derived.scopeAmendments).toEqual([]);
  });

  it("applies typed owner answers durably and idempotently without allowing round four", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const current = readCursorsState(paths);
    const questionId = "10000000-0000-4000-8000-000000000001";
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...current,
        issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 2 },
        ownerQuestion: {
          id: questionId,
          kind: "ballot-escalation",
          round: 2,
          allowedAnswers: ["retry", "revise", "abandon"],
          createdAt: "2026-08-11T17:00:00.000Z"
        }
      })
    );
    const args = ["answer", questionId, "revise", "--issue", "1", "--coord-root", fixture.runtime];
    expect(await runCli(args, { makeRunLoop: fakeLoop })).toBe(0);
    expect(readCursorsState(paths)).toMatchObject({
      issueCursor: { stepId: "R6.revise", round: 3 },
      ownerQuestion: null,
      lastOwnerAnswer: { questionId, answer: "revise" }
    });
    expect(await runCli(args, { makeRunLoop: fakeLoop })).toBe(0);

    const limitQuestion = "10000000-0000-4000-8000-000000000002";
    const atLimit = readCursorsState(paths);
    writeCursorsState(
      paths,
      cursorsStateSchema.parse({
        ...atLimit,
        issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 3 },
        ownerQuestion: {
          id: limitQuestion,
          kind: "revision-limit",
          round: 3,
          allowedAnswers: ["retry", "abandon"],
          createdAt: "2026-08-11T17:01:00.000Z"
        }
      })
    );
    const errors: string[] = [];
    expect(
      await runCli(["answer", limitQuestion, "revise", "--issue", "1", "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("not allowed");
    expect(readCursorsState(paths).issueCursor.round).toBe(3);
  });
});

describe("CLI — install, doctor, and the hook bridge", () => {
  const installedWorkspace = () => {
    ensureBuilt();
    const product = makeProduct();
    productFixtures.push(product);
    execFileSync("git", ["remote", "set-url", "origin", "https://github.com/example/myserver.git"], {
      cwd: product.productRoot
    });
    const declarePath = writeDeclaration(product.workspaceRoot, {
      checks: [{ name: "test", argv: ["true"] }],
      verify: { precommit: [{ name: "ok", argv: ["true"] }], prepush: [] },
      workflowCriticalPrefixes: ["cmd/"]
    });
    return { product, declarePath };
  };

  const installArgs = (product: ProductFixture, declarePath: string): string[] => [
    "install",
    "--product",
    product.productRoot,
    "--coord-root",
    product.coordRoot,
    "--agents",
    "claude",
    "--profile",
    "solo",
    "--declare",
    declarePath
  ];

  it("accepts the boolean switches without swallowing the next option", async () => {
    const { product, declarePath } = installedWorkspace();
    const out: string[] = [];
    const code = await runCli([...installArgs(product, declarePath), "--dry-run"], {
      io: { stdout: (message) => out.push(message) }
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("would clone");
    expect(existsSync(join(product.coordRoot, "workspaces"))).toBe(false);
  });

  it("emits a config that coord start accepts unchanged", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { io: { stdout: () => undefined } })).toBe(0);

    const configPath = join(product.coordRoot, "config.json");
    const runtime = join(product.coordRoot, "runtime");
    const messages: string[] = [];
    const started = await runCli(
      ["start", "1", "--profile", "solo", "--config", configPath, "--coord-root", runtime],
      {
        io: { stdout: (message) => messages.push(message), stderr: (message) => messages.push(message) },
        makeRunLoop: fakeLoop,
        processRunner: successfulStartGit
      }
    );
    expect(started).toBe(0);
    expect(messages.join("")).not.toContain("Invalid");
    expect(messages.join("")).not.toContain("Unknown option");
    expect(existsSync(issueRuntimePaths(runtime, 1).issueSnapshot)).toBe(true);

    // The mailbox is frozen into start.json rather than re-read from config on
    // every command: a reinstall that moved it would otherwise leave the
    // coordinator polling a tree no running harness holds a grant to.
    const started1 = readStartState(issueRuntimePaths(runtime, 1));
    const configured = readConfig(configPath).completesRoot as string;
    expect(started1.completesRoot).toBe(configured);
    const paths = issueRuntimePaths(runtime, 1, started1.completesRoot);
    expect(existsSync(agentRuntimePaths(paths, "claude").completeDir)).toBe(true);
    expect(agentRuntimePaths(paths, "claude").complete.startsWith(`${resolve(runtime)}/`)).toBe(false);
  });

  it("resolves analytics through an onboarded product", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { io: { stdout: () => undefined } })).toBe(0);
    execFileSync(
      "git",
      ["config", "--local", "coord.ownerWorkspaceConfig", join(product.coordRoot, "config.json")],
      { cwd: product.productRoot }
    );
    expect(
      await runCli(["start", "89", "--product", product.productRoot], {
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop,
        startEffects: async () => ({ cleanup: async () => undefined })
      })
    ).toBe(0);
    const paths = issueRuntimePaths(product.coordRoot, 89);
    installFormat4JournalFixture(paths.journal);
    const home = join(product.workspaceRoot, "analytics-home");
    const transcript = join(home, ".claude", "projects", "fixture", "session-claude.jsonl");
    mkdirSync(join(transcript, ".."), { recursive: true });
    copyFileSync(join(process.cwd(), "test", "support", "fixtures", "transcript-claude.jsonl"), transcript);
    const output: string[] = [];
    expect(
      await runCli(["analytics", "--issue", "89", "--product", product.productRoot], {
        home,
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Issue 89 analytics");
    expect(output.join("")).toContain("Token count");
  });

  it("returns doctor's class-specific exit code", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { io: { stdout: () => undefined } })).toBe(0);

    const doctorArgs = ["doctor", "--coord-root", product.coordRoot, "--product", product.productRoot];
    expect(await runCli(doctorArgs, { io: { stdout: () => undefined } })).toBe(0);

    rmSync(join(product.workspaceRoot, "myserver-claude", "start-claude.sh"));
    const errors: string[] = [];
    expect(await runCli(doctorArgs, { io: { stderr: (message) => errors.push(message) } })).toBe(DOCTOR_CODES.launcher);
    expect(errors.join("")).toContain("launcher");
  });

  it("serves the hook bridge from the workspace config", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { io: { stdout: () => undefined } })).toBe(0);
    const clone = join(product.workspaceRoot, "myserver-claude");

    const scope: string[] = [];
    expect(await runCli(["hook-scope", "--clone", clone], { io: { stdout: (message) => scope.push(message) } })).toBe(0);
    // Declared prefixes replace the proposal's; the files it did not declare
    // keep the proposal's, which is what the emitted config records.
    expect(scope.join("")).toBe("prefix\tcmd/\nfile\tgo.mod\nfile\tgo.sum\n");

    expect(await runCli(["hook-verify", "--clone", clone, "--phase", "precommit"], { io: { stdout: () => undefined } })).toBe(0);
  });

  it("keeps the observational agent-event bridge fail-open", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    expect(
      await runCli(["agent-event", "--vendor", "codex"], {
        io: {
          stdin: () => "not-json",
          stdout: (message) => output.push(message),
          stderr: (message) => errors.push(message)
        }
      })
    ).toBe(0);
    expect(output.join("")).toBe("{}\n");
    expect(errors.join("")).toContain("agent-event");
  });

  it("drops an oversized status-line payload before parsing and still answers the tee", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const payload = JSON.stringify({ session_id: "s", padding: "x".repeat(1024 * 1024) });
    expect(
      await runCli(["agent-event", "--vendor", "claude", "--event", "status-line"], {
        io: { stdin: () => payload, stdout: (message) => output.push(message), stderr: (message) => errors.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toBe("{}\n");
    expect(errors.join("")).toContain("exceeds the agent-event bound");
  });

  it("returns a non-continuing response even when an Antigravity Stop observation is rejected", async () => {
    const output: string[] = [];
    expect(
      await runCli(["agent-event", "--vendor", "antigravity", "--event", "Stop"], {
        io: {
          stdin: () => "not-json",
          stdout: (message) => output.push(message),
          stderr: () => undefined
        }
      })
    ).toBe(0);
    expect(JSON.parse(output.join(""))).toEqual({ decision: "allow" });
  });
});
