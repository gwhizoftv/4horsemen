# Code review: Codex implementation for issue 86

- Reviewed head: `origin/issue-86/codex` @ `46a9fe24ccc8691e455f6d3363e31388566d0fa6`
- Baseline: `origin/main`
- Scope: coordinator-owned CLI lifecycle hooks so later nudges happen only when idle, not every 45s

## Findings

### 1. `src/agentLifecycle.ts:387`

**Rule.** After the first inject, a later nudge is allowed only when the CLI is idle or stopped, Antigravity is `fullyIdle` with no pending input, and `complete` is still missing. Antigravity has no prompt-submit event, so `Stop` with `fullyIdle: true` must be able to reach `idle`.

**Failure.** `markActionInjected` leaves `delivery` at `"injected"` and `action.turnId` at `null`. Antigravity never emits `prompt-submitted` (`src/agentEvent.ts` maps only status-line, Pre/PostInvocation, and Stop). Every later `Stop` therefore hits `injectedAwaitingAcceptance` and sets `execution` to `"queued"`. `decideLifecycleNudge` then waits forever while the artifact is missing.

**Test.**

```ts
it("Antigravity Stop with fullyIdle reaches idle without a prompt-submit", () => {
  const injected = { /* delivery: "injected", turnId: null */ };
  const stopped = applyLifecycleObservation(injected, {
    kind: "stopped",
    eventName: "Stop",
    sessionId: "agy-1",
    backgroundActive: false
  });
  expect(stopped.execution).toBe("idle");
  expect(decideLifecycleNudge(stopped, actionId, digest).kind).toBe("send");
});
```

---

### 2. `src/agentHookSync.ts:317` and `src/agentEvent.ts:244`

**Rule.** Antigravity queue depth (`pending_input_count`) must reach the issue runtime. The user-global status-line wrapper is the only source of that field.

**Failure.** The wrapper runs `agent-event --vendor antigravity --event status-line` with no `--clone` and no `COORD_ISSUE`. Status-line payloads from the issue (`conversation_id`, `agent_state`, `pending_input_count`, …) do not include `cwd`. `handleAgentEvent` returns `{ observed: false }` when clone cannot be resolved, so pending-input never lands in `lifecycle.json`. Combined with finding 1, Antigravity cannot authorize a later nudge and cannot block one from queue depth either.

**Test.**

```ts
it("persists status-line pending_input without a clone flag", () => {
  const result = handleAgentEvent({
    vendor: "antigravity",
    explicitEvent: "status-line",
    raw: { conversation_id: "agy-1", agent_state: "working", pending_input_count: 2 }
  });
  expect(result.observed).toBe(true);
  expect(result.state?.agents.antigravity?.pendingInputCount).toBe(2);
});
```

---

### 3. `src/agentLifecycle.ts:306`

**Rule.** When a status-line payload starts a new session, that same payload’s `pending_input_count` and `agent_state` must still decide queued vs idle. A later inject must not fire into a conversation that still has pending input.

**Failure.** `beginsSession` includes `"status"`. On `conversation_id` change, `applyLifecycleObservation` forces `execution = "idle"`, `pendingInputCount = 0`, and `backgroundActive = false` before the status handler runs. A status event with a new `conversation_id`, `pending_input_count: 2`, and `agent_state: "working"` becomes eligible-idle, and `maybeLifecycleNudge` will send.

**Test.**

```ts
it("keeps pending_input from a session-replacing status payload", () => {
  const prior = applyLifecycleObservation(entry(), {
    kind: "status",
    eventName: "status-line",
    sessionId: "old",
    execution: "idle",
    pendingInputCount: 0
  });
  const next = applyLifecycleObservation(prior, {
    kind: "status",
    eventName: "status-line",
    sessionId: "new",
    execution: "queued",
    pendingInputCount: 2,
    backgroundActive: true
  });
  expect(next.pendingInputCount).toBe(2);
  expect(decideLifecycleNudge({ ...next, action }, actionId, digest)).toEqual({
    kind: "wait",
    reason: "pending-input"
  });
});
```

---

### 4. `src/cli.ts:809`

**Rule.** `coord agent-event` must not block vendor Stop. Antigravity Stop requires a JSON decision other than `"continue"` even when observation validation fails.

**Failure.** `{ decision: "allow" }` is assigned only after `handleAgentEvent` succeeds. Identity/roster/`actionPath` throws are caught and leave `response === "{}"`. A Stop hook that fails validation can fail the vendor’s stop path, contrary to the fail-open comment at `src/cli.ts:791`.

**Test.**

```ts
it("acks Antigravity Stop even when the observation is rejected", async () => {
  const lines: string[] = [];
  const code = await runCli(
    ["agent-event", "--vendor", "antigravity", "--event", "Stop", "--clone", mismatchClone],
    { io: { stdin: () => `{"fullyIdle":true}`, stdout: (m) => lines.push(m), stderr: () => undefined } }
  );
  expect(code).toBe(0);
  expect(JSON.parse(lines.join(""))).toEqual({ decision: "allow" });
});
```

## Verdict

Request changes. First inject and the 45s watchdog-not-resend path are right for Codex/Claude/Cursor when `UserPromptSubmit` / `beforeSubmitPrompt` correlates. Antigravity later-nudge gating is not: Stop cannot become idle while delivery stays `injected`, the status-line queue signal is dropped without a clone, and a session-replacing status payload wipes pending input. Fix those before treating issue 86 as done.
