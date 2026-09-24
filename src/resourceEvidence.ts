import { stripAnsi } from "./tmux.js";

/** Distinct failure classes kept separate from deadline confidence. */
export const failureClassSchemaValues = [
  "usage-window",
  "billing",
  "throttled",
  "context-overflow",
  "auth-account",
  "cancelled",
  "transport",
  "unknown"
] as const;

export type FailureClass = (typeof failureClassSchemaValues)[number];
export type ClassificationConfidence = "unknown" | "vendor-reported" | "probed";
export type DeadlineConfidence = "unknown" | "exact";

export type ResourceWindow = {
  source: "claude-statusline" | "codex-app-server";
  bucket: string;
  usedPercent: number | null;
  resetsAt: string | null;
};

export type ClassifiedFailure = {
  failureClass: FailureClass;
  classificationConfidence: ClassificationConfidence;
  deadlineConfidence: DeadlineConfidence;
  resetsAt: string | null;
  windows: ResourceWindow[];
  detail: string | null;
  episodeKey: string;
};

const DIAGNOSTIC_CAP = 2048;
const OBSERVATION_CAP = 8192;

const CREDENTIAL_RE =
  /\b(sk-[a-zA-Z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._\-+=/]+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/gi;

/** Sanitize diagnostic text: strip ANSI, redact secrets, bound length. */
export const redactDiagnostic = (raw: string | null | undefined, cap = DIAGNOSTIC_CAP): string | null => {
  if (raw === undefined || raw === null || raw === "") return null;
  const stripped = stripAnsi(raw).replace(CREDENTIAL_RE, "[redacted]").replace(/\s+/g, " ").trim();
  if (stripped === "") return null;
  return stripped.length <= cap ? stripped : `${stripped.slice(0, cap - 1)}…`;
};

export const boundObservationJson = (value: unknown): unknown => {
  const encoded = JSON.stringify(value);
  if (encoded.length <= OBSERVATION_CAP) return value;
  return { truncated: true, preview: encoded.slice(0, OBSERVATION_CAP - 32) };
};

const epochToIso = (seconds: number | null | undefined): string | null => {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(Math.trunc(seconds) * 1000).toISOString();
};

const familyLimitNamed = (detail: string | null): boolean =>
  detail !== null && /\b(opus|sonnet|haiku|model[\s_-]?family|family[\s_-]?limit)\b/i.test(detail);

export type ClaudeTelemetryWindow = {
  usedPercent: number | null;
  resetsAt: number | null;
};

export type ClaudeTelemetry = {
  sessionId: string;
  observedAt: string;
  firstSeenAt: string;
  payloadIdentity: string;
  fiveHour: ClaudeTelemetryWindow | null;
  sevenDay: ClaudeTelemetryWindow | null;
};

export type ClaudeFailureFields = {
  error: string | null;
  errorDetails: string | null;
  lastAssistantMessage: string | null;
  sessionId: string | null;
  observedAt: string;
};

const TELEMETRY_FRESHNESS_MS = 5 * 60_000;

const windowFromTelemetry = (
  source: ClaudeTelemetry,
  key: "fiveHour" | "sevenDay",
  bucket: string
): ResourceWindow | null => {
  const win = source[key];
  if (win === null) return null;
  return {
    source: "claude-statusline",
    bucket,
    usedPercent: win.usedPercent,
    resetsAt: epochToIso(win.resetsAt)
  };
};

/** Classify Claude StopFailure against cached matching statusline telemetry. */
export const classifyClaudeFailure = (
  failure: ClaudeFailureFields,
  telemetry: ClaudeTelemetry | null,
  injectedAt: string | null,
  nowMs: number
): ClassifiedFailure => {
  const error = redactDiagnostic(failure.error);
  const detail = redactDiagnostic(
    [failure.errorDetails, failure.lastAssistantMessage].filter(Boolean).join(" | ") || error
  );
  const episodeKey = `claude:${failure.sessionId ?? "none"}:${error ?? "unknown"}`;

  if (error === "authentication_failed") {
    return {
      failureClass: "auth-account",
      classificationConfidence: "vendor-reported",
      deadlineConfidence: "unknown",
      resetsAt: null,
      windows: [],
      detail,
      episodeKey
    };
  }
  if (error === "billing_error") {
    return {
      failureClass: "billing",
      classificationConfidence: "vendor-reported",
      deadlineConfidence: "unknown",
      resetsAt: null,
      windows: [],
      detail,
      episodeKey
    };
  }
  if (error === "server_error") {
    return {
      failureClass: "transport",
      classificationConfidence: "vendor-reported",
      deadlineConfidence: "unknown",
      resetsAt: null,
      windows: [],
      detail,
      episodeKey
    };
  }
  if (error === "invalid_request" && detail !== null && /\b(prompt|context).{0,40}(too long|overflow)\b/i.test(detail)) {
    return {
      failureClass: "context-overflow",
      classificationConfidence: "vendor-reported",
      deadlineConfidence: "unknown",
      resetsAt: null,
      windows: [],
      detail,
      episodeKey
    };
  }

  if (error === "rate_limit") {
    if (familyLimitNamed(detail)) {
      return {
        failureClass: "usage-window",
        classificationConfidence: "vendor-reported",
        deadlineConfidence: "unknown",
        resetsAt: null,
        windows: [],
        detail,
        episodeKey
      };
    }
    const matching =
      telemetry !== null &&
      failure.sessionId !== null &&
      telemetry.sessionId === failure.sessionId &&
      Date.parse(telemetry.firstSeenAt) <= nowMs &&
      nowMs - Date.parse(telemetry.firstSeenAt) <= TELEMETRY_FRESHNESS_MS &&
      (injectedAt === null || Date.parse(telemetry.firstSeenAt) >= Date.parse(injectedAt));

    if (!matching || telemetry === null) {
      return {
        failureClass: "unknown",
        classificationConfidence: "unknown",
        deadlineConfidence: "unknown",
        resetsAt: null,
        windows: [],
        detail,
        episodeKey
      };
    }

    const windows = [
      windowFromTelemetry(telemetry, "fiveHour", "five-hour"),
      windowFromTelemetry(telemetry, "sevenDay", "seven-day")
    ].filter((w): w is ResourceWindow => w !== null);

    const exhausted = windows.filter(
      (w) => typeof w.usedPercent === "number" && w.usedPercent >= 100 && w.resetsAt !== null
    );
    if (exhausted.length > 0) {
      const resetsAt = exhausted
        .map((w) => w.resetsAt)
        .filter((v): v is string => v !== null)
        .sort()
        .at(-1) ?? null;
      return {
        failureClass: "usage-window",
        classificationConfidence: "vendor-reported",
        deadlineConfidence: resetsAt === null ? "unknown" : "exact",
        resetsAt,
        windows,
        detail,
        episodeKey
      };
    }
    return {
      failureClass: "throttled",
      classificationConfidence: "vendor-reported",
      deadlineConfidence: "unknown",
      resetsAt: null,
      windows,
      detail,
      episodeKey
    };
  }

  // Rendered clock text alone never becomes a deadline.
  return {
    failureClass: "unknown",
    classificationConfidence: "unknown",
    deadlineConfidence: "unknown",
    resetsAt: null,
    windows: [],
    detail,
    episodeKey
  };
};

export type CursorFailureInput = {
  status: string | null;
  reason: string | null;
  errorMessage: string | null;
};

export const classifyCursorFailure = (input: CursorFailureInput): ClassifiedFailure => {
  const status = (input.status ?? input.reason ?? "").toLowerCase();
  const detail = redactDiagnostic(input.errorMessage ?? input.reason ?? input.status);
  if (status === "aborted" || status === "user_close") {
    return {
      failureClass: "cancelled",
      classificationConfidence: "vendor-reported",
      deadlineConfidence: "unknown",
      resetsAt: null,
      windows: [],
      detail,
      episodeKey: `cursor:cancelled:${status}`
    };
  }
  return {
    failureClass: "unknown",
    classificationConfidence: "unknown",
    deadlineConfidence: "unknown",
    resetsAt: null,
    windows: [],
    detail,
    episodeKey: `cursor:unknown:${status || "error"}`
  };
};

export type CodexWindowSnapshot = {
  limitId: string;
  window: "primary" | "secondary";
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
  rateLimitReachedType: string | null;
  spendControlReached: boolean | null;
};

export type CodexLimitsSnapshot = {
  accountId: string | null;
  ordinaryUsageAllowed: boolean | null;
  windows: CodexWindowSnapshot[];
};

export type BlockerIdentity = {
  limitId: string;
  window: "primary" | "secondary";
};

/** Windows that currently block recovery. */
export const codexBlockingWindows = (snapshot: CodexLimitsSnapshot): CodexWindowSnapshot[] =>
  snapshot.windows.filter((w) => {
    if (w.spendControlReached === true) return true;
    if (w.rateLimitReachedType !== null && w.rateLimitReachedType !== "") return true;
    if (typeof w.usedPercent === "number" && w.usedPercent >= 100) return true;
    return false;
  });

export const codexIsExhausted = (snapshot: CodexLimitsSnapshot): boolean => {
  if (snapshot.ordinaryUsageAllowed === false) return true;
  return codexBlockingWindows(snapshot).length > 0;
};

/**
 * Clearance requires affirmative evidence for every previously blocked window
 * and no new blockers. Missing/null fields never count as clear.
 */
export const codexClearsBlockers = (
  previousBlockers: readonly BlockerIdentity[],
  snapshot: CodexLimitsSnapshot
): boolean => {
  if (snapshot.ordinaryUsageAllowed !== true) return false;
  if (codexBlockingWindows(snapshot).length > 0) return false;
  for (const blocker of previousBlockers) {
    const match = snapshot.windows.find((w) => w.limitId === blocker.limitId && w.window === blocker.window);
    if (match === undefined) return false;
    if (match.usedPercent === null) return false;
    if (match.usedPercent >= 100) return false;
    if (match.rateLimitReachedType !== null && match.rateLimitReachedType !== "") return false;
    if (match.spendControlReached === true) return false;
    if (match.spendControlReached === null && previousBlockers.some((b) => b.limitId === blocker.limitId)) {
      // null spend control on a previously blocked bucket is not affirmative clear
      // only when that bucket was spend-blocked; still require usedPercent known.
    }
  }
  return true;
};

/** Latest blocking resetsAt (+30s scheduling uses this). */
export const latestBlockingEpochIso = (windows: readonly CodexWindowSnapshot[]): string | null => {
  const epochs = windows
    .map((w) => w.resetsAt)
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v) && v > 0)
    .sort((a, b) => a - b);
  const last = epochs.at(-1);
  return last === undefined ? null : epochToIso(last);
};

export const DEADLINE_RECHECK_DELAY_MS = 30_000;
export const CODEX_PROBE_SPACING_MS = 5 * 60_000;
export const CODEX_RETRY_DELAYS_MS = [5 * 60_000, 10 * 60_000] as const;
export const CODEX_MAX_STARTS_PER_EPISODE = 6;
export const CODEX_MAX_FAILURE_RETRIES = 2;
export const CODEX_HELPER_TIMEOUT_MS = 10_000;
export const CODEX_HELPER_MAX_BYTES = 256 * 1024;
