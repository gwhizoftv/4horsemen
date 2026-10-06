import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { release as osRelease } from "node:os";
import { sha256 } from "./hash.js";
import type { BareMirror } from "./mirror.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import type { ProcessRunner } from "./runLoop.js";
import { verificationPolicyDigest, type CheckCommand, type StartState } from "./state.js";
import type { CheckResult } from "./steps.js";
import { verificationMeasurement, type VerificationMeasurement } from "./verificationLog.js";
import { computeInputIdentity, dependencyIdentity, readReceipt, receiptKey, trackedInputsClean,
  tryVerificationLock, tryExpensiveSlot, writeReceipt, type ReceiptMaterial, type VerificationReceipt } from "./verificationReceipts.js";

export type VerificationSelection = {
  kind: "coordination" | "documentation" | "product"; reason: string; inputIdentity: string; commands: readonly CheckCommand[];
};
type Event = "verification-run" | "verification-reused" | "verification-joined" | "final-check";
export type VerificationRunInput = {
  paths: IssueRuntimePaths; start: StartState; mirror: Pick<BareMirror, "path" | "materializeWorktree" | "removeWorktree">;
  processRunner: ProcessRunner; now: () => string; checkpoint: () => void;
  journal: (type: Event, details: Record<string, unknown>, at: string) => void;
  phase: "candidate" | "finalization"; pin: string; selection: VerificationSelection;
  environment?: NodeJS.ProcessEnv;
};
export type VerificationRunResult = { ok: boolean; results: CheckResult[]; failed?: CheckResult };

/** Shared synchronous-within-tick gate. State locks are never held over suite
 * execution. Authority is checked between effects and while waiting for locks. */
export const runVerification = async (input: VerificationRunInput): Promise<VerificationRunResult> => {
  const { paths, start, selection, checkpoint, now } = input;
  const results: CheckResult[] = [];
  if (selection.commands.length === 0) {
    checkpoint();
    const at = now();
    input.journal("verification-run", verificationMeasurement({ trigger: "coordinator", phase: input.phase,
      inputIdentity: selection.inputIdentity, classification: selection.kind, reason: selection.reason,
      command: null, startedAt: at, completedAt: at, exitCode: 0, skipReason: selection.reason,
      cacheReason: "no commands selected" }), at);
    return { ok: true, results };
  }
  const target = containedPath(paths.issueRoot, `.verification-${randomUUID()}`);
  const environment = input.environment ?? process.env;
  const redact = (text: string): string => {
    for (const name of new Set(selection.commands.flatMap((command) => command.cache?.env ?? []))) {
      const value = environment[name];
      if (value) text = text.replaceAll(value, "[redacted]");
    }
    return text;
  };
  const wait = async () => { checkpoint(); await new Promise((resolve) => setTimeout(resolve, 100)); checkpoint(); };
  const measure = async (command: CheckCommand, attempt: number, queueWaitMs: number, cacheReason: string) => {
    checkpoint();
    const startedAt = now();
    const logPath = containedPath(paths.issueRoot, "verification-logs", `${randomUUID()}.log`);
    assertNoSymlink(paths.coordRoot, logPath);
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    const argv = command.argv.map((arg) => arg.replaceAll("{worktree}", target));
    let result: Awaited<ReturnType<ProcessRunner>>;
    try { result = await input.processRunner(argv, target); }
    catch (error) {
      writeFileSync(logPath, redact(String(error)), { mode: 0o600 });
      input.journal("verification-run", verificationMeasurement({ trigger: "coordinator", phase: input.phase,
        inputIdentity: input.pin, classification: selection.kind, reason: selection.reason, command: { ...command, argv },
        startedAt, completedAt: now(), exitCode: 1, skipReason: null, cacheReason, attempt, queueWaitMs,
        logPath, error: redact(String(error)) }), now());
      checkpoint();
      throw error;
    }
    writeFileSync(logPath, redact(`argv: ${JSON.stringify(argv)}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`), { mode: 0o600 });
    const measurement = verificationMeasurement({ trigger: "coordinator", phase: input.phase,
      inputIdentity: input.pin, classification: selection.kind, reason: selection.reason,
      command: { ...command, argv }, startedAt, completedAt: now(), exitCode: result.exitCode,
      skipReason: null, cacheReason, attempt, queueWaitMs, logPath });
    input.journal("verification-run", measurement, measurement.completedAt);
    if (input.phase === "finalization") input.journal("final-check", {
      tier: "checks", name: command.name, argv, exitCode: result.exitCode,
      durationMs: measurement.durationMs, logPath, attempt, cacheReason
    }, measurement.completedAt);
    checkpoint();
    return { result, measurement, logPath };
  };
  try {
    checkpoint();
    assertNoSymlink(paths.coordRoot, target);
    await input.mirror.materializeWorktree(target, input.pin);
    checkpoint();
    if (!trackedInputsClean(target, input.pin)) throw new Error("Verification worktree does not match its immutable pin");
    for (const command of selection.commands) {
      checkpoint();
      let material: ReceiptMaterial | undefined;
      let cacheReason = "uncached: no complete input declaration";
      const cache = command.cache;
      if (cache !== undefined && cache.dependencies !== undefined && cache.probes.length > 0 &&
        start.verificationDigest === verificationPolicyDigest(start)) {
        try {
          const probes: ReceiptMaterial["probes"] = [];
          for (const argv of cache.probes) {
            const { result } = await measure({ name: `probe:${command.name}`, argv }, 1, 0, "toolchain probe");
            if (result.exitCode !== 0) throw new Error("toolchain probe failed");
            probes.push({ argv, digest: sha256(result.stdout) });
          }
          if (!trackedInputsClean(target, input.pin)) throw new Error("probe changed tracked inputs");
          material = {
            v: 1, origin: start.origin, inputsMode: cache.inputs,
            inputIdentity: computeInputIdentity(input.mirror.path, input.pin, cache.inputs), argv: command.argv,
            policyDigest: start.verificationDigest!, platform: `${process.platform}:${osRelease()}`, arch: process.arch, node: process.version,
            probes, env: [...cache.env].sort().map((name) => ({ name, digest: environment[name] === undefined ? null : sha256(environment[name]!) })),
            dependencyIdentity: dependencyIdentity(target, cache.dependencies),
            preparationIdentity: sha256(JSON.stringify(selection.commands.slice(0, selection.commands.indexOf(command)).map((entry) => entry.argv)))
          };
          cacheReason = "receipt miss";
        } catch {
          // An unavailable identity never turns into a pass. Authority conflicts
          // are rethrown by this checkpoint, including after a failed probe.
          checkpoint();
          material = undefined;
          cacheReason = "uncached: probe or dependency identity unavailable";
        }
      }
      if (!trackedInputsClean(target, input.pin)) {
        const failed = { name: command.name, argv: command.argv, exitCode: 1 };
        return { ok: false, results: [...results, failed], failed };
      }
      const key = material === undefined ? undefined : receiptKey(material);
      let release: (() => void) | undefined;
      let slot: (() => void) | undefined;
      let joined = false;
      const requestedAt = now();
      try {
        let receipt: VerificationReceipt | null = key === undefined ? null : readReceipt(paths.coordRoot, key);
        if (key !== undefined && receipt === null) {
          while (release === undefined) {
            checkpoint();
            release = tryVerificationLock(paths.coordRoot, key) ?? undefined;
            if (release === undefined) { joined = true; await wait(); }
          }
          receipt = readReceipt(paths.coordRoot, key);
        }
        if (receipt !== null) {
          checkpoint();
          const at = now();
          input.journal(joined ? "verification-joined" : "verification-reused", {
            pin: input.pin, phase: input.phase, command, receiptId: receipt.key, logPath: receipt.logPath,
            originalDurationMs: receipt.durationMs, startedAt: requestedAt, completedAt: at,
            queueWaitMs: Math.max(0, Date.parse(at) - Date.parse(requestedAt)), cacheReason: "equivalent declared inputs"
          }, at);
          results.push({ name: command.name, argv: command.argv, exitCode: 0, reused: !joined, joined,
            receiptId: receipt.key, logPath: receipt.logPath, attempts: 1 });
          continue;
        }
        if (command.expensive) {
          while (slot === undefined) {
            checkpoint();
            slot = tryExpensiveSlot(paths.coordRoot, start.verification?.maxConcurrentExpensive ?? 1) ?? undefined;
            if (slot === undefined) await wait();
          }
        }
        const queueWaitMs = Math.max(0, Date.parse(now()) - Date.parse(requestedAt));
        let original: CheckResult | undefined;
        let success: VerificationMeasurement | undefined;
        for (let attempt = 1; attempt <= 1 + (command.retry ?? 0); attempt++) {
          const { result, measurement, logPath } = await measure(command, attempt, attempt === 1 ? queueWaitMs : 0, cacheReason);
          let validInputs = trackedInputsClean(target, input.pin);
          if (material !== undefined) {
            try {
              validInputs &&= dependencyIdentity(target, cache!.dependencies!) === material.dependencyIdentity &&
                material.env.every((entry) => (environment[entry.name] === undefined ? null : sha256(environment[entry.name]!)) === entry.digest);
            } catch { validInputs = false; }
          }
          const exitCode = validInputs ? result.exitCode : 1;
          original ??= { name: command.name, argv: command.argv, exitCode, logPath, attempts: attempt };
          original.attempts = attempt;
          if (!validInputs) {
            writeFileSync(logPath, "\nVerification rejected: execution inputs changed from the declared immutable identity.\n", { flag: "a" });
          }
          if (exitCode === 0 && attempt === 1) { success = measurement; break; }
          if (!validInputs) break;
          // Retry is diagnostic; retain the original result even if it turns green.
        }
        checkpoint();
        if (success !== undefined && material !== undefined && key !== undefined) {
          writeReceipt(paths.coordRoot, { key, material, exitCode: 0, logPath: original!.logPath!,
            durationMs: success.durationMs ?? 0, completedAt: success.completedAt });
          original!.receiptId = key;
        }
        results.push(original!);
        if (original!.exitCode !== 0) return { ok: false, results, failed: original };
      } finally { slot?.(); release?.(); }
    }
    return { ok: true, results };
  } finally {
    await input.mirror.removeWorktree(target);
    rmSync(target, { recursive: true, force: true });
  }
};
