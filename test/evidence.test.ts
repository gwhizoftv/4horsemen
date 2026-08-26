import { describe, expect, it } from "vitest";
import {
  computeInputSetHash,
  evaluateEvidence,
  extractApprovedPaths,
  isFileMapPath,
  type EvidenceMirror
} from "../src/evidence.js";
import type { EvidenceId, InternalOrder, WorkflowStepId } from "../src/steps.js";

const sha = (character: string): string => character.repeat(40);

const order = (overrides: Partial<InternalOrder> = {}): InternalOrder => ({
  actionId: "179da8c7-ae22-47eb-b6eb-211ceea6b732",
  submissionMode: "git",
  responsePath: null,
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

describe("plan file-map path extraction", () => {
  it("accepts nested repository paths including monorepo prefixes", () => {
    expect(isFileMapPath("packages/core/src/domain/model.ts")).toBe(true);
    expect(isFileMapPath("apps/web/src/session/mapSessionVideo.test.ts")).toBe(true);
    expect(isFileMapPath("src/product.ts")).toBe(true);
    expect(isFileMapPath("test/product.test.ts")).toBe(true);
    expect(isFileMapPath("cmd/coord/main.go")).toBe(true);
    expect(isFileMapPath("packages/core/src/**")).toBe(true);
    expect(isFileMapPath("apps/web/")).toBe(true);
    expect(isFileMapPath("package.json")).toBe(true);
  });

  it("rejects identifiers, escapes, and coordination prefixes", () => {
    expect(isFileMapPath("VIDEO_DOMAINS")).toBe(false);
    expect(isFileMapPath("toDomain")).toBe(false);
    expect(isFileMapPath("workouts")).toBe(false);
    expect(isFileMapPath("/abs/path.ts")).toBe(false);
    expect(isFileMapPath("packages/../secret.ts")).toBe(false);
    expect(isFileMapPath(".plans/issue-1/plan.md")).toBe(false);
    expect(isFileMapPath(".signals/issue-1/participation-ready-codex.json")).toBe(false);
    expect(isFileMapPath(".code-reviews/issue-1/review.md")).toBe(false);
  });

  it("keeps monorepo file-map paths and drops bare identifiers from a plan", () => {
    const plan = `# Plan
- \`packages/core/src/domain/model.ts\`
- \`apps/web/src/session/mapSessionVideo.test.ts\`
- \`VIDEO_DOMAINS\`
- \`toDomain\`
- \`workouts\`
- \`SessionVideo.tsx\`
`;
    expect(extractApprovedPaths(plan)).toEqual([
      "SessionVideo.tsx",
      "apps/web/src/session/mapSessionVideo.test.ts",
      "packages/core/src/domain/model.ts"
    ]);
  });

  it("expands a single bash brace group in backticked file-map paths", () => {
    const plan = `# Plan
- \`scripts/setup_{antigravity,claude,codex,cursor}.sh\`
- \`scripts/start_isolated_{antigravity,claude,codex}_agents.sh\`
- \`scripts/start_isolated_cursor_agents.sh\`
`;
    expect(extractApprovedPaths(plan)).toEqual([
      "scripts/setup_antigravity.sh",
      "scripts/setup_claude.sh",
      "scripts/setup_codex.sh",
      "scripts/setup_cursor.sh",
      "scripts/start_isolated_antigravity_agents.sh",
      "scripts/start_isolated_claude_agents.sh",
      "scripts/start_isolated_codex_agents.sh",
      "scripts/start_isolated_cursor_agents.sh"
    ]);
  });

  it("does not treat nested or empty brace groups as file-map paths", () => {
    expect(extractApprovedPaths("- `scripts/{a,{b,c}}.sh`\n")).toEqual([]);
    expect(extractApprovedPaths("- `scripts/{a,}.sh`\n")).toEqual([]);
  });
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

  it("accepts the split changed/created file-list headings", async () => {
    const plan = `# Plan

## Exact File List to be changed or deleted
- \`src/product.ts\`

## Exact file list to be created
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

  it("extracts monorepo file-map paths from a plan and ignores identifiers", async () => {
    const plan = `# Plan

## Exact File Map
- \`packages/core/src/domain/model.ts\`
- \`apps/web/src/session/mapSessionVideo.test.ts\`
- \`VIDEO_DOMAINS\`
- \`toDomain\`

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
      approvedPaths: [
        "apps/web/src/session/mapSessionVideo.test.ts",
        "packages/core/src/domain/model.ts"
      ]
    });
  });

  it("accepts implementation changes under an extracted packages/ file-map entry", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const approvedPaths = ["packages/core/src/domain/model.ts"];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths
    });
    expect(
      await evaluateEvidence(
        action,
        sha("e"),
        mirror(blob, { changedPaths: async () => ["packages/core/src/domain/model.ts"] })
      )
    ).toMatchObject({ status: "satisfied", productPin: sha("d") });
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

  it("checks participation-readiness session, baseline, and digest fields", async () => {
    const action = order({
      stepId: "R1.join",
      evidenceId: "join-published",
      requiredPath: ".signals/issue-1/participation-ready-codex.json"
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "participation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      baselineSha: sha("0"),
      automationDigest: action.automationDigest
    });
    expect(await evaluateEvidence(action, sha("c"), mirror(blob))).toMatchObject({
      status: "rejected",
      outstanding: ["participation-readiness baselineSha does not match the issue baseline"]
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

  it.each(["automation", "automation/", "automation/**"] as const)(
    "accepts Git's per-file listing for a deleted directory when the map names %s",
    async (mapEntry) => {
      const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
      const action = order({
        stepId: "R4.implement",
        evidenceId: "implementation-pinned",
        requiredPath: ".signals/issue-1/implementation-ready-codex.json",
        inputs,
        approvedPaths: [mapEntry]
      });
      const blob = JSON.stringify({
        protocolVersion: 1,
        artifact: "implementation-ready",
        issue: 1,
        issueSessionId: action.issueSessionId,
        agent: "codex",
        inputSetHash: computeInputSetHash(inputs),
        implementationCommitSha: sha("d"),
        approvedPaths: [mapEntry]
      });
      const result = await evaluateEvidence(
        action,
        sha("e"),
        mirror(blob, {
          changedPaths: async () => ["automation/src/foo.ts", "automation/package.json"]
        })
      );
      expect(result).toMatchObject({ status: "satisfied", productPin: sha("d") });
    }
  );

  it.each([
    ["implementation-pinned" as EvidenceId, "R4.implement" as WorkflowStepId, "the implementation signal"],
    ["revision-pinned" as EvidenceId, "R6.revise" as WorkflowStepId, "the revision signal"]
  ])(
    "names %s in outcome language, never by its evidence id, in pin-lineage rejections",
    async (evidenceId, stepId, subject) => {
      const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
      const action = order({
        stepId,
        evidenceId,
        requiredPath: ".signals/issue-1/implementation-ready-codex.json",
        inputs,
        approvedPaths: ["src/product.ts"],
        ...(stepId === "R6.revise" ? { round: 1 } : {})
      });
      const blob = JSON.stringify(
        stepId === "R6.revise"
          ? {
              protocolVersion: 1,
              artifact: "revision-ready",
              issue: 1,
              issueSessionId: action.issueSessionId,
              agent: "codex",
              inputSetHash: computeInputSetHash(inputs),
              round: 1,
              revisedBranchHead: sha("d"),
              basedOn: [sha("2")]
            }
          : {
              protocolVersion: 1,
              artifact: "implementation-ready",
              issue: 1,
              issueSessionId: action.issueSessionId,
              agent: "codex",
              inputSetHash: computeInputSetHash(inputs),
              implementationCommitSha: sha("d"),
              approvedPaths: ["src/product.ts"]
            }
      );
      // Echo the subject the evaluator supplies, exactly as pinValidation does.
      const result = await evaluateEvidence(
        action,
        sha("e"),
        mirror(blob, {
          validatePhasePin: async ({ subject: supplied }) => ({
            ok: false,
            reason: "history-rewrite",
            details: `${supplied} pins ${sha("d")}, which is not an ancestor of current origin tip.`
          })
        })
      );
      const outstanding = result.outstanding.join(" ");
      expect(outstanding).toContain(subject);
      expect(outstanding).not.toContain(evidenceId);
    }
  );

  it("does not let an implementation rewrite the bound file map to a directory prefix", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["automation"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["automation/"]
    });
    const result = await evaluateEvidence(action, sha("e"), mirror(blob));
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("do not match the selected plan file map");
  });

  it("does not treat a file map entry as a prefix of a sibling path", async () => {
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
      mirror(blob, { changedPaths: async () => ["src/product.ts.bak", "src/other.ts"] })
    );
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("src/product.ts.bak");
    expect(result.outstanding.join(" ")).toContain("src/other.ts");
  });

  it("does not treat a directory glob as a string prefix of a sibling name", async () => {
    const inputs = [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "selected-plan" }];
    const action = order({
      stepId: "R4.implement",
      evidenceId: "implementation-pinned",
      requiredPath: ".signals/issue-1/implementation-ready-codex.json",
      inputs,
      approvedPaths: ["automation/**"]
    });
    const blob = JSON.stringify({
      protocolVersion: 1,
      artifact: "implementation-ready",
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      inputSetHash: computeInputSetHash(inputs),
      implementationCommitSha: sha("d"),
      approvedPaths: ["automation/**"]
    });
    const result = await evaluateEvidence(
      action,
      sha("e"),
      mirror(blob, { changedPaths: async () => ["automation-extra/foo.ts"] })
    );
    expect(result.status).toBe("rejected");
    expect(result.outstanding.join(" ")).toContain("automation-extra/foo.ts");
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
    ["R3.plan-ballot", "plan-ballot-accepted"],
    ["R4.implement", "implementation-pinned"],
    ["R5.compare", "comparison-published"],
    ["R5.compare-ballot", "comparison-ballot-accepted"],
    ["R6.revise", "revision-pinned"],
    ["R6.ballot", "consensus-ballot-accepted"],
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
    ["R3.plan-ballot", "plan-ballot-accepted"],
    ["R4.implement", "implementation-pinned"],
    ["R5.compare-ballot", "comparison-ballot-accepted"],
    ["R6.revise", "revision-pinned"],
    ["R6.ballot", "consensus-ballot-accepted"],
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

  it("refuses to satisfy a plan ballot through a pushed repository artifact", async () => {
    // A ballot is judgment, and judgment now arrives as a private response. An
    // agent that pushes a ballot-shaped file to its own branch has not voted,
    // and must not be able to satisfy the step by doing so.
    const action = order({
      stepId: "R3.plan-ballot",
      evidenceId: "plan-ballot-accepted",
      submissionMode: "response",
      responsePath: "/runtime/issue-1/agents/codex/responses/179da8c7-ae22-47eb-b6eb-211ceea6b732.json",
      requiredPath: ".plans/issue-1/ballot-codex.json",
      eligibleChoices: ["claude", "codex"]
    });
    const artifact = {
      protocolVersion: 2,
      issue: 1,
      issueSessionId: action.issueSessionId,
      agent: "codex",
      actionId: action.actionId,
      responseSha256: "d".repeat(64),
      artifact: "plan-ballot",
      inputSetHash: "e".repeat(64),
      plans: [],
      reviews: [],
      choice: "claude",
      rationale: "clearest"
    };
    const result = await evaluateEvidence(action, sha("c"), mirror(JSON.stringify(artifact)));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain(
      "this action is answered with a runtime response, not a pushed commit"
    );
  });

  it("refuses to satisfy a comparison ballot through a pushed repository artifact", async () => {
    const action = order({
      stepId: "R5.compare-ballot",
      evidenceId: "comparison-ballot-accepted",
      submissionMode: "response",
      responsePath: "/runtime/issue-1/agents/codex/responses/179da8c7-ae22-47eb-b6eb-211ceea6b732.json",
      requiredPath: ".code-reviews/issue-1/ballot-codex.json",
      eligibleChoices: ["claude"]
    });
    const result = await evaluateEvidence(action, sha("c"), mirror("{}"));
    expect(result).toMatchObject({ status: "rejected" });
    expect(result.outstanding).toContain(
      "this action is answered with a runtime response, not a pushed commit"
    );
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
