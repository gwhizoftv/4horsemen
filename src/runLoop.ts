import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";

import {
  clearCompletion,
  mintActionId,
  readCompletion,
  renderActionMarkdown,
  requiredPathFor,
  toRenderedAction,
  type BoundInput,
  type Order
} from "./action.js";
import { evaluateEvidence, type EvidenceContext } from "./evidence.js";
import { verifyFinalization } from "./finalization.js";
import { decide, type MachineInput } from "./machine.js";
import type { Mirror } from "./mirror.js";
import {
  activeAgents,
  appendJournal,
  saveCursors,
  verificationWorktreePath,
  writeFileAtomic,
  type AgentCursor,
  type CheckCommand,
  type RuntimeState
} from "./state.js";
import {
  participantsFor,
  renderPath,
  stepById,
  type AgentObservation,
  type Decision,
  type Observations,
  type StepDefinition,
  type StepId,
  type VerificationResult
} from "./steps.js";
import { createTmuxController, nudgeText, shouldNudge, type TmuxController } from "./tmux.js";

/**
 * The effectful orchestration loop.
 *
 * Every tick: observe the filesystem and origin, hand a plain data snapshot to
 * the pure reducer, then apply the decisions it returns. The reducer never sees
 * a boundary, and this module never makes a workflow judgement of its own.
 *
 * Waiting is bounded polling on the `complete` files. `tmux wait-for` is never
 * used, and the loop sleeps between ticks rather than busy-spinning.
 */

export type CheckOutcome = {
  readonly argv: readonly string[];
  readonly exitCode: number;
  readonly detail: string;
};

export type LoopDeps = {
  readonly mirror: Mirror;
  readonly tmux: TmuxController;
  readonly now: () => string;
  readonly sleep: (ms: number) => Promise<void>;
  /** Run a configured check argv in the verification worktree. Never a shell. */
  readonly runCheck: (argv: readonly string[], cwd: string) => CheckOutcome;
  /** Open an unmerged PR. Absent means the capability is not available. */
  readonly openPullRequest?: (finalSha: string) => { ok: boolean; detail: string };
  readonly notify?: (message: string) => void;
};

export const defaultRunCheck = (argv: readonly string[], cwd: string): CheckOutcome => {
  const [command, ...rest] = argv;

  if (command === undefined) {
    return { argv, exitCode: 1, detail: "empty check argv" };
  }

  // Explicit argument vector: no shell, so a placeholder can only ever change
  // one argv element and can never inject a second command.
  const result = spawnSync(command, rest, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30 * 60_000
  });

  return {
    argv,
    exitCode: result.status ?? 1,
    detail: result.error?.message ?? (result.stderr ?? "").trim().slice(0, 2000)
  };
};

/** Expand `{placeholder}` in exactly one argv element. Never invokes a shell. */
export const expandArgv = (
  argv: readonly string[],
  values: Readonly<Record<string, string>>
): string[] =>
  argv.map((element) =>
    element.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, key: string) => values[key] ?? match)
  );

export const branchFor = (state: RuntimeState, agent: string): string =>
  renderPath(state.start.branchTemplate, state.start.issue, agent);

const evidenceContext = (state: RuntimeState, mirror: Mirror): EvidenceContext => ({
  mirror,
  issue: state.start.issue,
  issueSessionId: state.start.issueSessionId,
  baselineSha: state.start.baselineSha,
  automationDigest: state.start.automationDigest,
  automationDigestScheme: state.start.automationDigestScheme,
  branchFor: (agent) => branchFor(state, agent)
});

/**
 * Bind an action's inputs to exact commits taken from the *active* roster.
 * A dropped agent is absent from that roster, so its published work simply
 * stops appearing — which is the whole drop announcement.
 */
export const boundInputsFor = (state: RuntimeState, step: StepDefinition, agent: string): BoundInput[] => {
  const source = step.inputsFrom;

  if (source === undefined) {
    return [];
  }

  const active = activeAgents(state.start, state.cursors);
  const sourceStep = stepById(source.stepId);
  const candidates =
    source.scope === "peers"
      ? active.filter((other) => other !== agent)
      : source.scope === "selected"
        ? active.filter((other) => other === state.cursors.selected)
        : active;

  return candidates.flatMap((other) => {
    const commitSha = state.cursors.agents[other]?.published[source.stepId];

    return commitSha === undefined
      ? []
      : [{ agent: other, path: requiredPathFor(sourceStep, state.start.issue, other), commitSha }];
  });
};

export const buildOrder = (
  state: RuntimeState,
  agent: string,
  stepId: StepId,
  attempt: number,
  outstanding: readonly string[]
): Order => {
  const step = stepById(stepId);

  return {
    actionId: mintActionId(state.start.issueSessionId, agent, stepId, attempt, state.cursors.issueCursor.round),
    agent,
    stepId,
    gateId: step.gateId,
    evidenceId: step.evidenceId,
    requiredPath: requiredPathFor(step, state.start.issue, agent),
    attempt,
    round: state.cursors.issueCursor.round,
    inputs: boundInputsFor(state, step, agent),
    outstanding,
    completePath: state.paths.completeFile(agent),
    task: step.task
  };
};

const cursorFor = (state: RuntimeState, agent: string): AgentCursor => {
  const cursor = state.cursors.agents[agent];

  if (cursor === undefined) {
    throw new Error(`No cursor for agent ${agent}; state is inconsistent.`);
  }

  return cursor;
};

const patchCursor = (state: RuntimeState, agent: string, patch: Partial<AgentCursor>, now: string): void => {
  state.cursors = {
    ...state.cursors,
    agents: {
      ...state.cursors.agents,
      [agent]: { ...cursorFor(state, agent), ...patch, updatedAt: now }
    }
  };
};

/**
 * True when the action on disk is still the action this agent should have.
 *
 * Rendering is deterministic, so re-deriving the order and comparing bytes is
 * both an idempotency check and the drop mechanism: once an agent is dropped,
 * every outstanding action that cited it no longer matches and is reissued
 * with inputs that simply omit it — no announcement, no separate ceremony.
 */
export const actionIsCurrent = (state: RuntimeState, agent: string): boolean => {
  const path = state.paths.actionFile(agent);

  if (!existsSync(path)) {
    return false;
  }

  const cursor = cursorFor(state, agent);

  if (cursor.stepId === null) {
    return false;
  }

  const expected = renderActionMarkdown(
    toRenderedAction(buildOrder(state, agent, cursor.stepId as StepId, cursor.attempt, cursor.outstanding))
  );

  return readFileSync(path, "utf8") === expected;
};

/**
 * Snapshot what is true right now: outstanding actions, submitted intent, and
 * — only where there is intent — a verification verdict.
 */
export const observe = (state: RuntimeState, deps: LoopDeps): Observations => {
  const context = evidenceContext(state, deps.mirror);
  const active = new Set(activeAgents(state.start, state.cursors));

  const agents: AgentObservation[] = state.start.originalRoster.map((agent) => {
    const cursor = cursorFor(state, agent);
    const hasAction = actionIsCurrent(state, agent);
    const completion = readCompletion(state.paths.completeFile(agent));
    const submissionSha = completion.ok ? completion.sha : null;
    const harness = state.start.harnesses[agent] ?? "unknown";
    const target = deps.tmux.paneTarget(state.start.issue, agent);
    const harnessAlive = deps.tmux.available ? !deps.tmux.harnessDisappeared(target, harness) : true;

    let verification: VerificationResult | null = null;

    // A dropped agent's completion is never evaluated.
    if (submissionSha !== null && active.has(agent) && cursor.stepId !== null) {
      const order = buildOrder(state, agent, cursor.stepId as StepId, cursor.attempt, cursor.outstanding);

      verification = evaluateEvidence(context, order, submissionSha);
    }

    return {
      agent,
      hasAction,
      stepId: cursor.stepId as StepId | null,
      submissionSha,
      verification,
      harnessAlive
    };
  });

  return { agents, now: deps.now() };
};

export const machineInputFrom = (state: RuntimeState, observations: Observations): MachineInput => {
  const active = activeAgents(state.start, state.cursors);
  const satisfied: Record<string, string[]> = {};

  for (const agent of active) {
    for (const stepId of cursorFor(state, agent).satisfied) {
      (satisfied[stepId] ??= []).push(agent);
    }
  }

  return {
    profile: state.start.profile,
    activeAgents: active,
    droppedAgents: state.cursors.droppedAgents,
    gateId: state.cursors.issueCursor.gateId as MachineInput["gateId"],
    round: state.cursors.issueCursor.round,
    selected: state.cursors.selected,
    maxRevisionRounds: state.start.maxRevisionRounds,
    paused: state.cursors.paused,
    abandoned: state.cursors.abandoned,
    satisfied,
    attempts: Object.fromEntries(active.map((agent) => [agent, cursorFor(state, agent).attempt])),
    revisionRequested: false,
    observations
  };
};

/** Write the action and, where policy allows, nudge the pane. */
const deliver = (state: RuntimeState, deps: LoopDeps, order: Order, now: string): void => {
  const path = state.paths.actionFile(order.agent);

  writeFileAtomic(path, renderActionMarkdown(toRenderedAction(order)), state.paths.root);
  appendJournal(
    state.paths.journal,
    {
      at: now,
      kind: "action-prepared",
      agent: order.agent,
      detail: { actionId: order.actionId, stepId: order.stepId, attempt: order.attempt }
    },
    state.paths.root
  );
  patchCursor(
    state,
    order.agent,
    {
      stepId: order.stepId,
      actionId: order.actionId,
      status: "ordered",
      attempt: order.attempt,
      outstanding: [...order.outstanding],
      submissionSha: null
    },
    now
  );

  if (!deps.tmux.available) {
    return;
  }

  const target = deps.tmux.paneTarget(state.start.issue, order.agent);
  const harness = state.start.harnesses[order.agent] ?? "unknown";
  const decision = shouldNudge({
    harness,
    configured: state.start.nudgeAllowed[order.agent] === true,
    paneExists: deps.tmux.paneExists(target),
    harnessRunning: !deps.tmux.harnessDisappeared(target, harness),
    paneInMode: deps.tmux.paneInMode(target)
  });

  if (decision.nudge) {
    deps.tmux.insert(target, nudgeText(path));
    appendJournal(state.paths.journal, { at: now, kind: "nudged", agent: order.agent, detail: {} }, state.paths.root);
  }
};

export type TickResult = {
  readonly decisions: readonly Decision[];
  readonly finalized: boolean;
  readonly awaitingOwner: boolean;
};

/**
 * Re-read only what is on local disk. Used between passes within one tick,
 * after completions have been consumed — no origin round trip is needed to
 * know that an accepted agent now has no action and no intent.
 */
const reobserveLocal = (state: RuntimeState, now: string): Observations => ({
  now,
  agents: state.start.originalRoster.map((agent) => ({
    agent,
    hasAction: actionIsCurrent(state, agent),
    stepId: cursorFor(state, agent).stepId as StepId | null,
    submissionSha: null,
    verification: null,
    harnessAlive: true
  }))
});

/** Passes within one tick. Bounded so a tick always terminates. */
const maxPassesPerTick = 4;

const applyDecisions = (
  state: RuntimeState,
  deps: LoopDeps,
  decisions: readonly Decision[],
  now: string
): { finalized: boolean; awaitingOwner: boolean; progressed: boolean } => {
  let finalized = false;
  let awaitingOwner = false;
  let progressed = false;

  for (const decision of decisions) {
    switch (decision.kind) {
      case "order":
      case "reorder": {
        const outstanding = decision.kind === "reorder" ? decision.outstanding : [];

        deliver(state, deps, buildOrder(state, decision.agent, decision.stepId, decision.attempt, outstanding), now);
        break;
      }

      case "accept": {
        const cursor = cursorFor(state, decision.agent);

        progressed = true;

        appendJournal(
          state.paths.journal,
          {
            at: now,
            kind: "verify-result",
            agent: decision.agent,
            detail: { stepId: decision.stepId, submissionSha: decision.submissionSha, ok: true }
          },
          state.paths.root
        );
        patchCursor(
          state,
          decision.agent,
          {
            status: "waiting-peer",
            attempt: 0,
            outstanding: [],
            submissionSha: null,
            stepId: null,
            actionId: null,
            satisfied: [...new Set([...cursor.satisfied, decision.stepId])],
            published: { ...cursor.published, [decision.stepId]: decision.submissionSha }
          },
          now
        );
        rmSync(state.paths.actionFile(decision.agent), { force: true });
        break;
      }

      case "clear-completion":
        clearCompletion(state.paths.completeFile(decision.agent));
        break;

      case "retry-verification":
        // Preserve the action and the submitted SHA. No verdict is journaled,
        // because origin never answered.
        appendJournal(
          state.paths.journal,
          { at: now, kind: "verify-deferred", agent: decision.agent, detail: { detail: decision.detail } },
          state.paths.root
        );
        break;

      case "advance-gate": {
        progressed = true;
        state.cursors = {
          ...state.cursors,
          issueCursor: {
            gateId: decision.to,
            round: decision.to === "gate-6-consensus" ? (state.cursors.issueCursor.round ?? 1) : null
          },
          selected: state.cursors.selected ?? selectFromBallots(state)
        };
        appendJournal(
          state.paths.journal,
          { at: now, kind: "gate-advanced", detail: { from: decision.from, to: decision.to } },
          state.paths.root
        );
        break;
      }

      case "finalize":
        finalized = true;
        break;

      case "await-owner":
        awaitingOwner = true;
        appendJournal(
          state.paths.journal,
          { at: now, kind: "notify", detail: { reason: decision.reason } },
          state.paths.root
        );
        break;

      case "notify-owner":
        deps.notify?.(decision.message);
        appendJournal(
          state.paths.journal,
          { at: now, kind: "notify", detail: { message: decision.message } },
          state.paths.root
        );
        break;

      case "wait":
        break;
    }
  }

  return { finalized, awaitingOwner, progressed };
};

/**
 * One tick: observe once against origin, then let the reducer run to a fixed
 * point over local state. Accepting a submission can complete a gate, and the
 * orders that follow should be delivered in the same tick rather than after
 * another poll interval.
 */
export const runTick = (state: RuntimeState, deps: LoopDeps): TickResult => {
  const first = observe(state, deps);
  const now = first.now;
  const applied: Decision[] = [];
  let observations = first;
  let finalized = false;
  let awaitingOwner = false;

  for (let pass = 0; pass < maxPassesPerTick; pass += 1) {
    const decisions = decide(machineInputFrom(state, observations));

    applied.push(...decisions);

    const result = applyDecisions(state, deps, decisions, now);

    finalized = finalized || result.finalized;
    awaitingOwner = awaitingOwner || result.awaitingOwner;

    if (!result.progressed || finalized || awaitingOwner) {
      break;
    }

    observations = reobserveLocal(state, now);
  }

  saveCursors(state, now);

  return { decisions: applied, finalized, awaitingOwner };
};

/**
 * Coordinator-side selection. Automatic declaration is permitted by owner
 * policy; merging never is.
 */
export const selectFromBallots = (state: RuntimeState): string | null => {
  const active = activeAgents(state.start, state.cursors);
  const withPlans = active.filter((agent) => cursorFor(state, agent).published["R2.plan"] !== undefined);

  return withPlans[0] ?? active[0] ?? null;
};

export type FinalizationOutcome = {
  readonly ok: boolean;
  readonly checks: readonly CheckOutcome[];
  readonly prOpened: boolean;
  readonly detail: string;
};

/**
 * R7. Cleanup-only verification through the local copy of the seed verifier,
 * then the configured checks in a throwaway worktree at the exact final commit.
 *
 * A failed verifier or a failed check blocks PR creation. There is no merge
 * capability anywhere in this module.
 */
export const finalize = (state: RuntimeState, deps: LoopDeps): FinalizationOutcome => {
  const now = deps.now();
  const selected = state.cursors.selected;

  if (selected === null) {
    return { ok: false, checks: [], prOpened: false, detail: "no selected implementation to finalize" };
  }

  const cursor = cursorFor(state, selected);
  const consensusSha = cursor.published["R6.revise"] ?? cursor.published["R4.implement"];

  if (consensusSha === undefined) {
    return { ok: false, checks: [], prOpened: false, detail: `${selected} has no approved implementation commit` };
  }

  const branch = branchFor(state, selected);
  const fetched = deps.mirror.fetchBranch(branch);

  if (!fetched.ok) {
    return { ok: false, checks: [], prOpened: false, detail: `could not refresh ${branch}: ${fetched.detail}` };
  }

  const finalSha = consensusSha;
  const verified = verifyFinalization({
    root: deps.mirror.path,
    issue: state.start.issue,
    consensusSha,
    finalSha
  });

  if (!verified.ok) {
    appendJournal(
      state.paths.journal,
      { at: now, kind: "finalized", detail: { ok: false, reason: verified.reason } },
      state.paths.root
    );

    return { ok: false, checks: [], prOpened: false, detail: verified.details };
  }

  const nonce = `${process.pid.toString(36)}-${Date.now().toString(36)}`;
  const worktree = verificationWorktreePath(state.paths, finalSha, nonce);

  mkdirSync(state.paths.worktreesDir, { recursive: true });
  deps.mirror.removeWorktree(worktree);
  rmSync(worktree, { recursive: true, force: true });

  const created = deps.mirror.addWorktree(worktree, finalSha);

  if (!created.ok) {
    return { ok: false, checks: [], prOpened: false, detail: created.detail };
  }

  const checks: CheckOutcome[] = [];

  try {
    for (const check of state.start.finalChecks as readonly CheckCommand[]) {
      const argv = expandArgv(check.argv, {
        baselineSha: state.start.baselineSha,
        finalSha,
        consensusSha,
        issue: String(state.start.issue)
      });
      const outcome = deps.runCheck(argv, check.cwd === undefined ? worktree : `${worktree}/${check.cwd}`);

      checks.push(outcome);
      appendJournal(
        state.paths.journal,
        { at: now, kind: "check-result", detail: { argv: [...argv], exitCode: outcome.exitCode } },
        state.paths.root
      );

      if (outcome.exitCode !== 0) {
        return {
          ok: false,
          checks,
          prOpened: false,
          detail: `check failed: ${argv.join(" ")} exited ${String(outcome.exitCode)}`
        };
      }
    }
  } finally {
    deps.mirror.removeWorktree(worktree);
    rmSync(worktree, { recursive: true, force: true });
  }

  let prOpened = false;

  if (state.start.prPolicy === "coord-open-unmerged" && deps.openPullRequest !== undefined) {
    prOpened = deps.openPullRequest(finalSha).ok;
  }

  appendJournal(
    state.paths.journal,
    { at: now, kind: "finalized", detail: { ok: true, finalSha, prOpened } },
    state.paths.root
  );

  return { ok: true, checks, prOpened, detail: `finalization verified at ${finalSha}` };
};

export type LoopOptions = {
  readonly pollIntervalMs?: number;
  /** Stop after this many ticks. Undefined means run until told to stop. */
  readonly maxTicks?: number;
  readonly shouldStop?: () => boolean;
};

export const runLoop = async (
  state: RuntimeState,
  deps: LoopDeps,
  options: LoopOptions = {}
): Promise<TickResult> => {
  const interval = options.pollIntervalMs ?? 1000;
  let ticks = 0;
  let last: TickResult = { decisions: [], finalized: false, awaitingOwner: false };

  for (;;) {
    last = runTick(state, deps);
    ticks += 1;

    if (last.finalized || last.awaitingOwner || state.cursors.abandoned) {
      return last;
    }

    if (options.maxTicks !== undefined && ticks >= options.maxTicks) {
      return last;
    }

    if (options.shouldStop?.() === true) {
      return last;
    }

    await deps.sleep(interval);
  }
};

export const defaultDeps = (mirror: Mirror): LoopDeps => ({
  mirror,
  tmux: createTmuxController(),
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  runCheck: defaultRunCheck
});

export { participantsFor };
