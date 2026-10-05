# Issue 154 implementation comparison

Bound implementation pins:

- claude `6940cdb27af69c2e2332f3d605f83625fd790634`
- cursor `181ea79ca43a7f799e9635dbc5435ea50eaddb2b`
- codex `6990dfbc8b26b78375dfc2e1b879b51c2f9d46e1`

All three pins change the same 14 product paths: three new files plus edits to
`src/{action,cli,runLoop,state,steps}.ts`, four existing test files,
`README.md` and `docs/coord-driver.md`. None of them touches
`src/issueReport.ts`, hooks or dependencies. All three:

- extract the owner mutations into `src/ownerControls.ts`;
- keep `CursorsState.ownerGuidance` optional, following the existing
  defaulted-key precedent;
- bind guidance at the first `prepare-action`;
- render `## Owner guidance` in both action modes;
- skip completion cleanup after a foreground stop.

Line numbers below refer to each pin's worktree.

## Comparison

### Scope, reuse and coverage

- **claude:** Moves the existing `invalidateUnpublishedBatches`,
  `clearAgentLocalWork` and `rederiveAfterDrop` verbatim, and keeps CLI
  messages and the journal semantics unchanged. It adds one cancellable
  `abortableSleep`. Owner retry/revise and whole-cohort `resetTo` start a new
  guidance batch. Tests are focused:
  - one state test and one action test;
  - two run-loop tests: cohort consistency across reissue and restart, and
    abort with timer release;
  - two CLI tests;
  - one terminal test file using injected streams.

  It does not cover guidance continuity across amendments (finding 6).
- **cursor:** Similar shape and file sizes. It extends existing tests, but its
  guidance and terminal tests do not exercise the failure modes in findings
  1–4.
- **codex:** The most complete boundary model:
  - a `generation` that changes on owner answers, whole-cohort resets and
    amendment transitions;
  - suspend/restore of the interrupted step's snapshot across an amendment
    ballot;
  - an upgrade guard against binding into an already in-flight step;
  - bracketed-paste handling;
  - conventional 130/143 exit codes.

  This is more code (`state.ts` +86 lines, `runLoop.ts` +59), but every
  addition answers a concrete review failure, and it extends existing tests
  rather than adding fixtures. One external-CLI journal behaviour changed
  (finding 7).

### Findings

1. **cursor `src/state.ts:1283`**
   - **Rule:** Guidance queued before a fresh, whole-cohort batch of agent
     turns must reach that batch, even when the step and round labels repeat.
   - **Failure:** `bindOwnerGuidance` is keyed only by `(stepId, round)`, and
     nothing changes the key on an owner retry. While a round-2 ballot
     escalation is pending, queue `/steer re-check X` and then answer `retry`.
     The retried `R6.ballot` round-2 actions match the old binding, so they
     re-render the stale snapshot. The new text stays pending until a later
     step.
   - **Test:** bind `R6.ballot`/2, enqueue, apply owner `retry`, prepare
     `R6.ballot`/2, and assert the new text is rendered.
   - **Fix sketch:** codex's `generation` or claude's `batch`.

2. **cursor `src/runLoop.ts:2940`**
   - **Rule:** A foreground stop must not leave the poll timer holding the
     process open, or accumulate abort listeners across polls.
   - **Failure:** `Promise.race` against the default `setTimeout` sleep
     resolves on abort but never clears the timer. After `q`, `runCli` returns
     but Node waits out the remaining `pollIntervalMs`. Separately, every poll
     that the sleep wins leaves another `{ once: true }` abort listener on the
     signal. A long run exceeds the EventTarget listener warning threshold and
     retains a closure per poll.
   - **Test:** under fake timers, `run(signal)` with the default sleep, then
     abort, then `vi.getTimerCount() === 0`. This is the claude and codex test.

3. **cursor `src/interactive.ts:265` with `:326`**
   - **Rule:** A pasted burst in quick-control mode must not chain destructive
     controls.
   - **Failure:** `emitKeypressEvents` emits one `keypress` per character, so
     `key.sequence.length > 1 && key.name === undefined` is never true for
     plain text. Pasting `d1` opens the drop menu and immediately drops the
     first agent.
   - **Test:** emit the data chunk `"d1"` and assert `dropAgent` was not called.

4. **cursor `src/interactive.ts:230`**
   - **Rule:** An irreversible roster change from a single keystroke needs
     explicit confirmation.
   - **Failure:** `d` followed by a digit calls `commands.dropAgent` with no
     `y/N` step. One mistyped digit rederives the workflow without the intended
     agent. The `abandon` owner answer is equally unconfirmed. claude and codex
     both require confirmation.

5. **cursor `src/interactive.ts:68` and `src/cli.ts:709`**
   - **Rule:**
     - The interactive prompt must stay off when output is not a terminal.
     - The pause toggle must read `manualPaused` under the cursor lock.
     - Control feedback must go through the log-safe writer.
   - **Failures:**
     - `coord run --issue 1 | tee run.log` with a TTY stdin still enables raw
       mode and writes prompt escape sequences into the log.
     - `togglePause` reads state, then calls `setManualPause` in a separate
       lock. A concurrent `coord pause` in between makes the toggle a no-op.
     - Its `io.stdout` message bypasses `session.print`, splitting a
       half-typed `/steer` line.

6. **claude `src/runLoop.ts:1844` and `src/state.ts:1304`**
   - **Rule:** Guidance bound to `R4.implement` or `R6.revise` should survive
     an amendment ballot that interrupts and then resumes that same work.
   - **Failure:**
     - Entering `R4.amend-ballot` binds the ballot batch, which expires the
       implementation snapshot.
     - When the workflow resumes `R4.implement`, the key differs again. The
       re-prepared implementation actions are rendered without the owner's
       earlier implementation guidance.
     - Separately, an issue upgraded mid-step with no `bound` record binds
       newly queued text into only the recipients prepared after the upgrade.

     codex handles both cases with `suspended` and its in-flight guard. claude
     documents one-step expiry, but the resumed step is the same work.
   - **Test:** bind `R4.implement`, begin and then resolve an amendment, and
     assert the resumed action still lists the entry.

7. **codex `src/ownerControls.ts:368`**
   - **Rule:** Extracting shared controls must not change the journal semantics
     of the existing `coord pause`/`resume` commands.
   - **Failure:** The baseline journaled `paused`/`resumed` only on
     effective-pause changes. codex journals on `manualPaused` changes instead.
     `coord resume` while a hold remains now records `resumed`, although the
     workflow stays paused. `derivePausedMs` (`src/analytics.ts:407`) then stops
     counting paused time at that event.
   - **Test:** with a hold active, run `pause` then `resume`, and assert the
     analytics paused duration covers the full hold.

8. **cursor `src/cli.ts:644` and codex `src/cli.ts:687`**
   - **Rule:** Tests must never touch the real terminal unless they inject one.
   - **Failure:** Both pins default the terminal to `process.stdin`/`stdout`
     even under Vitest. A developer running `pnpm test:fast` in an interactive
     shell makes every CLI `run` test without an injected terminal enter raw
     mode on that shell and install SIGINT/SIGTERM handlers. claude gates the
     default on `VITEST`, following the existing `sessionExists` precedent.

### Ranking

1. **codex** is the strongest. It handles cohort identity across retry, reset
   and amendment, plus upgrade, paste, signal and exit-code edge cases. Its
   remaining defects are the CLI journal-semantics change and the test-time
   default terminal (findings 7 and 8).
2. **claude** is a smaller, consistent implementation with every review fix
   applied and unchanged external CLI behaviour. It still lacks amendment
   continuity and the upgrade guard (finding 6).
3. **cursor** reproduces the stale-retry binding and has several real terminal
   defects: timer and listener leaks, a pasted drop, unconfirmed drops,
   ungated output, and a racy toggle (findings 1–5).
