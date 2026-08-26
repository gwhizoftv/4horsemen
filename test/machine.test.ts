import { describe, expect, it } from "vitest";
import { decide } from "../src/machine.js";
import {
  cursorsStateSchema,
  initialCursors,
  startStateSchema,
  type AcceptedResponse,
  type AcceptedSubmission,
  type BallotBatch
} from "../src/state.js";

const now = "2026-08-11T12:00:00.000Z";
const roster = ["claude", "codex", "cursor", "antigravity"];

const start = startStateSchema.parse({
  formatVersion: 4,
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
  automationDigestScheme: "sha256-length-prefixed-v1",
  automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
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

/**
 * A ballot is an accepted response now, not an accepted Git submission, so the
 * consensus routing fixtures build one of these instead.
 */
const responded = (
  stepId: AcceptedResponse["stepId"],
  agent: string,
  round: number | null = null,
  disposition?: AcceptedResponse["disposition"]
): AcceptedResponse => ({
  stepId,
  agent,
  actionId: `ce80f31a-6884-42cf-b0ff-b0fb27fc6cc${agent.charCodeAt(0) % 10}`,
  round,
  responseSha256: (agent.charCodeAt(0) % 10).toString().repeat(64),
  rationale: "because",
  acceptedAt: now,
  ...(disposition === undefined ? {} : { disposition })
});

/** A published batch covering one gate/round, so the barrier is satisfied. */
const publishedBatch = (
  stepId: AcceptedResponse["stepId"],
  round: number | null
): BallotBatch => ({
  kind:
    stepId === "R3.plan-ballot"
      ? "plan-ballot-batch"
      : stepId === "R5.compare-ballot"
        ? "comparison-ballot-batch"
        : "consensus-ballot-batch",
  stepId,
  round,
  activeRoster: [...roster],
  inputSetHash: "a".repeat(64),
  responseSha256s: ["b".repeat(64)],
  paths: [".code-reviews/issue-1/consensus-ballot-claude-round-1.json"],
  branch: "issue-1/coordinator-evidence",
  parentSha: "c".repeat(40),
  commitSha: "d".repeat(40),
  status: "published",
  attempts: 0,
  error: null,
  supersedes: null,
  createdAt: now,
  publishedAt: now
});

const implementationDerived = {
  kind: "implementation-selection" as const,
  algorithm: "plurality-active-roster-v1" as const,
  inputSetHash: "d".repeat(64),
  activeRoster: roster,
  inputs: [
    {
      source: "git-submission" as const,
      kind: "implementation" as const,
      agent: "codex",
      submissionSha: "e".repeat(40),
      path: ".signals/issue-1/implementation-ready-codex.json",
      productPin: "d".repeat(40)
    }
  ],
  decisionId: `implementation-selection:${"d".repeat(64)}`,
  supersedes: null,
  decidedAt: now,
  winner: "codex",
  implementationPin: "d".repeat(40),
  reviser: "codex"
};

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
      derived: { ...base.derived, implementationSelection: implementationDerived },
      responses: roster.map((agent) => responded("R6.ballot", agent, 3, agent === "codex" ? "revise" : "approve")),
      ballotBatches: [publishedBatch("R6.ballot", 3)]
    });
    expect(decide({ start, cursors })).toEqual([
      {
        type: "owner-action-required",
        reason: "revision limit 3 reached; round 4 is forbidden",
        kind: "revision-limit",
        round: 3,
        allowedAnswers: ["retry", "abandon"]
      }
    ]);
  });

  it("routes revision work to the persisted authorized reviser", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.revise", gateId: "gate-6-consensus", round: 1 },
      derived: {
        planSelection: null,
        implementationSelection: {
          kind: "implementation-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "d".repeat(64),
          activeRoster: roster,
          inputs: [
            {
              source: "git-submission" as const,
              kind: "implementation",
              agent: "cursor",
              submissionSha: "e".repeat(40),
              path: ".signals/issue-1/implementation-ready-cursor.json",
              productPin: "d".repeat(40)
            }
          ],
          decisionId: `implementation-selection:${"d".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          winner: "cursor",
          implementationPin: "d".repeat(40),
          reviser: "cursor"
        },
        consensus: null
      }
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "prepare-action", agent: "cursor", stepId: "R6.revise", round: 1 }
    ]);
  });

  it("routes reviewed implementation to the selected plan winner", () => {
    const reviewed = startStateSchema.parse({ ...start, profile: "reviewed" });
    const base = initialCursors(reviewed, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
      derived: {
        planSelection: {
          kind: "plan-selection",
          algorithm: "plurality-active-roster-v1",
          inputSetHash: "d".repeat(64),
          activeRoster: reviewed.originalRoster,
          inputs: [
            {
              source: "git-submission" as const,
              kind: "plan",
              agent: "cursor",
              submissionSha: "e".repeat(40),
              path: ".plans/issue-1/plan-cursor.md"
            }
          ],
          decisionId: `plan-selection:${"d".repeat(64)}`,
          supersedes: null,
          decidedAt: now,
          selectedAgents: ["cursor"]
        },
        implementationSelection: null,
        consensus: null
      }
    });
    expect(decide({ start: reviewed, cursors })).toEqual([
      { type: "prepare-action", agent: "cursor", stepId: "R4.implement", round: null }
    ]);
  });

  it("advances revise dispositions through round three and types escalations", () => {
    const base = initialCursors(start, now);
    const revision = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      responses: roster.map((agent) => responded("R6.ballot", agent, 1, agent === "codex" ? "revise" : "approve")),
      ballotBatches: [publishedBatch("R6.ballot", 1)]
    });
    expect(decide({ start, cursors: revision })).toEqual([
      { type: "advance-step", from: "R6.ballot", to: "R6.revise", round: 2 }
    ]);
    const escalation = cursorsStateSchema.parse({
      ...revision,
      responses: roster.map((agent) => responded("R6.ballot", agent, 1, agent === "codex" ? "escalate" : "approve")),
      ballotBatches: [publishedBatch("R6.ballot", 1)]
    });
    expect(decide({ start, cursors: escalation })).toEqual([
      {
        type: "owner-action-required",
        reason: "consensus ballot round 1 requested escalation",
        kind: "ballot-escalation",
        round: 1,
        allowedAnswers: ["retry", "revise", "abandon"]
      }
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

  it("processes an in-flight satisfied observation before repeating an owner question", () => {
    const base = initialCursors(start, now);
    const actionId = "ce80f31a-6884-42cf-b0ff-b0fb27fc6cc8";
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      ownerQuestion: {
        id: "10000000-0000-4000-8000-000000000001",
        kind: "ballot-escalation",
        round: 1,
        allowedAnswers: ["retry", "revise", "abandon"],
        createdAt: now
      },
      agents: {
        ...base.agents,
        claude: {
          ...base.agents.claude,
          actionId,
          stepId: "R6.ballot",
          evidenceId: "consensus-ballot-accepted",
          status: "verifying"
        }
      }
    });
    expect(
      decide({
        start,
        cursors,
        observations: [
          {
            agent: "claude",
            actionId,
            submissionSha: "d".repeat(40),
            status: "satisfied",
            outstanding: [],
            disposition: "approve"
          }
        ]
      })
    ).toEqual([
      {
        type: "accept-submission",
        agent: "claude",
        submissionSha: "d".repeat(40),
        disposition: "approve"
      }
    ]);
  });
});

describe("ballot publication barrier", () => {
  const planCursors = (overrides: Partial<ReturnType<typeof initialCursors>> = {}) => {
    const base = initialCursors(start, now);
    return cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R3.plan-ballot", gateId: "gate-3-selection", round: null },
      accepted: roster.map((agent) => accepted("R2.plan", agent)),
      ...overrides
    });
  };

  it("asks for publication rather than waiting once the denominator closes", () => {
    // The barrier has to be a decision, not a `wait`: the run loop acts only on
    // non-`wait` decisions, so a barrier that merely waited would never produce
    // the batch it was waiting for and the issue would stall forever.
    const cursors = planCursors({
      responses: roster.map((agent) => responded("R3.plan-ballot", agent))
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "publish-ballot-batch", stepId: "R3.plan-ballot", round: null }
    ]);
  });

  it("derives only after a batch covering that exact gate is on origin", () => {
    const responses = roster.map((agent) => responded("R3.plan-ballot", agent));

    // A batch that is pending, failed, or invalidated is not publication.
    for (const status of ["pending", "failed", "invalidated"] as const) {
      const cursors = planCursors({
        responses,
        ballotBatches: [{ ...publishedBatch("R3.plan-ballot", null), status }]
      });
      expect(decide({ start, cursors }), status).toEqual([
        { type: "publish-ballot-batch", stepId: "R3.plan-ballot", round: null }
      ]);
    }

    // Neither is a published batch for a different gate or round.
    expect(
      decide({
        start,
        cursors: planCursors({ responses, ballotBatches: [publishedBatch("R6.ballot", 1)] })
      })
    ).toEqual([{ type: "publish-ballot-batch", stepId: "R3.plan-ballot", round: null }]);

    expect(
      decide({
        start,
        cursors: planCursors({ responses, ballotBatches: [publishedBatch("R3.plan-ballot", null)] })
      })
    ).toEqual([{ type: "derive-plan-selection" }]);
  });

  it("holds escalation and revision routing behind the same barrier", () => {
    const base = initialCursors(start, now);
    const consensus = (
      disposition: "revise" | "escalate",
      batches: readonly ReturnType<typeof publishedBatch>[]
    ) =>
      cursorsStateSchema.parse({
        ...base,
        issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
        derived: { ...base.derived, implementationSelection: implementationDerived },
        responses: roster.map((agent) =>
          responded("R6.ballot", agent, 1, agent === "codex" ? disposition : "approve")
        ),
        ballotBatches: [...batches]
      });

    // An outcome routed before its ballots reached origin would advance the
    // workflow on evidence nobody can read afterwards.
    for (const disposition of ["revise", "escalate"] as const) {
      expect(decide({ start, cursors: consensus(disposition, []) }), disposition).toEqual([
        { type: "publish-ballot-batch", stepId: "R6.ballot", round: 1 }
      ]);
    }
    expect(decide({ start, cursors: consensus("revise", [publishedBatch("R6.ballot", 1)]) })).toEqual([
      { type: "advance-step", from: "R6.ballot", to: "R6.revise", round: 2 }
    ]);
    expect(
      decide({ start, cursors: consensus("escalate", [publishedBatch("R6.ballot", 1)]) })[0]?.type
    ).toBe("owner-action-required");
  });

  it("does not publish while any active agent still owes a response", () => {
    const cursors = planCursors({
      responses: [responded("R3.plan-ballot", "claude")]
    });
    // An incomplete denominator prepares the missing action instead.
    expect(decide({ start, cursors }).every((decision) => decision.type !== "publish-ballot-batch")).toBe(true);
  });

  it("refuses to count a pushed Git artifact as a ballot", () => {
    // An agent that pushes a ballot-shaped file to its own branch has not voted.
    const cursors = planCursors({
      accepted: [
        ...roster.map((agent) => accepted("R2.plan", agent)),
        ...roster.map((agent) => accepted("R3.plan-ballot", agent))
      ]
    });
    expect(decide({ start, cursors }).every((decision) => decision.type !== "publish-ballot-batch")).toBe(true);
    expect(decide({ start, cursors }).every((decision) => decision.type !== "derive-plan-selection")).toBe(true);
  });
});
