# Issue 89 plan: measure only what Phase 2 must improve

## Scope and Evidence

Issue 89 aims to reduce coordination wall time, model work, repeated context,
and tool-call pressure without weakening independent judgment or final
verification. The Codex and Cursor discussions converge on two high-value,
bounded Phase-2 changes:

1. combine plan review with plan choice and implementation comparison with
   implementation choice; and
2. make the coordinator derive the mechanical selection, reviser authorization,
   and consensus declaration steps from already accepted evidence.

For `N` agents, those changes remove `2N + 3` model actions without removing an
independent plan, review, implementation, comparison, revision, or consensus
vote. With four agents and one successful revision round, the expected action
count falls from 37 to 26.

Phase 1 exists only to establish and later verify those Phase-2 savings. It will
measure:

- total and per-gate wall time;
- logical model actions and correction publications by step;
- rendered action bytes and exact bytes/count of pinned bound inputs;
- verification failures and revision rounds as quality guardrails; and
- final completion/check status, profile, and roster so comparisons are
  like-for-like.

It will not build general coordinator observability. Coordinator Git/PR
operation timing, lifecycle/nudge volume, journal size, vendor token adapters,
agent tool-call inference, percentile dashboards, and multi-issue aggregation
are outside this phase because Phase 2 does not need them. Action/input bytes
are labeled transport/context proxies, not tokens. Removing a complete model
turn is the structural tool/token saving; no unsupported vendor usage number is
invented.

The Phase-1 owner commands are:

```text
coord report --efficiency --issue <n> [--product <path> | --coord-root <path>]
coord report --efficiency --json --issue <n> [--product <path> | --coord-root <path>]
```

The default form is a short human summary. `--json` emits only a stable
`coord-efficiency-v1` document for before/after comparison.

## Phase 1 — Minimum Analytics Baseline

The report contains only the fields needed by the Phase-2 scorecard:

- issue, profile, original/active roster, completion state, and revision count;
- run start/end or explicit in-progress snapshot and elapsed milliseconds;
- each workflow gate/round and its elapsed milliseconds;
- logical action count by step/round/agent;
- action publication count, correction/reissue count, and accepted count;
- rendered `action.md` bytes for initial and correction publications;
- bound input count and exact immutable blob bytes by input kind;
- verification success/failure count and outstanding finding count; and
- final check result and completed/abandoned status.

Historical journals remain reportable. Fields that were not recorded, such as
rendered/bound bytes, are `null` with partial coverage rather than zero. Gate and
action counts already present in historical issue-76 state provide the initial
structural baseline; new byte fields become comparable after Phase 1 ships.

Phase 2 is successful only when comparable runs show:

- the expected `2N + 3` reduction in logical model actions;
- no model action publication for the three coordinator-derived clerical steps;
- no separate ballot action after a review or comparison;
- lower or equal wall time for the affected gates;
- lower repeated action/bound-input bytes; and
- no increase in verification failures or revision rounds, with the same final
  checks passing and the same independent judgment roles preserved.

## Exact File List to be changed or deleted

### Changed

- `README.md` — add the focused per-issue efficiency-report command and explain
  the Phase-2 scorecard and proxy limitations.
- `config.product.example.json` — bump the installed coordination version from
  `0.0.12` to `0.0.13` for this ship.
- `docs/coord-driver.md` — document the minimal report contract, historical
  coverage behavior, exact byte semantics, privacy boundary, and Phase-2
  acceptance criteria.
- `package.json` — bump the package version from `0.0.12` to `0.0.13` so the
  non-main ship gate passes.
- `src/cli.ts` — register `coord report --efficiency`, boolean `--json`, strict
  flag validation, normal issue-runtime resolution, and human-versus-JSON
  rendering. Do not add workspace-wide aggregation.
- `src/mirror.ts` — add a confined batch blob-size query for exact bound
  `commit:path` inputs. Validate commits and paths through the existing mirror
  trust boundary and avoid materializing blob contents.
- `src/runLoop.ts` — record step/round, rendered action bytes, bound-input count,
  and bound-input bytes when an action is first prepared or correction content
  is reissued. Do not add general operation timing or lifecycle telemetry.
- `src/state.ts` — admit a backward-compatible `action-reissued` journal event
  and validate its measurement details. Keep runtime format version 2 so older
  journals remain readable.
- `test/cli.test.ts` — update the version assertion and test human/JSON reports,
  issue/product/runtime resolution, strict flags, and JSON without a human
  preamble.
- `test/install.test.ts` — update the installed-version assertion to `0.0.13`.
- `test/integration.test.ts` — prove the focused telemetry is emitted by a
  complete workflow without changing its accepted result or final checks.
- `test/mirror.test.ts` — test batch immutable blob sizing, duplicate inputs,
  missing commits/blobs, and path confinement.
- `test/runLoop.test.ts` — test initial/correction publication measurements and
  prove action IDs, verification, authority checks, and gate decisions remain
  unchanged.
- `test/state.test.ts` — cover `action-reissued` parsing plus compatibility with
  version-2 journals that lack the new optional measurements.

### Deleted

- None.

## Exact file list to be created

- `src/efficiencyReport.ts` — define `coord-efficiency-v1`, derive the focused
  per-issue scorecard from `StartState`, `CursorsState`, and validated journal
  events, and render deterministic JSON and concise text.
- `test/efficiencyReport.test.ts` — unit-test run/gate timing, logical actions
  versus correction publications, parallelism, action/input bytes, quality
  guardrails, legacy/in-progress coverage, deterministic ordering, and output
  privacy.

## Implementation Details

1. Derive reports only from owner-controlled runtime state and journal events.
   Reporting must not mutate runtime, fetch Git, inspect agent clones, read model
   transcripts/render logs, or contact vendor services.
2. Use `start.createdAt` as the run start. Use the completion boundary for a
   completed run and label the snapshot time for an incomplete run. Reject
   invalid or negative intervals.
3. Pair `action-prepared`, `action-reissued`, and `verify-result` events by
   action ID. Report logical actions separately from publications/corrections so
   a rejected artifact never appears as another independent judgment.
4. Calculate gate wall time from ordered `gate-advanced` boundaries. Four
   concurrent agent actions count as one wall-clock gate; do not sum their
   durations into elapsed run time.
5. Record rendered bytes from the exact `action.md` content written for each
   publication. Sum bound input bytes from immutable mirror blobs named by the
   action's commit/path inputs, using one bounded batch lookup per action.
6. Group bound bytes by input kind so Phase 2 can show which repeated plan,
   review, implementation, or comparison context was removed.
7. Give newly measured byte families `complete`, `partial`, or `unavailable`
   coverage. Historical missing fields remain `null`, never zero.
8. Count verification failures and findings from explicit `verify-result`
   records. Take revision count and final status/check results from validated
   cursor/accepted state and journal events.
9. Keep human output to the Phase-2 scorecard: total/gate time, logical actions,
   corrections, action/input bytes, verification failures, revision rounds,
   final status, and coverage warnings.
10. Never include action bodies, peer blob content, stderr, credentials,
    environment values, transcripts, or render logs in telemetry or reports.
11. Use the issue-76 historical report as the structural baseline. Collect at
    least one post-Phase-1 four-agent consensus baseline for complete byte
    coverage before judging Phase 2's context-byte reduction.
12. Keep Phase 2 separately authorized after the baseline is recorded. Its
    implementation must preserve immutable input binding, all independent
    judgment roles, the revision/consensus gate, finalization cleanup, and full
    configured checks.

## Tests

Run focused tests while implementing:

```bash
pnpm vitest run --config vitest.config.ts test/efficiencyReport.test.ts test/state.test.ts test/mirror.test.ts test/runLoop.test.ts test/cli.test.ts test/integration.test.ts
```

Run the repository's required pre-commit suite before committing:

```bash
pnpm check:fast
```

Run the full coordinator acceptance suite before publication/final acceptance:

```bash
pnpm check
```

Exercise the built CLI against complete and in-progress fixtures:

```bash
pnpm build
node dist/main.js report --efficiency --issue 76 --coord-root /path/to/fixture-runtime
node dist/main.js report --efficiency --json --issue 76 --coord-root /path/to/fixture-runtime
```

Tests must prove:

- JSON output conforms to `coord-efficiency-v1` and has no human preamble.
- Corrections increase publications/reissues without increasing logical actions.
- Parallel work does not inflate wall-clock totals.
- Bound-input byte totals come from exact pinned blobs and fail closed for an
  invalid binding.
- Legacy missing measurements produce partial/unavailable coverage, not zero.
- Reports contain no token/tool-call claims or sensitive content.
- Instrumentation leaves workflow acceptance, correction, finalization, and
  checks unchanged.

## Alternatives Rejected

- **Comprehensive coordinator observability in Phase 1.** Git, check, PR,
  lifecycle, nudge, and journal-volume telemetry may be useful later, but it
  does not decide whether Phase 2 removed model actions and repeated inputs.
- **Workspace dashboards and percentile aggregation.** The first decision needs
  a small number of comparable per-issue JSON reports; a reporting platform is
  unnecessary scope.
- **Vendor token and tool-call adapters.** Coverage and formats differ by vendor.
  Phase 2 structurally removes turns, while action/input bytes provide an
  explicitly labeled context proxy.
- **Measure only total elapsed time.** It cannot attribute savings to the exact
  gates Phase 2 removes or combines.
- **Measure only action counts.** Counts prove turn removal but not repeated
  context reduction or gate latency.
- **Optimize before the baseline exists.** Historical issue 76 supplies action
  and timing counts, but one post-Phase-1 run is needed for byte coverage.
- **Reduce plans, reviewers, implementations, or consensus voters.** Phase 2
  removes clerical/duplicated turns, not independent judgment.
- **Add repository maps, embeddings, or retrieval in Phase 1.** Context tooling
  is not required for the selected Phase-2 action consolidation and could add
  more input than it saves.
- **Store analytics in issue coordination artifacts.** Those files are deleted
  during finalization; external runtime state is the durable authority.

## Risks and Mitigations

- **Risk: byte counts are mistaken for tokens.** Mitigation: label them as
  transport/context bytes and never convert them to token or cost estimates.
- **Risk: parallel action durations inflate savings claims.** Mitigation: use
  gate wall time as the elapsed metric and keep action counts separate.
- **Risk: historical runs appear cheaper because byte fields are absent.**
  Mitigation: mandatory coverage states and a post-Phase-1 baseline.
- **Risk: blob sizing adds coordinator overhead.** Mitigation: use one confined,
  non-materializing batch lookup per action and record only numeric sizes.
- **Risk: journal extension changes correctness-sensitive ordering.**
  Mitigation: preserve existing locks/authority checks and assert identical
  workflow results in run-loop and integration tests.
- **Risk: invalid bound inputs cross the mirror trust boundary.** Mitigation:
  validate commit/path inputs and fail closed on missing or unsafe blobs.
- **Risk: Phase 2 improves counts but harms quality.** Mitigation: preserve every
  independent judgment role and require unchanged-or-better verification
  failures, revision rounds, and final check results.
- **Risk: scope grows back into a general analytics platform.** Mitigation: every
  Phase-1 field must map directly to a Phase-2 success criterion listed above.

## Conclusion

Phase 1 is reduced to the smallest defensible scorecard for Phase 2: gate time,
logical actions and corrections, repeated action/input bytes, and workflow
quality guardrails. General operational analytics, vendor usage, lifecycle
volume, and aggregation are deferred. This is enough to prove whether combining
paired judgment/choice turns and deriving three clerical steps removes the
expected 11 model actions in a four-agent consensus run, lowers repeated
context and affected-gate latency, and preserves the existing quality and
safety guarantees.
