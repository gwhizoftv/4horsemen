import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import {
  observeAgentLifecycleWithResult,
  type LifecycleObservation,
  type AgentLifecycleState
} from "./agentLifecycle.js";
import { localConfigGet } from "./gitExec.js";
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

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;

const stringField = (value: JsonObject, ...names: readonly string[]): string | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "string" && candidate !== "") return candidate;
  }
  return undefined;
};

const intField = (value: JsonObject, ...names: readonly string[]): number | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0) return candidate;
  }
  return undefined;
};

const boolField = (value: JsonObject, ...names: readonly string[]): boolean | undefined => {
  for (const name of names) {
    const candidate = value[name];
    if (typeof candidate === "boolean") return candidate;
  }
  return undefined;
};

const arrayHasItems = (value: JsonObject, name: string): boolean | undefined => {
  const candidate = value[name];
  return Array.isArray(candidate) ? candidate.length > 0 : undefined;
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
    if (normalizedName === "stop") return { kind: "stopped", ...common, backgroundActive: false };
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
    if (normalizedName === "stopfailure") return { kind: "failed", ...common, backgroundActive: false };
    if (normalizedName === "stop") {
      const background = [arrayHasItems(raw, "background_tasks"), arrayHasItems(raw, "session_crons")].some(
        (value) => value === true
      );
      return { kind: "stopped", ...common, backgroundActive: background };
    }
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
    if (normalizedName === "sessionend") return { kind: "session-end", ...common };
    if (normalizedName === "beforesubmitprompt") {
      return {
        kind: "prompt-submitted",
        ...common,
        ...(action === null
          ? {}
          : { actionId: action.actionId, actionDigest: action.actionDigest, actionPath: action.actionPath })
      };
    }
    if (normalizedName === "stop") {
      const status = stringField(raw, "status", "reason", "final_status")?.toLowerCase();
      return status === "error" || status === "aborted"
        ? { kind: "failed", ...common, backgroundActive: false }
        : { kind: "stopped", ...common, backgroundActive: false };
    }
    return null;
  }

  const sessionId = stringField(raw, "conversation_id", "session_id", "conversationId");
  const common = { eventName, ...(sessionId === undefined ? {} : { sessionId }) };
  if (normalizedName === "status-line" || normalizedName === "statusline") {
    const pendingInputCount = intField(raw, "pending_input_count") ?? 0;
    const taskCount = intField(raw, "task_count") ?? 0;
    const toolConfirmationPending = boolField(raw, "tool_confirmation_pending") ?? false;
    const state = stringField(raw, "agent_state")?.toLowerCase();
    const execution =
      pendingInputCount > 0 || taskCount > 0 || toolConfirmationPending
        ? "queued"
        : state === "idle"
          ? "idle"
          : state === "thinking" || state === "working" || state === "tool_use" || state === "initializing"
            ? "working"
            : "unknown";
    return {
      kind: "status",
      ...common,
      execution,
      pendingInputCount,
      backgroundActive: taskCount > 0 || toolConfirmationPending
    };
  }
  if (normalizedName === "preinvocation" || normalizedName === "postinvocation") {
    return { kind: "working", ...common };
  }
  if (normalizedName === "stop") {
    const fullyIdle = boolField(raw, "fullyIdle") ?? false;
    return {
      kind: "stopped",
      ...common,
      backgroundActive: !fullyIdle,
      allowInjectedIdle: fullyIdle
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
  const observation = normalizeAgentEvent(input.vendor, raw, input.explicitEvent);
  if (observation === null) return { observed: false, issue, agent, state: null };
  if (
    observation.actionPath !== undefined &&
    resolve(observation.actionPath) !== resolve(agentRuntimePaths(paths, agent).action)
  ) {
    throw new Error("Lifecycle prompt names an action path outside the configured agent runtime.");
  }
  const now = input.now ?? new Date().toISOString();
  const result = observeAgentLifecycleWithResult(paths, agent, observation, now);
  if (result.changed) {
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
          execution: result.state.agents[agent]?.execution ?? "unknown",
          health: result.state.agents[agent]?.health ?? "unknown"
        }
      },
      now
    );
  }
  return { observed: true, issue, agent, state: result.state };
};
