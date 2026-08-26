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
  /** An overlay was in the clone before preparation touched it. */
  hadOverlay: boolean;
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
    try {
      writeCloneAgentsProtocol({
        clone,
        installRoot: root,
        options: { dryRun: false, log, changes: [] }
      });
      return "overlay";
    } catch (error) {
      // An install root that resolves but whose template tree has been moved or
      // pruned must not take the restore down with it. This runs in a `finally`,
      // so throwing here would both replace the original failure and leave the
      // bit clear -- the exact state the restore exists to prevent.
      log(
        `could not render the AGENTS.md protocol from ${root} ` +
          `(${error instanceof Error ? error.message : String(error)})\n`
      );
    }
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
const readinessProblems = (result: PrepareAgentIssueBranchResult): readonly string[] => {
  const head = git(result.clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const state = cloneAgentsProtocolState(result.clone);
  const problems: string[] = [];
  if (head !== result.branch) problems.push(`HEAD is ${head || "detached"}, not ${result.branch}`);
  if (state.tracked && !state.skipWorktree) problems.push("AGENTS.md is tracked but skip-worktree is not set");
  // The bit only hides the overlay; it is not a substitute for it. An overlay
  // that was in the clone before preparation must still be there afterwards,
  // and a restore that claims to have written one must have written it.
  if (result.hadOverlay && result.protocol !== "overlay") {
    problems.push("the AGENTS.md protocol was present before preparation and was not restored");
  }
  if (result.protocol === "overlay" && !state.overlayPresent) {
    problems.push("the AGENTS.md protocol was reported restored but is missing");
  }
  return problems;
};

const assertClonesReady = (results: readonly PrepareAgentIssueBranchResult[]): void => {
  for (const result of results) {
    if (result.action === "skipped-missing") continue;
    const problems = readinessProblems(result);
    if (problems.length > 0) {
      throw new Error(
        `Agent clone ${result.clone} is not ready for ${result.branch}: ${problems.join("; ")}. ` +
          "Agents were not started."
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
      results.push({
        agent: agent.id,
        clone: agent.root,
        branch,
        action: "skipped-missing",
        protocol: "skipped",
        hadOverlay: false
      });
      continue;
    }

    const captured = captureCloneAgentsProtocol(agent.root);
    const onBranch = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    if (onBranch === branch) {
      const protocol = restoreProtocol(agent.root, installRoot, captured, log);
      log(`${agent.id} already on ${branch}\n`);
      results.push({
        agent: agent.id,
        clone: agent.root,
        branch,
        action: "already-on-branch",
        protocol,
        hadOverlay: captured !== null
      });
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
    results.push({ agent: agent.id, clone: agent.root, branch, action, protocol, hadOverlay: captured !== null });
  }

  assertClonesReady(results);
  return results;
};

/**
 * What one clone's end-of-issue readiness pass did.
 *
 * `discardedPaths` is the porcelain path list captured before the discard, so
 * an owner reading the log can tell what `reset --hard` + `clean -fd` removed
 * from which clone. `baseTip` and `baseSynced` exist for the same reason: a
 * clone reported base-ready must name the commit it landed on, and must say so
 * when that commit came from a stale local ref rather than a fetched origin.
 */
export type CloneBaseReadyResult = {
  agent: string;
  clone: string;
  /** The finished issue's branch for this agent: what authorizes a discard. */
  branch: string;
  action: "checked-out" | "already-base" | "refused" | "skipped-missing";
  discardedPaths: readonly string[];
  protocol: ProtocolRestoreOutcome | "skipped";
  /** Commit `HEAD` ended on, or null when nothing was moved. */
  baseTip: string | null;
  /** False when `origin/<base>` could not be resolved and a local ref was used. */
  baseSynced: boolean;
  /** Set for `refused`: what was found, and the owner's remediation. */
  reason?: string;
};

type ReadinessPlan =
  | { kind: "skip"; agent: string; clone: string; branch: string }
  | { kind: "ready"; agent: string; clone: string; branch: string; head: string; dirty: readonly string[] }
  | { kind: "refuse"; agent: string; clone: string; branch: string; reason: string };

const isAncestor = (clone: string, ancestor: string, descendant: string): boolean =>
  git(clone, "merge-base", "--is-ancestor", ancestor, descendant).exitCode === 0;

/**
 * The base commit to land on, preferring the tip origin actually has.
 *
 * A failed fetch falls back to the local ref rather than refusing: an offline
 * completion still leaves a clean clone on the base branch, and the next
 * `coord start` resolves its own baseline from origin (`startPoint` above), so
 * a stale local base cannot put the next issue branch on the wrong commit. The
 * fallback is reported (`baseSynced: false`) instead of being implied.
 */
const resolveBaseTip = (clone: string, base: string): { tip: string; synced: boolean } | null => {
  git(clone, "fetch", "--quiet", "origin", base);
  const remote = git(clone, "rev-parse", "--verify", `origin/${base}^{commit}`);
  if (remote.exitCode === 0) return { tip: remote.stdout.trim(), synced: true };
  const local = git(clone, "rev-parse", "--verify", `${base}^{commit}`);
  if (local.exitCode === 0) return { tip: local.stdout.trim(), synced: false };
  return null;
};

/**
 * Land on the base branch without ever moving it backwards.
 *
 * `checkout -B base origin/base` is what `wipeIssue` does, and it is right when
 * the local base is absent or already contained in origin. It is not right when
 * the local base carries commits origin does not have: only this issue's branch
 * was authorized for discard, and re-pointing `base` would orphan work reachable
 * from nowhere else. In that case the clone is checked out on the base branch
 * where it stands, which still satisfies clean-and-on-base.
 */
const checkoutBase = (clone: string, base: string, tip: string, synced: boolean): void => {
  const localBase = git(clone, "rev-parse", "--verify", `refs/heads/${base}`);
  if (localBase.exitCode !== 0) {
    gitOrThrow(clone, "checkout", "--quiet", "-B", base, tip);
    return;
  }
  const orphans = synced && !isAncestor(clone, localBase.stdout.trim(), tip);
  if (orphans || !synced) {
    gitOrThrow(clone, "checkout", "--quiet", base);
    return;
  }
  gitOrThrow(clone, "checkout", "--quiet", "-B", base, tip);
};

const refusalReason = (branch: string, head: string, dirty: readonly string[]): string => {
  const paths = dirty.map(statusPath);
  return (
    `uncommitted changes on ${head === "HEAD" ? "a detached HEAD" : head}, not ${branch} ` +
    `(${paths.length} path(s): ${paths.slice(0, 3).join(", ")}). ` +
    "Reset or stash them by hand, or re-run the wipe with --force."
  );
};

const skippedResult = (
  plan: Extract<ReadinessPlan, { kind: "skip" }>,
  log: (message: string) => void
): CloneBaseReadyResult => {
  log(`skip missing clone for ${plan.agent}: ${plan.clone}\n`);
  return {
    agent: plan.agent,
    clone: plan.clone,
    branch: plan.branch,
    action: "skipped-missing",
    discardedPaths: [],
    protocol: "skipped",
    baseTip: null,
    baseSynced: false
  };
};

const refusedResult = (plan: ReadinessPlan, reason: string, log: (message: string) => void): CloneBaseReadyResult => {
  log(`refusing to clean ${plan.clone}: ${reason}\n`);
  return {
    agent: plan.agent,
    clone: plan.clone,
    branch: plan.branch,
    action: "refused",
    discardedPaths: [],
    protocol: "skipped",
    baseTip: null,
    baseSynced: false,
    reason
  };
};

/** Classify one clone read-only: nothing here writes to the worktree or index. */
const readinessPlanFor = (
  agent: { id: string; root: string },
  issue: number,
  branchTemplate: string
): ReadinessPlan => {
  const branch = issueBranchFor(branchTemplate, issue, agent.id);
  if (!existsSync(agent.root) || !isGitWorktree(agent.root)) {
    return { kind: "skip", agent: agent.id, clone: agent.root, branch };
  }
  const head = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const dirty = blockingDirtyPaths(agent.root);
  if (dirty.length > 0 && head !== branch) {
    return { kind: "refuse", agent: agent.id, clone: agent.root, branch, reason: refusalReason(branch, head, dirty) };
  }
  return { kind: "ready", agent: agent.id, clone: agent.root, branch, head, dirty };
};

/** Discard, land on base, restore the protocol. Only ever called on a `ready` plan. */
const makeOneCloneBaseReady = (
  plan: Extract<ReadinessPlan, { kind: "ready" }>,
  baseBranch: string,
  installRoot: string | null,
  log: (message: string) => void
): CloneBaseReadyResult => {
  const captured = captureCloneAgentsProtocol(plan.clone);
  const discardedPaths = plan.dirty.map(statusPath);
  let protocol: ProtocolRestoreOutcome = "bit-only";
  let baseTip: string | null = null;
  let baseSynced = false;
  let reason: string | undefined;
  try {
    liftCloneAgentsProtocol(plan.clone, { dryRun: false, log, changes: [] });
    if (discardedPaths.length > 0) {
      gitOrThrow(plan.clone, "reset", "--hard", "HEAD");
      gitOrThrow(plan.clone, "clean", "-fd");
      log(`discarded ${discardedPaths.length} path(s) on ${plan.branch} in ${plan.clone}: ${discardedPaths.join(", ")}\n`);
    }
    const base = resolveBaseTip(plan.clone, baseBranch);
    if (base === null) {
      reason = `cannot resolve origin/${baseBranch} or a local ${baseBranch} in ${plan.clone}; left on ${plan.head}.`;
      log(`${reason}\n`);
    } else {
      checkoutBase(plan.clone, baseBranch, base.tip, base.synced);
      baseSynced = base.synced;
      baseTip = git(plan.clone, "rev-parse", "HEAD").stdout.trim();
      log(
        `${plan.agent} on ${baseBranch} at ${baseTip.slice(0, 12)}` +
          (base.synced ? "" : ` (origin/${baseBranch} unavailable; local ${baseBranch} used)`) +
          "\n"
      );
    }
  } finally {
    // Same invariant branch preparation holds: a clone left with the bit clear
    // shows AGENTS.md as an uncommitted change the agent may not clean up, and
    // that state dead-ends every later run on the dirty check above.
    protocol = restoreProtocol(plan.clone, installRoot, captured, log);
  }
  return {
    agent: plan.agent,
    clone: plan.clone,
    branch: plan.branch,
    action: reason !== undefined ? "refused" : plan.head === baseBranch ? "already-base" : "checked-out",
    discardedPaths,
    protocol,
    baseTip,
    baseSynced,
    ...(reason === undefined ? {} : { reason })
  };
};

/**
 * Leave each agent clone ready for the next issue once this one has ended.
 *
 * Discard-only: `reset --hard` and `clean -fd`, never `commit`, `add`, `stash`,
 * or `push`, and never a ref delete. A clone's work is eligible only when its
 * `HEAD` is exactly `issue-<N>/<agent>` for the finished issue `N` -- branch
 * identity is the whole authorization boundary, so dirt on the base branch, on a
 * detached HEAD, or on another issue's branch refuses and changes nothing.
 *
 * Every clone is classified read-only before the first destructive command, and
 * one unauthorized clone aborts the whole pass. Nothing is discarded on the
 * strength of a picture that turned out to be incomplete, and a caller whose
 * refusal says "Nothing has been changed" can keep that promise.
 *
 * Callers must run this only at a terminal session end: a completed issue after
 * its panes are dead, or an explicit owner wipe of that same issue. Under a live
 * agent CLI the reset races a process that can still write the worktree.
 */
export const makeAgentClonesBaseReady = (input: {
  agents: readonly { id: string; root: string }[];
  issue: number;
  branchTemplate: string;
  baseBranch: string;
  installRoot?: string | null;
  log?: (message: string) => void;
}): CloneBaseReadyResult[] => {
  const log = input.log ?? (() => undefined);
  const installRoot = input.installRoot ?? null;
  const plans = input.agents.map((agent) => readinessPlanFor(agent, input.issue, input.branchTemplate));

  const unauthorized = plans.filter((plan) => plan.kind === "refuse");
  if (unauthorized.length > 0) {
    const others =
      `another agent clone has unauthorized changes (${unauthorized.map((plan) => plan.clone).join(", ")}); ` +
      "nothing has been changed.";
    return plans.map((plan) =>
      plan.kind === "skip"
        ? skippedResult(plan, log)
        : refusedResult(plan, plan.kind === "refuse" ? plan.reason : others, log)
    );
  }

  // The `refuse` arm cannot be reached past the batch abort above; keeping the
  // mapping total is what makes that safe to change later without a cast here.
  return plans.map((plan) =>
    plan.kind === "skip"
      ? skippedResult(plan, log)
      : plan.kind === "refuse"
        ? refusedResult(plan, plan.reason, log)
        : makeOneCloneBaseReady(plan, input.baseBranch, installRoot, log)
  );
};
