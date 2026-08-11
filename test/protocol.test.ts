import { describe, expect, it } from "vitest";

import {
  computeInputSetHash,
  consensusBallotSchema,
  implementationReadySchema,
  joinSignalSchema,
  markdownHeadings,
  missingSections,
  nonEmptySections,
  parseJsonArtifact,
  planBallotSchema,
  revisionReadySchema
} from "../src/protocol.js";

const sha = (fill: string): string => fill.repeat(40).slice(0, 40);
const digest = (fill: string): string => fill.repeat(64).slice(0, 64);

const validJoin = {
  issue: 1,
  issueSessionId: `issue-1:${sha("a")}`,
  agent: "claude",
  createdAt: "2026-08-11T01:00:00Z",
  baselineSha: sha("a"),
  automationDigest: digest("b"),
  automationDigestScheme: "v3"
};

describe("joinSignalSchema", () => {
  it("accepts a well-formed join", () => {
    expect(joinSignalSchema.safeParse(validJoin).success).toBe(true);
  });

  it("rejects an unknown key", () => {
    const result = joinSignalSchema.safeParse({ ...validJoin, extra: true });

    expect(result.success).toBe(false);
  });

  it("rejects an abbreviated baseline SHA", () => {
    expect(joinSignalSchema.safeParse({ ...validJoin, baselineSha: "abc1234" }).success).toBe(false);
  });

  it("rejects an uppercase SHA", () => {
    expect(joinSignalSchema.safeParse({ ...validJoin, baselineSha: sha("A") }).success).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(joinSignalSchema.safeParse({ ...validJoin, createdAt: "yesterday" }).success).toBe(false);
  });

  it("rejects an agent id that is not a safe path segment", () => {
    expect(joinSignalSchema.safeParse({ ...validJoin, agent: "../etc" }).success).toBe(false);
  });

  it("rejects a zero or negative issue", () => {
    expect(joinSignalSchema.safeParse({ ...validJoin, issue: 0 }).success).toBe(false);
  });

  it("accepts an offset timestamp", () => {
    expect(
      joinSignalSchema.safeParse({ ...validJoin, createdAt: "2026-08-11T01:00:00.123-07:00" }).success
    ).toBe(true);
  });
});

describe("ballot and signal schemas", () => {
  const base = {
    issue: 1,
    issueSessionId: `issue-1:${sha("a")}`,
    agent: "claude",
    createdAt: "2026-08-11T01:00:00Z"
  };

  it("accepts a plan ballot citing pinned inputs", () => {
    const result = planBallotSchema.safeParse({
      ...base,
      inputSetHash: digest("c"),
      citations: [{ agent: "codex", path: ".plans/issue-1/plan.md", commitSha: sha("d") }],
      choice: "codex",
      rationale: "clearest file map"
    });

    expect(result.success).toBe(true);
  });

  it("rejects a plan ballot with no citations", () => {
    expect(
      planBallotSchema.safeParse({
        ...base,
        inputSetHash: digest("c"),
        citations: [],
        choice: "codex",
        rationale: "why"
      }).success
    ).toBe(false);
  });

  it("rejects a citation without a commit SHA", () => {
    expect(
      planBallotSchema.safeParse({
        ...base,
        inputSetHash: digest("c"),
        citations: [{ agent: "codex", path: ".plans/issue-1/plan.md" }],
        choice: "codex",
        rationale: "why"
      }).success
    ).toBe(false);
  });

  it("rejects an empty rationale", () => {
    expect(
      planBallotSchema.safeParse({
        ...base,
        inputSetHash: digest("c"),
        citations: [{ agent: "codex", path: ".plans/issue-1/plan.md", commitSha: sha("d") }],
        choice: "codex",
        rationale: ""
      }).success
    ).toBe(false);
  });

  it("accepts an implementation-ready signal", () => {
    expect(
      implementationReadySchema.safeParse({
        ...base,
        baselineSha: sha("a"),
        implementationCommitSha: sha("e")
      }).success
    ).toBe(true);
  });

  it("rejects a revision-ready signal with round zero", () => {
    expect(
      revisionReadySchema.safeParse({
        ...base,
        round: 0,
        basePin: sha("e"),
        revisionCommitSha: sha("f")
      }).success
    ).toBe(false);
  });

  it("rejects a non-integer round", () => {
    expect(
      revisionReadySchema.safeParse({
        ...base,
        round: 1.5,
        basePin: sha("e"),
        revisionCommitSha: sha("f")
      }).success
    ).toBe(false);
  });

  it("accepts each valid consensus disposition and rejects others", () => {
    for (const disposition of ["approve", "revise", "escalate"]) {
      expect(
        consensusBallotSchema.safeParse({
          ...base,
          round: 1,
          pin: sha("e"),
          disposition,
          rationale: "reviewed"
        }).success
      ).toBe(true);
    }

    expect(
      consensusBallotSchema.safeParse({
        ...base,
        round: 1,
        pin: sha("e"),
        disposition: "lgtm",
        rationale: "reviewed"
      }).success
    ).toBe(false);
  });
});

describe("parseJsonArtifact", () => {
  it("reports invalid JSON concretely", () => {
    const result = parseJsonArtifact(joinSignalSchema, "{not json");

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors[0]).toMatch(/invalid JSON/);
    }
  });

  it("reports the offending field path on a schema failure", () => {
    const result = parseJsonArtifact(joinSignalSchema, JSON.stringify({ ...validJoin, baselineSha: "nope" }));

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("baselineSha");
    }
  });

  it("returns the typed value on success", () => {
    const result = parseJsonArtifact(joinSignalSchema, JSON.stringify(validJoin));

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.value.agent).toBe("claude");
    }
  });
});

describe("computeInputSetHash", () => {
  const a = { agent: "codex", path: ".plans/issue-1/plan.md", commitSha: sha("d") };
  const b = { agent: "cursor", path: ".plans/issue-1/plan.md", commitSha: sha("e") };

  it("is independent of citation order", () => {
    expect(computeInputSetHash([a, b])).toBe(computeInputSetHash([b, a]));
  });

  it("changes when a cited commit changes", () => {
    expect(computeInputSetHash([a, b])).not.toBe(
      computeInputSetHash([a, { ...b, commitSha: sha("f") }])
    );
  });

  it("changes when a citation is dropped", () => {
    expect(computeInputSetHash([a, b])).not.toBe(computeInputSetHash([a]));
  });
});

describe("markdown section checks", () => {
  const document = [
    "# Plan",
    "",
    "Intro text.",
    "",
    "## Exact file map",
    "",
    "- src/a.ts",
    "",
    "## Tests",
    "",
    "## Risks and mitigations",
    "",
    "Something could go wrong.",
    ""
  ].join("\n");

  it("lists all headings", () => {
    expect(markdownHeadings(document)).toEqual([
      "plan",
      "exact file map",
      "tests",
      "risks and mitigations"
    ]);
  });

  it("treats a heading with no body as absent", () => {
    expect(nonEmptySections(document).has("tests")).toBe(false);
    expect(nonEmptySections(document).has("exact file map")).toBe(true);
  });

  it("matches a required section as a substring of the heading", () => {
    expect(missingSections(document, ["file map", "risks"])).toEqual([]);
  });

  it("reports an empty required section as missing", () => {
    expect(missingSections(document, ["tests"])).toEqual(["tests"]);
  });

  it("reports a required section that does not appear at all", () => {
    expect(missingSections(document, ["conclusion"])).toEqual(["conclusion"]);
  });

  it("does not treat a hash inside a fenced body as a heading", () => {
    const withBody = "## Notes\n\nsee issue #1 for context\n";

    expect(missingSections(withBody, ["notes"])).toEqual([]);
  });
});
