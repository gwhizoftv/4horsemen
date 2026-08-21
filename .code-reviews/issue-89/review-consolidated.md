# Issue 89 Phase 1 — consolidated code review

- Compiled by: Claude
- Sources (verbatim consolidation; no new review performed):
  - Codex — `origin/issue-89/codex:.code-reviews/issue-89/review-codex.md`
  - Claude — `origin/issue-89/claude:.code-reviews/issue-89/review-codex.md`
  - Cursor — `origin/issue-89/cursor:.code-reviews/issue-89/review-cursor.md`
- Contract: selected Claude plan @ `99b4e7c`
- Baseline: `origin/main` @ `1bfc7f9`

**Two implementations are under review, not one.** Codex's and Claude's reviews
both examine the **Codex implementation** at `origin/issue-89/codex` @ `025bbd5`.
Cursor's review examines the **Cursor implementation** at `origin/issue-89/cursor`
@ `46e765f`. Both implement the same accepted plan, so most defects recur in
both, but line references differ per implementation. Each finding below records
its reporters and the implementation(s) in which it was observed.

19 distinct issues after de-duplication, from 25 reported findings.

## Findings

### 1. [P1] Codex `token_count` records carry no `turn_id`, so the exact token join never fires

**Reported by:** Codex, Claude, Cursor. **Observed in:** both implementations.
**Path:** codex impl `src/transcriptRead.ts:303-310`; cursor impl
`src/transcriptRead.ts:251-269`.

**Rule.** Codex token rows must join using fields the supported local store
actually emits; otherwise coverage must fail closed rather than presenting the
fixture-only path as exact.

**Failure.** Current CLI rollouts put `turn_id` on `task_started` and
`item_completed`, but never on `token_count` — measured 0 of 19,616 records
across 180 sessions, whose keys are exactly `info`, `rate_limits`, `type`. The
exact join therefore never fires; every token row falls to the temporal fallback
or to `unattributed`, completed turns are at best `partial`, and an
active/missing-stop turn is wholly unassigned. Both fixtures plant a `turn_id` on
`token_count` that the real format does not emit, so neither suite can expose it.

**Test.** Use a sanitized rollout with `task_started.turn_id` followed by
`token_count` records containing only `info`/`rate_limits`/`type`; require
non-zero phase tokens with an honest coverage state, or an explicit `unavailable`
naming the missing field.

### 2. [P1] Unrecognized `item_completed` variants null out independently valid tokens

**Reported by:** Codex, Claude. **Observed in:** codex impl.
**Path:** `src/transcriptRead.ts:255-266`, `:330-333`; rolled up at
`src/analytics.ts:107-110`, gated at `:408`.

**Rule.** Ordinary supported item variants must be classified as tool/non-tool,
or degrade only the metric whose schema is unknown. A tool classifier must not
erase independently parsed tokens.

**Failure.** Real rollouts emit `item.type: "Extension"` for tool calls such as
`kind: "web.search"`, plus control items `EnteredReviewMode` / `ExitedReviewMode`.
None appear in `codexToolTypes` (9 entries) or `codexNonToolTypes` (4), so all
hit the unknown branch, set the whole transcript `unsupported`, and cause
analytics to replace every valid token and tool phase with `null` — including the
cross-roster total. Measured: `Extension` ×65, `EnteredReviewMode` ×3,
`ExitedReviewMode` ×2, poisoning 5 of 171 rollouts; in a separate 12-session
sample, 2 of 12 contained `Extension` (47 records).

**Test.** Add one `Extension` tool row and one review-mode control row beside a
valid `token_count`; require the tool to count, the control not to count, and
token coverage to survive.

### 3. [P1] A single malformed record marks the entire transcript unsupported

**Reported by:** Cursor, Codex. **Observed in:** both implementations.
**Path:** cursor impl `src/transcriptRead.ts:251-306`; codex impl
`src/transcriptRead.ts:303` (the `ordinal` variant).

**Rule.** An unrecognized optional usage shape must mark that record unsupported
or skip it; successfully parsed tool/token rows must still surface under
`partial` coverage.

**Failure.** Any `token_count` missing `info.last_token_usage` sets a file-level
`unsupported` flag, and analytics then drops all token and tool data for that
agent. Codex reports the same file-level failure from a different trigger:
current Codex App rollouts omit `ordinal`, which marks an otherwise valid token
stream `unsupported`.

**Test.** Codex fixture with one empty `token_count` plus valid `item_completed`
and one good `token_count`; assert tools/tokens from the good lines remain and
coverage is `partial`, not wholesale `unsupported`.

### 4. [P1] Cross-roster total omits `unassigned`, printing a confident total over discarded tokens

**Reported by:** Codex, Claude, Cursor. **Observed in:** both implementations.
**Path:** codex impl `src/analytics.ts:408-417`; cursor impl
`src/analytics.ts:405-435`. Contract: `docs/analytics.md:433-449`.

**Rule.** A cross-roster total may print only when it accounts for every measured
token, or must clearly refuse the total.

**Failure.** The reduction sums only phase buckets and ignores
`agent.unassigned`, while unassigned rows do not lower agent coverage. The
branch's own fixture records 13 unassigned Claude input tokens and 10 unassigned
Codex input tokens, yet `test/analytics.test.ts` asserts a confident
`tokenTotal.input === 23` — the report presents 23 while 46 input tokens were
measured.

**Test.** Retain that fixture and require `tokenTotal === null` whenever any
active agent has non-empty unassigned usage, or include that usage in a
separately labelled total.

### 5. [P1] A zero-match record does not degrade coverage

**Reported by:** Claude. **Observed in:** codex impl.
**Path:** `src/analytics.ts:384`.

**Rule.** Discarding a measured record must lower coverage.

**Failure.** `assign(..., matching.length === 1)` passes `fallback: false` when
**zero** windows match, so `fallbackUsed` stays false and coverage remains
`complete` while the tokens go to `unassigned` — excluded from both the phase
breakdown and `tokenTotal`. Combined with findings 1 and 9, a codex agent can
report `coverage=complete`, every phase reading `input=0`, and a cross-roster
total omitting 100% of codex spend.

**Fix.** Treat a zero-match as `partial`, distinctly from the one-match exact case.

### 6. [P1] Missing tokens are reported as zero rather than `null`

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `src/analytics.ts:254-266` (`sumRows`), `:410-420`. Contract:
`docs/analytics.md` Coverage.

**Rule.** Missing metrics report `null`, never `0`.

**Failure.** When assigned rows have tools but no usage objects, `sumRows`
returns a zero-filled `TokenComponents`; the agent row stores that object and
`allComplete` treats the agent as token-covered.

**Test.** Assigned tool-only rows with no `tokens`; assert
`agentUsage[].tokens === null` and `crossRosterTotals === null`.

### 7. [P1] Identity coverage is not required for every attempted action

**Reported by:** Codex. **Observed in:** codex impl.
**Path:** `src/analytics.ts:312-316`.

**Rule.** An agent may be `complete` only when every attempted issue action
either has a journaled session/turn binding or is explicitly reported incomplete.

**Failure.** `hasSessionIdentity` checks only whether *any* agent action has
identity, and each agent later reads sessions derived only from successful
bindings. If one of several prompt hooks omits identity — especially after a
restart — that action and possibly its entire session disappears while the agent
still reports `complete` and a low total from its other actions.

**Test.** Give one agent two nudged actions but identity for only one; require
`partial`/`unavailable` coverage rather than complete zeroes for the missing
action's phase.

### 8. [P1] Lifecycle identity is journaled only when `result.changed`

**Reported by:** Claude. **Observed in:** codex impl; also a defect in the
accepted plan, which specified the projection inside that branch.
**Path:** `src/agentEvent.ts:290`.

**Rule.** Identity the report joins on must be journaled whenever it exists, not
only when it coincides with a lifecycle state transition.

**Failure.** Measured on the real issue-76 journal:

| agent | `action-prepared` | `prompt-submitted` | `stopped` |
| --- | ---: | ---: | ---: |
| claude | 10 | 6 | 6 |
| codex | 11 | 12 | 5 |
| antigravity | 8 | **0** | 16 |

A turn with no `prompt-submitted` row is never created by `deriveActionTurns`, so
its tokens go to `unassigned`; a turn with no `stopped` row leaves
`endedMs === null`, making the documented window fallback
(`src/analytics.ts:378`) unusable for 6 of 11 codex turns. Antigravity has no
usable window at all.

**Fix.** Journal `sessionId` / `turnId` unconditionally for `prompt-submitted`
and `stopped`, independent of the state-transition gate.

### 9. [P1] No `gate-advanced` yet: R1 interval is never emitted and a zero total is fabricated

**Reported by:** Codex, Claude. **Observed in:** codex impl.
**Path:** `src/analytics.ts:140`, `:159-162`. Contract:
`docs/analytics.md:395-398`.

**Rule.** Every unfinished final interval must be represented as `in-progress`,
including the initial `R1.join` interval before any `gate-advanced` event.
Absence of data must not render as a measured zero.

**Failure.** With no gates, `finalGate` and `activeName` are null, so `phases` is
empty; `phaseIndexAt` returns `null` for every record, all usage becomes
`unassigned`, and `tokenTotal` reduces over zero phases to `emptyTokens()` while
`agents.every(complete)` still holds. The report prints
`Cross-roster token total: input=0 output=0 …` and `Phase count 0` for a live run
that has already spent tokens. `coord analytics --issue N` during R1 hits this on
every run.

**Test.** Build a started journal with an R1 action/turn but no gate; require one
in-progress `R1.join` phase with its usage, not an empty phase list and zero
total.

### 10. [P1] Mid-run journals report `runStatus: complete`

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `src/analytics.ts:108-152` (`buildPhases`), `:285-292`.

**Rule.** A run is complete only when the terminal `gate-advanced` has
`details.to === null` — the same completion signal as `runLoop`; otherwise status
is `in-progress` and wall-clock must not present a finished total.

**Failure.** `buildPhases` only emits closed intervals from each gate's
`details.from`, so after advancing into an active phase every listed interval has
`endedAt` set; `buildAnalyticsReport` then sets `runStatus` to `complete` and sums
a truncated `runDurationMs`.

**Test.** Journal ending with `gate-advanced` `{ from: "R2.plan", to: "R3.review" }`;
assert `runStatus === "in-progress"` and `runDurationMs === null`.

### 11. [P1] Token and tool counts are not reported per phase

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `src/analytics.ts:200-214` (binds `phaseName`), `:410-420` (sums only
per agent).

**Rule.** Phase 1 "accurate" token/tool counts are per phase per agent.

**Failure.** `phaseName` is computed on each action binding and never used when
summing transcript rows; the rendered report has only agent-level totals, so
implement-versus-review spend cannot be compared — which is the comparison Phase 2
exists to make.

**Test.** Fixture journal with one Claude action in `R2.plan` and one in
`R3.review`, joined transcript with distinct turn ids; assert separate non-zero
token/tool rows per phase, not a single agent sum.

### 12. [P1] One `sessionId` per agent drops later sessions

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `src/analytics.ts:311-354`.

**Rule.** Each journaled session must be located and joined independently; an
agent that restarts mid-issue gets a new vendor session.

**Failure.** The join takes the first non-null binding/lifecycle `sessionId` and
reads a single transcript; later actions on a different session are attributed
against the wrong file or left unassigned.

**Test.** Two `agent-lifecycle` sessions for `claude` with different `sessionId`
values and two fixture files; require both sessions' assigned tokens to appear.

### 13. [P2] Retry waits are not paired with their own nudge

**Reported by:** Codex, Claude. **Observed in:** codex impl.
**Path:** `src/analytics.ts:232-246`, `:238`.

**Rule.** Each latency sample must span one delivery attempt, or an action-level
metric must emit only one final sample.

**Failure.** `firstNudge` is never consumed; when verification rejects an intent
and the coordinator re-nudges the same `(agent, actionId)`, the second
`intent-seen` is measured from the original nudge while the first sample is also
retained. Issue 76 contains this exact pattern for codex
(`ebb15626-5904-4341-96ee-80488076828b`) and antigravity
(`9833c8e7-e533-4abb-a20c-f05bbf413755`), so count and median/max include
overlapping waits and overstate the retry.

**Test.** `nudged(0) → intent(10) → nudged(20) → intent(25)` should produce
attempt waits 10 and 5, or one documented 25 — not 10 and 25.

### 14. [P2] An R6 phase takes its round from the exit gate

**Reported by:** Codex. **Observed in:** codex impl.
**Path:** `src/analytics.ts:147-153`.

**Rule.** Revision phases must retain the round in which the interval ran.

**Failure.** Completed phases take `round` from the gate that exits the phase. In
a two-round run the gate `R6.declare → R6.revise` carries round 2, so the round-1
declare interval is labelled round 2; the final `R6.declare → R7.finalize`
carries `null`, so the last declare loses its round entirely.

**Test.** Close two R6 cycles and assert the three intervals in each cycle remain
labelled rounds 1 and 2 respectively.

### 15. [P2] Usage labels omit the revision round

**Reported by:** Codex. **Observed in:** codex impl.
**Path:** `src/analytics.ts:473-475`.

**Rule.** Per-phase token/tool output must distinguish repeated revision-round
intervals just as the time section does.

**Failure.** `PhaseUsageAnalytics` carries `round`, but both usage render loops
print only `phase.phase`; a multi-round report emits multiple indistinguishable
`R6.revise`, `R6.ballot` and `R6.declare` rows, so the reader cannot tell which
round consumed the tokens/tools.

**Test.** Render two R6 rounds and require `round 1` / `round 2` in both token and
tool rows.

### 16. [P2] Coverage stays `complete` when unassigned usage exists

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `src/analytics.ts:405-435`.

**Rule.** Cross-roster totals require every active agent to have `complete`
coverage; incomplete attribution must not look fully joined.

**Failure.** Unmatched turn-keyed rows only fill `unassigned*`; coverage remains
`complete` and `crossRosterTotals` still prints, so a report can claim complete
roster totals while dropping transcript spend into unassigned.

**Test.** Fixture with one orphan Claude assistant turn; assert coverage is
`partial`, or cross-roster is null, when `unassignedTokens` is non-null.

### 17. [P2] The issue-76 oracle test hard-codes a machine-local path

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `test/analytics.test.ts:124-131`.

**Rule.** Acceptance tests must run — or cleanly skip — on any clone that has the
preserved journal, without assuming one absolute volume path.

**Failure.** `/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/journal.jsonl`
fails on other machines and in CI even when a journal exists elsewhere.

**Fix.** Resolve via `COORD_RUNTIME` / `coord-root`, or `skipIf(!existsSync(...))`
with a documented env override.

### 18. [P2] Documented acceptance (a) includes wait tables the tests do not assert

**Reported by:** Cursor. **Observed in:** cursor impl.
**Path:** `docs/analytics.md:83-94` versus `test/analytics.test.ts:124-152`.

**Rule.** Documented acceptance oracles must be covered by an automated check or
marked manual.

**Failure.** Phase minutes are asserted; the §2.3 wait table (median/max/total) is
not, so a wait regression can ship while the oracle still "passes."

**Test.** Against the same issue-76 journal, assert cursor/claude/codex/
antigravity wait medians within the documented tolerance.

### 19. [P2] Fixtures do not exercise the live Codex token shape

**Reported by:** Cursor, Claude. **Observed in:** both implementations.
**Path:** `test/support/fixtures/transcript-codex.jsonl`.

**Rule.** Fixtures that gate the join must include the failure mode they claim to
support.

**Failure.** The Codex fixture puts `turn_id` on `token_count`, so tests never
catch the live missing-`turn_id` case in finding 1, nor the unclassified item
types in finding 2. Both suites pass green over code paths that cannot execute in
production.

**Test.** Add a second Codex fixture, or line set, without `turn_id` on
`token_count`, and lock the intended inheritance/coverage behaviour.

## Verdict

**Changes required**, on both implementations. Twelve findings are P1.

All three reviewers reached the same verdict independently. The journal-only
issue-76 phase oracle reproduces and the focused suites pass, but the Codex
token/tool path does not support the live store shapes used by ordinary
sessions, and the coverage and in-progress defects can publish confident totals
over omitted usage. Phase 1 numbers are therefore not yet safe inputs to Phase 2
decisions.

Findings 1, 2, 3 and 19 form one cluster: both implementations were validated
against fixtures that invent fields the vendor format does not emit and omit item
types ordinary sessions contain. Findings 4, 5, 6, 9, 10 and 16 form a second:
the report prints `complete` coverage, or a confident total, over data it
silently discarded — the precise failure mode the plan's `null`-never-`0` rule
and gated roster total were written to prevent.

Validation reported by the source reviews, carried over unchanged:

- Codex — focused suite 50 passed; `analytics --issue 76` reproduced the
  phase/time oracle; live Claude and Codex transcript probes reproduced findings
  1 and 2.
- Claude — findings re-verified against the live vendor stores and the real
  issue-76 journal.
- Cursor — phase and wait reporting sound on the issue-76 oracle for closed
  intervals; version bump consistent at `0.0.13`. Non-findings checked: journal
  schema parses, CLI wiring passes `start` through, docs deferred list matches
  shipped non-goals.
