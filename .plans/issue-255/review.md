# Review — issue 255 plans

Plans reviewed at their bound pins: muse `365a094cff47adec222d55c12974f6c0b01175d3`,
claude `8972b77767d9f982a048fe2d1b5c70bbd6df99d0`, codex
`c3f3a2504e8c503f3ecb46c94caf761e107c1c45`. Code cited below is the shared
baseline `b45b725f7801df79bbcac6377deec2d195b4e320` all three plans describe.

## Findings

1. **Muse plan, Reuse and Scope item 4 and Scope limits ("The
   `unattributed` loop is not changed"; "Codex turn-keyed samples only").**
   The rule that must hold: the fix must cover the Codex records the issue
   reports, in the form the vendor actually emits them. A concrete failure
   if the plan is followed as written: live Codex `token_count` records
   carry no `turn_id` (`docs/analytics.md:483-486`; every `token_count` row
   in `test/support/fixtures/transcript-codex.jsonl` has no `turn_id`, and
   `codexSamples` at `src/transcriptRead.ts:367` then sets `turnId: null`),
   so they reach `buildAnalytics` through `result.unattributed`, not
   `result.turns`. In a chained shared turn, `deriveActionTurns`
   (`src/analytics.ts:300-317`) gives each sibling the same shared
   `stopped` `endedMs`, so a token sample after the second prompt matches
   several raw windows and the unchanged unattributed loop still calls
   `resolveTurnPhase` (`src/analytics.ts:141-161`), collapsing it onto the
   latest action with `sharedVendorTurn: true` and `partial` coverage. The
   plan's four-phase test hides this because its fixture artificially puts
   `turn_id` on the `token_count` records, a shape live Codex does not
   emit. The solo-run symptom in the issue (tokens/tools forced `partial`,
   cross-roster total unavailable) therefore survives for real token
   records. Smallest correction: apply the same per-sample timestamp
   resolution in the unattributed loop when its window matches share one
   `(sessionId, turnId)`, and make one four-phase fixture record a
   live-format (no `turn_id`) `token_count`.

2. **Muse plan, Reuse and Scope item 2 (phase fallback).** The rule that
   must hold (issue requirement 2): a sample is exact only when its
   timestamp maps uniquely to an action/phase window; a timestamp outside
   every action window stays `partial`. A concrete failure if the plan is
   followed as written: the phase fallback accepts a sample whenever
   `phaseIndexAt` returns a phase carried by exactly one matching turn,
   without first requiring the sample to lie inside any sibling's action
   window (`startedMs <= t`). A record timestamped after the phase gate
   opens but before the first `prompt-submitted` of that phase (for
   example during the previous action's wrap-up, or before any prompt of
   the run) is assigned `exact: true` to an action that had not started,
   laundering an out-of-window record into complete coverage. Smallest
   correction: gate the phase fallback on containment in at least one
   sibling's effective window, as the codex plan's step 4 explicitly does.

3. **Muse plan, Exact file list to be created (new fixture
   `transcript-codex-shared-turn-multiphase.jsonl`).** The rule that must
   hold: every new file must be justified, and the smallest change that
   solves the issue is preferred. A concrete failure if the plan is
   followed as written: the stated justification — that extending the
   existing fixture would break its tests — does not force a new file,
   because the test file already derives transcript variants in memory
   without touching the seed fixture (`sharedCodexTranscriptRoot(true)` at
   `test/analytics.test.ts:138-158` rewrites records with
   `turn_id: "turn-shared"` via `writeFileSync` into a temp root, and
   `test/transcriptRead.test.ts` writes inline transcripts the same way).
   Both peer plans generate the multiphase records this way and create no
   file. The new fixture is therefore unneeded scope an implementer must
   maintain in parallel with the existing shared-turn fixture. Smallest
   correction: drop the created file and derive the multiphase transcript
   in `test/analytics.test.ts` from the existing seed, as the peer plans
   specify.

4. **Claude plan, Reuse and Scope / `sharedTurnOwner` contract ("A last
   sibling with a null end owns nothing").** The rule that must hold
   (issue requirement 2): `partial` is retained only when a timestamp
   genuinely falls outside or ambiguously across action windows. A
   concrete failure if the plan is followed as written: in an in-progress
   run (the state `coord analytics` is most often read in), the last
   action of a shared turn has no `stopped` event yet, so `endedMs` is
   null and every one of its samples — including samples unambiguously
   after the last prompt and before any next prompt, matching exactly one
   sibling slice — returns no owner and keeps the latest-action `partial`
   fallback. Attribution for the currently running phase can never become
   complete until the vendor turn stops, even though the timestamp is not
   ambiguous across actions. Smallest correction: let the last sibling own
   `at >= startedMs` when there is no next sibling (bounded, if a bound is
   required, by the phase end `phaseIndexAt` already computes), reserving
   the null-owner rule for gaps and equal-start ambiguity.

5. **Claude plan, Exact File List to be changed or deleted (four files; no
   `docs/analytics.md`).** The rule that must hold: a plan that changes a
   documented behaviour must leave the shipped documentation describing
   the new behaviour. A concrete failure if the plan is followed as
   written: `docs/analytics.md:487-493` states that when windows sharing
   one `sessionId`/`turnId` overlap, "the most recently started action
   receives the record as an explicitly `partial` shared-turn fallback"
   and that turn-keyed records mapping to multiple actions are never exact
   — the exact statements this change repeals. Implementing the claude
   plan verbatim ships code whose coverage behaviour contradicts the
   analytics documentation that operators use to interpret `partial`.
   Smallest correction: add `docs/analytics.md` to the changed list and
   rewrite that paragraph to the per-sample timestamp rule, as both peer
   plans already specify.

6. **Codex plan, Reuse and Scope steps 4–5 and Tests item 2
   (timestamp-resolved unkeyed records assigned exactly, including the
   custom-tool-only variant).** The rule that must hold: records without
   an exact turn key may use a timestamp window only as a labelled
   `partial` fallback (`docs/analytics.md:502-507`); `codexSamples`
   encodes this by marking `custom_tool_call` fallback samples
   `windowAttribution: "fallback"` (`src/transcriptRead.ts:419-428`), and
   they are used only when the session has no authoritative
   `item_completed` tools. A concrete failure if the plan is followed as
   written: a session whose only tool evidence is `custom_tool_call` rows
   — the weakest tool evidence the reader supports — would, on a unique
   timestamp match in a shared-turn group, be promoted to exact and yield
   complete tool coverage, erasing the distinction the reader and docs
   deliberately keep between authoritative `item_completed` tools and the
   fallback representation. Smallest correction: in the shared-turn route,
   preserve `exact = sample.windowAttribution === "exact"` for unkeyed
   samples (the claude plan's unattributed rule), so timestamp resolution
   fixes placement without upgrading the evidence class.

7. **Codex plan, Reuse and Scope step 4 ("A missing stop may be bounded by
   the report's known phase/run end"; "Phase matching must inspect all
   eligible intervals").** The rule that must hold: the resolution rule
   must be mechanically decidable from the plan without the implementer
   inventing its inputs. A concrete failure if the plan is followed as
   written: phases in `derivePhases` (`src/analytics.ts:227-276`) are a
   single global sequence for the whole report, not intervals "belonging
   to that same shared identity group", and the plan never defines how to
   compute that eligible subset when several agents share phases or when
   `R6.*` rounds repeat a phase name; nor does it say which of the two
   candidate bounds (phase end versus run end, which for an in-progress
   report is simply `now`) wins when they differ. Two faithful
   implementations of this step can attribute the same open-window sample
   to different phases or disagree on exactness. The claude plan's
   slice rule (`startedMs` to next sibling start, bounded by the sibling's
   own stop) decides every one of these cases from `ActionTurn` fields
   alone. Smallest correction: define the eligible phases as exactly the
   distinct `phaseIndex` values of the matching `ActionTurn`s, decide
   uniqueness on `phaseIndex` (never name), and name one bound for a
   missing stop.

All three plans stay within the issue's scope (no lifecycle, journal, or
CLI changes), reuse `UsageSample.at`, `ActionTurn`, `resolveTurnPhase`,
`assign`, and the existing shared-turn fixtures/helpers, add no
dependencies, and propose focused tests that fail before and pass after.
The muse plan's new fixture file (finding 3) is the only unjustified new
file across the three; the claude and codex plans create none. The muse
plan's test set is otherwise focused, but its central fixture keys tokens
in a shape live Codex does not emit (finding 1), so its coverage of the
issue's actual symptom is weaker than its peers'.

## Conclusion

Do not implement the muse plan as written: findings 1–2 mean it fixes the
synthetic turn-keyed case while leaving live unkeyed Codex token records —
the records behind the reported `partial` coverage — on the collapsing
fallback, and can mark pre-prompt records exact. The codex plan covers
both record routes and the honest-residual cases, but its phase-first
resolution is under-specified and over-promotes fallback tool evidence
(findings 6–7). The claude plan is the sound base: one decidable
`sharedTurnOwner` slice rule applied in both the turn-keyed and
unattributed loops, optional per-turn `samples` that disturb no other
vendor, updated expectations for both existing shared-turn tests, and a
four-phase test asserting complete coverage plus the after-stop `partial`
case. Implement the claude plan with two corrections from the findings
above: let the last sibling own samples after its start when no next
sibling exists (finding 4), and add the `docs/analytics.md` update its
file list omits (finding 5).
