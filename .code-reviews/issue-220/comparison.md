# Issue 220 — implementation comparison

Bound implementation pins compared:

- cursor `8ac06bac06de77fb1702b7fd62187c99a1838a77`
- claude `966c689ae1ac7828a64b2b2de5c2696d1c59b4d3`
- codex `b71317bc0b11164a217e91f2c608eeb4d8616af1`

## Comparison

### Production code: identical behavior in all three pins

All three change only the round-1 branch of `R6.revise` in `deriveBoundInputs`.
Each returns, in this order:

1. `inputFromSubmission(selected, "implementation", true)`
2. `...consensusBallotInputs(publishedBallotBatch(cursors, "R5.compare-ballot", null))`
3. `...acceptedAt(cursors, "R5.compare").map((value) => inputFromSubmission(value, "review"))`

Locations: cursor `src/runLoop.ts:640-644`, claude `src/runLoop.ts:639-645`,
codex `src/runLoop.ts:639-643`.

When no selected implementation matches, each still returns `[]`. The
rounds-2+ branch is untouched in every pin. The diffs differ only in whitespace
and comments: cursor uses an early `if (selected === undefined) return [];`,
and claude adds a two-line comment. Every pin satisfies these invariants:

- **Single product parent.** `basedOn` stays the one selected pin, because the
  new `review` and `consensus-ballot` kinds are filtered out by
  `revisionProductInputs`.
- **Readable files.** Both new kinds are in `MATERIALIZED_MARKDOWN_KINDS`, so
  they are exported as files.
- **No collisions.** The shared `comparison.md` path does not collide, because
  entry directories are `kind-agent-sha8`.

All three change exactly the five approved paths. None adds a file, helper,
kind, or dependency. The docs sentence at `docs/coord-driver.md:590` is
updated in all three, with only wording differences: codex additionally names
the Bound input files section.

The pins differ only in their tests. Those differences decide the ranking.

### Tests: what each pin proves

| Acceptance clause (issue 220) | cursor | claude | codex |
|---|---|---|---|
| runLoop round-1 binding test fails before / passes after | yes (`test/runLoop.test.ts:4227`) | yes (`test/runLoop.test.ts:4227`); I confirmed it fails with the binder reverted | yes (`test/runLoop.test.ts:4202`) |
| orderScaffold `basedOn` test fails before / passes after | **no** (hand-written inputs, `test/orderScaffold.test.ts:35`) | **no** (hand-written inputs, `test/orderScaffold.test.ts:35`) | yes (derives inputs via `deriveBoundInputs`, `test/orderScaffold.test.ts:10`) |
| Inputs materialized as readable files (no `git show`) | not asserted | unit-level: `materializeBoundInputs` with a stub mirror, `omitted` empty, one entry per document, one implementation worktree | e2e: reads the published action, its manifest, each file's bytes against the mirror, and the worktree `HEAD` (`test/integration.test.ts:398-417`) |
| e2e canary asserts the exact round-1 shape | partial: per-agent counts only, no total (`test/integration.test.ts:408-412`) | exact counts plus total (`test/integration.test.ts:408-414`) | exact ordered `{kind, agent}` list (`test/integration.test.ts:396-400`) plus total (`:430`) |
| Inactive-agent comparison excluded | no | no | yes (`test/runLoop.test.ts:4210`) |
| Missing-selection / null-round paths | no | no | yes (`test/runLoop.test.ts:4221-4223`) |

### Findings

**F1 — cursor `test/orderScaffold.test.ts:35`, and claude `test/orderScaffold.test.ts:35`**

- **Rule.** Issue 220's acceptance requires the `test/orderScaffold.test.ts`
  `basedOn` case to fail before the change and pass after.
- **Concrete failure.** Both cases pass a hand-written list of
  implementation, ballot, and review inputs to `artifactScaffoldValue`.
  `revisionProductInputs` already filtered by kind at baseline `e5ec3f6`. If
  the binder change in `src/runLoop.ts` is reverted, both cases stay green.
  They therefore cannot detect the issue's defect, and that acceptance clause
  is unmet. The selected plan disclosed this up front. The red-before evidence
  for these two pins comes only from their `runLoop.test.ts` cases.
- **Smallest illustrative fix.** Build the scaffold context's `inputs` from
  `deriveBoundInputs(start, cursors, "R6.revise", 1)` over a state that has a
  published comparison batch and accepted comparisons, as codex does at
  `test/orderScaffold.test.ts:10-55`.

**F2 — cursor `test/integration.test.ts:408-412`**

- **Rule.** The canary must pin the complete round-1 input set. A binder that
  leaks an extra input (another kind, or a non-active agent's comparison) must
  fail the e2e suite.
- **Concrete failure.** The assertions only count `implementation` (exactly
  one), plus one `consensus-ballot` and one `review` per agent in
  `activeAfterDrop`. They never assert the total length or exclude other
  kinds. A regression that also bound every `R4.implement` pin, or a dropped
  agent's comparison, would add inputs without failing any of these
  assertions. Such a leak is caught only indirectly, if at all: at line 440,
  `basedOn` would gain extra `implementation` pins and evidence would reject
  the artifact, but only for the implementation-kind leak.
- **Smallest illustrative test.** Add
  `expect(currentOrder("cursor").inputs).toHaveLength(1 + 2 * activeAfterDrop.length)`.
  Claude has this at `:409` and codex at `:430`.

**F3 — codex `test/orderScaffold.test.ts:10-55` (non-blocking)**

- **Rule.** Test fixtures should reuse existing support rather than duplicate
  state construction.
- **Concrete failure.** The new case hand-builds a full `startStateSchema`
  object (14 fields), an accepted-response list, and a raw `BallotBatch`
  literal inside the scaffold suite. `test/runLoop.test.ts` already has
  equivalent helpers (`fixture`, `acceptedResponseFixture`,
  `publishedBallotBatchFixture`). Any later required field added to
  `StartState` or `BallotBatch` now breaks a scaffold test whose subject
  (`basedOn`) did not change. This costs maintenance, not correctness. It is
  also the only pin that literally meets the orderScaffold fails-before
  clause (F1).

**F4 — cursor `test/runLoop.test.ts:4274` (non-blocking)**

- **Rule.** Assertions should test the unit under test, not a fixture
  precondition placed after the real checks.
- **Concrete failure.** `expect(base.activeRoster).toHaveLength(2)` runs
  last. If the fixture roster changed, the binding assertions above it would
  fail first with a less clear message, so this guard adds nothing.
  Remove it, or move it to the top of the case.

### Scope and reuse

All three stay within issue 220, touch only the approved five paths, and
reuse `acceptedAt`, `inputFromSubmission`, `publishedBallotBatch`,
`consensusBallotInputs`, and `revisionProductInputs`. Their test footprints
differ:

- **cursor** has the smallest footprint. It reuses `fixture()` but rebuilds
  the `implementationSelection` record inline.
- **claude** reuses `terminalFixture`, `publishedBallotBatchFixture`, and
  `acceptedResponseFixture`, and adds a unit-level materialization check.
- **codex** has the largest footprint: a stronger e2e proof plus the
  duplicated state construction in F3. It is still focused on the issue's
  acceptance clauses.

### Verification

- **What I read.** I compared the bound worktrees directly with `diff -u`.
  I read the existing hook results: my pin's pre-commit `check:fast` and
  pre-push `test:e2e` both passed when I published it.
- **Peer pins.** I did not re-run cursor's or codex's suites. Their pins were
  pushed through the same pre-push hook.
- **Fails-before evidence.** My own red-before evidence covers only claude's
  runLoop case, which I checked by temporarily reverting the binder. The F1
  conclusion follows from the code: those scaffold cases never call
  `deriveBoundInputs`.

### Ranking

1. **codex** `b71317bc0b11164a217e91f2c608eeb4d8616af1`: the same production
   change, and the only pin that meets every acceptance clause as written,
   including orderScaffold fails-before and an end-to-end proof of readable
   bound files. Its fixture weight (F3) is the only cost.
2. **claude** `966c689ae1ac7828a64b2b2de5c2696d1c59b4d3`: the same production
   change, an exact e2e shape, and a materialization check. It misses the
   orderScaffold fails-before clause (F1).
3. **cursor** `8ac06bac06de77fb1702b7fd62187c99a1838a77`: the same production
   change. It misses the orderScaffold fails-before clause (F1), its canary
   has no total-length assertion (F2), and it has a misplaced fixture guard
   (F4).
