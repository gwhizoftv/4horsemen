# Issue 195 plan review

Reviewed the coordinator-exported plans at these exact pins:

- Codex: `95c3ea1c4f48148ff730cffa2a54039f3ecc7735`.
- Claude: `04aeec5a2504ce5998bd3da0f752e408692314c7`.
- Cursor: `550a927a18c330a7a46d43468464e4f6e9712740`.

All three exported files match their bound manifest SHA-256 values. The findings below concern the plans as written, not completed implementations.

## Findings

### 1. [P1] The proposed held-state send still calls authority that rejects every hold

**Plan claim/section:** Claude's file map says `sendOwnerReminder` runs before the pause return but “requires coordinator authority, through the existing `this.authority(cursors)` callback.” Cursor's operator contract similarly promises delivery during a hold-only pause while reusing `deliver` and its existing authority checks, without specifying an owner authority exception.

**Rule:** An explicit owner request must be deliverable while the issue is held, without releasing the hold or granting automatic workflow effects permission to run.

**Concrete failure:** `src/state.ts:1451` derives `paused` from the presence of a hold. `CoordinatorRunLoop.authority` at `src/runLoop.ts:1080` throws whenever `current.paused` is true, independently of where in `runTick` the caller runs. Therefore selecting `n` while hold `01edf7dd` or an equivalent nudge-loop hold is present still fails before delivery: moving the request before the early return does not change this predicate. The advertised held-state recovery and each plan's new hold test cannot work with the specified existing authority callback. Cursor's reused `deliver` also calls authority while reserving and sending.

Provide a narrowly scoped owner authority path that permits the requested send while preserving issue/target identity checks and the existing prohibition on automatic effects during the hold. The regression should request a reminder with `paused: true`, `manualPaused: false`, and a live hold, then assert a real transport attempt and an unchanged hold.

### 2. [P1] Cursor deliberately retains the operator restrictions the issue removes

**Plan claim/section:** Cursor's “Operator `n` contract” rejects manual pause, restricts delivery to nudge/`both`, logs without sending when there is no action file, excludes dropped agents, retains `reserved` as a delivery veto, and keeps `injectionGate`, dialog, capture, and Codex composer refusals. Its Tests section explicitly expects `pause`, `foreground`, `typing`, and `missing-capture` not to send.

**Rule:** Issue 195 requires the operator to nudge any time and removes readiness and spacing constraints; issue 187 requires selection of any agent rather than the algorithm's eligible subset. Clearer refusal text does not satisfy a request to remove the refusal.

**Concrete failure:** An owner who selects an otherwise running Codex pane with a draft, a live agent during manual pause, or an agent with `reserved: true` is still prevented from nudging. A configured agent without a task file can appear in the menu but cannot receive even a neutral owner reminder, and a pull-configured agent is still rejected before transport. These are retained policy gates, not failures to locate or write to a terminal. The proposed tests would lock in those violations of the requested control behavior.

Make explicit owner delivery independent of these automatic eligibility checks and define an appropriate neutral message for agents without an executable current assignment. Keep automatic delivery policy separate and preserve actual transport-error reporting.

### 3. [P1] Claude's historical-sentinel predicate can authorize automatic typing into an unfinished draft

**Plan claim/section:** Claude's `src/tmux.ts` change replaces UUID absence with `harnessPromptReady(...) && (!stdout.includes(actionId) || idleSentinelAfterAction(stdout, actionId))`. Its Risks section says the sentinel must be an exact full line and that this can only delay recovery, never duplicate a composer draft.

**Rule:** Automatic lost-delivery recovery must require current positive evidence that the outstanding send is absent. Historical or quoted instructions must not become permission for an unsolicited resend. The owner's explicit override does not authorize weakening this rule for automatic sends.

**Concrete failure:** `idleSentinelAfterAction` at `src/tmux.ts:226` checks substring positions; it does not require a full-line sentinel, a current sentinel at the terminal tail, or an empty composer. Cursor's `harnessPromptReady` returns true without those conditions when no blocking turn chrome is present. A capture containing the action UUID, then `The template says "COORD-IDLE: waiting for the next coordinator action file"`, then `> Please inspect my unfinished draft` makes the proposed expression true. So does a historical full sentinel followed by that draft. With an injected/unacknowledged action, no hook-reported queue/background activity, and the existing elapsed delay/budget conditions satisfied, this changes a refused automatic retry into a send that appends action text to the draft. None of the retained lifecycle conditions observes the unsent composer text.

A focused Node probe using the inspected existing `dist/tmux.js` exports reproduced both cases: the current UUID-absence expression returned `false`, while the plan's expression returned `true` with readiness `vendor-prompt`. The plan's proposed UUID-after-sentinel control does not cover a draft without the UUID or a quoted sentinel. Either retain the existing automatic predicate while adding the owner override, or specify and test a genuinely current, composer-aware proof before broadening automatic recovery.

### 4. [P2] The peer diagnoses state unrecorded terminal and owner-request details as established facts

**Plan claim/section:** Claude's Root Cause sections 1–2 state that the old UUID remained visible throughout the later stall, pane inspection was succeeding, and the owner's `n` was definitely inside the first 60-second window. Its Conclusion names these as the proven causes. Cursor's analysis initially describes the spacing scenario conditionally, but its Conclusion also says the actual owner request was refused by that spacing return.

**Rule:** The requested root-cause analysis must distinguish observations in the logs from hypotheses inferred from code. An absence of an event is not proof of the specific unrecorded condition, especially where diagnostics are deduplicated or omitted.

**Concrete failure:** Issue 177's journal records the automatic sends at sequences 3006 and 3009 and the later idle deferral at 3181. It records neither the owner's `n` timestamp nor the pane contents at the lost-delivery checks. The old owner path has several unjournalled early returns, and `journalDeferral` emits each code only once per action. Thus no new scrape-deferral row cannot eliminate a repeated scrape refusal; no lost-delivery event cannot establish that a visible old UUID was the veto rather than another failed proof condition. Publishing these conclusions as proven would claim an exact incident cause the supplied evidence does not establish, and Claude's automatic-policy change is justified using that unsupported certainty.

Retain the proven overnight hold, send/Stop/validation timeline, and the demonstrated shared owner gates. Label spacing and stale-UUID visibility as candidate explanations unless a time-stamped request record or historical capture establishes them. Record precise owner outcomes in the new implementation so future incidents can be attributed directly.

### Scope, reuse, and test assessment

All plans use existing run-loop, tmux, and test support and propose no new product dependency or file. Claude's shared typing extraction has a concrete duplication-avoidance purpose. Its extra automatic-recovery change needs the correction in finding 3 and stronger targeted negative coverage; simply deleting the old owner tests does not establish the replacement authority behavior. Cursor's compact file map is appropriate in size, but its retained-veto tests contradict the issue as described in finding 2.

Codex's plan covers nine existing files, reuses the established fixtures and message/key helpers, explicitly separates owner authority from automatic authority, and includes focused tests for the changed behavior. Its larger file map includes the existing help/documentation and transport/menu tests that the change affects. Its diagnosis preserves the limits of the historical evidence. I found no blocking plan defect in that bound plan. This assessment does not establish implementation correctness or product-test results.

## Conclusion

Revise Claude's plan to fix held-state authority, avoid unsafe historical-sentinel recovery, and qualify the unproven incident details. Revise Cursor's plan to remove the remaining operator eligibility vetoes, address paused authority, and qualify the exact-spacing diagnosis. The Codex plan is suitable to proceed to implementation.

Validation performed for this review: checked the action ID/digest; verified all three bound files against the manifest; inspected the existing authority, pause, readiness, and delivery paths; checked the cited issue-177 journal sequences; and ran the two-case predicate probe described in finding 3. No product suite was run for this evidence-only review.
