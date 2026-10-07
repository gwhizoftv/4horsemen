# Issue 169 — implementation comparison (claude)

## Comparison

Bound implementation pins compared, each read from its exported worktree and
diffed file by file against the frozen baseline
`cd2798983651198c865cd37c494e8ac38062c109`:

- codex `d6fd390286105a45df6420b062b7b9e817302c5a`
- cursor `86b34cf1f4c5f9fbe318dc4aaed349b6dac601f5`
- claude `a92952226156e51a12144a8425c10d5be4b136fd`

All three pins change exactly the 15 approved product paths, and none adds a
product file. All three implement the selected plan's design:

- the agent writes a `ready <actionId>` file beside `complete` (including when
  `action.md` is already gone after acceptance);
- the coordinator records the agent's last accepted action on Git or response
  acceptance and on an accepted amendment request;
- a hook-receipt clock also counts hook events that lifecycle deduplicates;
- a receipt newer than every hook overrides a stale `working` or uncorrelated
  `unknown` lifecycle for the first send of a never-sent action;
- a ready-file proof variant is threaded through `TmuxController.nudge`.

They differ in where the hook-receipt clock lives, which observations advance
it, and how completely the Codex composer checks were adapted to work without
a sentinel.

| | codex | cursor | claude |
| --- | --- | --- | --- |
| Hook-receipt clock | lifecycle entry; advances on everything except telemetry (status renders count) | **`cursors.json`, written by the hook process** | lifecycle entry; status renders and telemetry excluded |
| Codex composer, no sentinel | empty before typing, exact before submit, vim mode, submission detection, capture failure | readiness only; draft, vim mode and submission detection still sentinel-bound | empty before typing, exact before submit, vim mode, submission detection |
| Receipt consumed | only when it was the proof | any send, matched by id | any send, matched by id **and** file identity |
| Requester's receipt on amendment | kept | **deleted by retirement** | kept |
| Tests | most thorough: real acceptance, restart, 14-case eligibility table, amendment, capture failure, per-key races | thinnest; no ordering or amendment case | real response acceptance with receipt written before it, staleness, single use, amendment binding, per-key Codex cases |

### Finding 1 — cursor: hooks now write coordinator authority state, so concurrent hooks break coordinator effects (blocking)

`src/agentLifecycle.ts:688` (cursor pin) calls `advanceHookReceipt`
(`src/state.ts:1431`) on every non-telemetry hook. That function runs
`mutateCursorsState`, which increments `cursors.json`'s `stateRevision`.

- **Rule.** Hook traffic must not change workflow authority. Every coordinator
  effect is a compare-and-swap on `stateRevision` (`requireStateMutation`,
  `authority()`), and the baseline keeps hooks in a separate file
  (`agent-lifecycle.json`, "hook traffic is not workflow authority") for
  exactly that reason.
- **Failure.**
  1. In `deliver()`, `reserve()` charges the send. The submit key makes the
     harness fire `UserPromptSubmit`, and its hook process now increments
     `stateRevision`.
  2. The post-send `this.authority(cursors)`, or the `this.mutate` that clears
     `reserved` (`src/runLoop.ts`, after the call at line 1182), throws
     `StateConflictError`. The tick ends with `reserved: true`.
  3. The next tick sees a reserved send and places a `delivery-uncertain`
     hold, pausing the issue after a send that actually succeeded.

  The same race aborts any long effect in progress whenever any agent's hook
  lands: Git verification before acceptance, action preparation, evidence
  publication. Antigravity's continuously emitted `status` observations are
  not excluded, so with Antigravity on the roster the coordinator can livelock
  on conflicts.
- **Test.** In the run-loop fake tmux runner, call `observeAgentLifecycle`
  with a `prompt-submitted` observation when the final submit key arrives.
  Assert that the action reaches `delivery: "injected"` and that no
  `delivery-uncertain` hold exists.

### Finding 2 — cursor: a Codex ready-file send types into an owner's draft and cannot recognise its own submission (blocking)

`src/tmux.ts:336` (cursor pin) returns ready for a ready-file proof only when
the composer is empty, but otherwise falls through to the unconditional
`ready()`. The pre-typing check at line 1112 is `null` for `ready-file`. The
prelude at line 1074 and submission detection at line 1098 still call the
sentinel-anchored `codexVimNormal` and `codexNudgeSubmitted`.

- **Rule.** A proof that removes the sentinel requirement must keep every
  composer protection: empty before the first key, exact before each submit,
  vim mode honoured, and a confirmed submission ending the send.
- **Failures.**
  - **Owner draft.** With a draft in the Codex composer, the nudge is typed
    onto it. The pre-submit `composerMismatch` check then refuses
    `mid-send`, which leaves a `delivery-uncertain` hold and a corrupted
    draft.
  - **Vim NORMAL.** No `i` is sent, so the nudge text runs as vim commands.
  - **Successful submit.** When `C-j` submits and Codex's hooks are
    uncorrelated (issue 176), `codexNudgeSubmitted` cannot see it. The
    pre-`C-m` check finds an empty composer and refuses `mid-send`: another
    hold after a successful delivery.
- **Test.** Run the existing per-key Codex fixture with `ready-file` proof and
  no sentinel. With a pre-existing draft, expect `keys: []`. With vim NORMAL,
  expect `["i", "-l", …]`. With submit-on-`C-j`, expect `["-l", "C-j"]` and
  `status: "sent"`.

### Finding 3 — cursor: beginning an amendment deletes the requester's ready receipt

`src/runLoop.ts:2002` (cursor pin). `retireAmendmentActions` now unlinks
`runtime.ready` for every retired agent. `beginAmendment` retires the
requester's own action and immediately calls `retireAmendmentActions`.

- **Rule.** A receipt naming the accepted request must survive until the next
  action's first send. The plan binds amendment requests for exactly this.
- **Failure.** The requester writes `ready <requestActionId>` (its re-read
  of `action.md` is unchanged). The coordinator opens the amendment, records
  `lastAcceptedActionId`, then deletes that receipt in the same call. If the
  requester's Stop is lost, its amendment ballot stays blocked on stale
  `working`, the failure the issue exists to fix.
- **Test.** After `beginAmendment`, expect the requester's ready file to
  exist and its `lastAcceptedActionId` to equal the request's action.

### Finding 4 — codex: counting `status` renders as hook arrivals churns state and spoils Antigravity receipts

`src/agentLifecycle.ts:704` (codex pin) advances `hookReceipt` for every kind
except `telemetry`, including Antigravity's `status` renders. The pin rewrote
the baseline test "does not rewrite lifecycle state for duplicate status-line
renders" to expect the rewrite.

- **Rule.** Freshness may be revoked only by evidence of activity. Render
  feeds are emitted continuously while idle (see the baseline comment on
  Antigravity's "continuously emitted status payload").
- **Failures.**
  - Every Antigravity render now rewrites `agent-lifecycle.json`, where the
    baseline deliberately deduplicated those writes.
  - Each render moves `hookReceipt.at` past the receipt's mtime, so an
    Antigravity receipt is almost never proof.
  - When one is, any render during the send changes `hookReceipt.sequence`.
    The per-key check at `src/runLoop.ts:1134` returns `changed`, and after a
    key that becomes a `mid-send` refusal and a `delivery-uncertain` hold.
- **Test.** Keep the baseline assertion: two identical `status` observations
  leave `stateRevision` unchanged. Add a case where a `status` render
  arriving after the receipt does not invalidate it.

### Finding 5 — claude (self-review): a failed pane capture no longer blocks a ready-file override for Cursor-type agents

`src/tmux.ts:1034` (claude pin). `capturePane` returns `""` when
`capture-pane` fails (line 988). For `cursor` (and the default branch),
`harnessPromptReadiness("")` is `ready()`. In the baseline the override still
required a sentinel, which an empty capture can never show. With
`ready-file` proof, the claude pin skips that check (line 1042 guards only
Codex).

- **Rule.** A proof that replaces the sentinel must still have pane evidence
  that the turn chrome veto ran.
- **Failure.** A transient capture failure on a Cursor pane, with a stale
  `working` lifecycle and a fresh receipt, sends keys with no chrome check at
  all. The codex pin refuses this as `pane-capture-unavailable`.
- **Test.** Codex's `it.each([1, 2, 3])("refuses file-backed delivery when
  capture %s is unavailable")`, applied to the claude pin.

Lesser claude-pin note: excluding `status` from the hook-receipt clock (line
732) means a duplicate Antigravity `status: working` after the receipt does not
revoke it. Antigravity's turn-chrome veto is then the only guard. That is the
deliberate trade against Finding 4.

### Scope, reuse and tests

- **codex** reuses the existing override path, mailbox, completion-style
  parsing and fixtures. Its O_NOFOLLOW reader and identity-checked cleanup are
  justified hardening. Its test additions are the largest (+153 run-loop lines,
  table-driven), but each case maps to a plan rule. Apart from Finding 4, it is
  the most complete and best-verified pin.
- **cursor** adds three cursor-schema fields and a parse-result union. It
  duplicates the git and response footers verbatim, and imports
  `COORD_IDLE_SENTINEL` from `tmux.ts` into `action.ts`. Its tests do not
  exercise ordering (receipt written before acceptance), amendments, or
  concurrent hooks, which is why Findings 1–3 pass its suite.
- **claude** is the smallest change that covers the same contract. It reuses
  the existing owners, adds focused cases to existing files, and drives a real
  response acceptance with the receipt written before it. Finding 5 is its
  gap.

**Ranking:** codex, then claude, then cursor. Codex's pin can be accepted
once Finding 4 is fixed; its own capture-failure test already covers the gap
in Finding 5. Cursor's pin should not be selected because of Findings 1 and 2.

Checks I ran for this comparison: baseline export with `git archive` and
per-file `diff -u` of each worktree against it, plus source inspection. I ran
no product tests against the peer pins. Pin verification and final checks are
coordinator-owned.
