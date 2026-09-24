import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractPromptActionIdentity, handleAgentEvent, normalizeAgentEvent, normalizeCursorUsageEvent } from "../src/agentEvent.js";
import {
  initializeAgentLifecycle,
  markActionInjected,
  orderAgentAction,
  readAgentLifecycle
} from "../src/agentLifecycle.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { initializeOperationalState, readJournal } from "../src/state.js";

const actionId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const prompt = `Read and execute coordinator action ${actionId} digest ${digest} at /runtime/issue-86/agents/codex/action.md`;

it("preserves actual Claude failure fields and distinct Cursor cancellation without invented aliases", () => {
  expect(normalizeAgentEvent("claude", { session_id: "s", error: "rate_limit", error_details: "detail",
    last_assistant_message: "rendered", error_type: "invented" }, "StopFailure")?.failure).toEqual({
    vendor: "claude", error: "rate_limit", error_details: "detail", last_assistant_message: "rendered"
  });
  expect(normalizeAgentEvent("claude", { session_id: "s", rate_limits: { five_hour: { used_percentage: 100, resets_at: 2000000000 } } }, "status-line"))
    .toMatchObject({ kind: "telemetry", windows: [{ window: "five_hour" }] });
  expect(normalizeAgentEvent("cursor", { status: "aborted" }, "stop")?.failure?.error).toBe("aborted");
  expect(normalizeAgentEvent("cursor", { reason: "user_close" }, "sessionEnd")?.failure?.error).toBe("user_close");
});
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
    ).toMatchObject({ kind: "failed" });
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

  it("uses Antigravity queue, task, agent-state, and fullyIdle signals", () => {
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
    ).toMatchObject({ kind: "stopped", backgroundActive: true });
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
