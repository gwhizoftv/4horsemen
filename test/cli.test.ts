import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeAction } from "../src/action.js";
import { automationDigestMaterial, runCli, type CliRunLoop } from "../src/cli.js";
import { agentRuntimePaths, issueRuntimePaths } from "../src/paths.js";
import { buildOrder, runArgv, type ProcessRunner } from "../src/runLoop.js";
import type { TerminalInput, TerminalOutput } from "../src/interactive.js";
import {
  cursorsStateSchema,
  readConfig,
  readCursorsState,
  readJournal,
  readStartState,
  writeCursorsState
} from "../src/state.js";
import { DOCTOR_CODES } from "../src/doctor.js";
import { observeAgentLifecycle, readAgentLifecycle } from "../src/agentLifecycle.js";
import { syncAgentLifecycleHooks } from "../src/agentHookSync.js";
import { effectOptions, writeAgentLauncher, writeGitWrapper } from "../src/setupWorkspace.js";
import { ingestContainmentProbe } from "../src/shellGuard.js";
import { renderGitHubIssueSnapshot } from "../src/githubIssue.js";
import { ensureBuilt, git as fixtureGit, makeProduct, repoRoot, writeDeclaration, type ProductFixture } from "./support/workspaceFixture.js";
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

it("attach repairs terminals for a paused issue without running or releasing it", async () => {
  const fixture = setup();
  await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
    processRunner: successfulStartGit, makeRunLoop: fakeLoop, io: { stdout: () => undefined }
  });
  const paths = issueRuntimePaths(fixture.runtime, 1);
  const before = readCursorsState(paths);
  writeCursorsState(paths, cursorsStateSchema.parse({ ...before, manualPaused: true, paused: true }));
  const bytes = readFileSync(paths.cursors, "utf8");
  let restored = 0;
  expect(await runCli(["attach", "1", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
    io: { stdout: () => undefined }, sessionExists: async () => false,
    makeRunLoop: () => ({ ...fakeLoop(paths), restoreTerminals: async () => { restored++; },
      run: async () => { throw new Error("attach must not run workflow"); } })
  })).toBe(0);
  expect(restored).toBe(1);
  expect(readFileSync(paths.cursors, "utf8")).toBe(bytes);
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
  if (argv[3] === "coord-agent-maintenance") {
    return { exitCode: 0, stdout: argv.at(-1) === "--version" ? `${argv.at(-2)} fixture-version\n` : "", stderr: "" };
  }
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
  // Only Git may reach the real executable fallback; never update host vendors.
  if (argv[0] !== "git") return successfulStartGit(argv);
  if (argv.includes("ls-remote")) {
    return { exitCode: 0, stdout: `${baselineSha}\trefs/heads/main\n`, stderr: "" };
  }
  const [command, ...args] = argv;
  if (command === undefined) return { exitCode: 1, stdout: "", stderr: "empty command" };
  return { exitCode: 0, stdout: execFileSync(command, args, { cwd, encoding: "utf8" }), stderr: "" };
};

describe("fresh-start agent maintenance", () => {
  it("records Muse's version without running an update command", async () => {
    const f = setup();
    const clone = join(f.root, "clone-muse");
    mkdirSync(clone);
    writeFileSync(join(clone, "start-muse.sh"), "#!/bin/sh\n", { mode: 0o700 });
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    config.agents.push({ id: "muse", root: clone, launcher: "start-muse.sh", delivery: "pull" });
    writeFileSync(f.configPath, JSON.stringify(config));
    const calls: string[] = [], output: string[] = [], errors: string[] = [];
    expect(await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime], {
      makeRunLoop: fakeLoop,
      io: { stdout: (line) => output.push(line), stderr: (line) => errors.push(line) },
      processRunner: async (argv) => {
        if (argv[3] === "coord-agent-maintenance") calls.push(`${argv.at(-2)} ${argv.at(-1)}`);
        return successfulStartGit(argv);
      }
    })).toBe(0);
    expect(calls).toEqual([
      "codex update", "claude update", "agent update",
      "codex --version", "claude --version", "agent --version", "muse --version"
    ]);
    expect(readStartState(issueRuntimePaths(f.runtime, 1)).agentVersions?.muse).toBe("muse fixture-version");
    expect(output.join("")).toContain("muse has no update command; recording the installed version.");
    expect(errors.join("")).not.toContain("WARNING: muse");
  });

  it.each(["start", "numeric"])("awaits updates and records versions before %s launches", async (entry) => {
    const f = setup();
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    const agyRoot = join(f.root, "clone-antigravity");
    mkdirSync(agyRoot);
    writeFileSync(join(agyRoot, "start-antigravity.sh"), "#!/bin/sh\n", { mode: 0o700 });
    config.agents.push({ id: "antigravity", root: agyRoot, launcher: "start-antigravity.sh" });
    writeFileSync(f.configPath, JSON.stringify(config));
    const paths = issueRuntimePaths(f.runtime, 1);
    const profile = entry === "start" ? "consensus" : "solo";
    const commands = profile === "solo" ? ["codex"] : ["codex", "claude", "agent", "agy"];
    const ids = profile === "solo" ? ["codex"] : ["codex", "claude", "cursor", "antigravity"];
    const versions = Object.fromEntries(ids.map((id, i) => [id, `${commands[i]} fixture-version`]));
    const calls: string[] = [], output: string[] = [];
    let release!: () => void, entered!: () => void, launched = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const updating = new Promise<void>((resolve) => { entered = resolve; });
    const runner: ProcessRunner = async (argv, cwd, options) => {
      if (argv[3] === "coord-agent-maintenance") {
        const step = argv.at(-1)!;
        calls.push(`${argv.at(-2)} ${step}`);
        expect(cwd).toBe(join(f.root, `clone-${argv[5]}`));
        expect(options?.timeoutMs).toBe(step === "update" ? 180_000 : 5_000);
        if (calls.length === 1) { entered(); await gate; }
      }
      return successfulStartGit(argv);
    };
    const pending = runCli([...(entry === "start" ? ["start", "1"] : ["1"]), "--profile", profile,
      "--config", f.configPath, "--coord-runtime", f.runtime], {
      processRunner: runner, makeRunLoop: fakeLoop, io: { stdout: (line) => output.push(line) },
      startEffects: async () => {
        launched = true;
        expect(readStartState(paths).agentVersions).toEqual(versions);
        expect(calls).toEqual([...commands.map((c) => `${c} update`), ...commands.map((c) => `${c} --version`)]);
        for (const id of ids) expect(output.join("")).toContain(`Agent ${id} version: ${versions[id]}`);
        return { cleanup: async () => undefined };
      }
    });
    await updating;
    try {
      expect(launched).toBe(false);
      expect(existsSync(paths.start)).toBe(false);
      expect(calls).toEqual(["codex update"]);
    } finally { release(); }
    expect(await pending).toBe(0);
    expect(launched).toBe(true);
  });

  it.each(["exit", "timeout", "missing", "selector"])("warns and continues after %s failures without inventing versions", async (failure) => {
    const f = setup();
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    const customRoot = join(f.root, "custom");
    mkdirSync(customRoot);
    writeFileSync(join(customRoot, "custom.sh"), "#!/bin/sh\n", { mode: 0o700 });
    config.agents.push({ id: "gemini", root: customRoot, launcher: "custom.sh" });
    writeFileSync(f.configPath, JSON.stringify(config));
    const rejectedNode = join(customRoot, "node"), vendorLog = join(f.root, "unexpected-vendor");
    if (failure === "selector") {
      writeFileSync(rejectedNode, '#!/bin/sh\necho v16.18.0\n', { mode: 0o700 });
      writeFileSync(join(customRoot, "codex"), `#!/bin/sh\necho ran > '${vendorLog}'\n`, { mode: 0o700 });
    }
    const calls: string[] = [], errors: string[] = [], output: string[] = [];
    expect(await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime], {
      makeRunLoop: fakeLoop, io: { stdout: (s) => output.push(s), stderr: (s) => errors.push(s) },
      processRunner: async (argv, cwd, options) => {
        if (argv[3] === "coord-agent-maintenance") {
          calls.push(`${argv.at(-2)} ${argv.at(-1)}`);
          if (argv[5] === "codex") {
            if (failure === "selector") return runArgv(argv, cwd, { ...options,
              env: { ...process.env, COORD_NODE: rejectedNode, PATH: `${customRoot}:/usr/bin:/bin` } });
            if (failure === "missing") throw new Error("spawn ENOENT");
            if (failure === "timeout" && argv.at(-1) === "--version") return { exitCode: 0, stdout: " \n", stderr: "" };
            return { exitCode: failure === "timeout" ? 124 : 1, stdout: "", stderr: failure === "timeout" ? "Timed out" : "offline" };
          }
        }
        return successfulStartGit(argv);
      }
    })).toBe(0);
    expect(readStartState(issueRuntimePaths(f.runtime, 1)).agentVersions).toEqual({
      codex: null, claude: "claude fixture-version", cursor: "agent fixture-version", gemini: null
    });
    expect(calls).toEqual(["codex update", "claude update", "agent update", "codex --version", "claude --version", "agent --version"]);
    expect(errors.join("")).toContain("WARNING: codex update:");
    expect(errors.join("")).toContain("WARNING: codex --version:");
    expect(errors.join("")).toContain("gemini update skipped");
    expect(output.join("")).toContain("Agent codex version: unknown");
    if (failure === "selector") {
      expect(errors.join("")).toContain("COORD_NODE is not a supported Node");
      expect(existsSync(vendorLog)).toBe(false);
    }
  });

  it("does not update or replace the version snapshot on attach, resume, run, or numeric continuation", async () => {
    const f = setup();
    expect(await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime], {
      processRunner: successfulStartGit, makeRunLoop: fakeLoop, io: { stdout: () => undefined }
    })).toBe(0);
    const paths = issueRuntimePaths(f.runtime, 1);
    const before = readFileSync(paths.start, "utf8");
    const processRunner = vi.fn<ProcessRunner>(async () => { throw new Error("recovery must not run maintenance"); });
    for (const argv of [["attach", "1", "--config", f.configPath], ["resume", "--issue", "1"],
      ["run", "--issue", "1"], ["1", "--config", f.configPath]]) {
      expect(await runCli([...argv, "--coord-runtime", f.runtime], { processRunner,
        makeRunLoop: (p) => ({ ...fakeLoop(p), restoreTerminals: async () => undefined }),
        io: { stdout: () => undefined }
      })).toBe(0);
    }
    expect(processRunner).not.toHaveBeenCalled();
    expect(readFileSync(paths.start, "utf8")).toBe(before);
  });

  it.each([
    { id: "codex", label: "coord", nodeScript: true, pinned: true },
    { id: "claude", label: "home", nodeScript: false, pinned: true, coordClaude: false },
    { id: "claude", label: "home", nodeScript: false, pinned: true },
    { id: "claude", label: "coord", nodeScript: true, pinned: true, nativeClaude: "absent" },
    { id: "claude", label: "coord", nodeScript: true, pinned: true, nativeClaude: "not-executable" },
    { id: "cursor", label: "coord", nodeScript: false, pinned: true },
    { id: "antigravity", label: "home", nodeScript: false, pinned: true },
    { id: "muse", label: "home", nodeScript: false, pinned: true },
    { id: "claude", label: "pinned", nodeScript: true, pinned: true },
    { id: "claude", label: "coord", nodeScript: true, pinned: false, nativeClaude: "absent" }
  ])("updates and launches the same $id installation ($label, product pin: $pinned, case %#)", async ({
    id, label, nodeScript, pinned, nativeClaude = "executable", coordClaude = true
  }) => {
    const f = setup();
    const clone = join(f.root, "clone-codex");
    const home = join(f.root, "home"), nvm = join(home, ".nvm");
    const ownerBin = join(f.root, "owner bin"), pinnedBin = join(f.root, "pinned bin"), localBin = join(home, ".local/bin");
    const coordBin = join(f.root, "coord bin");
    for (const dir of [nvm, ownerBin, pinnedBin, localBin, coordBin]) mkdirSync(dir, { recursive: true });
    const executable = id === "cursor" ? "agent" : id === "antigravity" ? "agy" : id;
    const log = join(f.root, "vendor.log");
    for (const [dir, candidate] of [[ownerBin, "owner"], [pinnedBin, "pinned"], [localBin, "home"], [coordBin, "coord"]]) {
      // The fallback case has an installation discoverable only after nvm use.
      if (label === "pinned" && candidate !== "pinned") continue;
      if (id === "claude") {
        if (candidate === "coord" && !coordClaude) continue;
        if (candidate === "home" && nativeClaude === "absent") continue;
        if (candidate === "owner" && label === "home") {
          writeFileSync(join(dir!, executable), '#!/bin/sh\necho "Error: claude native binary not installed." >&2\nexit 1\n', { mode: 0o700 });
          continue;
        }
      }
      writeFileSync(join(dir!, executable), (nodeScript ? "#!/usr/bin/env node\n" : "#!/bin/sh\n") +
        `printf '%s|%s|%s|%s|%s\\n' '${candidate}' "$*" "$(node --version)" "\${VENDOR_INTERPRETER:-native}" "\${MUSE_NO_AUTO_UPDATE:-}" >> "$VENDOR_LOG"\n` +
        'case "$1" in update|--version) [ "$(node --version)" = v26.1.0 ] || exit 42 ;; esac\n' +
        `if [ "$1" = --version ]; then printf '%s\\n' '${candidate}-version'; fi\n`, {
        mode: id === "claude" && candidate === "home" && nativeClaude === "not-executable" ? 0o600 : 0o700
      });
    }
    for (const dir of [ownerBin, pinnedBin]) {
      writeFileSync(join(dir, "node"), '#!/bin/sh\nif [ "$1" = --version ]; then echo v16.18.0; else exit 42; fi\n', { mode: 0o700 });
    }
    // No host vendor can shadow these stubs: the real selector resolves this
    // fixture Node, whose interpreter deliberately executes our shell stubs.
    writeFileSync(join(coordBin, "node"), '#!/bin/sh\nif [ "$1" = --version ]; then echo v26.1.0; exit 0; fi\n' +
      'export VENDOR_INTERPRETER=coord\nexec /bin/sh "$@"\n', { mode: 0o700 });
    writeFileSync(join(nvm, "nvm.sh"), 'nvm() { export PATH="$PINNED_BIN:$PATH"; echo "nvm setup noise"; }\n');
    if (pinned) writeFileSync(join(clone, ".nvmrc"), "16\n");
    fixtureGit(clone, "init", "-q", "-b", `issue-1/${id}`);
    fixtureGit(clone, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "--allow-empty", "-m", "base");
    fixtureGit(clone, "config", "coord.cliEntry", join(repoRoot, "dist/main.js"));
    writeAgentLauncher({ installRoot: repoRoot, clone, agent: id, label: id, baseBranch: "main", options: effectOptions(() => undefined, false) });
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    config.agents = [{ id, root: clone, launcher: `start-${id}.sh` }];
    writeFileSync(f.configPath, JSON.stringify(config));
    const env = { ...process.env, HOME: home, NVM_DIR: nvm, PINNED_BIN: pinnedBin,
      PATH: `${ownerBin}:/usr/bin:/bin`, VENDOR_LOG: log, COORD_ISSUE: "", COORD_NODE: join(coordBin, "node"),
      VENDOR_INTERPRETER: undefined, MUSE_NO_AUTO_UPDATE: undefined };
    const before = { ...env };
    const errors: string[] = [];
    const result = await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime], {
      makeRunLoop: fakeLoop, io: { env, stdout: () => undefined, stderr: (line) => errors.push(line) },
      processRunner: (argv, cwd, options) => argv[3] === "coord-agent-maintenance" ? runArgv(argv, cwd, options) : successfulStartGit(argv)
    });
    expect(result, errors.join("")).toBe(0);
    expect(errors).toEqual([]);
    execFileSync("/bin/bash", [join(clone, `start-${id}.sh`)], { cwd: clone, env, stdio: "pipe" });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const runtime = `${nodeScript ? "coord" : "native"}|${id === "muse" ? "1" : ""}`;
    const steps = id === "muse" ? ["--version"] : ["update", "--version"];
    expect(lines.slice(0, -1)).toEqual(steps.map((step) => `${label}|${step}|v26.1.0|${runtime}`));
    expect(lines).toHaveLength(steps.length + 1);
    expect(lines.at(-1)).toMatch(new RegExp(`^${label}\\|`));
    expect(lines.at(-1)).toContain(`|v16.18.0|${runtime}`);
    if (id === "codex") expect(lines.at(-1)).toContain("-c check_for_update_on_startup=false");
    expect(readStartState(issueRuntimePaths(f.runtime, 1)).agentVersions).toEqual({ [id]: `${label}-version` });
    expect(env).toEqual(before);
  });

  it.each(["env-split", "direct"])("preserves %s Node shebang arguments for maintenance and launch", async (shebang) => {
    const f = setup(), clone = join(f.root, "clone-claude");
    const home = join(f.root, "home"), nvm = join(home, ".nvm"), pinnedBin = join(f.root, "pinned");
    const coordBin = join(f.root, 'coord bin "quoted" $literal \\path');
    for (const dir of [nvm, pinnedBin, coordBin]) mkdirSync(dir, { recursive: true });
    symlinkSync(process.execPath, join(coordBin, "node"));
    writeFileSync(join(pinnedBin, "node"), '#!/bin/sh\nif [ "$1" = --version ]; then echo v16.18.0; else exit 42; fi\n', { mode: 0o700 });
    writeFileSync(join(nvm, "nvm.sh"), 'nvm() { export PATH="$PINNED_BIN:$PATH"; }\n');
    writeFileSync(join(clone, ".nvmrc"), "16\n");
    const preload = join(clone, "preload file.cjs"), log = join(f.root, "vendor.log");
    writeFileSync(preload, "global.fixturePreloaded = true;\n");
    const interpreter = shebang === "env-split"
      ? "/usr/bin/env -S node --expose-gc --require './preload file.cjs'"
      : `${pinnedBin}/node --expose-gc  `;
    writeFileSync(join(coordBin, "claude"), `#!${interpreter}\n` +
      'const { appendFileSync } = require("node:fs");\nconst { execFileSync } = require("node:child_process");\n' +
      'const child = execFileSync("node", ["--version"], { encoding: "utf8" }).trim();\n' +
      'appendFileSync(process.env.VENDOR_LOG, JSON.stringify({ gc: typeof global.gc, preloaded: global.fixturePreloaded === true, child, args: process.argv.slice(2) }) + "\\n");\n' +
      'if (process.argv[2] === "--version") console.log("fixture-version");\n', { mode: 0o700 });
    fixtureGit(clone, "init", "-q", "-b", "issue-1/claude");
    fixtureGit(clone, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-q", "--allow-empty", "-m", "base");
    fixtureGit(clone, "config", "coord.cliEntry", join(repoRoot, "dist/main.js"));
    writeAgentLauncher({ installRoot: repoRoot, clone, agent: "claude", label: "claude", baseBranch: "main", options: effectOptions(() => undefined, false) });
    const config = JSON.parse(readFileSync(f.configPath, "utf8"));
    config.agents = [{ id: "claude", root: clone, launcher: "start-claude.sh" }];
    writeFileSync(f.configPath, JSON.stringify(config));
    const env = { ...process.env, HOME: home, NVM_DIR: nvm, PINNED_BIN: pinnedBin, COORD_NODE: join(coordBin, "node"),
      PATH: "/usr/bin:/bin", VENDOR_LOG: log, COORD_ISSUE: "" };
    const errors: string[] = [];
    expect(await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime], {
      makeRunLoop: fakeLoop, io: { env, stdout: () => undefined, stderr: (line) => errors.push(line) },
      processRunner: (argv, cwd, options) => argv[3] === "coord-agent-maintenance" ? runArgv(argv, cwd, options) : successfulStartGit(argv)
    })).toBe(0);
    expect(errors).toEqual([]);
    execFileSync("/bin/bash", [join(clone, "start-claude.sh")], { cwd: clone, env, stdio: "pipe" });
    const records = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records).toEqual([
      { gc: "function", preloaded: shebang === "env-split", child: process.version, args: ["update"] },
      { gc: "function", preloaded: shebang === "env-split", child: process.version, args: ["--version"] },
      { gc: "function", preloaded: shebang === "env-split", child: "v16.18.0", args: ["--permission-mode", "auto"] }
    ]);
    expect(readStartState(issueRuntimePaths(f.runtime, 1)).agentVersions).toEqual({ claude: "fixture-version" });
  });
});

describe("CLI version", () => {
  it("never touches the default terminal under Vitest, even when both host streams are TTYs", async () => {
    const f = setup();
    await runCli(["start", "1", "--profile", "solo", "--config", f.configPath, "--coord-runtime", f.runtime], {
      processRunner: successfulStartGit, makeRunLoop: fakeLoop, io: { stdout: () => undefined }
    });
    const input: TerminalInput = new PassThrough(), output: PassThrough & TerminalOutput = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = vi.fn();
    const run = vi.fn(async (_signal?: AbortSignal) => { expect(_signal).toBeInstanceOf(AbortSignal); });
    // Substitute streams at the process boundary so a regression cannot touch
    // the real developer terminal; deliberately do not inject dependencies.terminal.
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(input as typeof process.stdin);
    const stdout = vi.spyOn(process, "stdout", "get").mockReturnValue(output as unknown as typeof process.stdout);
    let code: number;
    try {
      code = await runCli(["run", "--issue", "1", "--coord-runtime", f.runtime], {
        io: { stdout: () => undefined }, makeRunLoop: (paths) => ({ ...fakeLoop(paths), run })
      });
    } finally { stdin.mockRestore(); stdout.mockRestore(); }
    expect(code).toBe(0);
    expect(run).toHaveBeenCalledOnce();
    expect(input.setRawMode).not.toHaveBeenCalled();
    expect(input.listenerCount("data")).toBe(0);
    expect(output.readableLength).toBe(0);
  });

  it.each(["run", "resume"])("routes %s foreground controls through shared state without another tick or quit teardown", async (command) => {
    const f = setup();
    await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime], {
      processRunner: successfulStartGit, makeRunLoop: fakeLoop, io: { stdout: () => undefined }
    });
    const paths = issueRuntimePaths(f.runtime, 1);
    const input: TerminalInput = new PassThrough(), output: TerminalOutput = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = (raw) => { input.isRaw = raw; };
    let printed = "";
    output.on("data", (chunk) => { printed += String(chunk); });
    const errors: string[] = [];
    const send = async (key: string) => { input.emit("data", key); await new Promise<void>((resolve) => setImmediate(resolve)); };
    let ticks = 0, runs = 0, reminders = 0;
    const code = await runCli([command, ...(command === "resume" ? ["--run"] : []), "--issue", "1", "--coord-runtime", f.runtime], {
      terminal: { input, output }, io: { stdout: (text) => { printed += text; }, stderr: (text) => errors.push(text) },
      makeRunLoop: () => ({ initializeEffects: async () => {}, runTick: async () => { ticks++; return readCursorsState(paths); },
        reminders: () => [{ label: "codex", request: () => { expect(runs).toBe(1); reminders++; return "Reminder requested"; } }],
        run: async (signal) => {
          runs++;
          await send("n"); await send("1"); await send("\r");
          expect(reminders).toBe(1); expect(ticks).toBe(0);
          await send("s"); await send("p");
          expect(readCursorsState(paths).manualPaused).toBe(true);
          // External resume uses the same operation while this runner stays live.
          await runCli(["resume", "--issue", "1", "--coord-runtime", f.runtime], { io: { stdout: () => undefined } });
          await send("p");
          expect(readCursorsState(paths).manualPaused).toBe(true);
          const current = readCursorsState(paths), actionId = actionIdFor("codex");
          const hold = { id: "20000000-0000-4000-8000-000000000001", agent: "codex", actionId,
            sessionId: null, reason: "nudge-loop", evidenceId: "budget", observedAt: current.updatedAt,
            resetsAt: null, confidence: "unknown", retryOwner: "owner" };
          writeCursorsState(paths, cursorsStateSchema.parse({ ...current,
            agents: { ...current.agents, codex: { ...current.agents.codex, actionId } },
            holds: [hold], actionSafety: { codex: { actionId, sends: 4, lastSendAt: current.updatedAt, activityAt: current.updatedAt } }
          }));
          await send("r"); await send("1"); await send("\r"); await send("n");
          expect(readCursorsState(paths).actionSafety.codex?.sends).toBe(4);
          await send("r"); await send("1"); await send("\r"); await send("y");
          expect(readCursorsState(paths)).toMatchObject({ manualPaused: true, paused: true, holds: [], actionSafety: { codex: { sends: 0 } } });
          await send("/"); await send("steer keep existing helpers"); await send("\r");
          expect(readCursorsState(paths).ownerGuidance!.pending[0]!.text).toBe("keep existing helpers");
          await send("d"); await send("3"); await send("\r"); await send("y");
          expect(readCursorsState(paths).activeRoster).toEqual(["codex", "claude"]);
          // Simulate a last slow tick completing concurrently with quit. Normal
          // completion cleanup would try to reset these deliberately dummy clones.
          writeCursorsState(paths, { ...readCursorsState(paths), completed: true });
          await send("q");
          expect(signal?.aborted).toBe(true);
        } })
    });
    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(runs).toBe(1); expect(ticks).toBe(0);
    expect(printed).toContain("Active step: checking agent readiness (R1.join)");
    expect(printed).toContain("Active roster: codex, claude, cursor");
    expect(printed).not.toContain("Clone readiness");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it("restores the foreground terminal if the runner throws", async () => {
    const f = setup();
    await runCli(["start", "1", "--profile", "solo", "--config", f.configPath, "--coord-runtime", f.runtime], {
      processRunner: successfulStartGit, makeRunLoop: fakeLoop, io: { stdout: () => undefined }
    });
    const input: TerminalInput = new PassThrough(), output: TerminalOutput = new PassThrough();
    input.isTTY = output.isTTY = true;
    input.setRawMode = (raw) => { input.isRaw = raw; };
    const errors: string[] = [];
    expect(await runCli(["run", "--issue", "1", "--coord-runtime", f.runtime], {
      terminal: { input, output }, io: { stderr: (text) => errors.push(text) },
      makeRunLoop: (paths) => ({ ...fakeLoop(paths), run: async () => { throw new Error("runner failed"); } })
    })).toBe(2);
    expect(errors.join("")).toContain("runner failed");
    expect(input.isRaw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
  });

  it.each(["codex", "claude", "cursor", "antigravity"])("git-guard %s returns its allow response on malformed or oversized input", async (vendor) => {
    for (const input of ["{broken", "x".repeat(1024 * 1024 + 1), '{"tool_input":{"command":"echo ok"},"command":"echo ok"}']) {
      const output: string[] = [], errors: string[] = [];
      expect(await runCli(["git-guard", "--vendor", vendor, "--clone", "/missing"], {
        io: { stdin: () => input, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) }
      })).toBe(0);
      expect(output.join("")).toBe(vendor === "cursor" ? '{"permission":"allow"}\n' : vendor === "antigravity" ? '{"decision":"allow"}\n' : "");
      if (input.includes("echo ok")) expect(errors).toEqual([]);
      else expect(errors.join("")).toContain("coord git-guard:");
    }
  });

  it("records actual-tool probe observations separately from emitted denials and detects changed policy", async () => {
    const f = setup();
    // Runtime is outside the clones, with its config beside it as installed.
    mkdirSync(f.runtime);
    const configPath = join(f.runtime, "config.json");
    const config = JSON.parse(readFileSync(f.configPath, "utf8")) as { agents: { root: string }[] };
    for (const agent of config.agents) agent.root = join(f.root, agent.root);
    writeFileSync(configPath, JSON.stringify(config));
    expect(await runCli(["start", "1", "--profile", "solo", "--config", configPath, "--coord-runtime", f.runtime], {
      makeRunLoop: fakeLoop, processRunner: successfulStartGit, io: { stdout: () => undefined }
    })).toBe(0);
    const clone = join(f.root, "clone-codex");
    fixtureGit(clone, "init", "-q");
    fixtureGit(clone, "config", "consensus.agentId", "codex");
    fixtureGit(clone, "config", "coord.workspaceConfig", configPath);
    const options = effectOptions(() => undefined, false);
    writeGitWrapper({ installRoot: repoRoot, clone, options });
    syncAgentLifecycleHooks({ clone, agent: "codex", cliEntry: join(repoRoot, "dist/main.js"), options });
    const paths = issueRuntimePaths(f.runtime, 1);
    observeAgentLifecycle(paths, "codex", { kind: "session-start", eventName: "SessionStart", sessionId: "tool-session" });
    const env = { ...process.env, COORD_ISSUE: "1", COORD_GIT_DELEGATE: "" };
    const output: string[] = [];
    const io = { cwd: clone, env, stdout: (text: string) => output.push(text), stdin: () => JSON.stringify({
      tool_input: { command: "git status --porcelain" }, cwd: clone, session_id: "tool-session"
    }) };
    expect(await runCli(["git-guard", "--vendor", "codex", "--clone", clone], { io })).toBe(0);
    expect(output.join("")).toContain('"deny"');
    expect(readAgentLifecycle(paths).agents.codex?.containment?.probe).toBeNull();
    const probe = async (resolved: string, result: string, overrides: NodeJS.ProcessEnv = {}) => {
      output.length = 0;
      const before = readFileSync(paths.agentLifecycle, "utf8");
      expect(await runCli(["containment-probe", "--resolved-git", resolved, "--tool-result", result,
        "--vendor-version", "test-version", "--issue", "1"], { io: { ...io, env: { ...env, ...overrides } } })).toBe(0);
      expect(readFileSync(paths.agentLifecycle, "utf8")).toBe(before);
      ingestContainmentProbe(paths, clone, "codex");
      expect(readAgentLifecycle(paths).agents.codex?.containment?.probe?.toolResult).toBe(result);
      const revision = readAgentLifecycle(paths).stateRevision;
      ingestContainmentProbe(paths, clone, "codex");
      expect(readAgentLifecycle(paths).stateRevision).toBe(revision);
      return JSON.parse(output.join("")) as { hook: string; shim: string };
    };
    expect(await probe(join(clone, ".coord/bin/git"), "executed")).toMatchObject({ hook: "inactive", shim: "bypassed" });
    expect(await probe(join(clone, ".coord/bin/git"), "shim-refused")).toMatchObject({ hook: "inactive", shim: "active" });
    expect(await probe("/usr/bin/git", "hook-denied")).toMatchObject({ hook: "active", shim: "bypassed" });
    expect(await probe(join(clone, ".coord/bin/git"), "unknown", { COORD_ISSUE: "" })).toMatchObject({ hook: "unverified", shim: "bypassed" });
    const shim = join(clone, ".coord/bin/git");
    writeFileSync(shim, `${readFileSync(shim, "utf8")}\n# updated policy\n`);
    expect(await probe("/usr/bin/git", "hook-denied")).toMatchObject({ hook: "unverified" });
    expect(readJournal(paths)).toContainEqual(expect.objectContaining({ type: "agent-lifecycle",
      details: expect.objectContaining({ kind: "containment-guard-denied", sessionId: "tool-session" }) }));
    const journal = JSON.stringify(readJournal(paths));
    expect(journal).not.toContain("git status --porcelain");
    observeAgentLifecycle(paths, "codex", { kind: "session-start", eventName: "SessionStart", sessionId: "new-session" });
    const afterRestart = readFileSync(paths.agentLifecycle, "utf8");
    ingestContainmentProbe(paths, clone, "codex");
    expect(readFileSync(paths.agentLifecycle, "utf8")).toBe(afterRestart);
    writeFileSync(join(clone, ".coord/containment-observation.json"), "x".repeat(16385));
    ingestContainmentProbe(paths, clone, "codex");
    expect(readFileSync(paths.agentLifecycle, "utf8")).toBe(afterRestart);
  });
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

describe("CLI GitHub account selection", () => {
  const helperKey = "credential.https://github.com.helper";
  /** A real clone already on its issue branch, wired to `account` as coord install would wire it. */
  const wireClone = (clone: string, branch: string, account = "acct"): void => {
    execFileSync("git", ["init", "-q", "-b", branch, clone]);
    execFileSync("git", ["-C", clone, "-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "base"]);
    execFileSync("git", ["-C", clone, "config", "--local", "coord.githubAccount", account]);
    execFileSync("git", ["-C", clone, "config", "--local", "--add", helperKey, ""]);
    execFileSync("git", ["-C", clone, "config", "--local", "--add", helperKey, `!/usr/bin/env node '/coord/dist/main.js' auth git-credential --account ${account}`]);
  };
  const selectAccount = (configPath: string): void => {
    writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, "utf8")) as object, github: { account: "acct" } }));
  };
  type Call = { argv: readonly string[]; env: NodeJS.ProcessEnv | undefined };
  /** gh answers as `acct` with `tok-acct`, or reports no saved credential when token is null. */
  const accountRunner = (calls: Call[], token: string | null = "tok-acct", api = (argv: readonly string[]) =>
    ({ exitCode: 0, stdout: argv[2] === "user" ? "acct\n" : "example/fixture\n", stderr: "" })): ProcessRunner =>
    async (argv, _cwd, options) => {
      calls.push({ argv, env: options?.env });
      if (argv[0] === "gh" && argv[1] === "auth" && argv[2] === "token") {
        return token === null ? { exitCode: 1, stdout: "", stderr: "no account" } : { exitCode: 0, stdout: `${token}\n`, stderr: "" };
      }
      if (argv[0] === "gh" && argv[1] === "api") return api(argv);
      return successfulStartGit(argv);
    };
  const start = (fixture: ReturnType<typeof setup>, runner: ProcessRunner, errors: string[], effects: string[]) =>
    runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
      io: { stdout: () => undefined, stderr: (message) => errors.push(message) },
      processRunner: runner,
      startEffects: async (input) => { effects.push(input.githubAccount ?? "none"); return { cleanup: async () => undefined }; },
      makeRunLoop: fakeLoop
    });

  it("refuses to start before any GitHub or runtime effect when the selected account's credential is unavailable", async () => {
    const fixture = setup();
    selectAccount(fixture.configPath);
    wireClone(join(fixture.root, "clone-codex"), "issue-1/codex");
    const calls: Call[] = [], errors: string[] = [], effects: string[] = [];
    expect(await start(fixture, accountRunner(calls, null), errors, effects)).toBe(2);
    expect(errors.join("")).toContain("GitHub authentication for acct is unavailable.\nRun: coord auth login");
    expect(calls.some((call) => call.argv[1] === "issue" || call.argv.includes("ls-remote"))).toBe(false);
    expect(effects).toEqual([]);
    expect(existsSync(join(fixture.runtime, "issue-1"))).toBe(false);
  });

  it("binds start's gh and git calls to the account, freezes it, and re-validates it on resume", async () => {
    const fixture = setup();
    selectAccount(fixture.configPath);
    wireClone(join(fixture.root, "clone-codex"), "issue-1/codex");
    const calls: Call[] = [], errors: string[] = [], effects: string[] = [];
    expect(await start(fixture, accountRunner(calls), errors, effects)).toBe(0);
    expect(calls.find((call) => call.argv[1] === "issue")?.env?.GH_TOKEN).toBe("tok-acct");
    const lsRemote = calls.find((call) => call.argv.includes("ls-remote"))!.argv;
    expect(lsRemote.slice(0, 3)).toEqual(["git", "-c", `${helperKey}=`]);
    expect(effects).toEqual(["acct"]);
    expect(readStartState(issueRuntimePaths(fixture.runtime, 1)).githubAccount).toBe("acct");

    const resumeErrors: string[] = [];
    expect(await runCli(["run", "--issue", "1", "--coord-runtime", fixture.runtime], {
      io: { stdout: () => undefined, stderr: (message) => resumeErrors.push(message) },
      processRunner: accountRunner([], "tok-acct", () => ({ exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials" })),
      makeRunLoop: (paths) => ({ ...fakeLoop(paths), run: async () => { throw new Error("resume must not run"); } })
    })).toBe(2);
    expect(resumeErrors.join("")).toContain("GitHub authentication for acct has expired or been revoked.\nRun: coord auth login");
  });

  it("validates only the active roster's clones on resume", async () => {
    const fixture = setup();
    selectAccount(fixture.configPath);
    for (const agent of ["codex", "claude", "cursor"]) wireClone(join(fixture.root, `clone-${agent}`), `issue-1/${agent}`);
    expect(await runCli(["start", "1", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
      io: { stdout: () => undefined }, processRunner: accountRunner([]),
      startEffects: async () => ({ cleanup: async () => undefined }), makeRunLoop: fakeLoop
    })).toBe(0);
    const paths = issueRuntimePaths(fixture.runtime, 1);
    const run = () => runCli(["run", "--issue", "1", "--coord-runtime", fixture.runtime], {
      io: { stdout: () => undefined, stderr: () => undefined }, processRunner: accountRunner([]), makeRunLoop: fakeLoop
    });
    execFileSync("git", ["-C", join(fixture.root, "clone-cursor"), "config", "--local", "--unset", "coord.githubAccount"]);
    expect(await run()).toBe(2);
    writeCursorsState(paths, cursorsStateSchema.parse({ ...readCursorsState(paths), activeRoster: ["codex", "claude"] }));
    expect(await run()).toBe(0);
  });

  it("reports the workspace account through coord auth status", async () => {
    const fixture = setup();
    const status = async (runner: ProcessRunner) => {
      const out: string[] = [], err: string[] = [];
      const code = await runCli(["auth", "status", "--config", fixture.configPath], {
        io: { stdout: (message) => out.push(message), stderr: (message) => err.push(message) }, processRunner: runner
      });
      return { code, out: out.join(""), err: err.join("") };
    };
    const unselected = await status(accountRunner([]));
    expect(unselected).toMatchObject({ code: 0 });
    expect(unselected.out).toContain("--github-account");

    selectAccount(fixture.configPath);
    for (const agent of ["codex", "claude", "cursor"]) wireClone(join(fixture.root, `clone-${agent}`), "main");
    const healthy = await status(accountRunner([]));
    expect(healthy.code).toBe(0);
    expect(healthy.out).toContain("GitHub account: acct\nRepository: example/fixture\n");
    expect(healthy.out).toContain("Status: authenticated as acct; repository access verified; agent clones wired.");

    const expired = await status(accountRunner([], "tok-acct", () => ({ exitCode: 1, stdout: "", stderr: "HTTP 401: Bad credentials" })));
    expect(expired.code).toBe(1);
    expect(expired.err).toContain("GitHub authentication for acct has expired or been revoked.\nRun: coord auth login");
  });
});

describe("CLI manual mode", () => {
  it("launches every configured agent without GitHub, runtime, or run-loop effects", async () => {
    const fixture = setup();
    const launches: Array<{ namespace: string | null; group: string; agents: string[] }> = [];
    const output: string[] = [];
    const code = await runCli(["manual", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
    const argv = ["manual", "--config", fixture.configPath, "--coord-runtime", fixture.runtime];
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
    const code = await runCli(["manual", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "7", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["manual", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "7", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        sessionExists: isManual,
        processRunner: async () => {
          throw new Error("conflict must fail before issue lookup");
        }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("coord detach manual");

    expect(
      await runCli(["start", "8", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
        io: { stdout: () => undefined },
        sessionExists: async () => false,
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    errors.length = 0;
    let resumed = false;
    expect(
      await runCli(["run", "--issue", "8", "--coord-runtime", fixture.runtime], {
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
      ["8", "--config", fixture.configPath, "--coord-runtime", fixture.runtime],
      ["attach", "8", "--config", fixture.configPath, "--coord-runtime", fixture.runtime]
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

    // With the owner's consent the leftover manual session is closed (clones
    // checked first) and the issue starts without a separate detach.
    const questions: string[] = [];
    const output: string[] = [];
    expect(
      await runCli(["start", "9", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
        io: { stdout: (message) => output.push(message) },
        sessionExists: isManual,
        confirm: async (question) => { questions.push(question); return true; },
        processRunner: successfulStartGit,
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(questions).toEqual([expect.stringContaining("Manual mode is still open for this workspace")]);
    expect(output.join("")).toContain("Detached manual mode");
    expect(output.join("")).toContain("Started issue 9");

    // A same-issue session left with no runtime is caught before any effect.
    errors.length = 0;
    expect(
      await runCli(["start", "10", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        sessionExists: async (name) => name.startsWith("coord-10"),
        processRunner: async () => {
          throw new Error("a leftover session must refuse before issue lookup");
        }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Run `coord detach 10` first");
    expect(existsSync(issueRuntimePaths(fixture.runtime, 10).issueRoot)).toBe(false);
  });

  it("dispatches exact manual teardown and advertises both manual commands", async () => {
    const fixture = setup();
    const output: string[] = [];
    expect(
      await runCli(["detach", "manual", "--config", fixture.configPath, "--coord-runtime", fixture.runtime, "--dry-run"], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Detached manual mode");
    expect(output.join("")).toContain("Clone readiness:");

    output.length = 0;
    expect(await runCli(["--help"], { io: { stdout: (message) => output.push(message) } })).toBe(0);
    expect(output.join("")).toContain("coord manual");
    expect(output.join("")).toContain("coord detach manual");
    expect(output.join("")).toContain("coord analytics --issue");
  });
});

describe("CLI", () => {
  it("rejects invalid wipe product paths without changing repositories or runtime", async () => {
    const product = makeProduct("plain");
    productFixtures.push(product);
    const clone = join(product.workspaceRoot, "clone-codex");
    fixtureGit(product.workspaceRoot, "clone", "-q", product.originPath, clone);
    fixtureGit(clone, "checkout", "-q", "-b", "issue-392/codex", "origin/main");
    const configPath = join(product.coordRoot, "config.json");
    writeFileSync(configPath, JSON.stringify({
      project: "myserver", origin: product.originPath,
      agents: [{ id: "codex", root: clone, launcher: "start-codex.sh" }],
      checks: [{ name: "ok", argv: ["true"] }]
    }));
    fixtureGit(product.productRoot, "config", "--local", "coord.ownerWorkspaceConfig", configPath);
    const paths = issueRuntimePaths(product.coordRoot, 392, join(product.workspaceRoot, "completes"));
    const drop = agentRuntimePaths(paths, "codex");
    mkdirSync(paths.issueRoot, { recursive: true });
    mkdirSync(drop.completeDir, { recursive: true });
    writeFileSync(paths.journal, "runtime sentinel\n");
    writeFileSync(drop.complete, "mailbox sentinel\n");
    const files = [configPath, paths.journal, drop.complete];
    for (const repo of [product.productRoot, clone]) {
      writeFileSync(join(repo, "README.md"), "staged work\n");
      fixtureGit(repo, "add", "README.md");
      writeFileSync(join(repo, "README.md"), "unstaged work\n");
      writeFileSync(join(repo, "untracked.txt"), "untracked work\n");
      files.push(...[".git/HEAD", ".git/config", ".git/index", "README.md", "untracked.txt"].map((path) => join(repo, path)));
    }
    const snapshot = () => ({
      files: files.map((path) => readFileSync(path)),
      refs: [product.productRoot, clone, product.originPath].map((repo) => fixtureGit(repo, "show-ref"))
    });
    const before = snapshot();
    const missing = join(product.workspaceRoot, "coordinator");
    for (const flags of [["--product", "coordinator"], ["--product", missing], []]) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      expect(await runCli(["wipe-issue", "392", "--force", ...flags], {
        io: { cwd: product.workspaceRoot, stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) }
      })).toBe(2);
      expect(stderr.join("")).toContain(flags.length === 0 ? "not a Git worktree" : "working directory does not exist");
      expect(stderr.join("")).toContain(flags.length === 0 ? product.workspaceRoot : missing);
      expect(stderr.join("")).not.toContain("spawnSync");
      expect(stdout).toEqual([]);
      expect(existsSync(missing)).toBe(false);
      expect(snapshot()).toEqual(before);
    }
  });

  it("does not accept COORD_ROOT instead of explicit or worktree context", async () => {
    const fixture = setup();
    const messages: string[] = [];
    const result = await runCli(["start", "1", "--profile", "solo", "--coord-runtime", fixture.runtime], {
      io: { stderr: (message) => messages.push(message) }
    });
    expect(result).toBe(2);
    expect(messages.join("")).toContain("--coord-runtime needs --config");

    messages.length = 0;
    expect(
      await runCli(["run", "--issue", "1"], {
        io: {
          cwd: fixture.root,
          env: { COORD_ROOT: fixture.runtime },
          stderr: (message) => messages.push(message)
        }
      })
    ).toBe(2);
    expect(messages.join("")).toContain("not a Git worktree");
  });

  it("starts from the exact origin baseline and exposes only the caller action", async () => {
    const fixture = setup();
    const output: string[] = [];
    const result = await runCli(
      ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime],
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
      await runCli(["next", "--issue", "1", "--coord-runtime", fixture.runtime, "--agent", "codex"], {
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
        ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime],
        { processRunner: resolvableStartGit, makeRunLoop: fakeLoop }
      )
    ).toBe(0);
    const output: string[] = [];
    expect(
      await runCli(["status", "--issue", "1", "--coord-runtime", fixture.runtime], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Issue 1:");
    expect(output.join("")).toContain("Final commit (PR head):");
    expect(output.join("")).toContain("Pull request handling: coordinator opens a draft; you review and merge");
  });

  it("resumes only the selected hold, audits budget resets, and reports remaining pauses", async () => {
    const fixture = setup();
    expect(await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime],
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
    const args = ["--issue", "1", "--coord-runtime", fixture.runtime];
    expect(await runCli(["resume", ...args], { io })).toBe(0);
    expect(readCursorsState(paths).paused).toBe(true);
    expect(output.join("")).toContain("1 active hold");
    // Journal pause/resume describes effective workflow state for analytics,
    // not the manual flag changing underneath an independent safety hold.
    expect(readJournal(paths).filter((event) => event.type === "resumed")).toHaveLength(0);
    expect(await runCli(["pause", ...args], { io })).toBe(0);
    expect(await runCli(["resume", ...args], { io })).toBe(0);
    expect(readJournal(paths).filter((event) => event.type === "paused" || event.type === "resumed")).toHaveLength(0);
    expect(await runCli(["restart-action", ...args], { io })).toBe(2);
    expect(await runCli(["resume", ...args, "--reset-nudge-budget"], { io })).toBe(2);
    expect(await runCli(["resume", ...args, "--hold", id], { io })).toBe(2);
    expect(await runCli(["resume", ...args, "--hold", id, "--reset-nudge-budget"], { io })).toBe(0);
    expect(readCursorsState(paths)).toMatchObject({ paused: false, holds: [], actionSafety: { codex: { sends: 0 } } });
    expect(readJournal(paths).filter((event) => event.type === "hold-released")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ hold: id, resetNudgeBudget: true }) })
    ]);
    expect(readJournal(paths).filter((event) => event.type === "resumed")).toHaveLength(1);
    expect(readJournal(paths).slice(-2).map((event) => event.type)).toEqual(["hold-released", "resumed"]);
  });

  it("resolves scoped agent recovery under the lock and runs only on explicit request", async () => {
    const f = setup();
    await runCli(["start", "1", "--config", f.configPath, "--coord-runtime", f.runtime],
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
    const args = ["resume", "--issue", "1", "--coord-runtime", f.runtime];
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
        ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime],
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
      await runCli(["analytics", "--issue", "1", "--coord-runtime", fixture.runtime], {
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
      await runCli(["analytics", "--issue", "1", "--coord-runtime", fixture.runtime, "--json", "true"], {
        io: { stderr: (message) => errors.push(message) }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("Unknown option --json");

    rmSync(paths.journal);
    errors.length = 0;
    expect(
      await runCli(["analytics", "--issue", "1", "--coord-runtime", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) }
      })
    ).toBe(2);
    expect(errors.join("")).toContain("No journal exists for issue 1");
  });

  it("reports completed format-2 analytics read-only while run remains fail-closed", async () => {
    const fixture = setup();
    expect(
      await runCli(
        ["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime],
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
      await runCli(["analytics", "--issue", "1", "--coord-runtime", fixture.runtime], {
        io: { stdout: (message) => output.push(message) }
      })
    ).toBe(0);
    expect(output.join("")).toContain("Source: runtime format 2 (legacy read-only); skipped journal records=1");
    expect(output.join("")).toContain("elapsed=0.13 min paused=0.02 min unpaused=0.12 min");
    expect(output.join("")).toContain("duration=unavailable");
    expect(output.join("")).not.toContain("Token count");

    const errors: string[] = [];
    expect(
      await runCli(["run", "--issue", "1", "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "7", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "999", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "1", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
    expect(errors.join("")).toContain("resume with coord run --issue 1 --coord-runtime");
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
      await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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

  it("resolves coord next from an agent clone without --coord-runtime", async () => {
    const fixture = setup();
    const runtimeConfig = join(fixture.runtime, "config.json");
    mkdirSync(fixture.runtime, { recursive: true });
    const config = JSON.parse(readFileSync(fixture.configPath, "utf8")) as {
      agents: Array<{ id: string; root: string; launcher: string; delivery: string }>;
    };
    config.agents = config.agents.map((agent) => ({ ...agent, root: join(fixture.root, agent.root) }));
    writeFileSync(runtimeConfig, JSON.stringify(config));
    expect(
      await runCli(["start", "1", "--profile", "solo", "--config", runtimeConfig, "--coord-runtime", fixture.runtime], {
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

    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["1", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["resume", "--run", "--issue", "1", "--coord-runtime", fixture.runtime], {
        io: { stdout: (message) => runOutput.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    expect(runOutput.join("")).toContain("already base 1");

    writeFileSync(join(clone, "owner.txt"), "keep\n");
    const refusedOutput: string[] = [];
    const refusedErrors: string[] = [];
    expect(
      await runCli(["run", "--issue", "1", "--coord-runtime", fixture.runtime], {
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
      await runCli(["run", "--issue", "1", "--coord-runtime", fixture.runtime], {
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

    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const paths = issueRuntimePaths(fixture.runtime, 1);
    writeFileSync(join(clone, "wip.txt"), "leftover\n");
    const output: string[] = [];
    expect(
      await runCli(["reset-clones", "1", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
      processRunner: successfulStartGit,
      makeRunLoop: fakeLoop
    });
    const errors: string[] = [];
    const result = await runCli(["drop", "codex", "--issue", "1", "--coord-runtime", fixture.runtime], {
      io: { stderr: (message) => errors.push(message) },
      makeRunLoop: fakeLoop
    });
    expect(result).toBe(2);
    expect(errors.join("")).toContain("final active agent");
  });

  it("refuses to silently rebind an authorized reviser on drop", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "consensus", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["drop", "cursor", "--issue", "1", "--coord-runtime", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    const after = readCursorsState(paths);
    expect(after.activeRoster).toContain("cursor");
    expect(after.derived.implementationSelection?.reviser).toBe("cursor");
    expect(errors.join("")).toContain("Cannot drop authorized reviser cursor");
  });

  it.each([false, true])("resets to plan-ballot after a drop when evidence roster changes (amendment: %s)", async (amendment) => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "consensus", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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

    if (amendment) {
      const prior = readCursorsState(paths);
      const actionId = "10000000-0000-4000-8000-000000000001";
      writeCursorsState(paths, cursorsStateSchema.parse({ ...prior, amendmentSequence: 1,
        issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: 1 },
        pendingAmendment: {
          sequence: 1, request: { agent: "codex", commitSha: "d".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json" },
          proposal: { protocolVersion: 1, artifact: "plan-amendment-request", issue: 1, issueSessionId: "fixture",
            agent: "codex", actionId, inputSetHash: "e".repeat(64), scopeHash: "f".repeat(64),
            explanation: "Missing regression", additionalPaths: [{ path: "test/product.test.ts", reason: "Regression" }] },
          plans: [{ agent: "codex", commitSha: "1".repeat(40), path: ".plans/issue-1/plan-codex.md" }],
          activeRoster: prior.activeRoster, resume: { stepId: "R4.implement", round: null }, requestedAt: now
        },
        agents: Object.fromEntries(Object.entries(prior.agents).map(([agent, cursor]) => [agent, { ...cursor, actionId, stepId: "R4.amend-ballot" }]))
      }));
      for (const agent of prior.activeRoster) {
        const runtime = agentRuntimePaths(paths, agent);
        writeFileSync(runtime.action, "retired amendment order");
        writeFileSync(runtime.complete, `response ${actionId}`);
      }
    }
    expect(
      await runCli(["drop", "cursor", "--issue", "1", "--coord-runtime", fixture.runtime], {
        makeRunLoop: fakeLoop
      })
    ).toBe(0);
    const after = readCursorsState(paths);
    expect(after.activeRoster).toEqual(["codex", "claude"]);
    expect(after.issueCursor.stepId).toBe("R3.plan-ballot");
    expect(after.derived.planSelection).toBeNull();
    if (amendment) {
      expect(after.pendingAmendment).toBeNull();
      expect(after.amendments?.at(-1)?.outcome).toBe("cancelled");
      for (const agent of current.activeRoster) {
        expect(existsSync(agentRuntimePaths(paths, agent).action)).toBe(false);
        expect(existsSync(agentRuntimePaths(paths, agent).complete)).toBe(false);
      }
    }
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
    await runCli(["start", "1", "--profile", "reviewed", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
      await runCli(["drop", "cursor", "--issue", "1", "--coord-runtime", fixture.runtime], { makeRunLoop: fakeLoop })
    ).toBe(0);
    const after = readCursorsState(paths);
    expect(after.accepted).toContainEqual(expect.objectContaining({ stepId: "R2.plan", agent: "codex" }));
    expect(after.activeRoster).toEqual(["codex", "claude"]);
    expect(readFileSync(pending, "utf8")).toBe(`${"c".repeat(40)}\n`);
    expect(after.agents.claude?.actionId).toBeNull();
  });

  it("applies typed owner answers durably and idempotently without allowing round four", async () => {
    const fixture = setup();
    await runCli(["start", "1", "--profile", "solo", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
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
    const args = ["answer", questionId, "revise", "--issue", "1", "--coord-runtime", fixture.runtime];
    expect(await runCli(args, { makeRunLoop: fakeLoop })).toBe(0);
    expect(readCursorsState(paths)).toMatchObject({
      issueCursor: { stepId: "R6.revise", round: 3 },
      ownerQuestion: null,
      ownerGuidance: { generation: 1 },
      lastOwnerAnswer: { questionId, answer: "revise" }
    });
    expect(await runCli(args, { makeRunLoop: fakeLoop })).toBe(0);
    expect(readCursorsState(paths).ownerGuidance!.generation).toBe(1);

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
      await runCli(["answer", limitQuestion, "revise", "--issue", "1", "--coord-runtime", fixture.runtime], {
        io: { stderr: (message) => errors.push(message) },
        makeRunLoop: fakeLoop
      })
    ).toBe(2);
    expect(errors.join("")).toContain("not allowed");
    expect(readCursorsState(paths).issueCursor.round).toBe(3);
  });
});

describe("CLI — install, doctor, and the hook bridge", () => {
  it.each(["onboard", "install", "start", "run", "doctor", "resume", "status", "manual"])(
    "rejects the removed runtime option before %s can act on a default directory",
    async (command) => {
      const root = mkdtempSync(join(tmpdir(), "coord-option-"));
      roots.push(root);
      const runtime = join(root, "runtime");
      const errors: string[] = [];
      const output: string[] = [];
      expect(await runCli([command, "--coord-root", runtime], {
        io: { cwd: root, stdout: (text) => output.push(text), stderr: (text) => errors.push(text) },
        makeRunLoop: () => { throw new Error("invalid options must not create a runner"); },
        processRunner: async () => { throw new Error("invalid options must not invoke processes"); }
      })).toBe(2);
      expect(errors.join("")).toContain("Unknown option --coord-root");
      expect(output).toEqual([]);
      expect(existsSync(runtime)).toBe(false);
      expect(existsSync(join(root, "coord-runtime"))).toBe(false);
    }
  );

  const defaultBranchRunner: ProcessRunner = async (argv) => {
    expect(argv).toEqual(["gh", "api", "repos/example/myserver"]);
    return { exitCode: 0, stdout: JSON.stringify({ default_branch: "main" }), stderr: "" };
  };

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
    "--coord-runtime",
    product.coordRoot,
    "--agents",
    "claude",
    "--profile",
    "solo",
    "--declare",
    declarePath
  ];

  it.each(["onboard", "install"])("%s honors an explicit branch without discovery", async (command) => {
    const { product, declarePath } = installedWorkspace();
    const argv = command === "install" ? installArgs(product, declarePath) : [
      "onboard", product.productRoot, "--coord-runtime", product.coordRoot,
      "--agents", "claude", "--profile", "solo", "--declare", declarePath
    ];
    expect(await runCli([...argv, "--base-branch", "main"], { home: null, io: { stdout: () => undefined },
      processRunner: async () => { throw new Error("explicit branch must skip discovery"); }
    })).toBe(0);
    expect(readConfig(join(product.coordRoot, "config.json")).baseBranch).toBe("main");
    expect(fixtureGit(join(product.workspaceRoot, "myserver-claude"), "config", "consensus.sharedBranch")).toBe("main");
  });

  it.each(["onboard", "install"])("%s leaves setup untouched after a failed lookup", async (command) => {
    const { product, declarePath } = installedWorkspace();
    const argv = command === "install" ? installArgs(product, declarePath) : [
      "onboard", product.productRoot, "--coord-runtime", product.coordRoot,
      "--agents", "claude", "--profile", "solo", "--declare", declarePath
    ];
    const errors: string[] = [];
    const fail: ProcessRunner = async () => ({ exitCode: 124, stdout: "", stderr: "Timed out after 30000 ms" });
    const quiet = { home: null, io: { stdout: () => undefined, stderr: (text: string) => errors.push(text) } };
    expect(await runCli(argv, { ...quiet, processRunner: fail })).toBe(2);
    const configPath = join(product.coordRoot, "config.json");
    const clone = join(product.workspaceRoot, "myserver-claude");
    expect(existsSync(configPath)).toBe(false);
    expect(existsSync(clone)).toBe(false);
    expect(errors.join("")).toContain("Timed out after 30000 ms");
    expect(errors.join("")).toContain("--base-branch");
    expect(await runCli(argv, { ...quiet, processRunner: defaultBranchRunner })).toBe(0);
    const before = [configPath, join(clone, ".git/config"), join(clone, "start-claude.sh")].map((path) => readFileSync(path, "utf8"));
    expect(await runCli(argv, { ...quiet, processRunner: fail })).toBe(2);
    expect([configPath, join(clone, ".git/config"), join(clone, "start-claude.sh")].map((path) => readFileSync(path, "utf8"))).toEqual(before);
  });

  it("uses the saved account and --origin for bounded discovery during a read-only dry-run", async () => {
    const { product, declarePath } = installedWorkspace();
    const calls: Array<{ argv: readonly string[]; token: string | undefined; timeout: number | undefined }> = [];
    let branch = "main";
    const gh: ProcessRunner = async (argv, _cwd, options) => {
      calls.push({ argv, token: options?.env?.GH_TOKEN, timeout: options?.timeoutMs });
      if (argv[1] === "auth") return { exitCode: 0, stdout: "selected-token\n", stderr: "" };
      return { exitCode: 0, stderr: "", stdout: argv.length === 3 ? JSON.stringify({ default_branch: branch }) :
        argv[2] === "user" ? "acct\n" : "example/myserver\n" };
    };
    const output: string[] = [];
    const dependencies = { home: null, processRunner: gh, io: { stdout: (text: string) => output.push(text) } };
    expect(await runCli([...installArgs(product, declarePath), "--github-account", "acct"], dependencies)).toBe(0);
    const configPath = join(product.coordRoot, "config.json");
    const clone = join(product.workspaceRoot, "myserver-claude");
    const configBefore = readFileSync(configPath, "utf8");
    const cloneConfigBefore = readFileSync(join(clone, ".git/config"), "utf8");
    fixtureGit(product.productRoot, "remote", "set-url", "origin", "https://github.com/unrelated/local.git");
    fixtureGit(product.productRoot, "update-ref", "refs/remotes/origin/release/alpha", "HEAD");
    branch = "release/alpha";
    calls.length = 0;
    const ambient = process.env.GH_TOKEN;
    try {
      process.env.GH_TOKEN = "wrong-account-token";
      expect(await runCli([...installArgs(product, declarePath), "--dry-run", "--origin", "https://github.com/example/myserver.git"], dependencies)).toBe(0);
    } finally {
      if (ambient === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = ambient;
    }
    expect(calls).toEqual([
      { argv: ["gh", "auth", "token", "--hostname", "github.com", "--user", "acct"], token: undefined, timeout: 30_000 },
      { argv: ["gh", "api", "repos/example/myserver"], token: "selected-token", timeout: 30_000 }
    ]);
    expect(output.join("")).toContain("Shared branch: release/alpha (GitHub default)");
    expect(readFileSync(configPath, "utf8")).toBe(configBefore);
    expect(readFileSync(join(clone, ".git/config"), "utf8")).toBe(cloneConfigBefore);
  });

  it("accepts the boolean switches without swallowing the next option", async () => {
    const { product, declarePath } = installedWorkspace();
    const out: string[] = [];
    const code = await runCli([...installArgs(product, declarePath), "--dry-run"], {
      processRunner: defaultBranchRunner,
      io: { stdout: (message) => out.push(message) }
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("would clone");
    expect(existsSync(join(product.coordRoot, "workspaces"))).toBe(false);
  });

  it("verifies a saved GitHub account before a repair install changes anything", async () => {
    const { product, declarePath } = installedWorkspace();
    const gh = (token: string | null): ProcessRunner => async (argv) => {
      if (argv[1] === "auth") return token === null ? { exitCode: 1, stdout: "", stderr: "no account" } : { exitCode: 0, stdout: `${token}\n`, stderr: "" };
      if (argv.length === 3 && argv[1] === "api") return defaultBranchRunner(argv, product.productRoot);
      return { exitCode: 0, stdout: argv[2] === "user" ? "acct\n" : "example/myserver\n", stderr: "" };
    };
    expect(await runCli([...installArgs(product, declarePath), "--github-account", "acct"], {
      home: null, io: { stdout: () => undefined }, processRunner: gh("tok")
    })).toBe(0);
    const out: string[] = [], errors: string[] = [];
    expect(await runCli(installArgs(product, declarePath), {
      home: null, io: { stdout: (message) => out.push(message), stderr: (message) => errors.push(message) }, processRunner: gh(null)
    })).toBe(2);
    expect(errors.join("")).toContain("GitHub authentication for acct is unavailable.\nRun: coord auth login");
    expect(out.join("")).not.toContain("clone already present");
  });

  it("emits a config that coord start accepts unchanged", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { home: null, processRunner: defaultBranchRunner, io: { stdout: () => undefined } })).toBe(0);

    const configPath = join(product.coordRoot, "config.json");
    const runtime = join(product.coordRoot, "runtime");
    const messages: string[] = [];
    const started = await runCli(
      ["start", "1", "--profile", "solo", "--config", configPath, "--coord-runtime", runtime],
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

  it("serves command help outside a repository before validation or effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-help-")); roots.push(root);
    for (const args of [["resume", "--help"], ["help", "restart-action"], ["wipe-issue", "--help"],
      ["resume", "--issue", "161", "--help"], ["resume", "-h", "--issue", "161"],
      ["restart-action", "--unknown-option", "--help"]]) {
      const output: string[] = [];
      expect(await runCli(args, {
        io: { cwd: root, stdout: (text) => output.push(text) },
        makeRunLoop: () => { throw new Error("help must not create a runner"); },
        processRunner: async () => { throw new Error("help must not invoke processes"); }
      })).toBe(0);
      expect(output.join("")).toContain("Example:");
      expect(output.join("")).toContain("repository");
      expect(output.join("")).not.toMatch(/(?<![-\w])product(?![-\w])/);
      expect(output.join("")).toContain("--product");
    }
  });

  it("reuses the diagnosed startup loop for a fresh foreground issue", async () => {
    const fixture = setup();
    const calls: string[] = [];
    const makeRunLoop = vi.fn((paths: ReturnType<typeof issueRuntimePaths>): CliRunLoop => ({
      ...fakeLoop(paths),
      reportStartup: async () => { calls.push("diagnose"); },
      runTick: async () => { calls.push("tick"); return readCursorsState(paths); },
      run: async () => { calls.push("run"); }
    }));
    expect(await runCli(["161", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
      io: { stdout: () => undefined }, processRunner: successfulStartGit, makeRunLoop
    })).toBe(0);
    expect(makeRunLoop).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["diagnose", "tick", "run"]);
    calls.length = 0;
    expect(await runCli(["start", "162", "--config", fixture.configPath, "--coord-runtime", fixture.runtime], {
      io: { stdout: () => undefined }, processRunner: successfulStartGit, makeRunLoop
    })).toBe(0);
    expect(calls).toEqual(["diagnose", "tick"]); // start-only still diagnoses before its first tick
  });

  it("infers owner and registered clone context while retaining the frozen mailbox", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { home: null, processRunner: defaultBranchRunner, io: { stdout: () => undefined } })).toBe(0);
    execFileSync("git", ["config", "--local", "coord.ownerWorkspaceConfig", join(product.coordRoot, "config.json")], { cwd: product.productRoot });
    expect(await runCli(["start", "89", "--product", product.productRoot], {
      io: { stdout: () => undefined }, processRunner: successfulStartGit, makeRunLoop: fakeLoop
    })).toBe(0);
    const paths = issueRuntimePaths(product.coordRoot, 89);
    const frozen = readStartState(paths).completesRoot;
    const configPath = join(product.coordRoot, "config.json");
    writeFileSync(configPath, JSON.stringify({ ...readConfig(configPath), completesRoot: join(product.workspaceRoot, "moved-mailbox") }));
    for (const root of [product.productRoot, join(product.workspaceRoot, "myserver-claude")]) {
      const cwd = join(root, "nested"); mkdirSync(cwd, { recursive: true });
      const output: string[] = [];
      expect(await runCli(["status", "--issue", "89"], { io: { cwd, stdout: (text) => output.push(text) } })).toBe(0);
      expect(output.join("")).toContain("Issue 89:");
      let runs = 0;
      expect(await runCli(["run", "--issue", "89"], { io: { cwd, stdout: () => undefined }, makeRunLoop: (resolved) => {
        expect(resolved.completesRoot).toBe(frozen);
        runs++;
        return fakeLoop(resolved);
      } })).toBe(0);
      expect(runs).toBe(1);
    }
    // Runtime-requiring commands infer it from an agent clone too, or from --config alone.
    const clone = join(product.workspaceRoot, "myserver-claude");
    for (const argv of [["reset-clones", "89", "--dry-run"], ["detach", "89", "--dry-run"]]) {
      expect(await runCli(argv, { io: { cwd: clone, stdout: () => undefined } })).toBe(0);
    }
    // An issue with no runtime still detaches only this workspace's UI.
    const scoped: string[] = [];
    expect(await runCli(["detach", "7", "--dry-run"], { io: { cwd: clone, stdout: (text) => scoped.push(text) } })).toBe(0);
    expect(scoped.join("")).toContain(issueRuntimePaths(product.coordRoot, 7).terminalGroup);
    expect(await runCli(["reset-clones", "89", "--dry-run", "--config", configPath],
      { io: { cwd: product.workspaceRoot, stdout: () => undefined } })).toBe(0);
  });

  it("resolves analytics through an onboarded product", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { home: null, processRunner: defaultBranchRunner, io: { stdout: () => undefined } })).toBe(0);
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
    expect(await runCli(installArgs(product, declarePath), { home: null, processRunner: defaultBranchRunner, io: { stdout: () => undefined } })).toBe(0);

    const doctorArgs = ["doctor", "--coord-runtime", product.coordRoot, "--product", product.productRoot];
    expect(await runCli(doctorArgs, { home: null, io: { stdout: () => undefined } })).toBe(0);

    rmSync(join(product.workspaceRoot, "myserver-claude", "start-claude.sh"));
    const errors: string[] = [];
    expect(await runCli(doctorArgs, { home: null, io: { stderr: (message) => errors.push(message) } })).toBe(DOCTOR_CODES.launcher);
    expect(errors.join("")).toContain("launcher");
  });

  it("serves the hook bridge from the workspace config", async () => {
    const { product, declarePath } = installedWorkspace();
    expect(await runCli(installArgs(product, declarePath), { home: null, processRunner: defaultBranchRunner, io: { stdout: () => undefined } })).toBe(0);
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
