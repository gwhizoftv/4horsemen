import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractPromptActionIdentity, handleAgentEvent, normalizeAgentEvent, normalizeCursorUsageEvent } from "../src/agentEvent.js";
import {
  initializeAgentLifecycle,
  initialAgentLifecycle,
  applyLifecycleObservation,
  markActionInjected,
  orderAgentAction,
  readAgentLifecycle
} from "../src/agentLifecycle.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { initializeOperationalState, readJournal } from "../src/state.js";
import { classifyClaudeFailure, classifyCursorStatus, parseClaudeRateLimits } from "../src/resourceEvidence.js";

const actionId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const prompt = `Read and execute coordinator action ${actionId} digest ${digest} at /runtime/issue-86/agents/codex/action.md`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const runtimeFixture = (agent: "codex" | "claude" | "cursor" | "antigravity") => {
  const root = mkdtempSync(join(tmpdir(), "coord-agent-event-"));
  roots.push(root);
  const clone = join(root, "clone");
  mkdirSync(clone);
  execFileSync("git", ["init", "-q"], { cwd: clone });
  const configPath = join(root, "config.json");
  const configuredAgent = { id: agent, root: clone, launcher: `start-${agent}.sh`, delivery: "both" as const };
  writeFileSync(
    configPath,
    `${JSON.stringify({
      project: "fixture",
      origin: "https://github.com/example/fixture.git",
      branch: "issue-{issue}/{agent}",
      agents: [configuredAgent],
      checks: [{ name: "true", argv: ["true"] }]
    })}\n`
  );
  execFileSync("git", ["config", "--local", "coord.workspaceConfig", configPath], { cwd: clone });
  execFileSync("git", ["config", "--local", "consensus.agentId", agent], { cwd: clone });
  const paths = issueRuntimePaths(root, 86);
  createIssueRuntime(paths, [agent]);
  initializeOperationalState(paths, {
    issue: 86,
    issueSessionId: `issue-86:${"b".repeat(40)}`,
    baselineSha: "b".repeat(40),
    profile: "solo",
    originalRoster: [agent],
    branchTemplate: "issue-{issue}/{agent}",
    baseBranch: "main",
    maxRevisionRounds: 3,
    prPolicy: "coord-open-unmerged",
    automationDigest: "c".repeat(64),
    automationDigestScheme: "sha256-length-prefixed-v1",
    automationDigestSources: [{ id: "config", sha256: "c".repeat(64) }],
    trustedSourceCommit: "d".repeat(40),
    origin: "https://github.com/example/fixture.git",
    coordRoot: root,
    configPath,
    agents: [configuredAgent],
    checks: [{ name: "true", argv: ["true"] }],
    pollIntervalMs: 1000
  });
  initializeAgentLifecycle(paths, [agent]);
  return { clone, paths };
};

describe("vendor lifecycle event normalization", () => {
  it("extracts the action UUID, digest, path, and issue from the exact nudge", () => {
    expect(extractPromptActionIdentity(prompt)).toEqual({
      actionId,
      actionDigest: digest,
      actionPath: "/runtime/issue-86/agents/codex/action.md",
      issue: 86
    });
    expect(extractPromptActionIdentity(`Read action ${actionId}`)).toBeNull();
  });

  it("normalizes Codex prompt and stop events with the same turn", () => {
    expect(
      normalizeAgentEvent("codex", {
        hook_event_name: "UserPromptSubmit",
        session_id: "thread-1",
        turn_id: "turn-1",
        prompt
      })
    ).toMatchObject({
      kind: "prompt-submitted",
      sessionId: "thread-1",
      turnId: "turn-1",
      actionId,
      actionDigest: digest
    });
    expect(
      normalizeAgentEvent("codex", {
        hook_event_name: "Stop",
        session_id: "thread-1",
        turn_id: "turn-1"
      })
    ).toMatchObject({ kind: "stopped", sessionId: "thread-1", turnId: "turn-1" });
  });

  it("retains Claude background task and failure state", () => {
    expect(
      normalizeAgentEvent("claude", {
        hook_event_name: "Stop",
        session_id: "claude-1",
        background_tasks: [{ id: "task-1" }],
        session_crons: []
      })
    ).toMatchObject({ kind: "stopped", backgroundActive: true });
    expect(
      normalizeAgentEvent("claude", { hook_event_name: "StopFailure", session_id: "claude-1" })
    ).toMatchObject({ kind: "failed", backgroundActive: false });
  });

  it("classifies Claude failures without inferring a deadline from anything but a fresh matching epoch", () => {
    const now = "2026-09-22T12:00:00.000Z";
    const epoch = (hours: number) => Date.parse(now) / 1000 + hours * 3600;
    const fields = (error: string, errorDetails: string | null = null) => ({ error, errorDetails, lastAssistantMessage: null });
    const telemetry = (fiveHour: number, sevenDay: number, observedAt = now, sessionId = "s1") => ({
      sessionId, observedAt,
      limits: parseClaudeRateLimits({ rate_limits: {
        five_hour: { used_percentage: fiveHour, resets_at: epoch(2) },
        seven_day: { used_percentage: sevenDay, resets_at: epoch(50) }
      } })!
    });
    const classify = (error: string, details: string | null, cached: ReturnType<typeof telemetry> | null) =>
      classifyClaudeFailure(fields(error, details), cached, { sessionId: "s1", now });
    expect(classify("authentication_failed", null, null).failureClass).toBe("auth-account");
    expect(classify("billing_error", null, telemetry(100, 0))).toMatchObject({ failureClass: "billing", resetsAt: null });
    expect(classify("server_error", null, null).failureClass).toBe("transport");
    expect(classify("invalid_request", "Prompt is too long", null).failureClass).toBe("context-overflow");
    expect(classify("invalid_request", "bad tool schema", null).failureClass).toBe("unknown");
    expect(classify("max_output_tokens", null, null).failureClass).toBe("unknown");
    // A typed rate limit alone, stale or foreign telemetry, or rendered clock text proves nothing.
    expect(classify("rate_limit", "Limit reached · resets 3:45pm", null)).toMatchObject({ failureClass: "unknown", resetsAt: null });
    expect(classify("rate_limit", null, telemetry(100, 0, "2026-09-22T11:54:00.000Z"))).toMatchObject({ failureClass: "unknown", resetsAt: null });
    expect(classify("rate_limit", null, telemetry(100, 0, now, "other"))).toMatchObject({ failureClass: "unknown", resetsAt: null });
    expect(classify("rate_limit", null, telemetry(40, 10)).failureClass).toBe("throttled");
    expect(classify("rate_limit", null, telemetry(100, 20))).toMatchObject({
      failureClass: "usage-window", classConfidence: "confirmed", resetsAt: new Date(epoch(2) * 1000).toISOString()
    });
    // Both applicable windows are kept; the later one governs the recheck.
    const both = classify("rate_limit", null, telemetry(100, 100));
    expect(both.windows.map((window) => window.limitId)).toEqual(["five_hour", "seven_day"]);
    expect(both.resetsAt).toBe(new Date(epoch(50) * 1000).toISOString());
    // A model-family restriction never borrows a general window's epoch.
    expect(classify("rate_limit", "Opus weekly limit reached", telemetry(100, 0))).toMatchObject({ failureClass: "usage-window", resetsAt: null });
    expect(parseClaudeRateLimits({ rate_limits: { five_hour: { used_percentage: 100, resets_at: epoch(2) * 1000 } } })?.fiveHour?.resetsAt).toBeNull();
    expect(classifyCursorStatus("aborted")).toBe("cancelled");
    expect(classifyCursorStatus("error")).toBe("unknown");
  });

  it("keeps actual Claude failure fields, redacted, and never journals or counts status renders as activity", () => {
    const { clone, paths } = runtimeFixture("claude");
    orderAgentAction(paths, "claude", actionId, digest, "2026-09-22T11:59:00.000Z");
    markActionInjected(paths, "claude", actionId, digest, "2026-09-22T11:59:00.000Z");
    const route = (raw: Record<string, unknown>, now: string, explicitEvent?: string) =>
      handleAgentEvent({ vendor: "claude", clone, environmentIssue: "86", raw, now, ...(explicitEvent === undefined ? {} : { explicitEvent }) });
    route({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt_id: "t1",
      prompt: `Read and execute coordinator action ${actionId} digest ${digest} at ${paths.issueRoot}/agents/claude/action.md` }, "2026-09-22T12:00:00.000Z");
    const before = readAgentLifecycle(paths).agents.claude!;
    const journal = readJournal(paths).length;
    const resetsAt = Date.parse("2026-09-22T15:00:00.000Z") / 1000;
    const render = { session_id: "s1", cwd: clone, model: { id: "x" }, rate_limits: { five_hour: { used_percentage: 100, resets_at: resetsAt } } };
    for (let index = 0; index < 100; index++) route(render, `2026-09-22T12:0${index < 50 ? 1 : 3}:00.000Z`, "status-line");
    const cached = readAgentLifecycle(paths).agents.claude!;
    expect(readJournal(paths)).toHaveLength(journal);
    expect(cached).toMatchObject({ execution: before.execution, lastEventAt: before.lastEventAt, sessionId: "s1" });
    // An identical re-render does not refresh the original observation age.
    expect(cached.claudeRateLimits).toMatchObject({ sessionId: "s1", observedAt: "2026-09-22T12:01:00.000Z" });
    route({ session_id: "other", rate_limits: render.rate_limits }, "2026-09-22T12:04:00.000Z", "status-line");
    expect(readAgentLifecycle(paths).agents.claude!.claudeRateLimits?.sessionId).toBe("s1");

    const failure = { hook_event_name: "StopFailure", session_id: "s1", error: "rate_limit",
      error_details: "\u001b[31mBearer abcdefghijklmnop\u001b[0m for owner@example.com · resets 3:45pm", last_assistant_message: "API Error: sk-ant-1234567890abcdef" };
    route(failure, "2026-09-22T12:05:00.000Z");
    const failed = readAgentLifecycle(paths).agents.claude!.lastFailure!;
    expect(failed).toMatchObject({
      actionId, sessionId: "s1", error: "rate_limit", resetsAt: "2026-09-22T15:00:00.000Z",
      evidence: { vendor: "claude", failureClass: "usage-window", classConfidence: "confirmed" }
    });
    expect(JSON.stringify(failed)).not.toMatch(/abcdefghijklmnop|owner@example.com|sk-ant/);
    expect(`${failed.errorDetails}`).not.toContain(String.fromCharCode(27));
    expect(failed.errorDetails).toContain("Bearer [redacted]");
    expect(readJournal(paths).at(-1)).toMatchObject({ type: "agent-lifecycle", details: { failureClass: "usage-window", correlated: true } });
    const afterFailure = readJournal(paths).length;
    route({ ...failure, error_details: "reworded" }, "2026-09-22T12:06:00.000Z");
    expect(readJournal(paths)).toHaveLength(afterFailure);
    expect(readAgentLifecycle(paths).agents.claude!.lastFailure?.evidence.observedAt).toBe(failed.evidence.observedAt);
  });

  it("correlates Cursor conversation and generation identifiers", () => {
    expect(
      normalizeAgentEvent("cursor", {
        hook_event_name: "beforeSubmitPrompt",
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        prompt
      })
    ).toMatchObject({
      kind: "prompt-submitted",
      sessionId: "conversation-1",
      turnId: "generation-1",
      actionId,
      actionDigest: digest
    });
    expect(
      normalizeAgentEvent("cursor", {
        hook_event_name: "stop",
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        status: "error"
      })
    ).toMatchObject({ kind: "failed", failure: { vendor: "cursor", status: "error" } });
    expect(
      normalizeAgentEvent("cursor", { hook_event_name: "stop", conversation_id: "conversation-1", status: "aborted" })
    ).toMatchObject({ kind: "failed", failure: { status: "aborted" } });
  });

  it("normalizes Cursor analytics hooks for tools and token usage", () => {
    expect(
      normalizeCursorUsageEvent("cursor", {
        hook_event_name: "postToolUse",
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        tool_name: "Read"
      })
    ).toMatchObject({ kind: "tool-used", sessionId: "conversation-1", turnId: "generation-1", toolCalls: 1 });
    expect(
      normalizeCursorUsageEvent("cursor", {
        hook_event_name: "afterAgentResponse",
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        input_tokens: 12,
        output_tokens: 4,
        cache_read_tokens: 1,
        cache_write_tokens: 0
      })
    ).toMatchObject({
      kind: "turn-usage",
      tokens: { input: 12, output: 4, cacheRead: 1, cacheWrite: 0, reasoning: null }
    });
  });

  it.each(["codex", "claude", "cursor", "antigravity"] as const)("uses %s Stop as readiness despite background work", (vendor) => {
    const current = { ...initialAgentLifecycle([vendor]).agents[vendor]!, execution: "working" as const,
      sessionId: "session", backgroundActive: true };
    const stop = normalizeAgentEvent(vendor, { session_id: "session", conversation_id: "session",
      background_tasks: [{ id: "task" }], fullyIdle: false }, "Stop")!;
    expect(applyLifecycleObservation(current, stop)).toMatchObject({ execution: "idle", stoppedAt: expect.any(String) });
  });

  it("retains Antigravity activity telemetry while accepting every Stop", () => {
    expect(
      normalizeAgentEvent(
        "antigravity",
        {
          conversation_id: "agy-1",
          agent_state: "working",
          pending_input_count: 2,
          task_count: 1,
          tool_confirmation_pending: true
        },
        "status-line"
      )
    ).toMatchObject({
      kind: "status",
      execution: "queued",
      pendingInputCount: 2,
      backgroundActive: true
    });
    expect(
      normalizeAgentEvent("antigravity", { conversationId: "agy-1", fullyIdle: false }, "Stop")
    ).toMatchObject({ kind: "stopped", backgroundActive: true, allowInjectedIdle: false });
    expect(
      normalizeAgentEvent("antigravity", { conversationId: "agy-1", fullyIdle: true }, "Stop")
    ).toMatchObject({ kind: "stopped", backgroundActive: false, allowInjectedIdle: true });
  });

  it("routes a hook through clone identity into the separate lifecycle state", () => {
    const { clone, paths } = runtimeFixture("codex");
    orderAgentAction(paths, "codex", actionId, digest);
    markActionInjected(paths, "codex", actionId, digest);
    const exactPrompt = `Read and execute coordinator action ${actionId} digest ${digest} at ${paths.issueRoot}/agents/codex/action.md`;
    const result = handleAgentEvent({
      vendor: "codex",
      clone,
      environmentIssue: "86",
      raw: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        prompt: exactPrompt
      }
    });
    expect(result.observed).toBe(true);
    expect(readAgentLifecycle(paths).agents.codex).toMatchObject({
      execution: "working",
      health: "healthy",
      action: { delivery: "accepted", sessionId: "session-1", turnId: "turn-1" }
    });
    expect(readJournal(paths).at(-1)).toMatchObject({
      type: "agent-lifecycle",
      agent: "codex",
      actionId,
      details: { sessionId: "session-1", turnId: "turn-1" }
    });

    const journalLength = readJournal(paths).length;
    handleAgentEvent({
      vendor: "codex",
      clone,
      environmentIssue: "86",
      raw: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        turn_id: "turn-1",
        prompt: exactPrompt
      }
    });
    expect(readJournal(paths)).toHaveLength(journalLength + 1);
    expect(readJournal(paths).at(-1)).toMatchObject({
      type: "agent-lifecycle",
      actionId,
      details: { kind: "prompt-submitted", sessionId: "session-1", turnId: "turn-1" }
    });

    const stop = {
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1"
    };
    handleAgentEvent({ vendor: "codex", clone, environmentIssue: "86", raw: stop });
    const stoppedLength = readJournal(paths).length;
    handleAgentEvent({ vendor: "codex", clone, environmentIssue: "86", raw: stop });
    expect(readJournal(paths)).toHaveLength(stoppedLength + 1);
    expect(readJournal(paths).at(-1)).toMatchObject({
      type: "agent-lifecycle",
      details: { kind: "stopped", sessionId: "session-1", turnId: "turn-1" }
    });
  });

  it("journals Claude and Codex identity only when the hooks supply it", () => {
    const identified = runtimeFixture("claude");
    orderAgentAction(identified.paths, "claude", actionId, digest);
    markActionInjected(identified.paths, "claude", actionId, digest);
    handleAgentEvent({
      vendor: "claude",
      clone: identified.clone,
      environmentIssue: "86",
      raw: {
        hook_event_name: "UserPromptSubmit",
        session_id: "claude-session",
        prompt_id: "claude-turn",
        prompt: `Read and execute coordinator action ${actionId} digest ${digest} at ${identified.paths.issueRoot}/agents/claude/action.md`
      }
    });
    expect(readJournal(identified.paths).at(-1)).toMatchObject({
      type: "agent-lifecycle",
      details: { sessionId: "claude-session", turnId: "claude-turn" }
    });

    const anonymous = runtimeFixture("claude");
    handleAgentEvent({
      vendor: "claude",
      clone: anonymous.clone,
      environmentIssue: "86",
      raw: { hook_event_name: "SessionStart" }
    });
    const details = readJournal(anonymous.paths).at(-1)?.details;
    expect(details).not.toHaveProperty("sessionId");
    expect(details).not.toHaveProperty("turnId");

    const anonymousCodex = runtimeFixture("codex");
    handleAgentEvent({
      vendor: "codex",
      clone: anonymousCodex.clone,
      environmentIssue: "86",
      raw: { hook_event_name: "SessionStart" }
    });
    const codexDetails = readJournal(anonymousCodex.paths).at(-1)?.details;
    expect(codexDetails).not.toHaveProperty("sessionId");
    expect(codexDetails).not.toHaveProperty("turnId");
  });

  it("routes Antigravity status-line queue depth from payload cwd without flags or issue env", () => {
    const { clone, paths } = runtimeFixture("antigravity");
    const result = handleAgentEvent({
      vendor: "antigravity",
      explicitEvent: "status-line",
      raw: {
        cwd: clone,
        conversation_id: "agy-1",
        agent_state: "working",
        pending_input_count: 2,
        task_count: 0
      }
    });
    expect(result.observed).toBe(true);
    expect(readAgentLifecycle(paths).agents.antigravity).toMatchObject({
      execution: "queued",
      sessionId: "agy-1",
      pendingInputCount: 2
    });
  });

  it("journals Cursor tool and token usage without mutating lifecycle on analytics-only hooks", () => {
    const { clone, paths } = runtimeFixture("cursor");
    const result = handleAgentEvent({
      vendor: "cursor",
      clone,
      environmentIssue: "86",
      explicitEvent: "postToolUse",
      raw: {
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        tool_name: "Read"
      }
    });
    expect(result.observed).toBe(true);
    expect(readJournal(paths).at(-1)).toMatchObject({
      type: "agent-usage",
      agent: "cursor",
      details: { kind: "tool-used", sessionId: "conversation-1", turnId: "generation-1" }
    });
    expect(readAgentLifecycle(paths).agents.cursor?.execution).toBe("unknown");
  });
});
