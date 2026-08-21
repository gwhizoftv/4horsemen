import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claudeProjectSlug, parseTranscriptText, readTranscript } from "../src/transcriptRead.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (name: string): string =>
  readFileSync(join(process.cwd(), "test/support/fixtures", name), "utf8");

describe("transcriptRead", () => {
  it("attributes claude usage and tools by parentUuid → user promptId", () => {
    const result = parseTranscriptText("claude", fixture("transcript-claude.jsonl"));
    expect(result.coverage).toBe("complete");
    const attributed = result.values.filter((row) => row.turnId === "prompt-turn-1");
    expect(attributed).toHaveLength(2);
    expect(attributed.reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0)).toBe(13);
    expect(attributed.reduce((sum, row) => sum + row.toolCalls, 0)).toBe(3);
    const orphan = result.values.find((row) => row.recordId === "broken-asst");
    expect(orphan?.turnId).toBeNull();
  });

  it("attributes codex tokens by turn_id and tools by item_completed, not custom_tool_call", () => {
    const result = parseTranscriptText("codex", fixture("transcript-codex.jsonl"));
    expect(result.coverage).toBe("complete");
    const turn1 = result.values.filter((row) => row.turnId === "codex-turn-1");
    const turn2 = result.values.filter((row) => row.turnId === "codex-turn-2");
    expect(turn1.reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0)).toBe(100);
    expect(turn2.reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0)).toBe(50);
    // Deltas sum to 150, not cumulative total_token_usage 150 on the second event alone mistotalled.
    const tokenInputs = result.values
      .filter((row) => row.tokens !== null)
      .reduce((sum, row) => sum + (row.tokens?.input ?? 0), 0);
    expect(tokenInputs).toBe(150);
    expect(turn1.reduce((sum, row) => sum + row.toolCalls, 0)).toBe(1);
    expect(turn2.reduce((sum, row) => sum + row.toolCalls, 0)).toBe(1);
    expect(result.values.some((row) => row.recordId === "ctc-1")).toBe(false);
  });

  it("returns unavailable for missing stores and does not throw", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-transcript-"));
    roots.push(root);
    const missing = readTranscript({ vendor: "claude", sessionId: "nope", root });
    expect(missing.coverage).toBe("unavailable");
    expect(missing.values).toEqual([]);
    expect(readTranscript({ vendor: "cursor", sessionId: "x" }).coverage).toBe("unavailable");
  });

  it("locates claude transcripts via project slug from clone path", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-claude-store-"));
    roots.push(root);
    const clonePath = "/Volumes/demo/coordination-claude";
    const dir = join(root, "projects", claudeProjectSlug(clonePath));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sess-1.jsonl"), fixture("transcript-claude.jsonl"));
    const result = readTranscript({ vendor: "claude", sessionId: "sess-1", root, clonePath });
    expect(result.coverage).toBe("complete");
    expect(result.values.length).toBeGreaterThan(0);
  });

  it("locates codex transcripts by session id under dated sessions/", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-codex-store-"));
    roots.push(root);
    const dir = join(root, "sessions", "2026", "08", "20");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "rollout-2026-08-20T18-00-00-codex-session-1.jsonl"), fixture("transcript-codex.jsonl"));
    const result = readTranscript({ vendor: "codex", sessionId: "codex-session-1", root });
    expect(result.coverage).toBe("complete");
    expect(result.values.some((row) => row.tokens !== null)).toBe(true);
  });

  it("marks malformed interior lines partial rather than complete", () => {
    const result = parseTranscriptText("claude", `${fixture("transcript-claude.jsonl")}\n{not-json\n`);
    expect(result.coverage).toBe("partial");
  });
});
