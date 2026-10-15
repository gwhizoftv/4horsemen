# Issue 220 — bind comparison ballots and comparisons to revise round 1

## Problem

`deriveBoundInputs` (`src/runLoop.ts:626-640`) gives `R6.revise` round 1 only
the selected implementation pin. Since #109 removed `R5.reviser-auth`, the
reviser has no bound copy of the `R5.compare` comparisons or the published
`R5.compare-ballot` batch. #110 made ballots private runtime responses, and the
shell guard refuses `git show`, so the reviser cannot read the requested
changes any other way (consensus-ai issue 396 stalled this way). Rounds 2+
were fixed by #212 (57cc186) through `consensusBallotInputs(publishedBallotBatch(...))`.

## Exact File List to be changed or deleted

- `src/runLoop.ts` — in the round-1 branch of `R6.revise` inside
  `deriveBoundInputs`, keep returning the selected implementation first, then
  append:
  1. `...acceptedAt(cursors, "R5.compare").map((value) => inputFromSubmission(value, "review"))`
     (the accepted active comparisons, cited by submission SHA and
     `.code-reviews/issue-<n>/comparison.md` path);
  2. `...consensusBallotInputs(publishedBallotBatch(cursors, "R5.compare-ballot", null))`
     (the published comparison-ballot batch, one entry per active agent).
  If the selected implementation is missing, the function still returns `[]`
  exactly as now (no feedback without the one authorized product parent).
  The rounds-2+ branch is not touched.
- `docs/coord-driver.md` — replace "Round 1 binds only the selected
  implementation." (line 590) with: round 1 binds the selected implementation
  as the single product parent, plus the accepted comparisons and the
  published comparison-ballot batch as readable feedback.
- `test/runLoop.test.ts` — add one round-1 binding case (see Tests).
- `test/orderScaffold.test.ts` — add one round-1 `basedOn` case (see Tests).

## Exact file list to be created

None. No new file is needed: the change is a few lines in an existing
branch, and both tests join existing suites.

## Reuse and Scope

Reused without modification:

- `acceptedAt` (`src/runLoop.ts:275`): active-roster filtering of accepted
  `R5.compare` submissions, the same as the `R3.plan-ballot` binding of
  `R3.review`.
- `inputFromSubmission` (`src/runLoop.ts:268`) with kind `"review"`: a
  comparison is a Markdown review document cited by its submission SHA.
  `"review"` is already in `MATERIALIZED_MARKDOWN_KINDS`
  (`src/materializedInputs.ts:30`), so comparisons are exported as files with
  no materializer change.
- `publishedBallotBatch` (`src/runLoop.ts:301`) with `("R5.compare-ballot", null)`:
  `computeImplementationSelection` already uses this exact call
  (`src/runLoop.ts:503`), so the batch the reviser reads is the same batch that
  elected them.
- `consensusBallotInputs` (`src/runLoop.ts:336`), the #212 helper. It emits
  kind `"consensus-ballot"`, which is in `MATERIALIZED_MARKDOWN_KINDS`, so the
  canonical ballot JSON files are exported. The only kind-sensitive consumer,
  `evidence.ts:395`, is gated on the `follow-up-published` evidence and is not
  reached by `R6.revise`.
- `revisionProductInputs` (`src/evidence.ts:45`) keeps only `implementation` /
  `prior-revision` inputs. Both the `revision-ready` scaffold `basedOn`
  (`src/orderScaffold.ts:75`) and the `revision-pinned` evidence check
  (`src/evidence.ts:367-369`, "exactly one authorized product pin") therefore
  stay at the single selected pin without any change.
- `computeInputSetHash` already hashes every bound input. The scaffold and the
  evidence check both derive it from `order.inputs`, so the larger round-1
  input set stays self-consistent.
- Test fixtures: `fixture`, `buildOrder`, `deriveBoundInputs`,
  `acceptedResponseFixture`, `publishedBallotBatchFixture` (which already
  supports `comparison-ballot-batch`), `materializeBoundInputs`, and the
  `third revision closeout` `terminalFixture` in `test/runLoop.test.ts`; the
  existing `R6.revise` scaffold context in `test/orderScaffold.test.ts`.

Out of scope: rounds 2+ binding, ballot publication, implementation-selection
tallying, materializer kinds, and action rendering (`src/action.ts` lists
whatever is bound by kind).

## Tests

Focused runs during development:
`pnpm vitest run test/runLoop.test.ts test/orderScaffold.test.ts`. The
commit hook runs `pnpm check:fast`; the coordinator owns final checks.

1. `test/runLoop.test.ts`, `describe("third revision closeout")`, new case
   "binds the comparisons and published comparison ballots for revision
   round 1". Seed from `terminalFixture()`:
   - the accepted `R4.implement` for the selected winner `codex`
     (`productPin` = `implementationSelection.implementationPin`);
   - one accepted `R5.compare` per active agent
     (path `.code-reviews/issue-1/comparison.md`, a distinct `submissionSha` per
     agent, `round: null`; the materializer keys each file by
     `kind-agent-sha8`, so equal paths do not collide);
   - `R5.compare-ballot` `acceptedResponseFixture`s for every active agent
     (`round: null`, `choice: "codex"`) and a
     `publishedBallotBatchFixture({ kind: "comparison-ballot-batch", round: null })`.

   Assert:
   - `buildOrder(..., "codex", "R6.revise", 1).inputs` equals, in order,
     the selected implementation (`kind: "implementation"`, `commitSha` = its
     pin), every comparison (`kind: "review"`, `commitSha` = its
     submission SHA), and one `consensus-ballot` per batch response
     (`commitSha` = batch commit, path = `batch.paths[i]`);
   - `revisionProductInputs(order.inputs)` is exactly `[selected pin]`;
   - `materializeBoundInputs` with a stub mirror reports zero `omitted`, one
     file entry per comparison and ballot, and one `implementation` worktree.
     This shows the reviser can read every input without `git show`;
   - with `ballotBatches` lacking the comparison batch, round 1 still binds
     the implementation and comparisons (no stale or partial ballot set).

   Before the change, the first assertion fails because only the
   implementation is bound. The existing round-1 assertion in the
   `binds the previous published ballots for revision round %s` case
   (`test/runLoop.test.ts:4222`) seeds no `R5.compare` / `R5.compare-ballot`
   state, so it still holds unchanged. Together with that case's round-2/3
   assertions, this confirms rounds 2+ are unchanged.

2. `test/orderScaffold.test.ts`, new case "keeps round-1 revision ancestry
   at the selected implementation". Use the existing `R6.revise` context with
   `round: 1` and inputs `implementation` (pin `c…`), two `review`
   comparisons, and two `consensus-ballot` entries. Assert
   `artifactScaffoldValue(ctx).basedOn` equals `["c".repeat(40)]` and
   `inputSetHash` equals `computeInputSetHash(ctx.inputs)`. Honest note: this
   unit case already passes before the change, because `revisionProductInputs`
   (57cc186) filters by kind. It is a regression guard for the issue's
   `basedOn` acceptance criterion. The fails-before evidence is test 1, which
   also checks `basedOn` over the real derived round-1 inputs.

## Alternatives Rejected

- **Restore `R5.reviser-auth` as an agent step.** #109 removed it correctly as
  a deterministic artifact phase. Bringing it back would add a full action
  round trip just to deliver files the coordinator can bind directly.
- **New kinds `comparison` / `comparison-ballot`.** These would make the
  rendered labels more specific, but they would also require changes to
  `MATERIALIZED_MARKDOWN_KINDS`, `consensusBallotInputs`, and the tests.
  Existing kinds already materialize correctly, and in round 1 no consensus
  ballot exists yet, so the `consensus-ballot` label cannot be confused with
  anything.
- **Let the reviser `git show` peer branches.** The containment guard refuses
  it by design, and ballots are no longer committed on agent branches (#110).
- **Bind ballots but not comparisons.** Ballot rationales refer to the
  file/line findings in the comparisons. Without those, the reviser still
  cannot act (issue requirement 2).
- **Bind every `R4.implement` pin as well.** This would let the reviser read
  peer code, but it adds non-selected product pins. Keeping them out avoids
  any risk to the single-parent `basedOn` rule and keeps worktree
  materialization cost flat.

## Risks and Mitigations

- **`basedOn` / evidence acceptance widened by accident.** New inputs use the
  non-product kinds `review` and `consensus-ballot`, and
  `revisionProductInputs` filters by kind. Test 1 asserts the single pin over
  real derived inputs, and test 2 pins the scaffold.
- **Roster drop after the comparison ballot.** `publishedBallotBatch` requires
  the batch roster to equal the current active roster. If an agent is dropped
  after `R5.compare-ballot`, the batch is not bound, while active comparisons
  still are. This matches the #212 rounds-2+ behavior, and it binds no stale
  or partial ballot set. Test 1 covers the batch-absent path.
- **Action / input-set hash changes for round 1.** Round-1 actions already in
  flight carry their own `inputSetHash`, and evidence is checked against the
  order's own inputs. New round-1 actions simply bind more files. No persisted
  schema changes.
- **Materialization size.** Comparisons and canonical ballots are small
  Markdown/JSON documents. No additional product worktrees are created.
- **Solo / reviewed profiles.** These have no `R5.compare` submissions and no
  comparison batch, so the added spreads are empty and their behavior is
  unchanged.

## Conclusion

Extend only the round-1 `R6.revise` branch of `deriveBoundInputs` to append the
accepted active `R5.compare` comparisons (kind `review`) and the published
`R5.compare-ballot` batch (via the #212 `consensusBallotInputs` helper) after
the selected implementation. Update the one doc sentence, and add one
fails-before binding/materialization test plus one `basedOn` guard. The
reviser then receives readable feedback in round 1. `basedOn` stays the single
selected pin, and rounds 2+ are untouched.
