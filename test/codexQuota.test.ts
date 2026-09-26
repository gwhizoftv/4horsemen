import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BINDING_SPACING_MS, finishBinding, readBindingRecord, readCodexQuota, reserveBinding } from "../src/codexQuota.js";
import { resourceBindingPaths } from "../src/paths.js";
import { assessCodexLimits, codexClearsBlockers, codexHelperVersion, parseCodexRateLimits } from "../src/resourceEvidence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const now = "2026-09-22T12:00:00.000Z";
const epoch = (hours: number): number => Date.parse(now) / 1000 + hours * 3600;
const window = (usedPercent: number, hours: number | null, windowDurationMins = 300) =>
  ({ usedPercent, windowDurationMins, resetsAt: hours === null ? null : epoch(hours) });
const bucket = (limitId: string | null, primary: unknown, secondary: unknown = null, extra: Record<string, unknown> = {}) => ({
  limitId, limitName: null, normalModelSlug: null, primary, secondary, credits: { hasCredits: false, unlimited: false, balance: "0" },
  individualLimit: null, spendControlReached: false, planType: "plus", rateLimitReachedType: null, ...extra
});
/** Sanitized `GetAccountRateLimitsResponse` shape (codex-cli app-server generate-ts). */
const response = (buckets: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ordinaryUsageAllowed: true, rateLimits: Object.values(buckets)[0], rateLimitsByLimitId: buckets,
  rateLimitResetCredits: null, accountId: "acct-1", rateLimitUpsell: null, ...extra
});

// A stand-in App Server: logs each request method, answers per mode.json in CODEX_HOME.
const FAKE_SERVER = `#!/usr/bin/env node
const fs = require("fs"), path = require("path");
const home = process.env.CODEX_HOME;
const mode = JSON.parse(fs.readFileSync(path.join(home, "mode.json"), "utf8"));
fs.writeFileSync(path.join(home, "pid"), String(process.pid));
if (mode.ignoreTerm) { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }
let queue = Promise.resolve();
const out = (message) => {
  const text = JSON.stringify(message) + "\\n";
  if (!mode.fragment) return process.stdout.write(text);
  // Split and coalesce frames across writes, in order.
  queue = queue.then(async () => {
    for (const part of [text.slice(0, 7), text.slice(7, 20), text.slice(20)]) {
      process.stdout.write(part);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  });
};
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const message = JSON.parse(line);
    fs.appendFileSync(path.join(home, "requests.log"), message.method + "\\n");
    if (mode.hang) continue;
    if (message.method === "initialize") {
      if (mode.exit) process.exit(3);
      if (mode.flood) process.stdout.write("x".repeat(300000));
      out({ id: message.id, result: { userAgent: "codex_cli_rs/0.156.1 (fake)", codexHome: mode.helperHome ?? home, platformFamily: "unix", platformOs: "macos" } });
      out({ method: "thread/started", params: {} });
      if (mode.serverRequest) out({ id: 99, method: "account/chatgptAuthTokens/refresh", params: {} });
    }
    if (message.method === "account/read") {
      const after = message.id === 4 && mode.accountAfter !== undefined;
      const account = after ? mode.accountAfter : mode.account === undefined ? { type: "chatgpt", email: null, planType: "plus" } : mode.account;
      out({ id: message.id, result: { account, requiresOpenaiAuth: true } });
    }
    if (message.method === "account/rateLimits/read") out({ id: message.id, result: mode.limits });
  }
});
process.stdin.on("end", () => { if (!mode.ignoreTerm) process.exit(0); });
`;

const fakeServer = (mode: Record<string, unknown>) => {
  const root = mkdtempSync(join(tmpdir(), "coord-codex-quota-"));
  roots.push(root);
  const command = join(root, "codex.cjs");
  writeFileSync(command, FAKE_SERVER);
  chmodSync(command, 0o700);
  writeFileSync(join(root, "mode.json"), JSON.stringify(mode));
  const alive = (): boolean => {
    const pid = Number(readFileSync(join(root, "pid"), "utf8"));
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const requests = (): string[] => existsSync(join(root, "requests.log"))
    ? readFileSync(join(root, "requests.log"), "utf8").trim().split("\n") : [];
  return { codexHome: root, command, alive, requests };
};

const limits = response({ codex: bucket("codex", window(40, 2), window(100, 50, 10_080), { rateLimitReachedType: "rate_limit_reached" }) });

describe("Codex App Server quota reads", () => {
  it("issues only the read-only allowlist over fragmented frames and reaps the helper", async () => {
    const server = fakeServer({ limits, fragment: true });
    const result = await readCodexQuota({ codexHome: server.codexHome, command: server.command });
    expect(result).toMatchObject({ status: "ok", reaped: true, limits: { accountId: "acct-1", ordinaryUsageAllowed: true },
      helper: { userAgent: "codex_cli_rs/0.156.1 (fake)", codexHome: server.codexHome } });
    // Identity is read on both sides of the limits snapshot.
    expect(server.requests()).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read", "account/read"]);
    expect(server.alive()).toBe(false);
  });

  it.each([
    ["a helper-initiated credential request", { limits, serverRequest: true }, /helper requested/],
    ["an early non-zero exit", { limits, exit: true }, /exited/],
    ["output past the byte cap", { limits, flood: true }, /byte cap/],
    ["malformed limits", { limits: { rateLimits: bucket("codex", { usedPercent: "high" }) } }, /malformed limits/]
  ])("fails closed on %s and still reaps", async (_label, mode, error) => {
    const server = fakeServer(mode);
    const result = await readCodexQuota({ codexHome: server.codexHome, command: server.command });
    expect(result).toMatchObject({ status: "failed", reaped: true });
    expect(result.status === "failed" && result.error).toMatch(error);
    expect(server.alive()).toBe(false);
  });

  it("kills a helper that ignores termination inside its total lifetime", async () => {
    const server = fakeServer({ limits, hang: true, ignoreTerm: true });
    const started = Date.now();
    const result = await readCodexQuota({ codexHome: server.codexHome, command: server.command, timeoutMs: 3_000 });
    expect(Date.now() - started).toBeLessThan(3_500);
    expect(result).toMatchObject({ status: "failed", error: "helper timed out", reaped: true });
    expect(server.alive()).toBe(false);
  });

  it.each([
    ["an API-key account", { account: { type: "apiKey" } }, /no ChatGPT account/],
    ["no account", { account: null }, /no ChatGPT account/],
    ["an account change during the read", { accountAfter: { type: "chatgpt", email: null, planType: "pro" } }, /changed during/],
    ["a helper answering for another home", { helperHome: "/elsewhere/.codex" }, /different CODEX_HOME/]
  ])("reports %s as an identity failure instead of inferring one", async (_label, mode, error) => {
    const server = fakeServer({ limits, ...mode });
    const result = await readCodexQuota({ codexHome: server.codexHome, command: server.command });
    expect(result).toMatchObject({ status: "identity", reaped: true });
    expect(result.status === "identity" && result.error).toMatch(error);
  });

  it("serializes one helper per binding across callers and spaces starts", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-binding-"));
    roots.push(root);
    const paths = resourceBindingPaths(root, "/owner/.codex", "acct-1");
    const reservation = (id: string, at: number) =>
      ({ reservation: id, issue: id === "10000000-0000-4000-8000-000000000001" ? 1 : 2, agent: "codex", startedAt: new Date(at).toISOString() });
    const first = "10000000-0000-4000-8000-000000000001";
    const second = "10000000-0000-4000-8000-000000000002";
    const t0 = Date.parse(now);
    let persisted = 0;
    expect(reserveBinding(root, paths, reservation(first, t0), () => persisted++)).toEqual({ status: "reserved" });
    // Another issue sharing the binding cannot start while the first helper is unreaped.
    expect(reserveBinding(root, paths, reservation(second, t0 + BINDING_SPACING_MS * 3), () => persisted++).status).toBe("busy");
    finishBinding(root, paths, second); // not the holder: no effect
    expect(readBindingRecord(paths)?.inFlight?.reservation).toBe(first);
    finishBinding(root, paths, first);
    expect(reserveBinding(root, paths, reservation(second, t0 + 60_000), () => persisted++))
      .toEqual({ status: "busy", retryAt: new Date(t0 + BINDING_SPACING_MS).toISOString() });
    expect(reserveBinding(root, paths, reservation(second, t0 + BINDING_SPACING_MS), () => persisted++)).toEqual({ status: "reserved" });
    expect(persisted).toBe(2);
    writeFileSync(paths.record, "not json");
    expect(reserveBinding(root, paths, reservation(first, t0 + BINDING_SPACING_MS * 9), () => persisted++)).toEqual({ status: "unknown" });
  });

  it("reports a helper that cannot start as reaped", async () => {
    const result = await readCodexQuota({ codexHome: tmpdir(), command: join(tmpdir(), "coord-no-such-codex") });
    expect(result).toMatchObject({ status: "failed", reaped: true });
  });
});

describe("Codex rate-limit evidence", () => {
  it("keeps every bucket and window, deduplicates the compatibility view, and fails closed on conflicts", () => {
    const parsed = parseCodexRateLimits(response({
      codex: bucket("codex", window(40, 2), window(100, 50, 10_080)),
      "opaque-b": bucket("opaque-b", window(10, 3))
    }));
    expect(parsed.buckets.map((entry) => [entry.limitId, entry.windows.map((item) => item.window)])).toEqual([
      ["codex", ["primary", "secondary"]], ["opaque-b", ["primary"]]
    ]);
    expect(() => parseCodexRateLimits(response({ codex: bucket("codex", window(40, 2)) },
      { rateLimits: bucket("codex", window(41, 2)) }))).toThrow(/conflicts/);
    expect(() => parseCodexRateLimits({ rateLimits: null, rateLimitsByLimitId: null })).toThrow(/no rate limit buckets/);
  });

  it("assesses exhaustion only from affirmative blockers and keeps billing distinct", () => {
    // Zero credits with ordinary usage allowed is not a hold.
    expect(assessCodexLimits(parseCodexRateLimits(response({ codex: bucket("codex", window(20, 2)) })), now)).toEqual({ status: "clear" });
    const renewable = assessCodexLimits(parseCodexRateLimits(limits), now);
    expect(renewable).toMatchObject({ status: "exhausted", classification: { failureClass: "usage-window",
      resetsAt: new Date(epoch(50) * 1000).toISOString() } });
    // The five-hour window below its limit is not a blocker; the weekly one governs the recheck.
    expect(renewable.status === "exhausted" && renewable.classification.windows.map((item) => item.window)).toEqual(["secondary"]);
    expect(assessCodexLimits(parseCodexRateLimits(response({ codex: bucket("codex", window(100, null)) })), now))
      .toMatchObject({ classification: { failureClass: "usage-window", resetsAt: null } });
    expect(assessCodexLimits(parseCodexRateLimits(response({ codex: bucket("codex", window(10, 2), null,
      { rateLimitReachedType: "workspace_member_credits_depleted" }) })), now))
      .toMatchObject({ classification: { failureClass: "billing", resetsAt: null } });
    expect(assessCodexLimits(parseCodexRateLimits(response({ codex: bucket("codex", window(10, 2), null,
      { rateLimitReachedType: "some_future_type" }) })), now))
      .toMatchObject({ classification: { failureClass: "unknown", resetsAt: null } });
  });

  it("clears only with backend permission and every prior blocked window present below its limit", () => {
    const blocked = assessCodexLimits(parseCodexRateLimits(limits), now);
    const prior = blocked.status === "exhausted" ? blocked.classification.windows : [];
    const recovered = response({ codex: bucket("codex", window(5, 4), window(30, 200, 10_080)) });
    expect(codexClearsBlockers(parseCodexRateLimits(recovered), prior, now)).toBe(true);
    expect(codexClearsBlockers(parseCodexRateLimits({ ...recovered, ordinaryUsageAllowed: null }), prior, now)).toBe(false);
    // The previously blocked weekly window is missing: absence is not clearance.
    expect(codexClearsBlockers(parseCodexRateLimits(response({ codex: bucket("codex", window(5, 4)) })), prior, now)).toBe(false);
    expect(codexClearsBlockers(parseCodexRateLimits(response({ other: bucket("other", window(5, 4), window(5, 9)) })), prior, now)).toBe(false);
    expect(codexClearsBlockers(parseCodexRateLimits(recovered), [], now)).toBe(false);
    // Missing, null or malformed restriction fields and a changed window are not clearance.
    const variant = (extra: Record<string, unknown>, omit?: string) => {
      const entry: Record<string, unknown> = { ...bucket("codex", window(5, 4), window(30, 200, 10_080)), ...extra };
      if (omit !== undefined) delete entry[omit];
      return parseCodexRateLimits(response({ codex: entry }));
    };
    expect(codexClearsBlockers(variant({}, "spendControlReached"), prior, now)).toBe(false);
    expect(codexClearsBlockers(variant({ spendControlReached: null }), prior, now)).toBe(false);
    expect(codexClearsBlockers(variant({ spendControlReached: "no" }), prior, now)).toBe(false);
    expect(codexClearsBlockers(variant({}, "rateLimitReachedType"), prior, now)).toBe(false);
    expect(codexClearsBlockers(variant({ secondary: window(30, 200, 43_200) }), prior, now)).toBe(false);
    expect(codexHelperVersion("codex_cli_rs/0.156.1 (Mac OS 26.4.0; arm64)")).toBe("0.156.1");
    expect(codexHelperVersion("codex_cli_rs/0.156.1.2")).toBeNull();
    expect(codexHelperVersion(null)).toBeNull();
  });
});
