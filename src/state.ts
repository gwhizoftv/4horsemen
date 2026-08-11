import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { agentIdSchema, digestSchema, gitShaSchema, issueSchema, issueSessionIdSchema } from "./protocol.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import {
  DEFAULT_MAX_REVISION_ROUNDS,
  type EvidenceId,
  type GateId,
  type PrPolicy,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export const RUNTIME_FORMAT_VERSION = 1;

const workflowProfileSchema = z.enum(["solo", "reviewed", "consensus"]);
const prPolicySchema = z.enum(["owner-only", "coord-open-unmerged"]);
const deliverySchema = z.enum(["pull", "nudge", "both"]);
const stepIdSchema = z.enum([
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R3.publish-selection",
  "R4.implement",
  "R5.compare",
  "R5.compare-ballot",
  "R5.reviser-auth",
  "R6.revise",
  "R6.ballot",
  "R6.declare",
  "R7.finalize"
]);
const gateIdSchema = z.enum([
  "gate-1-join",
  "gate-2-plans",
  "gate-3-selection",
  "gate-4-implementations",
  "gate-5-comparison",
  "gate-6-consensus",
  "gate-7-finalized"
]);
const evidenceIdSchema = z.enum([
  "join-published",
  "plan-published",
  "review-published",
  "plan-ballot-published",
  "selection-published",
  "implementation-pinned",
  "comparison-published",
  "comparison-ballot-published",
  "reviser-authorized",
  "revision-pinned",
  "consensus-ballot-published",
  "consensus-declared",
  "finalization-verified"
]);
const timestampSchema = z.string().datetime({ offset: true });

export const checkCommandSchema = z
  .object({
    name: z.string().min(1),
    argv: z.array(z.string()).min(1)
  })
  .strict();

export const agentConfigSchema = z
  .object({
    id: agentIdSchema,
    root: z.string().min(1),
    launcher: z.string().min(1),
    delivery: deliverySchema.default("pull"),
    harnessProcess: z.string().min(1).optional()
  })
  .strict();

export const coordinatorConfigSchema = z
  .object({
    project: z.string().min(1),
    origin: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    branch: z.string().refine((value) => value.includes("{issue}") && value.includes("{agent}")),
    baseBranch: z.string().min(1).default("main"),
    maxRevisionRounds: z.literal(DEFAULT_MAX_REVISION_ROUNDS).default(DEFAULT_MAX_REVISION_ROUNDS),
    prPolicy: prPolicySchema.default("owner-only"),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1_000)
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.agents.map((agent) => agent.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "agent ids must be unique", path: ["agents"] });
    }
  });

export const startStateSchema = z
  .object({
    formatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    issue: issueSchema,
    issueSessionId: issueSessionIdSchema,
    baselineSha: gitShaSchema,
    profile: workflowProfileSchema,
    originalRoster: z.array(agentIdSchema).min(1),
    branchTemplate: z.string().min(1),
    baseBranch: z.string().min(1),
    maxRevisionRounds: z.literal(DEFAULT_MAX_REVISION_ROUNDS),
    prPolicy: prPolicySchema,
    automationDigest: digestSchema,
    trustedSourceCommit: gitShaSchema,
    origin: z.string().min(1),
    coordRoot: z.string().min(1),
    configPath: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000),
    createdAt: timestampSchema
  })
  .strict();

export const agentCursorSchema = z
  .object({
    stepId: stepIdSchema.nullable(),
    evidenceId: evidenceIdSchema.nullable(),
    actionId: z.string().uuid().nullable(),
    status: z.enum([
      "idle",
      "ordered",
      "intent",
      "verifying",
      "waiting-peer",
      "paused",
      "complete",
      "failed",
      "harness-gone",
      "dropped"
    ]),
    attempt: z.number().int().nonnegative(),
    submissionSha: gitShaSchema.nullable(),
    outstanding: z.array(z.string()),
    updatedAt: timestampSchema
  })
  .strict();

export const acceptedSubmissionSchema = z
  .object({
    stepId: stepIdSchema,
    agent: agentIdSchema,
    round: z.number().int().min(1).nullable(),
    submissionSha: gitShaSchema,
    productPin: gitShaSchema.optional(),
    disposition: z.enum(["approve", "revise", "escalate"]).optional(),
    approvedPaths: z.array(z.string().min(1)).optional(),
    selectedAgents: z.array(agentIdSchema).optional(),
    path: z.string().min(1),
    acceptedAt: timestampSchema
  })
  .strict();

export const cursorsStateSchema = z
  .object({
    formatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    issueCursor: z
      .object({
        stepId: stepIdSchema,
        gateId: gateIdSchema,
        round: z.number().int().min(1).nullable()
      })
      .strict(),
    activeRoster: z.array(agentIdSchema).min(1),
    droppedAgents: z.array(agentIdSchema),
    reviser: agentIdSchema.nullable(),
    paused: z.boolean(),
    abandoned: z.boolean(),
    completed: z.boolean(),
    agents: z.record(agentIdSchema, agentCursorSchema),
    accepted: z.array(acceptedSubmissionSchema),
    updatedAt: timestampSchema
  })
  .strict();

export const journalEventSchema = z
  .object({
    formatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    sequence: z.number().int().nonnegative(),
    at: timestampSchema,
    type: z.enum([
      "started",
      "action-prepared",
      "nudged",
      "intent-seen",
      "verify-result",
      "gate-advanced",
      "owner-answer",
      "agent-dropped",
      "paused",
      "resumed",
      "action-restarted",
      "abandoned",
      "final-check",
      "pr-created"
    ]),
    agent: agentIdSchema.optional(),
    actionId: z.string().uuid().optional(),
    submissionSha: gitShaSchema.optional(),
    details: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type StartState = z.infer<typeof startStateSchema>;
export type AgentCursor = z.infer<typeof agentCursorSchema>;
export type AcceptedSubmission = z.infer<typeof acceptedSubmissionSchema>;
export type CursorsState = z.infer<typeof cursorsStateSchema>;
export type JournalEvent = z.infer<typeof journalEventSchema>;

export type StartStateInput = Omit<StartState, "formatVersion" | "createdAt"> & { createdAt?: string };

const parseFile = <T>(path: string, schema: z.ZodType<T>): T => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Invalid ${path}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
};

export const atomicWriteJson = (root: string, path: string, value: unknown): void => {
  const safePath = containedPath(root, relative(root, path));
  mkdirSync(dirname(safePath), { recursive: true, mode: 0o700 });
  assertNoSymlink(root, dirname(safePath));
  const temporary = containedPath(dirname(safePath), `.${randomUUID()}.tmp`);
  const handle = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, safePath);
  const directory = openSync(dirname(safePath), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
};

export const readConfig = (path: string): CoordinatorConfig => parseFile(path, coordinatorConfigSchema);
export const readStartState = (paths: IssueRuntimePaths): StartState => parseFile(paths.start, startStateSchema);
export const readCursorsState = (paths: IssueRuntimePaths): CursorsState => parseFile(paths.cursors, cursorsStateSchema);

export const initialCursors = (start: StartState, now = new Date().toISOString()): CursorsState => {
  const agents: Record<string, AgentCursor> = {};
  for (const agent of start.originalRoster) {
    agents[agent] = {
      stepId: null,
      evidenceId: null,
      actionId: null,
      status: "idle",
      attempt: 0,
      submissionSha: null,
      outstanding: [],
      updatedAt: now
    };
  }
  return cursorsStateSchema.parse({
    formatVersion: RUNTIME_FORMAT_VERSION,
    issueCursor: { stepId: "R1.join", gateId: "gate-1-join", round: null },
    activeRoster: start.originalRoster,
    droppedAgents: [],
    reviser: start.originalRoster[0] ?? null,
    paused: false,
    abandoned: false,
    completed: false,
    agents,
    accepted: [],
    updatedAt: now
  });
};

export const initializeOperationalState = (
  paths: IssueRuntimePaths,
  input: StartStateInput,
  now = new Date().toISOString()
): { start: StartState; cursors: CursorsState } => {
  if (existsSync(paths.start) || existsSync(paths.cursors) || existsSync(paths.journal)) {
    throw new Error(`Runtime state already exists for issue ${input.issue}. Use resume or abandon it explicitly.`);
  }
  const start = startStateSchema.parse({ ...input, formatVersion: RUNTIME_FORMAT_VERSION, createdAt: input.createdAt ?? now });
  const cursors = initialCursors(start, now);
  atomicWriteJson(paths.coordRoot, paths.start, start);
  atomicWriteJson(paths.coordRoot, paths.cursors, cursors);
  appendJournal(paths, { type: "started", details: { issue: start.issue, profile: start.profile } }, now);
  return { start, cursors };
};

export type JournalEventInput = Omit<JournalEvent, "formatVersion" | "sequence" | "at">;

export const readJournal = (paths: IssueRuntimePaths): JournalEvent[] => {
  if (!existsSync(paths.journal)) return [];
  const lines = readFileSync(paths.journal, "utf8").split("\n").filter((line) => line !== "");
  return lines.map((line, index) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(`Invalid journal line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return journalEventSchema.parse(value);
  });
};

export const appendJournal = (
  paths: IssueRuntimePaths,
  input: JournalEventInput,
  now = new Date().toISOString()
): JournalEvent => {
  const existing = readJournal(paths);
  const event = journalEventSchema.parse({
    ...input,
    formatVersion: RUNTIME_FORMAT_VERSION,
    sequence: existing.length,
    at: now
  });
  mkdirSync(dirname(paths.journal), { recursive: true, mode: 0o700 });
  assertNoSymlink(paths.coordRoot, dirname(paths.journal));
  const handle = openSync(paths.journal, "a", 0o600);
  try {
    writeFileSync(handle, `${JSON.stringify(event)}\n`, "utf8");
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  return event;
};

export const writeCursorsState = (paths: IssueRuntimePaths, cursors: CursorsState): void => {
  atomicWriteJson(paths.coordRoot, paths.cursors, cursorsStateSchema.parse(cursors));
};

export const replaceCursor = (
  cursors: CursorsState,
  agent: string,
  patch: Partial<AgentCursor>,
  now = new Date().toISOString()
): CursorsState => {
  const current = cursors.agents[agent];
  if (current === undefined) throw new Error(`Unknown agent ${agent}.`);
  return cursorsStateSchema.parse({
    ...cursors,
    agents: { ...cursors.agents, [agent]: { ...current, ...patch, updatedAt: now } },
    updatedAt: now
  });
};

export const setPaused = (cursors: CursorsState, paused: boolean, now = new Date().toISOString()): CursorsState =>
  cursorsStateSchema.parse({ ...cursors, paused, updatedAt: now });

export const dropAgent = (cursors: CursorsState, agent: string, now = new Date().toISOString()): CursorsState => {
  if (!cursors.activeRoster.includes(agent)) throw new Error(`${agent} is not active.`);
  if (cursors.activeRoster.length === 1) throw new Error("Cannot drop the final active agent.");
  const activeRoster = cursors.activeRoster.filter((candidate) => candidate !== agent);
  const current = cursors.agents[agent];
  if (current === undefined) throw new Error(`Unknown agent ${agent}.`);
  return cursorsStateSchema.parse({
    ...cursors,
    activeRoster,
    droppedAgents: [...cursors.droppedAgents, agent],
    reviser: cursors.reviser === agent ? activeRoster[0] : cursors.reviser,
    agents: {
      ...cursors.agents,
      [agent]: { ...current, status: "dropped", actionId: null, submissionSha: null, outstanding: [], updatedAt: now }
    },
    accepted: cursors.accepted.filter(
      (submission) => submission.agent !== agent || submission.stepId !== cursors.issueCursor.stepId
    ),
    updatedAt: now
  });
};

export type StateTypeExports = {
  profile: WorkflowProfile;
  prPolicy: PrPolicy;
  stepId: WorkflowStepId;
  gateId: GateId;
  evidenceId: EvidenceId;
};
