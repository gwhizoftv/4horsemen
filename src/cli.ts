import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCompletion, readAction } from "./action.js";
import { handleAgentEvent, lifecycleVendorSchema, type LifecycleVendor } from "./agentEvent.js";
import { runContainmentProbe, runShellGuard, SHELL_GUARD_ALLOW } from "./shellGuard.js";
import { buildAnalytics, renderAnalytics } from "./analytics.js";
import { initializeAgentLifecycle, readAgentLifecycle } from "./agentLifecycle.js";
import { clearAgentResponse } from "./ballotResponse.js";
import { doctor, renderDoctorReport } from "./doctor.js";
import { fetchGitHubIssue, renderGitHubIssueSnapshot } from "./githubIssue.js";
import { sha256 } from "./hash.js";
import { renderHookScope, resolveWorkspaceConfig, runVerifyPhase, WORKSPACE_CONFIG_KEY } from "./hookPolicy.js";
import { install, onboard, packageVersion, uninstall } from "./install.js";
import { BareMirror } from "./mirror.js";
import { localConfigGet, worktreeRoot } from "./gitExec.js";
import { makeAgentClonesBaseReady, prepareAgentIssueBranches } from "./prepareAgentBranch.js";
import {
  agentResponsePath,
  agentRuntimePaths,
  assertNoSymlink,
  containedPath,
  createIssueRuntime,
  defaultCompletesRoot,
  issueRuntimePaths,
  removeIssueMailbox,
  resolveSafeCompletesRoot,
  resolveSafeCoordRoot,
  type IssueRuntimePaths
} from "./paths.js";
import { gitShaSchema } from "./protocol.js";
import {
  CoordinatorRunLoop,
  computeConsensusDerived,
  computeImplementationSelectionDerived,
  computePlanSelectionDerived,
  derivedDecisionJournalDetails,
  runArgv,
  type ProcessRunner
} from "./runLoop.js";
import {
  appendJournal,
  atomicWriteJson,
  cursorsStateSchema,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readAnalyticsRuntime,
  readConfig,
  readCursorsState,
  readStartState,
  readStartStateHeader,
  replaceCursor,
  setPaused,
  releaseHold,
  verifyPhaseSchema,
  type BallotBatch,
  type CoordinatorConfig,
  type CursorsState
} from "./state.js";
import { STEP_DEFINITIONS, roundForStep, type WorkflowProfile, type WorkflowStepId } from "./steps.js";
import {
  resolveAgentLauncher,
  TmuxController,
  type OpenOwnerAgentClientsResult
} from "./tmux.js";
import {
  listIssueNumbersInWorkspace,
  resolveWorkspaceFromProduct,
  workspaceLocationFromConfig,
  type WorkspaceLocation
} from "./workspace.js";
import { renderIssueReport } from "./issueReport.js";
import { wipeIssue } from "./wipeIssue.js";
import { detachIssue } from "./detachIssue.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdin: () => string;
};

export type CliRunLoop = {
  initializeEffects(): Promise<void>;
  runTick(): Promise<CursorsState>;
  run(signal?: AbortSignal): Promise<void>;
};

export type CliDependencies = {
  io?: Partial<CliIo>;
  processRunner?: ProcessRunner;
  /** Test/embedding override for user-global vendor settings. */
  home?: string | null;
  makeRunLoop?: (paths: IssueRuntimePaths) => CliRunLoop;
  startEffects?: (input: {
    paths: IssueRuntimePaths;
    issue: number;
    origin: string;
    agents: CoordinatorConfig["agents"];
    log?: (message: string) => void;
  }) => Promise<{ cleanup: () => Promise<void> }>;
  /** Test/embedding override for owner-driven manual tmux/Terminal launch. */
  manualUi?: (input: {
    tmuxNamespace: string | null;
    terminalGroup: string;
    agents: CoordinatorConfig["agents"];
    log?: (message: string) => void;
  }) => Promise<OpenOwnerAgentClientsResult>;
  /** Test/embedding override for exact tmux liveness probes. */
  sessionExists?: (sessionName: string) => Promise<boolean>;
};

/** Upper bound for one lifecycle hook or status-line payload. */
const AGENT_EVENT_MAX_BYTES = 1024 * 1024;

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  env: process.env,
  cwd: process.cwd(),
  stdin: () => readFileSync(0, "utf8")
};

type ParsedArgs = { positionals: string[]; flags: Map<string, string> };

const coordinatorSourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const parseArgs = (args: readonly string[], booleans: readonly string[] = []): ParsedArgs => {
  const positionals: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "-v" || argument === "--verbose") {
      if (flags.has("verbose")) throw new Error(`Invalid or duplicate option ${argument}.`);
      flags.set("verbose", "true");
      continue;
    }
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (name === "" || flags.has(name)) throw new Error(`Invalid or duplicate option ${argument}.`);
    if (booleans.includes(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || value.startsWith("-")) {
      throw new Error(`Option ${argument} requires a value.`);
    }
    flags.set(name, value);
    index += 1;
  }
  return { positionals, flags };
};

/**
 * Switches that take no value. Declared per command so the existing
 * value-taking options keep rejecting a missing argument rather than silently
 * absorbing the next flag.
 */
const booleanFlags: Record<string, readonly string[]> = {
  resume: ["reset-nudge-budget", "run"],
  install: ["write-product", "vendor", "bootstrap-coordination", "dry-run"],
  uninstall: ["delete-clones", "wipe-runtime", "delete-coordination", "force", "dry-run"],
  "wipe-issue": ["force", "dry-run", "delete-evidence"],
  "reset-clones": ["force", "dry-run"],
  detach: ["dry-run"],
  "containment-probe": ["refusal-ran"]
};

const flagIsSet = (parsed: ParsedArgs, name: string): boolean => parsed.flags.get(name) === "true";

const requireFlag = (parsed: ParsedArgs, name: string): string => {
  const value = parsed.flags.get(name);
  if (value === undefined || value === "") throw new Error(`--${name} is required.`);
  return value;
};

const parseIssue = (value: string): number => {
  const issue = Number(value);
  if (!Number.isInteger(issue) || issue < 1) throw new Error("Issue must be a positive integer.");
  return issue;
};

/**
 * Re-derive the paths using the mailbox root frozen in `start.json`.
 *
 * The configured root is only the default for a *new* issue. Once an issue is
 * running, its receipts must keep resolving to the tree the agents were granted
 * at launch: `coord install` may rewrite config mid-issue, and re-reading the
 * mailbox from config would leave the coordinator polling a directory no
 * harness can write.
 */
const withStoredMailbox = (paths: IssueRuntimePaths): IssueRuntimePaths => {
  if (!existsSync(paths.start)) return paths;
  const start = readStartStateHeader(paths);
  if (start.completesRoot === undefined || resolve(start.completesRoot) === paths.completesRoot) return paths;
  return issueRuntimePaths(paths.coordRoot, paths.issue, start.completesRoot);
};

const context = (parsed: ParsedArgs, io: CliIo): IssueRuntimePaths => {
  const coordRoot = requireFlag(parsed, "coord-root");
  const issueValue = parsed.flags.get("issue") ?? io.env.COORD_ISSUE;
  if (issueValue === undefined) throw new Error("--issue or COORD_ISSUE is required.");
  return withStoredMailbox(issueRuntimePaths(resolve(io.cwd, coordRoot), parseIssue(issueValue)));
};

const allowedFlags = (parsed: ParsedArgs, allowed: readonly string[]): void => {
  for (const flag of parsed.flags.keys()) {
    if (!allowed.includes(flag)) throw new Error(`Unknown option --${flag}.`);
  }
};

const help = `coord — owner-side workflow driver

Usage:
  coord --version | -V | version
  coord onboard <product> [--coord-root <path>] [--completes-root <path>] [--agents <a,b,c>] [--profile <p>]
  coord <issue> [--product <path>] [--profile <solo|reviewed|consensus>] [-v|--verbose]
  coord manual [--product <path> | --config <path> --coord-root <path>]
  coord install --product <path> --coord-root <external-path> --agents <a,b,c> [--profile <p>]
                [--completes-root <path>] [--clone-root <dir>] [--declare <file>]
                [--write-product] [--vendor] [--bootstrap-coordination] [--dry-run]
  coord uninstall --coord-root <path> --product <path> [--delete-clones] [--force]
                  [--wipe-runtime] [--delete-coordination] [--dry-run]
  coord doctor --coord-root <path> --product <path>
  coord start <issue> --product <path> [--profile <solo|reviewed|consensus>] [-v|--verbose]
  coord start <issue> --config <path> --coord-root <external-path> [--profile <solo|reviewed|consensus>] [-v|--verbose]
  coord run --issue <issue> [--product <path> | --coord-root <path>] [-v|--verbose]
  coord status --issue <issue> [--product <path> | --coord-root <path>]
  coord analytics --issue <issue> [--product <path> | --coord-root <path>]
  coord next --issue <issue> [--product <path> | --coord-root <path>] [--agent <agent>]
  coord answer <question-id> <retry|revise|abandon> --issue <issue> [--product <path> | --coord-root <path>]
  coord drop <agent> --issue <issue> [--product <path> | --coord-root <path>]
  coord pause|resume|restart-action|abandon --issue <issue> [--product <path> | --coord-root <path>]
  coord resume --issue <issue> [--agent <agent> | --hold <id>] [--reset-nudge-budget] [--run]
               [--product <path> | --coord-root <path>]
  coord attach <issue> [--product <path> | --coord-root <path>]
  coord detach <issue> [--product <path> | --coord-root <path>] [--dry-run]
  coord detach manual [--product <path> | --config <path> --coord-root <path>] [--dry-run]
  coord wipe-issue <issue> [--product <path> | --config <path> --coord-root <path>] [--force] [--dry-run] [--delete-evidence]
  coord reset-clones <issue> [--product <path> | --config <path> --coord-root <path>] [--force] [--dry-run]

Called by the agent-clone hooks, not by operators:
  coord hook-verify --clone <path> --phase <precommit|prepush>
  coord hook-scope --clone <path>
  coord agent-event --vendor <codex|claude|cursor|antigravity> [--clone <path>] [--event <name>]
  coord git-guard --vendor <codex|claude|cursor|antigravity> --clone <path>

Run by an agent through its own shell tool:
  coord containment-probe [--clone <path>] [--issue <n>] [--refusal-ran]

Happy path: bootstrap once, onboard a product once, create GitHub issue N, then run
\`coord N\` from that onboarded product. Agents author plans on issue-N/<agent>.

From an agent clone, \`coord next --issue N\` resolves the runtime via
coord.workspaceConfig and the caller via consensus.agentId (or --agent / COORD_AGENT).
Use \`-v\` / \`--verbose\` on \`coord N\`, start, or run for tick-level nudge logs.
Phase changes (R1.join → R2.plan, …) always print.
Pauses and holds keep the coordinator waiting without advancing work; Ctrl-C stops it.
Plain \`coord resume\` clears only manual pause. \`--agent\` releases exactly one hold
for that agent; if ambiguous, use \`--hold\`. Nudge-loop release still requires
\`--reset-nudge-budget\`. Resume is state-only unless \`--run\` is supplied:
use \`coord resume --issue N --agent claude --run\` only for a stopped coordinator,
and omit \`--run\` beside a live runner (it does not detect a second runner).
\`coord --version\` prints the package version (pre-1.0: \`0.0.N\`, advanced by CI on merge to main).
\`coord status\` prints the chosen agent, final pin, published branch, evidence
branch/tip and publication state, and PR URL. It never exposes ballot choices,
dispositions, rationales, or pending response bytes.

On macOS, starting or resuming an issue opens one Terminal.app window per agent
when those windows are not already open, each attached to that agent's tmux
window (no Ctrl-b n). \`coord attach N\` re-opens them while the coordinator is
already running. \`coord detach N\` closes those Terminal windows and kills the
issue tmux sessions without wiping runtime or branches. A completed \`coord N\` / \`coord run\` does the
same teardown automatically, then discards leftover WIP only from matching
issue-N agent branches and checks eligible clones out at origin/base. If any
clone cannot be made base-ready, the command exits non-zero and prints
per-clone remediation — do not run \`git checkout\` by hand; use
\`coord reset-clones N\` (keeps analytics runtime). \`coord uninstall\` also tears down owner
tmux/Terminals for the workspace agents. \`coord wipe-issue N\` resets agent clones,
deletes origin issue-N agent/*-final branches plus leftover tracking refs (keeping
product-local issue branches that have owner commits or uncommitted work, and
keeping \`issue-N/coordinator-evidence\` unless \`--delete-evidence\`), removes the
issue runtime and completion mailbox, tears down UI, and leaves the GitHub issue
open. \`coord reset-clones N\` only makes agent clones base-ready (lift overlay,
checkout origin/base, restore overlay) without deleting \`coord-runtime/issue-N\`.
The analytics command can report completed runtime format 2 and 3 state read-only;
all control-plane uses of those formats must be wiped and restarted (format 4).

\`coord manual\` opens or repairs one workspace-scoped harness per configured
agent, opens only missing Terminal windows, and returns without an issue,
coordinator state, action, run loop, or publication. The owner assigns work in
chat and agents use their own <agent>/<name> scratch branches. Manual and
automated issue sessions cannot run concurrently for the same workspace; use
\`coord detach manual\` to close manual UI before starting or resuming an issue.

install remains the advanced explicit interface. Onboard and install leave the product's
tracked tree untouched; a fresh human clone receives no coordination hooks or metadata.
COORD_ISSUE and COORD_AGENT may replace their corresponding owner-control options.
`;

export const automationDigestMaterial = (
  configPath: string,
  config: CoordinatorConfig,
  issue: number,
  issueSnapshot: string
): { digest: string; sources: Array<{ id: string; sha256: string }> } => {
  const configRoot = dirname(configPath);
  assertNoSymlink(configRoot, configPath);
  const sourceBytes: Array<{ id: string; content: string }> = [
    { id: "config", content: readFileSync(configPath, "utf8") },
    { id: "github-issue", content: issueSnapshot }
  ];
  for (const template of config.digestPaths) {
    const path = template.replaceAll("{issue}", String(issue));
    if (path.includes("{") || path.includes("}")) throw new Error(`Unsupported digest path template ${template}.`);
    const absolute = containedPath(configRoot, path);
    assertNoSymlink(configRoot, absolute);
    let content: string;
    try {
      content = readFileSync(absolute, "utf8");
    } catch (error) {
      throw new Error(
        `Digest source ${path} for issue ${issue} is missing at ${absolute}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    sourceBytes.push({ id: path, content });
  }
  const canonical = sourceBytes
    .map(({ id, content }) => `${Buffer.byteLength(id)}:${id}${Buffer.byteLength(content)}:${content}`)
    .join("");
  return {
    digest: sha256(`sha256-length-prefixed-v1${canonical}`),
    sources: sourceBytes.map(({ id, content }) => ({ id, sha256: sha256(content) }))
  };
};

const invalidateUnpublishedBatches = (
  batches: readonly BallotBatch[],
  now: string,
  reason: string
): BallotBatch[] =>
  batches.map((batch) =>
    batch.status === "published" || batch.status === "invalidated"
      ? batch
      : {
          ...batch,
          status: "invalidated" as const,
          error: batch.error ?? reason,
          updatedAt: now
        }
  );

const clearAgentLocalWork = (paths: IssueRuntimePaths, agent: string, actionId: string | null): void => {
  const runtime = agentRuntimePaths(paths, agent);
  clearCompletion(runtime.complete);
  if (existsSync(runtime.action)) unlinkSync(runtime.action);
  if (actionId !== null) clearAgentResponse(agentResponsePath(paths, agent, actionId));
};

const rederiveAfterDrop = (
  paths: IssueRuntimePaths,
  cursors: CursorsState,
  dropped: string,
  now: string
): CursorsState => {
  const priorPlan = cursors.derived.planSelection;
  const priorImplementation = cursors.derived.implementationSelection;
  const priorConsensus = cursors.derived.consensus;
  let next = dropAgent(cursors, dropped, now);
  if (cursors.pendingAmendment != null) {
    for (const agent of cursors.activeRoster) clearAgentLocalWork(paths, agent, cursors.agents[agent]?.actionId ?? null);
    appendJournal(paths, { type: "amendment-decided", details: {
      sequence: cursors.pendingAmendment.sequence, outcome: "cancelled", reason: `drop of ${dropped}`,
      eventId: `amendment-cancel:${cursors.pendingAmendment.sequence}:${dropped}`
    } }, now);
  }
  // A ballot cast for an agent who is no longer eligible must be replaced by
  // its active author. Other evidence from the dropped agent remains as
  // historical provenance but is excluded by every active-only derivation.
  // Published ballot batches are retained; unpublished roster batches are
  // invalidated by dropAgent.
  next = cursorsStateSchema.parse({
    ...next,
    accepted: next.accepted.filter(
      (submission) =>
        !(
          next.activeRoster.includes(submission.agent) &&
          (submission.stepId === "R3.plan-ballot" || submission.stepId === "R5.compare-ballot") &&
          submission.choice === dropped
        )
    ),
    acceptedResponses: next.acceptedResponses.filter(
      (response) =>
        !(
          next.activeRoster.includes(response.agent) &&
          (response.stepId === "R3.plan-ballot" || response.stepId === "R5.compare-ballot") &&
          response.choice === dropped
        )
    ),
    ownerQuestion: null,
    updatedAt: now
  });

  const persistDecision = <T extends NonNullable<CursorsState["derived"][keyof CursorsState["derived"]]>>(
    record: T
  ): T => {
    const event = appendJournal(
      paths,
      { type: "decision-derived", details: derivedDecisionJournalDetails(record) },
      record.decidedAt
    );
    return { ...record, decidedAt: event.at };
  };

  const resetTo = (
    state: CursorsState,
    stepId: WorkflowStepId,
    round: number | null,
    removeStep: (step: WorkflowStepId) => boolean
  ): CursorsState => {
    const accepted = state.accepted.filter((submission) => !removeStep(submission.stepId));
    const acceptedResponses = state.acceptedResponses.filter((response) => !removeStep(response.stepId));
    const agents = { ...state.agents };
    for (const agent of state.activeRoster) {
      const cursor = agents[agent];
      if (cursor === undefined) continue;
      const definition = STEP_DEFINITIONS[stepId];
      const satisfied =
        definition.submissionMode === "response"
          ? acceptedResponses.find(
              (response) => response.stepId === stepId && response.agent === agent && response.round === round
            )
          : accepted.find(
              (submission) => submission.stepId === stepId && submission.agent === agent && submission.round === round
            );
      agents[agent] = {
        ...cursor,
        stepId,
        evidenceId: definition.evidenceId,
        actionId: null,
        submissionMode: null,
        status: satisfied === undefined ? "idle" : "waiting-peer",
        submissionSha: null,
        outstanding: [],
        updatedAt: now
      };
      clearAgentLocalWork(paths, agent, cursor.actionId);
    }
    return cursorsStateSchema.parse({
      ...state,
      issueCursor: { stepId, gateId: STEP_DEFINITIONS[stepId].gateId, round },
      agents,
      accepted,
      acceptedResponses,
      ballotBatches: invalidateUnpublishedBatches(state.ballotBatches, now, `invalidated by reset to ${stepId}`),
      ownerQuestion: null,
      publication: {
        status: "not-required",
        finalSha: null,
        branch: null,
        url: null,
        error: null,
        attempts: state.publication.attempts
      },
      completed: false,
      updatedAt: now
    });
  };

  let reset = false;
  if (priorPlan !== null) {
    if (next.activeRoster.length === 1) {
      if (priorPlan.selectedAgents[0] !== next.activeRoster[0]) {
        next = resetTo(next, "R4.implement", null, (step) =>
          ["R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot", "R7.finalize"].includes(step)
        );
        reset = true;
      }
    } else {
      const plan = computePlanSelectionDerived(next, now, priorPlan.decisionId);
      if (plan === null) {
        next = resetTo(next, "R3.plan-ballot", null, (step) =>
          ["R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot", "R7.finalize"].includes(step)
        );
        reset = true;
      } else {
        next = cursorsStateSchema.parse({
          ...next,
          derived: { ...next.derived, planSelection: persistDecision(plan) },
          updatedAt: now
        });
        if (plan.selectedAgents[0] !== priorPlan.selectedAgents[0]) {
          next = resetTo(next, "R4.implement", null, (step) =>
            ["R4.implement", "R5.compare", "R5.compare-ballot", "R6.revise", "R6.ballot", "R7.finalize"].includes(step)
          );
          reset = true;
        }
      }
    }
  }

  if (!reset && priorImplementation !== null && next.activeRoster.length > 1) {
    const implementation = computeImplementationSelectionDerived(next, now, priorImplementation.decisionId);
    if (implementation === null) {
      next = resetTo(next, "R5.compare-ballot", null, (step) =>
        ["R6.revise", "R6.ballot", "R7.finalize"].includes(step)
      );
      reset = true;
    } else {
      next = cursorsStateSchema.parse({
        ...next,
        derived: { ...next.derived, implementationSelection: persistDecision(implementation) },
        updatedAt: now
      });
      if (
        implementation.winner !== priorImplementation.winner ||
        implementation.implementationPin !== priorImplementation.implementationPin
      ) {
        next = resetTo(next, "R6.revise", 1, (step) =>
          ["R6.revise", "R6.ballot", "R7.finalize"].includes(step)
        );
        reset = true;
      }
    }
  }

  if (!reset && priorConsensus !== null && next.activeRoster.length > 1) {
    const consensus = computeConsensusDerived(next, priorConsensus.round, now, priorConsensus.decisionId);
    if (consensus === null) {
      next = resetTo(next, "R6.ballot", priorConsensus.round, (step) => step === "R7.finalize");
      reset = true;
    } else {
      next = cursorsStateSchema.parse({
        ...next,
        derived: { ...next.derived, consensus: persistDecision(consensus) },
        updatedAt: now
      });
      if (consensus.consensusPin !== priorConsensus.consensusPin) {
        next = resetTo(next, "R7.finalize", null, (step) => step === "R7.finalize");
        reset = true;
      }
    }
  }

  clearAgentLocalWork(paths, dropped, cursors.agents[dropped]?.actionId ?? null);
  if (reset) return next;

  const currentStep = next.issueCursor.stepId;
  const round = roundForStep(currentStep, next.issueCursor.round);
  const definition = STEP_DEFINITIONS[currentStep];
  for (const agent of next.activeRoster) {
    const alreadySatisfied =
      definition.submissionMode === "response"
        ? next.acceptedResponses.some(
            (response) => response.stepId === currentStep && response.agent === agent && response.round === round
          )
        : next.accepted.some(
            (submission) => submission.stepId === currentStep && submission.agent === agent && submission.round === round
          );
    if (alreadySatisfied) continue;
    const runtime = agentRuntimePaths(paths, agent);
    const priorActionId = next.agents[agent]?.actionId ?? null;
    if (existsSync(runtime.action)) unlinkSync(runtime.action);
    if (priorActionId !== null) clearAgentResponse(agentResponsePath(paths, agent, priorActionId));
    next = replaceCursor(
      next,
      agent,
      { actionId: null, status: "idle", submissionSha: null, outstanding: [] },
      now
    );
  }
  return next;
};

type StartResolution = {
  configPath: string;
  config: CoordinatorConfig;
  runtimeRoot: string;
  workspace: WorkspaceLocation | null;
  profile: WorkflowProfile;
};

type WorkspaceUiIdentity = {
  tmuxNamespace: string | null;
  terminalGroup: string;
};

const workspaceUiIdentity = (workspaceRoot: string): WorkspaceUiIdentity => {
  const paths = issueRuntimePaths(workspaceRoot, 1);
  return { tmuxNamespace: paths.tmuxNamespace, terminalGroup: paths.terminalGroup };
};

const resolvedAgents = (resolution: StartResolution): CoordinatorConfig["agents"] =>
  resolution.config.agents.map((agent) => ({ ...agent, root: resolve(dirname(resolution.configPath), agent.root) }));

const workflowProfile = (value: string): WorkflowProfile => {
  if (value === "solo" || value === "reviewed" || value === "consensus") return value;
  throw new Error("--profile must be solo, reviewed, or consensus.");
};

const resolveStart = (parsed: ParsedArgs, io: CliIo): StartResolution => {
  const hasConfig = parsed.flags.has("config");
  const hasCoordRoot = parsed.flags.has("coord-root");
  if (hasConfig !== hasCoordRoot) {
    throw new Error("--config and --coord-root must be supplied together, or use --product after coord onboard.");
  }
  if (hasConfig && parsed.flags.has("product")) {
    throw new Error("Use --product or the explicit --config/--coord-root pair, not both.");
  }

  let configPath: string;
  let runtimeRoot: string;
  let workspace: WorkspaceLocation | null = null;
  if (hasConfig) {
    configPath = resolve(io.cwd, requireFlag(parsed, "config"));
    runtimeRoot = resolve(io.cwd, requireFlag(parsed, "coord-root"));
  } else {
    const product = parsed.flags.has("product") ? resolve(io.cwd, requireFlag(parsed, "product")) : io.cwd;
    workspace = resolveWorkspaceFromProduct(product);
    configPath = workspace.configPath;
    runtimeRoot = workspace.workspaceRoot;
  }
  const config = readConfig(configPath);
  return {
    configPath,
    config,
    runtimeRoot,
    workspace,
    profile: workflowProfile(parsed.flags.get("profile") ?? config.profile)
  };
};

const matchesConfig = (paths: IssueRuntimePaths, configPath: string): boolean => {
  if (!existsSync(paths.start)) return false;
  const start = readStartStateHeader(paths);
  return resolve(start.configPath) === resolve(configPath);
};

/** Find durable state for product-resolved commands, including old nested installs. */
const existingIssueRuntime = (resolution: StartResolution, issue: number): IssueRuntimePaths | null => {
  const current = issueRuntimePaths(resolution.runtimeRoot, issue);
  const currentMatches = matchesConfig(current, resolution.configPath);
  let legacy: IssueRuntimePaths | null = null;
  let legacyMatches = false;
  if (resolution.workspace?.layout === "nested") {
    legacy = issueRuntimePaths(resolution.workspace.coordRoot, issue);
    legacyMatches = matchesConfig(legacy, resolution.configPath);
  }
  if (currentMatches && legacyMatches) {
    throw new Error(
      `Issue ${issue} has both workspace-scoped and legacy runtime state for ${resolution.config.project}; ` +
        "remove or archive the stale copy before continuing."
    );
  }
  if (currentMatches) return withStoredMailbox(current);
  if (legacyMatches) return legacy === null ? null : withStoredMailbox(legacy);
  if (existsSync(current.start)) {
    throw new Error(`Issue ${issue} runtime at ${current.issueRoot} belongs to a different workspace.`);
  }
  return null;
};

/** Resolve existing state either explicitly or through an onboarded product. */
const existingContext = (parsed: ParsedArgs, io: CliIo): IssueRuntimePaths => {
  if (!parsed.flags.has("product")) return context(parsed, io);
  if (parsed.flags.has("coord-root")) {
    throw new Error("Use --product or --coord-root for an issue command, not both.");
  }
  const issueValue = parsed.flags.get("issue") ?? io.env.COORD_ISSUE;
  if (issueValue === undefined) throw new Error("--issue or COORD_ISSUE is required.");
  const issue = parseIssue(issueValue);
  const resolution = resolveStart(
    { positionals: [], flags: new Map([["product", requireFlag(parsed, "product")]]) },
    io
  );
  const paths = existingIssueRuntime(resolution, issue);
  if (paths === null) {
    throw new Error(`No runtime state exists for issue ${issue} and this product. Run coord ${issue}.`);
  }
  return paths;
};

/**
 * Agent-facing next resolution: product, explicit coord-root, or the calling
 * agent clone's coord.workspaceConfig.
 */
const nextContext = (
  parsed: ParsedArgs,
  io: CliIo
): { paths: IssueRuntimePaths; agent: string } => {
  const issueValue = parsed.flags.get("issue") ?? io.env.COORD_ISSUE;
  if (issueValue === undefined) throw new Error("--issue or COORD_ISSUE is required.");
  const issue = parseIssue(issueValue);
  const flagAgent = parsed.flags.get("agent") ?? io.env.COORD_AGENT;

  if (parsed.flags.has("product") || parsed.flags.has("coord-root")) {
    const paths = existingContext(parsed, io);
    if (flagAgent === undefined) throw new Error("--agent or COORD_AGENT is required.");
    return { paths, agent: flagAgent };
  }

  const cloneRoot = worktreeRoot(io.cwd);
  if (cloneRoot === null) {
    throw new Error(
      "coord next needs --product, --coord-root, or to be run from an agent clone with coord.workspaceConfig set."
    );
  }
  const configPath = localConfigGet(cloneRoot, WORKSPACE_CONFIG_KEY);
  if (configPath === null) {
    throw new Error(
      `This worktree has no local ${WORKSPACE_CONFIG_KEY}. Run from an agent clone, or pass --product / --coord-root.`
    );
  }
  const workspace = workspaceLocationFromConfig(configPath);
  const config = readConfig(workspace.configPath);
  const resolution: StartResolution = {
    configPath: workspace.configPath,
    config,
    runtimeRoot: workspace.workspaceRoot,
    workspace,
    profile: workflowProfile(config.profile)
  };
  const paths = existingIssueRuntime(resolution, issue);
  if (paths === null) {
    throw new Error(`No runtime state exists for issue ${issue} under ${workspace.workspaceRoot}. Run coord ${issue}.`);
  }
  const configuredAgent = localConfigGet(cloneRoot, "consensus.agentId");
  const agent = flagAgent ?? configuredAgent ?? undefined;
  if (agent === undefined) {
    throw new Error("--agent, COORD_AGENT, or consensus.agentId in this clone is required.");
  }
  if (configuredAgent !== null && flagAgent !== undefined && configuredAgent !== flagAgent) {
    throw new Error(
      `Requested agent '${flagAgent}' does not match this clone's consensus.agentId '${configuredAgent}'.`
    );
  }
  return { paths, agent };
};

const reportOwnerAgentClients = (result: OpenOwnerAgentClientsResult, log: (message: string) => void): void => {
  if (result.status === "opened") {
    log(`Opened ${result.count} Terminal window(s), one per agent tmux client.\n`);
    return;
  }
  if (result.status === "already-open") return;
  log(
    result.status === "failed"
      ? `Could not open Terminal windows (${result.error}). Attach manually:\n`
      : `Owner Terminal auto-open is unavailable on this platform. Attach manually:\n`
  );
  for (const command of result.commands) log(`  ${command}\n`);
};

const defaultStartEffects = async (input: {
  paths: IssueRuntimePaths;
  issue: number;
  origin: string;
  agents: CoordinatorConfig["agents"];
  log?: (message: string) => void;
}): Promise<{ cleanup: () => Promise<void> }> => {
  const mirror = new BareMirror(input.paths.mirror, input.origin);
  await mirror.initialize();
  const tmux = new TmuxController(undefined, input.paths.tmuxNamespace, undefined, undefined, undefined, input.paths.terminalGroup);
  await tmux.startSession(input.issue, input.agents);
  const opened = await tmux.openOwnerAgentClients(input.issue, input.agents);
  reportOwnerAgentClients(opened, input.log ?? ((message) => process.stdout.write(message)));
  return { cleanup: async () => tmux.stopSession(input.issue) };
};

const defaultManualUi = async (input: {
  tmuxNamespace: string | null;
  terminalGroup: string;
  agents: CoordinatorConfig["agents"];
  log?: (message: string) => void;
}): Promise<OpenOwnerAgentClientsResult> => {
  const tmux = new TmuxController(undefined, input.tmuxNamespace, undefined, undefined, undefined, input.terminalGroup);
  await tmux.preflight(input.agents);
  await tmux.ensureSession("manual", input.agents);
  return tmux.openOwnerAgentClients("manual", input.agents, { onlyMissing: true });
};

const detachCompletedIssue = async (paths: IssueRuntimePaths, io: CliIo): Promise<number> => {
  const cursors = readCursorsState(paths);
  if (!cursors.completed) return 0;
  const start = readStartState(paths);
  const outcome = await detachIssue({
    issue: start.issue,
    agentIds: start.agents.map((agent) => agent.id),
    tmuxNamespace: paths.tmuxNamespace,
    terminalGroup: paths.terminalGroup,
    log: io.stdout
  });
  let installRoot: string | null = null;
  if (existsSync(start.configPath)) {
    try {
      installRoot = readConfig(start.configPath).coordination?.installRoot ?? null;
    } catch (error) {
      io.stdout(
        `Could not read ${start.configPath} for clone readiness ` +
          `(${error instanceof Error ? error.message : String(error)}); using each clone's captured protocol.\n`
      );
    }
  }
  const readiness = makeAgentClonesBaseReady({
    agents: start.agents,
    issue: start.issue,
    branchTemplate: start.branchTemplate,
    baseBranch: start.baseBranch,
    installRoot,
    log: io.stdout
  });
  // A later checkout can fail after reset/clean succeeded. Count the completed
  // discard from the structured result even when final readiness was refused.
  const cleaned = readiness.filter((result) => result.discardedPaths.length > 0).length;
  const checkedOut = readiness.filter((result) => result.action === "checked-out").length;
  const alreadyBase = readiness.filter((result) => result.action === "already-base").length;
  const refused = readiness.filter((result) => result.action === "refused");
  const skipped = readiness.filter((result) => result.action === "skipped-missing").length;
  io.stdout(
    `Issue ${start.issue} complete: killed ${outcome.killedSessions.length} tmux session(s)` +
      (outcome.terminalClose === "closed"
        ? `, closed ${outcome.closedTerminalTitles.length} Terminal window(s)`
        : "") +
      ".\n"
  );
  io.stdout(
    `Clone readiness: cleaned ${cleaned}, checked out ${checkedOut}, already base ${alreadyBase}, ` +
      `refused ${refused.length}, skipped ${skipped}.\n`
  );
  if (refused.length === 0) return 0;

  for (const result of refused) {
    io.stderr(
      `  refused ${result.agent} (${result.clone}): ${result.reason ?? "readiness refused"}\n`
    );
  }
  io.stderr(
    `Clone readiness refused for ${refused.length} clone(s). ` +
      `Do not run git checkout ${start.baseBranch} by hand — the AGENTS.md protocol overlay ` +
      `(skip-worktree) blocks it. Run: coord reset-clones ${start.issue} --product <path> ` +
      `(or --config <path> --coord-root <path>).\n`
  );
  appendJournal(
    paths,
    {
      type: "clone-readiness-refused",
      details: {
        refused: refused.map((result) => ({
          agent: result.agent,
          clone: result.clone,
          reason: result.reason ?? "readiness refused"
        }))
      }
    },
    new Date().toISOString()
  );
  return 1;
};

export const runCli = async (argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> => {
  const io: CliIo = { ...defaultIo, ...dependencies.io };
  const runner = dependencies.processRunner ?? runArgv;
  const verboseState = { enabled: false };
  const defaultMakeRunLoop = (paths: IssueRuntimePaths): CliRunLoop =>
    new CoordinatorRunLoop(paths, {
      log: (message) => io.stdout(`${message}\n`),
      verbose: (message) => {
        if (verboseState.enabled) io.stdout(`${message}\n`);
      }
    });
  const makeRunLoop = dependencies.makeRunLoop ?? defaultMakeRunLoop;
  const startEffects =
    dependencies.startEffects ??
    (dependencies.makeRunLoop === undefined
      ? defaultStartEffects
      : async () => ({ cleanup: async () => undefined }));
  const manualUi = dependencies.manualUi ?? defaultManualUi;
  const sessionExists =
    dependencies.sessionExists ??
    (process.env.VITEST !== undefined
      ? async () => false
      : async (sessionName: string) => (await runner(["tmux", "has-session", "-t", sessionName], io.cwd)).exitCode === 0);

  const sessionName = (key: number | "manual", identity: WorkspaceUiIdentity): string =>
    new TmuxController(undefined, identity.tmuxNamespace, null, null, undefined, identity.terminalGroup).sessionName(key);

  const assertNoManualSession = async (workspaceRoot: string): Promise<void> => {
    const identity = workspaceUiIdentity(workspaceRoot);
    const manual = sessionName("manual", identity);
    if (await sessionExists(manual)) {
      throw new Error(
        `Manual mode is active for this workspace (tmux session ${manual}). Run \`coord detach manual\` first.`
      );
    }
  };

  const assertIssueCanRun = async (paths: IssueRuntimePaths): Promise<void> => {
    const workspace = workspaceLocationFromConfig(readStartState(paths).configPath);
    const manualWorkspaceRoot =
      workspace.layout === "nested" && resolve(paths.coordRoot) === resolve(workspace.coordRoot)
        ? workspace.workspaceRoot
        : paths.coordRoot;
    await assertNoManualSession(manualWorkspaceRoot);
  };

  const runIssue = async (paths: IssueRuntimePaths): Promise<number> => {
    await makeRunLoop(paths).run();
    return detachCompletedIssue(paths, io);
  };

  const assertNoAutomatedSession = async (resolution: StartResolution): Promise<void> => {
    const sessions = new Map<string, number>();
    const currentIdentity = workspaceUiIdentity(resolution.runtimeRoot);
    for (const issue of listIssueNumbersInWorkspace(resolution.runtimeRoot)) {
      const paths = issueRuntimePaths(resolution.runtimeRoot, issue);
      // A flat root can be supplied explicitly with a config stored elsewhere.
      // Keep incomplete issue dirs conservative, but do not let durable state
      // that identifies another config create a cross-product false conflict.
      if (existsSync(paths.start) && !matchesConfig(paths, resolution.configPath)) continue;
      sessions.set(sessionName(issue, currentIdentity), issue);
    }

    const installed = workspaceLocationFromConfig(resolution.configPath);
    if (installed.layout === "nested" && resolve(installed.workspaceRoot) === resolve(resolution.runtimeRoot)) {
      const legacyIdentity = workspaceUiIdentity(installed.coordRoot);
      for (const issue of listIssueNumbersInWorkspace(installed.coordRoot)) {
        if (matchesConfig(issueRuntimePaths(installed.coordRoot, issue), resolution.configPath)) {
          sessions.set(sessionName(issue, legacyIdentity), issue);
        }
      }
    }

    for (const [candidate, issue] of sessions) {
      if (await sessionExists(candidate)) {
        throw new Error(
          `Issue ${issue} is running for this workspace (tmux session ${candidate}). ` +
            `Run \`coord detach ${issue}\` before \`coord manual\`.`
        );
      }
    }
  };

  const startIssue = async (issue: number, resolution: StartResolution): Promise<IssueRuntimePaths> => {
    const { configPath, config, profile } = resolution;
    const agents = resolvedAgents(resolution);
    const roster = profile === "solo" ? agents.slice(0, 1) : agents;
    if (roster.length === 0) throw new Error(`Profile ${profile} requires at least one configured agent.`);
    for (const agent of roster) resolveAgentLauncher(agent);
    const coordRoot = resolveSafeCoordRoot({
      coordRoot: resolution.runtimeRoot,
      agentRoots: agents.map((agent) => agent.root),
      create: false
    });
    // Resolved once here and then frozen into start.json: every later command
    // for this issue reads it from there, not from a config that may move.
    const completesRoot = resolveSafeCompletesRoot({
      completesRoot: config.completesRoot ?? defaultCompletesRoot(coordRoot),
      coordRoot,
      agentRoots: agents.map((agent) => agent.root),
      create: true
    });
    const paths = issueRuntimePaths(coordRoot, issue, completesRoot);
    if (existsSync(paths.issueRoot)) {
      throw new Error(`Runtime state already exists for issue ${issue}. Use coord ${issue} to resume or abandon it explicitly.`);
    }
    if (existsSync(paths.completesIssueRoot)) {
      throw new Error(
        `A completion mailbox already exists for issue ${issue} at ${paths.completesIssueRoot}. ` +
          "Wipe it with coord wipe-issue before starting; a stale receipt there would be read as completion intent."
      );
    }

    const snapshot = await fetchGitHubIssue({ origin: config.origin, issue, cwd: io.cwd, runner });
    const snapshotBytes = renderGitHubIssueSnapshot(snapshot);
    const digest = automationDigestMaterial(configPath, config, issue, snapshotBytes);
    const baselineResult = await runner(
      ["git", "ls-remote", "--exit-code", config.origin, `refs/heads/${config.baseBranch}`],
      io.cwd
    );
    if (baselineResult.exitCode !== 0) throw new Error(`Cannot resolve origin baseline: ${baselineResult.stderr.trim()}`);
    const baselineSha = baselineResult.stdout.trim().split(/\s+/)[0];
    const parsedBaseline = gitShaSchema.safeParse(baselineSha);
    if (!parsedBaseline.success) throw new Error("Origin returned an invalid baseline SHA.");
    const trustedSourceResult = await runner(["git", "rev-parse", "--verify", "HEAD^{commit}"], coordinatorSourceRoot);
    if (trustedSourceResult.exitCode !== 0) {
      throw new Error(`Cannot resolve trusted coordinator source commit: ${trustedSourceResult.stderr.trim()}`);
    }
    const trustedSourceCommit = gitShaSchema.safeParse(trustedSourceResult.stdout.trim());
    if (!trustedSourceCommit.success) throw new Error("Coordinator source checkout returned an invalid trusted commit SHA.");

    prepareAgentIssueBranches({
      agents: roster,
      issue,
      branchTemplate: config.branch,
      baselineSha: parsedBaseline.data,
      baseBranch: config.baseBranch,
      installRoot: config.coordination?.installRoot ?? coordinatorSourceRoot,
      log: io.stdout
    });

    let effects: { cleanup: () => Promise<void> } | null = null;
    createIssueRuntime(paths, roster.map((agent) => agent.id));
    try {
      atomicWriteJson(paths.coordRoot, paths.issueSnapshot, snapshot);
      initializeOperationalState(paths, {
        issue,
        issueSessionId: `issue-${issue}:${parsedBaseline.data}`,
        baselineSha: parsedBaseline.data,
        profile,
        originalRoster: roster.map((agent) => agent.id),
        branchTemplate: config.branch,
        baseBranch: config.baseBranch,
        maxRevisionRounds: config.maxRevisionRounds,
        prPolicy: config.prPolicy,
        automationDigest: digest.digest,
        automationDigestScheme: "sha256-length-prefixed-v1",
        automationDigestSources: digest.sources,
        trustedSourceCommit: trustedSourceCommit.data,
        origin: config.origin,
        coordRoot,
        configPath,
        agents: roster,
        checks: config.checks,
        pollIntervalMs: config.pollIntervalMs,
        contextPaths: config.contextPaths
      });
      initializeAgentLifecycle(paths, roster.map((agent) => agent.id));
      // Start the CLIs only after their owner runtime exists. SessionStart
      // hooks can then establish a durable handshake instead of racing start.
      effects = await startEffects({ paths, issue, origin: config.origin, agents: roster, log: io.stdout });
    } catch (error) {
      rmSync(paths.issueRoot, { recursive: true, force: true });
      // The mailbox is a separate tree, so the rollback has to name it too.
      // startIssue refuses to run when either tree already exists, so an orphan
      // drop directory from a failed start would block the retry it invites.
      removeIssueMailbox(paths);
      if (effects !== null) {
        try {
          await effects.cleanup();
        } catch (cleanupError) {
          io.stderr(
            `coord: startup cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`
          );
        }
      }
      throw error;
    }
    try {
      await makeRunLoop(paths).runTick();
    } catch (error) {
      throw new Error(
        `Issue ${issue} was started durably at ${paths.issueRoot}, but its initial tick failed; ` +
          `resume with coord ${issue}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    io.stdout(`Started issue ${issue} (${profile}) at ${paths.issueRoot}.\n`);
    return paths;
  };
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout(help);
    return 0;
  }
  if (command === "--version" || command === "-V" || command === "version") {
    io.stdout(`${packageVersion(coordinatorSourceRoot)}\n`);
    return 0;
  }

  try {
    const parsed = parseArgs(rest, booleanFlags[command] ?? []);

    if (/^[0-9]+$/.test(command)) {
      allowedFlags(parsed, ["product", "profile", "config", "coord-root", "verbose"]);
      if (parsed.positionals.length !== 0) throw new Error("coord <issue> takes no additional positional arguments.");
      verboseState.enabled = flagIsSet(parsed, "verbose");
      const issue = parseIssue(command);
      const resolution = resolveStart(parsed, io);
      await assertNoManualSession(resolution.runtimeRoot);
      const existing = existingIssueRuntime(resolution, issue);
      const paths = existing ?? (await startIssue(issue, resolution));
      return await runIssue(paths);
    }

    if (command === "manual") {
      allowedFlags(parsed, ["product", "config", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error("manual takes no positional arguments.");
      const resolution = resolveStart(parsed, io);
      const agents = resolvedAgents(resolution);
      if (agents.length === 0) throw new Error("Manual mode requires at least one configured agent.");
      for (const agent of agents) resolveAgentLauncher(agent);
      const workspaceRoot = resolveSafeCoordRoot({
        coordRoot: resolution.runtimeRoot,
        agentRoots: agents.map((agent) => agent.root),
        create: false
      });
      const identity = workspaceUiIdentity(workspaceRoot);
      await assertNoAutomatedSession({ ...resolution, runtimeRoot: workspaceRoot });
      const opened = await manualUi({ ...identity, agents, log: io.stdout });
      reportOwnerAgentClients(opened, io.stdout);
      io.stdout(
        `Manual mode ready in ${sessionName("manual", identity)} with ${agents.length} configured agent window(s).\n`
      );
      return 0;
    }

    if (command === "onboard") {
      allowedFlags(parsed, ["coord-root", "completes-root", "clone-root", "agents", "profile"]);
      if (parsed.positionals.length !== 1) throw new Error("onboard requires exactly one product path.");
      const agents = (parsed.flags.get("agents") ?? "claude,codex,cursor,antigravity")
        .split(",")
        .map((agent) => agent.trim())
        .filter((agent) => agent !== "");
      if (agents.length === 0) throw new Error("--agents requires at least one agent id.");
      const profile = workflowProfile(parsed.flags.get("profile") ?? "consensus");
      const productRoot = resolve(io.cwd, parsed.positionals[0] as string);
      const result = onboard({
        installRoot: coordinatorSourceRoot,
        productRoot,
        agents,
        profile,
        ...(parsed.flags.has("coord-root") ? { coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")) } : {}),
        ...(parsed.flags.has("completes-root")
          ? { completesRoot: resolve(io.cwd, requireFlag(parsed, "completes-root")) }
          : {}),
        ...(parsed.flags.has("clone-root") ? { cloneRoot: resolve(io.cwd, requireFlag(parsed, "clone-root")) } : {}),
        ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
        log: io.stdout
      });
      (result.doctor.exitCode === 0 ? io.stdout : io.stderr)(renderDoctorReport(result.doctor));
      return result.doctor.exitCode;
    }

    if (command === "install") {
      allowedFlags(parsed, [
        "product",
        "coord-root",
        "completes-root",
        "agents",
        "profile",
        "clone-root",
        "declare",
        "origin",
        "base-branch",
        ...(booleanFlags.install ?? [])
      ]);
      if (parsed.positionals.length !== 0) throw new Error("install takes no positional arguments.");
      const agents = requireFlag(parsed, "agents")
        .split(",")
        .map((agent) => agent.trim())
        .filter((agent) => agent !== "");
      if (agents.length === 0) throw new Error("--agents requires at least one agent id.");
      const profile = parsed.flags.get("profile") ?? "consensus";
      if (!(profile === "solo" || profile === "reviewed" || profile === "consensus")) {
        throw new Error("--profile must be solo, reviewed, or consensus.");
      }
      install({
        installRoot: coordinatorSourceRoot,
        productRoot: resolve(io.cwd, requireFlag(parsed, "product")),
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        agents,
        profile,
        ...(parsed.flags.has("completes-root")
          ? { completesRoot: resolve(io.cwd, requireFlag(parsed, "completes-root")) }
          : {}),
        ...(parsed.flags.has("clone-root") ? { cloneRoot: resolve(io.cwd, requireFlag(parsed, "clone-root")) } : {}),
        ...(parsed.flags.has("declare") ? { declarePath: resolve(io.cwd, requireFlag(parsed, "declare")) } : {}),
        ...(parsed.flags.has("origin") ? { origin: requireFlag(parsed, "origin") } : {}),
        ...(parsed.flags.has("base-branch") ? { baseBranch: requireFlag(parsed, "base-branch") } : {}),
        writeProduct: flagIsSet(parsed, "write-product"),
        vendor: flagIsSet(parsed, "vendor"),
        bootstrap: flagIsSet(parsed, "bootstrap-coordination"),
        dryRun: flagIsSet(parsed, "dry-run"),
        ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
        log: io.stdout
      });
      return 0;
    }

    if (command === "uninstall") {
      allowedFlags(parsed, ["product", "project", "coord-root", ...(booleanFlags.uninstall ?? [])]);
      if (parsed.positionals.length !== 0) throw new Error("uninstall takes no positional arguments.");
      uninstall({
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        ...(parsed.flags.has("product") ? { productRoot: resolve(io.cwd, requireFlag(parsed, "product")) } : {}),
        ...(parsed.flags.has("project") ? { project: requireFlag(parsed, "project") } : {}),
        deleteClones: flagIsSet(parsed, "delete-clones"),
        wipeRuntime: flagIsSet(parsed, "wipe-runtime"),
        deleteCoordination: flagIsSet(parsed, "delete-coordination"),
        force: flagIsSet(parsed, "force"),
        dryRun: flagIsSet(parsed, "dry-run"),
        ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
        log: io.stdout
      });
      return 0;
    }

    if (command === "doctor") {
      allowedFlags(parsed, ["product", "project", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error("doctor takes no positional arguments.");
      const report = doctor({
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        ...(parsed.flags.has("product") ? { productRoot: resolve(io.cwd, requireFlag(parsed, "product")) } : {}),
        ...(parsed.flags.has("project") ? { project: requireFlag(parsed, "project") } : {}),
        ...(dependencies.home === undefined ? {} : { home: dependencies.home })
      });
      (report.exitCode === 0 ? io.stdout : io.stderr)(renderDoctorReport(report));
      return report.exitCode;
    }

    if (command === "agent-event") {
      allowedFlags(parsed, ["vendor", "clone", "agent", "issue", "event"]);
      if (parsed.positionals.length !== 0) throw new Error("agent-event takes no positional arguments.");
      // Lifecycle hooks are observational. A broken/missing runtime must never
      // block the vendor prompt or turn-stop path.
      let response = "{}";
      try {
        const vendor = lifecycleVendorSchema.parse(requireFlag(parsed, "vendor"));
        const explicitEvent = parsed.flags.has("event") ? requireFlag(parsed, "event") : undefined;
        // Establish the fail-open Stop response before parsing or validating
        // the observation. Coordinator state errors must never trap the CLI.
        if (vendor === "antigravity" && explicitEvent?.toLowerCase() === "stop") {
          response = JSON.stringify({ decision: "allow" });
        }
        const input = io.stdin();
        // Hook and status-line payloads are small; an oversized one is dropped, never parsed.
        if (Buffer.byteLength(input, "utf8") > AGENT_EVENT_MAX_BYTES) throw new Error("payload exceeds the agent-event bound");
        const raw = JSON.parse(input) as unknown;
        handleAgentEvent({
          vendor,
          raw,
          ...(parsed.flags.has("clone") ? { clone: resolve(io.cwd, requireFlag(parsed, "clone")) } : {}),
          ...(parsed.flags.has("agent") ? { agent: requireFlag(parsed, "agent") } : {}),
          ...(parsed.flags.has("issue") ? { issue: parseIssue(requireFlag(parsed, "issue")) } : {}),
          ...(explicitEvent === undefined ? {} : { explicitEvent }),
          environmentIssue: io.env.COORD_ISSUE
        });
      } catch (error) {
        io.stderr(`coord agent-event: ${error instanceof Error ? error.message : String(error)}\n`);
      }
      io.stdout(`${response}\n`);
      return 0;
    }

    if (command === "git-guard") {
      allowedFlags(parsed, ["vendor", "clone"]);
      if (parsed.positionals.length !== 0) throw new Error("git-guard takes no positional arguments.");
      // A blocking hook, kept apart from the fail-open agent-event receiver.
      // Its own failure still answers "allow": a vendor treats a crashed hook
      // that way anyway, and the shim stays behind it as the second layer.
      let vendor: LifecycleVendor | null = null;
      try {
        vendor = lifecycleVendorSchema.parse(requireFlag(parsed, "vendor"));
        const clone = resolve(io.cwd, requireFlag(parsed, "clone"));
        const input = io.stdin();
        if (Buffer.byteLength(input, "utf8") > AGENT_EVENT_MAX_BYTES) throw new Error("payload exceeds the git-guard bound");
        const result = runShellGuard({ vendor, clone, raw: JSON.parse(input) as unknown, env: io.env });
        if (result.recordError !== undefined) io.stderr(`coord git-guard: deny not recorded: ${result.recordError}\n`);
        if (result.output !== "") io.stdout(`${result.output}\n`);
      } catch (error) {
        io.stderr(`coord git-guard: ${error instanceof Error ? error.message : String(error)}\n`);
        if (vendor !== null && SHELL_GUARD_ALLOW[vendor] !== "") io.stdout(`${SHELL_GUARD_ALLOW[vendor]}\n`);
      }
      return 0;
    }

    if (command === "containment-probe") {
      allowedFlags(parsed, ["clone", "issue", "refusal-ran"]);
      if (parsed.positionals.length !== 0) throw new Error("containment-probe takes no positional arguments.");
      const result = runContainmentProbe({
        clone: parsed.flags.has("clone") ? resolve(io.cwd, requireFlag(parsed, "clone")) : io.cwd,
        env: io.env,
        ...(parsed.flags.has("issue") ? { issue: parseIssue(requireFlag(parsed, "issue")) } : {}),
        refusalRan: flagIsSet(parsed, "refusal-ran")
      });
      io.stdout(`${result.lines.join("\n")}\n`);
      return 0;
    }

    if (command === "hook-verify") {
      allowedFlags(parsed, ["clone", "phase"]);
      if (parsed.positionals.length !== 0) throw new Error("hook-verify takes no positional arguments.");
      const clone = resolve(io.cwd, requireFlag(parsed, "clone"));
      const phase = verifyPhaseSchema.parse(requireFlag(parsed, "phase"));
      const { config } = resolveWorkspaceConfig(clone);
      const result = runVerifyPhase({ clone, config, phase, log: io.stdout });
      if (result.ok) return 0;
      io.stderr(
        `HOOK BLOCKED: declared ${phase} check '${result.failed.name}' failed with exit ${result.exitCode}.\n` +
          `  argv: ${result.failed.argv.join(" ")}\n`
      );
      return 1;
    }

    if (command === "hook-scope") {
      allowedFlags(parsed, ["clone"]);
      if (parsed.positionals.length !== 0) throw new Error("hook-scope takes no positional arguments.");
      const clone = resolve(io.cwd, requireFlag(parsed, "clone"));
      io.stdout(renderHookScope(resolveWorkspaceConfig(clone).config));
      return 0;
    }

    if (command === "start") {
      allowedFlags(parsed, ["profile", "config", "coord-root", "product", "verbose"]);
      if (parsed.positionals.length !== 1) throw new Error("start requires exactly one issue number.");
      verboseState.enabled = flagIsSet(parsed, "verbose");
      const issue = parseIssue(parsed.positionals[0] as string);
      const resolution = resolveStart(parsed, io);
      await assertNoManualSession(resolution.runtimeRoot);
      await startIssue(issue, resolution);
      return 0;
    }

    if (command === "attach") {
      allowedFlags(parsed, ["product", "config", "coord-root"]);
      if (parsed.positionals.length !== 1) throw new Error("attach requires exactly one issue number.");
      const issue = parseIssue(parsed.positionals[0] as string);
      const resolution = resolveStart(parsed, io);
      await assertNoManualSession(resolution.runtimeRoot);
      const paths = existingIssueRuntime(resolution, issue);
      if (paths === null) {
        throw new Error(`No runtime state exists for issue ${issue}. Start it with coord ${issue} first.`);
      }
      const start = readStartState(paths);
      const tmux = new TmuxController(undefined, paths.tmuxNamespace, undefined, undefined, undefined, paths.terminalGroup);
      const session = tmux.sessionName(issue);
      const present = await runArgv(["tmux", "has-session", "-t", session], io.cwd);
      if (present.exitCode !== 0) {
        throw new Error(`tmux session ${session} is not running. Resume with coord ${issue} first.`);
      }
      reportOwnerAgentClients(await tmux.openOwnerAgentClients(issue, start.agents), io.stdout);
      return 0;
    }

    if (command === "detach") {
      allowedFlags(parsed, ["product", "config", "coord-root", ...(booleanFlags.detach ?? [])]);
      if (parsed.positionals.length !== 1) throw new Error("detach requires exactly one issue number or 'manual'.");
      const resolution = resolveStart(parsed, io);
      if (parsed.positionals[0] === "manual") {
        const identity = workspaceUiIdentity(resolution.runtimeRoot);
        const outcome = await detachIssue({
          issue: "manual",
          agentIds: resolution.config.agents.map((agent) => agent.id),
          tmuxNamespace: identity.tmuxNamespace,
          terminalGroup: identity.terminalGroup,
          dryRun: flagIsSet(parsed, "dry-run"),
          log: io.stdout
        });
        io.stdout(
          `Detached manual mode: killed ${outcome.killedSessions.length} tmux session(s)` +
            (outcome.terminalClose === "closed"
              ? `, closed ${outcome.closedTerminalTitles.length} Terminal window(s)`
              : "") +
            ".\n"
        );
        return 0;
      }
      const issue = parseIssue(parsed.positionals[0] as string);
      const paths = existingIssueRuntime(resolution, issue);
      const agentIds =
        paths === null
          ? resolution.config.agents.map((agent) => agent.id)
          : readStartState(paths).agents.map((agent) => agent.id);
      const outcome = await detachIssue({
        issue,
        agentIds,
        tmuxNamespace: paths?.tmuxNamespace ?? null,
        terminalGroup: paths?.terminalGroup ?? null,
        dryRun: flagIsSet(parsed, "dry-run"),
        log: io.stdout
      });
      io.stdout(
        `Detached issue ${issue}: killed ${outcome.killedSessions.length} tmux session(s)` +
          (outcome.terminalClose === "closed"
            ? `, closed ${outcome.closedTerminalTitles.length} Terminal window(s)`
            : "") +
          ". Runtime left intact.\n"
      );
      return 0;
    }

    if (command === "wipe-issue") {
      allowedFlags(parsed, ["product", "config", "coord-root", ...(booleanFlags["wipe-issue"] ?? [])]);
      if (parsed.positionals.length !== 1) throw new Error("wipe-issue requires exactly one issue number.");
      const issue = parseIssue(parsed.positionals[0] as string);
      const resolution = resolveStart(parsed, io);
      const outcome = await wipeIssue({
        issue,
        config: resolution.config,
        configPath: resolution.configPath,
        coordRoot: resolution.runtimeRoot,
        completesRoot: withStoredMailbox(issueRuntimePaths(resolution.runtimeRoot, issue, resolution.config.completesRoot))
          .completesRoot,
        force: flagIsSet(parsed, "force"),
        dryRun: flagIsSet(parsed, "dry-run"),
        deleteEvidence: flagIsSet(parsed, "delete-evidence"),
        log: io.stdout
      });
      if (!flagIsSet(parsed, "delete-evidence")) {
        io.stdout(
          "Kept issue coordinator-evidence branch (ballot audit trail); re-run with --delete-evidence to remove it.\n"
        );
      }      io.stdout(
        `Wiped issue ${issue}: reset ${outcome.resetClones.length} clone(s), ` +
          `deleted ${outcome.deletedRemoteBranches.length} remote branch(es), ` +
          `GitHub issue left open.\n`
      );
      return 0;
    }

    if (command === "reset-clones") {
      allowedFlags(parsed, ["product", "config", "coord-root", ...(booleanFlags["reset-clones"] ?? [])]);
      if (parsed.positionals.length !== 1) throw new Error("reset-clones requires exactly one issue number.");
      const issue = parseIssue(parsed.positionals[0] as string);
      const resolution = resolveStart(parsed, io);
      const force = flagIsSet(parsed, "force");
      const dryRun = flagIsSet(parsed, "dry-run");
      const agents = resolution.config.agents.map((agent) => ({
        id: agent.id,
        root: resolve(dirname(resolution.configPath), agent.root)
      }));
      const readiness = makeAgentClonesBaseReady({
        agents,
        issue,
        branchTemplate: resolution.config.branch,
        baseBranch: resolution.config.baseBranch,
        installRoot: resolution.config.coordination?.installRoot ?? null,
        discardPolicy: force ? "force-wipe" : "finished-issue-only",
        dryRun,
        log: io.stdout
      });
      const cleaned = readiness.filter((result) => result.discardedPaths.length > 0).length;
      const checkedOut = readiness.filter((result) => result.action === "checked-out").length;
      const alreadyBase = readiness.filter((result) => result.action === "already-base").length;
      const refused = readiness.filter((result) => result.action === "refused");
      const skipped = readiness.filter((result) => result.action === "skipped-missing").length;
      io.stdout(
        `Reset clones for issue ${issue}: cleaned ${cleaned}, checked out ${checkedOut}, ` +
          `already base ${alreadyBase}, refused ${refused.length}, skipped ${skipped}. ` +
          "Runtime left intact.\n"
      );
      if (refused.length === 0) return 0;
      for (const result of refused) {
        io.stderr(
          `  refused ${result.agent} (${result.clone}): ${result.reason ?? "readiness refused"}\n`
        );
      }
      io.stderr(
        `Clone readiness refused for ${refused.length} clone(s). ` +
          `Do not run git checkout ${resolution.config.baseBranch} by hand — the AGENTS.md protocol ` +
          `overlay (skip-worktree) blocks it. Re-run with --force to discard unrelated dirt, ` +
          "or commit/stash that work first.\n"
      );
      const runtime = existingIssueRuntime(resolution, issue);
      if (runtime !== null) {
        appendJournal(
          runtime,
          {
            type: "clone-readiness-refused",
            details: {
              command: "reset-clones",
              refused: refused.map((result) => ({
                agent: result.agent,
                clone: result.clone,
                reason: result.reason ?? "readiness refused"
              }))
            }
          },
          new Date().toISOString()
        );
      }
      return 1;
    }

    if (command === "run") {
      allowedFlags(parsed, ["issue", "coord-root", "product", "verbose"]);
      if (parsed.positionals.length !== 0) throw new Error("run takes no positional arguments.");
      verboseState.enabled = flagIsSet(parsed, "verbose");
      const paths = existingContext(parsed, io);
      await assertIssueCanRun(paths);
      return await runIssue(paths);
    }

    if (command === "status") {
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 0) throw new Error("status takes no positional arguments.");
      const paths = existingContext(parsed, io);
      io.stdout(renderIssueReport(readStartState(paths), readCursorsState(paths), readAgentLifecycle(paths)));
      return 0;
    }

    if (command === "analytics") {
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 0) throw new Error("analytics takes no positional arguments.");
      const paths = existingContext(parsed, io);
      const runtime = readAnalyticsRuntime(paths);
      const home = dependencies.home === undefined ? homedir() : dependencies.home;
      io.stdout(
        renderAnalytics(
          buildAnalytics({
            start: runtime.start,
            journal: runtime.journal,
            activeRoster: runtime.activeRoster,
            source: runtime.source,
            transcriptRoots: {
              claude: home === null ? null : resolve(home, ".claude"),
              codex: home === null ? null : resolve(home, ".codex")
            }
          })
        )
      );
      return 0;
    }

    if (command === "next") {
      allowedFlags(parsed, ["issue", "coord-root", "product", "agent"]);
      if (parsed.positionals.length !== 0) throw new Error("next takes no positional arguments.");
      const { paths, agent } = nextContext(parsed, io);
      const start = readStartState(paths);
      if (!start.originalRoster.includes(agent)) throw new Error(`Unknown agent ${agent}.`);
      const actionPath = agentRuntimePaths(paths, agent).action;
      if (!existsSync(actionPath)) {
        io.stdout("none yet\n");
        return 0;
      }
      const action = readAction(actionPath);
      if (action.agent !== agent) throw new Error("Action identity does not match the caller.");
      io.stdout(readFileSync(actionPath, "utf8"));
      return 0;
    }

    if (command === "answer") {
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 2) {
        throw new Error("answer requires <question-id> and one of retry, revise, or abandon.");
      }
      const paths = existingContext(parsed, io);
      const questionId = parsed.positionals[0] as string;
      const answer = parsed.positionals[1] as string;
      if (!(answer === "retry" || answer === "revise" || answer === "abandon")) {
        throw new Error("answer must be retry, revise, or abandon.");
      }
      const before = readCursorsState(paths);
      if (before.lastOwnerAnswer?.questionId === questionId && before.lastOwnerAnswer.answer === answer) {
        io.stdout("Owner answer was already applied.\n");
        return 0;
      }
      const now = new Date().toISOString();
      const result = mutateCursorsState(paths, (current) => {
        const question = current.ownerQuestion;
        if (current.holds.length > 0 && answer !== "abandon") throw new Error("Release active holds explicitly before advancing an owner question.");
        if (question === null || question.id !== questionId) throw new Error(`Owner question ${questionId} is stale or unknown.`);
        if (!question.allowedAnswers.includes(answer)) {
          throw new Error(`Answer ${answer} is not allowed for owner question ${questionId}.`);
        }
        appendJournal(
          paths,
          { type: "owner-answer", details: { questionId, kind: question.kind, round: question.round, answer } },
          now
        );
        let next: CursorsState = cursorsStateSchema.parse({
          ...current,
          ownerQuestion: null,
          lastOwnerAnswer: { questionId, answer, answeredAt: now },
          abandoned: answer === "abandon" ? true : current.abandoned,
          updatedAt: now
        });
        if (answer === "retry" || answer === "revise") {
          const targetRound = answer === "revise" ? question.round + 1 : question.round;
          if (targetRound > readStartState(paths).maxRevisionRounds) throw new Error("Owner answer cannot enter revision round 4.");
          const stepId = answer === "revise" ? "R6.revise" : "R6.ballot";
          next = cursorsStateSchema.parse({
            ...next,
            issueCursor: { stepId, gateId: "gate-6-consensus", round: targetRound },
            accepted:
              answer === "retry"
                ? next.accepted.filter(
                    (submission) => !(submission.stepId === "R6.ballot" && submission.round === question.round)
                  )
                : next.accepted,
            acceptedResponses:
              answer === "retry"
                ? next.acceptedResponses.filter(
                    (response) => !(response.stepId === "R6.ballot" && response.round === question.round)
                  )
                : next.acceptedResponses,
            // Retain published batch history; invalidate only unpublished stale batches.
            ballotBatches: invalidateUnpublishedBatches(
              next.ballotBatches,
              now,
              `invalidated by owner ${answer}`
            ),
            updatedAt: now
          });
          for (const agent of next.activeRoster) {
            const priorActionId = next.agents[agent]?.actionId ?? null;
            clearAgentLocalWork(paths, agent, priorActionId);
            next = replaceCursor(
              next,
              agent,
              { stepId, actionId: null, status: "idle", submissionSha: null, outstanding: [] },
              now
            );
          }
        }
        return next;
      });
      if (!result.state.abandoned) await makeRunLoop(paths).runTick();
      io.stdout(`Owner answer ${answer} applied.\n`);
      return 0;
    }

    if (command === "drop") {
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 1) throw new Error("drop requires exactly one agent id.");
      const paths = existingContext(parsed, io);
      const agent = parsed.positionals[0] as string;
      const now = new Date().toISOString();
      mutateCursorsState(paths, (current) => {
        if (current.holds.length > 0) throw new Error("Release active holds explicitly before dropping an agent.");
        if (current.completed || current.publication.status === "completed") {
          throw new Error("Cannot drop an agent after finalization publication or workflow completion.");
        }
        if (!current.activeRoster.includes(agent)) throw new Error(`${agent} is not active.`);
        if (current.activeRoster.length === 1) throw new Error("Cannot drop the final active agent.");
        if (current.derived.implementationSelection?.reviser === agent) {
          throw new Error(
            `Cannot drop authorized reviser ${agent}; revision and finalization must not be rebound after the canonical implementation decision.`
          );
        }
        appendJournal(paths, { type: "agent-dropped", agent, details: {} }, now);
        return rederiveAfterDrop(paths, current, agent, now);
      });
      await makeRunLoop(paths).runTick();
      io.stdout(`Dropped ${agent}; remaining inputs have been rederived.\n`);
      return 0;
    }

    if (command === "pause" || command === "resume") {
      allowedFlags(parsed, ["issue", "coord-root", "product", ...(command === "resume" ? ["agent", "hold", "reset-nudge-budget", "run"] : [])]);
      if (parsed.positionals.length !== 0) throw new Error(`${command} takes no positional arguments.`);
      const paths = existingContext(parsed, io);
      const paused = command === "pause";
      const requestedHold = parsed.flags.has("hold") ? requireFlag(parsed, "hold") : null;
      const requestedAgent = parsed.flags.has("agent") ? requireFlag(parsed, "agent") : null;
      if (requestedHold !== null && requestedAgent !== null) throw new Error("--agent and --hold are mutually exclusive.");
      const resetBudget = flagIsSet(parsed, "reset-nudge-budget");
      if (resetBudget && requestedHold === null && requestedAgent === null) {
        throw new Error("--reset-nudge-budget requires --hold or --agent.");
      }
      const run = flagIsSet(parsed, "run");
      if (run) await assertIssueCanRun(paths);
      const now = new Date().toISOString();
      const result = mutateCursorsState(paths, (current) => {
        let holdId = requestedHold;
        if (requestedAgent !== null) {
          if (!current.activeRoster.includes(requestedAgent)) throw new Error(`Agent ${requestedAgent} is not active.`);
          const holds = current.holds.filter((hold) => hold.agent === requestedAgent);
          if (holds.length !== 1) {
            throw new Error(`Agent ${requestedAgent} has ${holds.length} active holds; --agent requires exactly one. ` +
              `Use --hold <id> to select one. Hold IDs: ${holds.map((hold) => hold.id).join(", ") || "(none)"}.`);
          }
          holdId = holds[0]!.id;
        }
        const next = holdId === null ? setPaused(current, paused, now) : releaseHold(current, holdId, resetBudget, now);
        if (holdId !== null) appendJournal(paths, { type: "hold-released", details: {
          hold: holdId, resetNudgeBudget: resetBudget, eventId: `release:${holdId}`
        } }, now);
        if (current.paused !== next.paused) appendJournal(paths, { type: next.paused ? "paused" : "resumed", details: {} }, now);
        return next;
      });
      io.stdout(`${result.state.paused ? "Paused" : "Resumed"} issue ${readStartState(paths).issue}.` +
        (result.state.holds.length > 0 ? ` ${result.state.holds.length} active hold(s); use coord status for scoped recovery.` : "") + "\n");
      if (run) return await runIssue(paths);
      if (!paused) io.stdout("A running coordinator continues after all pauses are released; add --run only if it was stopped.\n");
      return 0;
    }

    if (command === "restart-action") {
      allowedFlags(parsed, ["issue", "coord-root", "product", "agent"]);
      if (parsed.positionals.length !== 0) throw new Error("restart-action takes no positional arguments.");
      const paths = existingContext(parsed, io);
      const requestedAgent = parsed.flags.has("agent") ? requireFlag(parsed, "agent") : null;
      const now = new Date().toISOString();
      mutateCursorsState(paths, (current) => {
        if (current.holds.length > 0) throw new Error("Release active holds explicitly before restarting work.");
        const agents = requestedAgent === null ? current.activeRoster : [requestedAgent];
        if (agents.some((agent) => !current.activeRoster.includes(agent))) throw new Error("restart-action agent must be active.");
        appendJournal(paths, { type: "action-restarted", details: { agents } }, now);
        let next: CursorsState = cursorsStateSchema.parse({
          ...current,
          // Preserve still-valid accepted responses; retain published batch history;
          // invalidate only unpublished stale roster batches.
          ballotBatches: invalidateUnpublishedBatches(
            current.ballotBatches,
            now,
            "invalidated by restart-action"
          ),
          updatedAt: now
        });
        for (const agent of agents) {
          const priorActionId = next.agents[agent]?.actionId ?? null;
          clearAgentLocalWork(paths, agent, priorActionId);
          next = replaceCursor(next, agent, { actionId: null, status: "idle", submissionSha: null, outstanding: [] }, now);
        }
        return next;
      });
      await makeRunLoop(paths).runTick();
      io.stdout("Action restarted.\n");
      return 0;
    }

    if (command === "abandon") {
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 0) throw new Error("abandon takes no positional arguments.");
      const paths = existingContext(parsed, io);
      const now = new Date().toISOString();
      mutateCursorsState(paths, (current) => {
        appendJournal(paths, { type: "abandoned", details: {} }, now);
        return cursorsStateSchema.parse({ ...current, abandoned: true, ownerQuestion: null, updatedAt: now });
      });
      io.stdout("Workflow abandoned; runtime state was retained.\n");
      return 0;
    }

    throw new Error(`Unknown command ${command}.`);
  } catch (error) {
    io.stderr(`coord: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
};
