import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BareMirror } from "../src/mirror.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import type { CheckCommand, StartState } from "../src/state.js";
import {
  computeInputIdentity,
  dependencyIdentity,
  readReceipt,
  receiptKey,
  receiptPath,
  runningLockPath,
  writeReceipt,
  type ReceiptKeyMaterial
} from "../src/verificationReceipts.js";
import { runVerification, type RunVerificationInput } from "../src/verificationRunner.js";
import { runArgv } from "../src/runLoop.js";
import { runVerifyPhase } from "../src/hookPolicy.js";
import { coordinatorConfigSchema } from "../src/state.js";
import { git } from "./support/workspaceFixture.js";
import { sha256 } from "../src/hash.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const environment = { platform: "test-os", arch: "test-arch", node: "v0", env: { TOKEN: "secret" } };
const cached = (name: string, extra: Partial<CheckCommand> = {}): CheckCommand =>
  ({ name, argv: [name], cache: { inputs: "tree-excluding-evidence", env: [], probes: [], dependencies: [], dependencyExcludes: [] }, ...extra });

const setup = (files: Record<string, string> = {}) => {
  const root = mkdtempSync(join(tmpdir(), "coord-verify-"));
  roots.push(root);
  const seed = join(root, "seed");
  mkdirSync(join(seed, "src"), { recursive: true });
  git(seed, "init", "-q");
  writeFileSync(join(seed, "src/a.ts"), "source\n");
  for (const [path, content] of Object.entries(files)) writeFileSync(join(seed, path), content);
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "source");
  const pin = git(seed, "rev-parse", "HEAD");
  mkdirSync(join(seed, ".signals"));
  writeFileSync(join(seed, ".signals/ready.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "evidence");
  const evidencePin = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "src/a.ts"), "changed\n");
  git(seed, "commit", "-qam", "product");
  const productPin = git(seed, "rev-parse", "HEAD");
  const coordRoot = join(root, "coord-runtime");
  const paths = issueRuntimePaths(coordRoot, 1, join(root, "completes"));
  createIssueRuntime(paths, ["codex"]);
  git(root, "clone", "--bare", "-q", seed, paths.mirror);
  const start = { issue: 1, issueSessionId: `issue-1:${"a".repeat(40)}`, origin: "https://example.com/p.git",
    verificationDigest: "d".repeat(64), verification: { mode: "coordinator", maxConcurrentExpensive: 1 } } as unknown as StartState;
  const journal: Array<{ type: string; details: Record<string, unknown> }> = [];
  const input = (commands: CheckCommand[], processRunner: RunVerificationInput["processRunner"],
    overrides: Partial<RunVerificationInput> = {}): RunVerificationInput => ({
    paths, start, mirror: new BareMirror(paths.mirror, seed), processRunner, now: () => new Date().toISOString(),
    checkpoint: () => {}, journal: (type, details) => { journal.push({ type, details }); }, phase: "candidate", pin,
    classification: { kind: "product", reason: "test", inputIdentity: "range" }, commands, environment, pollMs: 5, ...overrides
  });
  const material = (command: CheckCommand, at = pin): ReceiptKeyMaterial => ({ v: 2, origin: start.origin,
    inputsMode: "tree-excluding-evidence", inputIdentity: computeInputIdentity(paths.mirror, at, "tree-excluding-evidence"),
    argv: [...command.argv], policyDigest: start.verificationDigest!, platform: environment.platform, arch: environment.arch,
    node: environment.node, toolchain: null, probes: [], env: [], dependencies: sha256("") });
  return { root, seed, paths, pin, evidencePin, productPin, journal, input, material };
};

const script = (path: string, body: string): string => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};

/** An older Node first on PATH, the product's pinned Node installed under nvm, and a
 * pnpm stand-in that, like pnpm running a script, starts `node` by name from PATH. */
const toolchainFixture = (root: string) => {
  const old = join(root, "old-node");
  script(join(old, "node"), "echo v23.0.0");
  const nvm = join(root, "nvm");
  const pinned = script(join(nvm, "versions/node/v26.99.0/bin/node"), "echo v26.99.0");
  const bin = join(root, "tools");
  script(join(bin, "pnpm"), 'echo "child node $(node --version)"');
  return { pinned, env: { PATH: [old, bin, "/usr/bin", "/bin"].join(":"), NVM_DIR: nvm, HOME: root } };
};

const ok = async () => ({ exitCode: 0, stdout: "", stderr: "" });

describe("verification receipts", () => {
  it("announces checks before running and distinguishes fresh, reused, and failed results", async () => {
    const { input } = setup();
    const messages: string[] = [];
    const progress = (message: string) => { messages.push(message); };
    const lint = cached("lint");
    const first = await runVerification(input([lint], async () => {
      expect(messages[0]).toContain("Preparing verification");
      expect(messages.at(-1)).toContain("Running lint");
      expect(messages.join("\n")).not.toContain("passed");
      return ok();
    }, { progress }));
    expect(first.status).toBe("passed");
    expect(messages.at(-1)).toMatch(/lint: passed.*log:/);
    messages.length = 0;
    await runVerification(input([lint], async () => { throw new Error("must reuse"); }, { progress }));
    expect(messages.join("\n")).toContain("reused, not rerun");
    expect(messages.join("\n")).not.toContain("Running lint");
    await runVerification(input([{ name: "fail", argv: ["fail"] }], async () => ({ exitCode: 1, stdout: "", stderr: "private process detail" }), { progress }));
    expect(messages.join("\n")).toContain("[ACTION] fail: failed");
    expect(messages.join("\n")).not.toContain("private process detail");
  });
  it("keys on every declared input and ignores only coordination evidence when asked", () => {
    const { paths, pin, evidencePin, productPin, material } = setup();
    const base = material(cached("lint"));
    const key = receiptKey(base);
    for (const changed of [
      { argv: ["lint", "--fix"] }, { policyDigest: "e".repeat(64) }, { platform: "other" }, { arch: "other" }, { node: "v1" },
      { probes: [{ argv: ["node", "--version"], stdout: "v2" }] }, { env: [{ name: "TOKEN", value: "f".repeat(64) }] },
      { dependencies: "f".repeat(64) },
      { inputIdentity: computeInputIdentity(paths.mirror, productPin, "tree-excluding-evidence") }
    ]) {
      expect(receiptKey({ ...base, ...changed }), JSON.stringify(changed)).not.toBe(key);
    }
    expect(computeInputIdentity(paths.mirror, evidencePin, "tree-excluding-evidence"))
      .toBe(computeInputIdentity(paths.mirror, pin, "tree-excluding-evidence"));
    expect(computeInputIdentity(paths.mirror, evidencePin, "tree")).not.toBe(computeInputIdentity(paths.mirror, pin, "tree"));
  });

  it("writes no receipt for a failure, and treats corrupt or mismatched receipts as misses", async () => {
    const { paths, input, material } = setup();
    const lint = cached("lint");
    const failed = await runVerification(input([lint], async () => ({ exitCode: 2, stdout: "", stderr: "bad" })));
    expect(failed).toMatchObject({ status: "failed", failure: "lint failed with exit 2", failed: { name: "lint", exitCode: 2 } });
    const key = receiptKey(material(lint));
    expect(readReceipt(paths.coordRoot, key)).toEqual({ status: "miss", reason: "no receipt" });

    mkdirSync(join(paths.coordRoot, "verification/receipts"), { recursive: true });
    writeFileSync(receiptPath(paths.coordRoot, key), "{ not json");
    expect(readReceipt(paths.coordRoot, key)).toMatchObject({ status: "miss", reason: expect.stringContaining("unreadable receipt") });
    const forged = { formatVersion: 1, key, material: { ...material(lint), node: "forged" }, name: "lint", exitCode: 0, durationMs: 1,
      issue: 1, issueSessionId: "s", productPin: "a".repeat(40), logPath: "/log", completedAt: new Date().toISOString() };
    writeFileSync(receiptPath(paths.coordRoot, key), JSON.stringify(forged));
    expect(readReceipt(paths.coordRoot, key)).toEqual({ status: "miss", reason: "receipt key material does not match" });
  });

  it("fails the command that modifies tracked files, so nothing later runs or reuses against changed bytes", async () => {
    const { paths, input, material } = setup();
    const lint = cached("lint");
    const calls: string[] = [];
    const result = await runVerification(input([{ name: "mutate", argv: ["mutate"] }, lint], async (argv, cwd) => {
      calls.push(argv[0]!);
      if (argv[0] === "mutate") writeFileSync(join(cwd, "src/a.ts"), "generated\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    }));
    expect(result).toMatchObject({ status: "failed", failure: "mutate exited 0 but modified tracked files" });
    if (result.status !== "failed") throw new Error("expected a failure");
    expect(readFileSync(result.failed.logPath!, "utf8")).toContain("modified tracked files");
    expect(calls).toEqual(["mutate"]);
    expect(readReceipt(paths.coordRoot, receiptKey(material(lint))).status).toBe("miss");
  });

  it("keys on the declared dependencies as prepared, and withholds the receipt when the command changed them", async () => {
    const { paths, input } = setup();
    const lint = cached("lint", { cache: { inputs: "tree-excluding-evidence", env: [], probes: [], dependencies: ["deps/lock.yaml"], dependencyExcludes: [] } });
    const prepare = { name: "prepare", argv: ["prepare"] };
    let installed = "a";
    const runner = (lintWrites: boolean): RunVerificationInput["processRunner"] => async (argv, cwd) => {
      if (argv[0] === "prepare") { mkdirSync(join(cwd, "deps"), { recursive: true }); writeFileSync(join(cwd, "deps/lock.yaml"), installed); }
      if (argv[0] === "lint" && lintWrites) writeFileSync(join(cwd, "deps/lock.yaml"), "changed by lint");
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const receipts = () => readdirSync(join(paths.coordRoot, "verification/receipts")).filter((name) => name.endsWith(".json"));
    expect(await runVerification(input([prepare, lint], runner(true)))).toMatchObject({ status: "passed" });
    expect(existsSync(join(paths.coordRoot, "verification/receipts"))).toBe(false);
    const first = await runVerification(input([prepare, lint], runner(false)));
    expect(first.results.at(-1)?.receiptId).toBeDefined();
    expect(receipts()).toHaveLength(1);
    // Different installed dependencies are different inputs: no reuse.
    installed = "b";
    const second = await runVerification(input([prepare, lint], runner(false)));
    expect(second.results.at(-1)).not.toHaveProperty("reused");
    expect(receipts()).toHaveLength(2);
  });
});

describe("dependency identity", () => {
  it("is independent of the worktree's own path, sees content changes, and refuses links outside the declared paths", () => {
    const make = () => {
      const root = mkdtempSync(join(tmpdir(), "coord-deps-"));
      roots.push(root);
      mkdirSync(join(root, "deps/pkg"), { recursive: true });
      writeFileSync(join(root, "deps/pkg/index.js"), "module.exports = 1;\n");
      writeFileSync(join(root, "deps/shim"), `#!/bin/sh\nexec node ${root}/deps/pkg/index.js\n`);
      symlinkSync("pkg", join(root, "deps/current"));
      return root;
    };
    const [a, b] = [make(), make()];
    expect(dependencyIdentity(a, ["deps"])).toBe(dependencyIdentity(b, ["deps"]));
    writeFileSync(join(b, "deps/pkg/index.js"), "module.exports = 2;\n");
    expect(dependencyIdentity(a, ["deps"])).not.toBe(dependencyIdentity(b, ["deps"]));
    // An executable shim is an input even when package bytes are unchanged;
    // declared tool state (timestamps, caches) is not.
    const shim = dependencyIdentity(b, ["deps"], ["deps/.state"]);
    writeFileSync(join(b, "deps/shim"), "#!/bin/sh\nexit 1\n");
    expect(dependencyIdentity(b, ["deps"], ["deps/.state"])).not.toBe(shim);
    const edited = dependencyIdentity(b, ["deps"], ["deps/.state"]);
    mkdirSync(join(b, "deps/.state"));
    writeFileSync(join(b, "deps/.state/stamp"), `${Date.now()}\n`);
    expect(dependencyIdentity(b, ["deps"], ["deps/.state"])).toBe(edited);
    expect(dependencyIdentity(b, ["deps"])).not.toBe(edited);
    symlinkSync(join(a, "outside"), join(a, "deps/escape"));
    writeFileSync(join(a, "outside"), "not declared\n");
    expect(() => dependencyIdentity(a, ["deps"])).toThrow(/outside the declared dependency paths/);
  });
});

describe("verification runner", () => {
  it("fails, rather than reuses a receipt, when a probe modifies tracked files", async () => {
    const { input, journal } = setup();
    const lint = cached("lint", { cache: { inputs: "tree-excluding-evidence", env: [], probes: [["probe"]], dependencies: [], dependencyExcludes: [] } });
    const runner = (mutate: boolean): RunVerificationInput["processRunner"] => async (argv, cwd) => {
      if (argv[0] === "probe" && mutate) writeFileSync(join(cwd, "src/a.ts"), "edited by a probe\n");
      return { exitCode: 0, stdout: argv[0] === "probe" ? "1.0" : "", stderr: "" };
    };
    expect(await runVerification(input([lint], runner(false)))).toMatchObject({ status: "passed", results: [{ receiptId: expect.any(String) }] });
    journal.length = 0;
    const result = await runVerification(input([lint], runner(true)));
    expect(result).toMatchObject({ status: "failed", failure: "probes for lint modified tracked files" });
    expect(journal.map((row) => row.type)).not.toContain("verification-reused");
  });


  it("joins a live owner's execution and never treats a dead owner's lock as success", async () => {
    const { paths, journal, input, material } = setup();
    const lint = cached("lint");
    const key = receiptKey(material(lint));
    mkdirSync(join(paths.coordRoot, "verification/running"), { recursive: true });
    const lock = runningLockPath(paths.coordRoot, key);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), token: "other", startedAt: new Date().toISOString() }));
    const calls: string[] = [];
    const progress: string[] = [];
    const joined = await runVerification(input([lint], async (argv) => { calls.push(argv[0]!); return ok(); }, {
      progress: (message) => { progress.push(message); },
      // The live owner finishes while this runner waits.
      sleep: async () => {
        expect(progress.at(-1)).toContain("Waiting for another coordinator");
        writeReceipt(paths.coordRoot, { formatVersion: 1, key, material: material(lint), name: "lint", exitCode: 0,
          durationMs: 4_000, issue: 1, issueSessionId: "s", productPin: "a".repeat(40), logPath: "/owner.log",
          completedAt: new Date().toISOString() });
        rmSync(lock);
      }
    }));
    expect(joined).toMatchObject({ status: "passed", results: [{ name: "lint", joined: true, receiptId: key }] });
    expect(calls).toEqual([]);
    expect(progress.at(-1)).toContain("joined, not rerun");
    expect(journal.map((row) => row.type)).toEqual(["verification-joined"]);

    rmSync(join(paths.coordRoot, "verification"), { recursive: true });
    mkdirSync(join(paths.coordRoot, "verification/running"), { recursive: true });
    const dead = spawnSync("true").pid!;
    writeFileSync(lock, JSON.stringify({ pid: dead, hostname: hostname(), token: "dead", startedAt: new Date(0).toISOString() }));
    const ran = await runVerification(input([lint], async (argv) => { calls.push(argv[0]!); return ok(); }));
    expect(ran).toMatchObject({ status: "passed", results: [{ name: "lint", receiptId: key }] });
    expect(calls).toEqual(["lint"]);
    expect(readReceipt(paths.coordRoot, key).status).toBe("hit");
  });

  it("stops waiting for a live owner that never finishes without running the same key unlocked", async () => {
    const { paths, journal, input, material } = setup();
    const lint = cached("lint");
    const lock = runningLockPath(paths.coordRoot, receiptKey(material(lint)));
    mkdirSync(join(paths.coordRoot, "verification/running"), { recursive: true });
    const owner = JSON.stringify({ pid: process.pid, hostname: hostname(), token: "stuck", startedAt: new Date().toISOString() });
    writeFileSync(lock, owner);
    const calls: string[] = [];
    const result = await runVerification(input([lint], async (argv) => { calls.push(argv[0]!); return ok(); }, { joinWaitMs: 20 }));
    expect(result).toEqual({ status: "waiting", results: [], waitingFor: "lint" });
    expect(calls).toEqual([]);
    expect(journal.filter((row) => row.type === "verification-run")).toEqual([]);
    expect(readFileSync(lock, "utf8")).toBe(owner);
  });

  it("bounds concurrent expensive commands and records the queue wait", async () => {
    const { input } = setup();
    let running = 0, peak = 0;
    const slow = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 60));
      running -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const expensive = { name: "e2e", argv: ["e2e"], expensive: true };
    const journals: Array<Array<{ type: string; details: Record<string, unknown> }>> = [[], []];
    await Promise.all(journals.map((rows) => runVerification(input([expensive], slow,
      { journal: (type, details) => { rows.push({ type, details }); } }))));
    expect(peak).toBe(1);
    const waits = journals.map((rows) => rows[0]!.details.queueWaitMs as number).sort((a, b) => a - b);
    expect(waits[0]).toBeLessThan(waits[1]!);
    expect(waits[1]).toBeGreaterThan(0);
  });

  it("keeps the original failure when a diagnostic retry passes", async () => {
    const { paths, journal, input, material } = setup();
    const flaky = cached("test", { retry: 1 });
    let attempt = 0;
    const result = await runVerification(input([flaky], async () =>
      ({ exitCode: attempt++ === 0 ? 1 : 0, stdout: "", stderr: "first run failed" })));
    expect(result).toMatchObject({ status: "failed", failed: { exitCode: 1, attempts: 2 }, stderr: "first run failed",
      note: "diagnostic retry passed; the original failure is the outcome" });
    expect(journal.filter((row) => row.type === "verification-run").map((row) => [row.details.attempt, row.details.exitCode]))
      .toEqual([[1, 1], [2, 0]]);
    expect(readReceipt(paths.coordRoot, receiptKey(material(flaky))).status).toBe("miss");
  });
});

it("cannot reuse an earlier policy receipt after adding a check obligation", async () => {
  const { input } = setup();
  const command = cached("test");
  let runs = 0;
  const runner = async () => { runs++; return ok(); };
  await runVerification(input([command], runner));
  await runVerification(input([command], runner, { policyDigest: "e".repeat(64) }));
  expect(runs).toBe(2);
  const reused = await runVerification(input([command], runner, { policyDigest: "e".repeat(64) }));
  expect(reused.results[0]?.reused).toBe(true);
  expect(runs).toBe(2);
});

describe("product toolchain", () => {
  it.each(["candidate", "finalization"] as const)("gives %s checks and their children the pinned Node, keyed by that Node", async (phase) => {
    const { root, paths, input } = setup({ ".nvmrc": "26.99.0\n" });
    const { pinned, env } = toolchainFixture(root);
    const check: CheckCommand = { name: "check", argv: ["pnpm", "run", "check"],
      cache: { inputs: "tree-excluding-evidence", env: [], probes: [["node", "--version"]], dependencies: [], dependencyExcludes: [] } };
    const result = await runVerification(input([check], runArgv, { phase, environment: { ...environment, node: "v26.99.0", env } }));
    expect(result.status).toBe("passed");
    const log = readFileSync(result.results[0]!.logPath!, "utf8");
    expect(log).toContain("child node v26.99.0");
    expect(log).not.toContain("v23.0.0");
    const receipt = readReceipt(paths.coordRoot, result.results[0]!.receiptId!);
    expect(receipt.status === "hit" && receipt.receipt.material).toMatchObject({
      v: 2, node: "v26.99.0", toolchain: pinned, probes: [{ argv: ["node", "--version"], stdout: "v26.99.0" }] });
  });

  it("never lets a version-1 receipt certify a check whose children ran another Node", async () => {
    const { root, paths, pin, input } = setup({ ".nvmrc": "26.99.0\n" });
    const { env } = toolchainFixture(root);
    const check = cached("check", { argv: ["pnpm", "run", "check"] });
    // Before the fix the key held only the coordinator's version string, which can equal the pin's.
    const material = { v: 1, origin: "https://example.com/p.git", inputsMode: "tree-excluding-evidence",
      inputIdentity: computeInputIdentity(paths.mirror, pin, "tree-excluding-evidence"), argv: check.argv, policyDigest: "d".repeat(64),
      platform: environment.platform, arch: environment.arch, node: "v26.99.0", probes: [], env: [], dependencies: sha256("") };
    const legacyKey = sha256(JSON.stringify(material));
    mkdirSync(join(receiptPath(paths.coordRoot, legacyKey), ".."), { recursive: true });
    writeFileSync(receiptPath(paths.coordRoot, legacyKey), JSON.stringify({ formatVersion: 1, key: legacyKey, material, name: "check",
      exitCode: 0, durationMs: 1, issue: 1, issueSessionId: `issue-1:${"a".repeat(40)}`, productPin: pin, logPath: "/old.log",
      completedAt: new Date().toISOString() }));
    let runs = 0;
    const runner: RunVerificationInput["processRunner"] = async (argv, cwd, options) => { runs++; return runArgv(argv, cwd, options); };
    const result = await runVerification(input([check], runner, { environment: { ...environment, node: "v26.99.0", env } }));
    expect(result.results[0]?.reused).toBeUndefined();
    expect(result.results[0]?.receiptId).not.toBe(legacyKey);
    expect(runs).toBe(1);
  });

  it("runs hook checks with the pinned Node, and leaves an unpinned product's PATH alone", () => {
    const { root, seed } = setup({ ".nvmrc": "26.99.0\n" });
    const { env } = toolchainFixture(root);
    vi.stubEnv("PATH", env.PATH);
    vi.stubEnv("NVM_DIR", env.NVM_DIR);
    const config = coordinatorConfigSchema.parse({ project: "p", origin: "https://example.com/p.git",
      agents: [{ id: "claude", root: "../p-claude", launcher: "start-claude.sh" }], branch: "issue-{issue}/{agent}", checks: [],
      verify: { precommit: [{ name: "check", argv: ["pnpm", "run", "check"] }], prepush: [] } });
    const seen: string[] = [];
    const runner = (command: CheckCommand, cwd: string, childEnv: NodeJS.ProcessEnv) => {
      const result = spawnSync(command.argv[0]!, command.argv.slice(1), { cwd, env: childEnv, encoding: "utf8" });
      seen.push(result.stdout.trim());
      return result.status ?? 1;
    };
    expect(runVerifyPhase({ clone: seed, config, phase: "precommit", log: () => undefined, runner })).toEqual({ ok: true });
    rmSync(join(seed, ".nvmrc"));
    expect(runVerifyPhase({ clone: seed, config, phase: "precommit", log: () => undefined, runner })).toEqual({ ok: true });
    expect(seen).toEqual(["child node v26.99.0", "child node v23.0.0"]);
  });

  it("reports an unavailable pin instead of falling back, and leaves no worktree", async () => {
    const { root, paths, input } = setup({ ".nvmrc": "26.98.0\n" });
    const { env } = toolchainFixture(root);
    let runs = 0;
    await expect(runVerification(input([cached("check")], async () => { runs++; return ok(); }, { environment: { ...environment, env } })))
      .rejects.toThrow(/pins Node '26\.98\.0'.*nvm install 26\.98\.0/);
    expect(runs).toBe(0);
    expect(readdirSync(paths.issueRoot).some((name) => name.startsWith(".verification-"))).toBe(false);
  });

  it("records a missing declared executable as comparable final-check evidence, but a coordinator error for candidates", async () => {
    const { input } = setup();
    const check = { name: "protoc", argv: ["coord-test-missing-protoc", "--version"] };
    const final = await runVerification(input([check], runArgv, { phase: "finalization" }));
    expect(final).toMatchObject({ status: "failed", failed: { exitCode: 127 }, index: 0,
      evidence: { kind: "missing-executable", diagnostics: ["missing executable coord-test-missing-protoc"] } });
    await expect(runVerification(input([check], runArgv))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the actionable diagnostic in a bounded excerpt while the log keeps both streams", async () => {
    const { input } = setup();
    const progress = Array.from({ length: 5000 }, (_, index) => `progress ${index}%`).join("\n");
    const result = await runVerification(input([{ name: "build", argv: ["build"] }],
      async () => ({ exitCode: 1, stdout: `compiler error A\n${progress}\n`, stderr: "build failed\n" })));
    if (result.status !== "failed") throw new Error("expected a failure");
    expect(result.excerpt).toContain("compiler error A");
    expect(result.excerpt.length).toBeLessThanOrEqual(2048);
    expect(result.evidence).toEqual({ kind: "exit", diagnostics: ["stdout: compiler error A"] });
    const log = readFileSync(result.failed.logPath!, "utf8");
    expect(log).toContain("progress 4999%");
    expect(log).toContain("build failed");
    const generic = await runVerification(input([{ name: "build", argv: ["build"] }],
      async () => ({ exitCode: 1, stdout: "progress 1%\n", stderr: "build failed\n ELIFECYCLE  Command failed with exit code 1.\n" })));
    expect(generic).toMatchObject({ status: "failed", evidence: { kind: "exit", diagnostics: [] } });
  });
});
