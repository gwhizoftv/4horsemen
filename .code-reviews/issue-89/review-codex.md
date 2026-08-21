# Issue 89 — code review of Codex's Phase 1 implementation

- Reviewer: Claude
- Under review: `origin/issue-89/codex` at `025bbd5` ("Codex: implement issue 89 analytics")
- Baseline: `origin/main` at `1bfc7f9`
- Reviewed against: `.plans/issue-89/plan.md` (the accepted Phase 1 plan)
- Scope: 18 files, +2953/-8
- Revision: supersedes the first version of this review, which contained an
  error of my own — see Correction below.

## Correction to my earlier review

The first version of this review listed "codex tokens attributed via
`token_count.turn_id`" as **verified correct**, citing 121/121 records. That was
wrong, and the plan I authored carried the same wrong claim.

The measurement behind it pooled key names across payload types
(`'token' in json.dumps(payload)[:200]`), so the `turn_id` I reported belonged to
a different record type. Re-measured precisely across the whole store:

```
sessions scanned      : 180
token_count records   : 19616
  carrying turn_id    : 0
  token_count keys    : ['info', 'rate_limits', 'type']
```

**Zero** codex `token_count` records carry `turn_id`, at payload or record level.
The plan has been corrected and the claim withdrawn. Codex token attribution
cannot use a vendor key at all; per finding 1 it should bracket by the
coordinator's own journaled turn window rather than by codex's `task_started` /
`task_complete` records, which do carry `turn_id` (105/105 and 91/91) but are
vendor-format archaeology. The consequence for this review is finding 1 below,
which I had missed entirely and which is more serious than anything I did find.

## Summary

The implementation is a careful, faithful rendering of the accepted plan, and in
two places better than the plan specified. But it is **not mergeable yet**: on
real vendor data the codex token path cannot execute at all, and three separate
defects let the report print a confident total over silently discarded tokens.

Verified genuinely correct:

| Plan requirement | Implementation |
| --- | --- |
| Codex tokens from `last_token_usage`, never cumulative `total_token_usage` | `src/transcriptRead.ts:282` — correct; the cumulative field appears nowhere |
| Codex tools from `item_completed`, not `custom_tool_call` | `src/transcriptRead.ts:323,344` — correct, and matches real data (5506/5506 carry `turn_id`) |
| `custom_tool_call` never guessed into a turn | `:353-362` — `turnId: null`, used only when `exactToolCount === 0` |
| Claude turn via `parentUuid` walk to `user.promptId` | `:184-193` — correct and cycle-safe via a `visited` set, better than the plan required |
| Cross-roster tool total never reported | `src/analytics.ts:498` — stated explicitly in output |
| Monotonic interval guard | `src/analytics.ts:153-154,172-173` |
| No `runLoop` / `action` / `state` / schema change | diff confirms |

## Findings

Findings 1, 3, 4, 6 and 7 were found by the `code-review` agent run against this
branch; I verified each against the live stores and the real issue-76 journal
before including it. Findings 2 and 5 are mine.

### 1. Codex token attribution can never fire — blocking

**Location.** `src/transcriptRead.ts:310`.

**Rule.** A join key must exist in the data being joined.

**Concrete failure.**
`turnId: string(payload.turn_id) ?? string(record.turn_id)` is always `null` for
codex `token_count` records, because that field does not exist in the format —
0 of 19,616 records across 180 real sessions. Every codex token sample therefore
falls to `unattributed`, and codex token usage never reaches a phase.
`test/support/fixtures/transcript-codex.jsonl` invents a `payload.turn_id` the
real format does not emit, so the suite green-lights a code path that cannot
execute in production. This is the defect my plan's incorrect claim invited.

**Smallest correction.** Bracket `token_count` by the coordinator's own
journaled turn window — `prompt-submitted` → `stopped` for that `actionId` and
`sessionId` — rather than by codex's `task_started` / `task_complete` records.
The owner has confirmed that adding journal fields is acceptable where it makes
analytics more accurate, and a journaled coordinator fact is more durable than an
inferred vendor one: it survives rollout-format changes and covers any future
vendor that reports usage without a turn key. This depends on finding 5 being
fixed first. Records with no enclosing window report `partial`.

**Smallest test.** Rebuild the codex fixture from a sanitized real rollout — with
`token_count` carrying only `info` / `rate_limits` / `type` — and assert non-zero
per-phase codex tokens. It fails today.

### 2. Unrecognized `item_completed` type nulls tokens and the roster total — blocking

**Location.** `src/transcriptRead.ts:255-266`, `:331-333`; rolled up at
`src/analytics.ts:107-110`, gated at `:408`.

**Rule.** An item type the parser does not recognize must not disable token
reporting, which is independent of item classification.

**Concrete failure.** Real sessions emit `Extension`, `EnteredReviewMode` and
`ExitedReviewMode`, none of which appear in `codexToolTypes` (9 entries) or
`codexNonToolTypes` (4), so `:332` sets `unsupported = true`. That makes the
agent `unsupported` (`analytics.ts:108`) and nulls `tokenTotal` (`:408`). Across
171 real rollouts the agent measured `Extension` ×65, `EnteredReviewMode` ×3,
`ExitedReviewMode` ×2, poisoning 5 of 171 sessions; in my own 12-session sample,
2 of 12 contained `Extension` (47 records). The fixture holds only classified
types, so tests stay green.

**Smallest correction.** Degrade the **tool** metric to `partial` naming the
unknown type; leave token coverage untouched.

**Smallest test.** Add one `item.type: "Extension"` record to the codex fixture
and assert codex token coverage stays `complete`.

### 3. `tokenTotal` omits `unassigned`, so the headline number understates spend

**Location.** `src/analytics.ts:408-417`.

**Rule.** A total presented without caveat must account for every measured token,
or refuse to print.

**Concrete failure.** `tokenTotal` sums only `agent.phases` and excludes
`agent.unassigned`, while being gated on coverage `complete`. The project's own
test proves the loss: `test/analytics.test.ts` asserts claude `unassigned.records
= 2` (13 input tokens) and codex `records = 1` (10 input tokens) while asserting
`tokenTotal.input === 23` — **23 of 46 input tokens dropped**, rendered as a
confident `Cross-roster token total: input=23`.

**Smallest correction.** Either add the unassigned buckets to the total, or
refuse to print a total when any agent has `unassigned.records > 0`.

### 4. A zero-match record does not degrade coverage

**Location.** `src/analytics.ts:384`.

**Rule.** Discarding a measured record must lower coverage.

**Concrete failure.** `assign(..., matching.length === 1)` passes
`fallback: false` when **zero** windows match, so `fallbackUsed` stays false and
coverage remains `complete` while the tokens go to `unassigned` — excluded from
both the phase breakdown and `tokenTotal`. Combined with findings 1 and 6, a
codex agent can report `coverage=complete`, every phase reading `input=0`, and a
cross-roster total omitting 100% of codex spend.

**Smallest correction.** Treat a zero-match as `partial`, distinctly from the
one-match exact case.

### 5. Lifecycle identity is journaled only when `result.changed`

**Location.** `src/agentEvent.ts:290` — and equally a defect in **my plan**,
which specified the projection inside that branch.

**Rule.** Identity the report joins on must be journaled whenever it exists, not
only when it coincides with a lifecycle state transition.

**Concrete failure.** Measured on the real issue-76 journal:

| agent | `action-prepared` | `prompt-submitted` | `stopped` |
| --- | ---: | ---: | ---: |
| claude | 10 | 6 | 6 |
| codex | 11 | 12 | 5 |
| antigravity | 8 | **0** | 16 |

A turn with no `prompt-submitted` row is never created by `deriveActionTurns`, so
its tokens go to `unassigned`; a turn with no `stopped` row leaves `endedMs ===
null`, making the documented window fallback (`src/analytics.ts:378`) unusable
for 6 of 11 codex turns. Antigravity has no usable window at all.

**Smallest correction.** Journal `sessionId` / `turnId` unconditionally for
`prompt-submitted` and `stopped`, independent of the state-transition gate. These
are bounded by action count and are not the status-tick noise that gate exists to
suppress.

### 6. `firstNudge` is never cleared, inflating wait times

**Location.** `src/analytics.ts:238`.

**Rule.** Each wait must span exactly one nudge→response pair.

**Concrete failure.** The real issue-76 journal contains duplicate `intent-seen`
events for the same `(agent, actionId)` — `('codex','ebb15626-…')` and
`('antigravity','9833c8e7-…')` each appear twice with a second `nudged` between.
The second sample is measured from the **first** nudge, spanning the first
response and the re-nudge, inflating both `count` and the median/max.

**Smallest correction.** Delete the key on consumption, or key on nudge
occurrence.

### 7. No `gate-advanced` yet renders a fabricated zero total

**Location.** `src/analytics.ts:140`.

**Rule.** Absence of data must not render as a measured zero — the plan's
`null`-never-`0` rule.

**Concrete failure.** With no `gate-advanced` events, `derivePhases` returns
empty, the in-progress phase at `:162` is skipped (`activeName` is null without a
`finalGate`), all usage becomes `unassigned`, and `tokenTotal` reduces over zero
phases to `emptyTokens()` while `agents.every(complete)` still holds. The report
prints `Cross-roster token total: input=0 output=0 …` and `Phase count 0` for a
live run that has already burned tokens. `coord analytics --issue N` during R1
hits this on every run.

**Smallest correction.** Emit the in-progress phase when gates are empty, and
report `null` rather than a zero total when no phase has concluded.

## Verdict

**Request changes.** Findings 1–5 are blocking; 6 and 7 should land with them.

Findings 1, 3, 4 and 7 share one shape: the report prints `complete` coverage and
a confident total over tokens it silently discarded. That is the specific failure
mode Phase 1 exists to prevent, since every Phase 2 decision will be made from
these numbers — a wrong number here is worse than no number, which is why the
plan required `null` over `0` and gated the roster total.

The craft is genuinely good — the cycle-safe parent walk and the fail-loud
allow/deny pair are both better than what the plan asked for. The failures are
concentrated where fixtures replaced real data: the codex fixture invents a
`turn_id` the format does not emit (finding 1) and omits item types that ordinary
sessions contain (finding 2). Both were invisible to a green suite.

This is what plan acceptance criterion (c) was for — "one real post-ship run has
produced a report with `complete` coverage for at least claude and codex" — and
it has not been run. I would treat that as the merge gate rather than the test
suite. My own withdrawn claim above is the same lesson: I asserted a vendor fact
from a sloppy measurement, and it propagated into the accepted plan and from
there into this implementation.
