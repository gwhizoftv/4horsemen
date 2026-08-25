# Issue 109 — implementation comparison

Bound implementation pins:

- cursor `0ea934235417926b4b8ba1c258b01959745878f0`
- codex `564ab5e7ca90dc682c970184b24fe0d3b4ddbf59`
- claude `fd9eff090797bb9efbcad51856c08ec2c378a762`

All three remove `R3.publish-selection`, `R5.reviser-auth`, and `R6.declare`; bump
`RUNTIME_FORMAT_VERSION` to `3`; introduce `cursors.derived` with
`decision-derived` journal events; and retarget the workflow to 10/6/4
agent-facing steps. They diverge on decision identity hashing, drop-time
re-derivation, stale-decision detection, binding fallbacks, test depth, and
whether removed artifact paths are still shipped.

## Comparison

### 1. cursor `0ea9342` — plan-selection `inputSetHash` omits roster, kind, and plan citations

`src/runLoop.ts:214-227` (`computePlanSelectionDerived` hashes only ballot
`boundInputs` via `computeInputSetHash`; `inputs` stores ballots alone).

**Rule.** A derived decision identity must bind every policy input the
coordinator read — decision kind, active roster (eligibility and tie-break),
consensus round when applicable, and exact accepted citations for both plans and
ballots — so a roster or evidence change cannot alias an earlier decision.

**Failure.** Reusing the agent-order hash from `computeInputSetHash` drops roster
and kind entirely and, for plan selection, ignores the accepted `R2.plan` rows
that define the eligible set. Two runs with identical ballot SHAs but different
rosters or different accepted plans share a `decisionId`; `needsPlanSelectionDerive`
at `src/machine.ts:61-62` treats a non-null record as current even when
`activeRoster` no longer matches, and downstream binding can advance on a stale
winner. Codex (`src/runLoop.ts:221-238`, `computeDerivedInputSetHash`) and
claude (`src/machine.ts`, `decisionInputSetHash`) length-prefix kind, roster,
round, and every citation.

**Test.**

```ts
const a = computePlanSelectionDerived(cursorsWithRoster(["claude", "codex"]), now);
const b = computePlanSelectionDerived({ ...cursors, activeRoster: ["codex", "cursor"] }, now);
expect(a?.decisionId).not.toBe(b?.decisionId);
```

### 2. cursor `0ea9342` — `rederiveAfterDrop` never recomputes derived decisions

`src/cli.ts:300-364` (invalidates ballots for the dropped choice and resets idle
cursors; returns without calling any `compute*Derived` helper or journaling a
supersession).

**Rule.** After a permitted agent drop the coordinator must re-derive plan,
implementation, and consensus selections from remaining accepted evidence,
journal `decision-derived` when the result changes, and reset downstream work
when the winner or pin changes (`src/cli.ts` plan section; codex
`rederiveAfterDrop` at `src/cli.ts:308-470`).

**Failure.** `dropAgent` nulls derived rows only when the dropped agent is cited
(`src/state.ts:843-849`), but when the drop changes the plurality winner while
leaving derived rows intact — e.g. cursor voted for itself and is dropped,
leaving codex the winner — `rederiveAfterDrop` exits with the old
`planSelection.selectedAgents` still bound. `R4.implement` orders and
finalization continue to target the removed winner until manual repair. Codex and
claude both recompute, journal, and `resetTo` downstream steps on winner or pin
change; each has a CLI test (`test/cli.test.ts` “recomputes … after a permitted
drop”).

### 3. cursor `0ea9342` — designated agent and binding fallbacks ignore missing derived evidence

`src/machine.ts:55-59` (`designatedReviser` / `designatedImplementer` fall back
to `activeRoster[0]`) and `src/runLoop.ts:306-309` (`R4.implement` binds
`activeRoster[0]` when `planSelection` is empty).

**Rule.** `R4.implement` must bind the derived plan winner's accepted plan;
`R6.revise` must bind the derived implementation winner's pin. When canonical
derived evidence is missing or stale the coordinator must wait or re-derive,
not silently pick the first roster entry.

**Failure.** On a reviewed or consensus run whose `planSelection` was cleared by
drop invalidation but not yet re-derived, `designatedImplementer` returns
`activeRoster[0]` and `deriveBoundInputs` still builds an `R4.implement` order
for that agent's plan even though no election names them. Codex waits with
“canonical plan selection is missing or stale” (`src/machine.ts:122-124`); claude
re-derives via `decisionIsCurrent` before advancing (`src/machine.ts:331-333`).

### 4. cursor `0ea9342` — stale derived records are not detected after roster change

`src/machine.ts:61-68` (`needsPlanSelectionDerive` / `needsImplementationSelectionDerive`
/ `needsConsensusDerive` check only `null` or consensus round, not roster or
input drift).

**Rule.** A stored derived decision is authoritative only while its
`activeRoster` and cited inputs still match the locked accepted evidence.

**Failure.** After a permitted drop shrinks the roster without citing the
dropped agent in derived inputs, cursor keeps the pre-drop decision and skips
`derive-plan-selection` even though tie-break order changed. Codex compares
rosters with `sameRoster` (`src/machine.ts:58-70`); claude compares full
content-derived identities with `decisionIsCurrent` (`src/machine.ts:262-265`,
`331-376`), which also catches citation changes codex's roster-only check misses.

### 5. cursor `0ea9342` — non-consensus `R7.finalize` binds every accepted implementation

`src/runLoop.ts:332-341` (when `consensus` is absent, returns all
`R4.implement` submissions as finalize inputs).

**Rule.** Finalization must bind the single accepted product pin the workflow
selected — derived implementation pin for reviewed/solo, derived consensus pin
for consensus — not an unfiltered implementation list.

**Failure.** In any state where more than one `R4.implement` row remains accepted
(data error or partial reset), cursor's finalize order lists every pin and
verification has no single canonical target. Codex resolves the winner from
`implementationSelection` / `planSelection` and matches pin
(`src/runLoop.ts:426-434`); claude's reviewed/solo path works when only the
winning implementer submitted but shares the same breadth when multiple
implementations exist (`src/runLoop.ts:237-239`).

### 6. cursor `0ea9342` — no regression test that removed artifact discriminators are rejected

Changed-path list omits `test/protocol.test.ts`; cursor is the only pin without
it.

**Rule.** `publishedArtifactSchema` must reject `selection`, `reviser-authorization`,
and `consensus-declaration` so agents cannot republish coordinator-owned results.

**Failure.** A regression restoring those branches in `src/protocol.ts` would
pass cursor's suite. Codex adds a focused case (`test/protocol.test.ts:68-72`);
claude adds full invalid payloads for all three removed shapes
(`test/protocol.test.ts:69-95`).

### 7. codex `564ab5e` — journal-first idempotency survives a crash between journal and cursor write

`src/runLoop.ts:1456-1488` (`persistDerivedDecision` reads the last
`decision-derived` journal row and reuses its timestamp/supersedes when
`decisionId` matches).

**Rule.** Deriving a decision is idempotent: a retry after partial persistence
must not append a second journal event or advance twice.

**Failure.** Without the journal reread, a crash after `appendJournal` but
before `replaceCursor` leaves derived state null while the journal records the
decision; the next tick re-derives and duplicates audit history. Cursor keys
idempotency only on in-memory `existing?.decisionId` (`src/runLoop.ts:1361-1364`).
Claude searches the journal (`findDerivedDecisionEvent` in `src/runLoop.ts`) but
codex's test explicitly covers “crash between journal and state”
(`test/runLoop.test.ts` “deduplicates a derived journal append …”).

### 8. codex `564ab5e` — `computeDerivedInputSetHash` is the reference policy hash

`src/runLoop.ts:207-238` (length-prefixed `coordinator-derived-decision-v1` tuple
over kind, round, roster, and sorted citations including `productPin`).

**Rule.** Decision identity must be a dedicated coordinator hash, not the
agent-order input-set hash, and must include tie-break roster order.

**Failure.** N/A for codex itself; included because cursor's finding 1 is fixed
here and claude's parallel `decisionInputSetHash` (`coord-decision-v1` prefix) is
equivalent in intent. Codex additionally exports `derivedDecisionJournalDetails`
for consistent audit payloads shared with `rederiveAfterDrop`.

### 9. claude `fd9eff0` — ships `.plans/issue-109/selection.json`, a removed coordinator artifact

`.plans/issue-109/selection.json` (`"artifact": "selection"`) is in claude's
changed-path list; issue 109 plan and claude's own `docs/analytics.md` §0 state
that path was eliminated with `R3.publish-selection`.

**Rule.** Implementations must not reintroduce files for phases the coordinator
now owns; `publishedArtifactSchema` rejects the `selection` discriminator.

**Failure.** The file is inert product code but documents the old protocol,
confuses reviewers, and contradicts the breaking-change narrative. Neither cursor
nor codex ships it.

### 10. claude `fd9eff0` — strongest decide/derive test matrix and analytics narrative

`test/machine.test.ts` (15 new cases on `decide`, `deterministicWinner`, and
derive helpers), `test/runLoop.test.ts` “coordinator-derived decisions” suite
(idempotency, crash recovery, binding), and `docs/analytics.md` §0 (10/6/4
topology plus `decision-derived` audit semantics). 495 tests pass vs 466 codex /
462 cursor (`pnpm check:fast` on each pin).

**Rule.** Derived decisions sit on the critical path for every multi-agent issue;
regressions must be caught at the machine, run-loop, CLI drop, and schema
layers.

**Failure.** N/A as a defect — claude's pin is the coverage benchmark. Notable
behaviors only claude tests explicitly: `decisionIsCurrent` re-derive when stored
identity drifts (`test/machine.test.ts` “re-derives rather than advancing when a
stored decision no longer matches its inputs”), and unanimous-vs-revise routing
never deriving consensus on a `revise` ballot.

### 11. claude `fd9eff0` — derive logic colocated with `deterministicWinner` in `src/machine.ts`

Derive helpers and `decisionIsCurrent` live beside `decide` (`src/machine.ts`;
re-exported from `src/runLoop.ts:242`). Codex and cursor keep compute helpers in
`runLoop.ts`, splitting policy from orchestration.

**Rule.** No strict functional requirement; maintainability preference.

**Failure.** None by itself. The layout makes claude's machine tests direct unit
tests of pure derive/decide policy without constructing a full `CoordinatorRunLoop`.

### What each pin does best

| Concern | Best pin |
| --- | --- |
| Drop-time re-derive with downstream reset | codex `564ab5e` / claude `fd9eff0` |
| Policy input-set hashing (roster + citations) | codex `564ab5e` / claude `fd9eff0` |
| Stale-decision detection breadth | claude `fd9eff0` (`decisionIsCurrent`) |
| Journal crash idempotency | codex `564ab5e` |
| Removed-artifact schema regression tests | claude `fd9eff0` |
| Analytics / workflow documentation | claude `fd9eff0` |
| Machine-level derive/decide unit tests | claude `fd9eff0` |
| Non-consensus finalize pin binding | codex `564ab5e` |
| Avoid shipping removed artifact paths | cursor `0ea9342` / codex `564ab5e` |
| End-to-end correctness on happy path | all three pass `pnpm check:fast` |

### Recommendation

Do **not** take cursor `0ea934235417926b4b8ba1c258b01959745878f0` as the merge
base: findings 1–5 leave stale or incorrect bindings after roster change and
permitted drops.

Prefer **claude `fd9eff090797bb9efbcad51856c08ec2c378a762`** as the merge base —
widest test coverage, `decisionIsCurrent` stale detection, and the clearest
analytics update — with these folds from codex `564ab5e7ca90dc682c970184b24fe0d3b4ddbf59`:

1. Delete `.plans/issue-109/selection.json` (finding 9).
2. Tighten reviewed/solo `R7.finalize` binding to the derived winner pin when
   `implementationSelection` is present (finding 5; codex `src/runLoop.ts:426-434`).
3. Align journal dedup on retry with codex's last-event reread in
   `persistDerivedDecision` (finding 7).

If minimizing diff surface matters more than claude's machine test layout, codex
is an acceptable base once claude's machine/runLoop integration tests and
analytics §0 are ported; add `decisionIsCurrent`-style input hashing checks beyond
codex's roster-only `sameRoster` guard.
