# Issue 109 — Eliminate deterministic agent artifact phases

## Problem restated

Three workflow phases already have a single answer the coordinator can compute
from accepted evidence: plan selection after `R3.plan-ballot`, implementation
winner/reviser after `R5.compare-ballot`, and consensus after unanimous
`R6.ballot`. Today the coordinator still prepares `action.md`, nudges an agent,
waits for a Git publish of a nearly-complete JSON scaffold, fetches the commit,
and re-verifies the same values. That loop adds ~2.3 minutes and three LLM
turns with no semantic contribution.

Remove `R3.publish-selection`, `R5.reviser-auth`, and `R6.declare` as
agent-facing steps. The coordinator derives, persists, and journals those
decisions itself, then advances to the next remaining step. This is a breaking
runtime-format change: no migration, no dual sequences, no legacy parsers.
Pre-change issue runtimes must fail closed and be wiped/restarted by the owner.

## Exact File List to be changed or deleted

### Core workflow and state

- `src/steps.ts` — Remove `R3.publish-selection`, `R5.reviser-auth`, and
  `R6.declare` from `WorkflowStepId`, `EvidenceId` (`selection-published`,
  `reviser-authorized`, `consensus-declared`), `STEP_DEFINITIONS`, and
  `consensusSteps` / `reviewedSteps`. Extend `MachineDecision` with pure
  coordinator decisions `derive-plan-selection`, `derive-implementation-selection`,
  and `derive-consensus` (payloads carry enough identity for idempotent apply).
  Consensus sequence becomes 10 agent-facing steps; reviewed becomes 6; solo
  stays 4.
- `src/machine.ts` — Drop the three steps from `globalOrder`. After a completed
  ballot denominator, return the matching `derive-*` decision (then advance)
  instead of `prepare-action` for the removed steps. Keep existing `R6.ballot`
  escalate / revise / revision-limit → `owner-action-required` behavior, which
  never derives consensus. Fix round accounting that today treats `R6.declare`
  as a revision-round step.
- `src/runLoop.ts` — Apply `derive-*` under existing authority/locking:
  revalidate the exact accepted input set, persist canonical `cursors.derived`,
  append one `decision-derived` journal event, advance to the next agent-facing
  step. Remove order construction, scaffold expectations, verification, and
  `accept` selection-mutation branches for the three removed steps. Keep
  `deterministicWinner` unchanged (plurality + `activeRoster` tie-break).
  Rewrite `deriveBoundInputs` / `selectedPlanAgents`:
  - `R4.implement` binds the derived plan winner's accepted `R2.plan`.
  - `R6.revise` binds the derived implementation winner's accepted product pin
    (round > 1 still binds the prior accepted revision).
  - Consensus-profile `R7.finalize` binds the accepted `R6.revise` pin stored
    in derived consensus (never an accepted `R6.declare`).
  - Solo/reviewed finalization continues to use the accepted implementation pin
    directly.
- `src/state.ts` — Bump `RUNTIME_FORMAT_VERSION` from `2` to `3`. Add strict
  Zod schemas for `cursors.derived` (`planSelection`, `implementationSelection`,
  `consensus`) requiring algorithm, `inputSetHash`, `activeRoster`, exact input
  citations, result fields, and `decidedAt`. Add journal type
  `decision-derived` with kind
  `plan-selection` | `implementation-selection` | `consensus`. Remove obsolete
  step/evidence enum values. Replace or retire `cursors.selection` so downstream
  routing cannot drift from derived evidence. Fail closed on format mismatch
  with an explicit wipe/restart remediation message. No migration from v2.
- `src/protocol.ts` — Remove `selectionArtifactSchema`,
  `reviserAuthorizationArtifactSchema`, `consensusDeclarationArtifactSchema`
  and their types from `publishedArtifactSchema`. No legacy parsers.
- `src/evidence.ts` — Remove verify branches for `selection-published`,
  `reviser-authorized`, and `consensus-declared`.
- `src/orderScaffold.ts` — Remove scaffold cases for the three removed steps.
- `src/agentLanguage.ts` — Remove the three evidence IDs and subject strings.
- `src/cli.ts` — Update `rederiveAfterDrop` to recompute/invalidate derived
  plan and implementation selections from remaining accepted evidence (no
  accepted publish-selection / reviser-auth rows). Drop-guard for the
  authorized reviser must read derived `implementationSelection.reviser`.
- `src/issueReport.ts` — Read chosen plan agent, implementation pin, and
  consensus pin from `cursors.derived` rather than artifact submissions or a
  parallel summary that can drift.

### Documentation and analytics narrative

- `docs/analytics.md` — Retarget phase tables and narrative so live docs
  describe only the new 10/6/4 topology; historical baseline numbers for the
  removed phases may remain as pre-change measurements but must not imply those
  phases still exist.
- `docs/coord-driver.md` — Clarify that plan selection, reviser authorization,
  and consensus declaration are coordinator-derived machine decisions, not
  agent-published artifacts; update profile prose accordingly.

### Tests

- `test/integration.test.ts` — Remove agent publish blocks for selection /
  reviser-auth / declare; assert direct
  `R3.plan-ballot → R4.implement`, `R5.compare-ballot → R6.revise`, and
  unanimous `R6.ballot → R7.finalize` with persisted derived state and no
  removed artifacts.
- `test/runLoop.test.ts` — Replace fixtures that seed `R3.publish-selection` /
  `selection.json` / `consensus.json`; cover derive application, binding, and
  repeated-tick idempotency; keep/extend `deterministicWinner` coverage.
- `test/machine.test.ts` — Assert derive decisions after ballot completion;
  revise / escalate / limit paths still do not derive consensus; solo/reviewed
  skip removed steps.
- `test/evidence.test.ts` — Delete suites for the three removed evidence IDs.
- `test/agentLanguage.test.ts` — Drop `reviser-authorized` / removed-evidence
  expectations; rebuild evidence-id lists.
- `test/cli.test.ts` — Drop fixtures that seed accepted `R5.reviser-auth`;
  assert drop/reselection against derived reviser and recomputed decisions.
- `test/analytics.test.ts` — Rewrite synthetic journals that advance through
  `R6.declare` to the new topology; assert phase counts under 10/6/4.
- `test/state.test.ts` — Expect `formatVersion: 3`; reject v2 with wipe/restart
  messaging; cover `derived` schemas and `decision-derived` journal events.
- `test/issueReport.test.ts` — Seed/read derived fields instead of obsolete
  selection summaries.
- `test/orderScaffold.test.ts` — Confirm scaffolds no longer emit the three
  removed artifacts (add absence assertions if useful).
- `test/protocol.test.ts` — Ensure the published-artifact union still parses
  remaining artifacts after the three schemas are removed.

### Explicitly not changed

- `package.json` — do **not** bump `0.0.N` on the issue branch (post–issue-108:
  CI advances version on merge to `main`).
- Historical `.plans/issue-1/*`, `.code-reviews/*`, and past issue plans —
  leave as historical records; live topology docs are `docs/*` plus code.
- No committed product files named `selection.json` /
  `reviser-authorization.json` / `consensus.json` exist to delete; those paths
  cease to be required/generated at runtime.

## Exact file list to be created

- `.plans/issue-109/plan.md` — this plan.

No new runtime module is required: derivation fits in `machine.ts` /
`runLoop.ts` / `state.ts` beside existing `deterministicWinner`. An optional
`src/derivedDecisions.ts` extract is rejected below unless review demands it.

## Design decisions

**Derived state, not fake `accepted` rows.** An `AcceptedSubmission` remains
agent-published evidence at a reachable Git SHA. Coordinator decisions live
under `cursors.derived` with algorithm identity, exact input citations,
`inputSetHash`, roster snapshot, result, and `decidedAt`. Downstream binding,
drops, reports, and finalization read only that canonical structure.

**Algorithms (names only; policy unchanged).** Plan and implementation
selection: `plurality-active-roster-v1` via existing `deterministicWinner`.
Consensus: `unanimous-active-roster-v1` (all active ballots `approve`, then the
exact current-round accepted revision product pin).

**Idempotent journaling.** Durable decision identity =
`kind + inputSetHash` (+ revision `round` for consensus). Repeated ticks over
the same input set must not duplicate `decision-derived` events or reapply
state. When policy allows reselection after a drop, invalidate/recompute and
journal a superseding decision.

**Transitions.**

```text
R3.plan-ballot  -> derive plan selection           -> R4.implement
R5.compare-ballot -> derive impl winner/pin/reviser -> R6.revise (round 1)
R6.ballot
  |-- escalate / revision-limit -> owner-question (no derive)
  |-- any revise -> R6.revise next allowed round (no derive)
  `-- all approve -> derive consensus -> R7.finalize
```

**Breaking rollout.** Format v3 only. No dual workflow sequences, no legacy
step normalization, no parsers for the three removed artifacts, no honor of
in-flight old `action.md`/`complete` for those steps.

## Tests

Commands (named, real):

- Pre-commit / plan verification: `pnpm check:fast` (lint, typecheck, fast
  tests — live `verify.precommit`).
- Coordinator final verification on the approved commit: `pnpm check`
  (build + check:fast + e2e).

Coverage to add or update (maps to issue acceptance):

- Plan plurality and active-roster-order tie-break.
- Implementation plurality and active-roster-order tie-break.
- Exclusion of dropped/inactive evidence; allowed reselection after a selected
  agent is dropped; no stale winner/pin/reviser retained.
- Exact winning implementation product-pin binding; reviser equals that agent.
- Unanimous approval derives consensus at the exact current-round revision pin.
- `revise` / `escalate` / round-limit never derive consensus and keep existing
  routing.
- Direct gate transitions listed above; no `prepare-action` / nudge / `complete`
  / fetch / accepted-submission for the three removed phases.
- Absence of required/generated `selection.json`,
  `reviser-authorization.json`, and `consensus.json`.
- Journal contents, reproducibility from cited inputs, repeated-tick
  idempotency.
- Solo and reviewed finalization pin selection.
- Drop/reselection + issue reporting.
- Analytics phase counts under the new topology.
- Rejection of runtime format v2 with clear wipe/restart remediation.

## Alternatives Rejected

- **Keep agent publish loops but pre-fill scaffolds more aggressively** —
  still burns LLM/Git/verify time for zero judgment; issue goal is to remove
  the phases.
- **Fabricate `AcceptedSubmission` rows for selection/auth/declare** —
  pollutes provenance; `accepted` must mean an agent-reachable Git SHA.
- **Migrate or dual-run old in-flight issues** — out of scope; fail closed and
  wipe/restart.
- **Change the voting / tie-break policy** — reuse `deterministicWinner` and
  existing owner-question behavior only.
- **Implement `coord submit` for remaining agent-authored phases** —
  related follow-up; not this issue.
- **Extract a new `src/derivedDecisions.ts` module in the first cut** —
  unnecessary file churn; keep logic next to `deterministicWinner` /
  `applyDecisions` unless size forces a split later.
- **Bump `package.json` on the issue branch** — forbidden after issue 108; CI
  bumps on merge to `main`.

## Risks and Mitigations

- **Stale routing after drops** — always revalidate input set before persist;
  invalidate derived decisions that cite inactive agents; journal superseding
  events; keep “cannot drop authorized reviser” against derived reviser.
- **Finalize binds the wrong pin** — consensus finalize must use
  `derived.consensus.consensusPin` → accepted `R6.revise`; solo/reviewed must
  never look for a declare artifact. Cover all three profiles in tests.
- **Silent re-derive on every tick** — gate journaling and state writes on
  durable decision identity (`kind` + `inputSetHash` [+ round]).
- **Old runtimes partially interpreted** — format bump to 3 with explicit
  wipe/restart error; no migration shims that half-read v2.
- **Docs/analytics still teaching removed phases** — update live docs in this
  change set; leave historical issue plans alone.
- **Integration canary still publishes removed JSON** — rewrite the canary to
  assert absence of those paths and presence of derived state / journal events.

## Conclusion

Remove the three deterministic agent artifact phases. After each prerequisite
ballot set is complete, the coordinator derives plan selection, implementation
winner/reviser, or unanimous consensus into canonical `cursors.derived`, journals
a single idempotent `decision-derived` event, and advances directly to the next
agent-facing step. Agents keep every judgmental artifact; the coordinator stops
using them as a JSON/Git transport for results it already enforces. Runtime
format 3 fails closed on older state with no compatibility layer.
