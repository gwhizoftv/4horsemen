# Issue 89 — code review of Codex's Phase 1 implementation

- Reviewer: Claude
- Under review: `origin/issue-89/codex` at `025bbd5` ("Codex: implement issue 89 analytics")
- Baseline: `origin/main` at `1bfc7f9`
- Reviewed against: `.plans/issue-89/plan.md` (the accepted Phase 1 plan)
- Scope: 18 files, +2953/-8

## Summary

This is a faithful and careful implementation of the accepted plan. Every hazard
the plan named is handled correctly, and several are handled better than the plan
specified. One defect is blocking: on real codex transcripts the report degrades
to `unsupported` and suppresses the cross-roster token total — the primary
deliverable — because of an item type that occurs in ordinary sessions and is
absent from the test fixture.

Verified correct, each of which the plan called out as easy to get wrong:

| Plan requirement | Implementation | Status |
| --- | --- | --- |
| Codex tokens from `last_token_usage`, never cumulative `total_token_usage` | `src/transcriptRead.ts:282` | correct; `total_token_usage` appears nowhere |
| Codex tools from `item_completed` (has `turn_id`), not `custom_tool_call` (does not) | `src/transcriptRead.ts:323,344` | correct |
| `custom_tool_call` never guessed into a turn | `src/transcriptRead.ts:353-362` — `turnId: null`, used only when `exactToolCount === 0`, lands in `unattributed` | correct |
| Claude turn via `parentUuid` walk to `user.promptId` | `src/transcriptRead.ts:184-193` | correct, and cycle-safe via a `visited` set — better than the plan required |
| No cross-roster token total unless every agent is `complete` | `src/analytics.ts:408-417` | correct |
| Cross-roster tool total never reported | `src/analytics.ts:498` | correct, stated explicitly in output |
| Monotonic interval guard, never a negative duration | `src/analytics.ts:153-154,172-173` — `state: "invalid"`, `durationMs: null` | correct |
| Unassigned records surfaced, never silently dropped | `src/analytics.ts:476-478,496` | correct |
| Journal only `sessionId` + `turnId`; omitted when absent, not `null` | `src/agentEvent.ts:302-303` | correct, exactly two lines |
| No `runLoop` / `action` / `state` / `agentLifecycle` / schema change | diff confirms | correct |

## Findings

### 1. Unrecognized codex `item.type` marks real sessions unsupported and nulls the token total — blocking

**Location.** `src/transcriptRead.ts:255-266` (the type sets) and `:331-333`
(the `unsupported` branch), rolled up at `src/analytics.ts:107-110` and gated at
`src/analytics.ts:408`.

**Rule that must hold.** Phase 1's deliverable is an accurate token count for the
vendors that can report one. An item type the parser does not recognize must not
disable token reporting for a vendor whose token records — `token_count`
payloads — parsed successfully and are entirely independent of item
classification.

**Concrete failure.** `codexToolTypes` (`:255-265`) lists nine types and
`codexNonToolTypes` (`:266`) four. Real codex sessions also emit
**`Extension`**, which is in neither, so `:332` sets `unsupported = true`. That
propagates: `readTranscript` returns `coverage: "unsupported"`
(`src/transcriptRead.ts:443`), `combineTranscriptCoverage` returns
`"unsupported"` for the agent (`src/analytics.ts:108`), and because that is not
`"complete"`, `tokenTotal` becomes `null` (`src/analytics.ts:408`). The report
then prints "Cross-roster token total: unavailable" (`:484`) for the whole
roster.

Measured against the live store: in the most recent codex session,
`item_completed` types are `Reasoning` 336, `CommandExecution` 210, `FileChange`
33, `AgentMessage` 25, `UserMessage` 14, `Extension` 10, `ContextCompaction` 2 —
so that session reports `unsupported`. Across the twelve most recent sessions,
**2 of 12 contain `Extension` (47 records total)**. Any consensus run whose codex
session includes one produces no cross-roster token total at all.

The tests do not catch it because
`test/support/fixtures/transcript-codex.jsonl` contains only
`CommandExecution` ×2, `FileChange` ×1, `Reasoning` ×1 — every type classified.
This is precisely the fixture-versus-reality gap the plan's acceptance criterion
(c) existed to catch: "one real post-ship run has produced a report with
`complete` coverage for at least claude and codex." Green fixtures are not
evidence that criterion was met.

**Smallest correction.** Separate tool-classification coverage from token
coverage: an unknown `item.type` should degrade the **tool** metric for that
agent to `partial` (with the unknown type named in `reason`) and leave the token
metric at `complete`, since `token_count` parsing is unaffected. Add `Extension`
to a known-non-tool set only if it is confirmed non-invocational; leaving it
unclassified is otherwise fine once it no longer nulls tokens.

**Smallest test.** Add one `item_completed` record with
`item.type: "Extension"` to `test/support/fixtures/transcript-codex.jsonl` and
assert the codex agent still reports token coverage `complete` with a non-null
`tokenTotal`, while tool coverage is `partial`. That test fails on the current
implementation.

### 2. `phaseCount` silently excludes the running phase while `phases[]` includes it

**Location.** `src/analytics.ts:423`.

**Rule that must hold.** Two fields describing the same collection in one report
must agree, or their difference must be named.

**Concrete failure.** `phaseCount` counts only phases whose state is `complete`
or `invalid`, so an in-progress run yields `report.phases.length ===
report.phaseCount + 1`. A consumer that iterates `phases` and one that reads
`phaseCount` disagree by one, with nothing in the output explaining why. The
asymmetry is also surprising in the other direction: a phase with corrupt
timestamps (`invalid`) counts, while a phase that is genuinely running does not.

For the Phase 2 before/after comparison this is low-impact, since both runs
compared will normally be complete. It is a reporting-consistency defect, not a
measurement error.

**Smallest correction.** Either count `in-progress` as well, or rename the field
to `concludedPhaseCount` and state the rule in `docs/analytics.md`. The current
behaviour is defensible; only its silence is not.

## Verdict

**Approve after finding 1.** Finding 2 is optional and can ship later.

The implementation is materially better than the plan in two places — the
`visited` cycle guard on the claude parent walk, and using an allow/deny pair
with unknown types failing loud rather than a single allow-list that would
silently undercount. Choosing to fail loud was the right instinct; finding 1 is
that the failure is wired to the wrong metric, so a tool-classification gap
disables token reporting that was never in doubt.

Finding 1 is blocking because it defeats the issue's own Phase 1 deliverable on
real data while every test passes. It also means acceptance criterion (c) has not
been satisfied — no live run can currently produce `complete` codex coverage on a
session containing `Extension`, and roughly one codex session in six contains
one. I would run `coord analytics` against a real issue-76-style runtime before
merging, which is what the criterion asked for and what the fixtures cannot
substitute for.
