import { readJournal, type JournalEvent, type StartState } from "./state.js";
import type { IssueRuntimePaths } from "./paths.js";
import {
  readTranscript,
  type TokenComponents,
  type TranscriptCoverage,
  type TranscriptTurnRow,
  type TranscriptVendor
} from "./transcriptRead.js";

export type PhaseInterval = {
  name: string;
  round: number | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "ok" | "invalid" | "in-progress";
  actionCount: number;
};

export type AgentWaitStats = {
  agent: string;
  actions: number;
  medianMs: number | null;
  maxMs: number | null;
  totalMs: number | null;
};

export type AgentUsageRow = {
  agent: string;
  vendor: TranscriptVendor;
  coverage: TranscriptCoverage;
  reason: string | null;
  tokens: TokenComponents | null;
  toolCalls: number | null;
  unassignedTokens: TokenComponents | null;
  unassignedToolCalls: number | null;
  usedTemporalFallback: boolean;
};

export type AnalyticsReport = {
  issue: number;
  profile: string | null;
  phases: PhaseInterval[];
  runDurationMs: number | null;
  runStatus: "complete" | "in-progress" | "invalid";
  agentWaits: AgentWaitStats[];
  agentUsage: AgentUsageRow[];
  crossRosterTotals: { tokens: TokenComponents; toolCalls: number } | null;
};

const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const parseAt = (at: string): number | null => {
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? null : ms;
};

const median = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2) : (sorted[mid] as number);
};

const zeroTokens = (): TokenComponents => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

const addTokens = (into: TokenComponents, add: TokenComponents): void => {
  into.input += add.input;
  into.output += add.output;
  into.cacheRead += add.cacheRead;
  into.cacheWrite += add.cacheWrite;
  if (add.reasoning !== undefined || into.reasoning !== undefined) {
    into.reasoning = (into.reasoning ?? 0) + (add.reasoning ?? 0);
  }
};

const vendorForAgent = (agent: string, detailsVendor: unknown): TranscriptVendor => {
  if (detailsVendor === "claude" || detailsVendor === "codex" || detailsVendor === "cursor" || detailsVendor === "antigravity") {
    return detailsVendor;
  }
  if (agent === "claude" || agent === "codex" || agent === "cursor" || agent === "antigravity") return agent;
  return "cursor";
};

type ActionBinding = {
  actionId: string;
  agent: string;
  phaseName: string;
  sessionId: string | null;
  turnIds: Set<string>;
  windowStart: string | null;
  windowEnd: string | null;
};

const buildPhases = (events: readonly JournalEvent[]): PhaseInterval[] => {
  const started = events.find((event) => event.type === "started");
  const gates = events.filter((event) => event.type === "gate-advanced");
  const prepared = events.filter((event) => event.type === "action-prepared");
  if (started === undefined) return [];

  // Match docs/analytics.md §2.1: each gate closes the phase named in details.from,
  // measured from the previous boundary (started, then each gate.at).
  const phases: PhaseInterval[] = [];
  let prevAt = started.at;
  for (const gate of gates) {
    const name = asString(gate.details.from);
    if (name === null) continue;
    const startMs = parseAt(prevAt);
    const endMs = parseAt(gate.at);
    let durationMs: number | null = null;
    let status: PhaseInterval["status"] = "ok";
    if (startMs === null || endMs === null || endMs < startMs) {
      status = "invalid";
    } else {
      durationMs = endMs - startMs;
    }
    const actionCount = prepared.filter((event) => {
      const at = parseAt(event.at);
      const start = parseAt(prevAt);
      const end = parseAt(gate.at);
      return at !== null && start !== null && end !== null && at >= start && at < end;
    }).length;
    phases.push({
      name,
      round: asNumber(gate.details.round),
      startedAt: prevAt,
      endedAt: gate.at,
      durationMs,
      status,
      actionCount
    });
    prevAt = gate.at;
  }

  if (phases.length === 0) {
    return [
      {
        name: "running",
        round: null,
        startedAt: started.at,
        endedAt: null,
        durationMs: null,
        status: "in-progress",
        actionCount: prepared.length
      }
    ];
  }

  return phases;
};

const buildAgentWaits = (events: readonly JournalEvent[]): AgentWaitStats[] => {
  const firstNudge = new Map<string, string>();
  const intent = new Map<string, string>();
  for (const event of events) {
    if (event.agent === undefined || event.actionId === undefined) continue;
    const key = `${event.agent}:${event.actionId}`;
    if (event.type === "nudged" && !firstNudge.has(key)) firstNudge.set(key, event.at);
    if (event.type === "intent-seen" && !intent.has(key)) intent.set(key, event.at);
  }
  const byAgent = new Map<string, number[]>();
  for (const [key, nudgedAt] of firstNudge) {
    const seenAt = intent.get(key);
    if (seenAt === undefined) continue;
    const start = parseAt(nudgedAt);
    const end = parseAt(seenAt);
    if (start === null || end === null || end < start) continue;
    const agent = key.split(":")[0] as string;
    const list = byAgent.get(agent) ?? [];
    list.push(end - start);
    byAgent.set(agent, list);
  }
  return [...byAgent.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([agent, waits]) => ({
      agent,
      actions: waits.length,
      medianMs: median(waits),
      maxMs: waits.length === 0 ? null : Math.max(...waits),
      totalMs: waits.length === 0 ? null : waits.reduce((sum, value) => sum + value, 0)
    }));
};

const phaseContaining = (phases: readonly PhaseInterval[], at: string): string | null => {
  const ms = parseAt(at);
  if (ms === null) return null;
  for (const phase of phases) {
    const start = parseAt(phase.startedAt);
    if (start === null || ms < start) continue;
    if (phase.endedAt === null) return phase.name;
    const end = parseAt(phase.endedAt);
    if (end !== null && ms < end) return phase.name;
  }
  return null;
};

const buildActionBindings = (events: readonly JournalEvent[], phases: readonly PhaseInterval[]): ActionBinding[] => {
  const bindings = new Map<string, ActionBinding>();
  for (const event of events) {
    if (event.type !== "action-prepared" || event.agent === undefined || event.actionId === undefined) continue;
    const phaseName = phaseContaining(phases, event.at) ?? "unknown";
    bindings.set(event.actionId, {
      actionId: event.actionId,
      agent: event.agent,
      phaseName,
      sessionId: null,
      turnIds: new Set(),
      windowStart: null,
      windowEnd: null
    });
  }

  for (const event of events) {
    if (event.type !== "agent-lifecycle" || event.agent === undefined) continue;
    const details = event.details;
    const sessionId = asString(details.sessionId);
    const turnId = asString(details.turnId);
    const kind = asString(details.kind);
    const actionId = event.actionId;
    if (actionId !== undefined) {
      const binding = bindings.get(actionId);
      if (binding !== undefined) {
        if (sessionId !== null) binding.sessionId = sessionId;
        if (turnId !== null) binding.turnIds.add(turnId);
        if (kind === "prompt-submitted") binding.windowStart = event.at;
      }
    }
    if (kind === "stopped" && sessionId !== null) {
      for (const binding of bindings.values()) {
        if (binding.agent === event.agent && binding.sessionId === sessionId && binding.windowStart !== null && binding.windowEnd === null) {
          if (actionId === undefined || binding.actionId === actionId) binding.windowEnd = event.at;
        }
      }
    }
  }

  // Attach turnIds/sessionIds seen on lifecycle rows even when actionId was only on a later row.
  for (const event of events) {
    if (event.type !== "agent-lifecycle" || event.actionId === undefined) continue;
    const binding = bindings.get(event.actionId);
    if (binding === undefined) continue;
    const sessionId = asString(event.details.sessionId);
    const turnId = asString(event.details.turnId);
    if (sessionId !== null) binding.sessionId = sessionId;
    if (turnId !== null) binding.turnIds.add(turnId);
  }

  return [...bindings.values()];
};

const sumRows = (rows: readonly TranscriptTurnRow[]): { tokens: TokenComponents; toolCalls: number } => {
  const tokens = zeroTokens();
  let toolCalls = 0;
  let anyTokens = false;
  for (const row of rows) {
    if (row.tokens !== null) {
      addTokens(tokens, row.tokens);
      anyTokens = true;
    }
    toolCalls += row.toolCalls;
  }
  return { tokens: anyTokens ? tokens : zeroTokens(), toolCalls };
};

export type BuildAnalyticsOptions = {
  paths: IssueRuntimePaths;
  start?: StartState;
  /** Override vendor store roots in tests: { claude?: path, codex?: path }. */
  transcriptRoots?: Partial<Record<"claude" | "codex", string>>;
  /** When false, skip transcript joins (journal-only). Default true. */
  joinTranscripts?: boolean;
};

export const buildAnalyticsReport = (options: BuildAnalyticsOptions): AnalyticsReport => {
  const events = readJournal(options.paths);
  const started = events.find((event) => event.type === "started");
  const issue = asNumber(started?.details.issue) ?? Number(options.paths.issueRoot.split("/").at(-1)?.replace("issue-", "") ?? NaN);
  const profile = asString(started?.details.profile);
  const phases = buildPhases(events);
  const agentWaits = buildAgentWaits(events);

  let runDurationMs: number | null = null;
  let runStatus: AnalyticsReport["runStatus"] = "in-progress";
  if (phases.length > 0 && phases.every((phase) => phase.status === "ok" && phase.endedAt !== null)) {
    runDurationMs = phases.reduce((sum, phase) => sum + (phase.durationMs ?? 0), 0);
    runStatus = phases.some((phase) => phase.status === "invalid") ? "invalid" : "complete";
  } else if (phases.some((phase) => phase.status === "invalid")) {
    runStatus = "invalid";
  }

  const hasSession = events.some(
    (event) => event.type === "agent-lifecycle" && asString(event.details.sessionId) !== null
  );

  const agentUsage: AgentUsageRow[] = [];
  if (options.joinTranscripts !== false && hasSession) {
    const bindings = buildActionBindings(events, phases);
    const byAgent = new Map<string, ActionBinding[]>();
    for (const binding of bindings) {
      const list = byAgent.get(binding.agent) ?? [];
      list.push(binding);
      byAgent.set(binding.agent, list);
    }

    const agents = [...new Set(events.filter((event) => event.agent !== undefined).map((event) => event.agent as string))];
    for (const agent of agents.sort()) {
      const agentBindings = byAgent.get(agent) ?? [];
      const lifecycle = events.find(
        (event) => event.type === "agent-lifecycle" && event.agent === agent && asString(event.details.sessionId) !== null
      );
      const vendor = vendorForAgent(agent, lifecycle?.details.vendor);
      const sessionId = agentBindings.find((binding) => binding.sessionId !== null)?.sessionId ?? asString(lifecycle?.details.sessionId);
      if (sessionId === null) {
        agentUsage.push({
          agent,
          vendor,
          coverage: "unavailable",
          reason: "no sessionId in journal",
          tokens: null,
          toolCalls: null,
          unassignedTokens: null,
          unassignedToolCalls: null,
          usedTemporalFallback: false
        });
        continue;
      }

      if (vendor !== "claude" && vendor !== "codex") {
        agentUsage.push({
          agent,
          vendor,
          coverage: "unavailable",
          reason: `vendor ${vendor} has no local usage store`,
          tokens: null,
          toolCalls: null,
          unassignedTokens: null,
          unassignedToolCalls: null,
          usedTemporalFallback: false
        });
        continue;
      }

      const clonePath = options.start?.agents.find((entry) => entry.id === agent)?.root;
      const transcript = readTranscript({
        vendor,
        sessionId,
        root: options.transcriptRoots?.[vendor],
        ...(clonePath === undefined ? {} : { clonePath }),
        searchAfter: started?.at,
        searchBefore: phases.at(-1)?.endedAt ?? undefined
      });

      if (transcript.coverage === "unavailable" || transcript.coverage === "unsupported") {
        agentUsage.push({
          agent,
          vendor,
          coverage: transcript.coverage,
          reason: transcript.reason,
          tokens: null,
          toolCalls: null,
          unassignedTokens: null,
          unassignedToolCalls: null,
          usedTemporalFallback: false
        });
        continue;
      }

      const turnToBinding = new Map<string, ActionBinding>();
      for (const binding of agentBindings) {
        for (const turnId of binding.turnIds) turnToBinding.set(turnId, binding);
      }

      const assigned: TranscriptTurnRow[] = [];
      const unassigned: TranscriptTurnRow[] = [];
      let usedTemporalFallback = false;

      for (const row of transcript.values) {
        if (row.turnId !== null) {
          if (turnToBinding.has(row.turnId)) assigned.push(row);
          else unassigned.push(row);
          continue;
        }
        // Temporal fallback only when no turn identity is present on the record.
        const windowHit = agentBindings.find((binding) => {
          if (binding.windowStart === null || row.timestamp === undefined) return false;
          const at = parseAt(row.timestamp);
          const start = parseAt(binding.windowStart);
          const end = binding.windowEnd === null ? null : parseAt(binding.windowEnd);
          if (at === null || start === null) return false;
          if (at < start) return false;
          if (end !== null && at > end) return false;
          return true;
        });
        if (windowHit !== undefined) {
          usedTemporalFallback = true;
          assigned.push(row);
          continue;
        }
        unassigned.push(row);
      }

      const assignedSum = sumRows(assigned);
      const unassignedSum = sumRows(unassigned);
      const coverage: TranscriptCoverage =
        usedTemporalFallback || transcript.coverage === "partial" ? "partial" : transcript.coverage;

      agentUsage.push({
        agent,
        vendor,
        coverage,
        reason: usedTemporalFallback ? "temporal window fallback used for some records" : transcript.reason,
        tokens: assignedSum.tokens,
        toolCalls: assignedSum.toolCalls,
        unassignedTokens: unassigned.length === 0 ? null : unassignedSum.tokens,
        unassignedToolCalls: unassigned.length === 0 ? null : unassignedSum.toolCalls,
        usedTemporalFallback
      });
    }
  }

  const allComplete =
    agentUsage.length > 0 && agentUsage.every((row) => row.coverage === "complete" && row.tokens !== null && row.toolCalls !== null);
  let crossRosterTotals: AnalyticsReport["crossRosterTotals"] = null;
  if (allComplete) {
    const tokens = zeroTokens();
    let toolCalls = 0;
    for (const row of agentUsage) {
      if (row.tokens !== null) addTokens(tokens, row.tokens);
      toolCalls += row.toolCalls ?? 0;
    }
    crossRosterTotals = { tokens, toolCalls };
  }

  return {
    issue: Number.isFinite(issue) ? issue : 0,
    profile,
    phases,
    runDurationMs,
    runStatus,
    agentWaits,
    agentUsage,
    crossRosterTotals
  };
};

const formatMs = (ms: number | null): string => {
  if (ms === null) return "n/a";
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  return `${(seconds / 60).toFixed(2)} min`;
};

export const renderAnalyticsReport = (report: AnalyticsReport): string => {
  const lines: string[] = [];
  lines.push(`Issue ${report.issue} analytics${report.profile === null ? "" : ` (${report.profile})`}`);
  lines.push(`Run: ${report.runStatus}${report.runDurationMs === null ? "" : ` · ${formatMs(report.runDurationMs)}`}`);
  lines.push("");
  lines.push("Phases");
  if (report.phases.length === 0) {
    lines.push("  (none)");
  } else {
    for (const phase of report.phases) {
      const dur =
        phase.status === "invalid"
          ? "invalid"
          : phase.status === "in-progress"
            ? "in-progress"
            : formatMs(phase.durationMs);
      lines.push(`  ${phase.name.padEnd(24)} ${dur.padStart(12)}  actions=${phase.actionCount}`);
    }
  }
  lines.push("");
  lines.push("Agent waits (first nudge → intent-seen)");
  if (report.agentWaits.length === 0) {
    lines.push("  (none)");
  } else {
    for (const wait of report.agentWaits) {
      lines.push(
        `  ${wait.agent.padEnd(12)} actions=${wait.actions}  median=${formatMs(wait.medianMs)}  max=${formatMs(wait.maxMs)}  total=${formatMs(wait.totalMs)}`
      );
    }
  }
  lines.push("");
  lines.push("Tokens / tools (per agent)");
  if (report.agentUsage.length === 0) {
    lines.push("  (omitted — no sessionId in journal, or joins disabled)");
  } else {
    for (const row of report.agentUsage) {
      if (row.tokens === null || row.toolCalls === null) {
        lines.push(`  ${row.agent.padEnd(12)} coverage=${row.coverage}${row.reason === null ? "" : ` · ${row.reason}`}`);
        continue;
      }
      lines.push(
        `  ${row.agent.padEnd(12)} coverage=${row.coverage}  tokens in=${row.tokens.input} out=${row.tokens.output} cacheRead=${row.tokens.cacheRead} cacheWrite=${row.tokens.cacheWrite}${row.tokens.reasoning === undefined ? "" : ` reasoning=${row.tokens.reasoning}`}  tools=${row.toolCalls}`
      );
      if (row.unassignedToolCalls !== null || row.unassignedTokens !== null) {
        lines.push(
          `               unassigned tools=${row.unassignedToolCalls ?? 0} tokens=${row.unassignedTokens === null ? "n/a" : `in=${row.unassignedTokens.input}`}`
        );
      }
    }
    if (report.crossRosterTotals === null) {
      lines.push("  cross-roster totals: omitted (coverage incomplete)");
    } else {
      const totals = report.crossRosterTotals;
      lines.push(
        `  ALL          tokens in=${totals.tokens.input} out=${totals.tokens.output} cacheRead=${totals.tokens.cacheRead} cacheWrite=${totals.tokens.cacheWrite}  tools=${totals.toolCalls}`
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
};
