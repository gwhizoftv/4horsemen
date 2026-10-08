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
    retryableInjectionAt: timestampSchema.nullable().default(null),
    acceptedAt: timestampSchema.nullable(),
    sessionId: z.string().min(1).nullable(),
    turnId: z.string().min(1).nullable(),
    lastNudgedIdleEpoch: z.number().int().nonnegative().nullable(),
    workflowCompleteAt: timestampSchema.nullable()
  })
  .strict();

const diagnosticSchema = z.string().max(DIAGNOSTIC_MAX_BYTES).nullable();

const emptyStopObservation = () => ({ turns: [] as string[], completedActions: [] as string[], stoppedActionId: null as string | null });
const stopObservationSchema = z.object({
  turns: z.array(z.string()).max(128), completedActions: z.array(z.string()).max(128), stoppedActionId: z.string().nullable()
}).default(emptyStopObservation);

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
    execution: z.enum(["unknown", "queued", "working", "idle", "failed"]),
    sessionId: z.string().min(1).nullable(),
    retiredSessionIds: z.array(z.string().min(1)).max(16).default([]),
    turnId: z.string().min(1).nullable(),
    pendingInputCount: z.number().int().nonnegative().nullable(),
    backgroundActive: z.boolean().nullable(),
    idleEpoch: z.number().int().nonnegative(),
    health: z.enum(["unknown", "healthy", "degraded"]),
    /** Why health degraded, so the operator message names what was observed. */
    degradedCause: z.enum(["hooks-never-seen", "correlation-lagged"]).nullable().default(null),
    lastEvent: z.string().min(1).nullable(),
    lastEventAt: timestampSchema.nullable(),
    /** Advisory only: never used to decide readiness or workflow authority. */
    stopObservation: stopObservationSchema,
    /** Activity-hook receipt, independent of semantic deduplication and telemetry. */
    hookReceipt: z.object({ at: timestampSchema, sequence: z.number().int().nonnegative() }).nullable().default(null),
    lastFailure: lifecycleFailureSchema.nullable().default(null),
    claudeRateLimits: claudeRateLimitsSchema.nullable().default(null),
    containment: containmentSchema.nullable().default(null),
    updatedAt: timestampSchema
  })
  .strict();

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
  kind: "session-start" | "session-end" | "prompt-submitted" | "working" | "stopped" | "failed" | "status" | "telemetry";
  eventName: string;
  sessionId?: string;
  turnId?: string;
  actionId?: string;
  actionDigest?: string;
  actionPath?: string;
  execution?: "unknown" | "queued" | "working" | "idle" | "failed";
  pendingInputCount?: number;
  backgroundActive?: boolean;
  /** Vendor proves a fully-idle stop even without a prompt-submit hook. */
  allowInjectedIdle?: boolean;
  failure?: ObservedFailure;
  /** Claude statusline rate limits; a render is telemetry, never activity. */
  rateLimits?: ClaudeRateLimits;
};

const emptyEntry = (now: string): AgentLifecycleEntry => ({
  action: null,
  execution: "unknown",
  sessionId: null,
  retiredSessionIds: [],
  turnId: null,
  pendingInputCount: null,
  backgroundActive: null,
  idleEpoch: 0,
  health: "unknown",
  degradedCause: null,
  lastEvent: null,
  lastEventAt: null,
  stopObservation: emptyStopObservation(),
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
    return replaceEntry(
      state,
      agent,
      {
        ...current,
        action: {
          actionId,
          actionDigest,
          delivery: "ordered",
          orderedAt: now,
          injectedAt: null,
          retryableInjectionAt: null,
          acceptedAt: null,
          sessionId: null,
          turnId: null,
          lastNudgedIdleEpoch: null,
          workflowCompleteAt: null
        }
      },
      now
    );
  });

export const markActionInjected = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  actionDigest: string,
  now = new Date().toISOString()
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    const action = current?.action;
    if (current === undefined || action === null) return state;
    if (action.actionId !== actionId || action.actionDigest !== actionDigest) return state;
    // A prompt hook can win the race with tmux returning. Keep only an
    // acceptance observed during this injection attempt; an acceptance from a
    // prior stopped turn must not stand in for the newly queued copy.
    const acceptedDuringAttempt =
      action.delivery === "accepted" &&
      action.acceptedAt !== null &&
      Date.parse(action.acceptedAt) >= Date.parse(now);
    return replaceEntry(
      state,
      agent,
      {
        ...current,
        health: acceptedDuringAttempt ? "healthy" : "unknown",
        degradedCause: null,
        action: {
          ...action,
          delivery: acceptedDuringAttempt ? "accepted" : "injected",
          injectedAt: now,
          retryableInjectionAt: null,
          acceptedAt: acceptedDuringAttempt ? action.acceptedAt : null,
          sessionId: acceptedDuringAttempt ? action.sessionId : null,
          turnId: acceptedDuringAttempt ? action.turnId : null,
          lastNudgedIdleEpoch: current.idleEpoch
        }
      },
      now
    );
  });

/** A ready pane that no longer contains the correlated prompt proves the send was lost. */
export const markInjectedActionAbsent = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  actionDigest: string,
  now = new Date().toISOString()
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    const action = current?.action;
    if (
      current === undefined ||
      action === null ||
      action.actionId !== actionId ||
      action.actionDigest !== actionDigest ||
      action.delivery !== "injected" ||
      action.turnId !== null
    ) {
      return state;
    }
    return replaceEntry(
      state,
      agent,
      {
        ...current,
        action: {
          ...action,
          delivery: "ordered",
          injectedAt: null,
          retryableInjectionAt: now,
          acceptedAt: null,
          sessionId: null,
          turnId: null
        }
      },
      now
    );
  });

/** Record a tmux readiness rejection; unlike elapsed time, this permits retry. */
export const markActionInjectionDeferred = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  actionDigest: string,
  now = new Date().toISOString()
): AgentLifecycleState =>
  mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    const action = current?.action;
    if (
      current === undefined ||
      action === null ||
      action.actionId !== actionId ||
      action.actionDigest !== actionDigest ||
      action.delivery !== "ordered"
    ) {
      return state;
    }
    return replaceEntry(
      state,
      agent,
      { ...current, action: { ...action, retryableInjectionAt: now } },
      now
    );
  });

export type WorkflowCompleteResult = { state: AgentLifecycleState; clearedDegraded: boolean };

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
  const state = mutateAgentLifecycle(paths, (current0) => {
    const current = current0.agents[agent];
    if (current?.action?.actionId !== actionId) return current0;
    clearedDegraded = current.health === "degraded";
    return replaceEntry(
      current0,
      agent,
      {
        ...current,
        stopObservation: current.action.workflowCompleteAt === null && current.stopObservation.stoppedActionId !== actionId
          ? { ...current.stopObservation, completedActions: [...new Set([...current.stopObservation.completedActions, actionId])].slice(-128) }
          : current.stopObservation,
        health: clearedDegraded ? "healthy" : current.health,
        degradedCause: clearedDegraded ? null : current.degradedCause,
        action: { ...current.action, workflowCompleteAt: now }
      },
      now
    );
  });
  return { state, clearedDegraded };
};

const positiveIdle = (entry: AgentLifecycleEntry, nextExecution: AgentLifecycleEntry["execution"]): number =>
  (nextExecution === "idle" || nextExecution === "failed") &&
  entry.execution !== "idle" &&
  entry.execution !== "failed"
    ? entry.idleEpoch + 1
    : entry.idleEpoch;

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

  let stopObservation = sessionChanged || (entry.sessionId === null && incomingSession !== null)
    ? emptyStopObservation() : entry.stopObservation;
  if (observation.kind === "prompt-submitted") {
    stopObservation = { ...stopObservation, stoppedActionId: null,
      turns: observation.turnId === undefined ? stopObservation.turns
        : [...new Set([...stopObservation.turns, observation.turnId])].slice(-128) };
  }
  if (observation.kind === "stopped" && incomingSession !== null && incomingSession === entry.sessionId &&
      ((stopObservation.turns.at(-1) ?? entry.turnId) === null ||
        observation.turnId === (stopObservation.turns.at(-1) ?? entry.turnId)) &&
      (entry.action?.turnId == null || observation.turnId === entry.action.turnId)) {
    stopObservation = { ...emptyStopObservation(), stoppedActionId: entry.action?.actionId ?? null };
  }

  let action = entry.action;
  let execution = observation.execution ?? entry.execution;
  let turnId = observation.turnId ?? (sessionChanged ? null : entry.turnId);
  const sessionId = incomingSession ?? entry.sessionId;
  const retiredSessionIds = sessionChanged
    ? [...new Set([...entry.retiredSessionIds, entry.sessionId as string])].slice(-16)
    : entry.retiredSessionIds;
  let pendingInputCount = observation.pendingInputCount ?? entry.pendingInputCount;
  let backgroundActive = observation.backgroundActive ?? entry.backgroundActive;

  if (sessionChanged) {
    if (action !== null && action.workflowCompleteAt === null) {
      action = {
        ...action,
        delivery: "ordered",
        injectedAt: null,
        retryableInjectionAt: null,
        acceptedAt: null,
        sessionId: null,
        turnId: null,
        lastNudgedIdleEpoch: null
      };
    }
    // SessionStart carries no activity fields and therefore establishes idle.
    // Antigravity status-line does carry them; never erase the queue/activity
    // values from the very observation that announced the replacement.
    execution = observation.execution ?? "idle";
    pendingInputCount = observation.pendingInputCount ?? 0;
    backgroundActive = observation.backgroundActive ?? false;
  } else if (observation.kind === "session-start") {
    // A delayed startup callback may arrive after tmux already injected the
    // first prompt. Establish health/session identity without reopening that
    // delivery for a duplicate nudge.
    if (action === null || action.delivery === "ordered") {
      execution = "idle";
      pendingInputCount = 0;
      backgroundActive = false;
    }
  }

  if (observation.kind === "prompt-submitted") {
    execution = "working";
    pendingInputCount = Math.max(0, (pendingInputCount ?? 1) - 1);
    if (
      action !== null &&
      observation.actionId === action.actionId &&
      observation.actionDigest === action.actionDigest
    ) {
      action = {
        ...action,
        delivery: "accepted",
        acceptedAt: now,
        sessionId,
        turnId: observation.turnId ?? null
      };
    }
  }

  if (observation.kind === "working") execution = "working";
  if (observation.kind === "failed") {
    const injectedAwaitingAcceptance =
      action?.delivery === "injected" && action.turnId === null && observation.allowInjectedIdle !== true;
    execution =
      injectedAwaitingAcceptance || (pendingInputCount ?? 0) > 0 || backgroundActive === true
        ? "queued"
        : "failed";
  }
  if (observation.kind === "session-end") execution = "failed";

  if (observation.kind === "stopped") {
    const currentActionTurn = action?.turnId ?? null;
    const stoppedTurn = observation.turnId ?? null;
    const stoppingOlderTurn =
      currentActionTurn !== null && stoppedTurn !== null && currentActionTurn !== stoppedTurn;
    const injectedAwaitingAcceptance =
      action?.delivery === "injected" && action.turnId === null && observation.allowInjectedIdle !== true;
    if (
      (pendingInputCount ?? 0) > 0 ||
      backgroundActive === true ||
      stoppingOlderTurn ||
      injectedAwaitingAcceptance
    ) {
      execution = "queued";
    } else {
      execution = "idle";
      turnId = null;
    }
  }

  if (observation.kind === "status") {
    if ((pendingInputCount ?? 0) > 0 || backgroundActive === true) execution = "queued";
  }

  const idleEpoch = positiveIdle(entry, execution);
  const lastFailure = observation.failure === undefined
    ? entry.lastFailure
    : recordFailure(entry, observation.failure, { action, sessionId, turnId: observation.turnId ?? null, now });
  return agentLifecycleEntrySchema.parse({
    ...entry,
    lastFailure,
    stopObservation,
    containment: sessionChanged || observation.kind === "session-end" ? null : entry.containment,
    action,
    execution,
    sessionId,
    retiredSessionIds,
    turnId,
    pendingInputCount,
    backgroundActive,
    idleEpoch,
    health: "healthy",
    degradedCause: null,
    lastEvent: observation.eventName,
    lastEventAt: now,
    updatedAt: now
  });
};

/** Missing Stop callbacks are an observability warning, not evidence of failure or idle. */
export const stopObservationWarning = (agent: string, entry: AgentLifecycleEntry): string | null => {
  const observed = entry.stopObservation;
  if (observed.turns.length >= 2) return `No Stop hook from ${agent} after ${observed.turns.length === 128 ? "at least " : ""}${observed.turns.length} observed turns; inspect its hook setup and current issue environment.`;
  if (observed.completedActions.length >= 2) return `No Stop confirmation from ${agent} after ${observed.completedActions.length === 128 ? "at least " : ""}${observed.completedActions.length} completed actions; turn identity may be unavailable; inspect its hook setup.`;
  return null;
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
    // An unchanged, explicitly fully idle status is a render, not activity or
    // a heartbeat for a newly ordered action. Other statuses (including repeated
    // working/unknown reports) still revoke ready, as do session/queue changes.
    if (observation.kind === "status" && observation.execution === "idle" &&
      observation.pendingInputCount === 0 && observation.backgroundActive === false &&
      next !== current && semanticallyEqual(current, next)) return state;
    const expectedAfter = current.action?.injectedAt ?? current.action?.orderedAt ?? null;
    const heartbeatNeeded =
      expectedAfter !== null &&
      (current.lastEventAt === null || Date.parse(current.lastEventAt) < Date.parse(expectedAfter));
    changed = next !== current && (!semanticallyEqual(current, next) || heartbeatNeeded);
    // Status-bar telemetry is not an activity hook: idle renders must not revoke
    // ready. Every remaining callback counts even when semantic deduplication (or
    // stale-session rejection) leaves execution unchanged.
    const hookReceipt = observation.kind === "telemetry" ? current.hookReceipt : {
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

/** Every reason delivery can be held back, as a closed union. */
export type NudgeWaitCode =
  | "unmatched-action"
  | "workflow-complete"
  | "pending-input"
  | "background-active"
  | "unknown"
  | "queued"
  | "working"
  | "idle-transition-already-used";

export type NudgeDecision =
  | { kind: "send"; reason: "eligible-idle"; code: "eligible-idle" }
  | { kind: "wait"; reason: string; code: NudgeWaitCode };

export const decideLifecycleNudge = (
  entry: AgentLifecycleEntry,
  actionId: string,
  actionDigest: string
): NudgeDecision => {
  const action = entry.action;
  if (action === null || action.actionId !== actionId || action.actionDigest !== actionDigest) {
    return { kind: "wait", reason: "unmatched-action", code: "unmatched-action" };
  }
  if (action.workflowCompleteAt !== null) {
    return { kind: "wait", reason: "workflow-complete", code: "workflow-complete" };
  }
  if (entry.pendingInputCount !== null && entry.pendingInputCount > 0) {
    return { kind: "wait", reason: "pending-input", code: "pending-input" };
  }
  if (entry.backgroundActive === true) {
    return { kind: "wait", reason: "background-active", code: "background-active" };
  }
  if (entry.execution !== "idle" && entry.execution !== "failed") {
    // `failed` is an eligible idle state below; the rest are wait codes.
    return { kind: "wait", reason: entry.execution, code: entry.execution };
  }
  if (action.lastNudgedIdleEpoch === entry.idleEpoch) {
    return { kind: "wait", reason: "idle-transition-already-used", code: "idle-transition-already-used" };
  }
  return { kind: "send", reason: "eligible-idle", code: "eligible-idle" };
};

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
