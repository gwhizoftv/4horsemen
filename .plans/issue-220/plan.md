# Issue 220: Supply comparison feedback to the first revision round

Issue baseline: `e5ec3f6d664d3967a15130337f91b4d193579555`.
This plan follows the frozen issue 220 request: restore comparison feedback to
`R6.revise` round 1 without restoring the deleted authorization step. The reviser
must receive the selected implementation, the published comparison ballots, and
accepted comparisons as local bound inputs, while retaining exactly one product
parent.

## Exact File List to be changed or deleted

- `src/runLoop.ts`: Extend only the round-1 branch of `deriveBoundInputs` for
  `R6.revise`. Preserve the selected-implementation lookup and return `[]` if no
  selected implementation matches the derived winner and product pin. When it
  does match, return, in order, the selected implementation through
  `inputFromSubmission(selected, "implementation", true)`, the results of
  `consensusBallotInputs(publishedBallotBatch(cursors, "R5.compare-ballot", null))`,
  and `acceptedAt(cursors, "R5.compare")` mapped through
  `inputFromSubmission(value, "review")`. Preserve the existing null-round
  fallback to round 1 and the round-2/3 branch.
- `test/runLoop.test.ts`: Add focused round-1 input and action-publication
  regressions using the existing fixtures. Retain the existing round-2/3 tests
  and verify first-round feedback does not enter those rounds.
- `test/orderScaffold.test.ts`: Add a round-1 case that obtains inputs through
  `deriveBoundInputs` and exercises the existing scaffold functions. Assert
  complete feedback binding and hashing together with the single selected
  product pin in `basedOn`.
- `docs/coord-driver.md`: Replace the Profiles paragraph's statement that round
  1 binds only the selected implementation. Describe the published comparison
  ballots and accepted comparisons as additional bound, materialized feedback,
  and explicitly retain the selected implementation as the sole product parent.
  Preserve the description of later revision rounds.

No existing files are deleted.

## Exact file list to be created

No product, test, fixture, or dependency files are created. The only new file for
this planning action is `.plans/issue-220/plan.md`, the coordinator-required plan
artifact; it is not an additional product implementation path.

## Reuse and Scope

Reuse `deriveBoundInputs`, `acceptedAt`, `inputFromSubmission`,
`publishedBallotBatch`, and `consensusBallotInputs` in `src/runLoop.ts`.
`publishedBallotBatch` already checks publication status, round, active-roster
identity, and correspondence with accepted response action IDs and digests.
Consequently, ballots come from the published coordinator-evidence commit and
its recorded paths, never from private response paths. `acceptedAt` retains its
existing active-agent filter for comparisons. Comparisons use their submission
SHA, whereas the implementation uses its product pin.

Keep the existing internal `consensus-ballot` kind for the comparison ballots,
as returned by the shared helper, and `review` for comparisons. These kinds are
already document inputs in `MATERIALIZED_MARKDOWN_KINDS` in
`src/materializedInputs.ts`. Reuse `materializeBoundInputs`, the run-loop action
preparation path, and `boundInputFilesSection` in `src/action.ts` without edits.
They export the document bytes and selected implementation worktree before
publishing the action. No new materialization kind, renderer, schema, migration,
workflow step, or dependency is needed.

Reuse `revisionProductInputs` and `computeInputSetHash` in `src/evidence.ts` and
`artifactScaffoldValue` / `renderArtifactScaffold` in `src/orderScaffold.ts`
without changing their production behavior. The existing filter accepts only
`implementation` and `prior-revision` as product parents; the input hash includes
feedback as well as the product input. Both scaffold and evidence validation
already use this distinction.

In the run-loop tests, reuse `fixture`, `acceptedResponseFixture`,
`publishedBallotBatchFixture`, `cursorsStateSchema`, `buildOrder`,
`CoordinatorRunLoop`, `BareMirror`, and the established action-publication test
pattern. Use `AcceptedResponse`, `BallotBatch`, and `BoundInput` shapes already
defined by the repository. For the scaffold test, use a small in-memory
two-agent state initialized with the existing state constructors/schemas and
local fixture data; do not extract a shared fixture module for this change.

## Tests

Use the following focused cases, extending the two existing test files:

1. In `test/runLoop.test.ts`, seed two active agents' implementations,
   comparisons, accepted comparison responses, and a matching published
   comparison batch, with one selected implementation. Assert the exact ordered
   round-1 inputs: one selected product pin, both ballots at the batch commit
   and published paths, and both comparisons at their submission commits with
   kind `review`. Exercise the null-round fallback in the same case. Include a
   historical comparison from an inactive agent and assert its exclusion.
   Check that absent or unpublished batches do not expose private responses,
   and that a missing selected implementation retains the empty-input result.
   The principal exact-input assertion fails before the fix because feedback
   is absent. Keep the existing round-2/3 assertions and seed comparison
   feedback there too, proving those rounds still bind only their prior
   revision and preceding consensus ballots.
2. In `test/runLoop.test.ts`, extend the existing action-publication coverage
   with a round-1 revision scenario. Reuse the two-agent fixture and a
   `BareMirror` stub containing recognizable ballot rationales and comparison
   findings. Run `CoordinatorRunLoop.runTick()` with the reviser ready for
   round 1. Read its generated action and assert that `## Bound input files`
   names every active published ballot, every active accepted comparison, and
   the selected implementation worktree. Read the listed document files and
   compare their bytes to the stub's pinned content; check the selected
   worktree path exists. Assert the feedback entry count explicitly, so a
   loop over zero exported documents cannot pass. This fails before the fix
   because the published action has no comparison feedback.
3. In `test/orderScaffold.test.ts`, derive round-1 inputs from a two-agent state
   with published comparison ballots and accepted comparisons, then pass them
   to `artifactScaffoldValue` / `renderArtifactScaffold`. Assert the full
   expected input set, `round: 1`, and `basedOn: [selectedProductPin]`; compare
   `inputSetHash` against the independently specified complete expected input
   set. Check the rendered revision-ready JSON as well. Deriving the inputs
   here makes the feedback/hash assertion fail before the binding fix. A
   test with only hand-written mixed inputs would already pass and would
   protect ancestry without detecting this issue; retain the existing
   later-round ancestry test as that complementary protection.

During implementation, run the new focused cases before and after the source
change, then run the two affected suites:

```sh
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/orderScaffold.test.ts
```

The actual package scripts and installed workspace verification configuration
declare `pnpm run check:fast` for product precommit and `pnpm run test:e2e` for
product prepush. Let those hooks run their mandatory checks; do not manually
duplicate them immediately before publishing. `check:fast` runs lint,
typechecking, fast tests, and system tests. The coordinator's frozen final
check is `pnpm run check`, which includes build, those checks, and e2e. The
coordinator owns that final run, and its result must not be reported as an
agent-run check. If a later action enables coordinator verification mode,
follow that action's candidate-check responsibilities instead.

For this plan-only action, validate the required non-empty headings, the exact
four-file product map, and the references to existing code and commands. Do not
run product suites or claim the proposed regression tests have already run.

## Alternatives Rejected

- Restoring `R5.reviser-auth` would add an agent round trip for deterministic
  authorization; binding the missing information directly repairs its lost
  information flow.
- Reading private responses or asking the reviser to fetch peer branches would
  bypass published evidence and leave the action incomplete. Use the existing
  published-batch lookup and materializer.
- Adding a new `comparison-ballot` materialization kind or generalizing the
  helper would expand production changes without adding needed behavior. The
  existing helper and document kind already handle the publication shape.
- Editing ancestry filtering would duplicate behavior already supplied by
  `revisionProductInputs`. Test it with the newly derived inputs instead.
- Adding review feedback to later rounds would change the established #212
  behavior and could repeat superseded requirements. Keep those rounds intact.

## Risks and Mitigations

- An unrecognized input kind could leave feedback cited but not exported. Use
  the existing materialized kinds and verify actual published action paths
  and document bytes.
- Treating feedback commits as product parents would corrupt revision ancestry.
  Preserve the existing product-input filter and test exact `basedOn` together
  with a hash that includes all feedback.
- Stale, unpublished, or inactive-agent evidence could leak into the action.
  Reuse the publication/roster checks and active comparison filtering; test
  unpublished-batch omission and inactive-comparison exclusion.
- Altering the selected-pin lookup or later-round branch could change unrelated
  selection behavior. Retain the no-selection guard and use explicit assertions
  for the selected pin, null-round fallback, and rounds 2 and 3.
- Comparing only hard-coded scaffold inputs would miss the original bug. Feed
  the scaffold regression from `deriveBoundInputs` and assert complete feedback
  before checking the existing ancestry invariant.

## Conclusion

The implementation changes four existing files and adds no production
abstractions or dependencies. Round 1 receives the published ballots and
comparison findings as readable bound feedback immediately, while its
revision-ready artifact retains exactly the selected implementation as its
product parent. Existing later-round behavior remains covered and unchanged.
