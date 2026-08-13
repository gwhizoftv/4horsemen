import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, relative } from "node:path";
import { z } from "zod";
import { agentIdSchema, digestSchema, gitShaSchema, issueSchema, issueSessionIdSchema } from "./protocol.js";
import { assertNoSymlink, containedPath, type IssueRuntimePaths } from "./paths.js";
import {
  DEFAULT_MAX_REVISION_ROUNDS,
  DEFAULT_PR_POLICY,
  type EvidenceId,
  type GateId,
  type PrPolicy,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export const RUNTIME_FORMAT_VERSION = 2;

const workflowProfileSchema = z.enum(["solo", "reviewed", "consensus"]);
const prPolicySchema = z.enum(["owner-only", "coord-open-unmerged", "coord-merged"]);
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

/**
 * Local verification the agent-clone hooks run, declared as argument vectors so
 * the hook bodies never branch on an ecosystem marker or grep the product for a
 * script name. Absent means "undeclared" and fails an agent clone closed; the
 * two empty arrays are the explicit, recorded way to opt out.
 */
export const verifyConfigSchema = z
  .object({
    precommit: z.array(checkCommandSchema),
    prepush: z.array(checkCommandSchema)
  })
  .strict();

export const verifyPhaseSchema = z.enum(["precommit", "prepush"]);

/**
 * Path fragments the pre-push scope filter compares against. They cross a
 * line-oriented boundary into the hooks, so whitespace is rejected here rather
 * than producing an ambiguous token the hook would silently mis-split.
 */
const pathTokenSchema = z
  .string()
  .min(1)
  .refine((value) => !/\s/.test(value), "workflow-critical entries must not contain whitespace");

/** What a workspace was installed against, so `coord doctor` can report drift. */
export const installStampSchema = z
  .object({
    installRoot: z.string().min(1),
    cliEntry: z.string().min(1),
    version: z.string().min(1),
    commit: gitShaSchema,
    /**
     * Digest of the hook bodies, shim template, and launcher template the
     * clones actually execute. The commit alone cannot see an uncommitted edit
     * to a canonical body, which is how a hook rewritten to `exit 0` passed
     * inspection while every clone ran it.
     */
    canonicalDigest: digestSchema,
    installedAt: timestampSchema,
    productRoot: z.string().min(1),
    cloneRoot: z.string().min(1),
    vendored: z.boolean(),
    /** Bootstrap commands were run in the install checkout. */
    bootstrapped: z.boolean(),
    /**
     * Coordination created the install checkout and may therefore delete it.
     * Running `pnpm install` inside somebody's existing clone is not ownership.
     */
    ownsInstallRoot: z.boolean(),
    wroteProductIgnore: z.boolean(),
    wroteAgentsMd: z.boolean()
  })
  .strict();

export const agentConfigSchema = z
  .object({
    id: agentIdSchema,
    root: z.string().min(1),
    launcher: z.string().min(1),
    delivery: deliverySchema.default("pull"),
    harnessProcess: z.string().min(1).optional(),
    /** tmux send-keys before the nudge text (e.g. vim insert `i`). */
    nudgePrelude: z.array(z.string().min(1)).optional(),
    /** tmux send-keys after the nudge text (e.g. Enter or C-j). */
    nudgeSubmit: z.array(z.string().min(1)).optional(),
    /** macOS Terminal.app settings-set (profile) name for owner attach windows. */
    terminalProfile: z.string().min(1).optional()
  })
  .strict();

export const coordinatorConfigSchema = z
  .object({
    project: z.string().min(1),
    origin: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    branch: z.string().refine((value) => value.includes("{issue}") && value.includes("{agent}")),
    baseBranch: z.string().min(1).default("main"),
    profile: workflowProfileSchema.default("consensus"),
    maxRevisionRounds: z.literal(DEFAULT_MAX_REVISION_ROUNDS).default(DEFAULT_MAX_REVISION_ROUNDS),
    prPolicy: prPolicySchema.default(DEFAULT_PR_POLICY),
    digestPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "digest path must be confined")
      )
      .default([]),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1_000),
    toolchain: z.string().min(1).optional(),
    verify: verifyConfigSchema.optional(),
    workflowCriticalPrefixes: z.array(pathTokenSchema).default([]),
    workflowCriticalFiles: z.array(pathTokenSchema).default([]),
    coordination: installStampSchema.optional()
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.agents.map((agent) => agent.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "agent ids must be unique", path: ["agents"] });
    }
    if (new Set(config.digestPaths).size !== config.digestPaths.length) {
      context.addIssue({ code: "custom", message: "digest paths must be unique", path: ["digestPaths"] });
    }
  });

/**
 * What an operator may hand to `coord install --declare`: the parts of a
 * workspace config that are the product's decision rather than the installer's.
 * Identity, agent roots, and the install stamp are deliberately absent — those
 * are derived from the arguments of the install itself, so a declaration file
 * cannot quietly redirect a clone.
 */
export const workspaceDeclarationSchema = z
  .object({
    toolchain: z.string().min(1).optional(),
    verify: verifyConfigSchema.optional(),
    workflowCriticalPrefixes: z.array(pathTokenSchema).optional(),
    workflowCriticalFiles: z.array(pathTokenSchema).optional(),
    checks: z.array(checkCommandSchema).min(1).optional(),
    branch: z
      .string()
      .refine((value) => value.includes("{issue}") && value.includes("{agent}"))
      .optional(),
    prPolicy: prPolicySchema.optional(),
    digestPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "digest path must be confined")
      )
      .optional(),
    pollIntervalMs: z.number().int().min(100).max(60_000).optional()
  })
  .strict();

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
    automationDigestScheme: z.literal("sha256-length-prefixed-v1"),
    automationDigestSources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            sha256: digestSchema
          })
          .strict()
      )
      .min(1),
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
    choice: agentIdSchema.optional(),
    reviser: agentIdSchema.optional(),
    checkResults: z
      .array(
        z
          .object({
            name: z.string().min(1),
            argv: z.array(z.string()).min(1),
            exitCode: z.number().int()
          })
          .strict()
      )
      .optional(),
    path: z.string().min(1),
    acceptedAt: timestampSchema
  })
  .strict();

export const cursorsStateSchema = z
  .object({
    formatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    stateRevision: z.number().int().nonnegative(),
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
    selection: z
      .object({
        planAgents: z.array(agentIdSchema),
        implementationAgent: agentIdSchema.nullable(),
        implementationPin: gitShaSchema.nullable(),
        reviser: agentIdSchema.nullable()
      })
      .strict(),
    ownerQuestion: z
      .object({
        id: z.string().uuid(),
        kind: z.enum(["ballot-escalation", "revision-limit"]),
        round: z.number().int().min(1),
        allowedAnswers: z.array(z.enum(["retry", "revise", "abandon"])).min(1),
        createdAt: timestampSchema
      })
      .strict()
      .nullable(),
    lastOwnerAnswer: z
      .object({
        questionId: z.string().uuid(),
        answer: z.enum(["retry", "revise", "abandon"]),
        answeredAt: timestampSchema
      })
      .strict()
      .nullable(),
    publication: z
      .object({
        status: z.enum(["not-required", "pending", "completed", "failed"]),
        finalSha: gitShaSchema.nullable(),
        branch: z.string().min(1).nullable(),
        url: z.string().url().nullable(),
        error: z.string().min(1).nullable(),
        attempts: z.number().int().nonnegative()
      })
      .strict(),
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
      "owner-question",
      "owner-answer",
      "agent-dropped",
      "paused",
      "resumed",
      "action-restarted",
      "abandoned",
      "final-check",
      "publication-pending",
      "publication-failed",
      "pr-created",
      "pr-merged"
    ]),
    agent: agentIdSchema.optional(),
    actionId: z.string().uuid().optional(),
    submissionSha: gitShaSchema.optional(),
    details: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type CoordinatorConfig = z.infer<typeof coordinatorConfigSchema>;
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type CheckCommand = z.infer<typeof checkCommandSchema>;
export type VerifyConfig = z.infer<typeof verifyConfigSchema>;
export type VerifyPhase = z.infer<typeof verifyPhaseSchema>;
export type InstallStamp = z.infer<typeof installStampSchema>;
export type WorkspaceDeclaration = z.infer<typeof workspaceDeclarationSchema>;
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
    stateRevision: 0,
    issueCursor: { stepId: "R1.join", gateId: "gate-1-join", round: null },
    activeRoster: start.originalRoster,
    droppedAgents: [],
    reviser: null,
    selection: { planAgents: [], implementationAgent: null, implementationPin: null, reviser: null },
    ownerQuestion: null,
    lastOwnerAnswer: null,
    publication: {
      status: "not-required",
      finalSha: null,
      branch: null,
      url: null,
      error: null,
      attempts: 0
    },
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
  mkdirSync(dirname(paths.journal), { recursive: true, mode: 0o700 });
  const lockPath = `${paths.journal}.lock`;
  const lock = acquireExclusiveLock(lockPath);
  try {
    const existing = readJournal(paths);
    const event = journalEventSchema.parse({
      ...input,
      formatVersion: RUNTIME_FORMAT_VERSION,
      sequence: existing.length,
      at: now
    });
    assertNoSymlink(paths.coordRoot, dirname(paths.journal));
    const handle = openSync(paths.journal, "a", 0o600);
    try {
      writeFileSync(handle, `${JSON.stringify(event)}\n`, "utf8");
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    return event;
  } finally {
    closeSync(lock);
    if (existsSync(lockPath)) unlinkSync(lockPath);
  }
};

export const writeCursorsState = (paths: IssueRuntimePaths, cursors: CursorsState): void => {
  atomicWriteJson(paths.coordRoot, paths.cursors, cursorsStateSchema.parse(cursors));
};

export class StateConflictError extends Error {
  override readonly name = "StateConflictError";
}

const cursorLockPath = (paths: IssueRuntimePaths): string => `${paths.cursors}.lock`;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
};

const acquireExclusiveLock = (lockPath: string): number => {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      const handle = openSync(lockPath, "wx", 0o600);
      writeFileSync(handle, `${process.pid}\n`, "utf8");
      fsyncSync(handle);
      return handle;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      try {
        const owner = Number(readFileSync(lockPath, "utf8").trim());
        if (Number.isInteger(owner) && owner > 0 && !processIsAlive(owner)) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // The owner may be between exclusive creation and writing its pid.
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  throw new Error(`Timed out waiting for coordinator state lock ${lockPath}.`);
};

/**
 * Apply one short local state transition under an exclusive lock. Slow Git,
 * tmux, check, and publication effects must happen outside this callback and
 * use expectedRevision when committing their result.
 */
export const mutateCursorsState = (
  paths: IssueRuntimePaths,
  mutation: (current: CursorsState) => CursorsState,
  expectedRevision?: number
): { applied: boolean; state: CursorsState } => {
  const handle = acquireExclusiveLock(cursorLockPath(paths));
  try {
    const current = readCursorsState(paths);
    if (expectedRevision !== undefined && current.stateRevision !== expectedRevision) {
      return { applied: false, state: current };
    }
    const candidate = mutation(current);
    const state = cursorsStateSchema.parse({
      ...candidate,
      stateRevision: current.stateRevision + 1
    });
    writeCursorsState(paths, state);
    return { applied: true, state };
  } finally {
    closeSync(handle);
    if (existsSync(cursorLockPath(paths))) unlinkSync(cursorLockPath(paths));
  }
};

export const requireStateMutation = (
  paths: IssueRuntimePaths,
  expectedRevision: number,
  mutation: (current: CursorsState) => CursorsState
): CursorsState => {
  // This compare-and-swap is the authority boundary for effects: without it,
  // a delayed Git/tmux/check result could overwrite a concurrent owner control.
  const result = mutateCursorsState(paths, mutation, expectedRevision);
  if (!result.applied) throw new StateConflictError("Coordinator state changed during an effect; re-observation is required.");
  return result.state;
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
    reviser: cursors.reviser === agent ? null : cursors.reviser,
    selection: {
      planAgents: cursors.selection.planAgents.filter((candidate) => candidate !== agent),
      implementationAgent: cursors.selection.implementationAgent === agent ? null : cursors.selection.implementationAgent,
      implementationPin: cursors.selection.implementationAgent === agent ? null : cursors.selection.implementationPin,
      reviser: cursors.selection.reviser === agent ? null : cursors.selection.reviser
    },
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
