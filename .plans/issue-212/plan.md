# Issue 212: bind prior-round ballots into revision actions

Protocol version: 1. Baseline: `3b09828c41afb14f3366f2f35f54e7337ec93e26`.

The issue asks revision rounds 2 and 3 to supply the previous round's published
ballot feedback, using the binding mechanism already used by R6.follow-up.
Currently R6.revise binds only the previous product revision. Adding ballot
citations alone would also make revision validation reject every submission:
both its scaffold and validator currently treat all bound inputs as product
parents. The implementation must distinguish feedback from product ancestry
and export the feedback so an agent following its bound-file instructions can
read it.

## Exact File List to be changed or deleted

- `src/runLoop.ts`: extend the round-2+ branch of deriveBoundInputs with the
  immediately preceding round's canonical published consensus ballots. Keep
  the existing prior-revision inputs first; reuse publishedBallotBatch and the
  response/path mapping used by R6.follow-up.
- `src/materializedInputs.ts`: add consensus-ballot to the existing document
  kind allowlist so the bound JSON artifacts are exported into input packets.
- `src/evidence.ts`: select authorized revision product pins separately from
  feedback; use that selection for basedOn equality, single-parent enforcement,
  ancestry, and the approved-path comparison.
- `src/orderScaffold.ts`: use the same product-pin selection for revision-ready
  basedOn while retaining the complete input set in inputSetHash.
- `test/runLoop.test.ts`: cover round-specific binding, canonical batch
  selection, and readable ballot files in rendered revision actions using the
  existing run-loop and materialization fixtures.
- `test/evidence.test.ts`: extend revision evidence coverage for a product
  parent accompanied by ballot feedback, including rejection boundaries.
- `test/orderScaffold.test.ts`: extend the existing revision ancestry test to
  assert that feedback affects inputSetHash but does not enter basedOn.

No files will be deleted.

## Exact file list to be created

No product, test, fixture, or dependency files are needed. This planning action
creates only `.plans/issue-212/plan.md`, the coordinator-requested artifact;
implementation extends the existing files listed above.

## Reuse and Scope

Reuse deriveBoundInputs, acceptedAt, inputFromSubmission, and
publishedBallotBatch in `src/runLoop.ts`. For R6.revise with round greater than
one, compute previousRound as round minus one and request
publishedBallotBatch(cursors, "R6.ballot", previousRound). Append one BoundInput
per response in that batch, with the response's agent, the batch's commitSha,
the corresponding batch.paths entry, and kind consensus-ballot. Include all
ballots in the batch, including approvals, so the exact published review set
is available. Do not use private response paths or response digests as Git
commit pins. Preserve round 1 and null-as-round-1 behavior.

The existing selector already requires a published batch for the requested
round, a matching active roster, and matching accepted response action IDs and
digests. Reuse those checks rather than selecting the newest batch or reading
raw responses. If no matching published batch exists, append no ballot inputs;
retain the existing product-input selection and never substitute another round
or an unpublished batch. The normal transition already waits for publication
in `src/machine.ts`; this issue does not add a new workflow gate or alter drop,
retry, escalation, or follow-up semantics.

Add one small shared revisionProductPins helper in `src/evidence.ts`, consumed
there and by `src/orderScaffold.ts`, which already imports evidence utilities.
Select only implementation and prior-revision inputs, the two product kinds
deriveBoundInputs supplies to R6.revise, and map them to their commit SHAs.
This shared helper is justified by the scaffold/validator agreement requirement;
it needs no new module or generic input-classification framework. Do not
deduplicate product entries: zero or multiple authorized product inputs must
still fail validation. Continue to require exactly one matching basedOn pin,
descent from it, approved changes relative to it, and immutable phase separation.
The existing computeInputSetHash must continue hashing every bound input,
including every ballot citation. Feedback is evidence, not a second ancestry
base or permission to change additional files.

Reuse MATERIALIZED_MARKDOWN_KINDS and materializeBoundInputs in
`src/materializedInputs.ts`; that allowlist already includes JSON amendment
artifacts despite its name. Add only consensus-ballot. Existing packet hashing,
mirror readBlob, manifests, file digests, read-only copies, cache validation, and
omission handling then apply without a new exporter. Reuse BoundInput and
MaterializedInputs from `src/steps.ts`, and the generic input and bound-file
rendering in `src/action.ts` without modifying their types or renderer.

Reuse fixture, acceptedResponseFixture, publishedBallotBatchFixture,
cursorsStateSchema, and the readingMirror helper in `test/runLoop.test.ts`.
Reuse order, mirror, and sha in `test/evidence.test.ts`, and
artifactScaffoldValue/renderArtifactScaffold in the existing scaffold tests.
There are no new dependencies, state/schema migrations, configuration changes,
hook edits, or version bumps. Only this plan is published in the current action.

## Tests

Use a few regression cases in the existing suites:

1. In `test/runLoop.test.ts`, parameterize revision binding over rounds 2 and 3.
   Seed the previous product revision and a matching published batch containing
   both approve and revise feedback, plus another round's batch. Assert the
   exact inputs contain the previous product pin followed by all and only the
   previous round's canonical ballot commit/path pairs. Include round 1 and
   null controls asserting the selected implementation remains the sole input.
   These round-2/3 expectations fail before the change.
2. In the same test file, vary batch eligibility using the existing fixtures:
   pending/failed/invalidated publication, wrong round, stale roster, and stale
   response identity must not supply feedback; a matching published batch
   alongside a stale candidate must be selected. Missing batches must not
   invent citations. Reuse the existing selector rather than retesting its
   implementation independently.
3. In the existing materialized-bound-inputs tests in `test/runLoop.test.ts`,
   derive round-2 revision inputs, materialize them with the existing mirror
   fixture, and render/write an action using buildOrder and writeAction. Assert
   the action cites every canonical ballot and lists its existing absolute file
   path; reading each file must return the published JSON including rationale,
   with the matching manifest digest. Retain the product worktree. Exercise an
   unreadable ballot with the product worktree still present and assert the
   existing omission note preserves the pinned-read fallback. Before the fix,
   the ballot files are silently absent from materialization.
4. In `test/orderScaffold.test.ts`, extend the revision ancestry case with a
   prior-revision and two consensus ballots sharing one batch commit. Assert
   basedOn contains only the product pin and inputSetHash equals the hash of the
   entire input set; replacing a ballot citation changes that hash. Retain the
   implementation-only control. The mixed-input case fails before the fix.
5. In `test/evidence.test.ts`, extend the revision-lineage test with round-2/3
   mixed inputs. A signal with the full input hash and only the product pin in
   basedOn must pass even when the ballot evidence commit is not an ancestor
   of the revised product. Verify ancestry and changed-path checks use the
   product parent. Reject a product-only/stale input hash, basedOn containing
   the ballot SHA, zero or multiple product parents, unrelated product ancestry,
   out-of-map changes, and post-pin product edits. Keep the existing round-1
   case. The valid mixed-input case is rejected before the fix.

Focused implementation command, confirmed against the package scripts and
Vitest configuration:

```sh
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/evidence.test.ts test/orderScaffold.test.ts
```

The current configured product commit hook owns `pnpm run check:fast` (lint,
typecheck, fast tests, and system tests); do not duplicate it immediately before
committing. The configured product push hook owns `pnpm run test:e2e`. The frozen
issue start declares coordinator final check
`pnpm run check`, which runs build, check:fast, and e2e. These are future
implementation/coordinator checks, not checks claimed for this planning action.
For this evidence-only plan publication, validate all required headings have
non-empty bodies, the exact seven-file map is extractable, and every new test
has an existing destination; let the evidence-only hooks validate publication.

## Alternatives Rejected

- Binding only the prior product revision leaves the requested feedback
  inaccessible to an agent constrained to the action's inputs.
- Adding ballots without changing basedOn handling makes every later revision
  fail the existing exactly-one-product-pin rule and suggests false ancestry.
- Rendering feedback as unbound prose or reading private responses bypasses
  the canonical published batch and its exact input hash.
- Binding ballots without exporting them leaves an action with a product
  worktree and a bound-file section that can block pinned reads of the omitted
  ballots. Adding the existing document kind closes that gap directly.
- A new schema, separate feedback store, or generic classification subsystem
  adds unnecessary interfaces when existing BoundInput records, packet export,
  and rendering already support this evidence.

## Risks and Mitigations

- Wrong-round or stale feedback could guide a revision against a superseded
  review. Select exactly previousRound through publishedBallotBatch and test
  stale candidates alongside a valid batch.
- Feedback commits may have independent evidence-branch history. Restrict
  ancestry and change-scope checks to the one authorized product input and
  retain full-set hashing so feedback cannot be silently omitted or swapped.
- Existing code could accidentally classify JSON ballots as nonmaterializable.
  Cover the complete derivation/export/render/read path and the existing
  unreadable-document fallback, rather than only testing an input array.
- The producer and validator could disagree on basedOn after the new inputs
  are added. Use their shared selection helper and test both valid mixed inputs
  and unauthorized ancestry, preserving existing round-1 behavior.

## Conclusion

Change seven existing files to give revision rounds 2 and 3 the previous
round's published, readable ballot feedback while preserving the single
authorized product parent, full evidence hashing, and approved file scope.
No additional product files or dependencies are required.
