import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  observeAgentLifecycleWithResult,
  type LifecycleObservation,
  type AgentLifecycleState
} from "./agentLifecycle.js";
import { extractCursorTokenUsage, type CursorUsageJournalDetails } from "./cursorHookUsage.js";
import { localConfigGet } from "./gitExec.js";
import { parseClaudeRateLimits } from "./resourceEvidence.js";
import { resolveWorkspaceConfig } from "./hookPolicy.js";
import { agentRuntimePaths, issueRuntimePaths } from "./paths.js";
import { appendJournal, readCursorsState, readStartState } from "./state.js";
import { listIssueNumbersInWorkspace, workspaceLocationFromConfig } from "./workspace.js";

export const lifecycleVendorSchema = z.enum(["codex", "claude", "cursor", "antigravity"]);
export type LifecycleVendor = z.infer<typeof lifecycleVendorSchema>;

const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";
const actionPromptPattern = new RegExp(
  `coordinator action\\s+(${uuid})\\s+digest\\s+([a-fA-F0-9]{64})\\s+at\\s+([^\\r\\n]+)`
);

export type PromptActionIdentity = {
  actionId: string;
  actionDigest: string;
  actionPath: string;
  issue: number | null;
};

export const extractPromptActionIdentity = (prompt: string): PromptActionIdentity | null => {
  const matched = prompt.match(actionPromptPattern);
  if (matched?.[1] === undefined || matched[2] === undefined || matched[3] === undefined) return null;
  const path = matched[3].trim();
  const issueMatch = path.match(/(?:^|\/)issue-([1-9][0-9]*)\/agents\/[a-z][a-z0-9-]*\/action\.md$/);
  return {
    actionId: matched[1].toLowerCase(),
    actionDigest: matched[2].toLowerCase(),
    actionPath: path,
    issue: issueMatch?.[1] === undefined ? null : Number(issueMatch[1])
  };
};

type JsonObject = Record<string, unknown>;

export const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

export const stringField = (value: JsonObject, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
};

const eventNameOf = (raw: JsonObject, explicitEvent?: string): string =>
  explicitEvent ?? stringField(raw, "hook_event_name", "hookEventName") ?? "unknown";

export const normalizeAgentEvent = (
  vendor: LifecycleVendor,
  rawValue: unknown,
  explicitEvent?: string
): LifecycleObservation | null => {
  const raw = object(rawValue);
  if (raw === null) return null;
  const eventName = eventNameOf(raw, explicitEvent);
  const normalizedName = eventName.toLowerCase();
  const prompt = stringField(raw, "prompt");
  const action = prompt === undefined ? null : extractPromptActionIdentity(prompt);

  if (vendor === "codex") {
    const common = {
      eventName,
      ...(stringField(raw, "session_id") === undefined ? {} : { sessionId: stringField(raw, "session_id") }),
      ...(stringField(raw, "turn_id") === undefined ? {} : { turnId: stringField(raw, "turn_id") })
    };
    if (normalizedName === "sessionstart") return { kind: "session-start", ...common };
    if (normalizedName === "sessionend") return { kind: "session-end", ...common };
    if (normalizedName === "userpromptsubmit") {
      return {
        kind: "prompt-submitted",
        ...common,
        ...(action === null
          ? {}
          : { actionId: action.actionId, actionDigest: action.actionDigest, actionPath: action.actionPath })
      };
    }
    if (normalizedName === "pretooluse") return { kind: "tool-start", ...common };
    if (normalizedName === "posttooluse") return { kind: "tool-activity", ...common };
    if (normalizedName === "stop") return { kind: "stopped", ...common };
    return null;
  }

  if (vendor === "claude") {
    const sessionId = stringField(raw, "session_id");
    const turnId = stringField(raw, "turn_id", "prompt_id");
    const common = {
      eventName,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(turnId === undefined ? {} : { turnId })
    };
    if (normalizedName === "sessionstart") return { kind: "session-start", ...common };
    if (normalizedName === "sessionend") return { kind: "session-end", ...common };
    if (normalizedName === "userpromptsubmit") {
      return {
        kind: "prompt-submitted",
        ...common,
        ...(action === null
          ? {}
          : { actionId: action.actionId, actionDigest: action.actionDigest, actionPath: action.actionPath })
      };
    }
    if (normalizedName === "stopfailure") {
      // Actual StopFailure fields only; no invented error_type/error_message aliases.
      return {
        kind: "failed", ...common,
        failure: {
          vendor: "claude",
          error: stringField(raw, "error") ?? null,
          errorDetails: stringField(raw, "error_details") ?? null,
          lastAssistantMessage: stringField(raw, "last_assistant_message") ?? null
        }
      };
    }
    if (normalizedName === "status-line" || normalizedName === "statusline") {
      const rateLimits = parseClaudeRateLimits(raw);
      return rateLimits === null ? null : { kind: "telemetry", ...common, rateLimits };
    }
    if (normalizedName === "pretooluse") return { kind: "tool-start", ...common };
    if (normalizedName === "posttooluse" || normalizedName === "posttoolusefailure") return { kind: "tool-activity", ...common };
    if (normalizedName === "stop") return { kind: "stopped", ...common };
    return null;
  }

  if (vendor === "cursor") {
    const sessionId = stringField(raw, "conversation_id", "session_id");
    const turnId = stringField(raw, "generation_id");
    const common = {
      eventName,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(turnId === undefined ? {} : { turnId })
    };
    if (normalizedName === "sessionstart") return { kind: "session-start", ...common };
    if (normalizedName === "sessionend") {
      const reason = stringField(raw, "reason")?.toLowerCase();
      const message = stringField(raw, "error_message");
      // Session-end diagnostics are advisory: never a confirmed quota or cancellation class.
      return reason === "error" || message !== undefined
        ? { kind: "session-end", ...common, failure: { vendor: "cursor", status: "error", error: reason ?? null, errorDetails: message ?? null, lastAssistantMessage: null } }
        : { kind: "session-end", ...common };
    }
    if (normalizedName === "beforesubmitprompt") {
      return {
        kind: "prompt-submitted",
        ...common,
        ...(action === null
          ? {}
          : { actionId: action.actionId, actionDigest: action.actionDigest, actionPath: action.actionPath })
      };
    }
    // A failed tool invocation still proves the turn is executing.
    if (normalizedName === "posttooluse" || normalizedName === "posttoolusefailure") return { kind: "tool-activity", ...common };
    if (normalizedName === "stop") {
      const status = stringField(raw, "status", "reason", "final_status")?.toLowerCase();
      return status === "error" || status === "aborted"
        ? {
          kind: "failed", ...common,
          failure: { vendor: "cursor", status, error: stringField(raw, "error", "error_message") ?? null, errorDetails: null, lastAssistantMessage: null }
        }
        : { kind: "stopped", ...common };
    }
    return null;
  }

  const sessionId = stringField(raw, "conversation_id", "session_id", "conversationId");
  const common = { eventName, ...(sessionId === undefined ? {} : { sessionId }) };
  // The status payload only establishes session identity; activity comes from the watchdog.
  if (normalizedName === "status-line" || normalizedName === "statusline") return { kind: "status", ...common };
  if (normalizedName === "preinvocation" || normalizedName === "postinvocation") return { kind: "tool-activity", ...common };
  if (normalizedName === "stop") return { kind: "stopped", ...common };
  return null;
};

/** Normalize Cursor analytics hook payloads into journaled usage records. */
export const normalizeCursorUsageEvent = (
  vendor: LifecycleVendor,
  rawValue: unknown,
  explicitEvent?: string
): CursorUsageJournalDetails | null => {
  if (vendor !== "cursor") return null;
  const raw = object(rawValue);
  if (raw === null) return null;
  const eventName = eventNameOf(raw, explicitEvent);
  const normalizedName = eventName.toLowerCase();
  const sessionId = stringField(raw, "conversation_id", "session_id");
  const turnId = stringField(raw, "generation_id", "turn_id");
  if (sessionId === undefined || turnId === undefined) return null;

  if (normalizedName === "posttooluse") {
    return {
      vendor: "cursor",
      event: eventName,
      kind: "tool-used",
      sessionId,
      turnId,
      toolCalls: 1
    };
  }
  if (normalizedName === "posttoolusefailure") {
    return {
      vendor: "cursor",
      event: eventName,
      kind: "tool-failed",
      sessionId,
      turnId,
      toolCalls: 0
    };
  }
  if (normalizedName === "afteragentresponse" || normalizedName === "stop") {
    const tokens = extractCursorTokenUsage(raw);
    if (tokens === null) return null;
    return {
      vendor: "cursor",
      event: eventName,
      kind: "turn-usage",
      sessionId,
      turnId,
      tokens
    };
  }
  return null;
};

const issueFromRaw = (raw: JsonObject): number | null => {
  const prompt = stringField(raw, "prompt");
  const action = prompt === undefined ? null : extractPromptActionIdentity(prompt);
  return action?.issue ?? null;
};

const cloneFromRaw = (raw: JsonObject): string | null => {
  const direct = stringField(raw, "cwd");
  if (direct !== undefined) return direct;
  const workspace = object(raw.workspace);
  const nested = workspace === null ? undefined : stringField(workspace, "current_dir", "project_dir");
  if (nested !== undefined) return nested;
  const roots = raw.workspace_roots ?? raw.workspacePaths;
  return Array.isArray(roots) && typeof roots[0] === "string" ? roots[0] : null;
};

export type HandleAgentEventInput = {
  vendor: LifecycleVendor;
  raw: unknown;
  clone?: string;
  agent?: string;
  issue?: number;
  environmentIssue?: string;
  explicitEvent?: string;
  now?: string;
};

export type HandleAgentEventResult = {
  observed: boolean;
  issue: number | null;
  agent: string | null;
  state: AgentLifecycleState | null;
};

/** Resolve one hook callback to its owner runtime and persist only normalized data. */
export const handleAgentEvent = (input: HandleAgentEventInput): HandleAgentEventResult => {
  const raw = object(input.raw);
  if (raw === null) return { observed: false, issue: null, agent: null, state: null };
  const cloneValue = input.clone ?? cloneFromRaw(raw);
  if (cloneValue === null) return { observed: false, issue: null, agent: null, state: null };
  const clone = resolve(cloneValue);
  const resolved = resolveWorkspaceConfig(clone);
  const configuredAgent = localConfigGet(clone, "consensus.agentId");
  const agent = input.agent ?? configuredAgent;
  if (agent === null || agent === undefined || (configuredAgent !== null && agent !== configuredAgent)) {
    throw new Error("Lifecycle hook agent identity does not match the configured clone.");
  }
  const workspace = workspaceLocationFromConfig(resolved.configPath);
  const envIssue = input.environmentIssue === undefined ? NaN : Number(input.environmentIssue);
  let issue =
    input.issue ??
    (Number.isInteger(envIssue) && envIssue > 0 ? envIssue : undefined) ??
    issueFromRaw(raw);
  if (issue === null || issue === undefined) {
    const activeIssues = listIssueNumbersInWorkspace(workspace.workspaceRoot).filter((candidate) => {
      const candidatePaths = issueRuntimePaths(workspace.workspaceRoot, candidate);
      if (!existsSync(candidatePaths.start) || !existsSync(candidatePaths.cursors)) return false;
      try {
        const start = readStartState(candidatePaths);
        const cursors = readCursorsState(candidatePaths);
        return start.originalRoster.includes(agent) && !cursors.completed && !cursors.abandoned;
      } catch {
        return false;
      }
    });
    issue = activeIssues.length === 1 ? activeIssues[0] : null;
  }
  if (issue === null || issue === undefined) return { observed: false, issue: null, agent, state: null };
  const paths = issueRuntimePaths(workspace.workspaceRoot, issue);
  if (!existsSync(paths.start)) return { observed: false, issue, agent, state: null };
  const start = readStartState(paths);
  if (!start.originalRoster.includes(agent)) throw new Error(`Agent ${agent} is not in issue ${issue}'s roster.`);
  const now = input.now ?? new Date().toISOString();
  const observation = normalizeAgentEvent(input.vendor, raw, input.explicitEvent);
  const usage = normalizeCursorUsageEvent(input.vendor, raw, input.explicitEvent);
  if (observation === null && usage === null) return { observed: false, issue, agent, state: null };

  let state: AgentLifecycleState | null = null;
  if (observation !== null) {
    if (
      observation.actionPath !== undefined &&
      resolve(observation.actionPath) !== resolve(agentRuntimePaths(paths, agent).action)
    ) {
      throw new Error("Lifecycle prompt names an action path outside the configured agent runtime.");
    }
    const result = observeAgentLifecycleWithResult(paths, agent, observation, now);
    state = result.state;
    const journalsTurnBoundary = observation.kind === "prompt-submitted" || observation.kind === "stopped";
    const failure = observation.failure === undefined ? null : result.state.agents[agent]?.lastFailure ?? null;
    // Status renders and tool callbacks are never journaled, however often they change.
    const quiet = observation.kind === "telemetry" || observation.kind === "tool-start" || observation.kind === "tool-activity";
    if (!quiet && (result.changed || journalsTurnBoundary)) {
      appendJournal(
        paths,
        {
          type: "agent-lifecycle",
          agent,
          ...(observation.actionId === undefined ? {} : { actionId: observation.actionId }),
          details: {
            vendor: input.vendor,
            event: observation.eventName,
            kind: observation.kind,
            health: result.state.agents[agent]?.health ?? "unknown",
            ...(observation.sessionId === undefined ? {} : { sessionId: observation.sessionId }),
            ...(observation.turnId === undefined ? {} : { turnId: observation.turnId }),
            ...(failure === null ? {} : { failureClass: failure.evidence.failureClass, correlated: failure.actionId !== null })
          }
        },
        now
      );
    }
  }

  if (usage !== null) {
    appendJournal(
      paths,
      {
        type: "agent-usage",
        agent,
        details: usage
      },
      now
    );
  }

  return { observed: true, issue, agent, state };
};
