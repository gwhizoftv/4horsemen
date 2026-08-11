import { describe, expect, it } from "vitest";
import { computeInputSetHash, evaluateEvidence, type EvidenceMirror } from "../src/evidence.js";
import type { EvidenceId, InternalOrder, WorkflowStepId } from "../src/steps.js";

const sha = (character: string): string => character.repeat(40);

const order = (overrides: Partial<InternalOrder> = {}): InternalOrder => ({
  actionId: "179da8c7-ae22-47eb-b6eb-211ceea6b732",
  issue: 1,
  agent: "codex",
  stepId: "R2.plan",
  evidenceId: "plan-published",
  requiredPath: ".plans/issue-1/plan.md",
  completePath: "/runtime/issue-1/agents/codex/complete",
  branch: "issue-1/codex",
  round: null,
  issueSessionId: `issue-1:${sha("a")}`,
  baselineSha: sha("a"),
  automationDigest: "b".repeat(64),
  task: "Plan",
  inputs: [],
  approvedPaths: [],
  activeRoster: ["codex"],
  eligibleChoices: [],
  expectedSelectedAgents: [],
  ...overrides
});

const mirror = (blob: string | null, overrides: Partial<EvidenceMirror> = {}): EvidenceMirror => ({
  fetchBranch: async () => ({ ok: true, ref: "refs/remotes/origin/issue-1/codex", tip: sha("f") }),
  isReachable: async () => true,
  isAncestor: async () => true,
  readBlob: async () => blob,
  changedPaths: async () => ["src/product.ts"],
  validatePhasePin: async () => ({ ok: true }),
  ...overrides
});

describe("evidence evaluation", () => {
  it("validates a plan at the submitted SHA and extracts its approved file map", async () => {
    const plan = `# Plan

## Exact File Map
- \`src/product.ts\`
- \`test/product.test.ts\`

## Tests
Run tests.

## Alternatives Rejected
None.

## Risks and Mitigations
Keep pins immutable.

## Conclusion
Implement it.
`;
    const result = await evaluateEvidence(order(), sha("c"), mirror(plan));
    expect(result).toMatchObject({
      status: "satisfied",
      approvedPaths: ["src/product.ts", "test/product.test.ts"]
    });
  });

  it("returns retry without an artifact verdict when origin fetch fails", async () => {
    const result = await evaluateEvidence(
      order(),
      sha("c"),
      mirror(null, { fetchBranch: async () => ({ ok: false, transient: true, error: "network timeout" }) })
    );
    expect(result).toMatchObject({ status: "retry", outstanding: ["origin fetch failed: network timeout"] });
  });

  it("treats a permanently absent expected branch as rejected evidence", async () => {
    const result = await evaluateEvidence(
      order(),
      sha("c"),
      mirror(null, { fetchBranch: async () => ({ ok: false, transient: false, error: "remote ref missing" }) })
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding.join(" ")).toContain("could not be fetched");
  });

  it("checks join session, baseline, and digest fields", async () => {
    const action = order({
      stepId: "R1.join",
      evidenceId: "join-published",
      requiredPath: ".signals/issue-1/joined-codex.json"
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "join",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      baselineSha: sha("0"),
      automationDigest: action.automationDigest
    });
    expect(await evaluateEvidence(action, sha("c"), mirror(blob))).toMatchObject({
      status: "rejected",
      outstanding: ["join baselineSha does not match the issue baseline"]
    });
  });

  it("rejects implementation paths outside the selected plan map", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["src/product.ts"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["src/product.ts"]
    });
    const result = await evaluateEvidence(
      action,
      sha("e"),
      mirror(blob, { changedPaths: async () => ["src/product.ts", "docs/unapproved.md"] })
    );
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("docs/unapproved.md");
  });

  it("rejects a coordination signal commit used as its own product pin", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["src/product.ts"]
    });
    const submission = sha("d");
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: submission,
      approvedPaths: ["src/product.ts"]
    });
    const result = await evaluateEvidence(action, submission, mirror(blob));
    expect(result.outstanding).toContain("product pin must differ from the coordination signal commit");
  });

  it.each([
    ["R1.join", "join-published"],
    ["R2.plan", "plan-published"],
    ["R3.review", "review-published"],
    ["R3.plan-ballot", "plan-ballot-published"],
    ["R3.publish-selection", "selection-published"],
    ["R4.implement", "implementation-pinned"],
    ["R5.compare", "comparison-published"],
    ["R5.compare-ballot", "comparison-ballot-published"],
    ["R5.reviser-auth", "reviser-authorized"],
    ["R6.revise", "revision-pinned"],
    ["R6.ballot", "consensus-ballot-published"],
    ["R6.declare", "consensus-declared"],
    ["R7.finalize", "finalization-verified"]
  ] as const)("rejects missing required-path evidence for %s", async (stepId, evidenceId) => {
    const result = await evaluateEvidence(
      order({ stepId: stepId as WorkflowStepId, evidenceId: evidenceId as EvidenceId, requiredPath: `.missing/${stepId}` }),
      sha("c"),
      mirror(null)
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding.join(" ")).toContain("is missing");
  });

  it.each([
    ["R1.join", "join-published"],
    ["R3.plan-ballot", "plan-ballot-published"],
    ["R3.publish-selection", "selection-published"],
    ["R4.implement", "implementation-pinned"],
    ["R5.compare-ballot", "comparison-ballot-published"],
    ["R5.reviser-auth", "reviser-authorized"],
    ["R6.revise", "revision-pinned"],
    ["R6.ballot", "consensus-ballot-published"],
    ["R6.declare", "consensus-declared"],
    ["R7.finalize", "finalization-verified"]
  ] as const)("rejects malformed structured evidence for %s", async (stepId, evidenceId) => {
    const result = await evaluateEvidence(
      order({ stepId: stepId as WorkflowStepId, evidenceId: evidenceId as EvidenceId }),
      sha("c"),
      mirror("not-json")
    );
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding.join(" ")).toMatch(/invalid|artifact/);
  });

  it.each([
    ["R2.plan", "plan-published"],
    ["R3.review", "review-published"],
    ["R5.compare", "comparison-published"]
  ] as const)("rejects mechanically incomplete markdown evidence for %s", async (stepId, evidenceId) => {
    const result = await evaluateEvidence(
      order({ stepId: stepId as WorkflowStepId, evidenceId: evidenceId as EvidenceId }),
      sha("c"),
      mirror("# Incomplete\n")
    );
    expect(result).toMatchObject({ status: "rejected" });
  });

  it("validates deterministic ballot selection and reviser authorization", async () => {
    const plan = { agent: "claude", commitSha: sha("1"), path: ".plans/issue-1/plan.md", kind: "plan" };
    const review = { agent: "claude", commitSha: sha("2"), path: ".plans/issue-1/review.md", kind: "review" };
    const ballotOrder = order({
      stepId: "R3.plan-ballot",
      evidenceId: "plan-ballot-published",
      requiredPath: ".plans/issue-1/ballot-codex.json",
      inputs: [plan, review],
      activeRoster: ["codex", "claude"],
      eligibleChoices: ["claude"]
    });
    const ballotBlob = JSON.stringify({
      protocolVersion: 1,
      artifact: "plan-ballot",
      issue: 1,
      issueSessionId: ballotOrder.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(ballotOrder.inputs),
      plans: [{ agent: plan.agent, commitSha: plan.commitSha, path: plan.path }],
      reviews: [{ agent: review.agent, commitSha: review.commitSha, path: review.path }],
      choice: "claude",
      rationale: "complete"
    });
    expect(await evaluateEvidence(ballotOrder, sha("c"), mirror(ballotBlob))).toMatchObject({
      status: "satisfied",
      choice: "claude"
    });
    const badChoice = JSON.stringify({ ...JSON.parse(ballotBlob), choice: "cursor" });
    expect((await evaluateEvidence(ballotOrder, sha("c"), mirror(badChoice))).outstanding.join(" ")).toContain(
      "not an eligible active plan agent"
    );

    const implementation = {
      agent: "claude",
      commitSha: sha("3"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const comparisonBallot = {
      agent: "codex",
      commitSha: sha("4"),
      path: ".code-reviews/issue-1/ballot-codex.json",
      kind: "comparison-ballot"
    };
    const authOrder = order({
      stepId: "R5.reviser-auth",
      evidenceId: "reviser-authorized",
      requiredPath: ".signals/issue-1/reviser-authorized.json",
      inputs: [implementation, comparisonBallot],
      activeRoster: ["codex", "claude"],
      expectedImplementationAgent: "claude",
      expectedImplementationPin: implementation.commitSha,
      expectedReviser: "claude"
    });
    const auth = {
      protocolVersion: 1,
      artifact: "reviser-authorization",
      issue: 1,
      issueSessionId: authOrder.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(authOrder.inputs),
      reviser: "claude",
      implementationCommitSha: implementation.commitSha
    };
    expect(await evaluateEvidence(authOrder, sha("c"), mirror(JSON.stringify(auth)))).toMatchObject({
      status: "satisfied",
      reviser: "claude",
      productPin: implementation.commitSha
    });
    expect(
      (
        await evaluateEvidence(authOrder, sha("c"), mirror(JSON.stringify({ ...auth, reviser: "cursor" })))
      ).outstanding.join(" ")
    ).toContain("deterministic comparison winner");
  });

  it("rejects a comparison that omits a bound implementation pin", async () => {
    const input = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const action = order({
      stepId: "R5.compare",
      evidenceId: "comparison-published",
      requiredPath: ".code-reviews/issue-1/comparison.md",
      inputs: [input]
    });
    const result = await evaluateEvidence(action, sha("c"), mirror("# Comparison\n\nNo bound pin is cited.\n"));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain(`comparison does not cite implementation pin ${input.commitSha}`);
  });

  it("rejects a published selection that differs from the deterministic tally", async () => {
    const ballot = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".plans/issue-1/ballot-claude.json",
      kind: "plan-ballot"
    };
    const action = order({
      stepId: "R3.publish-selection",
      evidenceId: "selection-published",
      requiredPath: ".plans/issue-1/selection.json",
      inputs: [ballot],
      activeRoster: ["claude", "codex"],
      expectedSelectedAgents: ["claude"]
    });
    const artifact = {
      protocolVersion: 1,
      artifact: "selection",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(action.inputs),
      selectedAgents: ["codex"],
      ballots: [{ agent: ballot.agent, commitSha: ballot.commitSha, path: ballot.path }]
    };
    const result = await evaluateEvidence(action, sha("c"), mirror(JSON.stringify(artifact)));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain("selection result does not equal the coordinator's deterministic ballot tally");
  });

  it("rejects a comparison ballot for an ineligible implementation", async () => {
    const implementation = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const action = order({
      stepId: "R5.compare-ballot",
      evidenceId: "comparison-ballot-published",
      requiredPath: ".code-reviews/issue-1/ballot-codex.json",
      inputs: [implementation],
      activeRoster: ["claude", "codex"],
      eligibleChoices: ["claude"]
    });
    const artifact = {
      protocolVersion: 1,
      artifact: "comparison-ballot",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(action.inputs),
      implementations: [
        { agent: implementation.agent, commitSha: implementation.commitSha, path: implementation.path }
      ],
      choice: "codex",
      rationale: "Prefer the unbound implementation."
    };
    const result = await evaluateEvidence(action, sha("c"), mirror(JSON.stringify(artifact)));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain("comparison ballot choice codex is not an eligible active implementation agent");
  });

  it("rejects a consensus declaration that pins a revision outside its bound inputs", async () => {
    const revision = {
      agent: "codex",
      commitSha: sha("2"),
      path: ".signals/issue-1/revision-ready-codex-round-1.json",
      kind: "revision"
    };
    const ballot = {
      agent: "claude",
      commitSha: sha("3"),
      path: ".code-reviews/issue-1/consensus-ballot-claude-round-1.json",
      kind: "consensus-ballot"
    };
    const action = order({
      stepId: "R6.declare",
      evidenceId: "consensus-declared",
      requiredPath: ".signals/issue-1/consensus.json",
      round: 1,
      inputs: [revision, ballot]
    });
    const artifact = {
      protocolVersion: 1,
      artifact: "consensus-declaration",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(action.inputs),
      round: 1,
      consensusCommitSha: sha("4"),
      ballots: [{ agent: ballot.agent, commitSha: ballot.commitSha, path: ballot.path }]
    };
    const result = await evaluateEvidence(action, sha("c"), mirror(JSON.stringify(artifact)));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain("consensus declaration does not pin the bound revision commit");
  });

  it("requires revision lineage, approved paths, and immutable phase separation", async () => {
    const input = {
      agent: "claude",
      commitSha: sha("2"),
      path: ".signals/issue-1/implementation-ready-claude.json",
      kind: "implementation"
    };
    const action = order({
      stepId: "R6.revise",
      evidenceId: "revision-pinned",
      requiredPath: ".signals/issue-1/revision-ready-codex-round-1.json",
      round: 1,
      inputs: [input],
      approvedPaths: ["src/product.ts"]
    });
    const artifact = {
      protocolVersion: 1,
      artifact: "revision-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(action.inputs),
      round: 1,
      revisedBranchHead: sha("d"),
      basedOn: [input.commitSha]
    };
    const unrelated = await evaluateEvidence(
      action,
      sha("e"),
      mirror(JSON.stringify(artifact), {
        isAncestor: async (base, tip) => !(base === input.commitSha && tip === artifact.revisedBranchHead)
      })
    );
    expect(unrelated.outstanding.join(" ")).toContain("does not descend from its exact authorized input pin");

    const escaped = await evaluateEvidence(
      action,
      sha("e"),
      mirror(JSON.stringify(artifact), { changedPaths: async () => ["docs/unapproved.md"] })
    );
    expect(escaped.outstanding.join(" ")).toContain("outside the approved file map");

    const postPin = await evaluateEvidence(
      action,
      sha("e"),
      mirror(JSON.stringify(artifact), {
        changedPaths: async () => ["src/product.ts"],
        validatePhasePin: async () => ({ ok: false, reason: "post-pin-implementation-change", details: "post-pin product change" })
      })
    );
    expect(postPin.outstanding).toContain("post-pin product change");

    expect(
      await evaluateEvidence(
        action,
        sha("e"),
        mirror(JSON.stringify(artifact), { changedPaths: async () => ["src/product.ts"] })
      )
    ).toMatchObject({ status: "satisfied", productPin: artifact.revisedBranchHead });
  });
});
