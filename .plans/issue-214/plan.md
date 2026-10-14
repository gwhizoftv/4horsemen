# Issue 214 — Handoff lifecycle and delivery reporting

Correct three ways coord loses track of an in-flight turn, and stop describing accepted work as a send that has not happened. The behavior below is the whole fix.

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts`
  - Add two nullable fields on `lifecycleActionSchema`, both `.default(null)` so an existing `agent-lifecycle.json` still parses: `acceptance` (`"execution" | "queued-input" | "reread"`) and `joinedTurnId` (string).
  - `applyLifecycleObservation` for `prompt-submitted`:
    - When the observation names this action and its `turnId` differs from the turn already stored on the entry (`entry.turnId` null, or a different id), bind `delivery: "accepted"`, `acceptance: "execution"`, `joinedTurnId: null`, and `action.turnId` to that new id. Execution stays `working`. This is the path that already accepts a distinct turn.
    - When the observation names this action and its `turnId` equals the turn already in progress (`entry.turnId`), and this action does not already have `acceptance: "execution"` for that same id, accept delivery with `acceptance: "queued-input"`, `action.turnId: null`, and `joinedTurnId` set to that in-progress id. Execution stays `working`. A repeated submit of an action that is already `execution` on that same id stays `execution` and keeps `action.turnId`.
  - `applyLifecycleObservation` for `stopped` replaces the branch that sets `execution = "queued"` whenever `currentActionTurn !== stoppedTurn`:
    - A Stop whose turn id differs from an `acceptance: "execution"` action's `turnId` leaves `execution`, `stoppedAt`, `turnId`, and the action unchanged. The newer turn stays `working`.
    - A Stop whose turn id equals `joinedTurnId` on an `acceptance: "queued-input"` action leaves `execution` at `working`, leaves `stoppedAt` null, and does not set `stopObservation.stoppedActionId` to this action. The Stop is the preceding turn, not the end of the queued prompt.
    - A Stop whose turn id equals `joinedTurnId` on an `acceptance: "reread"` action, while `workflowCompleteAt` is still null, reopens that action to `delivery: "ordered"`, clears `acceptedAt`, `sessionId`, `turnId`, `acceptance`, and `joinedTurnId`, and sets `execution: "idle"` with `stoppedAt` now. `positiveIdle` then grants one idle epoch so a later nudge can send.
    - A Stop that matches an `execution` turn, with no pending input, still sets `execution: "idle"` and `stoppedAt`. Pending input on that matching Stop still sets `execution: "queued"`.
  - `orderAgentAction` gains an optional `{ continueInFlightTurn?: boolean }`. When the call replaces an action whose `workflowCompleteAt` is set, `continueInFlightTurn` is true, `execution` is `working`, `stoppedAt` is null, and `sessionId` and `turnId` are set, the new action is stored already accepted: `delivery: "accepted"`, `acceptance: "reread"`, `joinedTurnId` equal to the live `turnId`, `action.turnId: null`, `sessionId` copied from the entry. Otherwise the new action stays `delivery: "ordered"` with both new fields null. The same-id early return is unchanged, so a later call cannot clear a reread acceptance.
- `src/agentEvent.ts`
  - After `normalizeCursorUsageEvent`, when `kind` is `tool-used` or `tool-failed`, the usage `sessionId` equals the entry `sessionId`, the usage `turnId` equals `entry.turnId` or `entry.action.turnId`, `stoppedAt` is null, and `execution` is `queued` or `unknown`, call `observeAgentLifecycleWithResult` with `kind: "working"` for that session and turn. Token `turn-usage` events stay usage-only. A tool event for any other turn does not change lifecycle. The existing usage journal row is still written.
- `src/runLoop.ts`
  - In the action-prepare path (`orderAgentAction` after `action-prepared`), read the ready file with `readReady`. Pass `continueInFlightTurn: true` only when that receipt is missing or its `actionId` is not `lastAcceptedActionId`. `maybeLifecycleNudge` keeps calling `orderAgentAction` without the flag.
  - `journalDeferral`: `gateWaiting` is true only when `cursors.agents[agent].status === "ordered"` and this action is not already `delivery: "accepted"` and `workflowCompleteAt` is null. The stdout line stays `[WAIT] Issue N: waiting to send to <agent>; <human>` for that true case.
  - `maybeLifecycleNudge`: when `decideLifecycleNudge` waits with `working` or `queued` and this action's `delivery` is already `accepted`, return without `journalDeferral`. Lost-injection retry for `delivery: "injected"` stays in place.
- `docs/readiness-policy.md`
  - State that `gateWaiting` is false once this action is accepted or workflow-complete, including while the cursor status is still `ordered`. State that an older Stop preserves the newer turn, that a same-turn prompt submit is `queued-input` and its Stop does not idle the new action, and that a reread continuation is accepted only while that turn is still active.
- `test/agentLifecycle.test.ts` — extend the current older-Stop case and add the queued-input and reread cases below.
- `test/agentEvent.test.ts` — add the current-turn tool repair case below. Keep the existing analytics-only assertion for a tool event with no matching turn.
- `test/runLoop.test.ts` — add the accepted-delivery silence case and the reread case below.

## Exact file list to be created

No product source, test, or schema files. The new action fields live on the existing lifecycle action object.

## Reuse and Scope

- `applyLifecycleObservation`, `orderAgentAction`, `decideLifecycleNudge`, `positiveIdle`, and `hasStopReadiness` in `src/agentLifecycle.ts`.
- `normalizeAgentEvent`, `normalizeCursorUsageEvent`, and `handleAgentEvent` in `src/agentEvent.ts`. A current-turn tool event reuses the existing `kind: "working"` observation, which already clears `stoppedAt` and sets `execution`.
- `journalDeferral`, `maybeLifecycleNudge`, `readyForNextAction`, and `readReady` (`src/action.ts`) in `src/runLoop.ts`.
- `DEFERRAL_RATIONALE` stays the text for a real refusal. Post-acceptance `working` and `queued` are not refusals, so they do not need a new code.
- `src/issueReport.ts` already prints `working; no intervention needed` and already hides scrollback waits after acceptance. No change there.
- No new module. Handoff rules stay beside the Stop branch they replace.

## Tests

Focused command while developing:

`pnpm exec vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/agentEvent.test.ts test/runLoop.test.ts`

These cases fail on the current Stop, usage, and deferral behavior and pass after the change. Each joins the file named above.

- `test/agentLifecycle.test.ts` — extend `uses a current Stop despite background work and revokes it on a new turn`. After a prompt submit binds turn `new`, a Stop for turn `old` keeps `execution: "working"` and `stoppedAt: null`. Today that Stop sets `execution: "queued"`.
- `test/agentLifecycle.test.ts` — new case: accept action A on turn `t1`, order action B, then `prompt-submitted` for B with the same `t1`. Expect `acceptance: "queued-input"`, `action.turnId: null`, `joinedTurnId: "t1"`, `execution: "working"`. The following Stop for `t1` keeps `execution: "working"`, `stoppedAt: null`, and `decideLifecycleNudge` returns `working`. A later prompt submit for B with turn `t2` binds `acceptance: "execution"` and `action.turnId: "t2"`, and a Stop for `t2` sets `idle`.
- `test/agentLifecycle.test.ts` — new case: with `continueInFlightTurn: true`, `orderAgentAction` replacing a workflow-complete action on a live turn stores `acceptance: "reread"` and `delivery: "accepted"`. A Stop for `joinedTurnId` before `workflowCompleteAt` returns `delivery: "ordered"` and `execution: "idle"`, and `decideLifecycleNudge` returns `send`. The same order with `continueInFlightTurn` omitted stores `delivery: "ordered"`.
- `test/agentEvent.test.ts` — new case: lifecycle is `queued` on session `conversation-1` and turn `generation-1` after an older Stop. `handleAgentEvent` for `postToolUse` with that session and turn sets `execution: "working"`. A `postToolUse` for a different `generation_id`, and an `afterAgentResponse` token event, leave `execution` unchanged. The existing test that a `postToolUse` with no current turn leaves `execution: "unknown"` stays.
- `test/runLoop.test.ts` — new case: after a successful nudge and a matching `prompt-submitted`, the next tick's log contains no `waiting to send` line. A `nudge-deferred` row for `working` on that accepted action is absent.
- `test/runLoop.test.ts` — new case: complete one action while the lifecycle turn is still `working` and no ready file is present; the following prepared action is `acceptance: "reread"` and the tick sends no further literal nudge. With a ready file for the previous action, the new action stays `ordered` and the existing ready-file send still runs.

The commit hook classifies a product change and runs its own check. This plan does not schedule a second `pnpm check:fast` immediately before commit.

## Alternatives Rejected

- Treating every non-matching Stop as `queued`. That is the current branch in `applyLifecycleObservation`, and it is the Cursor overwrite: the new turn is already `working`, then the old Stop replaces it with `queued`.
- Ignoring every Stop while `execution` is `working`. A Stop of the bound execution turn is still the idle signal `decideLifecycleNudge` uses for the next send.
- Marking every new action accepted whenever a session id exists. That would skip the first send and the ready-file send.
- Using a pane scrape, or the absence of `COORD-IDLE`, as proof the agent picked up a reread. Those scrapes are the `no-idle-sentinel` and `codex-turn-chrome` deferrals this issue is correcting.
- Promoting every `postToolUse` into a lifecycle journal row. Usage accounting stays on `agent-usage`. Only a tool event for the current turn, and only from `queued` or `unknown`, repairs execution.
- Adding a handoff module or a new deferral code. The decisions fit the existing observation and `journalDeferral` gates.

## Risks and Mitigations

- A vendor can emit one Stop for the turn a prompt was queued into and then drop that prompt. The queued-input Stop keeps `working`, so automatic delivery does not send a second copy. An injected action that never reached `accepted` still uses the existing lost-delivery proof. Owner reminder delivery is unchanged.
- Reread acceptance can be recorded before the agent reads the new `action.md`. It is limited to a workflow-complete predecessor, a turn with `stoppedAt === null`, and no ready receipt for that predecessor. A Stop before the new action reaches `workflowCompleteAt` reopens `ordered` and `idle`, which authorizes one send.
- A ready receipt must win over reread acceptance. The prepare path reads `readReady` first and passes `continueInFlightTurn: false` when the receipt names `lastAcceptedActionId`, so `readyForNextAction` still sees `delivery: "ordered"`.
- Tool repair could revive a finished turn. It requires `stoppedAt === null`, `execution` of `queued` or `unknown`, and the same session and current turn. Idle, failed, and token-usage events do not qualify.
- Existing lifecycle files lack the new keys. Both keys default to null under the strict schema, and a null `acceptance` keeps today's Stop behavior for state written before this change.
- `gateWaiting: false` could hide a first send that is actually blocked. The flag stays true until this action's delivery is `accepted` or `workflowCompleteAt` is set.

## Conclusion

Older Stops preserve a newer execution turn, a prompt submit that reuses the in-progress turn is queued input rather than that turn's completion, and a replacement action is accepted as a reread only while that turn is still live. Current-turn Cursor tool events repair a stale `queued` or `unknown` execution. After acceptance, the run loop does not print `waiting to send` and does not record ordinary `working` or `queued` as a delivery refusal.
