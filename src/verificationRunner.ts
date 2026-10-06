import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { containedPath, type IssueRuntimePaths } from "./paths.js";
import { appendJournal, type CheckCommand, type StartState } from "./state.js";
import type { CheckResult } from "./steps.js";
import type { ProcessRunner } from "./runLoop.js";
import { verificationMeasurement } from "./verificationLog.js";
import {
  acquireLock,
  computeInputIdentity,
  readReceipt,
  receiptKey,
  releaseLock,
  writeReceipt,
  type Lock,
  type ReceiptKeyMaterial
} from "./verificationReceipts.js";

/**
 * One execution path for both coordinator gates.
 *
 * The candidate gate proves a submitted implementation pin and the final gate
 * proves the approved one. They differ only in what selected the commands, so
 * worktree handling, receipts, locking, the expensive-command limiter, logs and
 * journalling live here once rather than twice in the run loop.
 */

export type VerificationTrigger = "candidate" | "final";
export type VerificationPhase = "candidate" | "finalization";

export type VerificationSelection = {
  kind: "coordination" | "documentation" | "product";
  reason: string;
  inputIdentity: string;
  commands: readonly CheckCommand[];
};

/** Per-component detail the run loop needs for its own journal events. */
export type VerificationRecord = {
  name: string;
  argv: readonly string[];
  exitCode: number;
  durationMs: number | null;
  cacheReason: string;
  attempt: number;
  logPath: string | null;
  receiptId: string | null;
};

export type VerificationRunResult = {
  ok: boolean;
  results: CheckResult[];
  records: VerificationRecord[];
  failed?: { name: string; exitCode: number; logPath: string | null; stderr: string; note: string };
};

export type VerificationMirror = {
  path: string;
  materializeWorktree: (target: string, sha: string) => Promise<void>;
  removeWorktree: (target: string) => Promise<void>;
};

export type RunVerificationInput = {
  paths: IssueRuntimePaths;
  start: StartState;
  mirror: VerificationMirror;
  processRunner: ProcessRunner;
  now: () => string;
  /** Re-asserts coordinator authority between every slow step. */
  checkpoint: () => void;
  agent: string;
  actionId: string;
  trigger: VerificationTrigger;
  phase: VerificationPhase;
  pin: string;
  selection: VerificationSelection;
  environment?: NodeJS.ProcessEnv;
  sleep?: (milliseconds: number) => Promise<void>;
};

const POLL_INTERVAL_MS = 1_000;
const SLOT_POLL_INTERVAL_MS = 200;
/** A waiter that has polled this long stops joining and runs the command itself. */
const JOIN_WAIT_LIMIT_MS = 30 * 60 * 1000;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const verificationRoot = (coordRoot: string, ...parts: readonly string[]): string =>
  containedPath(coordRoot, "verification", ...parts);

type ProbeResult = { argv: readonly string[]; stdout: string } | null;

const runProbes = async (
  input: RunVerificationInput,
  worktree: string
): Promise<Map<string, ProbeResult>> => {
  const probes = new Map<string, ProbeResult>();
  for (const command of input.selection.commands) {
    for (const argv of command.cache?.probes ?? []) {
      const identity = JSON.stringify(argv);
      if (probes.has(identity)) continue;
      input.checkpoint();
      try {
        // Probes run in the worktree because the toolchain they report can be
        // pinned by the tree itself (for example `packageManager`).
        const result = await input.processRunner(argv, worktree);
        probes.set(identity, result.exitCode === 0 ? { argv, stdout: result.stdout } : null);
      } catch {
        probes.set(identity, null);
      }
    }
  }
  return probes;
};

const keyMaterialFor = (
  input: RunVerificationInput,
  command: CheckCommand,
  probes: Map<string, ProbeResult>
): { material: ReceiptKeyMaterial } | { reason: string } => {
  const cache = command.cache;
  if (cache === undefined) return { reason: "not cached: no cache metadata declared" };
  const policyDigest = input.start.verificationDigest;
  if (policyDigest === undefined) return { reason: "not cached: the issue froze no verification digest" };
  const inputIdentity = computeInputIdentity(input.mirror.path, input.pin, cache.inputs);
  if (inputIdentity === null) return { reason: "not cached: the input identity could not be computed" };
  const resolved: { argv: string[]; stdout: string }[] = [];
  for (const argv of cache.probes) {
    const probe = probes.get(JSON.stringify(argv));
    if (probe === undefined || probe === null) return { reason: `not cached: probe ${argv.join(" ")} failed` };
    resolved.push({ argv: [...probe.argv], stdout: probe.stdout });
  }
  const environment = input.environment ?? process.env;
  return {
    material: {
      v: 1,
      origin: input.start.origin,
      inputsMode: cache.inputs,
      inputIdentity,
      argv: [...command.argv],
      policyDigest,
      platform: typeof environment.COORD_PLATFORM === "string" ? environment.COORD_PLATFORM : process.platform,
      arch: typeof environment.COORD_ARCH === "string" ? environment.COORD_ARCH : process.arch,
      node: typeof environment.COORD_NODE === "string" ? environment.COORD_NODE : process.version,
      probes: resolved,
      env: cache.env.map((name) => ({ name, value: environment[name] ?? null }))
    }
  };
};

/**
 * Hold one of the declared expensive slots.
 *
 * The limiter is process-external for the same reason the per-key lock is:
 * several issue runners can share one coordinator root, and an in-process
 * semaphore would let each of them start its own heavy suite.
 */
const takeExpensiveSlot = async (
  input: RunVerificationInput,
  sleep: (milliseconds: number) => Promise<void>
): Promise<{ lock: Lock | null; queueWaitMs: number }> => {
  const limit = input.start.verification?.maxConcurrentExpensive ?? 1;
  const from = Date.now();
  for (;;) {
    for (let slot = 0; slot < limit; slot += 1) {
      const lock = acquireLock(verificationRoot(input.paths.coordRoot, "slots", `${slot}.lock`));
      if (lock !== null) return { lock, queueWaitMs: Date.now() - from };
    }
    await sleep(SLOT_POLL_INTERVAL_MS);
    input.checkpoint();
  }
};

/**
 * Run the selected commands against one pin, in declared order, stopping at the
 * first failure. Launch errors propagate: a coordinator that cannot spawn a
 * declared command has not observed a failed submission.
 */
export const runVerification = async (input: RunVerificationInput): Promise<VerificationRunResult> => {
  const results: CheckResult[] = [];
  const records: VerificationRecord[] = [];
  if (input.selection.commands.length === 0) return { ok: true, results, records };

  const sleep = input.sleep ?? defaultSleep;
  const worktree = containedPath(input.paths.issueRoot, `.verification-${randomUUID()}`);
  const logDirectory = containedPath(input.paths.issueRoot, "verification-logs");
  const held: Lock[] = [];
  let failed: VerificationRunResult["failed"];

  try {
    input.checkpoint();
    await input.mirror.materializeWorktree(worktree, input.pin);
    input.checkpoint();
    mkdirSync(logDirectory, { recursive: true, mode: 0o700 });
    const probes = await runProbes(input, worktree);

    for (const command of input.selection.commands) {
      input.checkpoint();
      const argv = command.argv.map((argument) => argument.replaceAll("{worktree}", worktree));
      const keyed = keyMaterialFor(input, command, probes);
      const key = "material" in keyed ? receiptKey(keyed.material) : null;
      let cacheReason = "material" in keyed ? "" : keyed.reason;
      let keyLock: Lock | null = null;

      if (key !== null) {
        const hit = readReceipt(input.paths.coordRoot, key);
        if (hit.ok) {
          const at = input.now();
          appendJournal(input.paths, {
            type: "verification-reused", agent: input.agent, actionId: input.actionId,
            details: { name: command.name, phase: input.phase, trigger: input.trigger, pin: input.pin,
              receiptId: hit.receipt.receiptId, originalDurationMs: hit.receipt.durationMs }
          }, at);
          results.push({ name: command.name, argv, exitCode: 0, reused: true, receiptId: hit.receipt.receiptId });
          records.push({ name: command.name, argv, exitCode: 0, durationMs: 0,
            cacheReason: `reused receipt ${hit.receipt.receiptId}`, attempt: 0, logPath: null,
            receiptId: hit.receipt.receiptId });
          continue;
        }
        cacheReason = `cacheable, ${hit.reason}`;

        const lockPath = verificationRoot(input.paths.coordRoot, "running", `${key}.lock`);
        keyLock = acquireLock(lockPath);
        if (keyLock === null) {
          const until = Date.now() + JOIN_WAIT_LIMIT_MS;
          while (keyLock === null && Date.now() < until) {
            await sleep(POLL_INTERVAL_MS);
            input.checkpoint();
            keyLock = acquireLock(lockPath);
          }
          // The owner released the lock: a receipt means its run succeeded and
          // this one joins it; a miss means it was interrupted or failed, so
          // this runner holds the lock and runs the command itself.
          const joined = readReceipt(input.paths.coordRoot, key);
          if (joined.ok) {
            if (keyLock !== null) releaseLock(keyLock);
            const at = input.now();
            appendJournal(input.paths, {
              type: "verification-joined", agent: input.agent, actionId: input.actionId,
              details: { name: command.name, phase: input.phase, trigger: input.trigger, pin: input.pin,
                receiptId: joined.receipt.receiptId, originalDurationMs: joined.receipt.durationMs }
            }, at);
            results.push({ name: command.name, argv, exitCode: 0, reused: true, joined: true,
              receiptId: joined.receipt.receiptId });
            records.push({ name: command.name, argv, exitCode: 0, durationMs: 0,
              cacheReason: `joined receipt ${joined.receipt.receiptId}`, attempt: 0, logPath: null,
              receiptId: joined.receipt.receiptId });
            continue;
          }
          cacheReason = `cacheable, ${joined.reason} after waiting for a concurrent runner`;
        }
        if (keyLock !== null) held.push(keyLock);
      }

      let slot: Lock | null = null;
      let queueWaitMs = 0;
      if (command.expensive === true) {
        const taken = await takeExpensiveSlot(input, sleep);
        slot = taken.lock;
        queueWaitMs = taken.queueWaitMs;
        if (slot !== null) held.push(slot);
      }

      const attempts = 1 + (command.retry ?? 0);
      let first: { exitCode: number; stderr: string; logPath: string; durationMs: number | null } | null = null;
      let retryNote = "";
      try {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          input.checkpoint();
          const startedAt = input.now();
          let result: { exitCode: number; stdout: string; stderr: string };
          try {
            result = await input.processRunner(argv, worktree);
          } catch (error) {
            const measurement = verificationMeasurement({ trigger: "coordinator", phase: input.phase,
              inputIdentity: input.selection.inputIdentity, classification: input.selection.kind,
              reason: input.selection.reason, command: { name: command.name, argv },
              startedAt, completedAt: input.now(), exitCode: 1, skipReason: null, attempt,
              ...(attempt === 1 ? { queueWaitMs } : {}), cacheReason, error: String(error) });
            appendJournal(input.paths, { type: "verification-run", agent: input.agent, actionId: input.actionId,
              details: measurement }, measurement.completedAt);
            throw error;
          }
          const measurement = verificationMeasurement({ trigger: "coordinator", phase: input.phase,
            inputIdentity: input.selection.inputIdentity, classification: input.selection.kind,
            reason: input.selection.reason, command: { name: command.name, argv },
            startedAt, completedAt: input.now(), exitCode: result.exitCode, skipReason: null, attempt,
            ...(attempt === 1 ? { queueWaitMs } : {}), cacheReason });
          const logPath = containedPath(logDirectory, `${measurement.measurementId}.log`);
          writeFileSync(logPath, `$ ${argv.join(" ")}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`, { mode: 0o600 });
          appendJournal(input.paths, { type: "verification-run", agent: input.agent, actionId: input.actionId,
            details: { ...measurement, logPath } }, measurement.completedAt);

          if (first === null) {
            first = { exitCode: result.exitCode, stderr: result.stderr, logPath, durationMs: measurement.durationMs };
          } else {
            retryNote = result.exitCode === 0
              ? ` (diagnostic retry ${attempt - 1} passed; the original failure stands)`
              : ` (diagnostic retry ${attempt - 1} also failed with exit ${result.exitCode})`;
          }
          if (result.exitCode === 0) {
            if (attempt === 1 && key !== null && "material" in keyed) {
              writeReceipt(input.paths.coordRoot, { v: 1, key, receiptId: measurement.measurementId,
                name: command.name, exitCode: 0, durationMs: measurement.durationMs ?? 0,
                completedAt: measurement.completedAt, material: keyed.material });
            }
            break;
          }
        }
      } finally {
        if (slot !== null) {
          releaseLock(slot);
          held.splice(held.indexOf(slot), 1);
        }
      }

      if (keyLock !== null) {
        releaseLock(keyLock);
        held.splice(held.indexOf(keyLock), 1);
      }

      if (first === null) throw new Error(`Declared check ${command.name} produced no result.`);
      const outcome = first;
      const ran = outcome.exitCode === 0 ? 1 : attempts;
      results.push({ name: command.name, argv, exitCode: outcome.exitCode, logPath: outcome.logPath, attempts: ran });
      records.push({ name: command.name, argv, exitCode: outcome.exitCode, durationMs: outcome.durationMs,
        cacheReason, attempt: ran, logPath: outcome.logPath, receiptId: null });
      if (outcome.exitCode !== 0) {
        failed = { name: command.name, exitCode: outcome.exitCode, logPath: outcome.logPath,
          stderr: outcome.stderr, note: retryNote };
        break;
      }
    }
  } finally {
    for (const lock of held) releaseLock(lock);
    await input.mirror.removeWorktree(worktree);
    rmSync(worktree, { recursive: true, force: true });
  }

  return { ok: failed === undefined, results, records, ...(failed === undefined ? {} : { failed }) };
};
