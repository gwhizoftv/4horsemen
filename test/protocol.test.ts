import { describe, expect, it } from "vitest";
import {
  comparisonBallotArtifactSchema,
  planAmendmentRequestSchema,
  consensusBallotResponseSchema,
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  parseJsonWithSchema,
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
  it("accepts only bounded exact additive request paths with nonblank reasons", () => {
    const request = { ...common, artifact: "plan-amendment-request", actionId, inputSetHash: digest,
      scopeHash: digest, rationale: "The original behavior needs its regression test.",
      additionalPaths: [{ path: "test/product.test.ts", reason: "Existing assertion needs updating." }] };
    expect(planAmendmentRequestSchema.parse(request)).toEqual(request);
    for (const path of ["/test/a.ts", "../a.ts", "test/./a.ts", "test//a.ts", "test/", "test/**", "test/{a,b}.ts", ".git/config", ".plans/issue-1/plan.md"]) {
      expect(planAmendmentRequestSchema.safeParse({ ...request, additionalPaths: [{ path, reason: "needed" }] }).success, path).toBe(false);
    }
    for (const patch of [{ rationale: " " }, { additionalPaths: [] },
      { additionalPaths: [...request.additionalPaths, ...request.additionalPaths] },
      { additionalPaths: [{ path: "test/a.ts", reason: " " }] }, { surprise: true }]) {
      expect(planAmendmentRequestSchema.safeParse({ ...request, ...patch }).success).toBe(false);
    }
  });
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
