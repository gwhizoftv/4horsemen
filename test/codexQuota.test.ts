import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearsCodexResource, parseCodexQuota, readCodexQuota } from "../src/codexQuota.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// Sanitized protocol candidates, not an attestation of live provider clearance.
const account = { account: { type: "chatgpt", email: "redacted", planType: "pro" } };
const snapshot = (used = 100) => ({ limitId: "codex", rateLimitReachedType: null, spendControlReached: false,
  credits: { hasCredits: false },
  primary: { usedPercent: used, windowDurationMins: 300, resetsAt: 2000000000 },
  secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2000500000 } });
const response = (used = 100) => ({ accountId: "account", ordinaryUsageAllowed: used < 100,
  rateLimits: snapshot(used), rateLimitsByLimitId: { codex: snapshot(used) } });

describe("bounded Codex quota evidence", () => {
  it("preserves windows, treats zero credits as non-blocking, and requires independently proven clearance", () => {
    const exhausted = parseCodexQuota(response(), account, account, "account");
    expect(exhausted.outcome).toBe("exhausted");
    expect(exhausted.evidence.resetsAt).toBe(new Date(2000000000000).toISOString());
    const clear = parseCodexQuota(response(20), account, account, "account");
    expect(clear.outcome).toBe("clear");
    expect(clear.windows).toHaveLength(2);
    expect(clearsCodexResource(clear, exhausted.evidence)).toBe(false);
    expect(clearsCodexResource({ ...clear, recoveryProven: true }, exhausted.evidence)).toBe(true);
    expect(clearsCodexResource({ ...clear, recoveryProven: true, windows: [] }, exhausted.evidence)).toBe(false);
  });

  it("fails closed on missing identity, partial windows, spend limits, unknown enums and conflicting views", () => {
    const variants: unknown[] = [
      { ...response(), accountId: null }, { ...response(), ordinaryUsageAllowed: null },
      { ...response(), rateLimits: snapshot(10) },
      ...[null, "futureLimit"].map((value) => {
        const bucket = { ...snapshot(), ...(value === null ? { secondary: null } : { rateLimitReachedType: value }) };
        return { ...response(), rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } };
      })
    ];
    for (const raw of variants) expect(parseCodexQuota(raw, account, account, "account").outcome).toBe("owner");
    const bucket = { ...snapshot(), spendControlReached: true };
    expect(parseCodexQuota({ ...response(), rateLimits: bucket, rateLimitsByLimitId: { codex: bucket } }, account, account, "account").evidence.failureClass).toBe("billing");
    expect(parseCodexQuota(response(), account, { account: { type: "apiKey" } }, "account").evidence.failureClass).toBe("auth-account");
  });

  it.each(["success", "hang", "flood", "nonzero", "credential", "bad-id"])("reaps a fake helper on %s and uses only allowlisted calls", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "coord-quota-")); roots.push(root);
    const command = join(root, "codex");
    const log = join(root, "calls.jsonl");
    const pidPath = join(root, "pid");
    writeFileSync(command, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
if (${JSON.stringify(mode)} === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }
require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line); fs.appendFileSync(${JSON.stringify(log)}, line + '\\n');
  if (${JSON.stringify(mode)} === 'hang' || m.id === undefined) return;
  if (${JSON.stringify(mode)} === 'flood') { process.stderr.write('x'.repeat(300000)); return; }
  if (${JSON.stringify(mode)} === 'nonzero') process.exit(2);
  if (${JSON.stringify(mode)} === 'credential') { console.log(JSON.stringify({ id: 10, method: 'account/chatgptAuthTokens/refresh' })); return; }
  const result = m.id === 0 ? {} : m.id === 2 ? ${JSON.stringify(response(20))} : ${JSON.stringify(account)};
  const out = JSON.stringify({ id: ${JSON.stringify(mode)} === 'bad-id' ? 99 : m.id, result }) + '\\n';
  process.stdout.write(out.slice(0, 5)); process.stdout.write(out.slice(5));
});
`);
    chmodSync(command, 0o755);
    const result = await readCodexQuota({ codexHome: root, accountId: "account" }, { command, timeoutMs: 1500 });
    expect(result.reaped).toBe(true);
    expect(result.outcome).toBe(mode === "success" ? "clear" : "failed");
    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string });
    if (mode === "success") expect(calls.map((call) => call.method)).toEqual([
      "initialize", "initialized", "account/read", "account/rateLimits/read", "account/read"
    ]);
    expect(calls.every((call) => ["initialize", "initialized", "account/read", "account/rateLimits/read"].includes(call.method))).toBe(true);
  });
});
