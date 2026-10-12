# Issue 195 plan: owner reminders always send; reissued actions can prove lost delivery

Issue #195 asks for three things: find why coord thought Cursor was not ready in
issue 177, fix it, and let the operator nudge any agent at any time with no
readiness, spacing or budget gates. The last part also covers #187.

## Root Cause

The evidence is `coord-runtime/issue-177/journal.jsonl`, filtered to `agent:
"cursor"`. Times are UTC on 2026-10-11.

### 1. The 16:20 stall ("already sent while the agent was idle")

- 16:19:01 coord sent action `ff2e6ee7` (digest `1dd96723…`). Cursor accepted
  it as turn `162bcbdf` (seq 3123).
- 16:19:17 the submission failed validation because the response file was
  missing (seq 3145). `reissue()` rewrote `action.md` with the **same action
  ID** and a new digest (`6e977663…`).
- 16:19:27 the turn stopped and Cursor went idle (seq 3158).
- 16:20:02 coord sent the reissued action on Stop readiness (seq 3180). Cursor
  never submitted it: no `beforeSubmitPrompt` arrived until the owner typed
  manually at 16:22:52 (seq 3182).
- 16:20:03 onward, `decideLifecycleNudge` returned
  `idle-transition-already-used` (seq 3181). That rule allows one send per idle
  epoch, so another send needs either fresh hook activity or positive proof that
  the send was lost.
- Lost-delivery proof is `TmuxController.actionAbsentAtReadyPrompt`
  (`src/tmux.ts:1021`). It returns true only when the 40-line capture
  **does not contain the action UUID** (`!captured.stdout.includes(actionId)`).
  The prompt Cursor accepted at 16:19:01 (`Read and execute coordinator action
  ff2e6ee7… digest 1dd96723…`) was still on screen above Cursor's reply and its
  `COORD-IDLE` line. The UUID was therefore always visible, the proof could never
  succeed, and `maybeLifecycleNudge` (`src/runLoop.ts:1861`) waited for activity
  that never came.
- Elimination of the other conditions confirms this. Each of these held from
  16:20:47 onward:
  - delivery was `injected` with `turnId` null, from `markActionInjected`;
  - execution was idle, with no pending input or background work (deferral
    snapshot, seq 3181);
  - the 45 s delay had elapsed;
  - there was no ready file for a newer accepted action;
  - pane inspection was succeeding.
- Compare stall 1, where the action ID was new and so not on screen. There,
  `prompt-ready-action-absent` fired about 45 s after every lost send (seq 2943,
  2986, 2992, 2998). In stall 2 it never fired.

### 2. The owner's `n` that was "deferred by readiness, send spacing or a hold"

- 16:12:03.734 the owner released hold `01edf7dd` with a budget reset (seq 3003).
- 16:12:06 the coordinator's own poll sent automatically, setting `sends` to 1
  (seq 3006).
- The owner pressed `n` within the next 60 s. `deliver()` (`src/runLoop.ts:1211`)
  applies `NUDGE_REPEAT_DELAYS_MS[sends - 1]`, which is 60 s, to owner sends.
  It returned `cursors` unchanged before reaching tmux, so nothing was journaled.
  The run-loop caller (`src/runLoop.ts:3086`) cannot tell which early return
  happened, so it prints all three possibilities.
- This was the spacing gate. Other gates are ruled out:
  - no `hold-created` event, so it was not the budget;
  - no `nudge-deferred` scrape event, so it was not a pane refusal;
  - no "task/activity changed" warning.
- At 16:13:07 the automatic idle send (seq 3009, `idle: true`, not `owner`)
  went out once the 60 s had passed.

### 3. Overnight idle

- Coord sent action `9f6923bb` four times: 00:28:18, 00:29:19, 00:31:20 and
  00:35:21.
- Each send's text later disappeared from Cursor's prompt, which proved it lost.
- After the fourth, the four-send budget created a `nudge-loop` hold at 00:36:06
  (seq 2999). That hold pauses the whole issue until the owner releases it, and
  the release came at 16:12:03.
- Meanwhile `reminders()` refused every `n` with "Release pauses/holds before
  requesting a reminder", so the owner could not push Cursor from coord at all.
- The journal records only transport success and later absence. It does not
  record why Cursor dropped the keystrokes, so this plan does not change the
  Cursor key sequence. It removes the owner-side blocks instead.

### 4. Issue 187

`reminders()` (`src/runLoop.ts:936`) lists an agent only when:

- it is in the active roster;
- it has `status === "ordered"`;
- its `action.md` exists.

Agents that are `verifying`, `waiting-peer` or dropped, or that have no current
file, cannot be reminded.

## Exact File List to be changed or deleted

- `src/runLoop.ts`
  - Owner reminders:
    - Replace the `ownerReminders` map of action, digest, session and sequence
      identities with a `Set<string>` of agent ids.
    - `reminders()` lists **every configured agent** (`readStartState(...)
      .agents`), whatever its roster, status, pause, hold or completion state.
    - `request()` only adds the id to the set and never throws. It returns
      `Reminder queued for <agent>; it is typed into the agent's terminal on the
      coordinator's next poll.`
    - Delete the cancel loop at the top of `runTick`, lines 3019-3025.
    - Delete the owner branch in the per-agent loop, lines 3071-3088,
      including the "deferred by readiness, send spacing or a hold" message.
    - Add a private `sendOwnerReminder(start, cursors, agent)`. `runTick` calls
      it for each queued id before any pause, completion or abandoned early
      return, and removes the id first.
  - What `sendOwnerReminder` sends:
    - If the agent has a current `actionId` and `action.md` exists, it sends
      `renderNudgeText(path, actionId, sha256OfFile(path))`. Otherwise it sends
      the generic `renderNudgeText(path)`.
    - It requires coordinator authority, through the existing
      `this.authority(cursors)` callback.
    - It never reads or charges `actionSafety`: no `sends` increment, no
      reservation, no `nudge-loop` or `delivery-uncertain` hold.
  - When a send with a current action succeeds, `sendOwnerReminder`:
    - calls the existing `markActionInjected(...)`, so the prompt hook still
      correlates the submission and automatic sends do not duplicate it in the
      same idle epoch;
    - appends the existing `nudged` journal event with `{ actionDigest,
      readiness: "owner", owner: true }`;
    - logs `[OK] Reminder sent to <agent>.`
  - On failure it logs one exact cause, `[WARN] <agent>: reminder not sent:
    <cause>`, for one of three cases:
    - no terminal controller;
    - the agent window is missing or dead;
    - a tmux error, with its text.
  - Remove `"owner"` from `deliver()`'s `reason` union and delete every
    `owner`-only branch inside it. That covers the queued veto, the owner
    `IdleOverride`, the owner digest re-check in the authority callback, and the
    `[OK] Reminder sent` log. Automatic `initial`, `idle` and `reissue` delivery
    is unchanged.
  - The `maybeLifecycleNudge` call to `tmux.actionAbsentAtReadyPrompt` is
    unchanged, because the fix is inside the tmux method.
- `src/tmux.ts`
  - Fix `actionAbsentAtReadyPrompt`. A UUID that appears only **above the latest
    `COORD-IDLE` sentinel** is old scrollback, not the pending send. Return
    `harnessPromptReady(...) && (!stdout.includes(actionId) ||
    idleSentinelAfterAction(stdout, actionId))`. This reuses the exported
    `idleSentinelAfterAction` at `src/tmux.ts:226`, which already applies this
    "sentinel newer than the action" rule to readiness.
  - A UUID below the latest sentinel, or a UUID with no sentinel at all, still
    counts as present. Typed text sitting in the composer therefore never looks
    absent.
  - Add `async remind(issue, agent, text): Promise<{ status: "sent" } | {
    status: "gone"; reason: string }>`. It does three things in order:
    - Inspect the pane. A missing or dead pane returns `gone`.
    - If the pane is in tmux copy mode (`pane_in_mode`), run `send-keys -t
      <target> -X cancel` so the keys reach the agent rather than copy mode.
    - Capture the pane once, resolve keys with the existing `resolveNudgeKeys`,
      then type the text and submit.
  - `remind` applies no prompt-readiness, foreground, composer, lifecycle or
    spacing checks.
  - Extract the existing typing body of `nudge()` (the Antigravity per-key path
    and the batched `run-shell` path) into a private `typeAndSubmit(target,
    agent, text, prelude, submit, send)`. `nudge()` passes its gated `send`, and
    `remind()` passes an ungated runner call. Key layout and timing stay the same
    for both.
- `src/interactive.ts`
  - Help line 32 becomes: `n: Type a reminder of its current coordinator action
    into any agent's terminal, or into all of them; sent on the next poll
    whatever the agent's state, pauses or holds.`
  - Line 40 becomes: `If a reminder is not sent, coord prints the exact cause.`
- `src/cli.ts`
  - Help text lines 309-311 change in the same way. Drop "Reminders retain
    readiness checks and send limits; inspect/type in the agent terminal if
    refused" and say that `n` reminds any agent at any time.
- `docs/coord-driver.md`
  - Change the `n` row at line 691.
  - Rewrite the `n` paragraph at lines 711-718. It should say:
    - `n` reminds any configured agent;
    - the reminder is sent on the next poll during pauses and holds;
    - it is bound to nothing beyond the agent;
    - it skips readiness, spacing and budget checks;
    - it never clears files, restarts tasks or resets the automatic budget;
    - a missing pane is the only refusal.
  - At line 772, drop "(including owner reminders)" from the budget sentence.
  - In the delivery-safety section, add one sentence: lost-delivery proof
    ignores an action UUID shown only above the latest `COORD-IDLE` line.
- `test/runLoop.test.ts`: the cases described under Tests.

## Exact file list to be created

- `.plans/issue-195/plan.md`. This plan is the only new file.
- No product file is created. Every change extends the existing `runLoop.ts`,
  `tmux.ts` and `runLoop.test.ts`.

## Reuse and Scope

Existing code the implementation reuses:

- **Nudge text:** `renderNudgeText` (`src/tmux.ts:405`), so the operator sends
  the same text the coordinator sends.
- **Keys:** `resolveNudgeKeys`, `vimInsertPrelude` and `codexVimInsert`.
- **Pane access:** `TmuxController.inspectPane`, `capturePane` and `target`.
- **Typing:** the existing typing body of `nudge()`, extracted rather than
  copied.
- **Lifecycle:** `markActionInjected` keeps hook correlation and the
  one-send-per-idle-epoch rule.
- **Journal:** `appendJournal` with the existing `nudged` event shape, which
  already carries an `owner: true` flag.
- **Run-loop plumbing:** `this.authority(cursors)`, `agentRuntimePaths`,
  `sha256OfFile`, `readStartState` and `readCursorsState`.
- **Lost-delivery proof:** `idleSentinelAfterAction` (`src/tmux.ts:226`).
- **Tests:** `safetyFixture`, its tmux fake (`ui.sends`, `ui.busy`, `ui.dead`,
  `ui.text`), `fixture()`, `NUDGE_RETRY_MS`, `readJournal`, `setPaused` and
  `mutateCursorsState`.

Out of scope:

- The automatic delivery budget, the 60/120/240 s spacing, the `nudge-loop` and
  `delivery-uncertain` holds, and automatic readiness checks. The owner asked to
  remove constraints from the operator's nudge. The automatic budget is what
  stops coord from typing endlessly into a TUI that discards keys.
- The Cursor key sequence. The logs cannot show why Cursor discarded the 00:28
  and 16:20 sends, so changing keys would be guesswork.
- Any version bump.

New code is limited to three pieces:

- `sendOwnerReminder` (run loop);
- `remind` (tmux);
- `typeAndSubmit`, an extraction that avoids a second copy of the typing code.

## Tests

All cases go in the existing `test/runLoop.test.ts`, in the `describe("owner
reminders and advisory diagnostics")` block or next to `"recovers lost %s
delivery without a degraded-health flag"`.

1. **New:** `"sends an owner reminder at once regardless of spacing, budget,
   pause, holds, lifecycle or copy mode"`.
   - Setup: `safetyFixture("claude")`, one tick for the initial send, then
     `f.working()`, `f.ui.busy = true`, a manual pause and a `nudge-loop` hold.
   - `loop.reminders()[0].request()` then `runTick()`. Expect:
     - `ui.sends` is 2;
     - `actionSafety.claude.sends` is still 1 and `reserved` is false;
     - the journal has `nudged` with `owner: true` and the current digest;
     - the log has `[OK] Reminder sent to claude.`
   - Request again with no time advance. Expect `ui.sends` to be 3, with no
     spacing.
   - Set `f.ui.dead = true` and request. Expect `ui.sends` to stay 3 and the log
     to say `reminder not sent`.
   - This fails before the change: the request throws "Release pauses/holds",
     and spacing blocks the send.
2. **New:** `"lists every configured agent for an owner reminder (#187)"`.
   - Setup: `fixture()`, a loop with `tmux: null`, before any tick, so no agent
     has an action.
   - Expect `loop.reminders().map((item) => item.label)` to equal `["claude",
     "codex"]`.
   - This fails before the change, which returns `[]`.
3. **New:** `it.each(["claude", "cursor"])("proves lost %s delivery when the
   action UUID is only above the idle sentinel")`.
   - Setup: `safetyFixture(vendor, { nudgeRetryMs: NUDGE_RETRY_MS })` and one
     tick, so the action is injected with execution unknown.
   - Set `f.ui.text` to `` `${actionId}\n${COORD_IDLE_SENTINEL}` ``. Advance
     `NUDGE_RETRY_MS` and tick. Expect delivery `ordered` and a
     `prompt-ready-action-absent` journal event.
   - Advance 60 s and tick. Expect `ui.sends` to be 2.
   - Control case: with `` `${COORD_IDLE_SENTINEL}\n${actionId}` ``, which means
     the text is still in the composer, expect no absence event and
     `ui.sends === 1`.
   - This fails before the change, because the UUID anywhere in the capture
     blocked recovery. That is the 16:20 stall.
4. **Existing cases rewritten or removed**, because they assert the old owner
   constraints:
   - Delete `"rejects a stale menu selection rather than reminding a replacement
     action"`. Test 1 now covers the current action, read at send time.
   - Delete `"reminds the same accepted task only on explicit request and fresh
     idle proof, retaining spacing and budget"`.
   - Delete `it.each([...])("refuses a queued reminder on %s without resetting
     its allowance")`.
   - Delete `"keeps a charged reservation when owner authority changes after
     reminder text"`.
   - Around line 2403, drop the `draft = "owner is editing"` veto half: the
     first request now sends.
   - Lines 2758 and 2867 use `tmux: null` loops. Drop `reminder not sent` from
     their negative assertions, or remove the reminder request: a terminal-less
     loop now reports it explicitly.

`test/interactive.test.ts` and `test/cli.test.ts` use fakes for `reminders()` and
do not assert the help copy, so they are unchanged.

Commands:

- While developing: `pnpm vitest run --config vitest.config.ts
  test/runLoop.test.ts test/tmux.test.ts`.
- On commit: the hook runs `pnpm check:fast` (lint, typecheck, fast and system
  tests). Do not rerun it by hand.
- The coordinator owns `pnpm check`, which adds the build and e2e tests.

## Alternatives Rejected

- **Check digest absence instead of UUID absence in
  `actionAbsentAtReadyPrompt`.** This is more exact for reissues. But a 64-hex
  digest can be wrapped by the TUI, which would cause false "absent" results and
  duplicate typing. Many existing fixtures also treat a bare UUID on screen as
  "still pending" (for example `"waits for quiet $vendor work"`). The sentinel
  rule fixes the observed stall and keeps all of those fixtures unchanged.
- **Give reissued actions a new action ID.** This would avoid the stale UUID,
  but it changes `reissue()` semantics, journal identity, response paths and
  ballot bindings for every step. That is much larger than the defect.
- **Drop the one-send-per-idle-epoch rule, or the automatic budget and spacing,
  for all sends.** Rejected. The owner asked for an unconstrained *operator*
  nudge. Removing automatic limits brings back the endless typing loop that the
  `nudge-loop` hold exists to stop. With `n` usable during a hold, the owner
  already has the override.
- **Keep owner reminders inside `deliver()` with an `owner` bypass flag.** That
  threads exceptions through reservation, budget, override and hold code, which
  is how the current three-reason ambiguity arose. A separate
  `sendOwnerReminder`/`remind` path is smaller and has one failure cause per
  message.
- **Send the reminder synchronously from the `n` menu.** `request()` is
  synchronous, and the tmux client is owned by the run loop under coordinator
  authority. Queueing for the next poll costs one `pollIntervalMs` delay.

## Risks and Mitigations

- **Duplicate prompts when the owner reminds a working agent.** That is the
  owner's explicit choice. `markActionInjected` keeps automatic sends from
  adding another copy in the same idle epoch, and the automatic budget is not
  reset.
- **Typing while the owner is in copy mode in that pane.** `remind` cancels
  copy mode first, so keys reach the agent instead of copy-mode bindings.
- **A UUID below a sentinel the agent printed in prose.** The sentinel must be
  the exact full line (`COORD_IDLE_SENTINEL`). A UUID after the last sentinel
  still counts as present, so this can only delay recovery, never duplicate a
  composer draft. Test 3's control case covers this.
- **Stale scrollback hiding a real queued copy.** Recovery still needs every
  existing `canProveLostInjection` condition: `injected`, `turnId` null, idle or
  unknown, no pending input or background work, and the 45 s delay. It still
  needs `harnessPromptReady` too. Only the UUID-visibility rule changes.
- **Reminder when no action is current.** The generic `Read and execute your
  current coordinator action at <path>` text is sent. AGENTS.md already tells
  agents what to do when `action.md` is missing: write `ready` and idle.
- **Extracting `typeAndSubmit` changes `nudge()` behaviour.** It is a pure
  move with the gated `send` passed in. The existing `test/tmux.test.ts` nudge
  key-sequence tests and the `runLoop.test.ts` delivery tests guard it
  unchanged.

## Conclusion

Coord believed Cursor was not ready at 16:20 because of the action UUID. The
one-send-per-idle-epoch rule waits for proof that the reissued action's send was
lost. The proof required the action UUID to be absent from the pane, and the
same UUID was still visible from the earlier accepted prompt.

The owner's `n` was refused by the 60 s spacing gate, which still applied to
owner sends. The overnight stop was the four-send hold, and that hold also
blocked `n`.

The fix has three parts:

- Ignore a UUID shown only above the latest `COORD-IDLE` line when proving lost
  delivery.
- Make `n` list every configured agent and type the current action reminder on
  the next poll, with no readiness, spacing, budget, pause or hold constraints.
  This also fixes #187.
- Report the exact cause when a reminder cannot be typed.

Automatic delivery safety is unchanged. The work touches `src/runLoop.ts`,
`src/tmux.ts`, two help strings, `docs/coord-driver.md`, and focused cases in
`test/runLoop.test.ts`.
