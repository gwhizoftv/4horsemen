# Issue 195 plan review (claude)

This review covers three plans, each at `.plans/issue-195/plan.md` at the bound
pin:

- codex `95c3ea1c4f48148ff730cffa2a54039f3ecc7735`
- claude `04aeec5a2504ce5998bd3da0f752e408692314c7`
- cursor `550a927a18c330a7a46d43468464e4f6e9712740`

## Evidence used

- The plans were read from the bound input files.
- The issue-177 runtime journal was read directly. Sequence numbers below are
  journal `sequence` values.
- Code was checked at the baseline in this clone: `src/runLoop.ts` and
  `src/tmux.ts`.
- No product tests were run. None were needed to establish these findings.

## Findings

### 1. codex and cursor: the automatic 16:20 stall is left in place [blocking]

- **Plan claim:**
  - **codex**, Implementation behavior §6 and Reuse: automatic delivery stays
    as it is, except that the `idle-transition-already-used` explanation is
    reworded to point the owner to `n`.
  - **cursor**, Operator `n` contract, last bullet: "Automatic
    `maybeLifecycleNudge`, lost-delivery proof, spacing, and the four-send hold
    stay as they are."
  - **cursor**, Reuse and Conclusion: the `16:20:03` line is described as a
    once-per-code print that "stays on screen after the send has already
    happened".
- **Rule:** the issue asks for the root cause of coord treating an idle Cursor
  as not ready, and asks for it to be fixed. When a send is lost while the agent
  stays idle, the coordinator's own lost-delivery recovery must be able to prove
  the loss and retry. Owner action must not be the only way out.
- **Failure if followed:**
  - At `16:19:17` (seq 3145), `ff2e6ee7` was reissued with the same action UUID
    and a new digest.
  - The `16:20:02` send (seq 3180) was never submitted. No `beforeSubmitPrompt`
    arrived before the owner typed at `16:22:52` (seq 3182).
  - Recovery needs `TmuxController.actionAbsentAtReadyPrompt`
    (`src/tmux.ts:1021`) to return true. It returns false whenever
    `captured.stdout.includes(actionId)`. Cursor's accepted `16:19:01` prompt,
    which contains that same UUID, was still visible above its reply and its
    `COORD-IDLE` line.
  - In stall 1 the UUID was new. There, `prompt-ready-action-absent` fired about
    45 s after every lost send (seq 2943, 2986, 2992, 2998). After `16:20:02` it
    never fired in 170 s.
  - None of the other `canProveLostInjection` conditions blocked recovery:
    - delivery was `injected` with a null turn;
    - the agent was idle, with no pending input or background work (seq 3181
      snapshot);
    - the 45 s delay had elapsed.
  - No new idle epoch or ready-file proof can arrive either, because the agent
    is idle and silent.
  - Under either plan, the coordinator therefore still waits indefinitely in
    exactly the reported state ("this task was already sent while the agent was
    idle; waiting for fresh activity") until the owner presses `n` or types.
- **Smallest correction:**
  - In `actionAbsentAtReadyPrompt`, treat a UUID that appears only above the
    latest `COORD-IDLE` line as scrollback:
    `!includes(actionId) || idleSentinelAfterAction(text, actionId)`. This
    reuses `src/tmux.ts:226`.
  - Add one `runLoop.test.ts` case in which the UUID above the sentinel lets
    recovery retry. Its control case puts the UUID below the sentinel, which
    must still block.

### 2. claude: the owner reminder path throws while paused, so `n` fails during the overnight hold [blocking]

- **Plan claim:** `sendOwnerReminder` "requires coordinator authority, through
  the existing `this.authority(cursors)` callback". `runTick` calls it "before
  any pause, completion or abandoned early return". Test 1 expects a send under
  a manual pause plus a `nudge-loop` hold.
- **Rule:** an owner reminder must reach the pane while the issue is paused or
  held. Automatic effects must keep the strict authority check.
- **Failure if followed:**
  - `authority()` (`src/runLoop.ts:1085`) throws `StateConflictError` whenever
    `current.paused` is true. Any hold, including `nudge-loop`, sets `paused`.
  - The plan removes the id from the queue before sending, so the reminder is
    dropped.
  - `run()` catches `StateConflictError` and simply re-reads state, so the drop
    is silent.
  - This is the overnight scenario (hold `01edf7dd`, seq 2999 to 3003), and it
    stays unfixed. Test 1 fails as written.
- **Smallest correction:**
  - Give the owner path its own narrow check: issue not abandoned or completed,
    and the run loop still running. For example, an `allowPaused` option used
    only by `sendOwnerReminder`.
  - Leave every automatic `authority()` call unchanged.

### 3. cursor: `deliver(..., "owner")` during a hold has the same paused-authority failure [blocking]

- **Plan claim:** "On a hold-only pause, `runTick` delivers queued owner
  reminders before the existing pause return", through `deliver(..., "owner")`.
  A new test expects that "with a `nudge-loop` hold already pausing the issue,
  `request()` does not throw, the next tick sends once".
- **Rule:** the owner path must be able to type while `paused` is true.
- **Failure if followed:**
  - `deliver()` passes an authority callback into `tmux.nudge`, which calls it
    before the gate. Its `reserve()` and post-send code also call
    `this.authority(cursors)`.
  - Each of those throws while `paused` (`src/runLoop.ts:1085`).
  - The reminder during hold `01edf7dd` is therefore lost, the overnight case
    is unfixed, and the plan's own hold test fails.
  - The plan's remaining owner charges make it worse. An existing `reserved`
    send still converts `n` into a `delivery-uncertain` hold.
- **Smallest correction:** use a paused-tolerant owner check, as in Finding 2,
  for the owner branch only.

### 4. cursor: keeps owner constraints the issue says to remove

- **Plan claim:** the Operator `n` contract keeps these restrictions:
  - `request()` rejects `manualPaused`;
  - dropped agents stay off the menu;
  - the owner send still refuses on `owner-typing`, `input-off`,
    `foreground-mismatch`, `missing-capture`, `trust-dialog`,
    `claude-usage-wait`, `antigravity-verify-overlay` and
    `codex-composer-not-ready`;
  - owner sends still charge `sends` and `lastSendAt`.
- **Rule:** issue 195 says "allow the operator to nudge any time. Remove checks
  and constraints for readiness, spacing, etc." Issue 187 says "any agent, not
  just a list by algorithm".
- **Failure if followed:**
  - The owner has just scrolled the Cursor pane to inspect it, so tmux is in
    copy mode. Pressing `n` is refused with `owner-typing`, and they must leave
    copy mode and retry.
  - Under a manual pause, `n` throws.
  - A dropped agent cannot be selected.
  - Each owner send moves the automatic budget toward `nudge-loop`. After three
    owner reminders, one automatic retry creates a fresh whole-issue hold.
  - Some of these vetoes are defensible, such as not submitting an owner's
    unsent Codex draft. But the plan presents them as the fix rather than as
    deviations for the owner to approve.
- **Smallest correction:**
  - For copy mode, send `send-keys -X cancel` before typing.
  - Do not charge `actionSafety` for owner sends.
  - List every configured agent.
  - Name any veto that is kept as an explicit, owner-visible deviation.

### 5. codex: adds message kinds and test surface the issue does not need

- **Plan claim:** Implementation behavior §3 and §6, plus Tests, add:
  - three message kinds, including "submission is awaiting coordinator
    validation" when a completion exists and a neutral "no current executable
    assignment" text;
  - a FIFO with per-request journal identity;
  - an incident table in `docs/readiness-policy.md`;
  - new cases across `runLoop.test.ts`, `tmux.test.ts` and
    `interactive.test.ts`. These cover about ten lifecycle states and six
    assignment states, plus dispatch-race cases.
- **Rule:** make the smallest change that fully solves the issue, with the
  fewest focused tests. Justify every new behavior.
- **Failure if followed:**
  - The "awaiting validation" text is wrong in the incident's own sequence. At
    seq 3145, `ff2e6ee7`'s completion existed but was invalid (missing
    response). An `n` in that window would tell Cursor its submission merely
    awaits validation, so it would stay idle instead of writing the missing
    response.
  - The extra message kinds and race tests multiply wording and fixtures that
    nobody requested, with no corresponding defect.
- **Smallest correction:**
  - Send the existing `renderNudgeText` for the current action file, or its
    generic form when there is none.
  - Drop the validation-pending variant.
  - Limit the tests to "sends regardless of gates", "lists every agent" and
    "reports a missing pane".

### 6. codex: says the owner's `n` refusal cause is unrecoverable, but the evidence settles it

- **Plan claim:** "the exact cause of the quoted owner's `n` refusal cannot be
  recovered from these artifacts; do not assert that spacing, readiness, or a
  hold was its particular cause."
- **Rule:** the issue explicitly asks "What is 'send spacing'?" and asks for the
  root cause. Where the journal permits elimination, the plan should state the
  cause.
- **Failure if followed:** the owner's question goes unanswered. The causes can
  be eliminated one by one:
  - The hold had just been released with a reset at `16:12:03.734`, and no
    `hold-created` event follows before `16:13:28`.
  - No owner `nudged` or `nudge-deferred` scrape event was journaled.
  - Lifecycle was idle with no pending input or background work, so the silent
    `deliver()` returns for queued, pending input and background did not apply.
  - The only remaining silent return is
    `NUDGE_REPEAT_DELAYS_MS[0]` = 60 s after the automatic send at `16:12:06`
    (seq 3006).
  - The cursor plan reaches the same conclusion.
- **Smallest correction:** state spacing as the cause, citing the elimination.

### Scope and reuse

- All three plans stay within issues 195 and 187 and create no new product
  files.
- All three reuse `renderNudgeText`, `resolveNudgeKeys`, `markActionInjected`
  and `safetyFixture`.
- All three correctly keep the automatic budget and spacing. Removing them
  would bring back the endless retry loop that hold `01edf7dd` stopped.
- The claude plan is the only one that fixes the automatic stall (Finding 1).
  It needs Finding 2's authority correction before its owner path works under a
  hold.

## Conclusion

No plan is acceptable unchanged.

- **claude** has the complete root-cause analysis. It covers all three stalls
  and is the only plan that fixes the automatic lost-delivery stall. Its fix is
  minimal: the sentinel-ordered UUID check, an owner path with no gates, and
  every configured agent listed. It needs one correction, Finding 2: a
  paused-tolerant owner authority check.
- **codex** and **cursor** leave coord stuck indefinitely in the reported 16:20
  state (Finding 1).
- **cursor**'s owner path also fails under the overnight hold (Finding 3), and
  it keeps owner vetoes the issue asks to remove (Finding 4).
- **codex** adds unrequested message kinds and test breadth (Finding 5), and
  leaves the spacing cause unstated (Finding 6).

Recommendation: select the claude plan with Finding 2 applied.
