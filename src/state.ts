import {
  appendFileSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import { assertNoSymlinkBelow, coordPaths, type CoordPaths } from "./paths.js";
import { DEFAULT_MAX_REVISION_ROUNDS, RUNTIME_FORMAT_VERSION, type GateId } from "./steps.js";

/**
 * Operational state: strict schemas plus atomic, crash-safe I/O.
 *
 * `start.json` is written once and never mutated — it records what the run was
 * started with. Everything that changes during a run lives in `cursors.json`,
 * and every state change is journaled before it is acknowledged.
 */

const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const agentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*$/);
const timestampSchema = z.string().min(1);

export const profileSchema = z.enum(["solo", "reviewed", "consensus"]);
export const prPolicySchema = z.enum(["owner-only", "coord-open-unmerged"]);

export const checkCommandSchema = z
  .object({
    /** Explicit argument vector. Never a shell string. */
    argv: z.array(z.string().min(1)).min(1),
    /** Optional working directory relative to the verification worktree. */
    cwd: z.string().min(1).optional()
  })
  .strict();

export type CheckCommand = z.infer<typeof checkCommandSchema>;

export const agentConfigSchema = z
  .object({
    id: agentIdSchema,
    root: z.string().min(1),
    harness: z.string().min(1).default("unknown"),
    /** Automatic tmux insertion. Non-Claude harnesses stay pull-only. */
    nudge: z.boolean().default(false)
  })
  .strict();

export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const coordConfigSchema = z
  .object({
    project: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    branch: z.string().min(1).default("issue-{issue}/{agent}"),
    baseBranch: z.string().min(1).default("main"),
    originUrl: z.string().min(1).optional(),
    maxRevisionRounds: z.number().int().min(1).default(DEFAULT_MAX_REVISION_ROUNDS),
    prPolicy: prPolicySchema.default("owner-only"),
    finalChecks: z.array(checkCommandSchema).default([])
  })
  .strict();

export type CoordConfig = z.infer<typeof coordConfigSchema>;

export const startRecordSchema = z
  .object({
    runtimeFormatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    issue: z.number().int().positive(),
    issueSessionId: z.string().min(1),
    baselineSha: gitShaSchema,
    profile: profileSchema,
    /** The roster the run began with. Never edited by a drop. */
    originalRoster: z.array(agentIdSchema).min(1),
    agentRoots: z.record(agentIdSchema, z.string().min(1)),
    harnesses: z.record(agentIdSchema, z.string().min(1)),
    nudgeAllowed: z.record(agentIdSchema, z.boolean()),
    baseBranch: z.string().min(1),
    branchTemplate: z.string().min(1),
    maxRevisionRounds: z.number().int().min(1),
    prPolicy: prPolicySchema,
    automationDigest: z.string().regex(/^[a-f0-9]{64}$/),
    automationDigestScheme: z.string().min(1),
    trustedSourceCommit: gitShaSchema,
    finalChecks: z.array(checkCommandSchema),
    createdAt: timestampSchema
  })
  .strict();

export type StartRecord = z.infer<typeof startRecordSchema>;

export const agentStatusSchema = z.enum([
  "idle",
  "ordered",
  "intent",
  "verifying",
  "waiting-peer",
  "paused",
  "complete",
  "harness-gone"
]);

export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentCursorSchema = z
  .object({
    stepId: z.string().min(1).nullable(),
    actionId: z.string().min(1).nullable(),
    status: agentStatusSchema,
    /** Diagnostic only. It can never drop an agent or advance a gate. */
    attempt: z.number().int().min(0),
    delivery: z.enum(["nudge", "pull", "both"]),
    tmuxTarget: z.string().min(1).nullable(),
    submissionSha: gitShaSchema.nullable(),
    outstanding: z.array(z.string()),
    /** Steps this agent has already satisfied in this run. */
    satisfied: z.array(z.string()),
    /** stepId -> the accepted submission commit, used to bind peer inputs. */
    published: z.record(z.string(), gitShaSchema),
    updatedAt: timestampSchema
  })
  .strict();

export type AgentCursor = z.infer<typeof agentCursorSchema>;

export const cursorsSchema = z
  .object({
    runtimeFormatVersion: z.literal(RUNTIME_FORMAT_VERSION),
    issueCursor: z
      .object({
        gateId: z.string().min(1),
        round: z.number().int().min(1).nullable()
      })
      .strict(),
    /** Persisted owner drops. Checked before every observation. */
    droppedAgents: z.array(agentIdSchema),
    paused: z.boolean(),
    abandoned: z.boolean(),
    /** Selected plan/implementation owner, once chosen. */
    selected: agentIdSchema.nullable(),
    agents: z.record(agentIdSchema, agentCursorSchema),
    updatedAt: timestampSchema
  })
  .strict();

export type Cursors = z.infer<typeof cursorsSchema>;

export const journalEventSchema = z
  .object({
    at: timestampSchema,
    kind: z.enum([
      "started",
      "action-prepared",
      "nudged",
      "intent-seen",
      "verify-result",
      "verify-deferred",
      "gate-advanced",
      "owner-answer",
      "owner-drop",
      "paused",
      "resumed",
      "action-restarted",
      "abandoned",
      "check-result",
      "consensus-declared",
      "finalized",
      "notify"
    ]),
    agent: agentIdSchema.optional(),
    detail: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export type JournalEvent = z.infer<typeof journalEventSchema>;

/* -------------------------------------------------------------------------- */
/* Atomic I/O                                                                  */
/* -------------------------------------------------------------------------- */

/** fsync the directory so a rename survives a crash on the parent too. */
const syncDirectory = (directory: string): void => {
  let handle: number | undefined;

  try {
    handle = openSync(directory, "r");
    fsyncSync(handle);
  } catch {
    // Directory fsync is unsupported on some platforms; the rename is still atomic.
  } finally {
    if (handle !== undefined) {
      closeSync(handle);
    }
  }
};

/**
 * Write-and-rename with an fsync on the temporary file before the rename, so a
 * reader never observes a torn document.
 */
export const writeFileAtomic = (path: string, contents: string, base?: string): void => {
  if (base !== undefined) {
    assertNoSymlinkBelow(base, path);
  }

  const directory = dirname(path);

  mkdirSync(directory, { recursive: true });

  const temporary = `${path}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`;
  const handle = openSync(temporary, "w");

  try {
    writeSync(handle, contents);
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }

  renameSync(temporary, path);
  syncDirectory(directory);
};

export const writeJsonAtomic = (path: string, value: unknown, base?: string): void => {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, base);
};

export type LoadFailure = { ok: false; errors: string[] };
export type LoadSuccess<T> = { ok: true; value: T };
export type LoadOutcome<T> = LoadSuccess<T> | LoadFailure;

/**
 * Read and validate a runtime document. A version mismatch fails closed rather
 * than guessing how to resume an older layout.
 */
export const readJsonValidated = <T>(path: string, schema: z.ZodType<T>, base?: string): LoadOutcome<T> => {
  if (base !== undefined) {
    try {
      assertNoSymlinkBelow(base, path);
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
  }

  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { ok: false, errors: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const result = schema.safeParse(parsed);

  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((issue) => `${path}: ${issue.path.join(".")}: ${issue.message}`)
    };
  }

  return { ok: true, value: result.data };
};

/** Append one journal line. Journaling precedes destructive acknowledgement. */
export const appendJournal = (path: string, event: JournalEvent, base?: string): void => {
  if (base !== undefined) {
    assertNoSymlinkBelow(base, path);
  }

  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(journalEventSchema.parse(event))}\n`);
};

export const readJournal = (path: string): JournalEvent[] => {
  let raw: string;

  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => journalEventSchema.parse(JSON.parse(line)));
};

/* -------------------------------------------------------------------------- */
/* Construction and recovery                                                   */
/* -------------------------------------------------------------------------- */

export const emptyAgentCursor = (now: string, delivery: AgentCursor["delivery"]): AgentCursor => ({
  stepId: null,
  actionId: null,
  status: "idle",
  attempt: 0,
  delivery,
  tmuxTarget: null,
  submissionSha: null,
  outstanding: [],
  satisfied: [],
  published: {},
  updatedAt: now
});

export const initialCursors = (start: StartRecord, firstGate: GateId, now: string): Cursors => ({
  runtimeFormatVersion: RUNTIME_FORMAT_VERSION,
  issueCursor: { gateId: firstGate, round: null },
  droppedAgents: [],
  paused: false,
  abandoned: false,
  selected: null,
  agents: Object.fromEntries(
    start.originalRoster.map((agent) => [
      agent,
      emptyAgentCursor(now, start.nudgeAllowed[agent] === true ? "both" : "pull")
    ])
  ),
  updatedAt: now
});

/** Roster minus persisted drops. Never derived from anything else. */
export const activeAgents = (start: StartRecord, cursors: Cursors): string[] =>
  start.originalRoster.filter((agent) => !cursors.droppedAgents.includes(agent));

export type RuntimeState = {
  readonly paths: CoordPaths;
  readonly start: StartRecord;
  cursors: Cursors;
};

export const ensureRuntimeLayout = (paths: CoordPaths, roster: readonly string[]): void => {
  mkdirSync(paths.issueDir, { recursive: true });
  mkdirSync(paths.agentsDir, { recursive: true });

  for (const agent of roster) {
    mkdirSync(paths.agentDir(agent), { recursive: true });
  }
};

/**
 * Reload persisted state for `run`, `next`, and every owner control command.
 * Returns concrete errors instead of throwing so the CLI can map them to exit
 * codes.
 */
export const loadRuntimeState = (root: string, issue: number): LoadOutcome<RuntimeState> => {
  const paths = coordPaths(root, issue);
  const start = readJsonValidated(paths.startJson, startRecordSchema, root);

  if (!start.ok) {
    return start;
  }

  const cursors = readJsonValidated(paths.cursorsJson, cursorsSchema, root);

  if (!cursors.ok) {
    return cursors;
  }

  return { ok: true, value: { paths, start: start.value, cursors: cursors.value } };
};

export const saveCursors = (state: RuntimeState, now: string): void => {
  state.cursors = { ...state.cursors, updatedAt: now };
  writeJsonAtomic(state.paths.cursorsJson, state.cursors, state.paths.root);
};

/**
 * Path of the throwaway verification worktree for one finalization attempt.
 *
 * The nonce keeps every attempt on a fresh directory. Reusing a name risks
 * colliding with a stale `git worktree` admin entry left by an interrupted
 * run, which fails the checkout rather than the checks.
 */
export const verificationWorktreePath = (paths: CoordPaths, sha: string, nonce?: string): string =>
  join(paths.worktreesDir, `verify-${sha.slice(0, 12)}${nonce === undefined ? "" : `-${nonce}`}`);

export const writeStartRecord = (paths: CoordPaths, start: StartRecord): void => {
  writeJsonAtomic(paths.startJson, startRecordSchema.parse(start), paths.root);
};
