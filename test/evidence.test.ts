import { describe, expect, it } from "vitest";
import { computeInputSetHash, evaluateEvidence, type EvidenceMirror } from "../src/evidence.js";
import type { InternalOrder } from "../src/steps.js";

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
  ...overrides
});

const mirror = (blob: string | null, overrides: Partial<EvidenceMirror> = {}): EvidenceMirror => ({
  fetchBranch: async () => ({ ok: true, ref: "refs/remotes/origin/issue-1/codex", tip: sha("f") }),
  isReachable: async () => true,
  isAncestor: async () => true,
  readBlob: async () => blob,
  changedPaths: async () => ["src/product.ts"],
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
});
