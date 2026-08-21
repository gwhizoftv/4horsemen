# Code review: Cursor implementation for issue 89 Phase 1

- Reviewed head: `origin/issue-89/cursor` @ `46e765f314bb1828149dc465b0dcf9ba6a62035d`
- Implements Claude plan tip `99b4e7c` (not Cursor’s own `.plans/issue-89/plan.md`)
- Baseline: `origin/main` @ `1bfc7f9e9a094e8611bb3b85f70714a5c870d602`
- Scope: Phase 1 analytics — journal `sessionId`/`turnId`, `src/transcriptRead.ts`,
  `src/analytics.ts`, `coord analytics --issue`, fixtures, `docs/analytics.md`,
  version `0.0.12` → `0.0.13`
- Reviewer: Cursor, with [Bugbot](2c710c70-5141-48e0-8ccc-51b0827de684) findings merged in

## Verdict

**Changes required before treating Phase 1 analytics as accurate.** Phase and wait
reporting look sound on the issue-76 oracle for closed intervals, and the
`0.0.13` bump is consistent. Do not trust run completion status, per-agent token
nullability, multi-session joins, per-phase spend, or Codex coverage under live
transcript shapes until the findings below are fixed.

## Findings

### [P1] Mid-run journals report `runStatus: complete`

**Path:** `src/analytics.ts:108-152` (`buildPhases`) and `src/analytics.ts:285-292`.
**Rule:** A run is complete only when the terminal `gate-advanced` has
`details.to === null` (same completion signal as `runLoop`); otherwise status is
`in-progress` and wall-clock must not present a finished total. **Failure:**
`buildPhases` only emits closed intervals from each gate’s `details.from`, so
after advancing into an active phase every listed interval has `endedAt` set;
`buildAnalyticsReport` then sets `runStatus` to `complete` and sums a truncated
`runDurationMs`. **Test:** journal ending with `gate-advanced` `{ from: "R2.plan",
to: "R3.review" }`; assert `runStatus === "in-progress"` and
`runDurationMs === null`.

### [P1] Token and tool counts are not reported per phase

**Path:** `src/analytics.ts:200-214` (binds `phaseName`) and `src/analytics.ts:410-420`
(sums only per agent). **Rule:** Phase 1 “accurate” token/tool counts are **per
phase per agent** (Claude plan Exact file list / Tests; Cursor plan table rows for
token and tool count). **Failure:** `phaseName` is computed on each action binding
and never used when summing transcript rows; the rendered report has only
agent-level totals, so implement vs review spend cannot be compared. **Test:**
fixture journal with one Claude action in `R2.plan` and one in `R3.review`, joined
transcript with distinct turn ids; assert separate non-zero token/tool rows per
phase, not a single agent sum.

### [P1] One `sessionId` per agent drops later sessions

**Path:** `src/analytics.ts:311-354`. **Rule:** Each journaled session must be
located and joined independently; an agent that restarts mid-issue gets a new
vendor session. **Failure:** The join takes the first non-null binding/lifecycle
`sessionId` and reads a single transcript; later actions on a different session
are attributed against the wrong file or left unassigned. **Test:** two
`agent-lifecycle` sessions for `claude` with different `sessionId` values and two
fixture files; require both sessions’ assigned tokens to appear in the report.

### [P1] Live Codex `token_count` rows lack `turn_id`; parser does not inherit it

**Path:** `src/transcriptRead.ts:251-269`. **Rule:** Codex tokens come from
`last_token_usage` on `token_count` and must join by turn identity when the
payload omits `turn_id` (common in current `~/.codex` stores). **Failure:** The
parser sets `turnId` only from `payload.turn_id`; live samples often have none, so
every token row is unassigned unless temporal fallback applies, and Phase 1
Codex token accuracy collapses outside the fixture (which plants `turn_id` on
`token_count`). **Test:** fixture `token_count` without `turn_id` between
`task_started` / `item_completed` lines that carry the same turn; assert tokens
join that turn (stream inheritance) or coverage is explicitly `unavailable` with
a reason that names the missing field — not a silent `complete` agent sum of
tools only.

### [P1] Missing tokens are reported as zero, not `null`

**Path:** `src/analytics.ts:254-266` (`sumRows`) and `src/analytics.ts:410-420`.
**Rule:** Missing metrics report `null`, never `0` (`docs/analytics.md`
Coverage). **Failure:** When assigned rows have tools but no usage objects,
`sumRows` returns a zero-filled `TokenComponents`; the agent row stores that
object and `allComplete` treats the agent as token-covered. **Test:** assigned
tool-only rows, no `tokens`; assert `agentUsage[].tokens === null` and
`crossRosterTotals === null`.

### [P1] One bad Codex `token_count` poisons the whole transcript

**Path:** `src/transcriptRead.ts:251-306`. **Rule:** An unrecognized optional
usage shape must mark that record unsupported or skip it; successfully parsed
tool/token rows must still surface under `partial` coverage. **Failure:** Any
`token_count` missing `info.last_token_usage` sets a file-level `unsupported`
flag, and analytics then drops all token and tool data for that agent.
**Test:** Codex fixture with one empty `token_count` plus valid `item_completed`
and one good `token_count`; assert tools/tokens from the good lines remain and
coverage is `partial` (or per-record skip), not wholesale `unsupported`.

### [P2] Coverage stays `complete` when unassigned usage exists

**Path:** `src/analytics.ts:405-435`. **Rule:** Cross-roster totals require every
active agent to have `complete` coverage; incomplete attribution must not look
fully joined. **Failure:** Unmatched turn-keyed rows only fill `unassigned*`;
coverage remains `complete` and `crossRosterTotals` still prints, so a report can
claim complete roster totals while dropping transcript spend into unassigned.
**Test:** fixture with one orphan Claude assistant turn; assert coverage is
`partial` (or cross-roster is null) when `unassignedTokens` is non-null.

### [P2] Issue-76 oracle test hard-codes a machine-local path

**Path:** `test/analytics.test.ts:124-131`. **Rule:** Acceptance tests must run
(or cleanly skip) on any clone that has the preserved journal, without assuming
one absolute volume path. **Failure:** The path
`/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-76/journal.jsonl` fails on
other machines/CI even when a journal exists elsewhere. **Fix sketch:** resolve
via `COORD_RUNTIME` / `coord-root` or `skipIf(!existsSync(...))` with a documented
env override.

### [P2] Docs acceptance (a) includes wait tables; tests only assert phases

**Path:** `docs/analytics.md:83-94` vs `test/analytics.test.ts:124-152`. **Rule:**
Documented acceptance oracles must be covered by an automated check or marked
manual. **Failure:** Phase minutes are asserted; the §2.3 wait table (median/max/
total) is not, so a wait-regression can ship while the oracle still “passes.”
**Test:** against the same issue-76 journal, assert cursor/claude/codex/
antigravity wait medians within the documented tolerance.

### [P2] Fixtures do not exercise the live Codex token shape

**Path:** `test/support/fixtures/transcript-codex.jsonl`. **Rule:** Fixtures that
gate the join must include the failure mode they claim to support. **Failure:**
The Codex fixture puts `turn_id` on `token_count`, so tests never catch the live
missing-`turn_id` case above. **Test:** add a second Codex fixture (or line set)
without `turn_id` on `token_count` and lock the intended inheritance/coverage
behavior.

## Non-findings (checked)

- **Version bump:** `package.json`, `config.product.example.json`,
  `test/cli.test.ts`, and `test/install.test.ts` all pin `0.0.13` (> `origin/main`
  `0.0.12`).
- **Journal schema:** Fixture `analytics-journal.jsonl` parses through
  `journalEventSchema` in the join test.
- **CLI wiring:** `coord analytics` passes `start` into `buildAnalyticsReport` so
  Claude clone-path slug resolution can run in production.
- **Docs deferred list:** Matches shipped non-goals (`--json`, debounce,
  `preparedAt`, Phase 2 workflow work).
