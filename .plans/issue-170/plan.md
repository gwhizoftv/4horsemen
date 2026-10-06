# Issue 170 — Centralize coord verification, reuse results, select tests

Follow-up to #162 (landed: shared classifier, `check:docs`, advisory
`verificationLog` / analytics). Delivers original proposal sections 3, 4, 5 and
the #170 portion of section 6. Goal: one execution of each required suite per
distinct verified input set, with coordinator-owned candidate and final gates,
while hooks keep integrity and cheap local checks.

**Out of scope:** diagnosing the onboarding timeout; changing manual-branch
verification defaults; editing installed live workspace `config.json` (owner
rollout after merge); dependency or version bumps; inventing a silent “skip
tests” path when runtime state is absent.

## Exact File List to be changed or deleted

- `src/state.ts` — optional `verification` block on `coordinatorConfigSchema` /
  `workspaceDeclarationSchema` (`mode: "local" | "coordinator"`, default
  `local`; `coordinated.{precommit,prepush}`; `candidate` with commands plus
  path-to-check `selection`; `maxConcurrentExpensive`); optional per-command
  `expensive`, `cache` (`inputs`, declared `env`, toolchain `probes`), and
  `retry` (default 0) on `checkCommandSchema`; snapshot resolved verification
  policy + digest into `startStateSchema` (optional for older `start.json`);
  journal types `candidate-check`, `verification-reused`, `verification-joined`;
  extend `final-check` details with receipt id, log path, attempt, cache/skip
  reason.
- `src/steps.ts` — extend `CheckResult` with log path, receipt id,
  `reused`/`joined`, attempt number, and original-failure retention so a retry
  never replaces a recorded failure.
- `src/runLoop.ts` — route `verifyFinalizationChecks` through the new
  verification service (keep `verifyFinalization` pin check and `authority()`
  between steps); add a candidate gate after `evaluateEvidence` for
  `R4.implement` / `R6.revise` when start snapshot mode is `coordinator`
  (classify baseline→pin via #162 classifier, apply `selection`, reject with
  failing command + log, or attach `checkResults`); finalization skips only
  components covered by a trusted receipt for equivalent inputs, else full
  declared gate; after restart, re-evaluate `verifying` and reuse only success
  receipts.
- `src/hookPolicy.ts`, `src/cli.ts` (`hook-verify`) — bind coordinated lists to
  the issue derived from the outgoing/committed branch (`issue-<n>/<agent>`),
  reading that issue’s `start.json` + cursors; apply coordinated lists only when
  snapshot mode is `coordinator`, issue is not completed/abandoned, and agent is
  in the active roster; otherwise run local `verify` and print why (absent
  runtime never means skip). Accept `--ref` for the single pushed branch.
- `githooks/lib/policy.sh`, `githooks/pre-push` — pass the single pushed branch
  to `hook-verify` (`--ref`); multi-ref push stays unbound and runs local
  checks. Integrity gates unchanged. `pre-commit` itself needs no change.
- `src/setupWorkspace.ts`, `src/install.ts` — carry `verification` through
  `install --declare` / config generation; validate every `selection` rule names
  a declared command.
- `src/action.ts`, `src/orderScaffold.ts` — implementation/revision actions state
  that coord runs candidate checks on the submitted pin (agents keep focused
  tests, do not re-run the full suite); comparison/ballot actions surface each
  bound pin’s candidate results and log paths.
- `src/analytics.ts` — split counts/time by trigger (hook / candidate / final);
  report reused/joined executions and time avoided; add limiter queue wait to
  critical-path verification wait.
- `package.json` — add `test:system`; redefine `check` as
  `build` + `check:fast` + `test:system` + `test:e2e` (full acceptance
  unchanged). Do **not** bump `version`.
- `vitest.config.ts` — keep `test:fast` to cheap unit tests (exclude the system
  suite files once split).
- `config.example.json`, `docs/setup-workspace.md`, `docs/coord-driver.md`,
  `docs/analytics.md` — coordinator-mode example with final gate split into
  lint / typecheck / test:fast / test:system / build / test:e2e; binding rules,
  fail-closed fallbacks, receipt keys/trust, retry policy, new analytics fields.
- `AGENTS.md`, `templates/product/AGENTS.protocol.md` — one coordinated-mode
  clause on top of #162’s alignment: in a coordinator run, coord owns candidate
  and final suites; agents cite coord’s results instead of re-running them.
  Update tracked / template content without clearing `skip-worktree` on the
  clone-local overlay; escalate if index plumbing is refused.
- `test/runLoop.test.ts` — candidate gate pass/fail back to revision; shared
  execution for reviewers; finalization reuse vs full-gate fallback; failed
  check still blocks after restart.
- `test/hookSync.test.ts` — bound vs unbound; broken/absent runtime → local
  checks; multi-ref pushes; manual branches keep configured checks; integrity
  gates stay active.
- `test/verify-config.test.ts` — declared final components equal `package.json`
  `check`; every test file belongs to exactly one vitest config; selection rules
  for hooks/templates/config/lockfile, renames, unusual names, unclassified
  paths expand to full coverage (extend #162 classifier coverage here or in the
  existing shared-classification suite in this file).
- `test/state.test.ts` — older `start.json` files still parse.
- `test/action.test.ts`, `test/analytics.test.ts` — candidate-result rendering
  and new report fields.

## Exact file list to be created

- `src/verificationReceipts.ts` — receipt key (origin, input identity, argv,
  policy digest, platform/arch/Node, probe outputs, declared env) and store at
  `<coordRoot>/verification/receipts/` (outside clones, atomic write,
  schema-validated). Input identity is exact pin tree (`tree`) or
  `ls-tree -r -z` digest omitting only #162 coordination-evidence prefixes
  (`tree-excluding-evidence`). Only completed exit-0 runs from a
  mirror-materialized worktree are written; agent signals and dirty clones are
  never trusted.
- `src/verificationRunner.ts` — shared candidate/final service: materialize
  worktree, run commands, per-command logs under the issue root; bounded retry
  that journals and keeps the original failure; workspace-wide lock-file
  semaphore for `expensive`; join in-flight runs (in-process promise map +
  per-key lock file) so waiters re-read the receipt and never treat an
  interrupted run as success.
- `vitest.system.config.ts` — `test:system` suite. Initial candidates for the
  split (confirm from recorded durations): `cli`, `install`, `workspace`,
  `wipeIssue`, `wrapper`, `bootstrap`, `onboard`, `hookSync`, `agentHookSync`.
- `test/verificationReceipts.test.ts` — key invalidation on tree/argv/policy/
  platform/probes/env and evidence-only differences; no receipt from failed or
  interrupted runs; no reuse from dirty checkout.
- `test/verificationRunner.test.ts` — concurrent join; expensive semaphore;
  retry retains original failure.

## Reuse and Scope

**Reuse (do not reimplement):**

- `classifyChanges`, `inspectRangeChanges`, `inspectStagedChanges`,
  `inspectOutgoingChanges`, `selectVerification` in `src/changeClassification.ts`
  for baseline→pin and hook classification; evidence-prefix skip already matches
  `.signals/`, `.plans/`, `.code-reviews/`, `.amendments/`, `.escalations/`.
- `verificationMeasurement`, `createVerificationIngestor`,
  `hookVerificationRecorder` in `src/verificationLog.ts` for advisory journals;
  extend analytics consumers rather than a second logging path.
- `verifyFinalization` in `src/finalization.ts` for the pin/consensus gate
  before suite execution.
- `CheckResult` / `retry-verification` / evidence observation shapes in
  `src/steps.ts` and `evaluateEvidence` in `src/evidence.js` — extend, do not
  fork the machine.
- Existing `mirror.materializeWorktree` / `removeWorktree` and `processRunner`
  used today inside `verifyFinalizationChecks`.
- `appendJournal`, `atomicWriteJson`, schema helpers in `src/state.ts`.
- Hook path `coord_verify` → `hook-verify` in `githooks/lib/policy.sh` /
  `src/cli.ts` / `src/hookPolicy.ts`.
- Existing fixtures and suites in `test/runLoop.test.ts`,
  `test/hookSync.test.ts`, `test/verify-config.test.ts`, `test/state.test.ts`,
  `test/action.test.ts`, `test/analytics.test.ts`.

**New files justified:**

- `verificationReceipts.ts` — persistence and keying are a distinct trust
  boundary (outside clones, schema-validated, never agent-authored); keeping
  them out of `runLoop.ts` / `state.ts` avoids mixing orchestration with the
  store.
- `verificationRunner.ts` — shared execution, join, semaphore, and retry logic
  for both candidate and final gates; replacing the inline loop in
  `verifyFinalizationChecks` without duplicating it for the new candidate gate.
- `vitest.system.config.ts` — required to split expensive filesystem/process
  tests from `test:fast` while keeping them in full `check`.
- Two focused test files — receipt key/store and runner concurrency/retry are
  unit-isolated; gate wiring stays in existing `runLoop` / `hookSync` tests.

Paths cited only here do not expand the change set; every product path to edit
is listed in the file-list sections above.

## Tests

Fewest focused cases (fail before, pass after), joining existing files when
possible:

1. **`test/verificationReceipts.test.ts` (new)** — same key hits reuse; changing
   tree, argv, policy digest, platform, probe output, or declared env misses;
   evidence-only tree difference under `tree-excluding-evidence` still hits;
   failed/interrupted/dirty runs write no success receipt.
2. **`test/verificationRunner.test.ts` (new)** — two waiters join one execution;
   `maxConcurrentExpensive` blocks a second expensive run until the first
   finishes; a retry journals attempts but outcome remains the first failure.
3. **`test/runLoop.test.ts`** — coordinator-mode implement/revise: candidate
   failure → `retry-verification` with command + log path; success attaches
   `checkResults`; two consumers of the same pin share one run; finalization
   reuses a trusted receipt or falls back to the full gate; failed candidate/
   final still blocks after a simulated restart.
4. **`test/hookSync.test.ts`** — bound `issue-N/agent` with coordinator snapshot
   uses `coordinated` lists; unbound/manual/missing runtime/multi-ref uses local
   `verify` and explains why; ownership/prefix/no-main/no-peer/no-force still
   enforce.
5. **`test/verify-config.test.ts`** — `check` script composition matches
   declared components; each `test/*.test.ts` is in exactly one of
   `vitest.config.ts` / `vitest.system.config.ts` / `vitest.e2e.config.ts`;
   selection rules force full coverage for hooks/templates/config/lockfile/
   renames/unusual/unclassified paths.
6. **`test/state.test.ts`** — pre-#170 `start.json` without `verification`
   still parses.
7. **`test/action.test.ts`**, **`test/analytics.test.ts`** — action text shows
   shared candidate results/log paths; analytics report reused/joined/time
   avoided and limiter wait.

**Commands while developing:** focused vitest files + `pnpm check:fast`.
**Before PR:** full `pnpm check`. Report only checks actually run; coordinator
owns final pin checks.

## Alternatives Rejected

- **Empty both `verify` arrays to skip hook suites** — also changes manual
  behavior and supplies no candidate gate; absent runtime must not mean skip.
- **Trust agent-authored “tests passed” signals or dirty-clone results** —
  breaks the single trusted input identity; only mirror-materialized exit-0
  runs with a full receipt key are reusable.
- **Import-graph-only affected-test selection** — misses files read through
  filesystem APIs (hooks, templates, fixtures); path-to-check `selection` plus
  fail-closed full coverage for unclassified changes is required.
- **Keep mandatory E2E on every automated push** — duplicates work the
  candidate/final gates will own; hooks retain cheap coordinated lists only.
- **Blindly re-run aggregate `pnpm check` at finalization even when every
  component has a trusted receipt** — wastes the receipt store; skip only when
  each declared component has an equivalent-input success receipt, else full
  gate.
- **New abstraction layer over Git or a separate process manager** — reuse
  existing mirror worktrees, `processRunner`, and journal helpers.

## Risks and Mitigations

- **Silent skip if runtime/state missing** — fail closed to local `verify`
  lists and print the reason; never treat absent coordinator binding as empty
  checks.
- **Stale or forged receipts** — key includes origin, input identity, argv,
  policy digest, platform/Node, probes, and env; store only outside clones;
  validate schema; never read agent signals as results.
- **Mid-issue mode flip via `coord install`** — snapshot policy + digest into
  `start.json` at issue start; hooks and gates read the snapshot, not live
  config alone.
- **Retry greenwashing** — bounded retry keeps the original failure as the
  outcome; journals every attempt.
- **Expensive-suite contention / timeouts** — `maxConcurrentExpensive`
  semaphore; measure rather than assume this fixed the #162 onboarding timeout
  (that diagnosis stays out of scope).
- **AGENTS.md skip-worktree overlay** — edit tracked/template protocol text
  without clearing the bit; escalate if the environment refuses index plumbing.
- **Live workspaces stay on `local` until owner declares `coordinator`** —
  no surprise behavior change on merge; document the rollout step.

## Conclusion

Implement coordinator-owned candidate and final verification with trusted
receipts and a cheap/expensive test split on top of #162’s classifier and
measurement, so automated runs execute each required suite once per distinct
input set, hooks keep integrity plus cheap checks, and manual branches keep
their configured local policy until an owner opts into coordinator mode.
