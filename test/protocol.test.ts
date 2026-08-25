import { describe, expect, it } from "vitest";
import {
  implementationReadyArtifactSchema,
  participationReadyArtifactSchema,
  parseJsonWithSchema,
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

  it("rejects the three artifacts issue 109 replaced with coordinator decisions", () => {
    // The union is the only gate on what an agent may publish. If any of these
    // discriminators still parsed, an agent could push a selection, reviser
    // authorization, or consensus declaration and have it accepted as evidence
    // for a result the coordinator now owns.
    const removed = [
      {
        ...common,
        artifact: "selection",
        inputSetHash: "c".repeat(64),
        selectedAgents: ["codex"],
        ballots: [{ agent: "codex", commitSha: "d".repeat(40), path: ".plans/issue-1/ballot-codex.json" }]
      },
      {
        ...common,
        artifact: "reviser-authorization",
        inputSetHash: "c".repeat(64),
        reviser: "codex",
        implementationCommitSha: "d".repeat(40)
      },
      {
        ...common,
        artifact: "consensus-declaration",
        inputSetHash: "c".repeat(64),
        round: 1,
        consensusCommitSha: "d".repeat(40),
        ballots: [{ agent: "codex", commitSha: "e".repeat(40), path: ".code-reviews/issue-1/consensus-ballot-codex-round-1.json" }]
      }
    ];
    for (const artifact of removed) {
      expect(publishedArtifactSchema.safeParse(artifact).success).toBe(false);
    }
  });

  it("still accepts every artifact that remains agent-authored", () => {
    const supported = [
      { ...common, artifact: "participation-ready", baselineSha: "a".repeat(40), automationDigest: "b".repeat(64) },
      {
        ...common,
        artifact: "plan-ballot",
        inputSetHash: "c".repeat(64),
        plans: [{ agent: "codex", commitSha: "d".repeat(40), path: ".plans/issue-1/plan.md" }],
        reviews: [],
        choice: "codex",
        rationale: "clearest file map"
      },
      {
        ...common,
        artifact: "implementation-ready",
        inputSetHash: "c".repeat(64),
        implementationCommitSha: "d".repeat(40),
        approvedPaths: ["src/machine.ts"]
      },
      {
        ...common,
        artifact: "comparison-ballot",
        inputSetHash: "c".repeat(64),
        implementations: [{ agent: "codex", commitSha: "d".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json" }],
        choice: "codex",
        rationale: "smaller diff"
      },
      {
        ...common,
        artifact: "revision-ready",
        inputSetHash: "c".repeat(64),
        round: 1,
        revisedBranchHead: "d".repeat(40),
        basedOn: ["e".repeat(40)]
      },
      {
        ...common,
        artifact: "consensus-ballot",
        inputSetHash: "c".repeat(64),
        round: 1,
        revisionCommitSha: "d".repeat(40),
        disposition: "approve",
        rationale: "checks pass"
      },
      {
        ...common,
        artifact: "finalization",
        consensusSha: "d".repeat(40),
        finalSha: "e".repeat(40),
        checks: [{ argv: ["pnpm", "check"], exitCode: 0 }]
      }
    ];
    for (const artifact of supported) {
      expect(publishedArtifactSchema.safeParse(artifact).success).toBe(true);
      expect(publishedArtifactSchema.safeParse({ ...artifact, surprise: true }).success).toBe(false);
    }
  });

  it("reports JSON and schema errors without returning unchecked values", () => {
    expect(parseJsonWithSchema("{", participationReadyArtifactSchema)).toMatchObject({ ok: false });
    expect(parseJsonWithSchema(JSON.stringify({ nope: true }), participationReadyArtifactSchema)).toMatchObject({ ok: false });
  });
});
