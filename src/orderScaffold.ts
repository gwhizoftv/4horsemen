import { computeInputSetHash } from "./evidence.js";
import type { BoundInput, WorkflowStepId } from "./steps.js";

export type ArtifactScaffoldContext = {
  actionId?: string;
  stepId: WorkflowStepId;
  issue: number;
  issueSessionId: string;
  agent: string;
  baselineSha: string;
  automationDigest: string;
  inputs: readonly BoundInput[];
  eligibleChoices: readonly string[];
  round: number | null;
  approvedPaths: readonly string[];
};

const PLACEHOLDER_SHA = "<40-lowercase-hex-commit-sha>";

const common = (ctx: ArtifactScaffoldContext) => ({
  protocolVersion: 1 as const,
  issue: ctx.issue,
  issueSessionId: ctx.issueSessionId,
  agent: ctx.agent
});

const withHash = (ctx: ArtifactScaffoldContext) => ({
  ...common(ctx),
  inputSetHash: computeInputSetHash(ctx.inputs)
});

/**
 * Full minimal JSON body for JSON evidence steps. Known bindings are filled;
 * agent-authored commit SHAs use an explicit placeholder the agent must replace.
 */
export const artifactScaffoldValue = (ctx: ArtifactScaffoldContext): Record<string, unknown> | null => {
  switch (ctx.stepId) {
    case "R1.join":
      return {
        ...common(ctx),
        artifact: "participation-ready",
        baselineSha: ctx.baselineSha,
        automationDigest: ctx.automationDigest
      };
    case "R3.plan-ballot":
      return {
        actionId: ctx.actionId ?? "<current-action-uuid>",
        choice: ctx.eligibleChoices[0] ?? ctx.agent,
        rationale: "<one sentence>"
      };
    case "R4.implement":
      return {
        ...withHash(ctx),
        artifact: "implementation-ready",
        implementationCommitSha: PLACEHOLDER_SHA,
        approvedPaths: ctx.approvedPaths.length > 0 ? [...ctx.approvedPaths] : ["<path-from-selected-plan>"]
      };
    case "R5.compare-ballot":
      return {
        actionId: ctx.actionId ?? "<current-action-uuid>",
        choice: ctx.eligibleChoices[0] ?? ctx.agent,
        rationale: "<one sentence>"
      };
    case "R6.revise":
      return {
        ...withHash(ctx),
        artifact: "revision-ready",
        round: ctx.round ?? 1,
        revisedBranchHead: PLACEHOLDER_SHA,
        basedOn: ctx.inputs.map((input) => input.commitSha)
      };
    case "R6.ballot":
      return {
        actionId: ctx.actionId ?? "<current-action-uuid>",
        disposition: "approve",
        rationale: "<one sentence>"
      };
    case "R7.finalize":
      return {
        ...common(ctx),
        artifact: "finalization",
        consensusSha: ctx.inputs[0]?.commitSha ?? PLACEHOLDER_SHA,
        finalSha: PLACEHOLDER_SHA,
        checks: [{ argv: ["<exact check argv from workspace config>"], exitCode: 0 }]
      };
    default:
      return null;
  }
};

const markdownHeadingScaffold = (ctx: ArtifactScaffoldContext): string => {
  switch (ctx.stepId) {
    case "R2.plan":
      return (
        "\n\nRequired markdown headings for this action (also in AGENTS.md; the list here is authoritative " +
        "for this action and may change). Each heading needs a non-empty body " +
        "(accepted aliases in parentheses):\n\n" +
        "## Exact File List to be changed or deleted\n" +
        "(or Exact File Map / File Map / File Creation Order / Proposed Architecture)\n\n" +
        "## Exact file list to be created\n" +
        "(or Exact File Map / File Map / File Creation Order / Proposed Architecture)\n\n" +
        "## Tests\n" +
        "(or Test / Validation)\n\n" +
        "## Alternatives Rejected\n" +
        "(or Alternatives)\n\n" +
        "## Risks and Mitigations\n" +
        "(or Risks)\n\n" +
        "## Conclusion\n"
      );
    case "R3.review":
      return (
        "\n\nRequired markdown headings for this action (also in AGENTS.md; the list here is authoritative " +
        "for this action and may change). Each heading needs a non-empty body:\n\n" +
        "## Findings\n" +
        "(or Review Findings)\n\n" +
        "## Conclusion\n" +
        "(or Verdict)\n\n" +
        "Plan-review findings must state, in order: the plan claim or section; the rule that must hold; " +
        "a concrete failure if the plan is followed as written; then optionally the smallest correction. " +
        "The rule and the failure are the deliverable.\n"
      );
    case "R5.compare":
      return (
        "\n\nRequired markdown headings for this action (also in AGENTS.md; the list here is authoritative " +
        "for this action and may change). Use a heading line that is exactly the section name " +
        "(no em dash or subtitle on the same line). Each heading needs a non-empty body:\n\n" +
        "## Comparison\n" +
        "(or Findings)\n\n" +
        "Cite every bound implementation pin SHA from the inputs list below.\n\n" +
        "When a finding reviews implementation code, state in order: file path and line number; " +
        "the rule that must hold; a concrete failure that follows from breaking it; then optionally " +
        "the smallest illustrative test — or a fix sketch if a test cannot express it. Prefer a test over a fix.\n"
      );
    default:
      return "";
  }
};

export const renderArtifactScaffold = (ctx: ArtifactScaffoldContext): string => {
  const markdown = markdownHeadingScaffold(ctx);
  if (markdown !== "") return markdown;
  const value = artifactScaffoldValue(ctx);
  if (value === null) return "";
  const json = JSON.stringify(value, null, 2);
  const destination = ["R3.plan-ballot", "R5.compare-ballot", "R6.ballot"].includes(ctx.stepId)
    ? "response path"
    : "required path";
  return (
    `\n\nWrite this JSON to the ${destination} (replace any \`<...>\` placeholders; keep bound values exact):\n\n` +
    "```json\n" +
    `${json}\n` +
    "```"
  );
};
