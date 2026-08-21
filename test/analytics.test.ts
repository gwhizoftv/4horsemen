import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAnalyticsReport, renderAnalyticsReport } from "../src/analytics.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { journalEventSchema } from "../src/state.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixturePath = (name: string): string => join(process.cwd(), "test/support/fixtures", name);

const loadFixtureJournal = (paths: ReturnType<typeof issueRuntimePaths>, name: string): void => {
  const raw = readFileSync(fixturePath(name), "utf8");
  for (const line of raw.split("\n").filter((entry) => entry !== "")) {
    journalEventSchema.parse(JSON.parse(line));
  }
  writeFileSync(paths.journal, raw.endsWith("\n") ? raw : `${raw}\n`);
};

describe("analytics", () => {
  it("reports phase count, time, and waits from the journal without requiring sessionId", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-analytics-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 89);
    createIssueRuntime(paths, ["claude", "codex"]);
    const lines = readFileSync(fixturePath("analytics-journal.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as { type: string; details?: Record<string, unknown> });
    const stripped = lines.map((event) => {
      if (event.type !== "agent-lifecycle") return event;
      const details = { ...(event.details ?? {}) };
      delete details.sessionId;
      delete details.turnId;
      return { ...event, details };
    });
    writeFileSync(paths.journal, `${stripped.map((event) => JSON.stringify(event)).join("\n")}\n`);

    const report = buildAnalyticsReport({ paths, joinTranscripts: true });
    expect(report.phases.map((phase) => phase.name)).toEqual(["R2.plan", "R3.review"]);
    expect(report.phases[0]?.durationMs).toBe(5 * 60 * 1000);
    expect(report.phases[0]?.actionCount).toBe(2);
    expect(report.phases[1]?.durationMs).toBe(3 * 60 * 1000);
    expect(report.runDurationMs).toBe(8 * 60 * 1000);
    expect(report.agentWaits.find((wait) => wait.agent === "claude")?.medianMs).toBe(63_000);
    expect(report.agentWaits.find((wait) => wait.agent === "codex")?.medianMs).toBe(123_000);
    expect(report.agentUsage).toEqual([]);
    const text = renderAnalyticsReport(report);
    expect(text).toContain("Phases");
    expect(text).toContain("omitted — no sessionId");
  });

  it("joins tokens and tools by turn identity when sessionId is present", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-analytics-join-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 89);
    createIssueRuntime(paths, ["claude", "codex"]);
    loadFixtureJournal(paths, "analytics-journal.jsonl");

    const claudeRoot = join(root, "claude-store");
    const codexRoot = join(root, "codex-store");
    const claudeDir = join(claudeRoot, "projects", "-tmp-clone-claude");
    const codexDir = join(codexRoot, "sessions", "2026", "08", "20");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(codexDir, { recursive: true });
    copyFileSync(fixturePath("transcript-claude.jsonl"), join(claudeDir, "claude-session-1.jsonl"));
    copyFileSync(
      fixturePath("transcript-codex.jsonl"),
      join(codexDir, "rollout-2026-08-20T18-00-00-codex-session-1.jsonl")
    );

    const report = buildAnalyticsReport({
      paths,
      transcriptRoots: { claude: claudeRoot, codex: codexRoot }
    });

    const claude = report.agentUsage.find((row) => row.agent === "claude");
    const codex = report.agentUsage.find((row) => row.agent === "codex");
    expect(claude?.coverage).toBe("complete");
    expect(claude?.tokens?.input).toBe(13);
    expect(claude?.toolCalls).toBe(3);
    expect(claude?.unassignedTokens?.input).toBe(1);
    expect(codex?.tokens?.input).toBe(100);
    expect(codex?.toolCalls).toBe(1);
    expect(report.crossRosterTotals?.tokens.input).toBe(113);
    expect(report.crossRosterTotals?.toolCalls).toBe(4);
  });

  it("reports invalid duration when an interval goes backwards", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-analytics-invalid-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["claude"]);
    writeFileSync(
      paths.journal,
      `${[
        {
          formatVersion: 2,
          sequence: 0,
          at: "2026-08-20T18:10:00.000Z",
          type: "started",
          details: { issue: 1, profile: "solo" }
        },
        {
          formatVersion: 2,
          sequence: 1,
          at: "2026-08-20T18:00:00.000Z",
          type: "gate-advanced",
          details: { from: "R1.join", to: null, round: null }
        }
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`
    );
    const report = buildAnalyticsReport({ paths });
    expect(report.phases[0]?.status).toBe("invalid");
    expect(report.phases[0]?.durationMs).toBeNull();
  });

  it("reproduces issue-76 phase minutes from the preserved runtime journal", () => {
    const journalPath = "/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/journal.jsonl";
    const root = mkdtempSync(join(tmpdir(), "coord-analytics-76-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 76);
    createIssueRuntime(paths, ["claude", "codex", "cursor", "antigravity"]);
    writeFileSync(paths.journal, readFileSync(journalPath));
    const report = buildAnalyticsReport({ paths, joinTranscripts: false });
    const expected: Record<string, number> = {
      "R1.join": 6.55,
      "R2.plan": 5.39,
      "R3.review": 4.38,
      "R3.plan-ballot": 1.05,
      "R3.publish-selection": 1.11,
      "R4.implement": 19.27,
      "R5.compare": 9.19,
      "R5.compare-ballot": 2.01,
      "R5.reviser-auth": 0.61,
      "R6.revise": 5.49,
      "R6.ballot": 3.04,
      "R6.declare": 0.59,
      "R7.finalize": 5.78
    };
    for (const phase of report.phases) {
      const minutes = (phase.durationMs ?? 0) / 60_000;
      expect(minutes).toBeCloseTo(expected[phase.name] as number, 2);
    }
    expect((report.runDurationMs ?? 0) / 60_000).toBeCloseTo(64.5, 1);
  });
});
