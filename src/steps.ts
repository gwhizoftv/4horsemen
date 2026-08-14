export const DEFAULT_MAX_REVISION_ROUNDS = 3;

export type WorkflowProfile = "solo" | "reviewed" | "consensus";
/** `owner-only` is a legacy alias of `coord-open-unmerged` (opens a PR; owner merges). */
export type PrPolicy = "owner-only" | "coord-open-unmerged" | "coord-merged";
export const DEFAULT_PR_POLICY: PrPolicy = "coord-open-unmerged";

export const coordMergesPullRequest = (policy: PrPolicy): boolean => policy === "coord-merged";

export type EvidenceId =
  | "join-published"
  | "plan-published"
  | "review-published"
  | "plan-ballot-published"
  | "selection-published"
  | "implementation-pinned"
  | "comparison-published"
  | "comparison-ballot-published"
  | "reviser-authorized"
  | "revision-pinned"
  | "consensus-ballot-published"
  | "consensus-declared"
  | "finalization-verified";

export type WorkflowStepId =
  | "R1.join"
  | "R2.plan"
  | "R3.review"
  | "R3.plan-ballot"
  | "R3.publish-selection"
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
  | "gate-3-selection"
  | "gate-4-implementations"
  | "gate-5-comparison"
  | "gate-6-consensus"
  | "gate-7-finalized";

export type StepDefinition = {
  id: WorkflowStepId;
  gateId: GateId;
  evidenceId: EvidenceId;
  participants: "all" | "implementer" | "reviser";
  requiredPath: (issue: number, agent: string, round: number | null) => string;
  task: string;
};

export const STEP_DEFINITIONS: Readonly<Record<WorkflowStepId, StepDefinition>> = {
  "R1.join": {
    id: "R1.join",
    gateId: "gate-1-join",
    evidenceId: "join-published",
    participants: "all",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/joined-${agent}.json`,
    task: "Publish the join artifact for this issue."
  },
  "R2.plan": {
    id: "R2.plan",
    gateId: "gate-2-plans",
    evidenceId: "plan-published",
    participants: "all",
    requiredPath: (issue) => `.plans/issue-${issue}/plan.md`,
    task: "Write and publish a mechanically complete implementation plan."
  },
  "R3.review": {
    id: "R3.review",
    gateId: "gate-3-selection",
    evidenceId: "review-published",
    participants: "all",
    requiredPath: (issue) => `.plans/issue-${issue}/review.md`,
    task: "Review the bound peer plans and publish the review."
  },
  "R3.plan-ballot": {
    id: "R3.plan-ballot",
    gateId: "gate-3-selection",
    evidenceId: "plan-ballot-published",
    participants: "all",
    requiredPath: (issue, agent) => `.plans/issue-${issue}/ballot-${agent}.json`,
    task: "Publish a plan ballot citing the exact bound plan and review commits."
  },
  "R3.publish-selection": {
    id: "R3.publish-selection",
    gateId: "gate-3-selection",
    evidenceId: "selection-published",
    participants: "reviser",
    requiredPath: (issue) => `.plans/issue-${issue}/selection.json`,
    task: "Publish the mechanically selected plan from the bound ballots."
  },
  "R4.implement": {
    id: "R4.implement",
    gateId: "gate-4-implementations",
    evidenceId: "implementation-pinned",
    participants: "implementer",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/implementation-ready-${agent}.json`,
    task: "Implement the selected plan and publish an implementation-ready signal that pins the product commit."
  },
  "R5.compare": {
    id: "R5.compare",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-published",
    participants: "all",
    requiredPath: (issue) => `.code-reviews/issue-${issue}/comparison.md`,
    task: "Compare the exact bound implementation pins and publish the comparison."
  },
  "R5.compare-ballot": {
    id: "R5.compare-ballot",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-ballot-published",
    participants: "all",
    requiredPath: (issue, agent) => `.code-reviews/issue-${issue}/ballot-${agent}.json`,
    task: "Publish a comparison ballot citing every bound implementation pin."
  },
  "R5.reviser-auth": {
    id: "R5.reviser-auth",
    gateId: "gate-5-comparison",
    evidenceId: "reviser-authorized",
    participants: "reviser",
    requiredPath: (issue) => `.signals/issue-${issue}/reviser-authorized.json`,
    task: "Publish the automated reviser authorization from the bound comparison ballots."
  },
  "R6.revise": {
    id: "R6.revise",
    gateId: "gate-6-consensus",
    evidenceId: "revision-pinned",
    participants: "reviser",
    requiredPath: (issue, agent, round) =>
      `.signals/issue-${issue}/revision-ready-${agent}-round-${round ?? 1}.json`,
    task: "Prepare the requested revision and publish a signal pinning the revised product commit."
  },
  "R6.ballot": {
    id: "R6.ballot",
    gateId: "gate-6-consensus",
    evidenceId: "consensus-ballot-published",
    participants: "all",
    requiredPath: (issue, agent, round) =>
      `.code-reviews/issue-${issue}/consensus-ballot-${agent}-round-${round ?? 1}.json`,
    task: "Review the exact revision pin and publish a consensus disposition."
  },
  "R6.declare": {
    id: "R6.declare",
    gateId: "gate-6-consensus",
    evidenceId: "consensus-declared",
    participants: "reviser",
    requiredPath: (issue) => `.signals/issue-${issue}/consensus.json`,
    task: "Publish the consensus declaration from the bound unanimous approval ballots."
  },
  "R7.finalize": {
    id: "R7.finalize",
    gateId: "gate-7-finalized",
    evidenceId: "finalization-verified",
    participants: "reviser",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/finalization-ready-${agent}.json`,
    task: "Finalize the consensus commit, remove only current-issue coordination files, and publish finalization evidence."
  }
};

export const describeWorkflowStep = (stepId: WorkflowStepId | null, round: number | null): string => {
  if (stepId === null) return "complete";
  return round === null ? stepId : `${stepId} (round ${round})`;
};

const consensusSteps: readonly WorkflowStepId[] = [
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R3.publish-selection",
  "R4.implement",
  "R5.compare",
  "R5.compare-ballot",
  "R5.reviser-auth",
  "R6.revise",
  "R6.ballot",
  "R6.declare",
  "R7.finalize"
];

const reviewedSteps: readonly WorkflowStepId[] = [
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R3.publish-selection",
  "R4.implement",
  "R7.finalize"
];

const soloSteps: readonly WorkflowStepId[] = ["R1.join", "R2.plan", "R4.implement", "R7.finalize"];

export const stepsForProfile = (profile: WorkflowProfile): readonly WorkflowStepId[] => {
  if (profile === "consensus") return consensusSteps;
  if (profile === "reviewed") return reviewedSteps;
  return soloSteps;
};

export const participantsForStep = (
  stepId: WorkflowStepId,
  profile: WorkflowProfile,
  activeRoster: readonly string[],
  reviser?: string
): readonly string[] => {
  const step = STEP_DEFINITIONS[stepId];
  if (activeRoster.length === 0) return [];
  if (step.participants === "all") return activeRoster;
  const designated = reviser !== undefined && activeRoster.includes(reviser) ? reviser : activeRoster[0] as string;
  if (step.participants === "reviser") return [designated];
  return profile === "consensus" ? activeRoster : [designated];
};

export type BoundInput = {
  agent: string;
  commitSha: string;
  path: string;
  kind: string;
};

export type InternalOrder = {
  actionId: string;
  issue: number;
  agent: string;
  stepId: WorkflowStepId;
  evidenceId: EvidenceId;
  requiredPath: string;
  completePath: string;
  branch: string;
  round: number | null;
  issueSessionId: string;
  baselineSha: string;
  automationDigest: string;
  task: string;
  inputs: readonly BoundInput[];
  approvedPaths: readonly string[];
  activeRoster: readonly string[];
  eligibleChoices: readonly string[];
  expectedSelectedAgents: readonly string[];
  expectedImplementationAgent?: string;
  expectedImplementationPin?: string;
  expectedReviser?: string;
};

export type CheckResult = { name: string; argv: readonly string[]; exitCode: number };

export type EvidenceObservation = {
  agent: string;
  actionId: string;
  submissionSha: string;
  status: "satisfied" | "rejected" | "retry";
  outstanding: readonly string[];
  productPin?: string;
  disposition?: "approve" | "revise" | "escalate";
  approvedPaths?: readonly string[];
  selectedAgents?: readonly string[];
  choice?: string;
  reviser?: string;
  checkResults?: readonly CheckResult[];
};

export type MachineDecision =
  | { type: "prepare-action"; agent: string; stepId: WorkflowStepId; round: number | null }
  | {
      type: "accept-submission";
      agent: string;
      submissionSha: string;
      productPin?: string;
      disposition?: "approve" | "revise" | "escalate";
      approvedPaths?: readonly string[];
      selectedAgents?: readonly string[];
      choice?: string;
      reviser?: string;
      checkResults?: readonly CheckResult[];
    }
  | { type: "reissue-action"; agent: string; outstanding: readonly string[] }
  | { type: "retry-verification"; agent: string; outstanding: readonly string[] }
  | { type: "advance-step"; from: WorkflowStepId; to: WorkflowStepId | null; round: number | null }
  | { type: "wait"; reason: string }
  | {
      type: "owner-action-required";
      reason: string;
      kind: "ballot-escalation" | "revision-limit";
      round: number;
      allowedAnswers: readonly ("retry" | "revise" | "abandon")[];
    };
