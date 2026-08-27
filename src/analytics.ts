import type { JournalEvent } from "./state.js";
import { RUNTIME_FORMAT_VERSION } from "./state.js";
import { readCursorHookUsage } from "./cursorHookUsage.js";
import {
  readTranscript,
  type AnalyticsCoverage,
  type TokenUsage,
  type TranscriptReadResult,
  type TranscriptVendor,
  type UsageVendor
} from "./transcriptRead.js";

export type MetricState = "complete" | "in-progress" | "invalid";

export type AnalyticsStart = {
  issue: number;
  originalRoster: readonly string[];
  createdAt: string;
};

export type FinalCheckAnalytics = {
  at: string;
  agent: string | null;
  name: string;
  tier: string;
  exitCode: number | null;
  durationMs: number | null;
};

export type AnalyticsSource = {
  formatVersion: number;
  legacy: boolean;
  skippedJournalRecords: number;
};

export type PhaseAnalytics = {
  index: number;
  name: string;
  round: number | null;
  startedAt: string;
  endedAt: string;
  durationMs: number | null;
  state: MetricState;
  actions: number;
};

export type WaitAnalytics = {
  agent: string;
  count: number;
  medianMs: number | null;
  maxMs: number | null;
};

export type IntervalAnalytics = {
  count: number;
  medianMs: number | null;
  maxMs: number | null;
};

export type PhaseUsageAnalytics = {
  phaseIndex: number;
  phase: string;
  round: number | null;
  tokens: TokenUsage | null;
  toolCalls: number | null;
  tokenCoverage: AnalyticsCoverage;
  toolCoverage: AnalyticsCoverage;
};

export type AgentUsageAnalytics = {
  agent: string;
  vendor: UsageVendor | null;
  tokenCoverage: AnalyticsCoverage;
  tokenReason: string | null;
  toolCoverage: AnalyticsCoverage;
  toolReason: string | null;
  phases: PhaseUsageAnalytics[];
  unassigned: {
    tokens: TokenUsage;
    toolCalls: number;
    records: number;
    tokenRecords: number;
    toolRecords: number;
  };
};

export type AnalyticsReport = {
  issue: number;
  phaseCount: number;
  run: {
    startedAt: string;
    endedAt: string;
    durationMs: number | null;
    pausedMs: number | null;
    unpausedMs: number | null;
    state: MetricState;
  };
  phases: PhaseAnalytics[];
  waits: WaitAnalytics[];
  /** Agent ballot/response wait: nudged → response-accepted (excludes publication). */
  responseLatency: WaitAnalytics[];
  /** Coordinator evidence publication: ballot-batch-pending → published (retries do not add agent turns). */
  evidencePublicationLatency: IntervalAnalytics;
  finalChecks: FinalCheckAnalytics[];
  source: AnalyticsSource;
  usage: {
    agents: AgentUsageAnalytics[];
    tokenTotal: TokenUsage | null;
    tokenTotalReason: string | null;
  } | null;
};

type JsonObject = Record<string, unknown>;
type ActionTurn = {
  actionId: string;
  agent: string;
  sessionId: string;
  turnId: string;
  startedMs: number;
  endedMs: number | null;
  phaseIndex: number | null;
};

const object = (value: unknown): JsonObject | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
const string = (value: unknown): string | null => (typeof value === "string" && value !== "" ? value : null);
const integer = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);
const milliseconds = (value: string): number | null => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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

const coverageRank: Record<AnalyticsCoverage, number> = {
  complete: 0,
  partial: 1,
  unsupported: 2,
  unavailable: 3
};

const combineTranscriptCoverage = (
  results: readonly TranscriptReadResult[],
  metric: "tokenCoverage" | "toolCoverage"
): AnalyticsCoverage => {
  if (results.length === 0 || results.every((result) => result[metric] === "unavailable")) return "unavailable";
  if (results.every((result) => result[metric] === "unsupported" || result[metric] === "unavailable")) {
    return results.some((result) => result[metric] === "unsupported") ? "unsupported" : "unavailable";
  }
  if (results.some((result) => result[metric] !== "complete")) return "partial";
  return "complete";
};

const worseCoverage = (left: AnalyticsCoverage, right: AnalyticsCoverage): AnalyticsCoverage =>
  coverageRank[left] >= coverageRank[right] ? left : right;

const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)] ?? null;
};

const phaseIndexAt = (phases: readonly PhaseAnalytics[], at: string): number | null => {
  const target = milliseconds(at);
  if (target === null) return null;
  for (const phase of phases) {
    const start = milliseconds(phase.startedAt);
    const end = milliseconds(phase.endedAt);
    if (start !== null && end !== null && target >= start && (target < end || phase.index === phases.length - 1 && target === end)) {
      return phase.index;
    }
  }
  return null;
};

const derivePhases = (start: AnalyticsStart, journal: readonly JournalEvent[], now: string): PhaseAnalytics[] => {
  const started = journal.find((event) => event.type === "started")?.at ?? start.createdAt;
  const gates = journal.filter((event) => event.type === "gate-advanced");
  const phases: PhaseAnalytics[] = [];
  let phaseStart = started;
  let activeName: string | null = "R1.join";
  let activeRound: number | null = null;
  for (const gate of gates) {
    const details = object(gate.details);
    const name = string(details?.from);
    if (name === null) continue;
    const startMs = milliseconds(phaseStart);
    const endMs = milliseconds(gate.at);
    const valid = startMs !== null && endMs !== null && endMs >= startMs;
    phases.push({
      index: phases.length,
      name,
      round: name.startsWith("R6.") ? activeRound : null,
      startedAt: phaseStart,
      endedAt: gate.at,
      durationMs: valid ? endMs - startMs : null,
      state: valid ? "complete" : "invalid",
      actions: 0
    });
    phaseStart = gate.at;
    activeName = string(details?.to);
    activeRound = activeName?.startsWith("R6.") === true ? integer(details?.round) : null;
  }
  if (activeName !== null) {
    const startMs = milliseconds(phaseStart);
    const endMs = milliseconds(now);
    const valid = startMs !== null && endMs !== null && endMs >= startMs;
    phases.push({
      index: phases.length,
      name: activeName,
      round: activeName.startsWith("R6.") ? activeRound : null,
      startedAt: phaseStart,
      endedAt: now,
      durationMs: valid ? endMs - startMs : null,
      state: valid ? "in-progress" : "invalid",
      actions: 0
    });
  }
  for (const event of journal) {
    if (event.type !== "action-prepared") continue;
    const index = phaseIndexAt(phases, event.at);
    if (index !== null && phases[index] !== undefined) phases[index].actions += 1;
  }
  return phases;
};

const deriveActionTurns = (journal: readonly JournalEvent[], phases: readonly PhaseAnalytics[]): ActionTurn[] => {
  const preparedPhase = new Map<string, number | null>();
  for (const event of journal) {
    if (event.type === "action-prepared" && event.actionId !== undefined) {
      preparedPhase.set(event.actionId, phaseIndexAt(phases, event.at));
    }
  }

  const lifecycle = journal.filter((event) => event.type === "agent-lifecycle");
  const turns: ActionTurn[] = [];
  const seen = new Set<string>();
  for (const event of lifecycle) {
    if (event.agent === undefined || event.actionId === undefined) continue;
    const details = object(event.details);
    if (details?.kind !== "prompt-submitted") continue;
    const sessionId = string(details.sessionId);
    const turnId = string(details.turnId);
    const startedMs = milliseconds(event.at);
    if (sessionId === null || turnId === null || startedMs === null) continue;
    const key = `${event.agent}\u0000${event.actionId}\u0000${sessionId}\u0000${turnId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const stopped = lifecycle.find((candidate) => {
      if (candidate.agent !== event.agent || candidate.sequence <= event.sequence) return false;
      const candidateDetails = object(candidate.details);
      return (
        candidateDetails?.kind === "stopped" &&
        string(candidateDetails.sessionId) === sessionId &&
        string(candidateDetails.turnId) === turnId
      );
    });
    turns.push({
      actionId: event.actionId,
      agent: event.agent,
      sessionId,
      turnId,
      startedMs,
      endedMs: stopped === undefined ? null : milliseconds(stopped.at),
      phaseIndex: preparedPhase.get(event.actionId) ?? null
    });
  }
  return turns;
};

const resolveSharedTurnPhase = (
  matching: readonly ActionTurn[],
  sessionId: string,
  singleWindowExact: boolean
): { phaseIndex: number | null; exact: boolean; sharedTurn: boolean } => {
  if (matching.length === 0) return { phaseIndex: null, exact: false, sharedTurn: false };
  if (matching.length === 1) {
    const phaseIndex = matching[0]?.phaseIndex ?? null;
    return { phaseIndex, exact: phaseIndex !== null && singleWindowExact, sharedTurn: false };
  }
  const turnIds = new Set(matching.map((turn) => turn.turnId));
  if (turnIds.size !== 1 || matching.some((turn) => turn.sessionId !== sessionId)) {
    return { phaseIndex: null, exact: false, sharedTurn: false };
  }
  const latest = matching.reduce((best, turn) => (turn.startedMs > best.startedMs ? turn : best));
  return { phaseIndex: latest.phaseIndex ?? null, exact: false, sharedTurn: true };
};

const derivePauseIntervals = (
  journal: readonly JournalEvent[],
  runStartMs: number | null,
  runEndMs: number | null
): number | null => {
  if (runStartMs === null || runEndMs === null || runEndMs < runStartMs) return null;
  let paused = false;
  let pauseStart: number | null = null;
  let totalPaused = 0;
  for (const event of journal) {
    const at = milliseconds(event.at);
    if (at === null) continue;
    if (event.type === "paused") {
      if (!paused) {
        paused = true;
        pauseStart = Math.max(at, runStartMs);
      }
    } else if (event.type === "resumed") {
      if (paused && pauseStart !== null) {
        totalPaused += Math.max(0, Math.min(at, runEndMs) - pauseStart);
        paused = false;
        pauseStart = null;
      }
    }
  }
  if (paused && pauseStart !== null) {
    totalPaused += Math.max(0, runEndMs - pauseStart);
  }
  return totalPaused;
};

const deriveFinalChecks = (journal: readonly JournalEvent[]): FinalCheckAnalytics[] =>
  journal
    .filter((event) => event.type === "final-check")
    .map((event) => {
      const details = object(event.details);
      const duration = integer(details?.durationMs);
      return {
        at: event.at,
        agent: event.agent ?? null,
        name: string(details?.name) ?? "unknown",
        tier: string(details?.tier) ?? "unknown",
        exitCode: integer(details?.exitCode),
        durationMs: duration !== null && duration >= 0 ? duration : null
      };
    });

const deriveWaits = (roster: readonly string[], journal: readonly JournalEvent[]): WaitAnalytics[] => {
  const waits = new Map<string, number[]>();
  for (const agent of roster) waits.set(agent, []);
  const pendingNudge = new Map<string, number>();
  for (const event of journal) {
    if (event.actionId === undefined || event.agent === undefined) continue;
    const key = `${event.agent}\u0000${event.actionId}`;
    if (event.type === "nudged") {
      const at = milliseconds(event.at);
      if (at !== null && !pendingNudge.has(key)) pendingNudge.set(key, at);
    } else if (event.type === "intent-seen") {
      const from = pendingNudge.get(key);
      const to = milliseconds(event.at);
      if (from !== undefined && to !== null && to >= from) {
        const values = waits.get(event.agent) ?? [];
        values.push(to - from);
        waits.set(event.agent, values);
        pendingNudge.delete(key);
      }
    }
  }
  return [...waits.entries()]
    .map(([agent, values]) => ({
      agent,
      count: values.length,
      medianMs: median(values),
      maxMs: values.length === 0 ? null : Math.max(...values)
    }))
    .sort((left, right) => left.agent.localeCompare(right.agent));
};

/**
 * Agent response latency for ballot actions: nudged → response-accepted.
 * Publication retries and ballot-batch events are excluded; they are not agent turns.
 */
const deriveResponseLatency = (
  roster: readonly string[],
  journal: readonly JournalEvent[]
): WaitAnalytics[] => {
  const waits = new Map<string, number[]>();
  for (const agent of roster) waits.set(agent, []);
  const pendingNudge = new Map<string, number>();
  for (const event of journal) {
    if (event.actionId === undefined || event.agent === undefined) continue;
    const key = `${event.agent}\u0000${event.actionId}`;
    if (event.type === "nudged") {
      const at = milliseconds(event.at);
      if (at !== null && !pendingNudge.has(key)) pendingNudge.set(key, at);
    } else if (event.type === "response-accepted") {
      const from = pendingNudge.get(key);
      const to = milliseconds(event.at);
      if (from !== undefined && to !== null && to >= from) {
        const values = waits.get(event.agent) ?? [];
        values.push(to - from);
        waits.set(event.agent, values);
        pendingNudge.delete(key);
      }
    }
  }
  return [...waits.entries()]
    .map(([agent, values]) => ({
      agent,
      count: values.length,
      medianMs: median(values),
      maxMs: values.length === 0 ? null : Math.max(...values)
    }))
    .sort((left, right) => left.agent.localeCompare(right.agent));
};

/**
 * Coordinator evidence-publication latency: first ballot-batch-pending for a
 * batchId → ballot-batch-published. Failed retries do not start a new interval
 * and are not counted as agent turns.
 */
const deriveEvidencePublicationLatency = (journal: readonly JournalEvent[]): IntervalAnalytics => {
  const pendingAt = new Map<string, number>();
  const durations: number[] = [];
  for (const event of journal) {
    const details = object(event.details);
    const batchId = string(details?.batchId);
    if (batchId === null) continue;
    if (event.type === "ballot-batch-pending") {
      const at = milliseconds(event.at);
      if (at !== null && !pendingAt.has(batchId)) pendingAt.set(batchId, at);
    } else if (event.type === "ballot-batch-published") {
      const from = pendingAt.get(batchId);
      const to = milliseconds(event.at);
      if (from !== undefined && to !== null && to >= from) {
        durations.push(to - from);
        pendingAt.delete(batchId);
      }
    } else if (event.type === "ballot-batch-failed" || event.type === "ballot-batch-invalidated") {
      // Keep the original pending timestamp so a later publish still measures
      // wall time from first enqueue; do not treat the failure as a new turn.
    }
  }
  return {
    count: durations.length,
    medianMs: median(durations),
    maxMs: durations.length === 0 ? null : Math.max(...durations)
  };
};

const usageVendorForAgent = (agent: string, journal: readonly JournalEvent[]): UsageVendor | null => {
  if (agent === "cursor") return "cursor";
  for (const event of [...journal].reverse()) {
    if (event.type !== "agent-lifecycle" || event.agent !== agent) continue;
    const vendor = string(object(event.details)?.vendor);
    if (vendor === "claude" || vendor === "codex") return vendor;
  }
  return agent === "claude" || agent === "codex" ? agent : null;
};

const unavailableUsage = (
  agent: string,
  vendor: UsageVendor | null,
  phases: readonly PhaseAnalytics[],
  reason: string
): AgentUsageAnalytics => ({
  agent,
  vendor,
  tokenCoverage: "unavailable",
  tokenReason: reason,
  toolCoverage: "unavailable",
  toolReason: reason,
  phases: phases.map((phase) => ({
    phaseIndex: phase.index,
    phase: phase.name,
    round: phase.round,
    tokens: null,
    toolCalls: null,
    tokenCoverage: "unavailable",
    toolCoverage: "unavailable"
  })),
  unassigned: { tokens: emptyTokens(), toolCalls: 0, records: 0, tokenRecords: 0, toolRecords: 0 }
});

export type BuildAnalyticsInput = {
  start: AnalyticsStart;
  journal: readonly JournalEvent[];
  activeRoster?: readonly string[];
  now?: string;
  transcriptRoots?: Partial<Record<TranscriptVendor, string | null>>;
  source?: AnalyticsSource;
};

export const buildAnalytics = (input: BuildAnalyticsInput): AnalyticsReport => {
  if (!input.journal.some((event) => event.type === "started")) {
    throw new Error(`No journal exists for issue ${input.start.issue}.`);
  }
  const now = input.now ?? new Date().toISOString();
  const roster = [...(input.activeRoster ?? input.start.originalRoster)];
  const phases = derivePhases(input.start, input.journal, now);
  const gates = input.journal.filter((event) => event.type === "gate-advanced");
  const terminalGate = [...gates].reverse().find((event) => object(event.details)?.to === null);
  const startedAt = input.journal.find((event) => event.type === "started")?.at ?? input.start.createdAt;
  const endedAt = terminalGate?.at ?? now;
  const startMs = milliseconds(startedAt);
  const endMs = milliseconds(endedAt);
  const runValid = startMs !== null && endMs !== null && endMs >= startMs;
  const runState: MetricState = !runValid ? "invalid" : terminalGate === undefined ? "in-progress" : "complete";
  const elapsedMs = runValid ? endMs - startMs : null;
  const pausedMs = elapsedMs === null ? null : derivePauseIntervals(input.journal, startMs, endMs);
  const unpausedMs = elapsedMs === null || pausedMs === null ? null : elapsedMs - pausedMs;
  const source: AnalyticsSource = input.source ?? {
    formatVersion: RUNTIME_FORMAT_VERSION,
    legacy: false,
    skippedJournalRecords: 0
  };
  const turns = deriveActionTurns(input.journal, phases);
  const hasSessionIdentity = input.journal.some((event) => {
    if (event.type !== "agent-lifecycle") return false;
    const details = object(event.details);
    return string(details?.sessionId) !== null || string(details?.turnId) !== null;
  });

  let usage: AnalyticsReport["usage"] = null;
  if (hasSessionIdentity) {
    const agents: AgentUsageAnalytics[] = [];
    for (const agent of roster) {
      const vendor = usageVendorForAgent(agent, input.journal);
      if (vendor === null) {
        agents.push(unavailableUsage(agent, vendor, phases, "no supported local usage store for this agent"));
        continue;
      }
      const agentTurns = turns.filter((turn) => turn.agent === agent);
      const sessions = [...new Set(agentTurns.map((turn) => turn.sessionId))];
      if (sessions.length === 0) {
        agents.push(unavailableUsage(agent, vendor, phases, "no journaled session identity for this agent"));
        continue;
      }
      const attemptedActions = new Set(
        input.journal
          .filter((event) => event.type === "nudged" && event.agent === agent && event.actionId !== undefined)
          .map((event) => event.actionId as string)
      );
      const boundActions = new Set(agentTurns.map((turn) => turn.actionId));
      const missingIdentity = [...attemptedActions].filter((actionId) => !boundActions.has(actionId));
      const results = sessions.map((sessionId) =>
        vendor === "cursor"
          ? readCursorHookUsage(input.journal, sessionId)
          : readTranscript({ vendor, sessionId, root: input.transcriptRoots?.[vendor] ?? null })
      );
      let tokenCoverage = combineTranscriptCoverage(results, "tokenCoverage");
      let toolCoverage = combineTranscriptCoverage(results, "toolCoverage");
      const tokenReasons = results
        .filter((result) => result.tokenReason !== null)
        .map((result) => `${result.sessionId}: ${result.tokenReason}`);
      const toolReasons = results
        .filter((result) => result.toolReason !== null)
        .map((result) => `${result.sessionId}: ${result.toolReason}`);
      if (missingIdentity.length > 0) {
        tokenCoverage = worseCoverage(tokenCoverage, "partial");
        toolCoverage = worseCoverage(toolCoverage, "partial");
        const identityReason = `${missingIdentity.length} attempted action(s) have no complete session/turn identity`;
        tokenReasons.push(identityReason);
        toolReasons.push(identityReason);
      }
      const phaseUsage: PhaseUsageAnalytics[] = phases.map((phase) => ({
        phaseIndex: phase.index,
        phase: phase.name,
        round: phase.round,
        tokens: emptyTokens(),
        toolCalls: 0,
        tokenCoverage,
        toolCoverage
      }));
      let unassignedTokens = emptyTokens();
      let unassignedTools = 0;
      let unassignedRecords = 0;
      let unassignedTokenRecords = 0;
      let unassignedToolRecords = 0;
      let tokenFallbackUsed = false;
      let toolFallbackUsed = false;
      let sharedTurnFallbackUsed = false;

      const assign = (
        phaseIndex: number | null,
        record: {
          tokens: TokenUsage;
          toolCalls: number;
          tokenRecords: number;
          toolRecords: number;
        },
        exact: boolean
      ): void => {
        if (phaseIndex === null || phaseUsage[phaseIndex] === undefined) {
          if (record.tokenRecords > 0) {
            unassignedTokens = addTokens(unassignedTokens, record.tokens);
            unassignedTokenRecords += record.tokenRecords;
            tokenCoverage = worseCoverage(tokenCoverage, "partial");
          }
          if (record.toolRecords > 0) {
            unassignedTools += record.toolCalls;
            unassignedToolRecords += record.toolRecords;
            toolCoverage = worseCoverage(toolCoverage, "partial");
          }
          unassignedRecords += record.tokenRecords + record.toolRecords;
          return;
        }
        const bucket = phaseUsage[phaseIndex];
        if (record.tokenRecords > 0) bucket.tokens = addTokens(bucket.tokens ?? emptyTokens(), record.tokens);
        if (record.toolRecords > 0) bucket.toolCalls = (bucket.toolCalls ?? 0) + record.toolCalls;
        if (!exact && record.tokenRecords > 0) {
          tokenFallbackUsed = true;
          tokenCoverage = worseCoverage(tokenCoverage, "partial");
          bucket.tokenCoverage = worseCoverage(bucket.tokenCoverage, "partial");
        }
        if (!exact && record.toolRecords > 0) {
          toolFallbackUsed = true;
          toolCoverage = worseCoverage(toolCoverage, "partial");
          bucket.toolCoverage = worseCoverage(bucket.toolCoverage, "partial");
        }
      };

      for (const result of results) {
        for (const turnUsage of result.turns) {
          const matchingTurns = agentTurns.filter(
            (turn) => turn.sessionId === result.sessionId && turn.turnId === turnUsage.turnId
          );
          const resolved = resolveSharedTurnPhase(matchingTurns, result.sessionId, true);
          if (resolved.sharedTurn) sharedTurnFallbackUsed = true;
          assign(resolved.phaseIndex, turnUsage, resolved.exact);
        }
        for (const record of result.unattributed) {
          const at = record.at === null ? null : milliseconds(record.at);
          const matching =
            at === null
              ? []
              : agentTurns.filter(
                  (turn) =>
                    turn.sessionId === result.sessionId &&
                    turn.endedMs !== null &&
                    at >= turn.startedMs &&
                    at <= turn.endedMs
                );
          const resolved = resolveSharedTurnPhase(
            matching,
            result.sessionId,
            matching.length === 1 && record.windowAttribution === "exact"
          );
          if (resolved.sharedTurn) sharedTurnFallbackUsed = true;
          assign(resolved.phaseIndex, record, resolved.exact);
        }
      }
      if (unassignedTokenRecords > 0) tokenReasons.push("one or more measured token records are unassigned");
      if (unassignedToolRecords > 0) toolReasons.push("one or more measured tool records are unassigned");
      if (tokenFallbackUsed) {
        tokenReasons.push("one or more token records used a non-exact attribution fallback");
      }
      if (toolFallbackUsed) {
        toolReasons.push("one or more tool records used a non-exact attribution fallback");
      }
      if (sharedTurnFallbackUsed) {
        tokenReasons.push("one or more token records were shared by one vendor turn across several actions");
        toolReasons.push("one or more tool records were shared by one vendor turn across several actions");
      }
      for (const phase of phaseUsage) {
        phase.tokenCoverage = worseCoverage(phase.tokenCoverage, tokenCoverage);
        phase.toolCoverage = worseCoverage(phase.toolCoverage, toolCoverage);
        if (tokenCoverage === "unavailable" || tokenCoverage === "unsupported") phase.tokens = null;
        if (toolCoverage === "unavailable" || toolCoverage === "unsupported") phase.toolCalls = null;
      }
      const tokenReason = [...new Set(tokenReasons)].join("; ");
      const toolReason = [...new Set(toolReasons)].join("; ");
      agents.push({
        agent,
        vendor,
        tokenCoverage,
        tokenReason: tokenReason === "" ? null : tokenReason,
        toolCoverage,
        toolReason: toolReason === "" ? null : toolReason,
        phases: phaseUsage,
        unassigned: {
          tokens: unassignedTokens,
          toolCalls: unassignedTools,
          records: unassignedRecords,
          tokenRecords: unassignedTokenRecords,
          toolRecords: unassignedToolRecords
        }
      });
    }

    const tokenTotal =
      phases.length > 0 &&
      agents.every((agent) => agent.tokenCoverage === "complete" && agent.unassigned.tokenRecords === 0)
        ? agents.reduce(
            (total, agent) =>
              agent.phases.reduce(
                (phaseTotal, phase) => addTokens(phaseTotal, phase.tokens ?? emptyTokens()),
                total
              ),
            emptyTokens()
          )
        : null;
    const blockingAgents = agents
      .filter((agent) => agent.tokenCoverage !== "complete" || agent.unassigned.tokenRecords > 0)
      .map((agent) => agent.agent);
    const tokenTotalReason =
      tokenTotal === null && blockingAgents.length > 0 ? `blocked by: ${blockingAgents.join(", ")}` : null;
    usage = {
      agents: agents.sort((left, right) => left.agent.localeCompare(right.agent)),
      tokenTotal,
      tokenTotalReason
    };
  }

  return {
    issue: input.start.issue,
    phaseCount: phases.length,
    run: {
      startedAt,
      endedAt,
      durationMs: elapsedMs,
      pausedMs,
      unpausedMs,
      state: runState
    },
    phases,
    waits: deriveWaits(roster, input.journal),
    responseLatency: deriveResponseLatency(roster, input.journal),
    evidencePublicationLatency: deriveEvidencePublicationLatency(input.journal),
    finalChecks: deriveFinalChecks(input.journal),
    source,
    usage
  };
};

const formatDuration = (durationMs: number | null): string => {
  if (durationMs === null) return "invalid";
  return `${(durationMs / 60_000).toFixed(2)} min`;
};

const formatTokens = (tokens: TokenUsage | null): string => {
  if (tokens === null) return "unavailable";
  return (
    `input=${tokens.input} output=${tokens.output} cacheRead=${tokens.cacheRead} cacheWrite=${tokens.cacheWrite}` +
    (tokens.reasoning === null ? "" : ` reasoning=${tokens.reasoning}`)
  );
};

const formatPhase = (phase: Pick<PhaseUsageAnalytics, "phase" | "round">): string =>
  `${phase.phase}${phase.round === null ? "" : ` round ${phase.round}`}`;

export const renderAnalytics = (report: AnalyticsReport): string => {
  const runLine =
    report.run.durationMs === null
      ? `Run: ${formatDuration(null)} (${report.run.state})`
      : `Run: ${formatDuration(report.run.durationMs)} elapsed / ${formatDuration(report.run.pausedMs ?? 0)} paused / ${formatDuration(report.run.unpausedMs)} unpaused (${report.run.state})`;
  const lines = [
    `Issue ${report.issue} analytics`,
    "",
    "Time",
    runLine,
    ...report.phases.map(
      (phase) =>
        `- ${phase.name}${phase.round === null ? "" : ` round ${phase.round}`}: ${formatDuration(phase.durationMs)}; actions=${phase.actions}; ${phase.state}`
    ),
    "",
    "Phase count",
    `${report.phaseCount}`,
    "",
    "Agent wait (nudged -> intent-seen)",
    ...report.waits.map(
      (wait) =>
        `- ${wait.agent}: count=${wait.count} median=${wait.medianMs === null ? "unavailable" : `${(wait.medianMs / 1000).toFixed(1)}s`} max=${wait.maxMs === null ? "unavailable" : `${(wait.maxMs / 1000).toFixed(1)}s`}`
    ),
    "",
    "Agent response latency (nudged -> response-accepted)",
    ...report.responseLatency.map(
      (wait) =>
        `- ${wait.agent}: count=${wait.count} median=${wait.medianMs === null ? "unavailable" : `${(wait.medianMs / 1000).toFixed(1)}s`} max=${wait.maxMs === null ? "unavailable" : `${(wait.maxMs / 1000).toFixed(1)}s`}`
    ),
    "",
    "Evidence publication latency (ballot-batch-pending -> published)",
    `- count=${report.evidencePublicationLatency.count} median=${
      report.evidencePublicationLatency.medianMs === null
        ? "unavailable"
        : `${(report.evidencePublicationLatency.medianMs / 1000).toFixed(1)}s`
    } max=${
      report.evidencePublicationLatency.maxMs === null
        ? "unavailable"
        : `${(report.evidencePublicationLatency.maxMs / 1000).toFixed(1)}s`
    }`,
    "",
    "Final checks",
    ...(report.finalChecks.length === 0
      ? ["- none recorded"]
      : report.finalChecks.map((check) => {
          const duration =
            check.durationMs === null ? "unavailable" : `${(check.durationMs / 1000).toFixed(1)}s`;
          return `- ${check.name} (${check.tier}): exit=${check.exitCode ?? "unavailable"} duration=${duration}`;
        }))
  ];
  if (report.source.legacy || report.source.skippedJournalRecords > 0) {
    lines.push(
      "",
      "Provenance",
      `- formatVersion=${report.source.formatVersion}; legacy=${report.source.legacy}; skippedJournalRecords=${report.source.skippedJournalRecords}`
    );
  }
  if (report.usage !== null) {
    lines.push("", "Token count");
    for (const agent of report.usage.agents) {
      lines.push(
        `- ${agent.agent}: coverage=${agent.tokenCoverage}${agent.tokenReason === null ? "" : ` (${agent.tokenReason})`}`
      );
      for (const phase of agent.phases) {
        lines.push(`  - ${formatPhase(phase)}: ${formatTokens(phase.tokens)}; coverage=${phase.tokenCoverage}`);
      }
      if (agent.unassigned.tokenRecords > 0) {
        lines.push(
          `  - unassigned: ${formatTokens(agent.unassigned.tokens)}; records=${agent.unassigned.tokenRecords}`
        );
      }
    }
    lines.push(
      report.usage.tokenTotal === null
        ? `Cross-roster token total: unavailable${report.usage.tokenTotalReason === null ? " (not every active agent has complete coverage)" : ` (${report.usage.tokenTotalReason})`}`
        : `Cross-roster token total: ${formatTokens(report.usage.tokenTotal)}`,
      "",
      "Tool count"
    );
    for (const agent of report.usage.agents) {
      lines.push(
        `- ${agent.agent}: coverage=${agent.toolCoverage}${agent.toolReason === null ? "" : ` (${agent.toolReason})`}`
      );
      for (const phase of agent.phases) {
        lines.push(
          `  - ${formatPhase(phase)}: ${phase.toolCalls === null ? "unavailable" : phase.toolCalls}; coverage=${phase.toolCoverage}`
        );
      }
      if (agent.unassigned.toolRecords > 0) {
        lines.push(`  - unassigned: ${agent.unassigned.toolCalls}; records=${agent.unassigned.toolRecords}`);
      }
    }
    lines.push("Cross-roster tool total: intentionally not reported");
  }
  return `${lines.join("\n")}\n`;
};
