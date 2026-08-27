## Comparison

The exact implementations compared are Claude
`7d850e3549cddd9d50924c742781ac470543989e`, Codex
`17c3cf4f21786faed2eb0f30bb5e8a1ada7a6923`, and Cursor
`270c9f035040dbac3f38ef79cda2dfa8ac080106`.

All three implement the central repair set: normalized Cursor token reads,
first-outstanding-nudge timing, pause accounting, final-check durations,
shared-turn timestamp fallback, legacy provenance, and explanatory
cross-roster-total blocking. Their important differences are at the trust
boundaries rather than in report presentation.

### Findings

1. **Claude `src/cli.ts:1346-1357` and Cursor `src/cli.ts:1355-1367`.** The
   legacy analytics rule must admit only completed format-2/3 state and must use
   the run's recorded active roster. Both implementations bypass
   `cursors.json`, accept every legacy header as reportable, and pass
   `originalRoster` to analytics. An interrupted legacy issue therefore
   succeeds despite the completed-only contract, while a completed issue that
   dropped an agent recreates that agent's wait/coverage rows and can suppress
   an otherwise valid cross-roster total. The smallest regression fixture is a
   loose legacy cursors header with `completed: false`, followed by one with
   `completed: true` and `activeRoster` smaller than `originalRoster`; the first
   must fail and the second must report only the active roster.

2. **Cursor `src/state.ts:816-836`.** A compatibility reader may count and skip
   unknown event types, but malformed JSON and malformed records of a known,
   timing-bearing type must fail closed. This implementation increments
   `skipped` for every JSON or schema failure. If the terminal
   `gate-advanced` row has an invalid timestamp or details shape, analytics
   silently drops it, treats a completed run as in progress, and extends the
   final phase and elapsed time to the current clock. A focused test should
   corrupt a known terminal row and require an error while retaining the
   existing skip-count behavior for an unknown `type`.

3. **Claude `src/cursorHookUsage.ts:96-109` and Cursor
   `src/cursorHookUsage.ts:45-62`.** A canonical normalized token object must be
   complete before it contributes numbers; missing counters must not be
   materialized as zero. Both readers accept an object when only one of
   `input`, `output`, `cacheRead`, or `cacheWrite` is present and fill all
   absent counters with zero. A partial or damaged journal row can therefore
   be counted as measured usage and may unlock a misleading cross-roster total.
   The smallest test passes `{input: 10}` as canonical `details.tokens` and
   requires the row to remain unavailable rather than becoming
   `{input: 10, output: 0, cacheRead: 0, cacheWrite: 0}`.

4. **Claude `src/analytics.ts:608-613` and Codex
   `src/analytics.ts:586-592`.** A transcript turn keyed by
   `(sessionId, turnId)` may be labelled exact only when that identity maps to
   one coordinator action. Both implementations use `find` for
   `result.turns`, even though their later unattributed-record path explicitly
   handles one vendor turn shared by multiple actions. If a transcript supplies
   `turn_id` and the vendor reuses that turn across actions in different
   phases, the entire aggregated turn is assigned to the first action with
   complete coverage; the phase split is silently wrong and the inaccurate
   volume may enter the cross-roster total. A focused fixture should include an
   explicit-turn token row plus two lifecycle windows sharing that turn and
   require a labelled partial tie-break or an unassigned result. Cursor's
   `resolveSharedTurnPhase` at `src/analytics.ts:279-295` correctly applies the
   same non-exact rule to both turn-keyed and timestamp-attributed records.

### Relative assessment

**Codex `17c3cf4f21786faed2eb0f30bb5e8a1ada7a6923` is the strongest base.** It is
the only pin that reads the minimal legacy cursors projection, requires
`completed`, preserves `activeRoster`, rejects mixed runtime formats, fails on
malformed known events, and requires every canonical Cursor counter before
accepting the row (`src/state.ts:830-907`,
`src/cursorHookUsage.ts:45-61`). Its remaining defect is finding 4: the shared
turn resolver should also cover already turn-keyed transcript aggregates.

**Claude `7d850e3549cddd9d50924c742781ac470543989e` ranks second.** It has a clear,
well-tested unknown-versus-known legacy journal distinction and otherwise
closely follows the selected plan, but its start-header-only legacy branch
cannot enforce completed-only reporting or preserve drops, and its canonical
token parser can invent zero counters.

**Cursor `270c9f035040dbac3f38ef79cda2dfa8ac080106` ranks third.** Its reusable
shared-turn resolver is the best attribution implementation and is the piece to
carry into a revision of the Codex pin. However, treating every malformed
legacy row as skippable is a direct threat to the report's headline timing, on
top of the same legacy-roster and canonical-zero problems as Claude.

Recommendation: advance the Codex pin, then adopt Cursor's turn-keyed
shared-turn handling before finalization. Do not select the Claude or Cursor
pins without first restoring the completed/active-roster legacy boundary; for
Cursor, malformed known journal records must also become fatal.
