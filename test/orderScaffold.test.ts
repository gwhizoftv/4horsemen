import { describe, expect, it } from "vitest";
import { artifactScaffoldValue, renderArtifactScaffold } from "../src/orderScaffold.js";

describe("orderScaffold", () => {
  it("renders a filled join JSON scaffold", () => {
    const ctx = {
      stepId: "R1.join" as const,
      issue: 1,
      issueSessionId: "issue-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      agent: "antigravity",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      expectedSelectedAgents: [],
      round: null,
      approvedPaths: []
    };
    expect(artifactScaffoldValue(ctx)).toEqual({
      protocolVersion: 1,
      issue: 1,
      issueSessionId: ctx.issueSessionId,
      agent: "antigravity",
      artifact: "join",
      baselineSha: ctx.baselineSha,
      automationDigest: ctx.automationDigest
    });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain("```json");
    expect(rendered).toContain('"artifact": "join"');
  });

  it("skips markdown-only steps", () => {
    expect(
      renderArtifactScaffold({
        stepId: "R2.plan",
        issue: 1,
        issueSessionId: "s",
        agent: "claude",
        baselineSha: "a".repeat(40),
        automationDigest: "b".repeat(64),
        inputs: [],
        eligibleChoices: [],
        expectedSelectedAgents: [],
        round: null,
        approvedPaths: []
      })
    ).toBe("");
  });
});
