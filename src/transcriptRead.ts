import { existsSync, openSync, readSync, fstatSync, closeSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type TranscriptCoverage = "complete" | "partial" | "unsupported" | "unavailable";

export type TokenComponents = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
};

export type TranscriptTurnRow = {
  turnId: string | null;
  recordId: string;
  tokens: TokenComponents | null;
  toolCalls: number;
  timestamp?: string;
};

export type TranscriptReadResult = {
  values: TranscriptTurnRow[];
  coverage: TranscriptCoverage;
  reason: string | null;
};

export type TranscriptVendor = "claude" | "codex" | "cursor" | "antigravity";

export type TranscriptReadOptions = {
  vendor: TranscriptVendor;
  sessionId: string;
  /** Vendor store root; defaults to ~/.claude or ~/.codex. */
  root?: string;
  /** Absolute clone path; used to derive the Claude project slug. */
  clonePath?: string;
  /** Optional wall-clock hints to bound Codex dated session search. */
  searchAfter?: string;
  searchBefore?: string;
};

const emptyUnavailable = (reason: string): TranscriptReadResult => ({
  values: [],
  coverage: "unavailable",
  reason
});

/** Claude encodes the working directory as the projects/<slug> directory name. */
export const claudeProjectSlug = (clonePath: string): string =>
  clonePath.replaceAll("\\", "/").replaceAll("/", "-");

const readFilePrefix = (path: string, maxBytes: number): { text: string; truncated: boolean } | null => {
  try {
    const handle = openSync(path, "r");
    try {
      const size = fstatSync(handle).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      readSync(handle, buffer, 0, length, 0);
      return { text: buffer.toString("utf8"), truncated: size > maxBytes };
    } finally {
      closeSync(handle);
    }
  } catch {
    return null;
  }
};

const locateClaudeTranscript = (root: string, sessionId: string, clonePath: string | undefined): string | null => {
  const projects = join(root, "projects");
  if (!existsSync(projects)) return null;
  if (clonePath !== undefined) {
    const direct = join(projects, claudeProjectSlug(clonePath), `${sessionId}.jsonl`);
    if (existsSync(direct)) return direct;
  }
  try {
    for (const slug of readdirSync(projects)) {
      const candidate = join(projects, slug, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    return null;
  }
  return null;
};

const locateCodexTranscript = (
  root: string,
  sessionId: string,
  searchAfter?: string,
  searchBefore?: string
): string | null => {
  const sessions = join(root, "sessions");
  if (!existsSync(sessions)) return null;
  const after = searchAfter === undefined ? null : Date.parse(searchAfter);
  const before = searchBefore === undefined ? null : Date.parse(searchBefore);
  const matches: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(dir, name);
      if (!name.includes(".") && !name.endsWith(".jsonl")) {
        // Year / month / day directories are numeric.
        if (/^\d{4}$/.test(name) || /^\d{2}$/.test(name)) walk(path);
        continue;
      }
      if (!name.endsWith(".jsonl")) continue;
      if (!name.includes(sessionId)) continue;
      if (after !== null || before !== null) {
        const stamp = name.match(/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})/);
        if (stamp !== null) {
          const iso = stamp[1]!.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3Z");
          const ms = Date.parse(iso);
          if (!Number.isNaN(ms)) {
            if (after !== null && !Number.isNaN(after) && ms < after - 86_400_000) continue;
            if (before !== null && !Number.isNaN(before) && ms > before + 86_400_000) continue;
          }
        }
      }
      matches.push(path);
    }
  };
  walk(sessions);
  if (matches.length === 0) return null;
  matches.sort();
  return matches[matches.length - 1] ?? null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

const parseClaude = (text: string, truncated: boolean): TranscriptReadResult => {
  const byUuid = new Map<string, Record<string, unknown>>();
  const lines = text.split("\n").filter((line) => line !== "");
  let malformed = false;
  for (const line of lines) {
    try {
      const parsed = asRecord(JSON.parse(line));
      if (parsed === null) {
        malformed = true;
        continue;
      }
      const uuid = typeof parsed.uuid === "string" ? parsed.uuid : null;
      if (uuid !== null) byUuid.set(uuid, parsed);
    } catch {
      malformed = true;
    }
  }

  const promptIdFor = (record: Record<string, unknown>): string | null => {
    const direct = typeof record.promptId === "string" ? record.promptId : null;
    if (direct !== null) return direct;
    let parent = typeof record.parentUuid === "string" ? record.parentUuid : null;
    const seen = new Set<string>();
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      const parentRecord = byUuid.get(parent);
      if (parentRecord === undefined) return null;
      if (typeof parentRecord.promptId === "string") return parentRecord.promptId;
      if (parentRecord.type === "user" && typeof parentRecord.promptId === "string") return parentRecord.promptId;
      parent = typeof parentRecord.parentUuid === "string" ? parentRecord.parentUuid : null;
    }
    return null;
  };

  const values: TranscriptTurnRow[] = [];
  const seenIds = new Set<string>();
  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      const value = asRecord(JSON.parse(line));
      if (value === null) continue;
      parsed = value;
    } catch {
      continue;
    }
    const uuid = typeof parsed.uuid === "string" ? parsed.uuid : null;
    if (uuid === null || seenIds.has(uuid)) continue;
    seenIds.add(uuid);
    const message = asRecord(parsed.message) ?? parsed;
    const usage = asRecord(message.usage) ?? asRecord(parsed.usage);
    const content = Array.isArray(message.content) ? message.content : [];
    const toolCalls = content.filter((block) => asRecord(block)?.type === "tool_use").length;
    const hasTokens = usage !== null;
    if (!hasTokens && toolCalls === 0) continue;
    const turnId = promptIdFor(parsed);
    values.push({
      turnId,
      recordId: uuid,
      tokens:
        usage === null
          ? null
          : {
              input: num(usage.input_tokens),
              output: num(usage.output_tokens),
              cacheRead: num(usage.cache_read_input_tokens),
              cacheWrite: num(usage.cache_creation_input_tokens),
              ...(typeof asRecord(usage.output_tokens_details)?.thinking_tokens === "number"
                ? { reasoning: num(asRecord(usage.output_tokens_details)?.thinking_tokens) }
                : {})
            },
      toolCalls,
      ...(typeof parsed.timestamp === "string" ? { timestamp: parsed.timestamp } : {})
    });
  }

  const coverage: TranscriptCoverage = truncated || malformed ? "partial" : "complete";
  return {
    values,
    coverage,
    reason: truncated ? "transcript truncated at read bound" : malformed ? "malformed transcript line" : null
  };
};

const CODEX_NON_TOOL_ITEMS = new Set(["UserMessage", "AgentMessage", "Reasoning", "Message"]);

const parseCodex = (text: string, truncated: boolean): TranscriptReadResult => {
  const lines = text.split("\n").filter((line) => line !== "");
  const values: TranscriptTurnRow[] = [];
  const seenIds = new Set<string>();
  let malformed = false;
  let unsupported = false;

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      const value = asRecord(JSON.parse(line));
      if (value === null) {
        malformed = true;
        continue;
      }
      parsed = value;
    } catch {
      malformed = true;
      continue;
    }

    const payload = asRecord(parsed.payload) ?? parsed;
    const payloadType = typeof payload.type === "string" ? payload.type : null;
    const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : undefined;
    const ordinal = typeof parsed.ordinal === "number" ? String(parsed.ordinal) : null;

    if (payloadType === "token_count") {
      const info = asRecord(payload.info);
      const last = asRecord(info?.last_token_usage);
      if (last === null) {
        unsupported = true;
        continue;
      }
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      const recordId = `token:${ordinal ?? values.length}:${turnId ?? "none"}`;
      if (seenIds.has(recordId)) continue;
      seenIds.add(recordId);
      values.push({
        turnId,
        recordId,
        tokens: {
          input: num(last.input_tokens),
          output: num(last.output_tokens),
          cacheRead: num(last.cached_input_tokens),
          cacheWrite: num(last.cache_write_input_tokens),
          ...(typeof last.reasoning_output_tokens === "number"
            ? { reasoning: num(last.reasoning_output_tokens) }
            : {})
        },
        toolCalls: 0,
        ...(timestamp === undefined ? {} : { timestamp })
      });
      continue;
    }

    if (payloadType === "item_completed") {
      const turnId = typeof payload.turn_id === "string" ? payload.turn_id : null;
      const item = asRecord(payload.item);
      const itemType = typeof item?.type === "string" ? item.type : null;
      if (itemType === null || CODEX_NON_TOOL_ITEMS.has(itemType)) continue;
      const itemId = typeof item?.id === "string" ? item.id : `item:${ordinal ?? values.length}`;
      if (seenIds.has(itemId)) continue;
      seenIds.add(itemId);
      values.push({
        turnId,
        recordId: itemId,
        tokens: null,
        toolCalls: 1,
        ...(timestamp === undefined ? {} : { timestamp })
      });
      continue;
    }

    // custom_tool_call carries no turn_id — leave uncounted here per plan.
    if (payloadType === "custom_tool_call") continue;
  }

  const coverage: TranscriptCoverage = unsupported
    ? "unsupported"
    : truncated || malformed
      ? "partial"
      : "complete";
  return {
    values,
    coverage,
    reason: unsupported
      ? "unrecognized token_count shape"
      : truncated
        ? "transcript truncated at read bound"
        : malformed
          ? "malformed transcript line"
          : null
  };
};

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;

/**
 * Locate and parse a vendor transcript for one session.
 * Reads numeric usage and tool-invocation counts only — never message content.
 */
export const readTranscript = (options: TranscriptReadOptions): TranscriptReadResult => {
  const { vendor, sessionId } = options;
  if (vendor === "cursor" || vendor === "antigravity") {
    return emptyUnavailable(`vendor ${vendor} has no local usage store`);
  }

  const root =
    options.root ??
    (vendor === "claude" ? join(homedir(), ".claude") : join(homedir(), ".codex"));

  const path =
    vendor === "claude"
      ? locateClaudeTranscript(root, sessionId, options.clonePath)
      : locateCodexTranscript(root, sessionId, options.searchAfter, options.searchBefore);

  if (path === null) return emptyUnavailable(`no transcript for session ${sessionId}`);

  const prefix = readFilePrefix(path, MAX_TRANSCRIPT_BYTES);
  if (prefix === null) return emptyUnavailable(`cannot read transcript at ${path}`);

  return vendor === "claude"
    ? parseClaude(prefix.text, prefix.truncated)
    : parseCodex(prefix.text, prefix.truncated);
};

/** Test helper: parse transcript text without filesystem location. */
export const parseTranscriptText = (
  vendor: "claude" | "codex",
  text: string,
  truncated = false
): TranscriptReadResult => (vendor === "claude" ? parseClaude(text, truncated) : parseCodex(text, truncated));
