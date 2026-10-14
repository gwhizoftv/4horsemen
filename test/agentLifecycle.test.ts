import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLifecycleObservation,
  agentLifecycleEntrySchema,
  containmentCoverage,
  decideLifecycleNudge,
  initialAgentLifecycle,
  initializeAgentLifecycle,
  markActionInjected,
  markActionWorkflowComplete,
  markObservabilityDegraded,
  observeAgentLifecycleWithResult,
  orderAgentAction,
  readAgentLifecycle,
  rereadPickupPending,
  stopObservationWarning
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

describe("agent lifecycle policy", () => {
  it.each(["stopped", "failed"] as const)("preserves newer work and readiness against an older %s even with pending input", (kind) => {
    const root = mkdtempSync(join(tmpdir(), "coord-handoff-")); roots.push(root);
    const paths = issueRuntimePaths(root, 1); createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    const working = applyLifecycleObservation(readAgentLifecycle(paths).agents.codex!, {
      kind: "prompt-submitted", eventName: "prompt", sessionId: "s", turnId: "new", actionId, actionDigest: digest
    }, now);
    const oldStop = { kind, eventName: "Stop", sessionId: "s", turnId: "old", backgroundActive: false,
      ...(kind === "failed" ? { failure: { vendor: "cursor" as const, status: "aborted",
        error: null, errorDetails: null, lastAssistantMessage: null } } : {}) };
    for (const current of [working, { ...working, pendingInputCount: 1, backgroundActive: true },
      applyLifecycleObservation(working, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "new" }, later),
      applyLifecycleObservation(working, { kind: "failed", eventName: "StopFailure", sessionId: "s", turnId: "new",
        failure: { vendor: "cursor", status: "error", error: null, errorDetails: null, lastAssistantMessage: null } }, later)]) {
      const after = applyLifecycleObservation(current, oldStop, later);
      expect(after).toMatchObject({ execution: current.execution, turnId: current.turnId, action: current.action,
        stoppedAt: current.stoppedAt, idleEpoch: current.idleEpoch, pendingInputCount: current.pendingInputCount,
        backgroundActive: current.backgroundActive });
      if (current.lastFailure?.actionId != null) expect(after.lastFailure).toEqual(current.lastFailure);
      else if (kind === "failed") expect(after.lastFailure?.actionId).toBeNull();
      expect(applyLifecycleObservation(after, oldStop, later)).toEqual(after);
    }
  });

  it("keeps repeated preceding Stops from ending input accepted in the same live turn", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-handoff-")); roots.push(root);
    const paths = issueRuntimePaths(root, 1); createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    observeAgentLifecycleWithResult(paths, "codex", { kind: "prompt-submitted", eventName: "prompt",
      sessionId: "s", turnId: "shared", actionId, actionDigest: digest }, now);
    markActionWorkflowComplete(paths, "codex", actionId, now);
    const nextId = "22222222-2222-4222-8222-222222222222";
    orderAgentAction(paths, "codex", nextId, digest, now);
    markActionInjected(paths, "codex", nextId, digest, now);
    const prompt = { kind: "prompt-submitted" as const, eventName: "prompt", sessionId: "s", turnId: "shared",
      actionId: nextId, actionDigest: digest };
    let current = applyLifecycleObservation(readAgentLifecycle(paths).agents.codex!, prompt, now);
    expect(current.action?.queuedBehindTurnId).toBe("shared");
    current = applyLifecycleObservation(current, prompt, now); // duplicate acceptance must retain the guard
    const epoch = current.idleEpoch;
    for (let i = 0; i < 2; i++) current = applyLifecycleObservation(current, {
      kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "shared"
    }, later);
    current = applyLifecycleObservation(current, { kind: "failed", eventName: "StopFailure", sessionId: "s",
      turnId: "shared", failure: { vendor: "claude", error: "rate_limit", errorDetails: null, lastAssistantMessage: null } }, later);
    expect(current).toMatchObject({ execution: "working", stoppedAt: null, idleEpoch: epoch });
    expect(current.lastFailure?.actionId).toBeNull();
    expect(decideLifecycleNudge(current, nextId, digest).kind).toBe("wait");
    const newPrompt = { ...prompt, turnId: "next" };
    current = applyLifecycleObservation(current, newPrompt, later);
    current = applyLifecycleObservation(current, newPrompt, later); // ordinary duplicate is not queued input
    expect(current.action?.queuedBehindTurnId).toBeUndefined();
    current = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "next" }, later);
    expect(current).toMatchObject({ execution: "idle", idleEpoch: epoch + 1 });
    expect(decideLifecycleNudge(current, nextId, digest).kind).toBe("send");
    const restarted = applyLifecycleObservation({ ...current, action: { ...current.action!, queuedBehindTurnId: "shared", rereadExpected: true } },
      { kind: "session-start", eventName: "SessionStart", sessionId: "new-session" }, later);
    expect(restarted.action?.queuedBehindTurnId).toBeUndefined();
    expect(restarted.action?.rereadExpected).toBeUndefined();
  });

  it("repairs only current queued tool activity and leaves readiness clocks alone on no-op completion callbacks", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-tools-")); roots.push(root);
    const paths = issueRuntimePaths(root, 1); createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    const queued = observeAgentLifecycleWithResult(paths, "codex", { kind: "status", eventName: "status",
      sessionId: "s", turnId: "current", execution: "queued", pendingInputCount: 0 }, now).state.agents.codex!;
    const activity = { kind: "tool-activity" as const, eventName: "postToolUse", sessionId: "s", turnId: "current" };
    for (const observation of [{ ...activity, turnId: "old" }, { ...activity, sessionId: "old" },
      { ...activity, sessionId: undefined }, { ...activity, turnId: undefined }]) {
      expect(applyLifecycleObservation(queued, observation, later)).toBe(queued);
    }
    const repaired = observeAgentLifecycleWithResult(paths, "codex", activity, later);
    expect(repaired.state.agents.codex).toMatchObject({ execution: "working", turnId: "current", idleEpoch: queued.idleEpoch });
    expect(repaired.state.agents.codex.hookReceipt).toEqual(queued.hookReceipt);
    const repeated = observeAgentLifecycleWithResult(paths, "codex", activity, "2026-08-18T00:01:00.000Z");
    expect(repeated.state).toEqual(repaired.state);
    const stopped = applyLifecycleObservation(repaired.state.agents.codex, { kind: "stopped", eventName: "Stop",
      sessionId: "s", turnId: "current" }, later);
    expect(applyLifecycleObservation(stopped, activity, later)).toBe(stopped);
    expect(applyLifecycleObservation(entry(), activity, later)).toEqual(entry());
  });

  it("tracks consecutive reread handoffs without accepting delivery or replaying completion acknowledgments", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-reread-")); roots.push(root);
    const paths = issueRuntimePaths(root, 1); createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    observeAgentLifecycleWithResult(paths, "codex", { kind: "prompt-submitted", eventName: "prompt",
      sessionId: "s", turnId: "live", actionId, actionDigest: digest }, now);
    expect(markActionWorkflowComplete(paths, "codex", actionId, now).pickedUpByReread).toBe(false);
    for (const id of ["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"]) {
      const state = orderAgentAction(paths, "codex", id, digest, later);
      expect(rereadPickupPending(state.agents.codex, id)).toBe(true);
      expect(state.agents.codex.action).toMatchObject({ delivery: "ordered", acceptedAt: null, injectedAt: null });
      const rewritten = orderAgentAction(paths, "codex", id, "b".repeat(64), later);
      expect(rereadPickupPending(rewritten.agents.codex, id)).toBe(true);
      const completed = markActionWorkflowComplete(paths, "codex", id, later);
      expect(completed.pickedUpByReread).toBe(true);
      expect(completed.state.agents.codex.action?.sessionId).toBe("s");
      expect(markActionWorkflowComplete(paths, "codex", id, later).pickedUpByReread).toBe(false);
    }
    observeAgentLifecycleWithResult(paths, "codex", { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "live" }, later);
    const idle = orderAgentAction(paths, "codex", actionId, digest, later).agents.codex;
    expect(rereadPickupPending(idle, actionId)).toBe(false);
    expect(idle.action?.rereadExpected).toBeUndefined();
  });

  it("counts distinct observed turns without treating other hooks or stale Stop as recovery", () => {
    let current = applyLifecycleObservation(entry(), { kind: "session-start", eventName: "SessionStart", sessionId: "s" }, now);
    for (const turnId of ["one", "one", "two"]) current = applyLifecycleObservation(current,
      { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "s", turnId }, later);
    expect(stopObservationWarning("codex", current)).toContain("after 2 observed turns");
    expect(current.execution).toBe("working");
    expect(current.health).toBe("healthy");
    current = applyLifecycleObservation(current, { kind: "working", eventName: "Tool", sessionId: "s" }, later);
    current = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "old", turnId: "two" }, later);
    current = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "one" }, later);
    current = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "one" }, later);
    expect(stopObservationWarning("codex", current)).not.toBeNull();
    current = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "two" }, later);
    expect(stopObservationWarning("codex", current)).toBeNull();
    expect(applyLifecycleObservation(current, { kind: "session-start", eventName: "SessionStart", sessionId: "next" }, later).stopObservation.turns).toEqual([]);
    expect(agentLifecycleEntrySchema.parse({ ...entry(), stopObservation: undefined }).stopObservation.turns).toEqual([]);
  });

  it("counts completed actions separately when turn IDs are absent, and deduplicates completion", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-stop-warning-")); roots.push(root);
    const paths = issueRuntimePaths(root, 1); createIssueRuntime(paths, ["codex"]);
    initializeAgentLifecycle(paths, ["codex"], now);
    for (const id of [actionId, "22222222-2222-4222-8222-222222222222"]) {
      orderAgentAction(paths, "codex", id, digest, now);
      markActionWorkflowComplete(paths, "codex", id, later);
      markActionWorkflowComplete(paths, "codex", id, later);
    }
    const current = readAgentLifecycle(paths).agents.codex!;
    expect(stopObservationWarning("codex", current)).toContain("2 completed actions");
    expect(current.execution).toBe("unknown");
  });
  it("requires a tool-result observation plus a probe denial, and invalidates session/config changes", () => {
    const current = { ...entry(), sessionId: "s" };
    expect(containmentCoverage(current)).toEqual({ hook: "unverified", shim: "unverified" });
    const identity = { sessionId: "s", policyRevision: "policy", binding: digest, at: now };
    const denial = { ...identity, probe: true };
    current.containment = { hookDenial: denial, probe: null };
    expect(containmentCoverage(current).hook).toBe("unverified");
    current.containment.probe = { ...identity, vendorVersion: "1.2.3", resolvedGit: "/clone/.coord/bin/git",
      issueEnv: true, shim: "unverified", toolResult: "unknown" };
    expect(containmentCoverage(current).hook).toBe("unverified");
    current.containment.probe.toolResult = "executed";
    expect(containmentCoverage(current).hook).toBe("inactive");
    current.containment.probe.toolResult = "hook-denied";
    expect(containmentCoverage(current, digest)).toEqual({ hook: "active", shim: "unverified" });
    expect(containmentCoverage(current, "b".repeat(64)).hook).toBe("unverified");
    current.containment.probe.vendorVersion = "unknown";
    expect(containmentCoverage(current).hook).toBe("unverified");
    const restarted = applyLifecycleObservation(current, { kind: "session-start", eventName: "SessionStart", sessionId: "next" }, later);
    expect(restarted.containment).toBeNull();
    expect(containmentCoverage(restarted).hook).toBe("unverified");
    expect(applyLifecycleObservation(current, { kind: "session-end", eventName: "SessionEnd" }, later).containment).toBeNull();
    const legacy = { ...entry(), containment: undefined };
    expect(agentLifecycleEntrySchema.parse(legacy).containment).toBeNull();
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

  it.each([false, true])("lets Stop end an injected action without a submit callback, backgroundActive=%s", (backgroundActive) => {
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
      backgroundActive
    });
    expect(stopped.execution).toBe("idle");
    expect(decideLifecycleNudge(stopped, actionId, digest).kind).toBe("send");
  });

  it("uses a current Stop despite background work and revokes it on a new turn", () => {
    let current = applyLifecycleObservation(entry(), { kind: "session-start", eventName: "SessionStart", sessionId: "s" }, now);
    current = applyLifecycleObservation(current, { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "s", turnId: "new" }, now);
    const oldStop = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "old", backgroundActive: true }, later);
    expect(oldStop.stoppedAt).toBeNull();
    current = applyLifecycleObservation(current, { kind: "stopped", eventName: "Stop", sessionId: "s", turnId: "new", backgroundActive: true }, later);
    expect(current).toMatchObject({ execution: "idle", backgroundActive: true, stoppedAt: later });
    current = applyLifecycleObservation(current, { kind: "status", eventName: "status-line", sessionId: "s", execution: "queued",
      backgroundActive: true, pendingInputCount: 0 }, later);
    expect(current).toMatchObject({ execution: "idle", backgroundActive: true, stoppedAt: later });
    expect(applyLifecycleObservation(current, { kind: "working", eventName: "PreInvocation", sessionId: "s" }, later))
      .toMatchObject({ execution: "working", stoppedAt: null });
    expect(applyLifecycleObservation(current, { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "s", turnId: "next" }, later))
      .toMatchObject({ execution: "working", stoppedAt: null });
    expect(applyLifecycleObservation(current, { kind: "session-start", eventName: "SessionStart", sessionId: "next" }, later).stoppedAt).toBeNull();
    expect(applyLifecycleObservation(current, { kind: "status", eventName: "status-line", sessionId: "s", execution: "queued", pendingInputCount: 1 }, later))
      .toMatchObject({ execution: "queued", stoppedAt: null });
    expect(agentLifecycleEntrySchema.parse({ ...entry(), stoppedAt: undefined }).stoppedAt).toBeNull();
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

  it("deduplicates fully idle status renders even after ordering a new action", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["antigravity"]);
    initializeAgentLifecycle(paths, ["antigravity"], now);
    const observation = { kind: "status" as const, eventName: "status-line", sessionId: "agy-1",
      execution: "idle" as const, pendingInputCount: 0, backgroundActive: false };
    observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    orderAgentAction(paths, "antigravity", actionId, digest, later);
    const before = readAgentLifecycle(paths);
    const duplicate = observeAgentLifecycleWithResult(paths, "antigravity", observation, later);
    expect(duplicate.changed).toBe(false);
    expect(duplicate.state).toEqual(before);
    expect(readAgentLifecycle(paths)).toEqual(before);
    // A new session is not merely another idle render.
    const replacement = observeAgentLifecycleWithResult(paths, "antigravity", { ...observation, sessionId: "agy-2" }, later);
    expect(replacement.changed).toBe(true);
    expect(replacement.state.agents.antigravity.hookReceipt?.sequence).toBe(before.agents.antigravity.hookReceipt!.sequence + 1);
  });

  it.each(["working", "unknown"] as const)("records duplicate %s receipts without inventing semantic activity or counting telemetry", (execution) => {
    const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-"));
    roots.push(root);
    const paths = issueRuntimePaths(root, 1);
    createIssueRuntime(paths, ["antigravity"]);
    initializeAgentLifecycle(paths, ["antigravity"], now);
    const observation = {
      kind: "status" as const,
      eventName: "status-line",
      sessionId: "agy-1",
      execution,
      pendingInputCount: 0,
      backgroundActive: false
    };
    const first = observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    const second = observeAgentLifecycleWithResult(paths, "antigravity", observation, later);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.state.agents.antigravity).toMatchObject({ idleEpoch: first.state.agents.antigravity.idleEpoch,
      lastEventAt: now, hookReceipt: { at: later, sequence: 2 } });
    const sameTime = observeAgentLifecycleWithResult(paths, "antigravity", observation, later);
    expect(sameTime.state.agents.antigravity.hookReceipt).toEqual({ at: later, sequence: 3 });
    const backward = observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    expect(backward.state.agents.antigravity.hookReceipt).toEqual({ at: later, sequence: 4 });
    const telemetry = observeAgentLifecycleWithResult(paths, "antigravity", { kind: "telemetry", eventName: "status-line",
      sessionId: "agy-1", rateLimits: { fiveHour: null, sevenDay: null } }, later);
    expect(telemetry.state.agents.antigravity.hookReceipt).toEqual(backward.state.agents.antigravity.hookReceipt);
    const render = observeAgentLifecycleWithResult(paths, "antigravity", { kind: "telemetry", eventName: "status-line",
      sessionId: "agy-1", rateLimits: { fiveHour: null, sevenDay: null } }, later);
    expect(render.changed).toBe(false);
    expect(render.state.stateRevision).toBe(telemetry.state.stateRevision);
    expect(agentLifecycleEntrySchema.parse({ ...entry(), hookReceipt: undefined }).hookReceipt).toBeNull();
    const restarted = observeAgentLifecycleWithResult(paths, "antigravity", { kind: "session-start", eventName: "SessionStart", sessionId: "next" }, later);
    expect(restarted.state.agents.antigravity.hookReceipt?.sequence).toBe(5);
  });
});
