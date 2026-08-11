export const maxRevisionRounds = 3;

export type StepId = string;
export type GateId = string;
export type EvidenceId = string;

export type Profile = "solo" | "reviewed" | "consensus";

export type StepDefinition = {
  stepId: StepId;
  gateId: GateId;
  evidenceId: EvidenceId;
};

export const stepTable: Record<string, StepDefinition> = {
  "start": { stepId: "start", gateId: "start-gate", evidenceId: "start-evidence" },
  "plan": { stepId: "plan", gateId: "plan-gate", evidenceId: "plan-evidence" },
  "implement": { stepId: "implement", gateId: "implement-gate", evidenceId: "implement-evidence" }
};

export type Observation = {
  stepId: StepId;
  agent: string;
  satisfied: boolean;
  outstanding: string[];
};

export type Decision = 
  | { type: "advance"; stepId: StepId }
  | { type: "wait"; stepId: StepId }
  | { type: "drop"; agent: string }
  | { type: "reissue"; agent: string; outstanding: string[] };
