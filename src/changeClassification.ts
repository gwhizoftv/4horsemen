import { spawnSync } from "node:child_process";
import { inspectCommitRange, parseNameStatusRecordsZ, type GitNameStatusChange } from "./pinValidation.js";
import type { CoordinatorConfig } from "./state.js";

export type ChangeClass = "coordination" | "documentation" | "product";
export type ChangeInput = { changes: GitNameStatusChange[] | null; identity: string; reason?: string };
type Policy = Partial<Pick<CoordinatorConfig, "documentation" | "workflowCriticalFiles" | "workflowCriticalPrefixes">>;
export type ClassifiedChanges = { kind: ChangeClass; reason: string; inputIdentity: string };

/** Both names in a rename participate. Evidence cannot conceal a product path. */
export const classifyChanges = (input: ChangeInput, policy: Policy): ClassifiedChanges => {
  const result = (kind: ChangeClass, reason: string): ClassifiedChanges => ({ kind, reason, inputIdentity: input.identity });
  if (input.changes === null || input.changes.length === 0) {
    return result("product", input.reason ?? "empty or indeterminate change set");
  }
  let docs = false;
  for (const change of input.changes) {
    if (!/^(?:[ADM]|[RC][0-9]{1,3})$/.test(change.status) ||
      change.paths.length !== (/^[RC]/.test(change.status) ? 2 : 1)) {
      return result("product", "indeterminate change status");
    }
    for (const bytes of change.paths) {
      const path = bytes.toString("utf8");
      if (!Buffer.from(path).equals(bytes) || path === "") return result("product", "unrecognized path encoding");
      if (/^\.(?:signals|plans|code-reviews|amendments|escalations)\//.test(path)) continue;
      if (policy.workflowCriticalFiles?.includes(path) || policy.workflowCriticalPrefixes?.some((prefix) => path.startsWith(prefix)) ||
        !policy.documentation?.paths.includes(path)) return result("product", `product or unknown path ${JSON.stringify(path)}`);
      docs = true;
    }
  }
  return docs ? result("documentation", "only allowlisted documentation and coordination evidence")
    : result("coordination", "coordination evidence only");
};

export const inspectRangeChanges = (root: string, base: string, tip: string): ChangeInput => {
  const range = inspectCommitRange(root, base, tip);
  return { identity: `${base}..${tip}`, changes: range.ok ? range.changes : null,
    ...(range.ok ? {} : { reason: range.reason }) };
};

// Hook input is Git's actual index, including GIT_INDEX_FILE for partial commits.
// Pin inspection intentionally uses the separate hermetic range inspector.
const hookGit = (clone: string, args: string[]) => spawnSync("git", args, {
  cwd: clone, encoding: "buffer", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000
});

export const inspectStagedChanges = (clone: string): ChangeInput => {
  const tree = hookGit(clone, ["write-tree"]);
  const diff = hookGit(clone, ["diff", "--cached", "--no-ext-diff", "--name-status", "-z", "--find-renames", "--"]);
  const identity = `index:${tree.stdout?.toString("utf8").trim() || "unknown"}`;
  if (tree.status !== 0 || diff.status !== 0) return { identity, changes: null, reason: "could not inspect staged index" };
  try { return { identity, changes: parseNameStatusRecordsZ(diff.stdout) }; }
  catch { return { identity, changes: null, reason: "malformed staged diff" }; }
};

/** Consume the refs Git supplied, not HEAD or the last commit. New refs use the
 * merge base with the configured remote/base; missing history fails closed. */
export const inspectOutgoingChanges = (clone: string, refs: string, remote: string, baseBranch: string): ChangeInput => {
  const changes: GitNameStatusChange[] = [], identities: string[] = [];
  const unknown = (reason: string): ChangeInput => ({ changes: null, identity: refs.trim() || "outgoing:unknown", reason });
  const lines = refs.trim().split("\n");
  for (const line of lines) {
    const fields = line.trim().split(/\s+/);
    const [, tip, , old] = fields;
    if (fields.length !== 4 || !/^[0-9a-f]{40}$/.test(tip ?? "") || !/^[0-9a-f]{40}$/.test(old ?? "") || /^0+$/.test(tip!)) {
      return unknown("missing or malformed outgoing refs");
    }
    let base = old!;
    if (/^0+$/.test(base)) {
      const merged = hookGit(clone, ["merge-base", tip!, `refs/remotes/${remote}/${baseBranch}`]);
      if (merged.status !== 0) return unknown("no deterministic first-push base");
      base = merged.stdout.toString("utf8").trim();
    }
    const inspected = inspectRangeChanges(clone, base, tip!);
    if (inspected.changes === null) return unknown(inspected.reason ?? "unreadable outgoing range");
    changes.push(...inspected.changes);
    identities.push(inspected.identity);
  }
  return { changes, identity: identities.join(",") };
};

/** One selector for hooks and the pinned final gate. Unknown paths always run
 * the product profile; critical paths cannot be downgraded by the docs list. */
export const selectVerification = (
  input: ChangeInput,
  policy: Policy,
  phase: "precommit" | "prepush" | "finalization",
  productCommands: readonly import("./state.js").CheckCommand[]
) => {
  const classification = classifyChanges(input, policy);
  const commands = classification.kind === "coordination" ? []
    : classification.kind === "documentation" && policy.documentation !== undefined
      ? phase === "finalization" ? policy.documentation.checks : policy.documentation.verify[phase]
      : productCommands;
  return { ...classification, commands };
};
