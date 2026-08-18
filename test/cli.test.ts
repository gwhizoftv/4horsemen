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
import { DOCTOR_CODES } from "../src/doctor.js";
import { renderGitHubIssueSnapshot } from "../src/githubIssue.js";
import { ensureBuilt, makeProduct, writeDeclaration, type ProductFixture } from "./support/workspaceFixture.js";

const roots: string[] = [];
const productFixtures: ProductFixture[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const fixture of productFixtures.splice(0)) fixture.cleanup();
});

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
    for (const argv of [["--version"], ["-V"], ["version"]] as const) {
      const lines: string[] = [];
      expect(await runCli([...argv], { io: { stdout: (message) => lines.push(message) } })).toBe(0);
      expect(lines.join("").trim()).toBe("0.0.8");
    }
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
    expect(action).toContain("requiredPath: .signals/issue-1/joined-codex.json");
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

  it("cleans the snapshot and launched effects when a later startup write fails", async () => {
    const fixture = setup();
    const paths = issueRuntimePaths(fixture.runtime, 1);
    let cleanups = 0;
    const errors: string[] = [];
    expect(
      await runCli(["start", "1", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        startEffects: async () => {
          // Force initializeOperationalState to fail after github-issue.json
          // has been atomically materialized.
          mkdirSync(paths.start, { recursive: true });
          return {
            cleanup: async () => {
              cleanups += 1;
            }
          };
        },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Runtime state already exists");
    expect(cleanups).toBe(1);
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
    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
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
    expect(output.join("")).not.toContain("Tip: coord attach");
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
});
