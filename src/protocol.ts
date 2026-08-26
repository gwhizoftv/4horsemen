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
    ...commonArtifactFields,
    artifact: z.literal("plan-ballot"),
    inputSetHash: digestSchema,
    plans: z.array(artifactCitationSchema).min(1),
    reviews: z.array(artifactCitationSchema),
    choice: agentIdSchema,
    rationale: z.string().min(1)
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
    ...commonArtifactFields,
    artifact: z.literal("comparison-ballot"),
    inputSetHash: digestSchema,
    implementations: z.array(artifactCitationSchema).min(1),
    choice: agentIdSchema,
    rationale: z.string().min(1)
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
    ...commonArtifactFields,
    artifact: z.literal("consensus-ballot"),
    inputSetHash: digestSchema,
    round: z.number().int().min(1),
    revisionCommitSha: gitShaSchema,
    disposition: z.enum(["approve", "revise", "escalate"]),
    rationale: z.string().min(1)
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
