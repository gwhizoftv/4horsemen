import { describe, expect, it } from "vitest";
import { renderIssueReport } from "../src/issueReport.js";
import { initialAgentLifecycle } from "../src/agentLifecycle.js";
import type { CursorsState, StartState } from "../src/state.js";

const pin = "f".repeat(40);
const impl = "e".repeat(40);

const start = (policy: StartState["prPolicy"]): StartState =>
  ({
    formatVersion: 3,
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
    formatVersion: 3,
    stateRevision: 1,
    issueCursor: { stepId: "R7.finalize", gateId: "gate-7-finalized", round: null },
    activeRoster: ["cursor"],
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
