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
  /** The verified base commit on success, or null for a skip/refusal. */
  baseTip: string | null;
  /** True only when baseTip was resolved by this pass's successful origin fetch. */
  baseSynced: boolean;
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
  // Same-branch WIP needs no checkout. Share the read-only snapshot with base
  // readiness, but not its discard policy: preparation never discards work.
  const snapshots = snapshotCloneReadiness(input);
  const dirtySnapshots = snapshots.filter(
    ({ available, head, branch, dirtyLines }) => available && head !== branch && dirtyLines.length > 0
  );
  if (dirtySnapshots.length > 0) {
    const dirtyDescriptions = dirtySnapshots.map((s) => {
      const paths = s.dirtyLines.map((line) => statusPath(line)).join(", ");
      return `${s.clone} (${paths})`;
    });
    const allUntracked = dirtySnapshots.every((s) =>
      s.dirtyLines.every((line) => line.startsWith("??"))
    );
    const advice = allUntracked
      ? `These are untracked leftovers; discard them with coord reset-clones ${input.issue} --force, then retry.`
      : "Commit/stash them, then retry.";
    throw new Error(
      `Refusing to check out issue branches: uncommitted changes in ${dirtyDescriptions.join(", ")}. ` +
        `${advice} Nothing has been changed.`
    );
  }

  const results: PrepareAgentIssueBranchResult[] = [];
  for (const snapshot of snapshots) {
    const agent = { id: snapshot.agent, root: snapshot.clone };
    const branch = snapshot.branch;
    if (!snapshot.available) {
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
    if (onBranch !== snapshot.head) {
      throw new Error(`Agent clone ${agent.root} changed branches during preparation. Retry without switching agent branches.`);
    }
    if (onBranch === branch) {
      const state = cloneAgentsProtocolState(agent.root);
      const protocol = state.overlayPresent && (!state.tracked || state.skipWorktree)
        ? "overlay"
        : restoreProtocol(agent.root, installRoot, captured, log);
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
  baseTip: null,
  baseSynced: false,
  reason
});

type CloneBaseTarget =
  | { kind: "target"; sha: string; ref: string; synced: boolean; fallbackReason?: string }
  | { kind: "refuse"; reason: string };

/**
 * Resolve where one clone can safely land before any worktree discard begins.
 *
 * A fresh origin tip is preferred. Agent clones must not keep unpushed local
 * base history: when origin is reachable, checkout always targets
 * `origin/<base>` (resetting a diverged local base via `checkout -B`). When
 * origin cannot be fetched, the local base is an auditable offline fallback so
 * a transient network failure does not recreate the leftover-WIP dead end this
 * cleanup exists to remove.
 */
const resolveCloneBaseTarget = (
  snapshot: CloneReadinessSnapshot,
  baseBranch: string
): CloneBaseTarget => {
  const fetched = git(
    snapshot.clone,
    "fetch",
    "--quiet",
    "origin",
    `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`
  );
  const originBase = git(snapshot.clone, "rev-parse", "--verify", `origin/${baseBranch}^{commit}`);
  const localBase = git(snapshot.clone, "rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`);

  if (fetched.exitCode === 0 && originBase.exitCode === 0) {
    return {
      kind: "target",
      sha: originBase.stdout.trim(),
      ref: `origin/${baseBranch}`,
      synced: true
    };
  }

  const fetchFailure =
    fetched.exitCode === 0
      ? `origin/${baseBranch} was unavailable after fetch`
      : `fetch failed: ${fetched.stderr.trim() || fetched.stdout.trim() || "git fetch failed"}`;
  if (localBase.exitCode === 0) {
    return {
      kind: "target",
      sha: localBase.stdout.trim(),
      ref: baseBranch,
      synced: false,
      fallbackReason: fetchFailure
    };
  }
  // A pre-existing tracking ref is still useful when the clone has no local
  // base yet, but it is explicitly not called synchronized after a failed fetch.
  if (originBase.exitCode === 0) {
    return {
      kind: "target",
      sha: originBase.stdout.trim(),
      ref: `origin/${baseBranch}`,
      synced: false,
      fallbackReason: fetchFailure
    };
  }
  return {
    kind: "refuse",
    reason: `cannot resolve a local or fetched ${baseBranch} in ${snapshot.clone} (${fetchFailure})`
  };
};

const checkOutCloneBase = (input: {
  snapshot: CloneReadinessSnapshot;
  baseBranch: string;
  baseTarget: { sha: string; ref: string; synced: boolean; fallbackReason?: string };
  action: "already-base" | "checked-out";
  installRoot: string | null;
  discardedPaths?: readonly string[];
  log: (message: string) => void;
}): CloneBaseReadyResult => {
  const discardedPaths = input.discardedPaths ?? [];
  const captured = captureCloneAgentsProtocol(input.snapshot.clone);
  let protocol: ProtocolRestoreOutcome = "bit-only";
  let failure: string | null = null;
  let discarded: string[] = [];
  try {
    liftCloneAgentsProtocol(input.snapshot.clone, { dryRun: false, log: input.log, changes: [] });
    if (discardedPaths.length > 0) {
      input.log(
        `${input.snapshot.agent} discarding ${discardedPaths.length} path(s) in ${input.snapshot.clone}: ` +
          `${discardedPaths.join(", ")}\n`
      );
      gitOrThrow(input.snapshot.clone, "reset", "--hard", "HEAD");
      gitOrThrow(input.snapshot.clone, "clean", "-fd");
      discarded = [...discardedPaths];
      input.log(`${input.snapshot.agent} discarded ${discarded.length} path(s) in ${input.snapshot.clone}\n`);
    }
    if (input.baseTarget.ref === input.baseBranch) {
      gitOrThrow(input.snapshot.clone, "checkout", "--quiet", input.baseBranch);
    } else {
      gitOrThrow(input.snapshot.clone, "checkout", "--quiet", "-B", input.baseBranch, input.baseTarget.ref);
    }
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    protocol = restoreProtocol(input.snapshot.clone, input.installRoot, captured, input.log);
  }

  if (failure !== null) {
    input.log(`refused clone readiness for ${input.snapshot.agent}: ${failure}\n`);
    return refusedResult(input.snapshot, failure, discarded, protocol);
  }

  const head = git(input.snapshot.clone, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
  const headSha = git(input.snapshot.clone, "rev-parse", "HEAD").stdout.trim();
  const state = cloneAgentsProtocolState(input.snapshot.clone);
  const problems: string[] = [];
  if (head !== input.baseBranch) problems.push(`HEAD is ${head || "detached"}, not ${input.baseBranch}`);
  if (headSha !== input.baseTarget.sha) {
    problems.push(`HEAD ${headSha || "is missing"} is not expected base ${input.baseTarget.sha}`);
  }
  if (state.tracked && !state.skipWorktree) problems.push("AGENTS.md is tracked but skip-worktree is not set");
  if (captured !== null && protocol !== "overlay") problems.push("the captured AGENTS.md protocol was not restored");
  if (protocol === "overlay" && !state.overlayPresent) problems.push("the restored AGENTS.md protocol is missing");
  if (problems.length > 0) {
    const reason = problems.join("; ");
    input.log(`refused clone readiness for ${input.snapshot.agent}: ${reason}\n`);
    return refusedResult(input.snapshot, reason, discarded, protocol);
  }

  input.log(
    `${input.snapshot.agent} checked out ${input.baseBranch} at ${input.baseTarget.sha.slice(0, 12)}` +
      `${input.baseTarget.synced ? "" : " (offline fallback)"}\n`
  );
  return {
    agent: input.snapshot.agent,
    clone: input.snapshot.clone,
    branch: input.snapshot.branch,
    action: input.action,
    discardedPaths: discarded,
    protocol,
    baseTip: input.baseTarget.sha,
    baseSynced: input.baseTarget.synced
  };
};

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

  const baseTargets = new Map<string, CloneBaseTarget>();
  if (!dryRun) {
    for (const snapshot of snapshots) {
      if (!snapshot.available || ineligible.includes(snapshot)) continue;
      baseTargets.set(snapshot.clone, resolveCloneBaseTarget(snapshot, input.baseBranch));
    }
    if (input.batchPolicy === "refuse-all") {
      const baseRefusals = snapshots.filter(
        (snapshot) => baseTargets.get(snapshot.clone)?.kind === "refuse"
      );
      if (baseRefusals.length > 0) {
        const blocked = baseRefusals.map(({ clone }) => clone).join(", ");
        return snapshots.map((snapshot) => {
          if (!snapshot.available) {
            log(`skip missing clone for ${snapshot.agent}: ${snapshot.clone}\n`);
            return {
              agent: snapshot.agent,
              clone: snapshot.clone,
              branch: snapshot.branch,
              action: "skipped-missing",
              discardedPaths: [],
              protocol: "skipped",
              baseTip: null,
              baseSynced: false
            };
          }
          const target = baseTargets.get(snapshot.clone);
          const reason =
            target?.kind === "refuse"
              ? target.reason
              : `another agent clone cannot be made base-ready (${blocked}); no worktrees were changed.`;
          log(`refused clone readiness for ${snapshot.agent}: ${reason}\n`);
          return refusedResult(snapshot, reason);
        });
      }
    }
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
        protocol: "skipped",
        baseTip: null,
        baseSynced: false
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
        "commit/stash the unrelated work, or run coord reset-clones --force " +
        `(or wipe-issue --force). Do not run git checkout ${input.baseBranch} by hand — ` +
        "AGENTS.md skip-worktree blocks it. Nothing has been changed.";
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
        protocol: "skipped",
        baseTip: null,
        baseSynced: false
      });
      continue;
    }

    const baseTarget = baseTargets.get(snapshot.clone);
    if (baseTarget === undefined || baseTarget.kind === "refuse") {
      const reason = baseTarget?.reason ?? `cannot resolve ${input.baseBranch} in ${snapshot.clone}`;
      log(`refused clone readiness for ${snapshot.agent}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason));
      continue;
    }
    if (!baseTarget.synced) {
      log(
        `${snapshot.agent} using fallback ${baseTarget.ref} at ${baseTarget.sha.slice(0, 12)} ` +
          `because ${baseTarget.fallbackReason ?? `origin/${input.baseBranch} is unavailable`}\n`
      );
    } else {
      const localBase = git(snapshot.clone, "rev-parse", "--verify", `refs/heads/${input.baseBranch}^{commit}`);
      if (
        localBase.exitCode === 0 &&
        localBase.stdout.trim() !== baseTarget.sha &&
        git(snapshot.clone, "merge-base", "--is-ancestor", localBase.stdout.trim(), baseTarget.sha).exitCode !== 0
      ) {
        log(
          `${snapshot.agent} resetting diverged local ${input.baseBranch} ` +
            `(${localBase.stdout.trim().slice(0, 12)}) to ${baseTarget.ref} ` +
            `(${baseTarget.sha.slice(0, 12)})\n`
        );
      }
    }

    const result = checkOutCloneBase({
      snapshot,
      baseBranch: input.baseBranch,
      baseTarget,
      action,
      installRoot,
      discardedPaths,
      log
    });
    results.push(result);
  }
  return results;
};

/**
 * Return manual-mode agent clones safely to the base branch.
 *
 * Refuses without touching any clone if there are uncommitted changes, if HEAD
 * has commits absent from the base target and absent from upstream (@{u}), or if
 * local base has commits absent from the target. Never discards or resets work.
 */
export const makeManualClonesBaseReady = (input: {
  agents: readonly { id: string; root: string }[];
  baseBranch: string;
  installRoot?: string | null;
  dryRun?: boolean;
  log?: (message: string) => void;
}): CloneBaseReadyResult[] => {
  const log = input.log ?? (() => undefined);
  const installRoot = input.installRoot ?? null;
  const dryRun = input.dryRun === true;
  const results: CloneBaseReadyResult[] = [];

  for (const agent of input.agents) {
    if (!existsSync(agent.root) || !isGitWorktree(agent.root)) {
      log(`skip missing clone for ${agent.id}: ${agent.root}\n`);
      results.push({
        agent: agent.id,
        clone: agent.root,
        branch: "",
        action: "skipped-missing",
        discardedPaths: [],
        protocol: "skipped",
        baseTip: null,
        baseSynced: false
      });
      continue;
    }

    const head = git(agent.root, "rev-parse", "--abbrev-ref", "HEAD").stdout.trim();
    const headSha = git(agent.root, "rev-parse", "HEAD").stdout.trim();
    const dirtyLines = blockingDirtyPaths(agent.root);
    const snapshot: CloneReadinessSnapshot = {
      agent: agent.id,
      clone: agent.root,
      branch: head,
      available: true,
      head,
      dirtyLines
    };

    if (dirtyLines.length > 0) {
      const reason = `uncommitted changes in ${agent.root} (${dirtyLines.map(statusPath).join(", ")})`;
      log(`refused manual clone readiness for ${agent.id}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason));
      continue;
    }

    const baseTarget = resolveCloneBaseTarget(snapshot, input.baseBranch);
    if (baseTarget.kind === "refuse") {
      log(`refused manual clone readiness for ${agent.id}: ${baseTarget.reason}\n`);
      results.push(refusedResult(snapshot, baseTarget.reason));
      continue;
    }

    const isAncestorOfBase = git(agent.root, "merge-base", "--is-ancestor", headSha, baseTarget.sha).exitCode === 0;
    let isAncestorOfUpstream = false;
    const upstream = git(agent.root, "rev-parse", "--verify", "@{u}^{commit}");
    if (upstream.exitCode === 0) {
      isAncestorOfUpstream = git(agent.root, "merge-base", "--is-ancestor", headSha, upstream.stdout.trim()).exitCode === 0;
    }

    if (!isAncestorOfBase && !isAncestorOfUpstream) {
      const reason = head === input.baseBranch
        ? `local ${input.baseBranch} has unpushed commits not present in ${baseTarget.ref}`
        : `HEAD (${head || "detached"}) has unpushed commits not present in ${baseTarget.ref}`;
      log(`refused manual clone readiness for ${agent.id}: ${reason}\n`);
      results.push(refusedResult(snapshot, reason));
      continue;
    }

    const localBase = git(agent.root, "rev-parse", "--verify", `refs/heads/${input.baseBranch}^{commit}`);
    if (localBase.exitCode === 0) {
      const localBaseSha = localBase.stdout.trim();
      if (git(agent.root, "merge-base", "--is-ancestor", localBaseSha, baseTarget.sha).exitCode !== 0) {
        const reason = `local ${input.baseBranch} has unpushed commits not present in ${baseTarget.ref}`;
        log(`refused manual clone readiness for ${agent.id}: ${reason}\n`);
        results.push(refusedResult(snapshot, reason));
        continue;
      }
    }

    const action = head === input.baseBranch && headSha === baseTarget.sha ? "already-base" : "checked-out";
    if (dryRun) {
      log(`would check out ${input.baseBranch} at ${baseTarget.ref} in ${agent.root}\n`);
      results.push({
        agent: agent.id,
        clone: agent.root,
        branch: head,
        action,
        discardedPaths: [],
        protocol: "skipped",
        baseTip: null,
        baseSynced: false
      });
      continue;
    }

    const result = checkOutCloneBase({
      snapshot,
      baseBranch: input.baseBranch,
      baseTarget,
      action,
      installRoot,
      log
    });
    results.push(result);
  }

  return results;
};
