import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAction } from "../src/action.js";
import { automationDigestMaterial, runCli, type CliRunLoop } from "../src/cli.js";
import { agentRuntimePaths, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import { cursorsStateSchema, readConfig, readCursorsState, readStartState, writeCursorsState } from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-cli-"));
  roots.push(root);
  for (const agent of ["codex", "claude", "cursor"]) {
    const clone = join(root, `clone-${agent}`);
    mkdirSync(clone);
    writeFileSync(join(clone, `start-${agent}.sh`), "#!/usr/bin/env bash\n", { mode: 0o700 });
  }
  mkdirSync(join(root, ".plans/issue-1"), { recursive: true });
  writeFileSync(join(root, ".plans/issue-1/plan.md"), "# Issue 1 plan\n");
  const configPath = join(root, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      project: "fixture",
      origin: join(root, "origin.git"),
      agents: [
        { id: "codex", root: "clone-codex", launcher: "start-codex.sh", delivery: "pull" },
        { id: "claude", root: "clone-claude", launcher: "start-claude.sh", delivery: "pull" },
        { id: "cursor", root: "clone-cursor", launcher: "start-cursor.sh", delivery: "pull" }
      ],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
      maxRevisionRounds: 3,
      prPolicy: "owner-only",
      digestPaths: [".plans/issue-{issue}/plan.md"],
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
const successfulStartGit = async (argv: readonly string[]) => {
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  if (argv.includes("rev-parse")) return { exitCode: 0, stdout: `${trustedSourceSha}\n`, stderr: "" };
  return { exitCode: 1, stdout: "", stderr: `unexpected command: ${argv.join(" ")}` };
};
const resolvableStartGit = async (argv: readonly string[], cwd: string) => {
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  const [command, ...args] = argv;
  if (command === undefined) return { exitCode: 1, stdout: "", stderr: "empty command" };
  return { exitCode: 0, stdout: execFileSync(command, args, { cwd, encoding: "utf8" }), stderr: "" };
};

describe("CLI", () => {
  it("requires the external coord root explicitly rather than accepting COORD_ROOT", async () => {
    const fixture = setup();
    const messages: string[] = [];
    const result = await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath], {
      io: { stderr: (message) => messages.push(message) }
    });
    expect(result).toBe(2);
    expect(messages.join("")).toContain("--coord-root is required");

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
    expect(action).toContain("requiredPath: .signals/issue-1/joined-codex.json");
    expect(action).not.toContain("stepId:");
    expect(action).not.toContain("evidence:");
    expect(action).not.toContain("gate-");
    expect(readFileSync(runtime.action, "utf8")).toBe(action);
  });

  it("binds the digest to config-relative inputs for the issue being started", async () => {
    const fixture = setup();
    mkdirSync(join(fixture.root, ".plans/issue-7"), { recursive: true });
    writeFileSync(join(fixture.root, ".plans/issue-7/plan.md"), "# Issue 7 plan\n");
    const config = readConfig(fixture.configPath);
    const issue1 = automationDigestMaterial(fixture.configPath, config, 1);
    const issue7 = automationDigestMaterial(fixture.configPath, config, 7);
    expect(issue7.digest).not.toBe(issue1.digest);
    expect(issue7.sources.map((source) => source.id)).toContain(".plans/issue-7/plan.md");

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
  });

  it("rejects incompatible PR publication before creating issue state", async () => {
    const fixture = setup();
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as Record<string, unknown>;
    config.prPolicy = "coord-open-unmerged";
    writeFileSync(fixture.configPath, JSON.stringify(config));
    const errors: string[] = [];
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("requires a supported github.com origin");
    expect(existsSync(join(fixture.runtime, "issue-1"))).toBe(false);
  });

  it("fails closed when the running coordinator source commit cannot be resolved", async () => {
    const fixture = setup();
    const errors: string[] = [];
    let effectsCalled = false;
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: async (argv) =>
          argv.includes("ls-remote")
            ? { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" }
            : { exitCode: 128, stdout: "", stderr: "not a Git checkout" },
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
    expect(errors.join("")).toContain(`resume with coord run --issue 1 --coord-root ${fixture.runtime}`);
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
        reviser: "cursor",
        selection: {
          planAgents: ["codex"],
          implementationAgent: "cursor",
          implementationPin: "e".repeat(40),
          reviser: "cursor"
        },
        accepted: [
          {
            stepId: "R5.reviser-auth",
            agent: "codex",
            round: null,
            submissionSha: "f".repeat(40),
            productPin: "e".repeat(40),
            reviser: "cursor",
            path: ".signals/issue-1/reviser-authorized.json",
            acceptedAt: now
          }
        ],
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
    expect(after.selection.reviser).toBe("cursor");
    expect(errors.join("")).toContain("Cannot drop authorized reviser cursor");
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
