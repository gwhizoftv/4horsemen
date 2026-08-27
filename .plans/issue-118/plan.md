# Issue 118 — Repair analytics for trustworthy cost and timing comparisons

Baseline `c8e5fadd97df09bfc611d8e82f7a51189276bbfe`; branch `issue-118/claude`.

Two of the seven gaps have measured root causes in this repository, taken from
the completed issue-121 run
(`coord analytics --issue 121 --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime`,
journal `/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-121/journal.jsonl`,
Codex transcript
`~/.codex/sessions/2026/08/26/rollout-2026-08-26T15-14-50-01a04023-e91d-7a21-8c55-3a4c0de675cf.jsonl`).
They are stated here because they change what the smallest fix is:

- **Cursor tokens are captured and then dropped on read.** The hook path
  normalizes tokens before journaling (`src/agentEvent.ts:246-252` writes
  `details.tokens = {input, output, cacheRead, cacheWrite, reasoning}`), but
  `cursorUsageFromJournalDetails` (`src/cursorHookUsage.ts:106`) re-parses that
  object with `extractCursorTokenUsage`, whose aliases are the *vendor* names
  (`input_tokens`, `inputTokens`, `prompt_tokens`, …) and do not include the
  normalized names. The round trip returns `null`, `tokens` is dropped, and
  `readCursorHookUsage` reports `tokenRecords === 0`. Verified by executing the
  two functions back to back: input `{conversation_id, generation_id,
  inputTokens: 40, …}` journals as
  `{"tokens":{"input":40,"output":8,"cacheRead":12,"cacheWrite":0,"reasoning":null}}`
  and reads back with no `tokens` key at all. Issue 121 journaled 391
  `agent-usage` records and still reported
  `cursor: coverage=unsupported (… Cursor hooks did not journal token fields for
  this session)`. This is a read-side defect, not missing capture.
- **Codex unassigned volume is caused by overlapping turn windows, not by
  missing identity.** Of 308 `token_count` records in the issue-121 Codex
  transcript, 227 fall inside exactly one coordinator
  `prompt-submitted → stopped` window and are attributed today; **79 fall inside
  two windows and are therefore discarded** by the `matching.length === 1` test
  in `src/analytics.ts:602-612`; 2 fall in no closed window. Codex reuses one
  `turn_id` when a second prompt is submitted while a turn is still running, so
  `deriveActionTurns` emits two `ActionTurn` rows with the same
  `sessionId`/`turnId` and nested time ranges (e.g. actions `aa11675c` at
  `22:14:52` and `fc856554` at `22:16:03`, both closing at `22:19:44` on turn
  `…0c35ae`). Restricting the ambiguity rule to *different vendor turns*
  recovers 79 of the 81 unassigned records on that journal (unassigned
  `records=91` in the current report, which also counts tool records).

The remaining five gaps are pure projection or one-field changes.

## Exact File List to be changed or deleted

No file is deleted.

1. **`src/cursorHookUsage.ts`** — gaps 1 and 3.
   - Add a `normalizedTokenUsage(value)` reader for the journaled shape
     (`input`, `output`, `cacheRead`, `cacheWrite`, `reasoning`) and try it
     *before* `extractCursorTokenUsage` in `cursorUsageFromJournalDetails`
     (`:106`). Vendor-shaped rows already on disk keep parsing through the
     existing alias reader, so no journal is rewritten and no fixture breaks.
   - In `readCursorHookUsage` (`:189-193`), report `tokenCoverage`
     `"unavailable"` (not `"unsupported"`) when `tokenRecords === 0`, with the
     reason `Cursor hooks did not journal token fields for this session`.
     Cursor can supply tokens, so absence is missing data, not an unsupported
     vendor. `coverage` keeps its current shape; `toolCoverage` is unchanged.
     The dead ternary at `:191` (`toolRecords > 0 ? "complete" : "complete"`)
     collapses to `"complete"`.

2. **`src/analytics.ts`** — gaps 2, 3, 5, 6, 7 and the legacy provenance line.
   - `BuildAnalyticsInput.start` narrows from `StartState` to
     `Pick<StartState, "issue" | "originalRoster" | "createdAt">` (exported as
     `AnalyticsStart`). `buildAnalytics` reads only those three fields today;
     the narrowing is what lets a legacy `start.json` be reported without
     parsing the control-plane schema. Every existing caller still type-checks.
   - `deriveWaits` (`:236-244`) and `deriveResponseLatency` (`:279-287`): keep
     the **first outstanding** nudge per `(agent, actionId)` — set
     `pendingNudge` only when the key is absent — so a retry no longer resets
     the clock. A nudge issued *after* the matching `intent-seen` /
     `response-accepted` still opens a new wait, because the pending entry is
     deleted on pairing.
   - New `derivePauseIntervals(journal)`: merge `paused` → `resumed` spans
     (`paused` while paused is a no-op, `resumed` while running is ignored, a
     trailing `paused` runs to the report end), clipped to the run window.
     `AnalyticsReport.run` gains `pausedMs` and `unpausedMs`; `durationMs`
     keeps its current meaning (elapsed) so the existing field is not
     redefined. Both new fields are `null` when `durationMs` is `null`.
   - New `deriveFinalChecks(journal)` → `AnalyticsReport.finalChecks:
     FinalCheckAnalytics[]` with `{ at, agent, name, tier, exitCode,
     durationMs: number | null }`. `durationMs` is `null` for records written
     before this change — never `0`.
   - Unattributed-record matching (`:598-614`): when more than one turn window
     contains the record, do not discard it if every matching window shares the
     same `sessionId` **and** `turnId` — that is one vendor turn split across
     coordinator actions. Assign it to the matching window with the greatest
     `startedMs` (the most recently submitted prompt), always with
     `exact === false`, so coverage drops to `partial` and the reason
     `one or more token records were shared by one vendor turn across several
     actions` is recorded. Matches spanning different `turnId`s stay
     `unassigned`.
   - `tokenTotal` gate is unchanged (every active agent `complete`, zero
     unassigned token records). Add `tokenTotalReason: string | null` naming the
     agents that block it, so an unavailable total is explained rather than
     guessed.
   - `AnalyticsReport.source: { formatVersion: number; legacy: boolean;
     skippedJournalRecords: number }`, supplied by the caller, so a legacy
     read-only report says so in its output.
   - `renderAnalytics`: `Run:` line gains `elapsed / paused / unpaused`; new
     `Final checks` section (`- <name> (tier): exit=<n> duration=<x>s|unavailable`,
     and `- none recorded` when the list is empty); the cross-roster total line
     prints `tokenTotalReason`; a provenance line is printed when
     `source.legacy` is true or `skippedJournalRecords > 0`.

3. **`src/state.ts`** — gap 4 (read-only history, control plane still fails
   closed).
   - Export `isLegacyRuntimeFormat(value: unknown): boolean` over the existing
     `LEGACY_RUNTIME_FORMAT_VERSIONS` set (`:40`).
   - `startStateHeaderSchema` + `readStartStateHeader(paths)`: a loose
     (non-strict) schema reading only `formatVersion`, `issue`,
     `originalRoster`, `createdAt`, `configPath`, `completesRoot?`, parsed
     **without** `assertRuntimeFormat`. Unknown legacy keys are ignored; nothing
     is written back.
   - `readJournalForAnalytics(paths)` → `{ events, formatVersion, skipped }`:
     same line loop as `readJournal` (`:766-780`) minus `assertRuntimeFormat`,
     normalizing `formatVersion` to `RUNTIME_FORMAT_VERSION` *in memory only*,
     and skipping (counting) any line whose `type` is not in the current enum or
     that otherwise fails `journalEventSchema`. A skipped count is reported, not
     swallowed.
   - `readStartState`, `readCursorsState`, `readJournal`, `appendJournal` and
     `assertRuntimeFormat` are untouched, so `start`, `run`, `resume` and every
     mutating path keep failing closed on formats 2 and 3.

4. **`src/cli.ts`** — gap 4 at the command boundary.
   - `matchesConfig` (`:610`) and `withStoredMailbox` (`:625`) call
     `readStartStateHeader` instead of `readStartState`. Both read only
     `configPath` / `completesRoot` to *locate* runtime state; today they throw
     the wipe error during path resolution, before the `analytics` branch runs,
     which is what makes a legacy run unreadable. Resolution stays honest and
     every command that actually mutates state still calls `readStartState` and
     fails closed.
   - `analytics` branch (`:1327-1347`): read the header first. On
     `RUNTIME_FORMAT_VERSION`, behave exactly as today (`readStartState`,
     `readCursorsState`, `readJournal`). On a legacy version, build from the
     header (`activeRoster = originalRoster`, no `cursors.json` read) with
     `readJournalForAnalytics`, and pass `source: { legacy: true, … }`.
   - `help` text (`:227`) gains one clause: analytics also reads completed
     legacy (format 2/3) runs read-only.

5. **`src/runLoop.ts`** — gap 7.
   - In `verifyFinalizationChecks` (`:1809-1826`), capture
     `Date.parse(this.now())` immediately before and after
     `await this.processRunner(argv, target)` and add
     `durationMs` to the `final-check` details. Emit `null` when either
     timestamp is unparsable or the clock went backwards; never `0` as a
     stand-in for "not measured". The injected `now` (`:776`) keeps this
     deterministic under test.

6. **`docs/analytics.md`** — the contract text this report is checked against.
   - §1.4 Cursor row: journaled `agent-usage` rows carry normalized token
     fields and are read back in that shape.
   - §2.3 / §5 "Time": waits pair `intent-seen` with the **first outstanding**
     nudge for the `(agent, actionId)` pair, so a retry does not hide a stall;
     the same rule applies to response latency.
   - §2.5 / §3.3: `final-check` now records `durationMs`; older records report
     `unavailable`.
   - §5: add the elapsed/paused/unpaused split, the shared-vendor-turn fallback
     for Codex (labelled `partial`, never silent), the `tokenTotalReason`
     explanation, `unavailable` for a Cursor session with no journaled token
     fields, and the read-only legacy reader with its fail-closed boundary.
   - §6: strike the items this issue delivers; keep the rest deferred.

7. **`test/analytics.test.ts`** — new cases (see Tests).

8. **`test/cursorHookUsage.test.ts`** — round-trip and `unavailable` cases.

9. **`test/cli.test.ts`** — legacy read-only analytics plus the fail-closed
   assertions for `run`.

10. **`test/runLoop.test.ts`** — `final-check` `durationMs`.

## Exact file list to be created

1. **`test/support/fixtures/analytics-journal-format2.jsonl`** — a completed
   format-2 journal: `{"formatVersion":2,…}` on every line, `started`,
   `action-prepared`, `nudged`, `intent-seen`, `gate-advanced` boundaries
   including a terminal `{"from":"R7.finalize","to":null}`, one `paused` /
   `resumed` pair, one `final-check` **without** `durationMs`, and one record
   whose `type` is not in the current enum (to exercise the skipped-record
   count). No `agent-lifecycle` session identity, so the token/tool sections are
   correctly omitted rather than faked.

2. **`test/support/fixtures/transcript-codex-shared-turn.jsonl`** — a Codex
   transcript with `token_count` records whose timestamps fall inside two nested
   coordinator windows that share one `turn_id`, mirroring the issue-121 shape.
   Used to prove the shared-turn fallback assigns them as `partial` instead of
   leaving them unassigned.

No new module, package, store, or report format is created.

## Tests

Every gap gets a focused test. Command: `pnpm check:fast` (lint, typecheck,
`vitest run --config vitest.config.ts`). The coordinator's stricter `pnpm check`
adds `pnpm build` and the e2e suite; nothing here touches e2e fixtures.

1. **Cursor token capture** (`test/cursorHookUsage.test.ts`): feed a raw
   `afterAgentResponse` payload through `normalizeCursorUsageEvent`, journal the
   result verbatim, read it with `cursorUsageFromJournalDetails` and
   `readCursorHookUsage`, and assert the token counts survive with
   `tokenCoverage: "complete"`. Second case: journaled tool records but no
   `turn-usage` row ⇒ `tokenCoverage: "unavailable"`, `tokens` null for every
   phase, and no zeros in `renderAnalytics` output. The existing
   vendor-shaped-tokens fixture in `test/analytics.test.ts:386` must stay green,
   which pins the backward-compatible read.
2. **Codex phase attribution** (`test/analytics.test.ts`): two
   `prompt-submitted` events for different `actionId`s sharing one
   `sessionId`/`turnId` with nested windows, plus
   `transcript-codex-shared-turn.jsonl`. Assert the records land in the
   later-started action's phase, `unassigned.tokenRecords === 0`,
   `tokenCoverage === "partial"`, and the shared-turn reason is present. A
   sibling case with two *different* `turnId`s must stay `unassigned`.
3. **Cross-roster totals** (`test/analytics.test.ts`): a roster of
   `claude, codex, cursor` where Cursor's hook tokens are journaled and both
   transcripts are complete ⇒ `tokenTotal` is non-null and equals the sum of
   per-phase tokens; `tokenTotalReason` is `null`. Flip Cursor's token rows off
   ⇒ total `null` and `tokenTotalReason` names `cursor`.
4. **Legacy read-only analytics** (`test/cli.test.ts`): install
   `analytics-journal-format2.jsonl` and a format-2 `start.json`;
   `coord analytics` exits 0, prints the Time/Phase sections, prints the
   provenance line naming format 2 and the skipped record, and omits token/tool
   sections. Same fixture: `coord run --issue …` exits non-zero with
   `Runtime format versions 2 and 3 are no longer supported`. A `state.test.ts`
   case pins that `readStartState`/`readJournal` still throw on the same bytes.
5. **Paused vs unpaused** (`test/analytics.test.ts`): a run with one
   `paused`/`resumed` pair and one unterminated `paused` ⇒ `run.pausedMs` is the
   merged total, `unpausedMs === durationMs - pausedMs`, and the rendered `Run:`
   line shows all three. A run with no pause events ⇒ `pausedMs === 0`,
   `unpausedMs === durationMs`.
6. **Stall-aware wait timing** (`test/analytics.test.ts`): `nudged` at t0,
   `nudged` again at t0+1h, `intent-seen` at t0+1h5m ⇒ one wait of 65 minutes,
   not 5. The existing retry test (`test/analytics.test.ts:205`) — nudge,
   intent, nudge, intent — must keep reporting two waits, which pins that a
   nudge after a pairing still opens a new interval.
7. **Final-check duration** (`test/runLoop.test.ts`): an advancing injected
   `now` around a failing check ⇒ the journaled `final-check` details carry the
   exact `durationMs`. `test/analytics.test.ts` asserts the rendered
   `Final checks` section shows that duration, and shows `unavailable` (not
   `0`) for a legacy record without the field.

## Alternatives Rejected

- **Scrape Cursor's `store.db` for tokens.** Explicitly out of scope in the
  issue, and unnecessary: the hooks already deliver the numbers and the
  coordinator already journals them. The defect is a read-side field-name
  mismatch.
- **Change what `agentEvent.ts` journals for Cursor** (write raw vendor payloads
  instead of normalized tokens). It would fix new runs and orphan every existing
  journal. Fixing the reader repairs history and future runs with one function.
- **Attribute ambiguous Codex records by nearest-window distance or by
  splitting them proportionally across matching actions.** Both invent
  precision. Restricting the rule to windows that provably share one vendor turn
  uses identity already in the journal, and the fallback is labelled `partial`.
- **Attribute a shared vendor turn to the earliest-started action.** Records
  emitted before the second prompt already match exactly one window, so the
  ambiguous set is precisely "after the second prompt was submitted"; giving
  those to the later action is the better-supported guess.
- **Loosen the cross-roster total** (emit it with `partial` agents, or exclude
  incomplete agents from the sum). The issue names the current policy as
  correct; a partial sum labelled "total" is exactly the misleading headline
  this issue exists to remove. Explaining the block with `tokenTotalReason` is
  the honest fix.
- **Migrate legacy runtime state to format 4** (a converter, or relaxing
  `assertRuntimeFormat` globally). Prohibited by the issue's non-goals and by
  the fail-closed rule from #109. A separate lenient reader used only by
  `analytics` keeps the control plane unchanged.
- **Reuse `readStartState` for `analytics` with a try/catch fallback.** The
  throw happens in `matchesConfig`/`withStoredMailbox` during path resolution,
  before the command branch; catching it there would silently weaken every
  command's resolution. A header reader that never claims to validate the
  control plane is narrower.
- **Subtract pause time from each phase as well as the run.** More surface for
  no new decision: pauses are owner actions, and the run-level split answers
  "was this wall time productive". Phase rows keep meaning elapsed, stated in
  the report and in `docs/analytics.md`.
- **Cumulative idle-gap wait metric** (sum of all unanswered nudge gaps). It
  changes `WaitAnalytics` semantics for every historical comparison. First
  outstanding nudge → `intent-seen` restores stall visibility while keeping the
  metric comparable to the issue-76/121 tables.
- **The optional stretch items** (`analytics-summary.json`, back-filling
  `actionId`/phase onto usage rows). The snapshot needs a write path, a
  location, and a wipe policy in a read-only command, and the back-fill is
  unnecessary once the shared-turn join lands. Both are deferred; neither is a
  precondition for any acceptance item.
- **Adding `durationMs` to `verify-result` and `gate-advanced`** (§3.3 of the
  doc). The issue restricts the duration work to `final-check`; both others are
  already recoverable by pairing events.

## Risks and Mitigations

- **Legacy readers become a second, weaker parse path.** Mitigation: the lenient
  readers live in `state.ts` next to the strict ones, are used only by
  `analytics` and by path resolution, never write, and the fail-closed test in
  §Tests 4 asserts `run` still refuses the same bytes.
- **Skipping unparsable legacy journal lines could hide data loss.**
  Mitigation: the count is returned, carried into
  `AnalyticsReport.source.skippedJournalRecords`, and rendered. A skipped record
  is visible, not swallowed.
- **The shared-turn fallback could over-attribute** when the two actions belong
  to different phases (which is what issue 121 shows: no matching pair shared a
  phase). Mitigation: it never claims `exact`, it forces `partial` coverage with
  a named reason, and it never unlocks a cross-roster total on its own.
- **Changing Cursor's empty-token label from `unsupported` to `unavailable`
  moves a documented coverage value.** Mitigation: `docs/analytics.md` §5 is
  updated in the same commit, and `unavailable` still yields `null` tokens, so
  no number changes — only the explanation.
- **Fixing the Cursor round trip changes real reports** (Cursor stops being
  invisible, and a complete roster can now emit a cross-roster total that was
  previously suppressed). That is the intended unlock; the total remains gated
  on complete coverage with zero unassigned records.
- **Wait medians shift for runs with retried nudges**, so before/after tables
  built on the old rule are not comparable. Mitigation: the rule is stated in
  `docs/analytics.md` §2.3/§5, and the change only ever makes a wait longer,
  never shorter.
- **`durationMs` from an injected wall clock can be non-monotonic.**
  Mitigation: a negative or unparsable delta is journaled as `null`, and the
  report prints `unavailable`.
- **`pnpm check:fast` is the gate here, `pnpm check` is the coordinator's.**
  Mitigation: no change touches the Vite build or e2e fixtures; `pnpm check`
  will be run before the finalization commit if the coordinator requests it.

## Conclusion

Seven gaps, five files of production code, no new subsystem. Two of the seven
are defects with measured causes — a Cursor token round trip that drops the
fields it just normalized, and a Codex ambiguity rule that discards 79 of 308
token records because one vendor turn served two coordinator actions — and
fixing those two is what actually makes cross-roster totals reachable. The other
five are a one-line pairing rule, a merged-interval subtraction, one journal
field, one coverage label, and a lenient read-only reader that leaves the
control plane failing closed exactly as #109 requires. Each gap has a focused
test, the report keeps `complete`/`partial`/`unsupported`/`unavailable` with
`null` for absent data, and `pnpm check:fast` is the gate.
