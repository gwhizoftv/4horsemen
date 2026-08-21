import type { JournalEvent, StartState } from "./state.js";
import {
  readTranscript,
  type AnalyticsCoverage,
  type TokenUsage,
  type TranscriptReadResult,
  type TranscriptVendor
} from "./transcriptRead.js";

export type MetricState = "complete" | "in-progress" | "invalid";

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

export type PhaseUsageAnalytics = {
  phaseIndex: number;
  phase: string;
  round: number | null;
  tokens: TokenUsage | null;
  toolCalls: number | null;
  coverage: AnalyticsCoverage;
};

export type AgentUsageAnalytics = {
  agent: string;
  vendor: TranscriptVendor | null;
  coverage: AnalyticsCoverage;
  reason: string | null;
  phases: PhaseUsageAnalytics[];
  unassigned: {
    tokens: TokenUsage;
    toolCalls: number;
    records: number;
  };
};

export type AnalyticsReport = {
  issue: number;
  phaseCount: number;
  run: {
    startedAt: string;
    endedAt: string;
    durationMs: number | null;
    state: MetricState;
  };
  phases: PhaseAnalytics[];
  waits: WaitAnalytics[];
  usage: {
    agents: AgentUsageAnalytics[];
    tokenTotal: TokenUsage | null;
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

const combineTranscriptCoverage = (results: readonly TranscriptReadResult[]): AnalyticsCoverage => {
  if (results.length === 0 || results.every((result) => result.coverage === "unavailable")) return "unavailable";
  if (results.some((result) => result.coverage === "unsupported")) return "unsupported";
  if (results.some((result) => result.coverage !== "complete")) return "partial";
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

const derivePhases = (start: StartState, journal: readonly JournalEvent[], now: string): PhaseAnalytics[] => {
  const started = journal.find((event) => event.type === "started")?.at ?? start.createdAt;
  const gates = journal.filter((event) => event.type === "gate-advanced");
  const phases: PhaseAnalytics[] = [];
  let phaseStart = started;
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
      round: name.startsWith("R6.") ? integer(details?.round) : null,
      startedAt: phaseStart,
      endedAt: gate.at,
      durationMs: valid ? endMs - startMs : null,
      state: valid ? "complete" : "invalid",
      actions: 0
    });
    phaseStart = gate.at;
  }
  const finalGate = gates.at(-1);
  const finalDetails = finalGate === undefined ? null : object(finalGate.details);
  const activeName = finalDetails === null ? null : string(finalDetails.to);
  if (activeName !== null) {
    const startMs = milliseconds(phaseStart);
    const endMs = milliseconds(now);
    const valid = startMs !== null && endMs !== null && endMs >= startMs;
    phases.push({
      index: phases.length,
      name: activeName,
      round: activeName.startsWith("R6.") ? integer(finalDetails?.round) : null,
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

const deriveWaits = (roster: readonly string[], journal: readonly JournalEvent[]): WaitAnalytics[] => {
  const waits = new Map<string, number[]>();
  for (const agent of roster) waits.set(agent, []);
  const firstNudge = new Map<string, number>();
  for (const event of journal) {
    if (event.actionId === undefined || event.agent === undefined) continue;
    const key = `${event.agent}\u0000${event.actionId}`;
    if (event.type === "nudged") {
      const at = milliseconds(event.at);
      if (at !== null && !firstNudge.has(key)) firstNudge.set(key, at);
    } else if (event.type === "intent-seen") {
      const from = firstNudge.get(key);
      const to = milliseconds(event.at);
      if (from !== undefined && to !== null && to >= from) {
        const values = waits.get(event.agent) ?? [];
        values.push(to - from);
        waits.set(event.agent, values);
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

const vendorForAgent = (agent: string, journal: readonly JournalEvent[]): TranscriptVendor | null => {
  for (const event of [...journal].reverse()) {
    if (event.type !== "agent-lifecycle" || event.agent !== agent) continue;
    const vendor = string(object(event.details)?.vendor);
    if (vendor === "claude" || vendor === "codex") return vendor;
  }
  return agent === "claude" || agent === "codex" ? agent : null;
};

const unavailableUsage = (
  agent: string,
  vendor: TranscriptVendor | null,
  phases: readonly PhaseAnalytics[],
  reason: string
): AgentUsageAnalytics => ({
  agent,
  vendor,
  coverage: "unavailable",
  reason,
  phases: phases.map((phase) => ({
    phaseIndex: phase.index,
    phase: phase.name,
    round: phase.round,
    tokens: null,
    toolCalls: null,
    coverage: "unavailable"
  })),
  unassigned: { tokens: emptyTokens(), toolCalls: 0, records: 0 }
});

export type BuildAnalyticsInput = {
  start: StartState;
  journal: readonly JournalEvent[];
  activeRoster?: readonly string[];
  now?: string;
  transcriptRoots?: Partial<Record<TranscriptVendor, string | null>>;
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
  const turns = deriveActionTurns(input.journal, phases);
  const hasSessionIdentity = turns.length > 0;

  let usage: AnalyticsReport["usage"] = null;
  if (hasSessionIdentity) {
    const agents: AgentUsageAnalytics[] = [];
    for (const agent of roster) {
      const vendor = vendorForAgent(agent, input.journal);
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
      const results = sessions.map((sessionId) =>
        readTranscript({ vendor, sessionId, root: input.transcriptRoots?.[vendor] ?? null })
      );
      let coverage = combineTranscriptCoverage(results);
      let reason = results
        .filter((result) => result.reason !== null)
        .map((result) => `${result.sessionId}: ${result.reason}`)
        .join("; ");
      const phaseUsage: PhaseUsageAnalytics[] = phases.map((phase) => ({
        phaseIndex: phase.index,
        phase: phase.name,
        round: phase.round,
        tokens: emptyTokens(),
        toolCalls: 0,
        coverage
      }));
      let unassignedTokens = emptyTokens();
      let unassignedTools = 0;
      let unassignedRecords = 0;
      let fallbackUsed = false;

      const assign = (phaseIndex: number | null, tokens: TokenUsage, toolCalls: number, fallback: boolean): void => {
        if (fallback) fallbackUsed = true;
        if (phaseIndex === null || phaseUsage[phaseIndex] === undefined) {
          unassignedTokens = addTokens(unassignedTokens, tokens);
          unassignedTools += toolCalls;
          unassignedRecords += 1;
          return;
        }
        const bucket = phaseUsage[phaseIndex];
        bucket.tokens = addTokens(bucket.tokens ?? emptyTokens(), tokens);
        bucket.toolCalls = (bucket.toolCalls ?? 0) + toolCalls;
        if (fallback) bucket.coverage = worseCoverage(bucket.coverage, "partial");
      };

      for (const result of results) {
        for (const turnUsage of result.turns) {
          const action = agentTurns.find(
            (turn) => turn.sessionId === result.sessionId && turn.turnId === turnUsage.turnId
          );
          assign(action?.phaseIndex ?? null, turnUsage.tokens, turnUsage.toolCalls, false);
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
          assign(matching.length === 1 ? (matching[0]?.phaseIndex ?? null) : null, record.tokens, record.toolCalls, matching.length === 1);
        }
      }
      if (fallbackUsed) {
        coverage = worseCoverage(coverage, "partial");
        reason = [reason, "one or more records used a timestamp-window fallback"].filter((value) => value !== "").join("; ");
      }
      for (const phase of phaseUsage) {
        phase.coverage = worseCoverage(phase.coverage, coverage);
        if (coverage === "unavailable" || coverage === "unsupported") {
          phase.tokens = null;
          phase.toolCalls = null;
        }
      }
      agents.push({
        agent,
        vendor,
        coverage,
        reason: reason === "" ? null : reason,
        phases: phaseUsage,
        unassigned: { tokens: unassignedTokens, toolCalls: unassignedTools, records: unassignedRecords }
      });
    }

    const tokenTotal = agents.every((agent) => agent.coverage === "complete")
      ? agents.reduce(
          (total, agent) =>
            agent.phases.reduce(
              (phaseTotal, phase) => addTokens(phaseTotal, phase.tokens ?? emptyTokens()),
              total
            ),
          emptyTokens()
        )
      : null;
    usage = { agents: agents.sort((left, right) => left.agent.localeCompare(right.agent)), tokenTotal };
  }

  return {
    issue: input.start.issue,
    phaseCount: phases.filter((phase) => phase.state === "complete" || phase.state === "invalid").length,
    run: {
      startedAt,
      endedAt,
      durationMs: runValid ? endMs - startMs : null,
      state: runState
    },
    phases,
    waits: deriveWaits(roster, input.journal),
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

export const renderAnalytics = (report: AnalyticsReport): string => {
  const lines = [
    `Issue ${report.issue} analytics`,
    "",
    "Time",
    `Run: ${formatDuration(report.run.durationMs)} (${report.run.state})`,
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
    )
  ];
  if (report.usage !== null) {
    lines.push("", "Token count");
    for (const agent of report.usage.agents) {
      lines.push(`- ${agent.agent}: coverage=${agent.coverage}${agent.reason === null ? "" : ` (${agent.reason})`}`);
      for (const phase of agent.phases) {
        lines.push(`  - ${phase.phase}: ${formatTokens(phase.tokens)}; coverage=${phase.coverage}`);
      }
      if (agent.unassigned.records > 0) {
        lines.push(
          `  - unassigned: ${formatTokens(agent.unassigned.tokens)}; records=${agent.unassigned.records}`
        );
      }
    }
    lines.push(
      report.usage.tokenTotal === null
        ? "Cross-roster token total: unavailable (not every active agent has complete coverage)"
        : `Cross-roster token total: ${formatTokens(report.usage.tokenTotal)}`,
      "",
      "Tool count"
    );
    for (const agent of report.usage.agents) {
      lines.push(`- ${agent.agent}: coverage=${agent.coverage}`);
      for (const phase of agent.phases) {
        lines.push(
          `  - ${phase.phase}: ${phase.toolCalls === null ? "unavailable" : phase.toolCalls}; coverage=${phase.coverage}`
        );
      }
      if (agent.unassigned.records > 0) lines.push(`  - unassigned: ${agent.unassigned.toolCalls}`);
    }
    lines.push("Cross-roster tool total: intentionally not reported");
  }
  return `${lines.join("\n")}\n`;
};
