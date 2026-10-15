# Issue 220 plan review

Reviewed the coordinator-exported plans at these exact pins:

- Claude: `c9ff31f8c9eb3a4b913519f0cb97f9001bb09efa`.
- Codex: `c8f9ad31a0a575c4fea3f57c77eabd89f1eb4fc2`.
- Cursor: `d5e5c507f775d4ff141eff9e64551cbb8a32879d`.

## Findings

1. **[P2] Claude and Codex: the exact file maps omit a required integration-test
   update.** Both plans' "Exact File List to be changed or deleted" and "Tests"
   sections limit changes to the binder, documentation, and two unit-test
   files. The approved map must include the existing tests whose assumptions
   the requested behavior invalidates, so implementation can pass the required
   e2e checks without changing unapproved files. Following either four-file
   plan produces seven round-1 inputs in the three-active-agent consensus
   canary, but `test/integration.test.ts:408` still asserts
   `toHaveLength(1)`. Even after that assertion is corrected, line 436 submits
   every input SHA as `basedOn`, including the ballot and comparison commits.
   `src/evidence.ts:367` derives only the selected product pin and rejects that
   artifact, preventing the expected transition to `R6.ballot` at
   `test/integration.test.ts:442`. Thus the required `test:e2e` suite and final
   `check` cannot pass within either published map. Add
   `test/integration.test.ts` to both maps and update the existing canary to
   assert one selected implementation plus one ballot and comparison per active
   agent, and submit only the selected implementation pin in `basedOn`.
   Preserve the input-equality assertions across amendment resumes. Cursor's
   plan already includes these exact changes.

No blocking findings in Cursor's plan. Its five-file scope covers the required
production behavior and the existing canary affected by it. All three plans
correctly reuse `publishedBallotBatch`, `consensusBallotInputs`, `acceptedAt`,
and `inputFromSubmission`; preserve the selected-implementation guard; and
leave later-round binding intact. Their `review` and `consensus-ballot` kinds
are already materialized, and `revisionProductInputs` already keeps both kinds
out of product ancestry. The different ordering of the two feedback groups in
Claude's plan has no bearing on those invariants.

All three plans stay within issue 220 and introduce no product files,
dependencies, or new abstractions requiring justification. Cursor and Claude
reuse existing fixture support for their focused binding test and keep the
scaffold test small. Their scaffold case is explicitly an already-passing
ancestry guard; their derived-input regression supplies the failing-before
evidence for the missing feedback. Codex adds direct coverage of published
action paths and document bytes, but also duplicates binding-state setup in the
scaffold suite. That additional coverage does not resolve its omitted canary
file. Cursor's update to the existing canary is a necessary compatibility
change, not scope expansion.

Verification for this review: read all three exported plans and the relevant
binder, publication matching, materializer, scaffold, evidence-validation,
integration-test, and package-script code. The canary failure above follows
directly from its existing assertions and submitted artifact. No product suites
were run and no unimplemented regression tests are claimed as passing.

## Conclusion

Recommend Cursor's plan at
`d5e5c507f775d4ff141eff9e64551cbb8a32879d`. It includes the required
integration-test repair while retaining the minimal production change and
existing ancestry/materialization helpers. Claude's and Codex's plans need the
integration-test file and its concrete changes added before implementation can
complete within their approved maps.
