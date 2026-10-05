import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync } from "node:fs";
import { clearCompletion } from "./action.js";
import { clearAgentResponse } from "./ballotResponse.js";
import {
  computeConsensusDerived,
  computeImplementationSelectionDerived,
  computePlanSelectionDerived,
  derivedDecisionJournalDetails
} from "./runLoop.js";
import {
  agentResponsePath,
  agentRuntimePaths,
  type IssueRuntimePaths
} from "./paths.js";
import {
  appendJournal,
  cursorsStateSchema,
  dropAgent,
  enqueueOwnerGuidance,
  mutateCursorsState,
  ownerGuidanceEntrySchema,
  readCursorsState,
  readStartState,
  releaseHold,
  replaceCursor,
  setPaused,
  type BallotBatch,
  type CursorsState,
  type OwnerGuidanceEntry
} from "./state.js";
import { STEP_DEFINITIONS, roundForStep, type WorkflowStepId } from "./steps.js";

export const invalidateUnpublishedBatches = (
  batches: readonly BallotBatch[],
  now: string,
  reason: string
): BallotBatch[] =>
  batches.map((batch) =>
    batch.status === "published" || batch.status === "invalidated"
      ? batch
      : {
          ...batch,
          status: "invalidated" as const,
          error: batch.error ?? reason,
          updatedAt: now
        }
  );

export const clearAgentLocalWork = (paths: IssueRuntimePaths, agent: string, actionId: string | null): void => {
  const runtime = agentRuntimePaths(paths, agent);
  clearCompletion(runtime.complete);
  if (existsSync(runtime.action)) unlinkSync(runtime.action);
  if (actionId !== null) clearAgentResponse(agentResponsePath(paths, agent, actionId));
};

export const rederiveAfterDrop = (
  paths: IssueRuntimePaths,
  cursors: CursorsState,
  dropped: string,
  now: string
): CursorsState => {
  const priorPlan = cursors.derived.planSelection;
  const priorImplementation = cursors.derived.implementationSelection;
  const priorConsensus = cursors.derived.consensus;
  let next = dropAgent(cursors, dropped, now);
  if (cursors.pendingAmendment != null) {
    for (const agent of cursors.activeRoster) clearAgentLocalWork(paths, agent, cursors.agents[agent]?.actionId ?? null);
    appendJournal(
      paths,
      {
        type: "amendment-decided",
        details: {
          sequence: cursors.pendingAmendment.sequence,
          outcome: "cancelled",
          reason: `drop of ${dropped}`,
          eventId: `amendment-cancel:${cursors.pendingAmendment.sequence}:${dropped}`
        }
      },
      now
    );
  }
  next = cursorsStateSchema.parse({
    ...next,
    accepted: next.accepted.filter(
      (submission) =>
        !(
          next.activeRoster.includes(submission.agent) &&
          (submission.stepId === "R3.plan-ballot" || submission.stepId === "R5.compare-ballot") &&
          submission.choice === dropped
        )
    ),
    acceptedResponses: next.acceptedResponses.filter(
      (response) =>
        !(
          next.activeRoster.includes(response.agent) &&
          (response.stepId === "R3.plan-ballot" || response.stepId === "R5.compare-ballot") &&
          response.choice === dropped
        )
    ),
    ownerQuestion: null,
    updatedAt: now
  });

  const persistDecision = <T extends NonNullable<CursorsState["derived"][keyof CursorsState["derived"]]>>(
    record: T
  ): T => {
    const event = appendJournal(
      paths,
      { type: "decision-derived", details: derivedDecisionJournalDetails(record) },
      record.decidedAt
    );
    return { ...record, decidedAt: event.at };
  };

  const resetTo = (
    state: CursorsState,
    stepId: WorkflowStepId,
    round: number | null,
    removeStep: (step: WorkflowStepId) => boolean
  ): CursorsState => {
    const accepted = state.accepted.filter((submission) => !removeStep(submission.stepId));
    const acceptedResponses = state.acceptedResponses.filter((response) => !removeStep(response.stepId));
    const agents = { ...state.agents };
    for (const agent of state.activeRoster) {
      const cursor = agents[agent];
      if (cursor === undefined) continue;
      const definition = STEP_DEFINITIONS[stepId];
      const satisfied =
        definition.submissionMode === "response"
          ? acceptedResponses.find(
              (response) => response.stepId === stepId && response.agent === agent && response.round === round
            )
          : accepted.find(
              (submission) => submission.stepId === stepId && submission.agent === agent && submission.round === round
            );
      agents[agent] = {
        ...cursor,
        stepId,
        evidenceId: definition.evidenceId,
        actionId: null,
        submissionMode: null,
        status: satisfied === undefined ? "idle" : "waiting-peer",
        submissionSha: null,
        outstanding: [],
        updatedAt: now
      };
      clearAgentLocalWork(paths, agent, cursor.actionId);
    }
    return cursorsStateSchema.parse({
      ...state,
      issueCursor: { stepId, gateId: STEP_DEFINITIONS[stepId].gateId, round },
      agents,
      accepted,
      acceptedResponses,
      ballotBatches: invalidateUnpublishedBatches(state.ballotBatches, now, `invalidated by reset to ${stepId}`),
      ownerQuestion: null,
      publication: {
        status: "not-required",
        finalSha: null,
        branch: null,
        url: null,
        error: null,
        attempts: state.publication.attempts
      },
      completed: false,
      updatedAt: now
    });
  };

  let reset = false;
  if (priorPlan !== null) {
    if (next.activeRoster.length === 1) {
      if (priorPlan.selectedAgents[0] !== next.activeRoster[0]) {
        next = resetTo(next, "R4.implement", null, (step) =>
          ["R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot", "R7.finalize"].includes(step)
        );
        reset = true;
      }
    } else {
      const plan = computePlanSelectionDerived(next, now, priorPlan.decisionId);
      if (plan === null) {
        next = resetTo(next, "R3.plan-ballot", null, (step) =>
          ["R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot", "R7.finalize"].includes(step)
        );
        reset = true;
      } else {
        next = cursorsStateSchema.parse({
          ...next,
          derived: { ...next.derived, planSelection: persistDecision(plan) },
          updatedAt: now
        });
        if (plan.selectedAgents[0] !== priorPlan.selectedAgents[0]) {
          next = resetTo(next, "R4.implement", null, (step) =>
            ["R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot", "R7.finalize"].includes(step)
          );
          reset = true;
        }
      }
    }
  }

  if (!reset && priorImplementation !== null && next.activeRoster.length > 1) {
    const implementation = computeImplementationSelectionDerived(next, now, priorImplementation.decisionId);
    if (implementation === null) {
      next = resetTo(next, "R5.compare-ballot", null, (step) =>
        ["R6.revise", "R6.ballot", "R7.finalize"].includes(step)
      );
      reset = true;
    } else {
      next = cursorsStateSchema.parse({
        ...next,
        derived: { ...next.derived, implementationSelection: persistDecision(implementation) },
        updatedAt: now
      });
      if (
        implementation.winner !== priorImplementation.winner ||
        implementation.implementationPin !== priorImplementation.implementationPin
      ) {
        next = resetTo(next, "R6.revise", 1, (step) =>
          ["R6.revise", "R6.ballot", "R7.finalize"].includes(step)
        );
        reset = true;
      }
    }
  }

  if (!reset && priorConsensus !== null && next.activeRoster.length > 1) {
    const consensus = computeConsensusDerived(next, priorConsensus.round, now, priorConsensus.decisionId);
    if (consensus === null) {
      next = resetTo(next, "R6.ballot", priorConsensus.round, (step) => step === "R7.finalize");
      reset = true;
    } else {
      next = cursorsStateSchema.parse({
        ...next,
        derived: { ...next.derived, consensus: persistDecision(consensus) },
        updatedAt: now
      });
      if (consensus.consensusPin !== priorConsensus.consensusPin) {
        next = resetTo(next, "R7.finalize", null, (step) => step === "R7.finalize");
        reset = true;
      }
    }
  }

  clearAgentLocalWork(paths, dropped, cursors.agents[dropped]?.actionId ?? null);
  if (reset) return next;

  const currentStep = next.issueCursor.stepId;
  const round = roundForStep(currentStep, next.issueCursor.round);
  const definition = STEP_DEFINITIONS[currentStep];
  for (const agent of next.activeRoster) {
    const alreadySatisfied =
      definition.submissionMode === "response"
        ? next.acceptedResponses.some(
            (response) => response.stepId === currentStep && response.agent === agent && response.round === round
          )
        : next.accepted.some(
            (submission) => submission.stepId === currentStep && submission.agent === agent && submission.round === round
          );
    if (alreadySatisfied) continue;
    const runtime = agentRuntimePaths(paths, agent);
    const priorActionId = next.agents[agent]?.actionId ?? null;
    if (existsSync(runtime.action)) unlinkSync(runtime.action);
    if (priorActionId !== null) clearAgentResponse(agentResponsePath(paths, agent, priorActionId));
    next = replaceCursor(
      next,
      agent,
      { actionId: null, status: "idle", submissionSha: null, outstanding: [] },
      now
    );
  }
  return next;
};

export type OwnerAnswer = "retry" | "revise" | "abandon";

/** Validate + mutate + journal an owner question answer. Does not run a tick. */
export const applyOwnerAnswer = (
  paths: IssueRuntimePaths,
  questionId: string,
  answer: OwnerAnswer,
  now = new Date().toISOString()
): CursorsState => {
  const before = readCursorsState(paths);
  if (before.lastOwnerAnswer?.questionId === questionId && before.lastOwnerAnswer.answer === answer) {
    return before;
  }
  const result = mutateCursorsState(paths, (current) => {
    const question = current.ownerQuestion;
    if (current.holds.length > 0 && answer !== "abandon") {
      throw new Error("Release active holds explicitly before advancing an owner question.");
    }
    if (question === null || question.id !== questionId) {
      throw new Error(`Owner question ${questionId} is stale or unknown.`);
    }
    if (!question.allowedAnswers.includes(answer)) {
      throw new Error(`Answer ${answer} is not allowed for owner question ${questionId}.`);
    }
    appendJournal(
      paths,
      { type: "owner-answer", details: { questionId, kind: question.kind, round: question.round, answer } },
      now
    );
    let next: CursorsState = cursorsStateSchema.parse({
      ...current,
      ownerQuestion: null,
      lastOwnerAnswer: { questionId, answer, answeredAt: now },
      abandoned: answer === "abandon" ? true : current.abandoned,
      updatedAt: now
    });
    if (answer === "retry" || answer === "revise") {
      const targetRound = answer === "revise" ? question.round + 1 : question.round;
      if (targetRound > readStartState(paths).maxRevisionRounds) {
        throw new Error("Owner answer cannot enter revision round 4.");
      }
      const stepId = answer === "revise" ? "R6.revise" : "R6.ballot";
      next = cursorsStateSchema.parse({
        ...next,
        issueCursor: { stepId, gateId: "gate-6-consensus", round: targetRound },
        accepted:
          answer === "retry"
            ? next.accepted.filter(
                (submission) => !(submission.stepId === "R6.ballot" && submission.round === question.round)
              )
            : next.accepted,
        acceptedResponses:
          answer === "retry"
            ? next.acceptedResponses.filter(
                (response) => !(response.stepId === "R6.ballot" && response.round === question.round)
              )
            : next.acceptedResponses,
        ballotBatches: invalidateUnpublishedBatches(next.ballotBatches, now, `invalidated by owner ${answer}`),
        updatedAt: now
      });
      for (const agent of next.activeRoster) {
        const priorActionId = next.agents[agent]?.actionId ?? null;
        clearAgentLocalWork(paths, agent, priorActionId);
        next = replaceCursor(
          next,
          agent,
          { stepId, actionId: null, status: "idle", submissionSha: null, outstanding: [] },
          now
        );
      }
    }
    return next;
  });
  return result.state;
};

/** Validate + mutate + journal an agent drop with rederive. Does not run a tick. */
export const applyOwnerDrop = (
  paths: IssueRuntimePaths,
  agent: string,
  now = new Date().toISOString()
): CursorsState => {
  const result = mutateCursorsState(paths, (current) => {
    if (current.holds.length > 0) throw new Error("Release active holds explicitly before dropping an agent.");
    if (current.completed || current.publication.status === "completed") {
      throw new Error("Cannot drop an agent after finalization publication or workflow completion.");
    }
    if (!current.activeRoster.includes(agent)) throw new Error(`${agent} is not active.`);
    if (current.activeRoster.length === 1) throw new Error("Cannot drop the final active agent.");
    if (current.derived.implementationSelection?.reviser === agent) {
      throw new Error(
        `Cannot drop authorized reviser ${agent}; revision and finalization must not be rebound after the canonical implementation decision.`
      );
    }
    appendJournal(paths, { type: "agent-dropped", agent, details: {} }, now);
    return rederiveAfterDrop(paths, current, agent, now);
  });
  return result.state;
};

/** Toggle or set manual pause (not hold release). Does not run a tick. */
export const setManualPause = (
  paths: IssueRuntimePaths,
  paused: boolean,
  now = new Date().toISOString()
): CursorsState => {
  const result = mutateCursorsState(paths, (current) => {
    const next = setPaused(current, paused, now);
    if (current.paused !== next.paused) {
      appendJournal(paths, { type: next.paused ? "paused" : "resumed", details: {} }, now);
    }
    return next;
  });
  return result.state;
};

/** Release one hold by id. Interactive path never resets the nudge budget. */
export const releaseOwnerHold = (
  paths: IssueRuntimePaths,
  holdId: string,
  resetBudget: boolean,
  now = new Date().toISOString()
): CursorsState => {
  const result = mutateCursorsState(paths, (current) => {
    const next = releaseHold(current, holdId, resetBudget, now);
    appendJournal(
      paths,
      { type: "hold-released", details: { hold: holdId, resetNudgeBudget: resetBudget, eventId: `release:${holdId}` } },
      now
    );
    if (current.paused !== next.paused) {
      appendJournal(paths, { type: next.paused ? "paused" : "resumed", details: {} }, now);
    }
    return next;
  });
  return result.state;
};

/** Queue one `/steer` line. Does not rewrite actions or run a tick. */
export const queueOwnerGuidance = (
  paths: IssueRuntimePaths,
  text: string,
  now = new Date().toISOString(),
  id = randomUUID()
): { state: CursorsState; entry: OwnerGuidanceEntry } => {
  const entry = ownerGuidanceEntrySchema.parse({ id, text, enqueuedAt: now });
  const result = mutateCursorsState(paths, (current) => {
    if (current.completed || current.abandoned) {
      throw new Error("Cannot queue owner guidance on a completed or abandoned issue.");
    }
    const next = enqueueOwnerGuidance(current, entry, now);
    appendJournal(
      paths,
      { type: "owner-guidance-queued", details: { id: entry.id, textLength: entry.text.length } },
      now
    );
    return next;
  });
  return { state: result.state, entry };
};
