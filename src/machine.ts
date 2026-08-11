import {
  gatesForProfile,
  participantsFor,
  stepsForGate,
  stepsForProfile,
  type Decision,
  type GateId,
  type Observations,
  type Profile,
  type StepDefinition,
  type StepId
} from "./steps.js";

/**
 * The pure reducer: observations in, decisions out.
 *
 * This module imports nothing effectful. It does not know that Git, tmux, or a
 * filesystem exist — the run loop calls `evaluateEvidence(...)`, puts the
 * result into an `AgentObservation`, and passes it here. That is the only
 * reason `decide` can be exercised without a harness or a network.
 *
 * Two invariants are load-bearing and tested directly:
 *
 * - Attempt counts are diagnostic. No number of failed submissions ever drops
 *   an agent, advances a gate, or terminates the workflow.
 * - A dropped agent's work is never an input again. Dropped agents are absent
 *   from `activeAgents`, so nothing downstream can cite them.
 */

export type MachineInput = {
  readonly profile: Profile;
  /** Original roster minus persisted drops. */
  readonly activeAgents: readonly string[];
  readonly droppedAgents: readonly string[];
  readonly gateId: GateId;
  readonly round: number | null;
  readonly selected: string | null;
  readonly maxRevisionRounds: number;
  readonly paused: boolean;
  readonly abandoned: boolean;
  /** stepId -> agents that have already satisfied it in this run. */
  readonly satisfied: Readonly<Record<string, readonly string[]>>;
  /** agent -> attempts made on its current action. Diagnostic only. */
  readonly attempts: Readonly<Record<string, number>>;
  /** Set when the last consensus round asked for another revision. */
  readonly revisionRequested: boolean;
  readonly observations: Observations;
};

const hasSatisfied = (input: MachineInput, stepId: StepId, agent: string): boolean =>
  (input.satisfied[stepId] ?? []).includes(agent);

/** Steps of the current gate that this profile actually runs, in table order. */
const activeSteps = (input: MachineInput): readonly StepDefinition[] => {
  const included = stepsForProfile(input.profile);

  return stepsForGate(input.gateId).filter((step) => included.includes(step));
};

/** The next step this agent owes at the current gate, or null. */
export const nextStepFor = (input: MachineInput, agent: string): StepDefinition | null => {
  for (const step of activeSteps(input)) {
    const participants = participantsFor(step, input.profile, input.activeAgents, input.selected);

    if (participants.includes(agent) && !hasSatisfied(input, step.stepId, agent)) {
      return step;
    }
  }

  return null;
};

/** True when every participant of every step in the gate has satisfied it. */
export const gateComplete = (input: MachineInput): boolean =>
  activeSteps(input).every((step) =>
    participantsFor(step, input.profile, input.activeAgents, input.selected).every((agent) =>
      hasSatisfied(input, step.stepId, agent)
    )
  );

export const nextGate = (input: MachineInput): GateId | null => {
  const gates = gatesForProfile(input.profile);
  const index = gates.indexOf(input.gateId);

  if (index === -1 || index + 1 >= gates.length) {
    return null;
  }

  return gates[index + 1] ?? null;
};

/**
 * Revision accounting. Round 3 is the last: after three unsuccessful rounds the
 * driver requires owner action and never enters round 4.
 */
export const revisionExhausted = (input: MachineInput): boolean =>
  input.round !== null && input.round >= input.maxRevisionRounds && input.revisionRequested;

export const decide = (input: MachineInput): readonly Decision[] => {
  if (input.abandoned) {
    return [{ kind: "await-owner", reason: "run abandoned by owner" }];
  }

  if (input.paused) {
    return [{ kind: "wait" }];
  }

  const decisions: Decision[] = [];
  const active = new Set(input.activeAgents);

  for (const observation of input.observations.agents) {
    // A dropped agent cannot change anything in this run. Any completion it
    // wrote before or after the drop is ignored and cleared.
    if (!active.has(observation.agent)) {
      if (observation.submissionSha !== null) {
        decisions.push({ kind: "clear-completion", agent: observation.agent });
      }

      continue;
    }

    const step = nextStepFor(input, observation.agent);

    if (step === null) {
      continue;
    }

    const attempt = input.attempts[observation.agent] ?? 0;

    // No intent yet: order the work if nothing is outstanding, otherwise wait.
    if (observation.submissionSha === null || observation.verification === null) {
      if (!observation.hasAction) {
        decisions.push({ kind: "order", agent: observation.agent, stepId: step.stepId, attempt: attempt + 1 });
      }

      continue;
    }

    // Transport failure: keep the action and the submitted SHA, retry the
    // fetch. Emit no verdict — this is not evidence about the agent's work.
    if (observation.verification.kind === "transient") {
      decisions.push({
        kind: "retry-verification",
        agent: observation.agent,
        detail: observation.verification.detail
      });

      continue;
    }

    const outcome = observation.verification.outcome;

    if (outcome.ok) {
      decisions.push({
        kind: "accept",
        agent: observation.agent,
        stepId: step.stepId,
        submissionSha: observation.submissionSha
      });
      decisions.push({ kind: "clear-completion", agent: observation.agent });

      continue;
    }

    // Failed evidence: clear the intent and reissue the same action with
    // concrete outstanding detail. The attempt count rises and means nothing
    // beyond diagnostics.
    decisions.push({ kind: "clear-completion", agent: observation.agent });
    decisions.push({
      kind: "reorder",
      agent: observation.agent,
      stepId: step.stepId,
      attempt: attempt + 1,
      outstanding: outcome.outstanding
    });
    decisions.push({
      kind: "notify-owner",
      message: `${observation.agent} submitted work that did not satisfy its action (attempt ${attempt + 1}): ${outcome.outstanding.join("; ")}`
    });
  }

  if (gateComplete(input)) {
    if (revisionExhausted(input)) {
      return [
        ...decisions,
        {
          kind: "await-owner",
          reason: `revision round ${String(input.round)} of ${String(input.maxRevisionRounds)} did not reach consensus; owner action required`
        }
      ];
    }

    const following = nextGate(input);

    if (following === null) {
      decisions.push({ kind: "finalize", gateId: input.gateId });
    } else {
      decisions.push({ kind: "advance-gate", from: input.gateId, to: following });
    }
  }

  if (decisions.length === 0) {
    decisions.push({ kind: "wait" });
  }

  return decisions;
};
