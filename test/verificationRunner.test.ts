import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BareMirror } from "../src/mirror.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { initializeOperationalState, readJournal, readStartState, type CheckCommand } from "../src/state.js";
import {
  acquireLock,
  computeInputIdentity,
  readReceipt,
  receiptKey,
  releaseLock,
  type ReceiptKeyMaterial
} from "../src/verificationReceipts.js";
import { runVerification, type VerificationSelection } from "../src/verificationRunner.js";
import { git } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A coordinator runtime with a real bare mirror, because receipt keys are
 * computed from actual Git trees and the runner materializes a real worktree.
 */
const fixture = (verification?: { maxConcurrentExpensive?: number; digest?: string | null }) => {
  const workspace = mkdtempSync(join(tmpdir(), "coord-verify-"));
  roots.push(workspace);
  const root = join(workspace, "coord-runtime");
  mkdirSync(root, { recursive: true });
  const paths = issueRuntimePaths(root, 1, join(workspace, "completes"));
  createIssueRuntime(paths, ["codex"]);

  const seed = join(workspace, "seed");
  mkdirSync(seed);
  git(seed, "init", "-q");
  writeFileSync(join(seed, "source.ts"), "product\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "baseline");
  const baselineSha = git(seed, "rev-parse", "HEAD");
  mkdirSync(join(seed, ".signals/issue-1"), { recursive: true });
  writeFileSync(join(seed, ".signals/issue-1/ready.json"), "{}\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "evidence only");
  const evidenceSha = git(seed, "rev-parse", "HEAD");
  writeFileSync(join(seed, "source.ts"), "changed product\n");
  git(seed, "add", ".");
  git(seed, "commit", "-qm", "product change");
  const productSha = git(seed, "rev-parse", "HEAD");
  git(workspace, "clone", "--bare", "-q", seed, paths.mirror);

  const digest = verification?.digest === undefined ? "d".repeat(64) : verification.digest;
  initializeOperationalState(paths, {
    issue: 1,
    issueSessionId: `issue-1:${"a".repeat(40)}`,
    baselineSha,
    profile: "solo",
    originalRoster: ["codex"],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: "owner-only",
    automationDigest: "b".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
    trustedSourceCommit: "c".repeat(40),
    origin: "/origin.git",
    coordRoot: root,
    configPath: join(root, "config.json"),
    agents: [{ id: "codex", root: "/clones/codex", launcher: "start-codex.sh", delivery: "pull" }],
    checks: [{ name: "check", argv: ["true"] }],
    pollIntervalMs: 100,
    verification: { mode: "coordinator", maxConcurrentExpensive: verification?.maxConcurrentExpensive ?? 1 },
    ...(digest === null ? {} : { verificationDigest: digest })
  });

  return { workspace, root, paths, seed, baselineSha, evidenceSha, productSha };
};

const selection = (commands: readonly CheckCommand[]): VerificationSelection =>
  ({ kind: "product", reason: "fixture selection", inputIdentity: "fixture-range", commands });

type RunOptions = {
  paths: ReturnType<typeof fixture>["paths"];
  seed: string;
  pin: string;
  commands: readonly CheckCommand[];
  runner: (argv: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  sleep?: (milliseconds: number) => Promise<void>;
};

const run = (options: RunOptions) =>
  runVerification({
    paths: options.paths,
    start: readStartState(options.paths),
    mirror: new BareMirror(options.paths.mirror, options.seed),
    processRunner: options.runner,
    now: () => new Date().toISOString(),
    checkpoint: () => undefined,
    agent: "codex",
    actionId: "10000000-0000-4000-8000-000000000001",
    trigger: "candidate",
    phase: "candidate",
    pin: options.pin,
    selection: selection(options.commands),
    ...(options.sleep === undefined ? {} : { sleep: options.sleep })
  });

const receiptsDirectory = (root: string): string => join(root, "verification", "receipts");
const receiptFiles = (root: string): string[] =>
  existsSync(receiptsDirectory(root)) ? readdirSync(receiptsDirectory(root)).sort() : [];

const cached: CheckCommand = { name: "test:fast", argv: ["fake", "test"], cache: { inputs: "tree-excluding-evidence", env: [], probes: [] } };

describe("receipt keys", () => {
  const material = (overrides: Partial<ReceiptKeyMaterial> = {}): ReceiptKeyMaterial => ({
    v: 1,
    origin: "/origin.git",
    inputsMode: "tree-excluding-evidence",
    inputIdentity: "tree-excluding-evidence:abc",
    argv: ["pnpm", "test:fast"],
    policyDigest: "d".repeat(64),
    platform: "linux",
    arch: "x64",
    node: "v26.0.0",
    probes: [{ argv: ["node", "--version"], stdout: "v26.0.0\n" }],
    env: [{ name: "CI", value: "1" }],
    ...overrides
  });

  const variants: readonly [string, Partial<ReceiptKeyMaterial>][] = [
    ["the input identity", { inputIdentity: "tree-excluding-evidence:def" }],
    ["the declared argv", { argv: ["pnpm", "test:system"] }],
    ["the policy digest", { policyDigest: "e".repeat(64) }],
    ["the platform", { platform: "darwin" }],
    ["the architecture", { arch: "arm64" }],
    ["the node version", { node: "v27.0.0" }],
    ["a probe's stdout", { probes: [{ argv: ["node", "--version"], stdout: "v25.0.0\n" }] }],
    ["a declared env value", { env: [{ name: "CI", value: "0" }] }],
    ["an env value becoming unset", { env: [{ name: "CI", value: null }] }]
  ];

  it.each(variants)("changes when %s changes", (_label, override) => {
    expect(receiptKey(material(override))).not.toBe(receiptKey(material()));
  });

  it("is stable for identical material", () => {
    expect(receiptKey(material())).toBe(receiptKey(material()));
  });

  /**
   * The whole point of the evidence-excluding mode: a commit that only adds a
   * signal has not changed anything a product command reads.
   */
  it("ignores evidence-only differences only in the evidence-excluding mode", () => {
    const { paths, baselineSha, evidenceSha, productSha } = fixture();
    const excluding = (pin: string) => computeInputIdentity(paths.mirror, pin, "tree-excluding-evidence");
    const tree = (pin: string) => computeInputIdentity(paths.mirror, pin, "tree");

    expect(excluding(baselineSha)).not.toBeNull();
    expect(excluding(evidenceSha)).toBe(excluding(baselineSha));
    expect(tree(evidenceSha)).not.toBe(tree(baselineSha));
    // A real product change still moves both identities.
    expect(excluding(productSha)).not.toBe(excluding(baselineSha));
    expect(tree(productSha)).not.toBe(tree(baselineSha));
  });

  it("reports no identity for a pin the mirror cannot read, so the command runs", () => {
    const { paths } = fixture();
    expect(computeInputIdentity(paths.mirror, "f".repeat(40), "tree")).toBeNull();
    expect(computeInputIdentity(paths.mirror, "f".repeat(40), "tree-excluding-evidence")).toBeNull();
  });
});

describe("receipt storage", () => {
  it("writes a receipt only for a passing command", async () => {
    const { root, paths, productSha } = fixture();
    const failed = await run({ paths, seed: "", pin: productSha, commands: [cached],
      runner: async () => ({ exitCode: 2, stdout: "", stderr: "boom" }) });
    expect(failed.ok).toBe(false);
    expect(receiptFiles(root)).toEqual([]);

    const passed = await run({ paths, seed: "", pin: productSha, commands: [cached],
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    expect(passed.ok).toBe(true);
    expect(receiptFiles(root)).toHaveLength(1);
  });

  it("reads a corrupt or mis-keyed receipt as a miss with a reason, never as a pass", async () => {
    const { root, paths, productSha } = fixture();
    await run({ paths, seed: "", pin: productSha, commands: [cached],
      runner: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
    const name = receiptFiles(root)[0] as string;
    const key = name.replace(/\.json$/, "");
    const path = join(receiptsDirectory(root), name);
    const original = readFileSync(path, "utf8");
    expect(readReceipt(root, key).ok).toBe(true);

    writeFileSync(path, "{ not json");
    expect(readReceipt(root, key)).toEqual({ ok: false, reason: "unreadable or malformed receipt" });

    // Key material that does not hash to the file name is the tampering case:
    // the stored argv is recomputed, not trusted.
    const parsed = JSON.parse(original) as { material: ReceiptKeyMaterial };
    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), material: { ...parsed.material, argv: ["rm", "-rf", "/"] } }));
    expect(readReceipt(root, key)).toEqual({ ok: false, reason: "receipt key material does not hash to its key" });

    writeFileSync(path, JSON.stringify({ ...JSON.parse(original), exitCode: 1 }));
    expect(readReceipt(root, key)).toMatchObject({ ok: false });
    expect(readReceipt(root, "f".repeat(64))).toEqual({ ok: false, reason: "no receipt" });
  });

  it("reuses a stored receipt instead of running the command again", async () => {
    const { paths, productSha } = fixture();
    let calls = 0;
    const runner = async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; };
    await run({ paths, seed: "", pin: productSha, commands: [cached], runner });
    expect(calls).toBe(1);

    const second = await run({ paths, seed: "", pin: productSha, commands: [cached], runner });
    expect(calls).toBe(1);
    expect(second.results[0]).toMatchObject({ name: "test:fast", exitCode: 0, reused: true });
    expect(readJournal(paths).filter((event) => event.type === "verification-reused")).toHaveLength(1);
  });

  it("never caches a command with no cache metadata or no frozen policy digest", async () => {
    const uncached: CheckCommand = { name: "install", argv: ["fake", "install"] };
    const first = fixture();
    let calls = 0;
    const runner = async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; };
    await run({ paths: first.paths, seed: "", pin: first.productSha, commands: [uncached], runner });
    await run({ paths: first.paths, seed: "", pin: first.productSha, commands: [uncached], runner });
    expect(calls).toBe(2);
    expect(receiptFiles(first.root)).toEqual([]);

    // An issue frozen before the policy existed cannot key a receipt at all.
    const legacy = fixture({ digest: null });
    await run({ paths: legacy.paths, seed: "", pin: legacy.productSha, commands: [cached], runner });
    await run({ paths: legacy.paths, seed: "", pin: legacy.productSha, commands: [cached], runner });
    expect(calls).toBe(4);
    expect(receiptFiles(legacy.root)).toEqual([]);
  });
});

describe("per-key locking", () => {
  const lockPath = (root: string, key: string): string => join(root, "verification", "running", `${key}.lock`);

  it("waits for a live owner, then joins the receipt it wrote without running again", async () => {
    const { root, paths, productSha } = fixture();
    let calls = 0;
    const runner = async () => { calls += 1; return { exitCode: 0, stdout: "", stderr: "" }; };
    // One real run produces the receipt bytes the "owner" will publish.
    await run({ paths, seed: "", pin: productSha, commands: [cached], runner });
    expect(calls).toBe(1);
    const name = receiptFiles(root)[0] as string;
    const key = name.replace(/\.json$/, "");
    const stored = readFileSync(join(receiptsDirectory(root), name), "utf8");
    rmSync(join(receiptsDirectory(root), name));

    // A live owner on this host holds the key lock and has not finished yet.
    mkdirSync(join(root, "verification", "running"), { recursive: true });
    writeFileSync(lockPath(root, key),
      `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`);

    let polls = 0;
    const joined = await run({ paths, seed: "", pin: productSha, commands: [cached], runner,
      sleep: async () => {
        polls += 1;
        // The owner finishes while the waiter is polling.
        writeFileSync(join(receiptsDirectory(root), name), stored);
        rmSync(lockPath(root, key));
      } });

    expect(polls).toBeGreaterThan(0);
    expect(calls).toBe(1);
    expect(joined.ok).toBe(true);
    expect(joined.results[0]).toMatchObject({ exitCode: 0, reused: true, joined: true });
    expect(readJournal(paths).filter((event) => event.type === "verification-joined")).toHaveLength(1);
  });

  it("treats a dead owner's lock as stale and still refuses to call it a success", async () => {
    const { root, paths, productSha } = fixture();
    const deadPid = Number(execFileSync("node", ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }));
    let calls = 0;
    const runner = async () => { calls += 1; return { exitCode: 3, stdout: "", stderr: "still broken" }; };

    // Key the lock exactly as the runner will, so the stale sweep is what frees it.
    const identity = computeInputIdentity(paths.mirror, productSha, "tree-excluding-evidence") as string;
    const key = receiptKey({ v: 1, origin: "/origin.git", inputsMode: "tree-excluding-evidence", inputIdentity: identity,
      argv: [...cached.argv], policyDigest: "d".repeat(64), platform: process.platform, arch: process.arch,
      node: process.version, probes: [], env: [] });
    mkdirSync(join(root, "verification", "running"), { recursive: true });
    writeFileSync(lockPath(root, key),
      `${JSON.stringify({ pid: deadPid, hostname: hostname(), startedAt: new Date().toISOString() })}\n`);

    const result = await run({ paths, seed: "", pin: productSha, commands: [cached], runner,
      sleep: async () => { throw new Error("a stale lock must not make the runner wait"); } });

    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    expect(receiptFiles(root)).toEqual([]);
    expect(existsSync(lockPath(root, key))).toBe(false);
  });

  it("releases its own locks when the command fails", async () => {
    const { root, paths, productSha } = fixture();
    await run({ paths, seed: "", pin: productSha, commands: [cached],
      runner: async () => ({ exitCode: 1, stdout: "", stderr: "no" }) });
    const running = join(root, "verification", "running");
    expect(existsSync(running) ? readdirSync(running) : []).toEqual([]);
  });

  it("refuses a lock a live owner holds and grants it once released", () => {
    const { root } = fixture();
    const path = join(root, "verification", "running", "manual.lock");
    const first = acquireLock(path);
    if (first === null) throw new Error("the first acquisition must succeed");
    expect(acquireLock(path)).toBeNull();
    releaseLock(first);
    const second = acquireLock(path);
    if (second === null) throw new Error("a released lock must be acquirable");
    releaseLock(second);
    expect(existsSync(path)).toBe(false);
  });
});

describe("expensive command limiter", () => {
  it("never overlaps expensive commands and records the queue wait of the one that waited", async () => {
    const { paths, productSha } = fixture({ maxConcurrentExpensive: 1 });
    let active = 0;
    let peak = 0;
    const runner = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 40));
      active -= 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const expensive = (name: string): CheckCommand => ({ name, argv: ["fake", name], expensive: true });
    const quickSleep = async () => { await new Promise((resolve) => setTimeout(resolve, 5)); };

    const [first, second] = await Promise.all([
      run({ paths, seed: "", pin: productSha, commands: [expensive("test:system")], runner, sleep: quickSleep }),
      run({ paths, seed: "", pin: productSha, commands: [expensive("test:e2e")], runner, sleep: quickSleep })
    ]);

    expect(peak).toBe(1);
    expect(first.ok && second.ok).toBe(true);
    const waits = readJournal(paths)
      .filter((event) => event.type === "verification-run")
      .map((event) => event.details.queueWaitMs as number);
    expect(waits).toHaveLength(2);
    expect(waits.some((wait) => wait > 0)).toBe(true);
  });
});

describe("diagnostic retries", () => {
  it("keeps the original failure, journals every attempt, and writes no receipt", async () => {
    const { root, paths, productSha } = fixture();
    const retried: CheckCommand = { ...cached, name: "test:flaky", retry: 1 };
    let calls = 0;
    const result = await run({ paths, seed: "", pin: productSha, commands: [retried],
      runner: async () => { calls += 1; return { exitCode: calls === 1 ? 7 : 0, stdout: "", stderr: "flaked" }; } });

    expect(calls).toBe(2);
    expect(result.ok).toBe(false);
    expect(result.failed).toMatchObject({ name: "test:flaky", exitCode: 7 });
    expect(result.failed?.note).toContain("retry");
    expect(result.results[0]).toMatchObject({ exitCode: 7, attempts: 2 });
    expect(receiptFiles(root)).toEqual([]);

    const attempts = readJournal(paths)
      .filter((event) => event.type === "verification-run")
      .map((event) => ({ attempt: event.details.attempt, exitCode: event.details.exitCode }));
    expect(attempts).toEqual([{ attempt: 1, exitCode: 7 }, { attempt: 2, exitCode: 0 }]);
  });
});

describe("runner mechanics", () => {
  it("writes one log per executed attempt and reports its path", async () => {
    const { paths, productSha } = fixture();
    const result = await run({ paths, seed: "", pin: productSha, commands: [{ name: "lint", argv: ["fake", "lint"] }],
      runner: async () => ({ exitCode: 1, stdout: "out-marker", stderr: "err-marker" }) });
    const logPath = result.failed?.logPath as string;
    expect(logPath).toContain(join(paths.issueRoot, "verification-logs"));
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("out-marker");
    expect(log).toContain("err-marker");
  });

  it("removes its worktree and propagates a launch error rather than rejecting the submission", async () => {
    const { paths, productSha } = fixture();
    const launchError = new Error("spawn fake ENOENT");
    await expect(run({ paths, seed: "", pin: productSha, commands: [{ name: "lint", argv: ["fake", "lint"] }],
      runner: async () => { throw launchError; } })).rejects.toBe(launchError);
    expect(readdirSync(paths.issueRoot).some((name) => name.startsWith(".verification-"))).toBe(false);
    expect(readJournal(paths).at(-1)?.details).toMatchObject({ error: String(launchError) });
  });

  it("does nothing at all when the selection is empty", async () => {
    const { paths, productSha } = fixture();
    const result = await run({ paths, seed: "", pin: productSha, commands: [],
      runner: async () => { throw new Error("must not run"); } });
    expect(result).toMatchObject({ ok: true, results: [], records: [] });
    expect(readdirSync(paths.issueRoot).some((name) => name.startsWith(".verification-"))).toBe(false);
  });

  it("substitutes the materialized worktree path into the declared argv", async () => {
    const { paths, productSha } = fixture();
    const seen: string[][] = [];
    await run({ paths, seed: "", pin: productSha, commands: [{ name: "scan", argv: ["fake", "{worktree}/source.ts"] }],
      runner: async (argv, cwd) => { seen.push([...argv, cwd]); return { exitCode: 0, stdout: "", stderr: "" }; } });
    const [argv] = seen;
    expect(argv?.[1]).toContain(join(paths.issueRoot, ".verification-"));
    // The command runs inside that same worktree, which is what the probes rely on.
    expect(argv?.[1]).toBe(`${argv?.[2]}/source.ts`);
  });
});
