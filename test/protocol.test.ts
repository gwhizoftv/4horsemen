import { describe, expect, it } from "vitest";
import {
  implementationReadyArtifactSchema,
  joinArtifactSchema,
  parseJsonWithSchema,
  revisionReadyArtifactSchema
} from "../src/protocol.js";

const common = {
  protocolVersion: 1 as const,
  issue: 1,
  issueSessionId: `issue-1:${"a".repeat(40)}`,
  agent: "codex"
};

describe("published protocol schemas", () => {
  it("accepts a strict join and rejects unknown or stale shapes", () => {
    const join = {
      ...common,
      artifact: "join" as const,
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64)
    };
    expect(joinArtifactSchema.parse(join)).toEqual(join);
    expect(joinArtifactSchema.safeParse({ ...join, surprise: true }).success).toBe(false);
    expect(joinArtifactSchema.safeParse({ ...join, baselineSha: "ABC" }).success).toBe(false);
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
    expect(parseJsonWithSchema("{", joinArtifactSchema)).toMatchObject({ ok: false });
    expect(parseJsonWithSchema(JSON.stringify({ nope: true }), joinArtifactSchema)).toMatchObject({ ok: false });
  });
});
