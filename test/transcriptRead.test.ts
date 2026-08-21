import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readTranscript, type TranscriptVendor } from "../src/transcriptRead.js";

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), "support", "fixtures");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const transcriptPath = (root: string, vendor: TranscriptVendor, sessionId: string): string =>
  vendor === "claude"
    ? join(root, "projects", "fixture", `${sessionId}.jsonl`)
    : join(root, "sessions", "2026", "08", "21", `rollout-fixture-${sessionId}.jsonl`);

const installFixture = (vendor: TranscriptVendor, sessionId: string): { root: string; path: string } => {
  const root = mkdtempSync(join(tmpdir(), `coord-${vendor}-transcript-`));
  roots.push(root);
  const path = transcriptPath(root, vendor, sessionId);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(join(fixtureRoot, `transcript-${vendor}.jsonl`), path);
  return { root, path };
};

describe("vendor transcript reader", () => {
  it("attributes Claude usage and tool blocks through the parent chain and de-duplicates message usage", () => {
    const { root } = installFixture("claude", "session-claude");
    const result = readTranscript({ vendor: "claude", sessionId: "session-claude", root });

    expect(result.coverage).toBe("complete");
    expect(result.turns).toEqual([
      {
        turnId: "turn-claude-1",
        tokens: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, reasoning: 2 },
        toolCalls: 1,
        tokenRecords: 1,
        toolRecords: 1
      }
    ]);
    expect(result.unattributed).toHaveLength(2);
    expect(result.unattributed.reduce((total, row) => total + row.toolCalls, 0)).toBe(1);
    expect(result.unattributed.reduce((total, row) => total + row.tokens.input, 0)).toBe(13);
  });

  it("reads live Codex token_count rows without turn_id or ordinal and classifies live item variants", () => {
    const { root } = installFixture("codex", "session-codex");
    const result = readTranscript({ vendor: "codex", sessionId: "session-codex", root });

    expect(result).toMatchObject({ coverage: "complete", tokenCoverage: "complete", toolCoverage: "complete" });
    expect(result.turns).toEqual([
      {
        turnId: "turn-codex-1",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
        toolCalls: 1,
        tokenRecords: 0,
        toolRecords: 1
      },
      {
        turnId: "turn-codex-2",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
        toolCalls: 1,
        tokenRecords: 0,
        toolRecords: 1
      }
    ]);
    expect(result.unattributed).toHaveLength(2);
    expect(result.unattributed.every((row) => row.windowAttribution === "exact")).toBe(true);
    expect(result.unattributed.reduce((total, row) => total + row.tokens.input, 0)).toBe(30);
    expect(result.unattributed.reduce((total, row) => total + row.tokens.output, 0)).toBe(28);
  });

  it("leaves custom_tool_call-only tools unattributed rather than guessing a turn", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-codex-transcript-"));
    roots.push(root);
    const path = transcriptPath(root, "codex", "custom-only");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        timestamp: "2026-08-21T00:00:02.000Z",
        ordinal: 1,
        type: "response_item",
        payload: { type: "custom_tool_call", id: "custom-1", name: "fixture", input: "{}" }
      })}\n`
    );

    const result = readTranscript({ vendor: "codex", sessionId: "custom-only", root });
    expect(result.turns).toEqual([]);
    expect(result.unattributed).toMatchObject([{ recordId: "custom-tool:custom-1", toolCalls: 1 }]);
  });

  it("distinguishes a supported zero tool count from a missing store", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-codex-transcript-"));
    roots.push(root);
    const path = transcriptPath(root, "codex", "usage-only");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        timestamp: "2026-08-21T00:00:02.000Z",
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0
            }
          }
        }
      })}\n`
    );
    expect(readTranscript({ vendor: "codex", sessionId: "usage-only", root })).toMatchObject({
      coverage: "complete",
      tokenCoverage: "complete",
      toolCoverage: "complete",
      turns: [],
      unattributed: [{ tokenRecords: 1, toolRecords: 0, windowAttribution: "exact" }]
    });
    expect(readTranscript({ vendor: "codex", sessionId: "missing", root })).toMatchObject({
      coverage: "unavailable",
      turns: []
    });

    chmodSync(path, 0o000);
    expect(readTranscript({ vendor: "codex", sessionId: "usage-only", root })).toMatchObject({
      coverage: "unavailable",
      turns: []
    });
  });

  it("marks final truncation and malformed interior records partial", () => {
    const partial = installFixture("codex", "partial");
    writeFileSync(partial.path, '{"timestamp":"2026-08-21T00:00:00.000Z"}');
    expect(readTranscript({ vendor: "codex", sessionId: "partial", root: partial.root }).coverage).toBe("partial");

    const malformed = installFixture("codex", "malformed");
    writeFileSync(malformed.path, "not-json\n{}\n");
    expect(readTranscript({ vendor: "codex", sessionId: "malformed", root: malformed.root }).coverage).toBe(
      "partial"
    );
  });

  it("keeps valid token rows when another token or tool row is unsupported", () => {
    const { root, path } = installFixture("codex", "mixed");
    const valid = readFileSync(path, "utf8");
    writeFileSync(
      path,
      `${valid}${JSON.stringify({
        timestamp: "2026-08-21T00:01:45.000Z",
        type: "event_msg",
        payload: { type: "token_count", info: {} }
      })}\n${JSON.stringify({
        timestamp: "2026-08-21T00:01:46.000Z",
        type: "event_msg",
        payload: {
          type: "item_completed",
          turn_id: "turn-codex-1",
          item: { type: "FutureControl", id: "future-1" }
        }
      })}\n`
    );

    const result = readTranscript({ vendor: "codex", sessionId: "mixed", root });
    expect(result).toMatchObject({ tokenCoverage: "partial", toolCoverage: "partial" });
    expect(result.unattributed.reduce((total, row) => total + row.tokens.input, 0)).toBe(30);
    expect(result.turns.reduce((total, row) => total + row.toolCalls, 0)).toBe(2);
  });
});
