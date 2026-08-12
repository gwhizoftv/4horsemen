import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeAction } from "../src/action.js";
import { automationDigestMaterial, runCli, type CliRunLoop } from "../src/cli.js";
import { agentRuntimePaths, issueRuntimePaths } from "../src/paths.js";
import { buildOrder } from "../src/runLoop.js";
import { canonicalIssueSnapshot } from "../src/githubIssue.js";
import { cursorsStateSchema, readConfig, readCursorsState, readStartState, writeCursorsState } from "../src/state.js";
import { DOCTOR_CODES } from "../src/doctor.js";
import { onboard, uninstall } from "../src/install.js";
import { ensureBuilt, makeProduct, repoRoot, writeDeclaration, type ProductFixture } from "./support/workspaceFixture.js";

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
      origin: "https://github.com/example/fixture",
      agents: [
        { id: "codex", root: "clone-codex", launcher: "start-codex.sh", delivery: "pull" },
        { id: "claude", root: "clone-claude", launcher: "start-claude.sh", delivery: "pull" },
        { id: "cursor", root: "clone-cursor", launcher: "start-cursor.sh", delivery: "pull" }
      ],
      branch: "issue-{issue}/{agent}",
      baseBranch: "main",
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

/**
 * A `gh issue view` that answers for any issue number, so the digest binds to
 * real fetched bytes without a network. Failure fixtures override it.
 */
export const fakeGh = (
  overrides: { title?: string; body?: string; missing?: boolean } = {}
) => async (argv: readonly string[]) => {
  const issue = Number(argv[3]);
  if (overrides.missing === true) {
    return { exitCode: 1, stdout: "", stderr: `GraphQL: Could not resolve to an Issue with the number of ${issue}.` };
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      number: issue,
      title: overrides.title ?? `Fixture issue ${issue}`,
      body: overrides.body ?? `Body for issue ${issue}`,
      url: `https://github.com/example/fixture/issues/${issue}`
    }),
    stderr: ""
  };
};

export const issueSnapshotFor = (issue: number, overrides: { title?: string; body?: string } = {}): string =>
  canonicalIssueSnapshot({
    repository: "example/fixture",
    number: issue,
    title: overrides.title ?? `Fixture issue ${issue}`,
    body: overrides.body ?? `Body for issue ${issue}`,
    url: `https://github.com/example/fixture/issues/${issue}`
  });

const successfulStartGit = async (argv: readonly string[], cwd: string) => {
  if (argv[0] === "gh") return fakeGh()(argv);
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  if (argv.includes("rev-parse")) return { exitCode: 0, stdout: `${trustedSourceSha}\n`, stderr: "" };
  return { exitCode: 1, stdout: "", stderr: `unexpected command: ${argv.join(" ")} in ${cwd}` };
};
const resolvableStartGit = async (argv: readonly string[], cwd: string) => {
  if (argv[0] === "gh") return fakeGh()(argv);
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  const [command, ...args] = argv;
  if (command === undefined) return { exitCode: 1, stdout: "", stderr: "empty command" };
  return { exitCode: 0, stdout: execFileSync(command, args, { cwd, encoding: "utf8" }), stderr: "" };
};

describe("CLI", () => {
  it("never takes the runtime root from the environment", async () => {
    const fixture = setup();
    const elsewhere = mkdtempSync(join(tmpdir(), "coord-not-a-product-"));
    roots.push(elsewhere);
    const messages: string[] = [];
    // COORD_ROOT is not a supported input: with no --coord-root and no
    // onboarded product at the cwd, this must fail rather than adopt it.
    expect(
      await runCli(["run", "--issue", "1"], {
        io: {
          cwd: elsewhere,
          env: { COORD_ROOT: fixture.runtime },
          stderr: (message) => messages.push(message)
        }
      })
    ).toBe(2);
    expect(messages.join("")).toContain("not inside a git worktree");
    expect(messages.join("")).not.toContain(fixture.runtime);
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

  it("binds the digest to the config and the fetched GitHub issue, with no owner plan file", async () => {
    const fixture = setup();
    const config = readConfig(fixture.configPath);
    const issue1 = automationDigestMaterial(fixture.configPath, config, 1, issueSnapshotFor(1));
    const issue7 = automationDigestMaterial(fixture.configPath, config, 7, issueSnapshotFor(7));
    expect(issue7.digest).not.toBe(issue1.digest);
    expect(issue7.sources.map((source) => source.id)).toEqual(["config", "github-issue"]);
    // Only the issue body differs: the work statement must reach the digest.
    const reworded = automationDigestMaterial(fixture.configPath, config, 7, issueSnapshotFor(7, { body: "rewritten" }));
    expect(reworded.digest).not.toBe(issue7.digest);

    const elsewhere = mkdtempSync(join(tmpdir(), "coord-other-cwd-"));
    roots.push(elsewhere);
    expect(
      await runCli(["start", "7", "--profile", "solo", "--config", fixture.configPath, "--coord-root", fixture.runtime], {
        io: { cwd: elsewhere },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 7);
    expect(readStartState(paths)).toMatchObject({
      automationDigest: issue7.digest,
      automationDigestScheme: "sha256-length-prefixed-v1"
    });
    // The persisted snapshot is the exact bytes that were hashed, so an audit
    // can re-derive the digest from the run's own files.
    expect(readFileSync(paths.githubIssue, "utf8")).toBe(issueSnapshotFor(7));
    expect(existsSync(join(fixture.root, ".plans"))).toBe(false);
  });

  it("rejects incompatible PR publication before creating issue state", async () => {
    const fixture = setup();
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as Record<string, unknown>;
    config.prPolicy = "coord-open-unmerged";
    config.origin = join(fixture.root, "origin.git");
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
        processRunner: async (argv) => {
          if (argv[0] === "gh") return fakeGh()(argv);
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

describe("CLI — install, doctor, and the hook bridge", () => {
  const installedWorkspace = () => {
    ensureBuilt();
    const product = makeProduct();
    productFixtures.push(product);
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
    declarePath,
    // A github.com origin, because the work statement for a run is now a real
    // GitHub issue; the fixture answers `gh` without a network.
    "--origin",
    "https://github.com/example/myserver"
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

    // A single product onboards flat: no workspaces/<project>/ indirection.
    const configPath = join(product.coordRoot, "config.json");
    expect(existsSync(join(product.coordRoot, "workspaces"))).toBe(false);
    const messages: string[] = [];
    const started = await runCli(["start", "1", "--config", configPath, "--coord-root", product.coordRoot], {
      io: { stdout: (message) => messages.push(message), stderr: (message) => messages.push(message) },
      makeRunLoop: fakeLoop,
      processRunner: successfulStartGit
    });
    // Start must succeed outright: the installer's config needs no editing, and
    // no owner-authored plan file exists anywhere. --profile is not repeated
    // either; the workspace records the one install chose.
    expect(messages.join("")).not.toContain("Invalid");
    expect(started).toBe(0);
    const paths = issueRuntimePaths(product.coordRoot, 1);
    expect(readStartState(paths).profile).toBe("solo");
    expect(readFileSync(paths.githubIssue, "utf8")).toContain("Fixture issue 1");
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

describe("coord <n> — the daily command", () => {
  /** An onboarded product whose runtime the locator points at. */
  const onboarded = () => {
    ensureBuilt();
    const product = makeProduct("go", "myserver");
    productFixtures.push(product);
    const io: string[] = [];
    const result = onboard({
      installRoot: repoRoot,
      productRoot: product.productRoot,
      coordRoot: product.coordRoot,
      agents: ["claude"],
      profile: "solo",
      dryRun: false,
      log: (message) => io.push(message)
    });
    expect(result.exitCode).toBe(0);
    // Onboard derives origin from the product's remote, which is a local bare
    // repo in the fixture; the work statement now has to be a GitHub issue.
    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as Record<string, unknown>;
    config.origin = "https://github.com/example/myserver";
    writeFileSync(result.configPath, `${JSON.stringify(config, null, 2)}\n`);
    return { product, configPath: result.configPath };
  };

  it("resolves the product from the cwd, starts the issue, and enters the run loop", async () => {
    const { product } = onboarded();
    let ran = 0;
    const output: string[] = [];
    const code = await runCli(["7"], {
      io: { cwd: product.productRoot, stdout: (message) => output.push(message) },
      processRunner: successfulStartGit,
      makeRunLoop: (paths) => ({ ...fakeLoop(paths), run: async () => void (ran += 1) })
    });
    expect(code).toBe(0);
    expect(ran).toBe(1);

    const paths = issueRuntimePaths(product.coordRoot, 7);
    expect(readStartState(paths)).toMatchObject({ issue: 7, profile: "solo" });
    // No --profile, --config, or --coord-root was typed anywhere.
    expect(output.join("")).toContain("Fixture issue 7");
  });

  it("resumes an already-started issue instead of refusing it", async () => {
    const { product } = onboarded();
    const options = {
      io: { cwd: product.productRoot, stdout: () => undefined },
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    };
    expect(await runCli(["7"], options)).toBe(0);

    // The second invocation is the one after Ctrl-C. Inheriting start's refusal
    // here would break the daily command.
    const messages: string[] = [];
    const again = await runCli(["7"], { ...options, io: { ...options.io, stdout: (m) => messages.push(m) } });
    expect(again).toBe(0);
    expect(messages.join("")).toContain("Resuming issue 7");

    // Explicit `coord start` still refuses, so nothing silently reuses a session
    // where the operator asked for a new one.
    const errors: string[] = [];
    expect(
      await runCli(["start", "7"], {
        io: { cwd: product.productRoot, stderr: (m) => errors.push(m) },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Runtime state already exists");
  });

  it("resolves through --product from an unrelated directory", async () => {
    const { product } = onboarded();
    const elsewhere = mkdtempSync(join(tmpdir(), "coord-elsewhere-"));
    roots.push(elsewhere);
    expect(
      await runCli(["7", "--product", product.productRoot], {
        io: { cwd: elsewhere, stdout: () => undefined },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(existsSync(issueRuntimePaths(product.coordRoot, 7).issueRoot)).toBe(true);
  });

  it("refuses to guess when the cwd is not an onboarded product", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "coord-elsewhere-"));
    roots.push(elsewhere);
    const errors: string[] = [];
    expect(
      await runCli(["7"], {
        io: { cwd: elsewhere, stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("not inside a git worktree");
    expect(errors.join("")).toContain("--product");
  });

  it("names the onboard remedy for a git repository that was never onboarded", async () => {
    const product = makeProduct("go", "notonboarded");
    productFixtures.push(product);
    const errors: string[] = [];
    expect(
      await runCli(["7"], {
        io: { cwd: product.productRoot, stderr: (message) => errors.push(message) },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toMatch(/has not been onboarded/);
    expect(errors.join("")).toContain("coord onboard");
  });

  it("fails before any runtime or launch effect when the issue cannot be read", async () => {
    const { product } = onboarded();
    let effectsCalled = false;
    const errors: string[] = [];
    const code = await runCli(["7"], {
      io: { cwd: product.productRoot, stderr: (message) => errors.push(message) },
      processRunner: async (argv, cwd) => (argv[0] === "gh" ? fakeGh({ missing: true })(argv) : successfulStartGit(argv, cwd)),
      startEffects: async () => {
        effectsCalled = true;
        return { cleanup: async () => undefined };
      },
      makeRunLoop: fakeLoop
    });
    expect(code).toBe(2);
    expect(errors.join("")).toContain("gh issue create");
    // R5/R8: no tmux session, no mirror, no half-created runtime directory.
    expect(effectsCalled).toBe(false);
    expect(existsSync(issueRuntimePaths(product.coordRoot, 7).issueRoot)).toBe(false);
  });
});

describe("compatibility with an existing nested install", () => {
  it("start, doctor, and uninstall all still resolve workspaces/<project>/config.json", async () => {
    ensureBuilt();
    const product = makeProduct("go", "myserver");
    productFixtures.push(product);
    const io: string[] = [];
    const log = (message: string) => io.push(message);

    // Occupy the flat slot with another product so this one is nested, which is
    // the layout an install from before this change produced.
    mkdirSync(product.coordRoot, { recursive: true });
    writeFileSync(join(product.coordRoot, "config.json"), `${JSON.stringify({ project: "someone-else" }, null, 2)}\n`);

    const result = onboard({
      installRoot: repoRoot,
      productRoot: product.productRoot,
      coordRoot: product.coordRoot,
      agents: ["claude"],
      profile: "solo",
      dryRun: false,
      log
    });
    expect(result.location.layout).toBe("nested");
    expect(result.configPath).toBe(join(product.coordRoot, "workspaces", "myserver", "config.json"));

    const config = JSON.parse(readFileSync(result.configPath, "utf8")) as Record<string, unknown>;
    config.origin = "https://github.com/example/myserver";
    writeFileSync(result.configPath, `${JSON.stringify(config, null, 2)}\n`);

    // start: run state lands under the nested workspace, not the outer root.
    expect(
      await runCli(["start", "42", "--product", product.productRoot], {
        io: { cwd: product.productRoot, stdout: () => undefined },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(existsSync(join(result.location.workspaceRoot, "issue-42"))).toBe(true);
    expect(existsSync(join(product.coordRoot, "issue-42"))).toBe(false);

    // doctor: resolves the nested config without being told where it is, with
    // --product and with no flags at all from inside the product.
    expect(
      await runCli(["doctor", "--product", product.productRoot], { io: { cwd: product.productRoot, stdout: () => undefined } })
    ).toBe(0);
    expect(await runCli(["doctor"], { io: { cwd: product.productRoot, stdout: () => undefined } })).toBe(0);

    // uninstall: finds it, and leaves the other product's flat config alone.
    uninstall({
      coordRoot: product.coordRoot,
      productRoot: product.productRoot,
      deleteClones: false,
      wipeRuntime: false,
      deleteCoordination: false,
      force: false,
      dryRun: false,
      log
    });
    expect(existsSync(result.configPath)).toBe(false);
    expect(existsSync(join(product.coordRoot, "config.json"))).toBe(true);
  });
});
