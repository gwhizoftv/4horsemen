import { randomUUID } from "node:crypto";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { clearCompletion, createActionId, readAction, readCompletion, writeAction } from "./action.js";
import {
  AGENT_OBSERVABILITY_WATCHDOG_MS,
  decideLifecycleNudge,
  markActionInjectionDeferred,
  markActionInjected,
  markActionWorkflowComplete,
  markInjectedActionAbsent,
  markObservabilityDegraded,
  orderAgentAction,
  readAgentLifecycle
} from "./agentLifecycle.js";
import { evaluateEvidence, extractApprovedPaths, type EvidenceMirror } from "./evidence.js";
import { verifyFinalization } from "./finalization.js";
import { BareMirror, hermeticGitEnv } from "./mirror.js";
import { renderArtifactScaffold } from "./orderScaffold.js";
import { agentRuntimePaths, containedPath, type IssueRuntimePaths } from "./paths.js";
import { decide } from "./machine.js";
import {
  appendJournal,
  cursorsStateSchema,
  readConfig,
  readCursorsState,
  readStartState,
  replaceCursor,
  requireStateMutation,
  StateConflictError,
  type AcceptedSubmission,
  type CursorsState,
  type StartState
} from "./state.js";
import {
  BRANCH_PREPARED_NOTE,
  STEP_DEFINITIONS,
  coordMergesPullRequest,
  describeWorkflowStep,
  type BoundInput,
  type ChangeScopeEntry,
  type EvidenceObservation,
  type InternalOrder,
  type MachineDecision,
  type WorkflowStepId
} from "./steps.js";
import { renderIssueReport } from "./issueReport.js";
import { formatFinalizationPullRequest, githubRepositoryFromOrigin, readGitHubIssueSnapshot } from "./githubIssue.js";
import { prepareAgentIssueBranches } from "./prepareAgentBranch.js";
import { TmuxController } from "./tmux.js";
import { sha256OfFile } from "./hash.js";

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ProcessRunner = (argv: readonly string[], cwd: string) => Promise<ProcessResult>;

export const runArgv: ProcessRunner = (argv, cwd) =>
  new Promise((resolvePromise, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("Cannot run an empty argv."));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: command === "git" ? hermeticGitEnv() : process.env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ exitCode: code ?? 1, stdout, stderr }));
  });

export type PullRequestInput = {
  repository: string;
  base: string;
  head: string;
  title: string;
  body: string;
  draft: boolean;
};
export type PullRequestOpener = (input: PullRequestInput) => Promise<{ url: string }>;
export type PullRequestMerger = (input: { url: string }) => Promise<void>;

export const openDraftPullRequest: PullRequestOpener = async (input) => {
  const existing = await runArgv(
    ["gh", "pr", "list", "--repo", input.repository, "--head", input.head, "--state", "all", "--json", "url", "--limit", "1"],
    process.cwd()
  );
  if (existing.exitCode === 0) {
    try {
      const rows = JSON.parse(existing.stdout) as Array<{ url?: unknown }>;
      if (typeof rows[0]?.url === "string" && rows[0].url !== "") return { url: rows[0].url };
    } catch {
      // Fall through to create; gh's structured output should normally parse.
    }
  }
  const result = await runArgv(
    [
      "gh",
      "pr",
      "create",
      "--repo",
      input.repository,
      ...(input.draft ? ["--draft"] : []),
      "--base",
      input.base,
      "--head",
      input.head,
      "--title",
      input.title,
      "--body",
      input.body
    ],
    process.cwd()
  );
  if (result.exitCode !== 0) throw new Error(`PR creation failed: ${result.stderr.trim()}`);
  return { url: result.stdout.trim() };
};

export const mergePullRequest: PullRequestMerger = async (input) => {
  const ready = await runArgv(["gh", "pr", "ready", input.url], process.cwd());
  if (ready.exitCode !== 0 && !/not a draft/i.test(`${ready.stderr}${ready.stdout}`)) {
    throw new Error(`marking PR ready failed: ${ready.stderr.trim() || ready.stdout.trim()}`);
  }
  const merged = await runArgv(["gh", "pr", "merge", input.url, "--merge", "--delete-branch"], process.cwd());
  if (merged.exitCode !== 0) throw new Error(`PR merge failed: ${merged.stderr.trim() || merged.stdout.trim()}`);
};

export { githubRepositoryFromOrigin } from "./githubIssue.js";

export type RunLoopDependencies = {
  mirror?: BareMirror;
  tmux?: TmuxController | null;
  processRunner?: ProcessRunner;
  pullRequestOpener?: PullRequestOpener;
  pullRequestMerger?: PullRequestMerger;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  actionId?: () => string;
  log?: (message: string) => void;
  verbose?: (message: string) => void;
  /** @deprecated The timer is now an observability watchdog, never resend authority. */
  nudgeRetryMs?: number;
};

/** Kept as a public compatibility alias; elapsed time no longer authorizes a nudge. */
export const NUDGE_RETRY_MS = AGENT_OBSERVABILITY_WATCHDOG_MS;

const inputFromSubmission = (submission: AcceptedSubmission, kind: string, usePin = false): BoundInput => ({
  agent: submission.agent,
  commitSha: usePin ? (submission.productPin ?? submission.submissionSha) : submission.submissionSha,
  path: submission.path,
  kind
});

const acceptedAt = (
  cursors: CursorsState,
  stepId: WorkflowStepId,
  activeOnly = true,
  round?: number | null
): AcceptedSubmission[] =>
  cursors.accepted.filter(
    (submission) =>
      submission.stepId === stepId &&
      (!activeOnly || cursors.activeRoster.includes(submission.agent)) &&
      (round === undefined || submission.round === round)
  );

export const deterministicWinner = (
  cursors: CursorsState,
  stepId: "R3.plan-ballot" | "R5.compare-ballot",
  eligible: readonly string[]
): string | null => {
  const counts = new Map<string, number>();
  for (const submission of acceptedAt(cursors, stepId)) {
    if (submission.choice === undefined || !eligible.includes(submission.choice)) continue;
    counts.set(submission.choice, (counts.get(submission.choice) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let winner: string | null = null;
  let best = -1;
  for (const agent of cursors.activeRoster) {
    if (!eligible.includes(agent)) continue;
    const count = counts.get(agent) ?? 0;
    if (count > best) {
      winner = agent;
      best = count;
    }
  }
  return winner;
};

export const deriveBoundInputs = (
  start: StartState,
  cursors: CursorsState,
  stepId: WorkflowStepId,
  round: number | null
): BoundInput[] => {
  if (stepId === "R3.review") return acceptedAt(cursors, "R2.plan").map((value) => inputFromSubmission(value, "plan"));
  if (stepId === "R3.plan-ballot") {
    return [
      ...acceptedAt(cursors, "R2.plan").map((value) => inputFromSubmission(value, "plan")),
      ...acceptedAt(cursors, "R3.review").map((value) => inputFromSubmission(value, "review"))
    ];
  }
  if (stepId === "R3.publish-selection") {
    return acceptedAt(cursors, "R3.plan-ballot").map((value) => inputFromSubmission(value, "plan-ballot"));
  }
  if (stepId === "R4.implement") {
    const selected = cursors.selection.planAgents.filter((agent) => cursors.activeRoster.includes(agent));
    const planAgents = selected.length > 0 ? selected : [cursors.activeRoster[0] as string];
    return acceptedAt(cursors, "R2.plan")
      .filter((submission) => planAgents.includes(submission.agent))
      .map((value) => inputFromSubmission(value, "selected-plan"));
  }
  if (stepId === "R5.compare" || stepId === "R5.compare-ballot") {
    return acceptedAt(cursors, "R4.implement").map((value) => inputFromSubmission(value, "implementation", true));
  }
  if (stepId === "R5.reviser-auth") {
    return [
      ...acceptedAt(cursors, "R4.implement").map((value) => inputFromSubmission(value, "implementation", true)),
      ...acceptedAt(cursors, "R5.compare-ballot").map((value) => inputFromSubmission(value, "comparison-ballot"))
    ];
  }
  if (stepId === "R6.revise") {
    if ((round ?? 1) > 1) {
      return acceptedAt(cursors, "R6.revise", true, (round ?? 1) - 1).map((value) => inputFromSubmission(value, "prior-revision", true));
    }
    const selected = acceptedAt(cursors, "R4.implement").find(
      (value) =>
        value.agent === cursors.selection.implementationAgent && value.productPin === cursors.selection.implementationPin
    );
    return selected === undefined ? [] : [inputFromSubmission(selected, "implementation", true)];
  }
  if (stepId === "R6.ballot") {
    return acceptedAt(cursors, "R6.revise", true, round).map((value) => inputFromSubmission(value, "revision", true));
  }
  if (stepId === "R6.declare") {
    return [
      ...acceptedAt(cursors, "R6.revise", true, round).map((value) => inputFromSubmission(value, "revision", true)),
      ...acceptedAt(cursors, "R6.ballot", true, round).map((value) => inputFromSubmission(value, "consensus-ballot"))
    ];
  }
  if (stepId === "R7.finalize") {
    const declarations = acceptedAt(cursors, "R6.declare", false);
    if (declarations.length > 0) return declarations.map((value) => inputFromSubmission(value, "consensus", true));
    return acceptedAt(cursors, "R4.implement").map((value) => inputFromSubmission(value, "consensus", true));
  }
  return [];
};

const selectedPlanAgents = (cursors: CursorsState): string[] => {
  const selection = acceptedAt(cursors, "R3.publish-selection", false).at(-1);
  const selected = cursors.selection.planAgents.filter((agent) => cursors.activeRoster.includes(agent));
  return selected.length > 0 ? selected : (selection?.selectedAgents ?? [...cursors.activeRoster]);
};

const approvedPathsForOrder = (cursors: CursorsState, stepId: WorkflowStepId): string[] => {
  if (stepId !== "R4.implement" && stepId !== "R6.revise") return [];
  const selectedAgents = selectedPlanAgents(cursors);
  return [
    ...new Set(
      acceptedAt(cursors, "R2.plan")
        .filter((submission) => selectedAgents.includes(submission.agent))
        .flatMap((submission) => submission.approvedPaths ?? [])
    )
  ].sort();
};

/**
 * Re-extract the selected plan file map so extractor upgrades apply mid-issue
 * without wiping frozen plan-acceptance paths.
 */
export const resolveApprovedPaths = async (
  mirror: Pick<EvidenceMirror, "readBlob">,
  cursors: CursorsState,
  stepId: WorkflowStepId
): Promise<string[]> => {
  const frozen = approvedPathsForOrder(cursors, stepId);
  if (stepId !== "R4.implement" && stepId !== "R6.revise") return frozen;
  const selectedAgents = selectedPlanAgents(cursors);
  const plans = acceptedAt(cursors, "R2.plan").filter((submission) => selectedAgents.includes(submission.agent));
  if (plans.length === 0) return frozen;
  const paths = new Set<string>();
  for (const plan of plans) {
    const blob = await mirror.readBlob(plan.submissionSha, plan.path);
    if (blob === null) continue;
    for (const path of extractApprovedPaths(blob)) paths.add(path);
  }
  return paths.size > 0 ? [...paths].sort() : frozen;
};

/** Kinds whose bound `commitSha` is a product pin with a diff worth resolving. */
const PINNED_INPUT_KINDS = new Set(["implementation", "revision", "prior-revision"]);

/** Cap on rendered paths per pin; a large diff must not unbound the action. */
export const CHANGE_SCOPE_PATH_LIMIT = 200;

/**
 * Resolve the changed paths of each pinned bound input once, memoised per pin,
 * so four agents comparing the same four pins cost four diffs rather than
 * sixteen. A pin whose diff cannot be read is omitted rather than fatal: the
 * scope is advisory and must never block action preparation.
 */
export const resolveChangeScope = async (
  mirror: Pick<EvidenceMirror, "changedPaths">,
  start: StartState,
  inputs: readonly BoundInput[]
): Promise<ChangeScopeEntry[]> => {
  const pinned = inputs.filter((input) => PINNED_INPUT_KINDS.has(input.kind));
  if (pinned.length === 0) return [];
  // `null` records a pin whose diff could not be read. Caching the failure as
  // well as the success is what makes "one diff per distinct pin" hold on the
  // unreadable path too: without it, four inputs sharing one broken pin cost
  // four failing git invocations per tick instead of one.
  const byPin = new Map<string, readonly string[] | null>();
  const scope: ChangeScopeEntry[] = [];
  for (const input of pinned) {
    let cached = byPin.get(input.commitSha);
    if (cached === undefined) {
      try {
        cached = [...(await mirror.changedPaths(start.baselineSha, input.commitSha))].sort();
      } catch {
        cached = null;
      }
      byPin.set(input.commitSha, cached);
    }
    if (cached === null) continue;
    scope.push({
      agent: input.agent,
      commitSha: input.commitSha,
      paths: cached.slice(0, CHANGE_SCOPE_PATH_LIMIT),
      truncated: cached.length > CHANGE_SCOPE_PATH_LIMIT
    });
  }
  return scope;
};

export const buildOrder = (
  paths: IssueRuntimePaths,
  start: StartState,
  cursors: CursorsState,
  agent: string,
  stepId: WorkflowStepId,
  round: number | null,
  actionId = createActionId(),
  outstanding: readonly string[] = [],
  approvedPathOverride?: readonly string[],
  changeScope: readonly ChangeScopeEntry[] = []
): InternalOrder => {
  const definition = STEP_DEFINITIONS[stepId];
  const runtime = agentRuntimePaths(paths, agent);
  const branch = start.branchTemplate.replaceAll("{issue}", String(start.issue)).replaceAll("{agent}", agent);
  const correction = outstanding.length === 0 ? "" : `\n\nCorrect these outstanding items:\n${outstanding.map((item) => `- ${item}`).join("\n")}`;
  const inputs = deriveBoundInputs(start, cursors, stepId, round);
  const planChoices = acceptedAt(cursors, "R2.plan").map((submission) => submission.agent);
  const implementationChoices = acceptedAt(cursors, "R4.implement").map((submission) => submission.agent);
  const selectedPlan = deterministicWinner(cursors, "R3.plan-ballot", planChoices);
  const selectedImplementation = deterministicWinner(cursors, "R5.compare-ballot", implementationChoices);
  const selectedImplementationSubmission = acceptedAt(cursors, "R4.implement").find(
    (submission) => submission.agent === selectedImplementation
  );
  const approvedPaths =
    approvedPathOverride === undefined ? approvedPathsForOrder(cursors, stepId) : [...approvedPathOverride];
  const eligibleChoices =
    stepId === "R3.plan-ballot"
      ? planChoices
      : stepId === "R5.compare-ballot"
        ? implementationChoices
        : [];
  const expectedSelectedAgents = selectedPlan === null ? [] : [selectedPlan];
  const scaffold = renderArtifactScaffold({
    stepId,
    issue: start.issue,
    issueSessionId: start.issueSessionId,
    agent,
    baselineSha: start.baselineSha,
    automationDigest: start.automationDigest,
    inputs,
    eligibleChoices,
    expectedSelectedAgents,
    ...(selectedImplementation === null ? {} : { expectedImplementationAgent: selectedImplementation }),
    ...(selectedImplementationSubmission?.productPin === undefined
      ? {}
      : { expectedImplementationPin: selectedImplementationSubmission.productPin }),
    ...(selectedImplementation === null ? {} : { expectedReviser: selectedImplementation }),
    round,
    approvedPaths
  });
  const binding =
    scaffold === ""
      ? ""
      : `\n\nUse protocolVersion 1. Bound values below are authoritative; do not invent alternate digests or citations.`;
  return {
    actionId,
    issue: start.issue,
    agent,
    stepId,
    evidenceId: definition.evidenceId,
    requiredPath: definition.requiredPath(start.issue, agent, round),
    completePath: runtime.complete,
    branch,
    round,
    issueSessionId: start.issueSessionId,
    baselineSha: start.baselineSha,
    automationDigest: start.automationDigest,
    task: `${definition.task}${BRANCH_PREPARED_NOTE}${binding}${scaffold}${correction}`,
    inputs,
    approvedPaths,
    contextPaths: [...start.contextPaths],
    changeScope,
    activeRoster: [...cursors.activeRoster],
    eligibleChoices,
    expectedSelectedAgents,
    ...(selectedImplementation === null ? {} : { expectedImplementationAgent: selectedImplementation }),
    ...(selectedImplementationSubmission?.productPin === undefined
      ? {}
      : { expectedImplementationPin: selectedImplementationSubmission.productPin }),
    ...(selectedImplementation === null ? {} : { expectedReviser: selectedImplementation })
  };
};

/**
 * The operator-facing sentence for each refusal code. Every code in
 * `GateReason`, `PromptBlockedReason`, and `NudgeWaitCode` has an entry, so a
 * journal line always says what was actually observed.
 */
const DEFERRAL_RATIONALE: Readonly<Record<string, string>> = {
  "pane-dead": "the terminal pane for this agent is gone",
  "owner-typing": "the pane is in copy mode or the owner is typing in it",
  "input-off": "the pane has input disabled",
  "foreground-mismatch": "the foreground process is not this agent's harness",
  "trust-dialog": "the harness is waiting on its trust-this-folder prompt",
  "claude-no-prompt": "no idle prompt is visible in the pane",
  "cursor-turn-chrome": "the pane shows in-flight turn chrome",
  "antigravity-turn-chrome": "the pane shows in-flight turn chrome",
  "antigravity-verify-overlay": "the account-verify overlay is up and discards keystrokes",
  "antigravity-no-prompt": "no idle prompt is visible in the pane",
  "unmatched-action": "the recorded lifecycle action does not match the current one",
  "workflow-complete": "this agent already published its work for this action",
  "pending-input": "the agent has queued input of its own",
  "background-active": "the agent has background work running",
  unknown: "no lifecycle signal has been correlated yet",
  queued: "the agent has accepted work that has not started",
  working: "the agent is mid-turn",
  "idle-transition-already-used": "this action was already delivered on the current idle transition"
};

const deferralRationale = (code: string): string =>
  DEFERRAL_RATIONALE[code] ?? "the terminal or lifecycle layer refused delivery";

export class CoordinatorRunLoop {
  private readonly mirror: BareMirror;
  private readonly tmux: TmuxController | null;
  private readonly processRunner: ProcessRunner;
  private readonly pullRequestOpener: PullRequestOpener;
  private readonly pullRequestMerger: PullRequestMerger;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly actionId: () => string;
  private readonly log: (message: string) => void;
  private readonly verbose: (message: string) => void;
  private readonly observabilityWatchdogMs: number;
  /** Last RN/round announced on `log`, so resume and first prepare do not repeat. */
  private loggedPhaseKey: string | null = null;
  /** Last deferral code printed per `<agent>:<actionId>`, so an unchanged reason stays quiet. */
  private readonly loggedDeferral = new Map<string, string>();

  constructor(readonly paths: IssueRuntimePaths, dependencies: RunLoopDependencies = {}) {
    const start = readStartState(paths);
    this.mirror = dependencies.mirror ?? new BareMirror(paths.mirror, start.origin);
    this.tmux = dependencies.tmux === undefined ? new TmuxController(undefined, paths.tmuxNamespace, undefined, undefined, undefined, paths.terminalGroup) : dependencies.tmux;
    this.processRunner = dependencies.processRunner ?? runArgv;
    this.pullRequestOpener = dependencies.pullRequestOpener ?? openDraftPullRequest;
    this.pullRequestMerger = dependencies.pullRequestMerger ?? mergePullRequest;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.actionId = dependencies.actionId ?? createActionId;
    this.log = dependencies.log ?? ((message) => process.stdout.write(`${message}\n`));
    this.verbose = dependencies.verbose ?? (() => undefined);
    this.observabilityWatchdogMs = dependencies.nudgeRetryMs ?? AGENT_OBSERVABILITY_WATCHDOG_MS;
  }

  async initializeEffects(): Promise<void> {
    const start = readStartState(this.paths);
    const authority = readCursorsState(this.paths);
    this.authority(authority);
    // Resume used to swallow a config read failure to null, and null used to
    // mean "skip the overlay restore entirely". The restore no longer depends on
    // resolving a root — it falls back to the overlay already in the clone — so
    // the remaining job here is to report the failure instead of hiding it.
    //
    // Deliberately not defaulting to this checkout the way `coord start` does:
    // synthesising a root makes the restore render a protocol overlay into
    // clones that were never installed against it, adding an untracked
    // AGENTS.md that an agent's `git add -A` then sweeps into its commit.
    let installRoot: string | null = null;
    if (existsSync(start.configPath)) {
      try {
        installRoot = readConfig(start.configPath).coordination?.installRoot ?? null;
      } catch (error) {
        this.log(
          `could not read ${start.configPath} for the install root ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            "restoring the AGENTS.md overlay from each clone's own copy"
        );
      }
    }
    prepareAgentIssueBranches({
      agents: start.agents,
      issue: start.issue,
      branchTemplate: start.branchTemplate,
      baselineSha: start.baselineSha,
      baseBranch: start.baseBranch,
      installRoot,
      log: (message) => this.log(message.trimEnd())
    });
    this.authority(authority);
    await this.mirror.initialize();
    this.authority(authority);
    if (this.tmux !== null) {
      await this.tmux.ensureSession(start.issue, start.agents, () => this.authority(authority));
      this.authority(authority);
      const opened = await this.tmux.openOwnerAgentClients(start.issue, start.agents, { onlyMissing: true });
      this.authority(authority);
      if (opened.status === "opened" && opened.count > 0) {
        this.log(`Opened ${opened.count} Terminal window(s), one per agent tmux client.`);
      } else if (opened.status === "failed") {
        this.log(`Could not open Terminal windows (${opened.error}). Attach manually with coord attach ${start.issue}.`);
      }
    }
  }

  private authority(cursors: CursorsState, allowCompleted = false): CursorsState {
    const current = readCursorsState(this.paths);
    if (current.stateRevision !== cursors.stateRevision) {
      throw new StateConflictError("Coordinator authority changed during an effect.");
    }
    if (current.paused || current.abandoned || (!allowCompleted && current.completed)) {
      throw new StateConflictError("Coordinator authority no longer permits this effect.");
    }
    return current;
  }

  private mutate(
    cursors: CursorsState,
    mutation: (current: CursorsState) => CursorsState
  ): CursorsState {
    return requireStateMutation(this.paths, cursors.stateRevision, mutation);
  }

  private logPhase(
    issue: number,
    stepId: WorkflowStepId | null,
    round: number | null,
    from?: WorkflowStepId
  ): void {
    const key = `${stepId ?? "complete"}:${round ?? ""}`;
    if (from === undefined && this.loggedPhaseKey === key) return;
    this.loggedPhaseKey = key;
    const to = describeWorkflowStep(stepId, round);
    this.log(from === undefined ? `Issue ${issue}: ${to}` : `Issue ${issue}: ${from} → ${to}`);
  }

  private async prepareAction(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    stepId: WorkflowStepId,
    round: number | null
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined) throw new Error(`Unknown agent ${agent}.`);
    const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, stepId);
    const changeScope = await resolveChangeScope(this.mirror, start, deriveBoundInputs(start, cursors, stepId, round));
    this.authority(cursors);
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      stepId,
      round,
      this.actionId(),
      [],
      approvedPaths,
      changeScope
    );
    const runtime = agentRuntimePaths(this.paths, agent);
    let next = this.mutate(cursors, (current) => {
      writeAction(this.paths.coordRoot, runtime.action, order);
      appendJournal(
        this.paths,
        { type: "action-prepared", agent, actionId: order.actionId, details: { requiredPath: order.requiredPath } },
        this.now()
      );
      return replaceCursor(
        current,
        agent,
        {
          stepId,
          evidenceId: order.evidenceId,
          actionId: order.actionId,
          status: "ordered",
          attempt: cursor.attempt + 1,
          submissionSha: null,
          outstanding: []
        },
        this.now()
      );
    });
    const config = start.agents.find((candidate) => candidate.id === agent);
    const actionDigest = sha256OfFile(runtime.action);
    orderAgentAction(this.paths, agent, order.actionId, actionDigest, this.now());
    if (this.tmux !== null && config !== undefined) {
      const injectionStartedAt = this.now();
      const result = await this.tmux.nudge(
        start.issue,
        config,
        runtime.action,
        () => this.authority(next),
        order.actionId,
        actionDigest
      );
      this.authority(next);
      if (result.status === "sent") {
        markActionInjected(this.paths, agent, order.actionId, actionDigest, injectionStartedAt);
        this.verbose(`nudged ${agent} (${stepId}) → ${runtime.action}`);
        this.loggedDeferral.delete(`${agent}\u0000${order.actionId}`);
        next = this.mutate(next, (current) => {
          appendJournal(
            this.paths,
            {
              type: "nudged",
              agent,
              actionId: order.actionId,
              details: { actionDigest, readiness: result.detail ?? "vendor-prompt" }
            },
            this.now()
          );
          return current;
        });
      } else if (result.status === "gone") {
        this.verbose(`nudge skipped for ${agent}: harness gone (${result.reason})`);
        next = this.mutate(next, (current) => replaceCursor(current, agent, { status: "harness-gone" }, this.now()));
      } else if (result.status === "busy") {
        markActionInjectionDeferred(this.paths, agent, order.actionId, actionDigest, this.now());
        next = this.mutate(next, (current) => {
          this.journalDeferral(
            start,
            current,
            agent,
            order.actionId,
            actionDigest,
            "scrape",
            result.reason,
            deferralRationale(result.reason),
            result.detail
          );
          return current;
        });
      }
    } else {
      this.verbose(`ordered ${agent} (${stepId}) → ${runtime.action}`);
    }
    return next;
  }

  /** Refresh bound paths on an in-flight implement/revise order after extractor upgrades. */
  private async rewriteOrderedAction(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.stepId === null) return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    if (!existsSync(runtime.action)) return cursors;
    const previous = readAction(runtime.action).body;
    const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, cursor.stepId);
    this.authority(cursors);
    const round = cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
    const changeScope = await resolveChangeScope(
      this.mirror,
      start,
      deriveBoundInputs(start, cursors, cursor.stepId, round)
    );
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      cursor.stepId,
      round,
      actionId,
      cursor.outstanding,
      approvedPaths,
      changeScope
    );
    writeAction(this.paths.coordRoot, runtime.action, order);
    if (readAction(runtime.action).body !== previous) {
      this.verbose(`refreshed ${agent} action ${actionId} with current approved paths`);
    }
    return cursors;
  }

  /**
   * Record one delivery refusal with a machine-readable code.
   *
   * Both sides of the disagreement go on a single event: when the pane scrape
   * refuses while hooks say the agent is idle and healthy, `splitBrain` marks
   * it so status and debug do not have to be reconciled across two axes. The
   * line reaches normal stdout when the workflow is actually waiting on this
   * agent or when the two layers disagree; a repeat of an unchanged code stays
   * verbose so a long stall does not flood the operator.
   */
  private journalDeferral(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string,
    actionDigest: string,
    layer: "scrape" | "lifecycle",
    code: string,
    human: string,
    detail?: string
  ): void {
    const entry = readAgentLifecycle(this.paths).agents[agent];
    const splitBrain =
      layer === "scrape" && entry?.execution === "idle" && entry.health !== "degraded";
    // The workflow is blocked on this delivery only while the action is out and
    // unanswered. A deferral for an agent that is verifying or waiting on a peer
    // is background detail, so it belongs in the journal but not on stdout.
    const gateWaiting = cursors.agents[agent]?.status === "ordered";
    appendJournal(
      this.paths,
      {
        type: "nudge-deferred",
        agent,
        actionId,
        details: {
          layer,
          code,
          human,
          ...(detail === undefined ? {} : { detail }),
          ...(splitBrain ? { splitBrain: true } : {}),
          gateWaiting,
          actionDigest,
          hooks: {
            execution: entry?.execution ?? "unknown",
            health: entry?.health ?? "unknown",
            pendingInputCount: entry?.pendingInputCount ?? null,
            backgroundActive: entry?.backgroundActive ?? null
          }
        }
      },
      this.now()
    );
    const key = `${agent}\u0000${actionId}`;
    const repeated = this.loggedDeferral.get(key) === code;
    this.loggedDeferral.set(key, code);
    const detailText = detail === undefined ? "" : ` (${detail})`;
    const message = splitBrain
      ? `Issue ${start.issue}: ${agent} looks idle to its lifecycle hooks but its terminal is not ready to accept typing (${code}${detailText}); ${human}`
      : `Issue ${start.issue}: delivery to ${agent} deferred: ${code}${detailText}; ${human}`;
    if ((gateWaiting || splitBrain) && !repeated) this.log(message);
    else this.verbose(message);
  }

  private async maybeLifecycleNudge(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string,
    reason: "idle" | "reissue" = "idle"
  ): Promise<CursorsState> {
    const config = start.agents.find((candidate) => candidate.id === agent);
    if (config === undefined) return cursors;
    if (config.delivery !== "nudge" && config.delivery !== "both") return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    if (!existsSync(runtime.action)) return cursors;

    if (reason === "idle") {
      cursors = await this.rewriteOrderedAction(start, cursors, agent, actionId);
    }
    const actionDigest = sha256OfFile(runtime.action);
    orderAgentAction(this.paths, agent, actionId, actionDigest, this.now());

    if (reason === "idle") {
      const degraded = markObservabilityDegraded(
        this.paths,
        agent,
        this.now(),
        this.observabilityWatchdogMs
      );
      if (degraded.changed) {
        appendJournal(
          this.paths,
          {
            type: "agent-observability-degraded",
            agent,
            actionId,
            details: { actionDigest, watchdogMs: this.observabilityWatchdogMs, cause: degraded.cause }
          },
          this.now()
        );
        // The watchdog proves correlation lag, not a dead hook bridge. Only an
        // agent that never announced a session gets the restart remedy; telling
        // an operator to restart a healthy CLI kills the turn that was about to
        // write `complete`.
        this.log(
          degraded.cause === "hooks-never-seen"
            ? `Issue ${start.issue}: no lifecycle signal has ever arrived from ${agent}; duplicate send suppressed. ` +
                `Restart ${agent}'s CLI so it loads coordinator lifecycle hooks.`
            : `Issue ${start.issue}: no lifecycle signal correlated with the last delivery to ${agent} within ` +
                `${this.observabilityWatchdogMs}ms; duplicate send suppressed. The agent may still be finishing its ` +
                `previous turn — no action needed unless it stays quiet.`
        );
      }
      const entry = degraded.state.agents[agent];
      if (entry === undefined) return cursors;
      // An action that is still only ordered has never been sent. Retrying a
      // prior busy readiness rejection cannot create a duplicate; tmux
      // must still positively prove the pane is prompt-ready below. Once a
      // send succeeds, only a lifecycle idle transition can authorize more.
      if (entry.action?.delivery !== "ordered" || entry.action.retryableInjectionAt === null) {
        const decision = decideLifecycleNudge(entry, actionId, actionDigest);
        if (decision.kind === "wait") {
          const injected = entry.action;
          const observedAfterInjection =
            injected !== null &&
            injected !== undefined &&
            injected.injectedAt !== null &&
            entry.lastEventAt !== null &&
            Date.parse(entry.lastEventAt) >= Date.parse(injected.injectedAt);
          const tmux = this.tmux;
          // A send that was never accepted and whose watchdog has elapsed can be
          // retried, but only on the positive scrape proof below. Elapsed time
          // and a missing `complete` never authorize a retry on their own.
          const watchdogElapsed =
            injected !== null &&
            injected !== undefined &&
            injected.injectedAt !== null &&
            Date.parse(this.now()) - Date.parse(injected.injectedAt) >= this.observabilityWatchdogMs;
          const canProveLostInjection =
            tmux !== null &&
            injected?.delivery === "injected" &&
            injected.turnId === null &&
            (entry.pendingInputCount ?? 0) === 0 &&
            entry.backgroundActive !== true &&
            ((entry.execution === "queued" && observedAfterInjection) ||
              (entry.execution === "unknown" && entry.health === "degraded") ||
              (entry.execution === "idle" &&
                decision.code === "idle-transition-already-used" &&
                watchdogElapsed));
          if (
            !canProveLostInjection ||
            tmux === null ||
            !(await tmux.actionAbsentAtReadyPrompt(start.issue, config, actionId, () => this.authority(cursors)))
          ) {
            this.journalDeferral(
              start,
              cursors,
              agent,
              actionId,
              actionDigest,
              "lifecycle",
              decision.code,
              deferralRationale(decision.code)
            );
            return cursors;
          }
          this.authority(cursors);
          markInjectedActionAbsent(this.paths, agent, actionId, actionDigest, this.now());
          appendJournal(
            this.paths,
            {
              type: "agent-lifecycle",
              agent,
              actionId,
              details: { actionDigest, event: "prompt-ready-action-absent", execution: entry.execution }
            },
            this.now()
          );
          this.verbose(`retrying ${agent}: ready prompt no longer contains action ${actionId}`);
        }
      }
    }

    if (this.tmux === null) return cursors;
    const injectionStartedAt = this.now();
    const result = await this.tmux.nudge(
      start.issue,
      config,
      runtime.action,
      () => this.authority(cursors),
      actionId,
      actionDigest
    );
    this.authority(cursors);
    if (result.status === "sent") {
      markActionInjected(this.paths, agent, actionId, actionDigest, injectionStartedAt);
      this.verbose(`nudged ${agent} (${reason}) → ${runtime.action}`);
      this.loggedDeferral.delete(`${agent}\u0000${actionId}`);
      return this.mutate(cursors, (current) => {
        appendJournal(
          this.paths,
          {
            type: "nudged",
            agent,
            actionId,
            details: {
              actionDigest,
              readiness: result.detail ?? "vendor-prompt",
              ...(reason === "idle" ? { idle: true } : { reissue: true })
            }
          },
          this.now()
        );
        return current;
      });
    }
    if (result.status === "gone") {
      this.verbose(`nudge ${reason} skipped for ${agent}: harness gone (${result.reason})`);
      return this.mutate(cursors, (current) => replaceCursor(current, agent, { status: "harness-gone" }, this.now()));
    }
    if (result.status === "busy") {
      markActionInjectionDeferred(this.paths, agent, actionId, actionDigest, this.now());
      this.journalDeferral(
        start,
        cursors,
        agent,
        actionId,
        actionDigest,
        "scrape",
        result.reason,
        deferralRationale(result.reason),
        result.detail
      );
    }
    return cursors;
  }

  private accept(start: StartState, cursors: CursorsState, decision: Extract<MachineDecision, { type: "accept-submission" }>): CursorsState {
    const cursor = cursors.agents[decision.agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    const round = cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
    const path = STEP_DEFINITIONS[cursor.stepId].requiredPath(start.issue, decision.agent, round);
    const accepted: AcceptedSubmission = {
      stepId: cursor.stepId,
      agent: decision.agent,
      round,
      submissionSha: decision.submissionSha,
      path,
      acceptedAt: this.now(),
      ...(decision.productPin === undefined ? {} : { productPin: decision.productPin }),
      ...(decision.disposition === undefined ? {} : { disposition: decision.disposition }),
      ...(decision.approvedPaths === undefined ? {} : { approvedPaths: [...decision.approvedPaths] }),
      ...(decision.selectedAgents === undefined ? {} : { selectedAgents: [...decision.selectedAgents] }),
      ...(decision.choice === undefined ? {} : { choice: decision.choice }),
      ...(decision.reviser === undefined ? {} : { reviser: decision.reviser }),
      ...(decision.checkResults === undefined
        ? {}
        : { checkResults: decision.checkResults.map((result) => ({ ...result, argv: [...result.argv] })) })
    };
    const withoutPrior = cursors.accepted.filter(
      (item) => !(item.stepId === accepted.stepId && item.agent === accepted.agent && item.round === accepted.round)
    );
    const next = this.mutate(cursors, (current) => {
      if (decision.reviser !== undefined && !current.activeRoster.includes(decision.reviser)) {
        throw new Error(`authorized reviser ${decision.reviser} is not active`);
      }
      appendJournal(
        this.paths,
        {
          type: "verify-result",
          agent: decision.agent,
          actionId: cursor.actionId as string,
          submissionSha: decision.submissionSha,
          details: { ok: true }
        },
        this.now()
      );
      const runtime = agentRuntimePaths(this.paths, decision.agent);
      clearCompletion(runtime.complete);
      if (existsSync(runtime.action)) unlinkSync(runtime.action);
      const selection =
        accepted.stepId === "R3.publish-selection"
          ? { ...current.selection, planAgents: [...(accepted.selectedAgents ?? [])] }
          : accepted.stepId === "R5.reviser-auth"
            ? {
                ...current.selection,
                implementationAgent:
                  current.accepted.find(
                    (submission) =>
                      submission.stepId === "R4.implement" && submission.productPin === accepted.productPin
                  )?.agent ?? null,
                implementationPin: accepted.productPin ?? null,
                reviser: accepted.reviser ?? null
              }
            : current.selection;
      const publication =
        accepted.stepId === "R7.finalize" && accepted.productPin !== undefined
          ? {
              status: "pending" as const,
              finalSha: accepted.productPin,
              branch: `${start.branchTemplate
                .replaceAll("{issue}", String(start.issue))
                .replaceAll("{agent}", decision.agent)}-final`,
              url: null,
              error: null,
              attempts: current.publication.attempts
            }
          : current.publication;
      if (publication.status === "pending") {
        appendJournal(
          this.paths,
          {
            type: "publication-pending",
            agent: decision.agent,
            actionId: cursor.actionId as string,
            details: { finalSha: publication.finalSha, branch: publication.branch }
          },
          this.now()
        );
      }
      return cursorsStateSchema.parse({
        ...current,
        reviser: accepted.reviser ?? current.reviser,
        selection,
        publication,
        agents: {
          ...current.agents,
          [decision.agent]: {
            ...cursor,
            actionId: null,
            status: "waiting-peer",
            submissionSha: null,
            outstanding: [],
            updatedAt: this.now()
          }
        },
        accepted: [...withoutPrior, accepted],
        updatedAt: this.now()
      });
    });
    const completion = markActionWorkflowComplete(this.paths, decision.agent, cursor.actionId, this.now());
    if (completion.clearedDegraded) {
      // The agent published and pushed, so the earlier watchdog warning is
      // disproven. Retract it explicitly rather than leaving it standing.
      appendJournal(
        this.paths,
        {
          type: "agent-observability-recovered",
          agent: decision.agent,
          actionId: cursor.actionId,
          details: { reason: "workflow-complete-after-degraded" }
        },
        this.now()
      );
      this.log(
        `Issue ${start.issue}: ${decision.agent} completed its work; the earlier lifecycle warning is cleared.`
      );
    }
    return next;
  }

  private async reissue(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    outstanding: readonly string[]
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    const actionId = cursor.actionId;
    const stepId = cursor.stepId;
    const round = stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
    const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, stepId);
    const changeScope = await resolveChangeScope(this.mirror, start, deriveBoundInputs(start, cursors, stepId, round));
    this.authority(cursors);
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      stepId,
      round,
      actionId,
      outstanding,
      approvedPaths,
      changeScope
    );
    this.verbose(`reissued ${agent} action ${actionId}: ${outstanding.join("; ")}`);
    const next = this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        { type: "verify-result", agent, actionId, details: { ok: false, outstanding } },
        this.now()
      );
      clearCompletion(runtime.complete);
      writeAction(this.paths.coordRoot, runtime.action, order);
      return replaceCursor(
        current,
        agent,
        { status: "ordered", attempt: cursor.attempt + 1, submissionSha: null, outstanding: [...outstanding] },
        this.now()
      );
    });
    return this.maybeLifecycleNudge(start, next, agent, actionId, "reissue");
  }

  private advance(cursors: CursorsState, decision: Extract<MachineDecision, { type: "advance-step" }>): CursorsState {
    const agents = { ...cursors.agents };
    for (const agent of cursors.activeRoster) {
      const cursor = agents[agent];
      if (cursor !== undefined) {
        agents[agent] = {
          ...cursor,
          stepId: decision.to,
          evidenceId: decision.to === null ? null : STEP_DEFINITIONS[decision.to].evidenceId,
          actionId: null,
          status: decision.to === null ? "complete" : "idle",
          submissionSha: null,
          outstanding: [],
          updatedAt: this.now()
        };
      }
    }
    const issueCursor =
      decision.to === null
        ? cursors.issueCursor
        : { stepId: decision.to, gateId: STEP_DEFINITIONS[decision.to].gateId, round: decision.round };
    return this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        { type: "gate-advanced", details: { from: decision.from, to: decision.to, round: decision.round } },
        this.now()
      );
      return cursorsStateSchema.parse({
        ...current,
        issueCursor,
        completed: decision.to === null,
        agents,
        updatedAt: this.now()
      });
    });
  }

  async verifyFinalizationChecks(
    start: StartState,
    order: InternalOrder,
    observation: EvidenceObservation,
    cursors: CursorsState
  ): Promise<EvidenceObservation> {
    if (observation.status !== "satisfied" || order.stepId !== "R7.finalize" || observation.productPin === undefined) return observation;
    const consensusSha = order.inputs.find((input) => input.kind === "consensus")?.commitSha;
    if (consensusSha === undefined) return { ...observation, status: "rejected", outstanding: ["no consensus pin is bound to finalization"] };
    const verified = verifyFinalization({ root: this.mirror.path, issue: start.issue, consensusSha, finalSha: observation.productPin });
    if (!verified.ok) return { ...observation, status: "rejected", outstanding: [verified.details] };

    const target = containedPath(this.paths.issueRoot, `.verification-${randomUUID()}`);
    const checkResults: Array<{ name: string; argv: string[]; exitCode: number }> = [];
    try {
      this.authority(cursors);
      await this.mirror.materializeWorktree(target, observation.productPin);
      this.authority(cursors);
      for (const check of start.checks) {
        this.authority(cursors);
        const argv = check.argv.map((argument) => argument.replaceAll("{worktree}", target));
        const result = await this.processRunner(argv, target);
        this.authority(cursors);
        checkResults.push({ name: check.name, argv, exitCode: result.exitCode });
        appendJournal(
          this.paths,
          {
            type: "final-check",
            agent: order.agent,
            actionId: order.actionId,
            // The tier is recorded because two different suites can fail the
            // same project: the agent's own clone runs the declared `verify`
            // before a commit exists, and this runs the declared `checks`
            // hermetically at the approved commit. Only the second one reaches
            // the journal, and saying so is what makes the distinction legible.
            details: { tier: "checks", name: check.name, argv, exitCode: result.exitCode }
          },
          this.now()
        );
        if (result.exitCode !== 0) {
          return {
            ...observation,
            status: "rejected",
            outstanding: [
              `finalization check (tier: checks) ${check.name} failed with exit ${result.exitCode}: ${result.stderr.trim()}`
            ]
          };
        }
      }
    } finally {
      await this.mirror.removeWorktree(target);
      rmSync(target, { recursive: true, force: true });
    }
    return { ...observation, checkResults };
  }

  private async publishAcceptedFinalization(start: StartState, cursors: CursorsState): Promise<CursorsState> {
    if (cursors.publication.status !== "pending" && cursors.publication.status !== "failed") return cursors;
    const { finalSha, branch } = cursors.publication;
    const authority = this.authority(cursors, true);
    let openedUrl = cursors.publication.url;
    try {
      if (finalSha === null || branch === null) throw new Error("Pending publication is missing its final pin or branch.");
      const repository = githubRepositoryFromOrigin(start.origin);
      if (repository === null) throw new Error(`Cannot derive a GitHub repository from origin ${start.origin}.`);
      const issueSnapshot = readGitHubIssueSnapshot(this.paths.issueSnapshot);
      if (issueSnapshot.number !== start.issue) {
        throw new Error(
          `GitHub issue snapshot number ${issueSnapshot.number} does not match start issue ${start.issue}.`
        );
      }
      await this.mirror.publishBranch(finalSha, branch);
      this.authority(authority, true);
      const draft = !coordMergesPullRequest(start.prPolicy);
      const { title, body } = formatFinalizationPullRequest({
        issue: start.issue,
        title: issueSnapshot.title,
        finalSha,
        draft
      });
      const result = await this.pullRequestOpener({
        repository,
        base: start.baseBranch,
        head: branch,
        title,
        body,
        draft
      });
      openedUrl = result.url;
      this.authority(authority, true);
      if (coordMergesPullRequest(start.prPolicy)) {
        await this.pullRequestMerger({ url: result.url });
        this.authority(authority, true);
      }
      return this.mutate(authority, (current) => {
        appendJournal(
          this.paths,
          { type: "pr-created", agent: current.selection.reviser ?? undefined, details: { url: result.url, branch, finalSha } },
          this.now()
        );
        if (coordMergesPullRequest(start.prPolicy)) {
          appendJournal(this.paths, { type: "pr-merged", details: { url: result.url, branch, finalSha } }, this.now());
        }
        return cursorsStateSchema.parse({
          ...current,
          publication: {
            status: "completed",
            finalSha,
            branch,
            url: result.url,
            error: null,
            attempts: current.publication.attempts + 1
          },
          updatedAt: this.now()
        });
      });
    } catch (error) {
      const latest = readCursorsState(this.paths);
      if (latest.stateRevision !== authority.stateRevision || latest.paused || latest.abandoned) return latest;
      const message = error instanceof Error ? error.message : String(error);
      this.log(`Owner action required: finalization publication failed: ${message}`);
      return this.mutate(latest, (current) => {
        appendJournal(
          this.paths,
          { type: "publication-failed", details: { error: message, branch, finalSha, url: openedUrl } },
          this.now()
        );
        return cursorsStateSchema.parse({
          ...current,
          publication: {
            status: "failed",
            finalSha,
            branch,
            url: openedUrl,
            error: message,
            attempts: current.publication.attempts + 1
          },
          updatedAt: this.now()
        });
      });
    }
  }

  private async applyDecisions(start: StartState, cursors: CursorsState, decisions: readonly MachineDecision[]): Promise<CursorsState> {
    let next = cursors;
    for (const decision of decisions) {
      if (decision.type === "prepare-action") {
        this.logPhase(start.issue, decision.stepId, decision.round);
        next = await this.prepareAction(start, next, decision.agent, decision.stepId, decision.round);
      } else if (decision.type === "accept-submission") next = this.accept(start, next, decision);
      else if (decision.type === "reissue-action") next = await this.reissue(start, next, decision.agent, decision.outstanding);
      else if (decision.type === "retry-verification") {
        next = this.mutate(next, (current) =>
          replaceCursor(current, decision.agent, { status: "intent", outstanding: [...decision.outstanding] }, this.now())
        );
      } else if (decision.type === "advance-step") {
        this.logPhase(start.issue, decision.to, decision.round, decision.from);
        next = this.advance(next, decision);
      } else if (decision.type === "owner-action-required") {
        if (next.ownerQuestion === null) {
          next = this.mutate(next, (current) => {
            const id = this.actionId();
            appendJournal(
              this.paths,
              {
                type: "owner-question",
                details: {
                  id,
                  kind: decision.kind,
                  round: decision.round,
                  allowedAnswers: decision.allowedAnswers,
                  reason: decision.reason
                }
              },
              this.now()
            );
            return cursorsStateSchema.parse({
              ...current,
              ownerQuestion: {
                id,
                kind: decision.kind,
                round: decision.round,
                allowedAnswers: [...decision.allowedAnswers],
                createdAt: this.now()
              },
              updatedAt: this.now()
            });
          });
        }
        this.log(
          `Owner action required: ${decision.reason}. Answer with: coord answer ${next.ownerQuestion?.id ?? "<question-id>"} <${decision.allowedAnswers.join("|")}>`
        );
      }
    }
    return next;
  }

  async runTick(): Promise<CursorsState> {
    const start = readStartState(this.paths);
    try {
      let cursors = readCursorsState(this.paths);
      if (cursors.paused || cursors.abandoned || cursors.completed) return cursors;
      const observations: EvidenceObservation[] = [];

      for (const dropped of cursors.droppedAgents) clearCompletion(agentRuntimePaths(this.paths, dropped).complete);
      for (const agent of cursors.activeRoster) {
      const cursor = cursors.agents[agent];
      if (cursor === undefined || cursor.actionId === null || cursor.stepId === null) continue;
      const runtime = agentRuntimePaths(this.paths, agent);
      const completion = readCompletion(runtime.complete);
      if (completion.status === "missing") {
        let harnessGone = cursor.status === "harness-gone";
        if (this.tmux !== null) {
          const pane = await this.tmux.inspectPane(this.tmux.target(start.issue, agent));
          this.authority(cursors);
          if (!pane.alive) {
            harnessGone = true;
            cursors = this.mutate(cursors, (current) =>
              replaceCursor(current, agent, { status: "harness-gone" }, this.now())
            );
          } else if (cursor.status === "ordered") {
            cursors = await this.maybeLifecycleNudge(start, cursors, agent, cursor.actionId);
          }
        }
        if (harnessGone) {
          const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, cursor.stepId);
          this.authority(cursors);
          const order = buildOrder(
            this.paths,
            start,
            cursors,
            agent,
            cursor.stepId,
            cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null,
            cursor.actionId,
            cursor.outstanding,
            approvedPaths
          );
          const fetched = await this.mirror.fetchBranch(order.branch);
          this.authority(cursors);
          if (fetched.ok) {
            let observation = await evaluateEvidence(order, fetched.tip, this.mirror as EvidenceMirror, () =>
              this.authority(cursors)
            );
            this.authority(cursors);
            observation = await this.verifyFinalizationChecks(start, order, observation, cursors);
            this.authority(cursors);
            if (observation.status === "satisfied") {
              cursors = this.mutate(cursors, (current) => {
                appendJournal(
                  this.paths,
                  {
                    type: "intent-seen",
                    agent,
                    actionId: cursor.actionId as string,
                    submissionSha: fetched.tip,
                    details: { pushedThenDied: true }
                  },
                  this.now()
                );
                return current;
              });
              observations.push(observation);
            } else if (observation.status === "rejected") {
              this.log(`Owner action required: ${agent} harness is gone and origin tip is incomplete: ${observation.outstanding.join("; ")}`);
            }
          }
        }
        continue;
      }
      if (completion.status === "malformed") {
        cursors = await this.reissue(start, cursors, agent, [completion.message]);
        continue;
      }
      cursors = this.mutate(cursors, (current) => {
        appendJournal(
          this.paths,
          { type: "intent-seen", agent, actionId: cursor.actionId as string, submissionSha: completion.sha, details: {} },
          this.now()
        );
        return replaceCursor(current, agent, { status: "verifying", submissionSha: completion.sha }, this.now());
      });
      const approvedPaths = await resolveApprovedPaths(this.mirror, cursors, cursor.stepId);
      this.authority(cursors);
      const order = buildOrder(
        this.paths,
        start,
        cursors,
        agent,
        cursor.stepId,
        cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null,
        cursor.actionId,
        cursor.outstanding,
        approvedPaths
      );
      let observation = await evaluateEvidence(order, completion.sha, this.mirror as EvidenceMirror, () =>
        this.authority(cursors)
      );
      this.authority(cursors);
      observation = await this.verifyFinalizationChecks(start, order, observation, cursors);
      this.authority(cursors);
      observations.push(observation);
      }

      if (observations.length > 0) cursors = await this.applyDecisions(start, cursors, decide({ start, cursors, observations }));
      if (cursors.publication.status === "pending" || cursors.publication.status === "failed") {
        cursors = await this.publishAcceptedFinalization(start, cursors);
        if (cursors.publication.status !== "completed") return cursors;
      }

      for (let progress = 0; progress < 4; progress += 1) {
        const decisions = decide({ start, cursors }).filter((decision) => decision.type !== "wait");
        if (decisions.length === 0) break;
        cursors = await this.applyDecisions(start, cursors, decisions);
        if (cursors.publication.status === "pending" || cursors.publication.status === "failed") {
          cursors = await this.publishAcceptedFinalization(start, cursors);
          if (cursors.publication.status !== "completed") return cursors;
        }
        if (decisions.every((decision) => decision.type === "owner-action-required")) break;
      }
      const waiting = cursors.activeRoster
        .map((agent) => {
          const cursor = cursors.agents[agent];
          if (cursor === undefined) return null;
          if (cursor.status === "idle" && cursor.actionId === null) return null;
          return `${agent}=${cursor.status}${cursor.outstanding.length > 0 ? `(${cursor.outstanding[0]})` : ""}`;
        })
        .filter((item): item is string => item !== null);
      this.verbose(
        `tick ${cursors.issueCursor.stepId ?? "done"} roster=${cursors.activeRoster.join(",")} waiting=${waiting.join(";") || "none"}`
      );
      return cursors;
    } catch (error) {
      if (error instanceof StateConflictError) return readCursorsState(this.paths);
      throw error;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const start = readStartState(this.paths);
    const beforeEffects = readCursorsState(this.paths);
    if (beforeEffects.completed || beforeEffects.abandoned || beforeEffects.paused) {
      this.log(renderIssueReport(start, beforeEffects).trimEnd());
      return;
    }
    this.logPhase(start.issue, beforeEffects.issueCursor.stepId, beforeEffects.issueCursor.round);
    await this.initializeEffects();
    while (signal?.aborted !== true) {
      const cursors = await this.runTick();
      if (cursors.completed || cursors.abandoned || cursors.paused) {
        this.log(renderIssueReport(start, cursors).trimEnd());
        return;
      }
      await this.sleep(start.pollIntervalMs);
    }
  }
}
