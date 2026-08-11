import { describe, expect, it } from "vitest";
import { decide } from "../src/machine.js";
import { cursorsStateSchema, initialCursors, startStateSchema, type AcceptedSubmission } from "../src/state.js";

const now = "2026-08-11T12:00:00.000Z";
const roster = ["claude", "codex", "cursor", "antigravity"];

const start = startStateSchema.parse({
  formatVersion: 1,
  issue: 1,
  issueSessionId: `issue-1:${"a".repeat(40)}`,
  baselineSha: "a".repeat(40),
  profile: "consensus",
  originalRoster: roster,
  branchTemplate: "issue-{issue}/{agent}",
  baseBranch: "main",
  maxRevisionRounds: 3,
  prPolicy: "owner-only",
  automationDigest: "b".repeat(64),
  trustedSourceCommit: "c".repeat(40),
  origin: "/origin.git",
  coordRoot: "/runtime",
  configPath: "/config.json",
  agents: roster.map((id) => ({ id, root: `/clones/${id}`, launcher: `start-${id}.sh`, delivery: "pull" })),
  checks: [{ name: "check", argv: ["pnpm", "check"] }],
  pollIntervalMs: 1000,
  createdAt: now
});

const accepted = (
  stepId: AcceptedSubmission["stepId"],
  agent: string,
  round: number | null = null,
  disposition?: AcceptedSubmission["disposition"]
): AcceptedSubmission => ({
  stepId,
  agent,
  round,
  submissionSha: (agent.charCodeAt(0) % 10).toString().repeat(40),
  path: `.signals/issue-1/${agent}.json`,
  acceptedAt: now,
  ...(disposition === undefined ? {} : { disposition })
});

describe("pure workflow machine", () => {
  it("orders all four consensus participants at the join gate", () => {
    const decisions = decide({ start, cursors: initialCursors(start, now) });
    expect(decisions).toEqual(
      roster.map((agent) => ({ type: "prepare-action", agent, stepId: "R1.join", round: null }))
    );
  });

  it("advances only after the active gate denominator is satisfied", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R2.plan", gateId: "gate-2-plans", round: null },
      accepted: roster.slice(0, 3).map((agent) => accepted("R2.plan", agent))
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "prepare-action", agent: "antigravity", stepId: "R2.plan", round: null }
    ]);
    const complete = cursorsStateSchema.parse({ ...cursors, accepted: roster.map((agent) => accepted("R2.plan", agent)) });
    expect(decide({ start, cursors: complete })).toEqual([
      { type: "advance-step", from: "R2.plan", to: "R3.review", round: null }
    ]);
  });

  it("degrades future work to solo checks when one active agent remains", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      activeRoster: ["claude"],
      droppedAgents: ["codex", "cursor", "antigravity"],
      issueCursor: { stepId: "R5.compare", gateId: "gate-5-comparison", round: null }
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "advance-step", from: "R5.compare", to: "R7.finalize", round: null }
    ]);
  });

  it("never enters revision round four", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 3 },
      accepted: roster.map((agent) => accepted("R6.ballot", agent, 3, agent === "codex" ? "revise" : "approve"))
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "owner-action-required", reason: "revision limit 3 reached; round 4 is forbidden" }
    ]);
  });

  it("keeps retry and rejection separate from acceptance", () => {
    const base = initialCursors(start, now);
    const actionId = "ce80f31a-6884-42cf-b0ff-b0fb27fc6cc8";
    const cursors = cursorsStateSchema.parse({
      ...base,
      agents: {
        ...base.agents,
        claude: { ...base.agents.claude, actionId, stepId: "R1.join", evidenceId: "join-published", status: "verifying" }
      }
    });
    expect(
      decide({
        start,
        cursors,
        observations: [
          { agent: "claude", actionId, submissionSha: "d".repeat(40), status: "retry", outstanding: ["fetch failed"] }
        ]
      })
    ).toEqual([{ type: "retry-verification", agent: "claude", outstanding: ["fetch failed"] }]);
  });
});
