import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { detachIssue } from "./detachIssue.js";
import { git, gitOrThrow } from "./gitExec.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";
import { issueRuntimePaths } from "./paths.js";
import { cloneIsDirty } from "./setupWorkspace.js";
import type { CoordinatorConfig } from "./state.js";
import type { OwnerTerminalCloser } from "./tmux.js";

export type WipeIssueLogger = (message: string) => void;

export type WipeIssueOptions = {
  issue: number;
  config: CoordinatorConfig;
  configPath: string;
  coordRoot: string;
  force?: boolean;
  dryRun?: boolean;
  log?: WipeIssueLogger;
  terminalCloser?: OwnerTerminalCloser | null;
};

export type WipeIssueResult = {
  resetClones: string[];
  deletedLocalBranches: string[];
  deletedRemoteBranches: string[];
  missingRemoteBranches: string[];
  wipedRuntime: string | null;
  killedSessions: string[];
  closedTerminalTitles: string[];
};

const branchFor = (template: string, issue: number, agent: string): string =>
  template.replaceAll("{issue}", String(issue)).replaceAll("{agent}", agent);

const resolveAgentRoot = (configPath: string, root: string): string => resolve(dirname(configPath), root);

const deleteRemoteBranch = (cwd: string, origin: string, branch: string): void => {
  const pushed = git(cwd, "push", "origin", "--delete", branch);
  if (pushed.exitCode === 0) return;
  const repository = githubRepositoryFromOrigin(origin);
  if (repository === null) {
    throw new Error(`Cannot delete origin/${branch}: ${pushed.stderr.trim() || "git push failed"}`);
  }
  // Product masters have no agent pre-push hooks; agent clones may block deletes.
  // Fall back to the GitHub API so wipe-issue still works from either cwd.
  const api = spawnSync("gh", ["api", "-X", "DELETE", `repos/${repository}/git/refs/heads/${branch}`], {
    cwd,
    encoding: "utf8"
  });
  if ((api.status ?? 1) !== 0) {
    throw new Error(
      `Cannot delete origin/${branch} via git push (${pushed.stderr.trim()}) or gh api (${(api.stderr ?? "").trim()}).`
    );
  }
};

/**
 * Reset agent clones and delete per-agent origin branches for one issue.
 * Leaves the GitHub issue open. Does not uninstall the product.
 * Also tears down tmux + owner Terminal windows via detachIssue.
 */
export const wipeIssue = async (options: WipeIssueOptions): Promise<WipeIssueResult> => {
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const log = options.log ?? (() => undefined);
  const base = options.config.baseBranch;
  const result: WipeIssueResult = {
    resetClones: [],
    deletedLocalBranches: [],
    deletedRemoteBranches: [],
    missingRemoteBranches: [],
    wipedRuntime: null,
    killedSessions: [],
    closedTerminalTitles: []
  };

  const clones = options.config.agents.map((agent) => ({
    agent: agent.id,
    root: resolveAgentRoot(options.configPath, agent.root),
    branch: branchFor(options.config.branch, options.issue, agent.id)
  }));

  const dirty = clones.filter(({ root }) => existsSync(root) && cloneIsDirty(root)).map(({ root }) => root);
  if (dirty.length > 0 && !force) {
    throw new Error(
      `Refusing wipe-issue: uncommitted changes in ${dirty.join(", ")}. ` +
        "Commit/stash them, or re-run with --force to discard. Nothing has been changed."
    );
  }

  const paths = issueRuntimePaths(options.coordRoot, options.issue);
  try {
    for (const { agent, root, branch } of clones) {
      if (!existsSync(root)) {
        log(`skip missing clone for ${agent}: ${root}\n`);
        continue;
      }
      log(`${dryRun ? "would reset" : "resetting"} ${agent} clone ${root}\n`);
      if (!dryRun) {
        gitOrThrow(root, "fetch", "--prune", "origin");
        const onBranch = git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
        if (onBranch === branch) {
          gitOrThrow(root, "checkout", "--detach", "HEAD");
        }
        if (git(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0) {
          gitOrThrow(root, "branch", "-D", branch);
          result.deletedLocalBranches.push(branch);
          log(`deleted local ${branch}\n`);
        }
        gitOrThrow(root, "checkout", "-B", base, `origin/${base}`);
        if (force) {
          gitOrThrow(root, "reset", "--hard", `origin/${base}`);
          git(root, "clean", "-fd");
        }
      } else if (git(root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0) {
        result.deletedLocalBranches.push(branch);
      }
      result.resetClones.push(root);
    }

    const productRoot = options.config.coordination?.productRoot;
    const pushCwd =
      productRoot !== undefined && existsSync(productRoot)
        ? productRoot
        : clones.find(({ root }) => existsSync(root))?.root;
    if (pushCwd === undefined) {
      log("skip remote branch deletes: no product or agent clone available\n");
    } else {
      for (const { branch } of clones) {
        const remote = git(pushCwd, "ls-remote", "--exit-code", "--heads", "origin", branch);
        if (remote.exitCode !== 0) {
          result.missingRemoteBranches.push(branch);
          log(`remote ${branch} already absent\n`);
          continue;
        }
        log(`${dryRun ? "would delete" : "deleting"} origin/${branch}\n`);
        if (!dryRun) deleteRemoteBranch(pushCwd, options.config.origin, branch);
        result.deletedRemoteBranches.push(branch);
      }
    }

    if (existsSync(paths.issueRoot)) {
      log(`${dryRun ? "would wipe" : "wiping"} runtime ${paths.issueRoot}\n`);
      if (!dryRun) rmSync(paths.issueRoot, { recursive: true, force: true });
      result.wipedRuntime = paths.issueRoot;
    }
  } finally {
    // Always tear down UI once wipe has begun (after dirty check), even if clone
    // remotes fail or were already removed by uninstall --delete-clones.
    const ui = await detachIssue({
      issue: options.issue,
      agentIds: options.config.agents.map((agent) => agent.id),
      tmuxNamespace: paths.tmuxNamespace,
      dryRun,
      log,
      ...(options.terminalCloser === undefined ? {} : { terminalCloser: options.terminalCloser })
    });
    result.killedSessions = ui.killedSessions;
    result.closedTerminalTitles = ui.closedTerminalTitles;
  }

  return result;
};
