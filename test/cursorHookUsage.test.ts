import { describe, expect, it } from "vitest";
import { normalizeCursorUsageEvent } from "../src/agentEvent.js";
import {
  cursorUsageFromJournalDetails,
  extractCursorTokenUsage,
  readCursorHookUsage
} from "../src/cursorHookUsage.js";
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

  it("round-trips normalized hook tokens and reports missing Cursor counters as unavailable", () => {
    const normalized = normalizeCursorUsageEvent("cursor", {
      hook_event_name: "afterAgentResponse",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      inputTokens: 40,
      outputTokens: 8,
      cacheReadTokens: 12,
      cacheWriteTokens: 0
    });
    expect(cursorUsageFromJournalDetails(normalized)).toMatchObject({
      tokens: { input: 40, output: 8, cacheRead: 12, cacheWrite: 0, reasoning: null }
    });

    const toolsOnly = [
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 0,
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
      })
    ];
    expect(readCursorHookUsage(toolsOnly, "conversation-1")).toMatchObject({
      tokenCoverage: "unavailable",
      tokenReason: "Cursor hooks did not journal token fields for this session",
      turns: [{ tokenRecords: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }]
    });
  });
});
