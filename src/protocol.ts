import { z } from "zod";

export const gitShaSchema = z.string().regex(/^[a-f0-9]{40}$/, "expected a lowercase 40-character Git SHA");
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 digest");
export const agentIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export const issueSchema = z.number().int().positive();
export const issueSessionIdSchema = z.string().min(1).max(256);
export const repositoryPathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "expected a safe repository-relative path");

export const artifactCitationSchema = z
  .object({
    agent: agentIdSchema,
    commitSha: gitShaSchema,
    path: repositoryPathSchema
  })
  .strict();

const commonArtifactFields = {
  protocolVersion: z.literal(1),
  issue: issueSchema,
  issueSessionId: issueSessionIdSchema,
  agent: agentIdSchema
} as const;

export const actionIdSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "expected an opaque action UUID"
  );

/**
 * The one free-text field an agent supplies. Bounded before anything is
 * journaled or committed: the journal is append-only and the rationale is
 * copied verbatim into a Git tree, so an unbounded string would be durable in
 * two places at once.
 */
export const RATIONALE_MAX_LENGTH = 1000;

export const rationaleSchema = z
  .string()
  .min(1)
  .max(RATIONALE_MAX_LENGTH)
  .refine((value) => value.trim() !== "", "rationale must not be blank");

/**
 * Canonical ballots are version 2 because they changed authorship, not merely
 * shape. A version-1 ballot is a file an agent wrote and pushed to its own
 * branch; a version-2 ballot is one the coordinator wrote from an accepted
 * private response, and it carries `actionId` and `responseSha256` to say which
 * handoff it came from. Two incompatible strict shapes sharing one version
 * literal would make an old ballot fail the new parse with a missing-field
 * error that points at the wrong thing.
 */
const canonicalBallotFields = {
  protocolVersion: z.literal(2),
  issue: issueSchema,
  issueSessionId: issueSessionIdSchema,
  agent: agentIdSchema,
  actionId: actionIdSchema,
  responseSha256: digestSchema
} as const;

export const dispositionSchema = z.enum(["approve", "revise", "escalate"]);

/**
 * The private ballot responses.
 *
 * Strict by construction, and deliberately tiny: an agent supplies its judgment
 * and the action it is answering, nothing else. Every binding — issue, session,
 * agent identity, citations, round, eligible choices, input-set hash, protocol
 * version — is filled by the coordinator from trusted state, so none of them
 * appear here and any attempt to supply one is a parse error.
 */
export const planComparisonResponseSchema = z
  .object({
    actionId: actionIdSchema,
    choice: agentIdSchema,
    rationale: rationaleSchema
  })
  .strict();

export const consensusResponseSchema = z
  .object({
    actionId: actionIdSchema,
    disposition: dispositionSchema,
    rationale: rationaleSchema
  })
  .strict();

export type PlanComparisonResponse = z.infer<typeof planComparisonResponseSchema>;
export type ConsensusResponse = z.infer<typeof consensusResponseSchema>;
export type BallotResponse = PlanComparisonResponse | ConsensusResponse;

export const participationReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("participation-ready"),
    baselineSha: gitShaSchema,
    automationDigest: digestSchema
  })
  .strict();

export const planBallotArtifactSchema = z
  .object({
    ...canonicalBallotFields,
    artifact: z.literal("plan-ballot"),
    inputSetHash: digestSchema,
    plans: z.array(artifactCitationSchema).min(1),
    reviews: z.array(artifactCitationSchema),
    choice: agentIdSchema,
    rationale: rationaleSchema
  })
  .strict();

export const implementationReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("implementation-ready"),
    inputSetHash: digestSchema,
    implementationCommitSha: gitShaSchema,
    approvedPaths: z.array(repositoryPathSchema).min(1)
  })
  .strict();

export const comparisonBallotArtifactSchema = z
  .object({
    ...canonicalBallotFields,
    artifact: z.literal("comparison-ballot"),
    inputSetHash: digestSchema,
    implementations: z.array(artifactCitationSchema).min(1),
    choice: agentIdSchema,
    rationale: rationaleSchema
  })
  .strict();

export const revisionReadyArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("revision-ready"),
    inputSetHash: digestSchema,
    round: z.number().int().min(1),
    revisedBranchHead: gitShaSchema,
    basedOn: z.array(gitShaSchema).min(1)
  })
  .strict();

export const consensusBallotArtifactSchema = z
  .object({
    ...canonicalBallotFields,
    artifact: z.literal("consensus-ballot"),
    inputSetHash: digestSchema,
    round: z.number().int().min(1),
    revisionCommitSha: gitShaSchema,
    disposition: dispositionSchema,
    rationale: rationaleSchema
  })
  .strict();

export const finalizationArtifactSchema = z
  .object({
    ...commonArtifactFields,
    artifact: z.literal("finalization"),
    consensusSha: gitShaSchema,
    finalSha: gitShaSchema,
    checks: z.array(
      z
        .object({
          argv: z.array(z.string().min(1)).min(1),
          exitCode: z.number().int()
        })
        .strict()
    )
  })
  .strict();

export const publishedArtifactSchema = z.discriminatedUnion("artifact", [
  participationReadyArtifactSchema,
  planBallotArtifactSchema,
  implementationReadyArtifactSchema,
  comparisonBallotArtifactSchema,
  revisionReadyArtifactSchema,
  consensusBallotArtifactSchema,
  finalizationArtifactSchema
]);

export type ParticipationReadyArtifact = z.infer<typeof participationReadyArtifactSchema>;
export type PlanBallotArtifact = z.infer<typeof planBallotArtifactSchema>;
export type ImplementationReadyArtifact = z.infer<typeof implementationReadyArtifactSchema>;
export type ComparisonBallotArtifact = z.infer<typeof comparisonBallotArtifactSchema>;
export type RevisionReadyArtifact = z.infer<typeof revisionReadyArtifactSchema>;
export type ConsensusBallotArtifact = z.infer<typeof consensusBallotArtifactSchema>;
export type FinalizationArtifact = z.infer<typeof finalizationArtifactSchema>;
export type PublishedArtifact = z.infer<typeof publishedArtifactSchema>;

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const parseJsonWithSchema = <T>(raw: string, schema: z.ZodType<T>): JsonResult<T> => {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: z.prettifyError(parsed.error) };
  }
  return { ok: true, value: parsed.data };
};

export const validateCommonArtifactFields = (
  artifact: { issue: number; issueSessionId: string; agent: string },
  expected: { issue: number; issueSessionId: string; agent: string }
): string[] => {
  const outstanding: string[] = [];
  if (artifact.issue !== expected.issue) outstanding.push(`artifact issue must be ${expected.issue}`);
  if (artifact.issueSessionId !== expected.issueSessionId) outstanding.push("artifact issueSessionId is stale or incorrect");
  if (artifact.agent !== expected.agent) outstanding.push(`artifact agent must be ${expected.agent}`);
  return outstanding;
};
