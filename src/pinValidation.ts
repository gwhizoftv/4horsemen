import { spawnSync } from "node:child_process";

/**
 * Fail-closed classifications for an immutable pin. These values are
 * also part of the persisted escalation vocabulary in `schemas.ts`.
 */
export type PinValidationFailureReason =
  | "missing-pin"
  | "history-rewrite"
  | "post-pin-implementation-change"
  | "cross-issue-coordination-change";

export type PinValidationFailure = {
  ok: false;
  reason: PinValidationFailureReason;
  details: string;
};

export type PinValidationResult = { ok: true } | PinValidationFailure;

export type ValidatePhasePinParams = {
  root: string;
  /** Display name of the fetched origin ref whose tip is being checked. */
  ref: string;
  /** Immutable implementation/revision/content source commit. */
  pin: string;
  /** Session-pinned current origin tip. */
  tip: string;
  issue: number;
  /** Human-readable subject used in diagnostics. */
  subject: string;
};

type GitResult = {
  status: number | null;
  stdout: Buffer;
  error: string;
};

export type GitNameStatusChange = {
  /** Raw Git name-status token (`A`, `D`, `M`, `R100`, and so on). */
  status: string;
  /** One path normally; source and destination for rename/copy records. */
  paths: Buffer[];
};

export type CommitRangeInspection =
  | { ok: true; changes: GitNameStatusChange[] }
  | {
      ok: false;
      reason: "missing-base" | "missing-tip" | "not-ancestor" | "diff-failed" | "malformed-diff";
      details: string;
    };

const gitTimeoutMs = 15_000;

const runGit = (root: string, args: readonly string[]): GitResult => {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "buffer",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    timeout: gitTimeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
  const stderr = result.stderr === null ? "" : result.stderr.toString("utf8").trim();

  return {
    status: result.status,
    stdout: result.stdout === null ? Buffer.alloc(0) : Buffer.from(result.stdout),
    error: result.error?.message ?? stderr
  };
};

const splitNul = (bytes: Buffer): Buffer[] => {
  const fields: Buffer[] = [];
  let start = 0;

  while (start < bytes.length) {
    const end = bytes.indexOf(0, start);

    if (end === -1) {
      fields.push(bytes.subarray(start));
      break;
    }

    fields.push(bytes.subarray(start, end));
    start = end + 1;
  }

  return fields;
};

/**
 * Parse `git diff --name-status -z`, retaining both source and destination
 * paths for rename/copy records. No line-based parsing is used, so spaces,
 * tabs, and newlines in a Git path cannot hide a changed file.
 */
export const parseNameStatusRecordsZ = (bytes: Buffer): GitNameStatusChange[] => {
  const fields = splitNul(bytes);
  const changes: GitNameStatusChange[] = [];
  let index = 0;

  while (index < fields.length) {
    const status = fields[index]?.toString("ascii") ?? "";
    index += 1;

    if (status.length === 0 || index >= fields.length) {
      throw new Error("Git returned malformed NUL-delimited name-status output.");
    }

    const paths = [fields[index] as Buffer];
    index += 1;

    if (status.startsWith("R") || status.startsWith("C")) {
      if (index >= fields.length) {
        throw new Error("Git returned a rename/copy without its destination path.");
      }

      paths.push(fields[index] as Buffer);
      index += 1;
    }

    changes.push({ status, paths });
  }

  return changes;
};

/** Backwards-compatible flattened path view used by guarded pin callers. */
export const parseNameStatusZ = (bytes: Buffer): Buffer[] =>
  parseNameStatusRecordsZ(bytes).flatMap((change) => change.paths);

const startsWith = (value: Buffer, prefix: string): boolean =>
  value.subarray(0, Buffer.byteLength(prefix)).equals(Buffer.from(prefix));

export const displayGitPaths = (paths: readonly Buffer[]): string =>
  paths.map((path) => JSON.stringify(path.toString("utf8"))).join(", ");

export const currentIssueCoordinationPrefixes = (issue: number): string[] => [
  `.plans/issue-${issue}/`,
  `.signals/issue-${issue}/`,
  `.code-reviews/issue-${issue}/`
];

export const isCurrentIssueCoordinationPath = (path: Buffer, issue: number): boolean =>
  currentIssueCoordinationPrefixes(issue).some((prefix) => startsWith(path, prefix));

export const isCoordinationPath = (path: Buffer): boolean =>
  [".plans/", ".signals/", ".code-reviews/"].some((prefix) => startsWith(path, prefix));

/**
 * Shared ancestry and NUL-safe endpoint-diff inspection. Phase-pin validation
 * and finalization apply different path policies to this same trusted range.
 */
export const inspectCommitRange = (root: string, base: string, tip: string): CommitRangeInspection => {
  const baseExists = runGit(root, ["cat-file", "-e", `${base}^{commit}`]);

  if (baseExists.status !== 0) {
    return { ok: false, reason: "missing-base", details: baseExists.error };
  }

  const tipExists = runGit(root, ["cat-file", "-e", `${tip}^{commit}`]);

  if (tipExists.status !== 0) {
    return { ok: false, reason: "missing-tip", details: tipExists.error };
  }

  const ancestor = runGit(root, ["merge-base", "--is-ancestor", base, tip]);

  if (ancestor.status !== 0) {
    return { ok: false, reason: "not-ancestor", details: ancestor.error };
  }

  const diff = runGit(root, ["diff", "--no-ext-diff", "--name-status", "-z", "--find-renames", base, tip, "--"]);

  if (diff.status !== 0) {
    return { ok: false, reason: "diff-failed", details: diff.error };
  }

  try {
    return { ok: true, changes: parseNameStatusRecordsZ(diff.stdout) };
  } catch (error) {
    return {
      ok: false,
      reason: "malformed-diff",
      details: error instanceof Error ? error.message : String(error)
    };
  }
};

/**
 * Validate an immutable implementation/revision/content pin against a moving
 * issue branch. The tip may advance only through coordination files scoped to
 * the current issue; ancestry alone is deliberately insufficient.
 */
export const validatePhasePin = (params: ValidatePhasePinParams): PinValidationResult => {
  const { root, ref, pin, tip, issue, subject } = params;
  const inspected = inspectCommitRange(root, pin, tip);

  if (!inspected.ok) {
    if (inspected.reason === "missing-base") {
      return {
        ok: false,
        reason: "missing-pin",
        details: `${subject} pins ${pin}, but that commit is not available in the repository for ${ref}. Invariant: every immutable pin must name a fetched commit. Remediation: restore and push the pinned history, or publish a corrected coordination file with a new immutable pin; do not bypass pin validation.${inspected.details === "" ? "" : ` Git: ${inspected.details}`}`
      };
    }

    if (inspected.reason === "not-ancestor") {
      return {
        ok: false,
        reason: "history-rewrite",
        details: `${subject} pins ${pin}, which is not an ancestor of current origin tip ${tip} (${ref}). Invariant: published pins must remain in branch history. Remediation: restore the original history without force-pushing, then publish coordination files as descendants of the pin.${inspected.details === "" ? "" : ` Git: ${inspected.details}`}`
      };
    }

    return {
      ok: false,
      reason: "history-rewrite",
      details: `${subject} pins ${pin}, but its ancestry diff to ${tip} (${ref}) could not be inspected. Invariant: every post-pin path must be auditable. Remediation: restore complete readable history and rerun validation.${inspected.details === "" ? "" : ` Git: ${inspected.details}`}`
    };
  }

  const changedPaths = inspected.changes.flatMap((change) => change.paths);
  const disallowed = changedPaths.filter((path) => !isCurrentIssueCoordinationPath(path, issue));
  const implementationChanges = disallowed.filter((path) => !isCoordinationPath(path));

  if (implementationChanges.length > 0) {
    return {
      ok: false,
      reason: "post-pin-implementation-change",
      details: `${subject} pins ${pin}, but ${ref} changes product files after that pin: ${displayGitPaths(implementationChanges)}. Invariant: product files (including source, dependencies, tests, automation, scripts, hooks, and docs) cannot change after a pin. Remediation: publish a new implementation or revision commit, then publish a coordination file with the new pin before ballots are filed.`
    };
  }

  if (disallowed.length > 0) {
    return {
      ok: false,
      reason: "cross-issue-coordination-change",
      details: `${subject} pins ${pin}, but ${ref} changes coordination paths outside issue ${issue}: ${displayGitPaths(disallowed)}. Invariant: only .plans/issue-${issue}/**, .signals/issue-${issue}/**, and .code-reviews/issue-${issue}/** may follow this pin. Remediation: remove the cross-issue change with a fix-forward commit on its proper issue branch, then rerun validation.`
    };
  }

  return { ok: true };
};
