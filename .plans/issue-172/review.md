# Issue 172 — plan review

Protocol version: 1. Review action: `b24d57d0-8a11-4bf3-9105-06cf4ee693ae`.

Reviewed the coordinator-exported plans at these exact pins:

- Cursor: `cde4a70b515558e80d32c422a85fd9e50529f1c4`.
- Codex: `be4b37b973bb3420d44cbe41f7238d9c1c167a05`.
- Claude: `3e67191cefbc89b732f7cf8c412b3b30e214bc5e`.
- Antigravity: `d298175f625de94aeedd41a1d86c1f95d5cea268`.

All four exported files match the SHA-256 values in the bound manifest. Findings below concern the plans as written, checked against the frozen issue and the existing source/tests; they are not claims about implementations or test results.

## Findings

### 1. Cursor — the proposed cleanup helper does not have the promised preservation policy [P1]

**Plan claim:** The `src/cli.ts` file-map entry and Reuse and Scope propose `makeAgentClonesBaseReady` with “the same refuse-unpushed-work policy used by detachCompletedIssue”; the branch-file entry proposes only changing refusal text.

**Rule:** Manual completion must refuse unpublished work and preserve owner changes and local branch history. Reuse is appropriate only if the reused helper actually provides that contract.

**Failure:** The existing helper has no unpushed-commit check. Its eligibility test checks dirty paths and branch equality (`src/prepareAgentBranch.ts:423`), it resets/cleans eligible dirty work (`:555`), and it resets a divergent local base through `checkout -B` (`:537` and `:569`). A clean manual branch containing an unpushed commit therefore passes instead of refusing; a clean local base ahead of origin can have its base ref moved off those unpublished commits. The named safety policy does not exist, and the planned refusal-message change cannot supply it. Add a separate non-discarding manual policy with publication/ancestry checks and preservation tests before invoking checkout.

### 2. Cursor — session existence is not proof that manual work has finished [P1]

**Plan claim:** The CLI entry says `coord N` will detach an existing manual session before continuing; Risks and Mitigations proposes logging the cleanup and restricting its name as the mitigation for killing in-progress UI.

**Rule:** Automatic cleanup must distinguish abandoned/finished sessions from live owner work before terminating them. Correct workspace targeting alone does not establish permission to stop a running task.

**Failure:** A manual agent can be thinking, running a test, or holding unsaved input while its Git tree is clean. The plan will kill that agent merely because the owner invokes `coord N`. It also puts readiness checks after teardown, so a later refusal cannot restore the terminated work. Preflight clone safety and inspect session activity before effects; require explicit owner completion/confirmation for a live session that is not proven eligible for automatic cleanup.

### 3. Cursor — a separate `coord nudge` process cannot deliver through the existing in-memory request map [P2]

**Plan claim:** CLI item (5), New surface justified, and test case 8 describe a thin `coord nudge --agent/--all` wrapper around `CoordinatorRunLoop.reminders()`.

**Rule:** A successful reminder request must reach the coordinator that owns delivery, retaining its authority/readiness checks and send accounting.

**Failure:** `reminders().request()` only writes to that loop instance's private `ownerReminders` map (`src/runLoop.ts:908`, `:928`). A separate CLI process can report “requested” and exit without the running loop ever seeing the request. Calling the method is not a delivery integration test. The plan specifies neither a cross-process channel nor safe ownership for another runner. The smallest correction is to keep the requested individual/all choices in the existing interactive `n` menu and omit the extra CLI verb.

### 4. Cursor — home-scoped daemon termination is not workspace-scoped ownership [P1]

**Plan claim:** CLI item (3), the `src/codexQuota.ts`/optional `src/codexAppServer.ts` entry, and Risks and Mitigations propose stopping leftover app-server processes for a configured agent home at manual startup.

**Rule:** Manual startup must not terminate another workspace's active Codex process, and new process-management code needs a demonstrated gap beyond the baseline's `--no-daemon` launch.

**Failure:** A Codex home/account can be shared by multiple sessions. Matching that home or a resource-binding record does not establish that a process belongs to the manual session being replaced or is idle. The helper could stop an unrelated active app-server. `readCodexQuota` owns and reaps the particular child it spawns (`src/codexQuota.ts:40`); it is not an ownership registry for arbitrary leftover daemons. The baseline launcher already uses `--no-daemon`, which the plan acknowledges. Preserve that isolation and its generated-launcher regression instead of adding this unneeded termination surface.

### 5. Claude — copying the shim's legacy root calculation makes active nested issues look absent [P1]

**Plan claim:** The launcher entry extracts `coord_runtime_root` from `coord_action_lists_files` with “same nested-vs-flat logic” and delegates whenever `$root/issue-$COORD_ISSUE` is absent.

**Rule:** Staleness must be evaluated against the runtime that actually owns the issue; a supported nested layout must retain the active-session guard.

**Failure:** The copied helper strips `workspaces/<project>` and returns the outer runtime (`scripts/lib/launcher.sh:207–210`). Current product-resolved startup uses the workspace directory for issue state (`src/workspace.ts:111–119`, `src/cli.ts:427–429`, `:815–828`). With config `/runtime/workspaces/app/config.json`, a live issue is at `/runtime/workspaces/app/issue-42`, while the proposed absence test checks `/runtime/issue-42`. It will allow restricted commands in a valid automated session. Resolve the actual workspace-scoped location and only use a legacy location when its durable config binding matches; add a nested active-issue regression.

### 6. Claude — durable issue existence does not detect a stale vendor session [P1]

**Plan claim:** The launcher staleness rule delegates only for explicit manual mode, a missing issue directory, or completed/abandoned cursor flags; no native guard or lifecycle change is planned.

**Rule:** An inherited issue number must not impose automated restrictions on a request from a different/retired session, including when the old issue still has unfinished durable state.

**Failure:** Leave an incomplete `issue-42` runtime behind and run owner-directed work on a scratch branch with inherited `COORD_ISSUE=42` and no newly set manual flag. All of the proposed staleness tests fail to detect this case. The shim still refuses `git status`, even if the native request's session differs from the recorded lifecycle session. The native guard currently forwards command/environment to the shim without using `request.sessionId` to decide applicability (`src/shellGuard.ts:282–305`), so “the guard inherits the policy” cannot supply that missing check. Validate current clone/branch/session binding rather than substituting issue-directory liveness for session identity.

### 7. Claude — clone refusal occurs after the manual session has already been destroyed [P1]

**Plan claim:** The `detachManual` closure calls `detachIssue` and then `makeManualClonesBaseReady`, returning an error if a clone is refused.

**Rule:** A refusal for uncommitted/unpublished manual work must be determined before destructive transition effects, and the batch should not partly transition because another clone was inspected later.

**Failure:** With one dirty or unpublished clone, `coord detach manual` closes the Terminal tabs and kills its harnesses before discovering that it cannot complete the transition. The owner cannot continue the existing session to finish/push the work; with several clones, earlier clones can also be switched before a later refusal. The proposed confirmation asks to close UI and return clones to base, but it does not make that failed combined operation safe or atomic. Split read-only batch preflight from effects, and test that a refusing clone leaves all sessions and clone refs unchanged.

### 8. Claude — the placement diagnostic verifies creation metadata, not the running agent [P2]

**Plan claim:** `agentPlacementDiagnostics` checks only `pane_dead`, `pane_start_path`, and an expected Terminal title, then emits `[OK]`; its only call site is numeric `reportStartup()`.

**Rule:** A successful placement diagnostic must establish that the expected harness is running in the expected pane/clone, and the manual launch path implicated by this issue must be covered too.

**Failure:** A live shell or unrelated process in a pane initially created in the correct clone passes every proposed check and is reported as a correctly placed agent. `pane_start_path` also does not show a later cwd change. Separately, `coord manual` never creates the run loop, so this new diagnostic never runs for manual startup. Inspect current pane/process ownership and wire the check into both launch paths; do not label unknown process evidence `[OK]`.

### 9. Claude — the test changes are outside its declared file map [P2]

**Plan claim:** Tests requires modifications to eight existing test files, but Exact File List lists only product files, and Exact file list to be created permits only the plan artifact.

**Rule:** Every path intended for modification must appear in a file-list section, as required by this action's approved-scope protocol.

**Failure:** The planned implementation cannot add its own required regressions within the declared scope. The omitted files are `test/issueReport.test.ts`, `test/interactive.test.ts`, `test/shellGuard.test.ts`, `test/tmux.test.ts`, `test/runLoop.test.ts`, `test/prepareAgentBranch.test.ts`, `test/cli.test.ts`, and `test/install.test.ts`. List them in the changed-file section before this plan is approved; mentioning them only under Tests is insufficient.

### 10. Antigravity — several requested behaviors have no implementation or test path [P1]

**Plan claim:** Conclusion says the plan “addresses all items,” while its exact file map and tests cover only cache exclusion, refusal text, manual cleanup, and stale guards.

**Rule:** The plan must cover each unresolved requirement in the frozen issue, or demonstrate that the baseline already satisfies it.

**Failure:** `resolveStart` still requires the config/runtime pair and cannot use a registered clone locator; the existing `n` menu still offers only individual reminders; and no added startup diagnostic verifies agent placement. None of these changes or tests appears in the plan. Status separators and Codex `--no-daemon` do exist at baseline and can be retained, but that does not cover the other omissions. Add scoped resolution, all-agent reminder, and placement changes with focused tests, and explicitly identify the already-satisfied items.

### 11. Antigravity — native-hook allowances and direct-shim policy diverge [P1]

**Plan claim:** `src/shellGuard.ts` will allow completed/abandoned/mismatched sessions, but the generated wrapper will delegate only for `COORD_MANUAL=1` or an absent runtime directory.

**Rule:** Fixing stale inherited context must also fix the actual Git execution path; passing the native pre-tool guard must not leave the generated shim refusing the same stale invocation.

**Failure:** With a completed issue directory retained for analytics and inherited `COORD_ISSUE`, the native guard allows `git status` but `.coord/bin/git` still exits 2, so the reported owner failure remains. In the other direction, adding unconditional `COORD_MANUAL` passthrough without clearing that inherited variable in numeric startup can disarm the guard for a new automated issue; the plan does not list `src/tmux.ts`. Share the applicability policy and normalize both launch modes, with executable shim and mode-transition tests.

### 12. Antigravity — a clean Git tree is insufficient evidence for automatic manual teardown [P1]

**Plan claim:** CLI test case 3 expects automatic cleanup when clones are clean, and the plan relies on transition-time tmux/Git inspection without specifying an active-work veto or confirmation.

**Rule:** The automatic transition must preserve a currently working manual harness even if it has not written files yet.

**Failure:** A clean manual agent doing analysis or a long read-only command is indistinguishable from an abandoned session under the stated criterion and will be killed by the next issue start. Add a defined idle/finished-session predicate with conservative handling of unknown activity, or explicit owner confirmation, before teardown; test the clean-but-busy case.

### 13. Cursor, Claude, and Antigravity — the proposed test commands do not cover their named regression suites [P2]

**Plan claim:** Cursor's focused command uses default `pnpm exec vitest run` for both fast and system files; Claude prescribes `--config vitest.config.ts` per touched file; Antigravity names test cases but no runnable verification commands.

**Rule:** The plan must name real commands that actually execute its required tests and distinguish focused runs, hook checks, and coordinator checks.

**Failure:** `vitest.config.ts` explicitly excludes `test/cli.test.ts`, `test/install.test.ts`, and `test/workspace.test.ts`. Cursor's mixed command can run its fast cases while silently excluding its critical CLI/installer tests; Claude's per-file invocation cannot run those suites with the named config. Antigravity leaves the check contract unspecified altogether. Use `pnpm test:fast ...` for fast files and `pnpm test:system ...` for the system files, and name the hook-owned precommit/prepush and coordinator-owned final checks. These plans should also test preservation/refusal behavior, not only that a cleanup callback was invoked.

### Scope, reuse, and test assessment

- **Codex:** No blocking finding identified at `be4b37b973bb3420d44cbe41f7238d9c1c167a05`. The map explicitly includes the changed test files. It reuses the existing workspace/branch/tmux helpers, fixtures, guarded reminder closures, and status renderer, creates no product files/dependencies, and explains the new internal context query and manual readiness path. Its larger map corresponds to the issue's distinct lifecycle, binding, discovery, and UI requirements; the tests are grouped around those contracts. Preserve its explicit batch preflight, fresh publication evidence, busy-session veto, and correct test tiers during implementation. This is a review of my own bound plan as well as the peer plans, not independent implementation verification.
- **Claude:** Reuses the interactive reminder interface and fixtures well, avoids unnecessary daemon restart, and explicitly handles opposing tmux mode variables. The findings above prevent approval, particularly nested context, stale-session detection, cleanup ordering, and the missing test scope.
- **Cursor:** Reuses relevant modules and existing tests, but assumes safety properties that the cleanup/reminder APIs do not have. The added daemon manager (including its optional new module) and separate nudge verb are not justified when the baseline already provides daemon isolation and a guarded interactive reminder path.
- **Antigravity:** Avoids new dependencies/files and keeps tests in existing suites, but narrows the issue without acknowledging the uncovered requirements. Its proposed native/shim split and cleanup test criterion do not establish the promised transition behavior.

## Conclusion

Approve the Codex plan `be4b37b973bb3420d44cbe41f7238d9c1c167a05` for implementation within its declared file map. Request revisions to Cursor `cde4a70b515558e80d32c422a85fd9e50529f1c4`, Claude `3e67191cefbc89b732f7cf8c412b3b30e214bc5e`, and Antigravity `d298175f625de94aeedd41a1d86c1f95d5cea268` for the findings above.

Validation performed for this evidence-only review: verified all exported input hashes against the bound manifest, inspected the issue requirements and referenced source/test configuration, and validated this review's required headings and exact pin citations. No product suite was run and no implementation test result is claimed.
