import { closeSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { z } from "zod";
import { digestSchema, agentIdSchema } from "./protocol.js";
import type { IssueRuntimePaths } from "./paths.js";
import { acquireExclusiveLock, atomicWriteJson, readStartState } from "./state.js";

/** Independent from the workflow runtime format: hook traffic is not workflow authority. */
export const AGENT_LIFECYCLE_FORMAT_VERSION = 1;
export const AGENT_OBSERVABILITY_WATCHDOG_MS = 45_000;
export const observabilityDegradedCauseSchema = z.enum(["hooks-never-seen", "correlation-lagged"]);
export type ObservabilityDegradedCause = z.infer<typeof observabilityDegradedCauseSchema>;

const timestampSchema = z.string().datetime({ offset: true });

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
    degradedCause: observabilityDegradedCauseSchema.nullable().default(null),
    lastEvent: z.string().min(1).nullable(),
    lastEventAt: timestampSchema.nullable(),
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

export type LifecycleObservation = {
  kind: "session-start" | "session-end" | "prompt-submitted" | "working" | "stopped" | "failed" | "status";
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

export const markActionWorkflowComplete = (
  paths: IssueRuntimePaths,
  agent: string,
  actionId: string,
  now = new Date().toISOString()
): { state: AgentLifecycleState; clearedDegraded: boolean } => {
  let clearedDegraded = false;
  const state = mutateAgentLifecycle(paths, (state) => {
    const current = state.agents[agent];
    if (current?.action?.actionId !== actionId) return state;
    clearedDegraded = current.health === "degraded";
    return replaceEntry(
      state,
      agent,
      {
        ...current,
        health: clearedDegraded ? "healthy" : current.health,
        degradedCause: null,
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
        acceptedAt: action.acceptedAt ?? now,
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
  return agentLifecycleEntrySchema.parse({
    ...entry,
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
    if (next === current) return state;
    const expectedAfter = current.action?.injectedAt ?? current.action?.orderedAt ?? null;
    const heartbeatNeeded =
      expectedAfter !== null &&
      (current.lastEventAt === null || Date.parse(current.lastEventAt) < Date.parse(expectedAfter));
    if (semanticallyEqual(current, next) && !heartbeatNeeded) return state;
    changed = true;
    return replaceEntry(state, agent, next, now);
  });
  return { changed, state };
};

export const observeAgentLifecycle = (
  paths: IssueRuntimePaths,
  agent: string,
  observation: LifecycleObservation,
  now = new Date().toISOString()
): AgentLifecycleState => observeAgentLifecycleWithResult(paths, agent, observation, now).state;

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
  | { kind: "wait"; reason: NudgeWaitCode; code: NudgeWaitCode };

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
    return { kind: "wait", reason: entry.execution, code: entry.execution };
  }
  if (action.lastNudgedIdleEpoch === entry.idleEpoch) {
    return {
      kind: "wait",
      reason: "idle-transition-already-used",
      code: "idle-transition-already-used"
    };
  }
  return { kind: "send", reason: "eligible-idle", code: "eligible-idle" };
};

export const markObservabilityDegraded = (
  paths: IssueRuntimePaths,
  agent: string,
  now = new Date().toISOString(),
  watchdogMs = AGENT_OBSERVABILITY_WATCHDOG_MS
): { changed: boolean; state: AgentLifecycleState; cause: ObservabilityDegradedCause | null } => {
  let changed = false;
  let cause: ObservabilityDegradedCause | null = null;
  const state = mutateAgentLifecycle(paths, (current) => {
    const entry = current.agents[agent];
    const action = entry?.action;
    if (
      entry === undefined ||
      action === null ||
      action.workflowCompleteAt !== null ||
      entry.health === "degraded"
    ) {
      return current;
    }
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
