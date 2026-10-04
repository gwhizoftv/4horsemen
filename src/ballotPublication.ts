import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sha256 } from "./hash.js";
import { GitCommandError, isTransientGitFailure, runGitCommand } from "./mirror.js";
import { RESERVED_EVIDENCE_AGENT } from "./paths.js";
import {
  comparisonBallotArtifactSchema,
  consensusBallotArtifactSchema,
  gitShaSchema,
  planAmendmentBallotArtifactSchema,
  planBallotArtifactSchema,
  repositoryPathSchema,
  type ComparisonBallotArtifact,
  type ConsensusBallotArtifact,
  type PlanAmendmentBallotArtifact,
  type PlanBallotArtifact
} from "./protocol.js";
import type { BoundInput, WorkflowStepId } from "./steps.js";

/** Fixed author/committer on every evidence-branch commit. Never a voting agent. */
export const COORDINATOR_EVIDENCE_AUTHOR = {
  name: "Coordination Driver",
  email: "coordination@local"
} as const;

export type BallotBatchKind =
  | "plan-ballot-batch"
  | "comparison-ballot-batch"
  | "consensus-ballot-batch"
  | "amendment-ballot-batch";

export type BallotBatchStatus = "pending" | "published" | "failed" | "invalidated";

/**
 * Durable publication outbox / history row expected on `CursorsState.ballotBatches`
 * once runtime format 4 lands in `state.ts`.
 *
 * `commitSha` is frozen before the network push; retries push that exact object.
 */
export type BallotBatchRecord = {
  kind: BallotBatchKind;
  stepId: WorkflowStepId;
  round: number | null;
  activeRoster: readonly string[];
  inputSetHash: string;
  responseSha256s: readonly string[];
  paths: readonly string[];
  branch: string;
  parentSha: string;
  commitSha: string;
  status: BallotBatchStatus;
  attempts: number;
  error: string | null;
  /** Prior batch `inputSetHash` this supersedes, when a roster change rebuilds. */
  supersedes: string | null;
  createdAt: string;
  publishedAt: string | null;
};

/** Accepted private-response semantics needed to build a canonical published ballot. */
export type BallotAcceptedSemantics = {
  agent: string;
  actionId: string;
  responseSha256: string;
  rationale: string;
  choice?: string;
  disposition?: "approve" | "revise" | "escalate";
};

export type ArtifactCitation = {
  agent: string;
  commitSha: string;
  path: string;
};

export type BallotBatchFileEntry = {
  path: string;
  content: string;
};

export type PreparedBallotBatch = {
  kind: BallotBatchKind;
  round: number | null;
  activeRoster: readonly string[];
  inputSetHash: string;
  responseSha256s: readonly string[];
  paths: readonly string[];
  files: readonly BallotBatchFileEntry[];
  message: string;
};

export type EvidenceCommitMirror = {
  materializeWorktree(target: string, sha: string): Promise<void>;
  removeWorktree(target: string): Promise<void>;
};

export type EvidencePublicationReconcile =
  | { outcome: "already-published" }
  | { outcome: "push" }
  | { outcome: "conflict"; remoteTip: string };

const lengthPrefixed = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`;

const sortCitations = (citations: readonly ArtifactCitation[]): ArtifactCitation[] =>
  [...citations].sort((left, right) =>
    `${left.agent}\0${left.commitSha}\0${left.path}`.localeCompare(
      `${right.agent}\0${right.commitSha}\0${right.path}`
    )
  );

const citationsFromBoundInputs = (inputs: readonly BoundInput[], kind: string): ArtifactCitation[] =>
  sortCitations(
    inputs
      .filter((input) => input.kind === kind)
      .map((input) => ({ agent: input.agent, commitSha: input.commitSha, path: input.path }))
  );

/**
 * Stable canonical JSON: recursively sorted object keys, two-space indent, final newline.
 * Insertion order must not affect published blob bytes.
 */
export const serializeCanonicalJson = (value: unknown): string => {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(canonicalize);
    if (candidate !== null && typeof candidate === "object") {
      const record = candidate as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) {
        sorted[key] = canonicalize(record[key]);
      }
      return sorted;
    }
    return candidate;
  };
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
};

/** Derive `issue-<n>/coordinator-evidence` (or whatever the branch template yields). */
export const deriveEvidenceBranch = (branchTemplate: string, issue: number): string =>
  branchTemplate.replaceAll("{issue}", String(issue)).replaceAll("{agent}", RESERVED_EVIDENCE_AGENT);

/**
 * Reject reserved-agent roster membership and evidence-branch collisions with
 * agent branches, `*-final` branches, or the configured base branch.
 */
export const assertEvidenceBranchSafe = (input: {
  branchTemplate: string;
  issue: number;
  agentIds: readonly string[];
  baseBranch: string;
}): string => {
  if (input.agentIds.includes(RESERVED_EVIDENCE_AGENT)) {
    throw new Error(
      `${RESERVED_EVIDENCE_AGENT} is reserved for the coordinator evidence branch and cannot be an agent id.`
    );
  }
  const branch = deriveEvidenceBranch(input.branchTemplate, input.issue);
  for (const agent of input.agentIds) {
    const agentBranch = input.branchTemplate
      .replaceAll("{issue}", String(input.issue))
      .replaceAll("{agent}", agent);
    if (branch === agentBranch || branch === `${agentBranch}-final`) {
      throw new Error(`The evidence branch ${branch} collides with an agent or final branch.`);
    }
  }
  if (branch === input.baseBranch) {
    throw new Error(`The evidence branch ${branch} collides with the base branch.`);
  }
  return branch;
};

export const canonicalBallotPath = (
  kind: BallotBatchKind,
  issue: number,
  agent: string,
  round: number | null
): string => {
  if (kind === "plan-ballot-batch") return `.plans/issue-${issue}/ballot-${agent}.json`;
  if (kind === "comparison-ballot-batch") return `.code-reviews/issue-${issue}/ballot-${agent}.json`;
  if (kind === "amendment-ballot-batch") {
    return `.plans/issue-${issue}/amendment-ballot-${agent}-seq-${round ?? 1}.json`;
  }
  return `.code-reviews/issue-${issue}/consensus-ballot-${agent}-round-${round ?? 1}.json`;
};

export const ballotBatchKindForStep = (stepId: WorkflowStepId): BallotBatchKind => {
  if (stepId === "R3.plan-ballot") return "plan-ballot-batch";
  if (stepId === "R5.compare-ballot") return "comparison-ballot-batch";
  if (stepId === "R6.ballot") return "consensus-ballot-batch";
  if (stepId === "R4.amend-ballot") return "amendment-ballot-batch";
  throw new Error(`Step ${stepId} is not a ballot batch step.`);
};

export const evidenceCommitMessage = (
  kind: BallotBatchKind,
  issue: number,
  round: number | null
): string => {
  const roundSuffix =
    kind === "consensus-ballot-batch"
      ? ` round ${round ?? 1}`
      : kind === "amendment-ballot-batch"
        ? ` sequence ${round ?? 1}`
        : "";
  return `Coordinator: publish ${kind} evidence for issue ${issue}${roundSuffix}`;
};

/**
 * Identity of one frozen batch: what was voted on, by whom, and which judgments.
 * Components are length-prefixed so delimiters cannot alias another set.
 */
export const computeBallotBatchInputSetHash = (input: {
  kind: BallotBatchKind;
  round: number | null;
  activeRoster: readonly string[];
  boundInputs: readonly BoundInput[];
  responses: readonly Pick<BallotAcceptedSemantics, "agent" | "actionId" | "responseSha256">[];
}): string => {
  const citations = [...input.boundInputs]
    .map((bound) => [bound.kind, bound.agent, bound.commitSha, bound.path].map(lengthPrefixed).join(""))
    .sort();
  const tuples = input.responses.map((response) =>
    [response.agent, response.actionId, response.responseSha256].map(lengthPrefixed).join("")
  );
  const fields = [
    "coordinator-ballot-batch-v1",
    input.kind,
    input.round === null ? "" : String(input.round),
    String(input.activeRoster.length),
    ...input.activeRoster,
    String(citations.length),
    ...citations,
    String(tuples.length),
    ...tuples
  ];
  return sha256(fields.map(lengthPrefixed).join(""));
};

export const buildCanonicalPlanBallot = (input: {
  issue: number;
  issueSessionId: string;
  agent: string;
  actionId: string;
  responseSha256: string;
  rationale: string;
  choice: string;
  inputSetHash: string;
  plans: readonly ArtifactCitation[];
  reviews: readonly ArtifactCitation[];
}): PlanBallotArtifact =>
  planBallotArtifactSchema.parse({
    protocolVersion: 2,
    issue: input.issue,
    issueSessionId: input.issueSessionId,
    agent: input.agent,
    inputSetHash: input.inputSetHash,
    actionId: input.actionId,
    responseSha256: input.responseSha256,
    rationale: input.rationale,
    artifact: "plan-ballot",
    plans: sortCitations(input.plans),
    reviews: sortCitations(input.reviews),
    choice: input.choice
  });

export const buildCanonicalComparisonBallot = (input: {
  issue: number;
  issueSessionId: string;
  agent: string;
  actionId: string;
  responseSha256: string;
  rationale: string;
  choice: string;
  inputSetHash: string;
  implementations: readonly ArtifactCitation[];
}): ComparisonBallotArtifact =>
  comparisonBallotArtifactSchema.parse({
    protocolVersion: 2,
    issue: input.issue,
    issueSessionId: input.issueSessionId,
    agent: input.agent,
    inputSetHash: input.inputSetHash,
    actionId: input.actionId,
    responseSha256: input.responseSha256,
    rationale: input.rationale,
    artifact: "comparison-ballot",
    implementations: sortCitations(input.implementations),
    choice: input.choice
  });

export const buildCanonicalAmendmentBallot = (input: {
  issue: number;
  issueSessionId: string;
  agent: string;
  actionId: string;
  responseSha256: string;
  rationale: string;
  disposition: "approve" | "revise";
  inputSetHash: string;
  sequence: number;
  request: ArtifactCitation;
  selectedPlans: readonly ArtifactCitation[];
}): PlanAmendmentBallotArtifact =>
  planAmendmentBallotArtifactSchema.parse({
    protocolVersion: 2,
    issue: input.issue,
    issueSessionId: input.issueSessionId,
    agent: input.agent,
    inputSetHash: input.inputSetHash,
    actionId: input.actionId,
    responseSha256: input.responseSha256,
    rationale: input.rationale,
    artifact: "plan-amendment-ballot",
    sequence: input.sequence,
    request: input.request,
    selectedPlans: sortCitations(input.selectedPlans),
    disposition: input.disposition
  });

export const buildCanonicalConsensusBallot = (input: {
  issue: number;
  issueSessionId: string;
  agent: string;
  actionId: string;
  responseSha256: string;
  rationale: string;
  disposition: "approve" | "revise" | "escalate";
  inputSetHash: string;
  round: number;
  revisionCommitSha: string;
}): ConsensusBallotArtifact =>
  consensusBallotArtifactSchema.parse({
    protocolVersion: 2,
    issue: input.issue,
    issueSessionId: input.issueSessionId,
    agent: input.agent,
    inputSetHash: input.inputSetHash,
    actionId: input.actionId,
    responseSha256: input.responseSha256,
    rationale: input.rationale,
    artifact: "consensus-ballot",
    round: input.round,
    revisionCommitSha: input.revisionCommitSha,
    disposition: input.disposition
  });

/** Build the path → canonical-bytes map for one completed active-roster batch. */
export const buildBallotBatchFileMap = (input: {
  kind: BallotBatchKind;
  issue: number;
  issueSessionId: string;
  round: number | null;
  activeRoster: readonly string[];
  boundInputs: readonly BoundInput[];
  responses: readonly BallotAcceptedSemantics[];
  inputSetHash: string;
}): readonly BallotBatchFileEntry[] => {
  const ordered = input.activeRoster.map((agent) => {
    const response = input.responses.find((candidate) => candidate.agent === agent);
    if (response === undefined) {
      throw new Error(`Missing accepted response for active agent ${agent}.`);
    }
    return response;
  });
  if (ordered.length !== input.activeRoster.length) {
    throw new Error("Cannot build a ballot batch file map without one response per active agent.");
  }

  return ordered.map((response) => {
    const path = canonicalBallotPath(input.kind, input.issue, response.agent, input.round);
    let artifact:
      | PlanBallotArtifact
      | ComparisonBallotArtifact
      | ConsensusBallotArtifact
      | PlanAmendmentBallotArtifact;
    if (input.kind === "plan-ballot-batch") {
      if (response.choice === undefined) {
        throw new Error(`Plan ballot for ${response.agent} is missing choice.`);
      }
      artifact = buildCanonicalPlanBallot({
        issue: input.issue,
        issueSessionId: input.issueSessionId,
        agent: response.agent,
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        rationale: response.rationale,
        choice: response.choice,
        inputSetHash: input.inputSetHash,
        plans: citationsFromBoundInputs(input.boundInputs, "plan"),
        reviews: citationsFromBoundInputs(input.boundInputs, "review")
      });
    } else if (input.kind === "comparison-ballot-batch") {
      if (response.choice === undefined) {
        throw new Error(`Comparison ballot for ${response.agent} is missing choice.`);
      }
      artifact = buildCanonicalComparisonBallot({
        issue: input.issue,
        issueSessionId: input.issueSessionId,
        agent: response.agent,
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        rationale: response.rationale,
        choice: response.choice,
        inputSetHash: input.inputSetHash,
        implementations: citationsFromBoundInputs(input.boundInputs, "implementation")
      });
    } else if (input.kind === "amendment-ballot-batch") {
      if (response.disposition === undefined || response.disposition === "escalate") {
        throw new Error(`Amendment ballot for ${response.agent} is missing approve/revise disposition.`);
      }
      const request = input.boundInputs.find((bound) => bound.kind === "amendment-request");
      if (request === undefined) {
        throw new Error("An amendment ballot batch requires a bound amendment request.");
      }
      artifact = buildCanonicalAmendmentBallot({
        issue: input.issue,
        issueSessionId: input.issueSessionId,
        agent: response.agent,
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        rationale: response.rationale,
        disposition: response.disposition,
        inputSetHash: input.inputSetHash,
        sequence: input.round ?? 1,
        request: { agent: request.agent, commitSha: request.commitSha, path: request.path },
        selectedPlans: citationsFromBoundInputs(input.boundInputs, "selected-plan")
      });
    } else {
      if (response.disposition === undefined) {
        throw new Error(`Consensus ballot for ${response.agent} is missing disposition.`);
      }
      const revision = input.boundInputs.find((bound) => bound.kind === "revision");
      if (revision === undefined) {
        throw new Error("A consensus ballot batch requires a bound revision pin.");
      }
      artifact = buildCanonicalConsensusBallot({
        issue: input.issue,
        issueSessionId: input.issueSessionId,
        agent: response.agent,
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        rationale: response.rationale,
        disposition: response.disposition,
        inputSetHash: input.inputSetHash,
        round: input.round ?? 1,
        revisionCommitSha: revision.commitSha
      });
    }
    return { path, content: serializeCanonicalJson(artifact) };
  });
};

/**
 * Freeze one closed-gate batch: shared input-set hash, canonical files, commit message.
 * Responses are ordered by the active roster so timing cannot change bytes or digests.
 */
export const prepareBallotBatch = (input: {
  kind: BallotBatchKind;
  issue: number;
  issueSessionId: string;
  round: number | null;
  activeRoster: readonly string[];
  boundInputs: readonly BoundInput[];
  responses: readonly BallotAcceptedSemantics[];
}): PreparedBallotBatch => {
  const ordered = input.activeRoster.map((agent) => {
    const response = input.responses.find((candidate) => candidate.agent === agent);
    if (response === undefined) {
      throw new Error(`Cannot freeze a ballot batch before ${agent} has an accepted response.`);
    }
    return response;
  });
  if (ordered.length !== input.activeRoster.length) {
    throw new Error("Cannot freeze a ballot batch before every active agent has an accepted response.");
  }
  const inputSetHash = computeBallotBatchInputSetHash({
    kind: input.kind,
    round: input.round,
    activeRoster: input.activeRoster,
    boundInputs: input.boundInputs,
    responses: ordered
  });
  const files = buildBallotBatchFileMap({
    ...input,
    responses: ordered,
    inputSetHash
  });
  return {
    kind: input.kind,
    round: input.round,
    activeRoster: [...input.activeRoster],
    inputSetHash,
    responseSha256s: ordered.map((response) => response.responseSha256),
    paths: files.map((file) => file.path),
    files,
    message: evidenceCommitMessage(input.kind, input.issue, input.round)
  };
};

/** Parent for the next evidence commit: last published tip, else the issue baseline. */
export const resolveEvidenceParentSha = (input: {
  baselineSha: string;
  batches: readonly Pick<BallotBatchRecord, "status" | "commitSha">[];
}): string => {
  for (let index = input.batches.length - 1; index >= 0; index -= 1) {
    const batch = input.batches[index];
    if (batch !== undefined && batch.status === "published") return batch.commitSha;
  }
  return input.baselineSha;
};

/**
 * Exact-commit publication reconciliation: retry the frozen SHA, succeed if
 * origin already has it, push when tip equals the expected parent, else conflict.
 */
export const reconcileEvidencePublication = (input: {
  commitSha: string;
  parentSha: string;
  remoteTip: string | null;
}): EvidencePublicationReconcile => {
  gitShaSchema.parse(input.commitSha);
  gitShaSchema.parse(input.parentSha);
  if (input.remoteTip === input.commitSha) return { outcome: "already-published" };
  if (input.remoteTip === null || input.remoteTip === input.parentSha) return { outcome: "push" };
  return { outcome: "conflict", remoteTip: input.remoteTip };
};

/**
 * Create one coordinator-authored evidence commit in a temporary worktree.
 *
 * Parent is `parentSha` (baseline for the first commit, else last published tip).
 * Uses `materializeWorktree` + ordinary worktree git; never hash-object stdin.
 */
export const createEvidenceCommit = async (input: {
  mirror: EvidenceCommitMirror;
  worktreePath: string;
  parentSha: string;
  files: readonly BallotBatchFileEntry[];
  /** Optional stale ballot paths to delete when a superseding batch rebuilds the tree. */
  removePaths?: readonly string[];
  message: string;
  author?: { name: string; email: string };
}): Promise<string> => {
  gitShaSchema.parse(input.parentSha);
  if (input.files.length === 0 && (input.removePaths?.length ?? 0) === 0) {
    throw new Error("Evidence commit requires at least one file write or removal.");
  }
  const author = input.author ?? COORDINATOR_EVIDENCE_AUTHOR;
  await input.mirror.materializeWorktree(input.worktreePath, input.parentSha);
  try {
    for (const file of input.files) {
      repositoryPathSchema.parse(file.path);
      const absolute = join(input.worktreePath, file.path);
      mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
      writeFileSync(absolute, file.content, "utf8");
    }
    for (const path of input.removePaths ?? []) {
      repositoryPathSchema.parse(path);
      const absolute = join(input.worktreePath, path);
      if (existsSync(absolute)) unlinkSync(absolute);
    }

    const stagedPaths = [...input.files.map((file) => file.path), ...(input.removePaths ?? [])];
    const added = await runGitCommand(["add", "-A", "--", ...stagedPaths], { cwd: input.worktreePath });
    if (added.exitCode !== 0) {
      throw new GitCommandError(
        `git add failed for evidence commit: ${added.stderr}`,
        added,
        isTransientGitFailure(added.stderr)
      );
    }

    const committed = await runGitCommand(
      [
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "-m",
        input.message
      ],
      {
        cwd: input.worktreePath,
        env: {
          GIT_AUTHOR_NAME: author.name,
          GIT_AUTHOR_EMAIL: author.email,
          GIT_COMMITTER_NAME: author.name,
          GIT_COMMITTER_EMAIL: author.email
        }
      }
    );
    if (committed.exitCode !== 0) {
      throw new GitCommandError(
        `git commit failed for evidence commit: ${committed.stderr}`,
        committed,
        isTransientGitFailure(committed.stderr)
      );
    }

    const head = await runGitCommand(["rev-parse", "HEAD"], { cwd: input.worktreePath });
    if (head.exitCode !== 0) {
      throw new GitCommandError(
        `git rev-parse failed after evidence commit: ${head.stderr}`,
        head,
        false
      );
    }
    const sha = head.stdout.toString("utf8").trim();
    return gitShaSchema.parse(sha);
  } finally {
    await input.mirror.removeWorktree(input.worktreePath);
  }
};
