import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCompletion, readAction } from "./action.js";
import { doctor, renderDoctorReport } from "./doctor.js";
import { fetchGitHubIssue, renderGitHubIssueSnapshot } from "./githubIssue.js";
import { sha256 } from "./hash.js";
import { renderHookScope, resolveWorkspaceConfig, runVerifyPhase, WORKSPACE_CONFIG_KEY } from "./hookPolicy.js";
import { install, onboard, packageVersion, uninstall } from "./install.js";
import { BareMirror } from "./mirror.js";
import { localConfigGet, worktreeRoot } from "./gitExec.js";
import {
  agentRuntimePaths,
  assertNoSymlink,
  containedPath,
  createIssueRuntime,
  issueRuntimePaths,
  resolveSafeCoordRoot,
  type IssueRuntimePaths
} from "./paths.js";
import { gitShaSchema } from "./protocol.js";
import { CoordinatorRunLoop, deterministicWinner, runArgv, type ProcessRunner } from "./runLoop.js";
import {
  appendJournal,
  atomicWriteJson,
  cursorsStateSchema,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readConfig,
  readCursorsState,
  readStartState,
  replaceCursor,
  setPaused,
  verifyPhaseSchema,
  type CoordinatorConfig,
  type CursorsState
} from "./state.js";
import type { WorkflowProfile } from "./steps.js";
import {
  resolveAgentLauncher,
  TmuxController,
  type OpenOwnerAgentClientsResult
} from "./tmux.js";
import { resolveWorkspaceFromProduct, workspaceLocationFromConfig, type WorkspaceLocation } from "./workspace.js";
import { renderIssueReport } from "./issueReport.js";
import { wipeIssue } from "./wipeIssue.js";
import { detachIssue } from "./detachIssue.js";

export type CliIo = {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
};

export type CliRunLoop = {
  initializeEffects(): Promise<void>;
  runTick(): Promise<CursorsState>;
  run(signal?: AbortSignal): Promise<void>;
};

export type CliDependencies = {
  io?: Partial<CliIo>;
  processRunner?: ProcessRunner;
  makeRunLoop?: (paths: IssueRuntimePaths) => CliRunLoop;
  startEffects?: (input: {
    paths: IssueRuntimePaths;
    issue: number;
    origin: string;
    agents: CoordinatorConfig["agents"];
    log?: (message: string) => void;
  }) => Promise<{ cleanup: () => Promise<void> }>;
};

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  env: process.env,
  cwd: process.cwd()
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
  install: ["write-product", "vendor", "bootstrap-coordination", "dry-run"],
  uninstall: ["delete-clones", "wipe-runtime", "delete-coordination", "force", "dry-run"],
  "wipe-issue": ["force", "dry-run"],
  detach: ["dry-run"]
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

const context = (parsed: ParsedArgs, io: CliIo): IssueRuntimePaths => {
  const coordRoot = requireFlag(parsed, "coord-root");
  const issueValue = parsed.flags.get("issue") ?? io.env.COORD_ISSUE;
  if (issueValue === undefined) throw new Error("--issue or COORD_ISSUE is required.");
  return issueRuntimePaths(resolve(io.cwd, coordRoot), parseIssue(issueValue));
};

const allowedFlags = (parsed: ParsedArgs, allowed: readonly string[]): void => {
  for (const flag of parsed.flags.keys()) {
    if (!allowed.includes(flag)) throw new Error(`Unknown option --${flag}.`);
  }
};

const help = `coord — owner-side workflow driver

Usage:
  coord --version | -V | version
  coord onboard <product> [--coord-root <path>] [--agents <a,b,c>] [--profile <p>]
  coord <issue> [--product <path>] [--profile <solo|reviewed|consensus>] [-v|--verbose]
  coord install --product <path> --coord-root <external-path> --agents <a,b,c> [--profile <p>]
                [--clone-root <dir>] [--declare <file>] [--write-product] [--vendor]
                [--bootstrap-coordination] [--dry-run]
  coord uninstall --coord-root <path> --product <path> [--delete-clones] [--force]
                  [--wipe-runtime] [--delete-coordination] [--dry-run]
  coord doctor --coord-root <path> --product <path>
  coord start <issue> --product <path> [--profile <solo|reviewed|consensus>] [-v|--verbose]
  coord start <issue> --config <path> --coord-root <external-path> [--profile <solo|reviewed|consensus>] [-v|--verbose]
  coord run --issue <issue> [--product <path> | --coord-root <path>] [-v|--verbose]
  coord status --issue <issue> [--product <path> | --coord-root <path>]
  coord next --issue <issue> [--product <path> | --coord-root <path>] [--agent <agent>]
  coord answer <question-id> <retry|revise|abandon> --issue <issue> [--product <path> | --coord-root <path>]
  coord drop <agent> --issue <issue> [--product <path> | --coord-root <path>]
  coord pause|resume|restart-action|abandon --issue <issue> [--product <path> | --coord-root <path>]
  coord attach <issue> [--product <path> | --coord-root <path>]
  coord detach <issue> [--product <path> | --coord-root <path>] [--dry-run]
  coord wipe-issue <issue> [--product <path> | --config <path> --coord-root <path>] [--force] [--dry-run]

Called by the agent-clone hooks, not by operators:
  coord hook-verify --clone <path> --phase <precommit|prepush>
  coord hook-scope --clone <path>

Happy path: bootstrap once, onboard a product once, create GitHub issue N, then run
\`coord N\` from that onboarded product. Agents author plans on issue-N/<agent>.

From an agent clone, \`coord next --issue N\` resolves the runtime via
coord.workspaceConfig and the caller via consensus.agentId (or --agent / COORD_AGENT).
Use \`-v\` / \`--verbose\` on \`coord N\`, start, or run for tick-level progress logs.
\`coord --version\` prints the package version (pre-1.0: \`0.0.N\`, bump on every ship).
\`coord status\` prints the chosen agent, final pin, published branch, and PR URL.

On macOS, starting an issue opens one Terminal.app window per agent, each attached
to that agent's tmux window (no Ctrl-b n). Re-open later with \`coord attach N\`.
\`coord detach N\` closes those Terminal windows and kills the issue tmux sessions
without wiping runtime or branches. A completed \`coord N\` / \`coord run\` does the
same teardown automatically. \`coord uninstall\` also tears down owner
tmux/Terminals for the workspace agents. \`coord wipe-issue N\` resets agent clones,
deletes origin issue-N/<agent> branches, wipes local issue runtime and tmux/Terminals,
and leaves the GitHub issue open.

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

const rederiveAfterDrop = (
  paths: IssueRuntimePaths,
  cursors: CursorsState,
  dropped: string,
  now: string
): CursorsState => {
  let next = dropAgent(cursors, dropped, now);
  const currentStep = next.issueCursor.stepId;
  const round = currentStep.startsWith("R6.") ? (next.issueCursor.round ?? 1) : null;
  const invalidatedAgents = new Set(
    next.accepted
      .filter(
        (submission) =>
          submission.stepId === currentStep &&
          submission.round === round &&
          (submission.choice === dropped ||
            submission.reviser === dropped ||
            submission.selectedAgents?.includes(dropped) === true)
      )
      .map((submission) => submission.agent)
  );
  next = cursorsStateSchema.parse({
    ...next,
    accepted: next.accepted.filter(
      (submission) =>
        !(
          submission.stepId === currentStep &&
          submission.round === round &&
          invalidatedAgents.has(submission.agent)
        )
    ),
    ownerQuestion: null,
    publication:
      next.publication.finalSha !== null &&
      !next.accepted.some(
        (submission) => submission.stepId === "R7.finalize" && submission.productPin === next.publication.finalSha
      )
        ? {
            status: "not-required",
            finalSha: null,
            branch: null,
            url: null,
            error: null,
            attempts: next.publication.attempts
          }
        : next.publication,
    updatedAt: now
  });

  const planEligible = next.accepted
    .filter((submission) => submission.stepId === "R2.plan" && next.activeRoster.includes(submission.agent))
    .map((submission) => submission.agent);
  const implementationEligible = next.accepted
    .filter((submission) => submission.stepId === "R4.implement" && next.activeRoster.includes(submission.agent))
    .map((submission) => submission.agent);
  const planWinner = deterministicWinner(next, "R3.plan-ballot", planEligible);
  const implementationWinner = deterministicWinner(next, "R5.compare-ballot", implementationEligible);
  const implementation = next.accepted.find(
    (submission) => submission.stepId === "R4.implement" && submission.agent === implementationWinner
  );
  const reselectPlan = cursors.selection.planAgents.length > 0 && next.selection.planAgents.length === 0;
  const reselectImplementation =
    cursors.selection.implementationAgent !== null && next.selection.implementationAgent === null;
  const reselectReviser = cursors.selection.reviser !== null && next.selection.reviser === null;
  next = cursorsStateSchema.parse({
    ...next,
    reviser: reselectReviser ? implementationWinner : next.reviser,
    selection: {
      planAgents: reselectPlan && planWinner !== null ? [planWinner] : next.selection.planAgents,
      implementationAgent: reselectImplementation ? implementationWinner : next.selection.implementationAgent,
      implementationPin: reselectImplementation ? (implementation?.productPin ?? null) : next.selection.implementationPin,
      reviser: reselectReviser ? implementationWinner : next.selection.reviser
    },
    updatedAt: now
  });

  const droppedRuntime = agentRuntimePaths(paths, dropped);
  clearCompletion(droppedRuntime.complete);
  if (existsSync(droppedRuntime.action)) unlinkSync(droppedRuntime.action);
  for (const agent of next.activeRoster) {
    const alreadySatisfied = next.accepted.some(
      (submission) => submission.stepId === currentStep && submission.agent === agent && submission.round === round
    );
    if (alreadySatisfied) continue;
    const runtime = agentRuntimePaths(paths, agent);
    if (existsSync(runtime.action)) unlinkSync(runtime.action);
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
  const start = readStartState(paths);
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
  if (currentMatches) return current;
  if (legacyMatches) return legacy;
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

const detachCompletedIssue = async (paths: IssueRuntimePaths, io: CliIo): Promise<void> => {
  const cursors = readCursorsState(paths);
  if (!cursors.completed) return;
  const start = readStartState(paths);
  const outcome = await detachIssue({
    issue: start.issue,
    agentIds: start.agents.map((agent) => agent.id),
    tmuxNamespace: paths.tmuxNamespace,
    terminalGroup: paths.terminalGroup,
    log: io.stdout
  });
  io.stdout(
    `Issue ${start.issue} complete: killed ${outcome.killedSessions.length} tmux session(s)` +
      (outcome.terminalClose === "closed"
        ? `, closed ${outcome.closedTerminalTitles.length} Terminal window(s)`
        : "") +
      ".\n"
  );
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
  const startIssue = async (issue: number, resolution: StartResolution): Promise<IssueRuntimePaths> => {
    const { configPath, config, profile } = resolution;
    const agents = config.agents.map((agent) => ({ ...agent, root: resolve(dirname(configPath), agent.root) }));
    const roster = profile === "solo" ? agents.slice(0, 1) : agents;
    if (roster.length === 0) throw new Error(`Profile ${profile} requires at least one configured agent.`);
    for (const agent of roster) resolveAgentLauncher(agent);
    const coordRoot = resolveSafeCoordRoot({
      coordRoot: resolution.runtimeRoot,
      agentRoots: agents.map((agent) => agent.root),
      create: false
    });
    const paths = issueRuntimePaths(coordRoot, issue);
    if (existsSync(paths.issueRoot)) {
      throw new Error(`Runtime state already exists for issue ${issue}. Use coord ${issue} to resume or abandon it explicitly.`);
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

    let effects: { cleanup: () => Promise<void> } | null = null;
    try {
      effects = await startEffects({ paths, issue, origin: config.origin, agents: roster, log: io.stdout });
      createIssueRuntime(paths, roster.map((agent) => agent.id));
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
        pollIntervalMs: config.pollIntervalMs
      });
    } catch (error) {
      rmSync(paths.issueRoot, { recursive: true, force: true });
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
      const existing = existingIssueRuntime(resolution, issue);
      const paths = existing ?? (await startIssue(issue, resolution));
      if (existing !== null) {
        io.stdout(`Tip: coord attach ${issue} opens one Terminal window per agent.\n`);
      }
      await makeRunLoop(paths).run();
      await detachCompletedIssue(paths, io);
      return 0;
    }

    if (command === "onboard") {
      allowedFlags(parsed, ["coord-root", "clone-root", "agents", "profile"]);
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
        ...(parsed.flags.has("clone-root") ? { cloneRoot: resolve(io.cwd, requireFlag(parsed, "clone-root")) } : {}),
        log: io.stdout
      });
      (result.doctor.exitCode === 0 ? io.stdout : io.stderr)(renderDoctorReport(result.doctor));
      return result.doctor.exitCode;
    }

    if (command === "install") {
      allowedFlags(parsed, [
        "product",
        "coord-root",
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
        ...(parsed.flags.has("clone-root") ? { cloneRoot: resolve(io.cwd, requireFlag(parsed, "clone-root")) } : {}),
        ...(parsed.flags.has("declare") ? { declarePath: resolve(io.cwd, requireFlag(parsed, "declare")) } : {}),
        ...(parsed.flags.has("origin") ? { origin: requireFlag(parsed, "origin") } : {}),
        ...(parsed.flags.has("base-branch") ? { baseBranch: requireFlag(parsed, "base-branch") } : {}),
        writeProduct: flagIsSet(parsed, "write-product"),
        vendor: flagIsSet(parsed, "vendor"),
        bootstrap: flagIsSet(parsed, "bootstrap-coordination"),
        dryRun: flagIsSet(parsed, "dry-run"),
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
        ...(parsed.flags.has("project") ? { project: requireFlag(parsed, "project") } : {})
      });
      (report.exitCode === 0 ? io.stdout : io.stderr)(renderDoctorReport(report));
      return report.exitCode;
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
      await startIssue(issue, resolveStart(parsed, io));
      return 0;
    }

    if (command === "attach") {
      allowedFlags(parsed, ["product", "config", "coord-root"]);
      if (parsed.positionals.length !== 1) throw new Error("attach requires exactly one issue number.");
      const issue = parseIssue(parsed.positionals[0] as string);
      const resolution = resolveStart(parsed, io);
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
      if (parsed.positionals.length !== 1) throw new Error("detach requires exactly one issue number.");
      const issue = parseIssue(parsed.positionals[0] as string);
      const resolution = resolveStart(parsed, io);
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
        force: flagIsSet(parsed, "force"),
        dryRun: flagIsSet(parsed, "dry-run"),
        log: io.stdout
      });
      io.stdout(
        `Wiped issue ${issue}: reset ${outcome.resetClones.length} clone(s), ` +
          `deleted ${outcome.deletedRemoteBranches.length} remote branch(es), ` +
          `GitHub issue left open.\n`
      );
      return 0;
    }

    if (command === "run") {
      allowedFlags(parsed, ["issue", "coord-root", "product", "verbose"]);
      if (parsed.positionals.length !== 0) throw new Error("run takes no positional arguments.");
      verboseState.enabled = flagIsSet(parsed, "verbose");
      const paths = existingContext(parsed, io);
      await makeRunLoop(paths).run();
      await detachCompletedIssue(paths, io);
      return 0;
    }

    if (command === "status") {
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 0) throw new Error("status takes no positional arguments.");
      const paths = existingContext(parsed, io);
      io.stdout(renderIssueReport(readStartState(paths), readCursorsState(paths)));
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
        if (question === null || question.id !== questionId) throw new Error(`Owner question ${questionId} is stale or unknown.`);
        if (!question.allowedAnswers.includes(answer)) {
          throw new Error(`Answer ${answer} is not allowed for owner question ${questionId}.`);
        }
        appendJournal(
          paths,
          { type: "owner-answer", details: { questionId, kind: question.kind, round: question.round, answer } },
          now
        );
        let next = cursorsStateSchema.parse({
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
            updatedAt: now
          });
          for (const agent of next.activeRoster) {
            const runtime = agentRuntimePaths(paths, agent);
            clearCompletion(runtime.complete);
            if (existsSync(runtime.action)) unlinkSync(runtime.action);
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
        if (current.completed || current.publication.status === "completed") {
          throw new Error("Cannot drop an agent after finalization publication or workflow completion.");
        }
        if (!current.activeRoster.includes(agent)) throw new Error(`${agent} is not active.`);
        if (current.activeRoster.length === 1) throw new Error("Cannot drop the final active agent.");
        if (current.selection.reviser === agent || current.reviser === agent) {
          throw new Error(
            `Cannot drop authorized reviser ${agent}; revision and finalization must not be rebound without a new authorization.`
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
      allowedFlags(parsed, ["issue", "coord-root", "product"]);
      if (parsed.positionals.length !== 0) throw new Error(`${command} takes no positional arguments.`);
      const paths = existingContext(parsed, io);
      const paused = command === "pause";
      const now = new Date().toISOString();
      mutateCursorsState(paths, (current) => {
        appendJournal(paths, { type: paused ? "paused" : "resumed", details: {} }, now);
        return setPaused(current, paused, now);
      });
      io.stdout(`${paused ? "Paused" : "Resumed"} issue ${readStartState(paths).issue}.\n`);
      return 0;
    }

    if (command === "restart-action") {
      allowedFlags(parsed, ["issue", "coord-root", "product", "agent"]);
      if (parsed.positionals.length !== 0) throw new Error("restart-action takes no positional arguments.");
      const paths = existingContext(parsed, io);
      const requestedAgent = parsed.flags.has("agent") ? requireFlag(parsed, "agent") : null;
      const now = new Date().toISOString();
      mutateCursorsState(paths, (current) => {
        const agents = requestedAgent === null ? current.activeRoster : [requestedAgent];
        if (agents.some((agent) => !current.activeRoster.includes(agent))) throw new Error("restart-action agent must be active.");
        appendJournal(paths, { type: "action-restarted", details: { agents } }, now);
        let next = current;
        for (const agent of agents) {
          const runtime = agentRuntimePaths(paths, agent);
          clearCompletion(runtime.complete);
          if (existsSync(runtime.action)) unlinkSync(runtime.action);
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
