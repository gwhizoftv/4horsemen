# Plan Review — Issue 272

Reviewed bound peer plans:
- **codex** (`f3c1cdcb1b4c7fe3349255dea5ceeac8aa8897b2`)
- **claude** (`4cb22ad81efae1a6f6bee01c8682288ab6eeb728`)

## Findings

### Codex plan (`f3c1cdcb1b4c7fe3349255dea5ceeac8aa8897b2`)

1. **Plan claim / section:** `Reuse and Scope` ("For a Node project without an explicit pin, propagate the selected coordinator Node directory as the fallback for its checks.")
   - **Rule that must hold:** Checks must run with the *project's* intended tool versions, not coordination's own runtime (`>=26`), when the project targets an older Node version (see `scripts/lib/node-runtime.sh:2` and `docs/setup-workspace.md:59-65`).
   - **Concrete failure:** On a Node project that has no `.nvmrc` (for example, a repo declaring `"engines": { "node": "20.x" }` or relying on Node 20 on `PATH` while the operator runs `COORD_NODE=/path/to/node26/bin/node coord ...`), prepending coordination's Node 26 directory to `PATH` silently executes checks under Node 26 instead of the project's Node 20 and ignores `package.json` `engines.node` and `.node-version`.
   - **Smallest correction:** Only override `PATH` when the project declares a Node requirement (`.nvmrc`, `.node-version`, or `package.json` `engines.node`), resolving a Node that satisfies that declaration rather than falling back to coordination's Node `>=26`.

2. **Plan claim / section:** `Exact File List to be changed or deleted` and `Reuse and Scope` ("Keep its evidence identified as baseline-only, separate from successful candidate/final receipts and final-check totals." / "Adapt existing assertions counting verification runs to distinguish baseline diagnostics from gate attempts.")
   - **Rule that must hold:** Every file required to persist or validate a new measurement phase or journal event type must be declared in the plan's exact file map; `verificationMeasurementSchema` in `src/verificationLog.ts:14` strictly restricts `phase` to `z.enum(["precommit", "prepush", "candidate", "finalization"])`.
   - **Concrete failure:** Because `src/verificationLog.ts` is omitted from the file list, `runVerification` cannot record a `"baseline"` measurement phase without failing Zod validation in `verificationMeasurementSchema`; conversely, recording baseline runs under `phase: "finalization"` leaves them indistinguishable from candidate finalization runs in `verification-run` journal records.
   - **Smallest correction:** Add `src/verificationLog.ts` to the file map to widen `verificationMeasurementSchema`'s `phase` enum to include `"baseline"` (and/or add `"baseline-check"` to `journalEventTypeSchema` in `src/state.ts`).

3. **Plan claim / section:** `Exact File List to be changed or deleted` and `Reuse and Scope` ("On a positive match, return a typed comparison outcome to the tick, which atomically records the pending retry and uses `setPaused` for owner intervention... Retire the pending record with the corresponding acceptance, correction or action retirement.")
   - **Rule that must hold:** Owner-control retirement paths (`coord restart-action`, `coord drop`, `coord abandon`) must clear or invalidate any durable pending retry state tied to a retired `R7.finalize` action, and pause transitions must remain consistent with journal/analytics pause semantics (`src/ownerControls.ts:405-413`).
   - **Concrete failure:** `src/ownerControls.ts` and `src/cli.ts` are omitted from the file map. If an operator runs `coord restart-action` (`src/cli.ts:1929-1961`), `coord drop` (`src/ownerControls.ts:356-383`), or `coord abandon` (`src/cli.ts:1963-1974`) while a pending final-verification retry record is persisted in `cursors.json`, none of those paths retire the record, leaving stale retry state attached to `cursors.json` and misreporting it in `coord status`. In addition, calling `setPaused` directly in `src/runLoop.ts` sets `manualPaused: true` without emitting a `"paused"` journal event (`src/ownerControls.ts:411`), skewing pause-time analytics and presenting a baseline failure as `"Manual pause: active"`.
   - **Smallest correction:** Reuse `ownerQuestion` (extending `src/ownerControls.ts`, `src/machine.ts`, and `src/steps.ts`) instead of repurposing `manualPaused`, or include `src/ownerControls.ts` and `src/cli.ts` in the file list to retire the pending retry record and journal pause transitions consistently.

4. **Plan claim / section:** `Reuse and Scope` ("A true spawn ENOENT for the declared command with a valid worktree can identify the exact missing executable for comparison. Preserve the coordinator error path for unrelated spawn, mirror, authority and I/O faults.")
   - **Rule that must hold:** Coordinator launch failures thrown by `processRunner` must continue to reject `verifyFinalizationChecks` as required by the existing test contract in `test/runLoop.test.ts:3382-3395` (`const launchError = new Error("spawn docs-check ENOENT"); await expect(...verifyFinalizationChecks(...)).rejects.toBe(launchError)`).
   - **Concrete failure:** If `runVerification` intercepts `ENOENT` by matching error messages or without preserving the existing contract for `launchError` in `test/runLoop.test.ts:3383-3388`, that existing test fails because `verifyFinalizationChecks` resolves to a failed/baseline-comparison result instead of rejecting with `launchError`.
   - **Smallest correction:** Specify exact `(error as NodeJS.ErrnoException).code === "ENOENT"` handling (or keep `processRunner` throws rejecting and handle unavailable tools returned as non-zero exit codes / diagnostic messages) and explicitly verify compatibility with `test/runLoop.test.ts:3382-3395`.

5. **Scope, reuse, new files, and tests (codex):**
   - Stays within issue #272 and reuses `runVerification`, `BareMirror`, `runArgv`, `runVerifyPhase`, and existing test fixtures (`test/verificationRunner.test.ts`, `test/runLoop.test.ts`) with focused tests.
   - Justifies its single new file (`src/verificationEnvironment.ts`) as shared between sync hook spawning and async coordinator verification.
   - Notably catches stale pre-fix receipt collisions in `src/verificationReceipts.ts`, which is a real gap in naive receipt-key updates.

---

### Claude plan (`4cb22ad81efae1a6f6bee01c8682288ab6eeb728`)

1. **Plan claim / section:** `Exact File List` -> `src/verificationRunner.ts` item 1 ("If the worktree has no regular .nvmrc file, it returns `null`... Otherwise it runs, through `processRunner` with cwd set to the worktree and `{ env }`, a fixed bash argv... exits 3 with a clear message when nvm's script is missing, sources nvm with `--no-use`, and runs `nvm which`... Any other outcome throws an Error")
   - **Rule that must hold:** Toolchain resolution must work on hosts/CI without `nvm.sh` (e.g., `actions/setup-node`, Homebrew, `fnm`, `volta`, `COORD_NODE`, or multiple Nodes on `PATH`/`NVM_DIR/versions/node`), honor projects declaring `package.json` `engines.node` or `.node-version`, and not break callers or tests that inject a mocked `processRunner` for check commands.
   - **Concrete failure:** (a) On any machine without `$NVM_DIR/nvm.sh`, every check on a repo with `.nvmrc` (including `4horsemen` itself) throws and aborts even when Node `26.12.1` is already installed on `PATH`, `COORD_NODE`, or `process.execPath`. (b) A project declaring `"engines": { "node": ">=26.0.0" }` or `.node-version` without `.nvmrc` returns `null` and keeps resolving the older Node on inherited `PATH`. (c) Passing the internal `bash -c ... nvm which` probe through the check `processRunner` breaks any test whose mocked `processRunner` expects only declared check commands (recording unexpected `bash` calls and returning `"ok"` instead of a `/.../node` path, causing `resolveProjectToolchain` to throw).
   - **Smallest correction:** Support `.nvmrc`, `.node-version`, and `package.json` `engines.node`; probe `nvm.sh` only when present and fall back to scanning `COORD_NODE`, `PATH`, `${NVM_DIR}/versions/node`, and `process.execPath` directly rather than routing internal toolchain discovery through the check `processRunner`.

2. **Plan claim / section:** `Reuse and Scope` -> `Out of scope` ("Hook-run checks. The agent launcher already selects the project's Node via `nvm use` before the harness starts.")
   - **Rule that must hold:** Checks run through `coord hook-verify` (`src/hookPolicy.ts:267-324`) must also observe the project's intended Node version when an older Node appears first on the inherited `PATH` (for example in local verification mode, manual commits, or agent shells that reset `PATH` to login defaults).
   - **Concrete failure:** `githooks/lib/policy.sh:51` invokes `scripts/lib/node-runtime.sh $entry hook-verify` (which deliberately does not modify `PATH`), and `inheritRunner` in `src/hookPolicy.ts:269` runs `spawnSync(executable, args, { cwd, stdio: "inherit" })` with the inherited `PATH`. Any `pnpm` pre-commit or pre-push check invoked by `hook-verify` when an older Node is first on `PATH` still resolves the older Node.
   - **Smallest correction:** Include `src/hookPolicy.ts` in the file map and pass the resolved project environment into `inheritRunner` (and `unresolvableCommands`).

3. **Plan claim / section:** `Exact File List` and `Reuse and Scope` (omitting `src/issueReport.ts` and `src/interactive.ts`, claiming "The owner-question machinery, unchanged apart from one kind... and the interactive menu (which already renders any kind and its `allowedAnswers`).")
   - **Rule that must hold:** When candidate and baseline produce the same actionable failure, the coordinator must show the owner the evidence (excerpt, pins, and both log paths) and allow them to retry the same approved commit, including via `coord status` and the interactive TTY prompt.
   - **Concrete failure:** `src/issueReport.ts` references `cursors.ownerQuestion` only on line 94 (`needsAction`) and prints zero details about any pending `ownerQuestion` — `coord status` displays `[ACTION] Issue N: finalizing` with no question ID, no excerpt, no log paths, and no `coord answer` command. Likewise, `src/interactive.ts:102` prints only `Owner question: baseline-check-failure, round 1`, hiding all failure evidence and showing a misleading revision round.
   - **Smallest correction:** Add `src/issueReport.ts` and `src/interactive.ts` to the file map to display the pending `ownerQuestion` evidence and `coord answer` guidance.

4. **Plan claim / section:** `Risks and Mitigations` ("Receipt keys change for Node products. Earlier receipts keyed on the coordinator's Node simply miss, and the commands run once more.")
   - **Rule that must hold:** Cached receipts recorded *before* the toolchain `PATH` propagation fix (when `environment.node` recorded the coordinator's Node 26 even though `pnpm` child scripts actually ran on Node 23) must not be reused as valid passes after the fix.
   - **Concrete failure:** For `4horsemen` (where the coordinator runs Node `26.12.1` and `.nvmrc` also pins `26.12.1`), pre-fix receipts already stored `node: "v26.12.1"`. Under Claude's plan (which does not modify `src/verificationReceipts.ts`), post-fix runs compute the exact same `node: "v26.12.1"` receipt key and **hit** stale receipts that were actually produced under Node 23 instead of missing.
   - **Smallest correction:** Include `src/verificationReceipts.ts` to version/distinguish post-fix receipt keys (e.g. bump `ReceiptKeyMaterial` format or include toolchain provenance) so pre-fix receipts cannot hit.

5. **Plan claim / section:** `Exact File List` -> `src/runLoop.ts` item 2 and `Reuse and Scope` ("`runGateVerification`, `selectVerification` and `addCheckCommands`: these produce the command list the baseline prefix is taken from.")
   - **Rule that must hold:** Conditional future checks added in the current issue via `checkProposal` (`amendment`) apply only to commits containing the new entry points and must never be treated as baseline checks (`src/state.ts:252`).
   - **Concrete failure:** If a candidate proposes a new check command via `checkProposal` that fails due to an agent mistake (for example, a typo in the proposed script path or command name), running that issue-only amendment command against `start.baselineSha` produces the same `not found` error on baseline (where the new entry point does not exist), causing `verifyFinalizationChecks` to misclassify a candidate bug as a shared baseline failure and pause for the owner instead of rejecting the candidate.
   - **Smallest correction:** Only trigger baseline comparison when the failed command is part of the baseline's declared `selected.commands` (not an issue-only `checkAmendment` addition).

6. **Plan claim / section:** `Exact File List` -> `src/runLoop.ts` item 5 and `src/machine.ts` (logging `owner-action-required` with full multi-line evidence in `decision.reason`, without deduplicating console output in `applyDecisions`)
   - **Rule that must hold:** A waiting coordinator loop polling at `pollIntervalMs` (default 1s) must not flood stdout with repeated multi-line failure dumps on every tick while waiting for the owner.
   - **Concrete failure:** `decide()` emits `owner-action-required` on every tick while `cursors.ownerQuestion !== null` (`src/machine.ts:205-215`), and `src/runLoop.ts:3286-3288` unconditionally calls `this.log(\`Owner action required: ${decision.reason}...\`)`, so a live `coord run` process repeats the entire excerpt and both log paths every second.
   - **Smallest correction:** Track the last logged `ownerQuestion.id` in `CoordinatorRunLoop` so the full owner evidence banner is logged once on creation/restart rather than every poll tick.

7. **Scope, reuse, new files, and tests (claude):**
   - Adds no new files and reuses `ownerQuestion`, `applyOwnerAnswer`, `runVerification`, and existing test fixtures well.
   - Includes a concise doc update (`docs/coord-driver.md`), which is reasonable, and proposes focused tests in `test/verificationRunner.test.ts` and `test/runLoop.test.ts`, though it omits hook-phase (`test/verify-config.test.ts`) and CLI (`test/cli.test.ts`) coverage for `coord answer <id> retry`.

## Conclusion

Both peer plans accurately diagnose the core mechanisms behind #266, #270, and #271, but each has concrete gaps that would fail if followed as written:

- **Codex (`f3c1cdcb`)** rightly addresses `hookPolicy.ts` and pre-fix receipt invalidation in `verificationReceipts.ts`, and cleanly renders evidence in `issueReport.ts`, but its `manualPaused` / pending-retry design misses `src/verificationLog.ts`, `src/ownerControls.ts`, and `src/cli.ts` retirement paths, over-broadly overrides unpinned Node projects with coordination's Node 26, and risks breaking the `launchError` rejection contract in `test/runLoop.test.ts:3388`.
- **Claude (`4cb22ad8`)** cleanly reuses `ownerQuestion` / `applyOwnerAnswer` and avoids extra files, but requires `nvm.sh` unconditionally (failing on non-nvm hosts, `engines.node`-only repos, and mocked `processRunner` tests), skips `src/hookPolicy.ts`, omits `src/issueReport.ts` and `src/interactive.ts` (leaving `coord status` and interactive prompts without failure evidence), fails to invalidate stale pre-fix receipts in `src/verificationReceipts.ts`, runs issue-only `checkAmendment` commands against the baseline, and spams owner-action logs every poll tick.

Neither peer plan should be implemented as written without addressing the above defects. Combining the `ownerQuestion` retry architecture (with `src/issueReport.ts`, `src/interactive.ts`, and deduplicated logging) with multi-source toolchain resolution (supporting `.nvmrc`, `.node-version`, and `engines.node` with non-nvm fallback across both `src/verificationRunner.ts` and `src/hookPolicy.ts`), pre-fix receipt invalidation in `src/verificationReceipts.ts`, and baseline-check exclusion of issue-only `checkAmendment` commands resolves all findings cleanly.
