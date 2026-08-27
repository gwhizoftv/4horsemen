import type { JournalEvent } from "./state.js";
import {
  type AnalyticsCoverage,
  type TokenUsage,
  type TranscriptReadResult,
  type TranscriptUsage,
  type UnattributedTranscriptUsage,
  type UsageVendor
} from "./transcriptRead.js";

type JsonObject = Record<string, unknown>;

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

const string = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const intField = (value: JsonObject, ...names: readonly string[]): number | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return undefined;
};

const emptyTokens = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: null });

const addTokens = (left: TokenUsage, right: TokenUsage): TokenUsage => ({
  input: left.input + right.input,
  output: left.output + right.output,
  cacheRead: left.cacheRead + right.cacheRead,
  cacheWrite: left.cacheWrite + right.cacheWrite,
  reasoning:
    left.reasoning === null && right.reasoning === null ? null : (left.reasoning ?? 0) + (right.reasoning ?? 0)
});

const reasoningFromObject = (value: JsonObject): number | null => {
  const direct = intField(value, "reasoning_tokens", "reasoning_output_tokens", "thinking_tokens");
  if (direct !== undefined) return direct;
  const details = object(value.output_tokens_details) ?? object(value.outputTokensDetails);
  if (details === null) return null;
  return intField(details, "thinking_tokens", "reasoning_tokens") ?? null;
};

/** Read the canonical TokenUsage shape persisted by normalizeCursorUsageEvent. */
const normalizedTokenUsage = (value: JsonObject): TokenUsage | null => {
  const input = intField(value, "input");
  const output = intField(value, "output");
  const cacheRead = intField(value, "cacheRead");
  const cacheWrite = intField(value, "cacheWrite");
  const reasoning = value.reasoning === null ? null : intField(value, "reasoning");
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    (value.reasoning !== null && reasoning === undefined)
  ) {
    return null;
  }
  return { input, output, cacheRead, cacheWrite, reasoning: reasoning ?? null };
};

/** Parse Cursor hook stdin for per-turn token fields (aliases across CLI versions). */
export const extractCursorTokenUsage = (raw: JsonObject): TokenUsage | null => {
  const read = (value: JsonObject): TokenUsage | null => {
    const input = intField(value, "input_tokens", "inputTokens", "prompt_tokens", "promptTokens");
    const output = intField(value, "output_tokens", "outputTokens", "completion_tokens", "completionTokens");
    const cacheRead = intField(
      value,
      "cache_read_tokens",
      "cacheReadTokens",
      "cached_input_tokens",
      "cache_read_input_tokens"
    );
    const cacheWrite = intField(
      value,
      "cache_write_tokens",
      "cacheWriteTokens",
      "cache_creation_input_tokens",
      "cache_write_input_tokens"
    );
    if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
      return null;
    }
    return {
      input: input ?? 0,
      output: output ?? 0,
      cacheRead: cacheRead ?? 0,
      cacheWrite: cacheWrite ?? 0,
      reasoning: reasoningFromObject(value)
    };
  };

  const direct = read(raw);
  if (direct !== null) return direct;
  for (const key of ["usage", "token_usage", "tokenUsage", "metrics", "last_token_usage", "total_token_usage"]) {
    const nested = object(raw[key]);
    if (nested === null) continue;
    const parsed = read(nested);
    if (parsed !== null) return parsed;
  }
  return null;
};

export type CursorUsageJournalDetails = {
  vendor: "cursor";
  event: string;
  kind: "turn-usage" | "tool-used" | "tool-failed";
  sessionId: string;
  turnId: string;
  tokens?: TokenUsage;
  toolCalls?: number;
};

export const cursorUsageFromJournalDetails = (details: unknown): CursorUsageJournalDetails | null => {
  const record = object(details);
  if (record === null || record.vendor !== "cursor") return null;
  const kind = record.kind;
  if (kind !== "turn-usage" && kind !== "tool-used" && kind !== "tool-failed") return null;
  const sessionId = string(record.sessionId);
  const turnId = string(record.turnId);
  const event = string(record.event);
  if (sessionId === null || turnId === null || event === null) return null;
  const tokens = object(record.tokens);
  return {
    vendor: "cursor",
    event,
    kind,
    sessionId,
    turnId,
    ...(tokens === null ? {} : { tokens: normalizedTokenUsage(tokens) ?? extractCursorTokenUsage(tokens) ?? undefined }),
    ...(typeof record.toolCalls === "number" && Number.isInteger(record.toolCalls) && record.toolCalls >= 0
      ? { toolCalls: record.toolCalls }
      : {})
  };
};

/** Aggregate journaled Cursor hook usage for one conversation id. */
export const readCursorHookUsage = (
  journal: readonly JournalEvent[],
  sessionId: string
): TranscriptReadResult => {
  const unavailable = (reason: string): TranscriptReadResult => ({
    vendor: "cursor" satisfies UsageVendor,
    sessionId,
    path: null,
    coverage: "unavailable",
    reason,
    tokenCoverage: "unavailable",
    tokenReason: reason,
    toolCoverage: "unavailable",
    toolReason: reason,
    turns: [],
    unattributed: []
  });

  const records = journal
    .filter((event) => event.type === "agent-usage" && event.agent === "cursor")
    .map((event) => cursorUsageFromJournalDetails(event.details))
    .filter((record): record is CursorUsageJournalDetails => record !== null && record.sessionId === sessionId);

  if (records.length === 0) {
    return unavailable("no journaled Cursor hook usage for this session");
  }

  const turnMap = new Map<string, TranscriptUsage>();
  const tokenLatest = new Map<string, { sequence: number; tokens: TokenUsage }>();
  let toolRecords = 0;
  let tokenRecords = 0;

  for (const [sequence, event] of journal
    .map((entry, index) => [index, entry] as const)
    .filter(([, entry]) => entry.type === "agent-usage" && entry.agent === "cursor")) {
    const record = cursorUsageFromJournalDetails(event.details);
    if (record === null || record.sessionId !== sessionId) continue;
    const turn =
      turnMap.get(record.turnId) ??
      ({
        turnId: record.turnId,
        tokens: emptyTokens(),
        toolCalls: 0,
        tokenRecords: 0,
        toolRecords: 0
      } satisfies TranscriptUsage);
    if (record.kind === "tool-used") {
      turn.toolCalls += record.toolCalls ?? 1;
      turn.toolRecords += 1;
      toolRecords += 1;
    } else if (record.kind === "tool-failed") {
      turn.toolRecords += 1;
      toolRecords += 1;
    } else if (record.kind === "turn-usage" && record.tokens !== undefined) {
      tokenLatest.set(record.turnId, { sequence, tokens: record.tokens });
    }
    turnMap.set(record.turnId, turn);
  }

  for (const [turnId, latest] of tokenLatest) {
    const turn =
      turnMap.get(turnId) ??
      ({
        turnId,
        tokens: emptyTokens(),
        toolCalls: 0,
        tokenRecords: 0,
        toolRecords: 0
      } satisfies TranscriptUsage);
    turn.tokens = latest.tokens;
    turn.tokenRecords = 1;
    tokenRecords += 1;
    turnMap.set(turnId, turn);
  }

  const turns = [...turnMap.values()].sort((left, right) => left.turnId.localeCompare(right.turnId));
  const tokenCoverage: AnalyticsCoverage =
    tokenRecords === 0 ? "unavailable" : turns.every((turn) => turn.tokenRecords > 0) ? "complete" : "partial";
  const toolCoverage: AnalyticsCoverage = "complete";
  const coverage: AnalyticsCoverage =
    tokenCoverage === "unavailable"
      ? toolRecords > 0
        ? "partial"
        : "unavailable"
      : tokenCoverage === "partial"
        ? "partial"
        : "complete";

  return {
    vendor: "cursor",
    sessionId,
    path: "journal:agent-usage",
    coverage,
    reason: null,
    tokenCoverage,
    tokenReason:
      tokenRecords === 0 ? "Cursor hooks did not journal token fields for this session" : null,
    toolCoverage,
    toolReason: null,
    turns,
    unattributed: [] as UnattributedTranscriptUsage[]
  };
};

export const mergeCursorUsageTurns = (turns: readonly TranscriptUsage[]): TokenUsage =>
  turns.reduce((total, turn) => addTokens(total, turn.tokens), emptyTokens());
