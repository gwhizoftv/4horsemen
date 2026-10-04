# Plan — issue 137: declared scope amendments when the plan file map overlooked a path

## Problem

`evaluateEvidence` (`src/evidence.ts`) rejects an `implementation-ready` or
`revision-ready` artifact whenever the pinned diff touches a path outside the
selected plan's file map (`implementation changes paths outside the approved
file map: …`). The map is frozen at the selected plan's submission
(`resolveApprovedPaths` in `src/runLoop.ts` re-reads the plan blob at its
accepted `submissionSha`). When the plan forgot a path the change genuinely
needs — the issue's example is the test file paired with a changed source
file — the implementer is re-issued the same action forever: it cannot finish
the intended scope without touching the path, and it cannot touch the path
without being rejected.

## Design

Let the implementer **declare** each overlooked path, with a reason, in the
signal artifact it already publishes, and let the peers who already vote on
implementations **see** those declarations when they vote. No new step, gate,
ballot, or file is added.

1. `implementation-ready` and `revision-ready` gain an optional
   `scopeAmendments: [{ "path": "<repo path>", "reason": "<why the plan needed it>" }]`.
2. Evidence accepts a changed path outside the approved map only when it is
   declared there. Every declaration must be honest: it must name an exact path
   (no directory or glob), must actually be changed by the pinned diff, must lie
   outside the approved map, and must be unique. Undeclared out-of-map paths are
   still rejected, and the rejection text now tells the agent how to declare
   them. `approvedPaths` in the artifact must still equal the selected plan map
   exactly — the plan itself is not rewritten.
3. Accepted declarations are stored on the accepted submission
   (`scopeAmendments` beside `approvedPaths`) and attached to the matching pin in
   the advisory "Changed paths for the bound pins" section, so every R5.compare,
   R5.compare-ballot, R6.revise and R6.ballot action shows, per pin, which paths
   were added outside the plan and why. That is where the agents agree: in the
   consensus profile peers choose between implementations and approve/revise
   revisions with the amendments in front of them, so an unjustified amendment
   is voted down through the existing ballots.
4. The R4.implement and R6.revise task text gains one sentence describing the
   field so the agent learns the escape hatch before it is rejected.

Revision is checked against the input pin (`changedPaths(inputPin, revised)`),
so a reviser that touches an R4-amended path again redeclares it in its own
`revision-ready` artifact; that keeps every amendment visible at the ballot that
judges it, with no folding of earlier amendments into `approvedPaths`.

## Exact File List to be changed or deleted

- `src/protocol.ts` — add a strict `scopeAmendmentSchema`
  (`{ path: repositoryPathSchema, reason: rationaleSchema }`) and an optional
  `scopeAmendments: z.array(scopeAmendmentSchema).min(1)` on
  `implementationReadyArtifactSchema` and `revisionReadyArtifactSchema`; export
  the `ScopeAmendment` type.
- `src/evidence.ts` — in the `implementation-pinned` and `revision-pinned`
  branches: validate declarations (exact path, unique, changed, outside the
  approved map); exclude declared paths from `disallowed`; extend the
  out-of-map error with "declare each in scopeAmendments with a reason if the
  selected plan overlooked it"; return accepted declarations through
  `satisfied(..., { scopeAmendments })` (add `"scopeAmendments"` to the
  `satisfied` extra `Pick`).
- `src/steps.ts` — optional `scopeAmendments?: readonly ScopeAmendment[]` on
  `EvidenceObservation`, on the `accept-submission` `MachineDecision`, and on
  `ChangeScopeEntry` (`amendments?`); one added sentence in the `R4.implement`
  and `R6.revise` task strings.
- `src/machine.ts` — pass `observation.scopeAmendments` through to the
  `accept-submission` decision exactly as `approvedPaths` is passed.
- `src/state.ts` — optional `scopeAmendments` array of strict
  `{ path, reason }` on `acceptedSubmissionSchema` (optional, so existing
  cursors.json files still parse).
- `src/runLoop.ts` — copy `decision.scopeAmendments` onto the
  `AcceptedSubmission` in the accept-submission handler; give
  `resolveChangeScope` a fourth parameter `accepted: readonly AcceptedSubmission[] = []`
  and attach `amendments` from the R4/R6 accepted submission whose
  `productPin` equals the entry's `commitSha`; pass `cursors.accepted` at its
  three call sites.
- `src/action.ts` — `changeScopeSection` renders, under each pin that has
  amendments, a `Scope amendments (outside the selected plan file map):` block
  with one `<json-encoded path> — <reason>` line each, and the section intro
  says the amendments are the implementer's declarations for the ballot to
  judge. Pins without amendments render exactly as today.
- `test/evidence.test.ts` — new cases (see Tests).
- `test/action.test.ts` — new case (see Tests).
- `test/runLoop.test.ts` — new cases (see Tests).
- `test/machine.test.ts` — extend the existing accept-submission pass-through
  case to carry `scopeAmendments`.

## Exact file list to be created

None. `.plans/issue-137/plan.md` (this file) is the only new path and is a
coordination artifact. Every product change lands in existing files.

## Reuse and Scope

- Reuse `matchesApprovedPath`, `isCurrentIssueCoordinationPath`,
  `mirror.changedPaths`, `rejected`/`satisfied` in `src/evidence.ts` for the
  amendment checks; the existing `disallowed` computation simply gains one more
  exclusion.
- Reuse `repositoryPathSchema` and `rationaleSchema` from `src/protocol.ts`
  for the amendment shape (same length rule as ballot rationales), and
  `parseJsonWithSchema` for strict parsing.
- Reuse the `approvedPaths` plumbing as the template for the new optional field
  through `EvidenceObservation` → `MachineDecision` → `AcceptedSubmission`
  (`src/machine.ts`, `src/runLoop.ts`, `src/state.ts`).
- Reuse `resolveChangeScope`, `ChangeScopeEntry`, `changeScopeSection`, and
  `encodePath` to surface amendments, instead of a new action section or a new
  materialized file.
- Reuse the existing ballots (`R5.compare-ballot`, `R6.ballot`) as the
  agreement mechanism; no new workflow step or gate.
- Tests reuse the `mirror(...)` fixture in `test/evidence.test.ts`, the
  `changeScopeSection` assertions in `test/action.test.ts`, and the
  `resolveChangeScope` fixtures in `test/runLoop.test.ts`.
- Out of scope: rewriting the selected plan, an owner-approval step for
  amendments, folding R4 amendments into R6 `approvedPaths`, and editing
  `templates/product/AGENTS.protocol.md` / `AGENTS.md` (the per-action task text
  and rejection message are the authoritative instructions; see Alternatives).

## Tests

All new cases fail before the change (the field is rejected by the strict
schema, or the section/attachment does not exist) and pass after it.

`test/evidence.test.ts` (extend, using the existing `mirror` fixture with a
`changedPaths` override returning the approved file plus test/foo.test.ts):

1. `implementation-pinned` with test/foo.test.ts outside the map and declared
   in `scopeAmendments` with a reason → `satisfied`, and the observation carries
   that single amendment.
2. Same diff without the declaration → `rejected`, outstanding contains
   `outside the approved file map` and `scopeAmendments` (the hint).
3. Dishonest declarations are rejected: a declared path not in the diff, a
   declared path already inside the approved map, a duplicated path, and a
   directory-style path (test/) each produce a rejection naming the path.
4. `revision-pinned` with an out-of-map change declared → `satisfied` with the
   amendment; undeclared → `rejected` (proves the revision branch is wired too).

`test/runLoop.test.ts` (extend):

5. `resolveChangeScope` given an accepted `R4.implement` submission whose
   `productPin` equals a bound implementation pin and which carries
   `scopeAmendments` returns that entry with `amendments`; a pin with no
   accepted amendments has none.
6. Accepting an `accept-submission` decision with `scopeAmendments` persists it
   on the accepted submission and cursors.json round-trips through
   `acceptedSubmissionSchema` (join the existing accept-submission persistence
   case if one asserts `approvedPaths`; otherwise add one case).

`test/action.test.ts` (extend):

7. A comparison order whose `changeScope` entry has `amendments` renders the
   `Scope amendments` block with the encoded path and reason; an entry without
   amendments renders byte-identical to today.

`test/machine.test.ts` (extend the existing accept-submission case):

8. A satisfied observation with `scopeAmendments` yields an `accept-submission`
   decision carrying it.

Commands: `pnpm check:fast` before each commit (lint, typecheck, fast tests);
the coordinator runs full `pnpm check` on the approved commit.

## Alternatives Rejected

- **Let the implementer edit the selected plan's file map mid-implementation.**
  The map is read from the plan's accepted `submissionSha`, which is the record
  peers voted on; rewriting it erases what was agreed and leaves no record of
  what changed or why.
- **A new amendment step with its own ballot and gate.** Gives explicit
  agreement but adds a step, gate, ballot artifact, publication, and state
  machine transitions — far larger than the issue needs, and it stalls every
  implementer while peers vote on one test file. The existing comparison and
  consensus ballots already judge the whole pinned diff.
- **Heuristically auto-allow test files paired with approved sources.** Fixes
  only the example in the issue, silently, with no reason recorded; overlooked
  fixtures, configs, or callers would still deadlock the protocol.
- **Fold R4 amendments into R6 `approvedPaths`.** Saves a reviser one
  redeclaration but hides the amendment from the consensus ballot that judges
  the revision and adds a second source of approval.
- **Document the field in templates/product/AGENTS.protocol.md.** The action
  text is authoritative for format and is what the agent reads at the moment it
  matters; changing the installed protocol template also changes installed
  product files across workspaces for no behavioural gain.

## Risks and Mitigations

- **Implementers use amendments to widen scope at will.** Mitigation: each
  amendment must be an exact changed path outside the map with a non-empty
  reason, and every amendment is shown, per pin, in the compare and consensus
  ballot actions where peers can prefer another implementation or vote
  `revise`.
- **Solo and reviewed profiles have no post-implementation ballot.** There the
  amendment is still recorded in the committed `implementation-ready` artifact
  and on the accepted submission in cursors.json, and the PR is opened
  unmerged for the owner by default (`coord-open-unmerged`). This is no weaker
  than today's alternative, which is a stuck issue or an out-of-protocol owner
  intervention.
- **State compatibility.** `scopeAmendments` is optional in
  `acceptedSubmissionSchema` and in both artifact schemas, so existing runtime
  state and in-flight artifacts without it parse and validate unchanged.
- **Action text drift breaking snapshot-style tests.** The two task strings
  change by one appended sentence; any test asserting them verbatim is updated
  in the same commit (none found by `grep` for the task text outside
  `src/steps.ts`).
- **Advisory section size.** Amendments are bounded by the paths actually
  changed outside the map, which are already capped per pin by
  `CHANGE_SCOPE_PATH_LIMIT`; amendments are attached only for listed pins.

## Conclusion

Add an optional, strictly validated `scopeAmendments` list to the
implementation- and revision-ready artifacts, accept out-of-map changes only
when declared there with a reason, persist the accepted declarations, and show
them beside each pin in the actions where peers vote. The overlooked-path
deadlock is removed, the selected plan stays the record of what was agreed, and
agreement on any extension happens in the ballots the workflow already runs —
with changes confined to seven existing source files and four existing test
files.
