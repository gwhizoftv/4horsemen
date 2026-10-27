# Plan — issue 255: Attribute Codex token and tool usage by action timestamp window

Issue: Attribute Codex token and tool usage by action timestamp window when
multiple actions share one vendor `turnId`. In `coord analytics`, a shared
`(sessionId, turnId)` currently collapses all token/tool records onto the
latest action (e.g. `R7.finalize`), forces `coverage=partial` with reason
"one or more token/tool records were shared by one vendor turn across
several actions", makes the cross-roster token total unavailable, and shows
`0` tool calls for `R1.join` / `R2.plan` / `R4.implement` in solo runs.

Current behaviour verified in this clone at baseline
`b45b725f7801df79bbcac6377deec2d195b4e320`:

- `codexSamples` in `src/transcriptRead.ts:320` already parses each record's
  ISO timestamp into `UsageSample.at` (`src/transcriptRead.ts:333`), and token
  samples carry `windowAttribution: "exact"` while `item_completed` tool
  samples carry `windowAttribution: "fallback"`
  (`src/transcriptRead.ts:378,409`). That per-sample timestamp is then lost:
  `aggregateSamples` (`src/transcriptRead.ts:447`) folds samples into
  `TranscriptUsage` rows keyed only by `turnId`, with no timestamp retained.
- `buildAnalytics` in `src/analytics.ts:673-684` therefore resolves one
  aggregate row per vendor turn. `resolveTurnPhase`
  (`src/analytics.ts:141-161`) returns, for `matching.length > 1` sharing one
  `(sessionId, turnId)`, the turn with the greatest `startedMs`,
  `exact: false`, `sharedVendorTurn: true`. `assign`
  (`src/analytics.ts:634`) then downgrades that phase and the agent to
  `partial`, and `sharedTurnTokenFallbackUsed` /
  `sharedTurnToolFallbackUsed` add the "shared by one vendor turn" reasons
  (`src/analytics.ts:679-682,713-718`).
- The `unattributed` path (`src/analytics.ts:685-703`) already does
  timestamp-window matching, but only for samples with `turnId === null`, and
  it still resolves overlaps through the same latest-turn fallback.
- `deriveActionTurns` (`src/analytics.ts:278-320`) gives every chained action
  sharing one `(sessionId, turnId)` the same `endedMs`: the first later
  `stopped` lifecycle event for that session/turn, regardless of action. Raw
  `[startedMs, endedMs]` windows for chained actions therefore overlap, so a
  correct fix must derive non-overlapping effective windows (next action's
  `startedMs` truncates the previous action's window) or use phase
  boundaries, not test raw windows naively.
- `docs/analytics.md:483-496` documents the current latest-action `partial`
  fallback, so the documented contract must be updated with the behaviour.

Approach in one paragraph: preserve per-sample timestamps end-to-end for
turn-keyed samples (new `samples` list on `TranscriptReadResult`, leaving the
existing `turns` aggregate shape untouched), and in `src/analytics.ts`
resolve each sample of a shared vendor turn individually: build
non-overlapping effective action windows from the matching `ActionTurn`s,
fall back to phase boundaries (`phaseIndexAt`) when an action window is
open-ended, mark a sample `exact` only when its timestamp maps to exactly
one candidate window/phase, and keep the existing latest-turn shared
fallback — with `partial` coverage — for any sample that cannot be uniquely
mapped. No new files in `src/`, no new dependencies.

## Exact File List to be changed or deleted

- `src/transcriptRead.ts` — add an exported per-sample type and a `samples`
  field on `TranscriptReadResult`; populate it in `aggregateSamples` from the
  already-parsed `UsageSample.at` values for turn-keyed samples; return
  `samples: []` from the `unavailable` factory in `readTranscript`. The
  existing `TranscriptUsage` / `turns` shape and the `unattributed`
  (`UnattributedTranscriptUsage`, already carrying `at`) shape do not change,
  so `test/transcriptRead.test.ts` exact `turns` expectations and
  `src/cursorHookUsage.ts` `turns` construction stay valid.
- `src/analytics.ts` — add the shared-turn per-sample resolution described
  under Reuse and Scope: a helper that, given the `matching` `ActionTurn[]`
  for one `(sessionId, turnId)`, the derived `phases`, and a sample timestamp
  in milliseconds, returns a `TurnPhaseResolution`; use it only in the
  `result.turns` loop when `matching.length > 1` and per-sample data exists
  for that turn; keep `resolveTurnPhase`, `assign`, and all
  `sharedTurn*FallbackUsed` accounting for the single-match, no-sample, and
  unresolvable-sample paths.
- `src/cursorHookUsage.ts` — return `samples: []` from both
  `readCursorHookUsage` and its `unavailable` factory so the required
  `TranscriptReadResult.samples` field type-checks. Cursor behaviour is
  unchanged: it has no shared-turn sample stream, so a shared Cursor turn (if
  any) keeps the legacy aggregate fallback in `src/analytics.ts`.
- `test/analytics.test.ts` — extend the existing shared-Codex-turn helpers
  (`sharedCodexTranscriptRoot`, `sharedCodexJournal` at
  `test/analytics.test.ts:138-174`) and tests: add the four-phase shared-turn
  test from the Tests section, add the unresolvable-timestamp test, and
  update the one superseded expectation in "labels a turn-keyed aggregate
  partial when one vendor turn maps to multiple actions"
  (`test/analytics.test.ts:655-675`, whose transcript timestamps at
  `00:00:08` / `00:00:15` now map uniquely to `R1.join` / `R2.plan`).
  "assigns overlapping windows from one shared Codex turn as a named partial
  fallback" (`test/analytics.test.ts:634-653`) exercises the `unattributed`
  path and is not modified unless the unified helper changes its result;
  if it does, update only its coverage/reason expectation and record why in
  the test name/comment.
- `test/transcriptRead.test.ts` — add one assertion block (in the existing
  Codex test or a new focused `it`) that `readTranscript` preserves
  per-sample `at`, `turnId`, token and tool counts in `result.samples` for
  the `transcript-codex.jsonl` fixture. No existing expectation changes,
  because `turns` is unchanged.
- `docs/analytics.md` — rewrite the Codex paragraph at
  `docs/analytics.md:483-496`: records in a shared vendor turn are first
  resolved per-sample by timestamp against non-overlapping action windows
  (next `prompt-submitted` start truncates the previous window) and then
  phase boundaries; only a record whose timestamp is missing, invalid,
  outside every candidate window, or ambiguous across candidates keeps the
  latest-action `partial` shared-turn fallback. Keep the sentences on
  `custom_tool_call` and on records across different turn ids unchanged.

No file is deleted. No other `src/` file changes: in particular
`src/agentLifecycle.ts`, `src/state.ts`, `src/cli.ts`, and
`src/cursorHookUsage.ts` logic are out of scope (see Reuse and Scope).

## Exact file list to be created

- `test/support/fixtures/transcript-codex-shared-turn-multiphase.jsonl` —
  new Codex rollout fixture for the four-phase test. One session's records,
  every turn-keyed record carrying the same explicit `turn_id`
  `"turn-shared"`, interleaved by timestamp across the four phase windows
  defined in the Tests section: in each window exactly one
  `event_msg`/`token_count` record (with `info.last_token_usage`, distinct
  counters per phase) and exactly one
  `event_msg`/`item_completed` record whose `item.type` is a member of
  `codexToolTypes` (e.g. `FunctionCall`) with a unique stable `item.id`.
  Timestamps are the record-level ISO `timestamp` field that
  `codexSamples` already reads. Justification: the existing
  `transcript-codex-shared-turn.jsonl` has only two `token_count` records
  and no tool records, so it cannot verify the issue's requirement that
  tool calls as well as tokens are attributed per phase; extending it in
  place would break the two existing tests that assert its exact totals.
  This is the only new file; no new `src/` file, helper module, or test
  file is created.

## Reuse and Scope

Existing code reused, by name:

- `UsageSample.at`, `UsageSample.turnId`, `UsageSample.windowAttribution`
  and the `codexSamples` parsing in `src/transcriptRead.ts` — timestamps are
  already parsed per record; the change only stops discarding them in
  `aggregateSamples`. Token/tool counter parsing, de-duplication by
  `recordId`, the `custom_tool_call` fallback list, and coverage derivation
  in `readTranscript` are reused unchanged.
- `ActionTurn` (`src/analytics.ts:125-133`), `deriveActionTurns`,
  `phaseIndexAt` (`src/analytics.ts:214-225`, including its
  start-inclusive / end-exclusive rule with the last phase inclusive), and
  `milliseconds` (`src/analytics.ts:171-174`) — the new helper consumes
  these; it does not re-derive phases or parse dates itself.
- `TurnPhaseResolution` and `resolveTurnPhase` — reused as the return shape
  and as the fallback for single-match turns, sample-less turns (Cursor),
  and unresolvable samples. The new code is a pre-resolution step for the
  shared case, not a replacement of the existing resolver.
- `assign`, `worseCoverage`, `combineTranscriptCoverage`, the
  `sharedTurnTokenFallbackUsed` / `sharedTurnToolFallbackUsed` flags, and
  the `tokenTotal` gate (`src/analytics.ts:745-776`) — reused unchanged, so
  a fully resolved shared turn naturally yields `complete` coverage and,
  when every other agent is also complete with zero unassigned records, a
  non-null cross-roster token total with no change to the gate itself.
- Test helpers `sharedCodexTranscriptRoot(explicitTurnId)`,
  `sharedCodexJournal()`, `transcriptRoots()`, and the
  `journalEventSchema.parse` fixture style in `test/analytics.test.ts`;
  the four-phase journal is built by extending this style (a new local
  helper in the same file), not by a new harness.

New logic, kept inside `src/analytics.ts` (no new abstraction elsewhere):

1. Effective windows: sort the `matching` turns by `startedMs` (stable;
   equal `startedMs` values are ambiguous by definition). For turn *i*,
   `effectiveEndMs = min(endedMs ?? +Infinity, startedMs of turn i+1)` when
   a next turn exists, else `endedMs ?? +Infinity`. A sample at `t` matches
   turn *i* when `startedMs <= t < effectiveEndMs`, or when *i* is the last
   candidate and `t === effectiveEndMs === endedMs` (mirrors the last-phase
   inclusive rule in `phaseIndexAt`). Exactly one match is a unique action
   window.
2. Phase fallback: if no unique action window results (open-ended or
   truncated windows), compute `phaseIndexAt(phases, sampleAtIso)`; accept
   it only when that phase index is one of the `matching` turns'
   `phaseIndex` values and exactly one matching turn carries it. Otherwise
   the sample is ambiguous.
3. Exactness: a sample resolved by step 1 or 2 is assigned with
   `exact: true` for both token and tool records — the unique timestamp is
   the attribution evidence, superseding the tool samples'
   `windowAttribution: "fallback"` (which only recorded the absence of an
   authoritative per-record turn key). This is the step that removes the
   forced `partial` and unblocks the token total. A sample with a missing
   or unparseable `at`, or no unique window/phase, is assigned through the
   existing latest-turn `resolveTurnPhase(matching, ...)` result with
   `sharedVendorTurn: true`, setting the existing shared-fallback flags so
   coverage stays `partial` with the existing reason string.
4. Conservation: the per-sample branch runs only when
   `matching.length > 1`; samples are filtered by
   `sample.turnId === turnUsage.turnId` (and the enclosing result's
   `sessionId` loop). Their token/tool/record counts sum to the
   `turnUsage` aggregate by construction in `aggregateSamples`; if a result
   has no `samples` for that turn (Cursor), the aggregate row is assigned
   exactly as today. The `unattributed` loop is not changed.

Scope limits: Codex turn-keyed samples only. Claude attribution (parent
chain in `claudeSamples`), Cursor journal usage, overlapping windows across
different `turnId`s (still unassigned), `deriveActionTurns` stopped-event
selection, journal/lifecycle event production, CLI rendering in
`renderAnalytics`, and the coverage vocabulary are all unchanged. No
dependency, config, hook, or `package.json` change; no version bump (the
coordinator checks the `0.0.N` advance only on the PR into `main`).

## Tests

All tests are focused `vitest` cases in existing files; each new case fails
on the baseline and passes after the change. Run while developing with
`pnpm vitest run --config vitest.config.ts test/analytics.test.ts
test/transcriptRead.test.ts` (the repo's `test:fast` config), and let the
commit/push hooks own `pnpm check:fast` for the product commit; the plan
artifact itself is coordination evidence and needs no product suite.

1. New four-phase attribution test in `test/analytics.test.ts` (joins the
   existing `analytics aggregation` describe, reusing
   `sharedCodexTranscriptRoot`-style installation against the new fixture
   `transcript-codex-shared-turn-multiphase.jsonl`): a journal with
   `started` at `00:00:00`, then for each of `R1.join`, `R2.plan`,
   `R4.implement`, `R7.finalize` an `action-prepared` and an
   `agent-lifecycle` `prompt-submitted` with the same
   `sessionId: "session-shared"` and `turnId: "turn-shared"` (starts at
   `00:00:02`, `00:00:12`, `00:00:22`, `00:00:32`), `gate-advanced` events
   at `00:00:10` (`R1.join`→`R2.plan`), `00:00:20`
   (`R2.plan`→`R4.implement`), `00:00:30` (`R4.implement`→`R7.finalize`),
   one shared `stopped` at `00:00:38`, and a terminal gate at `00:00:40`.
   Fixture samples sit at `00:00:03`/`00:00:05`, `00:00:13`/`00:00:15`,
   `00:00:23`/`00:00:25`, `00:00:33`/`00:00:35`. Assert: each phase gets
   exactly its own fixture token counters and `toolCalls: 1` (not `0` for
   the first three phases and not the sum on `R7.finalize`);
   `tokenCoverage` and `toolCoverage` are `"complete"`; neither reason
   contains "shared by one vendor turn"; `unassigned` record counts are
   `0`; and `report.usage.tokenTotal` equals the sum of the four fixture
   token records (active roster `["codex"]` only, as in the existing
   shared-turn tests). On the baseline this fails: all counts land on
   `R7.finalize` with `partial` coverage and a null total.
2. New unresolvable-sample test in `test/analytics.test.ts`: same journal
   shape with two phases, plus one turn-keyed record whose timestamp falls
   outside every candidate window (after the shared `stopped`, e.g.
   `00:00:59`) or with the timestamp field absent. Assert that record keeps
   the existing behaviour — assigned by the latest-turn fallback or left
   counted under the existing shared/unassigned accounting — coverage is
   `partial`, the reason still contains "shared by one vendor turn" (or the
   existing unassigned reason, matching whichever branch the record takes),
   and `tokenTotal` is null. This pins requirement 2: honesty is retained
   when a timestamp genuinely does not map uniquely.
3. Updated existing test in `test/analytics.test.ts`: "labels a turn-keyed
   aggregate partial when one vendor turn maps to multiple actions"
   (`sharedCodexTranscriptRoot(true)` + `sharedCodexJournal()`) now expects
   the two token records split `R1.join` / `R2.plan` by timestamp
   (`input: 10, output: 2, cacheRead: 10` and
   `input: 10, output: 4, cacheRead: 30` — the same split the
   `unattributed` twin test already expects) with `complete` token
   coverage and no shared-turn reason; rename the test to state the new
   rule. The `unattributed` twin at line 634 is left as-is unless the
   implementation unifies the paths, per the file list above.
4. New preservation assertion in `test/transcriptRead.test.ts`:
   `readTranscript` on the Codex fixture returns `result.samples` whose
   turn-keyed entries carry the exact fixture `timestamp` strings as `at`,
   the fixture `turnId`s, and per-record (not yet aggregated) token/tool
   counts; `result.turns` still equals the previously asserted aggregates.
   On the baseline this fails because `samples` does not exist.
5. Regression guard, no new case: the full existing
   `test/analytics.test.ts`, `test/transcriptRead.test.ts`, and
   `test/cursorHookUsage.test.ts` suites must pass, proving single-match
   turns, Claude attribution, Cursor turns (`samples: []` fallback),
   missing-identity degradation, and the token-total gate are unchanged.

## Alternatives Rejected

- Resolve only inside `resolveTurnPhase` by picking the turn whose raw
  `[startedMs, endedMs]` contains "the turn's" timestamp: rejected because
  an aggregate `TranscriptUsage` has no single timestamp — this is exactly
  the information `aggregateSamples` discards — and because raw windows of
  chained actions overlap (shared `stopped`), so containment alone stays
  ambiguous. Per-sample data plus effective-window truncation is required.
- Change `TranscriptUsage` to carry a `samples` array on every turn row:
  rejected because it breaks the exact `toEqual` turn expectations in
  `test/transcriptRead.test.ts` and `test/cursorHookUsage.test.ts` and
  forces `src/cursorHookUsage.ts` to synthesise sample rows it has no
  timestamps for. A top-level `samples` list on `TranscriptReadResult`
  preserves every existing shape.
- Fix `deriveActionTurns` to stop each action at the next action's
  `prompt-submitted`: rejected as the primary fix because `endedMs` is also
  the record of the real vendor `stopped` event other logic may rely on,
  and the issue explicitly asks for sample-timestamp resolution against
  action windows or phase boundaries in the attribution step. Effective
  windows are derived locally in the resolver instead; changing
  `deriveActionTurns` remains a possible follow-up, not this issue.
- Attribute shared-turn samples by phase boundaries only
  (`phaseIndexAt` for every sample): rejected as the sole rule because a
  phase can contain several actions of the same agent, and the issue lists
  action windows first; phase lookup is kept as the fallback when action
  windows are open-ended, guarded by "exactly one matching turn carries
  that phase".
- Split the shared vendor turn in `codexSamples` by inventing synthetic
  turn ids per timestamp cluster: rejected because the transcript reader
  has no journal knowledge (it receives only vendor, session, root), so it
  cannot know action or phase boundaries; clustering would guess.
- Treat every shared-turn tool sample as still `partial` because
  `item_completed` samples are marked `windowAttribution: "fallback"`:
  rejected because it defeats requirement 2 — uniquely timestamped records
  would still force `partial` and keep the cross-roster total unavailable
  in exactly the solo runs the issue cites.

## Risks and Mitigations

- Overlapping or identical windows: two chained actions can share the same
  `startedMs` (same-second prompts) or a `stopped` can precede a later
  sample. Mitigation: equal starts and zero-length effective windows are
  treated as ambiguous and keep the existing `partial` fallback; the
  phase-fallback step is guarded to a single matching turn per phase.
- Boundary samples: a record timestamped exactly at the next action's
  start or at the shared `stopped`. Mitigation: one documented rule —
  start-inclusive, end-exclusive, last candidate inclusive at its real
  `endedMs` — mirroring `phaseIndexAt`; the four-phase fixture places one
  tool record in each window interior so the test does not hinge on a
  boundary guess, and boundary behaviour is stated in `docs/analytics.md`.
- Open-ended turns (`endedMs: null`, agent still running): samples after
  the last start would match an infinite window. Mitigation: phase
  fallback requires the phase to belong to exactly one matching turn;
  otherwise the sample keeps the shared fallback instead of being guessed
  into the running phase.
- Double counting: assigning both the aggregate turn row and its samples
  would inflate totals. Mitigation: the per-sample branch replaces the
  aggregate assignment for that turn (it never runs in addition), sample
  counts sum to the aggregate by construction, and the four-phase test
  asserts exact per-phase counters plus the exact token total.
- Vendor format drift: a future Codex build could emit turn-keyed records
  without timestamps. Mitigation: missing/invalid `at` takes the existing
  latest-turn shared fallback with `partial` coverage — the pre-fix
  behaviour — so drift degrades coverage honestly rather than
  misattributing.
- Cursor regression: `readCursorHookUsage` returns the same
  `TranscriptReadResult` type. Mitigation: it returns `samples: []`, the
  analytics loop falls back to today's aggregate path for sample-less
  turns, and `test/cursorHookUsage.test.ts` must pass unmodified.

## Conclusion

Implement the smallest change that satisfies all three issue requirements:
preserve per-sample Codex timestamps through `src/transcriptRead.ts` (new
`samples` list, existing `turns` untouched), resolve shared
`(sessionId, turnId)` samples in `src/analytics.ts` against non-overlapping
effective action windows with a guarded phase-boundary fallback, keep the
latest-turn `partial` fallback only for samples that cannot be uniquely
mapped, return `samples: []` from `src/cursorHookUsage.ts`, update the
current-behaviour paragraph in `docs/analytics.md`, and prove it with the
four-phase `R1.join` / `R2.plan` / `R4.implement` / `R7.finalize` fixture
test, the unresolvable-timestamp honesty test, the updated two-phase
shared-turn expectation, and the transcript timestamp-preservation
assertion. Four existing files change, one test changes, one doc changes,
and exactly one fixture file is created; no new source files, dependencies,
or coverage semantics are introduced.
