import type { CursorsState, StartState } from "./state.js";
import {
  STEP_DEFINITIONS,
  participantsForStep,
  stepsForProfile,
  type EvidenceObservation,
  type MachineDecision,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export type MachineInput = {
  start: StartState;
  cursors: CursorsState;
  observations?: readonly EvidenceObservation[];
};

const globalOrder: readonly WorkflowStepId[] = [
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R4.implement",
  "R5.compare",
  "R5.compare-ballot",
  "R6.revise",
  "R6.ballot",
  "R7.finalize"
];

const effectiveProfile = (start: StartState, cursors: CursorsState): WorkflowProfile =>
  cursors.activeRoster.length === 1 ? "solo" : start.profile;

const normalizeCurrentStep = (
  current: WorkflowStepId,
  profile: WorkflowProfile
): WorkflowStepId | null => {
  const sequence = stepsForProfile(profile);
  if (sequence.includes(current)) return current;
  const currentRank = globalOrder.indexOf(current);
  return sequence.find((step) => globalOrder.indexOf(step) > currentRank) ?? null;
};

const nextStep = (current: WorkflowStepId, profile: WorkflowProfile): WorkflowStepId | null => {
  const sequence = stepsForProfile(profile);
  const index = sequence.indexOf(current);
  return index < 0 ? normalizeCurrentStep(current, profile) : (sequence[index + 1] ?? null);
};

const hasAccepted = (cursors: CursorsState, stepId: WorkflowStepId, agent: string, round: number | null): boolean =>
  cursors.accepted.some(
    (submission) => submission.stepId === stepId && submission.agent === agent && submission.round === round
  );

const designatedReviser = (cursors: CursorsState): string | undefined =>
  cursors.derived.implementationSelection?.reviser ?? cursors.activeRoster[0];

const designatedImplementer = (cursors: CursorsState): string | undefined =>
  cursors.derived.planSelection?.selectedAgents[0] ?? cursors.activeRoster[0];

const needsPlanSelectionDerive = (cursors: CursorsState, profile: WorkflowProfile): boolean =>
  profile !== "solo" && cursors.derived.planSelection === null;

const needsImplementationSelectionDerive = (cursors: CursorsState): boolean =>
  cursors.derived.implementationSelection === null;

const needsConsensusDerive = (cursors: CursorsState, round: number): boolean =>
  cursors.derived.consensus === null || cursors.derived.consensus.round !== round;

export const decide = (input: MachineInput): readonly MachineDecision[] => {
  const { start, cursors } = input;
  if (cursors.abandoned) return [{ type: "wait", reason: "workflow was abandoned" }];
  if (cursors.completed) return [{ type: "wait", reason: "workflow is complete" }];
  if (cursors.paused) return [{ type: "wait", reason: "workflow is paused" }];

  const decisions: MachineDecision[] = [];
  for (const observation of input.observations ?? []) {
    if (!cursors.activeRoster.includes(observation.agent)) continue;
    const cursor = cursors.agents[observation.agent];
    if (cursor === undefined || cursor.actionId !== observation.actionId) continue;
    if (observation.status === "retry") {
      decisions.push({ type: "retry-verification", agent: observation.agent, outstanding: observation.outstanding });
    } else if (observation.status === "rejected") {
      decisions.push({ type: "reissue-action", agent: observation.agent, outstanding: observation.outstanding });
    } else {
      decisions.push({
        type: "accept-submission",
        agent: observation.agent,
        submissionSha: observation.submissionSha,
        ...(observation.productPin === undefined ? {} : { productPin: observation.productPin }),
        ...(observation.disposition === undefined ? {} : { disposition: observation.disposition }),
        ...(observation.approvedPaths === undefined ? {} : { approvedPaths: observation.approvedPaths }),
        ...(observation.choice === undefined ? {} : { choice: observation.choice }),
        ...(observation.checkResults === undefined ? {} : { checkResults: observation.checkResults })
      });
    }
  }
  if (decisions.length > 0) return decisions;
  if (cursors.ownerQuestion !== null) {
    return [
      {
        type: "owner-action-required",
        reason: `${cursors.ownerQuestion.kind} at revision round ${cursors.ownerQuestion.round}`,
        kind: cursors.ownerQuestion.kind,
        round: cursors.ownerQuestion.round,
        allowedAnswers: cursors.ownerQuestion.allowedAnswers
      }
    ];
  }

  const profile = effectiveProfile(start, cursors);
  const current = cursors.issueCursor.stepId;
  const normalized = normalizeCurrentStep(current, profile);
  if (normalized === null) return [{ type: "advance-step", from: current, to: null, round: null }];
  if (normalized !== current) {
    const round = normalized === "R6.revise" || normalized === "R6.ballot" ? (cursors.issueCursor.round ?? 1) : null;
    return [{ type: "advance-step", from: current, to: normalized, round }];
  }

  const designated =
    current === "R4.implement"
      ? designatedImplementer(cursors)
      : current === "R6.revise" || current === "R7.finalize"
        ? designatedReviser(cursors)
        : cursors.activeRoster[0];
  const participants = participantsForStep(current, profile, cursors.activeRoster, designated);
  const round = current.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
  const complete = participants.every((agent) => hasAccepted(cursors, current, agent, round));

  if (complete) {
    if (current === "R6.ballot") {
      const ballots = cursors.accepted.filter(
        (submission) => submission.stepId === current && submission.round === round && participants.includes(submission.agent)
      );
      if (ballots.some((ballot) => ballot.disposition === "escalate")) {
        const currentRound = round ?? 1;
        return [
          {
            type: "owner-action-required",
            reason: `consensus ballot round ${currentRound} requested escalation`,
            kind: "ballot-escalation",
            round: currentRound,
            allowedAnswers:
              currentRound < start.maxRevisionRounds ? ["retry", "revise", "abandon"] : ["retry", "abandon"]
          }
        ];
      }
      if (ballots.some((ballot) => ballot.disposition === "revise")) {
        if ((round ?? 1) >= start.maxRevisionRounds) {
          return [
            {
              type: "owner-action-required",
              reason: `revision limit ${start.maxRevisionRounds} reached; round ${start.maxRevisionRounds + 1} is forbidden`,
              kind: "revision-limit",
              round: start.maxRevisionRounds,
              allowedAnswers: ["retry", "abandon"]
            }
          ];
        }
        return [{ type: "advance-step", from: current, to: "R6.revise", round: (round ?? 1) + 1 }];
      }
      if (needsConsensusDerive(cursors, round ?? 1)) {
        return [{ type: "derive-consensus", round: round ?? 1 }];
      }
    }

    if (current === "R3.plan-ballot" && needsPlanSelectionDerive(cursors, profile)) {
      return [{ type: "derive-plan-selection" }];
    }
    if (current === "R5.compare-ballot" && needsImplementationSelectionDerive(cursors)) {
      return [{ type: "derive-implementation-selection" }];
    }

    const next = nextStep(current, profile);
    const nextRound = next === "R6.revise" || next === "R6.ballot" ? (round ?? 1) : null;
    return [{ type: "advance-step", from: current, to: next, round: nextRound }];
  }

  for (const agent of participants) {
    if (hasAccepted(cursors, current, agent, round)) continue;
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.status === "dropped") continue;
    if (cursor.actionId === null || cursor.stepId !== current) {
      decisions.push({ type: "prepare-action", agent, stepId: current, round });
    }
  }

  return decisions.length > 0 ? decisions : [{ type: "wait", reason: `waiting for ${STEP_DEFINITIONS[current].gateId}` }];
};
