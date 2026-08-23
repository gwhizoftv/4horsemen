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
  const tracked = cloneAgentsProtocolState(clone).tracked;
  if (tracked && root !== null && existsSync(root)) {
    writeCloneAgentsProtocol({
      clone,
      installRoot: root,
      options: { dryRun: false, log, changes: [] }
    });
    return "overlay";
  }
  ensureAgentsMdSkipWorktree(clone);
  return "bit-only";
};

const porcelainPath = (line: string): string | null => {
  if (line.length < 4) return null;
  const raw = line.slice(3).trim();
  const arrow = raw.indexOf(" -> ");
  return arrow >= 0 ? raw.slice(arrow + 4) : raw;
};

/** Refuses dirty clones except when AGENTS.md differs only by the managed protocol overlay. */
export const hasBlockingUncommittedChanges = (clone: string): boolean => {
  const porcelain = git(clone, "status", "--porcelain").stdout;
  if (porcelain.trim() === "") return false;

  const headResult = git(clone, "show", "HEAD:AGENTS.md");
  const headContent = headResult.exitCode === 0 ? headResult.stdout : null;
  const agentsPath = join(clone, "AGENTS.md");

  for (const line of porcelain.split("\n").filter((entry) => entry.trim() !== "")) {
    const path = porcelainPath(line);
    if (path === null) return true;
    if (path === "AGENTS.md" && headContent !== null && existsSync(agentsPath)) {
      const stripped = removeManagedBlock(readFileSync(agentsPath, "utf8"), path, AGENTS_PROTOCOL_MARKERS);
      if (stripped.content.trimEnd() === headContent.trimEnd()) continue;
    }
    return true;
  }
  return false;
};

const assertCloneReady = (clone: string, branch: string, issue: number): void => {
  const state = cloneAgentsProtocolState(clone);
  if (state.tracked && !state.skipWorktree) {
    throw new Error(
      `Agent clone ${clone} is not ready for issue ${issue}: AGENTS.md skip-worktree is not set. Agents were not started.`
    );
  }
  const onBranch = git(clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  if (onBranch !== branch) {
    throw new Error(
      `Agent clone ${clone} is not ready for issue ${issue}: expected branch ${branch}, on ${onBranch}. Agents were not started.`
    );
  }
};

/**
 * Put each agent clone on `issue-N/<agent>` before work begins. Lifts skip-worktree
 * AGENTS.md, checks out the issue branch at the baseline (or an existing issue
 * branch without resetting it), then mandatorily restores the protocol overlay or
 * at minimum re-sets skip-worktree before returning.
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
    .filter(({ root }) => existsSync(root) && isGitWorktree(root) && hasBlockingUncommittedChanges(root))
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
      results.push({
        agent: agent.id,
        clone: agent.root,
        branch,
        action: "skipped-missing",
        protocol: "skipped"
      });
      continue;
    }

    const onBranch = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    if (onBranch === branch) {
      const protocol = restoreProtocol(agent.root, installRoot, log);
      log(`${agent.id} already on ${branch}\n`);
      results.push({
        agent: agent.id,
        clone: agent.root,
        branch,
        action: "already-on-branch",
        protocol
      });
      continue;
    }

    liftCloneAgentsProtocol(agent.root, { dryRun: false, log, changes: [] });
    let action: "created" | "checked-out";
    let protocol: "overlay" | "bit-only";
    try {
      const hasLocal = git(agent.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
      if (hasLocal) {
        gitOrThrow(agent.root, "checkout", "--quiet", branch);
        action = "checked-out";
        log(`checked out existing ${branch} in ${agent.root}\n`);
      } else {
        const tip = startPoint(agent.root, input.baselineSha, input.baseBranch);
        gitOrThrow(agent.root, "checkout", "--quiet", "-B", branch, tip);
        action = "created";
        log(`created ${branch} at ${tip.slice(0, 12)} in ${agent.root}\n`);
      }
    } finally {
      protocol = restoreProtocol(agent.root, installRoot, log);
    }
    results.push({ agent: agent.id, clone: agent.root, branch, action, protocol });
  }

  for (const result of results) {
    if (result.action === "skipped-missing") continue;
    assertCloneReady(result.clone, result.branch, input.issue);
  }

  return results;
};
