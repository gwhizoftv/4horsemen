# Issue 212 implementation comparison

Bound implementation pins:

- cursor `b34cde7dda51655a1fc10ea245218f584bb3002a`
- codex `57cc186f930f0841b22f89a754b3d2bfbf946190`
- antigravity `ff20570dee7d7fa6800c16b423360833ae78f74a`
- claude `cadc99bd74a32882534cdc43f7fd668e415e49f4`

Method: I compared the four exported worktrees directly, file by file, using
plain `diff -u` over the seven product files each pin changed: `src/runLoop.ts`,
`src/materializedInputs.ts`, `src/evidence.ts`, `src/orderScaffold.ts`,
`docs/coord-driver.md`, and the three test files. Every pin changes exactly the
same paths, all of which are in the approved map. I ran no product tests for
this comparison. My own pin passed the commit hook (`check:fast`) and the push
hook when I published it. I did not observe the other pins' hook results.

## Comparison

### Behaviour: the four pins are functionally equivalent

**`src/runLoop.ts`, `deriveBoundInputs` `R6.revise` (`round > 1`).** All four
pins bind the `prior-revision` input(s) for `round - 1`, followed by one
`consensus-ballot` input per response of
`publishedBallotBatch(cursors, "R6.ballot", round - 1)`. Each ballot input
uses `batch.commitSha` and `batch.paths[index]`. All four keep the prior
revision alone when the batch is `null`, and leave round 1 unchanged. All four
route `R6.follow-up` through the same new helper `consensusBallotInputs`:

| pin | helper location | takes `null`? | other differences |
| --- | --- | --- | --- |
| cursor | `src/runLoop.ts:306` | no | none |
| codex | `src/runLoop.ts:341` | yes | none |
| antigravity | `src/runLoop.ts:588` | yes | also skips an empty path |
| claude | `src/runLoop.ts:589` | no | none |

The differences are cosmetic.

**`src/materializedInputs.ts`.** All four add `"consensus-ballot"` to
`MATERIALIZED_MARKDOWN_KINDS`. Claude also updates the doc comment to mention
JSON.

**`src/evidence.ts` and `src/orderScaffold.ts`.** All four use the same
allow-list of product kinds (`implementation`, `prior-revision`) for the
revision `basedOn` comparison, the single-pin rule, ancestry, and the
changed-path base. The scaffold builds `basedOn` from the same filter.
`inputSetHash` still covers every bound input.

| pin | filter name and location |
| --- | --- |
| cursor | `revisionProductParentInputs` over a `Set`, `src/evidence.ts:47` |
| codex | `revisionProductInputs`, `src/evidence.ts:45` |
| antigravity | `revisionProductInputs`, `src/evidence.ts:44` |
| claude | `revisionProductInputs`, `src/evidence.ts:45` |

**`docs/coord-driver.md:578-581`.** All four replace the stale "later rounds
bind only the preceding accepted revision" sentence.

No pin adds a file, dependency, schema, or input kind. None strays outside the
issue.

### Tests: this is where the pins differ

**Binding test in `test/runLoop.test.ts`:**

- **codex** (`:4507`) runs as `it.each([2, 3])` and goes through `buildOrder`,
  so it checks the real order path. It keeps a different-round consensus batch
  in `ballotBatches` alongside the correct one, which proves the `round - 1`
  selection. It also covers the missing-batch case and round 1.
- **antigravity** (`:4632`) also goes through `buildOrder`, covering round 2,
  round 1, and the missing-batch case.
- **cursor** (`:4597`) calls `deriveBoundInputs` and covers round 2, round 1,
  and the missing-batch case. It builds about 45 lines of cursor state by hand
  instead of reusing `terminalFixture`.
- **claude** (`:4540`) calls `deriveBoundInputs`, reuses `terminalFixture`, and
  covers round 2 and the missing-batch case. It has no round-1 control and no
  round-3 case.

**Materialization test:**

- **codex** extends the existing "writes one content-addressed packet" case with
  a real ballot JSON body. That adds the least new code.
- **cursor**, **antigravity** and **claude** each add one new focused case.
  Cursor's and claude's put a `prior-revision` worktree beside the ballot.

**Evidence test in `test/evidence.test.ts`:**

- **codex** (`:735`) turns the existing lineage test into `it.each([1, 2])`. Its
  mock makes `isAncestor` fail for the ballot commit, and it asserts that the
  extra-parent rejection is the equality error, not the single-pin error.
- **claude** (`:743`) uses the same `isAncestor` exclusion in a separate case.
- **cursor** (`:753`) and **antigravity** (`:773`) leave `isAncestor`
  always-true. Antigravity also re-tests the existing "two product pins" rule,
  which this issue does not change.

**Scaffold test in `test/orderScaffold.test.ts`:** all four assert that
`basedOn` excludes ballot SHAs and that `inputSetHash` covers the full set.
Codex and antigravity also check the rendered JSON.

### Findings

1. **antigravity `ff20570dee7d7fa6800c16b423360833ae78f74a`,
   `docs/coord-driver.md:579`.**
   - **Rule:** the operator contract sentence must name the bound revision
     unambiguously, and keep the paragraph's existing wrapping.
   - **Failure:** "Round 1 binds only the selected implementation, and later
     rounds bind that preceding revision…" uses "that" with no antecedent. No
     preceding revision has been mentioned, so a reader cannot tell which
     revision is the product parent. The sentence is also one 150-character
     line inside a hard-wrapped paragraph.
   - **Fix sketch** (prose, no test): "Later rounds bind the preceding accepted
     revision as the single product parent and also bind the previous round's
     published consensus ballot batch", wrapped like the surrounding lines.

2. **cursor `b34cde7dda51655a1fc10ea245218f584bb3002a`
   (`test/evidence.test.ts:753`) and antigravity
   `ff20570dee7d7fa6800c16b423360833ae78f74a`
   (`test/evidence.test.ts:773`).**
   - **Rule:** the round-2 acceptance case should show that ancestry is checked
     only against the product parent. Ballot commits live on the
     coordinator-evidence branch and never descend into the product branch.
   - **Failure:** both tests use the default `isAncestor: async () => true`.
     Suppose a later change ran the descent or changed-path check against every
     bound commit. In production every round-2+ revision would then be rejected
     with "revised product pin does not descend from its exact authorized input
     pin", yet these tests would stay green.
   - **Smallest test:** pass
     `isAncestor: async (base) => base !== ballotSha` to the satisfied case, as
     the codex and claude pins do.

Neither finding is a behavioural defect in the product code at any pin.

### Ranking

1. **codex `57cc186f930f0841b22f89a754b3d2bfbf946190`.** Its code matches the
   other three. Its tests are the strongest and the most economical: they cover
   rounds 2 and 3, prove the `round - 1` batch is chosen over a different-round
   one, go through `buildOrder`, exclude the ballot commit from ancestry, and
   extend existing cases rather than adding parallel ones. The only nit is that
   its doc line runs slightly past the wrap width.
2. **claude `cadc99bd74a32882534cdc43f7fd668e415e49f4`.** Its code is equivalent,
   and its tests are concise and reuse `terminalFixture`. It includes the
   ancestry exclusion but has no round-1 or round-3 control.
3. **cursor `b34cde7dda51655a1fc10ea245218f584bb3002a`.** Its code is equivalent
   and its doc is correct. Its binding test is verbose (hand-built cursor
   state), and it has Finding 2.
4. **antigravity `ff20570dee7d7fa6800c16b423360833ae78f74a`.** Its code is
   equivalent. It has Findings 1 and 2, and its evidence case adds re-testing
   of behaviour the issue does not change.

Any of the four would correctly close issue 212. I recommend codex.
