# Implementation Plan - Supply Ballots from Previous Round to Reviser in R6.revise

## Exact File List to be changed or deleted

- `src/runLoop.ts`
- `src/materializedInputs.ts`
- `src/evidence.ts`
- `src/orderScaffold.ts`
- `test/runLoop.test.ts`
- `test/orderScaffold.test.ts`
- `test/evidence.test.ts`

## Exact file list to be created

No new files will be created. All changes will be made to existing source and test files.

## Reuse and Scope

The implementation strictly reuses existing infrastructure and data structures:
- In `src/runLoop.ts`:
  - `publishedBallotBatch`: reuses existing helper to lookup the published BallotBatch for R6.ballot in round (round - 1).
  - `acceptedAt`: reuses existing query to retrieve the prior revision submission from round (round - 1).
  - `inputFromSubmission`: reuses existing mapper to construct product pin bound input.
  - `deriveBoundInputs`: updates R6.revise when (round ?? 1) > 1 to bind both prior-revision and consensus ballots from the published ballot batch, matching the pattern established in R6.follow-up.
- In `src/materializedInputs.ts`:
  - `MATERIALIZED_MARKDOWN_KINDS`: reuses the set of document kinds materialized to disk, adding "consensus-ballot" so that peer ballots are exported as read-only files under the issue runtime and presented in the action bound input files section.
- In `src/evidence.ts`:
  - `evaluateEvidence`: reuses the revision-pinned verification logic, filtering order.inputs to exclude consensus-ballot when determining expectedPins for product lineage checks (basedOn, isAncestor, diff path validation).
- In `src/orderScaffold.ts`:
  - `artifactScaffoldValue`: reuses scaffold generation for R6.revise, filtering ctx.inputs to exclude consensus-ballot from basedOn so that the revision scaffold cites only the product pin while withHash hashes all bound inputs.
- In existing test files:
  - Reuses test fixtures fixture, readingMirror, publishedBallotBatchFixture, order, and evaluateEvidence across test/runLoop.test.ts, test/orderScaffold.test.ts, and test/evidence.test.ts.

No new dependencies, abstractions, or files are introduced.

## Tests

The following focused tests will be added to existing test files:
1. `test/runLoop.test.ts`:
   - In deriveBoundInputs suite: verify that for R6.revise with round 2, deriveBoundInputs returns both the prior revision (kind "prior-revision") and the ballots from the published consensus ballot batch of round 1 (kind "consensus-ballot"). Fails before the change because deriveBoundInputs only returns prior-revision.
   - In materialized bound inputs suite: verify that materializeBoundInputs exports inputs with kind "consensus-ballot" to disk as read-only files and lists them in the packet manifest. Fails before the change because MATERIALIZED_MARKDOWN_KINDS omits consensus-ballot.
2. `test/orderScaffold.test.ts`:
   - In orderScaffold suite: verify that when stepId is R6.revise and ctx.inputs contains both a prior revision and consensus ballots, the generated scaffold populates basedOn with only the product pin commit SHA (excluding ballot commit SHAs), while inputSetHash covers all bound inputs. Fails before the change because basedOn includes all input commit SHAs.
3. `test/evidence.test.ts`:
   - In evaluateEvidence suite: verify that evaluateEvidence accepts a revision-ready artifact for R6.revise round 2 where order.inputs contains both a product pin and consensus-ballot inputs, with artifact basedOn naming only the product pin. Fails before the change because expectedPins length check rejects the revision when multiple inputs are bound.

## Alternatives Rejected

- Direct peer branch fetching or Git show by the reviser: Rejected because the protocol strictly isolates agents from peer clones and git operations (git status, git diff, and un-materialized git show are blocked by shell guards). All needed artifacts must be bound and materialized directly by coord into the action runtime.
- Introducing a separate input kind (such as "revision-ballot"): Rejected because publishedBallotBatch already stamps R6.ballot batches as "consensus-ballot-batch" and produces "consensus-ballot" responses, which R6.follow-up already consumes under kind "consensus-ballot". Reusing "consensus-ballot" preserves uniformity.
- Materializing ballot batches as git worktrees: Rejected because ballots are individual JSON documents, not source trees. Materializing them as read-only documents under MATERIALIZED_MARKDOWN_KINDS is lightweight and fast.
- Including ballot commit SHAs in basedOn: Rejected because basedOn in revision-ready specifies the product Git ancestry parent that the product branch descends from. Ballot batches live on coordination branches or mirrors and cannot be product Git ancestors.

## Risks and Mitigations

- Missing ballot batch if deriveBoundInputs is called when round 1 ballot batch is not yet published: Mitigation: deriveBoundInputs checks batch === null or priorRevisions length === 0 and returns empty array, preventing partially-bound orders. In addition, the state machine ensures that R6.ballot must publish its ballot batch before transitioning to R6.revise round 2+.
- Existing evidence verification for revision-ready expecting order.inputs to only contain product pins: Mitigation: Update evidence.ts and orderScaffold.ts to filter out consensus-ballot from expectedPins for basedOn ancestry validation, while keeping inputSetHash validation across the entire bound input set.
- Disk usage and materialization overhead: Mitigation: Ballot files are tiny JSON files (a few hundred bytes). Content-addressed packet storage in inputs ensures deduplication.

## Conclusion

By updating deriveBoundInputs in src/runLoop.ts to bind the previous round ballot batch when (round ?? 1) > 1, adding consensus-ballot to MATERIALIZED_MARKDOWN_KINDS in src/materializedInputs.ts, and ensuring evidence.ts and orderScaffold.ts distinguish product parent pins from evidence inputs in basedOn, the reviser in rounds 2 and 3 will receive and inspect peer ballots directly from bound input files in compliance with the coordination protocol.
