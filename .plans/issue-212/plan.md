# Plan — issue 212: bind the previous round's ballot batch to the round-2+ reviser

Issue #212: "Change coord to have the round-2+ revise step bind the previous
round's ballot batch, the same way R6.follow-up already does. Then it works under
AGENTS.md where they are told Inspect only the input it binds."

## Problem

`deriveBoundInputs` (`src/runLoop.ts:625-634`) binds a round-N (N > 1) `R6.revise`
action to exactly one input: the round N-1 revision, as `prior-revision`. The
ballots that sent the issue back for revision are never bound. AGENTS.md tells the
reviser to read the bound inputs, and the git shim refuses
`git show <sha>:<path>` once an action has a complete `## Bound input files`
section, which a round-2+ revise always has because its prior-revision worktree is
exported. The result is that the reviser cannot see the objections.

`R6.follow-up` (`src/runLoop.ts:640-650`) already does the right thing. It takes
`publishedBallotBatch(cursors, "R6.ballot", round)` and binds one
`consensus-ballot` input per batch response, with `commitSha: batch.commitSha` and
`path: batch.paths[index]`.

There is a second, smaller gap. Those `consensus-ballot` inputs are not
materialized: `MATERIALIZED_MARKDOWN_KINDS` (`src/materializedInputs.ts:31-33`)
does not include the kind. A bound ballot is therefore listed as a citation but is
not exported as a file, and the shim then refuses the pinned read. Binding without
exporting would not "work under AGENTS.md", so this plan also fixes the export.

Adding bound inputs changes the revise artifact's `basedOn`. Both the scaffold
(`src/orderScaffold.ts:75`) and the validator (`src/evidence.ts:363-365`) currently
treat every bound input commit as a product parent. Both must keep only the product
pin, or the revision would be rejected with "revision must be based on exactly one
authorized product pin".

## Exact File List to be changed or deleted

- `src/runLoop.ts`: in `deriveBoundInputs`, change the `R6.revise` branch for
  `round > 1`. It returns the existing `prior-revision` input(s), followed by one
  `consensus-ballot` input per response of
  `publishedBallotBatch(cursors, "R6.ballot", round - 1)`. Each of those uses
  `{ agent: response.agent, commitSha: batch.commitSha, path: batch.paths[index]!, kind: "consensus-ballot" }`,
  the same shape `R6.follow-up` builds. If the batch is `null`, only the
  `prior-revision` input is bound, which is today's behaviour. To share code with
  the existing `R6.follow-up` mapping, extract a small local helper
  (`consensusBallotInputs(batch)`) in the same file and use it from both branches.
- `src/materializedInputs.ts`: add `"consensus-ballot"` to
  `MATERIALIZED_MARKDOWN_KINDS`. Update its doc comment to say "coordination
  document (Markdown or JSON)", because ballots are JSON.
- `src/evidence.ts`: in the `revision-pinned` branch, compute `expectedPins` from
  `order.inputs.filter((input) => input.kind !== "consensus-ballot")`. Ballots are
  context, not product parents. The `inputSetHash` check still covers every bound
  input.
- `src/orderScaffold.ts`: in the `R6.revise` case, build `basedOn` from inputs
  whose `kind !== "consensus-ballot"`.
- `test/runLoop.test.ts`: add the binding and materialization cases listed under
  Tests.
- `test/evidence.test.ts`: add the `basedOn` acceptance case listed under Tests.
- `test/orderScaffold.test.ts`: extend the existing revise-scaffold case listed
  under Tests.

## Exact file list to be created

None. This changes existing derivation, export, scaffold, and validation code, and
each test case joins an existing test file.

## Reuse and Scope

Reused without change:

- `publishedBallotBatch` (`src/runLoop.ts:306`). This is the same function
  `R6.follow-up` uses. It returns only a batch that is published, matches the
  active roster, and matches the accepted responses. That makes the binding
  deterministic, and the binding is identical on every re-preparation.
- `acceptedAt(..., "R6.revise", true, round - 1)` and `inputFromSubmission(...,
  "prior-revision", true)`. The existing prior-revision binding is unchanged.
- The `consensus-ballot` input kind. It is already in `derivedInputKindSchema`
  (`src/state.ts:518-525`), already used by `R6.follow-up` and
  `computeConsensusDerived`, and already understood by `src/evidence.ts:391`. No
  new kind, schema field, or protocol change is needed.
- `materializeBoundInputs` and `boundInputFilesSection` (`src/action.ts`). Once
  the kind is in the document set, ballots are exported into the content-addressed
  packet under `consensus-ballot-<agent>-<sha8>/<path>` and listed in
  `## Bound input files`. Every ballot shares the batch commit, so the agent
  component keeps the directories distinct.
- `BareMirror.readBlob` reads the coordinator-evidence batch commit. That commit
  is created in the mirror before it is pushed (`src/ballotPublication.ts`), so
  the blob is present.
- The shim gate (`scripts/lib/launcher.sh`, `coord_action_lists_files`) and
  `INCOMPLETE_MATERIALIZATION_NOTE` are unchanged. With ballots exported, the
  existing rule ("pinned read refused once listed, allowed if anything is
  omitted") is now correct for both revise and follow-up.
- Test fixtures: `fixture`, `publishedBallotBatchFixture`,
  `acceptedResponseFixture`, and the cursor-construction pattern from the
  `third revision closeout` describe block in `test/runLoop.test.ts`. Also the
  `readingMirror` helper from the `materialized bound inputs` describe block, the
  `order`/`mirror` helpers in `test/evidence.test.ts`, and the existing
  `R6.revise` ctx in `test/orderScaffold.test.ts`.

Scope:

- No change to `R6.ballot` inputs, action text, `AGENTS.md`, `src/steps.ts` task
  strings, or protocol schemas.
- Round 1 revise is unchanged: it binds the selected implementation only, because
  no consensus ballot exists yet.
- `R6.follow-up` keeps the same bound inputs. Its only observable change is that
  its ballots now also appear in `## Bound input files`, which is the same export
  fix.
- `src/runLoop.ts` `PINNED_INPUT_KINDS` (change scope) is unchanged. Ballots are
  not product pins.

## Tests

Each case fails at the baseline and passes after the change. Per AGENTS.md, the
hook owns `pnpm check:fast` at commit time. While developing, run focused files:
`pnpm vitest run --config vitest.config.ts test/runLoop.test.ts test/evidence.test.ts test/orderScaffold.test.ts`.

1. `test/runLoop.test.ts`, new `it` in the `third revision closeout` describe
   block. Build cursors that hold an accepted round-1 `R6.revise` from the
   reviser, round-1 `R6.ballot` responses from every active agent, and a
   published round-1 `consensus-ballot-batch`
   (`publishedBallotBatchFixture({ kind: "consensus-ballot-batch", activeRoster, round: 1 })`).
   This is the same shape as the `earlier` cursors already built in that block.
   Assert that `deriveBoundInputs(start, cursors, "R6.revise", 2)` returns:
   - first, one `prior-revision` input at the round-1 revision's product pin;
   - then one `consensus-ballot` input per active agent, in roster order, each
     with `commitSha === batch.commitSha` and `path === batch.paths[i]`.

   Also assert that with `ballotBatches: []`, only the `prior-revision` input is
   returned. At the baseline the first assertion fails, because no
   `consensus-ballot` input is returned.
2. `test/runLoop.test.ts`, new `it` in the `materialized bound inputs` describe
   block. Call `materializeBoundInputs` with one `consensus-ballot` input
   (`.code-reviews/issue-1/consensus-ballot-codex-round-1.json`) and one
   `prior-revision` input. Assert:
   - `entries` contains the ballot, with its exact bytes on disk;
   - `worktrees` contains the prior revision;
   - `omitted` is empty.

   At the baseline `entries` is empty.
3. `test/evidence.test.ts`, new `it` next to "requires revision lineage, approved
   paths, and immutable phase separation". Use an `R6.revise` round-2 order whose
   inputs are one `prior-revision` plus two `consensus-ballot` inputs sharing a
   batch SHA. Submit an artifact with `basedOn: [priorPin]` and the matching
   `inputSetHash`. Assert that `outstanding` contains neither "basedOn pins do not
   equal bound inputs" nor "exactly one authorized product pin". At the baseline
   both errors appear.
4. `test/orderScaffold.test.ts`, extend the first case ("offers a request without
   a product pin and keeps revision ancestry separate"). Add a `consensus-ballot`
   input to `ctx.inputs`, and keep the existing expectation
   `basedOn: ["c".repeat(40)]`. At the baseline `basedOn` also contains the ballot
   SHA.

## Alternatives Rejected

- **Bind the ballots but do not export them.** The shim refuses
  `git show <sha>:<path>` whenever `## Bound input files` is present without the
  incomplete-export note. A round-2+ revise always exports its prior-revision
  worktree, so the reviser would be told about ballots it cannot read.
- **Paste ballot rationales into the action body (owner guidance or a new
  section).** That text is advisory, unpinned, and unverifiable. It does not
  match how `R6.follow-up` binds ballots, and the issue asks for the same
  mechanism.
- **Add a new input kind (for example `prior-ballot`).** That would need changes
  to the schema, the agent-language strings, and the validator for no
  behavioural gain. `consensus-ballot` already means exactly this artifact.
- **Bind the latest published consensus batch regardless of roster match.**
  That diverges from `publishedBallotBatch`, the rule `R6.follow-up` and
  `computeConsensusDerived` both use. It could also bind a batch the coordinator
  no longer treats as the closed round.
- **Return no inputs for revise when the batch is missing, as `R6.follow-up`
  does.** For revise, that would remove the only product parent and make every
  submission fail "exactly one authorized product pin". The plan degrades to
  today's behaviour instead.
- **Rename `MATERIALIZED_MARKDOWN_KINDS`.** It is churn across callers. A
  doc-comment update is enough.

## Risks and Mitigations

- **Ballot SHAs leak into revision ancestry.** If `basedOn` or the validator
  counted ballot commits as parents, every round-2+ revision would be rejected.
  Mitigation: both `src/orderScaffold.ts` and `src/evidence.ts` filter
  `consensus-ballot` out, and Tests 3 and 4 pin that. The single-parent rule
  (`expectedPins.length !== 1`) is still enforced on the product pins.
- **An in-flight round-2/3 revise action at upgrade time.** The bound inputs
  change, so `inputSetHash` changes. A revision signal built from the old action
  is rejected with the existing "inputSetHash does not match" message, and the
  agent republishes against the re-prepared action. Mitigation: no state
  migration is needed. The derivation is pure over cursors and is recomputed on
  preparation. Prefer upgrading between rounds.
- **A roster change after the round N-1 batch was published.**
  `publishedBallotBatch` returns `null`, and the reviser is bound to the prior
  revision only, which is today's behaviour, rather than being blocked. This is
  the same denominator rule `R6.follow-up` already relies on. Test 1 covers the
  `null` branch.
- **A follow-up packet hash changes**, because ballots are now included. Packets
  are content-addressed and immutable, so a new packet is built and the old one
  is left unused. Nothing keys on the old hash.
- **A ballot blob is unreadable in the mirror.** `materializeBoundInputs`
  records it in `omitted`. The action then carries
  `INCOMPLETE_MATERIALIZATION_NOTE`, and the shim keeps the pinned `git show`
  fallback open. This is existing behaviour.

## Conclusion

The fix is local to `deriveBoundInputs`. A round-2+ `R6.revise` binds the prior
revision plus the previous round's published consensus ballot batch, using the
same `publishedBallotBatch` and `consensus-ballot` shape as `R6.follow-up`. The
plan also exports `consensus-ballot` inputs as files, so the bound ballots are
actually readable under the shim. The revision `basedOn` scaffold and validator
are updated to ignore ballot citations, which keeps the single product-parent
rule intact. Four focused cases join the existing `runLoop`, `evidence`, and
`orderScaffold` test files. There are no new files, kinds, schemas, or protocol
changes.
