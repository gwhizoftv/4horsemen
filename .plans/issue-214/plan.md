# Issue 214 plan — handoff tracking: stale Stops, queued input, reread pickup, tool activity

Issue #214 reports that coord conflates three events: an action completing, a
prompt being queued, and an agent's turn actually ending. Four defects follow,
each traced below to the line in this repo that the issue's installed-copy
citation corresponds to:

1. **Older Stop overwrites the newer turn** (`src/agentLifecycle.ts:662-672`).
   When a Stop carries a turn id older than the current action turn,
   `stoppingOlderTurn` forces `execution = "queued"`. It also overwrites
   `turnId` with the old Stop's id at line 593. Cursor then worked 58 tool calls
   while status said "accepted work that has not started". The same branch also
   turns an already-idle agent into `queued` when a late older Stop arrives,
   because `action.turnId` survives the idle Stop.
2. **Queued input mistaken for a new turn** (`src/agentLifecycle.ts:631-648`,
   `662-677`). Claude's `UserPromptSubmit` for input typed during a still-running
   turn carries that running turn's id. The running turn's Stop then matches
   `action.turnId`, so coord records `idle`, advances `idleEpoch`, and
   `decideLifecycleNudge` authorizes a duplicate send (journal line 185 in the
   issue).
3. **Reread pickup is never acknowledged** (`src/runLoop.ts:2002`, and
   `orderAgentAction` at `src/agentLifecycle.ts:286`). The protocol tells agents
   to reread `action.md` after `complete` and execute a replacement immediately.
   Coord orders the replacement while that turn is still live. It never records
   that the turn will pick the replacement up, so `journalDeferral` decides
   `gateWaiting` from `cursors.agents[agent].status === "ordered"` alone and
   prints `[WAIT] ... waiting to send`. It does the same for actions whose
   delivery is already `accepted`.
4. **Tool activity does not repair lifecycle state** (`src/agentEvent.ts:398`).
   Cursor `postToolUse` / `postToolUseFailure` are journaled only as usage.
   `normalizeAgentEvent` returns `null` for them, so current-turn activity
   cannot correct a stale `queued`.

The two long holds the issue mentions trace to missing revision instructions
(a separate defect). They are out of scope here.

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts`
  - `lifecycleActionSchema`: add two **optional** fields. Both are optional, so
    existing state files and test fixtures stay valid without migration.
    - `queuedBehindTurnId: z.string().min(1).optional()`: the live turn this
      accepted action's prompt was queued into.
    - `rereadExpected: z.literal(true).optional()`: the action was ordered while
      the turn that completed the previous action was still live.
  - `LifecycleObservation.kind`: add `"tool-activity"`.
  - `applyLifecycleObservation`:
    - **(fix 1)** In the `stopped` branch, when `stoppingOlderTurn` is true and
      `pendingInputCount` is not > 0, keep `entry.execution`, `entry.stoppedAt`,
      and `entry.turnId` unchanged instead of forcing `queued`. Also keep
      `turnId` at line 593 from taking the older Stop's id in that case.
      `pendingInputCount > 0` still yields `queued`, exactly as today.
    - **(fix 2)** In the `prompt-submitted` branch, when the prompt correlates
      to the current action and all of the following hold, set
      `action.queuedBehindTurnId = observation.turnId`:
      - `entry.execution === "working"` and `entry.stoppedAt === null`
      - `observation.turnId !== undefined` and
        `observation.turnId === entry.turnId`
      - the action was not already accepted on that same turn. This excludes a
        duplicate delivery of the same callback:
        `!(entry.action.delivery === "accepted" && entry.action.turnId === observation.turnId)`.

      In the `stopped` branch, a Stop whose turn id equals
      `action.queuedBehindTurnId`:
      - sets `execution = "working"`, `stoppedAt = null`, and `turnId = null`
      - clears the marker and `action.turnId`, so the next Stop of any id ends
        the queued work
      - does not advance `idleEpoch`, because `execution` is not idle
      - resets `stopObservation.turns` but leaves `stoppedActionId` null; this is
        advisory data only.
    - **(fix 4)** New `tool-activity` handling. If any of the following fails,
      return `entry` unchanged (same reference):
      - `observation.sessionId === entry.sessionId`
      - `observation.turnId === (entry.stopObservation.turns.at(-1) ?? entry.turnId)`
      - `entry.stoppedAt === null`
      - `entry.execution` is `"queued"` or `"unknown"`

      Otherwise set `execution = "working"`. It never touches the action,
      `idleEpoch`, or `stoppedAt`, so a late tool event can never revoke a Stop
      or start a turn.
    - **(fix 3)** Clear `rereadExpected` whenever the computed execution becomes
      `idle` or `failed`, and in the existing `sessionChanged` action reset.
      Either one ends the turn the expectation was tied to.
  - `orderAgentAction`: when replacing the action, set `rereadExpected: true`
    if all of the following hold:
    - the previous action is a different `actionId`
    - its `workflowCompleteAt !== null`
    - its `sessionId === current.sessionId !== null`
    - `current.execution === "working"` and `current.stoppedAt === null`

    When the same `actionId` is re-ordered with a new digest (the
    `rewriteOrderedAction` path), carry the existing `rereadExpected` forward.
  - `markActionInjected`, `markInjectedActionAbsent`: drop `rereadExpected`
    once coord itself types the prompt; delivery is then tracked by the existing
    injected/accepted path. `queuedBehindTurnId` needs no handling here.
    `markActionInjected` spreads `...action`, and only `prompt-submitted` sets
    the marker.
  - `markActionWorkflowComplete`: add `pickedUpByReread: boolean` to
    `WorkflowCompleteResult`. It is true when the completed action was never
    sent (`delivery === "ordered" && injectedAt === null`). Coord sent no prompt
    and received no submit callback, yet the agent completed it, so it read
    `action.md` on its own.
  - `observeAgentLifecycleWithResult`: exempt `tool-activity` from the
    `hookReceipt` bump, exactly as `telemetry` is exempt today. A Cursor
    `postToolUse` for the shell call that wrote `ready` arrives after the file.
    Counting it as a hook would make `readyForNextAction`'s
    `writtenAt > lastHook` rule reject that ready receipt in the missing-Stop
    case.
  - Export `rereadPickupPending(entry, actionId)`. It is true when all of the
    following hold:
    - `entry.action.actionId === actionId`
    - `rereadExpected === true`
    - `delivery === "ordered"` and `injectedAt === null`
    - `workflowCompleteAt === null`
    - `entry.execution === "working"`

    `runLoop` and `issueReport` use it for one shared definition.
- `src/agentEvent.ts`: in the `cursor` branch of `normalizeAgentEvent`, map
  `posttooluse` / `posttoolusefailure` to
  `{ kind: "tool-activity", eventName, sessionId, turnId }`, built from the
  existing `common` object. `handleAgentEvent` already processes the lifecycle
  observation and the usage record independently, so usage journaling is
  unchanged. Lifecycle is journaled only when `result.changed`, because
  `tool-activity` is not a turn boundary.
- `src/runLoop.ts`, `journalDeferral` (line 2002):
  - Compute `gateWaiting` as `status === "ordered"` **and not**
    (`delivery accepted or workflow-complete for this actionId`, the predicate
    `remind` already uses at line 2006) **and not**
    `rereadPickupPending(entry, actionId)`.
  - When the deferral is suppressed for those two reasons, the verbose line says
    `Issue N: <agent> is working; <the action was accepted | it is expected to
    pick up action <id> by rereading action.md>; no reminder needed`. It no
    longer says "waiting to send". The journal row gains
    `rereadExpected: true` when applicable.
  - Delivery gates are untouched: `deliver()` keeps its `staleWorking`
    sentinel/ready-file rescue, so the missing-Stop recovery is preserved.
- `src/runLoop.ts`, the two `accept*` sites that call
  `markActionWorkflowComplete` (lines 2248 and 2506): when
  `completion.pickedUpByReread`, append one
  `agent-lifecycle` journal event
  `{ event: "action-picked-up-by-reread", actionId }` and log
  `Issue N: <agent> picked up action <id> by rereading action.md; no prompt was needed.`
- `src/issueReport.ts`: in the per-agent status line, when
  `rereadPickupPending(entry, entry.action.actionId)`, render the delivery as
  `task file published; agent expected to pick it up by rereading action.md`
  instead of `task file published; not yet sent`.
- `test/agentLifecycle.test.ts`, `test/agentEvent.test.ts`,
  `test/runLoop.test.ts`, `test/issueReport.test.ts`: new cases listed under
  Tests.

## Exact file list to be created

None. Every change extends an existing module and its existing test file.
`.plans/issue-214/plan.md` is this coordination artifact, not product code.

## Reuse and Scope

Reused, not duplicated:

- `applyLifecycleObservation`, including:
  - `stoppingOlderTurn` and `currentActionTurn`, which already compute "this
    Stop belongs to an older turn"; fix 1 changes only the consequence
  - `stopObservation.turns.at(-1)`, as the newest-submitted-turn source for the
    tool-activity guard
  - `positiveIdle`, which governs `idleEpoch`; the queued-behind Stop avoids an
    epoch advance simply by not producing `idle`
- `decideLifecycleNudge`: unchanged. Fixes 1 and 2 work by keeping `execution`
  truthful, so the existing `working` wait does the gating.
- `observeAgentLifecycleWithResult`: its existing `telemetry` exemption for
  `hookReceipt` is extended to `tool-activity`.
- `normalizeAgentEvent` cursor `common` object; `normalizeCursorUsageEvent` and
  the `agent-usage` journal are unchanged.
- `journalDeferral`: the accepted/workflow-complete predicate already used for
  `remind`, and its existing `this.log` / `this.verbose` split.
- `markActionWorkflowComplete` and its `WorkflowCompleteResult`. The reread
  acknowledgement follows the existing `clearedDegraded` pattern: one result
  flag, then a journal event and log at the two accept sites.
- `renderIssueReport` delivery wording table.
- Test helpers and fixtures:
  - `entry()`, `initialAgentLifecycle`, `runtimeFixture` / `issueRuntimePaths` /
    `createIssueRuntime` in `test/agentLifecycle.test.ts` and
    `test/agentEvent.test.ts`
  - the `fixture()` + `TmuxController` stub pattern in the existing
    "journals each deferred reason once across repeated ticks and restarts"
    case in `test/runLoop.test.ts`
  - `initialAgentLifecycle` + `start()`/`complete()` in
    `test/issueReport.test.ts`

Scope limits:

- No change to `src/tmux.ts` readiness scraping or `deliver()` send gates.
- No new vendor hooks. `agentHookSync.ts` already installs Cursor
  `postToolUse` / `postToolUseFailure`.
- Codex/Claude tool events are not routed to `agent-event` (only the
  shell-guard `PreToolUse`). Fix 4 is therefore Cursor-only, matching the
  evidence in the issue.
- No protocol or `AGENTS.md` change, and no new agent-written acknowledgement
  file. Reread pickup is inferred from evidence coord already holds (fix 3) and
  confirmed at acceptance.
- No `AGENT_LIFECYCLE_FORMAT_VERSION` bump: both new fields are optional.

## Tests

Each case fails on the baseline and passes after the change.

`test/agentLifecycle.test.ts`, in `describe("agent lifecycle policy")`:

1. **Older Stop preserves the newer turn** (Cursor 9:44 sequence).
   - Setup: session-start, then prompt-submitted `gen-old`, then an accepted
     action prompt `gen-new`; a Stop for `gen-old` follows.
   - Expect `execution: "working"`, `turnId: "gen-new"`, `stoppedAt: null`, and
     `decideLifecycleNudge(...).code === "working"`.
   - Baseline yields `queued`.
   - Second half: after the `gen-new` Stop (idle, `stoppedAt` set), a late
     `gen-old` Stop leaves `execution: "idle"` and `stoppedAt` unchanged.
   - An entry with `pendingInputCount: 1` still yields `queued`.
2. **Prompt queued into a live turn does not let that turn's Stop count as
   idle** (Claude 9:52 sequence).
   - Setup: working on turn `T` for action A (accepted, `workflowCompleteAt`
     set); order and inject action B; prompt-submitted for B with turn id `T`;
     then Stop `T`.
   - Expect `execution: "working"`, `idleEpoch` unchanged,
     `decideLifecycleNudge` returns wait `working` and not `send`. Baseline
     sends.
   - A following Stop (any turn id) yields `idle` with an advanced epoch.
   - A duplicated prompt-submitted for an action already accepted on `T`
     followed by Stop `T` still yields `idle`, which guards against a stuck
     `working`.
3. **Tool activity repairs only the current turn.**
   - From a `queued` entry whose newest turn is `g2`: `tool-activity` for `g2`
     gives `working`. Baseline: kind unhandled, stays `queued`.
   - `tool-activity` for `g1`, from another session, or after a `g2` Stop
     returns the same entry (`toBe`).
   - Through `observeAgentLifecycleWithResult` on a runtime, a no-op
     tool-activity leaves `hookReceipt` unchanged.
4. **Reread expectation and acknowledgement.**
   - `orderAgentAction` for B while A is workflow-complete in the same live
     working session sets `rereadExpected: true`, and `rereadPickupPending` is
     true.
   - When the entry is idle instead, it is not set.
   - `markActionWorkflowComplete` on the never-sent B returns
     `pickedUpByReread: true`; on an injected action it returns `false`.

`test/agentEvent.test.ts`: extend
"normalizes Cursor analytics hooks for tools and token usage". Expect
`normalizeAgentEvent("cursor", { hook_event_name: "postToolUse", conversation_id, generation_id })`
to equal `kind: "tool-activity"` with matching `sessionId` / `turnId`. The
baseline returns `null`. The existing "journals Cursor tool and token usage
without mutating lifecycle on analytics-only hooks" case must keep passing
unchanged (no session or turn yet, so the guard is a no-op).

`test/runLoop.test.ts`: one new case beside "journals each deferred reason once
across repeated ticks and restarts", reusing its fixture.

- Setup: the codex action is accepted and the agent is working
  (`orderAgentAction`, `markActionInjected`, correlated prompt-submitted).
- Expect the `nudge-deferred` row for code `working` to have
  `gateWaiting: false`, and no logged message to contain
  `waiting to send to codex`.
- The baseline has `gateWaiting: true` and prints `[WAIT]`.
- The same assertion is repeated for a never-sent action with
  `rereadExpected` while working.

`test/issueReport.test.ts`: extend
"shows delivery, execution, health, queue, and background state" with a
reread-pending entry. The rendered line contains
`agent expected to pick it up by rereading action.md`.

Commands: run focused tests during development with
`pnpm vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/agentEvent.test.ts test/runLoop.test.ts test/issueReport.test.ts`.
The pre-commit hook owns `pnpm check:fast`; the coordinator owns the final
`pnpm run check` at the approved pin.

## Alternatives Rejected

- **Treat every Stop whose id matches the current turn as idle, and fix only
  reporting.** This leaves the Claude duplicate send (fix 2) in place. That is
  the only defect in the issue that causes a real second prompt, not just
  misleading text.
- **Represent queued input through `pendingInputCount`.** Increment it on the
  same-turn prompt and decrement it on Stop. Antigravity sets
  `pendingInputCount` authoritatively from its status line, and the
  `pending-input` wait would also block the follow-on Stop. Either change would
  alter Antigravity semantics. An explicit, action-scoped `queuedBehindTurnId`
  is cleared when the action is replaced and touches no other vendor.
- **Mark a reread-expected action `delivery: "accepted"` at order time.** That
  would disable `readyForNextAction` (which requires `ordered`) and the
  `staleWorking` sentinel rescue, the only recoveries when a Stop hook never
  arrives. The plan keeps delivery `ordered` and changes only reporting, plus
  the post-hoc acknowledgement.
- **Skip the tmux scrape entirely while a reread is expected.** This is quieter
  but removes the missing-Stop rescue for agents that do not write `ready`. The
  scrape only types when the pane shows `COORD-IDLE`, and fix 2 now handles the
  queued-input case that typing into a finishing turn creates.
- **Detect reread by parsing shell-guard `PreToolUse` commands that read
  `action.md`.** Coverage is partial: the Read tool, Cursor reads, and
  non-shell reads are invisible. It would also couple the containment guard to
  lifecycle state.
- **Add Codex/Claude tool hooks for fix 4.** That needs hook-installation
  changes and is not what the issue's evidence calls for; Cursor is the vendor
  that showed the stale `queued`.

## Risks and Mitigations

- **A wrong queued-behind detection leaves an agent "working" with no Stop to
  follow.** Detection requires all three: a live working turn, the same turn
  id, and an action not already accepted on that turn, so duplicate callbacks
  cannot trigger it (test 2, last assertion). If it still misfires, the agent's
  `ready` file and the existing `staleWorking` rescue only apply to never-sent
  actions. The next action, however, is never-sent, so delivery is not
  permanently blocked.
- **Preserving `working` on an older Stop could mask a newer turn that already
  ended.** That newer turn's own Stop matches `currentActionTurn` and still
  produces `idle` through the unchanged branch (test 1).
- **Tool activity could revoke readiness or ready receipts.** It is guarded to
  the newest submitted turn, ignored once `stoppedAt` is set, never moves
  `idle` / `failed` / `working`, and does not bump `hookReceipt` (test 3).
- **`rereadExpected` could hide a genuine delivery wait from stdout.** It is
  reporting-only: `rereadPickupPending` also requires `execution === "working"`.
  It is cleared on any idle or failed transition, on session change, and on
  coord's own injection. Once the turn ends without pickup, the normal
  `[WAIT]` output and nudge resume.
- **Schema compatibility.** Both fields are optional on a `.strict()` schema.
  Old `agent-lifecycle.json` files parse, and existing test literals typecheck
  without edits.
- **Line-number drift from the issue's installed copy.** The issue cites the
  installed tree (`runLoop.ts:1992`). This plan maps each citation to the
  repo's current code at the baseline (`journalDeferral` `gateWaiting`,
  line 2002).

## Conclusion

Fix lifecycle truth at its source:

- An older Stop no longer downgrades a newer turn.
- A prompt queued into a live turn defers that turn's Stop from counting as
  idle, which removes the duplicate send.
- Current-turn Cursor tool activity repairs a stale `queued` or `unknown`.

Then make reporting honest. Accepted or reread-expected work is reported as
"working" without a `[WAIT] waiting to send` line. Actions completed without
any prompt are explicitly acknowledged as picked up by reread. Changes are
confined to `agentLifecycle.ts`, `agentEvent.ts`, `runLoop.ts`
(`journalDeferral` and the two accept sites), `issueReport.ts`, and four new or
extended cases in the existing test files. Delivery gates and recovery paths
are unchanged.
