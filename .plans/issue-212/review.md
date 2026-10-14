# Plan review — issue 212

Reviewed the bound plans at the cited pins. Line references below are the current tree.

## Findings

### Cursor `9d37c3f9db5c3b25ffe2f7bdb1cfd17880288ef9` — Tests

The Tests section says a round-2 artifact whose `basedOn` also contains the ballot batch commit is rejected "with the single-product-pin failure."

The single-pin rule is `expectedPins.length !== 1` in `src/evidence.ts`, and that array is the filtered product-parent set. Extra SHAs in `basedOn` fail the earlier equality check, `revision basedOn pins do not equal bound inputs`. They do not change `expectedPins.length`.

Followed as written, the new test looks for `revision must be based on exactly one authorized product pin` after the filter the plan adds. A correct implementation leaves that length at 1, so the test stays red.

Assert the equality failure for a `basedOn` that includes the ballot commit. Use a separate artifact with zero or two `implementation` / `prior-revision` inputs for the single-pin failure.

### Antigravity `0fa218a0ff2dddff8161e070744abd8384bde180` — Risks and Mitigations

The Risks section says `deriveBoundInputs` returns an empty array when `batch === null` or the prior-revision list is empty, "preventing partially-bound orders."

A round-2+ revise still has exactly one authorized product parent: the previous revision pin. Ballot citations are additive. `publishedBallotBatch` can return null after a roster change even though that pin is still accepted. The machine's publish-before-advance rule does not keep the batch resolvable for the life of the revise step.

Followed as written, a null batch drops the product parent. The order lists no inputs, and every revision-ready artifact fails `revision must be based on exactly one authorized product pin`. The same clause also drops a resolved ballot batch when the prior-revision list is empty.

Keep the `prior-revision` pin whenever it exists, and append `consensus-ballot` citations only when `publishedBallotBatch` for `round - 1` resolves. Return an empty list only when both are absent.

### Claude `6d5e64afa09bd489cf54653e35bdf47fbb4334c5`, Codex `8648fd54c3ee81799d16ac745086b78a0b368e44`, and Antigravity `0fa218a0ff2dddff8161e070744abd8384bde180` — file lists

Each file list changes `src/runLoop.ts`, `src/materializedInputs.ts`, `src/evidence.ts`, `src/orderScaffold.ts`, and the three existing test files. None lists `docs/coord-driver.md`. Claude's scope also says the action text and protocol schemas stay unchanged, and Codex's created-file section says no further product files are needed.

The Profiles paragraph is the operator contract for this binding. It currently says round 1 binds only the selected implementation and later rounds bind only the preceding accepted revision (`docs/coord-driver.md` lines 578–579). The implementation file map is closed, so this sentence cannot be edited under these plans.

Followed as written, the new `deriveBoundInputs` result binds the previous published ballot batch, and the manual still says later rounds bind only the preceding revision.

Add `docs/coord-driver.md` to the changed-file list and replace that sentence so later rounds bind the preceding revision as the single product parent and also bind the previous round's published consensus ballot batch.

## Conclusion

All four plans stay inside the issue, add no new files, and reuse `publishedBallotBatch`, the follow-up `consensus-ballot` citation, `materializeBoundInputs`, and the existing revision-ready schema. Round 1 stays the selected implementation. Ballot commits stay out of `basedOn`, and `consensus-ballot` is exported as a document rather than a product worktree. The focused cases belong in `test/runLoop.test.ts`, `test/evidence.test.ts`, and `test/orderScaffold.test.ts`.

Claude's binding, null-batch behavior, and `basedOn` filter can be implemented as written, aside from the driver sentence. Codex can too; its extra ineligible-batch cases do not fail on the current tree, because round-2 revise does not read batches yet, but they do not contradict the selector. Cursor's binding and doc edit are right, and its rejection test names the wrong error. Antigravity's null-batch mitigation removes the product parent the rest of that plan keeps.
