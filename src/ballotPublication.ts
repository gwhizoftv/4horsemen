import { sha256 } from "./hash.js";
import {
  comparisonBallotArtifactSchema,
  consensusBallotArtifactSchema,
  planBallotArtifactSchema
} from "./protocol.js";
import type { AcceptedResponse, StartState } from "./state.js";
import type { BoundInput, WorkflowStepId } from "./steps.js";

export const RESERVED_EVIDENCE_AGENT = "coordinator-evidence";
export const COORDINATOR_GIT_IDENTITY = {
  name: "Coordination Driver",
  email: "coordination@localhost"
} as const;

const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

const renderedBranch = (template: string, issue: number, agent: string): string =>
  template.replaceAll("{issue}", String(issue)).replaceAll("{agent}", agent);

export const evidenceBranchFor = (start: Pick<StartState, "branchTemplate" | "issue" | "baseBranch" | "agents">): string => {
  if (start.agents.some((agent) => agent.id === RESERVED_EVIDENCE_AGENT)) {
    throw new Error(`${RESERVED_EVIDENCE_AGENT} is reserved for coordinator evidence publication.`);
  }
  const branch = renderedBranch(start.branchTemplate, start.issue, RESERVED_EVIDENCE_AGENT);
  const collisions = new Set<string>([start.baseBranch]);
  for (const agent of start.agents) {
    const agentBranch = renderedBranch(start.branchTemplate, start.issue, agent.id);
    collisions.add(agentBranch);
    collisions.add(`${agentBranch}-final`);
  }
  if (!branchPattern.test(branch) || branch.startsWith("-") || branch.includes("..") || collisions.has(branch)) {
    throw new Error(`Invalid or colliding coordinator evidence branch ${branch}.`);
  }
  return branch;
};

export type BallotStepId = "R3.plan-ballot" | "R5.compare-ballot" | "R6.ballot";

export const isBallotStep = (stepId: WorkflowStepId): stepId is BallotStepId =>
  stepId === "R3.plan-ballot" || stepId === "R5.compare-ballot" || stepId === "R6.ballot";

export const ballotKindFor = (
  stepId: BallotStepId
): "plan-ballot-batch" | "comparison-ballot-batch" | "consensus-ballot-batch" =>
  stepId === "R3.plan-ballot"
    ? "plan-ballot-batch"
    : stepId === "R5.compare-ballot"
      ? "comparison-ballot-batch"
      : "consensus-ballot-batch";

export const canonicalBallotPath = (
  stepId: BallotStepId,
  issue: number,
  agent: string,
  round: number | null
): string => {
  if (stepId === "R3.plan-ballot") return `.plans/issue-${issue}/ballot-${agent}.json`;
  if (stepId === "R5.compare-ballot") return `.code-reviews/issue-${issue}/ballot-${agent}.json`;
  return `.code-reviews/issue-${issue}/consensus-ballot-${agent}-round-${round ?? 1}.json`;
};

const lengthPrefixed = (value: string): string => `${Buffer.byteLength(value, "utf8")}:${value}`;

const citation = (input: BoundInput): { agent: string; commitSha: string; path: string } => ({
  agent: input.agent,
  commitSha: input.commitSha,
  path: input.path
});

const orderedInputs = (inputs: readonly BoundInput[]): BoundInput[] =>
  [...inputs].sort((left, right) =>
    `${left.kind}\0${left.agent}\0${left.commitSha}\0${left.path}`.localeCompare(
      `${right.kind}\0${right.agent}\0${right.commitSha}\0${right.path}`
    )
  );

export const batchInputSetHash = (input: {
  stepId: BallotStepId;
  round: number | null;
  activeRoster: readonly string[];
  responses: readonly AcceptedResponse[];
  inputs: readonly BoundInput[];
}): string => {
  const byAgent = new Map(input.responses.map((response) => [response.agent, response]));
  const fields = [
    "coordinator-ballot-batch-v1",
    input.stepId,
    input.round === null ? "" : String(input.round),
    String(input.activeRoster.length),
    ...input.activeRoster,
    ...input.activeRoster.flatMap((agent) => {
      const response = byAgent.get(agent);
      if (response === undefined) throw new Error(`Missing accepted response for ${agent}.`);
      return [response.agent, response.actionId, response.responseSha256];
    }),
    ...orderedInputs(input.inputs).flatMap((bound) => [bound.kind, bound.agent, bound.commitSha, bound.path])
  ];
  return sha256(fields.map(lengthPrefixed).join(""));
};

export type BuiltBallotBatch = {
  kind: ReturnType<typeof ballotKindFor>;
  round: number | null;
  inputSetHash: string;
  activeRoster: string[];
  responseSha256s: string[];
  files: ReadonlyMap<string, string>;
  message: string;
};

export const buildBallotBatch = (input: {
  start: StartState;
  stepId: BallotStepId;
  round: number | null;
  activeRoster: readonly string[];
  responses: readonly AcceptedResponse[];
  inputs: readonly BoundInput[];
}): BuiltBallotBatch => {
  const responses = input.activeRoster.map((agent) => {
    const response = input.responses.find(
      (candidate) => candidate.agent === agent && candidate.supersededAt === undefined
    );
    if (response === undefined) throw new Error(`Missing active response for ${agent}.`);
    return response;
  });
  const inputSetHash = batchInputSetHash({ ...input, responses });
  const files = new Map<string, string>();
  const inputs = orderedInputs(input.inputs);
  for (const response of responses) {
    const common = {
      protocolVersion: 2 as const,
      issue: input.start.issue,
      issueSessionId: input.start.issueSessionId,
      agent: response.agent
    };
    let value: Record<string, unknown>;
    if (input.stepId === "R3.plan-ballot") {
      value = planBallotArtifactSchema.parse({
        ...common,
        artifact: "plan-ballot",
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        inputSetHash,
        plans: inputs.filter((bound) => bound.kind === "plan").map(citation),
        reviews: inputs.filter((bound) => bound.kind === "review").map(citation),
        choice: response.choice,
        rationale: response.rationale
      });
    } else if (input.stepId === "R5.compare-ballot") {
      value = comparisonBallotArtifactSchema.parse({
        ...common,
        artifact: "comparison-ballot",
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        inputSetHash,
        implementations: inputs.map(citation),
        choice: response.choice,
        rationale: response.rationale
      });
    } else {
      const revision = inputs[0];
      if (revision === undefined) throw new Error("Consensus batch has no bound revision pin.");
      value = consensusBallotArtifactSchema.parse({
        ...common,
        artifact: "consensus-ballot",
        actionId: response.actionId,
        responseSha256: response.responseSha256,
        inputSetHash,
        round: input.round ?? 1,
        revisionCommitSha: revision.commitSha,
        disposition: response.disposition,
        rationale: response.rationale
      });
    }
    files.set(
      canonicalBallotPath(input.stepId, input.start.issue, response.agent, input.round),
      `${JSON.stringify(value, null, 2)}\n`
    );
  }
  const label =
    input.stepId === "R3.plan-ballot"
      ? "plan ballot batch"
      : input.stepId === "R5.compare-ballot"
        ? "comparison ballot batch"
        : `consensus ballots round ${input.round ?? 1}`;
  return {
    kind: ballotKindFor(input.stepId),
    round: input.round,
    inputSetHash,
    activeRoster: [...input.activeRoster],
    responseSha256s: responses.map((response) => response.responseSha256),
    files,
    message: `Coordinator: publish issue ${input.start.issue} ${label}`
  };
};
