# Plan — issue 170: coordinator-owned verification, receipts, selective tests

Baseline `6f5b4bc` (v0.0.44). #162 has landed: `src/changeClassification.ts`
(shared fail-closed classifier, `selectVerification`), `src/verificationLog.ts`
(advisory `verification-run` measurements), the `check:docs` profile and
`deriveVerification` in `src/analytics.ts` already exist. This plan extends them
and follows the owner's file-map comment on #170, with five corrections verified
against the code (each is justified under Alternatives Rejected):

1. `githooks/lib/policy.sh` and `githooks/pre-push` are **not** changed. `pre-push`
   already pipes the buffered ref lines (`local_ref local_sha remote_ref remote_sha`)
   to `hook-verify` on stdin, so the pushed branch is available in TypeScript.
2. `src/orderScaffold.ts` is **not** changed. Coordinator results are rendered by
   `src/action.ts` and never copied into agent-authored JSON.
3. `src/install.ts` is **not** changed. `readDeclaration` already parses with
   `workspaceDeclarationSchema`, and `buildWorkspaceConfig` re-parses with
   `coordinatorConfigSchema`, so schema refinements enforce validation at install.
4. A failed candidate check returns `status: "rejected"`, so `machine.ts` emits
   `reissue-action` and the agent receives a corrected R4/R6 action naming the
   command and log. `retry-verification` only resets the cursor to `intent`, re-evaluating
   the same completion without telling the agent. That path is reserved for coordinator
   launch errors, which keep today's semantics: they throw, and the next tick re-evaluates.
5. Receipt keys use the **declared** argv. The executed argv has `{worktree}`
   replaced by a random `.verification-<uuid>` path, so a key built from it
   would never match.

**Out of scope:** diagnosing the onboarding timeout; editing installed hooks or the
live workspace `config.json` (switching a workspace to coordinator mode is an
owner rollout step after merge); dependency or version bumps; changing
`hookVerificationRecorder`'s existing attribution.

## Exact File List to be changed or deleted

Nothing is deleted.

- `src/state.ts`
  - Extend `checkCommandSchema` with optional, fail-closed metadata:
    - `expensive?: boolean`
    - `retry?: 0..2`, diagnostic only (see the runner).
    - `cache?: { inputs: "tree" | "tree-excluding-evidence"; env: string[] (/^[A-Z_][A-Z0-9_]*$/, default []); probes: string[][] (default []) }`.
      Absent `cache` means the command is never cached.
  - New exported `verificationPolicySchema` (strict):
    - `mode: "local" | "coordinator"`, default `"local"`.
    - `coordinated?: verifyConfigSchema`: hook lists used only while bound to an active coordinator run.
    - `candidate?`:
      - `checks: checkCommandSchema[] (min 1)`
      - `covers: { prefixes: pathToken[]; files: pathToken[] }`
      - `rules: { prefixes; files; add: "all" | string[] }[]` (default `[]`)
    - `maxConcurrentExpensive: 1..8`, default 1.
  - Add `verification: verificationPolicySchema.optional()` to `coordinatorConfigSchema` and to `workspaceDeclarationSchema`.
  - Extend `coordinatorConfigSchema.superRefine`:
    - `mode: "coordinator"` requires both `coordinated` and `candidate`.
    - Every rule's `add` name exists in `checks`.
    - Names are unique within `checks` and within `candidate.checks`.
  - `startStateSchema`: add optional `verification` and optional `verificationDigest` (`digestSchema`). A `start.json` written before this change still parses and means local mode.
  - `acceptedSubmissionSchema.checkResults[]`: add optional `reused: boolean`, `joined: boolean`, `receiptId: string`, `logPath: string`, `attempts: int ≥ 1`.
  - `journalEventTypeSchema`: add `"candidate-check"`, `"verification-reused"`, `"verification-joined"`.
- `src/steps.ts`
  - Extend `CheckResult` with the same optional fields.
  - Add to `InternalOrder`:
    - optional `verificationMode?: "local" | "coordinator"`
    - optional `candidateResults?: readonly { agent: string; commitSha: string; results: readonly CheckResult[] }[]`

  Both are optional, so the existing order construction sites stay valid.
- `src/changeClassification.ts`
  - Export the evidence prefix test as `isCoordinationEvidencePath(path)`, and use it inside `classifyChanges`; behavior is unchanged.
  - Add `selectCandidateVerification(input, start)`, using `classifyChanges` with the start snapshot as policy:
    - `coordination` → `[]`.
    - `documentation` → `start.documentation.checks`.
    - `product` with `changes === null` → `start.checks` (the full gate).
    - `product` otherwise, for every path including both rename sides and skipping evidence paths:
      - A path whose bytes do not round-trip as UTF-8 → full gate.
      - A path matched by a rule (prefix `startsWith` or exact file) adds the rule's names; `"all"` → full gate.
      - A path matched by no rule and outside `covers` → full gate ("unclassified path").
      - Result: `candidate.checks`, then the added `start.checks` entries in `start.checks` order, deduplicated by name.
  - Return `{ kind, reason, inputIdentity, commands, expanded: boolean }`.
- `src/verificationLog.ts`
  - In `verificationMeasurementSchema`:
    - Widen `phase` to include `"candidate"`.
    - Replace `cacheReason: z.literal("not implemented")` with `z.string().min(1)`.
    - Add optional `attempt` (int ≥ 1), `queueWaitMs` (int ≥ 0), `logPath`, `receiptId`.
  - `verificationMeasurement()` accepts an optional `cacheReason` and defaults it to `"not cached: hook"`. Records written earlier still parse because the literal is a valid string. The ingestor still accepts only `trigger: "hook"` and non-finalization phases; `candidate` is coordinator-only and is rejected from mailboxes.
- `src/runLoop.ts`
  - `verifyFinalizationChecks`:
    - Keep `verifyFinalization`, the baseline-classified `selectVerification`, the zero-command skip record and every `this.authority(cursors)` checkpoint.
    - Replace the inline materialize/run loop with `runVerification(...)` from the new runner (`trigger: "final"`).
    - Map a failed result to the existing `rejected` outstanding text, now with ` (log: <path>)` appended.
    - Keep emitting `final-check` for every executed component, with added `receiptId`, `logPath`, `attempt` and `cacheReason` details.
    - Launch errors still throw.
  - New `verifyCandidateChecks(start, order, observation, cursors)`:
    - Runs only when all hold: `observation.status === "satisfied"`, `order.stepId` is `R4.implement` or `R6.revise`, `productPin` is defined, and `start.verification?.mode === "coordinator"`.
    - Selects with `selectCandidateVerification(inspectRangeChanges(mirror, start.baselineSha, productPin), start)` and runs with `trigger: "candidate"`.
    - Journals one `candidate-check` event: pin, classification, reason, per-command `{name, exitCode, reused, joined, receiptId, logPath}`, outcome.
    - Failure → `{ status: "rejected", outstanding: ["candidate check <name> failed with exit <n> (log: <path>)" (+ retry note)] }`.
    - Success → `checkResults` on the observation; `accept()` already persists them.
    - Called at the existing call site right after `verifyFinalizationChecks`, with `this.authority(cursors)` before and after.
    - On a restart, a cursor still in `verifying` re-reads its completion and runs this again. Only success receipts exist, so a failed candidate re-runs and fails again.
  - `buildOrder`:
    - Sets `verificationMode` from `start.verification?.mode ?? "local"`.
    - Sets `candidateResults` from `cursors.accepted` entries with `stepId` `R4.implement`/`R6.revise`, `checkResults` defined and `productPin` equal to a bound input's `commitSha`. `inputFromSubmission(..., usePin=true)` already binds implementations by `productPin`.
- `src/hookPolicy.ts`
  - New `resolveHookBinding({ clone, configPath, phase, refs })` returns `{ bound: true; issue; commands: VerifyConfig } | { bound: false; reason }`.
  - Branch source:
    - precommit: `git symbolic-ref --quiet --short HEAD`.
    - prepush: the ref lines; exactly one non-empty line, whose third field is `refs/heads/<branch>`. More than one ref → unbound, reason "multi-ref push".
  - Bound only if every check holds:
    - The branch matches `^issue-(\d+)/([a-z0-9-]+)$`, with the agent equal to `consensus.agentId`.
    - `readStartState` and `readCursorsState` succeed for `issueRuntimePaths(workspaceLocationFromConfig(configPath).workspaceRoot, n)`.
    - `start.agents` has this agent with `resolve(root) === resolve(clone)`.
    - `start.verification?.mode === "coordinator"`, and `start.verification.coordinated` is present.
    - `!cursors.completed`, `!cursors.abandoned`, and `cursors.activeRoster` includes the agent.
  - Any exception or failed check → unbound with the reason. A missing runtime never means skip.
  - `runVerifyPhase` gains an optional `bound?: VerifyConfig`. When present, product commands are `bound[phase]` and the `verifyCommands` undeclared-`verify` throw is not consulted. Documentation and evidence selection are unchanged.
  - `unresolvableCommands` also lists `verification.coordinated` and `verification.candidate.checks` executables, so `coord doctor` reports them.
- `src/cli.ts`
  - `hook-verify`: read stdin once and pass it both to `inspectOutgoingChanges` and to `resolveHookBinding`. Print `coord <phase>: coordinator-bound issue <n> — coordinated checks` or `coord <phase>: local verification — <reason>`, then pass `bound` to `runVerifyPhase`.
  - `startIssue`'s `initializeOperationalState` input: add `verification: config.verification` and `verificationDigest: sha256(JSON.stringify({ verification, checks, documentation }))`, using `src/hash.ts` `sha256`.
- `src/setupWorkspace.ts`
  - `buildWorkspaceConfig`: copy `declared.verification` into the config, one spread line like `documentation`.
- `src/action.ts`
  - `verificationSection`, coordinator mode only:
    - R4/R6 text: coord runs the declared candidate checks on the submitted product pin and returns failures with their log. Run focused tests while developing; do not run the full suite. Hooks run only the coordinated cheap checks.
    - Other git and response steps: cite coord's recorded results.
  - Local mode text is byte-identical to today.
  - New `candidateResultsSection(order.candidateResults)` renders `## Coordinator check results for the bound pins`, one line per command: `<agent> <pin>: <name> exit <n> (ran|reused|joined) log <encoded path>`. Omitted when empty.
- `src/analytics.ts`
  - Add to `deriveVerification` and `AnalyticsReport["verification"]`:
    - `byTrigger: { hook, candidate, final }`, each `{ runners, runnerMs }`. Phase `candidate` → candidate; `finalization` → final; trigger `hook` → hook.
    - `reused` / `joined` counts from the new events.
    - `avoidedMs`: the sum of the `originalDurationMs` those events carry.
    - `queueWaitMs`: the sum of measurement `queueWaitMs`.
  - Critical-path intervals start at `startedAt − queueWaitMs`.
  - Render the new lines in the text report next to the existing `Aggregate runner time` line.
- `package.json`
  - Add `"test:system": "vitest run --config vitest.system.config.ts"`.
  - `"test": "pnpm test:fast && pnpm test:system && pnpm test:e2e"`.
  - `"check": "pnpm build && pnpm check:fast && pnpm test:system && pnpm test:e2e"`.
  - `check:fast`, `check:docs` and the version are unchanged.
- `vitest.config.ts`
  - Extend `exclude` with the system files: `test/cli.test.ts`, `test/install.test.ts`, `test/workspace.test.ts`, `test/wipeIssue.test.ts`, `test/wrapper.test.ts`, `test/bootstrap.test.ts`, `test/onboard.test.ts`, `test/hookSync.test.ts`, `test/agentHookSync.test.ts`.
  - The exclude list stays a literal array, which the coverage test reads.
- `config.example.json`
  - Add `verification` with:
    - `mode: "coordinator"`
    - `coordinated: { precommit: [check:fast], prepush: [] }`
    - `candidate.checks: [install (uncached), lint, typecheck, test:fast, test:system]`. The four cached ones use `cache: { inputs: "tree-excluding-evidence", probes: [["node","--version"],["pnpm","--version"]] }`, and `test:system` is `expensive`.
    - `covers.prefixes: ["src/", "test/"]`
    - `rules`:
      - `githooks/`, `templates/`, `scripts/` → `["test:e2e"]`
      - `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `test/tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `vitest.system.config.ts`, `vitest.e2e.config.ts` → `"all"`
    - `maxConcurrentExpensive: 1`
  - Split `checks` into `install, lint, typecheck, test:fast, test:system, build, test:e2e`:
    - `build` and `install` are uncached.
    - `test:e2e` is `expensive`, with `tree-excluding-evidence` cache.
  - `verify.prepush` becomes `[test:system, test:e2e]`, so local/manual coverage does not shrink with `check:fast`.
- `docs/setup-workspace.md`
  - The `verification` declaration fields.
  - Binding rules and fail-closed fallbacks.
  - Cache metadata rules: never cache commands that read Git history, commit identity, external services or undeclared env.
  - Retry semantics.
  - Rollout: add `test:system` to the live `verify.prepush` before relying on the new `check:fast`; switch `mode` only between issues.
- `docs/coord-driver.md`
  - The candidate gate, the reissue-on-failure path, finalization reuse, receipt keys, trust, storage, joins, the expensive-command limiter and restart behavior.
- `docs/analytics.md`
  - The new `verification` fields.
- `AGENTS.md`
  - One clause in "Checks that actually run": in a coordinator-mode run, coord owns the candidate and final suites, and agents cite coord's recorded results instead of re-running them.
  - The phrases asserted by `test/verify-config.test.ts` stay intact.
- `templates/product/AGENTS.protocol.md`
  - The same clause, in its checks section.
- `test/runLoop.test.ts`, `test/hookSync.test.ts`, `test/verify-config.test.ts`, `test/state.test.ts`, `test/action.test.ts`, `test/analytics.test.ts`: extended as listed under Tests.

## Exact file list to be created

- `src/verificationReceipts.ts`: receipt keys and the store.
- `src/verificationRunner.ts`: the runner shared by the candidate and final gates.
- `vitest.system.config.ts`: the `test:system` suite. It uses the same `testTimeout: 15_000` and `setupFiles: ["./test/support/yieldEventLoop.ts"]` as `vitest.config.ts`, and its `include` is the nine system files listed above.
- `test/verificationRunner.test.ts`: tests for both new modules.

## Reuse and Scope

Reused unchanged:

- From `src/changeClassification.ts`: `classifyChanges`, `selectVerification`, `inspectRangeChanges`, `inspectStagedChanges` and `inspectOutgoingChanges`.
- From `src/verificationLog.ts`: `verificationMeasurement` and the `verification-run` event.
- From `src/runLoop.ts`:
  - `ProcessRunner` and `runArgv`, so tests inject fake runners exactly as the finalization tests at `test/runLoop.test.ts:2570–2630` do.
  - The `processRunner` dependency and the `this.authority(cursors)` checkpoints.
  - `containedPath(this.paths.issueRoot, ".verification-<uuid>")` worktrees, via `mirror.materializeWorktree` / `removeWorktree`.
- From `src/machine.ts`: the `rejected → reissue-action` path.
- `accept()` already persists `checkResults` into `acceptedSubmissionSchema`.
- From `src/runLoop.ts`: `inputFromSubmission(..., usePin)` and `deriveBoundInputs`.
- From `src/state.ts`: `atomicWriteJson`, `appendJournal`, `readStartState`, `readCursorsState`, `pathTokenSchema` and `digestSchema`.
- From `src/paths.ts`: `assertNoSymlink`, `containedPath` and `issueRuntimePaths`.
- From `src/workspace.ts`: `workspaceLocationFromConfig`.
- From `src/gitExec.ts`: `git`, which the receipts module uses for the mirror's `rev-parse <pin>^{tree}` and `ls-tree -r -z --full-tree <pin>`, and `localConfigGet`.
- From `src/hash.ts`: `sha256`.
- Test fixtures: `test/runLoop.test.ts`'s `fixture()`, `BareMirror` and seeded bare-mirror pattern; `test/support/workspaceFixture.js`'s `makeProduct`, `git` and `repoRoot`; and the existing `hookSync.test.ts` agent-clone setup.

`src/verificationReceipts.ts` is a new file because receipt keying and trust are a separate concern from the run loop. `runLoop.ts` already has 2989 lines, and the hook path must never import receipt reads. It contains:

- `computeInputIdentity(mirrorPath, pin, mode)`:
  - `tree` → `tree:<treeId>`.
  - `tree-excluding-evidence` → `sha256` over the raw `ls-tree -z` records whose path is not `isCoordinationEvidencePath`. A path that does not round-trip as UTF-8 is kept, which is conservative.
- `receiptKey(material)`: `sha256` of a fixed-key-order JSON of `{v:1, origin, inputsMode, inputIdentity, argv (declared), policyDigest, platform, arch, node, probes:[{argv, stdout}], env:[{name, value|null}]}`.
- `readReceipt(coordRoot, key)`:
  - Schema-validated; the stored key material must hash back to the key, and `exitCode` must be 0.
  - Any error is a miss with a reason; it is never a pass.
- `writeReceipt` via `atomicWriteJson`, at `<coordRoot>/verification/receipts/<key>.json`.
- `acquireLock(path)` / `releaseLock`:
  - An `openSync(…, "wx")` lock file holding `{pid, hostname, startedAt}`.
  - The lock is stale when the hostname matches and `process.kill(pid, 0)` throws `ESRCH`, or when it is older than 6 h.

`src/verificationRunner.ts` is a new file because one implementation serves both the candidate and the final gates. `runVerification({ paths, start, mirror, processRunner, now, checkpoint, journal, trigger, phase, pin, selection, environment? })`:

1. Materializes one worktree when the selection has commands, and runs the probes there. `pnpm --version` depends on the worktree's `packageManager`.
2. For each command in declared order:
   - **Uncached** (no `cache`, no `start.verificationDigest`, or a failed probe): run it, write no receipt, and record the reason.
   - **Receipt hit:** journal `verification-reused` (with `originalDurationMs`) and push `{exitCode: 0, reused: true, receiptId}`.
   - **Otherwise:**
     1. Take the per-key lock `<coordRoot>/verification/running/<key>.lock`.
     2. If a live owner holds it, poll every 1 s, calling `checkpoint()` between polls. When it is released, re-read the receipt. A hit is journaled as `verification-joined`. A miss means the run was interrupted or failed, so take the lock and run.
     3. Then take an `expensive` slot (`<coordRoot>/verification/slots/<i>.lock`, `i < maxConcurrentExpensive`) and record `queueWaitMs`.
     4. Run the command, and write stdout and stderr to `<issueRoot>/verification-logs/<measurementId>.log`.
     5. Journal `verification-run` with `phase`, `attempt`, `logPath` and `cacheReason`.
     6. On exit 0 with a cache-eligible key, write the receipt.
     7. On non-zero exit with `retry > 0`, re-run up to `retry` more times and journal each attempt. The outcome stays the **original failure**; the note says whether the retry passed. No receipt is written.
3. Stops at the first failure.
4. Always releases its locks and removes the worktree, in a `finally` block.
5. Launch errors propagate.

It returns `{ ok, results: CheckResult[], failed? }`. There is no in-process promise map: the tick evaluates submissions serially, so the only real concurrency is across issue runners, which the per-key lock covers.

`vitest.system.config.ts` is a new file because the issue requires separating cheap unit tests from filesystem/process suites while keeping both in `pnpm check`.

`test/verificationRunner.test.ts` is one new file, not two, because the runner is the only consumer of the receipts module and no existing test file covers either one.

Hooks never read or write receipts. Clone state and agent signals are never treated as results.

## Tests

Every case below fails at the baseline, because the symbol, field, script or behavior does not exist yet, and passes after the change.

`test/verificationRunner.test.ts` (new):
- The receipt key changes when any one of these changes: tree, declared argv, policy digest, injected platform/arch/node, a probe's stdout, or a declared env value. An evidence-only difference (`.signals/…`) leaves the key unchanged under `tree-excluding-evidence` and changes it under `tree`.
- A failed command writes no receipt. A corrupt receipt, or one whose key material does not hash to its file name, reads as a miss with a reason.
- A per-key lock held by a live foreign pid makes the second request wait. After the owner writes a receipt and releases the lock, the waiter journals `verification-joined`, and the process runner is called once in total. A lock whose pid is dead is treated as stale: the command runs, and it is never counted as success.
- With `maxConcurrentExpensive: 1`, two concurrent `runVerification` calls on `expensive` commands never overlap; the fake runner records peak concurrency 1. The second records `queueWaitMs > 0`.
- With `retry: 1` and a runner that fails and then passes, the outcome is failed. Two `verification-run` attempts are journaled with the original exit code, and no receipt exists.

`test/runLoop.test.ts`, in the existing finalization-check `describe`, using the same seeded `BareMirror` and fake `processRunner`:
- **Candidate gate.** A coordinator-mode `start.json` and an `R4.implement` observation with a `productPin`:
  - A failing `test:fast` gives `rejected`, with outstanding naming the command and an existing log path containing the stderr. A `candidate-check` event records the failure, and `decide()` returns `reissue-action`.
  - A passing run gives `satisfied` with `checkResults`.
  - A new `CoordinatorRunLoop` (restart) re-evaluating the failed pin runs the command again and is still `rejected`.
- **Local mode is unchanged.** The same observation with no `verification` in `start.json` never calls `processRunner`.
- **Shared execution.** A second `R6.revise` pin whose tree differs only by `.signals/` evidence calls `processRunner` zero times for its cached commands and journals `verification-reused`.
- **Finalization reuse.** Finalization then runs only the uncached or missing components (`install`, `build`, `test:e2e`). With a fresh coord root (no receipts) it runs every component of `start.checks`.
- **Shared reviewer results.** `buildOrder` for `R5.compare` renders each bound pin's candidate results, so every reviewer receives one execution's results.

`test/hookSync.test.ts` (real hooks), in `declared verification in the hooks`:
- With an initialized coordinator-mode issue runtime (`initializeOperationalState`) for the clone's `issue-<n>/<agent>` branch, a commit runs the `coordinated.precommit` marker command, not `verify.precommit`.
- The same commit falls back to the local list and prints the reason when:
  - `cursors.json` is corrupt
  - the issue is completed
  - the branch is a manual `<agent>/<name>` branch
- A two-ref push runs the local `verify.prepush`.
- A bound push to a peer branch is still blocked by the ownership gate.

`test/verify-config.test.ts`:
- `shared change classification`: `selectCandidateVerification` returns:
  - README only → the docs checks
  - `src/x.ts` → `candidate.checks`
  - `githooks/pre-push` → `candidate.checks` + `test:e2e`
  - `pnpm-lock.yaml` → full `start.checks`
  - an unlisted `tools/x` path → full `start.checks`
  - a rename from `src/a.ts` to `githooks/a` → adds `test:e2e`
  - a non-UTF-8 path or `changes: null` → full `start.checks`
- `shipped examples`:
  - The coordinator-mode `config.example.json` parses.
  - Its `checks` names, minus `install`, equal the components that `package.json` `check` expands to (`build`, `lint`, `typecheck`, `test:fast`, `test:system`, `test:e2e`).
  - Every `test/**/*.test.ts` file matches exactly one of the three vitest configs' include/exclude sets, checked with `path.matchesGlob`.
- `workspace declaration`: a declaration with `verification` survives `buildWorkspaceConfig`. A rule naming an undeclared check, or `mode: "coordinator"` without `candidate`, is refused.

`test/state.test.ts`, in `operational state`: a `start.json` without `verification`/`verificationDigest` still parses (local mode), and one with them round-trips through `initializeOperationalState`.

`test/action.test.ts`:
- A coordinator-mode R4 action contains the candidate-check instruction.
- A local-mode action's verification section is byte-identical to today's.
- `candidateResults` render under `## Coordinator check results for the bound pins` with encoded log paths.

`test/analytics.test.ts`: a journal with hook, candidate and final `verification-run` rows plus `verification-reused` and `verification-joined` reports correct `byTrigger`, `reused`, `joined`, `avoidedMs` and `queueWaitMs`, and a critical-path wait that includes queue time.

Commands:
- During development: `pnpm vitest run --config vitest.config.ts test/verificationRunner.test.ts test/runLoop.test.ts test/verify-config.test.ts test/state.test.ts test/action.test.ts test/analytics.test.ts` and `pnpm vitest run --config vitest.system.config.ts test/hookSync.test.ts`.
- The pre-commit hook runs `pnpm check:fast`.
- Before submitting the pin: `pnpm test:system` and `pnpm check`.
- Coordinator final checks are not claimed here.

## Alternatives Rejected

- **Editing `githooks/lib/policy.sh` and `pre-push` to pass `--ref`** (owner map). The buffered stdin already reaches `hook-verify` with the remote ref in field 3. Changing hook bodies forces a resync in every installed clone (hook drift and attestation), and the protocol forbids editing `githooks/` to satisfy checks. It adds risk for no information gain.
- **Rendering candidate results in `src/orderScaffold.ts`.** Scaffolds are JSON that agents author and copy back. Coordinator results must never round-trip through agent-authored artifacts, because an agent-authored "tests passed" is untrusted.
- **Routing candidate failures through `retry-verification`.** It sets the cursor to `intent` and silently re-evaluates the same completion, so the agent never learns which command failed. `rejected → reissue-action` delivers the command and the log.
- **Emptying both `verify` arrays.** The issue rejects this: it also changes manual behavior and provides no candidate gate.
- **An in-process join map.** Submissions are verified serially within a tick. The cross-process per-key lock plus a receipt re-read covers the real concurrency (multiple issue runners and restarts).
- **Keying receipts on the commit SHA or the executed argv.** A commit SHA changes on evidence-only commits, and the executed argv embeds a random worktree path. A tree id or an evidence-excluded `ls-tree` digest plus the declared argv is exact and reusable.
- **Import-graph test selection.** The issue notes it misses files read through filesystem APIs. Explicit path rules with fail-closed `covers` expansion are used instead.
- **Letting a passing retry turn the gate green.** The issue forbids it. A retry is diagnostic only.
- **Two new test files.** The receipts module has a single consumer; one file keeps the fixtures shared.
- **Changing `src/install.ts`.** Schema parsing already flows through it.

## Risks and Mitigations

- **Local and manual coverage shrinks when `check:fast` drops the system suites.** `pnpm check` (final acceptance) still includes `test:system`. `config.example.json` and the setup docs move `test:system` into `verify.prepush`, and the rollout note tells the owner to update the live config. The verify-config test proves every test file is in exactly one suite.
- **An absent or broken runtime could silently skip tests.** Every binding failure falls back to the local lists and prints why. hookSync tests cover a corrupt runtime, a completed issue, a manual branch and a multi-ref push.
- **A mid-issue `coord install` could flip modes.** The policy and its digest are snapshotted into `start.json`; hooks and gates read the snapshot. Older `start.json` files mean local mode, so the issue running now is unaffected.
- **Stale receipts or locks after a crash.** Only exit-0 runs from a coordinator-materialized worktree write receipts. A dead-pid or over-age lock is stale, and the waiter re-reads the receipt and otherwise runs the command itself. Interrupted runs never count as success.
- **Undeclared inputs (registry, pnpm store, services).** `install` and `build` are uncached and always run. Probes capture the node/pnpm versions, and the lockfile is in the tree. The docs require commands that use history, services or undeclared env to stay uncached. Any key component that cannot be computed makes the command uncached.
- **Receipt tampering.** Receipts are stored only under the coordinator root, never read from clones, schema-validated, and their key material is recomputed on read. This is the same trust boundary as `start.json` and `cursors.json` today.
- **Queueing delays feedback.** `maxConcurrentExpensive` is declared; queue wait is journaled and counted in the critical path. Agents keep focused tests.
- **`AGENTS.md` is skip-worktree in agent clones.** If staging the clause is refused, I will escalate rather than clear the bit; #162 changed this file through the normal path.
- **`runLoop.ts` growth.** Execution, receipts and locking live in the two new modules; `runLoop.ts` only selects, calls and maps results.

## Conclusion

The change adds an opt-in `verification` mode that is snapshotted per issue:

- Hooks bind to the coordinated cheap lists only for a provably active coordinator run, and otherwise fail closed to the local lists.
- Coord verifies each implementation or revision pin once through a shared runner. Failures go back to the agent with the command and its log.
- Successful per-component receipts, keyed on tree, declared argv, policy, toolchain probes and env, let finalization and later candidates skip only work proven equivalent.
- `test:fast` is split from a new `test:system` suite, and `pnpm check` keeps full coverage.

It reuses #162's classifier and measurement boundary. It leaves the hook bodies, `orderScaffold.ts`, `install.ts`, manual-branch behavior and every integrity gate unchanged. It adds four files: two modules, one vitest config and one test file.
