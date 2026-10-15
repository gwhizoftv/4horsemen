# Issue 220 — Bind comparison feedback on revision round 1

Round 1 of revise currently returns only the selected implementation. Later rounds already bind the previous published consensus ballot batch. This plan restores the pre-authorization information flow for round 1 only: the published comparison-ballot batch and the accepted comparisons, with ancestry still limited to the selected implementation pin.

## Exact File List to be changed or deleted

- `src/runLoop.ts`
  - In `deriveBoundInputs`, leave the `(round ?? 1) > 1` branch unchanged. It still returns the previous round's accepted revision (`prior-revision`, product pin) plus `consensusBallotInputs(publishedBallotBatch(cursors, "R6.ballot", previousRound))`.
  - In the round-1 branch, keep the existing selected-implementation lookup (acceptedAt on R4.implement, matching derived.implementationSelection.winner and implementationPin). If that submission is missing, still return an empty list.
  - When it is present, return three groups in this order:
    1. `inputFromSubmission(selected, "implementation", true)` (unchanged product parent).
    2. `consensusBallotInputs(publishedBallotBatch(cursors, "R5.compare-ballot", null))`. A missing or roster-mismatched batch contributes nothing, the same way later rounds omit an unpublished ballot batch.
    3. acceptedAt on R5.compare, mapped through inputFromSubmission with kind review and usePin left false. The comparison commit is submissionSha; comparison.md lives on that commit. Active-only acceptedAt already drops agents who are no longer on the roster.
- `docs/coord-driver.md`
  - Replace the Profiles sentence that round 1 binds only the selected implementation. State that round 1 binds the selected implementation, the published comparison-ballot batch, and the accepted comparisons, and that later rounds are unchanged: the preceding accepted revision is the single product parent, plus the previous round's published consensus ballot batch.
- `test/runLoop.test.ts`
  - Add the round-1 binding case described under Tests. Leave the existing rounds-2-and-3 case, including its assertion that a round-1 call with no comparison batch and no accepted comparisons returns only the implementation.
- `test/orderScaffold.test.ts`
  - Add the round-1 `basedOn` case described under Tests.
- `test/integration.test.ts`
  - The consensus canary reaches revise round 1 and asserts `inputs` has length 1, then submits `basedOn` as every bound `commitSha`. After the binder change that submission is rejected (`basedOn` must equal the single product pin). Update those two assertions as described under Tests. Keep the assertion that an amendment resume returns the same input list.

## Exact file list to be created

None.

## Reuse and Scope

Reuse these existing pieces. No new module, helper, kind, or dependency.

- `deriveBoundInputs`, `acceptedAt`, `inputFromSubmission`, `publishedBallotBatch`, and `consensusBallotInputs` in `src/runLoop.ts`. The last helper is what later rounds use. It already emits `kind: "consensus-ballot"` with the batch `commitSha` and `batch.paths`. For a comparison-ballot batch those paths are `.code-reviews/issue-<n>/ballot-<agent>.json` from `canonicalBallotPath` in `src/ballotPublication.ts`.
- `revisionProductInputs` in `src/evidence.ts`, already used by `artifactScaffoldValue` in `src/orderScaffold.ts`. It keeps only `implementation` and `prior-revision`, so comparison ballots and comparisons stay out of `basedOn` without a scaffold change.
- `MATERIALIZED_MARKDOWN_KINDS` in `src/materializedInputs.ts` already contains `consensus-ballot` and `review`. `MATERIALIZED_PIN_KINDS` already contains `implementation`. `materializeBoundInputs` and `boundInputFilesSection` in `src/action.ts` therefore export the new documents and the selected worktree under `## Bound input files` with no materializer change. Entry directories are `kind-agent-sha8` plus the repository path, so three agents sharing `.code-reviews/issue-<n>/comparison.md` do not overwrite one file.
- `PINNED_INPUT_KINDS` in `src/runLoop.ts` is `implementation`, `revision`, and `prior-revision`. Change-scope diffs stay on the selected product pin. Ballot and comparison commits are not diffed.
- Test fixtures already in `test/runLoop.test.ts`: `fixture`, `cursorsStateSchema`, `publishedBallotBatchFixture`, `acceptedResponseFixture`, and `gitShaFixture`. The batch fixture's response ids match `acceptedResponseFixture` defaults, which is what `publishedBallotBatch` requires.
- `artifactScaffoldValue` and `computeInputSetHash` in the existing `test/orderScaffold.test.ts` case "offers a request without a product pin and keeps revision ancestry separate".

`consensusBallotInputs` labels comparison ballots `consensus-ballot` because that is the kind the materializer already exports. The repository path distinguishes them from later-round `.code-reviews/issue-<n>/consensus-ballot-<agent>-round-<n>.json` files. A new `comparison-ballot` kind is not added.

## Tests

Focused commands while developing:

```sh
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/orderScaffold.test.ts
pnpm exec vitest run --config vitest.e2e.config.ts test/integration.test.ts
```

The commit hook owns `pnpm check:fast`. Do not duplicate it immediately before committing. The coordinator owns final `pnpm check`.

- Join `test/runLoop.test.ts` in the "third revision closeout" describe, beside "binds the previous published ballots for revision round %s". New case: "binds comparison ballots and comparisons on revision round 1". Seed an active roster of two, an accepted implementation whose agent and productPin match derived.implementationSelection, an accepted R5.compare submission per active agent (path `.code-reviews/issue-1/comparison.md`, distinct submissionSha, no productPin), matching R5.compare-ballot accepted responses, and one published comparison-ballot-batch for that roster. Expect deriveBoundInputs for revise round 1 to equal the implementation pin, then one consensus-ballot per batch.responses entry (commitSha = batch commit, path = that response's batch path), then one review per accepted comparison (commitSha = that comparison's submissionSha). On current code this returns only the implementation, so the case fails before the binder change and passes after. In the same case, clear `ballotBatches` and expect the implementation plus the reviews and no ballots. Do not alter the rounds 2 and 3 expectations.
- Join `test/orderScaffold.test.ts`. New case: "keeps round-1 basedOn on the selected implementation pin". Pass `artifactScaffoldValue` a revise round-1 context whose inputs are one `implementation`, two `consensus-ballot` entries, and two `review` entries. Expect `basedOn` to be a one-element array of the implementation `commitSha`, and `inputSetHash` to equal `computeInputSetHash` of that full list. `revisionProductInputs` already implements this filter, so the case is green on the current scaffold. It fails if `basedOn` is mapped from every bound `commitSha`. The red-before proof of the issue is the runLoop case above; this case locks ancestry once those extra inputs exist.
- Update `test/integration.test.ts` in the consensus canary, not as a new file. `activeAfterDrop` is three agents, so round-1 revise inputs become one `implementation` plus three `consensus-ballot` entries plus three `review` entries. Replace `toHaveLength(1)` with that shape (exactly one `implementation`, and one ballot and one review for each agent in `activeAfterDrop`). Set the submitted `basedOn` to the `commitSha` values of inputs whose kind is `implementation`, not every bound SHA. Leave `inputs` equality across the rejected and approved amendment resumes.

## Alternatives Rejected

- Restoring R5.reviser-auth. The authorization step stayed deleted on purpose. Only the ballot and comparison binding comes back, inside the existing round-1 branch.
- A new bound kind for comparison ballots, plus an addition to `MATERIALIZED_MARKDOWN_KINDS`. The issue asks for `consensusBallotInputs`, which is already materialized. A new kind would be cited in the input list and absent from `## Bound input files`.
- Binding comparisons as a new comparison kind, or with usePin. review is the materialized markdown kind the issue names. usePin would cite productPin when present, and comparison.md is not on the product pin.
- Putting ballot or comparison SHAs into `basedOn`. Ancestry stays one product parent. The scaffold filter already enforces that.
- Letting the reviser `git show` peer branches. The shell guard refuses that, which is the observed stall.

## Risks and Mitigations

- Comparison ballots are labeled `consensus-ballot`. The action text uses that kind string. Paths remain `.code-reviews/issue-<n>/ballot-<agent>.json`. Later rounds never read the round-1 branch, so their R6.ballot bindings stay the previous consensus batch only. Follow-up's "your published final ballot" check reads follow-up inputs, not revise inputs.
- A missing published comparison batch yields no ballots. The machine only orders revise after implementation selection, and that derivation already requires a published comparison batch whose roster matches the active roster. The new test covers the empty-batch result so a mismatch cannot invent ballots.
- Round-1 `inputSetHash` changes because the hash covers every bound input. The scaffold fills the new hash. An artifact that still hashes only the implementation pin is rejected by the existing input-hash check.
- The e2e canary submits `basedOn` from every input SHA and expects a single input. Leaving it unchanged makes revise round 1 fail closed (`revision basedOn pins do not equal bound inputs` and the one-pin rule). The integration update is part of this change.
- Shared comparison.md paths. Materializer entry directories include kind, agent, and sha prefix, so the packet keeps one file per agent.

## Conclusion

Round 1 of revise will bind the selected implementation, every active agent's published comparison ballot, and every accepted comparison, and will materialize those documents through the existing markdown and pin kinds. `basedOn` stays the selected implementation pin. Rounds 2 and later stay as they are. No new files.
