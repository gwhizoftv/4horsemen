# Issue 255 — attribute shared Codex turns by sample timestamp

Protocol version: 1. Baseline: `b45b725f7801df79bbcac6377deec2d195b4e320`.
Issue session: `issue-255:b45b725f7801df79bbcac6377deec2d195b4e320`.

The frozen issue asks for tokens and tools from one Codex vendor turn to be
distributed across R1.join, R2.plan, R4.implement, and R7.finalize using their
recorded timestamps. Complete, uniquely attributable samples must no longer
make coverage partial merely because the vendor reused its turn ID.

At this baseline, `codexSamples` already captures `record.timestamp` in
`UsageSample.at`. The loss occurs in `aggregateSamples`: keyed samples become
one `TranscriptUsage` without timestamps. Unkeyed samples retain timestamps in
`unattributed`, but overlapping lifecycle windows still invoke the latest-action
fallback. The baseline does not infer a turn ID from `turn_context`; this change
will handle the existing keyed and unkeyed routes without inventing identities.

## Exact File List to be changed or deleted

Change these five existing files; delete none:

- `src/transcriptRead.ts`: retain per-record timestamp and usage details within
  Codex turn aggregates, preserving existing totals and parser validation.
- `src/analytics.ts`: resolve shared Codex usage per sample against action and
  phase timestamps before invoking the existing partial fallback.
- `test/transcriptRead.test.ts`: extend reader assertions to cover retained
  keyed samples and unchanged deduplication/normalization.
- `test/analytics.test.ts`: extend the shared-turn fixture helpers and replace
  obsolete always-partial expectations with timestamp attribution regressions.
- `docs/analytics.md`: update the Exact attribution section, whose current text
  says shared turns always use a partial latest-action fallback.

## Exact file list to be created

No product, test, fixture, or dependency files are needed. This action creates
only `.plans/issue-255/plan.md`, the coordinator-required planning artifact.
Generate the additional fixture records inside the existing test helpers.

## Reuse and Scope

Reuse `UsageSample`, `UnattributedTranscriptUsage`, `TranscriptUsage`,
`TokenUsage`, `codexSamples`, `aggregateSamples`, `readTranscript`, and
`addTokens` in the reader. Add an optional `samples` member to
`TranscriptUsage`, using the existing per-record shape
`UnattributedTranscriptUsage[]`; the enclosing aggregate supplies `turnId`.
Populate it only for Codex when aggregating validated, deduplicated samples.
Keep `turns` totals and `unattributed` intact. This additive member avoids
changing Claude results or the constructors in `src/cursorHookUsage.ts`.
It is necessary because the analytics consumer cannot split a summed turn
after the original record timestamps have been discarded.

Reuse `ActionTurn`, `deriveActionTurns`, `derivePhases`, `milliseconds`,
`resolveTurnPhase`, `TurnPhaseResolution`, `assign`, and the separate token/tool
coverage accounting in analytics. Implement the timestamp decision next to the
existing resolver; no new module or general attribution framework is needed.
Use the phase-boundary convention already implemented by `phaseIndexAt`:
start inclusive, end exclusive, with the final phase's terminal instant
included. Resolve by phase index, never by phase name, so revision rounds remain
distinct. Do not change lifecycle derivation or journal schemas.

The resolution flow is:

1. For a Codex aggregate whose `(sessionId, turnId)` matches multiple
   `ActionTurn` entries, process its retained samples instead of assigning its
   aggregate. Never assign both. Keep the current aggregate route for other
   vendors and an unambiguous single identity match.
2. Restrict keyed candidates to that exact session and turn. For an unkeyed
   Codex record, begin with the existing same-session timestamp-window
   candidates. Apply shared-turn disambiguation only if those candidates share
   one vendor turn ID; overlap between different turn IDs remains unassigned.
3. Parse the sample timestamp. A complete action window can supply a unique
   match when its phase also contains that timestamp. Shared vendor stop events
   can leave several action windows overlapping; in that case use the valid
   phase intervals belonging to that same shared identity group to find a
   unique phase. Phase matching must inspect all eligible intervals rather than
   silently accepting the first malformed/overlapping interval.
4. Phase disambiguation requires evidence that the shared turn is active at
   the sample timestamp: at least one of its lifecycle windows must contain
   it. A missing stop may be bounded by the report's known phase/run end for
   this shared-turn route, without manufacturing a stop event. A timestamp
   before all starts, after all known stops, in a genuine gap between complete
   windows, or outside the reported phase intervals is not exact. Phase
   boundaries can resolve an overlapping shared window even when the next
   action's prompt hook arrived after its phase began.
5. If those constraints identify one phase, assign the individual supported
   Codex token/tool record exactly, including a timestamp-resolved unkeyed
   record in a proven shared-turn group. Several candidate actions in the
   same phase do not make the reported phase ambiguous. At a phase transition
   the new phase owns the timestamp. Invalid/absent timestamps, invalid phase
   intervals, and multiple possible phases must never be promoted to exact.
6. If exact resolution fails, preserve `resolveTurnPhase`'s named partial
   latest-action fallback for an identified shared turn. Unkeyed samples with
   no eligible identity/window stay unassigned. Set shared-turn fallback
   reasons only for samples actually assigned through that fallback. Preserve
   metric-specific accounting: a bad tool attribution alone does not block an
   otherwise complete cross-roster token total.

Reader-level uncertainty remains authoritative: missing stores, truncated
JSONL, malformed counters, unsupported item types, and missing stable IDs are
not repaired by a successful timestamp match. Preserve `last_token_usage`
normalization, cache/reasoning fields, stable-ID deduplication, and the current
preference for authoritative `item_completed` tools over custom-tool fallback
records. No new Codex event formats or inferred context identities are needed.

Reuse `sharedCodexJournal`, `sharedCodexTranscriptRoot`, `transcriptRoots`,
`readJournalFixture`, `removeBrokenClaudeRecord`, `journalEventSchema`, and
the temporary-root cleanup in `test/analytics.test.ts`. The existing
`test/support/fixtures/transcript-codex-shared-turn.jsonl` and
`test/support/fixtures/transcript-codex.jsonl` are read-only seeds; derive
additional records in memory. Reuse `installFixture` and `transcriptPath` in
the reader tests. Preserve existing Claude, Cursor, missing-identity,
unsupported-record, and independent-coverage cases as regression coverage.

## Tests

Use the existing two test files and a small set of related cases:

1. **Reader preservation**, in `test/transcriptRead.test.ts`: extend the Codex
   reader case with keyed token/tool records at different timestamps, including
   a duplicate stable ID. Assert each retained sample's ID, timestamp, counters,
   and that sample sums equal the unchanged aggregate totals. Missing/invalid
   timestamp text must survive for conservative analytics handling rather than
   causing otherwise valid measurements to disappear. The preservation
   assertions fail before the change.
2. **Four-phase attribution**, in `test/analytics.test.ts`: extend the shared
   journal helper to prepare R1.join, R2.plan, R4.implement, and R7.finalize
   actions with one session/turn and a shared final stop. Give each phase
   distinguishable token deltas and tool counts. Exercise explicit keyed
   records and records without a turn key using supported timestamp windows;
   exercise the custom-tool-only fallback representation as a variant without
   authoritative item completions. Assert each phase's full token vector and
   tool count, complete metric coverage, no unassigned records, no shared-turn
   warning, conserved totals, and a non-null token total for the solo roster.
   Include a record exactly on a phase boundary. Update the current two-phase
   tests to expect exact placement where timestamps prove it. These assertions
   fail against the current collapsed/partial behavior.
3. **Honest residual uncertainty**, in `test/analytics.test.ts`: use table-driven
   mutations of that fixture for missing timestamp, invalid timestamp,
   out-of-window timestamp, and overlapping different turn identities for an
   unkeyed sample. Include an open final window bounded by a fixed `now`, and
   a timestamp beyond that bound. Check that valid sibling samples still
   reach their own phases exactly, unresolved samples remain counted once
   through partial fallback or unassigned accounting, and token/tool coverage
   degrades independently. Keep a case with a token record unresolved so the
   roster total stays unavailable. Retain the existing nonshared-vendor and
   malformed-source tests rather than duplicating them.

During implementation run:

```sh
pnpm exec vitest run --config vitest.config.ts test/transcriptRead.test.ts test/analytics.test.ts
```

The actual package scripts and runtime configuration were inspected. In this
issue's current local verification mode, the product precommit hook owns
`pnpm run check:fast` (lint, typecheck, fast tests, system tests), and the prepush
hook owns `pnpm run test:e2e`. Do not manually repeat those suites immediately
before committing/pushing. The frozen coordinator final check is
`pnpm run check`, which includes build, check:fast, and e2e; report its result
as coordinator evidence, not an agent-run check. If a later action switches to
coordinator verification mode, follow that action's ownership instructions.

For this plan-only action, validate all seven required headings and nonempty
bodies, verify the exact five-path file map and cited baseline, and publish only
the plan. No product suite is required or claimed for this planning artifact.

## Alternatives Rejected

- Assigning an entire shared aggregate to the newest action preserves the bug
  and hides useful timestamp evidence.
- Marking every shared turn complete without per-record resolution would
  conceal missing or ambiguous timestamps.
- Assigning all session records by global phase time alone could charge an
  unrelated session/turn or a record outside the action windows to this issue.
- Splitting totals proportionally by phase duration invents usage distribution
  even though the original records already provide timestamps.
- Replacing the transcript result contract for all vendors, changing hook
  events, or adding a new persisted usage stream is unnecessary for this fix.
- Adding standalone fixture files or a general interval library adds scope
  that the existing helpers and phase representation already cover.

## Risks and Mitigations

- **Double counting:** retained samples supplement aggregate metadata but
  replace aggregate assignment only on the shared Codex route. Assert exact
  conservation across assigned and unassigned totals, including duplicate IDs.
- **False exactness:** require a valid timestamp, matching session/turn
  evidence, an eligible lifecycle window, and a unique valid phase. Test gaps,
  open-window bounds, and identity overlap; preserve partial fallback reasons.
- **Boundary errors:** use the existing half-open phase convention and phase
  indices, and test the transition instant explicitly.
- **Coverage laundering:** keep parser coverage and token/tool reasons
  independent from attribution success; existing unsupported/truncated and
  mixed-vendor tests must remain valid.
- **Reader compatibility and memory:** make retained sample data optional and
  Codex-only, using references to already parsed usage objects where practical.
  Other vendor constructors and the analytics report format stay compatible.

## Conclusion

Preserve Codex sample timestamps at aggregation and consume them only where a
shared vendor identity needs disambiguation. A uniquely timed token or tool
record reaches its actual phase with exact attribution; unresolved records
retain honest partial or unassigned accounting. Five existing files and no new
dependencies or product files are sufficient to implement and verify issue 255.
