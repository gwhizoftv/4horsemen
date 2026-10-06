import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BareMirror } from "../src/mirror.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import type { CheckCommand, StartState } from "../src/state.js";
import {
  computeInputIdentity,
  readReceipt,
  receiptKey,
  receiptPath,
  runningLockPath,
  writeReceipt,
  type ReceiptKeyMaterial
} from "../src/verificationReceipts.js";
import { runVerification, type RunVerificationInput } from "../src/verificationRunner.js";
import { git } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const environment = { platform: "test-os", arch: "test-arch", node: "v0", env: { TOKEN: "secret" } };
const cached = (name: string, extra: Partial<CheckCommand> = {}): CheckCommand =>
  ({ name, argv: [name], cache: { inputs: "tree-excluding-evidence", env: [], probes: [] }, ...extra });

const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "coord-verify-"));
  roots.push(root);
  const seed = join(root, "seed");
  mkdirSync(join(seed, "src"), { recursive: true });
  git(seed, "init", "-q");
  writeFileSync(join(seed, "src/a.ts"), "source\n");
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
  const material = (command: CheckCommand, at = pin): ReceiptKeyMaterial => ({ v: 1, origin: start.origin,
    inputsMode: "tree-excluding-evidence", inputIdentity: computeInputIdentity(paths.mirror, at, "tree-excluding-evidence"),
    argv: [...command.argv], policyDigest: start.verificationDigest!, platform: environment.platform, arch: environment.arch,
    node: environment.node, probes: [], env: [] });
  return { paths, pin, evidencePin, productPin, journal, input, material };
};

const ok = async () => ({ exitCode: 0, stdout: "", stderr: "" });

describe("verification receipts", () => {
  it("keys on every declared input and ignores only coordination evidence when asked", () => {
    const { paths, pin, evidencePin, productPin, material } = setup();
    const base = material(cached("lint"));
    const key = receiptKey(base);
    for (const changed of [
      { argv: ["lint", "--fix"] }, { policyDigest: "e".repeat(64) }, { platform: "other" }, { arch: "other" }, { node: "v1" },
      { probes: [{ argv: ["node", "--version"], stdout: "v2" }] }, { env: [{ name: "TOKEN", value: "f".repeat(64) }] },
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
    expect(failed).toMatchObject({ ok: false, failed: { name: "lint", exitCode: 2 } });
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

  it("writes no receipt when tracked inputs changed before the cached command ran", async () => {
    const { paths, input, material } = setup();
    const lint = cached("lint");
    const result = await runVerification(input([{ name: "mutate", argv: ["mutate"] }, lint], async (argv, cwd) => {
      if (argv[0] === "mutate") writeFileSync(join(cwd, "src/a.ts"), "generated\n");
      return { exitCode: 0, stdout: "", stderr: "" };
    }));
    expect(result.ok).toBe(true);
    expect(readReceipt(paths.coordRoot, receiptKey(material(lint))).status).toBe("miss");
  });
});

describe("verification runner", () => {
  it("joins a live owner's execution and never treats a dead owner's lock as success", async () => {
    const { paths, journal, input, material } = setup();
    const lint = cached("lint");
    const key = receiptKey(material(lint));
    mkdirSync(join(paths.coordRoot, "verification/running"), { recursive: true });
    const lock = runningLockPath(paths.coordRoot, key);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), token: "other", startedAt: new Date().toISOString() }));
    const calls: string[] = [];
    const joined = await runVerification(input([lint], async (argv) => { calls.push(argv[0]!); return ok(); }, {
      // The live owner finishes while this runner waits.
      sleep: async () => {
        writeReceipt(paths.coordRoot, { formatVersion: 1, key, material: material(lint), name: "lint", exitCode: 0,
          durationMs: 4_000, issue: 1, issueSessionId: "s", productPin: "a".repeat(40), logPath: "/owner.log",
          completedAt: new Date().toISOString() });
        rmSync(lock);
      }
    }));
    expect(joined).toMatchObject({ ok: true, results: [{ name: "lint", joined: true, receiptId: key }] });
    expect(calls).toEqual([]);
    expect(journal.map((row) => row.type)).toEqual(["verification-joined"]);

    rmSync(join(paths.coordRoot, "verification"), { recursive: true });
    mkdirSync(join(paths.coordRoot, "verification/running"), { recursive: true });
    const dead = spawnSync("true").pid!;
    writeFileSync(lock, JSON.stringify({ pid: dead, hostname: hostname(), token: "dead", startedAt: new Date(0).toISOString() }));
    const ran = await runVerification(input([lint], async (argv) => { calls.push(argv[0]!); return ok(); }));
    expect(ran).toMatchObject({ ok: true, results: [{ name: "lint", receiptId: key }] });
    expect(calls).toEqual(["lint"]);
    expect(readReceipt(paths.coordRoot, key).status).toBe("hit");
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
    expect(result).toMatchObject({ ok: false, failed: { exitCode: 1, attempts: 2 }, stderr: "first run failed",
      retryNote: "diagnostic retry passed; the original failure is the outcome" });
    expect(journal.filter((row) => row.type === "verification-run").map((row) => [row.details.attempt, row.details.exitCode]))
      .toEqual([[1, 1], [2, 0]]);
    expect(readReceipt(paths.coordRoot, receiptKey(material(flaky))).status).toBe("miss");
  });
});
