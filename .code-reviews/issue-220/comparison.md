## Comparison

Compared these implementation pins:

- cursor `8ac06bac06de77fb1702b7fd62187c99a1838a77`
- claude `966c689ae1ac7828a64b2b2de5c2696d1c59b4d3`
- codex `b71317bc0b11164a217e91f2c608eeb4d8616af1`

All three stay inside issue 220. Each changes only `src/runLoop.ts`, `docs/coord-driver.md`, `test/runLoop.test.ts`, `test/orderScaffold.test.ts`, and `test/integration.test.ts`, plus that agent's own plan, review, and participation signal. None adds a file, kind, helper, or dependency. The rounds-2-and-later branch of `deriveBoundInputs` is unchanged on every pin: it still returns the previous revision as `prior-revision` and that round's published consensus ballots.

Round 1 is the same binding on every pin. After the selected `R4.implement` lookup (winner and `implementationPin`), a missing selection returns an empty list. Otherwise the list is the selected implementation (`usePin`), then `consensusBallotInputs(publishedBallotBatch(..., "R5.compare-ballot", null))`, then each active `R5.compare` submission as `review` cited by `submissionSha`.

- cursor `8ac06bac06de77fb1702b7fd62187c99a1838a77`: `src/runLoop.ts:639-644`
- claude `966c689ae1ac7828a64b2b2de5c2696d1c59b4d3`: `src/runLoop.ts:641-645` (same return, plus a comment)
- codex `b71317bc0b11164a217e91f2c608eeb4d8616af1`: `src/runLoop.ts:639-643`

`consensus-ballot` and `review` are already materialized markdown kinds, and `implementation` is already a pin kind, so the reviser gets readable ballots, comparisons, and the selected worktree without a materializer change. `revisionProductInputs` still keeps `basedOn` to the implementation pin. The Profiles paragraph in `docs/coord-driver.md` (around line 590 on each pin) states that contract. Codex's sentence also says those feedback files appear under Bound input files, which is what the existing materializer does for those kinds.

Tests differ in how tightly they lock that contract, not in the product behavior.

- cursor `8ac06bac06de77fb1702b7fd62187c99a1838a77` adds one `deriveBoundInputs` case in `test/runLoop.test.ts:4227` for the full round-1 list and for an empty `ballotBatches` list, a hand-built `basedOn` case in `test/orderScaffold.test.ts`, and an integration shape check that there is one implementation plus one ballot and one review per active agent. The canary submits `basedOn` from implementation inputs only.
- claude `966c689ae1ac7828a64b2b2de5c2696d1c59b4d3` uses the same three files. Its round-1 case also calls `materializeBoundInputs` and expects no omitted entries, one file per feedback input, and one implementation worktree. Its canary asserts length `1 + 2 * activeAfterDrop.length`, that the implementation agent is `cursor`, and submits `basedOn` through `revisionProductInputs`.
- codex `b71317bc0b11164a217e91f2c608eeb4d8616af1` derives the scaffold inputs with `deriveBoundInputs` inside `test/orderScaffold.test.ts`, so that case fails until the binder includes the feedback. Its run-loop case also checks the null-round fallback, excludes an inactive comparison agent, and expects an empty list when the selected implementation is absent. Its canary reads the published action manifest and compares each feedback file's bytes to the mirror, and it asserts input order: implementation, then ballots in roster order, then reviews.

The later-round test that still expects a feedback-free round 1 is left intact on all three pins. Each implementation reuses `acceptedAt`, `inputFromSubmission`, `publishedBallotBatch`, and `consensusBallotInputs`.
