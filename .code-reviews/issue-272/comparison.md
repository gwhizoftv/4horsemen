## Comparison

Compared all three bound implementation pins against issue #272 and the selected plan (`f3c1cdcb1b4c7fe3349255dea5ceeac8aa8897b2`):
- **antigravity**: `db04b1f4c95aa9f5a269e040866909cb2de94fb1`
- **claude**: `f7a4704f1e423ff2d2e4c304149e26407e90655a`
- **codex**: `aa59721fdbc69d7be1be908188ee2d9b7fe836d0`

All three pins stay strictly within the 9 approved product paths (`src/hookPolicy.ts`, `src/issueReport.ts`, `src/runLoop.ts`, `src/state.ts`, `src/verificationEnvironment.ts`, `src/verificationReceipts.ts`, `src/verificationRunner.ts`, `test/runLoop.test.ts`, `test/verificationRunner.test.ts`), bump `ReceiptKeyMaterial` to `v: 2`, reuse `runVerification`/`BareMirror`/`runVerifyPhase`/`renderIssueReport`, and add focused tests in the two existing test files.

### Findings on codex (`aa59721fdbc69d7be1be908188ee2d9b7fe836d0`)

1. **`src/verificationRunner.ts:81`**
   - **Rule:** Baseline-vs-candidate diagnostic normalization must normalize the canonical worktree path (including macOS `/var` -> `/private/var` symlink expansion) or `.verification-<uuid>` segments so identical errors emitted from two distinct verification worktrees compare equal.
   - **Failure:** `raw.trim().replaceAll(worktree, "{worktree}")` only replaces the unresolved `worktree` string. On macOS where `tmpdir()` is `/var/folders/...` while child tools report `realpath` `/private/var/folders/.../.verification-<uuid>`, candidate and baseline produce different diagnostic strings (`/private/var/.../.verification-<id1>` vs `/private/var/.../.verification-<id2>`), causing `baseline.signature !== checked.signature` and routing a shared missing-tool failure to agent correction instead of owner retry.
   - **Illustrative test:** Run `failureDiagnostics` on two macOS `tmpdir()` worktree paths where stderr contains `${realpathSync(worktree)}/tool.sh: missing tool`, and assert their signatures match.

2. **`src/verificationRunner.ts:93`**
   - **Rule:** Actionable diagnostic classification must recognize common runtime/compiler error classes such as `TypeError`, `SyntaxError`, and `ReferenceError`, not only standalone `error` words.
   - **Failure:** `/\b(?:error|fatal|exception|panic|missing|cannot|denied|ENOENT|EACCES|TS\d+|assertionerror)\b/i` requires a word boundary immediately before `error`, so lines like `TypeError: x is not iterable` fail to match; `identity` remains empty (`signature: null`), hiding the actionable diagnostic behind fallback lines and preventing baseline matching.
   - **Illustrative test:** Call `failureDiagnostics({ exitCode: 1, stdout: "TypeError: items is not iterable\n" + "progress\n".repeat(50), stderr: "build failed\n" }, "/wt")` and assert `excerpt` contains `TypeError: items is not iterable` and `signature` is non-null.

3. **`src/hookPolicy.ts:131` and `src/hookPolicy.ts:314`**
   - **Rule:** `unresolvableCommands` (used by `coord doctor`) must not crash with an unhandled exception when a repo's `.nvmrc` pin is unavailable, and `runVerifyPhase` must report hook policy/toolchain errors via `HookPolicyError`.
   - **Failure:** `unresolvableCommands` calls `verificationEnvironment(cwd)` without `try/catch`, so `coord doctor` aborts with an unhandled error instead of returning a `DoctorReport` when `.nvmrc` names an uninstalled Node. Likewise, `runVerifyPhase` lets `verificationEnvironment(input.clone)` throw a plain `Error` instead of `HookPolicyError`.
   - **Illustrative test:** Create a repo with `.nvmrc` containing `99.99.99`, call `unresolvableCommands(config, repo)` and `runVerifyPhase(...)`, and assert `unresolvableCommands` returns gracefully while `runVerifyPhase` throws `HookPolicyError`.

4. **`src/verificationEnvironment.ts:21-45`**
   - **Rule:** Partial numeric `.nvmrc` pins (such as `26` or `26.12`) must resolve against installed Nodes on `PATH`, `NVM_DIR/versions/node`, or `process.execPath` even on hosts/CI without `$NVM_DIR/nvm.sh`.
   - **Failure:** `exact` matches only 3-part versions (`/^v?\d+\.\d+\.\d+$/`), so a pin like `26` skips `process.execPath`, `PATH`, and `NVM_DIR/versions/node` entirely and throws on any machine without `nvm.sh` (e.g., GitHub Actions `actions/setup-node` or Homebrew Node).
   - **Illustrative test:** Create a repo with `.nvmrc` = `26`, set `NVM_DIR` to an absent directory, place Node `v26.12.1` on `PATH`, and assert `verificationEnvironment(repo, env)` resolves `v26.12.1` instead of throwing.

5. **`src/issueReport.ts:120`**
   - **Rule:** Pending final-verification retry evidence should remain visible in `coord status` whenever the retry is live on `R7.finalize`, even if `manualPaused` was just cleared (state-only `coord resume` before the next tick) or a concurrent hold exists.
   - **Failure:** Gating `finalRetryMessage` on `cursors.manualPaused && cursors.finalRetry` hides the persisted retry evidence immediately after state-only `coord resume` before the next tick executes, and does not verify that `finalRetry` still matches the active `R7.finalize` action if `cursors` was mutated externally.
   - **Illustrative test:** Call `renderIssueReport` with `manualPaused: false` and a live `finalRetry` (before the next tick runs) and assert the report still identifies the pending final verification for `finalSha`.

### Findings on claude (`f7a4704f1e423ff2d2e4c304149e26407e90655a`)

1. **`src/runLoop.ts:3597-3599`**
   - **Rule:** A persisted `finalRetry` binding (pinning `submissionSha`, `finalSha`, and `reuse: false`) must only be retired atomically inside the acceptance or reissue mutation (`accept()` / `reissue()`), never in an earlier separate mutation before `applyDecisions`.
   - **Failure:** `clearFinalRetry` commits `finalRetry: null` before `applyDecisions` calls `accept()`. If the coordinator crashes or encounters a `StateConflictError` between lines 3598 and 3620, `R7.finalize` remains unaccepted while `finalRetry` is already gone, allowing a replaced completion marker to substitute another SHA and allowing the next tick to reuse receipts (`reuse: true`) instead of running fresh verification.
   - **Illustrative test:** Resume a paused `finalRetry`, abort/throw inside `accept()` (or simulate a conflict before `applyDecisions`), reload `cursors.json`, and assert `finalRetry` is still persisted until acceptance or reissue commits.

2. **`src/verificationEnvironment.ts:66-80` and `src/verificationEnvironment.ts:105-106`**
   - **Rule:** Project Node resolution must discover installed matching Nodes on `PATH` (not only `process.execPath` and `$NVM_DIR/versions/node`), honor `package.json` `engines.node` when inherited `PATH` fails it, and record the actual inherited `PATH` Node version (not coordinator's `process.version`) in receipt keys for unpinned Node projects.
   - **Failure:** (a) On a non-nvm host where coordinator runs Node 26, `PATH` has Node 20 first and Node 22 second, and `.nvmrc` pins `22`, `installedNodes` never inspects `PATH` and throws `ProductToolchainError` even though Node 22 is installed. (b) A project declaring `"engines": { "node": ">=26.0.0" }` without `.nvmrc` returns `pin: null` and still runs `pnpm` children under an older Node 23 on inherited `PATH`. (c) For an unpinned Node project running Node 20 from `PATH`, `src/verificationRunner.ts:277` records `node: base.node` (coordinator's Node 26) in the receipt key.
   - **Illustrative test:** Put `v20.0.0` then `v22.10.0` on `PATH` with `NVM_DIR` absent and `.nvmrc` = `22`, and assert `resolveProductEnvironment` selects `v22.10.0`.

3. **`src/verificationRunner.ts:102-105`**
   - **Rule:** Specific diagnostic extraction must match JavaScript/Node error classes like `TypeError`, `SyntaxError`, and `ReferenceError`.
   - **Failure:** `/\b(?:errors?|...)\b/i` fails the leading word boundary on `TypeError: x is not iterable`, leaving `actionableDiagnostics` empty for that line so neither the excerpt priority nor baseline matching captures it.
   - **Illustrative test:** Call `actionableDiagnostics("TypeError: x is not iterable\n" + "progress\n".repeat(50), "build failed\n")` and assert it returns `["stdout: TypeError: x is not iterable"]`.

### Findings on antigravity (`db04b1f4c95aa9f5a269e040866909cb2de94fb1`)

1. **`src/verificationRunner.ts:368-371`**
   - **Rule:** Converting a `spawn ENOENT` error into a failed check result for baseline comparison must apply only to `phase === "finalization"`, keeping candidate-phase missing executables as coordinator launch errors rather than agent rejections.
   - **Failure:** Because `isMissingExecutable` omits `input.phase === "finalization"`, a missing host executable during `R4.implement` or `R6.revise` candidate checks is turned into a rejected agent submission instead of throwing as a coordinator launch fault, causing agents to be blamed for a host tool gap.
   - **Illustrative test:** Call `runVerification` with `phase: "candidate"` and `argv: ["definitely-missing-tool-xyz"]` using `runArgv`, and assert the promise rejects rather than returning `{ status: "failed" }`.

2. **`src/runLoop.ts:2945-2951`**
   - **Rule:** Checks added solely by the current issue's `checkAmendment` (`checkProposal`) target new entry points not present on the frozen baseline (`src/state.ts:252`) and must not trigger baseline-match owner pauses when they fail.
   - **Failure:** `evaluateFinalizationChecks` compares any failed command in `commands` (including `amendment` additions) against `start.baselineSha`. If a candidate introduces a typo'd script path in `checkProposal`, both candidate and baseline fail with the same missing-file diagnostic and pause for the owner instead of rejecting the candidate.
   - **Illustrative test:** Add a `checkAmendment` command `["sh", "scripts/typo.sh"]` to `R7.finalize`, run `runTick`, and assert the candidate is routed for correction (`paused: false`) rather than pausing as a baseline failure.

3. **`src/verificationRunner.ts:116-123`**
   - **Rule:** Comparison normalization must strip volatile timestamps and durations alongside worktree roots so identical failures emitted seconds apart compare equal.
   - **Failure:** `normalizeLine` replaces worktree paths and `.verification-<uuid>`, but leaves ISO timestamps and durations (`120ms`, `1.4s`) intact. If a shared tool failure line includes a timestamp or elapsed duration, candidate and baseline lines differ and `areDiagnosticEvidencesEquivalent` returns `false`, sending a shared failure to agent correction.
   - **Illustrative test:** Call `areDiagnosticEvidencesEquivalent` on `extractDiagnosticEvidence("", "2026-11-20T19:00:01Z error: protoc missing (12ms)")` vs `extractDiagnosticEvidence("", "2026-11-20T19:00:04Z error: protoc missing (19ms)")` and assert `true`.

### Scope, Reuse, and Test Discipline Comparison

- **codex (`aa59721f`)** is the most compact implementation (`src/verificationEnvironment.ts` is 46 lines; minimal additions in `test/verificationRunner.test.ts` and `test/runLoop.test.ts`) and uses a neat central retirement hook in `mutateCursorsState` (`src/state.ts:1423-1431`), but carries the highest-impact functional bugs: macOS `realpath` worktree mismatch breaking baseline matching, `TypeError`/`SyntaxError` regex miss, partial `.nvmrc` pin failure without `nvm.sh`, and unhandled `verificationEnvironment` throws in `unresolvableCommands` (`coord doctor`).
- **claude (`f7a4704f`)** has clean, readable modular code (`src/verificationEnvironment.ts` 129 lines), properly excludes issue-only `checkAmendment` commands from baseline comparison, normalizes timestamps/durations and `.verification-<uuid>`, scopes `ENOENT` handling to `finalization`, and includes `liveFinalRetry` validation in both `runLoop.ts` and `issueReport.ts`; its main defects are the crash-window early `clearFinalRetry` before `accept()`, not scanning `PATH` or `engines.node` in `resolveProductEnvironment`, recording coordinator Node in unpinned receipts, and the `\berrors?\b` miss on `TypeError`.
- **antigravity (`db04b1f4`)** handles the broadest toolchain cases (`.nvmrc` exact/partial/nvm, `.node-version`, `engines.node` without disturbing satisfied inherited `PATH`, scanning `PATH`/`NVM_DIR`/`COORD_NODE`/`process.execPath`), handles `TypeError`/`SyntaxError`/source locations, normalizes `realpath` worktree aliases, and clears `pendingFinalVerification` atomically inside `accept()`/`reissue()`; its main defects are not scoping `ENOENT` conversion to `finalization`, not excluding issue-only `checkAmendment` commands from baseline comparison, not normalizing timestamps/durations during comparison, and carrying a larger `src/verificationEnvironment.ts` (340 lines).
