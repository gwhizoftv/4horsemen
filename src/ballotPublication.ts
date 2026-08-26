import { sha256 } from "./hash.js";
import {
  comparisonBallotArtifactSchema,
  consensusBallotArtifactSchema,
  planBallotArtifactSchema
} from "./protocol.js";
import type { AcceptedResponse, BallotBatchKind, StartState } from "./state.js";
import {
  RESERVED_EVIDENCE_AGENT,
  STEP_DEFINITIONS,
  evidenceBranchFor,
  type BallotStepId,
  type BoundInput
} from "./steps.js";

/** Author and committer on every evidence commit. Never a voting agent. */
export const COORDINATOR_IDENTITY = {
  name: "coord coordination driver",
  email: "coord@coordination.invalid"
} as const;

export const BALLOT_BATCH_KINDS: Readonly<Record<BallotStepId, BallotBatchKind>> = {
  "R3.plan-ballot": "plan-ballot-batch",
  "R5.compare-ballot": "comparison-ballot-batch",
  "R6.ballot": "consensus-ballot-batch"
};

/**
 * Canonical JSON: explicit key order, two-space indent, trailing newline.
 *
 * `JSON.stringify` preserves insertion order, so the field order below *is* the
 * serialization contract. It is written out per artifact rather than derived
 * from the schema because the bytes end up in a Git tree: a reordering that
 * changed nothing semantically would still change every blob hash, and the
 * whole point of persisting one exact commit SHA is that the same inputs
 * reproduce the same tree.
 */
const canonicalJson = (value: Record<string, unknown>): string => `${JSON.stringify(value, null, 2)}\n`;

export const evidenceCommitMessage = (kind: BallotBatchKind, issue: number, round: number | null): string => {
  const subject =
    kind === "plan-ballot-batch" ? "plan" : kind === "comparison-ballot-batch" ? "comparison" : "consensus";
  const suffix = kind === "consensus-ballot-batch" ? ` round ${round ?? 1}` : "";
  return `Coordinator: publish issue ${issue} ${subject} ballot batch${suffix}`;
};

const lengthPrefixed = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`;

/**
 * Identity of one batch: what was voted on, by whom, and with which judgments.
 *
 * The ordered roster is inside the hash, so a roster change produces a
 * different batch identity rather than silently reusing the old one; every
 * component is length-prefixed so no delimiter can be forged from a value.
 */
export const computeBatchInputSetHash = (input: {
  kind: BallotBatchKind;
  round: number | null;
  activeRoster: readonly string[];
  inputs: readonly BoundInput[];
  responses: readonly AcceptedResponse[];
}): string => {
  const citations = [...input.inputs]
    .map((bound) => [bound.kind, bound.agent, bound.commitSha, bound.path].map(lengthPrefixed).join(""))
    .sort();
  const tuples = [...input.responses]
    .map((response) => [response.agent, response.actionId, response.responseSha256].map(lengthPrefixed).join(""))
    .sort();
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

const citationsOf = (inputs: readonly BoundInput[], kind: string) =>
  inputs
    .filter((input) => input.kind === kind)
    .map((input) => ({ agent: input.agent, commitSha: input.commitSha, path: input.path }))
    .sort((left, right) => left.agent.localeCompare(right.agent));

/**
 * Build one canonical ballot from trusted state plus an accepted judgment.
 *
 * Every field except `choice`/`disposition` and `rationale` comes from the
 * coordinator: the citations are built from the bound Git inputs it resolved
 * itself, never copied from the private response, which carries no citation
 * fields at all.
 */
export const canonicalBallotBytes = (input: {
  stepId: BallotStepId;
  start: StartState;
  response: AcceptedResponse;
  inputs: readonly BoundInput[];
  inputSetHash: string;
  round: number | null;
}): string => {
  const { start, response } = input;
  const common = {
    protocolVersion: 2 as const,
    issue: start.issue,
    issueSessionId: start.issueSessionId,
    agent: response.agent,
    actionId: response.actionId,
    responseSha256: response.responseSha256
  };

  if (input.stepId === "R3.plan-ballot") {
    const value = {
      ...common,
      artifact: "plan-ballot" as const,
      inputSetHash: input.inputSetHash,
      plans: citationsOf(input.inputs, "plan"),
      reviews: citationsOf(input.inputs, "review"),
      choice: response.choice as string,
      rationale: response.rationale
    };
    return canonicalJson(planBallotArtifactSchema.parse(value));
  }
  if (input.stepId === "R5.compare-ballot") {
    const value = {
      ...common,
      artifact: "comparison-ballot" as const,
      inputSetHash: input.inputSetHash,
      implementations: citationsOf(input.inputs, "implementation"),
      choice: response.choice as string,
      rationale: response.rationale
    };
    return canonicalJson(comparisonBallotArtifactSchema.parse(value));
  }
  const revision = input.inputs.find((bound) => bound.kind === "revision");
  if (revision === undefined) throw new Error("A consensus ballot batch requires a bound revision pin.");
  const value = {
    ...common,
    artifact: "consensus-ballot" as const,
    inputSetHash: input.inputSetHash,
    round: input.round ?? 1,
    revisionCommitSha: revision.commitSha,
    disposition: response.disposition as "approve" | "revise" | "escalate",
    rationale: response.rationale
  };
  return canonicalJson(consensusBallotArtifactSchema.parse(value));
};

export type BallotBatchPlan = {
  kind: BallotBatchKind;
  stepId: BallotStepId;
  round: number | null;
  activeRoster: readonly string[];
  inputSetHash: string;
  responseSha256s: readonly string[];
  files: readonly { path: string; content: string }[];
  message: string;
};

/**
 * Freeze one batch from the accepted active responses at a closed gate.
 *
 * Responses are ordered by the active roster rather than by arrival, so the
 * file set and every hash over it are a function of state and not of timing.
 */
export const buildBallotBatch = (input: {
  stepId: BallotStepId;
  start: StartState;
  activeRoster: readonly string[];
  responses: readonly AcceptedResponse[];
  inputs: readonly BoundInput[];
  round: number | null;
}): BallotBatchPlan => {
  const ordered = input.activeRoster
    .map((agent) =>
      input.responses.find(
        (response) =>
          response.agent === agent && response.stepId === input.stepId && response.round === input.round
      )
    )
    .filter((response): response is AcceptedResponse => response !== undefined);
  if (ordered.length !== input.activeRoster.length) {
    throw new Error(`Cannot freeze a ballot batch before every active agent has an accepted response.`);
  }
  const kind = BALLOT_BATCH_KINDS[input.stepId];
  const inputSetHash = computeBatchInputSetHash({
    kind,
    round: input.round,
    activeRoster: input.activeRoster,
    inputs: input.inputs,
    responses: ordered
  });
  const definition = STEP_DEFINITIONS[input.stepId];
  const files = ordered.map((response) => ({
    path: definition.requiredPath(input.start.issue, response.agent, input.round),
    content: canonicalBallotBytes({
      stepId: input.stepId,
      start: input.start,
      response,
      inputs: input.inputs,
      inputSetHash,
      round: input.round
    })
  }));
  return {
    kind,
    stepId: input.stepId,
    round: input.round,
    activeRoster: [...input.activeRoster],
    inputSetHash,
    responseSha256s: ordered.map((response) => response.responseSha256),
    files,
    message: evidenceCommitMessage(kind, input.start.issue, input.round)
  };
};

/**
 * Derive the evidence branch and prove it cannot be an agent's or the PR's.
 *
 * Checked at derivation rather than once at start, so a template or roster that
 * changes underneath a running issue cannot quietly redirect a batch onto a
 * branch an agent pushes to.
 */
export const resolveEvidenceBranch = (input: {
  branchTemplate: string;
  issue: number;
  roster: readonly string[];
  baseBranch: string;
}): string => {
  if (input.roster.includes(RESERVED_EVIDENCE_AGENT)) {
    throw new Error(
      `${RESERVED_EVIDENCE_AGENT} is reserved for the coordinator evidence branch and cannot be an agent id.`
    );
  }
  const branch = evidenceBranchFor(input.branchTemplate, input.issue);
  for (const agent of input.roster) {
    const agentBranch = input.branchTemplate
      .replaceAll("{issue}", String(input.issue))
      .replaceAll("{agent}", agent);
    if (branch === agentBranch || branch === `${agentBranch}-final`) {
      throw new Error(`The evidence branch ${branch} collides with an agent branch.`);
    }
  }
  if (branch === input.baseBranch) {
    throw new Error(`The evidence branch ${branch} collides with the base branch.`);
  }
  return branch;
};
