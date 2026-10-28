# Plan review — issue 255

Reviewed pins (from the bound input files):

- muse `365a094cff47adec222d55c12974f6c0b01175d3` — `.plans/issue-255/plan.md`
- claude `8972b77767d9f982a048fe2d1b5c70bbd6df99d0` — `.plans/issue-255/plan.md`
- codex `c3f3a2504e8c503f3ecb46c94caf761e107c1c45` — `.plans/issue-255/plan.md`

I checked the claims below against baseline `b45b725f` source:

- `src/transcriptRead.ts` `codexSamples` / `aggregateSamples`
- `src/analytics.ts` `resolveTurnPhase`, `deriveActionTurns`, and the
  turn-keyed and unattributed loops in `buildAnalytics`
- `test/analytics.test.ts:634-675`
- `test/transcriptRead.test.ts:43,62`
- `test/support/fixtures/transcript-codex*.jsonl`
- `docs/analytics.md:470-505`

Two baseline facts matter here.

1. Live Codex `token_count` rows have no `turn_id` (`test/transcriptRead.test.ts`
   asserts this with the "live Codex token_count rows without turn_id" case). They
   reach analytics only through `result.unattributed`.
2. Every prompt in a shared turn gets the same `stopped` end in
   `deriveActionTurns`, so the raw windows nest.

## Findings

### F1 — muse: shared-turn tokens on the unattributed path stay `partial` (blocking)

- **Plan claim.** Reuse and Scope, step 4: "The `unattributed` loop is not
  changed." File list: the test at `test/analytics.test.ts:634` "is not
  modified". The four-phase fixture puts an explicit `turn_id` on every
  `token_count` record.
- **Rule.** Issue requirement 2 applies to every shared-turn record whose
  timestamp maps to exactly one action. That includes the live Codex token rows,
  which carry no `turn_id` and so go through `unattributed`. Those rows are the
  source of the reported `coverage=partial` and `Cross-roster token total:
  unavailable`.
- **Failure.** Take the existing `sharedCodexJournal()` fixture with live-format
  rows. The row at `00:00:15` falls inside both nested windows (`[2s,22s]` and
  `[12s,22s]`). `resolveTurnPhase` still returns `sharedVendorTurn: true`, so:
  - codex `tokenCoverage` stays `partial`;
  - `tokenReason` still says "shared by one vendor turn across several
    actions";
  - `report.usage.tokenTotal` stays `null`.

  The plan's own regression guard keeps that assertion at line 634 passing.
  The new four-phase test passes only because its fixture uses a non-live
  keyed token format. The headline symptom in solo runs (#241, #248) is
  therefore unchanged.
- **Smallest correction.** In the unattributed loop, when `resolveTurnPhase`
  reports `sharedVendorTurn`, apply the same per-sample resolver to all
  same-`(sessionId, turnId)` siblings. Update line 634 to expect `complete`.
  Build the four-phase fixture's token rows without `turn_id`.

### F2 — muse: an open last window makes the phase fallback unreachable

- **Plan claim.** Reuse and Scope, step 1: the last candidate has
  `effectiveEndMs = endedMs ?? +Infinity`. Risks: an open-ended turn
  "Mitigation: phase fallback requires the phase to belong to exactly one
  matching turn".
- **Rule.** A window with no journaled stop is not a bound. A sample after the
  last prompt in an unstopped turn must not be promoted to exact on the strength
  of an infinite window.
- **Failure.** In an in-progress run, the last sibling has `endedMs: null`.
  Step 1 matches any sample at `t >= startedMs_last` uniquely, at any later
  time, and marks it `exact: true`. Step 2, the guarded phase fallback, runs only
  when step 1 fails, so it never runs here. The stated mitigation is dead code,
  and an implementer following step 1 reports `complete` for samples the Risks
  section says must stay `partial`.
- **Smallest correction.** A last candidate with a null `endedMs` yields no
  step-1 match, so the phase-guard path decides.

### F3 — muse: test 2 does not pin one expected outcome

- **Plan claim.** Tests, item 2: the after-stop record is "assigned by the
  latest-turn fallback or left counted under the existing shared/unassigned
  accounting … matching whichever branch the record takes".
- **Rule.** A focused test must fail before the change and pass after it, with
  one deterministic expectation.
- **Failure.** The assertion accepts either branch, so it cannot catch an
  implementation that unassigns a keyed record. Under the plan's own step 3, a
  turn-keyed record after the stop takes the latest-turn fallback. A
  regression that unassigns it instead would still pass.
- **Smallest correction.** Assert the latest-turn fallback: the record lands on
  the last phase, coverage is `partial`, and the reason is "shared by one vendor
  turn".

### F4 — muse: unneeded edit to `src/cursorHookUsage.ts`

- **Plan claim.** File list adds `src/cursorHookUsage.ts` to return
  `samples: []`. Alternatives rejects a per-turn `samples` field because it
  "breaks the exact `toEqual` turn expectations in … `test/cursorHookUsage.test.ts`
  and forces `src/cursorHookUsage.ts` to synthesise sample rows".
- **Rule.** Make the smallest change; don't widen the file map on a false
  premise.
- **Failure.** An *optional* per-turn `samples` field, which the claude and
  codex plans both use, is never populated by Cursor. So
  `test/cursorHookUsage.test.ts:117` `toEqual` and the `satisfies
  TranscriptUsage` constructors are unaffected. Only the *required* top-level
  field this plan chose forces the extra product file.
- **Note.** Not blocking on its own; it is avoidable scope.

### F5 — codex: custom-tool fallback records could be promoted to exact

- **Plan claim.** Resolution flow, step 5: "assign the individual supported
  Codex token/tool record exactly, including a timestamp-resolved unkeyed
  record". Tests, item 2: "exercise the custom-tool-only fallback
  representation as a variant … Assert … complete metric coverage".
- **Rule.** A `custom_tool_call` record has `windowAttribution: "fallback"`,
  and `docs/analytics.md:494-495` says it "alone is not treated as exact".
  Today the same record in a *non-shared* turn resolves with
  `resolveTurnPhase(matching, record.windowAttribution === "exact")` and is
  reported `partial`. The shared-turn route must keep that per-record flag.
- **Failure.** Take a custom-tool-only session whose records resolve to one
  phase each.
  - Under the plan, the shared-turn variant reports `toolCoverage: "complete"`.
  - The same records in non-overlapping, one-action-per-turn windows report
    `partial`.

  So reusing one turn id would *raise* coverage, which is the opposite of
  honest. The planned variant test would also lock that inconsistency in.
- **Smallest correction.** For unattributed records resolved through the
  shared-turn rule, set exactness to `record.windowAttribution === "exact"`.
  Assert `partial` for the custom-tool-only variant.

### F6 — codex: test scope is wider than the issue needs (non-blocking)

- **Plan claim.** Tests, item 3: table-driven mutations for missing timestamp,
  invalid timestamp, out-of-window timestamp, different-turn overlap, open final
  window, a beyond-`now` timestamp, and a custom-tool variant, plus a boundary
  record in item 2.
- **Rule.** The action asks for the fewest focused tests. The issue asks for one
  multi-phase fixture plus honest residual coverage.
- **Failure.** Different-turn overlap and invalid-timestamp handling already
  exist and are unchanged by this issue. Adding table rows for them grows
  `test/analytics.test.ts` without catching a new regression. Every extra
  variant that asserts exact sums must also be maintained when the rule's edge
  semantics are adjusted.
- **Smallest correction.** Keep:
  - the four-phase case;
  - one after-stop or out-of-window residual case;
  - the two updated existing cases.

  Drop the remaining rows.

### F7 — claude: the documented attribution contract is not updated

- **Plan claim.** File list names four files (`src/transcriptRead.ts`,
  `src/analytics.ts`, `test/analytics.test.ts`, `test/transcriptRead.test.ts`).
  `docs/analytics.md` is absent.
- **Rule.** `docs/analytics.md:486-493` states the shared-turn contract: "the
  most recently started action receives the record as an explicitly `partial`
  shared-turn fallback". That text must describe what ships.
- **Failure.** After the planned change, uniquely timed shared-turn records are
  exact and coverage can be `complete`. The doc would still tell operators that
  shared turns are always `partial`, and a reviewer of the doc would reject the
  correct new output as a regression.
- **Smallest correction.** Add `docs/analytics.md` to the file list. Rewrite
  only that paragraph: per-sample resolution against prompt-to-next-prompt
  slices bounded by the stop, with the latest-action `partial` fallback kept
  for samples that are missing, outside a slice, or ambiguous. The muse and codex
  plans both include this file.

### Cross-plan observations (not defects)

- **Attribution rule.**
  - claude: next-prompt truncation bounded by each sibling's own stop.
  - muse: the same truncation, with a phase fallback.
  - codex: phase intervals as the primary resolver.

  All three satisfy the issue's "action windows or phase boundaries" wording.
  They differ only for samples between a gate advance and the next prompt:
  claude and muse credit the previous action, and codex credits the new phase.
  The implementation must pick one rule and state it in the docs paragraph.
- **New files.** muse adds a fixture file
  (`transcript-codex-shared-turn-multiphase.jsonl`) with a stated
  justification. claude and codex show the same records can be written inline
  in `test/analytics.test.ts`, so the new file is avoidable but not wrong.
- **Scope.** All three keep to the issue: no lifecycle or journal changes, no
  new dependencies, and no report-shape change.

## Conclusion

- **muse — revise.** F1 is blocking. The plan leaves live, unkeyed Codex token
  rows on the shared-turn `partial` path, so the reported coverage and
  token-total symptoms persist while its keyed-only fixture passes. F2 and F3
  also need fixing. F4 is avoidable scope.
- **codex — approve with one correction.** F5 must be addressed so that
  `windowAttribution: "fallback"` records never become exact through the
  shared-turn route. F6 is advisory.
- **claude — approve with one correction.** F7: add the `docs/analytics.md`
  paragraph to the file map. Otherwise this is the smallest complete plan. It
  fixes both the turn-keyed and unattributed paths with one helper, adds no new
  files, and pins residual `partial` coverage with a deterministic after-stop
  assertion.

Recommended basis for implementation: the claude plan plus `docs/analytics.md`
from F7. Carry over muse's equal-start ambiguity guard, which is already
present in the claude plan as well.
