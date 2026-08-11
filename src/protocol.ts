import { z } from "zod";

export const CitationSchema = z.object({
  agent: z.string(),
  digest: z.string().optional(),
});

export const ArtifactEnvelope = z.object({
  issue: z.number().int().positive(),
  agent: z.string(),
  session: z.string().optional(),
  citations: z.array(CitationSchema).optional(),
});

export const JoinSchema = ArtifactEnvelope.extend({
  type: z.literal("join"),
  roster: z.array(z.string()),
});

export const PlanSchema = ArtifactEnvelope.extend({
  type: z.literal("plan"),
  content: z.string(),
});

export const BallotSchema = ArtifactEnvelope.extend({
  type: z.literal("ballot"),
  choice: z.string(),
});

export const ImplementationSchema = ArtifactEnvelope.extend({
  type: z.literal("implementation"),
  content: z.string().optional(),
  commit: z.string().optional(),
});

export const ComparisonSchema = ArtifactEnvelope.extend({
  type: z.literal("comparison"),
  content: z.string(),
});

export const RevisionSchema = ArtifactEnvelope.extend({
  type: z.literal("revision"),
  content: z.string(),
});

export const ConsensusSchema = ArtifactEnvelope.extend({
  type: z.literal("consensus"),
  implementationCommit: z.string(),
});

export const FinalizationSchema = ArtifactEnvelope.extend({
  type: z.literal("finalization"),
  finalCommit: z.string(),
});

export const AnyArtifactSchema = z.discriminatedUnion("type", [
  JoinSchema,
  PlanSchema,
  BallotSchema,
  ImplementationSchema,
  ComparisonSchema,
  RevisionSchema,
  ConsensusSchema,
  FinalizationSchema
]);

export type AnyArtifact = z.infer<typeof AnyArtifactSchema>;
