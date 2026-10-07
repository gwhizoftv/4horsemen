import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hermeticGitEnv } from "./mirror.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import type { ProcessResult, ProcessRunner } from "./runLoop.js";
import type { CheckCommand, StartState } from "./state.js";
import type { CheckResult } from "./steps.js";
import { verificationMeasurement, type VerificationMeasurement } from "./verificationLog.js";
import {
  computeInputIdentity,
  dependencyIdentity,
  envDigests,
  readReceipt,
  receiptKey,
  releaseLock,
  runningLockPath,
  slotLockPath,
  tryAcquireLock,
  writeReceipt,
  type Receipt,
  type ReceiptKeyMaterial
} from "./verificationReceipts.js";

/**
 * The one runner behind the coordinator's candidate and final gates. Commands
 * run in a worktree materialized from the mirror at the pin, in declared order,
 * stopping at the first failure. A cacheable command is satisfied by a trusted
 * receipt for equivalent inputs, joins a live runner already producing one, or
 * runs and records a receipt only after a clean exit-0 run that left tracked
 * inputs unchanged. Diagnostic retries never turn a failure green.
 */

export type VerificationJournal = (type: "verification-run" | "final-check" | "verification-reused" | "verification-joined",
  details: Record<string, unknown>, at: string) => void;

export type RunVerificationInput = {
  paths: IssueRuntimePaths;
  start: StartState;
  mirror: { path: string; materializeWorktree(target: string, sha: string): Promise<void>; removeWorktree(target: string): Promise<void> };
  processRunner: ProcessRunner;
  now: () => string;
  /** Throws when the coordinator lost authority; called between every step. */
  checkpoint: () => void;
  journal: VerificationJournal;
  phase: "candidate" | "finalization";
  pin: string;
  classification: { kind: "coordination" | "documentation" | "product"; reason: string; inputIdentity: string };
  commands: readonly CheckCommand[];
  environment?: { platform: string; arch: string; node: string; env: NodeJS.ProcessEnv };
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long to wait for another live runner of the same key before running anyway. */
  joinWaitMs?: number;
};

export type RunVerificationResult =
  | { status: "passed"; results: CheckResult[] }
  | { status: "failed"; results: CheckResult[]; failed: CheckResult; failure: string; stderr: string; note: string | null }
  /** Another live runner still holds this input's key: re-evaluate later rather than run unlocked. */
  | { status: "waiting"; results: CheckResult[]; waitingFor: string };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Tracked files in the worktree still match the pin. Untracked and ignored
 * outputs (dependencies, build products) are not checked-in inputs. */
const trackedInputsClean = (worktree: string): boolean => {
  const status = spawnSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
    { cwd: worktree, encoding: "buffer", env: hermeticGitEnv() });
  return status.status === 0 && status.stdout.length === 0;
};

export const runVerification = async (input: RunVerificationInput): Promise<RunVerificationResult> => {
  const { paths, start, checkpoint } = input;
  const sleep = input.sleep ?? defaultSleep;
  const pollMs = input.pollMs ?? 1_000;
  const joinWaitMs = input.joinWaitMs ?? 30 * 60_000;
  const environment = input.environment ?? { platform: process.platform, arch: process.arch, node: process.version, env: process.env };
  const results: CheckResult[] = [];
  if (input.commands.length === 0) return { status: "passed", results };

  const journal: VerificationJournal = (type, details, at) => { checkpoint(); input.journal(type, details, at); };
  const target = containedPath(paths.issueRoot, `.verification-${randomUUID()}`);
  const identities = new Map<string, string>();
  const probes = new Map<string, ProcessResult>();
  const held: Array<[string, string]> = [];
  const release = (path: string) => {
    const index = held.findIndex(([heldPath]) => heldPath === path);
    if (index >= 0) { releaseLock(path, held[index]![1]); held.splice(index, 1); }
  };
  /** Claim the per-key running lock, or wait for its live owner and return the
   * receipt that owner wrote. A failed or interrupted owner leaves no receipt,
   * so the waiter then claims the lock and runs the command itself. A live
   * owner that never finishes cannot hold this tick past `joinWaitMs`: the
   * waiter then runs the command itself without the lock. */
  const claim = async (key: string): Promise<{ receipt: Receipt; how: "reused" | "joined" } | "claimed" | "timed-out"> => {
    const path = runningLockPath(paths.coordRoot, key);
    const deadline = Date.parse(input.now()) + joinWaitMs;
    for (let polls = 0; ; polls++) {
      checkpoint();
      const token = tryAcquireLock(paths.coordRoot, path);
      if (token !== null) {
        held.push([path, token]);
        // The previous owner may have finished between the first read and this claim.
        const after = readReceipt(paths.coordRoot, key);
        if (after.status !== "hit") return "claimed";
        release(path);
        return { receipt: after.receipt, how: polls === 0 ? "reused" : "joined" };
      }
      if (Date.parse(input.now()) >= deadline) return "timed-out";
      await sleep(pollMs);
      const again = readReceipt(paths.coordRoot, key);
      if (again.status === "hit") return { receipt: again.receipt, how: "joined" };
    }
  };

  /** Key material, or the reason this command cannot be cached right now. */
  const keyFor = async (command: CheckCommand): Promise<ReceiptKeyMaterial | string> => {
    if (command.cache === undefined) return "not cached: no cache declaration";
    if (start.verificationDigest === undefined) return "not cached: no frozen verification policy";
    const mode = command.cache.inputs;
    let identity = identities.get(mode);
    if (identity === undefined) {
      try { identity = computeInputIdentity(input.mirror.path, input.pin, mode); }
      catch (error) { return `not cached: ${error instanceof Error ? error.message : String(error)}`; }
      identities.set(mode, identity);
    }
    const probeResults: ReceiptKeyMaterial["probes"] = [];
    for (const argv of command.cache.probes) {
      const id = JSON.stringify(argv);
      let probe = probes.get(id);
      if (probe === undefined) {
        try { probe = await input.processRunner(argv, target); }
        catch { return `not cached: probe ${argv.join(" ")} could not run`; }
        probes.set(id, probe);
      }
      if (probe.exitCode !== 0) return `not cached: probe ${argv.join(" ")} exited ${probe.exitCode}`;
      probeResults.push({ argv: [...argv], stdout: probe.stdout.trim() });
    }
    // Hashed now, after the commands before this one prepared the worktree.
    let dependencies: string;
    try { dependencies = dependencyIdentity(target, command.cache.dependencies); }
    catch (error) { return `not cached: ${error instanceof Error ? error.message : String(error)}`; }
    return {
      v: 1, origin: start.origin, inputsMode: mode, inputIdentity: identity, argv: [...command.argv],
      policyDigest: start.verificationDigest, platform: environment.platform, arch: environment.arch,
      node: environment.node, probes: probeResults, env: envDigests(command.cache.env, environment.env), dependencies
    };
  };

  const satisfiedBy = (command: CheckCommand, receipt: Receipt, how: "reused" | "joined"): CheckResult => {
    journal(how === "reused" ? "verification-reused" : "verification-joined", {
      phase: input.phase, name: command.name, argv: command.argv, pin: input.pin, receiptId: receipt.key,
      inputIdentity: receipt.material.inputIdentity, originalDurationMs: receipt.durationMs, logPath: receipt.logPath
    }, input.now());
    return { name: command.name, argv: [...command.argv], exitCode: 0, [how]: true, receiptId: receipt.key, logPath: receipt.logPath };
  };

  try {
    checkpoint();
    await input.mirror.materializeWorktree(target, input.pin);
    checkpoint();
    // Every command below must leave tracked files as the pin has them, so a
    // later command, and any receipt it reuses or writes, always sees the pin.
    if (!trackedInputsClean(target)) throw new Error(`Verification worktree for ${input.pin} does not match its pin.`);
    const logs = containedPath(paths.issueRoot, "verification-logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.issueRoot, logs);

    for (const command of input.commands) {
      checkpoint();
      const material = await keyFor(command);
      // Every command already left tracked files as the pin has them, so a
      // change here came from this command's probes: never reuse or run on it.
      if (!trackedInputsClean(target)) {
        const logPath = containedPath(logs, `${randomUUID()}.log`);
        const probeList = (command.cache?.probes ?? []).map((argv) => argv.join(" ")).join(", ");
        writeFileSync(logPath, `coord: probes for ${command.name} (${probeList}) modified tracked files, so the pin's bytes are no longer what would be checked.\n`,
          { mode: 0o600 });
        const failed: CheckResult = { name: command.name, argv: [...command.argv], exitCode: 1, logPath };
        results.push(failed);
        return { status: "failed", results, failed, failure: `probes for ${command.name} modified tracked files`, stderr: "", note: null };
      }
      const key = typeof material === "string" ? null : receiptKey(material);
      let cacheReason = typeof material === "string" ? material : "miss: no receipt";
      if (key !== null) {
        const read = readReceipt(paths.coordRoot, key);
        if (read.status === "hit") { results.push(satisfiedBy(command, read.receipt, "reused")); continue; }
        cacheReason = `miss: ${read.reason}`;
        const shared = await claim(key);
        if (shared === "timed-out") return { status: "waiting", results, waitingFor: command.name };
        if (shared !== "claimed") { results.push(satisfiedBy(command, shared.receipt, shared.how)); continue; }
      }

      let queueWaitMs = 0;
      let slot: string | null = null;
      if (command.expensive === true) {
        const queuedAt = Date.parse(input.now());
        const slots = Array.from({ length: start.verification?.maxConcurrentExpensive ?? 1 }, (_, index) => slotLockPath(paths.coordRoot, index));
        for (;;) {
          checkpoint();
          for (const candidate of slots) {
            const token = tryAcquireLock(paths.coordRoot, candidate);
            if (token !== null) { held.push([candidate, token]); slot = candidate; break; }
          }
          if (slot !== null) break;
          await sleep(pollMs);
        }
        queueWaitMs = Math.max(0, Date.parse(input.now()) - queuedAt);
      }

      const argv = command.argv.map((argument) => argument.replaceAll("{worktree}", target));
      const attempts = 1 + (command.retry ?? 0);
      let original: { exitCode: number; stderr: string; logPath: string; measurement: VerificationMeasurement; modified: boolean } | null = null;
      let retryNote: string | null = null;
      let ran = 0;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        ran = attempt;
        checkpoint();
        const logPath = containedPath(logs, `${randomUUID()}.log`);
        const startedAt = input.now();
        const record = (exitCode: number, error?: string) => {
          const measurement = verificationMeasurement({ trigger: "coordinator", phase: input.phase,
            inputIdentity: input.classification.inputIdentity, classification: input.classification.kind,
            reason: input.classification.reason, command: { name: command.name, argv }, startedAt, completedAt: input.now(),
            exitCode, skipReason: null, cacheReason, attempt, logPath,
            ...(attempt === 1 && command.expensive === true ? { queueWaitMs } : {}),
            ...(key === null ? {} : { receiptId: key }), ...(error === undefined ? {} : { error }) });
          journal("verification-run", measurement, measurement.completedAt);
          return measurement;
        };
        let result: ProcessResult;
        try { result = await input.processRunner(argv, target); }
        catch (error) {
          writeFileSync(logPath, `$ ${argv.join(" ")}\n${String(error)}\n`, { mode: 0o600 });
          record(1, String(error));
          // A coordinator launch failure is not a rejected agent submission.
          throw error;
        }
        const modified = !trackedInputsClean(target);
        writeFileSync(logPath, `$ ${argv.join(" ")}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\nexit ${result.exitCode}\n` +
          (modified ? "coord: this command modified tracked files, so the pin's bytes are not what was checked.\n" : ""), { mode: 0o600 });
        const measurement = record(result.exitCode);
        if (input.phase === "finalization") {
          journal("final-check", { tier: "checks", name: command.name, argv, exitCode: result.exitCode,
            durationMs: measurement.durationMs, logPath, attempt, cacheReason, ...(key === null ? {} : { receiptId: key }) },
          measurement.completedAt);
        }
        // Never retry in a tree that no longer matches the pin.
        if (original === null) {
          original = { exitCode: result.exitCode, stderr: result.stderr, logPath, measurement, modified };
          if (result.exitCode === 0 || modified) break;
        } else {
          retryNote = `diagnostic retry ${result.exitCode === 0 && !modified ? "passed" : "also failed"}; the original failure is the outcome`;
          if (result.exitCode === 0 || modified) break;
        }
      }
      if (slot !== null) release(slot);
      const first = original!;
      if (first.exitCode !== 0 || first.modified) {
        const failed: CheckResult = { name: command.name, argv, exitCode: first.exitCode, logPath: first.logPath, attempts: ran };
        results.push(failed);
        const failure = first.exitCode !== 0 ? `${command.name} failed with exit ${first.exitCode}`
          : `${command.name} exited 0 but modified tracked files`;
        const notes = [first.exitCode !== 0 && first.modified ? "it also modified tracked files" : null, retryNote]
          .filter((entry): entry is string => entry !== null);
        return { status: "failed", results, failed, failure, stderr: first.stderr, note: notes.length === 0 ? null : notes.join("; ") };
      }
      // A receipt certifies the inputs the command actually ran against: the
      // declared dependencies must still be what the key recorded.
      let receiptId: string | undefined;
      if (key !== null && typeof material !== "string") {
        let unchanged = false;
        try { unchanged = dependencyIdentity(target, command.cache!.dependencies) === material.dependencies; }
        catch { unchanged = false; }
        if (unchanged) {
          writeReceipt(paths.coordRoot, {
            formatVersion: 1, key, material, name: command.name, exitCode: 0,
            durationMs: first.measurement.durationMs ?? 0, issue: start.issue, issueSessionId: start.issueSessionId,
            productPin: input.pin, logPath: first.logPath, completedAt: first.measurement.completedAt
          });
          receiptId = key;
        }
      }
      if (key !== null) release(runningLockPath(paths.coordRoot, key));
      results.push({ name: command.name, argv, exitCode: 0, logPath: first.logPath, attempts: 1,
        ...(receiptId === undefined ? {} : { receiptId }) });
    }
    return { status: "passed", results };
  } finally {
    for (const [path, token] of held.splice(0)) releaseLock(path, token);
    await input.mirror.removeWorktree(target);
    rmSync(target, { recursive: true, force: true });
  }
};
