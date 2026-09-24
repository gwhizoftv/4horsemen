import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { parseCodexLimits, readCodexQuota } from "../src/codexQuota.js";
import { codexClearsBlockers, codexIsExhausted } from "../src/resourceEvidence.js";

describe("parseCodexLimits", () => {
  it("keeps multiple buckets and treats zero credits with ordinary usage as clear", () => {
    const snapshot = parseCodexLimits(
      { accountId: "acct-1" },
      {
        accountId: "acct-1",
        ordinaryUsageAllowed: true,
        rateLimitsByLimitId: {
          five: {
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1_700_000_000 },
            secondary: { usedPercent: 5, windowDurationMins: 10_080, resetsAt: 1_700_100_000 },
            rateLimitReachedType: null,
            spendControlReached: false,
            credits: { hasCredits: false, availableCount: 0 }
          }
        }
      }
    );
    expect(snapshot.accountId).toBe("acct-1");
    expect(snapshot.windows.length).toBe(2);
    expect(codexIsExhausted(snapshot)).toBe(false);
  });

  it("refuses clearance when a prior blocker is missing from a later snapshot", () => {
    const previous = [{ limitId: "weekly", window: "primary" as const }];
    const snapshot = parseCodexLimits(
      { accountId: "acct-1" },
      {
        ordinaryUsageAllowed: true,
        rateLimitsByLimitId: {
          five: {
            primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null },
            spendControlReached: false
          }
        }
      }
    );
    expect(codexClearsBlockers(previous, snapshot)).toBe(false);
  });

  it("treats ordinaryUsageAllowed null as not clear", () => {
    const snapshot = parseCodexLimits({ accountId: "a" }, { ordinaryUsageAllowed: null, rateLimitsByLimitId: {} });
    expect(codexIsExhausted(snapshot)).toBe(false);
    expect(codexClearsBlockers([], snapshot)).toBe(false);
  });
});

const fakeSpawn = (accountId: string) => {
  const methods: string[] = [];
  return Object.assign(
    () => {
      const child = new EventEmitter() as EventEmitter & {
        stdin: EventEmitter & { write: (s: string) => void; end: () => void };
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: (signal?: string) => boolean;
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
      };
      child.exitCode = null;
      child.signalCode = null;
      const stdin = new EventEmitter() as EventEmitter & { write: (s: string) => void; end: () => void };
      const stdout = new EventEmitter();
      const stderr = new EventEmitter();
      stdin.write = (line: string) => {
        const msg = JSON.parse(line) as { id?: number; method?: string };
        if (msg.method !== undefined) methods.push(msg.method);
        if (msg.id === undefined) return;
        const result =
          msg.method === "account/read" || msg.method === "account/rateLimits/read"
            ? { accountId, ordinaryUsageAllowed: true, rateLimitsByLimitId: {} }
            : {};
        queueMicrotask(() => {
          stdout.emit("data", Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`));
        });
      };
      stdin.end = () => {
        queueMicrotask(() => {
          child.exitCode = 0;
          child.emit("close", 0);
        });
      };
      child.stdin = stdin;
      child.stdout = stdout;
      child.stderr = stderr;
      child.kill = () => {
        child.exitCode = child.exitCode ?? 0;
        child.emit("close", child.exitCode);
        return true;
      };
      return child;
    },
    { methods }
  );
};

describe("readCodexQuota", () => {
  it("issues only allowlisted RPCs and matches identity", async () => {
    const spawned = fakeSpawn("acct-1");
    const result = await readCodexQuota(
      { codexHome: "/tmp/codex-home", accountId: "acct-1" },
      { spawn: spawned as unknown as typeof import("node:child_process").spawn }
    );
    expect(result.ok).toBe(true);
    expect(result.reaped).toBe(true);
    expect(spawned.methods).toEqual(["initialize", "initialized", "account/read", "account/rateLimits/read"]);
  });

  it("reports identity-gap when accountId mismatches", async () => {
    const spawned = fakeSpawn("other");
    const result = await readCodexQuota(
      { codexHome: "/tmp/codex-home", accountId: "acct-1" },
      { spawn: spawned as unknown as typeof import("node:child_process").spawn }
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.identityGap).toBe(true);
  });
});
