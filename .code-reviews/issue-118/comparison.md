# Issue 118 implementation comparison

Bound implementation pins (protocolVersion 1):

- Claude: `7d850e3549cddd9d50924c742781ac470543989e` at `.signals/issue-118/implementation-ready-claude.json`
- Codex: `17c3cf4f21786faed2eb0f30bb5e8a1ada7a6923` at `.signals/issue-118/implementation-ready-codex.json`
- Cursor: `270c9f035040dbac3f38ef79cda2dfa8ac080106` at `.signals/issue-118/implementation-ready-cursor.json`

Selected plan: Claude `2dcc50606a58b412c4b6f527e39f578defb39456`. All three pins change the same twelve product paths under `docs/`, `src/`, and `test/` (plus agent-local plan/review/signal paths outside product comparison).

## Comparison

### Shared behavior

Every pin closes the seven issue-118 gaps on the same surfaces:

1. **Cursor tokens** — `normalizedTokenUsage` reads journaled `{input, output, cacheRead, cacheWrite, reasoning}` before vendor aliases; empty token rows report `tokenCoverage: "unavailable"` (not `"unsupported"`).
2. **Codex shared vendor turn** — overlapping `prompt-submitted → stopped` windows that share one `sessionId`/`turnId` assign to the latest-started action with `exact === false` and a shared-turn reason; different `turnId`s stay unassigned.
3. **First-outstanding nudge** — both `deriveWaits` and `deriveResponseLatency` set `pendingNudge` only when the `(agent, actionId)` key is absent.
4. **Paused / unpaused** — `run.pausedMs` / `run.unpausedMs` with `durationMs` kept as elapsed wall time.
5. **Final-check duration** — `runLoop` journals `durationMs`; analytics renders missing values as unavailable, not `0`.
6. **Legacy read-only analytics** — header + `readJournalForAnalytics` (Codex wraps them in `readAnalyticsRuntime`); strict `readStartState` / `readJournal` / `readCursorsState` still wipe-guide on formats 2/3.
7. **Cross-roster total** — gate unchanged; `tokenTotalReason` names blocking agents; provenance/`source.legacy` printed when relevant.

Product-only diff volume (`docs/` + `src/` + `test/` at each pin):

| Pin | Approx. changed lines | `test/analytics.test.ts` cases |
|-----|----------------------:|-------------------------------:|
| Codex `17c3cf4f` | 589 | 15 |
| Cursor `270c9f03` | 747 | 17 |
| Claude `7d850e35` | 898 | 23 |

### Mechanical differences (non-defect unless noted below)

- **CLI wiring:** Claude and Cursor branch in `src/cli.ts`; Codex centralizes in `readAnalyticsRuntime` (`src/state.ts:874-898`) and always prefers live `cursors.activeRoster` when present.
- **Legacy roster:** Claude (`src/cli.ts:1356`) and Cursor (`src/cli.ts:1366`) report legacy runs with `header.originalRoster`; Codex uses the loose cursors header’s `activeRoster`.
- **Legacy completeness:** Codex refuses incomplete legacy runs (`src/state.ts:891-892`); Claude/Cursor will render an unfinished format-2/3 journal.
- **Shared-turn bookkeeping:** Claude counts shared records into the reason string; Codex/Cursor set boolean flags. Cursor also runs shared-turn resolution on already-keyed `result.turns` (`src/analytics.ts:620-626`), not only unattributed window matches.
- **Pause helpers:** Claude/Cursor skip unparseable timestamps; Codex returns `null` for the whole pause split if any `paused`/`resumed` timestamp fails (`src/analytics.ts:391-392`).

### Findings

#### Cursor — `src/state.ts:808-839` — analytics journal skips corrupt known events

**Rule:** `readJournalForAnalytics` may skip unknown event *types* (and count them), but a line whose `type` is known and whose body fails schema validation must throw. Skipping a known terminal event lets a broken journal look complete.

**Concrete failure:** A format-2 journal whose `gate-advanced` / `paused` line has a truncated `details` object is dropped into `skipped` (`:833-835`). The report can omit the pause interval or still show `state=running` while Claude’s reader at `7d850e35` (`src/state.ts:773-775`) would fail closed. Invalid JSON is likewise skipped (`:820-822`) instead of failing the command.

**Test:** Feed `analytics-journal-format2.jsonl` plus one known-type line with `details: null`; expect `readJournalForAnalytics` to throw, not increment `skipped`.

#### Cursor — `src/state.ts:824-826` — provenance `formatVersion` is last-line-wins

**Rule:** The reported journal `formatVersion` must come from the durable run header (first journal line / start header), not whatever the final line claims.

**Concrete failure:** In a mixed or repaired file, a trailing format-4 scrap after format-2 history sets `formatVersion` to `4` while `source.legacy` is still true from the start header path, so provenance lies about which bytes were read.

**Test:** Two-line journal with `formatVersion: 2` then `formatVersion: 4`; expect analytics journal read to report `formatVersion === 2` (or throw on mixed versions, as Codex does at `src/state.ts:856-858`).

#### Cursor — `src/analytics.ts:657-659` — shared-turn flag blames both token and tool channels

**Rule:** A shared-vendor-turn fallback must annotate only the channels that actually carried shared records (token vs tool), matching Claude’s per-channel accounting.

**Concrete failure:** A transcript with shared token windows and zero shared tool records still appends `one or more tool records were shared by one vendor turn across several actions` whenever `sharedTurnFallbackUsed` is set, so tool coverage looks worse than the data.

**Test:** Shared-turn fixture with token rows only; expect `tokenReason` to mention the shared turn and `toolReason` not to.

#### Claude / Cursor — legacy active roster from `originalRoster`

**Rule:** Analytics roster for a completed issue should reflect who actually ran (`activeRoster` after drops), not the creation-time original roster — otherwise wait/usage rows invent agents that were dropped mid-run.

**Concrete failure:** Claude `src/cli.ts:1356` and Cursor `src/cli.ts:1366` pass `header.originalRoster` into `buildAnalytics` for legacy issues. A format-2 run that dropped `codex` still emits wait and coverage lines for `codex`. Codex avoids this via `readAnalyticsRuntime` (`src/state.ts:900`) using the cursors header `activeRoster`.

**Test:** Legacy start + completed cursors with `activeRoster: ["cursor"]` and `droppedAgents: ["codex"]`; expect rendered analytics to omit `codex` wait/usage rows.

#### Codex — `src/analytics.ts:391-392` — one bad pause timestamp nulls the whole split

**Rule:** Unparseable non-pause events must not poison pause math; for pause/resume rows, skip-or-clip is preferable to erasing `pausedMs`/`unpausedMs` for an otherwise valid run (elapsed remains trustworthy).

**Concrete failure:** A single `paused` event with a non-ISO `at` makes `derivePausedMs` return `null`, so the Run line loses the paused/unpaused split even when every other pause pair is valid. Claude (`src/analytics.ts:394-411`) and Cursor (`src/analytics.ts:297-325`) ignore null timestamps and still sum the good intervals.

**Test:** Journal with one valid pause/resume pair and one `paused` row whose `at` is `"not-a-time"`; expect non-null `pausedMs` equal to the valid pair (or an explicit skip count), not `pausedMs === null`.

### Verdict preference

Prefer **Claude `7d850e3549cddd9d50924c742781ac470543989e`** as the merge base: it is the selected plan author’s pin, keeps fail-closed analytics parsing for known journal types, names shared-turn impact with record counts, and carries the densest gap coverage in tests. Adopt Codex’s completed-legacy + `activeRoster` gating when revising, and reject Cursor’s skip-all-failures journal reader and dual-channel shared-turn reason flag without a channel check.
