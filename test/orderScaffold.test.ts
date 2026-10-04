import { describe, expect, it } from "vitest";
import { amendmentRequestScaffoldValue, artifactScaffoldValue, renderArtifactScaffold } from "../src/orderScaffold.js";
import { BUILD_DISCIPLINE_NOTE, STEP_DEFINITIONS } from "../src/steps.js";

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
    expect(rendered).toContain("## Reuse and Scope");
    expect(rendered).toContain("## Tests");
    expect(rendered).toContain("## Alternatives Rejected");
    expect(rendered).toContain("## Risks and Mitigations");
    expect(rendered).toContain("## Conclusion");
    expect(rendered).toContain("AGENTS.md");
    expect(rendered).toContain("Paths cited only here do not expand");
    expect(rendered).toContain("fewest focused tests");
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
    expect(rendered).toContain("reuses existing code and test support");
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
    expect(rendered).toContain("reuses existing code and tests");
    expect(rendered).not.toContain("```json");
  });

  it("renders only the minimal private response JSON for ballot steps", () => {
    const plan = artifactScaffoldValue({
      stepId: "R3.plan-ballot",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: ["claude", "codex"],
      round: null,
      approvedPaths: [],
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4"
    });
    expect(plan).toEqual({
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      choice: "<eligible-agent-id>",
      rationale: "<one sentence>"
    });
    expect(plan).not.toHaveProperty("artifact");
    expect(plan).not.toHaveProperty("protocolVersion");

    const consensus = artifactScaffoldValue({
      stepId: "R6.ballot",
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: 1,
      approvedPaths: [],
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4"
    });
    expect(consensus).toEqual({
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      disposition: "approve",
      rationale: "<one sentence>"
    });
  });

  it("offers the amendment request beside the ready signal and binds scope once amended", () => {
    const ctx = {
      stepId: "R4.implement" as const,
      issue: 1,
      issueSessionId: "s",
      agent: "claude",
      baselineSha: "a".repeat(40),
      automationDigest: "b".repeat(64),
      inputs: [],
      eligibleChoices: [],
      round: null,
      approvedPaths: ["src/product.ts"],
      actionId: "b2337d85-6617-4e9f-8ace-901453764aa4",
      scopeHash: "5".repeat(64)
    };
    expect(artifactScaffoldValue(ctx)).not.toHaveProperty("scopeHash");
    expect(artifactScaffoldValue({ ...ctx, amended: true })).toMatchObject({ scopeHash: "5".repeat(64) });
    expect(amendmentRequestScaffoldValue(ctx)).toMatchObject({
      artifact: "plan-amendment-request",
      actionId: ctx.actionId,
      scopeHash: ctx.scopeHash
    });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain('"artifact": "implementation-ready"');
    expect(rendered).toContain('"artifact": "plan-amendment-request"');
    expect(amendmentRequestScaffoldValue({ ...ctx, stepId: "R5.compare" })).toBeNull();
    expect(
      artifactScaffoldValue({ ...ctx, stepId: "R4.amend-ballot", round: 1, approvedPaths: [] })
    ).toEqual({ actionId: ctx.actionId, disposition: "approve", rationale: "<one sentence>" });
    expect(renderArtifactScaffold({ ...ctx, stepId: "R4.amend-ballot", round: 1 })).toContain(
      "Write this JSON to the response path"
    );
  });

  it("limits build discipline to planning, implementation, and revision tasks", () => {
    expect(
      Object.values(STEP_DEFINITIONS)
        .filter((definition) => definition.task.includes(BUILD_DISCIPLINE_NOTE))
        .map((definition) => definition.id)
    ).toEqual(["R2.plan", "R4.implement", "R6.revise"]);
  });
});
