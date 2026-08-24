# Implementation Plan — Eliminate deterministic agent artifact phases

## Exact File List to be changed or deleted

No tracked file is deleted wholesale. Change only the following existing files:

- `src/steps.ts` — remove `R3.publish-selection`, `R5.reviser-auth`, and `R6.declare`, their evidence IDs, paths, tasks, and participant routing; make the consensus/reviewed/solo sequences contain 10/6/4 agent-facing steps; remove order/observation fields used only to verify the three obsolete artifacts; and add explicit typed machine decisions for plan selection, implementation selection, and consensus derivation.
- `src/state.ts` — bump the runtime format version; replace the parallel top-level `reviser` and `selection` summaries with one strict canonical `derived` structure; define strict schemas for decision identities, algorithms, roster snapshots, exact accepted-input citations, hashes, results, timestamps, and supersession; remove obsolete accepted-submission result fields; add the `decision-derived` journal event; initialize empty derived slots; update drop invalidation; and fail old-format reads with an explicit wipe/restart error rather than migrating them.
- `src/machine.ts` — keep `deterministicWinner` semantics but make election/consensus derivation pure and reproducible; emit derivation decisions once ballot denominators are complete; preserve escalation-before-revision precedence, revision limits, owner questions, pause/abandon behavior, and active-roster ordering; and advance directly to the next remaining agent-facing step only after the matching canonical decision is present.
- `src/runLoop.ts` — apply each pure derivation under the existing revision lock after revalidating the current roster and accepted inputs; persist the canonical record and an idempotent `decision-derived` journal event; remove action/scaffold/completion/fetch/verification/acceptance handling for the three deleted steps; bind implementation, revision, and finalization orders directly from derived state plus the cited accepted submissions; and use derived results for approved paths, routing, publication attribution, and retry/reissue behavior.
- `src/cli.ts` — replace selection-summary mutation in drop handling with dependency-aware invalidation and recomputation of canonical derived decisions, journal replacements with the prior decision identity as superseded, clear/reissue downstream work whose binding changed, retain the existing prohibition on dropping the authorized reviser, and keep owner retry/revise/escalation behavior unchanged.
- `src/protocol.ts` — remove selection, reviser-authorization, and consensus-declaration schemas, exported types, and discriminated-union members without retaining legacy parsers.
- `src/evidence.ts` — remove verification branches and imports for the three obsolete artifacts and remove their result plumbing; retain artifact input hashing for the remaining agent-authored evidence independently of the new coordinator decision hash.
- `src/orderScaffold.ts` — remove scaffold cases and context fields for the three obsolete publications so no action body can request or render them.
- `src/agentLanguage.ts` — remove the deleted evidence IDs and their agent-facing subjects while preserving exhaustive coverage of every remaining evidence ID.
- `src/issueReport.ts` — report the chosen implementation agent/pin/reviser from canonical derived state for consensus runs, with accepted-implementation/finalization fallbacks for reviewed and solo runs.
- `docs/analytics.md` — describe the new 10/6/4 agent-facing topology and coordinator-owned decision events, remove the deleted steps from active phase/token tables, and retain any historical cost discussion only as aggregated obsolete publication overhead rather than as current phases.
- `test/action.test.ts` — update `InternalOrder` fixtures after removal of obsolete expected-result and roster fields.
- `test/agentLanguage.test.ts` — seed canonical derived state, assert 10 remaining workflow/evidence subjects, and prove deleted artifact paths/IDs are no longer active agent-facing surfaces.
- `test/analytics.test.ts` — use the new runtime version and cover direct ballot-to-next-step phase boundaries, 10-step consensus counts, repeated revision rounds, and the fact that `decision-derived` is audit metadata rather than an agent action/phase.
- `test/cli.test.ts` — replace authorization-artifact fixtures with derived implementation decisions and cover permitted drop recomputation, supersession journaling, changed-winner invalidation, inactive evidence exclusion, and the still-forbidden authorized-reviser drop.
- `test/cursorHookUsage.test.ts` — update strict journal fixtures to the new runtime format version.
- `test/evidence.test.ts` — remove deleted step/evidence pairs and artifact-verification cases, update order fixtures, retain ballot eligibility/pin validation coverage, and assert obsolete repository artifacts cannot be accepted.
- `test/integration.test.ts` — update the four-agent canary to observe direct `R3.plan-ballot -> R4.implement`, `R5.compare-ballot -> R6.revise`, and unanimous `R6.ballot -> R7.finalize` transitions; assert persisted decisions and exact bindings; and assert no obsolete action, completion round trip, accepted submission, or repository artifact occurs.
- `test/issueReport.test.ts` — use canonical derived state and verify consensus plus reviewed/solo chosen-agent and final-pin reporting.
- `test/machine.test.ts` — cover plan and implementation plurality/tie-breaking, dropped/inactive exclusion, explicit pure derivation decisions, exact implementation pin/reviser selection, unanimous consensus at the current revision pin, direct transitions, revise/escalate/limit non-consensus paths, and missing/stale decision behavior.
- `test/orderScaffold.test.ts` — remove obsolete context fields and prove scaffolds exist only for the remaining agent-authored JSON/Markdown actions.
- `test/protocol.test.ts` — prove the active published-artifact union rejects the three removed artifact discriminators while remaining strict for supported artifacts.
- `test/runLoop.test.ts` — replace accepted selection/declaration fixtures with canonical decisions; cover canonical hashes/citations, exact-once journaling across repeated ticks, no action preparation or nudge for derivations, exact plan/implementation/revision binding, approved-path refresh, direct finalization pins for every profile, and drop/supersession routing.
- `test/state.test.ts` — cover strict derived-decision records and journal details, decision identity/supersession, initialization, drop invalidation, the runtime-format bump, and clear rejection/remediation for version-2 start/cursor/journal state.
- `test/support/fixtures/analytics-journal.jsonl` — update the fixture format version while retaining its current remaining-step events.

Within these files, remove all active references to `.plans/issue-<n>/selection.json`, `.signals/issue-<n>/reviser-authorization.json`, and `.signals/issue-<n>/consensus.json`; do not add compatibility branches or synthetic accepted submissions.

The canonical design is one `derived` object with nullable `planSelection`, `implementationSelection`, and `consensus` records. Each record has a durable identity (`kind` plus `inputSetHash`, and the round for consensus), the versioned algorithm name, the ordered active-roster snapshot, exact typed citations (`kind`, agent, accepted submission SHA, path, and product pin where applicable), the result, `decidedAt`, and an optional superseded decision identity. The hash uses a stable length-prefixed encoding of the decision kind, roster order, round, and sorted citations so a roster/input change necessarily creates a new identity. Plan and implementation decisions use `plurality-active-roster-v1`; consensus uses `unanimous-active-roster-v1`.

The plan-selection input set contains active eligible accepted plans and active accepted plan ballots. The implementation-selection input set contains active accepted implementations (including their exact product pins) and active accepted comparison ballots. Consensus contains the one accepted revision for the current round and every active accepted consensus ballot. Original Git SHA/path citations remain the provenance; no coordinator record is inserted into `accepted`.

For idempotency, decision application re-derives from the locked current state and compares the durable identity before writing. Journal append checks that identity and reuses an existing matching event, so a retry after a crash between journal append and cursor-state replacement cannot duplicate the event; `decidedAt` is the event timestamp. A later permitted roster change writes a new identity whose journal/state record names the prior identity as superseded. If an upstream result changes, drop handling invalidates dependent derived records and accepted downstream work, resets to the earliest affected remaining agent-facing step, and reissues bindings; it never falls back silently to roster position while a required derived result is missing.

## Exact file list to be created

None. The implementation extends existing source, test, fixture, and documentation files only. In particular, it creates none of the three obsolete coordination artifacts and introduces no migration or legacy-compatibility module.

## Tests

Add/update tests to establish all requested behavior:

1. Plan and implementation plurality winners and active-roster-order tie breaks are deterministic; dropped agents, their evidence, and ineligible choices do not participate.
2. A permitted drop recomputes an affected decision, records `supersedes`, invalidates stale downstream bindings, and never silently retains a no-longer-valid agent or pin; the existing authorized-reviser drop refusal remains.
3. Plan-ballot completion persists/journals the exact plan decision and advances directly to implementation without an action file, nudge, completion read, fetched coordinator submission, accepted synthetic record, or selection artifact.
4. Comparison-ballot completion persists/journals the exact winning implementation agent, its accepted product pin, and the same agent as reviser, then advances directly to revision without authorization publication.
5. Unanimous current-round approval persists/journals the exact accepted revision pin and advances directly to finalization; any `escalate`, any `revise`, and revision-limit handling create the existing routing outcome and never derive consensus.
6. Repeated ticks and crash-style reapplication with the same durable identity do not duplicate state replacement or `decision-derived` journal events; journal citations and the canonical hash reproduce the result.
7. `R4.implement`, first-round `R6.revise`, later-round `R6.revise`, and consensus/reviewed/solo `R7.finalize` bind exactly the appropriate accepted plan/product/revision pin and approved file map.
8. Strict state/protocol tests reject runtime format 2 with a wipe/restart remediation and reject obsolete artifact discriminators, step IDs, evidence IDs, paths, and accepted-submission shapes; there is no migration path.
9. Integration and analytics tests assert consensus/reviewed/solo agent-facing counts of 10/6/4, direct gate boundaries, absence of deleted artifacts/actions, and no token/tool action attribution for coordinator-only decisions.

Run focused tests while iterating:

```bash
pnpm exec vitest run --config vitest.config.ts test/action.test.ts test/agentLanguage.test.ts test/analytics.test.ts test/cli.test.ts test/cursorHookUsage.test.ts test/evidence.test.ts test/issueReport.test.ts test/machine.test.ts test/orderScaffold.test.ts test/protocol.test.ts test/runLoop.test.ts test/state.test.ts
pnpm test:e2e
```

Run the repository-required suites before publication:

```bash
pnpm check:fast
pnpm check
```

## Alternatives Rejected

- Keep the three files but have the coordinator commit them: rejected because they would still fabricate repository provenance and preserve redundant protocol/state paths.
- Insert synthetic coordinator decisions into `accepted`: rejected because `AcceptedSubmission` must continue to mean an agent-authored artifact reachable at an exact Git SHA.
- Preserve runtime version 2 with optional/defaulted derived fields or parse legacy artifacts: rejected by the deliberately breaking rollout policy; old runs must fail closed and be wiped/restarted.
- Reuse mutable top-level selection/reviser summaries beside derived records: rejected because parallel fields can drift and downstream routing would no longer have one authority.
- Change plurality, tie-breaking, reviser, escalation, or revision-limit policy: rejected as out of scope; the implementation reuses current semantics and changes only ownership/transport of deterministic decisions.
- Treat coordinator decisions as zero-duration pseudo-phases: rejected because analytics and lifecycle counts must represent agent-facing work; derivations are journal audit events between direct gate transitions.

## Risks and Mitigations

- **Split state/journal writes could duplicate or lose audit evidence.** Use a content-derived decision identity, deduplicate journal append by identity under the state authority lock, reuse the journal timestamp, and test crash-style retry plus repeated ticks.
- **A roster change could leave a formerly valid winner, reviser, pin, or action bound.** Hash roster order into every decision, rederive on permitted drops, journal supersession, cascade invalidation from the earliest changed dependency, and reissue affected actions.
- **Finalization could select a coordination-signal commit instead of a product pin.** Resolve the canonical decision's cited accepted implementation/revision submission and bind its `productPin`; assert exact pin lineage separately for consensus, reviewed, and solo profiles.
- **Removing enum members can leave hidden scaffold/parser paths.** Make TypeScript switches/unions exhaustive and add negative protocol/evidence/integration assertions for all three old paths and discriminators.
- **The runtime bump could accidentally act as a migration.** Require the new literal version at every persisted boundary and emit only a wipe/restart remediation on mismatch; update fixtures rather than normalizing old records.
- **Direct transitions could be counted as agent work.** Keep `decision-derived` separate from `action-prepared`, have analytics continue to segment only on direct `gate-advanced` events, and test 10/6/4 counts and zero actions for derivations.

## Conclusion

Implement the three deterministic results as strict, content-addressed coordinator state with reproducible exact-input journal records, then route the remaining 10/6/4 agent-facing workflows directly from that state. Remove every active artifact/scaffold/verification compatibility path, preserve current voting and owner-control policy, make drops and retries idempotent, and verify the breaking runtime rollout with focused, fast, full, and end-to-end checks.
