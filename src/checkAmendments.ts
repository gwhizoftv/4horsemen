import { closeSync, readFileSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { sha256 } from "./hash.js";
import type { CheckProposal, ProposalCommand } from "./protocol.js";
import {
  acquireExclusiveLock,
  atomicWriteJson,
  coordinatorConfigSchema,
  type AcceptedSubmission,
  type CheckAddition,
  type CheckAmendment,
  type CheckCommand,
  type CursorsState,
  type StartState
} from "./state.js";

/**
 * Additive check amendments (#261), shared by evidence validation, the run
 * loop, `coord start` and the workspace writer so they cannot disagree.
 *
 * An agent proposes commands with its ordinary implementation or revision
 * signal; reviewers judge it with that code. The proposal carried by the
 * authorized lineage becomes an issue amendment at finalization: the frozen
 * issue checks plus the additions, bound to one effective-policy digest. After
 * the effective checks pass, the addition is saved to the workspace config,
 * where a later issue activates it only when its baseline provably contains
 * the approved entry points.
 */

const sameArgv = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((argument, index) => argument === right[index]);

/** A proposal may only add: a name already required must keep its exact command. */
export const proposalConflicts = (proposal: CheckProposal, required: readonly CheckCommand[]): string[] =>
  proposal.commands.flatMap((command) => {
    const existing = required.find((entry) => entry.name === command.name);
    return existing === undefined || sameArgv(existing.argv, command.argv) ? [] : [
      `check proposals may only add checks; ${command.name} would replace the existing required command ` +
        `${JSON.stringify(existing.argv)} (replacing or removing checks is an owner settings change)`
    ];
  });

/** Required commands keep their order; additions follow, deduplicating only identical commands. */
export const mergeAdditions = (required: readonly CheckCommand[], additions: readonly ProposalCommand[]): CheckCommand[] => {
  const merged = [...required];
  for (const addition of additions) {
    const existing = merged.find((entry) => entry.name === addition.name);
    if (existing === undefined) merged.push({ name: addition.name, argv: [...addition.argv] });
    else if (!sameArgv(existing.argv, addition.argv)) {
      throw new Error(`Accepted check ${addition.name} conflicts with a required command of the same name.`);
    }
  }
  return merged;
};

// ---------------------------------------------------------------- lineage --

/**
 * The authorized implementation and its reviser's revisions, in order, ending
 * at the submission whose product pin is `pin`. Losing implementations are
 * never part of it, so their proposals can never be adopted.
 */
export const authorizedLineage = (cursors: CursorsState, pin: string): AcceptedSubmission[] => {
  const selection = cursors.derived.implementationSelection;
  const implementations = cursors.accepted.filter((submission) => submission.stepId === "R4.implement");
  const implementation = selection !== null
    ? implementations.find((submission) => submission.agent === selection.winner && submission.productPin === selection.implementationPin)
    : implementations.find((submission) => submission.productPin === pin);
  if (implementation === undefined) return [];
  const reviser = selection?.reviser ?? implementation.agent;
  const revisions = cursors.accepted
    .filter((submission) => submission.stepId === "R6.revise" && submission.agent === reviser)
    .sort((left, right) => (left.round ?? 0) - (right.round ?? 0));
  const lineage = [implementation, ...revisions];
  const end = lineage.findIndex((submission) => submission.productPin === pin);
  return end < 0 ? [] : lineage.slice(0, end + 1);
};

/** The latest proposal in a lineage: omission carries it forward, a newer proposal corrects it. */
export const pendingProposalSubmission = (lineage: readonly AcceptedSubmission[]): AcceptedSubmission | null =>
  [...lineage].reverse().find((submission) => submission.checkProposal !== undefined) ?? null;

export const checkAmendmentFor = (cursors: CursorsState, pin: string): CheckAmendment | null => {
  const submission = pendingProposalSubmission(authorizedLineage(cursors, pin));
  if (submission?.checkProposal === undefined || submission.productPin === undefined) return null;
  return {
    id: sha256(JSON.stringify(["check-amendment-v1", submission.agent, submission.submissionSha, submission.path, submission.checkProposal])),
    agent: submission.agent,
    submissionSha: submission.submissionSha,
    path: submission.path,
    productPin: submission.productPin,
    proposal: submission.checkProposal
  };
};

/** Frozen issue checks followed by the amendment's additions. */
export const effectiveFinalChecks = (start: Pick<StartState, "checks">, amendment: CheckAmendment | null): CheckCommand[] =>
  amendment === null ? [...start.checks] : mergeAdditions(start.checks, amendment.proposal.commands);

/**
 * The policy identity final results are bound to. Without an amendment it is
 * the frozen digest, so existing receipts stay reusable; with one, it covers
 * the ordered additions and the amendment identity, so an old-policy result
 * can never satisfy the expanded policy.
 */
export const effectivePolicyDigest = (
  start: Pick<StartState, "checks" | "documentation" | "verificationDigest">,
  amendment: CheckAmendment | null
): string => {
  const base = start.verificationDigest ?? sha256(JSON.stringify(["checks-v1", start.checks, start.documentation ?? null]));
  return amendment === null ? base
    : sha256(JSON.stringify(["check-amendment-v1", base, amendment.id, effectiveFinalChecks(start, amendment)]));
};

// ------------------------------------------------------------ persistence --

/**
 * Serialize workspace config read-merge-write transactions. Onboarding and
 * adoption both take this lock and re-read the file inside it, so neither can
 * write back a copy that predates the other's change.
 */
export const withWorkspaceConfigLock = <T>(configPath: string, action: () => T): T => {
  const lockPath = `${configPath}.lock`;
  const handle = acquireExclusiveLock(lockPath);
  try {
    return action();
  } finally {
    closeSync(handle);
    try { unlinkSync(lockPath); } catch { /* already released */ }
  }
};

/** Union by identity; witnessed baselines accumulate. */
export const mergeCheckAdditionLists = (current: readonly CheckAddition[], incoming: readonly CheckAddition[]): CheckAddition[] => {
  const merged = current.map((entry) => ({ ...entry, activationBaselines: [...entry.activationBaselines] }));
  for (const entry of incoming) {
    const existing = merged.find((candidate) => candidate.id === entry.id);
    if (existing === undefined) merged.push({ ...entry, activationBaselines: [...entry.activationBaselines] });
    else existing.activationBaselines = [...new Set([...existing.activationBaselines, ...entry.activationBaselines])];
  }
  return merged;
};

/**
 * Rewrite only `checkAdditions` in the current config bytes, under the lock.
 * A config that no longer parses is an error for the owner to repair, never a
 * reason to write a replacement policy.
 */
const updateCheckAdditions = (configPath: string, update: (current: CheckAddition[]) => CheckAddition[]): boolean =>
  withWorkspaceConfigLock(configPath, () => {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      throw new Error(`Cannot read workspace settings ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const parsed = coordinatorConfigSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`Workspace settings ${configPath} are invalid; repair the file before checks can be saved.`);
    const next = update(parsed.data.checkAdditions);
    if (JSON.stringify(next) === JSON.stringify(parsed.data.checkAdditions)) return false;
    atomicWriteJson(dirname(configPath), configPath, coordinatorConfigSchema.parse({ ...raw, checkAdditions: next }));
    return true;
  });

export const additionFromAmendment = (
  start: Pick<StartState, "issue" | "issueSessionId">,
  amendment: CheckAmendment,
  entryPoints: readonly { path: string; sha256: string }[],
  acceptedAt: string
): CheckAddition => ({
  id: amendment.id,
  issue: start.issue,
  issueSessionId: start.issueSessionId,
  agent: amendment.agent,
  productPin: amendment.productPin,
  commands: amendment.proposal.commands.map((command) => ({ name: command.name, argv: [...command.argv] })),
  entryPoints: entryPoints.map((entry) => ({ ...entry })),
  description: amendment.proposal.description,
  acceptedAt,
  activationBaselines: []
});

/** Idempotent: a restart that already saved this addition changes nothing. */
export const saveCheckAddition = (configPath: string, addition: CheckAddition): boolean =>
  updateCheckAdditions(configPath, (current) => mergeCheckAdditionLists(current, [addition]));

export const recordActivationBaseline = (configPath: string, ids: readonly string[], baseline: string): boolean =>
  updateCheckAdditions(configPath, (current) => current.map((entry) => ids.includes(entry.id) && !entry.activationBaselines.includes(baseline)
    ? { ...entry, activationBaselines: [...entry.activationBaselines, baseline] } : entry));

// ------------------------------------------------------------- activation --

/** Reads of one exact baseline; `contentSha256` is null for an absent path. */
export type BaselineReader = { contentSha256(path: string): string | null; isAncestor(commit: string): boolean };

export type AdditionStatus = {
  addition: CheckAddition;
  status: "active" | "pending" | "stale";
  reason: string;
  /** Activated by matching content, so the baseline should be recorded as a witness. */
  witnessed: boolean;
};

/**
 * Per-issue eligibility. Ancestry of the accepted commit (or of a baseline
 * already witnessed) proves the change merged; otherwise only exact content
 * of every approved entry point is accepted, which covers squash merges
 * without guessing. Once merged, a missing entry point is a stale policy the
 * owner must resolve rather than a check that silently disappears.
 */
export const additionStatusAt = (addition: CheckAddition, reader: BaselineReader): AdditionStatus => {
  const contents = addition.entryPoints.map((entry) => ({ entry, found: reader.contentSha256(entry.path) }));
  const missing = contents.filter((item) => item.found === null).map((item) => item.entry.path);
  const merged = reader.isAncestor(addition.productPin) || addition.activationBaselines.some((baseline) => reader.isAncestor(baseline));
  const label = `accepted check from issue ${addition.issue} (${addition.commands.map((command) => command.name).join(", ")})`;
  if (merged) {
    return missing.length === 0
      ? { addition, status: "active", reason: `${label}: baseline contains the accepted change`, witnessed: false }
      : { addition, status: "stale", reason: `${label} requires ${missing.join(", ")}, which this baseline no longer contains`, witnessed: false };
  }
  if (contents.every((item) => item.found === item.entry.sha256)) {
    return { addition, status: "active", reason: `${label}: baseline contains the approved entry points`, witnessed: true };
  }
  return { addition, status: "pending", witnessed: false, reason: missing.length > 0
    ? `${label} stays pending: ${missing.join(", ")} not in this baseline yet`
    : `${label} stays pending: entry point content differs and the accepted commit is not an ancestor of this baseline` };
};
