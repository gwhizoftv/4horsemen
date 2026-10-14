## Comparison

All four bound implementation pins implement the selected plan cleanly, strictly adhere to the approved file map, and fully resolve issue #212:

- cursor: `b34cde7dda51655a1fc10ea245218f584bb3002a`
- codex: `57cc186f930f0841b22f89a754b3d2bfbf946190`
- antigravity: `ff20570dee7d7fa6800c16b423360833ae78f74a`
- claude: `cadc99bd74a32882534cdc43f7fd668e415e49f4`

### Architectural and Scope Alignment

All four implementations modify exactly the eight approved files:
- `docs/coord-driver.md`
- `src/evidence.ts`
- `src/materializedInputs.ts`
- `src/orderScaffold.ts`
- `src/runLoop.ts`
- `test/evidence.test.ts`
- `test/orderScaffold.test.ts`
- `test/runLoop.test.ts`

No unapproved files, speculative refactors, or unnecessary dependencies were introduced by any implementation.

### Implementation Analysis

1. **`src/runLoop.ts`**:
   - `cursor` (`b34cde7dda51655a1fc10ea245218f584bb3002a`): Reuses `consensusBallotInputs` and in `deriveBoundInputs` for `R6.revise` with `round > 1` queries `publishedBallotBatch(cursors, "R6.ballot", previousRound)`. If the published batch is present, it binds the ballot inputs alongside the prior revision.
   - `codex` (`57cc186f930f0841b22f89a754b3d2bfbf946190`): Updates `consensusBallotInputs` signature to accept `BallotBatch | null` returning an empty array on null, allowing concise composition `...consensusBallotInputs(publishedBallotBatch(cursors, "R6.ballot", previousRound))`.
   - `claude` (`cadc99bd74a32882534cdc43f7fd668e415e49f4`): Moves `consensusBallotInputs` helper before `deriveBoundInputs` and uses ternary expression `...(batch === null ? [] : consensusBallotInputs(batch))`.
   - `antigravity` (`ff20570dee7d7fa6800c16b423360833ae78f74a`): Reuses `consensusBallotInputs`, cleanly binding `batch === null ? prior : [...prior, ...consensusBallotInputs(batch)]`.

2. **`src/materializedInputs.ts`**:
   - All four implementations add `"consensus-ballot"` to `MATERIALIZED_MARKDOWN_KINDS`, ensuring that published ballots are materialized as markdown files rather than product worktrees.

3. **`src/evidence.ts` & `src/orderScaffold.ts`**:
   - All four implementations extract a helper (`revisionProductParentInputs` in cursor, `revisionProductInputs` in codex, claude, antigravity) that filters bound inputs for `"implementation"` or `"prior-revision"`.
   - In `src/orderScaffold.ts`, `basedOn` in `R6.revise` uses this helper to only include authorized product pins, excluding consensus ballots.
   - In `src/evidence.ts`, `revision-pinned` verification uses the helper to enforce that `basedOn` matches exactly one authorized product parent, while `inputSetHash` incorporates all bound inputs including consensus ballots.

4. **`docs/coord-driver.md`**:
   - All four implementations update the documentation describing round-2+ revise step inputs, specifying that the reviser receives both the single product parent and the prior round's published consensus ballot batch.

5. **Test Coverage**:
   - All four implementations add thorough, focused tests across `test/runLoop.test.ts`, `test/orderScaffold.test.ts`, and `test/evidence.test.ts`, verifying ballot batch binding, fallback when batches are not published, artifact scaffold isolation in `basedOn`, and strict ancestor checking.

### Conclusion

All four implementations are high quality, sound, and fully compliant with the specification and protocol. Any of the four can be safely selected as consensus implementation.
