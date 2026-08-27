# Issue 118 implementation plan

The implementation will extend the existing journal/transcript aggregation path rather than add another analytics store. Current Cursor hook installation and normalization already capture supplied token fields, and the current token-total gate already requires complete per-agent coverage; those paths will be retained and tightened with focused missing-data and mixed-roster tests. The remaining work stays in the existing state, CLI, transcript, run-loop, analytics, documentation, and test modules.

## Exact File List to be changed or deleted

- `src/analytics.ts`
  - Keep `run.durationMs` as the elapsed-wall-time value for compatibility, and add nullable `pausedMs` and `unpausedMs` projections. Derive pause time in one journal pass by opening an interval at the first effective `paused`, closing it at the first effective `resumed`, ignoring duplicate state transitions, and closing an outstanding pause at the run endpoint. Invalid or non-monotonic boundaries produce `null`, never a negative duration; a valid run with no pause has a measured paused duration of zero.
  - Change nudge pairing so the first outstanding nudge for an `(agent, actionId)` is retained until `intent-seen` (and likewise until `response-accepted` for ballot latency); a retry cannot overwrite the start of an unresolved wait. Once an endpoint is observed, clear the key so a later genuine attempt can form a new interval.
  - Project each `final-check` row as a check name/result with `durationMs: number | null`, and render measured durations in the time output. Historical rows without the field render `unavailable`, not zero.
  - Preserve explicit `unassigned` token buckets and improve the coverage reason to say that a measured record could not be joined by turn identity or one unique complete action window. Preserve the cross-roster total gate: every member of the supplied active roster must have `complete` token coverage and zero unassigned token records. Update the unavailable-total text to name both conditions.
  - Render the headline elapsed/paused/unpaused split without renaming or removing the existing report sections.
- `src/cursorHookUsage.ts`
  - Continue aggregating journaled Cursor usage by `(conversation/session id, generation/turn id)`, but classify a session with no supplied token fields as token coverage `unavailable` rather than `unsupported`. Do not synthesize zero token records; independent tool coverage remains reportable.
- `src/transcriptRead.ts`
  - While scanning a Codex transcript, use existing `task_started.turn_id` / `task_complete.turn_id` boundaries as the enclosing turn identity for `token_count` rows that omit `turn_id`. Prefer an explicit row turn id, use an unambiguous enclosing task turn next, and otherwise leave the row unattributed for the existing timestamp-window join. Do not infer across mismatched/nested task boundaries and do not sum cumulative `total_token_usage`.
- `src/state.ts`
  - Add a read-only analytics input reader for current state and completed format-2 state. For format 2, parse only the start fields analytics consumes, the active roster plus `completed` flag from cursors, and the common journal event projection; normalize those values in memory only. Require `completed: true`, reject mixed/invalid formats, and never rewrite state.
  - Leave `readStartState`, `readCursorsState`, `readJournal`, mutation helpers, and append paths on the current-format schemas so start/resume/control-plane operations continue to fail closed for legacy state.
- `src/cli.ts`
  - Route only `coord analytics` through the read-only analytics reader and an analytics-specific runtime lookup that can inspect legacy start identity without invoking operational parsers. All other commands continue through the existing strict context and state readers.
  - Pass the normalized start projection, completed run's recorded active roster, and read-only journal to `buildAnalytics`; do not migrate files or make legacy state resumable.
- `src/runLoop.ts`
  - Capture the timestamp immediately before and after each awaited hermetic final-check process. Journal the completed check at the end timestamp with a validated nonnegative `durationMs` when both boundaries are valid, otherwise `null`. Scope the measurement to the check command itself, not worktree setup/cleanup, and keep failure behavior unchanged.
- `docs/analytics.md`
  - Document Cursor's supplied-versus-unavailable token behavior, exact Codex task-turn attribution and fallback, the complete-roster/zero-unassigned total policy, read-only completed format-2 support, elapsed/paused/unpaused semantics, first-outstanding-nudge waits, and final-check durations. State explicitly that legacy control-plane reads remain rejected and that no legacy bytes are migrated.
- `test/analytics.test.ts`
  - Add focused cases for pause/resume subtraction (including duplicate events and an open pause), first-nudge retry timing, nullable legacy final-check durations plus measured durations, exact Codex turn attribution reducing unassigned usage, and a Cursor/Codex active roster whose total appears only when both agents are complete with no unassigned token rows.
- `test/cursorHookUsage.test.ts`
  - Add a tools-only/session-identity fixture proving absent Cursor token fields return `unavailable` and never a synthetic zero token sample.
- `test/agentEvent.test.ts`
  - Extend the Cursor hook normalization coverage to prove token-bearing payloads are journaled while `afterAgentResponse` payloads without token fields do not fabricate a usage record.
- `test/transcriptRead.test.ts`
  - Add Codex fixtures with `task_started`, token rows lacking their own turn id, and matching `task_complete`; assert exact per-turn aggregation. Add missing or mismatched boundary cases that remain unattributed rather than being guessed.
- `test/state.test.ts`
  - Exercise the completed format-2 analytics reader and prove the operational readers still reject the same files. Assert incomplete legacy state and mixed-format journal lines are rejected and that analytics reads do not modify any file bytes.
- `test/cli.test.ts`
  - Build a completed format-2 runtime fixture and verify `coord analytics` renders it while normal run/resume entry points remain fail-closed. Verify modern CLI output includes the elapsed/paused/unpaused split and final-check duration/unavailability.
- `test/runLoop.test.ts`
  - Inject advancing timestamps around successful and failed check runners and assert each `final-check` journal row records the measured duration while preserving exit handling and publication blocking.

No tracked file will be deleted.

## Exact file list to be created

None. Format-2 runtime and transcript cases will be built inside the existing tests' temporary directories, avoiding a new fixture or analytics subsystem.

## Tests

The focused tests will establish one direct regression for each requested gap:

1. Cursor hook fields produce persisted token usage; absent fields produce `unavailable` and no fake zero.
2. Codex `token_count` records inherit a matching transcript task turn and therefore join to the action phase even when a lifecycle stop/window is unavailable; records without reliable identity stay explicitly unassigned.
3. A complete Cursor/Codex roster emits the summed token total, while one unavailable/partial agent or one unassigned measured token record makes the total `null`.
4. A completed format-2 runtime is readable only by analytics, remains byte-for-byte unchanged, and is still rejected by operational state/run paths.
5. Elapsed time equals paused plus unpaused time for valid runs, including repeated pause commands and a pause still open at the report endpoint.
6. Multiple nudges before one intent/response measure from the first outstanding nudge; a post-completion attempt starts a separate interval.
7. Successful and failed final checks journal and report measured durations, while historical missing durations remain `null`/`unavailable`.

Run the focused suite first:

```bash
pnpm exec vitest run --config vitest.config.ts test/analytics.test.ts test/cursorHookUsage.test.ts test/agentEvent.test.ts test/transcriptRead.test.ts test/state.test.ts test/cli.test.ts test/runLoop.test.ts
```

Then run the repository's declared fast verification before committing and the coordinator's full acceptance suite before publication:

```bash
pnpm check:fast
pnpm check
```

## Alternatives Rejected

- Scraping Cursor's private database or treating absent hook counters as zero is rejected because it makes cost totals look complete without measured data.
- Assigning every Codex token row solely by wall-clock phase, or silently folding unmatched records into the nearest phase, is rejected because concurrent/missing windows can misattribute billing. Existing transcript turn identity and unique complete coordinator windows are the only accepted joins.
- Loosening the roster total to sum whichever agents happened to report is rejected because the resulting number is not comparable across rosters.
- Making the general state schemas accept format 2, migrating legacy files, or permitting analytics to call mutation paths is rejected because it would weaken the control-plane format barrier.
- Adding a duration field to every journal event, an action-timing subsystem, a dashboard/database, or a completion snapshot is rejected for this issue. Only final-check duration is required, and the optional snapshot would materially expand write and lifecycle behavior.
- Counting from the most recent retry nudge is rejected because it erases the stall the retry was meant to recover from.
- Removing or renaming `run.durationMs` is rejected because retaining it as elapsed time keeps existing consumers stable while additive paused/unpaused fields provide the requested split.

## Risks and Mitigations

- **Legacy parsing could accidentally weaken resumability.** Keep the permissive projection behind a separately named analytics-only reader, require completed format-2 cursors, and retain strict operational reader tests.
- **A pause sequence can be duplicated, left open, or timestamped out of order.** Use a small state machine over ordered journal rows, ignore duplicate transitions, close an open interval at the report endpoint, and return nullable invalid metrics rather than negative values.
- **Codex transcript shapes can vary.** Prefer explicit turn ids, recognize only the already observed task boundary records, and preserve unattributed rows plus coverage reasons whenever the boundary is absent or ambiguous.
- **A retry can represent either the same unresolved delivery or a later attempt.** Retain the first nudge only while its key is pending, then clear it on the matching endpoint so subsequent completed attempts remain separately measurable.
- **Duration measurement can be invalid under an injected or adjusted wall clock.** Validate both timestamps and journal `null` on reversal/parse failure; analytics must not coerce missing/invalid values to zero.
- **Coverage dimensions can contaminate one another.** Keep token and tool coverage independent, keep the cross-roster tool total intentionally absent, and gate only the token total on token completeness plus zero unassigned token records.
- **The report could become noisy or incompatible.** Make fields additive, preserve `run.durationMs` and existing sections, and add concise timing lines rather than a new report format.

## Conclusion

This plan closes all seven issue-118 gaps with localized extensions to the existing single-pass analytics path. It reuses journal pause/nudge/check events and vendor session/turn identities, adds only the irrecoverable final-check duration at execution time, keeps missing measurements explicit, and isolates legacy format-2 access to completed read-only analytics so the workflow control plane remains fail-closed.
