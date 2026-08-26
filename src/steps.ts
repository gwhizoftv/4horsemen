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
  | "plan-ballot-response-accepted"
  | "plan-ballot-published"
  | "implementation-pinned"
  | "comparison-published"
  | "comparison-ballot-response-accepted"
  | "comparison-ballot-published"
  | "revision-pinned"
  | "consensus-ballot-response-accepted"
  | "consensus-ballot-published"
  | "finalization-verified";

export type WorkflowStepId =
  | "R1.join"
  | "R2.plan"
  | "R3.review"
  | "R3.plan-ballot"
  | "R4.implement"
  | "R5.compare"
  | "R5.compare-ballot"
  | "R6.revise"
  | "R6.ballot"
  | "R7.finalize";

export type GateId =
  | "gate-1-join"
  | "gate-2-plans"
  | "gate-3-selection"
  | "gate-4-implementations"
  | "gate-5-comparison"
  | "gate-6-consensus"
  | "gate-7-finalized";

/**
 * Appended to every action, not only the first one.
 *
 * Coordination checks the clone out and re-sets the skip-worktree bit before
 * any agent starts, but an agent that compacts, restarts, or reads only the
 * action in front of it has no memory of that. It used to be told once, on the
 * first action of the run, which is exactly the wrong place for a fact it needs
 * on every step.
 */
export const BRANCH_PREPARED_NOTE =
  "\n\nCoordination has already checked this clone out on the branch named below " +
  "and re-set the skip-worktree bit on AGENTS.md. Do not create that branch, " +
  "switch to it, or clear skip-worktree to make a checkout work. If the clone " +
  "looks wrong, report that instead of repairing it by hand.";

export type StepDefinition = {
  id: WorkflowStepId;
  gateId: GateId;
  evidenceId: EvidenceId;
  submissionMode?: "git" | "response";
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
    submissionMode: "git",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/participation-ready-${agent}.json`,
    task: "Publish the participation-readiness artifact for this issue."
  },
  "R2.plan": {
    id: "R2.plan",
    gateId: "gate-2-plans",
    evidenceId: "plan-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue) => `.plans/issue-${issue}/plan.md`,
    task: "Write and publish a mechanically complete implementation plan."
  },
  "R3.review": {
    id: "R3.review",
    gateId: "gate-3-selection",
    evidenceId: "review-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue) => `.plans/issue-${issue}/review.md`,
    task: "Review the bound peer plans and publish the review."
  },
  "R3.plan-ballot": {
    id: "R3.plan-ballot",
    gateId: "gate-3-selection",
    evidenceId: "plan-ballot-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent) => `.plans/issue-${issue}/ballot-${agent}.json`,
    task: "Submit a private plan choice and rationale after inspecting the exact bound plan and review commits."
  },
  "R4.implement": {
    id: "R4.implement",
    gateId: "gate-4-implementations",
    evidenceId: "implementation-pinned",
    participants: "implementer",
    submissionMode: "git",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/implementation-ready-${agent}.json`,
    task: "Implement the selected plan and publish an implementation-ready signal that pins the product commit."
  },
  "R5.compare": {
    id: "R5.compare",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-published",
    participants: "all",
    submissionMode: "git",
    requiredPath: (issue) => `.code-reviews/issue-${issue}/comparison.md`,
    task: "Compare the exact bound implementation pins and publish the comparison."
  },
  "R5.compare-ballot": {
    id: "R5.compare-ballot",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-ballot-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent) => `.code-reviews/issue-${issue}/ballot-${agent}.json`,
    task: "Submit a private implementation choice and rationale after inspecting every bound implementation pin."
  },
  "R6.revise": {
    id: "R6.revise",
    gateId: "gate-6-consensus",
    evidenceId: "revision-pinned",
    participants: "reviser",
    submissionMode: "git",
    requiredPath: (issue, agent, round) =>
      `.signals/issue-${issue}/revision-ready-${agent}-round-${round ?? 1}.json`,
    task: "Prepare the requested revision and publish a signal pinning the revised product commit."
  },
  "R6.ballot": {
    id: "R6.ballot",
    gateId: "gate-6-consensus",
    evidenceId: "consensus-ballot-response-accepted",
    participants: "all",
    submissionMode: "response",
    requiredPath: (issue, agent, round) =>
      `.code-reviews/issue-${issue}/consensus-ballot-${agent}-round-${round ?? 1}.json`,
    task: "Review the exact revision pin and submit a private consensus disposition and rationale."
  },
  "R7.finalize": {
    id: "R7.finalize",
    gateId: "gate-7-finalized",
    evidenceId: "finalization-verified",
    participants: "reviser",
    submissionMode: "git",
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
  "R4.implement",
  "R5.compare",
  "R5.compare-ballot",
  "R6.revise",
  "R6.ballot",
  "R7.finalize"
];

const reviewedSteps: readonly WorkflowStepId[] = [
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
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

/**
 * Changed paths of one bound pin, resolved by the coordinator so that N agents
 * comparing the same pins do not each re-derive the same diff. Advisory only:
 * `approvedPaths` remains the sole authority over what an implementation may
 * touch.
 */
export type ChangeScopeEntry = {
  agent: string;
  commitSha: string;
  paths: readonly string[];
  /** True when `paths` was capped and does not list the whole diff. */
  truncated: boolean;
};

export type InternalOrder = {
  actionId: string;
  issue: number;
  agent: string;
  stepId: WorkflowStepId;
  evidenceId: EvidenceId;
  submissionMode?: "git" | "response";
  requiredPath: string;
  responsePath?: string | null;
  completePath: string;
  branch: string;
  round: number | null;
  issueSessionId: string;
  baselineSha: string;
  automationDigest: string;
  task: string;
  inputs: readonly BoundInput[];
  approvedPaths: readonly string[];
  /**
   * Advisory, and optional on purpose: an added hint must not become a required
   * argument at every site that builds an order, and rendering must cope with
   * its absence rather than making callers supply an empty list.
   */
  contextPaths?: readonly string[];
  changeScope?: readonly ChangeScopeEntry[];
  activeRoster: readonly string[];
  eligibleChoices: readonly string[];
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
  choice?: string;
  checkResults?: readonly CheckResult[];
};

export type ResponseObservation = {
  agent: string;
  actionId: string;
  status: "satisfied" | "rejected";
  outstanding: readonly string[];
  responseSha256?: string;
  rationale?: string;
  choice?: string;
  disposition?: "approve" | "revise" | "escalate";
  bytes?: Uint8Array;
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
      choice?: string;
      checkResults?: readonly CheckResult[];
    }
  | {
      type: "accept-response";
      agent: string;
      responseSha256: string;
      rationale: string;
      choice?: string;
      disposition?: "approve" | "revise" | "escalate";
      bytes: Uint8Array;
    }
  | {
      type: "publish-ballot-batch";
      stepId: "R3.plan-ballot" | "R5.compare-ballot" | "R6.ballot";
      round: number | null;
    }
  | { type: "reissue-action"; agent: string; outstanding: readonly string[] }
  | { type: "retry-verification"; agent: string; outstanding: readonly string[] }
  | { type: "advance-step"; from: WorkflowStepId; to: WorkflowStepId | null; round: number | null }
  | { type: "derive-plan-selection" }
  | { type: "derive-implementation-selection" }
  | { type: "derive-consensus"; round: number }
  | { type: "wait"; reason: string }
  | {
      type: "owner-action-required";
      reason: string;
      kind: "ballot-escalation" | "revision-limit";
      round: number;
      allowedAnswers: readonly ("retry" | "revise" | "abandon")[];
    };
