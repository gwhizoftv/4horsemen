# Issue 118 plan: repair analytics for trustworthy cost and timing comparisons

## Scope

Close the seven analytics gaps called out in GitHub issue **#118** and
`docs/analytics.md` §3/§6. Each change reuses existing journal fields and
readers; no new analytics service, migration framework, or dashboard. The public
`coord analytics` text report stays the primary surface — extend sections in
place rather than introducing a parallel report format.

The seven deliverables map to concrete code paths:

1. **Cursor token capture** — persist hook-supplied token fields on
   `agent-usage` rows; report `unavailable` when hooks did not journal tokens.
2. **Codex phase attribution** — tighten the smallest reliable join so fewer
   `token_count` records land in `unassigned`; keep explicit `unassigned` for
   records that still lack identity.
3. **Cross-roster totals** — keep the existing strict policy (total only when
   every active agent has `complete` token coverage and zero unassigned token
   records); fix coverage bugs that block Cursor/Codex from qualifying.
4. **Historical format-2/3 read-only analytics** — allow `coord analytics` on
   completed legacy runtime files; resume/start/wipe paths remain fail-closed.
5. **Paused vs unpaused runtime** — split headline elapsed time using existing
   `paused` / `resumed` journal events.
6. **Stall-aware wait timing** — measure `nudged` → `intent-seen` from the
   **first** outstanding nudge per `(agent, actionId)`, not the last retry.
7. **Final-check duration** — journal `durationMs` on each `final-check` record;
   surface durations in analytics; absent durations stay `null`, never `0`.

Optional stretch items (`analytics-summary.json`, `actionId` on every usage
row) are out of scope unless they land as a few lines while implementing the
seven items above.

## Exact File List to be changed or deleted

### Changed

- `src/analytics.ts` — add `derivePausedIntervals` and extend `run` with
  `elapsedMs`, `pausedMs`, and `unpausedMs`; change `deriveWaits` (and document
  whether ballot `responseLatency` keeps per-retry pairing or also becomes
  first-nudge — default: change only `waits`, leave ballot latency as-is unless
  a fixture proves it must match); add `finalChecks` aggregation from journal
  `final-check` rows including optional `durationMs`; extend `renderAnalytics`
  for the new time split, stall-aware waits, and final-check durations; keep
  cross-roster total policy unchanged but verify Cursor/Codex completeness
  paths after attribution fixes.
- `src/state.ts` — add `readJournalForAnalytics` that parses journal lines with
  `formatVersion` 2, 3, or 4 without calling `assertRuntimeFormat`; add
  `readStartStateForAnalytics` and `readCursorsStateForAnalytics` with relaxed
  `formatVersion` literals (2/3/4) for read-only reporting; export a small
  `readAnalyticsRuntime(paths)` helper used only by the analytics command;
  extend `journalEventSchema.formatVersion` union to include `2` when needed for
  on-disk legacy lines; keep `readStartState`, `readCursorsState`, and
  `readJournal` strict for all control-plane callers.
- `src/cli.ts` — wire `coord analytics` to `readAnalyticsRuntime` instead of
  strict readers; no new flags.
- `src/runLoop.ts` — measure wall time around each hermetic `checks` invocation
  and include `durationMs` in `final-check.details` alongside existing
  `tier`, `name`, `argv`, and `exitCode`.
- `src/agentEvent.ts` — when appending `agent-usage`, copy the current lifecycle
  `actionId` onto the journal row when the hook context supplies it (same source
  as `agent-lifecycle` rows); do not invent tokens or read Cursor private stores.
- `src/transcriptRead.ts` — improve Codex token attribution in this order:
  (a) honor `turn_id` on `token_count` when present; (b) join through
  coordinator `prompt-submitted` → `stopped` windows keyed by journaled
  `sessionId`/`turnId`; (c) keep timestamp-window fallback labelled `partial`;
  never fold unmatched records into a phase silently.
- `docs/analytics.md` — update §3 gaps and §6 deferred list to reflect what
  issue 118 closes; document paused/unpaused split, first-nudge wait semantics,
  legacy read-only support, and final-check duration.
- `test/analytics.test.ts` — one focused test per gap (seven new or rewritten
  cases): Cursor tokens present vs unavailable; Codex unassigned reduction on a
  fixture; cross-roster total when all agents complete; format-2 completed
  journal via analytics readers; paused interval subtraction; first-nudge stall
  visibility across retries; final-check duration rendering.
- `test/state.test.ts` — prove legacy format 2/3 journal/start/cursors parse
  through analytics readers while strict readers still throw wipe guidance.
- `test/runLoop.test.ts` — assert `final-check.details.durationMs` is a positive
  integer when checks run.
- `test/agentEvent.test.ts` — prove Cursor `afterAgentResponse` usage rows carry
  `actionId` when the lifecycle observation bound one.
- `test/transcriptRead.test.ts` — Codex fixture where improved join assigns a
  previously unassigned `token_count` record.
- `test/cli.test.ts` — integration-style test that `coord analytics` succeeds
  on a completed format-2 runtime fixture without enabling resume.

### Deleted

- None.

## Exact file list to be created

- `test/support/fixtures/analytics-runtime-format2/` — minimal completed legacy
  runtime (`start.json`, `cursors.json`, `journal.jsonl` at format 2 or 3) used
  by analytics CLI and reader tests; journal includes `paused`/`resumed`,
  multi-nudge wait stall, and `final-check` rows (with and without `durationMs`
  for backward compatibility).
- `.plans/issue-118/plan.md` — this file.

## Implementation Details

1. **Single-pass journal analytics.** All new projections (`pausedMs`, waits,
   final checks) scan the journal once inside `buildAnalytics` or small helpers
   called from it. No run-loop polling or per-tick work.
2. **Honest coverage.** Missing measurements remain `null` or labelled
   `unavailable`/`partial`/`unassigned`. Never emit `0` where data is absent.
3. **Cursor tokens.** Rely on managed `.cursor/hooks.json` usage hooks already
   installed by `agentHookSync.ts` (`postToolUse`, `afterAgentResponse`). Parse
   with existing `extractCursorTokenUsage`; aggregate with `readCursorHookUsage`.
   When no token-bearing `agent-usage` rows exist for a session, surface
   `tokenCoverage: unavailable` and `tokenReason` explaining hooks did not
   journal token fields.
4. **Codex attribution.** Prefer exact keys already documented in
   `docs/analytics.md` §5: lifecycle `sessionId`/`turnId`, Codex
   `item_completed.turn_id`, and complete coordinator windows. Only then use
   single-window timestamp fallback. Report remaining unassigned volume in agent
   `unassigned` and reasons on the agent row.
5. **Cross-roster total.** Keep the existing guard in `buildAnalytics`:
   `tokenTotal` is non-null only when every active agent has
   `tokenCoverage === "complete"` and `unassigned.tokenRecords === 0`. Fixing
   Cursor/Codex coverage is the intended unlock; do not loosen the policy.
6. **Legacy read-only path.** `readAnalyticsRuntime` is used exclusively by
   `coord analytics`. It must not be referenced from `resume`, `start`, the run
   loop, or hook handlers. Completed legacy issues may have `formatVersion` 2 or
   3 on disk; analytics reads them; any attempt to resume still hits strict
   parsers and the wipe message.
7. **Paused time.** Walk `paused` / `resumed` events in sequence order; sum
   intersection with `[started.at, run end]`; if a run ends while still paused,
   count through run end. Expose `elapsedMs` (existing wall clock),
   `pausedMs`, and `unpausedMs = elapsedMs - pausedMs` on `report.run`.
8. **Stall-aware waits.** For each `(agent, actionId)`, set the wait anchor at
   the timestamp of the **first** `nudged` event and ignore later `nudged`
   retries until `intent-seen` clears the pair. This preserves multi-hour stalls
   that a late retry would otherwise hide.
9. **Final-check duration.** Wrap `processRunner` timing in the finalize path;
   journal integer `durationMs`. Analytics lists each check's name, exit code,
   and duration; pre-ship journals without the field show `duration unavailable`.
10. **Docs and acceptance alignment.** After implementation, `docs/analytics.md`
    gap list matches shipped behavior; issue acceptance checklist items are
    satisfied by named tests above.

## Tests

Run focused tests while implementing:

```bash
pnpm vitest run --config vitest.config.ts test/analytics.test.ts test/state.test.ts test/runLoop.test.ts test/agentEvent.test.ts test/transcriptRead.test.ts test/cli.test.ts
```

Run the repository pre-commit suite before committing:

```bash
pnpm check:fast
```

Run full coordinator acceptance before final publication:

```bash
pnpm check
```

Manual smoke on a real completed issue (optional during development):

```bash
pnpm build
node dist/main.js analytics --issue 76 --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime
```

Tests must prove:

- Each of the seven gaps has a dedicated unit or fixture test.
- Legacy format-2/3 completed fixtures report phase/time (and token sections when
  identity exists) without throwing wipe errors.
- Strict `readJournal` / `readStartState` still reject legacy formats for
  control-plane callers.
- A retry after a long idle produces a wait interval anchored at the first
  nudge, not the last.
- Paused intervals subtract from headline unpaused time.
- Final-check rows written after this change include `durationMs`; analytics
  shows them; older rows without the field stay `null`.
- Cursor with journaled tokens reports `complete`; Cursor without tokens reports
  `unavailable`, not zero-filled totals.
- Cross-roster `tokenTotal` appears only under the strict complete-and-zero-
  unassigned policy.

## Alternatives Rejected

- **Scrape Cursor `store.db` or vendor-private databases.** Violates trust
  boundary; hooks are the supported token source.
- **Loosen cross-roster totals.** Would produce misleading cost comparisons when
  Codex or Cursor coverage is partial.
- **Migrate legacy runtime to format 4.** Out of scope; read-only reporting is
  enough for historical baselines.
- **Resume or start legacy format-2/3 state.** Control plane must stay fail-closed
  per #109.
- **New analytics database or multi-issue dashboard.** Explicit non-goal.
- **Journal `action-timing` delivery-chain events.** Deferred from Phase 1; stall
  fix uses first-nudge semantics without a new event type.
- **Broad `durationMs` on every journal record.** Issue limits duration work to
  `final-check` only.
- **Cross-roster tool totals.** Vendors differ; remain intentionally unreported.
- **Separate analytics package or JSON report v2.** Extend existing
  `src/analytics.ts` and text renderer to keep diff small.

## Risks and Mitigations

- **Risk: legacy schema drift breaks relaxed parsers.** Mitigation: fixture copied
  from a real pre-format-3 completed issue; Zod strict schemas with explicit
  formatVersion union; strict readers unchanged.
- **Risk: first-nudge waits inflate medians vs prior per-retry table.** Mitigation:
  intentional behavior change for stall visibility; update tests and
  `docs/analytics.md` §2.3 wording; keep ballot response latency semantics
  separate unless tests require alignment.
- **Risk: Codex join heuristics silently mis-attribute tokens.** Mitigation: keep
  `unassigned` bucket and `partial` fallback labels; add fixture proving only
  confident joins move records out of unassigned.
- **Risk: paused intervals double-count when journal is malformed.** Mitigation:
  treat unmatched `resumed` as no-op; cap paused sum at `elapsedMs`; test odd
  sequences.
- **Risk: final-check timing includes worktree setup/teardown.** Mitigation:
  measure only the `processRunner` call window documented in the plan; keep
  worktree lifecycle outside the timed region (matching operator intent for
  check cost).
- **Risk: attaching `actionId` to usage rows leaks wrong action on concurrent
  hooks.** Mitigation: copy only from the normalized lifecycle observation for
  the same hook delivery, same as existing `agent-lifecycle` journaling.
- **Risk: scope creep into analytics-summary snapshot.** Mitigation: stretch items
  explicitly deferred unless trivial during implementation.

## Conclusion

Issue 118 is a bounded repair pass on the existing analytics stack: seven
targeted projections and joins in `src/analytics.ts`, `src/state.ts`,
`src/transcriptRead.ts`, `src/runLoop.ts`, and `src/agentEvent.ts`, with one
legacy fixture and focused tests. The outcome is a `coord analytics` report
operators can trust for before/after cost and timing comparisons — honest
coverage, visible stalls, pause-adjusted runtime, final-check cost, Cursor
tokens when hooks fire, tighter Codex attribution, and read-only access to
completed legacy runs — without expanding into dashboards, migrations, or new
long-lived services.
