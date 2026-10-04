import { agentFacingSubject } from "./agentLanguage.js";
import { sha256 } from "./hash.js";
import type { FetchResult } from "./mirror.js";
import {
  finalizationArtifactSchema,
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  parseJsonWithSchema,
  planAmendmentRequestArtifactSchema,
  revisionReadyArtifactSchema,
  validateCommonArtifactFields
} from "./protocol.js";
import type { BoundInput, EvidenceObservation, InternalOrder } from "./steps.js";
import type { PinValidationResult } from "./pinValidation.js";

export type EvidenceMirror = {
  fetchBranch(branch: string): Promise<FetchResult>;
  isReachable(sha: string, ref: string): Promise<boolean>;
  isAncestor(base: string, tip: string): Promise<boolean>;
  readBlob(sha: string, path: string): Promise<string | null>;
  changedPaths(base: string, tip: string): Promise<string[]>;
  validatePhasePin(params: {
    pin: string;
    tip: string;
    issue: number;
    subject: string;
    ref: string;
  }): Promise<PinValidationResult>;
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

const markdownSection = (raw: string, alternatives: readonly string[]): boolean =>
  alternatives.some((heading) => new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "im").test(raw));

const REUSE_SECTION_HEADINGS = ["Reuse and Scope", "Reuse", "Scope and Reuse"] as const;

const checkPlan = (raw: string): string[] => {
  // Legacy "Exact File Map" (and aliases) still satisfy both of the split list headings.
  const fileListAliases = [
    "(?:Exact )?File (?:Map|Creation Order)",
    "Proposed Architecture"
  ] as const;
  const required: readonly (readonly string[])[] = [
    ["Exact File List to be changed or deleted", ...fileListAliases],
    ["Exact file list to be created", ...fileListAliases],
    [...REUSE_SECTION_HEADINGS],
    ["Tests?", "Validation"],
    ["Alternatives?(?: Rejected)?"],
    ["Risks?(?: and Mitigations)?"],
    ["Conclusion"]
  ];
  return required
    .filter((headings) => !markdownSection(raw, headings))
    .map((headings) => `plan is missing a non-empty ${headings[0]} section`);
};

/** One path segment: letters, digits, and the punctuation git trees actually use. */
const FILE_MAP_SEGMENT = /^[A-Za-z0-9_.@+-]+$/;

/**
 * True when a backticked plan token is a repository-relative file-map path.
 *
 * Nested paths (`packages/…`, `apps/…`, `src/…`) and directory globs (`dir/`,
 * `dir/**`) are accepted regardless of the first directory name. A single
 * segment is kept only when it looks like a root file (`package.json`), so
 * identifiers (`VIDEO_DOMAINS`, `toDomain`) are not treated as paths.
 */
export const isFileMapPath = (candidate: string): boolean => {
  if (
    candidate.includes(" ") ||
    candidate.startsWith("/") ||
    candidate.split("/").includes("..") ||
    candidate.startsWith(".plans/") ||
    candidate.startsWith(".signals/") ||
    candidate.startsWith(".code-reviews/")
  ) {
    return false;
  }
  const glob = candidate.endsWith("/**");
  const directory = !glob && candidate.endsWith("/");
  const body = glob ? candidate.slice(0, -3) : directory ? candidate.slice(0, -1) : candidate;
  if (body === "" || body.startsWith("/") || body.endsWith("/") || body.includes("//")) return false;
  const segments = body.split("/");
  if (!segments.every((segment) => FILE_MAP_SEGMENT.test(segment))) return false;
  if (segments.length >= 2 || glob || directory) return true;
  return body.includes(".");
};

/**
 * Expand one bash-style brace group (`dir/{a,b}.sh` → `dir/a.sh`, `dir/b.sh`).
 * Nested or malformed braces are left unchanged so `isFileMapPath` can reject them.
 */
export const expandFileMapBraces = (candidate: string): string[] => {
  const matched = /^([^{}\n]*)\{([^{}\n]+)\}([^{}\n]*)$/.exec(candidate);
  if (matched === null) return [candidate];
  const prefix = matched[1] ?? "";
  const body = matched[2] ?? "";
  const suffix = matched[3] ?? "";
  const alternatives = body.split(",");
  if (alternatives.length < 2 || alternatives.some((part) => part === "")) return [candidate];
  return alternatives.map((part) => `${prefix}${part}${suffix}`);
};

/**
 * Remove named Markdown sections while retaining every other line. A section
 * ends at the next sibling-or-parent ATX heading. A depth-1 section also ends
 * at the next heading because accepted plan sections may use depth 2 beneath it.
 */
const stripSections = (raw: string, headings: readonly string[]): string => {
  const targets = new Set(headings.map((heading) => heading.toLowerCase()));
  const kept: string[] = [];
  let skippedDepth: number | null = null;
  for (const line of raw.split("\n")) {
    const matched = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
    const depth = matched?.[1]?.length;
    if (skippedDepth !== null) {
      if (depth === undefined || (skippedDepth > 1 && depth > skippedDepth)) continue;
      skippedDepth = null;
    }
    const title = matched?.[2]?.trim().toLowerCase();
    if (depth !== undefined && title !== undefined && targets.has(title)) {
      skippedDepth = depth;
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n");
};

export const extractApprovedPaths = (raw: string): string[] => {
  const paths = new Set<string>();
  for (const match of stripSections(raw, REUSE_SECTION_HEADINGS).matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1];
    if (candidate === undefined) continue;
    for (const expanded of expandFileMapBraces(candidate)) {
      if (isFileMapPath(expanded)) paths.add(expanded);
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

const approvedTreeRoot = (pattern: string): string => {
  if (pattern.endsWith("/**")) return pattern.slice(0, -3).replace(/\/+$/, "");
  if (pattern.endsWith("/")) return pattern.slice(0, -1);
  return pattern;
};

/** Git records a directory delete as a change to every file under it. A map entry names that tree. */
export const matchesApprovedPath = (path: string, approved: readonly string[]): boolean =>
  approved.some((pattern) => {
    const root = approvedTreeRoot(pattern);
    return root.length > 0 && (path === root || path.startsWith(`${root}/`));
  });

const isCurrentIssueCoordinationPath = (path: string, issue: number): boolean =>
  [`.plans/issue-${issue}/`, `.signals/issue-${issue}/`, `.code-reviews/issue-${issue}/`].some((prefix) =>
    path.startsWith(prefix)
  );

/** Amendment additions must be explicit files, not directories, globs, or coordination paths. */
export const isExactAmendmentPath = (candidate: string): boolean => {
  if (!isFileMapPath(candidate)) return false;
  if (candidate.endsWith("/") || candidate.endsWith("/**")) return false;
  if (candidate.includes("{") || candidate.includes("*") || candidate.includes("?")) return false;
  const segments = candidate.split("/");
  if (segments.some((segment) => segment === "" || segment === ".")) return false;
  return true;
};

export const validateAmendmentAdditionalPaths = (
  paths: readonly { path: string; reason: string }[],
  effectiveApproved: readonly string[],
  issue: number
): string[] => {
  const outstanding: string[] = [];
  const seen = new Set<string>();
  for (const entry of paths) {
    if (entry.reason.replace(/\s/gu, "").length === 0) {
      outstanding.push(`additional path ${entry.path} requires a nonblank reason`);
    }
    if (!isExactAmendmentPath(entry.path)) {
      outstanding.push(`additional path ${entry.path} must be an exact repository file path`);
      continue;
    }
    if (isCurrentIssueCoordinationPath(entry.path, issue)) {
      outstanding.push(`additional path ${entry.path} cannot be a coordination artifact namespace`);
      continue;
    }
    if (seen.has(entry.path)) {
      outstanding.push(`additional path ${entry.path} is duplicated`);
      continue;
    }
    seen.add(entry.path);
    if (matchesApprovedPath(entry.path, effectiveApproved)) {
      outstanding.push(`additional path ${entry.path} is already covered by the effective approved map`);
    }
  }
  if (paths.length === 0) outstanding.push("plan-amendment-request requires at least one additional path");
  return outstanding;
};

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
  extra: Pick<
    EvidenceObservation,
    "productPin" | "disposition" | "approvedPaths" | "choice" | "checkResults"
  > = {}
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

const scopeHashErrors = (actual: string | undefined, order: InternalOrder): string[] => {
  if (order.scopeHash === undefined) return [];
  if (actual === undefined) {
    if ((order.scopeEvidence?.length ?? 0) > 0) {
      return ["artifact scopeHash is required when approved amendments apply"];
    }
    return [];
  }
  return actual === order.scopeHash ? [] : ["artifact scopeHash does not match the current effective scope"];
};

const amendmentRequestObservation = (
  order: InternalOrder,
  sha: string,
  request: {
    scopeHash: string;
    explanation: string;
    additionalPaths: { path: string; reason: string }[];
  },
  requiredPath: string
) => ({
  agent: order.agent,
  actionId: order.actionId,
  submissionSha: sha,
  status: "amendment-request" as const,
  outstanding: [],
  amendmentRequest: {
    scopeHash: request.scopeHash,
    explanation: request.explanation,
    additionalPaths: request.additionalPaths,
    requestPath: requiredPath
  }
});

const evaluateAmendmentOrReady = async (
  order: InternalOrder,
  submissionSha: string,
  blob: string,
  requiredPath: string,
  fetchedRef: string,
  mirror: EvidenceMirror,
  readyKind: "implementation" | "revision"
): Promise<EvidenceObservation> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob) as unknown;
  } catch {
    return rejected(order, submissionSha, [`invalid ${readyKind}-ready artifact: invalid JSON`]);
  }
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "artifact" in parsed &&
    (parsed as { artifact: unknown }).artifact === "plan-amendment-request"
  ) {
    const request = parseJsonWithSchema(blob, planAmendmentRequestArtifactSchema);
    if (!request.ok) {
      return rejected(order, submissionSha, [`invalid plan-amendment-request artifact: ${request.error}`]);
    }
    const errors = [
      ...commonErrors(request.value, order),
      ...inputHashErrors(request.value.inputSetHash, order),
      ...scopeHashErrors(request.value.scopeHash, order)
    ];
    if (request.value.actionId !== order.actionId) {
      errors.push(`artifact actionId must be ${order.actionId}`);
    }
    errors.push(
      ...validateAmendmentAdditionalPaths(request.value.additionalPaths, order.approvedPaths, order.issue)
    );
    return errors.length === 0
      ? amendmentRequestObservation(order, submissionSha, request.value, requiredPath)
      : rejected(order, submissionSha, errors);
  }

  if (readyKind === "implementation") {
    const ready = parseJsonWithSchema(blob, implementationReadyArtifactSchema);
    if (!ready.ok) return rejected(order, submissionSha, [`invalid implementation-ready artifact: ${ready.error}`]);
    const errors = [
      ...commonErrors(ready.value, order),
      ...inputHashErrors(ready.value.inputSetHash, order),
      ...scopeHashErrors(ready.value.scopeHash, order),
      ...(await pinErrors(ready.value.implementationCommitSha, submissionSha, fetchedRef, order, mirror))
    ];
    const approved = order.approvedPaths.length === 0 ? ready.value.approvedPaths : order.approvedPaths;
    if (JSON.stringify([...ready.value.approvedPaths].sort()) !== JSON.stringify([...approved].sort())) {
      errors.push("implementation approvedPaths do not match the effective approved file map");
    }
    if (errors.length === 0) {
      const changed = await mirror.changedPaths(order.baselineSha, ready.value.implementationCommitSha);
      const disallowed = changed.filter(
        (path) => !isCurrentIssueCoordinationPath(path, order.issue) && !matchesApprovedPath(path, approved)
      );
      if (disallowed.length > 0) errors.push(`implementation changes paths outside the approved file map: ${disallowed.join(", ")}`);
    }
    return errors.length === 0
      ? satisfied(order, submissionSha, { productPin: ready.value.implementationCommitSha })
      : rejected(order, submissionSha, errors);
  }

  const ready = parseJsonWithSchema(blob, revisionReadyArtifactSchema);
  if (!ready.ok) return rejected(order, submissionSha, [`invalid revision-ready artifact: ${ready.error}`]);
  const errors = [
    ...commonErrors(ready.value, order),
    ...inputHashErrors(ready.value.inputSetHash, order),
    ...scopeHashErrors(ready.value.scopeHash, order),
    ...(await pinErrors(ready.value.revisedBranchHead, submissionSha, fetchedRef, order, mirror))
  ];
  if (ready.value.round !== order.round) errors.push(`revision round must be ${order.round ?? 1}`);
  const expectedPins = order.inputs.map((input) => input.commitSha).sort();
  if (JSON.stringify([...ready.value.basedOn].sort()) !== JSON.stringify(expectedPins)) {
    errors.push("revision basedOn pins do not equal bound inputs");
  }
  if (expectedPins.length !== 1) errors.push("revision must be based on exactly one authorized product pin");
  const inputPin = expectedPins[0];
  if (inputPin !== undefined && !(await mirror.isAncestor(inputPin, ready.value.revisedBranchHead))) {
    errors.push("revised product pin does not descend from its exact authorized input pin");
  }
  if (inputPin !== undefined) {
    const changed = await mirror.changedPaths(inputPin, ready.value.revisedBranchHead);
    const disallowed = changed.filter(
      (path) => !isCurrentIssueCoordinationPath(path, order.issue) && !matchesApprovedPath(path, order.approvedPaths)
    );
    if (disallowed.length > 0) errors.push(`revision changes paths outside the approved file map: ${disallowed.join(", ")}`);
  }
  return errors.length === 0
    ? satisfied(order, submissionSha, { productPin: ready.value.revisedBranchHead })
    : rejected(order, submissionSha, errors);
};

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
  const phase = await mirror.validatePhasePin({
    pin,
    tip: submissionSha,
    issue: order.issue,
    subject: agentFacingSubject(order.evidenceId),
    ref: order.branch
  });
  if (!phase.ok) outstanding.push(phase.details);
  return outstanding;
};

export const evaluateEvidence = async (
  order: InternalOrder,
  submissionSha: string,
  mirror: EvidenceMirror,
  assertAuthority: () => void = () => undefined
): Promise<EvidenceObservation> => {
  if (order.submissionMode === "response") {
    return rejected(order, submissionSha, ["ballot steps cannot be satisfied through a repository artifact"]);
  }
  const requiredPath = order.requiredPath;
  const fetched = await mirror.fetchBranch(order.branch);
  assertAuthority();
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
  const reachable = await mirror.isReachable(submissionSha, fetched.ref);
  assertAuthority();
  if (!reachable) {
    return rejected(order, submissionSha, [`submission ${submissionSha} is not reachable from origin/${order.branch}`]);
  }
  const blob = await mirror.readBlob(submissionSha, requiredPath);
  assertAuthority();
  if (blob === null) return rejected(order, submissionSha, [`required artifact ${requiredPath} is missing`]);

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
    if (!markdownSection(blob, ["Comparison", "Findings"])) {
      errors.push(
        "comparison is missing a Comparison or Findings section (use a heading line that is exactly `## Comparison` or `## Findings`, with no subtitle on that line)"
      );
    }
    for (const input of order.inputs) {
      if (!blob.includes(input.commitSha)) errors.push(`comparison does not cite implementation pin ${input.commitSha}`);
    }
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "join-published") {
    const parsed = parseJsonWithSchema(blob, participationReadyArtifactSchema);
    if (!parsed.ok) return rejected(order, submissionSha, [`invalid participation-readiness artifact: ${parsed.error}`]);
    const errors = commonErrors(parsed.value, order);
    if (parsed.value.baselineSha !== order.baselineSha) errors.push("participation-readiness baselineSha does not match the issue baseline");
    if (parsed.value.automationDigest !== order.automationDigest) errors.push("participation-readiness automationDigest does not match");
    return errors.length === 0 ? satisfied(order, submissionSha) : rejected(order, submissionSha, errors);
  }

  if (order.evidenceId === "implementation-pinned") {
    return evaluateAmendmentOrReady(order, submissionSha, blob, requiredPath, fetched.ref, mirror, "implementation");
  }

  if (order.evidenceId === "revision-pinned") {
    return evaluateAmendmentOrReady(order, submissionSha, blob, requiredPath, fetched.ref, mirror, "revision");
  }

  const parsed = parseJsonWithSchema(blob, finalizationArtifactSchema);
  if (!parsed.ok) return rejected(order, submissionSha, [`invalid finalization artifact: ${parsed.error}`]);
  const errors = commonErrors(parsed.value, order);
  if (parsed.value.finalSha === submissionSha) errors.push("final cleanup pin must differ from the coordination signal commit");
  if (!(await mirror.isReachable(parsed.value.finalSha, fetched.ref))) errors.push("final cleanup pin is not reachable from the expected origin branch");
  if (!(await mirror.isAncestor(parsed.value.finalSha, submissionSha))) errors.push("finalization signal does not descend from its final cleanup pin");
  const phase = await mirror.validatePhasePin({
    pin: parsed.value.finalSha,
    tip: submissionSha,
    issue: order.issue,
    subject: "finalization artifact",
    ref: order.branch
  });
  if (!phase.ok) errors.push(phase.details);
  if (!order.inputs.some((input) => input.commitSha === parsed.value.consensusSha)) errors.push("finalization consensusSha is not the bound consensus pin");
  if (parsed.value.checks.some((check) => check.exitCode !== 0)) errors.push("finalization artifact contains a failed check");
  return errors.length === 0 ? satisfied(order, submissionSha, { productPin: parsed.value.finalSha }) : rejected(order, submissionSha, errors);
};

export const isSatisfied = evaluateEvidence;
