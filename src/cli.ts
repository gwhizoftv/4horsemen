import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCompletion, readAction } from "./action.js";
import { doctor, renderDoctorReport } from "./doctor.js";
import { fetchGitHubIssueSnapshot } from "./githubIssue.js";
import { sha256 } from "./hash.js";
import { renderHookScope, resolveWorkspaceConfig, runVerifyPhase } from "./hookPolicy.js";
import { install, onboard, uninstall } from "./install.js";
import { BareMirror } from "./mirror.js";
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
import { CoordinatorRunLoop, deterministicWinner, githubRepositoryFromOrigin, runArgv, type ProcessRunner } from "./runLoop.js";
import {
  appendJournal,
  atomicWriteJson,
  cursorsStateSchema,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readCursorsState,
  readStartState,
  replaceCursor,
  setPaused,
  verifyPhaseSchema,
  type CoordinatorConfig,
  type CursorsState
} from "./state.js";
import type { WorkflowProfile } from "./steps.js";
import { resolveAgentLauncher, TmuxController } from "./tmux.js";
import { resolveRuntimeLocation } from "./workspace.js";

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
    if (value === undefined || value.startsWith("--")) throw new Error(`Option ${argument} requires a value.`);
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
  onboard: ["dry-run"]
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

const parseProfile = (value: string): WorkflowProfile => {
  if (!(value === "solo" || value === "reviewed" || value === "consensus")) {
    throw new Error("--profile must be solo, reviewed, or consensus.");
  }
  return value;
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

Happy path:
  curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
  coord onboard /path/to/app
  gh issue create --title "…" --body "…"
  coord 42

Usage:
  coord onboard <product> [--coord-root <path>] [--clone-root <dir>] [--agents a,b,c] [--profile <p>]
  coord install --product <path> --coord-root <external-path> --agents <a,b,c> [--profile <p>]
                [--clone-root <dir>] [--declare <file>] [--write-product] [--vendor]
                [--bootstrap-coordination] [--dry-run]
  coord uninstall --coord-root <path> --product <path> [--delete-clones] [--force]
                  [--wipe-runtime] [--delete-coordination] [--dry-run]
  coord doctor --coord-root <path> --product <path>
  coord <issue> [--product <path>] [--profile <solo|reviewed|consensus>]
                [--config <path> --coord-root <path>]
  coord start <issue> [--profile <solo|reviewed|consensus>] [--product <path>]
                      [--config <path> --coord-root <path>]
  coord run --issue <issue> --coord-root <path>
  coord next --issue <issue> --coord-root <path> --agent <agent>
  coord answer <question-id> <retry|revise|abandon> --issue <issue> --coord-root <path>
  coord drop <agent> --issue <issue> --coord-root <path>
  coord pause|resume|restart-action|abandon --issue <issue> --coord-root <path>

Called by the agent-clone hooks, not by operators:
  coord hook-verify --clone <path> --phase <precommit|prepush>
  coord hook-scope --clone <path>

onboard leaves the product's tracked tree untouched: wiring lands in agent clones
and under the runtime. Agents author .plans/issue-N/plan.md on their issue branches;
owners do not pre-create an owner plan under the runtime.

COORD_ISSUE and COORD_AGENT may replace the corresponding options. Explicit
--config/--coord-root still work; otherwise --product or the cwd locator is used.
`;

export const automationDigestMaterial = (
  configPath: string,
  config: CoordinatorConfig,
  issue: number,
  issueSnapshotBytes: string
): { digest: string; sources: Array<{ id: string; sha256: string }> } => {
  const configRoot = dirname(configPath);
  assertNoSymlink(configRoot, configPath);
  const sourceBytes: Array<{ id: string; content: string }> = [
    { id: "config", content: readFileSync(configPath, "utf8") },
    { id: "github-issue", content: issueSnapshotBytes }
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


export type StartIssueOptions = {
  issue: number;
  profile?: WorkflowProfile;
  configPath?: string;
  coordRoot?: string;
  productRoot?: string;
  /** When true, resume an existing runtime instead of refusing it. */
  resumeIfPresent: boolean;
  io: CliIo;
  runner: ProcessRunner;
  startEffects: NonNullable<CliDependencies["startEffects"]>;
  makeRunLoop: (paths: IssueRuntimePaths) => CliRunLoop;
};

export type StartIssueResult = {
  paths: IssueRuntimePaths;
  profile: WorkflowProfile;
  resumed: boolean;
  workspaceRoot: string;
};

/**
 * Shared start/resume transaction used by `coord start` and `coord N`.
 * Fetches the GitHub issue snapshot before any runtime or tmux effects.
 */
export const startIssue = async (options: StartIssueOptions): Promise<StartIssueResult> => {
  const resolved = resolveRuntimeLocation({
    cwd: options.io.cwd,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.coordRoot === undefined ? {} : { coordRoot: options.coordRoot }),
    ...(options.productRoot === undefined ? {} : { productRoot: options.productRoot })
  });
  const { location, config } = resolved;
  const configPath = location.configPath;
  const profile = options.profile ?? config.profile;
  const agents = config.agents.map((agent) => ({ ...agent, root: resolve(dirname(configPath), agent.root) }));
  const roster = profile === "solo" ? agents.slice(0, 1) : agents;
  if (roster.length === 0) throw new Error(`Profile ${profile} requires at least one configured agent.`);
  if (githubRepositoryFromOrigin(config.origin) === null) {
    throw new Error(
      `origin ${config.origin} is not a supported github.com repository; cannot fetch issue ${options.issue}.`
    );
  }
  if (config.prPolicy === "coord-open-unmerged" && githubRepositoryFromOrigin(config.origin) === null) {
    throw new Error(
      `prPolicy "coord-open-unmerged" requires a supported github.com origin; ${config.origin} is incompatible.`
    );
  }
  for (const agent of roster) resolveAgentLauncher(agent);

  const workspaceRoot = resolveSafeCoordRoot({
    coordRoot: location.workspaceRoot,
    agentRoots: agents.map((agent) => agent.root),
    create: false
  });
  const paths = issueRuntimePaths(workspaceRoot, options.issue);

  if (existsSync(paths.issueRoot)) {
    if (!options.resumeIfPresent) {
      throw new Error(`Runtime state already exists for issue ${options.issue}. Use resume or abandon it explicitly.`);
    }
    if (!existsSync(paths.start)) {
      throw new Error(`Issue ${options.issue} runtime is incomplete at ${paths.issueRoot}; abandon it and restart.`);
    }
    return { paths, profile: readStartState(paths).profile, resumed: true, workspaceRoot };
  }

  const { bytes: issueSnapshotBytes } = await fetchGitHubIssueSnapshot({
    origin: config.origin,
    issue: options.issue,
    runner: options.runner,
    cwd: options.io.cwd
  });
  const digest = automationDigestMaterial(configPath, config, options.issue, issueSnapshotBytes);

  const baselineResult = await options.runner(
    ["git", "ls-remote", "--exit-code", config.origin, `refs/heads/${config.baseBranch}`],
    options.io.cwd
  );
  if (baselineResult.exitCode !== 0) throw new Error(`Cannot resolve origin baseline: ${baselineResult.stderr.trim()}`);
  const baselineSha = baselineResult.stdout.trim().split(/\s+/)[0];
  const parsedBaseline = gitShaSchema.safeParse(baselineSha);
  if (!parsedBaseline.success) throw new Error("Origin returned an invalid baseline SHA.");
  const trustedSourceResult = await options.runner(
    ["git", "rev-parse", "--verify", "HEAD^{commit}"],
    coordinatorSourceRoot
  );
  if (trustedSourceResult.exitCode !== 0) {
    throw new Error(`Cannot resolve trusted coordinator source commit: ${trustedSourceResult.stderr.trim()}`);
  }
  const trustedSourceCommit = gitShaSchema.safeParse(trustedSourceResult.stdout.trim());
  if (!trustedSourceCommit.success) throw new Error("Coordinator source checkout returned an invalid trusted commit SHA.");

  let effects: { cleanup: () => Promise<void> } | null = null;
  try {
    effects = await options.startEffects({ paths, issue: options.issue, origin: config.origin, agents: roster });
    createIssueRuntime(paths, roster.map((agent) => agent.id));
    atomicWriteJson(paths.coordRoot, paths.issueSnapshot, JSON.parse(issueSnapshotBytes) as unknown);
    initializeOperationalState(paths, {
      issue: options.issue,
      issueSessionId: `issue-${options.issue}:${parsedBaseline.data}`,
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
      coordRoot: workspaceRoot,
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
        options.io.stderr(
          `coord: startup cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}\n`
        );
      }
    }
    throw error;
  }

  try {
    await options.makeRunLoop(paths).runTick();
  } catch (error) {
    throw new Error(
      `Issue ${options.issue} was started durably at ${paths.issueRoot}, but its initial tick failed; ` +
        `resume with coord run --issue ${options.issue} --coord-root ${workspaceRoot}: ${
          error instanceof Error ? error.message : String(error)
        }`
    );
  }

  return { paths, profile, resumed: false, workspaceRoot };
};

const defaultStartEffects = async (input: {
  paths: IssueRuntimePaths;
  issue: number;
  origin: string;
  agents: CoordinatorConfig["agents"];
}): Promise<{ cleanup: () => Promise<void> }> => {
  const mirror = new BareMirror(input.paths.mirror, input.origin);
  await mirror.initialize();
  const tmux = new TmuxController();
  await tmux.startSession(input.issue, input.agents);
  return { cleanup: async () => tmux.stopSession(input.issue) };
};

export const runCli = async (argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> => {
  const io: CliIo = { ...defaultIo, ...dependencies.io };
  const runner = dependencies.processRunner ?? runArgv;
  const makeRunLoop = dependencies.makeRunLoop ?? ((paths: IssueRuntimePaths) => new CoordinatorRunLoop(paths));
  const startEffects =
    dependencies.startEffects ??
    (dependencies.makeRunLoop === undefined
      ? defaultStartEffects
      : async () => ({ cleanup: async () => undefined }));
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout(help);
    return 0;
  }

  try {
    const parsed = parseArgs(rest, booleanFlags[command] ?? []);

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

    if (command === "onboard") {
      allowedFlags(parsed, ["coord-root", "clone-root", "agents", "profile", ...(booleanFlags.onboard ?? [])]);
      if (parsed.positionals.length !== 1) throw new Error("onboard requires exactly one product path.");
      const productRoot = resolve(io.cwd, parsed.positionals[0] as string);
      const agentsFlag = parsed.flags.get("agents");
      const agents =
        agentsFlag === undefined
          ? undefined
          : agentsFlag
              .split(",")
              .map((agent) => agent.trim())
              .filter((agent) => agent !== "");
      if (agents !== undefined && agents.length === 0) throw new Error("--agents requires at least one agent id.");
      const profileValue = parsed.flags.get("profile");
      const profile = profileValue === undefined ? undefined : parseProfile(profileValue);
      const result = onboard({
        installRoot: coordinatorSourceRoot,
        productRoot,
        ...(parsed.flags.has("coord-root") ? { coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")) } : {}),
        ...(parsed.flags.has("clone-root") ? { cloneRoot: resolve(io.cwd, requireFlag(parsed, "clone-root")) } : {}),
        ...(agents === undefined ? {} : { agents }),
        ...(profile === undefined ? {} : { profile }),
        dryRun: flagIsSet(parsed, "dry-run"),
        log: io.stdout
      });
      const report = doctor({
        coordRoot: result.location.coordRoot,
        productRoot,
        configPath: result.configPath
      });
      (report.exitCode === 0 ? io.stdout : io.stderr)(renderDoctorReport(report));
      return report.exitCode;
    }

    if (command === "start" || /^[1-9][0-9]*$/.test(command)) {
      const numeric = /^[1-9][0-9]*$/.test(command);
      allowedFlags(parsed, ["profile", "config", "coord-root", "product"]);
      const issue = numeric ? parseIssue(command) : parseIssue(parsed.positionals[0] as string);
      if (!numeric && parsed.positionals.length !== 1) throw new Error("start requires exactly one issue number.");
      if (numeric && parsed.positionals.length !== 0) throw new Error("coord <issue> takes no positional arguments.");
      const profile = parsed.flags.has("profile") ? parseProfile(requireFlag(parsed, "profile")) : undefined;
      const started = await startIssue({
        issue,
        ...(profile === undefined ? {} : { profile }),
        ...(parsed.flags.has("config") ? { configPath: requireFlag(parsed, "config") } : {}),
        ...(parsed.flags.has("coord-root") ? { coordRoot: requireFlag(parsed, "coord-root") } : {}),
        ...(parsed.flags.has("product") ? { productRoot: requireFlag(parsed, "product") } : {}),
        resumeIfPresent: numeric,
        io,
        runner,
        startEffects,
        makeRunLoop
      });
      if (numeric) {
        if (started.resumed) {
          io.stdout(`Resuming issue ${issue} at ${started.paths.issueRoot}.\n`);
        } else {
          io.stdout(`Started issue ${issue} (${started.profile}) at ${started.paths.issueRoot}.\n`);
        }
        await makeRunLoop(started.paths).run();
        return 0;
      }
      io.stdout(`Started issue ${issue} (${started.profile}) at ${started.paths.issueRoot}.\n`);
      return 0;
    }

    if (command === "run") {
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error("run takes no positional arguments.");
      await makeRunLoop(context(parsed, io)).run();
      return 0;
    }

    if (command === "next") {
      allowedFlags(parsed, ["issue", "coord-root", "agent"]);
      if (parsed.positionals.length !== 0) throw new Error("next takes no positional arguments.");
      const paths = context(parsed, io);
      const agent = parsed.flags.get("agent") ?? io.env.COORD_AGENT;
      if (agent === undefined) throw new Error("--agent or COORD_AGENT is required.");
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
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 2) {
        throw new Error("answer requires <question-id> and one of retry, revise, or abandon.");
      }
      const paths = context(parsed, io);
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
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 1) throw new Error("drop requires exactly one agent id.");
      const paths = context(parsed, io);
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
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error(`${command} takes no positional arguments.`);
      const paths = context(parsed, io);
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
      allowedFlags(parsed, ["issue", "coord-root", "agent"]);
      if (parsed.positionals.length !== 0) throw new Error("restart-action takes no positional arguments.");
      const paths = context(parsed, io);
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
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error("abandon takes no positional arguments.");
      const paths = context(parsed, io);
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
