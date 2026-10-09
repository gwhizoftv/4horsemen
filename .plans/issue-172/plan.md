# Implementation Plan: coord manual issues (Issue 172)

## Exact File List to be changed or deleted

- `.gitignore`: add `.pnpm-store/` to prevent pnpm store caches from dirtying agent worktrees.
- `src/prepareAgentBranch.ts`: update `prepareAgentIssueBranches` to advise running `coord reset-clones <issue> --force` when uncommitted changes consist only of untracked files; provide branch restoration helpers for manual mode detachment.
- `src/detachIssue.ts`: enhance manual mode teardown to restore clean agent clones to the base branch (`main`) while safely refusing if uncommitted or unpushed work exists on manual scratch branches.
- `src/cli.ts`: integrate clone base-readiness restoration into `coord detach manual`; add `coord manual --done` flag as an alias for detaching and resetting manual mode; update `assertNoManualSession` to detect and safely clean up leftover manual UI when safe.
- `src/shellGuard.ts`: detect stale session bindings, manual mode (`COORD_MANUAL === "1"`), completed/abandoned issues, and mismatched/retired session IDs so owner-directed manual work is not blocked from running `git status`, `git diff`, or `git show`.
- `scripts/lib/launcher.sh`: update the generated git wrapper to immediately delegate `git` calls when `COORD_MANUAL=1` or when the referenced issue runtime directory is absent.
- `test/prepareAgentBranch.test.ts`: add unit tests asserting that `prepareAgentIssueBranches` suggests `coord reset-clones <issue> --force` for untracked junk and `Commit/stash them` for tracked modifications.
- `test/detachIssue.test.ts`: add unit tests asserting that manual detach safely resets clean clones to `main` and refuses when clones have unpushed commits or uncommitted changes.
- `test/cli.test.ts`: add tests covering `coord manual --done` and automatic discovery/cleanup of leftover manual sessions.
- `test/shellGuard.test.ts`: add tests verifying that `guardShellRequest` allows tool requests when in manual mode, when an issue is finished/abandoned, or when session IDs are stale.

## Exact file list to be created

No new files to be created.

## Reuse and Scope

- Reuse `blockingDirtyPaths` and `statusPath` in `src/prepareAgentBranch.ts` to inspect porcelain status lines and classify untracked junk vs tracked modifications.
- Reuse `captureCloneAgentsProtocol`, `liftCloneAgentsProtocol`, and `restoreProtocol` from `src/prepareAgentBranch.ts` to ensure that switching an agent clone back to `main` safely lifts and restores the `AGENTS.md` protocol overlay and `skip-worktree` index bit.
- Reuse `detachIssue`, `ownerTerminalTitlesToClose`, and `filterSessionsForIssue` in `src/detachIssue.ts` for clean UI teardown.
- Reuse `runtimeFor`, `readStartState`, `readCursorsState`, and `readAgentLifecycle` in `src/shellGuard.ts` to inspect issue status and agent lifecycle session records.
- Reuse `workspaceUiIdentity`, `resolvedAgents`, and `resolveStart` in `src/cli.ts`.
- Scope justification: No new abstractions, libraries, or external files are introduced. All enhancements directly address the transition between manual mode (`coord manual`) and automated mode (`coord <issue>`) using existing coordination structures.

## Tests

1. `test/prepareAgentBranch.test.ts`:
   - `it("advises coord reset-clones --force when uncommitted changes are exclusively untracked junk")`: create an agent clone with only untracked files and assert that `prepareAgentIssueBranches` throws an error containing `coord reset-clones <issue> --force`.
   - `it("advises commit/stash when uncommitted changes include tracked modifications")`: create an agent clone with modified tracked files and assert that `prepareAgentIssueBranches` throws an error containing `Commit/stash them`.
2. `test/detachIssue.test.ts`:
   - `it("detaches manual mode and restores clean clones to base branch with protocol intact")`: verify that clones on clean `<agent>/<scratch>` branches are safely checked out on `main` with `AGENTS.md` skip-worktree bit restored.
   - `it("refuses manual clone reset when scratch branches have unpushed commits or uncommitted changes")`: verify that manual detach reports an error and leaves unpushed/uncommitted work intact on the scratch branch.
3. `test/cli.test.ts`:
   - `it("supports coord manual --done as an alias for detaching manual mode")`: verify that `coord manual --done` invokes manual detachment and clone restoration.
   - `it("discovers leftover manual session and auto-cleans when clones are clean before starting issue")`: verify that starting an issue discovers leftover manual UI and proceeds if safe.
4. `test/shellGuard.test.ts`:
   - `it("allows git commands when COORD_MANUAL=1 even if COORD_ISSUE is inherited")`: assert `guardShellRequest` returns `{ decision: "allow" }` (or vendor allow) when `COORD_MANUAL=1`.
   - `it("allows git commands when inherited COORD_ISSUE points to a completed or abandoned issue")`: assert `guardShellRequest` allows commands when `cursors.completed === true`.
   - `it("allows git commands when request sessionId does not match active issue session binding")`: assert `guardShellRequest` allows commands when `request.sessionId` is in `retiredSessionIds` or differs from `entry.sessionId`.

## Alternatives Rejected

- **Auto-discarding unpushed/uncommitted scratch work on manual detach**: Rejected because owner-directed manual work on `<agent>/<name>` scratch branches may represent uncommitted experiments or unpushed commits. Silently discarding or resetting with `git reset --hard` would cause irreversible data loss. Refusing with clear instructions preserves safety.
- **Removing the git command guard altogether**: Rejected because automated issues rely on keeping agent harnesses from performing expensive redundant checkout status/diff scans when coordination has already resolved and exported bound input files.
- **Introducing a daemon process to watch manual sessions**: Rejected because tmux session introspection and git porcelain checks at transition points (`coord start`, `coord detach manual`, `coord manual --done`) provide reliable state without unnecessary background complexity.

## Risks and Mitigations

- **Risk: Breaking `AGENTS.md` skip-worktree during branch switching on manual detach**:
  - *Mitigation*: Never run raw `git checkout` without lifting the protocol first. Use `liftCloneAgentsProtocol` before checkout and `restoreProtocol` in a `finally` block to guarantee the overlay and `skip-worktree` bit are restored even if checkout encounters an error.
- **Risk: False positive refusal when checking if a manual branch is pushed or merged**:
  - *Mitigation*: Inspect both upstream tracking (`@{u}`) and merge ancestry into the base branch (`origin/main` or `main`). If either confirms that work is safely preserved on the remote or merged into the base branch, consider it safe to switch.
- **Risk: Guard latency on shell tool invocations**:
  - *Mitigation*: The checks in `guardShellRequest` for `COORD_MANUAL`, `readCursorsState`, and `readAgentLifecycle` read small JSON files on local disk within existing deadlines, and short-circuit immediately if manual mode or an inactive issue is detected.

## Conclusion

This plan addresses all items from Issue 172 by improving `.gitignore` for package stores, providing safe and automated clone restoration to `main` upon manual mode completion (via `coord detach manual` and `coord manual --done`), enhancing start-time refusal error messages for untracked files, and making the shell tool guard robust against stale session bindings and inherited issue environments.
