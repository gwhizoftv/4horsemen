import { describe, it, expect } from "vitest";
import {
  JoinSchema,
  PlanBallotSchema,
  ImplementationReadySchema,
  RevisionReadySchema,
  ConsensusBallotSchema,
  ConsensusDeclarationSchema,
  parseArtifact,
} from "../src/protocol.js";

const sha = "a".repeat(40);
const sessionId = "issue-1:" + sha;
const now = "2026-01-01T00:00:00Z";

describe("JoinSchema", () => {
  const valid = { type: "join", issueSessionId: sessionId, agent: "alice", baselineSha: sha, automationDigest: "d1", automationDigestScheme: "v3", createdAt: now };

  it("parses valid input", () => {
    expect(JoinSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing fields", () => {
    const incomplete = { ...valid };
    delete (incomplete as Record<string, unknown>)["agent"];
    expect(() => JoinSchema.parse(incomplete)).toThrow();
  });

  it("rejects invalid SHA", () => {
    expect(() => JoinSchema.parse({ ...valid, baselineSha: "nope" })).toThrow();
  });

  it("rejects invalid sessionId", () => {
    expect(() => JoinSchema.parse({ ...valid, issueSessionId: "bad" })).toThrow();
  });
});

describe("PlanBallotSchema", () => {
  const valid = { type: "plan-ballot", issueSessionId: sessionId, agent: "bob", inputSetHash: "h1", planCommits: { alice: sha }, reviewCommits: { bob: sha }, disposition: "approve", createdAt: now };

  it("parses valid input", () => {
    expect(PlanBallotSchema.parse(valid)).toEqual(valid);
  });

  it("rejects invalid disposition", () => {
    expect(() => PlanBallotSchema.parse({ ...valid, disposition: "reject" })).toThrow();
  });
});

describe("ImplementationReadySchema", () => {
  const valid = { type: "implementation-ready", issueSessionId: sessionId, agent: "alice", implementationCommitSha: sha, baselineSha: sha, fileMap: ["a.ts"], createdAt: now };

  it("parses valid input", () => {
    expect(ImplementationReadySchema.parse(valid)).toEqual(valid);
  });

  it("rejects non-SHA implementationCommitSha", () => {
    expect(() => ImplementationReadySchema.parse({ ...valid, implementationCommitSha: "short" })).toThrow();
  });
});

describe("RevisionReadySchema", () => {
  const valid = { type: "revision-ready", issueSessionId: sessionId, agent: "alice", round: 1, revisedBranchHead: sha, baselineSha: sha, createdAt: now };

  it("parses valid input", () => {
    expect(RevisionReadySchema.parse(valid)).toEqual(valid);
  });

  it("rejects round < 1", () => {
    expect(() => RevisionReadySchema.parse({ ...valid, round: 0 })).toThrow();
  });
});

describe("ConsensusBallotSchema", () => {
  const valid = { type: "consensus-ballot", issueSessionId: sessionId, agent: "alice", revisionPin: sha, round: 1, disposition: "approve", createdAt: now };

  it("parses valid input", () => {
    expect(ConsensusBallotSchema.parse(valid)).toEqual(valid);
  });
});

describe("ConsensusDeclarationSchema", () => {
  const valid = { type: "consensus-declaration", issueSessionId: sessionId, approvedSha: sha, round: 1, voters: { alice: "approve" }, createdAt: now };

  it("parses valid input", () => {
    expect(ConsensusDeclarationSchema.parse(valid)).toEqual(valid);
  });

  it("rejects missing voters field", () => {
    const incomplete = { ...valid };
    delete (incomplete as Record<string, unknown>)["voters"];
    expect(() => ConsensusDeclarationSchema.parse(incomplete)).toThrow();
  });
});

describe("parseArtifact", () => {
  it("returns ok for valid", () => {
    const result = parseArtifact(JoinSchema, JSON.stringify({ type: "join", issueSessionId: sessionId, agent: "a", baselineSha: sha, automationDigest: "d", automationDigestScheme: "v3", createdAt: now }));
    expect(result.ok).toBe(true);
  });

  it("returns error for invalid JSON", () => {
    const result = parseArtifact(JoinSchema, "{bad");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("Invalid JSON");
  });

  it("returns error for schema mismatch", () => {
    const result = parseArtifact(JoinSchema, JSON.stringify({ type: "wrong" }));
    expect(result.ok).toBe(false);
  });
});
