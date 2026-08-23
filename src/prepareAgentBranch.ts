import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cloneAgentsProtocolState,
  ensureAgentsMdSkipWorktree,
  liftCloneAgentsProtocol,
  writeCloneAgentsProtocol
} from "./agentsProtocol.js";
import { git, gitOrThrow, isGitWorktree, localConfigGet } from "./gitExec.js";
import { INSTALL_ROOT_KEY } from "./hookPolicy.js";
import { AGENTS_PROTOCOL_MARKERS, removeManagedBlock } from "./productIgnore.js";

export type PrepareAgentIssueBranchResult = {
  agent: string;
  clone: string;
  branch: string;
  action: "created" | "checked-out" | "already-on-branch" | "skipped-missing";
  protocol: "overlay" | "bit-only" | "skipped";
};

export const issueBranchFor = (template: string, issue: number, agent: string): string =>
  template.replaceAll("{issue}", String(issue)).replaceAll("{agent}", agent);

const commitExists = (clone: string, sha: string): boolean =>
  git(clone, "cat-file", "-e", `${sha}^{commit}`).exitCode === 0;

const startPoint = (clone: string, baselineSha: string, baseBranch: string): string => {
  if (commitExists(clone, baselineSha)) return baselineSha;
  git(clone, "fetch", "--quiet", "origin");
  if (commitExists(clone, baselineSha)) return baselineSha;
  const originBase = git(clone, "rev-parse", "--verify", `origin/${baseBranch}^{commit}`);
  if (originBase.exitCode === 0) return originBase.stdout.trim();
  const localBase = git(clone, "rev-parse", "--verify", `${baseBranch}^{commit}`);
  if (localBase.exitCode === 0) return localBase.stdout.trim();
  throw new Error(
    `Cannot resolve issue baseline ${baselineSha} in ${clone}. Fetch origin and retry.`
  );
};

const restoreProtocol = (
  clone: string,
  installRoot: string | null,
  log: (message: string) => void
): "overlay" | "bit-only" => {
  const root = installRoot ?? localConfigGet(clone, INSTALL_ROOT_KEY);
  if (root === null || !existsSync(root)) {
    ensureAgentsMdSkipWorktree(clone);
    return "bit-only";
  }
  writeCloneAgentsProtocol({
    clone,
    installRoot: root,
    options: { dryRun: false, log, changes: [] }
  });
  return "overlay";
};

/** True only when the visible dirt is exactly coordination's managed AGENTS.md overlay. */
const hasOnlyRecoverableProtocolDirt = (clone: string): boolean => {
  const entries = git(clone, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout
    .split("\0")
    .filter((entry) => entry !== "");
  if (entries.length !== 1 || entries[0]?.slice(3) !== "AGENTS.md") return false;
  const path = join(clone, "AGENTS.md");
  if (!existsSync(path)) return false;
  const head = git(clone, "show", "HEAD:AGENTS.md");
  if (head.exitCode !== 0) return false;
  try {
    const stripped = removeManagedBlock(readFileSync(path, "utf8"), path, AGENTS_PROTOCOL_MARKERS);
    return stripped.changed && stripped.content === head.stdout;
  } catch {
    return false;
  }
};

const hasBlockingChanges = (clone: string): boolean => {
  const dirty = git(clone, "status", "--porcelain").stdout.trim() !== "";
  return dirty && !hasOnlyRecoverableProtocolDirt(clone);
};

const assertReady = (result: PrepareAgentIssueBranchResult, issue: number): void => {
  if (result.action === "skipped-missing") return;
  const state = cloneAgentsProtocolState(result.clone);
  const problems: string[] = [];
  const branch = git(result.clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (branch !== result.branch) problems.push(`expected branch ${result.branch}, found ${branch || "detached HEAD"}`);
  if (state.tracked && !state.skipWorktree) problems.push("AGENTS.md skip-worktree is not set");
  if (result.protocol === "overlay" && !state.overlayPresent) problems.push("managed AGENTS.md protocol is missing");
  if (problems.length > 0) {
    throw new Error(
      `Agent clone ${result.clone} is not ready for issue ${issue}: ${problems.join("; ")}. Agents were not started.`
    );
  }
};

/**
 * Put each agent clone on `issue-N/<agent>` before its harness starts. Lifts skip-worktree
 * AGENTS.md, checks out the issue branch at the baseline (or an existing issue
 * branch without resetting it), then restores the protocol overlay or at least
 * the index bit. Restoration is mandatory even when checkout fails.
 */
export const prepareAgentIssueBranches = (input: {
  agents: readonly { id: string; root: string }[];
  issue: number;
  branchTemplate: string;
  baselineSha: string;
  baseBranch: string;
  installRoot?: string | null;
  log?: (message: string) => void;
}): PrepareAgentIssueBranchResult[] => {
  const log = input.log ?? (() => undefined);
  const installRoot = input.installRoot ?? null;
  const dirty = input.agents
    .filter(({ root }) => existsSync(root) && isGitWorktree(root) && hasBlockingChanges(root))
    .map(({ root }) => root);
  if (dirty.length > 0) {
    throw new Error(
      `Refusing to check out issue branches: uncommitted changes in ${dirty.join(", ")}. ` +
        "Commit/stash them, then retry. Nothing has been changed."
    );
  }

  const results: PrepareAgentIssueBranchResult[] = [];
  for (const agent of input.agents) {
    const branch = issueBranchFor(input.branchTemplate, input.issue, agent.id);
    if (!existsSync(agent.root) || !isGitWorktree(agent.root)) {
      log(`skip missing clone for ${agent.id}: ${agent.root}\n`);
      results.push({ agent: agent.id, clone: agent.root, branch, action: "skipped-missing", protocol: "skipped" });
      continue;
    }

    const onBranch = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    if (onBranch === branch) {
      const protocol = restoreProtocol(agent.root, installRoot, log);
      log(`${agent.id} already on ${branch} (protocol: ${protocol})\n`);
      results.push({ agent: agent.id, clone: agent.root, branch, action: "already-on-branch", protocol });
      continue;
    }

    let action: "created" | "checked-out";
    let tip: string | null = null;
    let protocol: "overlay" | "bit-only" = "bit-only";
    try {
      liftCloneAgentsProtocol(agent.root, { dryRun: false, log, changes: [] });
      const hasLocal = git(agent.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
      if (hasLocal) {
        gitOrThrow(agent.root, "checkout", "--quiet", branch);
        action = "checked-out";
      } else {
        tip = startPoint(agent.root, input.baselineSha, input.baseBranch);
        gitOrThrow(agent.root, "checkout", "--quiet", "-B", branch, tip);
        action = "created";
      }
    } finally {
      protocol = restoreProtocol(agent.root, installRoot, log);
    }
    log(
      action === "created"
        ? `created ${branch} at ${(tip as string).slice(0, 12)} in ${agent.root} (protocol: ${protocol})\n`
        : `checked out existing ${branch} in ${agent.root} (protocol: ${protocol})\n`
    );
    results.push({ agent: agent.id, clone: agent.root, branch, action, protocol });
  }
  for (const result of results) assertReady(result, input.issue);
  return results;
};
