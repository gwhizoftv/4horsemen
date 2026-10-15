# Issue 220 — plan review

Reviewed bound plans:

- claude `c9ff31f8c9eb3a4b913519f0cb97f9001bb09efa` `.plans/issue-220/plan.md`
- codex `c8f9ad31a0a575c4fea3f57c77eabd89f1eb4fc2` `.plans/issue-220/plan.md`
- cursor `d5e5c507f775d4ff141eff9e64551cbb8a32879d` `.plans/issue-220/plan.md`

All three plans make the same production change: in the round-1 branch of
`R6.revise` in `deriveBoundInputs` (`src/runLoop.ts:626-640`), keep the
selected implementation and append `consensusBallotInputs(publishedBallotBatch(cursors, "R5.compare-ballot", null))`
and `acceptedAt(cursors, "R5.compare")` as `review` inputs. The rounds-2+
branch is unchanged, and each plan updates the doc sentence at
`docs/coord-driver.md:590`. That core is correct. I re-checked it against the
baseline:

- `review` and `consensus-ballot` are both in `MATERIALIZED_MARKDOWN_KINDS`
  (`src/materializedInputs.ts:30`).
- Entry directories are `kind-agent-sha8` (`src/materializedInputs.ts:71`), so
  the shared `.code-reviews/issue-<n>/comparison.md` path does not collide.
- `revisionProductInputs` (`src/evidence.ts:45`) keeps `basedOn` at the single
  implementation pin.
- The existing round-1 assertion at `test/runLoop.test.ts:4222` seeds no
  `R5.compare` / `R5.compare-ballot` state, so it stays green.

The plans differ in their file maps and tests.

## Findings

### F1 — claude and codex plans: file map omits `test/integration.test.ts` (blocking)

- **Plan claim.** The claude plan's "Exact File List to be changed or deleted"
  lists only `src/runLoop.ts`, `docs/coord-driver.md`, `test/runLoop.test.ts`,
  and `test/orderScaffold.test.ts`. The codex plan names the same four files
  and calls them "the exact four-file product map".
- **Rule.** The approved file map must include every file the change forces to
  change. Otherwise the implementer cannot touch it without an amendment
  round, and the coordinator's final `pnpm check` (which runs
  `pnpm test:e2e` → `vitest.e2e.config.ts` → `test/integration.test.ts`) fails
  at the approved pin.
- **Concrete failure.** The consensus canary reaches round-1 `R6.revise` with
  three active agents (`activeAfterDrop`, `test/integration.test.ts:28`). Each
  of those agents has an accepted `R5.compare` (lines 367-369), and there is a
  published `comparison-ballot-batch` (lines 388-392). After the binder change:
  - `test/integration.test.ts:408`, `expect(currentOrder("cursor").inputs).toHaveLength(1)`,
    sees 7 inputs (1 implementation + 3 ballots + 3 reviews) and fails.
  - Past that, `test/integration.test.ts:436` submits
    `basedOn: order.inputs.map((input) => input.commitSha)`, which is seven
    SHAs. The `revision-pinned` check (`src/evidence.ts:367-369`) rejects it
    with "revision basedOn pins do not equal bound inputs" and "revision must
    be based on exactly one authorized product pin". The canary then never
    reaches `R6.ballot`.

  Implemented as written, either plan ships a red e2e suite. If the
  implementer notices, the only way out is a `plan-amendment-request` round
  trip.
- **Smallest correction.** Add `test/integration.test.ts` to the change list.
  Replace line 408 with an exact-shape assertion: one `implementation`, plus
  one `consensus-ballot` and one `review` per agent in `activeAfterDrop`.
  Change line 436 to map only `revisionProductInputs(order.inputs)` (or the
  `kind === "implementation"` inputs) into `basedOn`. Keep the
  `toEqual(revisionBefore.inputs)` assertions at 407/419. The cursor plan
  already specifies exactly this.

### F2 — codex plan, Tests 2: a new full `runTick` action-publication scenario duplicates coverage the canary already gives

- **Plan claim.** Tests item 2 adds a new `test/runLoop.test.ts` scenario. It
  runs `CoordinatorRunLoop.runTick()` to round-1 revise with a `BareMirror`
  stub, then reads the published action's `## Bound input files` and the
  exported bytes.
- **Rule.** Add the fewest focused tests; prefer extending an existing case
  (AGENTS.md "Implementation discipline", and this action's review criteria).
- **Concrete failure.** The binding is fully decided by `deriveBoundInputs`,
  and materialization by kind is already covered by the packet test at
  `test/runLoop.test.ts:3705`. The e2e canary (F1) already drives
  `runTick` to round-1 revise with real comparisons and a published comparison
  batch. Under codex's plan it is left asserting the old shape (F1). The
  result is a second, heavier fixture with more mirror stubbing to maintain,
  while the real end-to-end path stays wrong.
- **Smallest correction.** Drop Tests 2. Put the action-level assertion into
  the existing canary update from F1, or assert
  `materializeBoundInputs(...).omitted` is empty over the derived round-1
  inputs inside the single new `runLoop.test.ts` case (the claude plan's
  approach).

### F3 — codex plan, Tests 3: deriving inputs inside `test/orderScaffold.test.ts` duplicates the binder test

- **Plan claim.** The `orderScaffold` case builds "a small in-memory
  two-agent state" and calls `deriveBoundInputs`, so that the scaffold test
  "fails before the binding fix".
- **Rule.** A unit test should exercise the unit it names. Fails-before
  evidence belongs to the test of the changed function, and one red-before
  test is enough.
- **Concrete failure.** This couples `orderScaffold.test.ts` to run-loop
  cursor state (`cursorsStateSchema`, implementation selection, ballot
  batches, roster) to re-prove the same binding as Tests 1. A later change to
  cursor-state shape then breaks a scaffold test whose subject
  (`artifactScaffoldValue` → `basedOn`) did not change. This is
  non-blocking: it adds fixture weight without adding a defect signal.
- **Smallest correction.** Keep the scaffold case on hand-written round-1
  inputs (implementation + ballots + reviews → `basedOn` = `[pin]`) as a
  declared regression guard, as the claude and cursor plans do. Leave
  red-before evidence to the `runLoop.test.ts` binder case.

### F4 — cursor plan: no defects found

The cursor plan covers the same production change as the other two. It also:

- correctly lists and specifies the `test/integration.test.ts` canary update
  (F1);
- keeps one focused fails-before case in the existing `third revision
  closeout` describe, plus the `ballotBatches`-cleared sub-assertion;
- keeps the scaffold case as an explicitly declared green-before guard;
- creates no files;
- justifies reusing `consensus-ballot` / `review` and explains why a new kind
  would be cited but never exported.

The focused commands it names exist (`vitest.config.ts`,
`vitest.e2e.config.ts`, and the `pnpm check:fast` / `pnpm check` scripts in
`package.json`). Optional, non-blocking: also assert that
`materializeBoundInputs` reports no `omitted` entries for the derived round-1
inputs. That would prove the acceptance clause "materializes them as readable
files" in the fast suite rather than only in e2e.

### Scope and reuse (all plans)

- **Scope.** All plans stay within issue 220. None restores `R5.reviser-auth`,
  touches rounds 2+, adds kinds or schemas, or creates product files.
- **Reuse.** All reuse `acceptedAt`, `inputFromSubmission`,
  `publishedBallotBatch`, `consensusBallotInputs`, `revisionProductInputs`,
  and the existing fixtures (`fixture`, `acceptedResponseFixture`,
  `publishedBallotBatchFixture` with `comparison-ballot-batch`).
- **Fails-before claim.** All plans correctly note that a hand-written
  scaffold `basedOn` case is green before the change.

## Conclusion

- **Recommended: the cursor plan.** It is the only plan whose file map is
  complete.
- **The claude and codex plans are blocked by F1.** Both leave the e2e
  consensus canary (`test/integration.test.ts:408`, `:436`) asserting the old
  single-input round-1 shape. The coordinator's final `pnpm check` would fail,
  or the implementer would need an amendment round.
- **Additional non-blocking issues in the codex plan.** Its tests are heavier
  than needed (F2, F3).

With the F1 correction applied, the claude plan would match the cursor plan in
substance.
