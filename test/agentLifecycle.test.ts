import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLifecycleObservation,
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
import { classifyFailure, claudeWindows, redactDiagnostic } from "../src/resourceEvidence.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const now = "2026-08-18T00:00:00.000Z";
const later = "2026-08-18T00:00:45.000Z";
const actionId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);

const entry = () => initialAgentLifecycle(["codex"], now).agents.codex!;

describe("agent lifecycle policy", () => {
  it("correlates bounded failure evidence without letting telemetry renew activity or freshness", () => {
    const accepted = { ...entry(), sessionId: "session", execution: "working" as const,
      action: { actionId, actionDigest: digest, delivery: "accepted" as const, orderedAt: now, injectedAt: now,
        retryableInjectionAt: null, acceptedAt: now, sessionId: "session", turnId: "turn", lastNudgedIdleEpoch: 0, workflowCompleteAt: null } };
    const windows = claudeWindows({ five_hour: { used_percentage: 100, resets_at: Date.parse(later) / 1000 + 100 } });
    const telemetry = { kind: "telemetry" as const, eventName: "status-line", sessionId: "session", windows };
    const cached = applyLifecycleObservation(accepted, telemetry, now);
    expect(cached.lastEventAt).toBe(accepted.lastEventAt);
    expect(cached.execution).toBe("working");
    expect(applyLifecycleObservation(cached, telemetry, later)).toBe(cached);
    const failure = { kind: "failed" as const, eventName: "StopFailure", sessionId: "session", turnId: "turn",
      failure: { vendor: "claude" as const, error: "rate_limit", error_details: "resets 3:45pm Bearer sensitive-token" } };
    const advisory = applyLifecycleObservation(cached, { ...failure, turnId: undefined }, later);
    expect(advisory.lastFailure?.confirmed).toBe(false);
    expect(advisory.lastFailure?.evidence.resetsAt).toBeNull();
    expect(advisory.execution).toBe("working");
    expect(advisory.lastEventAt).toBe(cached.lastEventAt);
    const failed = applyLifecycleObservation(cached, failure, later);
    expect(failed.lastFailure?.evidence).toMatchObject({ failureClass: "usage-window", deadlineConfidence: "exact" });
    expect(failed.lastFailure?.evidence.error_details).not.toContain("sensitive-token");
    expect(applyLifecycleObservation(failed, failure, later)).toBe(failed);
    expect(applyLifecycleObservation(cached, { ...failure, sessionId: "other" }, later)).toBe(cached);
    expect(applyLifecycleObservation(cached, { ...failure, turnId: "old" }, later)).toBe(cached);
    const stale = applyLifecycleObservation(cached, failure, "2026-08-18T01:00:00.000Z");
    expect(stale.lastFailure?.evidence.resetsAt).toBeNull();
    const cancelled = applyLifecycleObservation(cached, { ...failure, failure: { vendor: "cursor", error: "aborted" } }, later);
    expect(cancelled.lastFailure?.evidence.failureClass).toBe("cancelled");
    expect(applyLifecycleObservation(cancelled, failure, later)).toBe(cancelled);
  });

  it("keeps failure classes distinct and never parses rendered reset clocks or family deadlines", () => {
    const cases = [["authentication_failed", "auth-account"], ["billing_error", "billing"], ["server_error", "transport"],
      ["invalid_request", "context-overflow"], ["rate_limit", "unknown"], ["429", "unknown"], ["cancelled", "cancelled"]];
    for (const [error, expected] of cases) {
      expect(classifyFailure({ vendor: "claude", error, error_details: "prompt too long; resets 3:45pm" }, [], now))
        .toMatchObject({ failureClass: expected, resetsAt: null });
    }
    const windows = claudeWindows({ five_hour: { used_percentage: 100, resets_at: 2000000000 } });
    expect(classifyFailure({ vendor: "claude", error: "rate_limit", last_assistant_message: "Opus limit" }, windows, now).resetsAt).toBeNull();
    const redacted = redactDiagnostic("person@example.test https://test.invalid/?secret=abc sk-secret-token\u001b[31m");
    expect(redacted).not.toMatch(/person@|secret/);
    expect(redacted).not.toContain(String.fromCharCode(27));
    expect(redactDiagnostic("x ".repeat(10000))!.length).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(redactDiagnostic("🙂".repeat(3000))!)).toBeLessThanOrEqual(2048);
  });
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
