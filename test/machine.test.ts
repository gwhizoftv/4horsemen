import { createHash } from "node:crypto";
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

const responseDigest = (seed: string): string => createHash("sha256").update(seed, "utf8").digest("hex");
const gitSha = (seed: string): string =>
  createHash("sha256").update(`git:${seed}`, "utf8").digest("hex").slice(0, 40);
const actionIdFor = (agent: string): string => {
  const nibble = (agent.charCodeAt(0) % 10).toString();
  return `10000000-0000-4000-8000-${`${nibble}0`.padStart(12, "0")}`;
};
const acceptedResponseFixture = (input: {
  stepId: AcceptedResponse["stepId"];
  agent: string;
  round?: number | null;
  choice?: string;
  disposition?: AcceptedResponse["disposition"];
  acceptedAt?: string;
}): AcceptedResponse => {
  const actionId = actionIdFor(input.agent);
  return {
    stepId: input.stepId,
    agent: input.agent,
    actionId,
    round: input.round === undefined ? null : input.round,
    responseSha256: responseDigest(input.agent),
    rationale: "fixture rationale",
    path: `/runtime/accepted-responses/${input.agent}/${actionId}.json`,
    acceptedAt: input.acceptedAt ?? now,
    ...(input.choice === undefined ? {} : { choice: input.choice }),
    ...(input.disposition === undefined ? {} : { disposition: input.disposition })
  };
};
const publishedBallotBatchFixture = (input: {
  kind: BallotBatch["kind"];
  activeRoster: readonly string[];
  round?: number | null;
  commitSha?: string;
  createdAt?: string;
}): BallotBatch => {
  const createdAt = input.createdAt ?? now;
  const round = input.round === undefined ? null : input.round;
  return {
    batchId: "20000000-0000-4000-8000-000000000001",
    kind: input.kind,
    round,
    inputSetHash: responseDigest("batch"),
    activeRoster: [...input.activeRoster],
    responses: input.activeRoster.map((agent) => ({
      agent,
      actionId: actionIdFor(agent),
      responseSha256: responseDigest(agent)
    })),
    paths: input.activeRoster.map((agent) =>
      input.kind === "plan-ballot-batch"
        ? `.plans/issue-1/ballot-${agent}.json`
        : input.kind === "comparison-ballot-batch"
          ? `.code-reviews/issue-1/ballot-${agent}.json`
          : `.code-reviews/issue-1/consensus-ballot-${agent}-round-${round ?? 1}.json`
    ),
    branch: "issue-1/coordinator-evidence",
    parentSha: gitSha("a"),
    commitSha: input.commitSha ?? gitSha("b"),
    status: "published",
    attempts: 1,
    error: null,
    supersedes: null,
    createdAt,
    updatedAt: createdAt
  };
};

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

const consensusResponses = (round: number, reviseAgent: string | null, escalateAgent: string | null = null) =>
  roster.map((agent) =>
    acceptedResponseFixture({
      stepId: "R6.ballot",
      agent,
      round,
      acceptedAt: now,
      disposition:
        agent === escalateAgent ? "escalate" : agent === reviseAgent ? "revise" : "approve"
    })
  );

const consensusBatch = (round: number) =>
  publishedBallotBatchFixture({
    kind: "consensus-ballot-batch",
    activeRoster: roster,
    round,
    createdAt: now
  });

const implementationDerived = {
  kind: "implementation-selection" as const,
  algorithm: "plurality-active-roster-v1" as const,
  inputSetHash: "d".repeat(64),
  activeRoster: roster,
  inputs: [
    {
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
      acceptedResponses: consensusResponses(3, "codex"),
      ballotBatches: [consensusBatch(3)]
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
      acceptedResponses: consensusResponses(1, "codex"),
      ballotBatches: [consensusBatch(1)]
    });
    expect(decide({ start, cursors: revision })).toEqual([
      { type: "advance-step", from: "R6.ballot", to: "R6.revise", round: 2 }
    ]);
    const escalation = cursorsStateSchema.parse({
      ...revision,
      acceptedResponses: consensusResponses(1, null, "codex")
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

  it("does not advance a ballot gate before the evidence batch is published", () => {
    const base = initialCursors(start, now);
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: consensusResponses(1, null),
      ballotBatches: []
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "publish-ballot-batch", stepId: "R6.ballot", round: 1 }
    ]);
  });

  it("ignores a published batch whose response digests no longer match the closed set", () => {
    const base = initialCursors(start, now);
    const responses = consensusResponses(1, null);
    const stale = publishedBallotBatchFixture({
      kind: "consensus-ballot-batch",
      activeRoster: base.activeRoster,
      round: 1,
      commitSha: "9".repeat(40)
    });
    stale.responses = stale.responses.map((entry) => ({
      ...entry,
      responseSha256: "f".repeat(64)
    }));
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round: 1 },
      derived: { ...base.derived, implementationSelection: implementationDerived },
      acceptedResponses: responses,
      ballotBatches: [stale],
      evidence: { branch: "issue-1/coordinator-evidence", tip: "9".repeat(40) }
    });
    expect(decide({ start, cursors })).toEqual([
      { type: "publish-ballot-batch", stepId: "R6.ballot", round: 1 }
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
          evidenceId: "consensus-response-accepted",
          submissionMode: "response",
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
            disposition: "approve",
            responseSha256: "e".repeat(64),
            rationale: "Looks good."
          }
        ]
      })
    ).toEqual([
      {
        type: "accept-response",
        agent: "claude",
        responseSha256: "e".repeat(64),
        rationale: "Looks good.",
        disposition: "approve"
      }
    ]);
  });
});

describe("plan amendment detour", () => {
  const request = {
    explanation: "The plan omits the test for its source file.",
    scopeHash: "5".repeat(64),
    additionalPaths: [{ path: "test/product.test.ts", reason: "covers the listed source file" }]
  };
  const pendingAmendment = (sequence: number, activeRoster = roster) => ({
    sequence,
    agent: "codex",
    actionId: "c2337d85-6617-4e9f-8ace-901453764aa4",
    submissionSha: "d".repeat(40),
    path: ".signals/issue-1/implementation-ready-codex.json",
    explanation: request.explanation,
    scopeHash: request.scopeHash,
    additionalPaths: request.additionalPaths,
    selectedPlans: [{ agent: "codex", submissionSha: "e".repeat(40), path: ".plans/issue-1/plan.md" }],
    activeRoster,
    source: { stepId: "R4.implement" as const, round: null },
    deferredAgents: [],
    requestedAt: now
  });
  const onBallot = (profile: "consensus" | "reviewed" | "solo", sequence: number, extra: Record<string, unknown> = {}) => {
    const shaped = startStateSchema.parse({ ...start, profile });
    const base = initialCursors(shaped, now);
    return {
      start: shaped,
      cursors: cursorsStateSchema.parse({
        ...base,
        issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: sequence },
        amendments: { sequence, pending: pendingAmendment(sequence), history: [] },
        ...extra
      })
    };
  };
  const votes = (sequence: number, rejecter: string | null = null) =>
    roster.map((agent) =>
      acceptedResponseFixture({
        stepId: "R4.amend-ballot",
        agent,
        round: sequence,
        disposition: agent === rejecter ? "reject" : "approve"
      })
    );
  const amendmentBatch = (sequence: number) => ({
    ...publishedBallotBatchFixture({ kind: "amendment-ballot-batch", activeRoster: roster, round: sequence }),
    paths: roster.map((agent) => `.plans/issue-1/amendment-ballot-${agent}-${sequence}.json`)
  });

  it("opens the detour for the first request in roster order after accepting peer work", () => {
    const base = initialCursors(start, now);
    const ids = { claude: "11111111-1111-4111-8111-111111111111", codex: "22222222-2222-4222-8222-222222222222", cursor: "33333333-3333-4333-8333-333333333333" };
    const cursors = cursorsStateSchema.parse({
      ...base,
      issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null },
      agents: Object.fromEntries(
        roster.map((agent) => [
          agent,
          {
            ...base.agents[agent],
            stepId: "R4.implement",
            evidenceId: "implementation-pinned",
            actionId: ids[agent as keyof typeof ids] ?? null,
            status: "verifying"
          }
        ])
      )
    });
    const satisfied = { submissionSha: "d".repeat(40), status: "satisfied" as const, outstanding: [] };
    expect(
      decide({
        start,
        cursors,
        observations: [
          { agent: "cursor", actionId: ids.cursor, ...satisfied, amendmentRequest: request },
          { agent: "claude", actionId: ids.claude, ...satisfied, productPin: "f".repeat(40) },
          { agent: "codex", actionId: ids.codex, ...satisfied, amendmentRequest: request }
        ]
      })
    ).toEqual([
      { type: "accept-submission", agent: "claude", submissionSha: "d".repeat(40), productPin: "f".repeat(40) },
      { type: "request-amendment", agent: "codex", submissionSha: "d".repeat(40), request, deferredAgents: ["cursor"] }
    ]);
  });

  it("asks every active agent in every profile and never normalizes the ballot away", () => {
    for (const profile of ["consensus", "reviewed"] as const) {
      const { start: shaped, cursors } = onBallot(profile, 1);
      expect(decide({ start: shaped, cursors })).toEqual(
        roster.map((agent) => ({ type: "prepare-action", agent, stepId: "R4.amend-ballot", round: 1 }))
      );
    }
    const solo = startStateSchema.parse({ ...start, profile: "solo", originalRoster: ["codex"], agents: [start.agents[1]] });
    const soloCursors = cursorsStateSchema.parse({
      ...initialCursors(solo, now),
      issueCursor: { stepId: "R4.amend-ballot", gateId: "gate-4-implementations", round: 1 },
      amendments: { sequence: 1, pending: pendingAmendment(1, ["codex"]), history: [] }
    });
    expect(decide({ start: solo, cursors: soloCursors })).toEqual([
      { type: "prepare-action", agent: "codex", stepId: "R4.amend-ballot", round: 1 }
    ]);
  });

  it("waits for every voter and for published evidence before deciding", () => {
    const missing = onBallot("consensus", 1, { acceptedResponses: votes(1).slice(1) });
    expect(decide(missing).every((decision) => decision.type !== "resolve-amendment")).toBe(true);
    const unpublished = onBallot("consensus", 1, { acceptedResponses: votes(1) });
    expect(decide(unpublished)).toEqual([{ type: "publish-ballot-batch", stepId: "R4.amend-ballot", round: 1 }]);
    const approved = onBallot("consensus", 1, { acceptedResponses: votes(1), ballotBatches: [amendmentBatch(1)] });
    expect(decide(approved)).toEqual([{ type: "resolve-amendment", sequence: 1, outcome: "approved" }]);
    const rejected = onBallot("consensus", 1, { acceptedResponses: votes(1, "cursor"), ballotBatches: [amendmentBatch(1)] });
    expect(decide(rejected)).toEqual([{ type: "resolve-amendment", sequence: 1, outcome: "rejected" }]);
  });

  it("never lets an earlier request's votes or evidence decide a later one", () => {
    const second = onBallot("consensus", 2, { acceptedResponses: votes(1), ballotBatches: [amendmentBatch(1)] });
    expect(decide(second)).toEqual(
      roster.map((agent) => ({ type: "prepare-action", agent, stepId: "R4.amend-ballot", round: 2 }))
    );
  });
});
