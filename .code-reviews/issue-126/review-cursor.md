# Code review: PR #141 (issue 126)

- Reviewed PR: https://github.com/gwhizoftv/coordination/pull/141
- Reviewed head: `origin/issue-126/codex` @ `17ffddc24723cb1fb39bb5ef633fa3d2c8afcfac`
- Baseline: `origin/main` @ `ae991b81ba3508b3ef233d2392b88e9eb0569ad1`
- Scope: bounded delivery budget, durable unknown-cause holds, Claude wait veto,
  local observation — vendor quota classification deferred to #140
- Reviewer: Cursor (manual scratch review for refeedback)

## Findings

### [P1] Released evidence must not permanently immunize an ongoing failure

`src/runLoop.ts:874-879` (`hold`) refuses to reinstall when
`safety.releasedEvidence` already contains the evidence id.
`src/state.ts:1121-1137` (`releaseHold`) always appends that id on owner
release. `observationEvidence` is keyed by `actionId` / `sessionId` /
`lastEventAt`, which often does not change while a pane stays dead or a Claude
wait banner remains.

**Rule:** Owner release acknowledges one latch; it must not grant lasting
immunity to the same still-true local condition. Immediate same-tick
deduplication is fine; a later observation of the same live failure must be
allowed to hold again (or must keep the issue held another way).

**Failure:** Owner runs `coord resume --hold …` while the harness is still gone
or Claude is still waiting. The next `observeUnfinished` / busy
`claude-usage-wait` path calls `hold`, which no-ops. The issue is unpaused, the
roster looks healthy, and the run loop can spin delivery attempts every poll
without a hold, without a deferral journal, and without advancing — the
original unbounded-nudge symptom in a quieter form. The existing test only
covers a *new* session after release (`test/runLoop.test.ts` “suppresses
released old evidence but holds a new session failure”), not the same-evidence
still-broken case.

**Test:** Latch `harness-gone` (or `vendor-wait`), release the hold, keep the
same session / `lastEventAt` and the same dead pane (or wait banner), tick
again, and require a new hold (or an equivalent non-advancing durable block) —
not a silent no-op.

### [P1] Idle observation must not rewrite cursors when nothing changed

`src/runLoop.ts:967-1000` (`observeUnfinished`): after
`nextObservationAt` elapses, the method always `mutate`s
`observationChecks` / `nextObservationAt`, even when
`correlationMissing` and `stale` are both false and `checks` stays `0`.

**Rule:** A no-op observation must not bump `stateRevision` or rewrite
`cursors.json`. Persist only when checks, schedule, activity, or hold state
actually change.

**Failure:** Every unfinished agent rewrites authority once per minute for the
entire action lifetime. Concurrent owner `pause` / `resume --hold` / `drop`
collide more often (`StateConflictError`), and long quiet-but-healthy work
pays constant revision churn unrelated to delivery safety. The A/B/A stability
test does not advance the clock through healthy minute boundaries, so it does
not catch this.

**Test:** After initial delivery with fresh lifecycle activity, advance 60s
repeatedly for N minutes with no stale/correlation trigger; assert
`stateRevision` and `cursors.json` bytes are unchanged across those ticks.

### [P2] Mid-send Claude wait is collapsed to `delivery-uncertain`

`src/runLoop.ts:940-956`: any non-`sent` result with `stage === "mid-send"`
becomes `delivery-uncertain` before the `claude-usage-wait` → `vendor-wait`
branch runs. `src/tmux.ts:908-910` can return
`{ reason: "claude-usage-wait", stage: "mid-send" }` after a reservation (e.g.
prelude key already charged).

**Rule:** Budget charging for ambiguous keys may stay conservative, but the
hold reason and `retryOwner` should still reflect a known Claude usage wait
when that is the refusal reason — otherwise recovery instructions and reports
lie.

**Failure:** Operator sees `delivery-uncertain` / `retryOwner: owner` and
treats it as a partial keystroke failure, while Claude’s native waiter is the
actual blocker (`retryOwner` should remain `vendor`). Report text then pushes
the wrong recovery model.

**Test:** Drive the existing mid-send wait fixture (`test/tmux.test.ts`
recheck-before-keys) through `deliver` / a run-loop tick and require
`reason: "vendor-wait"` (budget may still be charged) rather than
`delivery-uncertain`.

## Verdict

**Changes required** before merge: fix permanent `releasedEvidence` suppression
for still-active failures, and stop no-op observation mutations. The mid-send
classification fix is smaller but should ship with them so hold reports stay
honest.

The narrowed #126 scope (unknown holds + nudge circuit breaker; quota adapters
in #140) is a practical split and matches the PR body. Do not treat merge as
“quota windows detected” — keep #140 as the follow-through for Codex/Claude/
Cursor evidence. Nudge budgeting, Claude wait veto (including last-moment
recheck), manual vs hold pause ownership, and the silent-Cursor observation
tests are the right core for this first ship once the P1s above are fixed.
