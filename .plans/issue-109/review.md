# Plan review — issue 109 (eliminate deterministic agent artifact phases)

Bound plans reviewed:

- cursor — `bcf63b62794fb8245d8eabb16d35d38f88ee51e3` at `.plans/issue-109/plan.md`
- claude — `0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04` at `.plans/issue-109/plan.md`
- codex — `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd` at `.plans/issue-109/plan.md`

All three agree on the shape of the change: delete the three steps and their
evidence ids, add a canonical `derived` block, journal `decision-derived`, bump
the runtime format, no migration. The findings below are the places where a plan
as written produces a wrong or rejected implementation. Findings 1 and 2 apply to
my own plan (`0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04`) as well as to a peer's,
and I have named it wherever it is at fault.

## Findings

### 1. Re-deriving plan selection after a drop silently rewrites the approved file map

**Claim.** cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3`, `src/cli.ts` bullet:
"recompute/invalidate derived plan and implementation selections from remaining
accepted evidence". codex `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd`: "drop
handling invalidates dependent derived records ... and reissues bindings".
claude `0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04`, `src/state.ts` bullet: "null
out any derived record whose selected agent ... is the dropped agent. The next
tick re-derives".

**Rule that must hold.** The approved file map bound to an already-accepted
implementation must not change underneath it. `src/runLoop.ts:255-259`
(`selectedPlanAgents`) reads the accepted selection row with `activeOnly = false`
on purpose: when the selected plan agent is dropped, `dropAgent`
(`src/state.ts:770-796`) empties `selection.planAgents`, and that unfiltered
fallback is what restores the original `selectedAgents` so
`approvedPathsForOrder` and `resolveApprovedPaths` keep returning the file map
the accepted implementations were verified against.

**Concrete failure.** Consensus run, roster `[claude, codex, cursor]`, plan
winner `codex`, all three implementations accepted at `R4.implement` against
codex's file map. The owner drops `codex` during `R6.revise`. Under all three
plans the derived plan selection is invalidated and recomputed from the two
remaining plan ballots, which elect `claude`; `selectedPlanAgents` now returns
`["claude"]`, so `resolveApprovedPaths` extracts claude's file map. The reviser's
revision touches only paths from codex's plan — the plan it was ordered to
implement — and `src/evidence.ts:395` rejects it with "revision changes paths
outside the approved file map". The run cannot progress: every reissue re-derives
the same wrong map. Today this cannot happen, because the deleted accepted
selection row survives the drop.

**Smallest correction.** Freeze the approved file map with the decision. Record
the selected agents' plan submission SHAs and their extracted `approvedPaths` in
`derived.planSelection`, and re-derive plan selection only while
`accepted` holds no `R4.implement` row — once an implementation has been accepted
against a plan, a drop must invalidate the *reviser*, not the plan winner.

### 2. Deleting `cursors.selection` breaks reviewed-profile finalization routing

**Claim.** claude `0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04`, `src/machine.ts`
bullet, states the replacement rule explicitly and states it wrongly: "every
other reviser-participant step uses `derived.implementationSelection?.reviser`;
both fall back to `activeRoster[0]` when the derivation has not run (solo, and
reviewed before selection)". cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3`
and codex `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd` delete the same field and
never state any replacement rule for it — cursor's `src/machine.ts` bullet covers
only `globalOrder`, the derive decisions, escalation, and round accounting.

**Rule that must hold.** The reviewed profile has no `R5.compare-ballot`, so it
never produces an implementation selection, and `R7.finalize` must still be
ordered to the agent whose plan was selected and who therefore holds the
implementation pin. `src/machine.ts:110-115` achieves this through the last term
of the fallback chain, `cursors.selection.planAgents[0]`;
`participantsForStep` (`src/steps.ts:224-232`) turns an undefined designate into
`activeRoster[0]`.

**Concrete failure.** Reviewed run, roster `[claude, codex, cursor]`, plan winner
and implementer `cursor`. At `R7.finalize` there is no
`derived.implementationSelection`, so the designate falls back to
`activeRoster[0]` = `claude`. The coordinator prepares the finalization action
for `claude`, an agent that never implemented and whose branch has no
implementation pin; `deriveBoundInputs` binds cursor's accepted pin, and
`verifyFinalization` (`src/finalization.ts:90-99`) rejects claude's final commit
as not descending from the bound consensus commit. The reviewed profile cannot
finalize at all.

**Smallest correction.** Make the fallback chain end at the derived plan winner,
not at `activeRoster[0]`: `derived.implementationSelection?.reviser ??
derived.planSelection?.selectedAgents[0]`, with `activeRoster[0]` reserved for
solo, where no selection exists by construction.

### 3. cursor's file map omits the two files the runtime-format bump breaks

**Claim.** cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3` lists eleven test
files and bumps `RUNTIME_FORMAT_VERSION` from `2` to `3`. Neither
`test/cursorHookUsage.test.ts` nor `test/support/fixtures/analytics-journal.jsonl`
appears anywhere in its file map. The same omission is in my own plan,
`0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04`; codex
`a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd` lists both and is correct here.

**Rule that must hold.** A plan's backticked file map is the allowlist the
coordinator enforces against the implementation commit
(`extractApprovedPaths`, `src/evidence.ts:127-137`; `matchesApprovedPath`,
`src/evidence.ts:153-157`; rejection at `src/evidence.ts:330-336`). A file the
change must touch and the map does not name cannot be edited.

**Concrete failure.** `journalEventSchema` pins `formatVersion:
z.literal(RUNTIME_FORMAT_VERSION)` (`src/state.ts:420`).
`test/cursorHookUsage.test.ts:106` calls `journalEventSchema.parse` on four
literals carrying `formatVersion: 2` (lines 43, 58, 73, 93), and
`test/support/fixtures/analytics-journal.jsonl` is thirteen `formatVersion: 2`
records read by `test/analytics.test.ts:44` and copied verbatim into a live
journal by `test/cli.test.ts:371` and `test/cli.test.ts:930`. On the bump both
fail, so `pnpm check:fast` fails; fixing them puts two unapproved paths in the
implementation commit and `src/evidence.ts:336` rejects it. The plan is
unimplementable as written either way.

**Smallest correction.** Add both paths to the file map.

### 4. cursor's file map omits `test/action.test.ts`

**Claim.** cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3` removes the
scaffold cases and the verification branches for the three artifacts but never
names `test/action.test.ts`, and its `src/steps.ts` bullet does not say whether
the `expected*` order fields go.

**Rule that must hold.** Same allowlist rule as finding 3, plus: `pnpm
typecheck` compiles `test/tsconfig.json`, so a test-side object literal for a
type that lost a field must be updated in the same commit.

**Concrete failure.** `expectedSelectedAgents`, `expectedImplementationAgent`,
`expectedImplementationPin`, and `expectedReviser` on `InternalOrder`
(`src/steps.ts:281-284`) exist only to bind the selection and reviser-auth
verifications (`src/evidence.ts:308`, `src/evidence.ts:356-364`) and the two
scaffold cases (`src/orderScaffold.ts:70`, `src/orderScaffold.ts:88-93`).
`test/action.test.ts:31` constructs an `InternalOrder` literal containing
`expectedSelectedAgents: []`. Remove the field and typecheck fails on an
unlisted file; keep it and every `buildOrder` call site must go on populating a
field nothing reads, which contradicts the same plan's removal of the scaffold
and verification branches. Either branch fails.

**Smallest correction.** State that the four `expected*` fields are removed and
add `test/action.test.ts` to the file map. (`test/evidence.test.ts` and
`test/orderScaffold.test.ts` carry the same literals and are already listed.)

### 5. codex's journal deduplication contradicts the append-cost invariant

**Claim.** codex `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd`: "Journal append
checks that identity and reuses an existing matching event, so a retry after a
crash between journal append and cursor-state replacement cannot duplicate the
event."

**Rule that must hold.** `appendJournal` must not read the journal body.
`src/state.ts:638-668` computes the next sequence with `nextJournalSequence`,
which seeks from the end and parses only the final record, under the comment at
`src/state.ts:605`: "Read only the final journal record; append cost must not grow
with issue age".
The only API that returns prior events is `readJournal` (`src/state.ts:591-604`),
which parses every line.

**Concrete failure.** To "check that identity and reuse an existing matching
event", the derivation apply path must call `readJournal` (or an equivalent full
scan) inside the journal lock. `runTick` runs at `pollIntervalMs` — default
1000 ms (`src/state.ts` config default) — and reaches the derivation branch on
every tick while the gate is complete, so an issue whose journal has grown to
tens of thousands of lines pays a full parse of that file once per second, and
the invariant the existing comment protects is inverted by exactly the code the
plan adds.

**Smallest correction.** Do not dedupe against the journal. Compare the
recomputed `decisionId` with the one already stored in `cursors.derived[kind]`
inside the existing `mutateCursorsState` lock, and append the journal event only
on the write path that changes that field. The crash window codex is protecting
against is closed by ordering — write cursor state first, or accept one
duplicate journal line as the strictly cheaper failure — not by scanning.

### 6. codex's drop handling rewinds the workflow, which the issue does not ask for

**Claim.** codex `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd`: drop handling
"invalidates dependent derived records and accepted downstream work, resets to
the earliest affected remaining agent-facing step, and reissues bindings."

**Rule that must hold.** The issue's roster section says to preserve current
active-roster semantics and "existing owner-question behavior", and its non-goals
forbid changing the deterministic voting policy. The current drop path
(`src/cli.ts:321-331`, `src/state.ts:791-793`) discards accepted rows only for
the *current* step and never moves `issueCursor` backwards.

**Concrete failure.** Consensus run at `R6.ballot` round 2; the owner drops the
agent whose plan was selected. "Earliest affected remaining agent-facing step" is
`R4.implement`, since the plan selection feeds the implementation binding. The
run rewinds from round-2 balloting to implementation, discarding three accepted
implementations, an accepted comparison, three accepted comparison ballots, an
accepted revision, and the round-1 ballots — roughly forty minutes of agent work
by the issue-76 baseline — for a decision the issue asks only to recompute. No
acceptance criterion requests a rewind, and no test in the suite permits one.

**Smallest correction.** Bound invalidation to routing that has not yet produced
accepted evidence: recompute the reviser and the pending binding, leave
`issueCursor` and all accepted rows alone, and let the existing "cannot drop the
authorized reviser" refusal (`src/cli.ts:1260-1266`) continue to cover the case where
that is not possible.

### 7. cursor leaves the fate of `cursors.selection` undecided

**Claim.** cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3`, `src/state.ts`
bullet: "Replace **or retire** `cursors.selection` so downstream routing cannot
drift from derived evidence."

**Rule that must hold.** The issue states the derived structure "should contain
no parallel summary fields that can drift from the evidence used by downstream
actions". A plan heading is "Exact File List"; a disjunction is not an exact
instruction, and the two branches produce different state schemas.

**Concrete failure.** Take the "replace" branch: `cursors.selection` survives
beside `derived`. `dropAgent` (`src/state.ts:770-796`) prunes `selection` and the
new drop path prunes `derived`, so a drop that a future edit teaches only one of
them leaves `selection.implementationPin` naming a dropped agent's commit while
`derived.implementationSelection` is null — precisely the drift the issue
forbids, and `src/issueReport.ts:19`, which reads `selection`, would report
it. The plan's own reviewer cannot tell which schema to verify against.

**Smallest correction.** Say "delete `cursors.selection` and the top-level
`cursors.reviser`", and list the four readers that must move to `derived`:
`src/machine.ts:110-115`, `src/runLoop.ts:255-259`, `src/runLoop.ts:1250-1253`,
`src/issueReport.ts:19`.

## Conclusion

All three plans get the architecture right — canonical `derived` state, no
synthetic `accepted` rows, identity-keyed idempotency, a failing-closed format
bump — and any of them would produce a working implementation of the happy path.
The separating issues are the edges.

codex `a651dc57a1d1cddbf647decc0f7daf9fa2bfe8bd` has the most complete file map;
it is the only plan that catches `test/cursorHookUsage.test.ts` and the
`formatVersion: 2` analytics fixture, which findings 3 makes unavoidable. Its two
defects (5 and 6) are localized: both are single mechanisms that can be replaced
without touching the file map.

cursor `bcf63b62794fb8245d8eabb16d35d38f88ee51e3` is the weakest as written.
Findings 3 and 4 mean its file map cannot be implemented without a rejected
commit, and finding 7 leaves the central state decision open.

My own plan `0a7d41e2ee6135ebc5e1c4777be0226e1cb38c04` shares the file-map gap of
finding 3 and states the wrong routing rule in finding 2; it should not be
selected over codex's without those two corrections.

Finding 1 is unresolved in every plan and is the one that will break a real run
rather than a test. Whichever plan is selected must add the fix before
`R4.implement`: freeze the selected plan's approved file map into
`derived.planSelection`, and stop re-deriving plan selection once an
implementation has been accepted.
