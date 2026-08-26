import { describe, expect, it } from "vitest";
import { renderIssueReport } from "../src/issueReport.js";
import { initialAgentLifecycle } from "../src/agentLifecycle.js";
import type { CursorsState, StartState } from "../src/state.js";

const pin = "f".repeat(40);
const impl = "e".repeat(40);

const start = (policy: StartState["prPolicy"]): StartState =>
  ({
    formatVersion: 4,
    issue: 1,
    issueSessionId: `issue-1:${"a".repeat(40)}`,
    baselineSha: "a".repeat(40),
    profile: "consensus",
    originalRoster: ["cursor"],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: policy,
    automationDigest: "b".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "b".repeat(64) }],
    trustedSourceCommit: "c".repeat(40),
    origin: "https://github.com/example/project.git",
    coordRoot: "/runtime",
    configPath: "/runtime/config.json",
    agents: [{ id: "cursor", root: "/c", launcher: "start-cursor.sh", delivery: "pull" }],
    checks: [{ name: "check", argv: ["true"] }],
    pollIntervalMs: 1000,
    contextPaths: [],
    createdAt: "2026-08-13T00:00:00.000Z"
  }) as StartState;

const complete = (overrides: Partial<CursorsState["publication"]> = {}): CursorsState =>
  ({
    formatVersion: 4,
    stateRevision: 1,
    issueCursor: { stepId: "R7.finalize", gateId: "gate-7-finalized", round: null },
    activeRoster: ["cursor"],
    responses: [],
    ballotBatches: [],
    evidence: { branch: null, tip: null },
    droppedAgents: [],
    derived: {
      planSelection: null,
      implementationSelection: {
        kind: "implementation-selection",
        algorithm: "plurality-active-roster-v1",
        inputSetHash: "b".repeat(64),
        activeRoster: ["cursor"],
        inputs: [
          {
            source: "git-submission" as const,
            kind: "implementation",
            agent: "cursor",
            submissionSha: "c".repeat(40),
            path: ".signals/issue-1/implementation-ready-cursor.json",
            productPin: impl
          }
        ],
        decisionId: `implementation-selection:${"b".repeat(64)}`,
        supersedes: null,
        decidedAt: "2026-08-13T00:00:00.000Z",
        winner: "cursor",
        implementationPin: impl,
        reviser: "cursor"
      },
      consensus: null
    },
    ownerQuestion: null,
    lastOwnerAnswer: null,
    publication: {
      status: "completed",
      finalSha: pin,
      branch: "issue-1/cursor-final",
      url: "https://github.com/example/project/pull/9",
      error: null,
      attempts: 1,
      ...overrides
    },
    paused: false,
    abandoned: false,
    completed: true,
    agents: {},
    accepted: [
      {
        stepId: "R7.finalize",
        agent: "cursor",
        round: null,
        submissionSha: "d".repeat(40),
        productPin: pin,
        path: ".signals/issue-1/finalization-ready-cursor.json",
        acceptedAt: "2026-08-13T00:00:00.000Z"
      }
    ],
    updatedAt: "2026-08-13T00:00:00.000Z"
  }) as CursorsState;

describe("issue report", () => {
  it("names the pin, published branch, and that the owner merges", () => {
    const text = renderIssueReport(start("coord-open-unmerged"), complete());
    expect(text).toContain("Issue 1: complete");
    expect(text).toContain("Chosen agent: cursor");
    expect(text).toContain(`Final pin (PR head): ${pin}`);
    expect(text).toContain("Published branch: issue-1/cursor-final");
    expect(text).toContain("Pull request: https://github.com/example/project/pull/9");
    expect(text).toContain("owner merges");
  });

  it("says the coordinator merged under coord-merged", () => {
    const text = renderIssueReport(start("coord-merged"), complete());
    expect(text).toContain("coordinator merged");
  });

  it("tells the owner to PR the final pin when publication was skipped", () => {
    const text = renderIssueReport(
      start("owner-only"),
      complete({ status: "not-required", finalSha: null, branch: null, url: null, attempts: 0 })
    );
    expect(text).toContain(`Final pin (PR head): ${pin}`);
    expect(text).toContain("legacy owner-only");
    expect(text).toContain("not from issue-1/<agent>");
  });

  it("shows delivery, execution, health, queue, and background state", () => {
    const lifecycle = initialAgentLifecycle(["cursor"], "2026-08-13T00:00:00.000Z");
    lifecycle.agents.cursor = {
      ...lifecycle.agents.cursor!,
      execution: "queued",
      health: "healthy",
      pendingInputCount: 2,
      backgroundActive: true
    };
    expect(renderIssueReport(start("coord-open-unmerged"), complete(), lifecycle)).toContain(
      "Agent cursor: none / queued / healthy, pending=2, background-active"
    );
  });
});

describe("ballot evidence in the issue report", () => {
  it("names the evidence branch and tip without leaking any pending judgment", () => {
    const cursors = complete();
    const withEvidence = {
      ...cursors,
      evidence: { branch: "issue-1/coordinator-evidence", tip: "e".repeat(40) },
      responses: [
        {
          stepId: "R3.plan-ballot" as const,
          agent: "cursor",
          actionId: "179da8c7-ae22-47eb-b6eb-211ceea6b732",
          round: null,
          responseSha256: "c".repeat(64),
          choice: "cursor",
          rationale: "a rationale that must not reach ordinary status output",
          acceptedAt: "2026-08-13T00:00:00.000Z"
        }
      ],
      ballotBatches: [
        {
          kind: "plan-ballot-batch" as const,
          stepId: "R3.plan-ballot" as const,
          round: null,
          activeRoster: ["cursor"],
          inputSetHash: "d".repeat(64),
          responseSha256s: ["c".repeat(64)],
          paths: [".plans/issue-1/ballot-cursor.json"],
          branch: "issue-1/coordinator-evidence",
          parentSha: "a".repeat(40),
          commitSha: "e".repeat(40),
          status: "published" as const,
          attempts: 0,
          error: null,
          supersedes: null,
          createdAt: "2026-08-13T00:00:00.000Z",
          publishedAt: "2026-08-13T00:00:00.000Z"
        }
      ]
    } as CursorsState;

    const report = renderIssueReport(start("coord-open-unmerged"), withEvidence);
    expect(report).toContain("Evidence branch: issue-1/coordinator-evidence");
    expect(report).toContain(`Evidence tip: ${"e".repeat(40)}`);
    expect(report).toContain("Ballot evidence commits: 1");
    // Judgment is never ordinary status output, published or not.
    expect(report).not.toContain("must not reach ordinary status output");
    expect(report).not.toContain("choice");
  });

  it("says nothing has been published yet when no batch has reached origin", () => {
    const report = renderIssueReport(start("coord-open-unmerged"), complete());
    expect(report).toContain("Evidence tip: (nothing published yet)");
    expect(report).toContain("Ballot evidence commits: 0");
  });
});
