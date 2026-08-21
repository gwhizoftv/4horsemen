import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  type Dirent
} from "node:fs";
import { basename, join, resolve } from "node:path";

export type TranscriptVendor = "claude" | "codex";
export type AnalyticsCoverage = "complete" | "partial" | "unsupported" | "unavailable";

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number | null;
};

export type TranscriptUsage = {
  turnId: string;
  tokens: TokenUsage;
  toolCalls: number;
  tokenRecords: number;
  toolRecords: number;
};

export type UnattributedTranscriptUsage = {
  recordId: string;
  at: string | null;
  tokens: TokenUsage;
  toolCalls: number;
  tokenRecords: number;
  toolRecords: number;
  windowAttribution: "exact" | "fallback";
};

export type TranscriptReadResult = {
  vendor: TranscriptVendor;
  sessionId: string;
  path: string | null;
  coverage: AnalyticsCoverage;
  reason: string | null;
  tokenCoverage: AnalyticsCoverage;
  tokenReason: string | null;
  toolCoverage: AnalyticsCoverage;
  toolReason: string | null;
  turns: TranscriptUsage[];
  unattributed: UnattributedTranscriptUsage[];
};

type JsonObject = Record<string, unknown>;
type UsageSample = {
  recordId: string;
  at: string | null;
  turnId: string | null;
  tokens: TokenUsage;
  toolCalls: number;
  tokenRecords: number;
  toolRecords: number;
  windowAttribution: "exact" | "fallback";
};

type ParsedSamples = {
  samples: UsageSample[];
  tokenRecords: number;
  validTokenRecords: number;
  tokenReasons: string[];
  toolReasons: string[];
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

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

const string = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);

const nonnegativeInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;

const optionalCounter = (value: unknown): { value: number; valid: boolean } => {
  if (value === undefined) return { value: 0, valid: true };
  const parsed = nonnegativeInteger(value);
  return parsed === null ? { value: 0, valid: false } : { value: parsed, valid: true };
};

const directoryEntries = (path: string): Dirent[] => {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES")) return [];
    throw error;
  }
};

const locateClaudeTranscript = (root: string, sessionId: string): string | null => {
  const projects = join(root, "projects");
  for (const project of directoryEntries(projects)) {
    if (!project.isDirectory() || project.isSymbolicLink()) continue;
    const candidate = join(projects, project.name, `${sessionId}.jsonl`);
    try {
      if (lstatSync(candidate).isFile()) return candidate;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES"))) throw error;
    }
  }
  return null;
};

const locateCodexTranscript = (root: string, sessionId: string): string | null => {
  const sessions = join(root, "sessions");
  for (const year of directoryEntries(sessions)) {
    if (!year.isDirectory() || year.isSymbolicLink()) continue;
    const yearPath = join(sessions, year.name);
    for (const month of directoryEntries(yearPath)) {
      if (!month.isDirectory() || month.isSymbolicLink()) continue;
      const monthPath = join(yearPath, month.name);
      for (const day of directoryEntries(monthPath)) {
        if (!day.isDirectory() || day.isSymbolicLink()) continue;
        const dayPath = join(monthPath, day.name);
        for (const entry of directoryEntries(dayPath)) {
          if (!entry.isFile() || !entry.name.endsWith(`-${sessionId}.jsonl`)) continue;
          return join(dayPath, entry.name);
        }
      }
    }
  }
  return null;
};

type BoundedJsonl = {
  records: JsonObject[];
  coverage: AnalyticsCoverage;
  reason: string | null;
};

/** Read no bytes appended after the initial stat, so an active transcript has a stable snapshot boundary. */
const readBoundedJsonl = (path: string): BoundedJsonl => {
  const handle = openSync(path, "r");
  let initialSize = 0;
  let finalSize = 0;
  let bytesRead = 0;
  let buffer = Buffer.alloc(0);
  try {
    initialSize = fstatSync(handle).size;
    buffer = Buffer.alloc(initialSize);
    while (bytesRead < initialSize) {
      const count = readSync(handle, buffer, bytesRead, initialSize - bytesRead, bytesRead);
      if (count === 0) break;
      bytesRead += count;
    }
    finalSize = fstatSync(handle).size;
  } finally {
    closeSync(handle);
  }

  const text = buffer.subarray(0, bytesRead).toString("utf8");
  const completeFinalLine = text === "" || text.endsWith("\n");
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: JsonObject[] = [];
  let malformedInterior = false;
  for (const [index, line] of lines.entries()) {
    if (line === "") continue;
    try {
      const parsed = object(JSON.parse(line) as unknown);
      if (parsed === null) malformedInterior = true;
      else records.push(parsed);
    } catch {
      const isFinalTruncatedLine = index === lines.length - 1 && !completeFinalLine;
      if (!isFinalTruncatedLine) malformedInterior = true;
    }
  }
  if (malformedInterior) {
    return { records, coverage: "partial", reason: "transcript contains a malformed interior record" };
  }
  if (!completeFinalLine || bytesRead < initialSize || finalSize > initialSize) {
    return { records, coverage: "partial", reason: "transcript was growing or ended with a truncated record" };
  }
  return { records, coverage: "complete", reason: null };
};

const claudeSamples = (records: readonly JsonObject[]): ParsedSamples => {
  const byUuid = new Map<string, JsonObject>();
  for (const record of records) {
    const uuid = string(record.uuid);
    if (uuid !== null) byUuid.set(uuid, record);
  }

  const promptFor = (record: JsonObject): string | null => {
    let parentId = string(record.parentUuid);
    const visited = new Set<string>();
    while (parentId !== null && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byUuid.get(parentId);
      if (parent === undefined) return null;
      if (parent.type === "user") return string(parent.promptId);
      parentId = string(parent.parentUuid);
    }
    return null;
  };

  const samples: UsageSample[] = [];
  const usageIds = new Set<string>();
  const toolIds = new Set<string>();
  let tokenRecords = 0;
  let validTokenRecords = 0;
  const tokenReasons = new Set<string>();
  const toolReasons = new Set<string>();
  for (const [recordIndex, record] of records.entries()) {
    if (record.type !== "assistant") continue;
    const message = object(record.message);
    if (message === null) continue;
    const turnId = promptFor(record);
    const at = string(record.timestamp);
    const messageId = string(message.id);
    const usage = object(message.usage);
    if (usage !== null) {
      if (messageId === null) tokenReasons.add("usage record has no stable message id");
      const recordId = messageId ?? `claude-usage-line-${recordIndex}`;
      if (!usageIds.has(recordId)) {
        usageIds.add(recordId);
        tokenRecords += 1;
        const input = nonnegativeInteger(usage.input_tokens);
        const output = nonnegativeInteger(usage.output_tokens);
        const cacheRead = nonnegativeInteger(usage.cache_read_input_tokens);
        const cacheWrite = nonnegativeInteger(usage.cache_creation_input_tokens);
        if (input === null || output === null || cacheRead === null || cacheWrite === null) {
          tokenReasons.add("usage record has invalid token counters");
        } else {
          const outputDetails = object(usage.output_tokens_details);
          const reasoning = outputDetails === null ? { value: 0, valid: true } : optionalCounter(outputDetails.thinking_tokens);
          if (!reasoning.valid) tokenReasons.add("usage record has an invalid reasoning-token counter");
          validTokenRecords += 1;
          samples.push({
            recordId: `usage:${recordId}`,
            at,
            turnId,
            tokens: {
              input,
              output,
              cacheRead,
              cacheWrite,
              reasoning: outputDetails === null || outputDetails.thinking_tokens === undefined ? null : reasoning.value
            },
            toolCalls: 0,
            tokenRecords: 1,
            toolRecords: 0,
            windowAttribution: "fallback"
          });
        }
      }
    }

    if (!Array.isArray(message.content)) continue;
    for (const [contentIndex, contentValue] of message.content.entries()) {
      const content = object(contentValue);
      if (content?.type !== "tool_use") continue;
      const vendorId = string(content.id);
      if (vendorId === null) toolReasons.add("tool record has no stable id");
      const recordId = vendorId ?? `claude-tool-line-${recordIndex}-${contentIndex}`;
      if (toolIds.has(recordId)) continue;
      toolIds.add(recordId);
      samples.push({
        recordId: `tool:${recordId}`,
        at,
        turnId,
        tokens: emptyTokens(),
        toolCalls: 1,
        tokenRecords: 0,
        toolRecords: 1,
        windowAttribution: "fallback"
      });
    }
  }
  return {
    samples,
    tokenRecords,
    validTokenRecords,
    tokenReasons: [...tokenReasons],
    toolReasons: [...toolReasons]
  };
};

const codexToolTypes = new Set([
  "CommandExecution",
  "FileChange",
  "McpToolCall",
  "WebSearch",
  "ImageGeneration",
  "DynamicToolCall",
  "CustomToolCall",
  "FunctionCall",
  "LocalShellCall",
  "Extension"
]);
const codexNonToolTypes = new Set([
  "Reasoning",
  "UserMessage",
  "AgentMessage",
  "ContextCompaction",
  "EnteredReviewMode",
  "ExitedReviewMode"
]);

const codexSamples = (records: readonly JsonObject[]): ParsedSamples => {
  const samples: UsageSample[] = [];
  const recordIds = new Set<string>();
  const fallbackCustomTools: UsageSample[] = [];
  let exactToolCount = 0;
  let tokenRecords = 0;
  let validTokenRecords = 0;
  const tokenReasons = new Set<string>();
  const toolReasons = new Set<string>();

  for (const [index, record] of records.entries()) {
    const payload = object(record.payload);
    if (payload === null) continue;
    const at = string(record.timestamp);
    const ordinal = nonnegativeInteger(record.ordinal);
    if (record.type === "event_msg" && payload.type === "token_count") {
      const vendorId = string(record.id) ?? string(payload.id) ?? (ordinal === null ? null : String(ordinal));
      const recordId = `token:${vendorId ?? `line-${index}`}`;
      if (recordIds.has(recordId)) continue;
      recordIds.add(recordId);
      tokenRecords += 1;
      const info = object(payload.info);
      const usage = info === null ? null : object(info.last_token_usage);
      if (usage === null) {
        tokenReasons.add("token_count record has no last_token_usage");
        continue;
      }
      const inputTotal = nonnegativeInteger(usage.input_tokens);
      const output = nonnegativeInteger(usage.output_tokens);
      const cacheRead = optionalCounter(usage.cached_input_tokens);
      const cacheWrite = optionalCounter(usage.cache_write_input_tokens);
      const reasoning = optionalCounter(usage.reasoning_output_tokens);
      if (
        inputTotal === null ||
        output === null ||
        !cacheRead.valid ||
        !cacheWrite.valid ||
        !reasoning.valid ||
        inputTotal < cacheRead.value + cacheWrite.value
      ) {
        tokenReasons.add("token_count record has invalid token counters");
        continue;
      }
      validTokenRecords += 1;
      samples.push({
        recordId,
        at,
        turnId: string(payload.turn_id) ?? string(record.turn_id),
        tokens: {
          input: inputTotal - cacheRead.value - cacheWrite.value,
          output,
          cacheRead: cacheRead.value,
          cacheWrite: cacheWrite.value,
          reasoning: usage.reasoning_output_tokens === undefined ? null : reasoning.value
        },
        toolCalls: 0,
        tokenRecords: 1,
        toolRecords: 0,
        windowAttribution: "exact"
      });
      continue;
    }

    if (record.type === "event_msg" && payload.type === "item_completed") {
      const item = object(payload.item);
      const itemType = item === null ? null : string(item.type);
      if (itemType === null) {
        toolReasons.add("item_completed record has no item type");
        continue;
      }
      if (codexNonToolTypes.has(itemType)) continue;
      if (!codexToolTypes.has(itemType)) {
        toolReasons.add(`unrecognized item_completed type ${itemType}`);
        continue;
      }
      const vendorId = item === null ? null : string(item.id);
      if (vendorId === null) toolReasons.add("tool item has no stable id");
      const recordId = `tool:${vendorId ?? ordinal ?? index}`;
      if (recordIds.has(recordId)) continue;
      recordIds.add(recordId);
      exactToolCount += 1;
      samples.push({
        recordId,
        at,
        turnId: string(payload.turn_id),
        tokens: emptyTokens(),
        toolCalls: 1,
        tokenRecords: 0,
        toolRecords: 1,
        windowAttribution: "fallback"
      });
      continue;
    }

    // This record proves a call happened but has no supported exact turn key.
    // Use it only when the session has no authoritative item_completed tools.
    if (record.type === "response_item" && payload.type === "custom_tool_call") {
      const vendorId = string(payload.id) ?? string(payload.call_id);
      if (vendorId === null) toolReasons.add("custom tool record has no stable id");
      fallbackCustomTools.push({
        recordId: `custom-tool:${vendorId ?? ordinal ?? index}`,
        at,
        turnId: null,
        tokens: emptyTokens(),
        toolCalls: 1,
        tokenRecords: 0,
        toolRecords: 1,
        windowAttribution: "fallback"
      });
    }
  }
  if (exactToolCount === 0) {
    for (const sample of fallbackCustomTools) {
      if (recordIds.has(sample.recordId)) continue;
      recordIds.add(sample.recordId);
      samples.push(sample);
    }
  }
  return {
    samples,
    tokenRecords,
    validTokenRecords,
    tokenReasons: [...tokenReasons],
    toolReasons: [...toolReasons]
  };
};

const aggregateSamples = (samples: readonly UsageSample[]): Pick<TranscriptReadResult, "turns" | "unattributed"> => {
  const turns = new Map<string, TranscriptUsage>();
  const unattributed: UnattributedTranscriptUsage[] = [];
  for (const sample of samples) {
    if (sample.turnId === null) {
      unattributed.push({
        recordId: sample.recordId,
        at: sample.at,
        tokens: sample.tokens,
        toolCalls: sample.toolCalls,
        tokenRecords: sample.tokenRecords,
        toolRecords: sample.toolRecords,
        windowAttribution: sample.windowAttribution
      });
      continue;
    }
    const current = turns.get(sample.turnId) ?? {
      turnId: sample.turnId,
      tokens: emptyTokens(),
      toolCalls: 0,
      tokenRecords: 0,
      toolRecords: 0
    };
    current.tokens = addTokens(current.tokens, sample.tokens);
    current.toolCalls += sample.toolCalls;
    current.tokenRecords += sample.tokenRecords;
    current.toolRecords += sample.toolRecords;
    turns.set(sample.turnId, current);
  }
  return {
    turns: [...turns.values()].sort((left, right) => left.turnId.localeCompare(right.turnId)),
    unattributed: unattributed.sort((left, right) => left.recordId.localeCompare(right.recordId))
  };
};

export type ReadTranscriptInput = {
  vendor: TranscriptVendor;
  sessionId: string;
  /** The vendor root (`~/.claude` or `~/.codex`), injected by tests. */
  root: string | null;
};

export const readTranscript = (input: ReadTranscriptInput): TranscriptReadResult => {
  const unavailable = (reason: string): TranscriptReadResult => ({
    vendor: input.vendor,
    sessionId: input.sessionId,
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
  if (input.root === null) return unavailable("vendor transcript root is unavailable");
  if (!/^[A-Za-z0-9._-]+$/.test(input.sessionId) || basename(input.sessionId) !== input.sessionId) {
    return unavailable("invalid session identifier");
  }

  let path: string | null;
  try {
    const root = resolve(input.root);
    path =
      input.vendor === "claude"
        ? locateClaudeTranscript(root, input.sessionId)
        : locateCodexTranscript(root, input.sessionId);
  } catch (error) {
    return unavailable(`cannot locate transcript: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (path === null) return unavailable("session transcript was not found or was unreadable");

  let bounded: BoundedJsonl;
  try {
    bounded = readBoundedJsonl(path);
  } catch (error) {
    return unavailable(`cannot read transcript: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = input.vendor === "claude" ? claudeSamples(bounded.records) : codexSamples(bounded.records);
  const aggregated = aggregateSamples(parsed.samples);
  const tokenCoverage: AnalyticsCoverage =
    bounded.coverage !== "complete"
      ? "partial"
      : parsed.tokenRecords === 0 || parsed.validTokenRecords === 0
      ? "unsupported"
      : parsed.tokenReasons.length > 0
        ? "partial"
        : "complete";
  const toolCoverage: AnalyticsCoverage =
    parsed.toolReasons.length > 0 || bounded.coverage !== "complete" ? "partial" : "complete";
  const tokenReason = [
    bounded.reason,
    parsed.tokenRecords === 0
      ? "transcript has no token metric records"
      : parsed.validTokenRecords === 0
        ? "transcript has no supported token metric records"
        : null,
    ...parsed.tokenReasons
  ]
    .filter((value): value is string => value !== null)
    .join("; ");
  const toolReason = [bounded.reason, ...parsed.toolReasons]
    .filter((value): value is string => value !== null)
    .join("; ");
  const coverage =
    tokenCoverage === "unsupported"
      ? "unsupported"
      : tokenCoverage === "partial" || toolCoverage === "partial"
        ? "partial"
        : "complete";
  const reason = [
    tokenReason === "" ? null : `tokens: ${tokenReason}`,
    toolReason === "" ? null : `tools: ${toolReason}`
  ]
    .filter((value): value is string => value !== null)
    .join("; ");
  return {
    vendor: input.vendor,
    sessionId: input.sessionId,
    path,
    coverage,
    reason: reason === "" ? null : reason,
    tokenCoverage,
    tokenReason: tokenReason === "" ? null : tokenReason,
    toolCoverage,
    toolReason: toolReason === "" ? null : toolReason,
    ...aggregated
  };
};
