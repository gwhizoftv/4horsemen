# Issue 109 — eliminate deterministic agent artifact phases

Remove R3.publish-selection, R5.reviser-auth, and R6.declare. The
coordinator derives, persists, and journals those three decisions itself and
advances directly to the next agent-facing step. Breaking change: no migration,
no dual sequences, no legacy parsers. Old runtime state fails closed.

## Exact File List to be changed or deleted

No file is deleted. Fourteen existing files change.

### `src/steps.ts`

- Delete `"R3.publish-selection"`, `"R5.reviser-auth"`, `"R6.declare"` from
  `WorkflowStepId`, from `STEP_DEFINITIONS`, from `consensusSteps`, and from
  `reviewedSteps`. `consensusSteps` becomes 10 entries, `reviewedSteps` 6,
  `soloSteps` stays 4.
- Delete `"selection-published"`, `"reviser-authorized"`, `"consensus-declared"`
  from `EvidenceId`. `GateId` is unchanged: `gate-3-selection`,
  `gate-5-comparison`, and `gate-6-consensus` each still carry surviving steps.
- Delete `expectedSelectedAgents`, `expectedImplementationAgent`,
  `expectedImplementationPin`, and `expectedReviser` from `InternalOrder`; they
  exist only to bind the three removed verifications.
- Delete `selectedAgents` and `reviser` from `EvidenceObservation` and from the
  `accept-submission` variant of `MachineDecision`; no surviving evidence
  branch produces either.
- Add `export type DerivedDecisionKind = "plan-selection" |
  "implementation-selection" | "consensus";` and a new pure `MachineDecision`
  variant `{ type: "derive-decision"; kind: DerivedDecisionKind; round: number |
  null }`. The variant carries no computed result: derivation is recomputed
  under the state lock so a decision cannot be persisted from a stale snapshot.

### `src/derive.ts` (new — see the creation list)

### `src/machine.ts`

- Shorten `globalOrder` to the 10 remaining ids so `normalizeCurrentStep` still
  ranks a profile switch correctly.
- Replace the three-way `designated` expression: R4.implement uses the first
  active agent of `cursors.derived.planSelection?.selectedAgents`; every other
  reviser-participant step uses `cursors.derived.implementationSelection?.reviser`;
  both fall back to `cursors.activeRoster[0]` when the derivation has not run
  (solo, and reviewed before selection).
- In the `complete` branch, before computing `nextStep`:
  - `current === "R3.plan-ballot"` and profile is not solo: call
    `derivePlanSelection`. If it returns a decision whose `decisionId` differs
    from `cursors.derived.planSelection?.decisionId`, return
    `[{ type: "derive-decision", kind: "plan-selection", round: null }]`.
  - `current === "R5.compare-ballot"`: same shape with
    `deriveImplementationSelection` against derived.implementationSelection.
  - `current === "R6.ballot"`: keep the existing `escalate` and `revise` checks
    and the revision-limit owner question **first**, unchanged and returning
    before any derivation; only on all-`approve` call `deriveConsensus(cursors,
    round)` and emit `derive-decision` with `kind: "consensus"` when its
    `decisionId` is new.
  - When the decision is already persisted, fall through to the existing
    `advance-step`, which now names R4.implement, R6.revise, and
    R7.finalize respectively.
- Delete `"R6.declare"` from the `nextRound` test.

### `src/runLoop.ts`

- `deriveBoundInputs`: delete the R3.publish-selection, R5.reviser-auth, and
  R6.declare branches. R4.implement binds the accepted R2.plan rows of
  derived.planSelection.selectedAgents filtered to the active roster, falling
  back to `activeRoster[0]` when there is no plan selection (solo). R6.revise
  round 1 binds the accepted R4.implement row matching
  derived.implementationSelection.implementationAgent **and**
  `implementationPin`; later rounds keep the prior-revision binding.
  R7.finalize binds derived.consensus.consensusPin — resolved back to its
  accepted R6.revise row — when consensus exists, otherwise the accepted
  R4.implement rows as today.
- `selectedPlanAgents`: read derived.planSelection.selectedAgents intersected
  with the active roster instead of the last accepted R3.publish-selection
  row; keep the active-roster fallback that feeds `approvedPathsForOrder` and
  `resolveApprovedPaths`.
- `buildOrder`: delete `selectedPlan`, `selectedImplementation`,
  `selectedImplementationSubmission`, and every `expected*` field from both the
  scaffold context and the returned order. `deterministicWinner` stays exported
  — `src/derive.ts` and `src/cli.ts` both use it and the voting policy does not
  change.
- `accept`: delete the R3.publish-selection / R5.reviser-auth selection
  mutation, the decision.reviser active-roster guard, the `reviser:` field on
  the returned state, and the `selectedAgents` / `reviser` spreads into
  `AcceptedSubmission`.
- Add a private `applyDerivedDecision(start, cursors, decision)`. Inside one
  this.mutate call it recomputes the decision from `current` (never from the
  snapshot the machine saw), re-checks that every cited input is still present
  in current.accepted and that its agent is still in current.activeRoster,
  returns `current` unchanged when the recomputed `decisionId` already equals
  the stored one, otherwise writes the record into current.derived with
  `supersedes` set to the displaced `decisionId` (or `null`) and appends one
  `decision-derived` journal event.
- `applyDecisions`: dispatch `derive-decision` to that method.
- `publishAcceptedFinalization`: the `pr-created` journal event reads
  `current.derived.implementationSelection?.reviser`.

### `src/state.ts`

- `RUNTIME_FORMAT_VERSION` 2 → 3.
- Delete the three ids from `stepIdSchema` and the three from
  `evidenceIdSchema`.
- Delete `selectedAgents` and `reviser` from `acceptedSubmissionSchema`.
- Delete the top-level `reviser` field and the whole `selection` object from
  `cursorsStateSchema`; add a strict `derived` object with nullable
  `planSelection`, `implementationSelection`, and `consensus` members. Every
  member carries `algorithm`, `inputSetHash`, `activeRoster`, `inputs`
  (`{ agent, submissionSha, path }`), `decisionId`, `supersedes` (nullable),
  and `decidedAt`; `planSelection` adds `selectedAgents`,
  `implementationSelection` adds `implementationAgent`, `implementationPin`,
  `reviser`, and `consensus` adds `round` and `consensusPin`. No summary field
  is duplicated outside these records.
- `initialCursors`: emit `derived: { planSelection: null,
  implementationSelection: null, consensus: null }` in place of `reviser` and
  `selection`.
- `dropAgent`: replace the `selection`/`reviser` pruning with pruning of
  `derived` — null out any derived record whose selected agent, implementation
  agent, or reviser is the dropped agent, or whose `inputs` cite it. The next
  tick re-derives and journals a superseding decision.
- Add `"decision-derived"` to the `journalEventSchema` type enum.
- Add `assertRuntimeFormat(path, value)`, called from `readStartState`,
  `readCursorsState`, and `readJournal` before schema parsing: when the document
  carries a numeric `formatVersion` other than `RUNTIME_FORMAT_VERSION`, throw a
  message naming both versions and instructing the owner to run
  `coord wipe-issue <n>` and restart, stating explicitly that no migration
  exists. This is what makes the bump fail closed with remediation instead of a
  raw Zod union error.

### `src/protocol.ts`

- Delete `selectionArtifactSchema`, `reviserAuthorizationArtifactSchema`,
  `consensusDeclarationArtifactSchema`, their three exported types, and their
  three entries in the `publishedArtifactSchema` union. No legacy parser is kept.

### `src/evidence.ts`

- Delete the `selection-published`, `reviser-authorized`, and
  `consensus-declared` branches of `evaluateEvidence`, the three now-unused
  schema imports, and `sameStrings` (its only caller is the selection branch).
- Delete `selectedAgents` and `reviser` from the `satisfied` helper's picked
  observation key list.

### `src/orderScaffold.ts`

- Delete the R3.publish-selection, R5.reviser-auth, and R6.declare cases
  of `artifactScaffoldValue` and the four `expected*` fields of
  `ArtifactScaffoldContext`.

### `src/agentLanguage.ts`

- Delete the three evidence ids from `EVIDENCE_IDS` and their entries in
  `AGENT_FACING_SUBJECT`.

### `src/cli.ts`

- Drop handling: replace the `reselectPlan` / `reselectImplementation` /
  `reselectReviser` block and its writes to next.selection / next.reviser.
  `dropAgent` has already invalidated the affected derived records; the CLI now
  only filters accepted rows and clears the owner question, and leaves
  re-derivation to the next coordinator tick so exactly one code path computes
  and journals a decision.
- Delete the `submission.reviser === dropped || submission.selectedAgents?.includes(dropped)`
  clause from the accepted-row filter (those fields no longer exist).
- The refuse-to-rebind guard reads
  `current.derived.implementationSelection?.reviser` instead of
  current.selection.reviser / current.reviser.

### `src/issueReport.ts`

- Read cursors.derived.implementationSelection for the chosen agent and the
  implementation pin; prefer derived.consensus.consensusPin for the reported
  pin when consensus exists.

### `docs/analytics.md`

- Mark the two issue-76 tables as a pre-change baseline and state that
  R3.publish-selection, R5.reviser-auth, and R6.declare no longer exist,
  with the new 10/6/4 agent-facing step counts. The measured numbers are
  historical fact and are not rewritten.

### `docs/coord-driver.md`

- Document the three coordinator-derived decisions, the `derived` block in
  cursor state, the `decision-derived` journal event, and the runtime-format
  bump with its wipe/restart remediation.

### `docs/repo-map.md`

- Add `src/derive.ts` to the state-machine row and to the "where do I change
  X" table.

### Tests changed

`test/machine.test.ts`, `test/runLoop.test.ts`, `test/evidence.test.ts`,
`test/orderScaffold.test.ts`, `test/action.test.ts`, `test/state.test.ts`,
`test/cli.test.ts`, `test/integration.test.ts`, `test/analytics.test.ts`,
`test/agentLanguage.test.ts`, `test/issueReport.test.ts` — detailed in **Tests**.

## Exact file list to be created

- `src/derive.ts` — the only place the three decisions are computed. Pure, no
  I/O, imports `computeInputSetHash` from `src/evidence.ts` and
  `deterministicWinner` from `src/runLoop.ts` (neither imports this module, so
  no cycle is introduced). Exports:
  - `PLURALITY_ALGORITHM = "plurality-active-roster-v1"` and
    `UNANIMOUS_ALGORITHM = "unanimous-active-roster-v1"`;
  - `decisionIdentity(kind, inputSetHash, round)` — the durable idempotency key;
  - `derivePlanSelection(cursors, now)` — eligible choices are agents with an
    accepted R2.plan row that are still on the active roster; the tally and
    the active-roster-order tie-break are `deterministicWinner`;
  - `deriveImplementationSelection(cursors, now)` — same policy over
    R5.compare-ballot and accepted R4.implement rows, resolving the winner's
    exact `productPin` and setting `reviser` to that same agent;
  - `deriveConsensus(cursors, round, now)` — returns `null` unless every active
    participant has an accepted R6.ballot row for `round` and all are
    `approve`; the pin is the `productPin` of the single accepted R6.revise
    row for that round.
  Each returns `null` rather than a partial record when an input is missing or a
  pin is unresolvable, so an incomplete gate can never be persisted as a
  decision.
- `test/derive.test.ts` — unit coverage for the module, listed in **Tests**.

## Tests

Run `pnpm check:fast` (lint, typecheck, `vitest run --config vitest.config.ts`)
before each commit and `pnpm check` (build + check:fast + e2e) for final
verification.

New file `test/derive.test.ts`:

1. plan plurality: three ballots, two for `codex` — `selectedAgents` is
   `["codex"]`, `algorithm` is the plurality id, `inputs` cite each ballot's
   exact `submissionSha` and path.
2. plan tie-break: one ballot each for two eligible agents — the winner is the
   one earlier in `activeRoster`; reordering the roster flips the winner and
   changes nothing else.
3. implementation plurality and implementation tie-break: the same two cases
   over R5.compare-ballot, asserting `implementationPin` equals the winner's
   accepted R4.implement `productPin` and `reviser === implementationAgent`.
4. exclusion: a ballot from an agent absent from `activeRoster`, and a ballot
   whose `choice` has no accepted plan, are excluded from the tally and from
   `inputs`.
5. reproducibility and identity: the same input set yields an identical
   `inputSetHash` and `decisionId`; changing one cited `submissionSha` changes
   both.
6. consensus: unanimous `approve` at round 2 yields `consensusPin` equal to that
   round's accepted revision pin and `round === 2`; a single `revise` and a
   single `escalate` each yield `null`; a missing ballot from an active agent
   yields `null`.

`test/machine.test.ts`:

7. complete R3.plan-ballot with no stored plan selection emits exactly
   `derive-decision`/`plan-selection`; with the matching decision stored it
   emits `advance-step` from R3.plan-ballot to R4.implement — and in neither
   case any `prepare-action`.
8. the same pair for R5.compare-ballot → R6.revise round 1 and for unanimous
   R6.ballot → R7.finalize.
9. a `revise` ballot still advances to R6.revise at the next round and emits
   no `derive-decision`; an `escalate` ballot still returns
   `owner-action-required`/`ballot-escalation`; at `maxRevisionRounds` the
   `revision-limit` question is unchanged.
10. revision work still routes to derived.implementationSelection.reviser
    (replacing the existing persisted-reviser test).

`test/runLoop.test.ts`:

11. a tick over complete plan ballots persists derived.planSelection, appends
    exactly one `decision-derived` journal event, prepares no action for any
    agent, and leaves `accepted` with no new row.
12. running that tick a second and third time appends no further journal event
    and does not change `stateRevision` on account of the decision.
13. `deriveBoundInputs("R4.implement")` binds only the derived winner's plan;
    `deriveBoundInputs("R6.revise", 1)` binds exactly the derived
    implementation pin; consensus-profile R7.finalize binds
    derived.consensus.consensusPin, and a reviewed/solo run binds its accepted
    R4.implement pin.
14. `resolveApprovedPaths` still re-extracts the selected plan's file map with
    the selection now coming from derived.planSelection (replaces the two
    tests that seed an accepted R3.publish-selection row).
15. after a drop invalidates derived.implementationSelection, the next tick
    re-derives from the remaining evidence and journals a `decision-derived`
    event whose `supersedes` names the prior `decisionId`.

`test/state.test.ts`:

16. a cursors document with `formatVersion: 2` is rejected with a message naming
    both versions and `coord wipe-issue`, and no partial state is returned; the
    same for start.json and for the journal.
17. `derived` is strict: an unknown key, a missing `inputSetHash`, and a
    non-SHA `consensusPin` each fail; `dropAgent` nulls a derived record naming
    the dropped agent.

`test/evidence.test.ts`: delete the selection, reviser-authorization, and
consensus-declaration verification cases and the three step/evidence rows in the
two exhaustiveness tables; keep those tables exhaustive over the 10 surviving
steps so a re-added phase fails the suite.

`test/protocol.test.ts` needs no change (it never exercised the three removed
schemas); `test/orderScaffold.test.ts` and `test/action.test.ts` drop the
`expected*` context/order fields.

`test/integration.test.ts`: the end-to-end consensus run submits 10 agent
artifacts instead of 13. After the plan-ballot tick it asserts the step is
R4.implement (not R3.publish-selection), that derived.planSelection is
persisted, and that no agent action file was written for the removed phase;
likewise R5.compare-ballot → R6.revise and unanimous R6.ballot →
R7.finalize. It also asserts that no `.plans/issue-1/selection.json`,
`.signals/issue-1/reviser-authorization.json`, or `.signals/issue-1/consensus.json`
is required or produced.

`test/cli.test.ts`: the drop/rebind guard test seeds `derived` instead of
`selection`; add a case asserting a drop that invalidates a derived record
leaves no stale reviser or pin behind in downstream routing.

`test/analytics.test.ts`: the inline journal fixture uses the new topology, and
the phase-count assertion covers 10 consensus phases.

`test/agentLanguage.test.ts`: the banned-term test no longer expects
`reviser-authorized`; it asserts the alternation is exhaustive over the
surviving `EvidenceId` values.

`test/issueReport.test.ts`: the report fixture seeds `derived` and still prints
the chosen agent and pin.

## Alternatives Rejected

**Keep the phases but auto-publish the artifacts from the coordinator.** The
coordinator would write and commit selection.json itself. Rejected: an
`AcceptedSubmission` means an agent published evidence at a reachable Git SHA,
and the issue forbids fabricating that provenance. It would also keep three Git
round trips whose removal is the point.

**Store the derived result in cursors.selection and leave the shape alone.**
Smaller diff, but the issue requires the algorithm id, input citations, input-set
hash, roster snapshot, and timestamp to be canonical, and forbids parallel
summary fields that can drift. Keeping `selection` alongside `derived` would
create exactly that pair of fields, and the drop path would have to null both.

**Compute the decision in `src/machine.ts` and hand the finished record to the
run loop inside the decision.** Rejected: the machine runs on a snapshot read
outside the state lock, so a decision computed there could be persisted after a
concurrent drop. The `derive-decision` variant deliberately carries only the
kind and round; the run loop recomputes under the lock.

**Derive on write inside `accept()` when the last ballot lands.** Rejected: it
would not be idempotent across a crash between accept and persist, and it hides
a workflow transition inside an evidence-acceptance path. A separate decision
keyed by `decisionId` makes a repeated tick a no-op by construction.

**Migrate old runtime state.** Explicitly forbidden by the issue.

## Risks and Mitigations

- **A drop leaves stale downstream routing.** `dropAgent` nulls any derived
  record naming the dropped agent, and the next tick re-derives with
  `supersedes` set. Tests 15 and the `test/cli.test.ts` addition cover it.
- **Duplicate journal derivations under repeated ticks.** `decisionId` is
  `kind + inputSetHash (+ round)`; `applyDerivedDecision` returns state unchanged
  when it already matches. Test 12 asserts it directly.
- **A decision persisted from a stale snapshot.** Recomputation happens inside
  `mutateCursorsState` and re-validates every cited input against the current
  `accepted` and `activeRoster`.
- **`escalate` or `revise` accidentally deriving consensus.** The existing
  dispositions are checked and returned from before any derivation call; test 9
  pins the ordering.
- **The runtime bump silently half-parsing an old issue.** `assertRuntimeFormat`
  runs before schema parsing on all three documents and names the wipe command;
  test 16 covers each document.
- **A derived.consensus pin that no accepted revision backs.**
  `deriveConsensus` returns `null` unless the round's accepted R6.revise row
  supplies the pin, so R7.finalize can only bind evidence-backed commits.
- **Import cycle from the new module.** `src/derive.ts` imports from
  `src/evidence.ts` and `src/runLoop.ts`; neither imports `src/derive.ts`
  (`src/machine.ts` and `src/runLoop.ts` import it). `pnpm typecheck` and the
  build catch a violation.

## Conclusion

Three phases, three evidence ids, three published-artifact schemas, and three
verification branches are deleted; one pure derivation module and one canonical
`derived` state block replace them. Consensus becomes 10 agent-facing steps,
reviewed 6, solo 4. Every decision keeps exact accepted input citations, an
input-set hash, an algorithm version, and a roster snapshot, and is journaled
once as `decision-derived`. The runtime format bump to 3 fails old state closed
with a wipe/restart message and no migration code.

**Out of scope, and deliberately not planned:** `.plans/issue-1/workflow-algorithm.md`
and `.plans/issue-89/discussion.md` also name the three removed phases, but the
coordinator rejects any implementation commit touching another issue's plan
tree — those paths cannot appear in an approved file map. They need a separate
owner-driven change.
