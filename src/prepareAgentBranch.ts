import { existsSync } from "node:fs";
import { liftCloneAgentsProtocol, writeCloneAgentsProtocol } from "./agentsProtocol.js";
import { git, gitOrThrow, hasUncommittedChanges, isGitWorktree, localConfigGet } from "./gitExec.js";
import { INSTALL_ROOT_KEY } from "./hookPolicy.js";

export type PrepareAgentIssueBranchResult = {
  agent: string;
  clone: string;
  branch: string;
  action: "created" | "checked-out" | "already-on-branch" | "skipped-missing";
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

const restoreProtocol = (clone: string, installRoot: string | null, log: (message: string) => void): void => {
  const root = installRoot ?? localConfigGet(clone, INSTALL_ROOT_KEY);
  if (root === null || !existsSync(root)) return;
  writeCloneAgentsProtocol({
    clone,
    installRoot: root,
    options: { dryRun: false, log, changes: [] }
  });
};

/**
 * Put each agent clone on `issue-N/<agent>` before JOIN. Lifts skip-worktree
 * AGENTS.md, checks out the issue branch at the baseline (or an existing issue
 * branch without resetting it), then restores the protocol overlay.
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
    .filter(({ root }) => existsSync(root) && isGitWorktree(root) && hasUncommittedChanges(root))
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
      results.push({ agent: agent.id, clone: agent.root, branch, action: "skipped-missing" });
      continue;
    }

    const onBranch = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    if (onBranch === branch) {
      restoreProtocol(agent.root, installRoot, log);
      log(`${agent.id} already on ${branch}\n`);
      results.push({ agent: agent.id, clone: agent.root, branch, action: "already-on-branch" });
      continue;
    }

    liftCloneAgentsProtocol(agent.root, { dryRun: false, log, changes: [] });
    const hasLocal = git(agent.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
    if (hasLocal) {
      gitOrThrow(agent.root, "checkout", "--quiet", branch);
      restoreProtocol(agent.root, installRoot, log);
      log(`checked out existing ${branch} in ${agent.root}\n`);
      results.push({ agent: agent.id, clone: agent.root, branch, action: "checked-out" });
      continue;
    }

    const tip = startPoint(agent.root, input.baselineSha, input.baseBranch);
    gitOrThrow(agent.root, "checkout", "--quiet", "-B", branch, tip);
    restoreProtocol(agent.root, installRoot, log);
    log(`created ${branch} at ${tip.slice(0, 12)} in ${agent.root}\n`);
    results.push({ agent: agent.id, clone: agent.root, branch, action: "created" });
  }
  return results;
};
