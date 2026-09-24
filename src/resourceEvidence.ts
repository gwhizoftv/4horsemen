import { z } from "zod";

/**
 * Vendor resource evidence (#140). Pure: no I/O, no clocks beyond the caller's
 * `now`. Classification confidence and deadline confidence stay separate — an
 * exact epoch never proves exhaustion, and a reported failure type never
 * proves a deadline.
 */

const timestampSchema = z.string().datetime({ offset: true });

export const failureClassSchema = z.enum([
  "usage-window",
  "billing",
  "throttled",
  "context-overflow",
  "auth-account",
  "cancelled",
  "transport",
  "unknown"
]);
export type FailureClass = z.infer<typeof failureClassSchema>;

export const resourceWindowSchema = z
  .object({
    source: z.enum(["claude-statusline", "codex-app-server"]),
    /** Claude: `five_hour`/`seven_day`. Codex: the explicit `limitId`, never mapped to a model. */
    limitId: z.string().min(1).max(128),
    window: z.enum(["five_hour", "seven_day", "primary", "secondary"]),
    usedPercent: z.number().finite().min(0).nullable(),
    windowDurationMins: z.number().int().nonnegative().nullable(),
    resetsAt: timestampSchema.nullable()
  })
  .strict();
export type ResourceWindow = z.infer<typeof resourceWindowSchema>;

export const DIAGNOSTIC_MAX_BYTES = 2048;

export const resourceEvidenceSchema = z
  .object({
    vendor: z.enum(["claude", "codex", "cursor"]),
    failureClass: failureClassSchema,
    /** `reported`: a vendor failure type alone. `confirmed`: corroborated by matching window evidence. */
    classConfidence: z.enum(["reported", "confirmed"]),
    windows: z.array(resourceWindowSchema).max(16),
    detail: z.string().max(DIAGNOSTIC_MAX_BYTES).nullable(),
    /** Stable across duplicate deliveries, wording changes, hold generations and shifted deadlines. */
    episodeId: z.string().min(1).max(512),
    observedAt: timestampSchema
  })
  .strict();
export type ResourceEvidence = z.infer<typeof resourceEvidenceSchema>;

/** Classes that hold the issue instead of falling back to #126's budgeted re-send. */
export const HOLDING_CLASSES: ReadonlySet<FailureClass> = new Set([
  "usage-window",
  "billing",
  "context-overflow",
  "auth-account",
  "cancelled"
]);

// ANSI CSI/OSC sequences and remaining C0/C1 controls (newline and tab collapse below).
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROLS = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

const truncateBytes = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes - 3) end -= 1;
  return `${text.slice(0, end)}...`;
};

/** Untrusted vendor text: strip controls, mask credential/personal shapes, bound bytes. */
export const redactDiagnostic = (value: unknown, maxBytes = DIAGNOSTIC_MAX_BYTES): string | null => {
  if (typeof value !== "string") return null;
  const text = value
    .replace(TERMINAL_CONTROLS, "")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|sess|org|acct|user)-[A-Za-z0-9_-]{8,}/gi, "[redacted]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/(https?:\/\/[^\s?#]+)\?[^\s#]*/g, "$1?[redacted]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return text === "" ? null : truncateBytes(text, maxBytes);
};

export type FailureFields = {
  error: string | null;
  errorDetails: string | null;
  lastAssistantMessage: string | null;
};

const detailOf = (fields: FailureFields): string | null =>
  redactDiagnostic([fields.error, fields.errorDetails, fields.lastAssistantMessage].filter((part) => part !== null).join(" | "));

/** Unix seconds from a vendor payload; anything else is not a deadline. */
export const epochSecondsToIso = (value: unknown): string | null => {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) return null;
  // 2020-01-01 .. 2100-01-01: rejects milliseconds and nonsense without guessing units.
  if (value < 1_577_836_800 || value > 4_102_444_800) return null;
  return new Date(value * 1000).toISOString();
};

const percentOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

export type ClaudeRateLimits = { fiveHour: ResourceWindow | null; sevenDay: ResourceWindow | null };

/** Claude statusline `rate_limits.{five_hour,seven_day}`; each is independently optional. */
export const parseClaudeRateLimits = (raw: unknown): ClaudeRateLimits | null => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const limits = (raw as Record<string, unknown>).rate_limits;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return null;
  const window = (name: "five_hour" | "seven_day"): ResourceWindow | null => {
    const value = (limits as Record<string, unknown>)[name];
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    const usedPercent = percentOf(entry.used_percentage);
    if (usedPercent === null) return null;
    return {
      source: "claude-statusline", limitId: name, window: name, usedPercent,
      windowDurationMins: name === "five_hour" ? 300 : 10_080, resetsAt: epochSecondsToIso(entry.resets_at)
    };
  };
  const parsed = { fiveHour: window("five_hour"), sevenDay: window("seven_day") };
  return parsed.fiveHour === null && parsed.sevenDay === null ? null : parsed;
};

export type Classification = {
  failureClass: FailureClass;
  classConfidence: "reported" | "confirmed";
  windows: ResourceWindow[];
  detail: string | null;
  /** Exact only when every applicable blocker carries a provider epoch still in the future. */
  resetsAt: string | null;
};

export const CLAUDE_TELEMETRY_FRESH_MS = 5 * 60_000;

const latestDeadline = (windows: readonly ResourceWindow[], now: string): string | null => {
  if (windows.length === 0 || windows.some((window) => window.resetsAt === null)) return null;
  const latest = Math.max(...windows.map((window) => Date.parse(window.resetsAt!)));
  return latest > Date.parse(now) ? new Date(latest).toISOString() : null;
};

export type ClaudeTelemetry = { sessionId: string; observedAt: string; limits: ClaudeRateLimits };

export const classifyClaudeFailure = (
  fields: FailureFields,
  telemetry: ClaudeTelemetry | null,
  context: { sessionId: string | null; now: string }
): Classification => {
  const detail = detailOf(fields);
  const reported = (failureClass: FailureClass): Classification =>
    ({ failureClass, classConfidence: "reported", windows: [], detail, resetsAt: null });
  const error = fields.error?.toLowerCase() ?? "";
  if (error === "authentication_failed") return reported("auth-account");
  if (error === "billing_error") return reported("billing");
  if (error === "server_error") return reported("transport");
  if (error === "invalid_request") {
    return /prompt is too long|context (?:window|length)|too many tokens/i.test(detail ?? "")
      ? reported("context-overflow")
      : reported("unknown");
  }
  if (error !== "rate_limit") return reported("unknown");
  // A model-family restriction has no supported epoch; never borrow a general window's.
  if (/\b(?:opus|sonnet|haiku)\b/i.test(detail ?? "")) return reported("usage-window");
  const age = telemetry === null ? NaN : Date.parse(context.now) - Date.parse(telemetry.observedAt);
  const fresh = telemetry !== null && context.sessionId !== null && telemetry.sessionId === context.sessionId &&
    age >= 0 && age <= CLAUDE_TELEMETRY_FRESH_MS;
  if (!fresh) return reported("unknown");
  const windows = [telemetry.limits.fiveHour, telemetry.limits.sevenDay].filter((window) => window !== null);
  const blocked = windows.filter((window) => (window.usedPercent ?? 0) >= 100);
  if (blocked.length > 0) {
    return { failureClass: "usage-window", classConfidence: "confirmed", windows: blocked, detail,
      resetsAt: latestDeadline(blocked, context.now) };
  }
  return reported(windows.length > 0 ? "throttled" : "unknown");
};

/** Cursor exposes no quota fields: only explicit cancellation is classified. */
export const classifyCursorStatus = (status: string | undefined): FailureClass =>
  status === "aborted" ? "cancelled" : "unknown";

// ---- Codex App Server `account/rateLimits/read` ------------------------------

export type CodexBucket = {
  limitId: string;
  reachedType: string | null;
  spendControlReached: boolean | null;
  windows: ResourceWindow[];
};

export type CodexLimits = {
  accountId: string | null;
  ordinaryUsageAllowed: boolean | null;
  buckets: CodexBucket[];
};

export class CodexLimitsFormatError extends Error {
  override readonly name = "CodexLimitsFormatError";
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new CodexLimitsFormatError(`${what} is not an object`);
  return value as Record<string, unknown>;
};

const nullableBoolean = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

const parseCodexWindow = (limitId: string, window: "primary" | "secondary", value: unknown): ResourceWindow | null => {
  if (value === null || value === undefined) return null;
  const entry = record(value, `${limitId}.${window}`);
  const usedPercent = percentOf(entry.usedPercent);
  if (usedPercent === null) throw new CodexLimitsFormatError(`${limitId}.${window}.usedPercent is not a finite percentage`);
  const duration = entry.windowDurationMins;
  return {
    source: "codex-app-server", limitId, window, usedPercent,
    windowDurationMins: typeof duration === "number" && Number.isInteger(duration) && duration >= 0 ? duration : null,
    resetsAt: epochSecondsToIso(entry.resetsAt)
  };
};

const parseCodexBucket = (fallbackId: string, value: unknown): CodexBucket => {
  const entry = record(value, `bucket ${fallbackId}`);
  const limitId = typeof entry.limitId === "string" && entry.limitId !== "" ? entry.limitId : fallbackId;
  const reached = entry.rateLimitReachedType;
  return {
    limitId,
    reachedType: typeof reached === "string" && reached !== "" ? reached : null,
    spendControlReached: nullableBoolean(entry.spendControlReached),
    windows: [parseCodexWindow(limitId, "primary", entry.primary), parseCodexWindow(limitId, "secondary", entry.secondary)]
      .filter((window) => window !== null)
  };
};

/** Explicit camelCase fields only; conflicting duplicate bucket views fail closed. */
export const parseCodexRateLimits = (value: unknown): CodexLimits => {
  const response = record(value, "rate limits response");
  const buckets = new Map<string, CodexBucket>();
  if (response.rateLimitsByLimitId !== null && response.rateLimitsByLimitId !== undefined) {
    for (const [key, bucket] of Object.entries(record(response.rateLimitsByLimitId, "rateLimitsByLimitId"))) {
      if (bucket === null || bucket === undefined) continue;
      const parsed = parseCodexBucket(key, bucket);
      if (parsed.limitId !== key) throw new CodexLimitsFormatError(`bucket ${key} reports limitId ${parsed.limitId}`);
      buckets.set(key, parsed);
    }
  }
  if (response.rateLimits !== null && response.rateLimits !== undefined) {
    const compatibility = parseCodexBucket("(compatibility)", response.rateLimits);
    const duplicate = buckets.get(compatibility.limitId);
    if (duplicate === undefined) buckets.set(compatibility.limitId, compatibility);
    else if (JSON.stringify(duplicate) !== JSON.stringify(compatibility)) {
      throw new CodexLimitsFormatError(`compatibility view conflicts with bucket ${compatibility.limitId}`);
    }
  }
  if (buckets.size === 0) throw new CodexLimitsFormatError("no rate limit buckets");
  return {
    accountId: typeof response.accountId === "string" && response.accountId !== "" ? response.accountId : null,
    ordinaryUsageAllowed: nullableBoolean(response.ordinaryUsageAllowed),
    buckets: [...buckets.values()]
  };
};

const RENEWABLE_REACHED_TYPES = new Set(["rate_limit_reached"]);
const SPEND_REACHED_TYPES = new Set([
  "workspace_owner_credits_depleted",
  "workspace_member_credits_depleted",
  "workspace_owner_usage_limit_reached",
  "workspace_member_usage_limit_reached"
]);

export type CodexAssessment =
  | { status: "clear" }
  | { status: "exhausted"; classification: Classification };

/**
 * Exhaustion needs an affirmative blocker. Zero credits with ordinary usage
 * allowed is not a hold, and a reset time alone proves nothing.
 */
export const assessCodexLimits = (limits: CodexLimits, now: string): CodexAssessment => {
  const blocked: ResourceWindow[] = [];
  let renewable = false;
  let spend = false;
  let unknownType = false;
  for (const bucket of limits.buckets) {
    const full = bucket.windows.filter((window) => (window.usedPercent ?? 0) >= 100);
    if (bucket.spendControlReached === true) spend = true;
    if (bucket.reachedType !== null) {
      if (RENEWABLE_REACHED_TYPES.has(bucket.reachedType)) renewable = true;
      else if (SPEND_REACHED_TYPES.has(bucket.reachedType)) spend = true;
      else unknownType = true;
      // The provider says which bucket, not which window: keep them all.
      blocked.push(...(full.length > 0 ? full : bucket.windows));
    } else if (full.length > 0) {
      renewable = true;
      blocked.push(...full);
    }
  }
  const exhausted = blocked.length > 0 || spend || unknownType || limits.ordinaryUsageAllowed === false;
  if (!exhausted) return { status: "clear" };
  const failureClass: FailureClass = spend ? "billing" : renewable && !unknownType ? "usage-window" : "unknown";
  return {
    status: "exhausted",
    classification: {
      failureClass,
      classConfidence: "confirmed",
      windows: blocked.slice(0, 16),
      detail: null,
      resetsAt: failureClass === "usage-window" ? latestDeadline(blocked, now) : null
    }
  };
};

/**
 * Recovery needs complete, affirmative, fresh evidence: backend permission,
 * no blocker anywhere, and every previously blocked window present again below
 * its limit. Absent, null or malformed evidence is never clearance.
 */
export const codexClearsBlockers = (limits: CodexLimits, prior: readonly ResourceWindow[], now: string): boolean => {
  if (limits.ordinaryUsageAllowed !== true || prior.length === 0) return false;
  if (assessCodexLimits(limits, now).status !== "clear") return false;
  return prior.every((blocked) => {
    const bucket = limits.buckets.find((candidate) => candidate.limitId === blocked.limitId);
    const window = bucket?.windows.find((candidate) => candidate.window === blocked.window);
    return window !== undefined && window.usedPercent !== null && window.usedPercent < 100;
  });
};
