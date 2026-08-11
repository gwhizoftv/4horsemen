import { type StepId, type GateId, type Profile, type EvidenceObservation, type Decision, GATE_ORDER, MAX_REVISION_ROUNDS, gateDenominator, stepsForProfile } from "./steps.js";
import { type Cursors, type StartConfig } from "./state.js";

export interface MachineInput {
  start: StartConfig;
  cursors: Cursors;
  observations: readonly EvidenceObservation[];
}

/**
 * Pure observations-to-decisions reducer.
 * Given the current state and new evidence observations, produce decisions.
 * Attempt counts are diagnostic only — they never cause drops or advances.
 */
export function decide(input: MachineInput): readonly Decision[] {
  const { start, cursors, observations } = input;
  const decisions: Decision[] = [];
  const activeAgents = start.roster.filter(a => !cursors.droppedAgents.includes(a));
  const profile = start.profile;
  const currentGate = cursors.issueCursor.gateId as GateId;
  const currentRound = cursors.issueCursor.round;

  for (const obs of observations) {
    if (cursors.droppedAgents.includes(obs.agent)) continue;

    if (obs.ok) {
      decisions.push({ type: "advance-cursor", agent: obs.agent, stepId: obs.stepId, submissionSha: obs.submissionSha });
    } else {
      decisions.push({ type: "reissue-action", agent: obs.agent, stepId: obs.stepId, outstanding: obs.outstanding });
    }
  }

  if (shouldAdvanceGate(currentGate, profile, activeAgents, cursors, observations)) {
    decisions.push({ type: "advance-gate", gate: currentGate });

    const nextGate = nextGateAfter(currentGate);
    if (nextGate) {
      const steps = stepsForProfile(profile).filter(s => s.gate === nextGate);
      for (const agent of activeAgents) {
        const agentSteps = steps.filter(s => needsAgentAction(s.stepId));
        for (const step of agentSteps) {
          decisions.push({ type: "prepare-action", agent, stepId: step.stepId });
        }
      }
    }

    if (nextGate === "gate-6-consensus" && currentRound !== null && currentRound >= MAX_REVISION_ROUNDS) {
      decisions.push({ type: "notify-owner", message: `Revision round ${currentRound} reached maximum (${MAX_REVISION_ROUNDS}). Owner action required.` });
    }
  }

  return decisions;
}

function shouldAdvanceGate(gate: GateId, profile: Profile, activeAgents: readonly string[], cursors: Cursors, observations: readonly EvidenceObservation[]): boolean {
  const denominator = gateDenominator(gate, profile, activeAgents);
  const steps = stepsForProfile(profile).filter(s => s.gate === gate);

  let completedCount = 0;
  for (const agent of activeAgents) {
    const cursor = cursors.agents[agent];
    if (!cursor) continue;
    const agentComplete = steps.every(step => {
      if (!needsAgentAction(step.stepId)) return true;
      return cursor.status === "complete" || observations.some(o => o.ok && o.agent === agent && o.stepId === step.stepId);
    });
    if (agentComplete) completedCount++;
  }

  return completedCount >= denominator;
}

function needsAgentAction(stepId: StepId): boolean {
  const perAgentSteps: StepId[] = ["R1.join", "R2.plan", "R3.review", "R3.plan-ballot", "R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot"];
  return perAgentSteps.includes(stepId);
}

function nextGateAfter(gate: GateId): GateId | null {
  const idx = GATE_ORDER.indexOf(gate);
  if (idx < 0 || idx >= GATE_ORDER.length - 1) return null;
  return GATE_ORDER[idx + 1];
}

/**
 * Handle an owner drop command. Returns decisions for the reduced roster.
 * Refuses to drop the final active agent.
 */
export function handleDrop(agent: string, start: StartConfig, cursors: Cursors): { ok: true; decisions: readonly Decision[] } | { ok: false; reason: string } {
  const activeAgents = start.roster.filter(a => !cursors.droppedAgents.includes(a));
  if (!activeAgents.includes(agent)) {
    return { ok: false, reason: `Agent '${agent}' is not in the active roster` };
  }
  if (activeAgents.length <= 1) {
    return { ok: false, reason: "Cannot drop the final active agent" };
  }
  return { ok: true, decisions: [{ type: "notify-owner", message: `Dropped agent '${agent}' from active roster` }] };
}
