import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyLifecycleObservation,
  agentLifecycleEntrySchema,
  agentLifecycleStateSchema,
  containmentCoverage,
  initialAgentLifecycle,
  initializeAgentLifecycle,
  markActionInjected,
  markActionWorkflowComplete,
  markObservabilityDegraded,
  observeAgentLifecycleWithResult,
  orderAgentAction,
  readAgentLifecycle,
  recordAgentReady,
  updateActionWatch
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
const action = (delivery: "ordered" | "injected" | "accepted" = "injected") => ({
  actionId, actionDigest: digest, delivery, orderedAt: now, injectedAt: delivery === "ordered" ? null : now,
  acceptedAt: null, sessionId: null, turnId: null, workflowCompleteAt: null,
  sentHoldGeneration: null, resentAt: null, waitReportedAt: null, watch: null
});
const runtime = (agent = "codex") => {
  const root = mkdtempSync(join(tmpdir(), "coord-lifecycle-")); roots.push(root);
  const paths = issueRuntimePaths(root, 1); createIssueRuntime(paths, [agent]);
  initializeAgentLifecycle(paths, [agent], now);
  return paths;
};

describe("agent lifecycle policy", () => {
  it("loads runtimes written before issue 222 and drops the removed turn-tracking keys", () => {
    const legacy = {
      formatVersion: 1, stateRevision: 3, updatedAt: now,
      agents: { codex: {
        ...entry(), freshSession: undefined, ready: undefined, toolActivity: undefined,
        execution: "working", turnId: "t", recentTurnIds: ["t"], stoppedTurnIds: [], pendingInputCount: 0,
        backgroundActive: false, stoppedAt: null, idleEpoch: 4,
        stopObservation: { turns: ["t"], completedActions: [], stoppedActionId: null },
        action: { ...action(), sentHoldGeneration: undefined, resentAt: undefined, waitReportedAt: undefined, watch: undefined,
          retryableInjectionAt: null, lastNudgedIdleEpoch: 4, queuedBehindTurnId: "t", queuedBehindStopped: true, rereadExpected: true }
      } }
    };
    const parsed = agentLifecycleStateSchema.parse(legacy).agents.codex!;
    expect(parsed).toEqual({ ...entry(), action: action() });
    expect(parsed).not.toHaveProperty("execution");
    expect(parsed.action).not.toHaveProperty("rereadExpected");
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
  it("records acknowledgment for display and never treats injection as acceptance", () => {
    const accepted = applyLifecycleObservation({ ...entry(), action: action() }, { kind: "prompt-submitted", eventName: "UserPromptSubmit",
      sessionId: "session-1", turnId: "turn-1", actionId, actionDigest: digest }, later);
    expect(accepted.action).toMatchObject({ delivery: "accepted", acceptedAt: later, sessionId: "session-1", turnId: "turn-1" });
    expect(accepted.health).toBe("healthy");
    const other = applyLifecycleObservation({ ...entry(), action: action() }, { kind: "prompt-submitted", eventName: "UserPromptSubmit",
      sessionId: "session-1", turnId: "turn-1", actionId, actionDigest: "b".repeat(64) }, later);
    expect(other.action?.delivery).toBe("injected");
  });

  it("counts open tool calls and closes them at every turn or process end", () => {
    let current = applyLifecycleObservation(entry(), { kind: "session-start", eventName: "SessionStart", sessionId: "s" }, now);
    const start = { kind: "tool-start" as const, eventName: "PreToolUse", sessionId: "s" };
    const end = { kind: "tool-activity" as const, eventName: "PostToolUse", sessionId: "s" };
    current = applyLifecycleObservation(applyLifecycleObservation(current, start, later), start, later);
    expect(current.toolActivity).toEqual({ sequence: 2, pending: 2, at: later });
    current = applyLifecycleObservation(applyLifecycleObservation(current, end, later), end, later);
    current = applyLifecycleObservation(current, end, later);
    expect(current.toolActivity).toEqual({ sequence: 5, pending: 0, at: later });
    // Tool hooks are activity only: no lifecycle event, health or delivery change.
    expect(current.lastEvent).toBe("SessionStart");
    for (const kind of ["stopped", "failed", "session-end"] as const) {
      const ended = applyLifecycleObservation(applyLifecycleObservation(current, start, later), { kind, eventName: kind, sessionId: "s" }, later);
      expect(ended.toolActivity).toMatchObject({ sequence: 6, pending: 0 });
    }
    expect(applyLifecycleObservation(current, { ...start, sessionId: "old" }, later)).toBe(current);
  });

  it("marks only a newly established session fresh, until a prompt is submitted", () => {
    const first = applyLifecycleObservation(entry(), { kind: "session-start", eventName: "SessionStart", sessionId: "s" }, now);
    expect(first.freshSession).toBe(true);
    const busy = applyLifecycleObservation(first, { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "s", turnId: "t" }, now);
    expect(busy.freshSession).toBe(false);
    // Resume or compaction keeps the session ID and is not a fresh session.
    expect(applyLifecycleObservation(busy, { kind: "session-start", eventName: "SessionStart", sessionId: "s" }, later).freshSession).toBe(false);
    const sent = { ...busy, action: { ...action("accepted"), sessionId: "s", turnId: "t" } };
    const replaced = applyLifecycleObservation(sent, { kind: "session-start", eventName: "SessionStart", sessionId: "next" }, later);
    expect(replaced).toMatchObject({ freshSession: true, sessionId: "next", retiredSessionIds: ["s"] });
    expect(replaced.action).toEqual({ ...action("ordered") });
    // A delayed prompt from the retired process changes nothing.
    expect(applyLifecycleObservation(replaced, { kind: "prompt-submitted", eventName: "UserPromptSubmit", sessionId: "s",
      turnId: "t", actionId, actionDigest: digest }, later)).toBe(replaced);
  });

  it("consumes ready and a fresh session with each send, and records the send's hold generation", () => {
    const paths = runtime();
    observeAgentLifecycleWithResult(paths, "codex", { kind: "session-start", eventName: "SessionStart", sessionId: "s" }, now);
    orderAgentAction(paths, "codex", actionId, digest, now);
    recordAgentReady(paths, "codex", actionId, now);
    const revision = readAgentLifecycle(paths).stateRevision;
    recordAgentReady(paths, "codex", actionId, later);
    expect(readAgentLifecycle(paths).stateRevision).toBe(revision);
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({ ready: { actionId, at: now }, freshSession: true });
    markActionInjected(paths, "codex", actionId, digest, later, { holdGeneration: 2 });
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({ ready: null, freshSession: false,
      action: { delivery: "injected", injectedAt: later, sentHoldGeneration: 2, resentAt: null } });
    markActionInjected(paths, "codex", actionId, digest, later, { resent: true });
    expect(readAgentLifecycle(paths).agents.codex!.action).toMatchObject({ sentHoldGeneration: 2, resentAt: later });
    const watch = { checkedAt: later, quietSince: later, fingerprint: "f" };
    updateActionWatch(paths, "codex", actionId, "b".repeat(64), { watch }, later);
    expect(readAgentLifecycle(paths).agents.codex!.action?.watch).toBeNull();
    updateActionWatch(paths, "codex", actionId, digest, { watch, waitReportedAt: later }, later);
    expect(readAgentLifecycle(paths).agents.codex!.action).toMatchObject({ watch, waitReportedAt: later });
    // A new digest (a reissue) starts unsent with fresh watchdog state.
    orderAgentAction(paths, "codex", actionId, "c".repeat(64), later);
    expect(readAgentLifecycle(paths).agents.codex!.action).toMatchObject({ delivery: "ordered", resentAt: null, watch: null, waitReportedAt: null });
    expect(markActionWorkflowComplete(paths, "codex", actionId, later).pickedUpByReread).toBe(true);
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
    const started = applyLifecycleObservation({ ...entry(), action: action() }, { kind: "session-start", eventName: "SessionStart", sessionId: "s1" }, now);
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
    expect(observed).toMatchObject({ lastEventAt: replaced.lastEventAt, lastEvent: replaced.lastEvent,
      claudeRateLimits: { sessionId: "s2", observedAt: later } });
  });

  it("rejects stale prompt and tool events after a session replacement", () => {
    const previous = applyLifecycleObservation(entry(), { kind: "session-start", eventName: "SessionStart", sessionId: "old-session" });
    const current = applyLifecycleObservation(previous, { kind: "session-start", eventName: "SessionStart", sessionId: "new-session" });
    expect(current.retiredSessionIds).toEqual(["old-session"]);
    for (const observation of [
      { kind: "prompt-submitted" as const, eventName: "UserPromptSubmit", sessionId: "old-session", turnId: "old-turn", actionId, actionDigest: digest },
      { kind: "tool-activity" as const, eventName: "PreInvocation", sessionId: "old-session" },
      { kind: "status" as const, eventName: "status-line", sessionId: "old-session" }
    ]) {
      expect(applyLifecycleObservation(current, observation)).toBe(current);
    }
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

  it("deduplicates unchanged status renders even after ordering a new action", () => {
    const paths = runtime("antigravity");
    const observation = { kind: "status" as const, eventName: "status-line", sessionId: "agy-1" };
    observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    orderAgentAction(paths, "antigravity", actionId, digest, later);
    const before = readAgentLifecycle(paths);
    const duplicate = observeAgentLifecycleWithResult(paths, "antigravity", observation, later);
    expect(duplicate.changed).toBe(false);
    expect(readAgentLifecycle(paths)).toEqual(before);
    // A new session is not merely another render.
    const replacement = observeAgentLifecycleWithResult(paths, "antigravity", { ...observation, sessionId: "agy-2" }, later);
    expect(replacement.changed).toBe(true);
    expect(replacement.state.agents.antigravity.hookReceipt?.sequence).toBe(before.agents.antigravity.hookReceipt!.sequence + 1);
  });

  it("records duplicate hook receipts without counting tool callbacks or telemetry", () => {
    const paths = runtime("antigravity");
    const observation = { kind: "stopped" as const, eventName: "Stop", sessionId: "agy-1" };
    const first = observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    const second = observeAgentLifecycleWithResult(paths, "antigravity", observation, later);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.state.agents.antigravity).toMatchObject({ lastEventAt: now, hookReceipt: { at: later, sequence: 2 } });
    const backward = observeAgentLifecycleWithResult(paths, "antigravity", observation, now);
    expect(backward.state.agents.antigravity.hookReceipt).toEqual({ at: later, sequence: 3 });
    // A tool callback (e.g. for the command that wrote ready) is not a lifecycle hook.
    const tool = observeAgentLifecycleWithResult(paths, "antigravity", { kind: "tool-start", eventName: "PreToolUse", sessionId: "agy-1" }, later);
    expect(tool.state.agents.antigravity.hookReceipt).toEqual(backward.state.agents.antigravity.hookReceipt);
    const telemetry = observeAgentLifecycleWithResult(paths, "antigravity", { kind: "telemetry", eventName: "status-line",
      sessionId: "agy-1", rateLimits: { fiveHour: null, sevenDay: null } }, later);
    expect(telemetry.state.agents.antigravity.hookReceipt).toEqual(backward.state.agents.antigravity.hookReceipt);
    expect(agentLifecycleEntrySchema.parse({ ...entry(), hookReceipt: undefined }).hookReceipt).toBeNull();
  });
});
