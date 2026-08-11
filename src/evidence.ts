import { sha256 } from "./hash.js";
import type { FetchResult } from "./mirror.js";
import {
  comparisonBallotArtifactSchema,
  consensusBallotArtifactSchema,
  consensusDeclarationArtifactSchema,
  finalizationArtifactSchema,
  implementationReadyArtifactSchema,
  joinArtifactSchema,
  parseJsonWithSchema,
  planBallotArtifactSchema,
  reviserAuthorizationArtifactSchema,
  revisionReadyArtifactSchema,
  selectionArtifactSchema,
  validateCommonArtifactFields
} from "./protocol.js";
import type { BoundInput, EvidenceObservation, InternalOrder } from "./steps.js";

export type EvidenceMirror = {
  fetchBranch(branch: string): Promise<FetchResult>;
  isReachable(sha: string, ref: string): Promise<boolean>;
  isAncestor(base: string, tip: string): Promise<boolean>;
  readBlob(sha: string, path: string): Promise<string | null>;
  changedPaths(base: string, tip: string): Promise<string[]>;
};

const canonicalInputs = (inputs: readonly BoundInput[]): string =>
  [...inputs]
    .sort((left, right) =>
      `${left.kind}\0${left.agent}\0${left.commitSha}\0${left.path}`.localeCompare(
        `${right.kind}\0${right.agent}\0${right.commitSha}\0${right.path}`
      )
    )
    .map((input) => `${input.kind}\0${input.agent}\0${input.commitSha}\0${input.path}`)
    .join("\n");

export const computeInputSetHash = (inputs: readonly BoundInput[]): string => sha256(canonicalInputs(inputs));

const citationsEqualInputs = (
  citations: readonly { agent: string; commitSha: string; path: string }[],
  inputs: readonly BoundInput[]
): boolean => {
  const normalize = (values: readonly { agent: string; commitSha: string; path: string }[]): string[] =>
    values.map((value) => `${value.agent}\0${value.commitSha}\0${value.path}`).sort();
  const expected = inputs.map(({ agent, commitSha, path }) => ({ agent, commitSha, path }));
  return JSON.stringify(normalize(citations)) === JSON.stringify(normalize(expected));
};

const markdownSection = (raw: string, alternatives: readonly string[]): boolean =>
  alternatives.some((heading) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "im").test(raw));

const checkPlan = (raw: string): string[] => {
  const required: readonly (readonly string[])[] = [
    ["(?:Exact )?File (?:Map|Creation Order)", "Proposed Architecture"],
    ["Tests?", "Validation"],
    ["Alternatives?(?: Rejected)?"],
    ["Risks?(?: and Mitigations)?"],
    ["Conclusion"]
  ];
  return required
    .filter((headings) => !markdownSection(raw, headings))
    .map((headings) => `plan is missing a non-empty ${headings[0]} section`);
};

const extractApprovedPaths = (raw: string): string[] => {
  const paths = new Set<string>();
  for (const match of raw.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1];
    if (
      candidate !== undefined &&
      !candidate.includes(" ") &&
      !candidate.startsWith("/") &&
      !candidate.startsWith(".plans/") &&
      !candidate.startsWith(".signals/") &&
      !candidate.startsWith(".code-reviews/") &&
      !candidate.split("/").includes("..") &&
      /^(?:src|test|docs|scripts|githooks)\/|^[A-Za-z0-9_.-]+$/.test(candidate)
    ) {
      paths.add(candidate);
    }
  }
  return [...paths].sort();
};

const checkReview = (raw: string): string[] => {
  const missing: string[] = [];
  if (!markdownSection(raw, ["Findings", "Review Findings"])) missing.push("review is missing a Findings section");
  if (!markdownSection(raw, ["Verdict", "Conclusion"])) missing.push("review is missing a Verdict section");
  return missing;
};

const matchesApprovedPath = (path: string, approved: readonly string[]): boolean =>
  approved.some((pattern) => {
    if (pattern.endsWith("/**")) return path.startsWith(pattern.slice(0, -3));
    if (pattern.endsWith("/")) return path.startsWith(pattern);
    return path === pattern;
  });

const isCurrentIssueCoordinationPath = (path: string, issue: number): boolean =>
  [`.plans/issue-${issue}/`, `.signals/issue-${issue}/`, `.code-reviews/issue-${issue}/`].some((prefix) =>
    path.startsWith(prefix)
  );

const rejected = (order: InternalOrder, sha: string, outstanding: readonly string[]): EvidenceObservation => ({
  agent: order.agent,
  actionId: order.actionId,
  submissionSha: sha,
  status: "rejected",
  outstanding
});

const satisfied = (
  order: InternalOrder,
  sha: string,
  extra: Pick<EvidenceObservation, "productPin" | "disposition"> = {}
): EvidenceObservation => ({
  agent: order.agent,
  actionId: order.actionId,
  submissionSha: sha,
  status: "satisfied",
  outstanding: [],
  ...extra
});

const commonErrors = (
  artifact: { issue: number; issueSessionId: string; agent: string },
  order: InternalOrder
): string[] => validateCommonArtifactFields(artifact, order);

const inputHashErrors = (actual: string, order: InternalOrder): string[] =>
  actual === computeInputSetHash(order.inputs) ? [] : ["artifact inputSetHash does not match the bound action inputs"];

const pinErrors = async (
  pin: string,
  submissionSha: string,
  ref: string,
  order: InternalOrder,
  mirror: EvidenceMirror
): Promise<string[]> => {
  const outstanding: string[] = [];
  if (pin === submissionSha) outstanding.push("product pin must differ from the coordination signal commit");
  if (!(await mirror.isReachable(pin, ref))) outstanding.push(`pinned commit ${pin} is not reachable from ${order.branch}`);
  if (!(await mirror.isAncestor(order.baselineSha, pin))) outstanding.push("pinned commit does not descend from the issue baseline");
  if (!(await mirror.isAncestor(pin, submissionSha))) outstanding.push("coordination signal commit does not descend from its product pin");
  return outstanding;
};

export const evaluateEvidence = async (
  order: InternalOrder,
  submissionSha: string,
  mirror: EvidenceMirror
): Promise<EvidenceObservation> => {
  const fetched = await mirror.fetchBranch(order.branch);
  if (!fetched.ok) {
    if (!fetched.transient) {
      return rejected(order, submissionSha, [`expected origin branch ${order.branch} could not be fetched: ${fetched.error}`]);
    }
    return {
      agent: order.agent,
      actionId: order.actionId,
      submissionSha,
      status: "retry",
      outstanding: [`origin fetch failed${fetched.error === "" ? "" : `: ${fetched.error}`}`]
    };
  }
  if (!(await mirror.isReachable(submissionSha, fetched.ref))) {
    return rejected(order, submissionSha, [`submission ${submissionSha} is not reachable from origin/${order.branch}`]);
  }
  const blob = await mirror.readBlob(submissionSha, order.requiredPath);
  if (blob === null) return rejected(order, submissionSha, [`required artifact ${order.requiredPath} is missing`]);

  if (order.evidenceId === "plan-published") {
    const errors = checkPlan(blob);
    const approvedPaths = extractApprovedPaths(blob);
    if (approvedPaths.length === 0) errors.push("plan file map does not name any repository paths in backticks");
    return errors.length === 0
      ? { ...satisfied(order, submissionSha), approvedPaths }
      : rejected(order, submissionSha, errors);
  }
  if (order.evidenceId === "review-published") {
    const errors = checkReview(blob);
    for (const input of order.inputs) {
      if (!blob.includes(input.commitSha)) errors.push(`review does not cite bound ${input.kind} commit ${input.commitSha}`);
    }
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }
  if (order.evidenceId === "comparison-published") {
    const errors: string[] = [];
    if (!markdownSection(blob, ["Comparison", "Findings"])) errors.push("comparison is missing a Comparison or Findings section");
    for (const input of order.inputs) {
      if (!blob.includes(input.commitSha)) errors.push(`comparison does not cite implementation pin ${input.commitSha}`);
    }
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "join-published") {
    const parsed = parseJsonWithSchema(blob, joinArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid join artifact: ${parsed.error}`]);
    const errors = commonErrors(parsed.value, order);
    if (parsed.value.baselineSha !== order.baselineSha) errors.push("join baselineSha does not match the issue baseline");
    if (parsed.value.automationDigest !== order.automationDigest) errors.push("join automationDigest does not match");
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "plan-ballot-published") {
    const parsed = parseJsonWithSchema(blob, planBallotArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid plan ballot: ${parsed.error}`]);
    const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
    if (!citationsEqualInputs([...parsed.value.plans, ...parsed.value.reviews], order.inputs)) {
      errors.push("plan ballot citations do not equal the bound plan/review set");
    }
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "selection-published") {
    const parsed = parseJsonWithSchema(blob, selectionArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid selection artifact: ${parsed.error}`]);
    const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
    if (!citationsEqualInputs(parsed.value.ballots, order.inputs)) errors.push("selection ballot citations do not equal bound inputs");
    return errors.length === 0
      ? { ...satisfied(order, submissionSha), selectedAgents: parsed.value.selectedAgents }
      : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "implementation-pinned") {
    const parsed = parseJsonWithSchema(blob, implementationReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid implementation-ready artifact: ${parsed.error}`]);
    const errors = [
      ...commonErrors(parsed.value, order),
      ...inputHashErrors(parsed.value.inputSetHash, order),
      ...(await pinErrors(parsed.value.implementationCommitSha, submissionSha, fetched.ref, order, mirror))
    ];
    const approved = order.approvedPaths.length === 0 ? parsed.value.approvedPaths : order.approvedPaths;
    if (JSON.stringify([...parsed.value.approvedPaths].sort()) !== JSON.stringify([...approved].sort())) {
      errors.push("implementation approvedPaths do not match the selected plan file map");
    }
    if (errors.length === 0) {
      const changed = await mirror.changedPaths(order.baselineSha, parsed.value.implementationCommitSha);
      const disallowed = changed.filter(
        (path) => !isCurrentIssueCoordinationPath(path, order.issue) && !matchesApprovedPath(path, approved)
      );
      if (disallowed.length > 0) errors.push(`implementation changes paths outside the approved file map: ${disallowed.join(", ")}`);
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { productPin: parsed.value.implementationCommitSha })
      : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "comparison-ballot-published") {
    const parsed = parseJsonWithSchema(blob, comparisonBallotArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid comparison ballot: ${parsed.error}`]);
    const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
    if (!citationsEqualInputs(parsed.value.implementations, order.inputs)) errors.push("comparison ballot pins do not equal bound inputs");
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "reviser-authorized") {
    const parsed = parseJsonWithSchema(blob, reviserAuthorizationArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid reviser authorization: ${parsed.error}`]);
    const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
    if (!order.inputs.some((input) => input.commitSha === parsed.value.implementationCommitSha)) {
      errors.push("authorized implementation pin is not one of the bound inputs");
    }
    return errors.length === 0 ? satisfied(order, submissionSha, { productPin: parsed.value.implementationCommitSha }) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "revision-pinned") {
    const parsed = parseJsonWithSchema(blob, revisionReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid revision-ready artifact: ${parsed.error}`]);
    const errors = [
      ...commonErrors(parsed.value, order),
      ...inputHashErrors(parsed.value.inputSetHash, order),
      ...(await pinErrors(parsed.value.revisedBranchHead, submissionSha, fetched.ref, order, mirror))
    ];
    if (parsed.value.round !== order.round) errors.push(`revision round must be ${order.round ?? 1}`);
    const expectedPins = order.inputs.map((input) => input.commitSha).sort();
    if (JSON.stringify([...parsed.value.basedOn].sort()) !== JSON.stringify(expectedPins)) errors.push("revision basedOn pins do not equal bound inputs");
    return errors.length === 0
      ? satisfied(order, submissionSha, { productPin: parsed.value.revisedBranchHead })
      : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "consensus-ballot-published") {
    const parsed = parseJsonWithSchema(blob, consensusBallotArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid consensus ballot: ${parsed.error}`]);
    const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
    if (parsed.value.round !== order.round) errors.push(`consensus ballot round must be ${order.round ?? 1}`);
    if (!order.inputs.some((input) => input.commitSha === parsed.value.revisionCommitSha)) {
      errors.push("consensus ballot does not cite the bound revision pin");
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { disposition: parsed.value.disposition })
      : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "consensus-declared") {
    const parsed = parseJsonWithSchema(blob, consensusDeclarationArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid consensus declaration: ${parsed.error}`]);
    const errors = [...commonErrors(parsed.value, order), ...inputHashErrors(parsed.value.inputSetHash, order)];
    if (parsed.value.round !== order.round) errors.push(`consensus declaration round must be ${order.round ?? 1}`);
    const ballotInputs = order.inputs.filter((input) => input.kind === "consensus-ballot");
    if (!citationsEqualInputs(parsed.value.ballots, ballotInputs)) errors.push("consensus declaration ballots do not equal bound inputs");
    if (!order.inputs.some((input) => input.kind === "revision" && input.commitSha === parsed.value.consensusCommitSha)) {
      errors.push("consensus declaration does not pin the bound revision commit");
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { productPin: parsed.value.consensusCommitSha })
      : rejected(order, submissionSha, errors);
  }

  const parsed = parseJsonWithSchema(blob, finalizationArtifactSchema);
  if (!parsed.ok) return rejected(order, submissionSha, [`invalid finalization artifact: ${parsed.error}`]);
  const errors = commonErrors(parsed.value, order);
  if (parsed.value.finalSha === submissionSha) errors.push("final cleanup pin must differ from the coordination signal commit");
  if (!(await mirror.isReachable(parsed.value.finalSha, fetched.ref))) errors.push("final cleanup pin is not reachable from the expected origin branch");
  if (!(await mirror.isAncestor(parsed.value.finalSha, submissionSha))) errors.push("finalization signal does not descend from its final cleanup pin");
  if (!order.inputs.some((input) => input.commitSha === parsed.value.consensusSha)) errors.push("finalization consensusSha is not the bound consensus pin");
  if (parsed.value.checks.some((check) => check.exitCode !== 0)) errors.push("finalization artifact contains a failed check");
  return errors.length === 0 ? satisfied(order, submissionSha, { productPin: parsed.value.finalSha }) : rejected(order, submissionSha, errors);
};

export const isSatisfied = evaluateEvidence;
