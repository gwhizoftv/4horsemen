import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { epochTimestamp, unknownEvidence, type ResourceEvidence, type ResourceWindow } from "./resourceEvidence.js";

export type CodexBinding = { codexHome: string; accountId: string };
export type CodexQuotaResult = {
  outcome: "clear" | "exhausted" | "owner" | "failed";
  evidence: ResourceEvidence;
  windows: ResourceWindow[];
  /** Only a validated version/auth/resource combination may authorize release. */
  recoveryProven: boolean;
  reaped: boolean;
};
export type CodexQuotaReader = (binding: CodexBinding) => Promise<CodexQuotaResult>;
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const parseCodexQuota = (raw: unknown, account: unknown, after: unknown, expected: string): CodexQuotaResult => {
  const evidence = unknownEvidence("codex");
  const result: CodexQuotaResult = { outcome: "owner", evidence, windows: [], recoveryProven: false, reaped: true };
  const limits = object(raw);
  const beforeAccount = object(object(account)?.account);
  const afterAccount = object(object(after)?.account);
  // Never derive identity from email, auth files, or a coordinator default.
  if (limits?.accountId !== expected || beforeAccount?.type !== "chatgpt" || afterAccount?.type !== "chatgpt" ||
      JSON.stringify(beforeAccount) !== JSON.stringify(afterAccount)) {
    evidence.failureClass = "auth-account";
    return result;
  }
  const buckets = object(limits.rateLimitsByLimitId);
  if (buckets === null || Object.keys(buckets).length === 0 || Object.keys(buckets).length > 8) return result;
  const compatibility = object(limits.rateLimits);
  if (compatibility === null || typeof compatibility.limitId !== "string" ||
      JSON.stringify(buckets[compatibility.limitId]) !== JSON.stringify(compatibility)) return result;
  let incomplete = false;
  let unknownType = false;
  let spend = false;
  for (const [id, value] of Object.entries(buckets)) {
    const bucket = object(value);
    if (!bucket || bucket.limitId !== id || !/^[A-Za-z0-9._-]{1,128}$/.test(id)) return result;
    if (!Object.hasOwn(bucket, "rateLimitReachedType") || !Object.hasOwn(bucket, "spendControlReached")) incomplete = true;
    // Unknown enum values never become a universal renewable-limit trigger.
    if (bucket.rateLimitReachedType !== null) unknownType = true;
    if (bucket.spendControlReached === true) spend = true;
    else if (bucket.spendControlReached !== false) incomplete = true;
    for (const name of ["primary", "secondary"]) {
      const window = object(bucket[name]);
      if (window === null) { incomplete = true; continue; }
      if (typeof window.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0 ||
          typeof window.windowDurationMins !== "number" || !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0) {
        incomplete = true; continue;
      }
      result.windows.push({ bucket: id, window: name, usedPercent: window.usedPercent,
        windowDurationMins: window.windowDurationMins, resetsAt: epochTimestamp(window.resetsAt) });
    }
  }
  evidence.confidence = "probed";
  if (spend) { evidence.failureClass = "billing"; return result; }
  const blocked = result.windows.filter((window) => window.usedPercent >= 100);
  if (unknownType || incomplete || typeof limits.ordinaryUsageAllowed !== "boolean") return result;
  if (blocked.length > 0) {
    evidence.failureClass = "usage-window";
    evidence.windows = blocked;
    result.outcome = "exhausted";
    if (blocked.every((window) => window.resetsAt !== null)) {
      evidence.resetsAt = blocked.map((window) => window.resetsAt!).sort().at(-1)!;
      evidence.deadlineConfidence = "exact";
    }
  } else if (limits.ordinaryUsageAllowed === true) result.outcome = "clear";
  return result;
};

/** Completeness is checked against the previous blockers, not just the returned subset. */
export const clearsCodexResource = (result: CodexQuotaResult, evidence: ResourceEvidence): boolean =>
  result.reaped && result.recoveryProven && result.outcome === "clear" && evidence.failureClass === "usage-window" &&
  evidence.windows.length > 0 && evidence.windows.every((old) => result.windows.some((next) =>
    next.bucket === old.bucket && next.window === old.window && next.windowDurationMins === old.windowDurationMins &&
    next.usedPercent < 100));

/** No live recovery combination has been validated; query results initially enrich owner holds only. */
export const readCodexQuota = (
  binding: CodexBinding,
  options: { command?: string; timeoutMs?: number; maxBytes?: number } = {}
): Promise<CodexQuotaResult> => new Promise((resolveResult) => {
  const failure = (): CodexQuotaResult => ({ outcome: "failed", evidence: unknownEvidence("codex"), windows: [], recoveryProven: false, reaped: true });
  const budget = Math.min(options.timeoutMs ?? 10_000, 10_000);
  const maxBytes = Math.min(options.maxBytes ?? 262_144, 262_144);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(options.command ?? "codex", ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: binding.codexHome }, stdio: ["pipe", "pipe", "pipe"]
    });
  } catch { resolveResult(failure()); return; }
  let result = failure();
  let finishing = false;
  let settled = false;
  let bytes = 0;
  let buffer = "";
  let expected = 0;
  let account: unknown;
  let limits: unknown;
  const decoder = new StringDecoder("utf8");
  const finish = () => {
    if (finishing) return;
    finishing = true;
    child.stdin?.end();
    child.kill("SIGTERM");
  };
  const settle = (reaped: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(stopTimer); clearTimeout(killTimer); clearTimeout(endTimer);
    resolveResult({ ...result, reaped });
  };
  // Reserve shutdown time inside the total lifetime, not after it.
  const stopTimer = setTimeout(finish, Math.max(1, budget - 500));
  const killTimer = setTimeout(() => { finish(); child.kill("SIGKILL"); }, Math.max(2, budget - 250));
  const endTimer = setTimeout(() => { child.kill("SIGKILL"); settle(false); }, budget);
  const request = (id: number, method: string, params: unknown = {}) => {
    expected = id;
    child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
  };
  const count = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > maxBytes) { result = failure(); finish(); return false; }
    return true;
  };
  child.stdin?.on("error", () => { result = failure(); finish(); });
  child.stderr?.on("data", (chunk: Buffer) => { count(chunk); });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (!count(chunk) || finishing) return;
    buffer += decoder.write(chunk);
    while (buffer.includes("\n") && !finishing) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      try {
        const message = object(JSON.parse(line));
        if (message === null) throw new Error("Invalid frame");
        if (Object.hasOwn(message, "method")) {
          if (Object.hasOwn(message, "id")) throw new Error("Helper requested credentials or work");
          continue;
        }
        if (message.id !== expected || message.error !== undefined || !Object.hasOwn(message, "result")) throw new Error("Invalid response");
        if (expected === 0) {
          child.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          request(1, "account/read", { refreshToken: false });
        } else if (expected === 1) { account = message.result; request(2, "account/rateLimits/read"); }
        else if (expected === 2) { limits = message.result; request(3, "account/read", { refreshToken: false }); }
        else { result = parseCodexQuota(limits, account, message.result, binding.accountId); finish(); }
      } catch { result = failure(); finish(); }
    }
  });
  child.once("error", () => { result = failure(); finish(); });
  child.once("close", (code) => {
    if (!finishing || (code !== null && code !== 0)) result = failure();
    settle(true);
  });
  request(0, "initialize", { clientInfo: { name: "coord", version: "1" }, capabilities: {} });
});
