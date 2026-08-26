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

export type CloneBaseReadyResult = {
  agent: string;
  clone: string;
  branch: string;
  action: "checked-out" | "already-base" | "refused" | "skipped-missing";
  discardedPaths: string[];
  protocol: ProtocolRestoreOutcome | "skipped";
  reason?: string;
};

export type CloneReadinessDiscardPolicy = "finished-issue-only" | "force-wipe";

/** Expected all-or-nothing refusal used by wipe before it mutates any clone. */
export class AgentCloneReadinessRefusal extends Error {
  readonly clones: string[];

  constructor(clones: readonly string[]) {
    super(`uncommitted changes in ${clones.join(", ")}`);
    this.name = "AgentCloneReadinessRefusal";
    this.clones = [...clones];
  }
}

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
export const blockingDirtyPaths = (clone: string): readonly string[] => {
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

type CloneReadinessSnapshot = {
  agent: string;
  clone: string;
  branch: string;
  available: boolean;
  head: string;
  dirtyLines: readonly string[];
};

const snapshotCloneReadiness = (input: {
  agents: readonly { id: string; root: string }[];
  issue: number;
  branchTemplate: string;
}): CloneReadinessSnapshot[] =>
  input.agents.map((agent) => {
    const branch = issueBranchFor(input.branchTemplate, input.issue, agent.id);
    if (!existsSync(agent.root) || !isGitWorktree(agent.root)) {
      return { agent: agent.id, clone: agent.root, branch, available: false, head: "", dirtyLines: [] };
    }
    return {
      agent: agent.id,
      clone: agent.root,
      branch,
      available: true,
      head: git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim(),
      dirtyLines: blockingDirtyPaths(agent.root)
    };
  });

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const refusedResult = (
  snapshot: CloneReadinessSnapshot,
  reason: string,
  discardedPaths: string[] = [],
  protocol: ProtocolRestoreOutcome | "skipped" = "skipped"
): CloneBaseReadyResult => ({
  agent: snapshot.agent,
  clone: snapshot.clone,
  branch: snapshot.branch,
  action: "refused",
  discardedPaths,
  protocol,
  reason
});

/**
 * End an issue with agent clones ready for the next one.
 *
 * Completion uses the default per-clone refusal: eligible clones are cleaned
 * even when an unrelated dirty branch makes another clone ineligible. Wipe
 * selects `refuse-all` so its historical "Nothing has been changed" dirty gate
 * remains a batch preflight. Neither mode authors commits, stashes, or pushes.
 */
export const makeAgentClonesBaseReady = (input: {
  agents: readonly { id: string; root: string }[];
  issue: number;
  branchTemplate: string;
  baseBranch: string;
  installRoot?: string | null;
  discardPolicy?: CloneReadinessDiscardPolicy;
  batchPolicy?: "continue" | "refuse-all";
  dryRun?: boolean;
  log?: (message: string) => void;
}): CloneBaseReadyResult[] => {
  const log = input.log ?? (() => undefined);
  const installRoot = input.installRoot ?? null;
  const discardPolicy = input.discardPolicy ?? "finished-issue-only";
  const dryRun = input.dryRun === true;
  const snapshots = snapshotCloneReadiness(input);
  const ineligible = snapshots.filter(
    (snapshot) =>
      snapshot.available &&
      snapshot.dirtyLines.length > 0 &&
      snapshot.head !== snapshot.branch &&
      discardPolicy !== "force-wipe"
  );
  if (input.batchPolicy === "refuse-all" && ineligible.length > 0) {
    throw new AgentCloneReadinessRefusal(ineligible.map(({ clone }) => clone));
  }

  const results: CloneBaseReadyResult[] = [];
  for (const snapshot of snapshots) {
    if (!snapshot.available) {
      log(`skip missing clone for ${snapshot.agent}: ${snapshot.clone}\n`);
      results.push({
        agent: snapshot.agent,
        clone: snapshot.clone,
        branch: snapshot.branch,
        action: "skipped-missing",
        discardedPaths: [],
        protocol: "skipped"
      });
      continue;
    }

    const discardedPaths = snapshot.dirtyLines.map(statusPath);
    if (
      discardedPaths.length > 0 &&
      snapshot.head !== snapshot.branch &&
      discardPolicy !== "force-wipe"
    ) {
      const reason =
        `HEAD is ${snapshot.head || "detached"}, not ${snapshot.branch}; ` +
        "commit/stash the unrelated work or use wipe-issue --force. Nothing has been changed.";
      log(`refused clone readiness for ${snapshot.agent}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason));
      continue;
    }

    const action = snapshot.head === input.baseBranch ? "already-base" : "checked-out";
    if (dryRun) {
      log(
        `${discardedPaths.length > 0 ? `would discard ${discardedPaths.join(", ")} and ` : ""}` +
          `would check out ${input.baseBranch} at origin/${input.baseBranch} in ${snapshot.clone}\n`
      );
      results.push({
        agent: snapshot.agent,
        clone: snapshot.clone,
        branch: snapshot.branch,
        action,
        discardedPaths,
        protocol: "skipped"
      });
      continue;
    }

    const fetched = git(snapshot.clone, "fetch", "--quiet", "origin");
    if (fetched.exitCode !== 0) {
      const reason = `cannot fetch origin: ${fetched.stderr.trim() || fetched.stdout.trim() || "git fetch failed"}`;
      log(`refused clone readiness for ${snapshot.agent}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason));
      continue;
    }
    const originBase = git(snapshot.clone, "rev-parse", "--verify", `origin/${input.baseBranch}^{commit}`);
    if (originBase.exitCode !== 0) {
      const reason = `cannot resolve origin/${input.baseBranch} after fetch`;
      log(`refused clone readiness for ${snapshot.agent}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason));
      continue;
    }
    const baseSha = originBase.stdout.trim();
    const captured = captureCloneAgentsProtocol(snapshot.clone);
    let protocol: ProtocolRestoreOutcome = "bit-only";
    let failure: string | null = null;
    try {
      liftCloneAgentsProtocol(snapshot.clone, { dryRun: false, log, changes: [] });
      if (discardedPaths.length > 0) {
        gitOrThrow(snapshot.clone, "reset", "--hard", "HEAD");
        gitOrThrow(snapshot.clone, "clean", "-fd");
      }
      gitOrThrow(snapshot.clone, "checkout", "--quiet", "-B", input.baseBranch, `origin/${input.baseBranch}`);
    } catch (error) {
      failure = errorMessage(error);
    } finally {
      protocol = restoreProtocol(snapshot.clone, installRoot, captured, log);
    }

    if (failure !== null) {
      log(`refused clone readiness for ${snapshot.agent}: ${failure}\n`);
      results.push(refusedResult(snapshot, failure, discardedPaths, protocol));
      continue;
    }

    const head = git(snapshot.clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    const headSha = git(snapshot.clone, "rev-parse", "HEAD").stdout.trim();
    const state = cloneAgentsProtocolState(snapshot.clone);
    const problems: string[] = [];
    if (head !== input.baseBranch) problems.push(`HEAD is ${head || "detached"}, not ${input.baseBranch}`);
    if (headSha !== baseSha) problems.push(`HEAD ${headSha || "is missing"} is not origin/${input.baseBranch} ${baseSha}`);
    if (state.tracked && !state.skipWorktree) problems.push("AGENTS.md is tracked but skip-worktree is not set");
    if (captured !== null && protocol !== "overlay") problems.push("the captured AGENTS.md protocol was not restored");
    if (protocol === "overlay" && !state.overlayPresent) problems.push("the restored AGENTS.md protocol is missing");
    if (problems.length > 0) {
      const reason = problems.join("; ");
      log(`refused clone readiness for ${snapshot.agent}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason, discardedPaths, protocol));
      continue;
    }

    log(
      `${snapshot.agent} ${discardedPaths.length > 0 ? `discarded ${discardedPaths.join(", ")}; ` : ""}` +
        `checked out ${input.baseBranch} at ${baseSha.slice(0, 12)}\n`
    );
    results.push({
      agent: snapshot.agent,
      clone: snapshot.clone,
      branch: snapshot.branch,
      action,
      discardedPaths,
      protocol
    });
  }
  return results;
};
