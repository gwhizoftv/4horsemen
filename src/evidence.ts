import { type InternalAction } from "./action.js";
import { type EvidenceObservation, type OutstandingItem } from "./steps.js";
import { readBlob, isReachable, commitExists, isAncestor } from "./mirror.js";
import { JoinSchema, PlanBallotSchema, ImplementationReadySchema, ComparisonBallotSchema, RevisionReadySchema, ConsensusBallotSchema, ConsensusDeclarationSchema, parseArtifact } from "./protocol.js";

function fail(agent: string, stepId: string, sha: string, items: OutstandingItem[]): EvidenceObservation {
  return { ok: false, agent, stepId: stepId as unknown as EvidenceObservation["stepId"], submissionSha: sha, outstanding: items };
}

function pass(agent: string, stepId: string, sha: string): EvidenceObservation {
  return { ok: true, agent, stepId: stepId as unknown as EvidenceObservation["stepId"], submissionSha: sha, outstanding: [] };
}

/**
 * Evaluate whether a submission SHA satisfies the evidence requirements for an action.
 * The coordRoot and issue session fields are needed for cross-referencing.
 */
export function evaluateEvidence(
  coordRoot: string,
  action: InternalAction,
  submissionSha: string,
  issueSessionId: string,
  startBaseline: string,
  startDigest: string,
  startDigestScheme: string,
  activeAgents: readonly string[],
): EvidenceObservation {
  const { agent, stepId, evidenceId, requiredPath, issue } = action;
  const branch = `issue-${issue}/${agent}`;

  if (!isReachable(coordRoot, submissionSha, branch)) {
    return fail(agent, stepId, submissionSha, [{ code: "submission-not-on-branch", message: `Commit ${submissionSha} is not reachable from ${branch}` }]);
  }

  if (evidenceId === "finalization-verified") {
    return pass(agent, stepId, submissionSha);
  }

  if (!requiredPath) {
    return fail(agent, stepId, submissionSha, [{ code: "no-required-path", message: "Action has no required path configured" }]);
  }

  const blob = readBlob(coordRoot, submissionSha, requiredPath);
  if (blob === null) {
    return fail(agent, stepId, submissionSha, [{ code: "missing-artifact", message: `Required path ${requiredPath} does not exist in commit ${submissionSha}` }]);
  }

  switch (evidenceId) {
    case "join-published":
      return evaluateJoin(agent, stepId, submissionSha, blob, issueSessionId, startBaseline, startDigest, startDigestScheme);
    case "plan-published":
      return evaluatePlan(agent, stepId, submissionSha, blob);
    case "review-published":
      return evaluateReview(agent, stepId, submissionSha, blob);
    case "plan-ballot-published":
      return evaluatePlanBallot(agent, stepId, submissionSha, blob, issueSessionId, action.inputCommits);
    case "implementation-pinned":
      return evaluateImplementation(coordRoot, agent, stepId, submissionSha, blob, issueSessionId, startBaseline, issue);
    case "compare-published":
      return evaluateCompare(agent, stepId, submissionSha, blob);
    case "compare-ballot-published":
      return evaluateCompareBallot(agent, stepId, submissionSha, blob, issueSessionId, action.inputCommits);
    case "reviser-authorized":
      return pass(agent, stepId, submissionSha);
    case "revision-pinned":
      return evaluateRevision(coordRoot, agent, stepId, submissionSha, blob, issueSessionId, issue);
    case "consensus-ballot-published":
      return evaluateConsensusBallot(agent, stepId, submissionSha, blob, issueSessionId, action.inputCommits);
    case "consensus-declared":
      return evaluateConsensusDeclaration(agent, stepId, submissionSha, blob, issueSessionId, activeAgents);
    default:
      return fail(agent, stepId, submissionSha, [{ code: "unknown-evidence", message: `Unknown evidence predicate: ${evidenceId}` }]);
  }
}

function evaluateJoin(agent: string, stepId: string, sha: string, blob: string, sessionId: string, baseline: string, digest: string, digestScheme: string): EvidenceObservation {
  const result = parseArtifact(JoinSchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-join", message: result.error }]);
  const join = result.value;
  const issues: OutstandingItem[] = [];
  if (join.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}, got ${join.issueSessionId}` });
  if (join.agent !== agent) issues.push({ code: "agent-mismatch", message: `Expected agent ${agent}, got ${join.agent}` });
  if (join.baselineSha !== baseline) issues.push({ code: "baseline-mismatch", message: `Expected baseline ${baseline}, got ${join.baselineSha}` });
  if (join.automationDigest !== digest) issues.push({ code: "digest-mismatch", message: `Expected digest ${digest}, got ${join.automationDigest}` });
  if (join.automationDigestScheme !== digestScheme) issues.push({ code: "digest-scheme-mismatch", message: `Expected scheme ${digestScheme}, got ${join.automationDigestScheme}` });
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

const REQUIRED_PLAN_SECTIONS = ["## Exact file map", "## Required behavior", "## Alternatives rejected", "## Risks and mitigations", "## Conclusion"];

function evaluatePlan(agent: string, stepId: string, sha: string, blob: string): EvidenceObservation {
  const issues: OutstandingItem[] = [];
  for (const section of REQUIRED_PLAN_SECTIONS) {
    if (!blob.includes(section)) {
      issues.push({ code: "missing-section", message: `Plan is missing required section: ${section}` });
    }
  }
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

const REQUIRED_REVIEW_SECTIONS = ["## Verdict", "## Findings"];

function evaluateReview(agent: string, stepId: string, sha: string, blob: string): EvidenceObservation {
  const issues: OutstandingItem[] = [];
  for (const section of REQUIRED_REVIEW_SECTIONS) {
    if (!blob.includes(section)) {
      issues.push({ code: "missing-section", message: `Review is missing required section: ${section}` });
    }
  }
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

function evaluatePlanBallot(agent: string, stepId: string, sha: string, blob: string, sessionId: string, _inputCommits: Record<string, string>): EvidenceObservation {
  const result = parseArtifact(PlanBallotSchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-ballot", message: result.error }]);
  const ballot = result.value;
  const issues: OutstandingItem[] = [];
  if (ballot.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}` });
  if (ballot.agent !== agent) issues.push({ code: "agent-mismatch", message: `Expected agent ${agent}` });
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

function evaluateImplementation(coordRoot: string, agent: string, stepId: string, sha: string, blob: string, sessionId: string, baseline: string, _issue: number): EvidenceObservation {
  const result = parseArtifact(ImplementationReadySchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-implementation", message: result.error }]);
  const impl = result.value;
  const issues: OutstandingItem[] = [];
  if (impl.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}` });
  if (impl.agent !== agent) issues.push({ code: "agent-mismatch", message: `Expected agent ${agent}` });
  if (impl.implementationCommitSha === sha) issues.push({ code: "pin-is-signal", message: "Implementation pin must not be the signal commit itself" });
  if (!commitExists(coordRoot, impl.implementationCommitSha)) issues.push({ code: "pin-not-found", message: `Implementation pin ${impl.implementationCommitSha} not found` });
  else if (!isAncestor(coordRoot, baseline, impl.implementationCommitSha)) issues.push({ code: "pin-not-descendant", message: `Implementation pin is not a descendant of baseline ${baseline}` });
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

function evaluateCompare(agent: string, stepId: string, sha: string, blob: string): EvidenceObservation {
  if (blob.trim().length === 0) return fail(agent, stepId, sha, [{ code: "empty-comparison", message: "Comparison document is empty" }]);
  return pass(agent, stepId, sha);
}

function evaluateCompareBallot(agent: string, stepId: string, sha: string, blob: string, sessionId: string, _inputCommits: Record<string, string>): EvidenceObservation {
  const result = parseArtifact(ComparisonBallotSchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-ballot", message: result.error }]);
  const ballot = result.value;
  const issues: OutstandingItem[] = [];
  if (ballot.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}` });
  if (ballot.agent !== agent) issues.push({ code: "agent-mismatch", message: `Expected agent ${agent}` });
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

function evaluateRevision(coordRoot: string, agent: string, stepId: string, sha: string, blob: string, sessionId: string, _issue: number): EvidenceObservation {
  const result = parseArtifact(RevisionReadySchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-revision", message: result.error }]);
  const rev = result.value;
  const issues: OutstandingItem[] = [];
  if (rev.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}` });
  if (rev.agent !== agent) issues.push({ code: "agent-mismatch", message: `Expected agent ${agent}` });
  if (rev.revisedBranchHead === sha) issues.push({ code: "pin-is-signal", message: "Revision pin must not be the signal commit itself" });
  if (!commitExists(coordRoot, rev.revisedBranchHead)) issues.push({ code: "pin-not-found", message: `Revision pin ${rev.revisedBranchHead} not found` });
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

function evaluateConsensusBallot(agent: string, stepId: string, sha: string, blob: string, sessionId: string, _inputCommits: Record<string, string>): EvidenceObservation {
  const result = parseArtifact(ConsensusBallotSchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-ballot", message: result.error }]);
  const ballot = result.value;
  const issues: OutstandingItem[] = [];
  if (ballot.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}` });
  if (ballot.agent !== agent) issues.push({ code: "agent-mismatch", message: `Expected agent ${agent}` });
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}

function evaluateConsensusDeclaration(agent: string, stepId: string, sha: string, blob: string, sessionId: string, activeAgents: readonly string[]): EvidenceObservation {
  const result = parseArtifact(ConsensusDeclarationSchema, blob);
  if (!result.ok) return fail(agent, stepId, sha, [{ code: "invalid-declaration", message: result.error }]);
  const decl = result.value;
  const issues: OutstandingItem[] = [];
  if (decl.issueSessionId !== sessionId) issues.push({ code: "session-mismatch", message: `Expected session ${sessionId}` });
  for (const a of activeAgents) {
    if (!(a in decl.voters)) issues.push({ code: "missing-voter", message: `Agent ${a} has not voted` });
  }
  return issues.length > 0 ? fail(agent, stepId, sha, issues) : pass(agent, stepId, sha);
}
