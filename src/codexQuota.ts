import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { closeSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import type { ResourceBindingPaths } from "./paths.js";
import { CodexLimitsFormatError, parseCodexRateLimits, type CodexLimits } from "./resourceEvidence.js";
import { acquireExclusiveLock, atomicWriteJson } from "./state.js";

/**
 * One-shot, read-only Codex App Server quota read (#140). The helper lives at
 * most `timeoutMs` from spawn through reap, may emit at most `maxBytes` on
 * stdout+stderr combined, and is only ever asked for `initialize`,
 * `account/read` and `account/rateLimits/read` — no login, turn,
 * subscription, usage query, or reset-credit redemption.
 */
export const CODEX_QUOTA_TIMEOUT_MS = 10_000;
export const CODEX_QUOTA_MAX_BYTES = 256 * 1024;
/** Part of the total lifetime reserved for SIGTERM→SIGKILL→close. */
const SHUTDOWN_RESERVE_MS = 2_000;

/** What the initialized helper reported about itself; null when it did not say. */
export type CodexHelperIdentity = { userAgent: string | null; codexHome: string | null };

export type CodexQuotaResult =
  /** Fresh limits from an initialized helper that was proved reaped, bracketed by identical account reads. */
  | { status: "ok"; limits: CodexLimits; helper: CodexHelperIdentity; reaped: true }
  /** The bound home has no ChatGPT account the limits can be attributed to. */
  | { status: "identity"; error: string; reaped: boolean }
  | { status: "failed"; error: string; reaped: boolean };

export type CodexQuotaReader = (input: { codexHome: string }) => Promise<CodexQuotaResult>;

export type CodexQuotaOptions = {
  codexHome: string;
  command?: string;
  timeoutMs?: number;
  maxBytes?: number;
};

type Message = { id?: unknown; method?: unknown; result?: unknown; error?: unknown };

export const readCodexQuota = (options: CodexQuotaOptions): Promise<CodexQuotaResult> =>
  new Promise((resolvePromise) => {
    const timeoutMs = options.timeoutMs ?? CODEX_QUOTA_TIMEOUT_MS;
    const maxBytes = options.maxBytes ?? CODEX_QUOTA_MAX_BYTES;
    const startedAt = Date.now();
    const child = spawn(options.command ?? "codex", ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: options.codexHome },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let closed = false;
    let settled = false;
    let bytes = 0;
    let buffer = "";
    let helper: CodexHelperIdentity = { userAgent: null, codexHome: null };
    let account: unknown;
    let limits: unknown;
    let outcome: { status: "ok"; limits: CodexLimits } | { status: "identity" | "failed"; error: string } | null = null;
    const timers: NodeJS.Timeout[] = [];

    const settle = (): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.stdin.removeAllListeners();
      child.removeAllListeners();
      const final = outcome ?? { status: "failed" as const, error: "helper ended without a result" };
      resolvePromise(final.status === "ok" && closed
        ? { status: "ok", limits: final.limits, helper, reaped: true }
        : { status: final.status === "ok" ? "failed" : final.status,
          error: final.status === "ok" ? "helper was not proved reaped" : final.error, reaped: closed });
    };

    const remaining = (): number => Math.max(0, timeoutMs - (Date.now() - startedAt));

    // Every exit path ends here: close stdin, terminate, escalate, await close.
    const finish = (result: NonNullable<typeof outcome>): void => {
      if (outcome !== null) return;
      outcome = result;
      child.stdin.end();
      if (closed || child.pid === undefined) {
        closed = true;
        settle();
        return;
      }
      child.kill("SIGTERM");
      timers.push(setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, Math.min(1_000, remaining())));
      timers.push(setTimeout(settle, remaining()));
    };

    const send = (message: Record<string, unknown>): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    const accountOf = (value: unknown): { type?: unknown } | null | undefined =>
      (value as { account?: { type?: unknown } } | null)?.account;
    // The account is read before and after the limits: a change in between invalidates the snapshot.
    const complete = (after: unknown): void => {
      const before = accountOf(account);
      if (before === null || before === undefined || before.type !== "chatgpt") {
        finish({ status: "identity", error: "the bound CODEX_HOME has no ChatGPT account" });
        return;
      }
      if (JSON.stringify(accountOf(after)) !== JSON.stringify(before)) {
        finish({ status: "identity", error: "the account changed during the quota read" });
        return;
      }
      if (helper.codexHome !== null && resolve(helper.codexHome) !== resolve(options.codexHome)) {
        finish({ status: "identity", error: "the helper answered for a different CODEX_HOME" });
        return;
      }
      try {
        finish({ status: "ok", limits: parseCodexRateLimits(limits) });
      } catch (error) {
        finish({ status: "failed", error: error instanceof CodexLimitsFormatError ? `malformed limits: ${error.message}` : String(error) });
      }
    };

    const handle = (message: Message): void => {
      if (message.method !== undefined) {
        // Helper-initiated requests (credentials, approvals) are refused; notifications are ignored.
        if (message.id !== undefined) finish({ status: "failed", error: `helper requested ${String(message.method)}` });
        return;
      }
      if (message.error !== undefined && message.error !== null) {
        finish({ status: "failed", error: `request ${String(message.id)} failed` });
        return;
      }
      if (message.id === 1) {
        const init = (message.result ?? {}) as { userAgent?: unknown; codexHome?: unknown };
        helper = {
          userAgent: typeof init.userAgent === "string" ? init.userAgent : null,
          codexHome: typeof init.codexHome === "string" ? init.codexHome : null
        };
        send({ method: "initialized" });
        send({ id: 2, method: "account/read", params: { refreshToken: false } });
      } else if (message.id === 2) {
        account = message.result ?? null;
        send({ id: 3, method: "account/rateLimits/read" });
      } else if (message.id === 3) {
        limits = message.result ?? null;
        send({ id: 4, method: "account/read", params: { refreshToken: false } });
      } else if (message.id === 4) {
        complete(message.result ?? null);
      }
    };

    const count = (chunk: Buffer): boolean => {
      bytes += chunk.length;
      if (bytes <= maxBytes) return true;
      finish({ status: "failed", error: "helper output exceeded the byte cap" });
      return false;
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (outcome !== null || !count(chunk)) return;
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0 && outcome === null) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") {
          let message: unknown;
          try {
            message = JSON.parse(line);
          } catch {
            finish({ status: "failed", error: "helper wrote a malformed frame" });
            return;
          }
          if (message === null || typeof message !== "object" || Array.isArray(message)) {
            finish({ status: "failed", error: "helper wrote a non-object frame" });
            return;
          }
          handle(message as Message);
        }
        newline = buffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (outcome === null) count(chunk);
    });
    child.stdin.on("error", () => finish({ status: "failed", error: "helper closed its input" }));
    child.on("error", (error) => {
      if (child.pid === undefined) closed = true;
      finish({ status: "failed", error: `helper failed to start: ${error.message}` });
    });
    child.on("close", (code) => {
      closed = true;
      if (outcome === null) finish({ status: "failed", error: `helper exited (${code ?? "signal"}) before answering` });
      else settle();
    });
    timers.push(setTimeout(() => finish({ status: "failed", error: "helper timed out" }), Math.max(0, timeoutMs - SHUTDOWN_RESERVE_MS)));
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "coord", title: null, version: "1" }, capabilities: null } });
  });

// ---- per-binding exclusion ----------------------------------------------------

/** At most one helper start per home/account binding in this window, across issues. */
export const BINDING_SPACING_MS = 5 * 60_000;

export type BindingReservation = { reservation: string; issue: number; agent: string; startedAt: string };
export type BindingRecord = { version: 1; inFlight: BindingReservation | null; lastStartAt: string | null };

/** Null means unreadable: nobody can prove the binding idle, so nobody starts a helper. */
export const readBindingRecord = (paths: ResourceBindingPaths): BindingRecord | null => {
  if (!existsSync(paths.record)) return { version: 1, inFlight: null, lastStartAt: null };
  try {
    const value = JSON.parse(readFileSync(paths.record, "utf8")) as BindingRecord;
    if (value.version !== 1 || typeof value !== "object" || value === null) return null;
    return { version: 1, inFlight: value.inFlight ?? null, lastStartAt: value.lastStartAt ?? null };
  } catch {
    return null;
  }
};

const withBindingLock = <T>(coordRoot: string, paths: ResourceBindingPaths, effect: () => T): T => {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const handle = acquireExclusiveLock(paths.lock);
  try {
    return effect();
  } finally {
    closeSync(handle);
    if (existsSync(paths.lock)) unlinkSync(paths.lock);
  }
};

export type BindingReserveResult =
  | { status: "reserved" }
  | { status: "busy"; retryAt: string }
  | { status: "unknown" };

/**
 * Serialize one helper start for the binding. `persist` records the caller's
 * own durable reservation under this exclusion before the binding marker is
 * written; the marker then stays until the helper is proved reaped.
 */
export const reserveBinding = (
  coordRoot: string,
  paths: ResourceBindingPaths,
  reservation: BindingReservation,
  persist: () => void
): BindingReserveResult =>
  withBindingLock(coordRoot, paths, () => {
    const record = readBindingRecord(paths);
    if (record === null) return { status: "unknown" };
    const now = Date.parse(reservation.startedAt);
    if (record.inFlight !== null) return { status: "busy", retryAt: new Date(now + BINDING_SPACING_MS).toISOString() };
    if (record.lastStartAt !== null && now - Date.parse(record.lastStartAt) < BINDING_SPACING_MS) {
      return { status: "busy", retryAt: new Date(Date.parse(record.lastStartAt) + BINDING_SPACING_MS).toISOString() };
    }
    persist();
    atomicWriteJson(coordRoot, paths.record, { version: 1, inFlight: reservation, lastStartAt: reservation.startedAt });
    return { status: "reserved" };
  });

/** Clear the marker only for a helper that was proved reaped. */
export const finishBinding = (coordRoot: string, paths: ResourceBindingPaths, reservation: string): void => {
  withBindingLock(coordRoot, paths, () => {
    const record = readBindingRecord(paths);
    if (record?.inFlight?.reservation !== reservation) return;
    atomicWriteJson(coordRoot, paths.record, { ...record, inFlight: null });
  });
};
