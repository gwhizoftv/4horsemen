# Issue 109 implementation review

## Comparison

Three bound implementation pins were compared:

- cursor `0ea934235417926b4b8ba1c258b01959745878f0`
- codex `564ab5e7ca90dc682c970184b24fe0d3b4ddbf59`
- claude `fd9eff090797bb9efbcad51856c08ec2c378a762`

### How each pin was checked

Each peer pin was materialised in a detached worktree and run with this
repository's own toolchain: `tsc -p tsconfig.json --noEmit`, `tsc -p
test/tsconfig.json`, `eslint src test`, `vitest run --config vitest.config.ts`,
and `vitest run --config vitest.e2e.config.ts`.

All three pins typecheck and lint clean, and all three pass the end-to-end
canary. In a bare worktree, five cases in `test/cli.test.ts` (`CLI — install,
doctor, and the hook bridge`) fail identically for **every** pin, including
this reviewer's: `ensureBuilt` in `test/support/workspaceFixture.ts` needs a
real `pnpm install` plus `dist/` in the checkout it runs from. That is a
harness artifact of comparing pins out of tree, not a defect in any
implementation, and it is excluded from the counts below.

Passing tests over the twelve files this issue touches:

| pin | tests passing |
| --- | ---: |
| cursor `0ea9342` | 191 |
| codex `564ab5e` | 195 |
| claude `fd9eff0` | 229 |

### What all three did the same

All three removed `R3.publish-selection`, `R5.reviser-auth`, and `R6.declare`
from `WorkflowStepId`, `STEP_DEFINITIONS`, and every profile sequence (10/6/4);
removed `selection-published`, `reviser-authorized`, and `consensus-declared`
from `EvidenceId`, `agentLanguage.ts`, and the state enums; deleted the three
artifact schemas from `protocol.ts`, their `evaluateEvidence` branches, and
their `orderScaffold` cases; bumped `RUNTIME_FORMAT_VERSION` to 3 with no
migration; added a `derived` structure with `planSelection`,
`implementationSelection`, and `consensus`, each carrying an algorithm name, an
active-roster snapshot, exact accepted-submission citations, an input-set hash,
and a `decidedAt`; and added a `decision-derived` journal event. None inserts a
synthetic record into `accepted`. The e2e canary in all three observes the three
direct gate boundaries.

The remaining differences are in what happens when a decision is missing or
stale, which is where the issue's acceptance criteria are strictest.

## Findings

### 1. cursor: a permitted drop silently re-routes implementation to roster position

`src/runLoop.ts:309` and `src/runLoop.ts:348` (cursor
`0ea934235417926b4b8ba1c258b01959745878f0`); reached through
`src/machine.ts:58` and `src/state.ts:843`.

**The rule.** The issue states it twice: "Never silently retain a selected plan,
implementation, pin, or reviser that is no longer valid under the active
roster", and "It never falls back silently to roster position while a required
derived result is missing." A missing canonical decision must stop the workflow
or be recomputed — it must not be replaced by `activeRoster[0]`.

**The failure.** `invalidateDerivedForDrop` (`src/state.ts:843`) nulls
`planSelection` when the dropped agent is *cited*, and `computePlanSelectionDerived`
(`src/runLoop.ts:216`) cites **every accepted plan ballot** — one per active
agent. So dropping any agent that voted clears the decision, including a drop
that leaves the elected winner active and eligible. Nothing then restores it:
`rederiveAfterDrop` (`src/cli.ts:300`) never recomputes a derived record, and
`decide` only emits `derive-plan-selection` while `current === "R3.plan-ballot"`
(`src/machine.ts:168`). With the slot null,
`designatedImplementer` (`src/machine.ts:58`) returns `activeRoster[0]`,
`deriveBoundInputs` binds `[cursors.activeRoster[0]]` (`src/runLoop.ts:309`),
and `selectedPlanAgents` widens to `[...cursors.activeRoster]`
(`src/runLoop.ts:348`).

Run against the cursor pin, `reviewed` profile, roster `claude, codex, cursor`,
all three voting for `cursor`, cursor elected, then a permitted drop of
`claude` — a non-winner, not the reviser:

```
planSelection after drop: null
R4 bound inputs:  [ { agent: 'codex', ..., kind: 'selected-plan' } ]
decide:           [ { type: 'prepare-action', agent: 'codex', stepId: 'R4.implement' } ]
approvedPaths:    [ 'src/only-cursor.ts', 'src/product.ts' ]
```

The elected winner `cursor` is still active, still eligible, and still has the
only accepted plan anyone voted for. The run implements `codex`'s plan instead,
with no `decision-derived` event recording the change. The approved-path list is
worse than merely wrong: it is the **union** of both remaining plans, so it
authorises `src/only-cursor.ts`, a path the plan actually bound to the action
never named. `evaluateEvidence`'s approved-path check
(`src/evidence.ts`, `implementation-pinned`) is the sole authority over what an
implementation may touch, and it has just been widened by a drop.

The same three lines mean `supersedes` — computed at `src/runLoop.ts:227` — can
never be populated in practice, because the only path that would set it is a
re-derivation that never runs.

**Smallest test.** Add to `test/cli.test.ts`, mirroring the probe above:

```ts
it("keeps routing to the elected plan winner when an unrelated agent is dropped", async () => {
  // seed: consensus/reviewed run at R4.implement, planSelection elects "cursor",
  // ballots from claude, codex, cursor
  await runCli(["drop", "claude", "--issue", "1", "--coord-root", fixture.runtime], { makeRunLoop: fakeLoop });
  const after = readCursorsState(paths);
  expect(after.derived.planSelection?.selectedAgents).toEqual(["cursor"]);
  expect(deriveBoundInputs(start, after, "R4.implement", null).map((i) => i.agent)).toEqual(["cursor"]);
});
```

Both assertions fail on `0ea9342`. Both pass on `564ab5e` (which returns
`{ type: "wait" }` and recomputes in `rederiveAfterDrop`) and on `fd9eff0`
(which keeps a record the drop did not falsify and recomputes when it did).

### 2. cursor: the decision identity does not distinguish the roster that decided it

`src/runLoop.ts:220`, `:247`, `:276` (cursor
`0ea934235417926b4b8ba1c258b01959745878f0`).

**The rule.** The issue requires a durable identity "derived from decision kind
plus `inputSetHash` (and round where applicable)" whose purpose is that
"repeated run-loop ticks over the same input set must not append duplicate
derived-decision events", and it requires the persisted decision to record "the
active-roster order used for eligibility and tie-breaking" so the result is
reproducible. Roster order is a decision input: it decides both eligibility and
the tie-break, so two decisions taken under different rosters are different
decisions.

**The failure.** cursor reuses `computeInputSetHash(boundInputs)` from
`src/evidence.ts`, which hashes only `{kind, agent, commitSha, path}` tuples.
The roster is stored on the record but never hashed into `decisionId`
(`src/runLoop.ts:202`, `deriveDecisionId(kind, inputSetHash, round)`). The
dedupe at `src/runLoop.ts:1362` compares that id, so a decision taken under a
different roster over the same submission set is indistinguishable from the
earlier one and would be skipped as already current. A reader replaying the
journal cannot tell which roster order broke a tie, which is the whole point of
recording it.

Both peers hash roster order in: codex at `src/runLoop.ts` (`computeDerivedInputSetHash`,
`"coordinator-derived-decision-v1"` with `String(activeRoster.length)` and the
ordered roster length-prefixed) and claude at `src/machine.ts`
(`decisionInputSetHash`, same shape). Either is the minimal correction.

### 3. cursor: a crash between the journal append and the state write duplicates the audit event

`src/runLoop.ts:1362` (cursor `0ea934235417926b4b8ba1c258b01959745878f0`).

**The rule.** "The transition must be idempotent. Repeated run-loop ticks over
the same input set must not append duplicate derived-decision events or reapply
state."

**The failure.** `persistDerivedDecision` dedupes only against
`cursors.derived[slot]?.decisionId` — that is, against state. `appendJournal`
runs inside the `mutate` callback and fsyncs before `writeCursorsState` renames
the new cursors file. A crash in that window leaves the journal entry on disk
and the state slot still null; the next tick re-derives, finds `existing ===
null`, and appends a second `decision-derived` event with the same
`decisionId`. The audit trail then shows two derivations of one decision.

codex closes this at `src/runLoop.ts:1456` by reading the journal for the last
`decision-derived` event of that kind and reusing its `decisionId`, `supersedes`,
and `at`. claude closes it at `src/runLoop.ts:1197` with
`findDerivedDecisionEvent(readJournal(...), candidate.identity)`, reusing the
recorded `at` as `decidedAt`. `test/runLoop.test.ts` in the claude pin covers
this directly ("is idempotent across repeated ticks and across a crash between
journal and state").

### 4. cursor: no test asserts the three removed artifacts are rejected

`test/protocol.test.ts` (cursor `0ea934235417926b4b8ba1c258b01959745878f0`).

**The rule.** The issue's required-test list names "absence of the three
obsolete repository artifacts", and the plan calls for proving "the active
published-artifact union rejects the three removed artifact discriminators".

**The failure.** cursor's `test/protocol.test.ts` is byte-identical to the
pre-change baseline (`703c856`) — it is not in the pin's changed-path list at
all. `publishedArtifactSchema` is the only gate on what an agent may publish, and
nothing asserts it now refuses `"selection"`, `"reviser-authorization"`, or
`"consensus-declaration"`. Re-adding any of them to the union would be caught by
no test in that pin.

**Smallest test.** `expect(publishedArtifactSchema.safeParse({ ...common,
artifact: "selection", ... }).success).toBe(false)` for each of the three
discriminators. codex added a form of this (`test/protocol.test.ts`, +7 lines);
claude added it for all three plus a positive assertion that every remaining
artifact still parses and still rejects unknown keys.

### 5. All three: an old runtime format other than 2 falls through to a schema error

`src/state.ts` (`assertRuntimeFormat`, cursor `0ea9342` and codex `564ab5e`);
not present in claude `fd9eff0`.

**The rule.** "The runtime version mismatch must fail closed with a clear
remediation message rather than partially interpreting old state."

**The failure.** Both peers gate on `formatVersion === LEGACY_RUNTIME_FORMAT_VERSION`
(exactly `2`). Any other mismatch — a hand-edited file, or a future rollback
from a version 4 — falls through to `z.prettifyError`, which prints a
field-level diff of a document the operator cannot repair rather than the
wipe/restart remedy. claude's `assertRuntimeFormatVersion` fires on any numeric
`formatVersion !== RUNTIME_FORMAT_VERSION` and names `coord wipe-issue`.

This is low severity — version 2 is the only format that ever shipped — and it
is identical in both peers, so it does not separate them.

### 6. cursor and codex: an underivable decision throws out of the run loop

`src/runLoop.ts:1404`, `:1415`, `:1426` (cursor `0ea9342`);
`src/runLoop.ts:1464` (codex `564ab5e`).

**The rule.** `runTick` catches only `StateConflictError`; `run()` calls it in a
bare `while` loop. Anything else thrown from a tick terminates the coordinator
process and strands the issue.

**The failure.** Both peers throw `Cannot derive <kind> from the current
accepted evidence` when the compute function returns `null`. That is reachable
whenever `deterministicWinner` finds no eligible choice — every accepted active
ballot naming an agent with no accepted plan or implementation. A stalled gate
that an owner can inspect and drop out of becomes a dead coordinator instead.
claude returns the state unchanged, so the tick stalls and keeps polling.

The trigger is remote (ballot verification constrains `choice` to
`eligibleChoices` at acceptance time), so this ranks below the findings above —
but a crash is a strictly worse failure mode than a stall for an unattended
coordinator.

### 7. claude: a stale roster snapshot is not caught at the gate that consumes it

`src/machine.ts` (claude `fd9eff090797bb9efbcad51856c08ec2c378a762`), the
`decisionIsCurrent` checks inside `if (complete)`.

Stated against this reviewer's own pin for symmetry.

**The rule.** Same as finding 2: the persisted roster order must be the one that
actually decided the result.

**The failure.** claude re-derives on a stale identity only at the ballot step
that produced the decision (`R3.plan-ballot`, `R5.compare-ballot`, `R6.ballot`).
At `R4.implement` or `R6.revise` it reads `derived.planSelection` /
`derived.implementationSelection` without checking that the record's
`activeRoster` still matches. Routing stays correct — the record is only kept
when the drop did not falsify its result, and `selectedPlanAgents` re-filters by
the live roster — but the stored snapshot names a roster that no longer exists
until `rederiveAfterDrop` refreshes it. Every production drop goes through
`coord drop`, which does refresh it, so the window is narrow; codex's
`sameRoster` guard at `src/machine.ts:122` closes it at the consuming gate as
well, which is the stricter design.

**Smallest fix.** Extend the `decisionIsCurrent` check to the consuming steps,
or adopt codex's `needs*Derive` predicate shape.

## Verdict

Ranked: **codex `564ab5e7ca90dc682c970184b24fe0d3b4ddbf59`** and **claude
`fd9eff090797bb9efbcad51856c08ec2c378a762`** are both correct on the acceptance
criteria that matter; **cursor `0ea934235417926b4b8ba1c258b01959745878f0`** is
not.

cursor carries one high-severity defect (finding 1) that a routine, permitted
owner drop triggers: it silently re-routes implementation to `activeRoster[0]`
and widens the approved-path authority to the union of every active agent's
plan, with no audit record. Findings 2, 3, and 4 compound it — the decision
identity does not distinguish the roster that decided a tie, a crash can
duplicate the audit event, and no test guards the removed protocol
discriminators. That pin should not be the base for revision without fixing
finding 1 first.

Between the two remaining pins, **codex is the stronger base**. Its
`decide` fails closed with a typed `wait` at every gate that consumes a
canonical decision, and its `rederiveAfterDrop` is the most complete: it
recomputes each decision, journals the supersession, and resets to the earliest
affected step with an explicit cascade. That combination makes the
"never silently retain or substitute" rule hold at both the producer and the
consumer, where claude enforces it only at the producer (finding 7).

claude's pin is close behind, and is ahead on two axes worth carrying over
whichever base is chosen: the crash-window journal dedupe keyed on the full
decision identity rather than the last event of a kind
(`findDerivedDecisionEvent`), the format-version guard that fires on any
mismatch (finding 5), and the widest test coverage of the three (229 vs 195 vs
191 on the touched files), including negative protocol assertions for all three
removed discriminators and an explicit no-fallback test
("elects nobody rather than falling back when every choice is ineligible").
