import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalytics, renderAnalytics } from "../src/analytics.js";
import { journalEventSchema, startStateSchema, type JournalEvent } from "../src/state.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "support", "fixtures");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const start = startStateSchema.parse({
  formatVersion: 2,
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
    .map((line) => journalEventSchema.parse(JSON.parse(line) as unknown));

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
      coverage: "complete",
      phases: [
        {
          phase: "R1.join",
          tokens: { input: 3, output: 5, cacheRead: 7, cacheWrite: 11, reasoning: 2 },
          toolCalls: 1
        },
        { phase: "R2.plan", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 0 }
      ],
      unassigned: { toolCalls: 1, records: 2 }
    });
    expect(codex).toMatchObject({
      coverage: "complete",
      phases: [
        { phase: "R1.join", tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, toolCalls: 0 },
        {
          phase: "R2.plan",
          tokens: { input: 20, output: 20, cacheRead: 70, cacheWrite: 10, reasoning: 5 },
          toolCalls: 1
        }
      ],
      unassigned: { toolCalls: 1, records: 1 }
    });
    expect(report.usage?.tokenTotal).toEqual({
      input: 23,
      output: 25,
      cacheRead: 77,
      cacheWrite: 21,
      reasoning: 7
    });
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

  it("labels a timestamp-window attribution partial and leaves unmatched records unassigned", () => {
    const journal = readJournalFixture().map((event) =>
      event.type === "agent-lifecycle" && event.agent === "claude" && event.details.kind === "stopped"
        ? journalEventSchema.parse({ ...event, at: "2026-08-21T00:00:05.000Z" })
        : event
    );
    const report = buildAnalytics({ start, journal, transcriptRoots: transcriptRoots() });
    const claude = report.usage?.agents.find((agent) => agent.agent === "claude");
    expect(claude).toMatchObject({ coverage: "partial", unassigned: { records: 0 } });
    expect(claude?.reason).toContain("timestamp-window fallback");
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
    expect(cursor).toMatchObject({ coverage: "unavailable" });
    expect(cursor?.phases.every((phase) => phase.tokens === null && phase.toolCalls === null)).toBe(true);
    expect(report.usage?.tokenTotal).toBeNull();
  });
});
