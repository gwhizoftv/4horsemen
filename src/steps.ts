/**
 * Coordinator-internal vocabulary: step ids, gate ids, evidence-predicate ids,
 * profile participation, path templates, and defaults.
 *
 * None of these identifiers is ever rendered into `action.md` or printed by
 * `coord next`. They live here and in `cursors.json`/the journal only.
 *
 * This module also owns the shared observation and decision types. `evidence.ts`
 * produces them and `machine.ts` consumes them, which is what keeps the pure
 * reducer from importing the Git boundary.
 */

export const DEFAULT_MAX_REVISION_ROUNDS = 3;

export const RUNTIME_FORMAT_VERSION = 1;

export type Profile = "solo" | "reviewed" | "consensus";

export type StepId =
  | "R1.join"
  | "R2.plan"
  | "R3.review"
  | "R3.plan-ballot"
  | "R3.publish-selection"
  | "R4.implement"
  | "R5.compare"
  | "R5.compare-ballot"
  | "R6.revise"
  | "R6.ballot"
  | "R6.declare"
  | "R7.finalize";

export type GateId =
  | "gate-1-join"
  | "gate-2-plans"
  | "gate-3-selection"
  | "gate-4-implementation"
  | "gate-5-comparison"
  | "gate-6-consensus"
  | "gate-7-finalized";

export type EvidenceId =
  | "join-published"
  | "plan-published"
  | "review-published"
  | "plan-ballot-published"
  | "implementation-pinned"
  | "comparison-published"
  | "comparison-ballot-published"
  | "revision-pinned"
  | "consensus-ballot-published"
  | "coordinator-internal";

/**
 * Who performs a step.
 *
 * - `all-active`: every agent still in the roster.
 * - `implementers`: profile-dependent — every active agent under `consensus`,
 *   the selected agent under `reviewed`/`solo`.
 * - `reviewers`: active agents that are not implementers.
 * - `reviser`: the single agent authorised to revise.
 * - `coordinator`: no agent action; the driver resolves it from evidence it
 *   already holds.
 */
export type Participation = "all-active" | "implementers" | "reviewers" | "reviser" | "coordinator";

export type SectionRequirement = {
  /** Human label used in `outstanding[]`. */
  readonly label: string;
  /** Satisfied when any of these appears as a non-empty heading. */
  readonly anyOf: readonly string[];
};

export type StepDefinition = {
  readonly stepId: StepId;
  readonly gateId: GateId;
  readonly evidenceId: EvidenceId;
  /** Template with `{issue}` and `{agent}` placeholders. */
  readonly pathTemplate: string;
  readonly participation: Participation;
  /** Present only for markdown steps. */
  readonly sections?: readonly SectionRequirement[];
};

export const planSectionRequirements: readonly SectionRequirement[] = [
  { label: "file map", anyOf: ["file map"] },
  { label: "tests", anyOf: ["test"] },
  { label: "alternatives or risks", anyOf: ["alternative", "risk"] },
  { label: "conclusion", anyOf: ["conclusion"] }
];

export const reviewSectionRequirements: readonly SectionRequirement[] = [
  { label: "findings", anyOf: ["finding", "assessment", "review"] },
  { label: "conclusion", anyOf: ["conclusion", "verdict", "recommendation"] }
];

export const comparisonSectionRequirements: readonly SectionRequirement[] = [
  { label: "comparison", anyOf: ["comparison", "compare"] },
  { label: "conclusion", anyOf: ["conclusion", "recommendation"] }
];

/** Ordered step table. Gate order is the order of first appearance here. */
export const stepTable: readonly StepDefinition[] = [
  {
    stepId: "R1.join",
    gateId: "gate-1-join",
    evidenceId: "join-published",
    pathTemplate: ".signals/issue-{issue}/joined-{agent}.json",
    participation: "all-active"
  },
  {
    stepId: "R2.plan",
    gateId: "gate-2-plans",
    evidenceId: "plan-published",
    pathTemplate: ".plans/issue-{issue}/plan.md",
    participation: "all-active",
    sections: planSectionRequirements
  },
  {
    stepId: "R3.review",
    gateId: "gate-3-selection",
    evidenceId: "review-published",
    pathTemplate: ".plans/issue-{issue}/review-{agent}.md",
    participation: "all-active",
    sections: reviewSectionRequirements
  },
  {
    stepId: "R3.plan-ballot",
    gateId: "gate-3-selection",
    evidenceId: "plan-ballot-published",
    pathTemplate: ".plans/issue-{issue}/ballot-{agent}.json",
    participation: "all-active"
  },
  {
    stepId: "R3.publish-selection",
    gateId: "gate-3-selection",
    evidenceId: "coordinator-internal",
    pathTemplate: ".plans/issue-{issue}/selection.json",
    participation: "coordinator"
  },
  {
    stepId: "R4.implement",
    gateId: "gate-4-implementation",
    evidenceId: "implementation-pinned",
    pathTemplate: ".signals/issue-{issue}/implementation-ready-{agent}.json",
    participation: "implementers"
  },
  {
    stepId: "R5.compare",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-published",
    pathTemplate: ".code-reviews/issue-{issue}/comparison-{agent}.md",
    participation: "all-active",
    sections: comparisonSectionRequirements
  },
  {
    stepId: "R5.compare-ballot",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-ballot-published",
    pathTemplate: ".code-reviews/issue-{issue}/comparison-ballot-{agent}.json",
    participation: "all-active"
  },
  {
    stepId: "R6.revise",
    gateId: "gate-6-consensus",
    evidenceId: "revision-pinned",
    pathTemplate: ".signals/issue-{issue}/revision-ready-{agent}.json",
    participation: "reviser"
  },
  {
    stepId: "R6.ballot",
    gateId: "gate-6-consensus",
    evidenceId: "consensus-ballot-published",
    pathTemplate: ".code-reviews/issue-{issue}/consensus-ballot-{agent}.json",
    participation: "all-active"
  },
  {
    stepId: "R6.declare",
    gateId: "gate-6-consensus",
    evidenceId: "coordinator-internal",
    pathTemplate: ".signals/issue-{issue}/consensus.json",
    participation: "coordinator"
  },
  {
    stepId: "R7.finalize",
    gateId: "gate-7-finalized",
    evidenceId: "coordinator-internal",
    pathTemplate: ".signals/issue-{issue}/finalization.json",
    participation: "coordinator"
  }
];

export const gateOrder: readonly GateId[] = [
  "gate-1-join",
  "gate-2-plans",
  "gate-3-selection",
  "gate-4-implementation",
  "gate-5-comparison",
  "gate-6-consensus",
  "gate-7-finalized"
];

const stepsById = new Map<StepId, StepDefinition>(stepTable.map((step) => [step.stepId, step]));

export const stepById = (stepId: StepId): StepDefinition => {
  const step = stepsById.get(stepId);

  if (step === undefined) {
    throw new Error(`Unknown step id ${stepId}.`);
  }

  return step;
};

export const stepsForGate = (gateId: GateId): readonly StepDefinition[] =>
  stepTable.filter((step) => step.gateId === gateId);

/** Steps skipped entirely by the solo profile (no peers to review or compare). */
const soloSkippedGates: ReadonlySet<GateId> = new Set<GateId>([
  "gate-3-selection",
  "gate-5-comparison"
]);

export const stepsForProfile = (profile: Profile): readonly StepDefinition[] =>
  profile === "solo" ? stepTable.filter((step) => !soloSkippedGates.has(step.gateId)) : stepTable;

export const gatesForProfile = (profile: Profile): readonly GateId[] => {
  const included = new Set(stepsForProfile(profile).map((step) => step.gateId));

  return gateOrder.filter((gate) => included.has(gate));
};

export const renderPath = (template: string, issue: number, agent: string): string =>
  template.replaceAll("{issue}", String(issue)).replaceAll("{agent}", agent);

/**
 * Agents that perform a step, given the active roster and the selected
 * implementer/reviser. Dropped agents are never in `activeAgents`, so their
 * work can never become an input.
 */
export const participantsFor = (
  step: StepDefinition,
  profile: Profile,
  activeAgents: readonly string[],
  selected: string | null
): readonly string[] => {
  if (step.participation === "coordinator") {
    return [];
  }

  if (activeAgents.length <= 1) {
    // Degraded to solo: the remaining agent performs every agent-facing step.
    return step.participation === "reviewers" ? [] : activeAgents;
  }

  if (step.participation === "all-active") {
    return activeAgents;
  }

  const implementers =
    profile === "consensus"
      ? activeAgents
      : activeAgents.filter((agent) => agent === (selected ?? activeAgents[0]));

  if (step.participation === "implementers") {
    return implementers;
  }

  if (step.participation === "reviewers") {
    return activeAgents.filter((agent) => !implementers.includes(agent));
  }

  // reviser
  const reviser = selected ?? implementers[0] ?? activeAgents[0];

  return reviser === undefined ? [] : [reviser];
};

/** Number of agents that must satisfy a step before its gate can advance. */
export const gateDenominator = (
  gateId: GateId,
  profile: Profile,
  activeAgents: readonly string[],
  selected: string | null
): number =>
  stepsForGate(gateId)
    .filter((step) => stepsForProfile(profile).includes(step))
    .reduce((total, step) => total + participantsFor(step, profile, activeAgents, selected).length, 0);

/* -------------------------------------------------------------------------- */
/* Shared observation and decision vocabulary                                  */
/* -------------------------------------------------------------------------- */

/**
 * Result of evaluating one submission against one action's predicate.
 * `outstanding` values are concrete and stable so a re-order can name exactly
 * what is missing.
 */
export type EvidenceOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly outstanding: readonly string[] };

/**
 * A transient boundary failure (origin unreachable, mirror fetch failed).
 * Deliberately distinct from a failed predicate: it must never be converted
 * into a missing-artifact verdict, and it must not clear `complete`.
 */
export type BoundaryFailure = { readonly kind: "transient"; readonly detail: string };

export type VerificationResult =
  | { readonly kind: "verdict"; readonly outcome: EvidenceOutcome }
  | BoundaryFailure;

/** What the run loop observed about one agent during a tick. */
export type AgentObservation = {
  readonly agent: string;
  /** An action is currently outstanding for this agent. */
  readonly hasAction: boolean;
  readonly stepId: StepId | null;
  /** Parsed SHA from `complete`, or null when there is no intent. */
  readonly submissionSha: string | null;
  /** Present only when a submission was verified this tick. */
  readonly verification: VerificationResult | null;
  /** False when the harness process is gone from its pane. */
  readonly harnessAlive: boolean;
};

export type Observations = {
  readonly agents: readonly AgentObservation[];
  readonly now: string;
};

/** Everything the reducer may do. All of it is effect-free description. */
export type Decision =
  | { readonly kind: "order"; readonly agent: string; readonly stepId: StepId; readonly attempt: number }
  | {
      readonly kind: "reorder";
      readonly agent: string;
      readonly stepId: StepId;
      readonly attempt: number;
      readonly outstanding: readonly string[];
    }
  | { readonly kind: "accept"; readonly agent: string; readonly stepId: StepId; readonly submissionSha: string }
  | { readonly kind: "clear-completion"; readonly agent: string }
  | { readonly kind: "advance-gate"; readonly from: GateId; readonly to: GateId }
  | { readonly kind: "retry-verification"; readonly agent: string; readonly detail: string }
  | { readonly kind: "notify-owner"; readonly message: string }
  | { readonly kind: "await-owner"; readonly reason: string }
  | { readonly kind: "finalize"; readonly gateId: GateId }
  | { readonly kind: "wait" };
