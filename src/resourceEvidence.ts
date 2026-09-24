import { z } from "zod";
import { stripVTControlCharacters } from "node:util";

const timestamp = z.string().datetime({ offset: true });
export const resourceWindowSchema = z.object({
  bucket: z.string().min(1).max(128),
  window: z.string().min(1).max(32),
  usedPercent: z.number().finite().nonnegative(),
  windowDurationMins: z.number().positive().nullable(),
  resetsAt: timestamp.nullable()
}).strict();
export const resourceEvidenceSchema = z.object({
  vendor: z.enum(["claude", "codex", "cursor"]),
  failureClass: z.enum(["usage-window", "billing", "throttled", "context-overflow", "auth-account", "cancelled", "transport", "unknown"]),
  confidence: z.enum(["unknown", "vendor-reported", "probed"]),
  deadlineConfidence: z.enum(["unknown", "exact"]),
  resetsAt: timestamp.nullable(),
  windows: z.array(resourceWindowSchema).max(16),
  error: z.string().max(2048).nullable(),
  error_details: z.string().max(2048).nullable(),
  last_assistant_message: z.string().max(2048).nullable()
}).strict();
export type ResourceEvidence = z.infer<typeof resourceEvidenceSchema>;
export type ResourceWindow = z.infer<typeof resourceWindowSchema>;
export type RawFailure = { vendor: "claude" | "cursor"; error?: string; error_details?: string; last_assistant_message?: string };

export const redactDiagnostic = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const clean = stripVTControlCharacters(value)
    .replace(/https?:\/\/[^\s]+/gi, "[url]")
    .replace(/\bBearer\s+\S+|\bsk-[\w-]+|\b(?:token|password|secret|api[_-]?key)\s*[:=]\s*\S+/gi, "[credential]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, "[email]")
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[identifier]")
    .replace(/\p{Cc}/gu, " ");
  const bytes = Buffer.from(clean);
  let end = Math.min(bytes.length, 2048);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
};

export const unknownEvidence = (vendor: ResourceEvidence["vendor"]): ResourceEvidence => ({
  vendor, failureClass: "unknown", confidence: "unknown", deadlineConfidence: "unknown", resetsAt: null,
  windows: [], error: null, error_details: null, last_assistant_message: null
});

export const epochTimestamp = (value: unknown): string | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < 253402300800
    ? new Date(value * 1000).toISOString() : null;

export const claudeWindows = (value: unknown): ResourceWindow[] => {
  if (value === null || typeof value !== "object") return [];
  const raw = value as Record<string, unknown>;
  return ["five_hour", "seven_day"].flatMap((key) => {
    const window = raw[key];
    if (window === null || typeof window !== "object") return [];
    const fields = window as Record<string, unknown>;
    if (typeof fields.used_percentage !== "number" || !Number.isFinite(fields.used_percentage) || fields.used_percentage < 0) return [];
    return [{ bucket: "claude", window: key, usedPercent: fields.used_percentage,
      windowDurationMins: key === "five_hour" ? 300 : 10080, resetsAt: epochTimestamp(fields.resets_at) }];
  });
};

/** Telemetry passed here has already been correlated to the accepted action/session. */
export const classifyFailure = (raw: RawFailure, windows: ResourceWindow[], now: string): ResourceEvidence => {
  const evidence = { ...unknownEvidence(raw.vendor), error: redactDiagnostic(raw.error),
    error_details: redactDiagnostic(raw.error_details), last_assistant_message: redactDiagnostic(raw.last_assistant_message) };
  const detail = `${evidence.error_details ?? ""} ${evidence.last_assistant_message ?? ""}`;
  const error = raw.error;
  if (error === "aborted" || error === "user_close" || error === "cancelled") evidence.failureClass = "cancelled";
  else if (raw.vendor === "claude") {
    if (error === "authentication_failed") evidence.failureClass = "auth-account";
    else if (error === "billing_error") evidence.failureClass = "billing";
    else if (error === "server_error") evidence.failureClass = "transport";
    else if (error === "invalid_request" && /(?:prompt|context).*(?:too long|exceed)/i.test(detail)) evidence.failureClass = "context-overflow";
    else if (error === "rate_limit") {
      if (/opus|sonnet|haiku|model|family/i.test(detail)) return evidence;
      const blocked = windows.filter((window) => window.usedPercent >= 100);
      if (blocked.length > 0) {
        evidence.failureClass = "usage-window";
        evidence.windows = blocked;
        if (blocked.every((window) => window.resetsAt !== null && Date.parse(window.resetsAt) > Date.parse(now))) {
          evidence.resetsAt = blocked.map((window) => window.resetsAt!).sort().at(-1)!;
          evidence.deadlineConfidence = "exact";
        }
      } else if (windows.length === 2) evidence.failureClass = "throttled";
    }
  }
  if (evidence.failureClass !== "unknown") evidence.confidence = "vendor-reported";
  return evidence;
};
