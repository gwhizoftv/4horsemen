# Issue 170 — coordinator-owned verification with conservative reuse

Baseline: 6f5b4bc0bb97feeb1711fe3d8f38c327460f5827. Build on the shared classification, documentation policy, and advisory measurements already delivered by issue 162. Deliver ownership first, receipts second, and selective execution third. This plan changes verification, not agent delivery, workspace resolution, or the unrelated onboarding timeout.

## Exact File List to be changed or deleted

No deletions. Change only these existing product files:

- `src/state.ts` — strict optional coordinated-verification declaration, frozen start policy, accepted-result references, and backward-compatible state validation.
- `src/setupWorkspace.ts` — preserve the explicit declaration in generated workspace configuration; do not infer an opt-in from an ecosystem or empty hook arrays.
- `src/cli.ts` — freeze verification policy at start and supply validated automated context to hook verification.
- `src/hookPolicy.ts` — choose declared cheap automated hook checks only for a matching active issue; retain manual checks and fail-closed fallback.
- `src/changeClassification.ts` — extend the shared selector with candidate phase and conservative explicit path-to-check rules.
- `src/paths.ts` — contained owner-only verification job, receipt, and log locations, outside agent clones and completion mailboxes.
- `src/runLoop.ts` — gate implementation/revision acceptance, consume shared results, render them for reviewers, and run only proven-missing final requirements.
- `src/steps.ts` — typed coordinator verification summaries on internal orders, separate from agent-authored evidence.
- `src/action.ts` — render command outcomes and stable log locations for all reviewers and actionable failure feedback for implementers.
- `src/verificationLog.ts` — distinguish actual execution, joined jobs, trusted cache hits, artifact validation, and policy skips; preserve old advisory records.
- `src/analytics.ts` — execution counts, cache/join counts, aggregate suite time, and queue/execution critical-path wait without double counting consumers.
- `config.example.json` — explicit opt-in example with atomic checks and documented manual fallback.
- `package.json` — add a filesystem/process test tier and ensure full acceptance still includes every tier; no version bump or dependency changes.
- `vitest.config.ts` — retain cheap tests while excluding the explicit expensive tier.
- `vitest.e2e.config.ts` — retain end-to-end acceptance and align shared coverage declarations if needed.
- `templates/product/AGENTS.protocol.md` — conditional instructions for coordinator-owned candidate checks, focused local tests, and unchanged manual fallback.
- `docs/coord-driver.md` — explain the mode, candidate gate, receipts, failure recovery, and full-gate fallback.
- `docs/setup-workspace.md` — declaration examples, active-run binding, dependency setup, and migration without silently editing an existing runtime.
- `docs/analytics.md` — define verification ownership, queue wait, cache hits, and what remains unobserved.
- `test/state.test.ts` — declaration validation, old-runtime defaults, and persisted result compatibility.
- `test/verify-config.test.ts` — selector, setup propagation, example consistency, and test-tier coverage assertions.
- `test/cli.test.ts` — frozen policy and hook-context integration.
- `test/hookSync.test.ts` — real installed-hook behavior, manual fallback, and preserved integrity/evidence/doc exemptions.
- `test/runLoop.test.ts` — candidate and final gates, shared result delivery, stale-authority rejection, and restart behavior.
- `test/action.test.ts` — bound result/log rendering and mode-specific instructions.
- `test/analytics.test.ts` — execution versus reuse and queue-wait accounting.

## Exact file list to be created

- `src/verificationReceipts.ts` — strict receipt identity and atomic owner-side storage; deliberately separate from untrusted hook telemetry.
- `src/verificationRunner.ts` — one pinned-worktree execution service shared by candidate and final gates, with single-flight jobs, durable outcomes, logs, and an expensive-suite concurrency limit.
- `test/verification.test.ts` — focused receipt/runner contract tests using temporary local Git fixtures and injected runners/clocks; no network or new test framework.
- `test/support/testSuites.ts` — one explicit inventory of filesystem/process-heavy files shared by test configurations, avoiding diverging include/exclude lists.
- `vitest.system.config.ts` — the new expensive filesystem/process tier with bounded workers and the existing event-loop-yield setup.

The coordination plan artifact itself is not a product file. Do not edit the clone-local AGENTS overlay, product hook bodies, lockfile, generated build output, or live owner runtime configuration to make checks pass.

## Reuse and Scope

Reuse CheckCommand, verifyConfigSchema, workspaceDeclarationSchema, coordinatorConfigSchema, startStateSchema, acceptedSubmissionSchema, atomicWriteJson, and the current cursor mutation/authority checks. Reuse classifyChanges, selectVerification, inspectStagedChanges, inspectOutgoingChanges, inspectRangeChanges, the NUL-safe rename-aware range parser, and the baseline-based final classifier. Do not introduce a second classifier in shell hooks.

Reuse BareMirror materialization/removal and ProcessRunner for immutable worktrees; reuse containedPath and assertNoSymlink for owner storage. Keep finalization's existing product-equivalence validation before any check reuse. Extend verificationMeasurement/buildAnalytics rather than building another telemetry pipeline. Existing hook observations remain advisory and never become trusted receipts.

Reuse run-loop fixture/buildOrder helpers, installed/makeProduct/workspaceFixture helpers, the analytics journal builders, and the existing event-loop-yield setup. The two production modules isolate receipt trust and runner lifecycle from the already-large run loop. One direct test file is warranted for these new modules; acceptance coverage belongs in existing test files. The tier manifest and configuration exist solely to split current coverage without dropping tests. No new dependencies, generic scheduler framework, AST/import graph, or unrelated refactoring.

### 1. Explicit policy and active-run binding

Add an optional versioned verification declaration alongside existing manual verify/checks fields. It declares coordinated mode, cheap local precommit/prepush vectors, atomic check IDs and commands, candidate requirements, final requirements, explicit early-risk path rules, preparation commands, bounded expensive concurrency (default one), and per-check cache/input policy. Keep ordinary manual verify arrays and the legacy final checks as the conservative fallback. Require unique IDs, resolvable references, nonempty candidate/final product requirements, and explicit preparation/toolchain declarations for cached commands.

Freeze the declaration in start state and bind its canonical digest to the run's existing automation digest. Absent declarations preserve existing behavior; older format-4 state parses with coordinated mode disabled. No live config change may weaken a frozen run. Start/install preserve an owner's declaration rather than enabling it automatically for every repository.

Hook selection must verify branch issue/agent, configured clone real path, origin, actual readable start/cursors, active roster, noncompleted/nonabandoned run, and the frozen declaration. An environment variable or an issue-shaped branch alone is not sufficient. Current config must agree with the frozen coordinated policy; a malformed/missing/mismatched runtime runs the existing local policy or errors if that policy is undeclared, never silently skips. Manual scratch branches keep their original checks. Existing branch ownership, commit prefix, no-main/no-peer/no-force, staged-index, and outgoing-ref gates are untouched. Evidence-only and declared documentation classification retain issue 162 behavior.

### 2. Candidate gate and shared results

After evaluateEvidence validates an implementation or revision artifact and its exact product pin, but before the observation becomes eligible for acceptance, schedule the selected candidate checks at that product pin. Amendment requests, plans, reviews, and signals without a product candidate do not launch suites. Classify from frozen issue baseline to candidate, not signal tip or cleanup parent. Documentation uses the frozen docs policy; unknown or mixed paths use product checks. A declared risk rule can add expensive/system/build/E2E checks early; final acceptance is never narrowed by candidate selection.

Use clean coordinator-owned detached worktrees, not any agent working directory, with declared frozen dependency setup. Bind each job to immutable inputs; keep references from action/session/pin to that job. Execution must not hold the state lock or stall lifecycle/owner-control polling: schedule bounded async work, observe completion on subsequent ticks, and recheck authority before applying results. Dropped agents, changed actions, pauses, and abandonment cannot receive stale acceptance from a late job. The same snapshot requested by multiple consumers shares one job and the same logs.

On failure, reject/reissue the current implementation or revision action with command, exit status, and stable full-log path. Preserve the revision's basedOn relationship and approved scope. Do not advance to comparison/ballot using a failed candidate. Persist job outcome and result references before acceptance; restart must resume observation or conservatively rerun, never infer success from a missing process or completion marker. Review actions bind pin-specific coordinator results and log paths for all participants. Legacy runs explicitly report candidate verification unavailable rather than fabricating a pass.

### 3. Receipts, concurrency, and final acceptance

Write successful receipts only from the coordinator runner into owner storage inaccessible through agent response/completion grants. Key them by normalized repository identity; immutable commit and tree; check ID and canonical argv; verification/input-policy version and digest; executable/toolchain versions; platform/architecture; dependency lock/install identity; preparation policy; and a digest of the declared relevant environment with missing-versus-present values preserved. Redact environment values and secrets from logs/receipts. Default to exact commit snapshots, not just equal source-tree hashes; commands sensitive to Git history or identity retain that binding. Unknown environment/toolchain/dependency inputs, external services, or undeclared inputs disable caching.

Provide explicit per-check projected-tree opt-in only for commands declared independent of excluded paths and Git identity/history. Hash all remaining tracked paths with modes, names, and object IDs (including deletions); default exclusions are empty. Narrow coordination-evidence exclusions can prove equivalence across evidence-only commits/cleanup, but must never exclude dependency, build, test, hook, template, configuration, or other undeclared inputs. Every digest rule is part of the key. Any inability to establish equivalence is a cache miss, not permission to assume unchanged inputs.

Prepare an isolated dependency state before computing/validating the execution identity. Reject reusable success if tracked inputs, relevant environment, or dependencies change during execution, or if a dirty/preexisting checkout supplies inputs. Generated outputs must follow declared preparation/order and must not become hidden cache inputs. Atomically publish receipts only after exit zero and post-run identity validation. Store failed/interrupted attempts for diagnosis but never as successful receipts. Agent signals, advisory hook records, malformed receipts, and partial files have no gate authority.

Use an in-memory promise map plus atomic owner-side job claims for cross-instance single-flight; coordinate expensive slots at workspace scope so agents/issues sharing that workspace do not overlap expensive mandatory suites above the limit. A restarted coordinator must not reclaim a live job merely because a timer expired; confirm its owner is gone, record interruption, then retry conservatively. No automatic retries by default. If a bounded retry is explicitly declared, record each failure, attempt, and final outcome; a diagnostic focused retry cannot satisfy a failed required suite.

Finalization first retains current consensus-to-final product validation and frozen baseline classification. A fully declared atomic final profile can run just missing lint/typecheck/fast/system/build/E2E requirements when each reused result has a trusted equivalent-input receipt. A check cannot be discharged because its name resembles part of an aggregate command. If aggregate decomposition or equivalence is undeclared/unverifiable, run the existing full final profile. Cold finalization executes all required coverage. A failed final requirement blocks publication after restart as well as in the current process.

### 4. Selective tests and measurement

Split current expensive filesystem/process cases into the system tier using a single explicit file manifest (start with installer/onboarding/bootstrap/hook synchronization/workspace/wrapper/wipe/real-CLI/run-loop cases after inspecting their fixtures). Leave lightweight schema/algorithm/unit checks in fast. Keep existing end-to-end tests distinct. Add a coverage assertion that fast, system, and E2E include every test file exactly once; new unclassified tests join full coverage rather than vanishing. Full check runs build, lint, typecheck, fast, system, and E2E. Keep documentation's focused command working if a referenced test moves tiers, by selecting it through the appropriate config rather than relying on an excluded fast file.

Candidate selection uses explicit conservative path rules and unions every matching requirement over both rename paths. Shell hooks, launcher scripts, templates, and filesystem-read fixtures explicitly select their integration consumers. Dependency manifests/lockfiles, test/build/lint configuration, changed selection policy, missing history, undecodable names, or any unclassified path select full coverage. Ordinary source changes retain at least the complete fast tier unless a narrower dependency mapping is explicitly proven; no import-only inference. Final acceptance always covers the full declared requirement set.

Extend existing journal measurements with stable job/attempt IDs, candidate phase, requested/queued/started/completed times, immutable input identity, command, selection reason, exit code, and cache/skip/join reason. Distinguish execution from consumption and artifact validation. Analytics count each actual suite attempt once, sum execution time, and union queue/execution wait intervals instead of multiplying time for several consumers. Maintain legacy journal readability and mark advisory/unknown coverage honestly. Do not assert a measured performance improvement or explain the onboarding timeout without data.

## Tests

Evidence-only publication of this plan needs heading/file-map/content validation, not product suites. Implementation uses the following minimal acceptance groups, extending the named existing files:

1. State/config/CLI tests: coordinated declaration round-trip and frozen start; malformed references and absent candidate requirements rejected; old state unchanged; no implicit opt-in. Table-driven hookSync tests: active matching automation selects cheap vectors, manual/missing/broken/mismatched runtime selects manual vectors or fails closed; all existing integrity assertions remain; evidence with unstaged product edits still skips; README-only versus mixed input still differs.
2. Direct verification tests: two simultaneous consumers and a second runner share one actual invocation; restart reuses a valid completed receipt, not interrupted/failed/tampered/partial state. Table-driven key invalidation for commit/tree/argv/policy/toolchain/platform/dependency/environment; dirty-input and undeclared-input refusal; exact-pin defaults and explicitly proven evidence-cleanup reuse; expensive limit and orphan recovery. No real expensive tools needed for scheduling tests.
3. Run-loop tests: candidate failure reissues implementation/revision before acceptance; success unlocks review with identical logs for every reader; new action/drop during a job discards stale application; final missing-only versus aggregate fallback; failed finalization still prevents all publication effects after restart. Extend existing real-Git baseline/cleanup fixture rather than inventing a second one.
4. Selector/config tests: hook/template/fixture mappings, both rename endpoints, tabs/newlines, invalid encoding, first push/missing history, lock/config changes, and unknown paths all retain required coverage. Assert the test-tier partition and full script includes every tier, including docs command compatibility.
5. Action/analytics tests: render bound pin/results/logs and failures; count one run for multiple consumers, retain original failure on retry, report candidate/final/cache/queue statistics and read old measurements.

Focused commands available before the change include `pnpm exec vitest run --config vitest.config.ts test/state.test.ts test/verify-config.test.ts test/action.test.ts test/analytics.test.ts` and `pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/hookSync.test.ts test/cli.test.ts`. Once split, use `pnpm exec vitest run --config vitest.system.config.ts test/runLoop.test.ts test/hookSync.test.ts test/cli.test.ts`; run direct runner tests via `pnpm exec vitest run --config vitest.config.ts test/verification.test.ts`. Run `pnpm check:docs` to verify moved focused coverage and instruction examples.

The current installed commit hook owns `pnpm check:fast`; do not manually duplicate it immediately before a product commit. The current push hook owns `pnpm test:e2e` until the owner installs/enables the new policy. The coordinator owns `pnpm check` at the approved final pin; the new full command must include the system tier. Record only executed commands, never claim a suite passed because its receipt/log is absent. Do not change live hooks/config to test the new policy; use the installed-hook fixtures.

## Alternatives Rejected

- Emptying both hook verify arrays globally: weakens manual branches and creates no candidate gate.
- Caching agent claims, hook telemetry, exit markers alone, or dirty working directories: none establishes verified immutable inputs.
- Reusing all equal trees automatically or stripping all evidence paths unconditionally: commands may inspect Git metadata or evidence; require explicit input declarations.
- Parsing an aggregate command into guessed component successes: only an explicit complete atomic requirement profile can replace the full fallback.
- Import-only test selection, extension-only docs classification, or dropping expensive tests from acceptance: filesystem consumers and unknown changes require conservative coverage.
- Independent mandatory E2E runs in every automated push or unbounded parallelism: central ownership and a shared bound avoid duplicate contention without claiming a timeout diagnosis.
- Automatically retrying until green: retain failures and enforce an explicit bounded policy instead.

## Risks and Mitigations

- Incorrect cache equivalence could publish unverified code. Default to exact snapshots and uncached unknown inputs; explicit exclusions are opt-in, key-bound, and tested. Full final fallback remains available.
- Runtime/config drift could weaken hooks. Resolve actual issue/agent/clone identity and frozen policy; mismatch falls back to manual checks or fails closed. Do not use environment-only authority.
- Async work can outlive its action or process. Persist jobs/outcomes, use safe claims, keep cursor effects behind existing authority checks, and treat interruption as incomplete verification.
- Dependency setup and generated outputs can obscure inputs. Declare preparation/toolchain/environment and validate identities before/after; never reuse agent-installed dependencies as proof.
- Test-tier movement can silently reduce checks or break docs tests. Share one manifest, assert exhaustive disjoint coverage, preserve focused docs commands, and keep full acceptance mandatory.
- Measurement claims can overstate savings. Count executions separately from joins/cache hits, retain legacy unknowns, and report actual queue and execution time. Investigate unrelated timeouts separately.
- Scope could expand during implementation. The exact map above is authoritative; request a plan amendment rather than touching another product file or adding an abstraction silently.

## Conclusion

Implement the three layers in order while keeping the feature opt-in and preserving the current manual/full verification fallback. Candidate eligibility and publication must depend on coordinator-owned successful results, never agent assertions. Reuse only proven equivalent inputs, keep expensive acceptance coverage, and measure execution savings without masking failures. No product changes or product tests are part of publishing this plan.
