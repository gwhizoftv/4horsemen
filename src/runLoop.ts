import { randomUUID } from "node:crypto";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { clearCompletion, createActionId, readCompletion, writeAction } from "./action.js";
import { computeInputSetHash, evaluateEvidence, type EvidenceMirror } from "./evidence.js";
import { verifyFinalization } from "./finalization.js";
import { BareMirror, hermeticGitEnv } from "./mirror.js";
import { agentRuntimePaths, containedPath, type IssueRuntimePaths } from "./paths.js";
import { decide } from "./machine.js";
import {
  appendJournal,
  cursorsStateSchema,
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
  STEP_DEFINITIONS,
  type BoundInput,
  type EvidenceObservation,
  type InternalOrder,
  type MachineDecision,
  type WorkflowStepId
} from "./steps.js";
import { TmuxController } from "./tmux.js";
import { githubRepositoryFromOrigin } from "./githubIssue.js";

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

export type PullRequestInput = { repository: string; base: string; head: string; title: string; body: string };
export type PullRequestOpener = (input: PullRequestInput) => Promise<{ url: string }>;

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
      "--draft",
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
  if (result.exitCode !== 0) throw new Error(`draft PR creation failed: ${result.stderr.trim()}`);
  return { url: result.stdout.trim() };
};

export { githubRepositoryFromOrigin } from "./githubIssue.js";

export type RunLoopDependencies = {
  mirror?: BareMirror;
  tmux?: TmuxController | null;
  processRunner?: ProcessRunner;
  pullRequestOpener?: PullRequestOpener;
  now?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  actionId?: () => string;
  log?: (message: string) => void;
};

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

const approvedPathsForOrder = (cursors: CursorsState, stepId: WorkflowStepId): string[] => {
  if (stepId !== "R4.implement" && stepId !== "R6.revise") return [];
  const selection = acceptedAt(cursors, "R3.publish-selection", false).at(-1);
  const selected = cursors.selection.planAgents.filter((agent) => cursors.activeRoster.includes(agent));
  const selectedAgents = selected.length > 0 ? selected : (selection?.selectedAgents ?? cursors.activeRoster);
  return [
    ...new Set(
      acceptedAt(cursors, "R2.plan")
        .filter((submission) => selectedAgents.includes(submission.agent))
        .flatMap((submission) => submission.approvedPaths ?? [])
    )
  ].sort();
};

export const buildOrder = (
  paths: IssueRuntimePaths,
  start: StartState,
  cursors: CursorsState,
  agent: string,
  stepId: WorkflowStepId,
  round: number | null,
  actionId = createActionId(),
  outstanding: readonly string[] = []
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
  const jsonSteps: readonly WorkflowStepId[] = [
    "R1.join",
    "R3.plan-ballot",
    "R3.publish-selection",
    "R4.implement",
    "R5.compare-ballot",
    "R5.reviser-auth",
    "R6.revise",
    "R6.ballot",
    "R6.declare",
    "R7.finalize"
  ];
  const binding = jsonSteps.includes(stepId)
    ? `\n\nUse protocolVersion 1, issue ${start.issue}, issueSessionId \`${start.issueSessionId}\`, and agent \`${agent}\`.` +
      (stepId === "R1.join"
        ? ` Set baselineSha to \`${start.baselineSha}\` and automationDigest to \`${start.automationDigest}\`.`
        : ` Set inputSetHash to \`${computeInputSetHash(inputs)}\` when that field is required.`)
    : "";
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
    task: `${definition.task}${binding}${correction}`,
    inputs,
    approvedPaths: approvedPathsForOrder(cursors, stepId),
    activeRoster: [...cursors.activeRoster],
    eligibleChoices:
      stepId === "R3.plan-ballot"
        ? planChoices
        : stepId === "R5.compare-ballot"
          ? implementationChoices
          : [],
    expectedSelectedAgents: selectedPlan === null ? [] : [selectedPlan],
    ...(selectedImplementation === null ? {} : { expectedImplementationAgent: selectedImplementation }),
    ...(selectedImplementationSubmission?.productPin === undefined
      ? {}
      : { expectedImplementationPin: selectedImplementationSubmission.productPin }),
    ...(selectedImplementation === null ? {} : { expectedReviser: selectedImplementation })
  };
};

export class CoordinatorRunLoop {
  private readonly mirror: BareMirror;
  private readonly tmux: TmuxController | null;
  private readonly processRunner: ProcessRunner;
  private readonly pullRequestOpener: PullRequestOpener;
  private readonly now: () => string;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly actionId: () => string;
  private readonly log: (message: string) => void;
  /** Action ids that received a successful tmux paste in this process. */
  private readonly nudgedActions = new Set<string>();

  constructor(readonly paths: IssueRuntimePaths, dependencies: RunLoopDependencies = {}) {
    const start = readStartState(paths);
    this.mirror = dependencies.mirror ?? new BareMirror(paths.mirror, start.origin);
    this.tmux = dependencies.tmux === undefined ? new TmuxController(undefined, paths.tmuxNamespace) : dependencies.tmux;
    this.processRunner = dependencies.processRunner ?? runArgv;
    this.pullRequestOpener = dependencies.pullRequestOpener ?? openDraftPullRequest;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.actionId = dependencies.actionId ?? createActionId;
    this.log = dependencies.log ?? ((message) => process.stdout.write(`${message}\n`));
  }

  async initializeEffects(): Promise<void> {
    const start = readStartState(this.paths);
    const authority = readCursorsState(this.paths);
    this.authority(authority);
    await this.mirror.initialize();
    this.authority(authority);
    if (this.tmux !== null) {
      await this.tmux.ensureSession(start.issue, start.agents, () => this.authority(authority));
      this.authority(authority);
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

  private async prepareAction(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    stepId: WorkflowStepId,
    round: number | null
  ): Promise<CursorsState> {
    const cursor = cursors.agents[agent];
    if (cursor === undefined) throw new Error(`Unknown agent ${agent}.`);
    const order = buildOrder(this.paths, start, cursors, agent, stepId, round, this.actionId());
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
    if (this.tmux !== null && config !== undefined) {
      const result = await this.tmux.nudge(start.issue, config, runtime.action, () => this.authority(next));
      this.authority(next);
      if (result === "sent") {
        this.nudgedActions.add(order.actionId);
        next = this.mutate(next, (current) => {
          appendJournal(this.paths, { type: "nudged", agent, actionId: order.actionId, details: {} }, this.now());
          return current;
        });
      } else if (result === "gone") {
        next = this.mutate(next, (current) => replaceCursor(current, agent, { status: "harness-gone" }, this.now()));
      }
    }
    return next;
  }

  private async maybeRetryNudge(
    start: StartState,
    cursors: CursorsState,
    agent: string,
    actionId: string
  ): Promise<CursorsState> {
    if (this.tmux === null || this.nudgedActions.has(actionId)) return cursors;
    const config = start.agents.find((candidate) => candidate.id === agent);
    if (config === undefined) return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    if (!existsSync(runtime.action)) return cursors;
    const result = await this.tmux.nudge(start.issue, config, runtime.action, () => this.authority(cursors));
    this.authority(cursors);
    if (result === "sent") {
      this.nudgedActions.add(actionId);
      return this.mutate(cursors, (current) => {
        appendJournal(this.paths, { type: "nudged", agent, actionId, details: { retry: true } }, this.now());
        return current;
      });
    }
    if (result === "gone") {
      return this.mutate(cursors, (current) => replaceCursor(current, agent, { status: "harness-gone" }, this.now()));
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
    return this.mutate(cursors, (current) => {
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
        accepted.stepId === "R7.finalize" && start.prPolicy === "coord-open-unmerged" && accepted.productPin !== undefined
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
  }

  private reissue(start: StartState, cursors: CursorsState, agent: string, outstanding: readonly string[]): CursorsState {
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    const order = buildOrder(
      this.paths,
      start,
      cursors,
      agent,
      cursor.stepId,
      cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null,
      cursor.actionId,
      outstanding
    );
    return this.mutate(cursors, (current) => {
      appendJournal(
        this.paths,
        { type: "verify-result", agent, actionId: cursor.actionId as string, details: { ok: false, outstanding } },
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
    if (start.prPolicy !== "coord-open-unmerged") return cursors;
    if (cursors.publication.status !== "pending" && cursors.publication.status !== "failed") return cursors;
    const { finalSha, branch } = cursors.publication;
    const authority = this.authority(cursors, true);
    try {
      if (finalSha === null || branch === null) throw new Error("Pending publication is missing its final pin or branch.");
      const repository = githubRepositoryFromOrigin(start.origin);
      if (repository === null) throw new Error(`Cannot derive a GitHub repository from origin ${start.origin}.`);
      await this.mirror.publishBranch(finalSha, branch);
      this.authority(authority, true);
      const result = await this.pullRequestOpener({
        repository,
        base: start.baseBranch,
        head: branch,
        title: `Issue ${start.issue}: coordinated implementation`,
        body: `Automated draft PR for issue ${start.issue}. Merge remains owner-only. Final pin: ${finalSha}.`
      });
      this.authority(authority, true);
      return this.mutate(authority, (current) => {
        appendJournal(
          this.paths,
          { type: "pr-created", agent: current.selection.reviser ?? undefined, details: { url: result.url, branch, finalSha } },
          this.now()
        );
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
          { type: "publication-failed", details: { error: message, branch, finalSha } },
          this.now()
        );
        return cursorsStateSchema.parse({
          ...current,
          publication: {
            status: "failed",
            finalSha,
            branch,
            url: null,
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
      if (decision.type === "prepare-action") next = await this.prepareAction(start, next, decision.agent, decision.stepId, decision.round);
      else if (decision.type === "accept-submission") next = this.accept(start, next, decision);
      else if (decision.type === "reissue-action") next = this.reissue(start, next, decision.agent, decision.outstanding);
      else if (decision.type === "retry-verification") {
        next = this.mutate(next, (current) =>
          replaceCursor(current, decision.agent, { status: "intent", outstanding: [...decision.outstanding] }, this.now())
        );
      } else if (decision.type === "advance-step") next = this.advance(next, decision);
      else if (decision.type === "owner-action-required") {
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
            cursors = await this.maybeRetryNudge(start, cursors, agent, cursor.actionId);
          }
        }
        if (harnessGone) {
          const order = buildOrder(
            this.paths,
            start,
            cursors,
            agent,
            cursor.stepId,
            cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null,
            cursor.actionId,
            cursor.outstanding
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
        cursors = this.reissue(start, cursors, agent, [completion.message]);
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
      const order = buildOrder(
        this.paths,
        start,
        cursors,
        agent,
        cursor.stepId,
        cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null,
        cursor.actionId,
        cursor.outstanding
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
      return cursors;
    } catch (error) {
      if (error instanceof StateConflictError) return readCursorsState(this.paths);
      throw error;
    }
  }

  async run(signal?: AbortSignal): Promise<void> {
    const start = readStartState(this.paths);
    const beforeEffects = readCursorsState(this.paths);
    if (beforeEffects.completed || beforeEffects.abandoned || beforeEffects.paused) return;
    await this.initializeEffects();
    while (signal?.aborted !== true) {
      const cursors = await this.runTick();
      if (cursors.completed || cursors.abandoned || cursors.paused) return;
      await this.sleep(start.pollIntervalMs);
    }
  }
}
