import { describe, expect, it } from "vitest";
import { normalizeCursorUsageEvent } from "../src/agentEvent.js";
import { extractCursorTokenUsage, readCursorHookUsage } from "../src/cursorHookUsage.js";
import { journalEventSchema } from "../src/state.js";

describe("cursor hook usage", () => {
  it("parses token aliases from Cursor hook stdin", () => {
    expect(
      extractCursorTokenUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_tokens: 3,
        cache_write_tokens: 1,
        reasoning_tokens: 2
      })
    ).toEqual({
      input: 10,
      output: 5,
      cacheRead: 3,
      cacheWrite: 1,
      reasoning: 2
    });
    expect(
      extractCursorTokenUsage({
        usage: {
          input_tokens: 7,
          output_tokens: 4,
          cache_read_input_tokens: 9,
          cache_creation_input_tokens: 2
        }
      })
    ).toEqual({
      input: 7,
      output: 4,
      cacheRead: 9,
      cacheWrite: 2,
      reasoning: null
    });
  });

  it("reads back the tokens the hook path actually journals", () => {
    // The write side normalizes before journaling, so a reader that only knows
    // the vendor aliases silently drops every count. Going through
    // `normalizeCursorUsageEvent` — rather than hand-writing the journal row —
    // is what makes that round trip a test at all.
    const usage = normalizeCursorUsageEvent(
      "cursor",
      {
        conversation_id: "conversation-round-trip",
        generation_id: "generation-1",
        inputTokens: 40,
        outputTokens: 8,
        cacheReadTokens: 12,
        cacheWriteTokens: 0
      },
      "afterAgentResponse"
    );
    expect(usage).not.toBeNull();

    const journal = [
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 0,
        at: "2026-08-21T00:00:00.000Z",
        type: "agent-usage",
        agent: "cursor",
        details: usage as Record<string, unknown>
      })
    ];
    const result = readCursorHookUsage(journal, "conversation-round-trip");
    expect(result.tokenCoverage).toBe("complete");
    expect(result.turns).toEqual([
      {
        turnId: "generation-1",
        tokens: { input: 40, output: 8, cacheRead: 12, cacheWrite: 0, reasoning: null },
        toolCalls: 0,
        tokenRecords: 1,
        toolRecords: 0
      }
    ]);
  });

  it("reports unavailable, not zero, when hooks journal tools but no tokens", () => {
    const journal = [
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 0,
        at: "2026-08-21T00:00:00.000Z",
        type: "agent-usage",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "postToolUse",
          kind: "tool-used",
          sessionId: "conversation-tools-only",
          turnId: "generation-1",
          toolCalls: 1
        }
      })
    ];
    const result = readCursorHookUsage(journal, "conversation-tools-only");
    // Cursor can report tokens, so absence is missing data — not an
    // unsupported vendor, and never a measured zero.
    expect(result.tokenCoverage).toBe("unavailable");
    expect(result.tokenReason).toContain("did not journal token fields");
    expect(result.toolCoverage).toBe("complete");
    expect(result.turns).toEqual([
      {
        turnId: "generation-1",
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null },
        toolCalls: 1,
        tokenRecords: 0,
        toolRecords: 1
      }
    ]);
  });

  it("aggregates journaled tool and token records by generation id", () => {
    const journal = [
      {
        formatVersion: 3,
        sequence: 0,
        at: "2026-08-21T00:00:00.000Z",
        type: "agent-lifecycle",
        agent: "cursor",
        actionId: "11111111-1111-4111-8111-111111111111",
        details: {
          vendor: "cursor",
          event: "beforeSubmitPrompt",
          kind: "prompt-submitted",
          sessionId: "conversation-1",
          turnId: "generation-1"
        }
      },
      {
        formatVersion: 3,
        sequence: 1,
        at: "2026-08-21T00:00:01.000Z",
        type: "agent-usage",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "postToolUse",
          kind: "tool-used",
          sessionId: "conversation-1",
          turnId: "generation-1",
          toolCalls: 1
        }
      },
      {
        formatVersion: 3,
        sequence: 2,
        at: "2026-08-21T00:00:02.000Z",
        type: "agent-usage",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "afterAgentResponse",
          kind: "turn-usage",
          sessionId: "conversation-1",
          turnId: "generation-1",
          tokens: {
            input_tokens: 100,
            output_tokens: 20,
            cache_read_tokens: 50,
            cache_write_tokens: 0
          }
        }
      },
      {
        formatVersion: 3,
        sequence: 3,
        at: "2026-08-21T00:00:03.000Z",
        type: "agent-lifecycle",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "stop",
          kind: "stopped",
          sessionId: "conversation-1",
          turnId: "generation-1"
        }
      }
    ].map((event) => journalEventSchema.parse(event));

    const result = readCursorHookUsage(journal, "conversation-1");
    expect(result.vendor).toBe("cursor");
    expect(result.tokenCoverage).toBe("complete");
    expect(result.toolCoverage).toBe("complete");
    expect(result.turns).toEqual([
      {
        turnId: "generation-1",
        tokens: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, reasoning: null },
        toolCalls: 1,
        tokenRecords: 1,
        toolRecords: 1
      }
    ]);
  });
});
