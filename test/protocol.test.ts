import { describe, expect, it } from "vitest";
import {
  comparisonBallotArtifactSchema,
  consensusBallotResponseSchema,
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  parseJsonWithSchema,
  planAmendmentBallotArtifactSchema,
  planAmendmentBallotResponseSchema,
  planAmendmentRequestArtifactSchema,
  planBallotArtifactSchema,
  planComparisonBallotResponseSchema,
  publishedArtifactSchema,
  revisionReadyArtifactSchema
} from "../src/protocol.js";

const common = {
  protocolVersion: 1 as const,
  issue: 1,
  issueSessionId: `issue-1:${"a".repeat(40)}`,
  agent: "codex"
};

const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
const digest = "c".repeat(64);

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

  it("accepts private ballot responses and rejects envelope fields", () => {
    expect(
      planComparisonBallotResponseSchema.safeParse({
        actionId,
        choice: "claude",
        rationale: "Prefer this plan."
      }).success
    ).toBe(true);
    expect(
      planComparisonBallotResponseSchema.safeParse({
        actionId,
        choice: "claude",
        rationale: "Prefer this plan.",
        agent: "codex"
      }).success
    ).toBe(false);
    expect(
      consensusBallotResponseSchema.safeParse({
        actionId,
        disposition: "revise",
        rationale: "Needs another pass."
      }).success
    ).toBe(true);
  });

  it("validates plan-amendment request and ballot contracts", () => {
    const request = {
      ...common,
      artifact: "plan-amendment-request" as const,
      actionId,
      inputSetHash: digest,
      scopeHash: digest,
      explanation: "The plan omitted the test file.",
      additionalPaths: [{ path: "test/product.test.ts", reason: "covers the new behavior" }]
    };
    expect(planAmendmentRequestArtifactSchema.parse(request)).toEqual(request);
    expect(
      planAmendmentRequestArtifactSchema.safeParse({
        ...request,
        additionalPaths: [{ path: "../escape.ts", reason: "traversal" }]
      }).success
    ).toBe(false);
    expect(
      planAmendmentBallotResponseSchema.safeParse({
        actionId,
        disposition: "approve",
        rationale: "Necessary addition."
      }).success
    ).toBe(true);
    expect(
      planAmendmentBallotResponseSchema.safeParse({
        actionId,
        disposition: "escalate",
        rationale: "nope"
      }).success
    ).toBe(false);
    expect(
      planAmendmentBallotArtifactSchema.safeParse({
        protocolVersion: 2,
        issue: 1,
        issueSessionId: common.issueSessionId,
        agent: "codex",
        inputSetHash: digest,
        actionId,
        responseSha256: digest,
        rationale: "Necessary addition.",
        artifact: "plan-amendment-ballot",
        sequence: 1,
        request: { agent: "cursor", commitSha: "a".repeat(40), path: ".signals/issue-1/implementation-ready-cursor.json" },
        selectedPlans: [{ agent: "codex", commitSha: "b".repeat(40), path: ".plans/issue-1/plan.md" }],
        disposition: "approve"
      }).success
    ).toBe(true);
  });

  it("requires protocol v2 provenance on published ballot artifacts", () => {
    const plan = {
      protocolVersion: 2 as const,
      issue: 1,
      issueSessionId: common.issueSessionId,
      agent: "codex",
      inputSetHash: digest,
      actionId,
      responseSha256: digest,
      rationale: "Prefer this plan.",
      artifact: "plan-ballot" as const,
      plans: [{ agent: "claude", commitSha: "a".repeat(40), path: ".plans/issue-1/plan.md" }],
      reviews: [],
      choice: "claude"
    };
    expect(planBallotArtifactSchema.parse(plan)).toEqual(plan);
    expect(planBallotArtifactSchema.safeParse({ ...plan, protocolVersion: 1 }).success).toBe(false);
    expect(
      comparisonBallotArtifactSchema.safeParse({
        ...plan,
        artifact: "comparison-ballot",
        implementations: [{ agent: "claude", commitSha: "a".repeat(40), path: ".signals/x.json" }],
        plans: undefined,
        reviews: undefined
      }).success
    ).toBe(false);
  });
});
