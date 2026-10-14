# Issue 212 — Bind the previous ballot batch on later revisions

Round 1 of `R6.revise` keeps binding only the selected implementation. Round 2 and later must also bind the previous round's published consensus ballot batch, using the same citation `R6.follow-up` already uses, and export those ballot files so the reviser can read them under the bound-input rule. `basedOn` stays the single product parent.

## Exact File List to be changed or deleted

- `src/runLoop.ts`
  - In `deriveBoundInputs`, when `stepId` is `R6.revise` and `round` is greater than 1, keep the existing previous-round `prior-revision` product pin and append one `consensus-ballot` input per response in `publishedBallotBatch(cursors, "R6.ballot", round - 1)`.
  - Cite each ballot the way `R6.follow-up` does today: `agent` from the batch response, `commitSha` from `batch.commitSha`, `path` from `batch.paths` at the same index, `kind` `consensus-ballot`.
  - Share that mapping in one private helper used by both `R6.follow-up` and `R6.revise`. If `paths[index]` is missing, skip that response instead of citing an empty path.
  - When that published batch does not resolve, leave the `prior-revision` pin in place and add no ballot citations. Do not read private `acceptedResponses` in place of the batch.
  - Round 1 stays the selected implementation pin only.
- `src/evidence.ts`
  - Export a small filter, used by the `revision-pinned` check, that keeps only bound inputs of kind `implementation` or `prior-revision`.
  - `basedOn` equality and the "exactly one authorized product pin" rule, plus ancestry and the approved-path diff, apply to that product parent only. `consensus-ballot` evidence commits are not product parents.
  - `inputSetHash` continues to cover every bound input, including the ballots.
- `src/orderScaffold.ts`
  - `R6.revise` `basedOn` lists only the commit SHAs from that same product-parent filter. The scaffold `inputSetHash` still hashes the full input list.
- `src/materializedInputs.ts`
  - Add `consensus-ballot` to `MATERIALIZED_MARKDOWN_KINDS` so each bound ballot JSON is copied into the input packet and listed under `## Bound input files`. Do not add it to `MATERIALIZED_PIN_KINDS` or `PINNED_INPUT_KINDS`.
- `docs/coord-driver.md`
  - Replace the Profiles sentence that says later rounds bind only the preceding accepted revision. State that round 1 binds only the selected implementation, and later rounds bind that preceding revision as the single product parent and also bind the previous round's published consensus ballot batch.
- `test/runLoop.test.ts`
- `test/evidence.test.ts`
- `test/orderScaffold.test.ts`

## Exact file list to be created

None. No new source, test, or schema file. The ballot citation helper stays private in `src/runLoop.ts`. The product-parent filter stays in `src/evidence.ts`, which `orderScaffold.ts` already imports.

## Reuse and Scope

- Reuse `publishedBallotBatch` for `R6.ballot` at `round - 1`. It already requires a published batch whose roster, action ids, and response digests match the current active roster. That is the same resolver `computeConsensusDerived` and `R6.follow-up` use. Do not add a second lookup that accepts a stale or unpublished batch.
- Reuse the follow-up citation shape (`agent`, `batch.commitSha`, `batch.paths[index]`, kind `consensus-ballot`) via the shared helper. `R6.follow-up` itself keeps binding the final revision pin plus that batch; this change only stops the two call sites from drifting.
- Reuse `inputFromSubmission(..., "prior-revision", true)` for the previous revision's product pin, and the round-1 `implementation` pin path unchanged.
- Reuse `computeInputSetHash` from `src/evidence.ts` for the revision artifact. Ballot inputs change that hash because they are part of the bound set. Reuse the packet writer in `materializeBoundInputs`; adding the kind is what puts the JSON on disk. An unreadable blob stays an omission and keeps the existing `git show <sha>:<path>` fallback.
- Reuse `revisionReadyArtifactSchema`. `basedOn` remains an array of SHAs with at least one entry. No cursor, ballot-batch, or protocol field is added.
- Leave `candidateResultsFor` as it is. It attaches check results by product pin, and ballot citations use the evidence commit, not that pin.
- Leave the machine's advance rule as it is. Round 2+ is already reached only after the previous ballot step has a published batch.
- The amendment paragraph that says revision `basedOn` is still the single authorized product parent stays true and is not rewritten.
- `test/integration.test.ts` only revises round 1 and then approves. It does not need a second-round path.

## Tests

These cases fail on the current tree: a round-2 revise order has no `consensus-ballot` inputs, a revision whose `basedOn` is only the product pin is rejected once ballot commits are also bound, and a `consensus-ballot` input is not written into an input packet.

- `test/runLoop.test.ts`, beside the existing follow-up binding case that expects two `consensus-ballot` inputs: build an `R6.revise` round-2 order whose previous round has one accepted revision and a published consensus batch for the active roster. Assert the inputs are that `prior-revision` product pin plus one `consensus-ballot` per roster member, each using `batch.commitSha` and the matching `batch.paths` entry. Assert round 1 is still only the selected implementation pin. Assert a round-2 cursor with no published batch keeps the `prior-revision` pin and has no `consensus-ballot` input. In the existing "materialized bound inputs" describe, one `consensus-ballot` document is written into the packet and recorded in the manifest.
- `test/evidence.test.ts`, in the existing revision-lineage test: a round-2 order whose inputs are one `prior-revision` pin plus `consensus-ballot` rows is satisfied when `basedOn` is only that product pin and `inputSetHash` is `computeInputSetHash` of the full list. The same artifact is rejected when `basedOn` also contains the ballot batch commit, with the single-product-pin failure.
- `test/orderScaffold.test.ts`, in the existing revise scaffold test: when the context also carries `consensus-ballot` inputs, `basedOn` is only the product-parent SHA and the rendered `inputSetHash` matches the full input list.

Focused command while developing:

```sh
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/evidence.test.ts test/orderScaffold.test.ts
```

The product commit hook owns `pnpm check:fast`. Do not run that full suite a second time immediately before committing.

## Alternatives Rejected

- Putting ballot batch SHAs into `basedOn`. The evidence commit is not the product parent. Ancestry and the approved-path diff would run against the evidence branch, and the single-pin rule would reject the revision.
- Binding the ballots in the action list without adding `consensus-ballot` to `MATERIALIZED_MARKDOWN_KINDS`. The `prior-revision` worktree already fills `## Bound input files`. Once that section is complete, the git shim refuses `git show <40-hex>:<path>`, so the ballot bytes would be neither on disk nor readable by pin.
- Reading private `acceptedResponses` instead of the published batch. Follow-up does not do that. Those responses are not a commit the reviser is allowed to open, and they can differ from the published batch.
- Returning no inputs when the previous batch is missing. That drops the product parent and makes every round-2 revision fail the single-pin check during a roster mismatch. The pin stays; ballots are omitted until `publishedBallotBatch` resolves.
- A new module or a new bound kind. `consensus-ballot` and the document packet already exist.

## Risks and Mitigations

- A drop that changes the active roster makes `publishedBallotBatch` ignore the previous round's batch, same as follow-up. The revise order then has the product parent and no ballots until a batch matches the current roster. This change does not republish old batches.
- Round-2+ `inputSetHash` values change because the bound set grows. A revision-ready artifact must echo the hash from its own action. In-flight actions keep their issued hash until the coordinator prepares a new order.
- Follow-up actions that already bind `consensus-ballot` inputs start exporting those files too. Their evidence hash does not change; only the packet contents do. The existing follow-up test that expects one ballot citation per roster member guards the shared helper.
- A ballot blob the mirror cannot read is omitted, and the action keeps the incomplete-export line so `git show <sha>:<path>` stays available for that file. Preparation does not fail.

## Conclusion

Round 2 and later revise orders bind the previous published consensus ballot batch with the follow-up citation, export those files as bound documents, and still require `basedOn` to be the single previous product pin. Round 1 is unchanged.
