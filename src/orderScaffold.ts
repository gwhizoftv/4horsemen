import { computeInputSetHash } from "./evidence.js";
import type { BoundInput, WorkflowStepId } from "./steps.js";

export type ArtifactScaffoldContext = {
  stepId: WorkflowStepId;
  issue: number;
  issueSessionId: string;
  agent: string;
  baselineSha: string;
  automationDigest: string;
  inputs: readonly BoundInput[];
  eligibleChoices: readonly string[];
  expectedSelectedAgents: readonly string[];
  expectedImplementationAgent?: string;
  expectedImplementationPin?: string;
  expectedReviser?: string;
  round: number | null;
  approvedPaths: readonly string[];
};

const PLACEHOLDER_SHA = "<40-lowercase-hex-commit-sha>";

const citation = (input: BoundInput): { agent: string; commitSha: string; path: string } => ({
  agent: input.agent,
  commitSha: input.commitSha,
  path: input.path
});

const citationsOf = (inputs: readonly BoundInput[], kind: string) =>
  inputs.filter((input) => input.kind === kind).map(citation);

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
        artifact: "join",
        baselineSha: ctx.baselineSha,
        automationDigest: ctx.automationDigest
      };
    case "R3.plan-ballot":
      return {
        ...withHash(ctx),
        artifact: "plan-ballot",
        plans: citationsOf(ctx.inputs, "plan"),
        reviews: citationsOf(ctx.inputs, "review"),
        choice: ctx.eligibleChoices[0] ?? ctx.agent,
        rationale: "<one sentence>"
      };
    case "R3.publish-selection":
      return {
        ...withHash(ctx),
        artifact: "selection",
        selectedAgents: [...ctx.expectedSelectedAgents],
        ballots: citationsOf(ctx.inputs, "plan-ballot")
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
        ...withHash(ctx),
        artifact: "comparison-ballot",
        implementations: citationsOf(ctx.inputs, "implementation"),
        choice: ctx.eligibleChoices[0] ?? ctx.agent,
        rationale: "<one sentence>"
      };
    case "R5.reviser-auth":
      return {
        ...withHash(ctx),
        artifact: "reviser-authorization",
        reviser: ctx.expectedReviser ?? ctx.agent,
        implementationCommitSha: ctx.expectedImplementationPin ?? PLACEHOLDER_SHA
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
        ...withHash(ctx),
        artifact: "consensus-ballot",
        round: ctx.round ?? 1,
        revisionCommitSha: ctx.inputs[0]?.commitSha ?? PLACEHOLDER_SHA,
        disposition: "approve",
        rationale: "<one sentence>"
      };
    case "R6.declare":
      return {
        ...withHash(ctx),
        artifact: "consensus-declaration",
        round: ctx.round ?? 1,
        consensusCommitSha: ctx.inputs.find((input) => input.kind === "revision")?.commitSha ?? PLACEHOLDER_SHA,
        ballots: citationsOf(ctx.inputs, "consensus-ballot")
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
        "for this step and may change). Each heading needs a non-empty body " +
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
        "for this step and may change). Each heading needs a non-empty body:\n\n" +
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
        "for this step and may change). Use a heading line that is exactly the section name " +
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
  return (
    `\n\nWrite this JSON to the required path (replace any \`<...>\` placeholders; keep bound citations and digests exact):\n\n` +
    "```json\n" +
    `${json}\n` +
    "```"
  );
};
