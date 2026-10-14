# Review — issue 212 plans

Bound plans reviewed:

- claude `6d5e64afa09bd489cf54653e35bdf47fbb4334c5` (`.plans/issue-212/plan.md`)
- codex `8648fd54c3ee81799d16ac745086b78a0b368e44` (`.plans/issue-212/plan.md`)
- cursor `9d37c3f9db5c3b25ffe2f7bdb1cfd17880288ef9` (`.plans/issue-212/plan.md`)
- antigravity `0fa218a0ff2dddff8161e070744abd8384bde180` (`.plans/issue-212/plan.md`)

All four plans agree on the core change, and it is the right one:

- For `round > 1`, the `R6.revise` branch of `deriveBoundInputs` keeps the
  `prior-revision` pin. It then appends one `consensus-ballot` input per response
  of `publishedBallotBatch(cursors, "R6.ballot", round - 1)`, built the same way
  `R6.follow-up` builds them.
- `consensus-ballot` is added to `MATERIALIZED_MARKDOWN_KINDS`. This matters:
  the prior-revision worktree already fills `## Bound input files`, so the shim
  would refuse a pinned `git show` of the ballots.
- `consensus-ballot` inputs are kept out of the revision `basedOn`, in both
  `src/orderScaffold.ts` and the `revision-pinned` check in `src/evidence.ts`.

The plans differ on three things: whether the product parent is kept when no
matching batch exists, how much testing is proposed, and whether the driver doc
is updated.

## Findings

1. **antigravity `0fa218a0ff2dddff8161e070744abd8384bde180`, Risks and
   Mitigations ("deriveBoundInputs checks batch === null or priorRevisions
   length === 0 and returns empty array").**
   - **Rule:** a round-2+ `R6.revise` order must always bind its single
     authorized product parent. A missing ballot batch must not remove it.
     `src/evidence.ts:363-365` rejects any revision whose expected product pins
     are not exactly one.
   - **Failure if followed as written:** an agent is dropped after round-1
     ballots are published. `cursors.activeRoster` no longer matches
     `batch.activeRoster`, so `publishedBallotBatch` (`src/runLoop.ts:306-338`)
     returns `null`, and under this plan the round-2 revise order has no inputs.
     The reviser's `basedOn` is then empty or arbitrary. Every submission is
     rejected with "revision must be based on exactly one authorized product pin".
     No worktree is exported either, so the issue stalls at R6.revise. Today the
     same roster change still yields a usable `prior-revision` input, so this
     would be a regression.
   - **Smallest correction:** when the batch is `null`, return the
     `prior-revision` input alone and add no ballots. This is what the claude,
     codex and cursor plans do.

2. **claude `6d5e64afa09bd489cf54653e35bdf47fbb4334c5`, codex
   `8648fd54c3ee81799d16ac745086b78a0b368e44` and antigravity
   `0fa218a0ff2dddff8161e070744abd8384bde180`, Exact File List (none lists
   `docs/coord-driver.md`).**
   - **Rule:** the shipped driver doc must not state the opposite of the new
     binding.
   - **Failure if followed as written:** `docs/coord-driver.md:578-579` still
     says "Round 1 binds only the selected implementation, and later rounds bind
     only the preceding accepted revision." After the change, later rounds also
     bind the previous round's consensus ballots. An operator or agent reading
     the doc is told the ballots are not bound, which is exactly the
     misunderstanding issue 212 fixes. The approved file map would also forbid
     the implementer from correcting it without an amendment round.
   - **Smallest correction:** add `docs/coord-driver.md` to the file map, with
     the one-sentence rewrite the cursor plan specifies.

3. **codex `8648fd54c3ee81799d16ac745086b78a0b368e44`, Tests items 2, 3 and 5.**
   - **Rule:** AGENTS.md asks for the fewest focused tests that fail before the
     change. Existing selectors should be reused, not re-verified. The plan
     itself says "Reuse the existing selector rather than retesting its
     implementation independently."
   - **Failure if followed as written:** item 2 re-tests every
     `publishedBallotBatch` rejection path: pending, failed and invalidated
     status, wrong round, stale roster, stale response identity, and a stale
     candidate beside a valid one. None of these behaviours is changed by
     issue 212, so all of them pass before the change and none is a regression
     test for this issue.

     Item 3 adds a full `buildOrder` and `writeAction` render. It also adds an
     unreadable-blob omission case. That existing behaviour is not changed and
     already has tests in the `materialized bound inputs` describe block.

     Item 5 re-asserts unrelated-ancestry, out-of-map and post-pin rejections
     that the existing revision-lineage test already covers.

     The suite grows by a dozen-plus cases. Only about four of them can fail on
     the baseline: round-2 binding, ballot export, scaffold `basedOn`, and
     validator `basedOn`.
   - **Smallest correction:** keep items 1 and 4. For item 3, keep only "a
     `consensus-ballot` input is written into the packet". For item 5, keep only
     "valid mixed inputs are accepted" and "`basedOn` containing the ballot SHA
     is rejected". Drop item 2, except for a single `null`-batch control.

Observations that are not blocking:

- The codex and cursor plans pick the product parent from an allow-list
  (`implementation` and `prior-revision`). The claude and antigravity plans use
  a deny-list (`kind !== "consensus-ballot"`). Both are correct for today's
  input kinds. The allow-list is slightly more robust, and the implementer may
  prefer it.
- The cursor plan says to skip a response whose `batch.paths[index]` is missing.
  That changes nothing for well-formed batches. For follow-up it turns a
  malformed batch into an explicit "needs your published final ballot"
  rejection rather than an empty-path citation. This is acceptable.
- All four plans stay within the issue, create no new files, kinds, schemas or
  dependencies, and reuse `publishedBallotBatch`, `inputFromSubmission`,
  `materializeBoundInputs` and the existing fixtures
  (`publishedBallotBatchFixture`, `acceptedResponseFixture`, `readingMirror`).

## Conclusion

- **cursor `9d37c3f9db5c3b25ffe2f7bdb1cfd17880288ef9`** is the most complete
  plan. It covers the binding, the export, both `basedOn` sites with an
  allow-list filter, the `null`-batch fallback, the doc sentence that would
  otherwise go stale, and a focused test set. I recommend it for selection as
  written.
- **claude `6d5e64afa09bd489cf54653e35bdf47fbb4334c5`** is acceptable if
  `docs/coord-driver.md` is added (Finding 2).
- **codex `8648fd54c3ee81799d16ac745086b78a0b368e44`** has a correct design,
  but it misses the doc (Finding 2) and its tests should be cut back to the
  regression cases (Finding 3).
- **antigravity `0fa218a0ff2dddff8161e070744abd8384bde180`** should not be
  selected as written. Its empty-inputs fallback (Finding 1) would stall
  round-2+ revisions after any roster change, and it also misses the doc.
