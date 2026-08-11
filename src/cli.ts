import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { readCompletion } from "./action.js";
import { sha256 } from "./hash.js";
import { createMirror, spawnGit, type GitRunner, type Mirror } from "./mirror.js";
import { coordPaths, CoordPathError, resolveCoordRoot } from "./paths.js";
import { RUNTIME_FORMAT_VERSION, gatesForProfile, type Profile } from "./steps.js";
import { defaultDeps, finalize, runLoop, type LoopDeps } from "./runLoop.js";
import {
  activeAgents,
  appendJournal,
  coordConfigSchema,
  ensureRuntimeLayout,
  initialCursors,
  loadRuntimeState,
  saveCursors,
  writeJsonAtomic,
  writeStartRecord,
  type CoordConfig,
  type RuntimeState,
  type StartRecord
} from "./state.js";
import { createTmuxController } from "./tmux.js";

/**
 * Strict CLI parsing and the exit contract.
 *
 * This is a new surface. It preserves no legacy automation command shape, and
 * it exposes no merge operation — the coordinator can open an unmerged PR when
 * owner policy allows, and nothing more.
 */

export const EXIT_OK = 0;
export const EXIT_FAILURE = 1;
export const EXIT_USAGE = 2;
export const EXIT_STATE = 3;
export const EXIT_REFUSED = 4;

export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
};

export type CliDeps = {
  readonly io: CliIo;
  readonly now: () => string;
  readonly git: GitRunner;
  /** Override for tests; production builds a real mirror-backed dependency set. */
  readonly loopDeps?: (mirror: Mirror) => LoopDeps;
};

export const defaultCliDeps = (io: CliIo): CliDeps => ({
  io,
  now: () => new Date().toISOString(),
  git: spawnGit
});

export type ParsedArgs = {
  readonly command: string;
  readonly positional: readonly string[];
  readonly flags: Readonly<Record<string, string>>;
};

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedArgs }
  | { readonly ok: false; readonly error: string };

const knownFlags = new Set(["--profile", "--config", "--coord-root", "--issue", "--agent", "--message", "--poll-ms", "--max-ticks"]);

export const parseArgs = (argv: readonly string[]): ParseResult => {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    return { ok: false, error: "usage" };
  }

  const positional: string[] = [];
  const flags: Record<string, string> = {};

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] as string;

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    if (!knownFlags.has(token)) {
      return { ok: false, error: `unknown flag ${token}` };
    }

    const value = rest[index + 1];

    if (value === undefined || value.startsWith("--")) {
      return { ok: false, error: `${token} requires a value` };
    }

    flags[token.slice(2)] = value;
    index += 1;
  }

  return { ok: true, value: { command, positional, flags } };
};

export const usage = (): string =>
  [
    "coord — owner-side workflow driver",
    "",
    "  coord start <issue> --profile <solo|reviewed|consensus> --config <path> --coord-root <external-path>",
    "  coord run --coord-root <path> --issue <n>",
    "  coord next --coord-root <path> --issue <n> --agent <agent>",
    "  coord answer --coord-root <path> --issue <n> --message <text>",
    "  coord drop <agent> --coord-root <path> --issue <n>",
    "  coord pause | resume | restart-action | abandon --coord-root <path> --issue <n>",
    "",
    "--coord-root is required and must be outside every configured clone.",
    "The coordinator can never merge."
  ].join("\n");

const requireFlag = (args: ParsedArgs, name: string): string | null => args.flags[name] ?? null;

const loadConfig = (path: string): { ok: true; value: CoordConfig } | { ok: false; error: string } => {
  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, error: `cannot read config ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, error: `invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const result = coordConfigSchema.safeParse(parsed);

  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
};

const resolveAgentRoot = (configPath: string, root: string): string =>
  isAbsolute(root) ? root : resolve(configPath, "..", root);

const openState = (
  args: ParsedArgs,
  deps: CliDeps
): { ok: true; value: RuntimeState } | { ok: false; code: number } => {
  const root = requireFlag(args, "coord-root");
  const issueText = requireFlag(args, "issue");

  if (root === null || issueText === null) {
    deps.io.stderr("coord: --coord-root and --issue are required\n");

    return { ok: false, code: EXIT_USAGE };
  }

  const issue = Number(issueText);

  if (!Number.isInteger(issue) || issue < 1) {
    deps.io.stderr(`coord: --issue must be a positive integer, received ${issueText}\n`);

    return { ok: false, code: EXIT_USAGE };
  }

  const loaded = loadRuntimeState(resolve(root), issue);

  if (!loaded.ok) {
    deps.io.stderr(`coord: ${loaded.errors.join("\n")}\n`);

    return { ok: false, code: EXIT_STATE };
  }

  return { ok: true, value: loaded.value };
};

const journalControl = (
  state: RuntimeState,
  kind: "paused" | "resumed" | "abandoned" | "owner-drop" | "owner-answer" | "action-restarted",
  now: string,
  detail: Record<string, unknown> = {},
  agent?: string
): void => {
  appendJournal(state.paths.journal, { at: now, kind, agent, detail }, state.paths.root);
};

export const cmdStart = (args: ParsedArgs, deps: CliDeps): number => {
  const issueText = args.positional[0];
  const profile = requireFlag(args, "profile");
  const configPath = requireFlag(args, "config");
  const coordRoot = requireFlag(args, "coord-root");

  if (issueText === undefined || profile === null || configPath === null || coordRoot === null) {
    deps.io.stderr("coord start: <issue> --profile, --config, and --coord-root are all required\n");

    return EXIT_USAGE;
  }

  const issue = Number(issueText);

  if (!Number.isInteger(issue) || issue < 1) {
    deps.io.stderr(`coord start: issue must be a positive integer, received ${issueText}\n`);

    return EXIT_USAGE;
  }

  if (!["solo", "reviewed", "consensus"].includes(profile)) {
    deps.io.stderr(`coord start: unknown profile ${profile}\n`);

    return EXIT_USAGE;
  }

  const config = loadConfig(resolve(configPath));

  if (!config.ok) {
    deps.io.stderr(`coord start: ${config.error}\n`);

    return EXIT_USAGE;
  }

  const agentRoots = config.value.agents.map((agent) => resolveAgentRoot(resolve(configPath), agent.root));
  let root: string;

  try {
    // Proven outside every clone before anything at all is written.
    root = resolveCoordRoot(resolve(coordRoot), agentRoots);
  } catch (error) {
    deps.io.stderr(`coord start: ${error instanceof CoordPathError ? error.message : String(error)}\n`);

    return EXIT_REFUSED;
  }

  const firstAgentRoot = agentRoots[0] as string;
  const head = deps.git(["-C", firstAgentRoot, "rev-parse", `origin/${config.value.baseBranch}`]);

  if (head.status !== 0) {
    deps.io.stderr(`coord start: cannot resolve origin/${config.value.baseBranch}: ${head.stderr}\n`);

    return EXIT_FAILURE;
  }

  const baselineSha = head.stdout.toString("utf8").trim();
  const digestScheme = "v3";
  const paths = coordPaths(root, issue);
  const now = deps.now();
  const start: StartRecord = {
    runtimeFormatVersion: RUNTIME_FORMAT_VERSION,
    issue,
    issueSessionId: `issue-${issue}:${baselineSha}`,
    baselineSha,
    profile: profile as Profile,
    originalRoster: config.value.agents.map((agent) => agent.id),
    agentRoots: Object.fromEntries(config.value.agents.map((agent, index) => [agent.id, agentRoots[index] as string])),
    harnesses: Object.fromEntries(config.value.agents.map((agent) => [agent.id, agent.harness])),
    nudgeAllowed: Object.fromEntries(config.value.agents.map((agent) => [agent.id, agent.nudge])),
    baseBranch: config.value.baseBranch,
    branchTemplate: config.value.branch,
    maxRevisionRounds: config.value.maxRevisionRounds,
    prPolicy: config.value.prPolicy,
    // Bound to the source every agent must agree on. A join declaring a
    // different digest is rejected rather than silently accepted.
    automationDigest: sha256(`${digestScheme}:${baselineSha}:${config.value.agents.map((agent) => agent.id).sort().join(",")}`),
    automationDigestScheme: digestScheme,
    trustedSourceCommit: baselineSha,
    finalChecks: config.value.finalChecks,
    createdAt: now
  };

  ensureRuntimeLayout(paths, start.originalRoster);
  writeStartRecord(paths, start);

  const firstGate = gatesForProfile(start.profile)[0] ?? "gate-1-join";

  writeJsonAtomic(paths.cursorsJson, initialCursors(start, firstGate, now), paths.root);
  appendJournal(paths.journal, { at: now, kind: "started", detail: { issue, profile, root } }, paths.root);

  const mirror = createMirror(paths.mirror);
  const originUrl = config.value.originUrl ?? firstAgentRoot;
  const ensured = mirror.ensure(originUrl);

  if (!ensured.ok) {
    deps.io.stderr(`coord start: could not prepare mirror: ${ensured.detail}\n`);

    return EXIT_FAILURE;
  }

  const tmux = createTmuxController();
  const failures: string[] = [];

  if (tmux.available) {
    tmux.ensureSession(issue);

    for (const agent of config.value.agents) {
      const launched = tmux.launchAgent(issue, agent.id, start.agentRoots[agent.id] as string);

      if (!launched.ok) {
        failures.push(launched.error);
      }
    }
  }

  if (failures.length > 0) {
    // A missing launcher is a named startup failure, never a bare shell.
    deps.io.stderr(`coord start: ${failures.join("\n")}\n`);

    return EXIT_FAILURE;
  }

  deps.io.stdout(`started issue ${String(issue)} (${profile}) with control root ${root}\n`);

  return EXIT_OK;
};

export const cmdNext = (args: ParsedArgs, deps: CliDeps): number => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const agent = requireFlag(args, "agent");

  if (agent === null) {
    deps.io.stderr("coord next: --agent is required\n");

    return EXIT_USAGE;
  }

  const state = opened.value;

  if (!state.start.originalRoster.includes(agent)) {
    deps.io.stderr(`coord next: ${agent} is not part of this run\n`);

    return EXIT_USAGE;
  }

  let contents: string;

  try {
    contents = readFileSync(state.paths.actionFile(agent), "utf8");
  } catch {
    // Deliberately uninformative: no peer, step, gate, evidence, or global
    // phase state is exposed to an agent.
    deps.io.stdout("none yet\n");

    return EXIT_OK;
  }

  deps.io.stdout(contents.endsWith("\n") ? contents : `${contents}\n`);

  return EXIT_OK;
};

export const cmdDrop = (args: ParsedArgs, deps: CliDeps): number => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const agent = args.positional[0];
  const state = opened.value;

  if (agent === undefined) {
    deps.io.stderr("coord drop: name the agent to drop\n");

    return EXIT_USAGE;
  }

  if (!state.start.originalRoster.includes(agent)) {
    deps.io.stderr(`coord drop: ${agent} is not part of this run\n`);

    return EXIT_USAGE;
  }

  const active = activeAgents(state.start, state.cursors);

  if (!active.includes(agent)) {
    deps.io.stdout(`${agent} is already dropped\n`);

    return EXIT_OK;
  }

  if (active.length <= 1) {
    // A zero-agent workflow cannot continue.
    deps.io.stderr(`coord drop: ${agent} is the last active agent; a run needs at least one\n`);

    return EXIT_REFUSED;
  }

  const now = deps.now();

  journalControl(state, "owner-drop", now, { agent }, agent);

  // One local atomic change: persist the drop, discard the agent's pending
  // completion, and let the next tick rederive actions from the rest.
  state.cursors = { ...state.cursors, droppedAgents: [...state.cursors.droppedAgents, agent] };
  saveCursors(state, now);

  const completion = readCompletion(state.paths.completeFile(agent));

  if (completion.ok) {
    deps.io.stdout(`ignoring a pending completion from ${agent}\n`);
  }

  deps.io.stdout(`dropped ${agent}; continuing with ${activeAgents(state.start, state.cursors).join(", ")}\n`);

  return EXIT_OK;
};

const setPaused = (args: ParsedArgs, deps: CliDeps, paused: boolean): number => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const state = opened.value;
  const now = deps.now();

  journalControl(state, paused ? "paused" : "resumed", now);
  state.cursors = { ...state.cursors, paused };
  saveCursors(state, now);
  deps.io.stdout(paused ? "paused\n" : "resumed\n");

  return EXIT_OK;
};

export const cmdRestartAction = (args: ParsedArgs, deps: CliDeps): number => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const agent = requireFlag(args, "agent");
  const state = opened.value;

  if (agent === null || !state.start.originalRoster.includes(agent)) {
    deps.io.stderr("coord restart-action: --agent must name an agent in this run\n");

    return EXIT_USAGE;
  }

  const now = deps.now();
  const cursor = state.cursors.agents[agent];

  if (cursor === undefined) {
    deps.io.stderr(`coord restart-action: no cursor for ${agent}\n`);

    return EXIT_STATE;
  }

  journalControl(state, "action-restarted", now, { agent }, agent);
  state.cursors = {
    ...state.cursors,
    agents: {
      ...state.cursors.agents,
      [agent]: { ...cursor, status: "idle", stepId: null, actionId: null, submissionSha: null, outstanding: [], updatedAt: now }
    }
  };
  saveCursors(state, now);
  deps.io.stdout(`restarted the current action for ${agent}\n`);

  return EXIT_OK;
};

export const cmdAbandon = (args: ParsedArgs, deps: CliDeps): number => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const state = opened.value;
  const now = deps.now();

  journalControl(state, "abandoned", now);
  state.cursors = { ...state.cursors, abandoned: true };
  saveCursors(state, now);
  deps.io.stdout("abandoned; runtime state and tmux sessions are left in place\n");

  return EXIT_OK;
};

export const cmdAnswer = (args: ParsedArgs, deps: CliDeps): number => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const message = requireFlag(args, "message");

  if (message === null) {
    deps.io.stderr("coord answer: --message is required\n");

    return EXIT_USAGE;
  }

  journalControl(opened.value, "owner-answer", deps.now(), { message });
  deps.io.stdout("recorded\n");

  return EXIT_OK;
};

export const cmdRun = async (args: ParsedArgs, deps: CliDeps): Promise<number> => {
  const opened = openState(args, deps);

  if (!opened.ok) {
    return opened.code;
  }

  const state = opened.value;
  const mirror = createMirror(state.paths.mirror);
  const loopDeps = (deps.loopDeps ?? defaultDeps)(mirror);
  const maxTicksText = args.flags["max-ticks"];
  const pollText = args.flags["poll-ms"];
  const result = await runLoop(state, loopDeps, {
    pollIntervalMs: pollText === undefined ? undefined : Number(pollText),
    maxTicks: maxTicksText === undefined ? undefined : Number(maxTicksText)
  });

  if (result.finalized) {
    const outcome = finalize(state, loopDeps);

    deps.io.stdout(`${outcome.detail}\n`);

    if (!outcome.ok) {
      return EXIT_FAILURE;
    }

    deps.io.stdout(outcome.prOpened ? "opened an unmerged pull request\n" : "no pull request opened\n");

    return EXIT_OK;
  }

  if (result.awaitingOwner) {
    deps.io.stdout("awaiting owner action\n");

    return EXIT_OK;
  }

  deps.io.stdout("stopped\n");

  return EXIT_OK;
};

export const runCli = async (argv: readonly string[], deps: CliDeps): Promise<number> => {
  const parsed = parseArgs(argv);

  if (!parsed.ok) {
    if (parsed.error === "usage") {
      deps.io.stdout(`${usage()}\n`);

      return EXIT_OK;
    }

    deps.io.stderr(`coord: ${parsed.error}\n${usage()}\n`);

    return EXIT_USAGE;
  }

  const args = parsed.value;

  switch (args.command) {
    case "start":
      return cmdStart(args, deps);
    case "run":
      return cmdRun(args, deps);
    case "next":
      return cmdNext(args, deps);
    case "answer":
      return cmdAnswer(args, deps);
    case "drop":
      return cmdDrop(args, deps);
    case "pause":
      return setPaused(args, deps, true);
    case "resume":
      return setPaused(args, deps, false);
    case "restart-action":
      return cmdRestartAction(args, deps);
    case "abandon":
      return cmdAbandon(args, deps);
    default:
      deps.io.stderr(`coord: unknown command ${args.command}\n${usage()}\n`);

      return EXIT_USAGE;
  }
};
