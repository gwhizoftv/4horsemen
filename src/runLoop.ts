import { randomUUID } from "node:crypto";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { clearCompletion, createActionId, readCompletion, writeAction } from "./action.js";
import { computeInputSetHash, evaluateEvidence, type EvidenceMirror } from "./evidence.js";
import { verifyFinalization } from "./finalization.js";
import { BareMirror } from "./mirror.js";
import { agentRuntimePaths, containedPath, type IssueRuntimePaths } from "./paths.js";
import { decide } from "./machine.js";
import {
  appendJournal,
  cursorsStateSchema,
  readCursorsState,
  readJournal,
  readStartState,
  replaceCursor,
  writeCursorsState,
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

export type ProcessResult = { exitCode: number; stdout: string; stderr: string };
export type ProcessRunner = (argv: readonly string[], cwd: string) => Promise<ProcessResult>;

export const runArgv: ProcessRunner = (argv, cwd) =>
  new Promise((resolvePromise, reject) => {
    const [command, ...args] = argv;
    if (command === undefined) {
      reject(new Error("Cannot run an empty argv."));
      return;
    }
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
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

export const githubRepositoryFromOrigin = (origin: string): string | null => {
  const https = /^https:\/\/github\.com\/([^/]+\/[^/]+)$/.exec(origin);
  if (https?.[1] !== undefined) return https[1].replace(/\.git$/, "");
  const ssh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(origin);
  return ssh?.[1]?.replace(/\.git$/, "") ?? null;
};

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
    const selection = acceptedAt(cursors, "R3.publish-selection", false).at(-1);
    const selected = selection?.selectedAgents?.filter((agent) => cursors.activeRoster.includes(agent));
    const planAgents = selected !== undefined && selected.length > 0 ? selected : [cursors.reviser ?? cursors.activeRoster[0] as string];
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
    return acceptedAt(cursors, "R4.implement").map((value) => inputFromSubmission(value, "implementation", true));
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
  const selected = selection?.selectedAgents?.filter((agent) => cursors.activeRoster.includes(agent));
  const selectedAgents = selected !== undefined && selected.length > 0 ? selected : cursors.activeRoster;
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
    approvedPaths: approvedPathsForOrder(cursors, stepId)
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

  constructor(readonly paths: IssueRuntimePaths, dependencies: RunLoopDependencies = {}) {
    const start = readStartState(paths);
    this.mirror = dependencies.mirror ?? new BareMirror(paths.mirror, start.origin);
    this.tmux = dependencies.tmux === undefined ? new TmuxController() : dependencies.tmux;
    this.processRunner = dependencies.processRunner ?? runArgv;
    this.pullRequestOpener = dependencies.pullRequestOpener ?? openDraftPullRequest;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.sleep = dependencies.sleep ?? ((milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)));
    this.actionId = dependencies.actionId ?? createActionId;
    this.log = dependencies.log ?? ((message) => process.stdout.write(`${message}\n`));
  }

  async initializeEffects(): Promise<void> {
    const start = readStartState(this.paths);
    await this.mirror.initialize();
    if (this.tmux !== null) await this.tmux.ensureSession(start.issue, start.agents);
  }

  private persist(cursors: CursorsState): CursorsState {
    writeCursorsState(this.paths, cursors);
    return cursors;
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
    writeAction(this.paths.coordRoot, runtime.action, order);
    appendJournal(
      this.paths,
      { type: "action-prepared", agent, actionId: order.actionId, details: { requiredPath: order.requiredPath } },
      this.now()
    );
    let next = replaceCursor(
      cursors,
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
    next = this.persist(next);
    const config = start.agents.find((candidate) => candidate.id === agent);
    if (this.tmux !== null && config !== undefined) {
      const result = await this.tmux.nudge(start.issue, config, runtime.action);
      if (result === "sent") {
        appendJournal(this.paths, { type: "nudged", agent, actionId: order.actionId, details: {} }, this.now());
      } else if (result === "gone") {
        next = this.persist(replaceCursor(next, agent, { status: "harness-gone" }, this.now()));
      }
    }
    return next;
  }

  private accept(start: StartState, cursors: CursorsState, decision: Extract<MachineDecision, { type: "accept-submission" }>): CursorsState {
    const cursor = cursors.agents[decision.agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    const round = cursor.stepId.startsWith("R6.") ? (cursors.issueCursor.round ?? 1) : null;
    const path = STEP_DEFINITIONS[cursor.stepId].requiredPath(start.issue, decision.agent, round);
    appendJournal(
      this.paths,
      {
        type: "verify-result",
        agent: decision.agent,
        actionId: cursor.actionId,
        submissionSha: decision.submissionSha,
        details: { ok: true }
      },
      this.now()
    );
    const runtime = agentRuntimePaths(this.paths, decision.agent);
    clearCompletion(runtime.complete);
    if (existsSync(runtime.action)) unlinkSync(runtime.action);
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
      ...(decision.selectedAgents === undefined ? {} : { selectedAgents: [...decision.selectedAgents] })
    };
    const withoutPrior = cursors.accepted.filter(
      (item) => !(item.stepId === accepted.stepId && item.agent === accepted.agent && item.round === accepted.round)
    );
    return this.persist(
      cursorsStateSchema.parse({
        ...cursors,
        agents: {
          ...cursors.agents,
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
      })
    );
  }

  private reissue(start: StartState, cursors: CursorsState, agent: string, outstanding: readonly string[]): CursorsState {
    const cursor = cursors.agents[agent];
    if (cursor === undefined || cursor.stepId === null || cursor.actionId === null) return cursors;
    const runtime = agentRuntimePaths(this.paths, agent);
    appendJournal(
      this.paths,
      { type: "verify-result", agent, actionId: cursor.actionId, details: { ok: false, outstanding } },
      this.now()
    );
    clearCompletion(runtime.complete);
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
    writeAction(this.paths.coordRoot, runtime.action, order);
    return this.persist(
      replaceCursor(
        cursors,
        agent,
        { status: "ordered", attempt: cursor.attempt + 1, submissionSha: null, outstanding: [...outstanding] },
        this.now()
      )
    );
  }

  private advance(cursors: CursorsState, decision: Extract<MachineDecision, { type: "advance-step" }>): CursorsState {
    appendJournal(
      this.paths,
      { type: "gate-advanced", details: { from: decision.from, to: decision.to, round: decision.round } },
      this.now()
    );
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
    return this.persist(
      cursorsStateSchema.parse({
        ...cursors,
        issueCursor,
        completed: decision.to === null,
        agents,
        updatedAt: this.now()
      })
    );
  }

  private async verifyFinalizationChecks(
    start: StartState,
    order: InternalOrder,
    observation: EvidenceObservation
  ): Promise<EvidenceObservation> {
    if (observation.status !== "satisfied" || order.stepId !== "R7.finalize" || observation.productPin === undefined) return observation;
    const consensusSha = order.inputs.find((input) => input.kind === "consensus")?.commitSha;
    if (consensusSha === undefined) return { ...observation, status: "rejected", outstanding: ["no consensus pin is bound to finalization"] };
    const verified = verifyFinalization({ root: this.mirror.path, issue: start.issue, consensusSha, finalSha: observation.productPin });
    if (!verified.ok) return { ...observation, status: "rejected", outstanding: [verified.details] };

    const target = containedPath(this.paths.issueRoot, `.verification-${randomUUID()}`);
    try {
      await this.mirror.materializeWorktree(target, observation.productPin);
      for (const check of start.checks) {
        const argv = check.argv.map((argument) => argument.replaceAll("{worktree}", target));
        const result = await this.processRunner(argv, target);
        appendJournal(
          this.paths,
          { type: "final-check", agent: order.agent, actionId: order.actionId, details: { name: check.name, argv, exitCode: result.exitCode } },
          this.now()
        );
        if (result.exitCode !== 0) {
          return {
            ...observation,
            status: "rejected",
            outstanding: [`final check ${check.name} failed with exit ${result.exitCode}: ${result.stderr.trim()}`]
          };
        }
      }
    } finally {
      await this.mirror.removeWorktree(target);
      rmSync(target, { recursive: true, force: true });
    }

    if (start.prPolicy === "coord-open-unmerged" && !readJournal(this.paths).some((event) => event.type === "pr-created")) {
      const repository = githubRepositoryFromOrigin(start.origin);
      if (repository === null) throw new Error(`Cannot derive a GitHub repository from origin ${start.origin}.`);
      const finalBranch = `${order.branch}-final`;
      await this.mirror.publishBranch(observation.productPin, finalBranch);
      const result = await this.pullRequestOpener({
        repository,
        base: start.baseBranch,
        head: finalBranch,
        title: `Issue ${start.issue}: coordinated implementation`,
        body: `Automated draft PR for issue ${start.issue}. Merge remains owner-only. Final pin: ${observation.productPin}.`
      });
      appendJournal(
        this.paths,
        { type: "pr-created", agent: order.agent, actionId: order.actionId, details: { url: result.url } },
        this.now()
      );
    }
    return observation;
  }

  private async applyDecisions(start: StartState, cursors: CursorsState, decisions: readonly MachineDecision[]): Promise<CursorsState> {
    let next = cursors;
    for (const decision of decisions) {
      if (decision.type === "prepare-action") next = await this.prepareAction(start, next, decision.agent, decision.stepId, decision.round);
      else if (decision.type === "accept-submission") next = this.accept(start, next, decision);
      else if (decision.type === "reissue-action") next = this.reissue(start, next, decision.agent, decision.outstanding);
      else if (decision.type === "retry-verification") {
        next = this.persist(replaceCursor(next, decision.agent, { status: "intent", outstanding: [...decision.outstanding] }, this.now()));
      } else if (decision.type === "advance-step") next = this.advance(next, decision);
      else if (decision.type === "owner-action-required") this.log(`Owner action required: ${decision.reason}`);
    }
    return next;
  }

  async runTick(): Promise<CursorsState> {
    const start = readStartState(this.paths);
    let cursors = readCursorsState(this.paths);
    const observations: EvidenceObservation[] = [];

    for (const agent of cursors.activeRoster) {
      const cursor = cursors.agents[agent];
      if (cursor === undefined || cursor.actionId === null || cursor.stepId === null) continue;
      const runtime = agentRuntimePaths(this.paths, agent);
      const completion = readCompletion(runtime.complete);
      if (completion.status === "missing") {
        let harnessGone = cursor.status === "harness-gone";
        if (this.tmux !== null) {
          const pane = await this.tmux.inspectPane(this.tmux.target(start.issue, agent));
          if (!pane.alive) {
            harnessGone = true;
            cursors = this.persist(replaceCursor(cursors, agent, { status: "harness-gone" }, this.now()));
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
          if (fetched.ok) {
            let observation = await evaluateEvidence(order, fetched.tip, this.mirror as EvidenceMirror);
            observation = await this.verifyFinalizationChecks(start, order, observation);
            if (observation.status === "satisfied") {
              appendJournal(
                this.paths,
                {
                  type: "intent-seen",
                  agent,
                  actionId: cursor.actionId,
                  submissionSha: fetched.tip,
                  details: { pushedThenDied: true }
                },
                this.now()
              );
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
      appendJournal(
        this.paths,
        { type: "intent-seen", agent, actionId: cursor.actionId, submissionSha: completion.sha, details: {} },
        this.now()
      );
      cursors = this.persist(replaceCursor(cursors, agent, { status: "verifying", submissionSha: completion.sha }, this.now()));
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
      let observation = await evaluateEvidence(order, completion.sha, this.mirror as EvidenceMirror);
      observation = await this.verifyFinalizationChecks(start, order, observation);
      observations.push(observation);
    }

    if (observations.length > 0) cursors = await this.applyDecisions(start, cursors, decide({ start, cursors, observations }));

    for (let progress = 0; progress < 4; progress += 1) {
      const decisions = decide({ start, cursors }).filter((decision) => decision.type !== "wait");
      if (decisions.length === 0 || decisions.every((decision) => decision.type === "owner-action-required")) break;
      cursors = await this.applyDecisions(start, cursors, decisions);
    }
    return cursors;
  }

  async run(signal?: AbortSignal): Promise<void> {
    const start = readStartState(this.paths);
    await this.initializeEffects();
    while (signal?.aborted !== true) {
      const cursors = await this.runTick();
      if (cursors.completed || cursors.abandoned || cursors.paused) return;
      await this.sleep(start.pollIntervalMs);
    }
  }
}
