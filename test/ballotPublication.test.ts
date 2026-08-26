import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertEvidenceBranchSafe,
  buildCanonicalPlanBallot,
  canonicalBallotPath,
  computeBallotBatchInputSetHash,
  COORDINATOR_EVIDENCE_AUTHOR,
  createEvidenceCommit,
  deriveEvidenceBranch,
  evidenceCommitMessage,
  prepareBallotBatch,
  reconcileEvidencePublication,
  resolveEvidenceParentSha,
  serializeCanonicalJson
} from "../src/ballotPublication.js";
import { BareMirror } from "../src/mirror.js";
import { git } from "./support/workspaceFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const actionId = "b2337d85-6617-4e9f-8ace-901453764aa4";
const digest = "a".repeat(64);
const sha = (ch: string): string => ch.repeat(40);

describe("ballotPublication", () => {
  it("derives a reserved evidence branch and rejects agent collisions", () => {
    expect(deriveEvidenceBranch("issue-{issue}/{agent}", 12)).toBe("issue-12/coordinator-evidence");
    expect(() =>
      assertEvidenceBranchSafe({
        branchTemplate: "issue-{issue}/{agent}",
        issue: 12,
        agentIds: ["claude", "coordinator-evidence"],
        baseBranch: "main"
      })
    ).toThrow(/reserved/);
  });

  it("builds canonical plan ballot bytes with protocol v2 provenance", () => {
    const artifact = buildCanonicalPlanBallot({
      issue: 1,
      issueSessionId: `issue-1:${sha("a")}`,
      agent: "codex",
      actionId,
      responseSha256: digest,
      rationale: "Prefer the complete plan.",
      choice: "claude",
      inputSetHash: digest,
      plans: [{ agent: "claude", commitSha: sha("1"), path: ".plans/issue-1/plan.md" }],
      reviews: [{ agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/review.md" }]
    });
    expect(artifact.protocolVersion).toBe(2);
    expect(artifact.actionId).toBe(actionId);
    expect(artifact.responseSha256).toBe(digest);
    expect(canonicalBallotPath("plan-ballot-batch", 1, "codex", null)).toBe(
      ".plans/issue-1/ballot-codex.json"
    );
    expect(serializeCanonicalJson({ b: 1, a: 2 })).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
  });

  it("freezes one batch for the active roster with a stable input-set hash", () => {
    const boundInputs = [
      { agent: "claude", commitSha: sha("1"), path: ".plans/issue-1/plan.md", kind: "plan" },
      { agent: "codex", commitSha: sha("2"), path: ".plans/issue-1/plan.md", kind: "plan" }
    ] as const;
    const responses = [
      {
        agent: "claude",
        actionId: "11111111-1111-4111-8111-111111111111",
        responseSha256: "1".repeat(64),
        rationale: "claude",
        choice: "claude"
      },
      {
        agent: "codex",
        actionId: "22222222-2222-4222-8222-222222222222",
        responseSha256: "2".repeat(64),
        rationale: "codex",
        choice: "claude"
      }
    ];
    const prepared = prepareBallotBatch({
      kind: "plan-ballot-batch",
      issue: 1,
      issueSessionId: `issue-1:${sha("a")}`,
      round: null,
      activeRoster: ["claude", "codex"],
      boundInputs,
      responses
    });
    expect(prepared.files).toHaveLength(2);
    expect(prepared.message).toBe(evidenceCommitMessage("plan-ballot-batch", 1, null));
    expect(prepared.inputSetHash).toBe(
      computeBallotBatchInputSetHash({
        kind: "plan-ballot-batch",
        round: null,
        activeRoster: ["claude", "codex"],
        boundInputs,
        responses
      })
    );
    expect(
      prepareBallotBatch({
        kind: "plan-ballot-batch",
        issue: 1,
        issueSessionId: `issue-1:${sha("a")}`,
        round: null,
        activeRoster: ["codex", "claude"],
        boundInputs,
        responses
      }).inputSetHash
    ).not.toBe(prepared.inputSetHash);
  });

  it("reconciles publication retries against the frozen commit SHA", () => {
    const commitSha = sha("c");
    const parentSha = sha("a");
    expect(reconcileEvidencePublication({ commitSha, parentSha, remoteTip: commitSha })).toEqual({
      outcome: "already-published"
    });
    expect(reconcileEvidencePublication({ commitSha, parentSha, remoteTip: null })).toEqual({
      outcome: "push"
    });
    expect(reconcileEvidencePublication({ commitSha, parentSha, remoteTip: parentSha })).toEqual({
      outcome: "push"
    });
    expect(reconcileEvidencePublication({ commitSha, parentSha, remoteTip: sha("d") })).toEqual({
      outcome: "conflict",
      remoteTip: sha("d")
    });
    expect(
      resolveEvidenceParentSha({
        baselineSha: sha("b"),
        batches: [
          { status: "failed", commitSha: sha("1") },
          { status: "published", commitSha: sha("2") },
          { status: "pending", commitSha: sha("3") }
        ]
      })
    ).toBe(sha("2"));
  });

  it("creates a coordinator-authored evidence commit via worktree", async () => {
    const root = mkdtempSync(join(tmpdir(), "coord-ballot-pub-"));
    roots.push(root);
    const origin = join(root, "origin.git");
    const product = join(root, "product");
    mkdirSync(product, { recursive: true });
    git(product, "init", "-q", "--initial-branch=main");
    git(product, "config", "user.name", "Fixture");
    git(product, "config", "user.email", "fixture@example.com");
    writeFileSync(join(product, "README.md"), "# app\n");
    git(product, "add", "README.md");
    git(product, "commit", "-qm", "init");
    const baseline = git(product, "rev-parse", "HEAD");
    git(product, "clone", "--bare", "-q", product, origin);

    const mirrorPath = join(root, "mirror.git");
    git(root, "clone", "--bare", "-q", origin, mirrorPath);
    const mirror = new BareMirror(mirrorPath, origin);
    await mirror.fetchBranch("main");

    const priorAuthor = process.env.GIT_AUTHOR_NAME;
    const priorEmail = process.env.GIT_AUTHOR_EMAIL;
    process.env.GIT_AUTHOR_NAME = "Somebody Else";
    process.env.GIT_AUTHOR_EMAIL = "somebody@example.com";
    try {
      const worktree = join(root, "evidence-wt");
      const ballotPath = ".plans/issue-1/ballot-codex.json";
      const ballotBytes = serializeCanonicalJson({
        protocolVersion: 2,
        artifact: "plan-ballot",
        choice: "codex"
      });
      const commitSha = await createEvidenceCommit({
        mirror,
        worktreePath: worktree,
        parentSha: baseline,
        files: [{ path: ballotPath, content: ballotBytes }],
        message: evidenceCommitMessage("plan-ballot-batch", 1, null)
      });
      expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
      const author = git(mirrorPath, "log", "-1", "--format=%an <%ae>", commitSha);
      expect(author).toBe(`${COORDINATOR_EVIDENCE_AUTHOR.name} <${COORDINATOR_EVIDENCE_AUTHOR.email}>`);
      const parent = git(mirrorPath, "rev-parse", `${commitSha}^`);
      expect(parent).toBe(baseline);
      const tree = git(mirrorPath, "ls-tree", "-r", "--name-only", commitSha);
      expect(tree.split("\n")).toContain(ballotPath);
      expect(existsSync(worktree)).toBe(false);

      const conflict = reconcileEvidencePublication({
        commitSha,
        parentSha: baseline,
        remoteTip: "c".repeat(40)
      });
      expect(conflict).toEqual({ outcome: "conflict", remoteTip: "c".repeat(40) });
    } finally {
      if (priorAuthor === undefined) delete process.env.GIT_AUTHOR_NAME;
      else process.env.GIT_AUTHOR_NAME = priorAuthor;
      if (priorEmail === undefined) delete process.env.GIT_AUTHOR_EMAIL;
      else process.env.GIT_AUTHOR_EMAIL = priorEmail;
    }
  }, 30_000);
});
