import { z } from "zod";

const sha40 = z.string().regex(/^[a-f0-9]{40}$/);
const issueSessionId = z.string().regex(/^issue-\d+:[a-f0-9]{40}$/);

export const JoinSchema = z.object({
  type: z.literal("join"),
  issueSessionId,
  agent: z.string().min(1),
  baselineSha: sha40,
  automationDigest: z.string().min(1),
  automationDigestScheme: z.string().min(1),
  createdAt: z.string().datetime(),
});
export type Join = z.infer<typeof JoinSchema>;

export const PlanBallotSchema = z.object({
  type: z.literal("plan-ballot"),
  issueSessionId,
  agent: z.string().min(1),
  inputSetHash: z.string().min(1),
  planCommits: z.record(z.string(), sha40),
  reviewCommits: z.record(z.string(), sha40),
  disposition: z.enum(["approve", "revise", "escalate"]),
  createdAt: z.string().datetime(),
});
export type PlanBallot = z.infer<typeof PlanBallotSchema>;

export const ImplementationReadySchema = z.object({
  type: z.literal("implementation-ready"),
  issueSessionId,
  agent: z.string().min(1),
  implementationCommitSha: sha40,
  baselineSha: sha40,
  fileMap: z.array(z.string()),
  createdAt: z.string().datetime(),
});
export type ImplementationReady = z.infer<typeof ImplementationReadySchema>;

export const ComparisonBallotSchema = z.object({
  type: z.literal("comparison-ballot"),
  issueSessionId,
  agent: z.string().min(1),
  inputSetHash: z.string().min(1),
  implementationPins: z.record(z.string(), sha40),
  disposition: z.enum(["approve", "revise", "escalate"]),
  createdAt: z.string().datetime(),
});
export type ComparisonBallot = z.infer<typeof ComparisonBallotSchema>;

export const RevisionReadySchema = z.object({
  type: z.literal("revision-ready"),
  issueSessionId,
  agent: z.string().min(1),
  round: z.number().int().min(1),
  revisedBranchHead: sha40,
  baselineSha: sha40,
  createdAt: z.string().datetime(),
});
export type RevisionReady = z.infer<typeof RevisionReadySchema>;

export const ConsensusBallotSchema = z.object({
  type: z.literal("consensus-ballot"),
  issueSessionId,
  agent: z.string().min(1),
  revisionPin: sha40,
  round: z.number().int().min(1),
  disposition: z.enum(["approve", "revise", "escalate"]),
  createdAt: z.string().datetime(),
});
export type ConsensusBallot = z.infer<typeof ConsensusBallotSchema>;

export const ConsensusDeclarationSchema = z.object({
  type: z.literal("consensus-declaration"),
  issueSessionId,
  approvedSha: sha40,
  round: z.number().int().min(1),
  voters: z.record(z.string(), z.enum(["approve", "revise", "escalate"])),
  createdAt: z.string().datetime(),
});
export type ConsensusDeclaration = z.infer<typeof ConsensusDeclarationSchema>;

export function parseArtifact<T>(schema: z.ZodType<T>, raw: string): { ok: true; value: T } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }
  const result = schema.safeParse(parsed);
  if (result.success) {
    return { ok: true, value: result.data };
  }
  return { ok: false, error: result.error.message };
}
