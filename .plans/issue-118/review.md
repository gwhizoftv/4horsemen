# Issue 118 plan review — claude

Plans reviewed, as bound by the action:

- cursor `25a7ff8bc81c90389f203c95579dddcf3a2b5387` at `.plans/issue-118/plan.md`
- codex `492f35f7e088821f91ba27893ce702c35bb7339f` at `.plans/issue-118/plan.md`
- claude `2dcc50606a58b412c4b6f527e39f578defb39456` at `.plans/issue-118/plan.md`

Measurements below come from the completed issue-121 run: journal
`/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime/issue-121/journal.jsonl` and
Codex transcript
`~/.codex/sessions/2026/08/26/rollout-2026-08-26T15-14-50-01a04023-e91d-7a21-8c55-3a4c0de675cf.jsonl`.
Schema history comes from `git show 51caf7f:src/state.ts` (the commit where
`RUNTIME_FORMAT_VERSION = 2`).

## Findings

### 1. codex `492f35f` — inheriting the Codex task turn id without resolving one turn to many actions folds 240 of 308 token records into the wrong phase, labelled `exact`

**Claim.** `src/transcriptRead.ts`: "use existing `task_started.turn_id` /
`task_complete.turn_id` boundaries as the enclosing turn identity for
`token_count` rows that omit `turn_id`."

**Rule.** A record may only be labelled exactly attributed when its identity
resolves to exactly one coordinator action. The issue requires explicit
`unassigned` "rather than silent folding", and `docs/analytics.md` §5 requires
that anything other than an exact turn key be a "labelled `partial` fallback".

**Failure.** The inheritance works — all 308 `token_count` records in the
issue-121 session fall inside a `task_started` → `task_complete` span, and every
enclosing `turn_id` matches a journaled lifecycle `turnId`. That is exactly what
makes the omission dangerous. Codex reuses one `turn_id` when a second prompt is
submitted while a turn is still running, so one vendor turn maps to two
coordinator actions: turn `…0c35ae` serves actions `aa11675c` (prompt
`22:14:52`) and `fc856554` (prompt `22:16:03`); the same holds for `…b9e43c`,
`…7145d4`, `…8d8b92`, `…3f1498`. Those five turns carry
44+81+17+57+41 = **240 of 308 token records**. Once such a record has a
`turnId`, `aggregateSamples` puts it in `result.turns`, and
`src/analytics.ts:592-596` resolves it with
`agentTurns.find((turn) => turn.sessionId === … && turn.turnId === turnUsage.turnId)`
— `find` returns the **first** matching action and discards the second. The
call at `src/analytics.ts:597` then passes `exact = phaseIndex !== null`, so
coverage stays `complete`. Measured on issue 121, none of those action pairs
share a phase (0 of 5), so 78% of Codex's token volume moves from an honest
`unassigned` bucket into a *confidently wrong* phase row, and the cross-roster
total can now be emitted from it.

**Smallest correction.** Before assigning a turn-keyed record, count the
`agentTurns` matching that `sessionId`/`turnId`. One match keeps `exact`; more
than one must not use `find` — pick a documented tie-break, pass `exact = false`
so coverage drops to `partial`, and record a reason naming the shared turn.

### 2. cursor `25a7ff8` — the three Codex attribution steps recover zero records, and step (b) cannot be implemented where the plan puts it

**Claim.** `src/transcriptRead.ts`: "(a) honor `turn_id` on `token_count` when
present; (b) join through coordinator `prompt-submitted` → `stopped` windows
keyed by journaled `sessionId`/`turnId`; (c) keep timestamp-window fallback
labelled `partial`."

**Rule.** A plan step must change behavior that is not already implemented, and
must be implementable in the module it names. `readTranscript`'s input is
`{vendor, sessionId, root}` (`src/transcriptRead.ts:481-487`) — a pure file
reader with no access to the journal.

**Failure.** (a) is already the shipped behavior:
`turnId: string(payload.turn_id) ?? string(record.turn_id)` at
`src/transcriptRead.ts:355`. Measured on the issue-121 session, **0 of 308**
`token_count` records carry `turn_id` in either position, so (a) moves nothing.
(b) is also already shipped — the coordinator-window join lives in
`src/analytics.ts:598-614` — and cannot be moved into `transcriptRead.ts`
without passing the journal or the derived `ActionTurn` list into a reader that
has neither, producing two attribution paths that can disagree. (c) preserves
today's behavior. Following the plan as written, unassigned Codex volume drops
by **0** records and the acceptance item "Codex unassigned volume drops on a
representative fixture" fails, while the plan's own
`test/transcriptRead.test.ts` case ("improved join assigns a previously
unassigned `token_count` record") cannot be written against a reader that never
sees a coordinator window.

**Smallest correction.** Keep the window join in `buildAnalytics`. Limit
`transcriptRead.ts` to identity available *inside* the transcript — the
`task_started`/`task_complete` `turn_id` span that codex `492f35f` correctly
identified — and handle the one-turn/many-actions case per finding 1.

### 3. cursor `25a7ff8` and codex `492f35f` — both leave the defect that actually silences Cursor tokens, and both would ship a green test over it

**Claim.** cursor: "Parse with existing `extractCursorTokenUsage`; aggregate
with `readCursorHookUsage`." codex: "Current Cursor hook installation and
normalization already capture supplied token fields"; the only
`src/cursorHookUsage.ts` change is relabelling `unsupported` → `unavailable`.

**Rule.** What the hook writes must be readable by the reader that consumes it.
`src/agentEvent.ts:246-252` journals *normalized* tokens —
`{input, output, cacheRead, cacheWrite, reasoning}` — while
`extractCursorTokenUsage` (`src/cursorHookUsage.ts:45-83`) only recognizes
vendor aliases (`input_tokens`, `inputTokens`, `prompt_tokens`,
`cache_read_tokens`, …).

**Failure.** `cursorUsageFromJournalDetails` (`src/cursorHookUsage.ts:106`)
re-parses the already-normalized object with `extractCursorTokenUsage`, gets
`null`, and drops `tokens`; `readCursorHookUsage` then sees
`tokenRecords === 0`. Executing the two functions back to back confirms it:
input `{conversation_id, generation_id, inputTokens: 40, outputTokens: 8,
cacheReadTokens: 12}` journals as
`{"tokens":{"input":40,"output":8,"cacheRead":12,"cacheWrite":0,"reasoning":null}}`
and reads back with no `tokens` key. Issue 121 journaled **391 `agent-usage`
records** and `coord analytics --issue 121` still prints
`cursor: coverage=unsupported (…: Cursor hooks did not journal token fields for
this session)`. Under either plan the label changes to `unavailable` and the
number stays missing, so the acceptance item "Cursor token section appears when
hooks provided tokens" fails, and finding-3 also blocks both plans' cross-roster
total case (item 3 of each Tests section) on any real roster containing Cursor.
The failure survives review because the existing fixture at
`test/analytics.test.ts:386` hand-writes `details.tokens` in **vendor** shape,
which no production hook path ever produces — a new unit test written the same
way passes while production stays broken.

**Smallest correction.** Accept the normalized field names when reading a
journaled row (try a normalized reader before the vendor-alias reader in
`cursorUsageFromJournalDetails`), and write at least one test that feeds a raw
hook payload through `normalizeCursorUsageEvent` and reads back what it
journaled, rather than constructing the journal row by hand.

### 4. cursor `25a7ff8` — a legacy `cursors.json` cannot be parsed by relaxing `formatVersion` alone, so the legacy analytics path throws before it reports

**Claim.** `src/state.ts`: "add `readStartStateForAnalytics` and
`readCursorsStateForAnalytics` with relaxed `formatVersion` literals (2/3/4) for
read-only reporting."

**Rule.** A reader that claims to read a legacy document must parse the fields
that document actually has. `cursorsStateSchema` is `.strict()`
(`src/state.ts:506-561`), so unknown keys are rejected and missing required keys
are errors.

**Failure.** The format-2 `cursorsStateSchema` (`git show 51caf7f:src/state.ts`)
carries `reviser` and `selection`, neither of which exists today, and has none
of today's required `derived`, `evidence`, `acceptedResponses`, or
`ballotBatches`. Relaxing only the `formatVersion` literal therefore still
throws `Invalid …/cursors.json: …` on every real format-2 file, so
`coord analytics` on the legacy fixture exits 2 and the acceptance item "A
fixture format-2 completed journal can be read by analytics" fails. (The
equivalent `start.json` reader does survive a literal relaxation — the format-2
start field set is a subset of today's, with `completesRoot` optional and
`contextPaths` defaulted — so the defect is specific to the cursors reader.)

**Smallest correction.** For legacy input, read only what analytics consumes
through a non-strict projection (`issue`, `originalRoster`, `createdAt`, and the
roster), or skip `cursors.json` entirely for legacy runs and fall back to
`originalRoster`.

### 5. codex `492f35f` — requiring `completed: true` makes analytics fail closed on exactly the historical runs the reader exists to report

**Claim.** `src/state.ts`: "Require `completed: true`, reject mixed/invalid
formats, and never rewrite state."

**Rule.** `docs/analytics.md` §5 states the existing contract: "Historical
journals without `sessionId` remain useful: the command reports phase count,
time, and agent wait, and omits token/tool sections rather than failing."
`buildAnalytics` already models unfinished runs — `run.state` is
`"in-progress"` when no terminal `gate-advanced` exists (`src/analytics.ts:472`).

**Failure.** A legacy run that was abandoned (`abandoned: true`,
`completed: false`) or interrupted still has a complete journal with phase
boundaries, nudges and waits — the baseline data #118 wants for before/after
comparison — and under this plan `coord analytics` refuses it. The gate also
sources a precondition about the *journal* from a *different file*, so a legacy
issue whose `cursors.json` is unreadable for any reason reports nothing even
though the journal alone answers the question. It contradicts both the doc's
"rather than failing" promise and the module's own `in-progress` state.

**Smallest correction.** Drop the `completed` precondition. Read-only is
enforced by never writing and by leaving `readStartState`/`readCursorsState`/
`readJournal` strict — not by refusing to report unfinished history.

### 6. cursor `25a7ff8` — copying `actionId` onto `agent-usage` rows is a no-op, and its test can only pass on a payload Cursor never sends

**Claim.** `src/agentEvent.ts`: "when appending `agent-usage`, copy the current
lifecycle `actionId` onto the journal row when the hook context supplies it
(same source as `agent-lifecycle` rows)"; test: "prove Cursor
`afterAgentResponse` usage rows carry `actionId` when the lifecycle observation
bound one."

**Rule.** A test must be able to fail for the reason it claims to test. The
named source of `actionId` is `extractPromptActionIdentity(prompt)`
(`src/agentEvent.ts:125-131`), which reads the action identity out of the hook
payload's `prompt` field.

**Failure.** Usage-bearing Cursor events carry no prompt.
`normalizeAgentEvent`'s cursor branch (`src/agentEvent.ts:143-168`) returns
`null` for `postToolUse`, `postToolUseFailure` and `afterAgentResponse`, so at
the append site (`src/agentEvent.ts:369-377`) `observation` is `null` and there
is no `actionId` to copy; the `stop` event does produce an observation but also
has no prompt, so its `actionId` is `undefined` too. The change adds a field
that is never populated, and the proposed test can only go green by
constructing an `afterAgentResponse` payload that also contains the action
prompt — a payload the vendor does not emit — certifying behavior that cannot
occur. The issue also lists this under "Optional stretch … Skip these if they
expand scope."

**Smallest correction.** Drop the item, or state the real source (the persisted
lifecycle state's current action in `agent-lifecycle.json`) and test it through
`handleAgentEvent` with a genuine `afterAgentResponse` payload.

### 7. cursor `25a7ff8` — two adjacent report sections would use different pairing rules under identical `nudged ->` labels

**Claim.** `src/analytics.ts`: "change `deriveWaits` … (default: change only
`waits`, leave ballot latency as-is unless a fixture proves it must match)."

**Rule.** Two metrics printed side by side with the same stated endpoints must
be computed the same way, or the labels lie. `renderAnalytics`
(`src/analytics.ts:664-676`) prints
`Agent wait (nudged -> intent-seen)` immediately above
`Agent response latency (nudged -> response-accepted)`, and both are derived
from the same `pendingNudge` map (`src/analytics.ts:236-244`,
`src/analytics.ts:279-287`).

**Failure.** After the change, a ballot action nudged at t0, re-nudged at t0+4h
and answered at t0+4h05m reports a 4h05m wait and a 5m response latency. A
reader comparing the two adjacent lines concludes the ballot round was fast,
when the only difference is which nudge each rule anchored on. The issue's
stated motivation — "a late retry reset the wait clock … hides long stalls" —
applies identically to the response-latency pairing.

**Smallest correction.** Apply first-outstanding-nudge to both derivations, or
rename the response-latency heading to say it measures the last delivery
attempt.

### 8. claude `2dcc506` (this reviewer's own plan) — the shared-turn window tie-break is a weaker join than the exact identity codex found, and its `partial` label permanently blocks the cross-roster total

**Claim.** `## Exact File List to be changed or deleted` item 2: resolve
multi-window matches by "the matching window with the greatest `startedMs` …
always with `exact === false`, so coverage drops to `partial`".

**Rule.** When an exact vendor turn key exists, a timestamp-window heuristic
must not be preferred to it; and the cross-roster total is gated on every active
agent reaching `tokenCoverage === "complete"` (`src/analytics.ts:645-648`), so
any rule that forces `partial` on a normal run makes that total permanently
unreachable.

**Failure.** codex `492f35f` is right that `task_started`/`task_complete` carry
`turn_id`: measured, **308 of 308** issue-121 `token_count` records sit inside
such a span and every span id matches a journaled lifecycle `turnId`. The claude
plan ignores that source and instead recovers 79 records by timestamp windows,
labelling them `partial`. Because one vendor turn serving two actions is the
normal case on this workflow (5 of 11 turns on issue 121), Codex would report
`partial` on essentially every multi-agent run, so `tokenTotal` stays `null`
forever and the issue's goal — "Make Cursor/Codex completeness the real unlock"
— is unreachable by construction, even after the Cursor defect in finding 3 is
fixed.

**Smallest correction.** Take the identity from the transcript task span (codex's
route), and keep the claude plan's honesty rule only where it is still needed:
`exact` when the turn maps to one action, `partial` with a named reason when it
maps to several.

### 9. codex `492f35f` — `turn_aborted` is not named as a task-span boundary, so an aborted turn can leak its id onto later records

**Claim.** `src/transcriptRead.ts`: spans are `task_started` … `task_complete`,
with "Do not infer across mismatched/nested task boundaries."

**Rule.** Every record that ends a turn must close the span, or the span stays
open and subsequent records inherit a stale, now-wrong turn id — which under
this plan is labelled `exact`.

**Failure.** The issue-121 session contains 11 `task_started`, 10
`task_complete` and 1 `turn_aborted` (turn `…054473`, aborted
`2026-08-27T03:30:42.954Z`). With only `task_complete` closing spans, turn
`…054473` stays open until the next `task_started` and any `token_count`
emitted in that interval is attributed to the aborted turn's action. On this run
the gap is 2.8 s and holds no token record, so the fault is latent here; it is
reachable whenever an abort is followed by work before the next task starts, and
the plan's own "mismatched boundary" test cases will not catch it because an
abort is not a mismatch.

**Smallest correction.** Treat `turn_aborted` as a span closer alongside
`task_complete`, and assert it in the transcript fixture.

## Conclusion

The three plans are complementary rather than interchangeable, and the strongest
implementation is not any one of them intact.

- codex `492f35f` found the right Codex identity source. `task_started` /
  `task_complete` `turn_id` covers **308 of 308** measured records, against
  **0 of 308** for the `token_count.turn_id` route cursor `25a7ff8` proposes and
  79 of 81 for the window heuristic claude `2dcc506` proposes. It must not ship
  without finding 1's disambiguation, or 240 of 308 records become confidently
  wrong instead of honestly unassigned.
- All three plans keep `docs/analytics.md` in the same commit, keep the strict
  cross-roster total policy, and keep the control plane fail-closed on legacy
  formats. Those points are settled and need no further debate.
- Findings 3 and 4 are the two that decide whether acceptance is met at all:
  neither peer plan repairs the Cursor journal round trip (so Cursor tokens stay
  invisible and no cross-roster total can appear), and cursor `25a7ff8`'s legacy
  cursors reader cannot parse a real format-2 file (so the legacy acceptance item
  fails at exit 2).
- Findings 5, 6 and 7 remove work that either blocks legitimate reports
  (`completed: true`), adds a field that is never populated (`actionId` on usage
  rows), or ships two differently-computed metrics under matching labels.

Recommendation: proceed on codex `492f35f`'s transcript-identity route with
finding 1's one-turn/many-actions rule and finding 9's abort boundary, take
claude `2dcc506`'s Cursor round-trip repair and its legacy-projection reader
(findings 3 and 4), and drop the items named in findings 5 and 6.
