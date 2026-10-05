import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentLifecycleStateSchema,
  applyLifecycleObservation,
  containmentCoverage,
  decideLifecycleNudge,
  initialAgentLifecycle,
  initializeAgentLifecycle,
  markActionInjected,
  markActionWorkflowComplete,
  markObservabilityDegraded,
  observeAgentLifecycleWithResult,
  orderAgentAction,
  readAgentLifecycle
} from "../src/agentLifecycle.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const now = "2026-08-18T00:00:00.000Z";
const later = "2026-08-18T00:00:45.000Z";
const actionId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);

const entry = () => initialAgentLifecycle(["codex"], now).agents.codex!;

describe("containment coverage", () => {
  const probe = { shim: "active" as const, resolvedGit: "/c/.coord/bin/git", issueEnv: true, delegateEnv: false };
  it("adopts lifecycle files written before containment evidence existed", () => {
    const legacy = initialAgentLifecycle(["codex"], now) as unknown as { agents: Record<string, Record<string, unknown>> };
    delete legacy.agents.codex!.containment;
    const parsed = agentLifecycleStateSchema.parse(legacy);
    expect(containmentCoverage(parsed.agents.codex!)).toEqual({ hook: "unverified", shim: "unverified" });
  });

  it("does not credit a deny issued under a different shim policy", () => {
    const base = { ...entry(), sessionId: "s1" };
    const covered = (denialRevision: string) =>
      containmentCoverage({
        ...base,
        containment: {
          hookDenial: { sessionId: "s1", vendorVersion: null, policyRevision: denialRevision, at: now },
          refusalRan: null,
          probe: { ...probe, sessionId: "s1", policyRevision: "rev-2", at: later }
        }
      });
    expect(covered("rev-2")).toEqual({ hook: "active", shim: "active" });
    expect(covered("rev-1")).toEqual({ hook: "inactive", shim: "active" });
  });
});

describe("agent lifecycle policy", () => {
  it("correlates an exact prompt and never treats injection as acceptance", () => {
    const injected = {
      ...entry(),
      action: {
        actionId,
        actionDigest: digest,
        delivery: "injected" as const,
        orderedAt: now,
        injectedAt: now,
        retryableInjectionAt: null,
        acceptedAt: null,
        sessionId: null,
        turnId: null,
        lastNudgedIdleEpoch: 0,
        workflowCompleteAt: null
      }
    };
    const accepted = applyLifecycleObservation(
      injected,
      {
        kind: "prompt-submitted",
        eventName: "UserPromptSubmit",
        sessionId: "session-1",
        turnId: "turn-1",
        actionId,
        actionDigest: digest
      },
      later
    );
    expect(accepted.action).toMatchObject({ delivery: "accepted", sessionId: "session-1", turnId: "turn-1" });
    expect(accepted.execution).toBe("working");
    expect(accepted.health).toBe("healthy");
  });

  it("keeps queued and background-active work ineligible", () => {
    const queued = applyLifecycleObservation(entry(), {
      kind: "status",
      eventName: "status-line",
      sessionId: "agy-1",
      execution: "queued",
      pendingInputCount: 2,
      backgroundActive: true
    });
    const withAction = {
      ...queued,
      action: {
        actionId,
        actionDigest: digest,
        delivery: "injected" as const,
        orderedAt: now,
        injectedAt: now,
        retryableInjectionAt: null,
        acceptedAt: null,
        sessionId: null,
        turnId: null,
        lastNudgedIdleEpoch: 0,
        workflowCompleteAt: null
      }
    };
    expect(decideLifecycleNudge(withAction, actionId, digest)).toEqual({ kind: "wait", reason: "pending-input", code: "pending-input" });
    const failedPriorTurn = applyLifecycleObservation(withAction, {
      kind: "failed",
      eventName: "StopFailure",
      sessionId: "agy-1"
    });
    expect(failedPriorTurn.execution).toBe("queued");
  });

  it("lets Antigravity fully-idle Stop end an injected action without a prompt-submit hook", () => {
    const injected = {
      ...entry(),
      execution: "working" as const,
      sessionId: "agy-1",
      action: {
        actionId,
        actionDigest: digest,
        delivery: "injected" as const,
        orderedAt: now,
        injectedAt: now,
        retryableInjectionAt: null,
        acceptedAt: null,
        sessionId: null,
        turnId: null,
        lastNudgedIdleEpoch: 0,
        workflowCompleteAt: null
      }
    };
    const stopped = applyLifecycleObservation(injected, {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "agy-1",
      backgroundActive: false,
      allowInjectedIdle: true
    });
    expect(stopped.execution).toBe("idle");
    expect(decideLifecycleNudge(stopped, actionId, digest).kind).toBe("send");
  });

  it("keeps queue and activity fields from a session-replacing status payload", () => {
    const prior = applyLifecycleObservation(entry(), {
      kind: "status",
      eventName: "status-line",
      sessionId: "old-session",
      execution: "idle",
      pendingInputCount: 0,
      backgroundActive: false
    });
    const next = applyLifecycleObservation(prior, {
      kind: "status",
      eventName: "status-line",
      sessionId: "new-session",
      execution: "queued",
      pendingInputCount: 2,
      backgroundActive: true
    });
    expect(next).toMatchObject({
      sessionId: "new-session",
      execution: "queued",
      pendingInputCount: 2,
      backgroundActive: true
    });
  });

  it("allows one nudge for each positive transition into idle", () => {
    const working = {
      ...entry(),
      execution: "working" as const,
      action: {
        actionId,
        actionDigest: digest,
        delivery: "accepted" as const,
        orderedAt: now,
        injectedAt: now,
        retryableInjectionAt: null,
        acceptedAt: now,
        sessionId: "session-1",
        turnId: "turn-1",
        lastNudgedIdleEpoch: 0,
        workflowCompleteAt: null
      }
    };
    const idle = applyLifecycleObservation(working, {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "turn-1",
      backgroundActive: false
    });
    expect(idle.idleEpoch).toBe(1);
    expect(decideLifecycleNudge(idle, actionId, digest).kind).toBe("send");
    const used = { ...idle, action: { ...idle.action!, lastNudgedIdleEpoch: idle.idleEpoch } };
    expect(decideLifecycleNudge(used, actionId, digest)).toEqual({
      kind: "wait",
      reason: "idle-transition-already-used",
      code: "idle-transition-already-used"
    });
    const duplicateStop = applyLifecycleObservation(idle, {
      kind: "stopped",
      eventName: "Stop",
      sessionId: "session-1",
      turnId: "turn-1",
      backgroundActive: false
    });
    expect(duplicateStop.idleEpoch).toBe(1);
  });

  it("rejects a stale stop after a session replacement", () => {
    const current = applyLifecycleObservation(entry(), {
      kind: "session-start",
      eventName: "SessionStart",
      sessionId: "new-session"
    });
    expect(
      applyLifecycleObservation(current, {
        kind: "stopped",
        eventName: "Stop",
        sessionId: "old-session"
      })
    ).toBe(current);
  });

  it("binds failure evidence only to the accepted current episode and never lets telemetry establish a session", () => {
    const failure = { vendor: "claude" as const, error: "billing_error", errorDetails: null, lastAssistantMessage: null };
    const action = { actionId, actionDigest: digest, delivery: "injected" as const, orderedAt: now, injectedAt: now,
      retryableInjectionAt: null, acceptedAt: null, sessionId: null, turnId: null, lastNudgedIdleEpoch: 0, workflowCompleteAt: null };
    const started = applyLifecycleObservation({ ...entry(), action }, { kind: "session-start", eventName: "SessionStart", sessionId: "s1" }, now);
    // Injected but never accepted: the failure is advisory only.
    const advisory = applyLifecycleObservation(started, { kind: "failed", eventName: "StopFailure", sessionId: "s1", failure }, later);
    expect(advisory.lastFailure).toMatchObject({ actionId: null, evidence: { failureClass: "billing" } });
    const accepted = applyLifecycleObservation(started, { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "s1",
      turnId: "t1", actionId, actionDigest: digest }, now);
    const failed = applyLifecycleObservation(accepted, { kind: "failed", eventName: "StopFailure", sessionId: "s1", failure }, later);
    expect(failed.lastFailure).toMatchObject({ actionId, sessionId: "s1", evidence: { episodeId: `${actionId}:s1:t1:billing` } });
    // A retired session's failure and a foreign render change nothing.
    const replaced = applyLifecycleObservation(failed, { kind: "session-start", eventName: "SessionStart", sessionId: "s2" }, later);
    expect(applyLifecycleObservation(replaced, { kind: "failed", eventName: "StopFailure", sessionId: "s1", failure }, later)).toBe(replaced);
    const rateLimits = { fiveHour: null, sevenDay: { source: "claude-statusline" as const, limitId: "seven_day", window: "seven_day" as const,
      usedPercent: 100, windowDurationMins: 10_080, resetsAt: later } };
    expect(applyLifecycleObservation(entry(), { kind: "telemetry", eventName: "status-line", sessionId: "s2", rateLimits }, later)).toEqual(entry());
    const observed = applyLifecycleObservation(replaced, { kind: "telemetry", eventName: "status-line", sessionId: "s2", rateLimits }, later);
    expect(observed).toMatchObject({ lastEventAt: replaced.lastEventAt, execution: replaced.execution, idleEpoch: replaced.idleEpoch,
      claudeRateLimits: { sessionId: "s2", observedAt: later } });
  });

  it("rejects stale prompt and work events after a session replacement", () => {
    const previous = applyLifecycleObservation(entry(), {
      kind: "session-start",
      eventName: "SessionStart",
      sessionId: "old-session"
    });
    const current = applyLifecycleObservation(previous, {
      kind: "session-start",
      eventName: "SessionStart",
      sessionId: "new-session"
    });
    expect(current.retiredSessionIds).toEqual(["old-session"]);
    for (const observation of [
      {
        kind: "prompt-submitted" as const,
        eventName: "UserPromptSubmit",
        sessionId: "old-session",
        turnId: "old-turn",
        actionId,
        actionDigest: digest
      },
      { kind: "working" as const, eventName: "PreInvocation", sessionId: "old-session" }
    ]) {
      expect(applyLifecycleObservation(current, observation)).toBe(current);
    }
    expect(
      applyLifecycleObservation(current, {
        kind: "status",
        eventName: "status-line",
        sessionId: "old-session",
        execution: "idle"
      })
    ).toBe(current);
  });

  it("persists injection and degrades missing observations without authorizing a resend", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    markActionInjected(paths, "codex", actionId, digest, now);
    const degraded = markObservabilityDegraded(paths, "codex", later, 45_000);
    expect(degraded.changed).toBe(true);
    const persisted = readAgentLifecycle(paths).agents.codex!;
    expect(persisted).toMatchObject({ health: "degraded", action: { delivery: "injected" } });
    expect(decideLifecycleNudge(persisted, actionId, digest)).toEqual({ kind: "wait", reason: "unknown", code: "unknown" });
  });

  it("classifies a degrade as correlation lag unless no session was ever announced", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    markActionInjected(paths, "codex", actionId, digest, now);
    // No SessionStart has ever arrived: restarting the CLI is the right remedy.
    expect(markObservabilityDegraded(paths, "codex", later, 45_000)).toMatchObject({
      changed: true,
      cause: "hooks-never-seen"
    });
    expect(readAgentLifecycle(paths).agents.codex!.degradedCause).toBe("hooks-never-seen");

    const second = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(second);
    const other = issueRuntimePaths(second, 1);
    createIssueRuntime(other, ["codex"]);
    initializeAgentLifecycle(other, ["codex"], now);
    // The session announced itself before this delivery, so hooks are live and
    // the watchdog can only be reporting that *this* send has not correlated.
    observeAgentLifecycleWithResult(
      other,
      "codex",
      { kind: "session-start", eventName: "SessionStart", sessionId: "session-1" },
      "2026-08-17T23:59:00.000Z"
    );
    orderAgentAction(other, "codex", actionId, digest, now);
    markActionInjected(other, "codex", actionId, digest, now);
    // Hooks are live; the watchdog only proves this send has not correlated yet.
    expect(markObservabilityDegraded(other, "codex", later, 45_000)).toMatchObject({
      changed: true,
      cause: "correlation-lagged"
    });
  });

  it("never degrades an action whose work already reached the workflow", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    markActionInjected(paths, "codex", actionId, digest, now);
    markActionWorkflowComplete(paths, "codex", actionId, now);
    const far = "2026-08-18T01:00:00.000Z";
    expect(markObservabilityDegraded(paths, "codex", far, 45_000)).toMatchObject({
      changed: false,
      cause: null
    });
    expect(readAgentLifecycle(paths).agents.codex!.health).not.toBe("degraded");
  });

  it("clears a degraded alert when the workflow proves the delivery worked", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    markActionInjected(paths, "codex", actionId, digest, now);
    expect(markObservabilityDegraded(paths, "codex", later, 45_000).changed).toBe(true);
    const cleared = markActionWorkflowComplete(paths, "codex", actionId, later);
    expect(cleared.clearedDegraded).toBe(true);
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({
      health: "healthy",
      degradedCause: null
    });
    // A healthy entry reports no retraction to make.
    expect(markActionWorkflowComplete(paths, "codex", actionId, later).clearedDegraded).toBe(false);
  });

  it("gives every wait a stable code", () => {
    const base = entry();
    expect(decideLifecycleNudge(base, actionId, digest).code).toBe("unmatched-action");
    const queued = {
      ...base,
      execution: "queued" as const,
      action: {
        actionId,
        actionDigest: digest,
        delivery: "injected" as const,
        orderedAt: now,
        injectedAt: now,
        retryableInjectionAt: null,
        acceptedAt: null,
        sessionId: null,
        turnId: null,
        lastNudgedIdleEpoch: 0,
        workflowCompleteAt: null
      }
    };
    expect(decideLifecycleNudge(queued, actionId, digest).code).toBe("queued");
    expect(decideLifecycleNudge({ ...queued, execution: "working" }, actionId, digest).code).toBe("working");
    expect(
      decideLifecycleNudge({ ...queued, action: { ...queued.action, workflowCompleteAt: now } }, actionId, digest).code
    ).toBe("workflow-complete");
    expect(decideLifecycleNudge(queued, actionId, "b".repeat(64)).code).toBe("unmatched-action");
  });

  it("does not rewrite lifecycle state for duplicate status-line renders", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["antigravity"]);
    initializeAgentLifecycle(paths, ["antigravity"], now);
    const observation = {
      kind: "status" as const,
      eventName: "status-line",
      sessionId: "agy-1",
      execution: "idle" as const,
      pendingInputCount: 0,
      backgroundActive: false
    };
    const first = observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    const second = observeAgentLifecycleWithResult(paths, "antigravity", observation, later);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.state.stateRevision).toBe(first.state.stateRevision);
  });
});
