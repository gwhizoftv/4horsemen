import type { CursorsState, StartState } from "./state.js";
import { ballotKindFor, isBallotStep } from "./ballotPublication.js";
import {
  STEP_DEFINITIONS,
  participantsForStep,
  stepsForProfile,
  type EvidenceObservation,
  type MachineDecision,
  type ResponseObservation,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export type MachineInput = {
  start: StartState;
  cursors: CursorsState;
  observations?: readonly (EvidenceObservation | ResponseObservation)[];
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
  isBallotStep(stepId)
    ? (cursors.acceptedResponses ?? []).some(
        (response) =>
          response.stepId === stepId &&
          response.agent === agent &&
          response.round === round &&
          response.supersededAt === undefined
      ) ||
      (cursors.formatVersion < 4 &&
        cursors.accepted.some(
          (submission) => submission.stepId === stepId && submission.agent === agent && submission.round === round
        ))
    : cursors.accepted.some(
        (submission) => submission.stepId === stepId && submission.agent === agent && submission.round === round
      );

const sameRoster = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((agent, index) => agent === right[index]);

const needsPlanSelectionDerive = (cursors: CursorsState, profile: WorkflowProfile): boolean =>
  profile !== "solo" &&
  (cursors.derived.planSelection === null ||
    !sameRoster(cursors.derived.planSelection.activeRoster, cursors.activeRoster));

const needsImplementationSelectionDerive = (cursors: CursorsState): boolean =>
  cursors.derived.implementationSelection === null ||
  !sameRoster(cursors.derived.implementationSelection.activeRoster, cursors.activeRoster);

const needsConsensusDerive = (cursors: CursorsState, round: number): boolean =>
  cursors.derived.consensus === null ||
  cursors.derived.consensus.round !== round ||
  !sameRoster(cursors.derived.consensus.activeRoster, cursors.activeRoster);

const hasPublishedBallotBatch = (
  cursors: CursorsState,
  stepId: "R3.plan-ballot" | "R5.compare-ballot" | "R6.ballot",
  round: number | null
): boolean => {
  if (cursors.formatVersion < 4) return true;
  const responses = cursors.activeRoster.map((agent) =>
    (cursors.acceptedResponses ?? []).find(
      (response) =>
        response.stepId === stepId &&
        response.agent === agent &&
        response.round === round &&
        response.supersededAt === undefined
    )
  );
  if (responses.some((response) => response === undefined)) return false;
  const digests = responses.map((response) => response?.responseSha256 as string);
  return (cursors.ballotBatches ?? []).some(
    (batch) =>
      batch.kind === ballotKindFor(stepId) &&
      batch.round === round &&
      batch.status === "published" &&
      sameRoster(batch.activeRoster, cursors.activeRoster) &&
      batch.responseSha256s.length === digests.length &&
      batch.responseSha256s.every((digest, index) => digest === digests[index])
  );
};

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
    if ("submissionSha" in observation && observation.status === "retry") {
      decisions.push({ type: "retry-verification", agent: observation.agent, outstanding: observation.outstanding });
    } else if (observation.status === "rejected") {
      decisions.push({ type: "reissue-action", agent: observation.agent, outstanding: observation.outstanding });
    } else if ("submissionSha" in observation) {
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
    } else {
      if (
        observation.responseSha256 === undefined ||
        observation.rationale === undefined ||
        observation.bytes === undefined
      ) {
        decisions.push({
          type: "reissue-action",
          agent: observation.agent,
          outstanding: ["accepted response observation is incomplete"]
        });
      } else {
        decisions.push({
          type: "accept-response",
          agent: observation.agent,
          responseSha256: observation.responseSha256,
          rationale: observation.rationale,
          bytes: observation.bytes,
          ...(observation.choice === undefined ? {} : { choice: observation.choice }),
          ...(observation.disposition === undefined ? {} : { disposition: observation.disposition })
        });
      }
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

  if (current === "R4.implement" && profile !== "solo" && needsPlanSelectionDerive(cursors, profile)) {
    return [{ type: "wait", reason: "canonical plan selection is missing or stale" }];
  }
  if ((current === "R6.revise" || current === "R6.ballot") && needsImplementationSelectionDerive(cursors)) {
    return [{ type: "wait", reason: "canonical implementation selection is missing or stale" }];
  }
  if (
    current === "R7.finalize" &&
    profile === "consensus" &&
    (cursors.derived.consensus === null ||
      !sameRoster(cursors.derived.consensus.activeRoster, cursors.activeRoster)) &&
    !cursors.accepted.some(
      (submission) =>
        submission.stepId === "R7.finalize" && cursors.activeRoster.includes(submission.agent)
    )
  ) {
    return [{ type: "wait", reason: "canonical consensus decision is missing" }];
  }
  if (current === "R7.finalize" && profile === "reviewed" && needsPlanSelectionDerive(cursors, profile)) {
    return [{ type: "wait", reason: "canonical plan selection is missing or stale" }];
  }

  const designated =
    current === "R4.implement"
      ? profile === "solo"
        ? cursors.activeRoster[0]
        : cursors.derived.planSelection?.selectedAgents[0]
      : current === "R6.revise"
        ? cursors.derived.implementationSelection?.reviser
        : current === "R7.finalize"
          ? profile === "consensus"
            ? cursors.derived.implementationSelection?.reviser
            : profile === "reviewed"
              ? cursors.derived.planSelection?.selectedAgents[0]
              : cursors.activeRoster[0]
        : cursors.activeRoster[0];
  const participants = participantsForStep(current, profile, cursors.activeRoster, designated);
  const round = current.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
  const complete = participants.every((agent) => hasAccepted(cursors, current, agent, round));

  if (complete) {
    if (isBallotStep(current) && !hasPublishedBallotBatch(cursors, current, round)) {
      return [{ type: "publish-ballot-batch", stepId: current, round }];
    }
    if (current === "R6.ballot") {
      const ballots = (cursors.formatVersion < 4
        ? cursors.accepted.map((submission) => ({ ...submission, stepId: submission.stepId as typeof current }))
        : cursors.acceptedResponses ?? []
      ).filter(
        (response) =>
          response.stepId === current &&
          response.round === round &&
          (!("supersededAt" in response) || response.supersededAt === undefined) &&
          participants.includes(response.agent)
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
