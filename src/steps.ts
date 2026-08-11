/** Evidence predicate identifiers — coordinator-internal, never exposed to agents. */
export type EvidenceId =
  | "join-published"
  | "plan-published"
  | "review-published"
  | "plan-ballot-published"
  | "implementation-pinned"
  | "compare-published"
  | "compare-ballot-published"
  | "reviser-authorized"
  | "revision-pinned"
  | "consensus-ballot-published"
  | "consensus-declared"
  | "finalization-verified";

/** Step identifiers matching the workflow algorithm. */
export type StepId =
  | "R1.join"
  | "R2.plan"
  | "R3.review"
  | "R3.plan-ballot"
  | "R4.implement"
  | "R5.compare"
  | "R5.compare-ballot"
  | "R5.reviser-auth"
  | "R6.revise"
  | "R6.ballot"
  | "R6.declare"
  | "R7.finalize";

export type GateId =
  | "gate-1-join"
  | "gate-2-plans"
  | "gate-3-ballots"
  | "gate-4-implement"
  | "gate-5-compare"
  | "gate-6-consensus"
  | "gate-7-finalized";

export type Profile = "solo" | "reviewed" | "consensus";

export interface StepDefinition {
  stepId: StepId;
  evidenceId: EvidenceId;
  gate: GateId;
  /** Which profiles include this step. */
  profiles: readonly Profile[];
  /** Required path template. Use {issue} and {agent} placeholders. */
  requiredPathTemplate: string;
}

export const MAX_REVISION_ROUNDS = 3;

export const STEP_TABLE: readonly StepDefinition[] = [
  { stepId: "R1.join", evidenceId: "join-published", gate: "gate-1-join", profiles: ["solo", "reviewed", "consensus"], requiredPathTemplate: ".signals/issue-{issue}/joined-{agent}.json" },
  { stepId: "R2.plan", evidenceId: "plan-published", gate: "gate-2-plans", profiles: ["solo", "reviewed", "consensus"], requiredPathTemplate: ".plans/issue-{issue}/plan.md" },
  { stepId: "R3.review", evidenceId: "review-published", gate: "gate-3-ballots", profiles: ["consensus"], requiredPathTemplate: ".plans/issue-{issue}/review.md" },
  { stepId: "R3.plan-ballot", evidenceId: "plan-ballot-published", gate: "gate-3-ballots", profiles: ["consensus"], requiredPathTemplate: ".plans/issue-{issue}/ballot-{agent}.json" },
  { stepId: "R4.implement", evidenceId: "implementation-pinned", gate: "gate-4-implement", profiles: ["solo", "reviewed", "consensus"], requiredPathTemplate: ".signals/issue-{issue}/implementation-ready-{agent}.json" },
  { stepId: "R5.compare", evidenceId: "compare-published", gate: "gate-5-compare", profiles: ["consensus"], requiredPathTemplate: ".plans/issue-{issue}/comparison.md" },
  { stepId: "R5.compare-ballot", evidenceId: "compare-ballot-published", gate: "gate-5-compare", profiles: ["consensus"], requiredPathTemplate: ".plans/issue-{issue}/comparison-ballot-{agent}.json" },
  { stepId: "R5.reviser-auth", evidenceId: "reviser-authorized", gate: "gate-5-compare", profiles: ["consensus"], requiredPathTemplate: ".signals/issue-{issue}/reviser-authorized.json" },
  { stepId: "R6.revise", evidenceId: "revision-pinned", gate: "gate-6-consensus", profiles: ["consensus"], requiredPathTemplate: ".signals/issue-{issue}/revision-ready-{agent}.json" },
  { stepId: "R6.ballot", evidenceId: "consensus-ballot-published", gate: "gate-6-consensus", profiles: ["consensus"], requiredPathTemplate: ".signals/issue-{issue}/consensus-ballot-{agent}.json" },
  { stepId: "R6.declare", evidenceId: "consensus-declared", gate: "gate-6-consensus", profiles: ["consensus"], requiredPathTemplate: ".signals/issue-{issue}/consensus-declared.json" },
  { stepId: "R7.finalize", evidenceId: "finalization-verified", gate: "gate-7-finalized", profiles: ["solo", "reviewed", "consensus"], requiredPathTemplate: "" },
];

/** Resolve a path template with issue number and agent name. */
export function resolvePathTemplate(template: string, issue: number, agent: string): string {
  return template.replace("{issue}", String(issue)).replace("{agent}", agent);
}

/** Get the gate denominator: how many agents must complete a gate for it to advance. */
export function gateDenominator(gate: GateId, profile: Profile, activeAgents: readonly string[]): number {
  if (profile === "solo") return 1;
  if (profile === "reviewed") {
    if (gate === "gate-4-implement" || gate === "gate-6-consensus" || gate === "gate-7-finalized") return 1;
    return activeAgents.length;
  }
  return activeAgents.length;
}

/** Get the steps applicable for a profile. */
export function stepsForProfile(profile: Profile): readonly StepDefinition[] {
  return STEP_TABLE.filter(s => s.profiles.includes(profile));
}

// --- Shared observation/result types (used by evidence.ts and machine.ts) ---

/** Concrete reason an evidence check failed. */
export interface OutstandingItem {
  code: string;
  message: string;
}

/** Result of evaluating evidence for a single action. */
export interface EvidenceObservation {
  ok: boolean;
  agent: string;
  stepId: StepId;
  submissionSha: string;
  outstanding: readonly OutstandingItem[];
}

/** A decision the pure machine emits for the run loop to execute. */
export type Decision =
  | { type: "advance-cursor"; agent: string; stepId: StepId; submissionSha: string }
  | { type: "advance-gate"; gate: GateId }
  | { type: "reissue-action"; agent: string; stepId: StepId; outstanding: readonly OutstandingItem[] }
  | { type: "prepare-action"; agent: string; stepId: StepId }
  | { type: "finalize"; approvedSha: string }
  | { type: "notify-owner"; message: string };

/** The GATE_ORDER defines the progression of gates. */
export const GATE_ORDER: readonly GateId[] = [
  "gate-1-join",
  "gate-2-plans",
  "gate-3-ballots",
  "gate-4-implement",
  "gate-5-compare",
  "gate-6-consensus",
  "gate-7-finalized",
];
