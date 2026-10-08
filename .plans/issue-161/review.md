# Plan Review — Issue #161

Evaluation of candidate implementation plans for issue #161:
- `cursor` (`87653072adc2b4f5e944cc093c2fa73337745813`) at `.plans/issue-161/plan.md`
- `claude` (`e635fae7af6dd6d07b3f3bd7c4ff6e2867149ae3`) at `.plans/issue-161/plan.md`
- `antigravity` (`84dc2d37e099af6d8d58d069f33cc694c3f9f28d`) at `.plans/issue-161/plan.md`
- `codex` (`b35d439ec356cee0158a59b8154b1c893ee2aa16`) at `.plans/issue-161/plan.md`

## Findings

### Finding 1: Claude's plan implements interactive re-nudge (`n`) via `restartOwnerAction`, destroying current action state and failing when holds exist (Issue item 6)
- **Plan claim**: Claude's plan Section "Exact File List to be changed or deleted" (line 20) and Section 6 / "Reuse and Scope" (lines 42, 75) states: "The interactive `n` key calls it without a tick, like the existing `d` key... Selecting one calls `restartOwnerAction`. A fresh `action.md` is issued and the running loop delivers it through its normal safety gates; uncommitted work in the agent clone is untouched."
- **Rule**: An interactive re-nudge control (`n`) must prompt an agent or re-evaluate terminal readiness for its *current* action without discarding the in-flight `actionId` or aborting if active holds exist.
- **Concrete failure**: `restart-action` in `src/cli.ts` (and `restartOwnerAction`) calls `clearAgentLocalWork(paths, agent, priorActionId)`, unlinking `runtime.action`, clearing the completion marker, and replacing the cursor with `actionId: null`. If an agent has already authored a commit or submitted a completion marker for the current action, clearing the action forces the runner to mint an entirely new `actionId`, invalidating the agent's completion. Furthermore, line 1426 of `src/cli.ts` asserts `if (current.holds.length > 0) throw new Error("Release active holds explicitly before restarting work.");`. If any hold is present on any agent, pressing `n` immediately throws an unhandled error. Finally, `restart-action` calls `invalidateUnpublishedBatches`, which unnecessarily invalidates other agents' pending ballot submissions in ballot rounds.
- **Correction**: Re-nudge must not call `restartOwnerAction`. Instead, implement `n` as a reminder request that invokes `maybeLifecycleNudge` (or resets the observation delay on the existing `actionId`) through the running loop, keeping the current action ID and ballots intact.

---

### Finding 2: Cursor's plan rejects worktree-defaulting for `--coord-root`, failing operator recovery commands (Issue item 4d)
- **Plan claim**: Cursor's plan Section "Exact File List to be changed or deleted" (lines 13-14) and Section "Alternatives Rejected" (line 131) states: "Default omitting `--coord-root` by changing global CLI resolution only — recovery text must still print a pasteable command; include `start.coordRoot` on the recovery line".
- **Rule**: When `--coord-root` is omitted from an issue command executed within an onboarded repository worktree, the CLI must automatically resolve the issue runtime from the current worktree's workspace locator, as requested in Issue #161 item 4d ("Can coord-root be defaulted to the one for the current worktree if it is ommitted?").
- **Concrete failure**: When an operator copies a suggested command or manually runs `coord resume --issue <n> --agent <agent>` from their worktree, `existingContext` in `src/cli.ts` still throws `--coord-root is required.` because cursor only adds `--coord-root` to the printed text without updating `existingContext` resolution.
- **Correction**: In `src/cli.ts` `existingContext`, when neither `--coord-root` nor `--product` is passed, resolve the workspace locator from `io.cwd` via `resolveWorkspaceFromProduct(io.cwd)` and find the matching runtime, exactly as `resolveStart` already does.

---

### Finding 3: Cursor's and Codex's plans reject `--repository` as a CLI flag, causing CLI failures when users follow updated help and error messages (Issue item 12)
- **Plan claim**: Cursor's plan (lines 89, 136) and Codex's plan (lines 103-104, 271) specify changing help and error prose to use "repository", but explicitly reject adding `--repository` as a flag option ("Keep the existing flag spelling `--product`... Do not rename schemas or introduce a second flag alias").
- **Rule**: When help documentation and error messages instruct operators to pass a repository path via `--repository`, the CLI argument parser must accept `--repository`.
- **Concrete failure**: Operators running `coord <issue> --repository <path>` as advertised in the updated help text will receive `Unknown option --repository` from `allowedFlags`.
- **Correction**: As proposed in Claude's and Antigravity's plans, treat `--repository` as a direct parse-time alias for `--product` in `parseArgs`.

---

### Finding 4: Codex's plan unnecessarily modifies core execution and runner interfaces (`src/tmux.ts`, `src/verificationRunner.ts`, `src/doctor.ts`), expanding change scope beyond the issue
- **Plan claim**: Codex's plan Section "Exact File List to be changed or deleted" (lines 18-21) and Section 4 proposes modifying `src/tmux.ts` to inspect tmux environment variables, adding progress callback interfaces to `src/verificationRunner.ts`, and altering `src/doctor.ts`.
- **Rule**: Implementations must make the smallest change that fully solves the issue, avoiding invasive changes to core runner and terminal interfaces when existing call sites in `runLoop.ts` already own the operations.
- **Concrete failure**: Modifying `src/verificationRunner.ts` changes the verification runner signature across all test suites when `src/runLoop.ts` (`runGateVerification`) already controls the invocation and can log before and after running checks without touching runner internals. Modifying `src/tmux.ts` and `src/doctor.ts` introduces unnecessary cross-module churn for read-only checks that `inspectAgentLifecycleHooks` in `src/agentHookSync.ts` already provides.
- **Correction**: Keep `src/tmux.ts` and `src/verificationRunner.ts` untouched. Emit progress logging before and after `runVerification` directly in `src/runLoop.ts`, and perform startup hook inspection using the existing `inspectAgentLifecycleHooks` helper.

---

### Finding 5: Evaluation of Reuse, Scope, and Proposed Tests
- **Reuse and Scope**:
  - `antigravity` and `claude` reuse existing functions (`startInteractiveSession`, `holdRecoveryCommand`, `renderIssueReport`, `inspectAgentLifecycleHooks`, `resolveWorkspaceFromProduct`) without modifying unrelated modules.
  - `cursor` leaves `--coord-root` defaulting unsolved and omits the `--repository` flag alias.
  - `codex` over-engineers the solution across 9 source files and 9 test files, modifying `src/tmux.ts` and `src/verificationRunner.ts`.
- **File Justification**: All four plans correctly create 0 new product files, ensuring no unnecessary file proliferation.
- **Tests**:
  - `antigravity`, `claude`, and `cursor` propose focused additions to existing suites (`test/interactive.test.ts`, `test/issueReport.test.ts`, `test/cli.test.ts`, `test/runLoop.test.ts`).
  - `codex` proposes extending 9 test files, adding significant test maintenance overhead.

## Conclusion

All four plans correctly understand the 12 usability points in Issue #161 and avoid creating unnecessary new files. However, significant differences emerge in execution safety:
1. `claude`'s plan mistakenly routes re-nudging (`n`) through `restartOwnerAction`, which clears action state and fails when holds exist.
2. `cursor`'s plan refuses to default `--coord-root` when omitted, leaving manual resume commands broken.
3. Both `cursor` and `codex` reject `--repository` as a CLI flag, creating a mismatch with updated help text.
4. `codex`'s plan is over-scoped, unnecessarily modifying core runner modules (`src/tmux.ts`, `src/verificationRunner.ts`).

`antigravity`'s plan provides the most focused, safe, and complete architecture: it properly defaults `--coord-root` from the worktree, accepts `--repository` as an alias, implements `n` as a clean re-nudge rather than a destructive restart, performs startup hook verification cleanly via `agentHookSync`, and limits changes strictly to the necessary CLI, interactive, report, and run-loop files.
