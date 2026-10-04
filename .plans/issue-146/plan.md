# Issue 146 — preserve live work and simplify coordinator recovery

The issue snapshot describes two linked failures: an ordinary safety hold ends the foreground coordinator, and restarting rejects unfinished agent work even when no branch switch is needed. At baseline `a792b19e8757c734c1c572b1c3fc1675a78d8bfc`, `CoordinatorRunLoop.run()` treats a paused issue without pending resource work as finished, while `prepareAgentIssueBranches()` checks all clones for dirt before its existing already-on-branch path. Fix these boundaries without weakening hold authorization or resetting agent work.

## Exact File List to be changed or deleted

1. `src/prepareAgentBranch.ts`
   - Reuse the existing clone-readiness snapshot and `issueBranchFor()` to preflight all available clones. Block real dirt only when the clone needs a branch switch: main, another issue/agent branch, and detached HEAD retain the current refusal. Finish this preflight before modifying any clone.
   - When HEAD is already on the exact configured issue/agent branch, retain local commits, staged changes, unstaged changes, and untracked files. Do not checkout, reset, clean, stash, fetch, or require merged/pushed work for this path. Recheck branch identity before effects; refuse if a clone changed branches since preflight.
   - Preserve the existing `already-on-branch` result and readiness assertions. Leave a healthy protocol overlay alone; use the existing protocol restoration helpers only when repair is required, preserving human text outside the managed block. Do not lift the overlay on this path. Keep the existing capture/finally-restore behavior when an actual clean branch switch is needed.
2. `src/runLoop.ts`
   - Treat completed and abandoned state, an abort signal, and unrecoverable errors as termination conditions. A manual pause or safety/resource hold is a waiting condition, not process completion, including a hold already present when `run()` starts.
   - Continue sleeping at `pollIntervalMs` and rereading durable state. Keep `runTick()`'s held path observation-only: no clone preparation, harness launch, delivery, completion acceptance, or publication while paused. Manual pause continues to prevent resource observations as well. Do not create extra quota probes, replenish budgets, or release holds merely because the process stays alive.
   - Once another owner command releases the applicable gates, continue in this same process. Initialize effects once successfully authorized; an initially held runner initializes only after unpausing. Handle `StateConflictError` during initialization by rereading and retrying on a later poll, not by exiting or claiming initialization succeeded. Other initialization failures still surface rather than being swallowed.
   - Remove the now-unused `resourceWorkPending()` exit predicate, not the resource scheduling/budget machinery. Report waiting/recovery on entry and meaningful changes, not every poll; refresh the report when resource recovery information changes even if the hold ID is unchanged. Update hold logs with the simpler recovery guidance below.
3. `src/cli.ts`
   - Add `--agent <id>` and boolean `--run` to `resume` only. Keep existing `--issue`, `--product`, `--coord-root`, `COORD_ISSUE`, and workspace discovery. A stopped coordinator can be recovered with `coord resume --issue 139 --agent claude --run`, without copying a UUID or issuing a second command.
   - `--agent` and `--hold` are mutually exclusive. Within the existing `mutateCursorsState()` transaction, resolve an agent selector to exactly one hold belonging to that active agent and call `releaseHold()` with its actual ID. Reject zero or multiple matches without changing state; show candidates and retain `--hold` as the unambiguous fallback. Do not select the first hold silently.
   - Preserve plain `resume` as manual-pause-only recovery, and preserve explicit `--hold` semantics. An agent-selected release must not clear another hold or a manual pause. Keep retired-action validation, required `--reset-nudge-budget` for nudge-loop holds, rejection of that flag for other hold kinds, and existing journal identities. Record the resolved hold ID in the existing `hold-released` event.
   - Without `--run`, return after the scoped mutation so an already-running coordinator can observe it. With `--run`, use the same manual-session exclusion, run-loop construction, and completed-issue cleanup as `coord run`; check session exclusion before releasing a hold. Do not run startup/new-issue initialization. Remaining pauses keep the runner waiting, not advancing. Explain that `--run` is for a stopped coordinator; recovery beside an existing foreground coordinator omits it. No new daemon/runner-lease subsystem is introduced.
   - Update CLI help and recovery output with both forms and the ambiguity/budget rules.
4. `src/issueReport.ts`
   - Keep hold IDs, reason, vendor evidence, resource deadlines, and owner authority visible. Add agent-based recovery guidance when that agent has exactly one hold, with exact-ID fallback for ambiguity. Explain that the running coordinator will continue after recovery; add `--run` only if restarting a stopped coordinator. Preserve nudge-budget flag guidance and independent manual-pause instructions.
5. `test/prepareAgentBranch.test.ts` — extend the existing preparation tests with preservation and mixed-clone preflight coverage.
6. `test/runLoop.test.ts` — extend existing run/resource and initialization coverage to distinguish a live waiting runner from an authorized workflow effect.
7. `test/cli.test.ts` — extend scoped hold recovery coverage and reuse fake run-loop dependencies for `--run` assertions.
8. `test/issueReport.test.ts` — extend existing hold reports to verify the new recovery guidance and ambiguity fallback.
9. `docs/coord-driver.md` — correct the blanket dirty-clone refusal and two-command recovery instructions; document waiting, owner release, and safe same-branch reattachment.
10. `README.md` — add the concise stopped-runner recovery example and explain that remaining alive does not authorize automatic release.

No product files are deleted. Do not change `package.json`, hooks, runtime schemas, templates, or unrelated cleanup/finalization behavior.

## Exact file list to be created

- `.plans/issue-146/plan.md` — this required coordinator planning artifact, the only file published by this action.
- No new implementation, test, fixture, documentation, or dependency files. All implementation work fits the existing modules and test suites listed above.

## Reuse and Scope

Reuse `snapshotCloneReadiness()`, `issueBranchFor()`, `blockingDirtyPaths()`, `PrepareAgentIssueBranchResult`, `cloneAgentsProtocolState()`, `captureCloneAgentsProtocol()`, `restoreProtocol()`, and `assertClonesReady()`. Existing protocol helpers already preserve non-managed text and restore the skip-worktree invariant; do not build a second overlay implementation or relax the checkout safety check globally.

Reuse `CoordinatorRunLoop.runTick()`, `initializeEffects()`, `authority()`, injected `sleep`/`now`, `StateConflictError`, and the existing resource-observation gates. Reuse `mutateCursorsState()`, `releaseHold()`, `setPaused()`, `appendJournal()`, `existingContext()`, `assertNoManualSession()`, `makeRunLoop()`, and `detachCompletedIssue()`. Factor only the small existing CLI run-entry sequence if needed to keep the new option's guards identical; no generalized recovery framework or new state type is needed.

Tests reuse `seedClone()`, `skipWorktree()`, and `test/support/workspaceFixture.ts` Git helpers; run-loop `fixture()`, `safetyFixture()`, `quotaFixture()`, scripted `BareMirror`/`TmuxController` dependencies; CLI `setup()`, `fakeLoop()`, and `resolvableStartGit`; and existing issue-report fixtures. These referenced helper files do not require edits. This issue changes runner liveness, branch-preparation eligibility, and recovery ergonomics, not the decision machine, acceptance rules, quota authority, or concurrent-runner architecture.

## Tests

Prefer extending existing cases and small table-driven variants over separate fixture files:

1. **Same-branch preservation (`test/prepareAgentBranch.test.ts`):** prepare the issue branch, add a local unpushed commit, then staged/unstaged tracked edits and an untracked plan. Preparing again must succeed with `already-on-branch`; compare HEAD, staged blob content, worktree bytes, and untracked bytes before/after and assert the overlay/skip-worktree invariant. Extend dirty refusal with a mixed-clone case: dirty correct-branch work is eligible, but a different dirty clone needing checkout rejects the whole operation before either clone changes. Include detached/wrong-issue branch variants; retain all existing protocol repair tests.
2. **Waiting and recovery (`test/runLoop.test.ts`):** update the existing unknown-reset/one-recheck tests, which currently expect `run()` to return, to stop explicitly with `AbortController` through the injected sleep. Assert multiple sleeping polls, unchanged holds/sends and bounded quota reads, no initialization while held, and non-repeating diagnostics. Cover manual pause and a non-resource hold, then release the gate from an injected sleep and show that the same runner initializes/continues. Verify completion/abandon/abort terminate and an initialization-time authority conflict waits/retries without unauthorized effects. Extend the existing reattachment initialization case with a real dirty same-branch clone and a scripted mirror to exercise the failing restart boundary.
3. **Scoped CLI recovery (`test/cli.test.ts`):** extend the selected-hold test for an agent selector and `--run`: the resolved ID is audited once and the injected run loop is invoked once after release. Verify no loop starts without `--run`; ambiguity, unknown agent, conflicting selectors, missing nudge-budget acknowledgment, or retired work mutate nothing. Keep another hold/manual pause intact. Verify `--run` honors manual-session exclusion before mutation and reuses normal completed cleanup. Existing legacy `--hold` and plain resume cases remain valid.
4. **Actionable reporting (`test/issueReport.test.ts`):** extend existing report assertions for readable agent recovery, optional restart, independent manual pause, nudge-budget acknowledgment, and same-agent multiple-hold fallback. Do not imply provider capacity or automatic clearance.

Commands, verified from this repository's package scripts/configs:

```sh
pnpm exec vitest run --config vitest.config.ts test/prepareAgentBranch.test.ts test/runLoop.test.ts test/cli.test.ts test/issueReport.test.ts
pnpm check:fast
pnpm check
```

Run `pnpm check:fast` before commits, including this plan publication. Run full `pnpm check` (build, lint/typecheck/fast tests, and the existing integration suite) for the implementation before submission; hooks alone are not final acceptance. Update every existing `run()` test that depends on pause-triggered return so the new waiting semantics cannot hang the suite.

## Alternatives Rejected

- **Remove dirt checks or stash/reset agents:** permits switching unrelated dirty work and risks loss of normal in-progress plans or implementation. Exempt only the exact current target branch.
- **Automatically release all holds, reset budgets, or drop an agent:** staying alive is not permission to bypass independent safety gates. Keep audited, scoped owner recovery and existing narrowly authorized resource release.
- **Make every `resume` start a runner:** owner recovery is often issued beside a live coordinator. Keep state-only behavior by default and add an explicit one-command stopped-runner option.
- **Infer quota clearance from elapsed time, completion files, or pane output:** not required to solve either reported boundary and would change independent safety policy.
- **Catch and retry every error indefinitely:** masks malformed state, unsafe branch transitions, or installation failures. Handle ordinary held state and typed concurrent-state conflicts; keep genuine failures diagnostic and restartable.

## Risks and Mitigations

- Agents may still be writing while reattachment runs. The exact-branch path does not touch their product/index contents beyond a necessary protocol-bit repair; recheck identity before effects, preserve healthy overlays, and never switch a dirty clone.
- A waiting process could flood logs or create fresh work. Sleep on the configured cadence, report meaningful waiting-state changes once, and retain held `runTick()`/authority gates and resource budgets.
- Owner changes may race initialization or recovery. Resolve selectors under the existing cursor mutation lock, retain action-ID validation, and treat initialization authority conflicts as a reason to reobserve rather than proceed.
- A shorter selector could release unintended work. Require one matching hold, reject ambiguity, preserve explicit-ID fallback, and never combine manual-pause clearing with scoped hold release.
- Running `--run` beside another coordinator could duplicate the pre-existing foreground-run pattern. Document state-only recovery for a live runner and `--run` for a stopped one; do not add speculative process supervision or imply single-runner detection exists.

## Conclusion

Keep the coordinator alive while safe advancement is temporarily blocked, preserve legitimate dirty work when rejoining the same issue branch, and make stopped-runner recovery an explicit agent-named single command. Deliver these changes without weakening hold authority, rewriting branch history, introducing new runtime state, or expanding beyond the reported recovery workflow.
