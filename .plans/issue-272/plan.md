# Plan — issue 272: project toolchain for checks, bounded failure diagnostics, baseline retry

Issue 272 merges #266, #270 and #271. All three behaviours live on one path:
`runVerification` in `src/verificationRunner.ts` runs every coordinator check
(candidate and finalization), and `verifyFinalizationChecks` in `src/runLoop.ts`
turns a finalization failure into the agent's correction. The plan changes that
path and nothing upstream of it.

Facts this plan relies on (verified in the tree at the baseline):

- The coordinator's own Node comes from scripts/lib/node-runtime.sh, which
  deliberately never changes PATH for product subprocesses. `runVerification`
  calls `processRunner(argv, target)` with no options, so `runArgv` spawns
  every check with the coordinator's inherited process environment. When an
  older Node comes first on that PATH, every `node` that pnpm spawns is the older
  one. This is the #266 failure.
- The agent launcher (launcher_environment in scripts/lib/launcher.sh) already
  defines the project's Node: when the clone has an .nvmrc file it sources nvm
  and runs `nvm use`, and fails if it cannot. This repository pins 26.12.1 there.
  Checks should use the same source of truth.
- The receipt key records environment.node, which defaults to the
  coordinator's own Node version rather than the Node the check actually ran
  under.
- A failed run returns only `stderr`. `verifyFinalizationChecks` puts the whole
  of `checked.stderr.trim()` into the outstanding item. Stdout is dropped and
  nothing is bounded, so `compiler error A` on stdout followed by `build failed`
  on stderr shows only `build failed` (#270).
- Every finalization failure becomes a `rejected` observation and is reissued
  to the agent. That includes failures the candidate cannot cause, such as a
  missing tool that the frozen baseline needs too (#271).
- Owner questions (`ownerQuestion`, `applyOwnerAnswer`, `coord answer`, the
  interactive menu) and the `retry` observation status with its
  `retry-verification` decision already exist. The retry status keeps the
  submission and re-evaluates it on a later tick. Publication starts only from
  an accepted R7 submission (`publishAcceptedFinalization`), so anything that
  stays unaccepted cannot publish.

## Exact File List to be changed or deleted

- `src/verificationRunner.ts`
  1. **Project toolchain.** Add an exported
     `resolveProjectToolchain(worktree, env, processRunner)`.
     - If the worktree has no regular .nvmrc file, it returns `null` and the
       inherited environment is kept unchanged (non-Node products).
     - Otherwise it runs, through `processRunner` with cwd set to the worktree
       and `{ env }`, a fixed bash argv. That argv sets NVM_DIR (defaulting to
       HOME/.nvm), exits 3 with a clear message when nvm's script is missing,
       sources nvm with `--no-use`, and runs `nvm which` with no argument, so nvm
       itself reads the pin exactly as `nvm use` does in the launcher.
     - The last non-blank stdout line must be an absolute path whose basename is
       `node`. That binary's `--version` output must then match
       `^v\d+\.\d+\.\d+$`.
     - It returns `{ nodePath, version }`. Any other outcome throws an Error
       that names the pinned value, the nvm output excerpt and the remedy
       (install that version with nvm). This follows the existing rule there
       that a coordinator launch failure is not a rejected agent submission.
  2. **Effective environment.** In `runVerification`, after the worktree is
     materialized and found clean, compute one effective environment.
     - Start from the base `environment` (input or process default).
     - Unless `input.resolveToolchain === false`, apply the resolved toolchain:
       PATH becomes the directory of `nodePath` + the path delimiter + the
       inherited PATH, and `node` becomes the resolved `version`.
     - Pass `{ env: effective.env }` to every `processRunner` call: probes and
       commands.
     - Use the effective `platform`/`arch`/`node`/`env` for the receipt
       `keyFor` material, so receipts record the Node the check actually ran
       under.
  3. **Result fields.** Add `stdout: string` and
     `environment: VerificationEnvironment` (the effective one) to the `failed`
     variant of `RunVerificationResult`. Fill them in both failure returns: the
     probe-modified early return uses an empty stdout, and the command failure
     uses first.stdout. That means keeping result.stdout in the `original`
     record. Name the inline environment type `VerificationEnvironment`, exported.
  4. **Diagnostics.** Add two exported pure helpers over a run's stdout and
     stderr.
     - `actionableDiagnostics(stdout, stderr)` returns normalized diagnostic
       lines in output order, capped at 50.
       - Normalization strips ANSI and CR, rewrites any
         `.verification-<uuid>` worktree segment to a fixed placeholder, rewrites
         durations and ISO timestamps to placeholders, and collapses whitespace.
       - A line is actionable when it matches a diagnostic keyword pattern and is
         not a generic failure line. The keyword pattern is case-insensitive
         (error, fatal, exception, panic, traceback, assert, cannot, unable,
         denied, missing, not found, no such, undefined, unresolved, invalid,
         unexpected, word-bounded FAIL), plus case-sensitive Node error codes
         such as ENOENT.
       - A generic failure line is at most one word followed by failed, failure
         or error (`build failed`, `test failed`, `failed`), any
         `command failed with exit code N`, `exited with code N`, an ELIFECYCLE
         line, or a bare `exit N`.
     - `failureExcerpt(stdout, stderr)` returns a bounded excerpt: at most 12
       lines, each at most 300 characters, and 2,000 characters in total.
       - It holds the actionable lines, each prefixed with its stream
         (`[stdout]` / `[stderr]`).
       - When there are none, it falls back to the last non-blank lines of
         stderr, or of stdout when stderr is blank.
       - Diagnostics that come before progress output survive, because selection
         is by kind, not by tail position.
     - `sameActionableFailure(a, b)` is true only when both lists are non-empty
       and identical. A shared exit code or generic line alone never matches,
       because neither is actionable.
  5. **Phase.** Widen `phase` to `"candidate" | "finalization" | "baseline"`.
     The `final-check` journal stays `finalization`-only, so baseline runs never
     look like final checks. Add `resolveToolchain?: boolean` (default true) to
     `RunVerificationInput`.

- `src/verificationLog.ts`: add `"baseline"` to the `phase` enum of
  `verificationMeasurementSchema`. The coordinator journals baseline
  measurements; hook ingestion already rejects any phase other than precommit
  and prepush.

- `src/runLoop.ts`
  1. **Outstanding message.** In `verifyFinalizationChecks`, the outstanding
     text becomes:
     `finalization check (tier: checks) ${failure}: ${failureExcerpt(stdout, stderr)} (log: ${logPath})`
     with the existing note suffix. The `(log: …)` shape that tests and agents
     parse is unchanged, and the full log already holds both streams.
  2. **Baseline comparison.** Before rejecting, when the failed command exited
     non-zero, did not modify tracked files, and
     `actionableDiagnostics(stdout, stderr)` is non-empty, run the baseline:
     - Call `runGateVerification` with phase `"baseline"` and pin set to the
       frozen `baselineSha`.
     - Its commands are the selected list up to and including the failed
       command, each with its `cache` declaration removed, so the run really
       executes and never reuses or writes a receipt.
     - It uses the same classification, and passes
       `environment: checked.environment` with `resolveToolchain: false`. That
       gives the same Node and PATH as the approved candidate, even if the
       candidate changed the pin.
     - Thread `environment` and `resolveToolchain` through `runGateVerification`
       as optional parameters.
  3. **Routing.**
     - The baseline failed on the same command name and `sameActionableFailure`
       holds: return `status: "retry"` with an outstanding line naming the
       evidence, plus a new `baselineFailure` field holding
       `{ command, pin, baselineSha, excerpt, candidateLog, baselineLog }`.
     - The baseline passed, failed on another command, failed differently, or is
       `waiting`: return the normal `rejected` observation. Its outstanding item
       gains `; the frozen baseline <short sha> passes this check` or
       `; the frozen baseline fails differently (log: …)`.
     - A baseline launch error propagates like any coordinator launch error.
  4. **Tick.** In `runTick`, skip evaluating a SHA completion with `continue`
     while `cursors.ownerQuestion?.kind === "baseline-check-failure"` and the
     cursor's step is R7.finalize. Checks are then not rerun every tick while
     the owner fixes the environment. The completion marker and the `intent`
     cursor stay in place, so once the question is answered, the next tick
     re-verifies the same final SHA, and publication follows only an accepted,
     verified submission.
  5. **Owner question.** In `applyDecisions`'s `owner-action-required` branch,
     copy decision.evidence into the stored question and the `owner-question`
     journal details when present.

- `src/steps.ts`
  - Add an exported `BaselineFailureEvidence` type.
  - Add an optional `baselineFailure` to `EvidenceObservation`.
  - Widen the `owner-action-required` decision's `kind` to include
    `"baseline-check-failure"` and give it an optional `evidence`.

- `src/machine.ts`
  - In the observation loop, a `retry` observation that carries
    `baselineFailure` emits `retry-verification` as today. When no question is
    outstanding, it also emits `owner-action-required`:
    - `kind: "baseline-check-failure"`.
    - `allowedAnswers: ["retry", "abandon"]`.
    - `round` set to the consensus round, or 1. This satisfies the existing
      positive-integer schema. Round has no meaning for this kind.
    - `evidence`.
    - A reason that names the command, both SHAs, the excerpt and both logs,
      and says to fix the shared cause and then answer retry to re-verify the
      same SHA before publication.
  - The existing outstanding-question branch builds that same reason from the
    stored evidence for this kind. Other kinds keep
    `${kind} at revision round ${round}`.

- `src/state.ts`: in `cursorsStateSchema`'s `ownerQuestion`, add
  `"baseline-check-failure"` to `kind` and an optional strict `evidence` object.
  The object's fields are command, pin and baselineSha (as `gitShaSchema`),
  excerpt, candidateLog and baselineLog. Both changes are additive, so existing
  runtime state still parses and `RUNTIME_FORMAT_VERSION` stays the same.

- `src/ownerControls.ts`: in `applyOwnerAnswer`, a `baseline-check-failure`
  question is handled before the revision-round rules.
  - `retry` clears `ownerQuestion`, records `lastOwnerAnswer`, journals
    `owner-answer`, and leaves the cursor, roster, accepted evidence and step
    unchanged.
  - `abandon` uses the existing abandon path.
  - The existing active-hold and allowed-answer guards still apply. Without
    this branch, retry would wrongly reset the issue to R6.ballot, or be refused
    at round 3.

- `docs/coord-driver.md`: one paragraph under "Coordinator-owned verification"
  covering three things. Checks run with the Node pinned by the product's .nvmrc
  through nvm, propagated on PATH to children, and that Node is the one in the
  receipt key. Final failures show a bounded excerpt plus the log. A final
  failure that the baseline reproduces with the same actionable diagnostic
  becomes an owner question to answer with retry or abandon.

- `test/verificationRunner.test.ts` and `test/runLoop.test.ts`: the new cases
  under Tests.

## Exact file list to be created

None. Every change extends an existing module and its existing test file.

## Reuse and Scope

Reused, not reimplemented:

- `runVerification`: the baseline is a second call, reusing its worktree
  materialization, locks, expensive-slot queue, log writing, measurements and
  cleanup.
- `runGateVerification`, `selectVerification` and `addCheckCommands`: these
  produce the command list the baseline prefix is taken from.
- `ProcessRunner`/`runArgv`'s existing `env` option, so no spawn code changes.
- nvm's own `nvm which`. The launcher already depends on it, so this reuses the
  launcher's source of truth for the project's Node, and the .nvmrc format is
  not reimplemented.
- The `retry` observation status and the `retry-verification` decision, which
  keep the submission pending.
- The owner-question machinery, unchanged apart from one kind: `ownerQuestion`,
  the `owner-question` and `owner-answer` journal events, `applyOwnerAnswer`,
  `coord answer` in the CLI, and the interactive menu (which already renders any
  kind and its `allowedAnswers`).
- `publishAcceptedFinalization`, which already publishes only accepted,
  verified finalization.
- Test fixtures: the `setup()` helper, the `environment` constant and `ok` in
  `test/verificationRunner.test.ts`; `gateFixture` (its seed has distinct
  baseline, consensus and final SHAs, and a processRunner that sees each
  worktree), `seedPendingPublication`, `buildOrder` and `applyOwnerAnswer` in
  `test/runLoop.test.ts`.

Out of scope:

- Hook-run checks. The agent launcher already selects the project's Node via
  `nvm use` before the harness starts.
- Candidate-phase baseline comparison. The issue limits it to the approved
  candidate's final checks. Candidate failures still route to the agent, but they
  do run under the project toolchain, because that change is in the shared
  runner.
- pnpm version selection. pnpm itself honours the product's packageManager
  field, and the pnpm found first on the new PATH belongs to the selected Node.
- Analytics. A `baseline` measurement appears under its own key in `byPhase` and
  in the final trigger bucket, which is accurate.

No new file, dependency or abstraction is added.

## Tests

Every case fails before the change and passes after it. All cases join existing
files.

`test/verificationRunner.test.ts`, inside the existing "verification runner"
describe:

1. **Toolchain propagation** ((an it-each over "candidate", "finalization")): a pnpm
   child sees the project Node while an older Node is first on PATH.
   - Seed setup: `setup()` with an .nvmrc of 26.99.0 committed.
   - A temporary directory holds:
     - an old `node` script that prints v23.0.0, placed first on PATH;
     - a fake NVM_DIR whose nvm script defines an `nvm` function printing
       NVM_DIR/versions/node/v26.99.0/bin/node, plus that `node` script, which
       prints v26.99.0;
     - a `pnpm` script that runs `node --version`, which stands in for pnpm
       launching a script child that resolves `node` from PATH.
   - Run `["pnpm", "run", "check"]` through the real `runArgv`, with
     environment.env carrying that PATH and NVM_DIR and `phase` set per case.
   - Assert that the command's log contains v26.99.0 and not v23.0.0. Before
     the change the log shows v23.0.0, because the command env is not passed.
   - Also assert that a missing nvm script makes `runVerification` reject with
     the remedy message, and that no worktree directory is left behind.
2. **Bounded excerpt** (#270): a check exits 1 with stdout `compiler error A`
   followed by 5,000 `progress N%` lines, and stderr `build failed`.
   - result.stdout is returned.
   - `failureExcerpt(result.stdout, result.stderr)` contains `compiler error A`
     and is at most 2,000 characters.
   - The log file contains `compiler error A`, `progress 4999%` and
     `build failed`.
   - `actionableDiagnostics` is empty for stdout `progress` with stderr
     `build failed`, and also for stderr `test failed`.
   - `sameActionableFailure` is false for `compiler error A` against
     `compiler error B`, and true for the same `sh: protoc: command not found` in
     two different `.verification-<uuid>` worktrees.

`test/runLoop.test.ts`, beside the existing finalization `gateFixture` cases.
These use a processRunner that tells baseline from final by reading the
worktree's src/a.ts.

3. **Same unavailable tool** (#271 retry path):
   - Both worktrees exit 127 on `build` with stderr
     `sh: protoc: command not found`.
   - `verifyFinalizationChecks` returns `status: "retry"`, and its
     `baselineFailure` names `build`, the final SHA and the baseline SHA.
   - After `runTick` on a seeded R7 cursor and completion:
     - ownerQuestion.kind is `baseline-check-failure`, with
       `allowedAnswers` set to retry and abandon;
     - the log contains the excerpt and both log paths;
     - nothing was pushed or opened.
   - A second `runTick` runs no check (no new calls) and publishes nothing.
   - Restore the tool (the runner passes), then call
     `applyOwnerAnswer(paths, id, "retry")`. The cursor step is still
     R7.finalize.
   - The next `runTick` reruns verification on the same final SHA and only then
     accepts it and publishes once.
4. **Correction routing** (parameterized): a passing baseline, and a baseline that
   emits `compiler error B` while the final SHA emits `compiler error A`.
   - Both failures share exit 1 and stderr `build failed`.
   - Each returns `status: "rejected"`, and its outstanding item contains
     `compiler error A`, the `(log: …)` path, and the baseline note.
   - `ownerQuestion` stays null.
   - The baseline measurement is journaled with phase `baseline`, and no extra
     `final-check` event is written.

Existing finalization tests whose failures print only generic or
non-diagnostic text (`failed`, `test failed`, `lint broke`) keep their current
call counts and `rejected` outcome, because no baseline run is triggered. The
implementer runs the affected files while developing:
`pnpm vitest run --config vitest.config.ts test/verificationRunner.test.ts test/runLoop.test.ts`.
The commit hook then runs the declared `pnpm check:fast`, and the coordinator
runs `pnpm check` at the pin.

## Alternatives Rejected

- **Prepend the coordinator's own Node directory to PATH.** That Node is the
  coordination runtime (at least 26), not the product's pin. A product pinning
  another Node would then be verified under the wrong one. node-runtime.sh
  documents that it must not choose the product's Node.
- **Parse .nvmrc and look up NVM_DIR/versions ourselves.** That reimplements
  nvm's alias and partial-version rules (`lts/*`, `26`) and can disagree with
  the launcher's `nvm use`. Asking nvm keeps one source of truth.
- **Resolve the toolchain separately inside the baseline run.** If the issue
  changes .nvmrc, the baseline would run under a different Node, which breaks
  "same toolchain and environment as the approved candidate". The candidate's
  effective environment is passed through instead.
- **Treat an unresolvable pinned Node as a failed check.** On candidate pins
  that would reject agents for a coordinator environment fault. Throwing matches
  the existing launch-failure contract and the launcher's fatal handling.
- **Match on exit code, the tail of stderr, or whole-log equality.** Exit codes
  and generic lines are explicitly insufficient. Whole logs differ by worktree
  path, timing and progress noise. Normalized actionable lines are the narrowest
  evidence that both runs hit the same problem.
- **Reuse baseline receipts.** A success receipt recorded before a tool vanished
  would make the baseline look passing and misroute the candidate. The baseline
  always executes, uncached.
- **Represent the owner wait as a hold.** Holds are per-agent delivery and
  vendor states with a different release path. The owner-question flow already
  provides evidence display, validated answers, retry and abandon.
- **Reissue to the agent with a note.** The agent cannot install a tool or fix
  the owner's machine, and the issue requires owner retry of the same SHA.

## Risks and Mitigations

- **A heuristic false match sends a real candidate bug to the owner instead of
  the agent.** A match needs non-empty, identical, normalized actionable lines
  from the same failed command at both SHAs. A candidate-introduced error
  produces a line the baseline lacks. Even on a false match, the retry
  re-verifies before publication, so nothing unverified ships. The owner can
  also abandon.
- **Missed matches leave environment failures on the agent path.** This is
  today's behaviour. The excerpt and the baseline note in the outstanding item
  still give the agent and the owner the evidence.
- **Extra cost.** The baseline runs only for finalization failures with an
  actionable diagnostic, and only the command prefix up to the failure, under
  the existing expensive-slot limit.
- **Re-verification loop while waiting.** `runTick` skips the R7 completion
  while a `baseline-check-failure` question is outstanding, and test 3 asserts
  that the second tick makes no calls.
- **Receipt keys change for Node products.** Earlier receipts keyed on the
  coordinator's Node simply miss, and the commands run once more. That is
  correct, because those receipts described a different Node.
- **The real nvm prints extra lines** (`Found … with version <…>`). Only the
  last non-blank line is used, and it must be an absolute path to an executable
  `node` whose version parses. Anything else throws with nvm's output.
- **State compatibility.** The schema changes are additive: an enum value and
  an optional field. Old cursors parse, and the format version does not change.
- **Existing tests.** Their failure strings are generic or non-diagnostic, so
  their outcomes and call counts stay the same. The implementer runs both test
  files before committing, and the hook runs `pnpm check:fast`.

## Conclusion

Check toolchain:

- Resolve the product's Node once per verification worktree, the same way the
  launcher does (.nvmrc through nvm).
- Put it first on PATH for every check and probe in both coordinator phases, so
  pnpm's children inherit it.
- Record it in receipt keys.

Final check failures:

- Show a bounded excerpt that keeps the actionable lines from both streams,
  next to the full-log path.
- Rerun the failed command prefix, uncached, at the frozen baseline under the
  candidate's exact environment.
- An identical actionable failure becomes an owner question that holds the
  evidence. A retry answer re-verifies the same final SHA before publication.
- A passing baseline, or a different failure, goes through the normal
  correction path.

The change touches seven source modules, one doc and two existing test files,
and adds no new files.
