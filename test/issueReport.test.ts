import { describe, expect, it } from "vitest";
import { renderIssueReport } from "../src/issueReport.js";
import { initialAgentLifecycle } from "../src/agentLifecycle.js";
import { emptyResourceObservation, type CursorsState, type StartState } from "../src/state.js";

const pin = "f".repeat(40);
const impl = "e".repeat(40);

it("reports unknown runtime containment rather than inferring it from installation", () => {
  expect(renderIssueReport(start("owner-only"), complete(), initialAgentLifecycle(["cursor"])))
    .toContain("containment hook=unverified shim=unverified (session identity unavailable)");
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
    expect(text).toContain("Manual pause: active");
    expect(text).toContain("No provider failure confirmed; provider recovery time unknown. Who acts next: you.");
    expect(text).toContain("coord resume --issue 1 --agent cursor --reset-nudge-budget");
    expect(text).toContain("coord resume --issue 1 --coord-runtime '/runtime' clears only this pause");
    expect(text).toContain("add --run to resume only if the coordinator was stopped");
    expect(text).toContain("Hold hold-id:");
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
    expect(text).toContain("cause usage-window (codex, confirmed); provider reset 2026-08-20T00:00:00.000Z (recheck time, not guaranteed availability)");
    expect(text).toContain("Blocked windows: codex/secondary 100% (resets 2026-08-20T00:00:00.000Z).");
    expect(text).toContain("Vendor detail (redacted): limit for Bearer [redacted]");
    expect(text).toContain("next automatic check at 2026-08-20T00:00:30.000Z; quota reads 2/6");
    cursors.actionSafety = { codex: { ...safety, resource: { ...safety.resource, nextAt: null, terminal: "no exact provider deadline" } } };
    text = renderIssueReport(start("owner-only"), cursors);
    expect(text).toContain("stopped (no exact provider deadline); owner release required.");
    expect(text).toContain("coord resume --issue 1 --agent codex");
  });

  it("names the pin, published branch, and that the owner merges", () => {
    const text = renderIssueReport(start("coord-open-unmerged"), complete());
    expect(text).toContain("Issue 1: complete");
    expect(text).toContain("Chosen agent: cursor");
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
      "Agent cursor: no current task; input queued; activity reports healthy, pending=2, background-active"
    );
  });

  it("frames the whole report and quotes recovery paths without changing control vocabulary", () => {
    const cursors = complete();
    cursors.completed = false; cursors.paused = true; cursors.manualPaused = true;
    const text = renderIssueReport({ ...start("owner-only"), coordRoot: "/runtime space/owner's" }, cursors);
    expect(text).toMatch(/^==== coord status: issue 1 ====\n\[ACTION\] Issue 1: paused/);
    expect(text).toContain("--coord-runtime '/runtime space/owner'\"'\"'s'");
    expect(text).toMatch(/Active step: .*\nActive roster: cursor\nQueued guidance: 0\n==== end coord status: issue 1 ====\n$/);
  });
});


it("reports pending/filed follow-ups and authorized-reviser recovery without exposing private ballots", () => {
  const cursors = complete();
  cursors.completed = false;
  cursors.issueCursor = { stepId: "R6.follow-up", gateId: "gate-6-consensus", round: 3 };
  cursors.derived.consensus = { kind: "consensus", algorithm: "revision-limit-active-roster-v1", objectors: ["cursor"],
    inputSetHash: "b".repeat(64), activeRoster: ["cursor"], inputs: cursors.derived.implementationSelection!.inputs,
    decisionId: `consensus:${"b".repeat(64)}:r3`, supersedes: null, decidedAt: cursors.updatedAt, round: 3, consensusPin: pin };
  cursors.droppedAgents = ["claude"];
  let report = renderIssueReport(start("owner-only"), cursors);
  expect(report).toContain("not unanimous approval");
  expect(report).toContain("Follow-up pending: cursor");
  expect(report).toContain("authorized reviser must remain active");
  expect(report).not.toContain("drop cursor");
  expect(report).toContain("historical objections are not approvals or filing receipts");
  cursors.accepted.push({ stepId: "R6.follow-up", agent: "cursor", round: 3, submissionSha: "a".repeat(40), path: ".signals/receipt.json",
    acceptedAt: cursors.updatedAt, followUp: { number: 2, url: "https://github.com/example/project/issues/2", revisionCommitSha: pin } });
  report = renderIssueReport(start("owner-only"), cursors);
  expect(report).toContain("Follow-up filed by cursor: https://github.com/example/project/issues/2");
  expect(report).not.toContain("Follow-up pending");
  cursors.derived.consensus = { ...cursors.derived.consensus, algorithm: "unanimous-active-roster-v1", objectors: undefined };
  cursors.acceptedResponses = [{ stepId: "R6.ballot", round: 3, agent: "claude", disposition: "revise",
    actionId: "10000000-0000-4000-8000-000000000001", responseSha256: "a".repeat(64), rationale: "Historical objection",
    path: "/runtime/claude.json", acceptedAt: cursors.updatedAt }];
  report = renderIssueReport(start("owner-only"), cursors);
  expect(report).toContain("remaining active agents unanimously approved revision 3 after agent drops");
  expect(report).toContain("historical objections remain recorded");
  expect(report).not.toContain("not unanimous approval");
  expect(report).not.toContain("Follow-up pending");
});

it("shows a scrollback wait only while that ordered action is still unanswered", () => {
  const actionId = "10000000-0000-4000-8000-000000000009";
  const observedAt = "2026-08-13T00:00:00.000Z";
  const sentence = "the cursor pane is scrolled back; scroll to the bottom to let coord send";
  const waiting = (): CursorsState => {
    const cursors = complete();
    cursors.completed = false;
    cursors.abandoned = false;
    cursors.paused = false;
    cursors.manualPaused = false;
    cursors.activeRoster = ["cursor"];
    cursors.agents = {
      cursor: {
        lastAcceptedActionId: null,
        stepId: "R4.implement",
        evidenceId: "implementation-pinned",
        actionId,
        submissionMode: "git",
        actionDigest: "a".repeat(64),
        status: "ordered",
        attempt: 1,
        submissionSha: null,
        outstanding: [],
        updatedAt: observedAt
      }
    };
    cursors.actionSafety = {
      cursor: {
        actionId,
        sends: 0,
        lastSendAt: null,
        reserved: false,
        deferrals: ["owner-typing"],
        holdGeneration: 0,
        observationChecks: 0,
        nextObservationAt: null,
        activityAt: observedAt,
        resource: emptyResourceObservation(),
        scrollbackWait: { observedAt, lastReminderAt: observedAt }
      }
    };
    return cursors;
  };
  const active = waiting();
  expect(renderIssueReport(start("owner-only"), active)).toContain(`[WAIT] ${sentence}`);
  expect(renderIssueReport(start("owner-only"), active)).not.toContain("scrolling does not resume");

  const completed = waiting();
  completed.completed = true;
  expect(renderIssueReport(start("owner-only"), completed)).not.toContain(sentence);

  const stale = waiting();
  stale.agents.cursor!.actionId = "10000000-0000-4000-8000-000000000010";
  expect(renderIssueReport(start("owner-only"), stale)).not.toContain(sentence);

  const verifying = waiting();
  verifying.agents.cursor!.status = "verifying";
  expect(renderIssueReport(start("owner-only"), verifying)).not.toContain(sentence);

  const accepted = waiting();
  const lifecycle = initialAgentLifecycle(["cursor"], observedAt);
  lifecycle.agents.cursor!.action = {
    actionId,
    actionDigest: "a".repeat(64),
    delivery: "accepted",
    orderedAt: observedAt,
    injectedAt: observedAt,
    retryableInjectionAt: null,
    acceptedAt: observedAt,
    sessionId: null,
    turnId: null,
    lastNudgedIdleEpoch: null,
    workflowCompleteAt: null
  };
  expect(renderIssueReport(start("owner-only"), accepted, lifecycle)).not.toContain(sentence);

  const elsewhere = waiting();
  elsewhere.activeRoster = ["codex"];
  expect(renderIssueReport(start("owner-only"), elsewhere)).not.toContain(sentence);

  const inferred = waiting();
  delete inferred.actionSafety.cursor!.scrollbackWait;
  expect(renderIssueReport(start("owner-only"), inferred)).not.toContain(sentence);

  const paused = waiting();
  paused.paused = true;
  expect(renderIssueReport(start("owner-only"), paused)).toContain(
    `[WAIT] ${sentence} (last observed ${observedAt}; scrolling does not resume delivery while coord is paused).`
  );
});
