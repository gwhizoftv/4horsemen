# Issue 118 plan review (cursor)

Bound plans reviewed:

- cursor @ `25a7ff8bc81c90389f203c95579dddcf3a2b5387`
- codex @ `492f35f7e088821f91ba27893ce702c35bb7339f`
- claude @ `2dcc50606a58b412c4b6f527e39f578defb39456`

## Findings

### Cursor plan — Cursor token capture targets the wrong layer

**Claim:** `src/agentEvent.ts` should copy `actionId` onto `agent-usage` rows so
Cursor tokens persist and report correctly (`plan.md` scope item 1 and Exact File
List).

**Rule:** When hooks supply token fields, journaled usage must survive the
read path and appear in `coord analytics` with honest coverage — not
`unsupported` with zero token records.

**Failure:** The coordinator already normalizes hook payloads and journals
`details.tokens` as `{input, output, cacheRead, cacheWrite, reasoning}` in
`src/agentEvent.ts`, but `cursorUsageFromJournalDetails`
(`src/cursorHookUsage.ts:106-113`) re-parses that object with
`extractCursorTokenUsage`, whose aliases are vendor names (`input_tokens`,
`inputTokens`, …) only. Normalized keys round-trip to `undefined`, `tokens` is
dropped, and `readCursorHookUsage` reports `tokenRecords === 0` even when hooks
fired. Adding `actionId` on write does not repair that read-side loss; Cursor
still blocks cross-roster totals.

**Correction:** Fix `src/cursorHookUsage.ts` first — accept the normalized
journaled shape before vendor aliases — and classify empty token streams as
`unavailable`, not `unsupported`.

### Cursor plan — Codex attribution omits the measured overlap defect

**Claim:** Improve Codex joins only in `src/transcriptRead.ts` via `turn_id`
and coordinator windows (`plan.md` Exact File List).

**Rule:** The plan must address why measured production journals leave large
Codex token volumes in `unassigned`, not only how to parse transcript rows.

**Failure:** In `src/analytics.ts:527-537`, unattributed records matching more
than one coordinator `prompt-submitted → stopped` window are discarded
(`matching.length === 1` required). Codex reuses one vendor `turn_id` across
nested coordinator actions, so many `token_count` rows fall in two windows and
stay unassigned even when transcript parsing is perfect. Transcript-only changes
cannot recover those rows.

**Correction:** Add an analytics-level fallback: when all matching windows
share the same `sessionId` and `turnId`, assign with `exact === false` and
`partial` coverage (as claude's plan specifies); keep different-`turnId` overlaps
explicitly unassigned.

### Cursor and Codex plans — legacy analytics never reaches the reader

**Claim (cursor):** Add `readAnalyticsRuntime` in `src/state.ts` and wire only
the `analytics` branch in `src/cli.ts`. **Claim (codex):** Route `coord
analytics` through a read-only reader and an analytics-specific runtime lookup.

**Rule:** `coord analytics` on a completed format-2/3 run must succeed without
relaxing start/resume/control-plane parsers.

**Failure:** Before the analytics branch runs, path resolution calls
`readStartState` from `matchesConfig` (`src/cli.ts:607`) and
`withStoredMailbox` (`src/cli.ts:192`). Both invoke `assertRuntimeFormat`, which
throws the wipe error on legacy `start.json`. A lenient reader added only inside
the analytics branch is never reached; legacy completed runs still fail at lookup.

**Correction:** Introduce a header-only start read (`formatVersion`, `issue`,
`originalRoster`, `configPath`, `completesRoot`) for resolution helpers, as
claude's plan specifies; keep strict `readStartState` for every mutating command.

### Cursor plan — stall-aware timing leaves ballot waits on the old rule

**Claim:** Change `deriveWaits` only; leave ballot `responseLatency` on
per-retry pairing unless a fixture proves otherwise (`plan.md`
`src/analytics.ts` bullet).

**Rule:** A late retry must not reset wait clocks used for stall visibility
(issue #118 goal 6; `docs/analytics.md` already reports ballot response
latency separately).

**Failure:** `deriveResponseLatency` (`src/analytics.ts:297-299`) still
overwrites `pendingNudge` on every retry. Following the cursor plan leaves
ballot response medians/maxima measured from the last nudge only, so the same
multi-hour stall remains hidden in that table even after agent waits are fixed.

**Correction:** Apply first-outstanding-nudge retention to both
`deriveWaits` and `deriveResponseLatency` (codex and claude agree).

### Codex plan — task-boundary parsing does not fix shared-turn overlap

**Claim:** In `src/transcriptRead.ts`, use `task_started.turn_id` /
`task_complete.turn_id` to supply turn identity for `token_count` rows that omit
`turn_id` (`plan.md` Exact File List).

**Rule:** Codex phase attribution must reduce unassigned volume on
representative completed runs without silent folding.

**Failure:** On issue-121-shaped journals, most unassigned tokens already have
turn identity; they fail because two coordinator action windows overlap on the
same vendor turn (`analytics.ts:527-537`), not because the transcript row lacks
`turn_id`. Task-boundary parsing in `transcriptRead.ts` does not choose between
those windows and leaves the 79-record overlap class untouched.

**Correction:** Pair transcript turn enrichment with the shared-vendor-turn
fallback in `src/analytics.ts`; keep task boundaries as a separate enrichment for
rows that truly lack turn keys.

### Codex plan — normalized Cursor tokens still drop on read

**Claim:** `src/cursorHookUsage.ts` should classify tool-only sessions as token
`unavailable` and continue aggregating journaled usage (`plan.md` Exact File
List).

**Rule:** Supplied hook tokens must be counted when present; absence must not
look like an unsupported vendor.

**Failure:** The plan changes the empty-session label but does not fix
`cursorUsageFromJournalDetails` re-parsing normalized journaled tokens through
vendor-only aliases. Sessions with journaled `turn-usage` rows still read as
having zero token records and can remain `unsupported`/`unavailable` incorrectly.

**Correction:** Add normalized-token recognition before
`extractCursorTokenUsage`, as claude's plan specifies.

### Claude plan — legacy analytics skips `cursors.json` active roster

**Claim:** On legacy format, build analytics from the start header with
`activeRoster = originalRoster` and do not read `cursors.json` (`plan.md`
`src/cli.ts` gap 4).

**Rule:** Cross-roster totals and per-agent waits must use the roster that
actually ran, including agent drops on completed issues.

**Failure:** If a completed format-2/3 issue recorded drops in `cursors.json`,
forcing `activeRoster = originalRoster` re-requires token coverage from dropped
agents, keeps blocking `tokenTotal`, and mislabels waits for agents no longer
active. The plan's legacy fixture omits drops, so the gap is easy to miss during
implementation.

**Correction:** When `cursors.json` parses under a lenient completed-state
projection, use its `activeRoster`; fall back to `originalRoster` only when
cursors are missing or unreadable.

## Conclusion

All three plans cover the seven issue-118 gaps and stay within the requested
surface (no migration framework, no new analytics service). **Claude's plan is
the most implementation-ready:** it names two measured root causes (Cursor token
round-trip loss and Codex shared-turn overlap), fixes CLI path resolution before
the analytics branch, and gives one focused test per gap. **Codex's plan**
aligns on first-nudge pairing for both wait tables, pause semantics, final-check
duration, and strict cross-roster totals, but under-specifies CLI resolution and
over-weighted transcript task boundaries for the overlap class. **The cursor
plan** (this agent's bound revision) is structurally sound but must adopt
claude's read-side Cursor fix, analytics shared-turn fallback, and header-based
path resolution; drop the optional `actionId`-on-usage stretch unless it remains
trivial after those fixes.

None of the plans is blocking if the implementation merges: (1) normalized
Cursor token read + `unavailable` label, (2) shared-vendor-turn fallback in
`analytics.ts`, (3) header-only start reads in CLI resolution, (4) first-nudge
retention in both wait derivations, plus the pause/final-check/legacy-reader
work all three agree on. Proceed to implementation with claude's defect analysis
as the authoritative join strategy and codex's explicit invariants on
`run.durationMs`, pause state machine, and completed-only legacy reads.
