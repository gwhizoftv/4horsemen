import { describe, expect, it } from "vitest";
import { artifactScaffoldValue, renderArtifactScaffold } from "../src/orderScaffold.js";
import { WORKFLOW_STEP_ORDER } from "../src/steps.js";

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
      round: null,
      approvedPaths: []
    };
    expect(artifactScaffoldValue(ctx)).toEqual({
      protocolVersion: 1,
      issue: 1,
      issueSessionId: ctx.issueSessionId,
      agent: "antigravity",
      artifact: "participation-ready",
      baselineSha: ctx.baselineSha,
      automationDigest: ctx.automationDigest
    });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain("```json");
    expect(rendered).toContain('"artifact": "participation-ready"');
  });

  it("renders JSON for implementation-ready", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R4.implement",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("```json");
    expect(rendered).toContain('"artifact": "implementation-ready"');
  });

  it("lists required plan headings for R2.plan", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R2.plan",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("## Exact File List to be changed or deleted");
    expect(rendered).toContain("## Exact file list to be created");
    expect(rendered).toContain("## Tests");
    expect(rendered).toContain("## Alternatives Rejected");
    expect(rendered).toContain("## Risks and Mitigations");
    expect(rendered).toContain("## Conclusion");
    expect(rendered).toContain("AGENTS.md");
  });

  it("lists required review headings for R3.review", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R3.review",
      issue: 1,
      issueSessionId: "s",
      agent: "codex",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("## Findings");
    expect(rendered).toContain("## Conclusion");
    expect(rendered).toContain("Plan-review findings must state");
  });

  it("lists required comparison headings for R5.compare", () => {
    const rendered = renderArtifactScaffold({
      stepId: "R5.compare",
      issue: 1,
      issueSessionId: "s",
      agent: "cursor",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: []
    });
    expect(rendered).toContain("## Comparison");
    expect(rendered).toContain("(or Findings)");
    expect(rendered).toContain("no em dash or subtitle");
    expect(rendered).toContain("file path and line number");
    expect(rendered).not.toContain("```json");
  });

  it("has no scaffold for a step that publishes no artifact", () => {
    // Every remaining step that names a required path is agent-authored. If a
    // coordinator-owned decision ever grew a scaffold again, an action body
    // could ask an agent to re-serialize a result the coordinator already owns.
    const scaffolded = WORKFLOW_STEP_ORDER.filter(
      (stepId) =>
        artifactScaffoldValue({
          stepId,
          issue: 1,
          issueSessionId: "s",
          agent: "claude",
          baselineSha: "a".repeat(40),
          automationDigest: "b".repeat(64),
          inputs: [],
          eligibleChoices: [],
          round: null,
          approvedPaths: []
        }) !== null
    );
    expect(scaffolded).toEqual([
      "R1.join",
      "R3.plan-ballot",
      "R4.implement",
      "R5.compare-ballot",
      "R6.revise",
      "R6.ballot",
      "R7.finalize"
    ]);
    const markdownOnly = WORKFLOW_STEP_ORDER.filter((stepId) =>
      ["R2.plan", "R3.review", "R5.compare"].includes(stepId)
    );
    expect([...scaffolded, ...markdownOnly].sort()).toEqual([...WORKFLOW_STEP_ORDER].sort());
  });
});
