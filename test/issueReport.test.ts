import { describe, expect, it } from "vitest";
import { renderIssueReport } from "../src/issueReport.js";
import { initialAgentLifecycle } from "../src/agentLifecycle.js";
import type { CursorsState, StartState } from "../src/state.js";

const pin = "f".repeat(40);
const impl = "e".repeat(40);

it("reports unknown runtime containment rather than inferring it from installation", () => {
  const text = renderIssueReport(start("owner-only"), complete(), initialAgentLifecycle(["cursor"]));
  expect(text).toContain("git guard hook=unverified shim=unverified (no hook has reported from this agent's session yet)");
  // Unknown coverage is never presented as OK.
  expect(text).toContain("[WAIT] Agent cursor:");
});

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
    evidence: {
      branch: "issue-1/coordinator-evidence",
      tip: "d".repeat(40)
    },
    paused: false,
    manualPaused: false,
    holds: [],
    actionSafety: {},
    resourceBindingChecks: {},
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
    acceptedResponses: [],
    ballotBatches: [],
    updatedAt: "2026-08-13T00:00:00.000Z"
  }) as CursorsState;

describe("issue report", () => {
  it("reports unknown holds and scoped recovery without implying capacity or auto-resume", () => {
    const cursors = complete();
    cursors.completed = false; cursors.paused = true; cursors.manualPaused = true;
    cursors.holds = [{ id: "hold-id", agent: "cursor", actionId: "action-id", sessionId: null,
      reason: "nudge-loop", evidenceId: "budget", observedAt: cursors.updatedAt, resetsAt: null,
      confidence: "unknown", retryOwner: "owner", evidence: null }];
    const text = renderIssueReport(start("owner-only"), cursors);
    expect(text).toContain("[ACTION] Issue 1: paused — finalizing the pull request commit (R7.finalize)");
    expect(text).toContain("Next for you: inspect each held agent below, then release its hold.");
    expect(text).toContain("Manual pause: on (coord resume --issue 1 --coord-root '/runtime' clears only this pause)");
    expect(text).toContain("Hold hold-id: cursor — automatic reminder limit reached");
    expect(text).toContain("Who acts next: you.");
    expect(text).toContain("then allow it 4 more automatic sends (press r in the coord terminal, or run: " +
      "coord resume --issue 1 --agent cursor --reset-nudge-budget --coord-root '/runtime')");
    expect(text).toContain("add --run to resume only if the coordinator was stopped");
    // Unknown evidence is omitted, never presented as a cause or a capacity claim.
    expect(text).not.toContain("cause unknown");
    expect(text).not.toContain("quota exhausted");
    cursors.holds.push({ ...cursors.holds[0]!, id: "another-hold" });
    const ambiguous = renderIssueReport(start("owner-only"), cursors);
    expect(ambiguous).not.toContain("--agent cursor");
    expect(ambiguous).toContain("--hold hold-id --reset-nudge-budget");
    expect(ambiguous).toContain("--hold another-hold --reset-nudge-budget");
  });
  it("separates cause, exact recheck time, blocked windows and redacted detail from owner release", () => {
    const cursors = complete();
    cursors.completed = false; cursors.paused = true;
    cursors.activeRoster = ["codex"];
    const window = { source: "codex-app-server" as const, limitId: "codex", window: "secondary" as const,
      usedPercent: 100, windowDurationMins: 10_080, resetsAt: "2026-08-20T00:00:00.000Z" };
    const evidence = { vendor: "codex" as const, failureClass: "usage-window" as const, classConfidence: "confirmed" as const,
      windows: [window], detail: "limit for Bearer [redacted]", episodeId: "a:codex", observedAt: cursors.updatedAt };
    cursors.holds = [{ id: "exact", agent: "codex", actionId: "action-id", sessionId: null, reason: "vendor-failure",
      evidenceId: "e", observedAt: cursors.updatedAt, resetsAt: window.resetsAt, confidence: "exact", retryOwner: "owner", evidence }];
    const safety = { actionId: "action-id", sends: 1, lastSendAt: null, reserved: false, deferrals: [], holdGeneration: 0,
      observationChecks: 0, nextObservationAt: null, activityAt: cursors.updatedAt,
      resource: { starts: 2, failures: 0, inFlight: null, nextAt: "2026-08-20T00:00:30.000Z", consumedDeadlines: [], terminal: null, episode: null } };
    cursors.actionSafety = { codex: safety };
    let text = renderIssueReport(start("owner-only"), cursors);
    expect(text).toContain("Cause: usage-window reported by codex (confirmed).");
    expect(text).toContain("Provider recheck time: 2026-08-20T00:00:00.000Z (when coord looks again; not a promise the limit has lifted, " +
      "and you cannot reset a provider limit).");
    expect(text).toContain("Blocked windows: codex/secondary 100% (resets 2026-08-20T00:00:00.000Z).");
    expect(text).toContain("Vendor detail (redacted): limit for Bearer [redacted]");
    expect(text).toContain("next automatic check at 2026-08-20T00:00:30.000Z; quota reads 2/6");
    cursors.actionSafety = { codex: { ...safety, resource: { ...safety.resource, nextAt: null, terminal: "no exact provider deadline" } } };
    text = renderIssueReport(start("owner-only"), cursors);
    expect(text).toContain("stopped (no exact provider deadline); owner release required.");
    expect(text).toContain("then release this hold (press r in the coord terminal, or run: coord resume --issue 1 --agent codex --coord-root '/runtime')");
  });

  it("names the pin, published branch, and that the owner merges", () => {
    const text = renderIssueReport(start("coord-open-unmerged"), complete());
    expect(text).toContain("[OK] Issue 1: complete");
    expect(text).toContain("Pull request handling: coord opens a draft pull request; you review and merge it (policy coord-open-unmerged).");
    expect(text).toContain("Chosen agent: cursor");
    expect(text).toContain(`Implementation commit: ${impl}`);
    expect(text).toContain(`Final commit (PR head): ${pin}`);
    expect(text).toContain("Published branch: issue-1/cursor-final");
    expect(text).toContain("Pull request: https://github.com/example/project/pull/9");
    expect(text).toContain("owner merges");
    expect(text).toContain("Evidence branch: issue-1/coordinator-evidence");
    expect(text).toContain(`latest published tip ${"d".repeat(40)}`);
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
    expect(text).toContain(`Final commit (PR head): ${pin}`);
    expect(text).toContain("legacy owner-only");
    expect(text).toContain("not from issue-1/<agent>");
  });

  it("reports when the evidence branch has not been published yet", () => {
    const withoutEvidence = {
      ...complete(),
      evidence: { branch: null, tip: null }
    };
    expect(renderIssueReport(start("coord-open-unmerged"), withoutEvidence)).toContain(
      "Evidence branch: (none yet)"
    );
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
      "[WAIT] Agent cursor: no action yet; input queued in its terminal; hooks healthy, pending=2, background-active"
    );
  });

  it("frames the whole snapshot and says when nothing is needed from the owner", () => {
    const cursors = complete({ status: "not-required", finalSha: null, branch: null, url: null, attempts: 0 });
    cursors.completed = false;
    cursors.issueCursor = { stepId: "R4.implement", gateId: "gate-4-implementations", round: null } as CursorsState["issueCursor"];
    cursors.acceptedResponses = [{ stepId: "R3.plan-ballot", agent: "cursor", actionId: "10000000-0000-4000-8000-000000000001",
      round: null, responseSha256: "9".repeat(64), rationale: "private rationale", choice: "cursor",
      path: ".plans/issue-1/ballot-cursor.json", acceptedAt: "2026-08-13T00:00:00.000Z" }];
    const text = renderIssueReport(start("coord-open-unmerged"), cursors, initialAgentLifecycle(["cursor"]));
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("----");
    expect(lines.at(-1)).toBe("----");
    expect(lines.filter((line) => line === "----")).toHaveLength(2);
    expect(lines[1]).toBe("[WAIT] Issue 1: implementing (R4.implement)");
    expect(text).toContain("Next for you: nothing; agents are working and coord continues by itself.");
    expect(text).toContain("Active agents: cursor");
    expect(text).not.toContain("private rationale");
    cursors.ownerQuestion = { id: "q-1", kind: "ballot-escalation", round: 2, allowedAnswers: ["retry", "abandon"],
      createdAt: "2026-08-13T00:00:00.000Z" };
    expect(renderIssueReport(start("coord-open-unmerged"), cursors)).toContain("[ACTION] Issue 1: implementing (R4.implement)");
  });

  it("quotes the runtime path in printed commands", () => {
    const cursors = complete();
    cursors.completed = false; cursors.paused = true; cursors.manualPaused = true;
    const text = renderIssueReport({ ...start("owner-only"), coordRoot: "/run time/o'brien" }, cursors);
    expect(text).toContain(`coord resume --issue 1 --coord-root '/run time/o'"'"'brien' clears only this pause`);
  });

  it("warns on an agent whose Stop hook never reaches the issue", () => {
    const lifecycle = initialAgentLifecycle(["cursor"], "2026-08-13T00:00:00.000Z");
    lifecycle.agents.cursor = { ...lifecycle.agents.cursor!, sessionId: "s1",
      stopObservation: { sessionId: "s1", lastStopAt: null, unstoppedTurns: ["t1", "t2"], unstoppedActions: [] } };
    const text = renderIssueReport(start("coord-open-unmerged"), complete(), lifecycle);
    expect(text).toContain("[WARN] Agent cursor:");
    expect(text).toContain("  Warning: No Stop hook from cursor after 2 observed turns.");
    expect(text).toContain("COORD_ISSUE=1");
  });
});
