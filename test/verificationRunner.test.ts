import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BareMirror } from "../src/mirror.js";
import { issueRuntimePaths } from "../src/paths.js";
import { startStateSchema, verificationPolicyDigest, checkCommandSchema } from "../src/state.js";
import { runVerification, type VerificationRunInput } from "../src/verificationRunner.js";
import { computeInputIdentity, readReceipt, receiptKey, tryVerificationLock, type ReceiptMaterial } from "../src/verificationReceipts.js";
import { git, makeProduct, type ProductFixture } from "./support/workspaceFixture.js";

const fixtures: ProductFixture[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) fixture.cleanup(); });
const checked = checkCommandSchema.parse({ name: "suite", argv: ["suite", "{worktree}"], expensive: true,
  cache: { inputs: "commit", probes: [["version"]], env: ["TEST_SECRET"], dependencies: [] } });

const fixture = () => {
  const product = makeProduct("plain"); fixtures.push(product);
  const pin = git(product.productRoot, "rev-parse", "HEAD");
  const paths = issueRuntimePaths(product.coordRoot, 1, join(product.workspaceRoot, "completes"));
  mkdirSync(paths.issueRoot, { recursive: true });
  const start = startStateSchema.parse({ formatVersion: 4, issue: 1, issueSessionId: `issue-1:${pin}`,
    baselineSha: pin, profile: "solo", originalRoster: ["codex"], branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main", maxRevisionRounds: 3, prPolicy: "coord-open-unmerged", automationDigest: "a".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1", automationDigestSources: [{ id: "config", sha256: "a".repeat(64) }],
    trustedSourceCommit: pin, origin: product.originPath, coordRoot: product.coordRoot,
    configPath: join(product.coordRoot, "config.json"), agents: [{ id: "codex", root: product.productRoot, launcher: "start-codex.sh" }],
    checks: [checked], pollIntervalMs: 100, createdAt: new Date().toISOString(),
    verification: { mode: "coordinator", coordinated: { precommit: [], prepush: [] },
      candidate: { checks: [checked], covers: { prefixes: ["src/"] } }, maxConcurrentExpensive: 1 }
  });
  start.verificationDigest = verificationPolicyDigest(start);
  const events: Array<{ type: string; details: Record<string, unknown> }> = [];
  const calls: string[] = [];
  const input: VerificationRunInput = { paths, start, pin, mirror: new BareMirror(product.originPath, product.originPath),
    now: () => new Date().toISOString(), checkpoint: () => {}, phase: "candidate", environment: { TEST_SECRET: "private-value" },
    selection: { kind: "product", reason: "fixture", inputIdentity: pin, commands: [checked] },
    journal: (type, details) => { events.push({ type, details }); },
    processRunner: async (argv) => { calls.push(argv[0]!); return { exitCode: 0, stdout: "version-one", stderr: "" }; }
  };
  return { product, input, events, calls };
};

describe("coordinator verification receipts and runner", () => {
  it("shares one successful suite and immutable logs with concurrent consumers and restart", async () => {
    const { input, events } = fixture();
    let runs = 0;
    input.processRunner = async (argv) => {
      if (argv[0] === "suite") { runs++; await new Promise((resolve) => setTimeout(resolve, 150)); }
      return { exitCode: 0, stdout: "private-value", stderr: "" };
    };
    const [first, second] = await Promise.all([runVerification(input), runVerification(input)]);
    expect(first.ok && second.ok).toBe(true);
    expect(runs).toBe(1);
    expect(first.results[0]!.logPath).toBe(second.results[0]!.logPath);
    expect(readFileSync(first.results[0]!.logPath!, "utf8")).not.toContain("private-value");
    expect(events.some((event) => event.type === "verification-joined")).toBe(true);
    const restarted = await runVerification({ ...input });
    expect(restarted.results[0]).toMatchObject({ reused: true, exitCode: 0 });
    expect(runs).toBe(1);
    expect(readdirSync(input.paths.issueRoot).filter((name) => name.startsWith(".verification-"))).toEqual([]);
  });

  it("binds every receipt-key component and fails closed on corrupt receipts", async () => {
    const { input } = fixture();
    const result = await runVerification(input), key = result.results[0]!.receiptId!;
    const receipt = readReceipt(input.paths.coordRoot, key)!;
    expect(receipt).not.toBeNull();
    const changes: Partial<ReceiptMaterial>[] = [
      { origin: "another-origin" }, { inputIdentity: "another-pin" }, { argv: ["different"] },
      { policyDigest: "b".repeat(64) }, { platform: "different" }, { arch: "different" }, { node: "different" },
      { probes: [{ argv: ["version"], digest: "c".repeat(64) }] },
      { env: [{ name: "TEST_SECRET", digest: "d".repeat(64) }] },
      { dependencyIdentity: "e".repeat(64) }, { preparationIdentity: "f".repeat(64) }
    ];
    for (const change of changes) expect(receiptKey({ ...receipt.material, ...change })).not.toBe(key);
    writeFileSync(join(input.paths.coordRoot, "verification", "receipts", `${key}.json`), "{}");
    expect(readReceipt(input.paths.coordRoot, key)).toBeNull();
  });

  it("reuses a proven projected candidate at finalization and executes missing requirements", async () => {
    const { input, product, calls } = fixture();
    const command = { ...checked, cache: { ...checked.cache!, inputs: "tree-excluding-evidence" as const } };
    input.start.checks = [command, { name: "build", argv: ["build"] }];
    input.start.verification!.candidate!.checks = [command];
    input.start.verificationDigest = verificationPolicyDigest(input.start);
    input.selection.commands = [command];
    const candidate = await runVerification(input);
    mkdirSync(join(product.productRoot, ".signals")); writeFileSync(join(product.productRoot, ".signals", "ready.json"), "{}");
    git(product.productRoot, "add", "."); git(product.productRoot, "commit", "-qm", "evidence only");
    git(product.productRoot, "push", "-q", "origin", "main");
    const pin = git(product.productRoot, "rev-parse", "HEAD");
    const final = await runVerification({ ...input, pin, phase: "finalization",
      selection: { ...input.selection, commands: input.start.checks } });
    expect(final.ok).toBe(true);
    expect(final.results[0]).toMatchObject({ reused: true, receiptId: candidate.results[0]!.receiptId });
    expect(calls.filter((name) => name === "suite")).toHaveLength(1);
    expect(calls.filter((name) => name === "build")).toHaveLength(1);
    const uncached = { ...input, pin, phase: "finalization" as const,
      selection: { ...input.selection, commands: [{ name: "aggregate", argv: ["full-check"] }] } };
    await runVerification(uncached);
    expect(calls).toContain("full-check");
  });

  it("uses exact pins by default and excludes only declared evidence in projected mode", () => {
    const { product, input } = fixture();
    mkdirSync(join(product.productRoot, ".signals"));
    writeFileSync(join(product.productRoot, ".signals", "ready.json"), "{}");
    git(product.productRoot, "add", "."); git(product.productRoot, "commit", "-qm", "evidence");
    const second = git(product.productRoot, "rev-parse", "HEAD");
    for (const mode of ["commit", "tree"] as const) expect(computeInputIdentity(product.productRoot, input.pin, mode))
      .not.toBe(computeInputIdentity(product.productRoot, second, mode));
    expect(computeInputIdentity(product.productRoot, input.pin, "tree-excluding-evidence"))
      .toBe(computeInputIdentity(product.productRoot, second, "tree-excluding-evidence"));
    git(product.productRoot, "commit", "--allow-empty", "-qm", "same tree different identity");
    const third = git(product.productRoot, "rev-parse", "HEAD");
    expect(computeInputIdentity(product.productRoot, second, "commit")).not.toBe(computeInputIdentity(product.productRoot, third, "commit"));
  });

  it("preserves original failure after a passing diagnostic retry and across restart", async () => {
    const { input } = fixture();
    input.selection.commands = [{ ...checked, retry: 1 }];
    let calls = 0;
    input.processRunner = async (argv) => ({ exitCode: argv[0] === "suite" && ++calls % 2 === 1 ? 7 : 0, stdout: "v", stderr: "failure" });
    for (let restart = 0; restart < 2; restart++) {
      const result = await runVerification(input);
      expect(result).toMatchObject({ ok: false, failed: { exitCode: 7, attempts: 2 } });
      expect(result.failed?.receiptId).toBeUndefined();
    }
    expect(calls).toBe(4);
    expect(existsSync(join(input.paths.coordRoot, "verification", "receipts"))).toBe(false);
  });

  it("rejects a passing command that modifies tracked inputs and never caches the dirty result", async () => {
    const { input } = fixture();
    input.processRunner = async (argv, cwd) => {
      if (argv[0] === "suite") writeFileSync(join(cwd, "README.md"), "not the pinned input");
      return { exitCode: 0, stdout: "v", stderr: "" };
    };
    const result = await runVerification(input);
    expect(result.ok).toBe(false);
    expect(result.failed?.receiptId).toBeUndefined();
    expect(readFileSync(result.failed!.logPath!, "utf8")).toContain("execution inputs changed");
  });

  it("invalidates reuse when declared dependency or relevant environment changes", async () => {
    const { input } = fixture();
    let dependency = "one", runs = 0;
    const check = { ...checked, cache: { ...checked.cache!, dependencies: ["generated-dependency"] } };
    input.selection.commands = [{ name: "prepare", argv: ["prepare"] }, check];
    input.processRunner = async (argv, cwd) => {
      if (argv[0] === "prepare") writeFileSync(join(cwd, "generated-dependency"), dependency);
      if (argv[0] === "suite") runs++;
      return { exitCode: 0, stdout: "v", stderr: "" };
    };
    expect((await runVerification(input)).ok).toBe(true);
    expect((await runVerification(input)).results[1]!.reused).toBe(true);
    dependency = "two";
    await runVerification(input);
    await runVerification({ ...input, environment: { TEST_SECRET: "changed" } });
    expect(runs).toBe(3);
  });

  it("serializes expensive uncached commands and retains live locks without an age timeout", async () => {
    const { input } = fixture();
    input.selection.commands = [{ name: "expensive", argv: ["expensive"], expensive: true }];
    let active = 0, peak = 0;
    input.processRunner = async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 130));
      active--;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await Promise.all([runVerification(input), runVerification(input)]);
    expect(peak).toBe(1);
    const release = tryVerificationLock(input.paths.coordRoot, "test-live")!;
    expect(tryVerificationLock(input.paths.coordRoot, "test-live")).toBeNull();
    release();
    const next = tryVerificationLock(input.paths.coordRoot, "test-live")!;
    release(); // an old owner's release cannot delete its replacement
    expect(tryVerificationLock(input.paths.coordRoot, "test-live")).toBeNull();
    next();
  });

  it("does not publish a receipt after losing authority or a launch error", async () => {
    const { input, events } = fixture();
    let stale = false;
    input.checkpoint = () => { if (stale) throw new Error("stale action"); };
    input.processRunner = async (argv) => {
      if (argv[0] === "suite") stale = true;
      return { exitCode: 0, stdout: "v", stderr: "" };
    };
    await expect(runVerification(input)).rejects.toThrow("stale action");
    expect(events.some((event) => event.type === "verification-run" &&
      (event.details.command as { name: string }).name === "suite")).toBe(true);
    expect(existsSync(join(input.paths.coordRoot, "verification", "receipts"))).toBe(false);
    stale = false;
    input.processRunner = async (argv) => { if (argv[0] === "suite") throw new Error("cannot spawn"); return { exitCode: 0, stdout: "v", stderr: "" }; };
    await expect(runVerification(input)).rejects.toThrow("cannot spawn");
    expect(existsSync(join(input.paths.coordRoot, "verification", "receipts"))).toBe(false);
  });
});
