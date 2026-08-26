import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { liftCloneAgentsProtocol } from "./agentsProtocol.js";
import { deriveEvidenceBranch } from "./ballotPublication.js";
import { detachIssue } from "./detachIssue.js";
import { git, gitOrThrow, hasUncommittedChanges } from "./gitExec.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";
import { issueRuntimePaths, removeIssueMailbox, RESERVED_EVIDENCE_AGENT } from "./paths.js";
import { makeAgentClonesBaseReady } from "./prepareAgentBranch.js";
import { cloneIsDirty } from "./setupWorkspace.js";
import type { CoordinatorConfig } from "./state.js";
import type { OwnerTerminalCloser } from "./tmux.js";

export type WipeIssueLogger = (message: string) => void;

export type WipeIssueOptions = {
  issue: number;
  config: CoordinatorConfig;
  configPath: string;
  coordRoot: string;
  /** Mailbox root for this workspace; defaults to the sibling of coordRoot. */
  completesRoot?: string;
  force?: boolean;
  dryRun?: boolean;
  /** When true, also delete `issue-N/coordinator-evidence`. Default keeps it. */
  deleteEvidence?: boolean;
  log?: WipeIssueLogger;
  terminalCloser?: OwnerTerminalCloser | null;
};

export type WipeIssueResult = {
  resetClones: string[];
  deletedLocalBranches: string[];
  deletedRemoteBranches: string[];
  missingRemoteBranches: string[];
  keptProductBranches: string[];
  wipedRuntime: string | null;
  /** This issue's mailbox subtree, when one was removed. */
  wipedCompletes: string | null;
  killedSessions: string[];
  closedTerminalTitles: string[];
};

const branchFor = (template: string, issue: number, agent: string): string =>
  template.replaceAll("{issue}", String(issue)).replaceAll("{agent}", agent);

const resolveAgentRoot = (configPath: string, root: string): string => resolve(dirname(configPath), root);

const issuePrefix = (issue: number): string => `issue-${issue}/`;

const issueHeadGlob = (issue: number): string => `refs/heads/issue-${issue}/*`;

const issueRemoteGlob = (issue: number): string => `refs/remotes/origin/issue-${issue}/*`;

const isGitRepo = (cwd: string): boolean =>
  existsSync(cwd) && git(cwd, "rev-parse", "--git-dir").exitCode === 0;

const listRefs = (cwd: string, ...patterns: string[]): string[] => {
  const result = git(cwd, "for-each-ref", "--format=%(refname)", ...patterns);
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
};

const shortHead = (ref: string): string => ref.replace(/^refs\/heads\//, "");

const recordUnique = (list: string[], value: string): void => {
  if (!list.includes(value)) list.push(value);
};

const commitTip = (cwd: string, rev: string): string | null => {
  const result = git(cwd, "rev-parse", "--verify", `${rev}^{commit}`);
  return result.exitCode === 0 ? result.stdout.trim() : null;
};

const isAncestor = (cwd: string, ancestor: string, descendant: string): boolean =>
  git(cwd, "merge-base", "--is-ancestor", ancestor, descendant).exitCode === 0;

type OriginIssueBranch = { branch: string; sha: string };

const listOriginIssueBranches = (cwd: string, issue: number): OriginIssueBranch[] => {
  const result = git(cwd, "ls-remote", "--heads", "origin", issueHeadGlob(issue));
  if (result.exitCode !== 0) return [];
  const prefix = `refs/heads/${issuePrefix(issue)}`;
  return result.stdout
    .split("\n")
    .map((line) => {
      const tab = line.indexOf("\t");
      if (tab === -1) return null;
      const sha = line.slice(0, tab).trim();
      const ref = line.slice(tab + 1).trim();
      if (!ref.startsWith(prefix) || sha === "") return null;
      return { branch: shortHead(ref), sha };
    })
    .filter((row): row is OriginIssueBranch => row !== null);
};

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

const hasOrigin = (cwd: string): boolean =>
  git(cwd, "remote").stdout
    .split("\n")
    .map((line) => line.trim())
    .includes("origin");

/** Local pointer at clone work: same commit, or behind the clone on that line. */
const isCloneCheckout = (cwd: string, localSha: string, cloneSha: string | undefined): boolean => {
  if (cloneSha === undefined) return false;
  if (localSha === cloneSha) return true;
  return isAncestor(cwd, localSha, cloneSha);
};

const rosterBranchMap = (
  template: string,
  issue: number,
  agents: readonly { id: string }[]
): { byBranch: Map<string, string>; finals: Set<string> } => {
  const byBranch = new Map<string, string>();
  const finals = new Set<string>();
  for (const agent of agents) {
    const branch = branchFor(template, issue, agent.id);
    byBranch.set(branch, agent.id);
    finals.add(`${branch}-final`);
  }
  return { byBranch, finals };
};

/**
 * Drop leftover issue-N refs. `dropLocalHeads` omitted means every local issue head;
 * a set drops only those names. Remote-tracking refs whose origin branch still
 * exists are left for `git fetch --prune`.
 */
const pruneIssueRefs = (input: {
  cwd: string;
  issue: number;
  dryRun: boolean;
  log: WipeIssueLogger;
  deletedLocalBranches: string[];
  dropLocalHeads?: ReadonlySet<string>;
  keepRemoteBranches?: ReadonlySet<string>;
}): void => {
  if (!isGitRepo(input.cwd)) return;
  if (!input.dryRun && hasOrigin(input.cwd)) {
    const pruned = git(input.cwd, "fetch", "--prune", "origin");
    if (pruned.exitCode !== 0) {
      input.log(`could not fetch --prune in ${input.cwd}: ${pruned.stderr.trim() || "git fetch failed"}\n`);
    }
  }
  const dropHeads = input.dropLocalHeads;
  for (const ref of listRefs(input.cwd, issueHeadGlob(input.issue))) {
    const branch = shortHead(ref);
    if (dropHeads !== undefined && !dropHeads.has(branch)) continue;
    recordUnique(input.deletedLocalBranches, branch);
    input.log(`${input.dryRun ? "would delete" : "deleted"} ${ref} in ${input.cwd}\n`);
    if (!input.dryRun) gitOrThrow(input.cwd, "update-ref", "-d", ref);
  }
  for (const ref of listRefs(input.cwd, issueRemoteGlob(input.issue))) {
    const branch = ref.replace(/^refs\/remotes\/origin\//, "");
    if (input.keepRemoteBranches?.has(branch) === true) continue;
    input.log(`${input.dryRun ? "would delete" : "deleted"} ${ref} in ${input.cwd}\n`);
    if (!input.dryRun) gitOrThrow(input.cwd, "update-ref", "-d", ref);
  }
};

/**
 * Reset agent clones and delete coord `issue-N/*` refs on origin and in clones.
 * Deletes the coordinator evidence branch `issue-N/coordinator-evidence`
 * (derived from the branch template) alongside agent and `*-final` branches.
 * Does not treat arbitrary owner branches as coordinator-owned.
 * In the product worktree, leftover `origin/issue-N/*` tracking refs go, but a
 * local issue branch is kept when it has owner commits or uncommitted work.
 * Leaves the GitHub issue open. Does not uninstall the product.
 * Also tears down tmux + owner Terminal windows via detachIssue.
 */
export const wipeIssue = async (options: WipeIssueOptions): Promise<WipeIssueResult> => {
  const force = options.force === true;
  const dryRun = options.dryRun === true;
  const deleteEvidence = options.deleteEvidence === true;
  const log = options.log ?? (() => undefined);
  const base = options.config.baseBranch;
  const prefix = issuePrefix(options.issue);
  const result: WipeIssueResult = {
    resetClones: [],
    deletedLocalBranches: [],
    deletedRemoteBranches: [],
    missingRemoteBranches: [],
    keptProductBranches: [],
    wipedRuntime: null,
    wipedCompletes: null,
    killedSessions: [],
    closedTerminalTitles: []
  };

  if (options.config.agents.some((agent) => agent.id === RESERVED_EVIDENCE_AGENT)) {
    throw new Error(
      `${RESERVED_EVIDENCE_AGENT} is reserved for the coordinator evidence branch and cannot be an agent id.`
    );
  }

  const clones = options.config.agents.map((agent) => ({
    agent: agent.id,
    root: resolveAgentRoot(options.configPath, agent.root),
    branch: branchFor(options.config.branch, options.issue, agent.id)
  }));

  let dirty = clones.filter(({ root }) => existsSync(root) && cloneIsDirty(root)).map(({ root }) => root);
  if (dirty.length > 0 && !force) {
    // Leftover WIP only on this wipe's issue-N/<agent> branches can be discarded
    // without --force. Any other dirt keeps today's all-or-nothing refuse.
    // Preflight first so we never mutate some clones then claim nothing changed.
    if (!dryRun) {
      const dirtyRows = clones.filter(({ root }) => existsSync(root) && cloneIsDirty(root));
      const ambiguous = dirtyRows.filter(({ root, branch }) => {
        const head = git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
        return head !== branch;
      });
      if (ambiguous.length === 0) {
        makeAgentClonesBaseReady({
          agents: dirtyRows.map(({ agent, root }) => ({ id: agent, root })),
          issue: options.issue,
          branchTemplate: options.config.branch,
          baseBranch: options.config.baseBranch,
          installRoot: options.config.coordination?.installRoot ?? null,
          log
        });
        dirty = clones.filter(({ root }) => existsSync(root) && cloneIsDirty(root)).map(({ root }) => root);
      }
    }
    if (dirty.length > 0) {
      throw new Error(
        `Refusing wipe-issue: uncommitted changes in ${dirty.join(", ")}. ` +
          "Commit/stash them, or re-run with --force to discard. Nothing has been changed."
      );
    }
  }

  const paths = issueRuntimePaths(options.coordRoot, options.issue, options.completesRoot);
  const productRoot = options.config.coordination?.productRoot;
  const evidenceBranch = deriveEvidenceBranch(options.config.branch, options.issue);
  const { byBranch: rosterByBranch, finals: finalBranches } = rosterBranchMap(
    options.config.branch,
    options.issue,
    options.config.agents
  );

  const cloneTips = new Map<string, string>();
  for (const { agent, root, branch } of clones) {
    if (!isGitRepo(root)) continue;
    const sha = commitTip(root, `refs/heads/${branch}`) ?? commitTip(root, `refs/remotes/origin/${branch}`);
    if (sha !== null) cloneTips.set(agent, sha);
  }

  try {
    for (const { agent, root } of clones) {
      if (!existsSync(root)) {
        log(`skip missing clone for ${agent}: ${root}\n`);
        continue;
      }
      log(`${dryRun ? "would reset" : "resetting"} ${agent} clone ${root}\n`);
      if (!dryRun) {
        liftCloneAgentsProtocol(root, { dryRun: false, log, changes: [] });
        git(root, "fetch", "origin", base);
        const onBranch = git(root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
        if (onBranch.startsWith(prefix)) {
          gitOrThrow(root, "checkout", "--detach", "HEAD");
        }
        for (const ref of listRefs(root, issueHeadGlob(options.issue))) {
          gitOrThrow(root, "update-ref", "-d", ref);
          recordUnique(result.deletedLocalBranches, shortHead(ref));
          log(`deleted local ${shortHead(ref)}\n`);
        }
        if (force) {
          gitOrThrow(root, "checkout", "-f", "-B", base, `origin/${base}`);
          git(root, "clean", "-fd");
        } else {
          gitOrThrow(root, "checkout", "-B", base, `origin/${base}`);
        }
      } else {
        for (const ref of listRefs(root, issueHeadGlob(options.issue))) {
          recordUnique(result.deletedLocalBranches, shortHead(ref));
        }
      }
      result.resetClones.push(root);
    }

    const pushCwd =
      productRoot !== undefined && isGitRepo(productRoot)
        ? productRoot
        : clones.find(({ root }) => isGitRepo(root))?.root;

    const compareCwd = pushCwd ?? clones.find(({ root }) => isGitRepo(root))?.root;
    const productHasRepo = productRoot !== undefined && isGitRepo(productRoot);
    const productHead = productHasRepo ? git(productRoot, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim() : "";
    const productDirty = productHasRepo && hasUncommittedChanges(productRoot);

    const keepProductHeads = new Set<string>();
    if (productHasRepo) {
      for (const ref of listRefs(productRoot, issueHeadGlob(options.issue))) {
        const branch = shortHead(ref);
        const isEvidence = branch === evidenceBranch;
        const localSha = commitTip(productRoot, ref);
        const agent = rosterByBranch.get(branch);
        const cloneSha = agent === undefined ? undefined : cloneTips.get(agent);
        const dirtyHere = productDirty && productHead === branch;
        const ownerCommits = localSha !== null && !isCloneCheckout(productRoot, localSha, cloneSha);
        // Evidence is coordinator-owned; keep it unless the owner opts into deletion.
        if (isEvidence) {
          if (!deleteEvidence) {
            keepProductHeads.add(branch);
            recordUnique(result.keptProductBranches, branch);
            log(`keeping product ${branch} (ballot evidence; delete it with --delete-evidence)\n`);
          }
          continue;
        }
        if (dirtyHere || ownerCommits || agent === undefined) {
          keepProductHeads.add(branch);
          recordUnique(result.keptProductBranches, branch);
          log(
            `keeping product ${branch}` +
              (dirtyHere ? " (uncommitted changes)" : ownerCommits ? " (commits not in the clone)" : " (not a clone branch)") +
              "\n"
          );
        }
      }
    }

    const keepRemoteBranches = new Set<string>();
    if (pushCwd === undefined) {
      log("skip remote branch deletes: no product or agent clone available\n");
    } else {
      const remoteBranches = listOriginIssueBranches(pushCwd, options.issue);
      if (remoteBranches.length === 0) {
        log(`remote ${prefix}* already absent\n`);
      }
      for (const { branch, sha } of remoteBranches) {
        const agent = rosterByBranch.get(branch);
        const isFinal = finalBranches.has(branch);
        const isEvidence = branch === evidenceBranch;
        if (isEvidence) {
          if (!deleteEvidence) {
            keepRemoteBranches.add(branch);
            log(`keeping origin/${branch} (ballot evidence; delete it with --delete-evidence)\n`);
            continue;
          }
          log(`${dryRun ? "would delete" : "deleting"} origin/${branch} (ballot evidence, owner requested)\n`);
          if (!dryRun) deleteRemoteBranch(pushCwd, options.config.origin, branch);
          result.deletedRemoteBranches.push(branch);
          continue;
        }
        const cloneSha = agent === undefined ? undefined : cloneTips.get(agent);
        const ownerRemote =
          !isFinal &&
          agent !== undefined &&
          cloneSha !== undefined &&
          compareCwd !== undefined &&
          !isCloneCheckout(compareCwd, sha, cloneSha);
        if (agent === undefined && !isFinal) {
          keepRemoteBranches.add(branch);
          log(`keeping origin/${branch} (not a clone or publication branch)\n`);
          continue;
        }
        if (ownerRemote) {
          keepRemoteBranches.add(branch);
          log(`keeping origin/${branch} (commits not in the clone)\n`);
          continue;
        }
        log(`${dryRun ? "would delete" : "deleting"} origin/${branch}\n`);
        if (!dryRun) deleteRemoteBranch(pushCwd, options.config.origin, branch);
        result.deletedRemoteBranches.push(branch);
      }
    }

    const dropProductHeads = new Set<string>();
    if (productHasRepo) {
      for (const ref of listRefs(productRoot, issueHeadGlob(options.issue))) {
        const branch = shortHead(ref);
        if (!keepProductHeads.has(branch)) dropProductHeads.add(branch);
      }
      if (!dryRun && dropProductHeads.has(productHead)) {
        gitOrThrow(productRoot, "checkout", "--detach", "HEAD");
      }
    }

    for (const { root } of clones) {
      pruneIssueRefs({
        cwd: root,
        issue: options.issue,
        dryRun,
        log,
        deletedLocalBranches: result.deletedLocalBranches,
        keepRemoteBranches
      });
    }
    if (productHasRepo) {
      pruneIssueRefs({
        cwd: productRoot,
        issue: options.issue,
        dryRun,
        log,
        deletedLocalBranches: result.deletedLocalBranches,
        dropLocalHeads: dropProductHeads,
        keepRemoteBranches
      });
    }
    pruneIssueRefs({
      cwd: paths.mirror,
      issue: options.issue,
      dryRun,
      log,
      deletedLocalBranches: result.deletedLocalBranches,
      keepRemoteBranches
    });

    // The two trees are wiped independently: either can exist without the other
    // (a failed start creates the mailbox first), and a receipt that survives a
    // wipe is read as completion intent by a rerun of the same issue number.
    if (existsSync(paths.completesIssueRoot)) {
      log(`${dryRun ? "would wipe" : "wiping"} completion mailbox ${paths.completesIssueRoot}\n`);
      if (!dryRun) removeIssueMailbox(paths);
      result.wipedCompletes = paths.completesIssueRoot;
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
      terminalGroup: paths.terminalGroup,
      dryRun,
      log,
      ...(options.terminalCloser === undefined ? {} : { terminalCloser: options.terminalCloser })
    });
    result.killedSessions = ui.killedSessions;
    result.closedTerminalTitles = ui.closedTerminalTitles;
  }

  return result;
};
