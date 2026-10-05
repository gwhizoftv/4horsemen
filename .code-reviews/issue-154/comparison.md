# Issue 154 implementation comparison

Pins compared:

- claude `6940cdb27af69c2e2332f3d605f83625fd790634`
- cursor `181ea79ca43a7f799e9635dbc5435ea50eaddb2b`
- codex `6990dfbc8b26b78375dfc2e1b879b51c2f9d46e1`

## Comparison

All three implementations deliver TTY-gated interactive controls, shared `ownerControls` mutations without a second interactive `runTick`, advisory `## Owner guidance` on `InternalOrder`, and an `s` overlay that appends active step/roster without editing `issueReport.ts`. Claude is the only pin that jointly matches the selected plan’s bind-once-at-prepare contract **and** same-step cohort rebind after owner retry/drop reset, plus abortable poll sleep.

1. **cursor `181ea79c` — `src/runLoop.ts:870` and `:2940–2949`.** Default `sleep` is a plain `setTimeout`; `run()` races it against abort without clearing the timer. Rule: a foreground `q`/Ctrl-C must end the poll wait and release its timer so the process cannot stay alive for up to `pollIntervalMs`. Failure: abort resolves the race while the outstanding timeout still holds the event loop (or a never-resolving injected sleep never cancels). Prefer a test that aborts during a long real `setTimeout` and asserts the process/handle is gone; Claude’s `abortableSleep` at `src/runLoop.ts:192` is the fix shape.

2. **cursor `181ea79c` — `src/state.ts:1276–1285` with `src/ownerControls.ts` answer/drop reset paths.** `bindOwnerGuidance` is a no-op when `(stepId, round)` already matches, and neither `applyOwnerAnswer` retry/revise nor drop `resetTo` bumps a batch/generation. Rule: guidance queued after an owner whole-cohort reset that repeats the same step/round (ballot retry) must bind once for that new cohort. Failure: owner `/steer`s then answers `retry` on `R6.ballot` round *N*; re-prepared agents keep the old bound snapshot and the new pending text never appears until a different step binds. Smallest test: queue after answer retry, prepare the same step/round, assert the new text is in every agent’s `action.md`. Claude’s `startOwnerGuidanceBatch` (`src/state.ts:1319`, used from `ownerControls.ts:149` / `:316`) is the missing piece.

3. **cursor `181ea79c` — `src/cli.ts:707–730`.** `togglePause` and `attach` write through `io.stdout` / raw attach reporting while the interactive session owns the TTY; only `status` uses `logSink`/`session.print`. Rule: while raw mode is active, owner-facing lines must clear the prompt, write, and redraw. Failure: `p` or `a` corrupts a half-typed `/steer` line or leaves the prompt desynced. Fix sketch: return strings from those commands and print via the session (Claude/Codex pattern).

4. **codex `6990dfbc` — `src/action.ts:58–61`.** `ownerGuidanceSection` renders `- ${JSON.stringify(entry)}`. Rule: each bound entry is one plain `- ` bullet of the owner’s text. Failure: agents see quoted/escaped bullets (`- "keep Go 1.22 compatibility"`) unlike claude/cursor. Test: render an order with guidance containing spaces and assert the bullet is unquoted.

5. **codex `6990dfbc` — `src/runLoop.ts:2615–2625`.** Bind is computed outside `mutate`, then the mutate callback returns that precomputed `bound` object. Rule: persist bind by rebasing on the locked current state inside the mutation (claude/cursor re-call `bindOwnerGuidance(current, …)` under the lock). Failure: a concurrent `mutateCursorsState` (external pause/steer) between the outer bind and `this.mutate` can be overwritten by the stale snapshot. Fix sketch: bind inside the mutate callback from `current`.

6. **codex `6990dfbc` — guidance lifetime (`src/state.ts` generation/suspend; `src/runLoop.ts` advance reset; `src/ownerControls.ts` answer/drop resets).** Rule: the selected plan binds lazily at first prepare-action for a new key and rejects scattering promotion across advance/answer/amendment sites. Failure: multi-site generation bumps and amendment suspend/restore can re-inject or expire guidance in ways the selected “expire when a different step binds; re-enter to persist” model does not specify, and the extra surface is harder to audit. Prefer claude’s pending/bound(+batch) and single prepare-action bind site.

7. **codex `6990dfbc` — `src/ownerControls.ts:364–369`.** Hold-release journals pause/resume only when `manualPaused` changes. Rule: releasing the last hold that kept `paused` true must journal `resumed` the same way as other owner pause paths. Failure: interactive `r` clears the only hold, `paused` flips false, but no `resumed` journal is written. Test: release last hold with `manualPaused` false and assert a `resumed` journal event (claude/cursor journal on `paused` change).

**Scope / reuse:** All three stay on the issue’s three features, reuse `mutateCursorsState` / journal / existing pause-drop-answer paths, and add focused interactive/state/runLoop/action/cli tests without new dependencies. Claude adds the batch counter needed for same-step cohort resets without expanding into Codex’s multi-site promotion model. Cursor is structurally close but fails quit timer cleanup and same-step rebind. Codex has solid terminal teardown and abort sleep but drifts from the selected guidance model and carries the lock/TOCTOU and JSON-bullet defects above.

**Verdict:** Prefer claude `6940cdb27af69c2e2332f3d605f83625fd790634` as the implementation to accept. Do not accept cursor `181ea79c` or codex `6990dfbc` as written without correcting the cited failures.
