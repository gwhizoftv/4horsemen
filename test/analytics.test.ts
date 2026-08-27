import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalytics, renderAnalytics } from "../src/analytics.js";
import { issueRuntimePaths } from "../src/paths.js";
import {
  isLegacyRuntimeFormat,
  journalEventSchema,
  readJournal,
  readJournalForAnalytics,
  readStartState,
  readStartStateHeader,
  startStateSchema,
  type JournalEvent
} from "../src/state.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "support", "fixtures");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const start = startStateSchema.parse({
  formatVersion: 4,
  issue: 89,
  issueSessionId: `issue-89:${"a".repeat(40)}`,
  baselineSha: "a".repeat(40),
  profile: "consensus",
  originalRoster: ["claude", "codex"],
  branchTemplate: "issue-{issue}/{agent}",
  baseBranch: "main",
  maxRevisionRounds: 3,
  prPolicy: "owner-only",
  automationDigest: "b".repeat(64),
  automationDigestScheme: "sha256-length-prefixed-v1",
  automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
  trustedSourceCommit: "c".repeat(40),
  origin: "https://github.com/example/fixture.git",
  coordRoot: "/runtime",
  configPath: "/runtime/config.json",
  agents: [
    { id: "claude", root: "/clone-claude", launcher: "start-claude.sh", delivery: "pull" },
    { id: "codex", root: "/clone-codex", launcher: "start-codex.sh", delivery: "pull" }
  ],
  checks: [{ name: "true", argv: ["true"] }],
  pollIntervalMs: 1000,
  createdAt: "2026-08-21T00:00:00.000Z"
});

const readJournalFixture = (): JournalEvent[] =>
  readFileSync(join(fixtures, "analytics-journal.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => {
      const value = JSON.parse(line) as { formatVersion?: number };
      return journalEventSchema.parse({
        ...value,
        formatVersion: value.formatVersion === 3 ? 4 : value.formatVersion
      });
    });

const transcriptRoots = (): { claude: string; codex: string } => {
  const root = mkdtempSync(join(tmpdir(), "coord-analytics-transcripts-"));
  roots.push(root);
  const claude = join(root, ".claude");
  const codex = join(root, ".codex");
  const claudePath = join(claude, "projects", "fixture", "session-claude.jsonl");
  const codexPath = join(codex, "sessions", "2026", "08", "21", "rollout-fixture-session-codex.jsonl");
  mkdirSync(dirname(claudePath), { recursive: true });
  mkdirSync(dirname(codexPath), { recursive: true });
  copyFileSync(join(fixtures, "transcript-claude.jsonl"), claudePath);
  copyFileSync(join(fixtures, "transcript-codex.jsonl"), codexPath);
  return { claude, codex };
};

/** A Codex root whose only transcript holds two token records and no turn ids. */
const sharedTurnCodexRoot = (): { codex: string } => {
  const root = mkdtempSync(join(tmpdir(), "coord-analytics-shared-turn-"));
  roots.push(root);
  const codex = join(root, ".codex");
  const path = join(codex, "sessions", "2026", "08", "21", "rollout-fixture-session-shared.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(join(fixtures, "transcript-codex-shared-turn.jsonl"), path);
  return { codex };
};

/**
 * Two coordinator actions inside one vendor turn window.
 *
 * `turnIds` supplies the vendor turn id each prompt reported: one shared id is
 * the Codex mid-turn-prompt case, two ids are genuinely different turns.
 */
const nestedWindowJournal = (turnIds: readonly [string, string]): JournalEvent[] =>
  [
    { sequence: 0, at: "2026-08-21T00:00:00.000Z", type: "started", details: { issue: 89, profile: "consensus" } },
    {
      sequence: 1,
      at: "2026-08-21T00:00:00.100Z",
      type: "action-prepared",
      agent: "codex",
      actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      details: { requiredPath: ".plans/issue-89/plan.md" }
    },
    {
      sequence: 2,
      at: "2026-08-21T00:00:01.000Z",
      type: "agent-lifecycle",
      agent: "codex",
      actionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      details: { vendor: "codex", event: "UserPromptSubmit", kind: "prompt-submitted", sessionId: "session-shared", turnId: turnIds[0] }
    },
    { sequence: 3, at: "2026-08-21T00:00:04.000Z", type: "gate-advanced", details: { from: "R1.join", to: "R2.plan", round: null } },
    {
      sequence: 4,
      at: "2026-08-21T00:00:04.100Z",
      type: "action-prepared",
      agent: "codex",
      actionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      details: { requiredPath: ".plans/issue-89/review.md" }
    },
    {
      sequence: 5,
      at: "2026-08-21T00:00:05.000Z",
      type: "agent-lifecycle",
      agent: "codex",
      actionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      details: { vendor: "codex", event: "UserPromptSubmit", kind: "prompt-submitted", sessionId: "session-shared", turnId: turnIds[1] }
    },
    {
      sequence: 6,
      at: "2026-08-21T00:00:08.000Z",
      type: "agent-lifecycle",
      agent: "codex",
      details: { vendor: "codex", event: "Stop", kind: "stopped", sessionId: "session-shared", turnId: turnIds[0] }
    },
    {
      sequence: 7,
      at: "2026-08-21T00:00:09.000Z",
      type: "agent-lifecycle",
      agent: "codex",
      details: { vendor: "codex", event: "Stop", kind: "stopped", sessionId: "session-shared", turnId: turnIds[1] }
    },
    { sequence: 8, at: "2026-08-21T00:00:10.000Z", type: "gate-advanced", details: { from: "R2.plan", to: null, round: null } }
  ].map((event) => journalEventSchema.parse({ formatVersion: 4, ...event }));

const removeBrokenClaudeRecord = (roots: { claude: string }): void => {
  const path = join(roots.claude, "projects", "fixture", "session-claude.jsonl");
  const records = readFileSync(path, "utf8").trim().split("\n");
  writeFileSync(path, `${records.slice(0, -1).join("\n")}\n`);
};

describe("analytics aggregation", () => {
  it("reconstructs phase/time metrics and joins per-turn tokens and tools to actions", () => {
    const report = buildAnalytics({ start, journal: readJournalFixture(), transcriptRoots: transcriptRoots() });

    expect(report.phaseCount).toBe(2);
    expect(report.phases.map((phase) => [phase.name, phase.durationMs, phase.actions])).toEqual([
      ["R1.join", 60_000, 1],
      ["R2.plan", 120_000, 1]
    ]);
    expect(report.run).toMatchObject({ durationMs: 180_000, state: "complete" });
    expect(report.run.durationMs).toBe(report.phases.reduce((total, phase) => total + (phase.durationMs ?? 0), 0));
    expect(report.waits).toEqual([
      { agent: "claude", count: 1, medianMs: 2400, maxMs: 2400 },
      { agent: "codex", count: 1, medianMs: 54_000, maxMs: 54_000 }
    ]);

    const claude = report.usage?.agents.find((agent) => agent.agent === "claude");
    const codex = report.usage?.agents.find((agent) => agent.agent === "codex");
    expect(claude).toMatchObject({
      tokenCoverage: "partial",
      toolCoverage: "partial",
      phases: [
        {
          phase: "R1.join",
          tokens: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, reasoning: 2 },
          toolCalls: 1
        },
        { phase: "R2.plan", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 0 }
      ],
      unassigned: { toolCalls: 1, records: 2, tokenRecords: 1, toolRecords: 1 }
    });
    expect(codex).toMatchObject({
      tokenCoverage: "complete",
      toolCoverage: "partial",
      phases: [
        { phase: "R1.join", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 0 },
        {
          phase: "R2.plan",
          tokens: { input: 30, output: 28, cacheRead: 100, cacheWrite: 10, reasoning: 8 },
          toolCalls: 1
        }
      ],
      unassigned: { toolCalls: 1, records: 1, tokenRecords: 0, toolRecords: 1 }
    });
    expect(report.usage?.tokenTotal).toBeNull();
    expect(renderAnalytics(report)).toContain("Cross-roster tool total: intentionally not reported");
  });

  it("keeps historical journals useful when no session identity was recorded", () => {
    const historical = readJournalFixture().filter((event) => event.type !== "agent-lifecycle");
    const report = buildAnalytics({ start, journal: historical, transcriptRoots: transcriptRoots() });
    expect(report.phaseCount).toBe(2);
    expect(report.run.durationMs).toBe(180_000);
    expect(report.usage).toBeNull();
    expect(renderAnalytics(report)).not.toContain("Token count");
  });

  it("keeps complete token totals independent from partial tool coverage", () => {
    const roots = transcriptRoots();
    removeBrokenClaudeRecord(roots);
    const report = buildAnalytics({ start, journal: readJournalFixture(), transcriptRoots: roots });
    const codex = report.usage?.agents.find((agent) => agent.agent === "codex");

    expect(codex).toMatchObject({ tokenCoverage: "complete", toolCoverage: "partial" });
    expect(report.usage?.tokenTotal).toEqual({
      input: 33,
      output: 33,
      cacheRead: 107,
      cacheWrite: 21,
      reasoning: 10
    });
  });

  it("degrades coverage when any attempted action lacks session and turn identity", () => {
    const roots = transcriptRoots();
    removeBrokenClaudeRecord(roots);
    const missingActionId = "33333333-3333-4333-8333-333333333333";
    const journal = readJournalFixture();
    journal.splice(
      -1,
      0,
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 12,
        at: "2026-08-21T00:02:10.000Z",
        type: "action-prepared",
        agent: "claude",
        actionId: missingActionId,
        details: { requiredPath: ".plans/issue-89/review.md" }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 13,
        at: "2026-08-21T00:02:11.000Z",
        type: "nudged",
        agent: "claude",
        actionId: missingActionId,
        details: {}
      })
    );
    const report = buildAnalytics({ start, journal, activeRoster: ["claude"], transcriptRoots: roots });
    const claude = report.usage?.agents[0];

    expect(claude).toMatchObject({ tokenCoverage: "partial", toolCoverage: "partial" });
    expect(claude?.tokenReason).toContain("1 attempted action(s) have no complete session/turn identity");
    expect(report.usage?.tokenTotal).toBeNull();
  });

  it("emits the active R1 interval before the first gate", () => {
    const journal = readJournalFixture().filter((event) => event.sequence <= 5);
    const report = buildAnalytics({
      start,
      journal,
      activeRoster: ["claude"],
      now: "2026-08-21T00:00:30.000Z",
      transcriptRoots: transcriptRoots()
    });

    expect(report).toMatchObject({
      phaseCount: 1,
      run: { state: "in-progress", durationMs: 30_000 },
      phases: [{ name: "R1.join", state: "in-progress", actions: 1 }]
    });
    expect(report.usage?.agents[0]?.phases[0]).toMatchObject({
      phase: "R1.join",
      tokens: { input: 3, output: 5 }
    });
    expect(report.usage?.tokenTotal).toBeNull();
  });

  it("pairs every retry response with the immediately preceding nudge", () => {
    const actionId = "44444444-4444-4444-8444-444444444444";
    const journal = [
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 0,
        at: "2026-08-21T00:00:00.000Z",
        type: "started",
        details: { issue: 89, profile: "consensus" }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 1,
        at: "2026-08-21T00:00:00.000Z",
        type: "nudged",
        agent: "codex",
        actionId,
        details: {}
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 2,
        at: "2026-08-21T00:00:10.000Z",
        type: "intent-seen",
        agent: "codex",
        actionId,
        submissionSha: "a".repeat(40),
        details: {}
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 3,
        at: "2026-08-21T00:00:20.000Z",
        type: "nudged",
        agent: "codex",
        actionId,
        details: {}
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 4,
        at: "2026-08-21T00:00:25.000Z",
        type: "intent-seen",
        agent: "codex",
        actionId,
        submissionSha: "b".repeat(40),
        details: {}
      })
    ];
    const report = buildAnalytics({ start, journal, activeRoster: ["codex"], now: "2026-08-21T00:00:30.000Z" });
    expect(report.waits).toEqual([{ agent: "codex", count: 2, medianMs: 10_000, maxMs: 10_000 }]);
  });

  it("retains entry rounds on repeated R6 phases and labels usage rows", () => {
    const actionId = "55555555-5555-4555-8555-555555555555";
    const raw = [
      { sequence: 0, at: "2026-08-21T00:00:00.000Z", type: "started", details: { issue: 89, profile: "consensus" } },
      { sequence: 1, at: "2026-08-21T00:00:00.500Z", type: "gate-advanced", details: { from: "R1.join", to: "R6.revise", round: 1 } },
      { sequence: 2, at: "2026-08-21T00:00:00.600Z", type: "action-prepared", agent: "claude", actionId, details: { requiredPath: ".code-reviews/issue-89/revise.md" } },
      { sequence: 3, at: "2026-08-21T00:00:00.700Z", type: "nudged", agent: "claude", actionId, details: {} },
      { sequence: 4, at: "2026-08-21T00:00:01.000Z", type: "agent-lifecycle", agent: "claude", actionId, details: { vendor: "claude", event: "UserPromptSubmit", kind: "prompt-submitted", execution: "working", health: "healthy", sessionId: "session-claude", turnId: "turn-claude-1" } },
      { sequence: 5, at: "2026-08-21T00:00:03.500Z", type: "agent-lifecycle", agent: "claude", details: { vendor: "claude", event: "Stop", kind: "stopped", execution: "idle", health: "healthy", sessionId: "session-claude", turnId: "turn-claude-1" } },
      { sequence: 6, at: "2026-08-21T00:00:04.000Z", type: "gate-advanced", details: { from: "R6.revise", to: "R6.ballot", round: 1 } },
      { sequence: 7, at: "2026-08-21T00:00:05.000Z", type: "gate-advanced", details: { from: "R6.ballot", to: "R7.finalize", round: null } },
      { sequence: 8, at: "2026-08-21T00:00:06.000Z", type: "gate-advanced", details: { from: "R7.finalize", to: "R6.revise", round: 2 } },
      { sequence: 9, at: "2026-08-21T00:00:07.000Z", type: "gate-advanced", details: { from: "R6.revise", to: "R6.ballot", round: 2 } },
      { sequence: 10, at: "2026-08-21T00:00:08.000Z", type: "gate-advanced", details: { from: "R6.ballot", to: "R7.finalize", round: null } },
      { sequence: 11, at: "2026-08-21T00:00:09.000Z", type: "gate-advanced", details: { from: "R7.finalize", to: null, round: null } }
    ];
    const journal = raw.map((event) => journalEventSchema.parse({ formatVersion: 4, ...event }));
    const report = buildAnalytics({ start, journal, activeRoster: ["claude"], transcriptRoots: transcriptRoots() });

    expect(report.phases.filter((phase) => phase.name.startsWith("R6.")).map((phase) => [phase.name, phase.round])).toEqual([
      ["R6.revise", 1],
      ["R6.ballot", 1],
      ["R6.revise", 2],
      ["R6.ballot", 2]
    ]);
    const rendered = renderAnalytics(report);
    expect(rendered.match(/R6\.revise round 1/g)).toHaveLength(3);
    expect(rendered.match(/R6\.revise round 2/g)).toHaveLength(3);
  });

  it("labels a timestamp-window attribution partial and leaves unmatched records unassigned", () => {
    const journal = readJournalFixture().map((event) =>
      event.type === "agent-lifecycle" && event.agent === "claude" && event.details.kind === "stopped"
        ? journalEventSchema.parse({ ...event, at: "2026-08-21T00:00:05.000Z" })
        : event
    );
    const report = buildAnalytics({ start, journal, transcriptRoots: transcriptRoots() });
    const claude = report.usage?.agents.find((agent) => agent.agent === "claude");
    expect(claude).toMatchObject({ tokenCoverage: "partial", toolCoverage: "partial", unassigned: { records: 0 } });
    expect(claude?.tokenReason).toContain("non-exact attribution fallback");
    expect(report.usage?.tokenTotal).toBeNull();
  });

  it("reports invalid rather than negative intervals", () => {
    const journal = readJournalFixture().map((event) =>
      event.type === "gate-advanced" && event.sequence === 6
        ? journalEventSchema.parse({ ...event, at: "2026-08-20T23:59:00.000Z" })
        : event
    );
    const report = buildAnalytics({ start, journal, transcriptRoots: transcriptRoots() });
    expect(report.phases[0]).toMatchObject({ durationMs: null, state: "invalid" });
  });

  it("uses null, not zero, for an active agent without a supported store", () => {
    const report = buildAnalytics({
      start,
      journal: readJournalFixture(),
      activeRoster: ["claude", "cursor"],
      transcriptRoots: transcriptRoots()
    });
    const cursor = report.usage?.agents.find((agent) => agent.agent === "cursor");
    expect(cursor).toMatchObject({ tokenCoverage: "unavailable", toolCoverage: "unavailable" });
    expect(cursor?.phases.every((phase) => phase.tokens === null && phase.toolCalls === null)).toBe(true);
    expect(report.usage?.tokenTotal).toBeNull();
  });

  it("aggregates Cursor hook usage from journaled agent-usage events", () => {
    const cursorStart = startStateSchema.parse({
      ...start,
      originalRoster: ["cursor"],
      agents: [{ id: "cursor", root: "/clone-cursor", launcher: "start-cursor.sh", delivery: "pull" }]
    });
    const journal = [
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 0,
        at: "2026-08-21T00:00:00.000Z",
        type: "started",
        details: { issue: 94, profile: "solo" }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 1,
        at: "2026-08-21T00:00:01.000Z",
        type: "action-prepared",
        agent: "cursor",
        actionId: "11111111-1111-4111-8111-111111111111",
        details: { requiredPath: ".plans/issue-94/plan.md" }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 2,
        at: "2026-08-21T00:00:02.000Z",
        type: "agent-lifecycle",
        agent: "cursor",
        actionId: "11111111-1111-4111-8111-111111111111",
        details: {
          vendor: "cursor",
          event: "beforeSubmitPrompt",
          kind: "prompt-submitted",
          sessionId: "conversation-1",
          turnId: "generation-1"
        }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 3,
        at: "2026-08-21T00:00:03.000Z",
        type: "agent-usage",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "postToolUse",
          kind: "tool-used",
          sessionId: "conversation-1",
          turnId: "generation-1",
          toolCalls: 1
        }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 4,
        at: "2026-08-21T00:00:04.000Z",
        type: "agent-usage",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "afterAgentResponse",
          kind: "turn-usage",
          sessionId: "conversation-1",
          turnId: "generation-1",
          tokens: { input_tokens: 40, output_tokens: 8, cache_read_tokens: 12, cache_write_tokens: 0 }
        }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 5,
        at: "2026-08-21T00:00:05.000Z",
        type: "agent-lifecycle",
        agent: "cursor",
        details: {
          vendor: "cursor",
          event: "stop",
          kind: "stopped",
          sessionId: "conversation-1",
          turnId: "generation-1"
        }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 6,
        at: "2026-08-21T00:01:00.000Z",
        type: "gate-advanced",
        details: { from: "R1.join", to: null, round: null }
      })
    ];
    const report = buildAnalytics({ start: cursorStart, journal });
    const cursor = report.usage?.agents.find((agent) => agent.agent === "cursor");
    expect(cursor).toMatchObject({
      vendor: "cursor",
      tokenCoverage: "complete",
      toolCoverage: "complete",
      phases: [{ phase: "R1.join", tokens: { input: 40, output: 8, cacheRead: 12, cacheWrite: 0 }, toolCalls: 1 }]
    });
    expect(renderAnalytics(report)).toContain("cursor: coverage=complete");
  });

  it("assigns records shared by one vendor turn to the latest action, labelled partial", () => {
    const codexStart = startStateSchema.parse({
      ...start,
      originalRoster: ["codex"],
      agents: [{ id: "codex", root: "/clone-codex", launcher: "start-codex.sh", delivery: "pull" }]
    });
    const report = buildAnalytics({
      start: codexStart,
      journal: nestedWindowJournal(["turn-shared", "turn-shared"]),
      activeRoster: ["codex"],
      transcriptRoots: sharedTurnCodexRoot()
    });
    const codex = report.usage?.agents.find((agent) => agent.agent === "codex");

    // The record inside only the first window is exact; the record inside both
    // belongs to one vendor turn, so it lands in the later action's phase
    // rather than being discarded.
    expect(codex?.phases.map((phase) => [phase.phase, phase.tokens?.output])).toEqual([
      ["R1.join", 10],
      ["R2.plan", 30]
    ]);
    expect(codex?.unassigned.tokenRecords).toBe(0);
    expect(codex?.tokenCoverage).toBe("partial");
    expect(codex?.tokenReason).toContain("shared by one vendor turn across several actions");
    expect(report.usage?.tokenTotal).toBeNull();
  });

  it("leaves records unassigned when overlapping windows are different vendor turns", () => {
    const codexStart = startStateSchema.parse({
      ...start,
      originalRoster: ["codex"],
      agents: [{ id: "codex", root: "/clone-codex", launcher: "start-codex.sh", delivery: "pull" }]
    });
    const report = buildAnalytics({
      start: codexStart,
      journal: nestedWindowJournal(["turn-one", "turn-two"]),
      activeRoster: ["codex"],
      transcriptRoots: sharedTurnCodexRoot()
    });
    const codex = report.usage?.agents.find((agent) => agent.agent === "codex");

    expect(codex?.phases.map((phase) => [phase.phase, phase.tokens?.output])).toEqual([
      ["R1.join", 10],
      ["R2.plan", 0]
    ]);
    expect(codex?.unassigned.tokenRecords).toBe(1);
    expect(codex?.tokenReason).toContain("unassigned");
    expect(codex?.tokenReason).not.toContain("shared by one vendor turn");
  });

  it("splits the headline run into elapsed, paused, and unpaused time", () => {
    const journal = [
      { sequence: 0, at: "2026-08-21T00:00:00.000Z", type: "started", details: { issue: 89, profile: "consensus" } },
      { sequence: 1, at: "2026-08-21T00:01:00.000Z", type: "paused", details: {} },
      // A duplicate pause must not open a second interval.
      { sequence: 2, at: "2026-08-21T00:02:00.000Z", type: "paused", details: {} },
      { sequence: 3, at: "2026-08-21T00:03:00.000Z", type: "resumed", details: {} },
      // A resume with nothing paused is a no-op, not negative time.
      { sequence: 4, at: "2026-08-21T00:04:00.000Z", type: "resumed", details: {} },
      { sequence: 5, at: "2026-08-21T00:08:00.000Z", type: "paused", details: {} },
      { sequence: 6, at: "2026-08-21T00:10:00.000Z", type: "gate-advanced", details: { from: "R1.join", to: null, round: null } }
    ].map((event) => journalEventSchema.parse({ formatVersion: 4, ...event }));
    const report = buildAnalytics({ start, journal, activeRoster: ["claude"], now: "2026-08-21T00:20:00.000Z" });

    // 2 min of the closed pause, plus the pause still open at the run's end.
    expect(report.run).toMatchObject({ durationMs: 600_000, pausedMs: 240_000, unpausedMs: 360_000 });
    expect(renderAnalytics(report)).toContain("Run: elapsed 10.00 min; paused 4.00 min; unpaused 6.00 min");
  });

  it("reports zero paused time, and never null, for a run that was never paused", () => {
    const report = buildAnalytics({ start, journal: readJournalFixture(), transcriptRoots: transcriptRoots() });
    expect(report.run.pausedMs).toBe(0);
    expect(report.run.unpausedMs).toBe(report.run.durationMs);
  });

  it("measures a wait from the first outstanding nudge, so a late retry cannot hide the stall", () => {
    const actionId = "66666666-6666-4666-8666-666666666666";
    const journal = [
      { sequence: 0, at: "2026-08-21T00:00:00.000Z", type: "started", details: { issue: 89, profile: "consensus" } },
      { sequence: 1, at: "2026-08-21T00:00:00.000Z", type: "nudged", agent: "claude", actionId, details: {} },
      { sequence: 2, at: "2026-08-21T01:00:00.000Z", type: "nudged", agent: "claude", actionId, details: {} },
      {
        sequence: 3,
        at: "2026-08-21T01:05:00.000Z",
        type: "intent-seen",
        agent: "claude",
        actionId,
        submissionSha: "a".repeat(40),
        details: {}
      },
      { sequence: 4, at: "2026-08-21T01:05:00.000Z", type: "response-accepted", agent: "claude", actionId, details: {} }
    ].map((event) => journalEventSchema.parse({ formatVersion: 4, ...event }));
    const report = buildAnalytics({ start, journal, activeRoster: ["claude"], now: "2026-08-21T01:10:00.000Z" });

    expect(report.waits).toEqual([{ agent: "claude", count: 1, medianMs: 3_900_000, maxMs: 3_900_000 }]);
    // The two tables sit side by side under matching labels, so the ballot
    // table must anchor on the same nudge.
    expect(report.responseLatency).toEqual([{ agent: "claude", count: 1, medianMs: 3_900_000, maxMs: 3_900_000 }]);
  });

  it("reports final-check durations and leaves an unmeasured check unavailable", () => {
    const actionId = "77777777-7777-4777-8777-777777777777";
    const journal = [
      { sequence: 0, at: "2026-08-21T00:00:00.000Z", type: "started", details: { issue: 89, profile: "consensus" } },
      {
        sequence: 1,
        at: "2026-08-21T00:01:00.000Z",
        type: "final-check",
        agent: "claude",
        actionId,
        details: { tier: "checks", name: "check", argv: ["pnpm", "run", "check"], exitCode: 1, durationMs: 42_000 }
      },
      {
        sequence: 2,
        at: "2026-08-21T00:02:00.000Z",
        type: "final-check",
        agent: "claude",
        actionId,
        details: { tier: "checks", name: "legacy-check", argv: ["pnpm", "run", "check"], exitCode: 0 }
      },
      { sequence: 3, at: "2026-08-21T00:03:00.000Z", type: "gate-advanced", details: { from: "R1.join", to: null, round: null } }
    ].map((event) => journalEventSchema.parse({ formatVersion: 4, ...event }));
    const report = buildAnalytics({ start, journal, activeRoster: ["claude"] });

    expect(report.finalChecks).toEqual([
      { at: "2026-08-21T00:01:00.000Z", agent: "claude", name: "check", tier: "checks", exitCode: 1, durationMs: 42_000 },
      { at: "2026-08-21T00:02:00.000Z", agent: "claude", name: "legacy-check", tier: "checks", exitCode: 0, durationMs: null }
    ]);
    const rendered = renderAnalytics(report);
    expect(rendered).toContain("- check (tier: checks): exit=1 duration=42.0s");
    // Absent is unavailable, never a zero-cost check.
    expect(rendered).toContain("- legacy-check (tier: checks): exit=0 duration=unavailable");
  });

  it("names the agents that block a cross-roster token total", () => {
    const report = buildAnalytics({
      start,
      journal: readJournalFixture(),
      activeRoster: ["claude", "codex"],
      transcriptRoots: transcriptRoots()
    });
    expect(report.usage?.tokenTotal).toBeNull();
    expect(report.usage?.tokenTotalReason).toContain("claude (coverage=partial)");
    expect(renderAnalytics(report)).toContain("Cross-roster token total: unavailable (not every active agent");
  });

  it("separates agent response latency from evidence-publication latency", () => {
    const actionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const batchId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const journal = [
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 0,
        at: "2026-08-21T00:00:00.000Z",
        type: "started",
        details: { issue: 89, profile: "consensus" }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 1,
        at: "2026-08-21T00:00:01.000Z",
        type: "action-prepared",
        agent: "claude",
        actionId,
        details: {}
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 2,
        at: "2026-08-21T00:00:02.000Z",
        type: "nudged",
        agent: "claude",
        actionId,
        details: {}
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 3,
        at: "2026-08-21T00:00:12.000Z",
        type: "response-accepted",
        agent: "claude",
        actionId,
        details: { responseSha256: "a".repeat(64) }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 4,
        at: "2026-08-21T00:00:13.000Z",
        type: "ballot-batch-pending",
        details: { batchId, kind: "plan-ballot-batch", commitSha: "b".repeat(40) }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 5,
        at: "2026-08-21T00:00:14.000Z",
        type: "ballot-batch-failed",
        details: { batchId, error: "transient" }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 6,
        at: "2026-08-21T00:00:23.000Z",
        type: "ballot-batch-published",
        details: { batchId, kind: "plan-ballot-batch", commitSha: "b".repeat(40) }
      }),
      journalEventSchema.parse({
        formatVersion: 4,
        sequence: 7,
        at: "2026-08-21T00:00:24.000Z",
        type: "gate-advanced",
        details: { from: "R3.plan-ballot", to: "R4.implement", round: null }
      })
    ];
    const report = buildAnalytics({ start, journal, now: "2026-08-21T00:00:24.000Z" });
    expect(report.responseLatency).toEqual([
      { agent: "claude", count: 1, medianMs: 10_000, maxMs: 10_000 },
      { agent: "codex", count: 0, medianMs: null, maxMs: null }
    ]);
    // Failure retry does not start a new interval or add an agent turn.
    expect(report.evidencePublicationLatency).toEqual({ count: 1, medianMs: 10_000, maxMs: 10_000 });
    expect(report.phases[0]?.actions).toBe(1);
    expect(renderAnalytics(report)).toContain("Agent response latency");
    expect(renderAnalytics(report)).toContain("Evidence publication latency");
  });
});

/**
 * The read-only readers that feed a legacy report.
 *
 * They exist only to build this report, so they are exercised beside it: the
 * contract worth pinning is that history stays reportable while the same bytes
 * stay unrunnable.
 */
describe("analytics read-only inputs", () => {
  const legacyRuntime = (journalFixture?: string) => {
    const root = mkdtempSync(join(tmpdir(), "coord-analytics-legacy-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 89);
    mkdirSync(dirname(paths.start), { recursive: true });
    writeFileSync(paths.start, `${JSON.stringify({ ...start, formatVersion: 2 }, null, 2)}\n`);
    if (journalFixture !== undefined) copyFileSync(join(fixtures, journalFixture), paths.journal);
    return paths;
  };

  it("reads a legacy journal for reporting while the strict reader still refuses it", () => {
    const paths = legacyRuntime("analytics-journal-format2.jsonl");
    const before = readFileSync(paths.journal, "utf8");

    const legacy = readJournalForAnalytics(paths);
    expect(legacy.formatVersion).toBe(2);
    expect(isLegacyRuntimeFormat(legacy.formatVersion)).toBe(true);
    expect(legacy.events.some((event) => event.type === "started")).toBe(true);
    expect(legacy.events.some((event) => event.type === "final-check")).toBe(true);
    // The one event type this build no longer knows is counted, not hidden.
    expect(legacy.skipped).toBe(1);

    // The control plane still fails closed on the very same bytes...
    expect(() => readJournal(paths)).toThrow(/Wipe this issue/);
    // ...and reporting rewrote none of them.
    expect(readFileSync(paths.journal, "utf8")).toBe(before);
  });

  it("builds a complete legacy report from those inputs, with no invented usage", () => {
    const paths = legacyRuntime("analytics-journal-format2.jsonl");
    const header = readStartStateHeader(paths);
    const legacy = readJournalForAnalytics(paths);
    const report = buildAnalytics({
      start: header,
      journal: legacy.events,
      activeRoster: header.originalRoster,
      source: { formatVersion: legacy.formatVersion, legacy: true, skippedJournalRecords: legacy.skipped }
    });

    expect(report.run).toMatchObject({ state: "complete", pausedMs: 600_000 });
    // Format 2 recorded no session identity, so there is nothing to attribute.
    expect(report.usage).toBeNull();
    expect(report.finalChecks).toHaveLength(1);
    expect(report.finalChecks[0]?.durationMs).toBeNull();
    const rendered = renderAnalytics(report);
    expect(rendered).toContain("Runtime format 2 (legacy, read-only; this run cannot be resumed)");
    expect(rendered).not.toContain("Token count");
  });

  it("fails on a malformed known event rather than reporting plausible timing", () => {
    const paths = legacyRuntime();
    writeFileSync(
      paths.journal,
      `${[
        JSON.stringify({ formatVersion: 2, sequence: 0, at: "2026-08-19T00:00:00.000Z", type: "started", details: {} }),
        // A terminal boundary with an unusable timestamp: skipping this would
        // render a finished run as still in progress, with its final phase
        // stretched to now.
        JSON.stringify({
          formatVersion: 2,
          sequence: 1,
          at: "not-a-timestamp",
          type: "gate-advanced",
          details: { from: "R1.join", to: null }
        })
      ].join("\n")}\n`
    );
    expect(() => readJournalForAnalytics(paths)).toThrow(/journal line 2/);
  });

  it("resolves legacy start identity through the header, but never for an operational read", () => {
    const paths = legacyRuntime();
    const header = readStartStateHeader(paths);
    expect(header).toMatchObject({ formatVersion: 2, issue: 89, originalRoster: ["claude", "codex"] });
    expect(header.configPath).toBe(start.configPath);
    // Path resolution can reach a read-only report...
    expect(isLegacyRuntimeFormat(header.formatVersion)).toBe(true);
    // ...while every operational read of the same file stays fail-closed.
    expect(() => readStartState(paths)).toThrow(/Wipe this issue/);
  });
});
