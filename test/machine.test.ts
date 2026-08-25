import { describe, expect, it } from "vitest";
import {
  decide,
  deriveConsensus,
  deriveImplementationSelection,
  derivePlanSelection,
  deterministicWinner
} from "../src/machine.js";
import {
  cursorsStateSchema,
  initialCursors,
  startStateSchema,
  type AcceptedSubmission,
  type CursorsState
} from "../src/state.js";
import { stepsForProfile } from "../src/steps.js";

const now = "2026-08-11T12:00:00.000Z";
const roster = ["claude", "codex", "cursor", "antigravity"];

const start = startStateSchema.parse({
  formatVersion: 3,
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

/** Distinct, stable 40-hex values keyed by an arbitrary label. */
const sha = (label: string): string => {
  let code = 0;
  for (const character of label) code = (code * 31 + character.charCodeAt(0)) % 0xfffff;
  return code.toString(16).padStart(5, "0").repeat(8);
};

const accepted = (
  stepId: AcceptedSubmission["stepId"],
  agent: string,
  round: number | null = null,
  extra: Partial<AcceptedSubmission> = {}
): AcceptedSubmission => ({
  stepId,
  agent,
  round,
  submissionSha: sha(`${stepId}:${agent}:${round ?? ""}`),
  path: `.signals/issue-1/${agent}.json`,
  acceptedAt: now,
  ...extra
});

const planStage = (choices: Record<string, string>, activeRoster = roster): CursorsState =>
  cursorsStateSchema.parse({
    ...initialCursors(start, now),
    activeRoster,
    droppedAgents: roster.filter((agent) => !activeRoster.includes(agent)),
    issueCursor: { stepId: "R3.plan-ballot", gateId: "gate-3-selection", round: null },
    accepted: [
      ...Object.keys(choices).map((agent) => accepted("R2.plan", agent, null, { path: ".plans/issue-1/plan.md" })),
      ...Object.entries(choices).map(([agent, choice]) =>
        accepted("R3.plan-ballot", agent, null, { choice, path: `.plans/issue-1/ballot-${agent}.json` })
      )
    ]
  });

const withPlanSelection = (cursors: CursorsState): CursorsState =>
  cursorsStateSchema.parse({
    ...cursors,
    derived: { ...cursors.derived, planSelection: derivePlanSelection(cursors, now) }
  });

const comparisonStage = (choices: Record<string, string>, activeRoster = roster): CursorsState => {
  const planned = withPlanSelection(planStage(Object.fromEntries(activeRoster.map((agent) => [agent, activeRoster[0] as string])), activeRoster));
  return cursorsStateSchema.parse({
    ...planned,
    issueCursor: { stepId: "R5.compare-ballot", gateId: "gate-5-comparison", round: null },
    accepted: [
      ...planned.accepted,
      ...Object.keys(choices).map((agent) =>
        accepted("R4.implement", agent, null, {
          productPin: sha(`pin:${agent}`),
          path: `.signals/issue-1/implementation-ready-${agent}.json`
        })
      ),
      ...Object.entries(choices).map(([agent, choice]) =>
        accepted("R5.compare-ballot", agent, null, { choice, path: `.code-reviews/issue-1/ballot-${agent}.json` })
      )
    ]
  });
};

const withImplementationSelection = (cursors: CursorsState): CursorsState =>
  cursorsStateSchema.parse({
    ...cursors,
    derived: { ...cursors.derived, implementationSelection: deriveImplementationSelection(cursors, now) }
  });

const consensusStage = (
  dispositions: Record<string, AcceptedSubmission["disposition"]>,
  round = 1
): CursorsState => {
  const compared = withImplementationSelection(
    comparisonStage(Object.fromEntries(roster.map((agent) => [agent, "cursor"])))
  );
  const reviser = compared.derived.implementationSelection?.reviser as string;
  return cursorsStateSchema.parse({
    ...compared,
    issueCursor: { stepId: "R6.ballot", gateId: "gate-6-consensus", round },
    accepted: [
      ...compared.accepted,
      accepted("R6.revise", reviser, round, {
        productPin: sha(`revision:${round}`),
        path: `.signals/issue-1/revision-ready-${reviser}-round-${round}.json`
      }),
      ...Object.entries(dispositions).map(([agent, disposition]) =>
        accepted("R6.ballot", agent, round, {
          disposition,
          path: `.code-reviews/issue-1/consensus-ballot-${agent}-round-${round}.json`
        })
      )
    ]
  });
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
    const cursors = consensusStage(
      Object.fromEntries(roster.map((agent) => [agent, agent === "codex" ? "revise" : "approve"])),
      3
    );
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

  it("routes revision work to the reviser named by the canonical decision", () => {
    const compared = withImplementationSelection(
      comparisonStage(Object.fromEntries(roster.map((agent) => [agent, "cursor"])))
    );
    const cursors = cursorsStateSchema.parse({
      ...compared,
      issueCursor: { stepId: "R6.revise", gateId: "gate-6-consensus", round: 1 }
    });
    expect(cursors.derived.implementationSelection?.reviser).toBe("cursor");
    expect(decide({ start, cursors })).toEqual([
      { type: "prepare-action", agent: "cursor", stepId: "R6.revise", round: 1 }
    ]);
  });

  it("routes reviewed implementation to the derived plan winner", () => {
    const reviewed = startStateSchema.parse({ ...start, profile: "reviewed" });
    const planned = withPlanSelection(
      planStage(Object.fromEntries(roster.map((agent) => [agent, "cursor"])))
    );
    const cursors = cursorsStateSchema.parse({
      ...planned,
      issueCursor: { stepId: "R4.implement", gateId: "gate-4-implementations", round: null }
    });
    expect(decide({ start: reviewed, cursors })).toEqual([
      { type: "prepare-action", agent: "cursor", stepId: "R4.implement", round: null }
    ]);
  });

  it("advances revise dispositions through round three and types escalations", () => {
    const revision = consensusStage(
      Object.fromEntries(roster.map((agent) => [agent, agent === "codex" ? "revise" : "approve"]))
    );
    expect(decide({ start, cursors: revision })).toEqual([
      { type: "advance-step", from: "R6.ballot", to: "R6.revise", round: 2 }
    ]);
    const escalation = consensusStage(
      Object.fromEntries(roster.map((agent) => [agent, agent === "codex" ? "escalate" : "approve"]))
    );
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
          evidenceId: "consensus-ballot-published",
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

describe("workflow topology", () => {
  it("is 10 agent-facing steps for consensus, 6 for reviewed, and 4 for solo", () => {
    expect(stepsForProfile("consensus")).toHaveLength(10);
    expect(stepsForProfile("reviewed")).toHaveLength(6);
    expect(stepsForProfile("solo")).toHaveLength(4);
    for (const profile of ["consensus", "reviewed", "solo"] as const) {
      expect(stepsForProfile(profile)).not.toContain("R3.publish-selection");
      expect(stepsForProfile(profile)).not.toContain("R5.reviser-auth");
      expect(stepsForProfile(profile)).not.toContain("R6.declare");
    }
  });
});

describe("deterministic elections", () => {
  it("picks the plurality winner", () => {
    const cursors = planStage({ claude: "codex", codex: "codex", cursor: "cursor", antigravity: "codex" });
    expect(deterministicWinner(cursors, "R3.plan-ballot", roster)).toBe("codex");
    expect(derivePlanSelection(cursors, now)?.selectedAgents).toEqual(["codex"]);
  });

  it("breaks a tie by persisted active-roster order, not by ballot order", () => {
    // cursor is named first in the ballot list; claude wins because it comes
    // first in `activeRoster`. If the tie-break ever read insertion order, this
    // run would revise the wrong implementation.
    const cursors = planStage({ cursor: "cursor", antigravity: "cursor", claude: "claude", codex: "claude" });
    expect(derivePlanSelection(cursors, now)?.selectedAgents).toEqual(["claude"]);
  });

  it("ignores ballots and choices belonging to inactive agents", () => {
    const cursors = planStage(
      { claude: "claude", codex: "codex", cursor: "codex", antigravity: "codex" },
      ["claude", "codex"]
    );
    // codex has three votes but two of them come from dropped agents, so the
    // active tally is 1–1 and roster order decides.
    expect(derivePlanSelection(cursors, now)?.selectedAgents).toEqual(["claude"]);
    expect(derivePlanSelection(cursors, now)?.activeRoster).toEqual(["claude", "codex"]);
  });

  it("elects nobody rather than falling back when every choice is ineligible", () => {
    // Only claude published a plan, yet every ballot names codex. Choosing
    // claude by roster position would bind the implementation to a plan nobody
    // voted for; the run must stall on the missing decision instead.
    const cursors = cursorsStateSchema.parse({
      ...planStage({ claude: "codex", codex: "codex", cursor: "codex", antigravity: "codex" }),
      accepted: [
        accepted("R2.plan", "claude", null, { path: ".plans/issue-1/plan.md" }),
        ...roster.map((agent) =>
          accepted("R3.plan-ballot", agent, null, { choice: "codex", path: `.plans/issue-1/ballot-${agent}.json` })
        )
      ]
    });
    expect(deterministicWinner(cursors, "R3.plan-ballot", ["claude"])).toBeNull();
    expect(derivePlanSelection(cursors, now)).toBeNull();
    expect(decide({ start, cursors }).some((decision) => decision.type === "advance-step")).toBe(false);
  });
});

describe("coordinator-derived decisions", () => {
  it("holds at the plan ballot until the canonical decision exists, then advances straight to implementation", () => {
    const cursors = planStage(Object.fromEntries(roster.map((agent) => [agent, "codex"])));
    expect(decide({ start, cursors })).toEqual([{ type: "derive-plan-selection" }]);
    expect(decide({ start, cursors: withPlanSelection(cursors) })).toEqual([
      { type: "advance-step", from: "R3.plan-ballot", to: "R4.implement", round: null }
    ]);
  });

  it("re-derives rather than advancing when a stored decision no longer matches its inputs", () => {
    const cursors = withPlanSelection(planStage(Object.fromEntries(roster.map((agent) => [agent, "codex"]))));
    // The same ballots under a smaller roster are a different decision: the
    // stored identity is stale and must not carry the run forward.
    const shrunk = cursorsStateSchema.parse({
      ...cursors,
      activeRoster: ["claude", "codex", "cursor"],
      droppedAgents: ["antigravity"]
    });
    expect(decide({ start, cursors: shrunk })).toEqual([{ type: "derive-plan-selection" }]);
  });

  it("derives the exact implementation pin and reviser, then advances to revision round one", () => {
    const cursors = comparisonStage(Object.fromEntries(roster.map((agent) => [agent, "cursor"])));
    expect(decide({ start, cursors })).toEqual([{ type: "derive-implementation-selection" }]);
    const decided = withImplementationSelection(cursors);
    expect(decided.derived.implementationSelection).toMatchObject({
      algorithm: "plurality-active-roster-v1",
      implementationAgent: "cursor",
      implementationPin: sha("pin:cursor"),
      reviser: "cursor",
      activeRoster: roster
    });
    expect(decide({ start, cursors: decided })).toEqual([
      { type: "advance-step", from: "R5.compare-ballot", to: "R6.revise", round: 1 }
    ]);
  });

  it("derives consensus at the current round's revision pin on unanimous approval", () => {
    const cursors = consensusStage(Object.fromEntries(roster.map((agent) => [agent, "approve"])));
    expect(decide({ start, cursors })).toEqual([{ type: "derive-consensus", round: 1 }]);
    const decided = cursorsStateSchema.parse({
      ...cursors,
      derived: { ...cursors.derived, consensus: deriveConsensus(cursors, 1, now) }
    });
    expect(decided.derived.consensus).toMatchObject({
      algorithm: "unanimous-active-roster-v1",
      round: 1,
      consensusAgent: "cursor",
      consensusPin: sha("revision:1")
    });
    expect(decide({ start, cursors: decided })).toEqual([
      { type: "advance-step", from: "R6.ballot", to: "R7.finalize", round: null }
    ]);
  });

  it("never derives consensus for a revise or escalate round", () => {
    for (const disposition of ["revise", "escalate"] as const) {
      const cursors = consensusStage(
        Object.fromEntries(roster.map((agent) => [agent, agent === "codex" ? disposition : "approve"]))
      );
      expect(deriveConsensus(cursors, 1, now)).toBeNull();
      expect(decide({ start, cursors }).some((decision) => decision.type === "derive-consensus")).toBe(false);
    }
  });

  it("cites every accepted input it read and hashes the roster into its identity", () => {
    const cursors = planStage(Object.fromEntries(roster.map((agent) => [agent, "codex"])));
    const decision = derivePlanSelection(cursors, now);
    expect(decision?.inputs.filter((input) => input.kind === "plan")).toHaveLength(4);
    expect(decision?.inputs.filter((input) => input.kind === "plan-ballot")).toHaveLength(4);
    // Same evidence, different roster order → a different durable identity.
    const reordered = cursorsStateSchema.parse({ ...cursors, activeRoster: [...roster].reverse() });
    expect(derivePlanSelection(reordered, now)?.identity.inputSetHash).not.toBe(decision?.identity.inputSetHash);
    // Same evidence and roster, different clock → the same identity.
    expect(derivePlanSelection(cursors, "2027-01-01T00:00:00.000Z")?.identity).toEqual(decision?.identity);
  });

  it("names the decision it replaces", () => {
    const first = withPlanSelection(planStage(Object.fromEntries(roster.map((agent) => [agent, "codex"]))));
    const shrunk = cursorsStateSchema.parse({
      ...first,
      activeRoster: ["claude", "codex", "cursor"],
      droppedAgents: ["antigravity"]
    });
    expect(derivePlanSelection(shrunk, now)?.supersedes).toEqual(first.derived.planSelection?.identity);
  });

  it("solo runs derive nothing: they hold no ballot to derive from", () => {
    const cursors = cursorsStateSchema.parse({
      ...initialCursors(start, now),
      activeRoster: ["claude"],
      droppedAgents: ["codex", "cursor", "antigravity"],
      issueCursor: { stepId: "R2.plan", gateId: "gate-2-plans", round: null },
      accepted: [accepted("R2.plan", "claude", null, { path: ".plans/issue-1/plan.md" })]
    });
    expect(derivePlanSelection(cursors, now)).toBeNull();
    expect(decide({ start, cursors })).toEqual([
      { type: "advance-step", from: "R2.plan", to: "R4.implement", round: null }
    ]);
  });
});
