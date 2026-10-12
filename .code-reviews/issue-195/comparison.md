# Issue 195 implementation comparison (claude)

## Comparison

This compares three implementation pins:

- claude `b5372125cab35e55f695faa274db2dca0ed2f30b`
- codex `c42d14ec2da1860cc79be5e209d129025da143b7`
- cursor `61b75918d3924970935c891e50517380795266d7`

All three implement the selected codex plan (`95c3ea1c`).

### Method

- Read each bound worktree directly.
- Diffed `src/`, `test/` and `docs/` against the frozen baseline `6a04d57` inside
  each worktree.
- Traced the run-loop and tmux paths by hand.
- Ran no product suites. The statements below come from the code; the
  coordinator owns the checks at each pin.

### Shared behavior

All three pins meet the core of issues 195 and 187:

- `reminders()` lists `readStartState().agents`.
- A selection records only the agent and a request id.
- Owner requests are drained at the top of `runTick`, before the
  pause/hold/observe-only returns.
- The `"owner"` reason and its branches are removed from `deliver()`.
- Owner sends never touch `actionSafety` and never raise
  `nudge-loop`/`delivery-uncertain`.
- A successful task send calls `markActionInjected`.
- Every attempt is journalled as `nudged` or `nudge-deferred` with `owner: true`.
- The `working` and `idle-transition-already-used` messages now point the
  operator to `n`.

Scope matches across the pins. All three change the same nine approved product
files, create no new product files and add no dependencies.

None of the three changes the automatic lost-delivery proof
(`actionAbsentAtReadyPrompt`), which the selected plan left as it was. The
16:20 same-UUID reissue stall is therefore still escaped only through `n`. This
is shared and plan-conformant, so it is not held against any one pin.

### Findings

#### 1. codex: an owner reminder in the same tick suppresses a newly prepared action's only initial send

- **Location:** `src/runLoop.ts:1273` in the codex pin:
  `if (this.ownerAttemptsThisTick.has(agent)) return cursors;` at the top of
  `deliver()`.
- **Rule:** an owner reminder may stop automatic delivery from repeating *the
  text the owner just typed*. It must not cancel delivery of a different action
  prepared later in the same tick.
- **Failure:**
  - The skip covers every `deliver()` reason, including `"initial"` (called from
    the prepare path, `src/runLoop.ts:1789`).
  - Scenario: the owner presses `n` while the agent has no assignment, so it
    receives the neutral text. In the same tick the machine prepares that
    agent's next action. `orderAgentAction` records it as `ordered`, and
    `deliver("initial")` returns early.
  - On later ticks, `maybeLifecycleNudge` reaches `decideLifecycleNudge`. While
    lifecycle `execution` is `unknown`, `queued` or `background`, the result is
    a wait, and the never-sent override exists only for `working`.
    `canProveLostInjection` requires `delivery: "injected"`.
  - The action is therefore never typed until a hook reports a fresh idle
    transition.
  - `unknown` is the normal state just after launch, by the code's own
    rationale table.
  - The common case is "All agents" at startup, in the same poll that publishes
    the join action.
- **Test:** in `test/runLoop.test.ts`, on
  `safetyFixture("claude")` (initial lifecycle `unknown`):
  1. Call `loop.reminders()[0].request()` before the first tick.
  2. Run one tick, then a second tick.
  3. Expect two typed texts: the neutral reminder and then the action line.
  The codex pin types only the neutral reminder. The claude pin's case
  `"lists every configured agent and types the reminder for its state when it is
  sent"` asserts both in the first tick.
- **Fix sketch:** skip only when the owner just typed this same `actionId`, as
  the claude pin does at `src/runLoop.ts:1295`.

#### 2. cursor: copy mode is not left, so a reminder reported as sent never reaches the agent

- **Location:** `src/tmux.ts:1169` (`deliverOwnerNudge`) in the cursor pin.
- **Rule:** an owner reminder must reach the agent whenever its pane exists.
  Where tmux would route the keys elsewhere, the reminder must say it was not
  delivered rather than report success.
- **Failure:**
  - `inspectPane` returns `ownerTyping` (`pane_in_mode=1`), but the method
    ignores it and runs `send-keys -l` into the pane.
  - In tmux copy mode, `send-keys` input is consumed by the copy-mode key table,
    not the application. Literal text there runs copy-mode commands; for
    example, `q` leaves the mode part-way through.
  - The method still returns `{ status: "sent" }`, and the run loop logs
    `[OK] … owner reminder handed to tmux`. It also calls `markActionInjected`,
    so automatic delivery then waits on a send that never arrived.
  - This is the incident's own usage pattern: the owner scrolls the Cursor pane
    to inspect it, then presses `n`.
  - The pin's test `"types through copy mode, a bash foreground, …"`
    (`test/tmux.test.ts:1278`) locks this in. It asserts `sent` with
    `pane_in_mode=1` and never checks that copy mode was exited.
- **Test:** with display `"0\tagent\t1\t0\n"`, expect a
  `["send-keys", "-t", target, "-X", "cancel"]` call before the literal batch.
  The claude and codex pins both have this test.
- **Fix:** run `send-keys -X cancel` first when `pane.ownerTyping` is set, as
  the claude pin does at `src/tmux.ts:1164`.

#### 3. cursor: a state-revision change during the send aborts the tick without recording the attempt

- **Locations:** in the cursor pin:
  - `src/runLoop.ts:1095` (`ownerAuthority` rejects any `stateRevision` change);
  - `src/runLoop.ts:3092` (passed as `assertAuthority` to `deliverOwnerNudge`);
  - `src/tmux.ts:1190` (called after each runner call);
  - `src/runLoop.ts:3133` (rethrows `StateConflictError`).
- **Rule:** the plan (§6) requires a precise outcome for every owner attempt,
  including ambiguous ones. A typed reminder must not vanish from the journal.
- **Failure:**
  - The interactive controls share the process with the runner. Suppose the
    owner presses `p` or `r`, or runs `coord resume`, while the batch's
    `run-shell sleep` is in flight. `cursors.json` changes revision.
  - The `assertAuthority` that runs after the runner then throws
    `StateConflictError`. `deliverOwnerReminder` rethrows it, the drain loop
    rethrows it, and `runTick` returns without any journal entry or log.
  - The keys have already been typed, and `markActionInjected` is skipped. The
    attempt is unreported, and the automatic path may paste the same action
    again.
  - A pause or hold is exactly the time the owner is using these controls.
- **Fix sketch:** owner authority should not depend on `stateRevision`. Check
  only that the issue is not abandoned or completed, plus the binding recheck.
  Alternatively, catch the conflict inside the owner path and record it as
  `uncertain` once any key has been sent. The claude and codex pins both record
  this case.

#### 4. cursor: copies the typing code instead of sharing it

- **Location:** `src/tmux.ts:1169`–`1226` in the cursor pin.
- **Rule:** the plan says to reuse the existing key batching and the text/key
  delays rather than duplicate them.
- **Failure:** the AGY per-key path and the batched `run-shell` path are copied
  verbatim from `nudge()`. A later fix to one key layout will silently diverge
  for the other. The pin's own test `"uses the same literal and submit batch as
  an automatic nudge"` exists only to catch that drift.
- **Fix sketch:** extract one shared `typeAndSubmit`, as the claude and codex
  pins do.

#### 5. claude: minor differences, not defects

- The owner send has no issue-session recheck beyond the assignment binding.
  The codex pin also compares `issueSessionId` and the agent config.
- An exception during pane inspection is recorded as `failed` at stage
  `target`.
- Neither difference produces a wrong send or a lost record. The request queue
  is in-process and belongs to the runner that owns the interactive session.

### Tests and reuse

- **claude:**
  - One parameterized owner case across eight lifecycle, budget, reservation,
    pause and hold states.
  - One state-driven message and listing case, covering: no assignment, a menu
    opened before an assignment change, pull delivery, a pending completion, a
    binding change, accepted, dropped, and a missing pane.
  - One issue-177 reproduction, and two tmux cases.
  - It extends the existing `safetyFixture` by recording typed text.
- **codex:**
  - Broader coverage: a fourteen-state parameterized case, repeat selection,
    ambiguous attempts, and four tmux failure kinds.
  - It is correct but larger, and it does not cover the initial-send
    interaction in Finding 1.
- **cursor:**
  - Comparable breadth.
  - Its copy-mode test asserts the defect in Finding 2.

## Conclusion

Ranking: claude first, codex second, cursor third.

- **claude** has no defect found.
  - It shares the typing code.
  - It leaves copy mode before typing.
  - It records every attempt.
  - It limits the same-tick skip to the action the owner typed.
- **codex** is sound apart from Finding 1, a one-line correction. Its tests are
  more extensive than needed.
- **cursor** has three behavioral defects: copy mode (Finding 2), a lost
  attempt record when the state revision changes (Finding 3), and duplicated
  typing code (Finding 4).

No pin addresses the automatic same-UUID lost-delivery stall, because the
selected plan kept it out of scope.
