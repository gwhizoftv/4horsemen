Bound implementation pins cited in full, as required:

- muse: `cb89b2d10600833586af4201dbb68adf53320142`
- claude: `5dbe2f46a3a15eb79689715c8e50894586e09d8f`
- codex: `166878e2904afb5a1c28164920bf04ed3948c4a3`

All three pins change the same five product/test/doc paths
(`src/analytics.ts`, `src/transcriptRead.ts`, `test/analytics.test.ts`,
`test/transcriptRead.test.ts`, `docs/analytics.md`), create no new files,
add no dependencies, and keep the existing coverage vocabulary and
`report.usage.tokenTotal` gate. Their `src/transcriptRead.ts` changes are
functionally identical: an optional `TranscriptUsage.samples` list that
preserves each turn-keyed sample's `at`, tokens, and record counts through
`aggregateSamples`, leaving the aggregate `turns` totals untouched. The
implementations differ in `src/analytics.ts` shared-turn ownership, in how
far that rule is scoped, and in edge-case test coverage.

## Comparison

Core agreement (verified by reading all three bound worktrees): when
several actions share one `(sessionId, turnId)`, each implementation
assigns turn-keyed samples individually by timestamp in the
`result.turns` loop and resolves live unkeyed Codex `token_count` records
in the `result.unattributed` loop; a uniquely resolved record is assigned
to its action's phase, unresolved records keep the latest-action
`sharedVendorTurn` fallback with `partial` coverage and the existing
"shared by one vendor turn across several actions" reason, records at the
next sibling's prompt start belong to the next sibling, and a record at a
recorded stop is included in its slice. The four-phase
`R1.join`/`R2.plan`/`R4.implement`/`R7.finalize` scenario the issue
requires is tested by all three, with complete token/tool coverage and a
non-null token total, plus an after-stop residual record that stays
`partial`. Divergences:

| Case | muse `cb89b2d1` | claude `5dbe2f46` | codex `166878e2` |
|---|---|---|---|
| Unstopped last action (in-progress run) | No owner; `partial` fallback | Owner if inside its phase; exact | No owner; `partial` fallback |
| Tied prompts in the same phase | No owner for that slice; `partial` | Owner (all owners share the phase); exact | No owner (`owners.length === 1` fails); `partial` |
| Earlier sample beside later tied prompts | Exact (tied turns excluded per-sample) | Exact (same-phase owners collapse to the phase) | Exact (only latest-start owners compete) |
| Vendor scope of the new rule | Any vendor with samples | Any vendor with samples | Gated to `vendor === "codex"` in both loops |
| Missing-timestamp keyed sample | Fallback (untested) | Fallback (untested) | Fallback, explicitly tested |
| `custom_tool_call`-only evidence | Docs state it stays `partial`; unattributed branch keeps `windowAttribution` exactness | Same branch behaviour; docs less explicit | Same behaviour, explicitly tested |

Findings, in the required order (file and line; rule; concrete failure;
smallest illustrative test):

1. **Muse, `src/analytics.ts:163` (`sharedTurnOwner`: a last sibling with
   `endedMs === null` can never own).** The rule that must hold (issue
   requirement 2): `partial` is retained only when a timestamp genuinely
   falls outside or ambiguously across action windows. Concrete failure:
   in an in-progress run — the state `coord analytics` is most often read
   in — the running last action of a shared turn has no `stopped` event
   yet, so every sample unambiguously after the last prompt, matching
   exactly one sibling slice, returns no owner and keeps the latest-action
   `partial` fallback; that phase's coverage and the cross-roster token
   total stay blocked until the vendor turn happens to stop, even though
   the timestamp is not ambiguous across actions. The claude pin's
   phase-bound rule (below) shows the bound the issue's "or phase
   boundaries" wording already allows. Smallest illustrative test: the
   claude pin's "keeps an earlier shared-turn sample exact beside tied
   later prompts and bounds an unstopped turn by its phase" case in
   `test/analytics.test.ts`, which asserts `tokenCoverage: "complete"` for
   an unstopped shared turn; the muse pin has no unstopped case.

2. **Codex, `src/analytics.ts:164` (`sharedTurnOwner`: last unstopped
   sibling needs a later prompt to own anything, and
   `owners.length === 1` rejects same-phase ties).** The rule that must
   hold: attribution is reported per phase, so several candidate actions
   in the same phase do not make the reported phase ambiguous — the rule
   the codex plan itself stated — and a uniquely sliced timestamp is
   exact. Concrete failures: (a) as in finding 1, samples in the running
   last action stay `partial` (`turn.endedMs === null ? hasNextPrompt`
   is false after the last prompt); (b) two prompts journaled in the same
   second within one phase (a retry or re-prompt inside `R2.plan`) make
   `owners` contain both tied actions, so every sample in that slice
   falls back to `partial` on the latest action and can block the token
   total, although both candidates report the identical `phaseIndex`.
   The codex pin's own "does not let later tied prompts displace an
   earlier uniquely timed sample" test locks in `tokenCoverage:
   "partial"` for a same-phase tie, contradicting the phase-level rule.
   Smallest illustrative test: the claude pin's tied-prompt case, where
   the tied prompts sit in one phase and coverage is `"complete"`.

3. **Claude, `src/analytics.ts:708-710`, and muse, `src/analytics.ts:696-698`
   (shared-turn resolution not gated to Codex).** The rule that must hold:
   keep the work within the issue, which is Codex-specific ("Attribute
   Codex token and tool usage…"). Concrete failure: `aggregateSamples`
   populates `samples` for Claude transcripts too (Claude samples carry a
   `promptId` turn key), so a Claude session whose `promptId` is reused
   across chained actions now gets per-sample exact splitting and can
   flip from `partial` to `complete` — a behaviour change for a vendor
   the issue never mentions, with no Claude shared-turn test in either
   pin's `test/analytics.test.ts` to pin the new behaviour. The codex pin
   gates both loops with `vendor === "codex"`
   (`src/analytics.ts:692,727`) and is the only one that stays exactly
   inside the issue's scope. This is a scope/test gap, not a correctness
   failure for Codex records; smallest fix is the codex pin's vendor gate,
   or a Claude shared-turn test justifying the wider change.

4. **Claude, `src/analytics.ts:710` (`assign(owner.phaseIndex, sample,
   true)`).** The rule that must hold: a sample is exact only when it is
   actually placed in a phase. Concrete effect, checked against `assign`
   at `src/analytics.ts:649` in the same pin: when the owning action was
   prepared outside every derived phase (`phaseIndex === null`), the
   `true` flag is inert — the null-phase branch counts the sample
   unassigned and degrades coverage to `partial` exactly as the muse and
   codex pins do with `owner.phaseIndex !== null`. No output difference
   follows today, so this is a readability divergence only; the muse/codex
   form states the real condition and is preferable if the pins are ever
   merged.

Test coverage comparison: the claude pin has the strongest edge coverage
for the ownership rule (parameterised unkeyed/turn-keyed two-phase split,
tied prompts plus phase-bounded unstopped turn, four-phase attribution
with after-stop residual). The codex pin has the widest residual coverage
(four-phase with boundary tool at the prompt instant, after-stop record,
missing-timestamp keyed token retained once via the fallback,
custom-tool-only evidence staying `partial`) but asserts the same-phase
tie `partial` criticised in finding 2. The muse pin covers the required
four-phase case and both two-phase routes, but has no tied-prompt,
unstopped-turn, or missing-timestamp case, so findings 1–2 class of
regressions would pass its suite unnoticed. All three update the
`test/transcriptRead.test.ts` `toEqual` turn expectations to include
`samples` and preserve the existing Claude/Cursor regression cases.

Reuse and scope comparison: all three reuse `UsageSample.at`,
`ActionTurn`/`deriveActionTurns`, `resolveTurnPhase`, `assign`, and the
existing shared-turn test helpers and fixtures, deriving multiphase
transcripts inline in `test/analytics.test.ts` rather than adding fixture
files. The codex pin is the most scope-disciplined (vendor gate, docs
paragraph with the fullest boundary statement). The muse pin's docs
paragraph is the only one that explicitly states the `custom_tool_call`
evidence distinction survives; the claude and codex docs reach the same
behaviour through the unchanged `windowAttribution` exactness in the
unattributed branch but do not say so.

Verification note: this comparison is based on reading the three bound
worktrees' source, tests, and docs directly. The exported worktrees
contain no `node_modules`, so no peer test suite was re-run here; missing
results are not treated as a pass. The muse pin's focused suites
(analytics, transcriptRead, cursorHookUsage — 30 tests) were observed
passing in the preceding implementation action in this clone.

## Verdict

Select the claude implementation, `5dbe2f46a3a15eb79689715c8e50894586e09d8f`,
for finalization. It is the only pin that resolves the full shared-turn
matrix the issue describes — keyed tools and live unkeyed tokens, tied
prompts that share a phase, and the in-progress unstopped last action
bounded by its phase — while keeping unresolved records honestly
`partial`, and it backs that rule with the tied/unstopped test the other
pins lack. The codex pin `166878e2904afb5a1c28164920bf04ed3948c4a3` is a
close second (best scope discipline and residual tests) but leaves
same-phase ties and the running last action `partial`. The muse pin
`cb89b2d10600833586af4201dbb68adf53320142` is correct on the required
four-phase scenario but is the most conservative on exactly the
in-progress runs the issue's solo-run symptom comes from, with the
thinnest edge coverage. If any follow-up is taken from the other pins,
take the codex pin's `vendor === "codex"` gate (finding 3) as a separate,
deliberate scope decision — not as part of this issue's fix.
