import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { hermeticGitEnv } from "./mirror.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import type { ProcessResult, ProcessRunner } from "./runLoop.js";
import type { CheckCommand, StartState } from "./state.js";
import type { CheckResult } from "./steps.js";
import { resolveProductEnvironment } from "./verificationEnvironment.js";
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
 *
 * Every probe and command receives the product's environment, selected once in
 * the materialized checkout (see verificationEnvironment.ts), so children such
 * as pnpm's scripts resolve the product's Node rather than the inherited PATH.
 */

export type VerificationJournal = (type: "verification-run" | "final-check" | "verification-reused" | "verification-joined" | "baseline-check",
  details: Record<string, unknown>, at: string) => void;

/** The environment checks actually ran in; `toolchain` is the selected Node, or null for the inherited PATH. */
export type VerificationEnvironment = { platform: string; arch: string; node: string; env: NodeJS.ProcessEnv; toolchain: string | null };

/**
 * What a failure can be compared on. `diagnostics` holds every specific
 * diagnostic line (normalized, stream-tagged); generic wrappers such as
 * `build failed` or an exit-code summary never appear, so generic-only output
 * leaves it empty and can never establish that two failures are the same.
 */
export type FailureEvidence = { kind: "exit" | "missing-executable" | "modified"; diagnostics: string[] };

export type RunVerificationInput = {
  paths: IssueRuntimePaths;
  start: StartState;
  policyDigest?: string;
  mirror: { path: string; materializeWorktree(target: string, sha: string): Promise<void>; removeWorktree(target: string): Promise<void> };
  processRunner: ProcessRunner;
  now: () => string;
  /** Throws when the coordinator lost authority; called between every step. */
  checkpoint: () => void;
  journal: VerificationJournal;
  /** Operator progress only; verification decisions continue to use receipts and checkpoints. */
  progress?: (message: string) => void;
  phase: "candidate" | "finalization";
  pin: string;
  classification: { kind: "coordination" | "documentation" | "product"; reason: string; inputIdentity: string };
  commands: readonly CheckCommand[];
  environment?: { platform: string; arch: string; node: string; env: NodeJS.ProcessEnv };
  /** An already selected environment (the candidate's, for its baseline comparison); skips selection. */
  resolved?: VerificationEnvironment;
  /** `baseline`: an uncached diagnostic run, journaled apart from gate verification. */
  diagnostic?: "baseline";
  /** False runs every command fresh: no receipt is read, joined or written. */
  reuse?: boolean;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  /** How long to wait for another live runner of the same key before running anyway. */
  joinWaitMs?: number;
};

export type RunVerificationResult =
  | { status: "passed"; results: CheckResult[] }
  | { status: "failed"; results: CheckResult[]; failed: CheckResult; failure: string; stdout: string; stderr: string; note: string | null;
      /** Position of the failed command in the declared list. */
      index: number; excerpt: string; evidence: FailureEvidence; environment: VerificationEnvironment }
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

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const SPECIFIC = [
  /\b(?:errors?|fatal|exception|panic(?:ked)?|traceback|assert(?:ion)?(?:error)?|cannot|can't|couldn't|unable|denied|missing|not found|no such file|undefined|unresolved|invalid|unexpected|refused|segmentation fault)\b/i,
  /\bFAIL(?:ED)?\b/, /\bE[A-Z]{3,}\b/, /^\s*(?:✗|×|✖)/
];
const GENERIC = [
  /^(?:\S+\s+)?(?:failed|failure|errored|error)[.!:]?$/i,
  /\b(?:command|process|script|task)\b.*\bfailed\b.*\b(?:code|status)\s*\d+/i,
  /\bexit(?:ed)? (?:with )?(?:exit )?(?:code|status) \d+/i,
  /\bELIFECYCLE\b/,
  /^exit(?: code| status)? \d+$/i
];

/** Lines as a terminal last rendered them: escapes removed, carriage-return progress collapsed. */
const renderedLines = (text: string): string[] => text.replace(ANSI, "").split("\n").map((line) =>
  line.split("\r").filter((segment) => segment.trim() !== "").at(-1)?.trim() ?? "").filter((line) => line !== "");

const isSpecific = (line: string): boolean => SPECIFIC.some((pattern) => pattern.test(line)) && !GENERIC.some((pattern) => pattern.test(line));

const tagged = (stdout: string, stderr: string): Array<[stream: "stdout" | "stderr", line: string]> => [
  ...renderedLines(stdout).map((line) => ["stdout", line] as ["stdout", string]),
  ...renderedLines(stderr).map((line) => ["stderr", line] as ["stderr", string])
];

/** Presentation noise only: worktree roots, timings and timestamps. Payloads, files and codes stay. */
const normalize = (line: string, worktree?: string): string =>
  (worktree === undefined ? line : line.replaceAll(worktree, "<worktree>"))
    .replace(/\.verification-[0-9a-f-]{36}/g, ".verification-<id>")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s)\b/g, "<duration>")
    .replace(/\s+/g, " ").trim();

/** Every specific diagnostic, independent of the display budget. */
export const actionableDiagnostics = (stdout: string, stderr: string, worktree?: string): string[] =>
  tagged(stdout, stderr).filter(([, line]) => isSpecific(line)).map(([stream, line]) => `${stream}: ${normalize(line, worktree)}`);

const EXCERPT_LINES = 8;
const EXCERPT_LINE_CHARS = 300;
const EXCERPT_CHARS = 2048;

/** A bounded display excerpt: specific diagnostics first, wherever progress put them; else the output's tail. */
export const failureExcerpt = (stdout: string, stderr: string): string => {
  const all = tagged(stdout, stderr);
  const specific = all.filter(([, line]) => isSpecific(line));
  const fallback = renderedLines(stderr).length > 0
    ? renderedLines(stderr).slice(-EXCERPT_LINES).map((line) => ["stderr", line] as const)
    : renderedLines(stdout).slice(-EXCERPT_LINES).map((line) => ["stdout", line] as const);
  const chosen = (specific.length > 0 ? specific : fallback).slice(0, EXCERPT_LINES);
  if (chosen.length === 0) return "(no output)";
  let excerpt = "";
  for (const [stream, line] of chosen) {
    const entry = `[${stream}] ${line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS - 1)}…` : line}`;
    if (excerpt.length + entry.length + 3 > EXCERPT_CHARS) break;
    excerpt += excerpt === "" ? entry : ` | ${entry}`;
  }
  return excerpt === "" ? chosen[0]![1].slice(0, EXCERPT_CHARS) : excerpt;
};

/** Equivalent only on the same failure kind and the identical, non-empty set of specific diagnostics. */
export const sameFailure = (a: FailureEvidence, b: FailureEvidence): boolean =>
  a.kind === b.kind && a.kind !== "modified" && a.diagnostics.length > 0 &&
  a.diagnostics.length === b.diagnostics.length && a.diagnostics.every((line, index) => line === b.diagnostics[index]);

export const runVerification = async (input: RunVerificationInput): Promise<RunVerificationResult> => {
  const { paths, start, checkpoint } = input;
  const progress = input.progress ?? (() => undefined);
  const sleep = input.sleep ?? defaultSleep;
  const pollMs = input.pollMs ?? 1_000;
  const joinWaitMs = input.joinWaitMs ?? 30 * 60_000;
  const base = input.environment ?? { platform: process.platform, arch: process.arch, node: process.version, env: process.env };
  let environment: VerificationEnvironment = input.resolved ?? { ...base, toolchain: null };
  const reuse = input.reuse !== false && input.diagnostic === undefined;
  const results: CheckResult[] = [];
  if (input.commands.length === 0) return { status: "passed", results };

  const journal: VerificationJournal = (type, details, at) => {
    checkpoint();
    if (input.diagnostic === "baseline") {
      // Diagnostic evidence only: never a gate run, final check or receipt event.
      if (type === "verification-run") input.journal("baseline-check", { ...details, pin: input.pin }, at);
      return;
    }
    input.journal(type, details, at);
  };
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
      if (polls === 0) progress("[WAIT] Waiting for another coordinator's verification of the same inputs...");
      await sleep(pollMs);
      const again = readReceipt(paths.coordRoot, key);
      if (again.status === "hit") return { receipt: again.receipt, how: "joined" };
    }
  };

  /** Key material, or the reason this command cannot be cached right now. */
  const keyFor = async (command: CheckCommand): Promise<ReceiptKeyMaterial | string> => {
    if (input.diagnostic === "baseline") return "not cached: baseline diagnostic";
    if (!reuse) return "not cached: fresh owner retry";
    if (command.cache === undefined) return "not cached: no cache declaration";
    if ((input.policyDigest ?? start.verificationDigest) === undefined) return "not cached: no frozen verification policy";
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
        try { probe = await input.processRunner(argv, target, { env: environment.env }); }
        catch { return `not cached: probe ${argv.join(" ")} could not run`; }
        probes.set(id, probe);
      }
      if (probe.exitCode !== 0) return `not cached: probe ${argv.join(" ")} exited ${probe.exitCode}`;
      probeResults.push({ argv: [...argv], stdout: probe.stdout.trim() });
    }
    // Hashed now, after the commands before this one prepared the worktree.
    let dependencies: string;
    try { dependencies = dependencyIdentity(target, command.cache.dependencies, command.cache.dependencyExcludes); }
    catch (error) { return `not cached: ${error instanceof Error ? error.message : String(error)}`; }
    return {
      v: 2, origin: start.origin, inputsMode: mode, inputIdentity: identity, argv: [...command.argv],
      policyDigest: (input.policyDigest ?? start.verificationDigest)!, platform: environment.platform, arch: environment.arch,
      node: environment.node, toolchain: environment.toolchain, probes: probeResults, env: envDigests(command.cache.env, environment.env),
      dependencies
    };
  };

  const satisfiedBy = (command: CheckCommand, receipt: Receipt, how: "reused" | "joined"): CheckResult => {
    progress(`[OK] ${command.name}: trusted success ${how}, not rerun (log: ${receipt.logPath}).`);
    journal(how === "reused" ? "verification-reused" : "verification-joined", {
      phase: input.phase, name: command.name, argv: command.argv, pin: input.pin, receiptId: receipt.key,
      inputIdentity: receipt.material.inputIdentity, originalDurationMs: receipt.durationMs, logPath: receipt.logPath
    }, input.now());
    return { name: command.name, argv: [...command.argv], exitCode: 0, [how]: true, receiptId: receipt.key, logPath: receipt.logPath };
  };

  try {
    checkpoint();
    progress(`[WAIT] Preparing verification for commit ${input.pin.slice(0, 12)}...`);
    await input.mirror.materializeWorktree(target, input.pin);
    checkpoint();
    // Every command below must leave tracked files as the pin has them, so a
    // later command, and any receipt it reuses or writes, always sees the pin.
    if (!trackedInputsClean(target)) throw new Error(`Verification worktree for ${input.pin} does not match its pin.`);
    if (input.resolved === undefined) {
      // An unavailable product pin is a coordinator environment fault, never a rejected submission.
      const product = resolveProductEnvironment(target, base.env);
      environment = { platform: base.platform, arch: base.arch, node: product.node ?? base.node, env: product.env, toolchain: product.nodePath };
      if (product.node !== null) progress(`[OK] Product Node ${product.node} (${product.pin} in .nvmrc) for every check.`);
    }
    const logs = containedPath(paths.issueRoot, "verification-logs");
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    assertNoSymlink(paths.issueRoot, logs);

    for (const [index, command] of input.commands.entries()) {
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
        const failure = `probes for ${command.name} modified tracked files`;
        return { status: "failed", results, failed, failure, stdout: "", stderr: "", note: null, index,
          excerpt: failure, evidence: { kind: "modified", diagnostics: [] }, environment };
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
        let announced = false;
        for (;;) {
          checkpoint();
          for (const candidate of slots) {
            const token = tryAcquireLock(paths.coordRoot, candidate);
            if (token !== null) { held.push([candidate, token]); slot = candidate; break; }
          }
          if (slot !== null) break;
          if (!announced) { progress(`[WAIT] ${command.name}: waiting for a verification slot...`); announced = true; }
          await sleep(pollMs);
        }
        queueWaitMs = Math.max(0, Date.parse(input.now()) - queuedAt);
      }

      const argv = command.argv.map((argument) => argument.replaceAll("{worktree}", target));
      const attempts = 1 + (command.retry ?? 0);
      let original: { exitCode: number; stdout: string; stderr: string; logPath: string; measurement: VerificationMeasurement;
        modified: boolean; missing: boolean } | null = null;
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
        let missing = false;
        progress(`[WAIT] Running ${command.name}${attempt > 1 ? ` (diagnostic retry ${attempt - 1}; original failure remains)` : ""}...`);
        try { result = await input.processRunner(argv, target, { env: environment.env }); }
        catch (error) {
          // At finalization, a declared executable that is not installed is a
          // check failure with comparable evidence (its baseline can show the
          // same gap). Every other launch fault stays a coordinator error.
          missing = input.phase === "finalization" && (error as NodeJS.ErrnoException).code === "ENOENT" &&
            (error as NodeJS.ErrnoException).path === argv[0] && existsSync(target);
          if (!missing) {
            writeFileSync(logPath, `$ ${argv.join(" ")}\n${String(error)}\n`, { mode: 0o600 });
            record(1, String(error));
            progress(`[ACTION] ${command.name}: could not start/finish (log: ${logPath}).`);
            // A coordinator launch failure is not a rejected agent submission.
            throw error;
          }
          result = { exitCode: 127, stdout: "", stderr: `coord: ${argv[0]}: executable not found on the check's PATH (${String(error)})\n` };
        }
        const modified = !trackedInputsClean(target);
        progress(`${result.exitCode === 0 && !modified ? "[OK]" : "[ACTION]"} ${command.name}: ${result.exitCode === 0 && !modified ? "passed" : "failed"}${attempt > 1 ? "; diagnostic only, original failure remains" : ""} (log: ${logPath}).`);
        writeFileSync(logPath, `$ ${argv.join(" ")}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\nexit ${result.exitCode}\n` +
          (modified ? "coord: this command modified tracked files, so the pin's bytes are not what was checked.\n" : ""), { mode: 0o600 });
        const measurement = record(result.exitCode);
        if (input.phase === "finalization" && input.diagnostic === undefined) {
          journal("final-check", { tier: "checks", name: command.name, argv, exitCode: result.exitCode,
            durationMs: measurement.durationMs, logPath, attempt, cacheReason, ...(key === null ? {} : { receiptId: key }) },
          measurement.completedAt);
        }
        // Never retry in a tree that no longer matches the pin.
        if (original === null) {
          original = { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, logPath, measurement, modified, missing };
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
        progress(`[ACTION] Verification failed: ${failure} (log: ${first.logPath}).`);
        const notes = [first.exitCode !== 0 && first.modified ? "it also modified tracked files" : null, retryNote]
          .filter((entry): entry is string => entry !== null);
        const evidence: FailureEvidence = first.modified ? { kind: "modified", diagnostics: [] }
          : first.missing ? { kind: "missing-executable", diagnostics: [`missing executable ${command.argv[0]}`] }
            : { kind: "exit", diagnostics: actionableDiagnostics(first.stdout, first.stderr, target) };
        return { status: "failed", results, failed, failure, stdout: first.stdout, stderr: first.stderr,
          note: notes.length === 0 ? null : notes.join("; "), index, excerpt: failureExcerpt(first.stdout, first.stderr), evidence, environment };
      }
      // A receipt certifies the inputs the command actually ran against: the
      // declared dependencies must still be what the key recorded.
      let receiptId: string | undefined;
      if (key !== null && typeof material !== "string") {
        let unchanged = false;
        try {
          unchanged = dependencyIdentity(target, command.cache!.dependencies, command.cache!.dependencyExcludes) === material.dependencies;
        } catch { unchanged = false; }
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
