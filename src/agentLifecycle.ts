import { closeSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { digestSchema, agentIdSchema } from "./protocol.js";
import type { IssueRuntimePaths } from "./paths.js";
import {
  classifyClaudeFailure,
  classifyCursorStatus,
  DIAGNOSTIC_MAX_BYTES,
  redactDiagnostic,
  resourceEvidenceSchema,
  resourceWindowSchema,
  type ClaudeRateLimits,
  type Classification,
  type FailureFields
} from "./resourceEvidence.js";
import { acquireExclusiveLock, atomicWriteJson, readStartState } from "./state.js";

/** Independent from the workflow runtime format: hook traffic is not workflow authority. */
export const AGENT_LIFECYCLE_FORMAT_VERSION = 1;
export const AGENT_OBSERVABILITY_WATCHDOG_MS = 45_000;

const timestampSchema = z.string().datetime({ offset: true });

const containmentIdentity = {
  sessionId: z.string().min(1),
  policyRevision: z.string().min(1),
  binding: digestSchema,
  at: timestampSchema
};
export const containmentSchema = z.object({
  hookDenial: z.object({ ...containmentIdentity, probe: z.boolean() }).nullable(),
  probe: z.object({
    ...containmentIdentity,
    vendorVersion: z.string().min(1).max(256),
    resolvedGit: z.string().max(4096),
    issueEnv: z.boolean(),
    shim: z.enum(["active", "bypassed", "unverified"]),
    /** An explicit observation of the tool result, NOT merely a deny callback. */
    toolResult: z.enum(["hook-denied", "shim-refused", "executed", "unknown"])
  }).nullable()
});
export type Containment = z.infer<typeof containmentSchema>;

export const containmentCoverage = (entry: AgentLifecycleEntry | undefined, binding?: string | null): {
  hook: "active" | "inactive" | "unverified";
  shim: "active" | "bypassed" | "unverified";
} => {
  const probe = entry?.containment?.probe;
  if (!probe || probe.sessionId !== entry?.sessionId || (binding !== undefined && probe.binding !== binding)) {
    return { hook: "unverified", shim: "unverified" };
  }
  const denial = entry?.containment?.hookDenial;
  const corroborated = denial?.probe === true && denial.sessionId === probe.sessionId &&
    denial.binding === probe.binding && denial.policyRevision === probe.policyRevision && denial.at <= probe.at;
  return {
    hook: probe.toolResult === "executed" || probe.toolResult === "shim-refused" ? "inactive"
      : probe.toolResult === "hook-denied" && corroborated && probe.vendorVersion !== "unknown" ? "active" : "unverified",
    shim: probe.shim
  };
};

export const lifecycleActionSchema = z
  .object({
    actionId: z.string().uuid(),
    actionDigest: digestSchema,
    delivery: z.enum(["ordered", "injected", "accepted"]),
    orderedAt: timestampSchema,
    injectedAt: timestampSchema.nullable(),
    acceptedAt: timestampSchema.nullable(),
    sessionId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    workflowCompleteAt: timestampSchema.nullable(),
    /** Cursor hold generation of the last send; an owner hold release makes the action sendable again. */
    sentHoldGeneration: z.number().int().nonnegative().nullable().default(null),
    /** The stall watchdog's one resend for this action. */
    resentAt: timestampSchema.nullable().default(null),
    /** The stall watchdog's one `[WAIT]` report for this action. */
    waitReportedAt: timestampSchema.nullable().default(null),
    /** Last watchdog activity fingerprint and when it last changed. */
    watch: z.object({ checkedAt: timestampSchema, quietSince: timestampSchema, fingerprint: z.string() })
      .strict().nullable().default(null)
  });
// Not strict: runtimes written before issue 222 carry removed turn-tracking keys, which are dropped on read.

const diagnosticSchema = z.string().max(DIAGNOSTIC_MAX_BYTES).nullable();

/** Latest correlated vendor failure; `actionId: null` is advisory and cannot hold or release work. */
export const lifecycleFailureSchema = z
  .object({
    evidence: resourceEvidenceSchema,
    resetsAt: timestampSchema.nullable(),
    error: diagnosticSchema,
    errorDetails: diagnosticSchema,
    lastAssistantMessage: diagnosticSchema,
    sessionId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    actionId: z.string().uuid().nullable()
  })
  .strict();

/** Claude statusline windows; `observedAt` is first receipt of this exact identity, not the latest render. */
export const claudeRateLimitsSchema = z
  .object({
    sessionId: z.string().min(1),
    identity: z.string().max(1024),
    observedAt: timestampSchema,
    fiveHour: resourceWindowSchema.nullable(),
    sevenDay: resourceWindowSchema.nullable()
  })
  .strict();

export const agentLifecycleEntrySchema = z
  .object({
    action: lifecycleActionSchema.nullable(),
    sessionId: z.string().min(1).nullable(),
    retiredSessionIds: z.array(z.string().min(1)).max(16).default([]),
    /** A new session was established and no prompt has been submitted since: it may be sent its action. */
    freshSession: z.boolean().default(false),
    /** A consumed ready receipt: the agent is idle after this action and may be sent the next one. */
    ready: z.object({ actionId: z.string().uuid(), at: timestampSchema }).strict().nullable().default(null),
    /** Tool hooks seen; `pending` counts tool starts without a matching end in the current turn. */
    toolActivity: z.object({
      sequence: z.number().int().nonnegative(), pending: z.number().int().nonnegative(), at: timestampSchema.nullable()
    }).strict().default({ sequence: 0, pending: 0, at: null }),
    health: z.enum(["unknown", "healthy", "degraded"]),
    /** Why health degraded, so the operator message names what was observed. */
    degradedCause: z.enum(["hooks-never-seen", "correlation-lagged"]).nullable().default(null),
    lastEvent: z.string().min(1).nullable(),
    lastEventAt: timestampSchema.nullable(),
    /** Activity-hook receipt, independent of semantic deduplication and telemetry. */
    hookReceipt: z.object({ at: timestampSchema, sequence: z.number().int().nonnegative() }).nullable().default(null),
    lastFailure: lifecycleFailureSchema.nullable().default(null),
    claudeRateLimits: claudeRateLimitsSchema.nullable().default(null),
    containment: containmentSchema.nullable().default(null),
    updatedAt: timestampSchema
  });

export const agentLifecycleStateSchema = z
  .object({
    formatVersion: z.literal(AGENT_LIFECYCLE_FORMAT_VERSION),
    stateRevision: z.number().int().nonnegative(),
    agents: z.record(agentIdSchema, agentLifecycleEntrySchema),
    updatedAt: timestampSchema
  })
  .strict();

export type LifecycleAction = z.infer<typeof lifecycleActionSchema>;
export type AgentLifecycleEntry = z.infer<typeof agentLifecycleEntrySchema>;
export type AgentLifecycleState = z.infer<typeof agentLifecycleStateSchema>;

export type LifecycleFailure = z.infer<typeof lifecycleFailureSchema>;

/** Raw vendor failure fields, sanitized before persistence. */
export type ObservedFailure = FailureFields & { vendor: "claude" | "cursor"; status?: string };

export type LifecycleObservation = {
  /** `tool-start` opens a tool call and `tool-activity` closes one (or reports other activity); neither is a turn boundary. */
  kind: "session-start" | "session-end" | "prompt-submitted" | "tool-start" | "tool-activity" | "stopped" | "failed" | "status" | "telemetry";
  eventName: string;
  sessionId?: string;
  turnId?: string;
  actionId?: string;
  actionDigest?: string;
  actionPath?: string;
  failure?: ObservedFailure;
  /** Claude statusline rate limits; a render is telemetry, never activity. */
  rateLimits?: ClaudeRateLimits;
};

const emptyEntry = (now: string): AgentLifecycleEntry => ({
  action: null,
  sessionId: null,
  retiredSessionIds: [],
  freshSession: false,
  ready: null,
  toolActivity: { sequence: 0, pending: 0, at: null },
  health: "unknown",
  degradedCause: null,
  lastEvent: null,
  lastEventAt: null,
  hookReceipt: null,
  lastFailure: null,
  claudeRateLimits: null,
  containment: null,
  updatedAt: now
});

export const initialAgentLifecycle = (
  agents: readonly string[],
  now = new Date().toISOString()
): AgentLifecycleState =>
  agentLifecycleStateSchema.parse({
    formatVersion: AGENT_LIFECYCLE_FORMAT_VERSION,
    stateRevision: 0,
    agents: Object.fromEntries(agents.map((agent) => [agent, emptyEntry(now)])),
    updatedAt: now
  });

const parseLifecycleFile = (paths: IssueRuntimePaths): AgentLifecycleState => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.agentLifecycle, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Cannot parse ${paths.agentLifecycle}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const result = agentLifecycleStateSchema.safeParse(parsed);
  if (!result.success) throw new Error(`Invalid ${paths.agentLifecycle}: ${z.prettifyError(result.error)}`);
  return result.data;
};

export const initializeAgentLifecycle = (
  paths: IssueRuntimePaths,
  agents: readonly string[],
  now = new Date().toISOString()
): AgentLifecycleState => {
  if (existsSync(paths.agentLifecycle)) return parseLifecycleFile(paths);
  const state = initialAgentLifecycle(agents, now);
  atomicWriteJson(paths.coordRoot, paths.agentLifecycle, state);
  return state;
};

/** Old issue runtimes are adopted lazily without changing cursors.json. */
export const readAgentLifecycle = (paths: IssueRuntimePaths): AgentLifecycleState => {
  if (existsSync(paths.agentLifecycle)) return parseLifecycleFile(paths);
  return initializeAgentLifecycle(paths, readStartState(paths).originalRoster);
};

const lifecycleLockPath = (paths: IssueRuntimePaths): string => `${paths.agentLifecycle}.lock`;

export const mutateAgentLifecycle = (
  paths: IssueRuntimePaths,
  mutation: (current: AgentLifecycleState) => AgentLifecycleState
): AgentLifecycleState => {
  const lockPath = lifecycleLockPath(paths);
  const handle = acquireExclusiveLock(lockPath);
  try {
    const current = readAgentLifecycle(paths);
    const candidate = mutation(current);
    if (candidate === current) return current;
    const state = agentLifecycleStateSchema.parse({
      ...candidate,
      stateRevision: current.stateRevision + 1
    });
    atomicWriteJson(paths.coordRoot, paths.agentLifecycle, state);
    return state;
  } finally {
    closeSync(handle);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
};

const replaceEntry = (
  state: AgentLifecycleState,
  agent: string,
  entry: AgentLifecycleEntry,
  now: string
): AgentLifecycleState =>
  agentLifecycleStateSchema.parse({
    ...state,
    agents: { ...state.agents, [agent]: { ...entry, updatedAt: now } },
    updatedAt: now
  });

/** Hook telemetry cannot establish a session or accept workflow work. */
export const recordContainmentEvidence = (
  paths: IssueRuntimePaths, agent: string, patch: Partial<Containment>, now = new Date().toISOString()
): AgentLifecycleState => mutateAgentLifecycle(paths, (state) => {
  const entry = state.agents[agent];
  const sessionId = patch.probe?.sessionId ?? patch.hookDenial?.sessionId;
  if (!entry || !sessionId || entry.sessionId !== sessionId) return state;
  return replaceEntry(state, agent, { ...entry,
    containment: { hookDenial: null, probe: null, ...entry.containment, ...patch }
  }, now);
});

const unsentAction = (actionId: string, actionDigest: string, orderedAt: string): LifecycleAction => ({
  actionId,
  actionDigest,
  delivery: "ordered",
  orderedAt,
  injectedAt: null,
  acceptedAt: null,
  sessionId: null,
  turnId: null,
  workflowCompleteAt: null,
  sentHoldGeneration: null,
  resentAt: null,
  waitReportedAt: null,
  watch: null
});

export const orderAgentAction = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  actionDigest: string,
  now = new Date().toISOString()
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    if (current === undefined) throw new Error(`Unknown lifecycle agent ${agent}.`);
    if (
      current.action?.actionId === actionId &&
      current.action.actionDigest === actionDigest &&
      current.action.workflowCompleteAt === null
    ) {
      return state;
    }
    return replaceEntry(state, agent, { ...current, action: unsentAction(actionId, actionDigest, now) }, now);
  });

/** A send consumes the authority that allowed it: the ready receipt and a fresh session. */
export const markActionInjected = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  actionDigest: string,
  now = new Date().toISOString(),
  options: { holdGeneration?: number; resent?: boolean } = {}
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    const action = current?.action;
    if (current === undefined || action === null) return state;
    if (action.actionId !== actionId || action.actionDigest !== actionDigest) return state;
    // A prompt hook can win the race with tmux returning. Keep only an
    // acceptance observed during this injection attempt; an acceptance from a
    // prior send must not stand in for the newly typed copy.
    const acceptedDuringAttempt =
      action.delivery === "accepted" &&
      action.acceptedAt !== null &&
      Date.parse(action.acceptedAt) >= Date.parse(now);
    return replaceEntry(
      state,
      agent,
      {
        ...current,
        ready: null,
        freshSession: false,
        health: acceptedDuringAttempt ? "healthy" : "unknown",
        degradedCause: null,
        action: {
          ...action,
          delivery: acceptedDuringAttempt ? "accepted" : "injected",
          injectedAt: now,
          acceptedAt: acceptedDuringAttempt ? action.acceptedAt : null,
          sessionId: acceptedDuringAttempt ? action.sessionId : null,
          turnId: acceptedDuringAttempt ? action.turnId : null,
          sentHoldGeneration: options.holdGeneration ?? action.sentHoldGeneration,
          resentAt: options.resent === true ? now : action.resentAt
        }
      },
      now
    );
  });

/** Record a consumed ready receipt; the file itself is deleted by the caller. */
export const recordAgentReady = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  now = new Date().toISOString()
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    if (current === undefined || current.ready?.actionId === actionId) return state;
    return replaceEntry(state, agent, { ...current, ready: { actionId, at: now } }, now);
  });

/** Durable stall-watchdog bookkeeping for the current action only. */
export const updateActionWatch = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  actionDigest: string,
  patch: Partial<Pick<LifecycleAction, "watch" | "waitReportedAt">>,
  now = new Date().toISOString()
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    const action = current?.action;
    if (current === undefined || action == null || action.actionId !== actionId || action.actionDigest !== actionDigest) return state;
    return replaceEntry(state, agent, { ...current, action: { ...action, ...patch } }, now);
  });

/** `pickedUpByReread`: completed without any sent prompt, so the agent found it by rereading action.md. */
export type WorkflowCompleteResult = { state: AgentLifecycleState; clearedDegraded: boolean; pickedUpByReread: boolean };

/**
 * Workflow truth outranks observability. The agent published and pushed, so a
 * watchdog alert raised against this action is disproven: clear it, and record
 * that it was cleared so the operator sees the retraction.
 */
export const markActionWorkflowComplete = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  now = new Date().toISOString()
): WorkflowCompleteResult => {
  let clearedDegraded = false;
  let pickedUpByReread = false;
  const state = mutateAgentLifecycle(paths, (current0) => {
    const current = current0.agents[agent];
    if (current?.action?.actionId !== actionId) return current0;
    clearedDegraded = current.health === "degraded";
    pickedUpByReread = current.action.workflowCompleteAt === null &&
      current.action.delivery === "ordered" && current.action.injectedAt === null;
    return replaceEntry(
      current0,
      agent,
      {
        ...current,
        health: clearedDegraded ? "healthy" : current.health,
        degradedCause: clearedDegraded ? null : current.degradedCause,
        action: { ...current.action, workflowCompleteAt: now }
      },
      now
    );
  });
  return { state, clearedDegraded, pickedUpByReread };
};

const applyTelemetry = (
  entry: AgentLifecycleEntry,
  observation: LifecycleObservation,
  now: string
): AgentLifecycleEntry => {
  const sessionId = observation.sessionId ?? null;
  // A render never establishes a session, and never counts as activity.
  if (observation.rateLimits === undefined || sessionId === null || sessionId !== entry.sessionId) return entry;
  const identity = JSON.stringify(observation.rateLimits);
  const cached = entry.claudeRateLimits;
  if (cached?.sessionId === sessionId && cached.identity === identity) return entry;
  return agentLifecycleEntrySchema.parse({
    ...entry,
    claudeRateLimits: {
      sessionId, identity, observedAt: now,
      fiveHour: observation.rateLimits.fiveHour, sevenDay: observation.rateLimits.sevenDay
    }
  });
};

/**
 * Bind a failure to the current episode only through the accepted-session
 * correlation. Hook delivery time alone does not make an old event current.
 */
const recordFailure = (
  entry: AgentLifecycleEntry,
  failure: ObservedFailure,
  context: { action: LifecycleAction | null; sessionId: string | null; turnId: string | null; now: string }
): LifecycleFailure => {
  const { action, sessionId, turnId, now } = context;
  const correlated =
    action !== null &&
    action.workflowCompleteAt === null &&
    action.delivery === "accepted" &&
    sessionId !== null &&
    action.sessionId === sessionId &&
    (action.turnId === null || turnId === null || action.turnId === turnId);
  const fields: FailureFields = {
    error: redactDiagnostic(failure.error),
    errorDetails: redactDiagnostic(failure.errorDetails),
    lastAssistantMessage: redactDiagnostic(failure.lastAssistantMessage)
  };
  const telemetry = entry.claudeRateLimits === null ? null : {
    sessionId: entry.claudeRateLimits.sessionId,
    observedAt: entry.claudeRateLimits.observedAt,
    limits: { fiveHour: entry.claudeRateLimits.fiveHour, sevenDay: entry.claudeRateLimits.sevenDay }
  };
  const classification: Classification = failure.vendor === "claude"
    ? classifyClaudeFailure(fields, telemetry, { sessionId, now })
    : { failureClass: classifyCursorStatus(failure.status), classConfidence: "reported", windows: [],
      detail: redactDiagnostic([failure.status, fields.error, fields.errorDetails].filter((part) => part !== null && part !== undefined).join(" | ")),
      resetsAt: null };
  const actionId = correlated ? action.actionId : null;
  const episodeId = `${actionId ?? "advisory"}:${sessionId ?? "none"}:${turnId ?? action?.turnId ?? "none"}:${classification.failureClass}`;
  // A duplicate delivery of the same episode keeps its original observation.
  if (entry.lastFailure?.evidence.episodeId === episodeId) return entry.lastFailure;
  return lifecycleFailureSchema.parse({
    evidence: {
      vendor: failure.vendor,
      failureClass: classification.failureClass,
      classConfidence: classification.classConfidence,
      windows: classification.windows,
      detail: classification.detail,
      episodeId,
      observedAt: now
    },
    resetsAt: classification.resetsAt,
    ...fields,
    sessionId,
    turnId,
    actionId
  });
};

/** Apply a validated vendor observation. Duplicate and stale events are harmless. */
export const applyLifecycleObservation = (
  entry: AgentLifecycleEntry,
  observation: LifecycleObservation,
  now = new Date().toISOString()
): AgentLifecycleEntry => {
  const incomingSession = observation.sessionId ?? null;
  const sessionChanged =
    incomingSession !== null && entry.sessionId !== null && incomingSession !== entry.sessionId;
  const beginsSession =
    observation.kind === "session-start" ||
    observation.kind === "status";

  if (incomingSession !== null && entry.retiredSessionIds.includes(incomingSession)) return entry;

  // Only an explicit startup callback (or Antigravity's continuously emitted
  // status payload) may replace an established session. A delayed prompt,
  // tool, or stop event from the previous process must not become current
  // merely because it carries the action UUID.
  if (sessionChanged && !beginsSession) return entry;

  if (observation.kind === "telemetry") return applyTelemetry(entry, observation, now);

  // Tool hooks are watchdog activity only: they never touch delivery or health.
  if (observation.kind === "tool-start" || observation.kind === "tool-activity") {
    const { sequence, pending } = entry.toolActivity;
    return agentLifecycleEntrySchema.parse({ ...entry, toolActivity: {
      sequence: sequence + 1,
      pending: observation.kind === "tool-start" ? pending + 1 : Math.max(0, pending - 1),
      at: now
    } });
  }

  const newSession = sessionChanged || (entry.sessionId === null && incomingSession !== null);
  const sessionId = incomingSession ?? entry.sessionId;
  const retiredSessionIds = sessionChanged
    ? [...new Set([...entry.retiredSessionIds, entry.sessionId as string])].slice(-16)
    : entry.retiredSessionIds;
  let action = entry.action;
  // A replacement process never received the previous session's prompt.
  if (sessionChanged && action !== null && action.workflowCompleteAt === null) {
    action = unsentAction(action.actionId, action.actionDigest, action.orderedAt);
  }
  // A delayed first SessionStart after a send is not a fresh session: that prompt may already be running in it.
  const sentUnfinished = action !== null && action.delivery !== "ordered" && action.workflowCompleteAt === null;
  let freshSession = beginsSession && newSession && !sentUnfinished ? true : entry.freshSession;

  if (observation.kind === "prompt-submitted") {
    freshSession = false;
    if (
      action !== null &&
      observation.actionId === action.actionId &&
      observation.actionDigest === action.actionDigest
    ) {
      // Delivery acknowledgment is recorded for display; it never gates a send.
      action = { ...action, delivery: "accepted", acceptedAt: now, sessionId, turnId: observation.turnId ?? null };
    }
  }

  // A tool call cannot outlive its turn or process, even when its end hook never fired.
  const endsTools = ["stopped", "failed", "session-start", "session-end"].includes(observation.kind);
  const toolActivity = endsTools || sessionChanged ? { ...entry.toolActivity, pending: 0 } : entry.toolActivity;
  const lastFailure = observation.failure === undefined
    ? entry.lastFailure
    : recordFailure(entry, observation.failure, { action, sessionId, turnId: observation.turnId ?? null, now });
  return agentLifecycleEntrySchema.parse({
    ...entry,
    lastFailure,
    containment: sessionChanged ? null : entry.containment,
    action,
    sessionId,
    retiredSessionIds,
    freshSession,
    toolActivity,
    health: "healthy",
    degradedCause: null,
    lastEvent: observation.eventName,
    lastEventAt: now,
    updatedAt: now
  });
};

const semanticallyEqual = (left: AgentLifecycleEntry, right: AgentLifecycleEntry): boolean => {
  const normalize = (entry: AgentLifecycleEntry) => ({ ...entry, updatedAt: "", lastEventAt: null });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

export type LifecycleObservationResult = { changed: boolean; state: AgentLifecycleState };

export const observeAgentLifecycleWithResult = (
  paths: IssueRuntimePaths,
  agent: string,
  observation: LifecycleObservation,
  now = new Date().toISOString()
): LifecycleObservationResult => {
  let changed = false;
  const state = mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    if (current === undefined) throw new Error(`Unknown lifecycle agent ${agent}.`);
    const next = applyLifecycleObservation(current, observation, now);
    // An unchanged status render is not activity.
    if (observation.kind === "status" && next !== current && semanticallyEqual(current, next)) return state;
    const expectedAfter = current.action?.injectedAt ?? current.action?.orderedAt ?? null;
    const heartbeatNeeded =
      expectedAfter !== null &&
      (current.lastEventAt === null || Date.parse(current.lastEventAt) < Date.parse(expectedAfter));
    changed = next !== current && (!semanticallyEqual(current, next) || heartbeatNeeded);
    // Status-bar telemetry and tool callbacks are not lifecycle hooks: a tool
    // callback can describe the very command that wrote ready.
    const toolOrTelemetry = observation.kind === "telemetry" || observation.kind === "tool-start" || observation.kind === "tool-activity";
    const hookReceipt = toolOrTelemetry ? current.hookReceipt : {
      at: new Date(Math.max(Date.parse(now), Date.parse(current.hookReceipt?.at ?? current.lastEventAt ?? now))).toISOString(),
      sequence: (current.hookReceipt?.sequence ?? 0) + 1
    };
    if (!changed && hookReceipt === current.hookReceipt) return state;
    const effective = changed ? next : current;
    return replaceEntry(state, agent, { ...effective, hookReceipt }, now);
  });
  return { changed, state };
};

export const observeAgentLifecycle = (
  paths: IssueRuntimePaths,
  agent: string,
  observation: LifecycleObservation,
  now = new Date().toISOString()
): AgentLifecycleState => observeAgentLifecycleWithResult(paths, agent, observation, now).state;

export type DegradedCause = "hooks-never-seen" | "correlation-lagged";

export type ObservabilityDegradeResult = {
  changed: boolean;
  state: AgentLifecycleState;
  cause: DegradedCause | null;
};

/**
 * @deprecated Retained for legacy-state fixtures only. The coordinator must not
 * degrade agent health merely because lifecycle events are missing.
 */
export const markObservabilityDegraded = (
  paths: IssueRuntimePaths,
  agent: string,
  now = new Date().toISOString(),
  watchdogMs = AGENT_OBSERVABILITY_WATCHDOG_MS
): ObservabilityDegradeResult => {
  let changed = false;
  let cause: DegradedCause | null = null;
  const state = mutateAgentLifecycle(paths, (current) => {
    const entry = current.agents[agent];
    const action = entry?.action;
    if (entry === undefined || action === null || entry.health === "degraded") return current;
    if (action.workflowCompleteAt !== null) return current;
    const expectedAfter = action.injectedAt ?? action.orderedAt;
    if (entry.lastEventAt !== null && Date.parse(entry.lastEventAt) >= Date.parse(expectedAfter)) return current;
    const elapsed = Date.parse(now) - Date.parse(expectedAfter);
    if (!Number.isFinite(elapsed) || elapsed < watchdogMs) return current;
    changed = true;
    cause = entry.lastEvent === null && entry.sessionId === null ? "hooks-never-seen" : "correlation-lagged";
    return replaceEntry(current, agent, { ...entry, health: "degraded", degradedCause: cause }, now);
  });
  return { changed, state, cause };
};
