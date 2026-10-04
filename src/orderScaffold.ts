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
  round: number | null;
  approvedPaths: readonly string[];
  actionId?: string;
  /** Implementation and revision: identity of the effective file map. */
  scopeHash?: string;
  /** True once an approved plan amendment extends the file map; ready signals must then bind `scopeHash`. */
  amended?: boolean;
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

/** Ready signals carry the scope binding only once an approved amendment makes it mandatory. */
const scopeBinding = (ctx: ArtifactScaffoldContext): { scopeHash?: string } =>
  ctx.amended === true && ctx.scopeHash !== undefined ? { scopeHash: ctx.scopeHash } : {};

/**
 * The alternative JSON body for an implementation or revision action whose
 * selected plan overlooked a needed file. Every binding is supplied; only the
 * explanation and the requested files are written by the agent.
 */
export const amendmentRequestScaffoldValue = (ctx: ArtifactScaffoldContext): Record<string, unknown> | null => {
  if ((ctx.stepId !== "R4.implement" && ctx.stepId !== "R6.revise") || ctx.scopeHash === undefined) return null;
  return {
    ...withHash(ctx),
    artifact: "plan-amendment-request",
    actionId: ctx.actionId ?? "<action-uuid>",
    scopeHash: ctx.scopeHash,
    explanation: "<what the selected plan overlooked and why the agreed change cannot be finished without it>",
    additionalPaths: [{ path: "<exact repository file path>", reason: "<why this file is necessary>" }]
  };
};

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
        actionId: ctx.actionId ?? "<action-uuid>",
        choice: "<eligible-agent-id>",
        rationale: "<one sentence>"
      };
    case "R4.implement":
      return {
        ...withHash(ctx),
        artifact: "implementation-ready",
        implementationCommitSha: PLACEHOLDER_SHA,
        approvedPaths: ctx.approvedPaths.length > 0 ? [...ctx.approvedPaths] : ["<path-from-selected-plan>"],
        ...scopeBinding(ctx)
      };
    case "R4.amend-ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
        disposition: "approve",
        rationale: "<one sentence>"
      };
    case "R5.compare-ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
        choice: "<eligible-agent-id>",
        rationale: "<one sentence>"
      };
    case "R6.revise":
      return {
        ...withHash(ctx),
        artifact: "revision-ready",
        round: ctx.round ?? 1,
        revisedBranchHead: PLACEHOLDER_SHA,
        basedOn: ctx.inputs.map((input) => input.commitSha),
        ...scopeBinding(ctx)
      };
    case "R6.ballot":
      return {
        actionId: ctx.actionId ?? "<action-uuid>",
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
        "## Reuse and Scope\n" +
        "(or Reuse / Scope and Reuse)\n" +
        "Name the existing functions, types, helpers, tests, and fixtures the implementation will reuse, " +
        "and justify every new file. Paths cited only here do not expand what the implementation may change; " +
        "also list every path intended for change in a file-list section above.\n\n" +
        "## Tests\n" +
        "(or Test / Validation)\n" +
        "Propose the fewest focused tests that fail before the change and pass after it, and name the existing " +
        "test file each new case will join whenever one exists.\n\n" +
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
        "The rule and the failure are the deliverable. Also evaluate whether the plan stays within the issue, " +
        "reuses existing code and test support, justifies every new file, and proposes only focused tests.\n"
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
        "the smallest illustrative test — or a fix sketch if a test cannot express it. Prefer a test over a fix. " +
        "Also compare whether each implementation stays within the issue, reuses existing code and tests, " +
        "avoids unnecessary files or refactors, and adds only focused coverage.\n"
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
  const isResponse =
    ctx.stepId === "R3.plan-ballot" ||
    ctx.stepId === "R4.amend-ballot" ||
    ctx.stepId === "R5.compare-ballot" ||
    ctx.stepId === "R6.ballot";
  const preamble = isResponse
    ? `\n\nWrite this JSON to the response path (replace any \`<...>\` placeholders):\n\n`
    : `\n\nWrite this JSON to the required path (replace any \`<...>\` placeholders; keep bound citations and digests exact):\n\n`;
  const disposition =
    ctx.stepId === "R4.amend-ballot"
      ? "\n\nUse `\"disposition\": \"approve\"` or `\"disposition\": \"reject\"`, and give the reason in the rationale."
      : "";
  const request = amendmentRequestScaffoldValue(ctx);
  const alternative =
    request === null
      ? ""
      : "\n\nOnly if the selected plan overlooked a needed file, write this plan amendment request to the same " +
        "required path instead of the signal above. List at most 20 exact file paths; no directories or patterns:\n\n" +
        "```json\n" +
        `${JSON.stringify(request, null, 2)}\n` +
        "```";
  return preamble + "```json\n" + `${json}\n` + "```" + disposition + alternative;
};
