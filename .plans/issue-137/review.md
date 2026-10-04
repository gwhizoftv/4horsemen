# Issue 137 — plan review

Protocol version: 1. Reviewed the exact bound plans:

- Cursor: `bc5f9ae75426112fa1eb2379bdc0c278eb0b3844`.
- Claude: `283f72447e43206d1ef6c8fe104382a7df0ec713`.
- Antigravity: `c91a1c98e239aab9cc534c46d9b88956300948bf`.
- Codex: `82873282557e9c24e08621ed4356b736618fd7df`.

All citations refer to `.plans/issue-137/plan.md` at the listed SHA. The
coordinator-exported copies were read directly, and the proposed integration
points were checked against this checkout's existing implementation.

## Findings

### 1. [P1] Claude: recording a declaration is not agent agreement in reviewed mode

**Plan claim:** Design items 2–3 accept declared out-of-map paths immediately
and rely on existing downstream ballots for agreement. Risks and Mitigations
explicitly accepts the absence of those ballots in reviewed/solo profiles,
relying instead on the default unmerged PR.

**Rule:** In a multi-agent reviewed issue, an overlooked file must receive
agent agreement before it becomes an authorized amendment. A configurable
publication policy cannot substitute for that agreement.

**Concrete failure:** `reviewedSteps` in `src/steps.ts:192–199` goes directly
from implementation to finalization. An implementer can declare an unrelated
configuration file, have the signal accepted under this plan, and reach
finalization without any reviewer judging the expansion. With the supported
`coord-merged` policy, even the assumed later owner merge review is absent.
Keeping a reason in Git/cursors does not supply the missing authorization.
This is not merely a solo-profile tradeoff: it weakens a workflow that has
active peer reviewers and fails the issue's requested agreement mechanism.

**Smallest correction:** Add a conditional approval mechanism for profiles
without a downstream amendment judgment, or otherwise prohibit accepting the
expanded map until the required peers have explicitly approved it. Include a
reviewed-profile test that cannot finalize an unapproved declaration.

### 2. [P1] Claude: the proposed advisory attachment does not preserve amendment visibility through revision

**Plan claim:** Design item 3 and the run-loop file entry attach declarations
only from the accepted submission whose `productPin` exactly matches the
displayed pin. The revision paragraph requires redeclaration only when the
reviser changes that path again. Risks claims every amendment will be shown
in the ballot that judges it.

**Rule:** If existing ballots are the sole agreement mechanism, the final
judgment must receive the complete applicable amendment evidence, including
inherited out-of-map changes. That evidence cannot disappear merely because
an advisory diff cannot be produced.

**Concrete failure:** An implementation declares an omitted test file at pin
A. Revision B changes another, originally approved file and retains the test
unchanged. Under the proposed delta rule B need not redeclare the test.
`deriveBoundInputs` binds only B for the consensus ballot
(`src/runLoop.ts:556–557`), and the proposed exact-pin attachment finds B's
empty declaration list, not A's. The consensus action therefore omits the
inherited amendment and its reason even though the final tree still includes
it. A comparison plurality is not the final unanimous judgment. Independently,
`resolveChangeScope` deliberately omits a pin's entire entry on a diff-read
failure (`src/runLoop.ts:650–661`), which would also omit the only explicit
amendment notice without blocking ballot preparation.

**Smallest correction:** Carry cumulative applicable declaration provenance
as explicit ballot input independently of best-effort changed-path hints;
do not require an unchanged inherited file to appear in the revision delta.
Test both an untouched inherited amendment and a failed advisory diff read.

### 3. [P1] Cursor: the amendment request has no specified entry point from the issued work action

**Plan claim:** The file map adds `R4.amend-scope` and `R4.amend-ballot` outside
normal progression, and transitions from implementation/revision once a
proposal is accepted. It adds scaffolds for those new steps, but does not
define an alternative submission for the currently issued implementation or
revision action, or an event that orders the proposal step.

**Rule:** A blocked implementer must have an actionable, coordinator-recognized
submission route before an amendment proposal can be accepted; reaching that
route cannot depend on the proposal already being accepted.

**Concrete failure:** The agent currently has a Git action requiring a ready
signal. `evaluateEvidence` reads exactly `order.requiredPath`
(`src/evidence.ts:261–263`) and dispatches using that order's evidence ID.
The machine does not independently discover arbitrary proposal files, and
the added proposal step is deliberately absent from the normal sequence.
Following the stated transitions leaves the agent on the same ready-signal
action with no way to enter the new proposal action. A test seeded with an
already-accepted proposal would pass while the real overlooked-test scenario
remains stuck.

**Smallest correction:** Specify the exact request path/schema, completion
contract, discrimination from readiness, and admission in the original work
action. Test from an actual issued implementation action through request
publication, not only from a manually seeded accepted proposal.

### 4. [P1] Cursor and Antigravity: repeated amendments need distinct voter-response identities

**Plan claims:** Cursor's state entry records an amendment decision/input hash
and interrupted step/round, while its Risks permits two accepted amendments.
Antigravity returns to implementation after a ballot and explicitly allows
further proposals after rejection. Neither plan specifies a proposal-specific
ballot sequence or invalidation of the previous ballot's accepted responses
and publication when starting another proposal.

**Rule:** Each proposal must obtain its own fresh judgments bound to that
proposal. Responses and a published batch for proposal A cannot satisfy
proposal B, whether A was approved or rejected.

**Concrete failure:** The existing machine's `hasResponse` keys readiness by
step, agent, and round (`src/machine.ts:57–60`); its current round calculation
uses null for non-revision steps (`src/machine.ts:214`). On a second visit to
`R4.amend-ballot`, the first visit's responses therefore still satisfy every
voter. `hasPublishedBatch` checks those response identities and roster, not
the current proposal's bound inputs (`src/machine.ts:67–98`). Merely adding
the new ballot kind to these helpers allows an earlier approval to authorize
a second set of files without new votes, or an earlier rejection to reject
every corrected request immediately. A derived decision hash alone does not
fix response/batch eligibility.

**Smallest correction:** Persist a unique proposal sequence/identity and use
it consistently in actions, accepted-response selection, batch identity and
paths, restart, and drop recovery, separate from the saved revision round.
Test two different proposals and rejection followed by a corrected proposal.

### 5. [P1] Antigravity: absence-only detection misses the already-rejected implementation case

**Plan claim:** The evidence file entry and first evidence test detect the
amendment Markdown only when the implementation-ready signal is absent.
The action instruction says to publish the amendment Markdown when an
omission is discovered.

**Rule:** The recovery route must work after the coordinator has rejected an
out-of-map ready signal, not only before the first ready signal exists.

**Concrete failure:** An agent has already pushed implementation-ready and
received an out-of-map rejection for a missing test file. It then commits
the instructed amendment Markdown. Git retains the earlier ready-signal file
in that commit. The plan's absence-only condition is false, so the verifier
reads/rejects the old ready signal again and never opens the amendment ballot.
The documented recovery reproduces the issue's deadlock unless the agent
guesses an unstated deletion of the other artifact.

**Smallest correction:** Define an explicit, current-action-bound amendment
submission that is distinguishable from an old ready signal, rather than
using mere file absence. Add the regression with both files present after an
initial out-of-map rejection.

### 6. [P1] Antigravity: the exact file map omits a mandatory type integration and the publication design stops short of usable evidence

**Plan claim:** The steps entry adds two `EvidenceId` variants, but the exact
file map excludes `src/agentLanguage.ts`. The publication entry only maps the
new step to a batch kind; no canonical amendment artifact schema/publication
shape is specified, and `src/protocol.ts` is also absent from the map.

**Rule:** The approved file map must include files required to keep exhaustive
types compiling, and a new ballot must be serializable as its own canonical
evidence before the machine waits for its publication.

**Concrete failure:** `AGENT_FACING_SUBJECT` is a `Record<EvidenceId, string>`
in `src/agentLanguage.ts:117–128`. Adding the planned identifiers without
changing that out-of-scope file makes `pnpm typecheck` fail—the same
missing-file-map problem this issue is meant to repair. Separately, changing
only the batch-kind mapping leaves `buildBallotBatchFileMap` using its
consensus fallback (`src/ballotPublication.ts:359–378`), which throws because
an amendment ballot has no bound revision pin. Thus collecting approvals
cannot finish publication as described.

**Smallest correction:** Include the language mapping and canonical protocol
schema work in the file map, and specify the complete amendment batch builder
with proposal citations and approve/reject semantics. Extend existing schema
and publisher tests. The listed reuse functions also need correction:
`inputsForStep`, `validateBallotResponse`, and `buildBallotBatchRecord` do not
exist here; the actual entry points include `deriveBoundInputs`,
`parseBallotResponse`, and `prepareBallotBatch`.

## Conclusion

- **Claude:** smallest file count and good reuse of existing plumbing, but
  not acceptable as written: declarations substitute for agreement in reviewed
  mode, and amendment evidence can disappear from the final judgment.
- **Cursor:** stays within the intended additive correction and reuses the
  right scope/ballot primitives, with no unnecessary new source files. It
  needs a concrete admission contract and proposal-specific vote lifecycle;
  the currently proposed union/first-ballot tests do not cover those failures.
- **Antigravity:** targets the requested agreement mechanism and existing
  fixtures, but needs a working post-rejection entry point, fresh repeated
  ballots, and a mechanically complete source map/publication path. Its Tests
  section should also explicitly name `pnpm check:fast` and `pnpm check`.
- **Codex:** no blocking finding identified in the bound plan. It is broader
  in file count, but the changes are tied to the existing request, ballot,
  evidence, rendering, recovery, and test layers; it adds no product files,
  dependencies, or general workflow framework. Its explicit admission,
  publication-before-authorization, separate amendment sequence, saved
  revision parent/round, and drop/restart tests address the failures above.
  Keep implementation limited to those integration points and reuse the
  existing canary rather than expanding test infrastructure.

The review favors explicit agreed additive amendments, not an unchecked
exception to the selected file map. These are plan-level findings; no product
implementation has been changed or claimed verified by this review.
