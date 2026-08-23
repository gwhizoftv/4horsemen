import { existsSync } from "node:fs";
import {
  agentsMdDiffersOnlyByProtocol,
  captureCloneAgentsProtocol,
  cloneAgentsProtocolState,
  ensureAgentsMdSkipWorktree,
  liftCloneAgentsProtocol,
  restoreCapturedAgentsProtocol,
  writeCloneAgentsProtocol
} from "./agentsProtocol.js";
import { git, gitOrThrow, isGitWorktree, localConfigGet } from "./gitExec.js";
import { INSTALL_ROOT_KEY } from "./hookPolicy.js";

/**
 * `overlay` — the protocol block is back in AGENTS.md and the bit is set.
 * `bit-only` — no overlay was there to restore and no template could be
 * located, so only the index bit was re-asserted.
 */
export type ProtocolRestoreOutcome = "overlay" | "bit-only";

export type PrepareAgentIssueBranchResult = {
  agent: string;
  clone: string;
  branch: string;
  action: "created" | "checked-out" | "already-on-branch" | "skipped-missing";
  protocol: ProtocolRestoreOutcome | "skipped";
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

/**
 * Put the overlay and the skip-worktree bit back. Never a no-op.
 *
 * Resolving an install root is the preferred path because the template is
 * authoritative, but it is not always possible: a vendored clone records no
 * `coord.installRoot` by design. The earlier behaviour returned quietly when
 * nothing resolved, so on every vendored workspace the lift cleared the bit and
 * nothing ever set it again. Falling back to the overlay captured before the
 * lift keeps those clones correct, and the bit is re-asserted even when there is
 * nothing left to re-render.
 */
const restoreProtocol = (
  clone: string,
  installRoot: string | null,
  captured: string | null,
  log: (message: string) => void
): ProtocolRestoreOutcome => {
  const root = installRoot ?? localConfigGet(clone, INSTALL_ROOT_KEY);
  if (root !== null && existsSync(root)) {
    writeCloneAgentsProtocol({
      clone,
      installRoot: root,
      options: { dryRun: false, log, changes: [] }
    });
    return "overlay";
  }
  if (captured !== null) {
    restoreCapturedAgentsProtocol(clone, captured);
    log(`restored the AGENTS.md protocol in ${clone} from the clone's own copy\n`);
    return "overlay";
  }
  ensureAgentsMdSkipWorktree(clone);
  return "bit-only";
};

/** Porcelain status lines are `XY <path>`; the path starts at column 3. */
const statusPath = (line: string): string => line.slice(3);

/**
 * Dirty paths that must block a checkout.
 *
 * An AGENTS.md that differs from HEAD only by the managed overlay is not the
 * agent's work: it is what a run leaves behind when it clears the bit and then
 * fails to restore it. Refusing on it made that wreck permanent, because the
 * protocol forbids the agent from clearing the flag or reverting the file by
 * hand, so neither `coord start` nor a resume could get past it.
 */
const blockingDirtyPaths = (clone: string): readonly string[] => {
  const lines = git(clone, "status", "--porcelain")
    .stdout.split("\n")
    .filter((line) => line.trim() !== "");
  return lines.filter(
    (line) => !(statusPath(line) === "AGENTS.md" && agentsMdDiffersOnlyByProtocol(clone))
  );
};

/**
 * Refuse to hand a clone to an agent unless it is actually ready.
 *
 * Both callers start agent CLIs only after `prepareAgentIssueBranches` returns,
 * so throwing here is what keeps "checked out and the bit re-set before the
 * agent is started" true rather than merely intended.
 */
const assertClonesReady = (results: readonly PrepareAgentIssueBranchResult[]): void => {
  for (const result of results) {
    if (result.action === "skipped-missing") continue;
    const head = git(result.clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    const state = cloneAgentsProtocolState(result.clone);
    const reason =
      head !== result.branch
        ? `HEAD is ${head}, not ${result.branch}`
        : state.tracked && !state.skipWorktree
          ? "AGENTS.md is tracked but skip-worktree is not set"
          : null;
    if (reason !== null) {
      throw new Error(
        `Agent clone ${result.clone} is not ready for ${result.branch}: ${reason}. Agents were not started.`
      );
    }
  }
};

/**
 * Put each agent clone on `issue-N/<agent>` before any harness starts. Lifts
 * skip-worktree AGENTS.md, checks out the issue branch at the baseline (or an
 * existing issue branch without resetting it), then restores the protocol
 * overlay and the index bit.
 *
 * The restore runs in a `finally` and is never conditional: a clone whose bit
 * stays clear shows AGENTS.md as an uncommitted change, which the agent is
 * forbidden to clean up and which used to dead-end every later run on the dirty
 * check above. The readiness of every clone is asserted before returning,
 * because both callers launch agent CLIs only after this function returns
 * (`coord start` through `startEffects`, resume through `tmux.ensureSession`).
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
    .filter(({ root }) => existsSync(root) && isGitWorktree(root) && blockingDirtyPaths(root).length > 0)
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

    const captured = captureCloneAgentsProtocol(agent.root);
    const onBranch = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    if (onBranch === branch) {
      const protocol = restoreProtocol(agent.root, installRoot, captured, log);
      log(`${agent.id} already on ${branch}\n`);
      results.push({ agent: agent.id, clone: agent.root, branch, action: "already-on-branch", protocol });
      continue;
    }

    let action: "created" | "checked-out" = "checked-out";
    let protocol: ProtocolRestoreOutcome = "bit-only";
    try {
      liftCloneAgentsProtocol(agent.root, { dryRun: false, log, changes: [] });
      const hasLocal = git(agent.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`).exitCode === 0;
      if (hasLocal) {
        gitOrThrow(agent.root, "checkout", "--quiet", branch);
        log(`checked out existing ${branch} in ${agent.root}\n`);
      } else {
        const tip = startPoint(agent.root, input.baselineSha, input.baseBranch);
        gitOrThrow(agent.root, "checkout", "--quiet", "-B", branch, tip);
        action = "created";
        log(`created ${branch} at ${tip.slice(0, 12)} in ${agent.root}\n`);
      }
    } finally {
      // A failed checkout must not leave the bit clear behind it; that state is
      // what the dirty check above used to refuse forever.
      protocol = restoreProtocol(agent.root, installRoot, captured, log);
    }
    results.push({ agent: agent.id, clone: agent.root, branch, action, protocol });
  }

  assertClonesReady(results);
  return results;
};
