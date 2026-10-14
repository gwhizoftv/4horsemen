# Review of Plans for Issue 212

This review examines the bound plans for issue 212:
- Claude: `6d5e64afa09bd489cf54653e35bdf47fbb4334c5` at `.plans/issue-212/plan.md`
- Codex: `8648fd54c3ee81799d16ac745086b78a0b368e44` at `.plans/issue-212/plan.md`
- Cursor: `9d37c3f9db5c3b25ffe2f7bdb1cfd17880288ef9` at `.plans/issue-212/plan.md`
- Antigravity: `0fa218a0ff2dddff8161e070744abd8384bde180` at `.plans/issue-212/plan.md`

## Findings

### Finding 1: Unnecessary documentation expansion in Cursor plan
- Plan claim or section: Cursor's `## Exact File List to be changed or deleted` lists `docs/coord-driver.md`.
- Rule that must hold: Implementation discipline requires keeping changes strictly within the issue and making the smallest change that fully solves it without extraneous file modifications.
- Concrete failure: Modifying `docs/coord-driver.md` expands the approved file map beyond code and test files into documentation, creating mixed-profile verification requirements and unnecessary modification risk for a driver runtime bug.
- Smallest correction: Remove `docs/coord-driver.md` from the file list and constrain changes to `src/runLoop.ts`, `src/materializedInputs.ts`, `src/evidence.ts`, `src/orderScaffold.ts`, and their corresponding test files.

### Finding 2: Missing ballot batch fallback in Antigravity plan
- Plan claim or section: Antigravity's `## Reuse and Scope` and `## Risks and Mitigations` state that if `batch === null`, `deriveBoundInputs` returns `[]`.
- Rule that must hold: A round-2+ revision order must always have an authorized product parent pin (`prior-revision`) so the reviser has a base to branch from and satisfy the single authorized product pin rule.
- Concrete failure: If a published ballot batch cannot be resolved (for instance during active roster divergence), returning an empty array drops the product parent pin, causing the subsequent revision artifact to be rejected with "revision must be based on exactly one authorized product pin".
- Smallest correction: When `publishedBallotBatch` returns `null`, return `priorRevisions` without ballot entries, preserving the product parent pin.

### Finding 3: Alignment and strengths of Claude and Codex plans
- Plan claim or section: Claude (`6d5e64afa09bd489cf54653e35bdf47fbb4334c5`) and Codex (`8648fd54c3ee81799d16ac745086b78a0b368e44`).
- Rule that must hold: The plan must stay within the issue, reuse existing code and test support, justify every file, and propose focused tests.
- Evaluation: Both Claude and Codex identify the exact minimal set of seven files (`src/runLoop.ts`, `src/materializedInputs.ts`, `src/evidence.ts`, `src/orderScaffold.ts`, `test/runLoop.test.ts`, `test/evidence.test.ts`, `test/orderScaffold.test.ts`), correctly export `consensus-ballot` artifacts to disk, filter `consensus-ballot` out of `basedOn` in scaffold and validator, and add targeted regression tests.

## Conclusion

The consensus architecture across all plans is clear:
1. Extend `deriveBoundInputs` in `src/runLoop.ts` for `R6.revise` when `(round ?? 1) > 1` to append the previous round's consensus ballots from `publishedBallotBatch`, falling back to `prior-revision` alone if the batch is null.
2. Add `"consensus-ballot"` to `MATERIALIZED_MARKDOWN_KINDS` in `src/materializedInputs.ts` so ballot JSON files are materialized under `inputs/<hash>/` and listed in bound input files.
3. Update `src/evidence.ts` and `src/orderScaffold.ts` so `basedOn` includes only product parents while `inputSetHash` covers all bound inputs.
4. Add focused tests in `test/runLoop.test.ts`, `test/evidence.test.ts`, and `test/orderScaffold.test.ts`.

Claude's plan (`6d5e64afa09bd489cf54653e35bdf47fbb4334c5`) and Codex's plan (`8648fd54c3ee81799d16ac745086b78a0b368e44`) are both fully actionable and well-specified. Claude's plan is recommended for selection.
