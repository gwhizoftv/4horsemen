import { describe, expect, it } from "vitest";
import {
  RATIONALE_MAX_LENGTH,
  consensusResponseSchema,
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  parseJsonWithSchema,
  planBallotArtifactSchema,
  planComparisonResponseSchema,
  publishedArtifactSchema,
  revisionReadyArtifactSchema
} from "../src/protocol.js";

const common = {
  protocolVersion: 1 as const,
  issue: 1,
  issueSessionId: `issue-1:${"a".repeat(40)}`,
  agent: "codex"
};

describe("published protocol schemas", () => {
  it("accepts a strict participation-readiness artifact and rejects unknown or stale shapes", () => {
    const join = {
      ...common,
      artifact: "participation-ready" as const,
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64)
    };
    expect(participationReadyArtifactSchema.parse(join)).toEqual(join);
    expect(participationReadyArtifactSchema.safeParse({ ...join, surprise: true }).success).toBe(false);
    expect(participationReadyArtifactSchema.safeParse({ ...join, baselineSha: "ABC" }).success).toBe(false);
    expect(participationReadyArtifactSchema.safeParse({ ...join, artifact: "join" }).success).toBe(false);
  });

  it("validates implementation pins and approved repository paths", () => {
    const parsed = implementationReadyArtifactSchema.safeParse({
      ...common,
      artifact: "implementation-ready",
      inputSetHash: "c".repeat(64),
      implementationCommitSha: "d".repeat(40),
      approvedPaths: ["src/machine.ts", "test/machine.test.ts"]
    });
    expect(parsed.success).toBe(true);
    expect(
      implementationReadyArtifactSchema.safeParse({
        ...common,
        artifact: "implementation-ready",
        inputSetHash: "c".repeat(64),
        implementationCommitSha: "d".repeat(40),
        approvedPaths: ["../escape"]
      }).success
    ).toBe(false);
  });

  it("binds revision rounds and based-on pins", () => {
    expect(
      revisionReadyArtifactSchema.safeParse({
        ...common,
        artifact: "revision-ready",
        inputSetHash: "c".repeat(64),
        round: 0,
        revisedBranchHead: "d".repeat(40),
        basedOn: ["e".repeat(40)]
      }).success
    ).toBe(false);
  });

  it("reports JSON and schema errors without returning unchecked values", () => {
    expect(parseJsonWithSchema("{", participationReadyArtifactSchema)).toMatchObject({ ok: false });
    expect(parseJsonWithSchema(JSON.stringify({ nope: true }), participationReadyArtifactSchema)).toMatchObject({ ok: false });
  });

  it("rejects the removed coordinator-derived artifact discriminators", () => {
    for (const artifact of ["selection", "reviser-authorization", "consensus-declaration"]) {
      expect(publishedArtifactSchema.safeParse({ ...common, artifact }).success).toBe(false);
    }
  });
});

describe("private ballot response schemas", () => {
  const ACTION_ID = "179da8c7-ae22-47eb-b6eb-211ceea6b732";

  it("accepts exactly the three fields an agent authors", () => {
    expect(
      planComparisonResponseSchema.safeParse({ actionId: ACTION_ID, choice: "codex", rationale: "clear" }).success
    ).toBe(true);
    expect(
      consensusResponseSchema.safeParse({ actionId: ACTION_ID, disposition: "escalate", rationale: "blocked" })
        .success
    ).toBe(true);
  });

  it("refuses a missing field, a wrong-kind field, and any extra key", () => {
    expect(planComparisonResponseSchema.safeParse({ actionId: ACTION_ID, rationale: "x" }).success).toBe(false);
    expect(planComparisonResponseSchema.safeParse({ choice: "codex", rationale: "x" }).success).toBe(false);
    // A disposition cannot answer a plan ballot, and a choice cannot answer a
    // consensus ballot: the two schemas are not interchangeable.
    expect(
      planComparisonResponseSchema.safeParse({ actionId: ACTION_ID, disposition: "approve", rationale: "x" }).success
    ).toBe(false);
    expect(
      consensusResponseSchema.safeParse({ actionId: ACTION_ID, choice: "codex", rationale: "x" }).success
    ).toBe(false);
    expect(
      consensusResponseSchema.safeParse({ actionId: ACTION_ID, disposition: "yes", rationale: "x" }).success
    ).toBe(false);
    expect(
      planComparisonResponseSchema.safeParse({
        actionId: ACTION_ID,
        choice: "codex",
        rationale: "x",
        issue: 1
      }).success
    ).toBe(false);
  });

  it("bounds the rationale and refuses a blank one", () => {
    const of = (rationale: string) =>
      planComparisonResponseSchema.safeParse({ actionId: ACTION_ID, choice: "codex", rationale }).success;
    expect(of("x")).toBe(true);
    expect(of("x".repeat(RATIONALE_MAX_LENGTH))).toBe(true);
    // Both bounds matter: the rationale is copied into an append-only journal
    // and into a Git tree, so it is durable in two places at once.
    expect(of("x".repeat(RATIONALE_MAX_LENGTH + 1))).toBe(false);
    expect(of("")).toBe(false);
    expect(of("   \n  ")).toBe(false);
  });

  it("requires an opaque action id rather than any string", () => {
    for (const actionId of ["", "1", "not-a-uuid", "179da8c7ae2247ebb6eb211ceea6b732"]) {
      expect(planComparisonResponseSchema.safeParse({ actionId, choice: "c", rationale: "x" }).success).toBe(false);
    }
  });

  it("versions coordinator-published ballots apart from agent-authored artifacts", () => {
    const ballot = {
      protocolVersion: 2,
      issue: 1,
      issueSessionId: `issue-1:${"a".repeat(40)}`,
      agent: "codex",
      actionId: ACTION_ID,
      responseSha256: "c".repeat(64),
      artifact: "plan-ballot",
      inputSetHash: "d".repeat(64),
      plans: [{ agent: "claude", commitSha: "1".repeat(40), path: ".plans/issue-1/plan.md" }],
      reviews: [],
      choice: "claude",
      rationale: "clear"
    };
    expect(planBallotArtifactSchema.safeParse(ballot).success).toBe(true);
    // Version 1 was an agent-authored, agent-pushed ballot with no provenance
    // pair. Keeping the discriminator honest is what lets a reader tell them
    // apart instead of getting a missing-field error pointing at the wrong thing.
    expect(planBallotArtifactSchema.safeParse({ ...ballot, protocolVersion: 1 }).success).toBe(false);
    for (const field of ["actionId", "responseSha256"] as const) {
      const without: Record<string, unknown> = { ...ballot };
      delete without[field];
      expect(planBallotArtifactSchema.safeParse(without).success).toBe(false);
    }
    // A participation artifact stays at version 1: only ballots changed author.
    expect(
      participationReadyArtifactSchema.safeParse({
        protocolVersion: 1,
        issue: 1,
        issueSessionId: `issue-1:${"a".repeat(40)}`,
        agent: "codex",
        artifact: "participation-ready",
        baselineSha: "a".repeat(40),
        automationDigest: "b".repeat(64)
      }).success
    ).toBe(true);
  });
});
