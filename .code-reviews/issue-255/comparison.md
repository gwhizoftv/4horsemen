# Implementation comparison — issue 255

## Bound implementation pins

- muse `cb89b2d10600833586af4201dbb68adf53320142`
- claude `5dbe2f46a3a15eb79689715c8e50894586e09d8f` (my own implementation; I
  judged the others by the same criteria)
- codex `166878e2904afb5a1c28164920bf04ed3948c4a3`

I read each pin from its coordinator-exported worktree under
`coord-runtime/issue-255/worktrees/`.

All three change the same five approved paths:

- `src/transcriptRead.ts`
- `src/analytics.ts`
- `test/transcriptRead.test.ts`
- `test/analytics.test.ts`
- `docs/analytics.md`

None creates a new file or adds a dependency.

## Comparison

### Shared design (all three pins)

The three implementations converge on the selected plan's architecture:

- **Reader.** An optional `TranscriptUsage.samples?: TranscriptSample[]`,
  filled in `aggregateSamples` with each turn-keyed record's `at`. Turn totals
  are unchanged. The only reader differences are style:
  - claude initialises `samples: []` and uses `?.push`;
  - muse and codex use `(current.samples ??= []).push`;
  - codex declares `TranscriptSample` after `TranscriptUsage`.
- **Helper.** One `sharedTurnOwner` helper in `src/analytics.ts`, called in
  both places:
  - the turn-keyed loop, per sample, when `resolveTurnPhase` reports
    `sharedVendorTurn`;
  - the unattributed loop, against all `(sessionId, turnId)` siblings.
- **Slice rule.** A slice runs from an action's prompt to the next sibling's
  prompt and is never extended past that action's own stop.
- **Fallback.** Unresolved samples keep the existing latest-action fallback,
  `partial` coverage, and the existing reason text.
- **Exactness.** Unkeyed records keep `record.windowAttribution === "exact"`,
  so `custom_tool_call` fallbacks are never promoted to exact. All three are
  correct here.
- **Tests and docs.** All three update the two existing shared-turn tests to
  expect the split with `complete` coverage. All three add a four-phase
  R1/R2/R4/R7 case with a residual after-stop record that stays `partial`, and
  rewrite only the Codex shared-turn paragraph in `docs/analytics.md`.

### Cross-run evidence

To check whether the implementations actually behave differently, I ran each
pin's `test/analytics.test.ts` against each pin's `src/analytics.ts` and
`src/transcriptRead.ts`. I used a scratch copy with the claude clone's
`node_modules`, and ran
`vitest run --config vitest.config.ts test/analytics.test.ts`.

| source \ tests | claude (20) | muse (19) | codex (21) |
| --- | --- | --- | --- |
| claude | pass | pass | 1 fail: "does not let later tied prompts displace an earlier uniquely timed sample" |
| muse | 1 fail: "keeps an earlier shared-turn sample exact beside tied later prompts and bounds an unstopped turn by its phase" | pass | pass |
| codex | 1 fail: same claude case | pass | pass |

muse and codex behave identically on every test written by any pin. claude
differs on exactly two policy points, D1 and D2 below. Every other behaviour
matches across all three, including:

- the boundary instant at a prompt;
- missing timestamps;
- custom-tool exactness;
- an earlier sample beside a later tie.

I did not run the full product suites; the hooks and the coordinator own
those.

### D1 — a shared turn whose last action has no stop yet

- **Code.**
  - claude `src/analytics.ts:184`: an unstopped last sibling owns `at` only
    when `phaseIndexAt(phases, at) === turn.phaseIndex`, so it is bounded by its
    own phase.
  - muse `src/analytics.ts:172` and codex `src/analytics.ts:170`: it owns
    nothing.
- **Rule (issue requirement 2).** Keep `partial` only when a timestamp falls
  outside, or ambiguously across, action windows.
- **Observable difference.** Take a running issue where the last action in
  R4.implement has prompted and its turn has not stopped.
  - Under muse and codex, every turn-keyed tool record after that prompt takes
    the fallback. It lands in the *same* phase, but `toolCoverage` is `partial`
    with "shared by one vendor turn" until the stop arrives.
  - Under claude it is exact.

  Completed runs, the #241/#248 symptom, are unaffected, because every action
  has a stop.
- **Assessment.** Neither choice is a correctness defect.
  - The claude bound answers the open-window concern from codex's plan review:
    a record after the phase ends still falls back.
  - muse and codex are more conservative, and their docs say so (muse
    `docs/analytics.md:493`, codex `docs/analytics.md:494`).
- **Claude caveat.** The phase bound only reaches turn-keyed records. Unkeyed
  token rows need a complete window to enter `matching` (claude
  `src/analytics.ts:735`), so in an open window they stay unassigned in all
  three pins. claude's doc sentence "An action with no stop yet is bounded by
  its phase" (`docs/analytics.md:492`) is therefore true only for keyed records.
  Read alone, it overstates the rule for live token rows.

### D2 — tied prompts in the same phase

- **Code.**
  - claude `src/analytics.ts:187` returns the first owner when all tied owners
    share one `phaseIndex`.
  - muse `src/analytics.ts:167,175` and codex `src/analytics.ts:173` require
    exactly one owner.
- **Rule.** Same requirement as D1. The reported unit is the phase, while the
  ambiguity is between actions.
- **Observable difference.** codex's own test (`test/analytics.test.ts:740`)
  has two R2 actions prompted at 12 s, and both are R2 actions.
  - codex and muse put the 15 s sample in R2 as `partial`.
  - claude puts it in R2 as `complete`.

  The phase totals are identical; only the coverage label differs.
- **Assessment.** This is a policy choice. claude follows the codex plan's own
  sentence, "Several candidate actions in the same phase do not make the
  reported phase ambiguous". The codex implementation chose the stricter
  reading. All three handle ties in *different* phases conservatively, and all
  keep an earlier unique sample exact.

### Scope, reuse, and test focus

- **codex**
  - Gates the shared-turn path on `vendor === "codex"`
    (`src/analytics.ts:692,727`), matching the issue's Codex-only scope.
    claude and muse also apply it to Claude turns that carry samples.
    Shared Claude turns are not expected in practice, so this does not change
    any current behaviour.
  - Parameterises the existing `sharedCodexJournal(phases)` helper instead of
    adding a parallel one. This is the best reuse.
  - Has the widest focused coverage:
    - the boundary instant at a prompt;
    - a missing timestamp;
    - an earlier sample beside a later tie (line 740);
    - custom-tool-only evidence staying `partial` (line 757).
  - Does not test its own unstopped-last-action rule directly.
- **claude**
  - Smallest test footprint:
    - one `it.each` covering the two updated cases;
    - one inline four-phase case;
    - one case for D1 and D2.
  - Adds no helpers.
  - Has no test for custom-tool exactness or a missing timestamp. Its code
    passes codex's tests for both, so this is only a gap in its own suite.
- **muse**
  - Adds two new helpers, `multiphaseCodexTranscriptRoot` and
    `multiphaseCodexJournal` (`test/analytics.test.ts:176,225`, about 95
    lines). They duplicate the existing shared-turn helper's shape instead of
    extending it.
  - Has no test for ties or custom-tool exactness, although its code passes
    codex's tests for both.
  - Its doc paragraph is the only one that restates the custom-tool
    distinction.

## Findings

No pin has a correctness defect against the issue's requirements:

- tools and live tokens split per phase;
- completed shared turns reach `complete` coverage and a non-null token total;
- unresolved records stay `partial` with the existing reason;
- custom-tool evidence stays non-exact.

The differences are the two policy points above and test-suite breadth.

1. **claude `docs/analytics.md:492`.**
   - **Rule:** the documentation must describe the rule as implemented for
     every record route.
   - **Failure:** an operator reading "An action with no stop yet is bounded by
     its phase" expects live token rows in a running turn to be attributed.
     In fact they remain unassigned, because `src/analytics.ts:735` admits only
     complete windows.
   - **Fix:** a one-clause doc fix: "turn-keyed records of an action with no
     stop yet are bounded by its phase".
2. **claude `test/analytics.test.ts` (no custom-tool case).**
   - **Rule:** the plan's exactness-preservation claim for `custom_tool_call`
     fallbacks needs a regression test in the suite.
   - **Failure:** nothing in claude's own suite would catch a future change
     that passes `true` instead of `record.windowAttribution === "exact"` at
     `src/analytics.ts:750`.
   - **Smallest test:** codex's case at `test/analytics.test.ts:757`, which
     already passes against claude's source.
3. **muse `test/analytics.test.ts` (no tie or custom-tool case; duplicated
   helpers).**
   - **Rule:** use focused regression coverage that reuses existing helpers.
   - **Failure:**
     - Removing the tie guard at `src/analytics.ts:167` would pass muse's whole
       suite but fail codex's line-740 case.
     - The new helpers at lines 176–249 must be maintained alongside
       `sharedCodexJournal`.

**Recommendation.** For the issue's actual symptom (completed solo runs), all
three pins produce identical output. codex
`166878e2904afb5a1c28164920bf04ed3948c4a3` is the strongest candidate:

- its Codex-only gating matches the issue scope;
- it reuses the existing helper;
- it has the broadest focused regression coverage.

claude `5dbe2f46a3a15eb79689715c8e50894586e09d8f` is acceptable. It would be
the choice if the team prefers exact attribution for unstopped turn-keyed
records and same-phase ties (D1/D2), with finding 1 corrected.

muse `cb89b2d10600833586af4201dbb68adf53320142` behaves the same as codex, but
its tests are weaker and it adds duplicated helpers.
