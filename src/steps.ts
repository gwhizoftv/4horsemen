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
  | "plan-ballot-accepted"
  | "implementation-pinned"
  | "comparison-published"
  | "comparison-ballot-accepted"
  | "revision-pinned"
  | "consensus-ballot-accepted"
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

/**
 * How an agent answers an action.
 *
 * `git` is the original contract: publish an artifact at a repository path,
 * push, and write the pushed SHA. `response` is for the three ballot steps:
 * write a small private JSON judgment to an action-scoped runtime path plus an
 * action-bound marker, with no Git write at all. A closed union rather than an
 * inferred property, so a forbidden cross-mode field is a parse error rather
 * than something a reader has to notice.
 */
export type SubmissionMode = "git" | "response";

export type StepDefinition = {
  id: WorkflowStepId;
  gateId: GateId;
  evidenceId: EvidenceId;
  participants: "all" | "implementer" | "reviser";
  submissionMode: SubmissionMode;
  /**
   * For a `git` step, the repository path the agent must publish at.
   *
   * For a `response` step this is not an agent destination: the agent is never
   * told a repository path, never commits, and never pushes. It is the
   * canonical path the coordinator writes the published ballot to on its own
   * evidence branch, kept here so the published layout stays beside the step it
   * belongs to.
   */
  requiredPath: (issue: number, agent: string, round: number | null) => string;
  task: string;
};

/** The three steps whose judgment arrives as a private runtime response. */
export const BALLOT_STEP_IDS = ["R3.plan-ballot", "R5.compare-ballot", "R6.ballot"] as const;

export type BallotStepId = (typeof BALLOT_STEP_IDS)[number];

export const isBallotStep = (stepId: WorkflowStepId): stepId is BallotStepId =>
  (BALLOT_STEP_IDS as readonly WorkflowStepId[]).includes(stepId);

/**
 * The agent id reserved for the coordinator's own evidence branch.
 *
 * Rendered through the configured branch template like any agent, so the
 * evidence branch obeys whatever naming a workspace already uses. Reserved at
 * config parse time precisely because it is rendered that way: an agent
 * actually named this would make the coordinator publish its ballot batches
 * onto that agent's own branch.
 */
export const RESERVED_EVIDENCE_AGENT = "coordinator-evidence";

export const evidenceBranchFor = (branchTemplate: string, issue: number): string =>
  branchTemplate.replaceAll("{issue}", String(issue)).replaceAll("{agent}", RESERVED_EVIDENCE_AGENT);

export const STEP_DEFINITIONS: Readonly<Record<WorkflowStepId, StepDefinition>> = {
  "R1.join": {
    id: "R1.join",
    gateId: "gate-1-join",
    evidenceId: "join-published",
    submissionMode: "git",
    participants: "all",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/participation-ready-${agent}.json`,
    task: "Publish the participation-readiness artifact for this issue."
  },
  "R2.plan": {
    id: "R2.plan",
    gateId: "gate-2-plans",
    evidenceId: "plan-published",
    submissionMode: "git",
    participants: "all",
    requiredPath: (issue) => `.plans/issue-${issue}/plan.md`,
    task: "Write and publish a mechanically complete implementation plan."
  },
  "R3.review": {
    id: "R3.review",
    gateId: "gate-3-selection",
    evidenceId: "review-published",
    submissionMode: "git",
    participants: "all",
    requiredPath: (issue) => `.plans/issue-${issue}/review.md`,
    task: "Review the bound peer plans and publish the review."
  },
  "R3.plan-ballot": {
    id: "R3.plan-ballot",
    gateId: "gate-3-selection",
    evidenceId: "plan-ballot-accepted",
    submissionMode: "response",
    participants: "all",
    requiredPath: (issue, agent) => `.plans/issue-${issue}/ballot-${agent}.json`,
    task: "Read the bound plans and reviews, then submit your plan choice and a one-sentence rationale."
  },
  "R4.implement": {
    id: "R4.implement",
    gateId: "gate-4-implementations",
    evidenceId: "implementation-pinned",
    submissionMode: "git",
    participants: "implementer",
    requiredPath: (issue, agent) => `.signals/issue-${issue}/implementation-ready-${agent}.json`,
    task: "Implement the selected plan and publish an implementation-ready signal that pins the product commit."
  },
  "R5.compare": {
    id: "R5.compare",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-published",
    submissionMode: "git",
    participants: "all",
    requiredPath: (issue) => `.code-reviews/issue-${issue}/comparison.md`,
    task: "Compare the exact bound implementation pins and publish the comparison."
  },
  "R5.compare-ballot": {
    id: "R5.compare-ballot",
    gateId: "gate-5-comparison",
    evidenceId: "comparison-ballot-accepted",
    submissionMode: "response",
    participants: "all",
    requiredPath: (issue, agent) => `.code-reviews/issue-${issue}/ballot-${agent}.json`,
    task: "Read the bound implementation pins, then submit your choice and a one-sentence rationale."
  },
  "R6.revise": {
    id: "R6.revise",
    gateId: "gate-6-consensus",
    evidenceId: "revision-pinned",
    submissionMode: "git",
    participants: "reviser",
    requiredPath: (issue, agent, round) =>
      `.signals/issue-${issue}/revision-ready-${agent}-round-${round ?? 1}.json`,
    task: "Prepare the requested revision and publish a signal pinning the revised product commit."
  },
  "R6.ballot": {
    id: "R6.ballot",
    gateId: "gate-6-consensus",
    evidenceId: "consensus-ballot-accepted",
    submissionMode: "response",
    participants: "all",
    requiredPath: (issue, agent, round) =>
      `.code-reviews/issue-${issue}/consensus-ballot-${agent}-round-${round ?? 1}.json`,
    task: "Review the exact revision pin, then submit your disposition and a one-sentence rationale."
  },
  "R7.finalize": {
    id: "R7.finalize",
    gateId: "gate-7-finalized",
    evidenceId: "finalization-verified",
    submissionMode: "git",
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
  submissionMode: SubmissionMode;
  /**
   * Repository destination for a `git` order; for a `response` order this is
   * the canonical path the coordinator will publish the ballot at, and it is
   * never rendered into the action.
   */
  requiredPath: string;
  /**
   * Absolute action-scoped response path, set only for a `response` order.
   * Derived from trusted runtime paths and the action id — never from anything
   * an agent supplied.
   */
  responsePath: string | null;
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

/**
 * What the coordinator observed about one private ballot response.
 *
 * Deliberately not an `EvidenceObservation`: that type is keyed on a pushed Git
 * SHA, and a response has none. Collapsing the two would force a fake SHA into
 * the accepted record and lose the distinction between agent intent and
 * coordinator publication that the rest of this design rests on.
 */
export type ResponseObservation = {
  agent: string;
  actionId: string;
  status: "satisfied" | "rejected";
  outstanding: readonly string[];
  /** SHA-256 over the exact accepted bytes, computed by the coordinator. */
  responseSha256?: string;
  rationale?: string;
  choice?: string;
  disposition?: "approve" | "revise" | "escalate";
};

export type MachineDecision =
  | { type: "prepare-action"; agent: string; stepId: WorkflowStepId; round: number | null }
  | {
      type: "accept-response";
      agent: string;
      responseSha256: string;
      rationale: string;
      choice?: string;
      disposition?: "approve" | "revise" | "escalate";
    }
  /**
   * The active denominator for a ballot step is complete and no published batch
   * covers it yet.
   *
   * This exists as a decision rather than as a `wait` because `runTick` acts
   * only on non-`wait` decisions: a barrier that reported "waiting for
   * publication" without also asking for the publication would never produce
   * the batch it was waiting for, and the issue would stall with every response
   * accepted and nothing left to trigger progress.
   */
  | { type: "publish-ballot-batch"; stepId: BallotStepId; round: number | null }
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
