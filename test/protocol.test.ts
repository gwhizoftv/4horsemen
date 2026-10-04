import { describe, expect, it } from "vitest";
import {
  amendmentBallotArtifactSchema,
  amendmentBallotResponseSchema,
  comparisonBallotArtifactSchema,
  consensusBallotResponseSchema,
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  parseJsonWithSchema,
  planAmendmentRequestSchema,
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

  it("validates plan amendment requests with strict path and rationale rules", () => {
    const validRequest = {
      ...common,
      artifact: "plan-amendment-request" as const,
      actionId,
      inputSetHash: digest,
      scopeHash: digest,
      explanation: "Need to add missing helper file to complete test suite.",
      additionalPaths: [
        { path: "src/helper.ts", reason: "Shared utility for test setup" }
      ]
    };
    expect(planAmendmentRequestSchema.safeParse(validRequest).success).toBe(true);

    // Rejects empty additionalPaths
    expect(
      planAmendmentRequestSchema.safeParse({ ...validRequest, additionalPaths: [] }).success
    ).toBe(false);

    // Rejects blank explanation
    expect(
      planAmendmentRequestSchema.safeParse({ ...validRequest, explanation: "   " }).success
    ).toBe(false);

    // Rejects blank path reason
    expect(
      planAmendmentRequestSchema.safeParse({
        ...validRequest,
        additionalPaths: [{ path: "src/helper.ts", reason: "  " }]
      }).success
    ).toBe(false);

    // Rejects traversing / absolute paths
    expect(
      planAmendmentRequestSchema.safeParse({
        ...validRequest,
        additionalPaths: [{ path: "../src/helper.ts", reason: "escape" }]
      }).success
    ).toBe(false);
    expect(
      planAmendmentRequestSchema.safeParse({
        ...validRequest,
        additionalPaths: [{ path: "/etc/passwd", reason: "absolute" }]
      }).success
    ).toBe(false);

    // Rejects git and coordination artifact namespaces
    expect(
      planAmendmentRequestSchema.safeParse({
        ...validRequest,
        additionalPaths: [{ path: ".git/config", reason: "git" }]
      }).success
    ).toBe(false);
    expect(
      planAmendmentRequestSchema.safeParse({
        ...validRequest,
        additionalPaths: [{ path: ".plans/issue-1/other.json", reason: "coordination" }]
      }).success
    ).toBe(false);

    // Rejects duplicate paths
    expect(
      planAmendmentRequestSchema.safeParse({
        ...validRequest,
        additionalPaths: [
          { path: "src/helper.ts", reason: "reason 1" },
          { path: "src/helper.ts", reason: "reason 2" }
        ]
      }).success
    ).toBe(false);

    // Allows optional scopeHash on implementation-ready and revision-ready
    expect(
      implementationReadyArtifactSchema.safeParse({
        ...common,
        artifact: "implementation-ready",
        inputSetHash: digest,
        implementationCommitSha: "d".repeat(40),
        approvedPaths: ["src/a.ts"],
        scopeHash: digest
      }).success
    ).toBe(true);
    expect(
      revisionReadyArtifactSchema.safeParse({
        ...common,
        artifact: "revision-ready",
        inputSetHash: digest,
        round: 1,
        revisedBranchHead: "d".repeat(40),
        basedOn: ["e".repeat(40)],
        scopeHash: digest
      }).success
    ).toBe(true);
  });

  it("validates amendment ballot responses and published amendment ballot artifacts", () => {
    expect(
      amendmentBallotResponseSchema.safeParse({
        actionId,
        disposition: "approve",
        rationale: "LGTM to add test helper."
      }).success
    ).toBe(true);
    expect(
      amendmentBallotResponseSchema.safeParse({
        actionId,
        disposition: "revise",
        rationale: "Unnecessary addition."
      }).success
    ).toBe(true);
    expect(
      amendmentBallotResponseSchema.safeParse({
        actionId,
        disposition: "escalate",
        rationale: "Not allowed."
      }).success
    ).toBe(false);

    const published = {
      protocolVersion: 2 as const,
      issue: 1,
      issueSessionId: common.issueSessionId,
      agent: "codex",
      inputSetHash: digest,
      actionId,
      responseSha256: digest,
      rationale: "Approved additions.",
      artifact: "amendment-ballot" as const,
      sequence: 1,
      request: {
        agent: "claude",
        commitSha: "1".repeat(40),
        path: ".plans/issue-1/plan-amendment-request-claude.json"
      },
      plans: [{ agent: "claude", commitSha: "a".repeat(40), path: ".plans/issue-1/plan.md" }],
      disposition: "approve" as const
    };
    expect(amendmentBallotArtifactSchema.parse(published)).toEqual(published);
    expect(
      amendmentBallotArtifactSchema.safeParse({ ...published, artifact: "plan-ballot" }).success
    ).toBe(false);
  });
});
