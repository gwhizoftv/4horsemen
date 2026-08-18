import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractPromptActionIdentity, handleAgentEvent, normalizeAgentEvent } from "../src/agentEvent.js";
import {
  initializeAgentLifecycle,
  markActionInjected,
  orderAgentAction,
  readAgentLifecycle
} from "../src/agentLifecycle.js";
import { createIssueRuntime, issueRuntimePaths } from "../src/paths.js";
import { initializeOperationalState } from "../src/state.js";

const actionId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
const prompt = `Read and execute coordinator action ${actionId} digest ${digest} at /runtime/issue-86/agents/codex/action.md`;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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
  });

  it("routes a hook through clone identity into the separate lifecycle state", () => {
    const root = mkdtempSync(join(tmpdir(), "coord-agent-event-"));
    roots.push(root);
    const clone = join(root, "clone");
    mkdirSync(clone);
    execFileSync("git", ["init", "-q"], { cwd: clone });
    const configPath = join(root, "config.json");
    writeFileSync(
      configPath,
      `${JSON.stringify({
        project: "fixture",
        origin: "https://github.com/example/fixture.git",
        branch: "issue-{issue}/{agent}",
        agents: [{ id: "codex", root: clone, launcher: "start-codex.sh", delivery: "both" }],
        checks: [{ name: "true", argv: ["true"] }]
      })}\n`
    );
    execFileSync("git", ["config", "--local", "coord.workspaceConfig", configPath], { cwd: clone });
    execFileSync("git", ["config", "--local", "consensus.agentId", "codex"], { cwd: clone });
    const paths = issueRuntimePaths(root, 86);
    createIssueRuntime(paths, ["codex"]);
    initializeOperationalState(paths, {
      issue: 86,
      issueSessionId: `issue-86:${"b".repeat(40)}`,
      baselineSha: "b".repeat(40),
      profile: "solo",
      originalRoster: ["codex"],
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
      agents: [{ id: "codex", root: clone, launcher: "start-codex.sh", delivery: "both" }],
      checks: [{ name: "true", argv: ["true"] }],
      pollIntervalMs: 1000
    });
    initializeAgentLifecycle(paths, ["codex"]);
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
  });
});
