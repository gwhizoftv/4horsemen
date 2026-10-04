# Issue 137: Agree on additive file-map fixes during implementation

## Exact File List to be changed or deleted

- `src/steps.ts` — add `R4.amend-scope` / `R4.amend-ballot` (and matching `EvidenceId`s); extend `MachineDecision` with `derive-scope-amendment`; register ballot step; keep amend steps off the normal linear profile progression (entered only from implement/revise)
- `src/machine.ts` — from `R4.implement` / `R6.revise`, when a valid amend-scope proposal is accepted, advance to `R4.amend-ballot` (solo: skip ballot and derive immediately); on unanimous approve derive then return to the interrupted step; on any reject return to the interrupted step without growing the map; cap amendments per issue
- `src/runLoop.ts` — `resolveApprovedPaths` unions selected-plan extraction with accepted `derived.scopeAmendment.addedPaths`; wire `derive-scope-amendment`; bind proposal + selected plan in amend-ballot inputs; reinject in-flight implement/revise actions when the effective map grows (same pattern as extractor-upgrade rewrite)
- `src/protocol.ts` — additive scope-amendment proposal artifact schema; amend-ballot private response schema (`approve` / `reject`)
- `src/evidence.ts` — accept amend-scope proposals only when every added path passes `isFileMapPath`, is not already covered by `matchesApprovedPath` against the current effective map, and the proposal is additive-only (no removals / no plan rewrite)
- `src/state.ts` — `derived.scopeAmendment` record (decision id, input set hash, `addedPaths`, interrupted step/round, supersedes); extend step/evidence enums and empty derived defaults
- `src/orderScaffold.ts` — JSON/markdown scaffolds for amend-scope proposal and amend-ballot response
- `src/ballotPublication.ts` — amend-ballot batch kind + publication path under `.signals/issue-N/`
- `src/ballotResponse.ts` — recognize `R4.amend-ballot` as a ballot step and parse approve/reject
- `src/agentLanguage.ts` — human labels for the new evidence ids
- `src/cli.ts` — include amend steps in owner retry/revise reset filters that already clear post-plan work
- `templates/product/AGENTS.protocol.md` — document that overlooked file-map paths may be proposed additively during implement/revise and take effect only after agreement; selected plan SHA stays immutable
- `docs/coord-driver.md` — document effective approved map = plan extraction ∪ accepted amendment paths; amendment cap; solo auto-accept
- `docs/repo-map.md` — note amendment overlay beside frozen plan file-map authority
- `test/evidence.test.ts` — proposal validation (additive ok; already-covered / non-path / removal rejected); impl after amendment allows newly listed paths
- `test/runLoop.test.ts` — `resolveApprovedPaths` grows only after derive; in-flight rewrite carries unioned map into implement scaffold `approvedPaths`
- `test/machine.test.ts` — enter ballot from accepted proposal; approve → derive → return to implement; reject → return without derive; solo skips ballot; cap blocks further proposals
- `test/protocol.test.ts` — schema accept/reject cases for proposal + ballot response
- `test/orderScaffold.test.ts` — scaffolds for the new steps
- `test/ballotPublication.test.ts` / `test/ballotResponse.test.ts` — extend if present for batch kind + response parse (otherwise cover via `runLoop`/`machine` tests)
- `test/install.test.ts` — protocol overlay still installs and mentions the amendment agreement rule

## Exact file list to be created

- `.plans/issue-137/plan.md` — this plan (coordination artifact only)

No new `src/` modules: helpers stay next to `extractApprovedPaths`, `resolveApprovedPaths`, plan-selection derive, and existing ballot publishers.

## Reuse and Scope

Reuse:

- `extractApprovedPaths`, `isFileMapPath`, `matchesApprovedPath`, `isCurrentIssueCoordinationPath` (`src/evidence.ts`) for path legality and out-of-map checks
- `resolveApprovedPaths` / `approvedPathsForOrder` / in-flight action rewrite (`src/runLoop.ts`) so the effective map stays the sole implement/revise authority
- `implementationReadyArtifactSchema` / revision pin checks — after amendment, `approvedPaths` on the implement signal must equal the **effective** map (plan ∪ amendment), not the frozen pre-amendment list alone
- Plan-selection / consensus derive pattern (`planSelectionDerivedSchema`, `deriveDecisionId`, `plurality-active-roster-v1` / unanimous ballot handling) for a `scope-amendment` derived record
- Ballot machinery: `publish-ballot-batch`, `ballotResponse.ts`, `acceptedResponses`, `ballotSteps` set
- `BUILD_DISCIPLINE_NOTE` / outstanding reissue path — amendment is how agents escape a true file-map omission without fabricating out-of-map product edits
- Existing test fixtures in `test/evidence.test.ts` and `test/runLoop.test.ts` that already seed `approvedPaths: ["src/product.ts"]` and assert out-of-map rejection

Justify no new modules: the feature is an overlay on the existing approved-path and ballot pipelines; a new package boundary would only duplicate those call sites.

Out of scope (do not change):

- Mutating or re-extracting a new plan blob at a different SHA (selected `R2.plan` `submissionSha` remains the plan pin)
- Returning to `R2.plan` / `R3.*` or invalidating plan selection
- Subtractive map edits, wholesale replans, or using amendment for product scope expansion beyond overlooked paths needed to finish the intended change
- Restoring the removed issue-1 “amendment paperwork” product surface beyond this additive agreement

## Tests

Run `pnpm check:fast` before commit (live `verify.precommit`).

Fewest focused cases (extend existing files):

1. `test/evidence.test.ts` — amend proposal listing a missing test path is accepted; proposal that removes or repeats already-approved paths is rejected; implementation pin that touches only the newly amended test path fails before derive and passes after.
2. `test/runLoop.test.ts` — with `derived.scopeAmendment.addedPaths = ["test/product.test.ts"]`, `resolveApprovedPaths` for `R4.implement` equals sorted union with plan paths; implement order scaffold embeds that union.
3. `test/machine.test.ts` — accepted proposal while on `R4.implement` yields amend-ballot prepares (consensus/reviewed) or `derive-scope-amendment` (solo); approve path returns to `R4.implement`; reject path returns with no derived amendment; second proposal after cap yields wait/reject outstanding.
4. `test/protocol.test.ts` — strict schema coverage for proposal + amend ballot response.
5. `test/orderScaffold.test.ts` + `test/install.test.ts` — scaffold/protocol text for the new steps and overlay rule.

These fail on main today because no amendment evidence/derive/union exists, and pass once the overlay is wired.

## Alternatives Rejected

- **Owner-only `coord answer` path list** — issue asks agents to agree; owner interrupts remain for escalate/revision-limit only
- **Silent self-expand by the implementer** — defeats file-map authority; any growth must be an accepted derived record
- **Edit selected `plan.md` and re-extract** — `resolveApprovedPaths` reads the frozen plan `submissionSha`; rewriting history or asking peers to re-plan is heavier than an additive overlay and breaks pin immutability
- **Reuse `R6.revise` as the escape hatch** — revision uses the same `resolveApprovedPaths` map, so an omitted test still fails out-of-map
- **Full return to R2/R3** — correct for real scope change, not for a file-map omission while completing intended work
- **New standalone `src/scopeAmendment.ts` module** — unnecessary indirection; keep logic beside existing path/ballot code

## Risks and Mitigations

- **Scope creep via repeated amendments** — hard cap (default 2 accepted amendments per issue); additive-only; reject paths already matched by the effective map
- **Ballot disagreement stalls implement** — reject returns to implement/revise with outstanding naming the rejected paths; agents can narrow the proposal or escalate through existing owner channels only if later extended (not required for MVP)
- **Solo auto-accept weakens review** — solo already has no plan ballot; document that reviewed/consensus require unanimous approve on the amend ballot
- **In-flight action UUID churn when map grows** — follow existing extractor-upgrade rewrite: same action id where possible, digest change invalidates stale hooks; cover with `runLoop` test
- **`implementation-ready` approvedPaths mismatch after amendment** — evidence check must compare against effective map from `resolveApprovedPaths`, and action scaffolds must publish that same list
- **Protocol overlay / skip-worktree** — change only `templates/product/AGENTS.protocol.md` (installed overlay source); do not hand-edit clone-local `AGENTS.md` skip-worktree state

## Conclusion

Add a narrow, ballot-agreed **additive** file-map overlay during `R4.implement` / `R6.revise`: the implementer proposes overlooked repository paths, peers agree (solo auto-derives), and `resolveApprovedPaths` unions those paths with the immutable selected plan extraction. That unblocks finishing the intended implementation when the plan’s file map omitted a necessary file, without reopening plan selection or allowing silent scope expansion.
