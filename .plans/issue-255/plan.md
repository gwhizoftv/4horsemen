# Issue 255 plan — attribute shared Codex turn usage by sample timestamp

## Problem restated against the code

- `src/transcriptRead.ts` `aggregateSamples` folds every `UsageSample` that carries
  a `turnId` into one `TranscriptUsage` per turn. That drops each sample's `at`.
  Live Codex `item_completed` tool rows carry `turn_id`, so all tool calls for a
  shared turn reach analytics as one timeless aggregate.
- `src/analytics.ts` `resolveTurnPhase` sees several `ActionTurn`s with the same
  `(sessionId, turnId)` and assigns the whole aggregate to the latest-started
  action (R7.finalize). It marks the aggregate non-exact (`sharedVendorTurn`),
  which makes coverage `partial` and blocks the cross-roster token total.
- Live Codex `token_count` rows have no `turn_id`, so they go through the
  `unattributed` path. `deriveActionTurns` gives every prompt in a shared turn
  the same `stopped` end. The windows `[startedMs, endedMs]` therefore nest, and
  a token row after the second prompt matches several siblings. Today it lands
  on the right action (the latest-started match) but is still flagged as a
  shared-turn fallback, so coverage is `partial` even though the timestamp is
  unambiguous.

## Exact File List to be changed or deleted

- `src/transcriptRead.ts`
  - Export a new type `TranscriptSample = { at: string | null; tokens: TokenUsage; toolCalls: number; tokenRecords: number; toolRecords: number }`.
  - Add an optional `samples?: TranscriptSample[]` field to `TranscriptUsage`.
  - In `aggregateSamples`, append each turn-keyed sample to its turn's `samples`
    in file order, keeping its `at`. The aggregate totals stay exactly as they
    are today. No change to `codexSamples`, `claudeSamples`, or coverage
    computation.
- `src/analytics.ts`
  - Add one helper, `sharedTurnOwner(siblings: readonly ActionTurn[], at: number | null): ActionTurn | null`.
    It returns the single sibling whose slice of the shared vendor turn contains
    `at`, or `null`. Order siblings by `startedMs`. Sibling *k* owns `at` only
    when all of these hold:
    - `startedMs_k <= at`;
    - `at < startedMs_{k+1}` when a next sibling exists (half-open, so a
      timestamp equal to the next prompt belongs to the next action);
    - `at <= endedMs_k` when `endedMs_k` is non-null. A last sibling with a
      null end owns nothing, because an open window is not a bound.

    It returns `null` when `at` is `null`, when `at` lies before the first
    prompt, after a stop, or in a gap between a stop and the next prompt, or
    when two siblings share the same `startedMs`. These are the "outside or
    ambiguous" cases where the issue still requires `partial`.
  - In `buildAnalytics`, turn-keyed loop over `result.turns`: when
    `resolveTurnPhase` reports `sharedVendorTurn` and `turnUsage.samples` is
    present, assign each sample on its own.
    - If `sharedTurnOwner(matching, milliseconds(sample.at))` returns an owner,
      assign the sample to the owner's `phaseIndex` with
      `exact = owner.phaseIndex !== null`.
    - Otherwise apply today's fallback to that sample alone: the latest action,
      non-exact, and set `sharedTurnTokenFallbackUsed` /
      `sharedTurnToolFallbackUsed` for that sample's record kinds.

    Turns with no `samples` (Cursor hook usage) and non-shared turns keep the
    current single `assign` call.
  - In `buildAnalytics`, unattributed loop: when `resolveTurnPhase` reports
    `sharedVendorTurn`, call `sharedTurnOwner` on all of this agent's turns with
    the same `(sessionId, turnId)` as the first match. If it returns an owner,
    assign there with `exact = record.windowAttribution === "exact"`, which
    keeps the current `singleMatchExact` meaning, and do not set the shared
    flag. Otherwise keep today's fallback and flag.
  - `resolveTurnPhase`, `ActionTurn`, `deriveActionTurns`, `assign`, the reason
    strings, and the token-total gate are unchanged.
- `test/analytics.test.ts`
  - Update the two existing shared-turn cases to the corrected attribution (see
    Tests).
  - Add one multi-phase case as the issue requires.
- `test/transcriptRead.test.ts`
  - Lines 43 and 62 use `toEqual` on `result.turns`. They must include the new
    `samples` arrays. This doubles as the transcript-level proof that each
    sample keeps its timestamp.

No files are deleted.

## Exact file list to be created

None. The issue's new case builds its multi-phase Codex transcript inline with
`writeFileSync` inside `test/analytics.test.ts`. That follows the inline pattern
already used in `test/transcriptRead.test.ts`, so it needs no new fixture file.

## Reuse and Scope

Reused without modification:

- `UsageSample.at` (already parsed in `codexSamples` / `claudeSamples`) is the
  timestamp source; nothing new is parsed.
- `ActionTurn.startedMs` / `endedMs` from `deriveActionTurns` are the action
  windows; no new journal reading.
- `resolveTurnPhase` still detects the shared turn and supplies the fallback
  phase.
- `assign`, `worseCoverage`, `milliseconds`, the `sharedTurn*FallbackUsed`
  flags, and the existing reason text "shared by one vendor turn across several
  actions" are unchanged. Coverage stays honest through the same path: only a
  fallback sample makes it `partial`.
- Test helpers `sharedCodexTranscriptRoot`, `sharedCodexJournal`, `start`,
  `journalEventSchema`, the `roots` cleanup, and the existing
  `transcript-codex-shared-turn.jsonl` / `transcript-codex.jsonl` fixtures.

Scope:

- `samples` is optional, so `src/cursorHookUsage.ts` (which builds
  `TranscriptUsage` with `satisfies`) and its tests need no change, and Cursor
  attribution is untouched.
- `AnalyticsReport` output shape is unchanged; `TranscriptUsage` is internal to
  the analytics computation.
- The only new abstractions are the exported `TranscriptSample` type, which the
  `samples` field needs, and `sharedTurnOwner`. The helper has two call sites,
  the turn-keyed and unattributed loops, so one rule decides both.
- No new files or dependencies.

## Tests

Focused command while developing:
`pnpm vitest run --config vitest.config.ts test/analytics.test.ts test/transcriptRead.test.ts`.
The commit hook owns `pnpm check:fast`; I will not run it again by hand right
before committing.

1. **New:** `test/analytics.test.ts`, "attributes one shared Codex turn across
   R1/R2/R4/R7 by record timestamp".
   - Journal: `started`, then four `action-prepared` + `prompt-submitted` pairs
     (same `sessionId` / `turnId: "turn-shared"`). They are separated by
     `gate-advanced` R1.join→R2.plan→R4.implement→R7.finalize, followed by one
     `stopped` and a final gate to `null`.
   - Transcript, written inline: inside each action's slice, one or more
     `item_completed` tool rows with `turn_id: "turn-shared"` and distinct
     ids, plus one live-format `token_count` row with no `turn_id`.
   - Assert: per-phase `toolCalls` (for example 1/2/3/1) and per-phase tokens
     match each slice. `tokenCoverage` and `toolCoverage` are `"complete"`.
     Neither reason contains "shared by one vendor turn". `unassigned` record
     counts are 0, and `report.usage.tokenTotal` is non-null.
   - Before the change this fails, because all tool calls land on R7.finalize
     and coverage is `partial`.
   - Second step in the same case, for honest coverage: append one tool row
     timestamped after `stopped`, rebuild, and assert that R7.finalize gains it,
     `toolCoverage` is `"partial"`, and `toolReason` contains "shared by one
     vendor turn across several actions". Tokens stay `"complete"`.
2. **Updated:** `test/analytics.test.ts:634`, "assigns overlapping windows from
   one shared Codex turn…". Same phases as now, but the 00:00:15 row now
   resolves to its unique slice. Expect `tokenCoverage: "complete"` and no
   shared-turn reason. Rename the case to say it resolves by timestamp.
3. **Updated:** `test/analytics.test.ts:655`, "labels a turn-keyed aggregate
   partial…". With per-sample timestamps the turn-keyed rows split: R1.join
   `{input 10, output 2, cacheRead 10}` and R2.plan
   `{input 10, output 4, cacheRead 30}`. Expect `tokenCoverage: "complete"`
   and `tokenTotal` equal to `{input 20, output 6, cacheRead 40, cacheWrite 0, reasoning 3}`.
   Rename the case accordingly.
4. **Updated:** `test/transcriptRead.test.ts:43` and `:62`. Add `samples` to the
   expected turns. For example, Codex `turn-codex-1` has
   `samples: [{ at: "2026-08-21T00:01:25.000Z", toolCalls: 1, toolRecords: 1, tokenRecords: 0, tokens: zero }]`.
   The duplicate `tool-codex-1` row stays de-duplicated. The Claude turn gets
   its matching samples.

## Alternatives Rejected

- **Map samples to phases with `phaseIndexAt` (gate boundaries) only.** This
  attributes by the gate that is open, not by which action the agent was on. A
  record emitted after a gate advanced but before the next prompt would be
  credited to the new phase even though the agent was still finishing the
  previous action. Action windows are the tighter, journaled bound, and they
  already supply `phaseIndex` through `action-prepared`.
- **Stop aggregating Codex samples and emit them all as `unattributed`.** That
  discards the authoritative `turn_id` key. It would also make Codex tool rows
  depend on stop/prompt windows even in unshared turns, where the turn key is
  exact today.
- **Add a separate `turnSamples` list to `TranscriptReadResult`.** It duplicates
  the turn data in a second place that analytics would have to re-join by
  `turnId`. A per-turn `samples` field keeps the data next to the aggregate it
  explains.
- **Treat nested `[startedMs, endedMs]` windows as exact by taking the latest
  match.** That only works for the unattributed path. It cannot split
  turn-keyed tools, which is the reported R7 dump.
- **Partition siblings without honouring `endedMs`.** Records after a stop or
  between a stop and the next prompt would be silently claimed. That would hide
  exactly the ambiguity the issue says must remain `partial`.

## Risks and Mitigations

- **A sibling slice could steal a record that belonged to a previous action
  still running after the next prompt.** Mitigation: a Codex turn is sequential
  per agent. A record at or after the next prompt belongs to that prompt, which
  matches how the coordinator chains actions (re-read `action.md`, then the next
  prompt). Equal start times are treated as ambiguous and fall back.
- **An in-progress run's last action has no stop.** Mitigation: a null
  `endedMs` on the last sibling yields no owner, so those samples keep today's
  partial fallback instead of being claimed by an unbounded window.
- **Wider `TranscriptUsage` objects could break deep-equality consumers.**
  Mitigation: the field is optional. The only `toEqual` consumers
  (`test/transcriptRead.test.ts:43,62`) are updated in this change. Cursor
  construction is unaffected.
- **Memory use grows with large sessions.** Mitigation: transcripts are already
  bounded by `readBoundedJsonl`, and samples hold only small numeric records
  already materialized as `UsageSample`.
- **Behaviour change to two existing assertions.** This is intentional, and
  both updated expectations come from the fixture arithmetic shown under
  Tests.

## Conclusion

The fix keeps each turn-keyed sample's timestamp in `TranscriptUsage.samples`.
When one Codex `turnId` spans several actions, analytics resolves each sample
with one helper, `sharedTurnOwner`, against non-overlapping action slices: from
a prompt to the next sibling prompt, bounded by the sibling's stop. Samples that
resolve uniquely are attributed exactly, so R1/R2/R4 receive their own tools and
tokens and coverage can be `complete`. Samples outside or ambiguous across
slices keep the existing latest-action fallback, `partial` coverage, and the
shared-turn reason.

Four files change: `src/transcriptRead.ts`, `src/analytics.ts`,
`test/analytics.test.ts`, and `test/transcriptRead.test.ts`. No files are
created and no dependencies are added.
