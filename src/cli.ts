import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clearCompletion, readAction } from "./action.js";
import { doctorWorkspace } from "./doctor.js";
import { sha256 } from "./hash.js";
import { install } from "./install.js";
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
  cursorsStateSchema,
  dropAgent,
  initializeOperationalState,
  mutateCursorsState,
  readConfig,
  readCursorsState,
  readStartState,
  replaceCursor,
  setPaused,
  type CoordinatorConfig,
  type CursorsState
} from "./state.js";
import type { WorkflowProfile } from "./steps.js";
import { resolveAgentLauncher, TmuxController } from "./tmux.js";
import { uninstallWorkspace } from "./uninstall.js";

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
const booleanFlags = new Set([
  "dry-run",
  "vendor",
  "write-product",
  "bootstrap-coordination",
  "delete-clones",
  "force",
  "wipe-runtime",
  "delete-coordination"
]);

const parseArgs = (args: readonly string[]): ParsedArgs => {
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
    if (booleanFlags.has(name)) {
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

const enabled = (parsed: ParsedArgs, name: string): boolean => parsed.flags.get(name) === "true";

const help = `coord — owner-side workflow driver

Usage:
  coord install --product <path> --coord-root <path> --agents <ids> --profile <profile> [--dry-run]
  coord uninstall --product <path> --coord-root <path> [--delete-clones] [--force]
  coord doctor --product <path> --coord-root <path>
  coord start <issue> --profile <solo|reviewed|consensus> --config <path> --coord-root <external-path>
  coord run --issue <issue> --coord-root <path>
  coord next --issue <issue> --coord-root <path> --agent <agent>
  coord answer <question-id> <retry|revise|abandon> --issue <issue> --coord-root <path>
  coord drop <agent> --issue <issue> --coord-root <path>
  coord pause|resume|restart-action|abandon --issue <issue> --coord-root <path>

COORD_ISSUE and COORD_AGENT may replace the corresponding options. The safety-critical
--coord-root option must always be explicit.
`;

export const automationDigestMaterial = (
  configPath: string,
  config: CoordinatorConfig,
  issue: number
): { digest: string; sources: Array<{ id: string; sha256: string }> } => {
  const configRoot = dirname(configPath);
  assertNoSymlink(configRoot, configPath);
  const sourceBytes: Array<{ id: string; content: string }> = [{ id: "config", content: readFileSync(configPath, "utf8") }];
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
    const parsed = parseArgs(rest);
    if (command === "install") {
      allowedFlags(parsed, [
        "product",
        "coord-root",
        "agents",
        "profile",
        "clone-root",
        "config",
        "base-branch",
        "remote",
        "dry-run",
        "vendor",
        "write-product",
        "bootstrap-coordination"
      ]);
      if (parsed.positionals.length !== 0) throw new Error("install takes no positional arguments.");
      const profileValue = requireFlag(parsed, "profile");
      if (!(profileValue === "solo" || profileValue === "reviewed" || profileValue === "consensus")) {
        throw new Error("--profile must be solo, reviewed, or consensus.");
      }
      const agents = requireFlag(parsed, "agents").split(",").map((agent) => agent.trim()).filter(Boolean);
      const result = install({
        product: resolve(io.cwd, requireFlag(parsed, "product")),
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        agents,
        profile: profileValue,
        installRoot: coordinatorSourceRoot,
        ...(parsed.flags.has("clone-root") ? { cloneRoot: resolve(io.cwd, requireFlag(parsed, "clone-root")) } : {}),
        ...(parsed.flags.has("config") ? { configSource: resolve(io.cwd, requireFlag(parsed, "config")) } : {}),
        ...(parsed.flags.has("base-branch") ? { baseBranch: requireFlag(parsed, "base-branch") } : {}),
        ...(parsed.flags.has("remote") ? { remoteName: requireFlag(parsed, "remote") } : {}),
        dryRun: enabled(parsed, "dry-run"),
        vendor: enabled(parsed, "vendor"),
        writeProduct: enabled(parsed, "write-product"),
        bootstrapCoordination: enabled(parsed, "bootstrap-coordination"),
        log: io.stdout
      });
      if (!enabled(parsed, "dry-run")) {
        io.stdout(`${result.changed ? "Installed" : "Already current"}: ${result.configPath}\n`);
      }
      return 0;
    }

    if (command === "uninstall") {
      allowedFlags(parsed, [
        "product",
        "coord-root",
        "config",
        "delete-clones",
        "force",
        "wipe-runtime",
        "delete-coordination",
        "dry-run"
      ]);
      if (parsed.positionals.length !== 0) throw new Error("uninstall takes no positional arguments.");
      const result = uninstallWorkspace({
        product: resolve(io.cwd, requireFlag(parsed, "product")),
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        ...(parsed.flags.has("config") ? { configPath: resolve(io.cwd, requireFlag(parsed, "config")) } : {}),
        deleteClones: enabled(parsed, "delete-clones"),
        force: enabled(parsed, "force"),
        wipeRuntime: enabled(parsed, "wipe-runtime"),
        deleteCoordination: enabled(parsed, "delete-coordination"),
        dryRun: enabled(parsed, "dry-run"),
        log: io.stdout
      });
      if (!enabled(parsed, "dry-run")) io.stdout(`${result.changed ? "Uninstalled" : "Already absent"}.\n`);
      return 0;
    }

    if (command === "doctor") {
      allowedFlags(parsed, ["product", "coord-root", "config"]);
      if (parsed.positionals.length !== 0) throw new Error("doctor takes no positional arguments.");
      const result = doctorWorkspace({
        product: resolve(io.cwd, requireFlag(parsed, "product")),
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        ...(parsed.flags.has("config") ? { configPath: resolve(io.cwd, requireFlag(parsed, "config")) } : {})
      });
      if (!result.ok) {
        for (const issue of result.issues) {
          io.stderr(`coord doctor [${issue.code}]${issue.agent === undefined ? "" : ` ${issue.agent}`}: ${issue.message}\n`);
        }
        return 3;
      }
      io.stdout(`coord doctor: healthy (${result.configPath}).\n`);
      return 0;
    }

    if (command === "start") {
      allowedFlags(parsed, ["profile", "config", "coord-root"]);
      if (parsed.positionals.length !== 1) throw new Error("start requires exactly one issue number.");
      const issue = parseIssue(parsed.positionals[0] as string);
      const profileValue = requireFlag(parsed, "profile");
      if (!(profileValue === "solo" || profileValue === "reviewed" || profileValue === "consensus")) {
        throw new Error("--profile must be solo, reviewed, or consensus.");
      }
      const profile: WorkflowProfile = profileValue;
      const configPath = resolve(io.cwd, requireFlag(parsed, "config"));
      const config = readConfig(configPath);
      const agents = config.agents.map((agent) => ({ ...agent, root: resolve(dirname(configPath), agent.root) }));
      const roster = profile === "solo" ? agents.slice(0, 1) : agents;
      if (roster.length === 0) throw new Error(`Profile ${profile} requires at least one configured agent.`);
      if (config.prPolicy === "coord-open-unmerged" && githubRepositoryFromOrigin(config.origin) === null) {
        throw new Error(
          `prPolicy "coord-open-unmerged" requires a supported github.com origin; ${config.origin} is incompatible.`
        );
      }
      for (const agent of roster) resolveAgentLauncher(agent);
      const coordRoot = resolveSafeCoordRoot({
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        agentRoots: agents.map((agent) => agent.root),
        create: false
      });
      const paths = issueRuntimePaths(coordRoot, issue);
      if (existsSync(paths.issueRoot)) {
        throw new Error(`Runtime state already exists for issue ${issue}. Use resume or abandon it explicitly.`);
      }
      const digest = automationDigestMaterial(configPath, config, issue);
      const baselineResult = await runner(["git", "ls-remote", "--exit-code", config.origin, `refs/heads/${config.baseBranch}`], io.cwd);
      if (baselineResult.exitCode !== 0) throw new Error(`Cannot resolve origin baseline: ${baselineResult.stderr.trim()}`);
      const baselineSha = baselineResult.stdout.trim().split(/\s+/)[0];
      const parsedBaseline = gitShaSchema.safeParse(baselineSha);
      if (!parsedBaseline.success) throw new Error("Origin returned an invalid baseline SHA.");
      const trustedSourceResult = await runner(
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
        effects = await startEffects({ paths, issue, origin: config.origin, agents: roster });
        createIssueRuntime(paths, roster.map((agent) => agent.id));
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
            `resume with coord run --issue ${issue} --coord-root ${coordRoot}: ${
              error instanceof Error ? error.message : String(error)
            }`
        );
      }
      io.stdout(`Started issue ${issue} (${profile}) at ${paths.issueRoot}.\n`);
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
