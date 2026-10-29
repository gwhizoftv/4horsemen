import { describe, expect, it } from "vitest";
import { artifactScaffoldValue, renderArtifactScaffold } from "../src/orderScaffold.js";
import { computeInputSetHash } from "../src/evidence.js";
import { findAgentLanguageViolations } from "../src/agentLanguage.js";
import { followUpIssueArtifactSchema, planAmendmentRequestSchema } from "../src/protocol.js";
import { BUILD_DISCIPLINE_NOTE, STEP_DEFINITIONS } from "../src/steps.js";
import { computeImplementationSelectionDerived, deriveBoundInputs } from "../src/runLoop.js";
import { cursorsStateSchema, initialCursors, RUNTIME_FORMAT_VERSION, startStateSchema } from "../src/state.js";

describe("orderScaffold", () => {
  it("keeps round-1 basedOn on the selected implementation pin while hashing comparison feedback", () => {
    const now = "2026-08-11T12:00:00.000Z";
    const agents = ["claude", "codex"];
    const start = startStateSchema.parse({
      formatVersion: RUNTIME_FORMAT_VERSION, issue: 1, issueSessionId: `issue-1:${"a".repeat(40)}`,
      baselineSha: "a".repeat(40), profile: "consensus", originalRoster: agents,
      branchTemplate: "issue-{issue}/{agent}", baseBranch: "main", maxRevisionRounds: 3, prPolicy: "owner-only",
      automationDigest: "b".repeat(64), automationDigestScheme: "sha256-length-prefixed-v1",
      automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }], trustedSourceCommit: "a".repeat(40),
      origin: "/origin.git", coordRoot: "/runtime", configPath: "/runtime/config.json",
      agents: agents.map((id) => ({ id, root: `/clones/${id}`, launcher: `start-${id}.sh`, delivery: "pull" })),
      checks: [{ name: "check", argv: ["true"] }], pollIntervalMs: 100, createdAt: now
    });
    const implementation = { stepId: "R4.implement", agent: "codex", round: null, submissionSha: "d".repeat(40),
      productPin: "c".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json", acceptedAt: now };
    const comparisons = agents.map((agent, index) => ({ stepId: "R5.compare", agent, round: null,
      submissionSha: String(index + 1).repeat(40), path: ".code-reviews/issue-1/comparison.md", acceptedAt: now }));
    const responses = agents.map((agent, index) => ({ stepId: "R5.compare-ballot", agent, round: null,
      actionId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      responseSha256: String(index + 1).repeat(64), choice: "codex", rationale: "Use the comparison findings.",
      path: `/runtime/accepted-responses/${agent}.json`, acceptedAt: now }));
    const batch = {
      batchId: "20000000-0000-4000-8000-000000000001", kind: "comparison-ballot-batch", round: null,
      inputSetHash: "e".repeat(64), activeRoster: agents,
      responses: responses.map(({ agent, actionId, responseSha256 }) => ({ agent, actionId, responseSha256 })),
      paths: agents.map((agent) => `.code-reviews/issue-1/ballot-${agent}.json`),
      branch: "issue-1/coordinator-evidence", parentSha: "a".repeat(40), commitSha: "e".repeat(40),
      status: "published", attempts: 1, error: null, supersedes: null, createdAt: now, updatedAt: now
    };
    const cursors = cursorsStateSchema.parse({ ...initialCursors(start, now),
      accepted: [implementation, ...comparisons], acceptedResponses: responses, ballotBatches: [batch] });
    cursors.derived.implementationSelection = computeImplementationSelectionDerived(cursors, now);
    const expectedInputs = [
      { kind: "implementation", agent: "codex", commitSha: implementation.productPin, path: implementation.path },
      ...agents.map((agent, index) => ({ kind: "consensus-ballot", agent, commitSha: batch.commitSha, path: batch.paths[index] })),
      ...comparisons.map((comparison) => ({ kind: "review", agent: comparison.agent,
        commitSha: comparison.submissionSha, path: comparison.path }))
    ];
    const ctx = {
      stepId: "R6.revise" as const, issue: start.issue, issueSessionId: start.issueSessionId, agent: "codex",
      baselineSha: start.baselineSha, automationDigest: start.automationDigest,
      inputs: deriveBoundInputs(start, cursors, "R6.revise", 1), eligibleChoices: [], round: 1, approvedPaths: ["src/product.ts"]
    };
    expect(artifactScaffoldValue(ctx)).toMatchObject({ round: 1, basedOn: [implementation.productPin],
      inputSetHash: computeInputSetHash(expectedInputs) });
    expect(ctx.inputs).toEqual(expectedInputs);
  });

  it("offers a request without a product pin and keeps revision ancestry separate", () => {
    const ctx = {
      stepId: "R6.revise" as const, issue: 1, issueSessionId: "s", agent: "codex",
      actionId: "10000000-0000-4000-8000-000000000001", baselineSha: "a".repeat(40), automationDigest: "b".repeat(64),
      inputs: [
        { kind: "prior-revision", agent: "codex", commitSha: "c".repeat(40), path: ".signals/issue-1/revision-ready-codex-round-1.json" },
        { kind: "consensus-ballot", agent: "claude", commitSha: "e".repeat(40), path: ".code-reviews/issue-1/consensus-ballot-claude-round-1.json" }
      ],
      eligibleChoices: [], round: 2, approvedPaths: ["src/product.ts"], scopeHash: "d".repeat(64)
    };
    expect(artifactScaffoldValue(ctx)).toMatchObject({ scopeHash: ctx.scopeHash, basedOn: ["c".repeat(40)], round: 2,
      inputSetHash: computeInputSetHash(ctx.inputs) });
    const rendered = renderArtifactScaffold(ctx);
    expect(rendered).toContain('"inputSetHash": "' + computeInputSetHash(ctx.inputs) + '"');
    expect(rendered).toContain('"artifact": "plan-amendment-request"');
    expect(rendered).toContain('"scopeHash": "' + ctx.scopeHash + '"');
    expect(rendered).toContain("unstaged");
    expect(rendered).toContain('"explanation": "<discovered omission>"');
    expect(rendered).not.toContain('"rationale"');
    const requestJson = [...rendered.matchAll(/```json\n([\s\S]*?)\n```/g)][1]![1]!;
    expect(planAmendmentRequestSchema.parse({ ...JSON.parse(requestJson),
      additionalPaths: [{ path: "test/product.test.ts", reason: "Regression coverage" }]
    })).toMatchObject({ explanation: "<discovered omission>" });
    const ballot = artifactScaffoldValue({ ...ctx, stepId: "R4.amend-ballot" });
    expect(ballot).toEqual({ actionId: ctx.actionId, disposition: "approve", rationale: "<one sentence>" });
  });

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

  it("limits build discipline to planning, implementation, and revision tasks", () => {
    expect(
      Object.values(STEP_DEFINITIONS)
        .filter((definition) => definition.task.includes(BUILD_DISCIPLINE_NOTE))
        .map((definition) => definition.id)
    ).toEqual(["R2.plan", "R4.implement", "R6.revise"]);
  });
});


it("instructs objectors to reconcile retries and file all objections with bound receipt identity", () => {
  const ctx = { stepId: "R6.follow-up" as const, issue: 1, issueSessionId: "session", agent: "codex",
    actionId: "10000000-0000-4000-8000-000000000001", baselineSha: "a".repeat(40), automationDigest: "b".repeat(64),
    inputs: [{ kind: "revision", agent: "claude", commitSha: "c".repeat(40), path: ".signals/issue-1/revision.json" }],
    eligibleChoices: [], round: 3, approvedPaths: [],
    followUp: { repository: "acme/app", parentUrl: "https://github.com/acme/app/issues/1", key: "stable-key" } };
  const scaffold = artifactScaffoldValue(ctx);
  expect(followUpIssueArtifactSchema.parse({ ...scaffold, followUpIssueUrl: "https://github.com/acme/app/issues/2" }))
    .toMatchObject({ actionId: ctx.actionId, round: 3, revisionCommitSha: "c".repeat(40) });
  const text = renderArtifactScaffold(ctx);
  for (const expected of ["all your remaining objections", "all issue states", "stable-key", "--body-file", "Related to https://github.com/acme/app/issues/1", "Revision: " + "c".repeat(40)]) {
    expect(text).toContain(expected);
  }
});

describe("check proposals in actions (#261)", () => {
  it("binds proposal signals beside their pins, carries a pending proposal into revisions, and explains both roles", () => {
    const now = "2026-08-11T12:00:00.000Z";
    const agents = ["claude", "codex"];
    const start = startStateSchema.parse({
      formatVersion: RUNTIME_FORMAT_VERSION, issue: 1, issueSessionId: `issue-1:${"a".repeat(40)}`,
      baselineSha: "a".repeat(40), profile: "consensus", originalRoster: agents,
      branchTemplate: "issue-{issue}/{agent}", baseBranch: "main", maxRevisionRounds: 3, prPolicy: "owner-only",
      automationDigest: "b".repeat(64), automationDigestScheme: "sha256-length-prefixed-v1",
      automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }], trustedSourceCommit: "a".repeat(40),
      origin: "/origin.git", coordRoot: "/runtime", configPath: "/runtime/config.json",
      agents: agents.map((id) => ({ id, root: `/clones/${id}`, launcher: `start-${id}.sh`, delivery: "pull" })),
      checks: [], pollIntervalMs: 100, createdAt: now
    });
    const proposal = { implementationCommitSha: "c".repeat(40), commands: [{ name: "native-test", argv: ["sh", "scripts/test.sh"] }],
      entryPointPaths: ["scripts/test.sh"], description: "Runs the new native tests." };
    const implementation = { stepId: "R4.implement", agent: "codex", round: null, submissionSha: "d".repeat(40),
      productPin: "c".repeat(40), path: ".signals/issue-1/implementation-ready-codex.json", acceptedAt: now, checkProposal: proposal };
    const other = { stepId: "R4.implement", agent: "claude", round: null, submissionSha: "1".repeat(40),
      productPin: "2".repeat(40), path: ".signals/issue-1/implementation-ready-claude.json", acceptedAt: now };
    const revision = { stepId: "R6.revise", agent: "codex", round: 1, submissionSha: "4".repeat(40),
      productPin: "5".repeat(40), path: ".signals/issue-1/revision-ready-codex-round-1.json", acceptedAt: now };
    const cursors = cursorsStateSchema.parse({ ...initialCursors(start, now), accepted: [implementation, other, revision] });
    cursors.derived.implementationSelection = {
      kind: "implementation-selection", algorithm: "plurality-active-roster-v1", inputSetHash: "e".repeat(64),
      activeRoster: agents, inputs: [{ kind: "implementation", agent: "codex", submissionSha: implementation.submissionSha,
        path: implementation.path, productPin: implementation.productPin }],
      decisionId: `implementation-selection:${"e".repeat(64)}`, supersedes: null, decidedAt: now,
      winner: "codex", implementationPin: implementation.productPin, reviser: "codex"
    };
    const signal = { kind: "check-proposal", agent: "codex", commitSha: implementation.submissionSha, path: implementation.path };
    const compare = deriveBoundInputs(start, cursors, "R5.compare", null);
    expect(compare).toEqual([
      { kind: "implementation", agent: "codex", commitSha: implementation.productPin, path: implementation.path }, signal,
      { kind: "implementation", agent: "claude", commitSha: other.productPin, path: other.path }
    ]);
    // A revision that omits the optional field still carries the pending proposal to its reviewers.
    expect(deriveBoundInputs(start, cursors, "R6.ballot", 1)).toContainEqual(signal);
    const revise = deriveBoundInputs(start, cursors, "R6.revise", 1);
    expect(revise).toContainEqual(signal);
    // A changed proposal for the same code changes what reviewers are bound to.
    const changed = cursorsStateSchema.parse({ ...cursors,
      accepted: [{ ...implementation, submissionSha: "9".repeat(40) }, other, revision] });
    expect(computeInputSetHash(deriveBoundInputs(start, changed, "R5.compare", null))).not.toBe(computeInputSetHash(compare));

    const context = (stepId: "R4.implement" | "R5.compare" | "R6.revise", inputs: typeof compare) => ({
      stepId, issue: 1, issueSessionId: start.issueSessionId, agent: "codex", baselineSha: start.baselineSha,
      automationDigest: start.automationDigest, inputs, eligibleChoices: [], round: stepId === "R6.revise" ? 1 : null,
      approvedPaths: ["scripts/test.sh"]
    });
    const implement = renderArtifactScaffold(context("R4.implement", []));
    expect(implement).toContain('add a "checkProposal" field');
    expect(implement).toContain("may only add checks");
    expect(artifactScaffoldValue(context("R4.implement", []))).not.toHaveProperty("checkProposal");
    expect(artifactScaffoldValue(context("R6.revise", revise))).toMatchObject({ basedOn: [implementation.productPin] });
    expect(renderArtifactScaffold(context("R6.revise", revise))).toContain("carries forward unless you supply a corrected checkProposal");
    const review = renderArtifactScaffold(context("R5.compare", compare));
    expect(review).toContain("Evaluate those commands and entry points together with the implementation");
    for (const text of [implement, review]) expect(findAgentLanguageViolations(text)).toEqual([]);
  });
});
