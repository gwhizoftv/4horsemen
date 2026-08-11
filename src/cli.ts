import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { clearCompletion, readAction } from "./action.js";
import { sha256 } from "./hash.js";
import { agentRuntimePaths, createIssueRuntime, issueRuntimePaths, resolveSafeCoordRoot, type IssueRuntimePaths } from "./paths.js";
import { gitShaSchema } from "./protocol.js";
import { CoordinatorRunLoop, runArgv, type ProcessRunner } from "./runLoop.js";
import {
  appendJournal,
  cursorsStateSchema,
  dropAgent,
  initializeOperationalState,
  readConfig,
  readCursorsState,
  readStartState,
  replaceCursor,
  setPaused,
  writeCursorsState,
  type CursorsState
} from "./state.js";
import type { WorkflowProfile } from "./steps.js";

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
};

const defaultIo: CliIo = {
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
  env: process.env,
  cwd: process.cwd()
};

type ParsedArgs = { positionals: string[]; flags: Map<string, string> };

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
  const coordRoot = parsed.flags.get("coord-root") ?? io.env.COORD_ROOT;
  const issueValue = parsed.flags.get("issue") ?? io.env.COORD_ISSUE;
  if (coordRoot === undefined) throw new Error("--coord-root or COORD_ROOT is required.");
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
  coord start <issue> --profile <solo|reviewed|consensus> --config <path> --coord-root <external-path>
  coord run --issue <issue> --coord-root <path>
  coord next --issue <issue> --coord-root <path> --agent <agent>
  coord answer <text> --issue <issue> --coord-root <path>
  coord drop <agent> --issue <issue> --coord-root <path>
  coord pause|resume|restart-action|abandon --issue <issue> --coord-root <path>

COORD_ROOT, COORD_ISSUE, and COORD_AGENT may replace the corresponding options.
`;

const resetUnresolvedActions = (paths: IssueRuntimePaths, cursors: CursorsState, now: string): CursorsState => {
  let next = cursorsStateSchema.parse({
    ...cursors,
    accepted: cursors.accepted.filter((submission) => submission.stepId !== cursors.issueCursor.stepId),
    updatedAt: now
  });
  for (const agent of next.activeRoster) {
    const runtime = agentRuntimePaths(paths, agent);
    clearCompletion(runtime.complete);
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

export const runCli = async (argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> => {
  const io: CliIo = { ...defaultIo, ...dependencies.io };
  const runner = dependencies.processRunner ?? runArgv;
  const makeRunLoop = dependencies.makeRunLoop ?? ((paths: IssueRuntimePaths) => new CoordinatorRunLoop(paths));
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    io.stdout(help);
    return 0;
  }

  try {
    const parsed = parseArgs(rest);
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
      const coordRoot = resolveSafeCoordRoot({
        coordRoot: resolve(io.cwd, requireFlag(parsed, "coord-root")),
        agentRoots: agents.map((agent) => agent.root),
        create: true
      });
      const baselineResult = await runner(["git", "ls-remote", "--exit-code", config.origin, `refs/heads/${config.baseBranch}`], io.cwd);
      if (baselineResult.exitCode !== 0) throw new Error(`Cannot resolve origin baseline: ${baselineResult.stderr.trim()}`);
      const baselineSha = baselineResult.stdout.trim().split(/\s+/)[0];
      const parsedBaseline = gitShaSchema.safeParse(baselineSha);
      if (!parsedBaseline.success) throw new Error("Origin returned an invalid baseline SHA.");
      const paths = issueRuntimePaths(coordRoot, issue);
      createIssueRuntime(paths, roster.map((agent) => agent.id));
      const digestMaterial = `${readFileSync(configPath, "utf8")}\n${readFileSync(resolve(io.cwd, ".plans/issue-1/plan.md"), "utf8")}`;
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
        automationDigest: sha256(digestMaterial),
        trustedSourceCommit: "01be9854919e1bf9a75f70ced7980d48d7150c28",
        origin: config.origin,
        coordRoot,
        configPath,
        agents: roster,
        checks: config.checks,
        pollIntervalMs: config.pollIntervalMs
      });
      const loop = makeRunLoop(paths);
      await loop.initializeEffects();
      await loop.runTick();
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
      if (parsed.positionals.length === 0) throw new Error("answer requires text.");
      const paths = context(parsed, io);
      appendJournal(paths, { type: "owner-answer", details: { answer: parsed.positionals.join(" ") } });
      io.stdout("Owner answer recorded.\n");
      return 0;
    }

    if (command === "drop") {
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 1) throw new Error("drop requires exactly one agent id.");
      const paths = context(parsed, io);
      const agent = parsed.positionals[0] as string;
      let cursors = readCursorsState(paths);
      if (!cursors.activeRoster.includes(agent)) throw new Error(`${agent} is not active.`);
      if (cursors.activeRoster.length === 1) throw new Error("Cannot drop the final active agent.");
      appendJournal(paths, { type: "agent-dropped", agent, details: {} });
      cursors = dropAgent(cursors, agent);
      const droppedRuntime = agentRuntimePaths(paths, agent);
      clearCompletion(droppedRuntime.complete);
      if (existsSync(droppedRuntime.action)) unlinkSync(droppedRuntime.action);
      cursors = resetUnresolvedActions(paths, cursors, new Date().toISOString());
      writeCursorsState(paths, cursors);
      await makeRunLoop(paths).runTick();
      io.stdout(`Dropped ${agent}; remaining inputs have been rederived.\n`);
      return 0;
    }

    if (command === "pause" || command === "resume") {
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error(`${command} takes no positional arguments.`);
      const paths = context(parsed, io);
      const paused = command === "pause";
      appendJournal(paths, { type: paused ? "paused" : "resumed", details: {} });
      writeCursorsState(paths, setPaused(readCursorsState(paths), paused));
      io.stdout(`${paused ? "Paused" : "Resumed"} issue ${readStartState(paths).issue}.\n`);
      return 0;
    }

    if (command === "restart-action") {
      allowedFlags(parsed, ["issue", "coord-root", "agent"]);
      if (parsed.positionals.length !== 0) throw new Error("restart-action takes no positional arguments.");
      const paths = context(parsed, io);
      let cursors = readCursorsState(paths);
      const agents = parsed.flags.has("agent") ? [requireFlag(parsed, "agent")] : cursors.activeRoster;
      appendJournal(paths, { type: "action-restarted", details: { agents } });
      for (const agent of agents) {
        const runtime = agentRuntimePaths(paths, agent);
        clearCompletion(runtime.complete);
        if (existsSync(runtime.action)) unlinkSync(runtime.action);
        cursors = replaceCursor(cursors, agent, { actionId: null, status: "idle", submissionSha: null, outstanding: [] });
      }
      writeCursorsState(paths, cursors);
      await makeRunLoop(paths).runTick();
      io.stdout("Action restarted.\n");
      return 0;
    }

    if (command === "abandon") {
      allowedFlags(parsed, ["issue", "coord-root"]);
      if (parsed.positionals.length !== 0) throw new Error("abandon takes no positional arguments.");
      const paths = context(parsed, io);
      appendJournal(paths, { type: "abandoned", details: {} });
      const cursors = readCursorsState(paths);
      writeCursorsState(paths, cursorsStateSchema.parse({ ...cursors, abandoned: true, updatedAt: new Date().toISOString() }));
      io.stdout("Workflow abandoned; runtime state was retained.\n");
      return 0;
    }

    throw new Error(`Unknown command ${command}.`);
  } catch (error) {
    io.stderr(`coord: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
};
