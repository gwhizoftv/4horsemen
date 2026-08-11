import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { resolveCoordRoot } from "./paths.js";
import { readStart, readCursors, writeStart, writeCursors, ensureIssueStructure, appendJournal, type StartConfig } from "./state.js";
import { readAction, writeAction, generateActionId, type InternalAction } from "./action.js";
import { runLoop, executeDrop, executePause, executeResume } from "./runLoop.js";
import { initMirror } from "./mirror.js";
import { stepsForProfile, resolvePathTemplate, GATE_ORDER, type StepId } from "./steps.js";
import { sha256 } from "./hash.js";

export interface CliResult {
  code: number;
  message?: string;
}

export async function runCli(args: string[]): Promise<CliResult> {
  const cmd = args[0];
  if (!cmd || cmd === "--help" || cmd === "-h") {
    return { code: 0, message: usage() };
  }

  switch (cmd) {
    case "start": return cmdStart(args.slice(1));
    case "run": return cmdRun(args.slice(1));
    case "next": return cmdNext(args.slice(1));
    case "drop": return cmdDrop(args.slice(1));
    case "pause": return cmdPause(args.slice(1));
    case "resume": return cmdResume(args.slice(1));
    case "restart-action": return cmdRestartAction(args.slice(1));
    case "abandon": return cmdAbandon(args.slice(1));
    default: return { code: 2, message: `coord: unknown command '${cmd}'` };
  }
}

function usage(): string {
  return `coord — owner-side workflow driver

Usage:
  coord start <issue> --profile <solo|reviewed|consensus> --config <path> --coord-root <path>
  coord run [--coord-root <path> --issue <n>]
  coord next [--coord-root <path> --issue <n> --agent <name>]
  coord drop <agent> [--coord-root <path> --issue <n>]
  coord pause [--coord-root <path> --issue <n>]
  coord resume [--coord-root <path> --issue <n>]
  coord restart-action [--coord-root <path> --issue <n> --agent <name>]
  coord abandon [--coord-root <path> --issue <n>]
`;
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx < 0 || idx >= args.length - 1) return undefined;
  return args[idx + 1];
}

function requireFlag(args: string[], flag: string): string {
  const value = parseFlag(args, flag);
  if (!value) throw new Error(`Missing required flag: ${flag}`);
  return value;
}

async function cmdStart(args: string[]): Promise<CliResult> {
  const issueStr = args[0];
  if (!issueStr || !/^\d+$/.test(issueStr)) {
    return { code: 2, message: "coord start: first argument must be the issue number" };
  }
  const issue = parseInt(issueStr, 10);

  let coordRoot: string;
  let profile: string;
  let configPath: string;
  try {
    coordRoot = requireFlag(args, "--coord-root");
    profile = requireFlag(args, "--profile");
    configPath = requireFlag(args, "--config");
  } catch (e) {
    return { code: 2, message: `coord start: ${(e as Error).message}` };
  }

  if (!["solo", "reviewed", "consensus"].includes(profile)) {
    return { code: 2, message: `coord start: invalid profile '${profile}'` };
  }

  if (!existsSync(configPath)) {
    return { code: 1, message: `coord start: config not found: ${configPath}` };
  }

  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const agentRoots: string[] = (config.agents ?? []).map((a: { root: string }) => resolve(configPath, "..", a.root));

  try {
    coordRoot = resolveCoordRoot(coordRoot, agentRoots);
  } catch (e) {
    return { code: 1, message: `coord start: ${(e as Error).message}` };
  }

  const agents: string[] = (config.agents ?? []).map((a: { id: string }) => a.id);
  const baselineSha = "0".repeat(40);
  const issueSessionId = `issue-${issue}:${baselineSha}`;
  const digest = sha256(readFileSync(configPath, "utf8"));

  const startConfig: StartConfig = {
    formatVersion: 1,
    issue,
    issueSessionId,
    baselineSha,
    profile: profile as "solo" | "reviewed" | "consensus",
    roster: agents,
    baseBranch: config.baseBranch ?? "main",
    maxRevisionRounds: config.maxRevisionRounds ?? 3,
    prPolicy: config.prPolicy ?? "owner-only",
    automationDigest: digest,
    automationDigestScheme: "v3",
    trustedSourceCommit: "0".repeat(40),
    createdAt: new Date().toISOString(),
  };

  ensureIssueStructure(coordRoot, issue, agents);
  writeStart(coordRoot, issue, startConfig);

  const firstStep = stepsForProfile(startConfig.profile)[0];
  const agentCursors: Record<string, unknown> = {};
  for (const agent of agents) {
    agentCursors[agent] = {
      stepId: firstStep?.stepId ?? "R1.join",
      actionId: generateActionId(issue, agent, (firstStep?.stepId ?? "R1.join") as StepId, 1),
      status: "ordered",
      attempt: 1,
      delivery: "pull",
      submissionSha: null,
      outstanding: [],
      updatedAt: new Date().toISOString(),
    };
  }
  const cursors = {
    issueCursor: { gateId: GATE_ORDER[0], round: null },
    agents: agentCursors,
    droppedAgents: [] as string[],
    paused: false,
  };
  writeCursors(coordRoot, issue, cursors as unknown as import("./state.js").Cursors);

  for (const agent of agents) {
    if (firstStep) {
      const action: InternalAction = {
        actionId: generateActionId(issue, agent, firstStep.stepId, 1),
        agent,
        stepId: firstStep.stepId,
        evidenceId: firstStep.evidenceId,
        requiredPath: resolvePathTemplate(firstStep.requiredPathTemplate, issue, agent),
        issue,
        attempt: 1,
        inputCommits: {},
        outstanding: [],
      };
      writeAction(coordRoot, issue, action);
    }
  }

  const originUrl = config.originUrl ?? `file://${agentRoots[0]}`;
  try {
    initMirror(coordRoot, originUrl);
  } catch {
    // Mirror init may fail if no origin yet; non-fatal at start
  }

  appendJournal(coordRoot, issue, {
    timestamp: new Date().toISOString(),
    event: "started",
    issue,
    profile,
    roster: agents,
  });

  return { code: 0, message: `Started issue ${issue} with profile '${profile}' and ${agents.length} agents.\nCoord root: ${coordRoot}` };
}

async function cmdRun(args: string[]): Promise<CliResult> {
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  if (!coordRoot || !issue) return { code: 2, message: "coord run: requires --coord-root and --issue" };

  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());

  await runLoop({ coordRoot, issue, signal: controller.signal });
  return { code: 0 };
}

async function cmdNext(args: string[]): Promise<CliResult> {
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  const agent = requireFlagOrEnv(args, "--agent");
  if (!coordRoot || !issue || !agent) return { code: 2, message: "coord next: requires --coord-root, --issue, and --agent" };

  const action = readAction(coordRoot, issue, agent);
  if (!action) {
    return { code: 0, message: "none yet" };
  }
  return { code: 0, message: `Action: ${action.actionId}\nPath: ${action.requiredPath}` };
}

async function cmdDrop(args: string[]): Promise<CliResult> {
  const agent = args[0];
  if (!agent) return { code: 2, message: "coord drop: specify the agent to drop" };
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  if (!coordRoot || !issue) return { code: 2, message: "coord drop: requires --coord-root and --issue" };

  const result = executeDrop(coordRoot, issue, agent);
  if (!result.ok) return { code: 1, message: `coord drop: ${result.reason}` };
  return { code: 0, message: `Dropped agent '${agent}'` };
}

async function cmdPause(args: string[]): Promise<CliResult> {
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  if (!coordRoot || !issue) return { code: 2, message: "coord pause: requires --coord-root and --issue" };
  executePause(coordRoot, issue);
  return { code: 0, message: "Paused" };
}

async function cmdResume(args: string[]): Promise<CliResult> {
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  if (!coordRoot || !issue) return { code: 2, message: "coord resume: requires --coord-root and --issue" };
  executeResume(coordRoot, issue);
  return { code: 0, message: "Resumed" };
}

async function cmdRestartAction(args: string[]): Promise<CliResult> {
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  const agent = requireFlagOrEnv(args, "--agent");
  if (!coordRoot || !issue || !agent) return { code: 2, message: "coord restart-action: requires --coord-root, --issue, and --agent" };

  const start = readStart(coordRoot, issue);
  const cursors = readCursors(coordRoot, issue);
  const cursor = cursors.agents[agent];
  if (!cursor) return { code: 1, message: `coord restart-action: agent '${agent}' not found` };

  cursor.attempt += 1;
  cursor.status = "ordered";
  cursor.outstanding = [];
  cursor.updatedAt = new Date().toISOString();
  writeCursors(coordRoot, issue, cursors);

  const stepDef = stepsForProfile(start.profile).find(s => s.stepId === cursor.stepId);
  if (stepDef) {
    const action: InternalAction = {
      actionId: generateActionId(issue, agent, stepDef.stepId, cursor.attempt),
      agent,
      stepId: stepDef.stepId,
      evidenceId: stepDef.evidenceId,
      requiredPath: resolvePathTemplate(stepDef.requiredPathTemplate, issue, agent),
      issue,
      attempt: cursor.attempt,
      inputCommits: {},
      outstanding: [],
    };
    writeAction(coordRoot, issue, action);
  }

  appendJournal(coordRoot, issue, { timestamp: new Date().toISOString(), event: "action-restarted", agent });
  return { code: 0, message: `Restarted action for '${agent}'` };
}

async function cmdAbandon(args: string[]): Promise<CliResult> {
  const coordRoot = requireFlagOrEnv(args, "--coord-root");
  const issue = parseInt(requireFlagOrEnv(args, "--issue"), 10);
  if (!coordRoot || !issue) return { code: 2, message: "coord abandon: requires --coord-root and --issue" };

  appendJournal(coordRoot, issue, { timestamp: new Date().toISOString(), event: "abandoned" });
  return { code: 0, message: "Issue abandoned. No further actions will be taken." };
}

function requireFlagOrEnv(args: string[], flag: string): string {
  const value = parseFlag(args, flag);
  if (value) return value;
  const envKey = `COORD_${flag.replace(/^--/, "").replace(/-/g, "_").toUpperCase()}`;
  return process.env[envKey] ?? "";
}
