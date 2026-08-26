import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
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
  RESERVED_EVIDENCE_AGENT,
  evidenceBranchFor,
  type EvidenceId,
  type GateId,
  type PrPolicy,
  type WorkflowProfile,
  type WorkflowStepId
} from "./steps.js";

export const RUNTIME_FORMAT_VERSION = 4;

/**
 * Every format this build refuses, rather than only the immediately previous
 * one. Ballot intent moved out of Git entirely at format 4, so a format-2 or
 * format-3 runtime read under these semantics would treat a gate whose ballots
 * were pushed commits as a gate with no responses at all. There is no migration
 * by design; the remedy is a wipe and a restart.
 */
const UNSUPPORTED_RUNTIME_FORMAT_VERSIONS = [2, 3] as const;

const runtimeFormatWipeMessage = (found: number): string =>
  `Runtime format version ${found} is no longer supported. Wipe this issue with ` +
  "`coord wipe-issue <issue>` and start it again.";

const workflowProfileSchema = z.enum(["solo", "reviewed", "consensus"]);
const prPolicySchema = z.enum(["owner-only", "coord-open-unmerged", "coord-merged"]);
const deliverySchema = z.enum(["pull", "nudge", "both"]);
const stepIdSchema = z.enum([
  "R1.join",
  "R2.plan",
  "R3.review",
  "R3.plan-ballot",
  "R4.implement",
  "R5.compare",
  "R5.compare-ballot",
  "R6.revise",
  "R6.ballot",
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
  "plan-ballot-accepted",
  "implementation-pinned",
  "comparison-published",
  "comparison-ballot-accepted",
  "revision-pinned",
  "consensus-ballot-accepted",
  "finalization-verified"
]);

const submissionModeSchema = z.enum(["git", "response"]);
const dispositionSchema = z.enum(["approve", "revise", "escalate"]);
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
    wroteAgentsMd: z.boolean(),
    /**
     * Resolved absolute mailbox root this workspace was installed against.
     * Optional so a stamp written before the mailbox existed still parses; a
     * reinstall fills it in.
     */
    completesRoot: z.string().min(1).optional()
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
    contextPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "context path must be confined")
      )
      .default([]),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000).default(1_000),
    toolchain: z.string().min(1).optional(),
    verify: verifyConfigSchema.optional(),
    workflowCriticalPrefixes: z.array(pathTokenSchema).default([]),
    workflowCriticalFiles: z.array(pathTokenSchema).default([]),
    /**
     * Absolute root of the completion mailbox. Optional: a flat workspace
     * derives the sibling of the coord root. Nested or shared runtimes that do
     * not share that parent must state it, because the derived sibling would
     * put two products' receipts in one tree.
     */
    completesRoot: z.string().min(1).optional(),
    coordination: installStampSchema.optional()
  })
  .strict()
  .superRefine((config, context) => {
    const ids = config.agents.map((agent) => agent.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", message: "agent ids must be unique", path: ["agents"] });
    }
    // Refused where the roster is admitted, not where it is used. The evidence
    // branch is rendered from this same template, so an agent with this id
    // would make the coordinator publish its ballot batches onto that agent's
    // own branch and then let a wipe delete them as agent leftovers.
    if (ids.includes(RESERVED_EVIDENCE_AGENT)) {
      context.addIssue({
        code: "custom",
        message: `${RESERVED_EVIDENCE_AGENT} is reserved for the coordinator evidence branch`,
        path: ["agents"]
      });
    }
    if (new Set(config.digestPaths).size !== config.digestPaths.length) {
      context.addIssue({ code: "custom", message: "digest paths must be unique", path: ["digestPaths"] });
    }
    if (new Set(config.contextPaths).size !== config.contextPaths.length) {
      context.addIssue({ code: "custom", message: "context paths must be unique", path: ["contextPaths"] });
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
    contextPaths: z
      .array(
        z
          .string()
          .min(1)
          .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), "context path must be confined")
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
    /**
     * Where this issue's receipts live, frozen for the issue session.
     *
     * Read from here rather than from config on resume: `coord install` may
     * rewrite config mid-issue, and a mailbox that moved under a running action
     * would leave the coordinator polling a tree no agent holds a grant to.
     *
     * Optional for the same reason `contextPaths` is defaulted — a `start.json`
     * written before this field existed must still parse under the strict
     * schema. Every issue started since carries it, and readers fall back to the
     * derived default only for those older documents.
     */
    completesRoot: z.string().min(1).optional(),
    configPath: z.string().min(1),
    agents: z.array(agentConfigSchema).min(1),
    checks: z.array(checkCommandSchema).min(1),
    pollIntervalMs: z.number().int().min(100).max(60_000),
    /**
     * Advisory reading named in every action. Defaulted rather than required so
     * a start.json written before this field existed still parses under the
     * strict schema; see `StartStateInput` for the construction boundary.
     */
    contextPaths: z.array(z.string().min(1)).default([]),
    createdAt: timestampSchema
  })
  .strict();

export const agentCursorSchema = z
  .object({
    stepId: stepIdSchema.nullable(),
    evidenceId: evidenceIdSchema.nullable(),
    actionId: z.string().uuid().nullable(),
    /** How the current action must be answered; null when no action is out. */
    submissionMode: submissionModeSchema.nullable(),
    /**
     * SHA-256 of the exact `action.md` bytes this cursor authorized.
     *
     * Workflow authority, not observability: the lifecycle file also records a
     * digest, but `paths.ts` documents that tree as deliberately separate from
     * authority, so it cannot be what a response is checked against. A
     * correction reissues under the *same* action id with different bytes, and
     * without a digest here a response written against the superseded text
     * would still match on every id and satisfy the corrected action.
     */
    actionDigest: digestSchema.nullable(),
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

const derivedInputKindSchema = z.enum([
  "plan",
  "plan-ballot",
  "implementation",
  "comparison-ballot",
  "revision",
  "consensus-ballot"
]);

/**
 * What a derived decision cites.
 *
 * A discriminated union rather than one shape, because the two things a
 * decision can rest on are not the same kind of fact. A Git submission is
 * proven by a pushed 40-character commit; a ballot is proven by the SHA-256 of
 * the exact private response bytes the coordinator accepted, plus the evidence
 * commit it published them in. Forcing the second into `submissionSha` would
 * either fail the 40-hex parse or, worse, pass it by truncation and quietly
 * label a response digest as a commit.
 */
const gitSubmissionCitationSchema = z
  .object({
    source: z.literal("git-submission"),
    kind: derivedInputKindSchema,
    agent: agentIdSchema,
    submissionSha: gitShaSchema,
    path: z.string().min(1),
    productPin: gitShaSchema.optional()
  })
  .strict();

const responseCitationSchema = z
  .object({
    source: z.literal("response"),
    kind: derivedInputKindSchema,
    agent: agentIdSchema,
    /** The action the judgment answered. */
    actionId: z.string().uuid(),
    /** SHA-256 over the exact accepted response bytes. */
    responseSha256: digestSchema,
    /** The coordinator commit that published this ballot, and its path in it. */
    evidenceCommitSha: gitShaSchema,
    path: z.string().min(1)
  })
  .strict();

const derivedInputCitationSchema = z.discriminatedUnion("source", [
  gitSubmissionCitationSchema,
  responseCitationSchema
]);

const derivedDecisionBaseSchema = z
  .object({
    inputSetHash: digestSchema,
    activeRoster: z.array(agentIdSchema).min(1),
    inputs: z.array(derivedInputCitationSchema).min(1),
    decidedAt: timestampSchema
  })
  .strict();

const planSelectionDecisionIdSchema = z
  .string()
  .regex(/^plan-selection:[a-f0-9]{64}$/, "expected a plan-selection decision identity");

const implementationSelectionDecisionIdSchema = z
  .string()
  .regex(/^implementation-selection:[a-f0-9]{64}$/, "expected an implementation-selection decision identity");

const consensusDecisionIdSchema = z
  .string()
  .regex(/^consensus:[a-f0-9]{64}:r[1-9][0-9]*$/, "expected a round-bound consensus decision identity");

export const planSelectionDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("plan-selection"),
    algorithm: z.literal("plurality-active-roster-v1"),
    decisionId: planSelectionDecisionIdSchema,
    supersedes: planSelectionDecisionIdSchema.nullable(),
    selectedAgents: z.array(agentIdSchema).min(1)
  })
  .strict()
  .refine((record) => record.decisionId === `plan-selection:${record.inputSetHash}`, {
    path: ["decisionId"],
    message: "decision identity must match the plan-selection input hash"
  });

export const implementationSelectionDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("implementation-selection"),
    algorithm: z.literal("plurality-active-roster-v1"),
    decisionId: implementationSelectionDecisionIdSchema,
    supersedes: implementationSelectionDecisionIdSchema.nullable(),
    winner: agentIdSchema,
    implementationPin: gitShaSchema,
    reviser: agentIdSchema
  })
  .strict()
  .refine((record) => record.decisionId === `implementation-selection:${record.inputSetHash}`, {
    path: ["decisionId"],
    message: "decision identity must match the implementation-selection input hash"
  });

export const consensusDerivedSchema = derivedDecisionBaseSchema
  .extend({
    kind: z.literal("consensus"),
    algorithm: z.literal("unanimous-active-roster-v1"),
    decisionId: consensusDecisionIdSchema,
    supersedes: consensusDecisionIdSchema.nullable(),
    round: z.number().int().min(1),
    consensusPin: gitShaSchema
  })
  .strict()
  .refine((record) => record.decisionId === `consensus:${record.inputSetHash}:r${record.round}`, {
    path: ["decisionId"],
    message: "decision identity must match the consensus input hash and round"
  });

export const derivedStateSchema = z
  .object({
    planSelection: planSelectionDerivedSchema.nullable(),
    implementationSelection: implementationSelectionDerivedSchema.nullable(),
    consensus: consensusDerivedSchema.nullable()
  })
  .strict();

/**
 * One accepted private ballot response.
 *
 * Deliberately *not* an `AcceptedSubmission`. That type records what an agent
 * pushed to Git; this records what an agent privately judged. Keeping them
 * apart is what lets a derived decision say both "this is the exact handoff the
 * agent authored" and "this is the commit in which the coordinator published
 * it" without one masquerading as the other.
 */
export const acceptedResponseSchema = z
  .object({
    stepId: stepIdSchema,
    agent: agentIdSchema,
    actionId: z.string().uuid(),
    round: z.number().int().min(1).nullable(),
    responseSha256: digestSchema,
    choice: agentIdSchema.optional(),
    disposition: dispositionSchema.optional(),
    rationale: z.string().min(1),
    acceptedAt: timestampSchema
  })
  .strict();

const ballotBatchKindSchema = z.enum([
  "plan-ballot-batch",
  "comparison-ballot-batch",
  "consensus-ballot-batch"
]);

/**
 * One durable publication attempt for a completed ballot gate or round.
 *
 * `commitSha` is persisted *before* the push, and every retry pushes that exact
 * object. Commit metadata is part of a commit's identity, so rebuilding on
 * retry would produce a different SHA each time and leave a trail of candidate
 * commits with no way to say which one the decision rested on.
 *
 * History is a list, not a slot: consensus can run several rounds, and a roster
 * change can supersede a batch that is already on origin. Both must stay
 * readable afterwards.
 */
export const ballotBatchSchema = z
  .object({
    kind: ballotBatchKindSchema,
    stepId: stepIdSchema,
    round: z.number().int().min(1).nullable(),
    /** Ordered active roster this batch was frozen against. */
    activeRoster: z.array(agentIdSchema).min(1),
    /** Hash over kind, round, roster, bound Git citations, and response tuples. */
    inputSetHash: digestSchema,
    responseSha256s: z.array(digestSchema).min(1),
    paths: z.array(z.string().min(1)).min(1),
    branch: z.string().min(1),
    parentSha: gitShaSchema,
    commitSha: gitShaSchema,
    status: z.enum(["pending", "published", "failed", "invalidated"]),
    attempts: z.number().int().nonnegative(),
    error: z.string().min(1).nullable(),
    supersedes: digestSchema.nullable(),
    createdAt: timestampSchema,
    publishedAt: timestampSchema.nullable()
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
    choice: agentIdSchema.optional(),
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
    derived: derivedStateSchema,
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
    /** Accepted private ballot judgments, kept apart from Git submissions. */
    responses: z.array(acceptedResponseSchema),
    /** Append-only publication history, including superseded and failed batches. */
    ballotBatches: z.array(ballotBatchSchema),
    /** The coordinator-owned evidence branch and its last published tip. */
    evidence: z
      .object({
        branch: z.string().min(1).nullable(),
        tip: gitShaSchema.nullable()
      })
      .strict(),
    updatedAt: timestampSchema
  })
  .strict();

/**
 * A journal *event*, as opposed to a journal *file*.
 *
 * `formatVersion` is deliberately not pinned to a literal here. Format gating
 * belongs to `assertRuntimeFormat`, which every read of a journal file goes
 * through and which is what produces the wipe-and-restart remediation; pinning
 * the literal a second time in this schema adds no protection — a rejected
 * format never reaches the parse — while making a single historical event
 * object unreadable outside that gate. `appendJournal` always stamps
 * `RUNTIME_FORMAT_VERSION`, so nothing this build writes can carry another one.
 */
export const journalEventSchema = z
  .object({
    formatVersion: z.number().int().positive(),
    sequence: z.number().int().nonnegative(),
    at: timestampSchema,
    type: z.enum([
      "started",
      "action-prepared",
      "nudged",
      "agent-lifecycle",
      "agent-usage",
      "agent-observability-degraded",
      "agent-observability-recovered",
      "nudge-deferred",
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
      "pr-merged",
      "decision-derived",
      "response-accepted",
      "response-rejected",
      "ballot-batch-pending",
      "ballot-batch-published",
      "ballot-batch-failed",
      "ballot-batch-invalidated"
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
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;
export type BallotBatch = z.infer<typeof ballotBatchSchema>;
export type BallotBatchKind = z.infer<typeof ballotBatchKindSchema>;
export type GitSubmissionCitation = z.infer<typeof gitSubmissionCitationSchema>;
export type ResponseCitation = z.infer<typeof responseCitationSchema>;
export type DerivedInputKind = z.infer<typeof derivedInputKindSchema>;
export type DerivedInputCitation = z.infer<typeof derivedInputCitationSchema>;
export type PlanSelectionDerived = z.infer<typeof planSelectionDerivedSchema>;
export type ImplementationSelectionDerived = z.infer<typeof implementationSelectionDerivedSchema>;
export type ConsensusDerived = z.infer<typeof consensusDerivedSchema>;
export type DerivedState = z.infer<typeof derivedStateSchema>;
export type CursorsState = z.infer<typeof cursorsStateSchema>;
export type JournalEvent = z.infer<typeof journalEventSchema>;

/**
 * A Zod `.default()` is only optional on the *input* side; `z.infer` reports the
 * parsed output, where the field is present. Omitting `contextPaths` here and
 * re-adding it as optional keeps every existing typed initializer compiling —
 * a defaulted field must not become a required constructor argument.
 */
export type StartStateInput = Omit<
  StartState,
  "formatVersion" | "createdAt" | "contextPaths" | "completesRoot"
> & {
  createdAt?: string;
  contextPaths?: readonly string[];
  /**
   * Omitted by callers: it is taken from the `IssueRuntimePaths` the state is
   * written with, so `start.json` cannot record a mailbox other than the one
   * the coordinator is actually using for this issue.
   */
  completesRoot?: string;
};

const assertRuntimeFormat = (path: string, value: unknown): void => {
  if (typeof value !== "object" || value === null || !("formatVersion" in value)) return;
  const formatVersion = (value as { formatVersion: unknown }).formatVersion;
  if (
    typeof formatVersion === "number" &&
    (UNSUPPORTED_RUNTIME_FORMAT_VERSIONS as readonly number[]).includes(formatVersion)
  ) {
    throw new Error(`Invalid ${path}: ${runtimeFormatWipeMessage(formatVersion)}`);
  }
};

const parseFile = <T>(path: string, schema: z.ZodType<T>): T => {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertRuntimeFormat(path, value);
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
      submissionMode: null,
      actionDigest: null,
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
    derived: { planSelection: null, implementationSelection: null, consensus: null },
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
    responses: [],
    ballotBatches: [],
    evidence: { branch: evidenceBranchFor(start.branchTemplate, start.issue), tip: null },
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
  const start = startStateSchema.parse({
    ...input,
    formatVersion: RUNTIME_FORMAT_VERSION,
    completesRoot: input.completesRoot ?? paths.completesRoot,
    createdAt: input.createdAt ?? now
  });
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
    assertRuntimeFormat(`journal line ${index + 1}`, value);
    return journalEventSchema.parse(value);
  });
};

/** Read only the final journal record; append cost must not grow with issue age. */
const nextJournalSequence = (path: string): number => {
  if (!existsSync(path)) return 0;
  const handle = openSync(path, "r");
  try {
    let position = fstatSync(handle).size;
    if (position === 0) return 0;
    let suffix = Buffer.alloc(0);
    while (position > 0) {
      const start = Math.max(0, position - 4096);
      const chunk = Buffer.alloc(position - start);
      readSync(handle, chunk, 0, chunk.length, start);
      suffix = Buffer.concat([chunk, suffix]);
      position = start;
      const text = suffix.toString("utf8").replace(/\n+$/, "");
      const boundary = text.lastIndexOf("\n");
      if (boundary < 0 && position > 0) continue;
      const line = text.slice(boundary + 1);
      if (line === "") return 0;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line) as unknown;
      } catch (error) {
        throw new Error(`Invalid final journal line: ${error instanceof Error ? error.message : String(error)}`);
      }
      return journalEventSchema.parse(parsed).sequence + 1;
    }
    return 0;
  } finally {
    closeSync(handle);
  }
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
    // A derived decision is content-addressed.  The journal is written before
    // cursor replacement, so a process can die after the durable append but
    // before the state file is renamed.  Reusing the event by identity makes
    // that retry exact-once and also preserves its original decidedAt value.
    if (input.type === "decision-derived" && typeof input.details.decisionId === "string") {
      const existing = readJournal(paths).find(
        (event) =>
          event.type === "decision-derived" &&
          event.details.decisionId === input.details.decisionId
      );
      if (existing !== undefined) return existing;
    }
    const event = journalEventSchema.parse({
      ...input,
      formatVersion: RUNTIME_FORMAT_VERSION,
      sequence: nextJournalSequence(paths.journal),
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

export const acquireExclusiveLock = (lockPath: string): number => {
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

/**
 * Every decision identity includes the ordered active roster, so any drop
 * invalidates all decisions that have already been derived.  The owner drop
 * path immediately recomputes the slots whose prerequisites are still
 * complete and journals their supersession; this lower-level helper fails
 * closed for callers that cannot do that recomputation themselves.
 */
export const invalidateDerivedForDrop = (derived: DerivedState, agent: string): DerivedState => {
  void derived;
  void agent;
  return { planSelection: null, implementationSelection: null, consensus: null };
};

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
    derived: invalidateDerivedForDrop(cursors.derived, agent),
    agents: {
      ...cursors.agents,
      [agent]: { ...current, status: "dropped", actionId: null, submissionSha: null, outstanding: [], updatedAt: now }
    },
    accepted: cursors.accepted.filter(
      (submission) => submission.agent !== agent || submission.stepId !== cursors.issueCursor.stepId
    ),
    // Same rule as `accepted`: a dropped agent leaves the denominator, so its
    // judgment at the step in flight must leave with it. Judgments it already
    // contributed to a *closed* step stay, because those are already published.
    responses: cursors.responses.filter(
      (response) => response.agent !== agent || response.stepId !== cursors.issueCursor.stepId
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
