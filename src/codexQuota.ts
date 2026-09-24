import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  CODEX_HELPER_MAX_BYTES,
  CODEX_HELPER_TIMEOUT_MS,
  type CodexLimitsSnapshot,
  type CodexWindowSnapshot
} from "./resourceEvidence.js";

export type CodexQuotaBinding = {
  codexHome: string;
  accountId: string;
};

export type CodexQuotaReadResult =
  | { ok: true; snapshot: CodexLimitsSnapshot; reaped: true }
  | { ok: false; error: string; reaped: boolean; identityGap?: boolean };

export type CodexQuotaDeps = {
  spawn?: typeof spawn;
  now?: () => number;
  command?: string;
};

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const parseWindow = (
  limitId: string,
  side: "primary" | "secondary",
  raw: unknown,
  parent: Record<string, unknown>
): CodexWindowSnapshot | null => {
  const win = object(raw);
  if (win === null) return null;
  return {
    limitId,
    window: side,
    usedPercent: finiteNumber(win.usedPercent),
    windowDurationMins: finiteNumber(win.windowDurationMins),
    resetsAt: finiteNumber(win.resetsAt),
    rateLimitReachedType: stringOrNull(parent.rateLimitReachedType ?? win.rateLimitReachedType),
    spendControlReached:
      typeof parent.spendControlReached === "boolean"
        ? parent.spendControlReached
        : typeof win.spendControlReached === "boolean"
          ? win.spendControlReached
          : null
  };
};

/** Parse App Server rate-limit payloads; missing fields become null and never clear. */
export const parseCodexLimits = (account: unknown, rateLimits: unknown): CodexLimitsSnapshot => {
  const accountObj = object(account);
  const limitsObj = object(rateLimits);
  const accountId =
    stringOrNull(accountObj?.accountId) ??
    stringOrNull(object(accountObj?.account)?.["accountId" as string]) ??
    stringOrNull(limitsObj?.accountId);

  const ordinaryUsageAllowed =
    typeof limitsObj?.ordinaryUsageAllowed === "boolean" ? limitsObj.ordinaryUsageAllowed : null;

  const windows: CodexWindowSnapshot[] = [];
  const byId = object(limitsObj?.rateLimitsByLimitId) ?? {};
  const seen = new Set<string>();

  for (const [limitId, rawBucket] of Object.entries(byId)) {
    const bucket = object(rawBucket);
    if (bucket === null) continue;
    for (const side of ["primary", "secondary"] as const) {
      const parsed = parseWindow(limitId, side, bucket[side], bucket);
      if (parsed !== null) {
        windows.push(parsed);
        seen.add(`${limitId}:${side}`);
      }
    }
  }

  const compat = Array.isArray(limitsObj?.rateLimits) ? limitsObj.rateLimits : [];
  for (const raw of compat) {
    const bucket = object(raw);
    if (bucket === null) continue;
    const limitId = stringOrNull(bucket.limitId);
    if (limitId === null) continue;
    for (const side of ["primary", "secondary"] as const) {
      const key = `${limitId}:${side}`;
      if (seen.has(key)) continue;
      const parsed = parseWindow(limitId, side, bucket[side] ?? bucket, bucket);
      if (parsed !== null) {
        windows.push(parsed);
        seen.add(key);
      }
    }
  }

  return { accountId, ordinaryUsageAllowed, windows };
};

const terminate = async (child: ChildProcessWithoutNullStreams, budgetMs: number): Promise<boolean> => {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    child.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + Math.max(50, Math.floor(budgetMs / 2));
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  const killDeadline = Date.now() + Math.max(50, Math.floor(budgetMs / 2));
  while (Date.now() < killDeadline) {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return child.exitCode !== null || child.signalCode !== null;
};

/**
 * One-shot `codex app-server --listen stdio://` read of account + rate limits.
 * Never issues turns, login, subscriptions, usage, or reset-credit calls.
 */
export const readCodexQuota = async (
  binding: CodexQuotaBinding,
  deps: CodexQuotaDeps = {}
): Promise<CodexQuotaReadResult> => {
  const spawnFn = deps.spawn ?? spawn;
  const command = deps.command ?? "codex";
  const started = deps.now?.() ?? Date.now();
  const child = spawnFn(command, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, CODEX_HOME: binding.codexHome },
    stdio: ["pipe", "pipe", "pipe"]
  }) as ChildProcessWithoutNullStreams;

  let combined = Buffer.alloc(0);
  let overflow = false;
  const append = (chunk: Buffer) => {
    if (overflow) return;
    if (combined.length + chunk.length > CODEX_HELPER_MAX_BYTES) {
      overflow = true;
      combined = Buffer.concat([combined, chunk.subarray(0, Math.max(0, CODEX_HELPER_MAX_BYTES - combined.length))]);
      return;
    }
    combined = Buffer.concat([combined, chunk]);
  };
  child.stdout.on("data", (chunk: Buffer | string) => {
    append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    append(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });

  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let buffer = "";

  const onLine = (line: string) => {
    if (line.trim() === "") return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    if (msg.id === undefined || msg.id === null) return;
    const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
    const waiter = pending.get(id);
    if (waiter === undefined) return;
    pending.delete(id);
    if (msg.error !== undefined) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  };

  child.stdout.on("data", (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      onLine(line);
    }
  });

  const write = (payload: unknown) => {
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  };

  const request = (method: string, params?: unknown): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolveReq, rejectReq) => {
      pending.set(id, { resolve: resolveReq, reject: rejectReq });
      write({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  };

  const remaining = () => Math.max(0, CODEX_HELPER_TIMEOUT_MS - ((deps.now?.() ?? Date.now()) - started));

  let reaped = false;
  try {
    const timeout = setTimeout(() => {
      void terminate(child, remaining());
    }, CODEX_HELPER_TIMEOUT_MS);

    try {
      await request("initialize", { clientInfo: { name: "coord", version: "0.0.0" } });
      write({ jsonrpc: "2.0", method: "initialized", params: {} });
      const account = await request("account/read", { refreshToken: false });
      const rateLimits = await request("account/rateLimits/read", {});
      if (overflow) {
        reaped = await terminate(child, remaining());
        return { ok: false, error: "output-cap", reaped };
      }
      const snapshot = parseCodexLimits(account, rateLimits);
      if (snapshot.accountId === null || snapshot.accountId !== binding.accountId) {
        reaped = await terminate(child, remaining());
        return { ok: false, error: "identity-gap", reaped, identityGap: true };
      }
      child.stdin.end();
      reaped = await terminate(child, remaining());
      return { ok: true, snapshot, reaped: true };
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    reaped = await terminate(child, remaining());
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      reaped
    };
  } finally {
    for (const waiter of pending.values()) waiter.reject(new Error("helper-closed"));
    pending.clear();
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    child.stdin.removeAllListeners();
  }
};

export type CodexLimitsReader = (binding: CodexQuotaBinding) => Promise<CodexQuotaReadResult>;
