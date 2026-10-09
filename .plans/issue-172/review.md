# Plan Review: Issue 172 (coord manual issues)

## Findings

This review evaluates the following bound implementation plans:
- Cursor plan at commit `cde4a70b515558e80d32c422a85fd9e50529f1c4` (`.plans/issue-172/plan.md`)
- Codex plan at commit `be4b37b973bb3420d44cbe41f7238d9c1c167a05` (`.plans/issue-172/plan.md`)
- Claude plan at commit `3e67191cefbc89b732f7cf8c412b3b30e214bc5e` (`.plans/issue-172/plan.md`)
- Antigravity plan at commit `d298175f625de94aeedd41a1d86c1f95d5cea268` (`.plans/issue-172/plan.md`)

### Finding 1 (Codex plan `be4b37b973bb3420d44cbe41f7238d9c1c167a05`: Status report framing dismissed as already satisfied)
- **Plan claim or section**: Codex plan (`be4b37b973bb3420d44cbe41f7238d9c1c167a05`), section "Existing behavior to retain":
  > "`renderIssueReport` in `src/issueReport.ts` already wraps the whole report in `----` lines. `test/issueReport.test.ts` already asserts both boundaries, and both `coord status` and interactive `s` call that renderer. This satisfies the status-separation request at the baseline; keep those assertions and run that existing test file rather than introducing another report renderer."
- **Rule that must hold**: The coordinator's status output must have unmistakable, unambiguous boundaries when rendered in owner terminals or interactive sessions, distinct from ordinary diff markers or log dividers.
- **Concrete failure**: Issue 172 was opened specifically because the existing four-hyphen divider (`----`) blends into terminal output and command transcripts ("FOr the UI, there should be clear separation when the owner runs the status command, so we know where the status reports starts and stops"). If the plan retains bare `----` delimiters without change, the owner's reported UI ambiguity remains completely unaddressed in production runs.
- **Smallest correction**: In `src/issueReport.ts`, replace the bare `"----"` boundaries in `renderIssueReport` with distinct, labeled header and footer lines such as `==== coord status: issue <N> ====` and `==== end coord status: issue <N> ====`, and update boundary assertions in `test/issueReport.test.ts`.

### Finding 2 (Codex plan `be4b37b973bb3420d44cbe41f7238d9c1c167a05`: Subprocess CLI context query invoked inside git wrapper shim)
- **Plan claim or section**: Codex plan (`be4b37b973bb3420d44cbe41f7238d9c1c167a05`), section "1. Validate automation context and remove stale manual context":
  > "Expose this resolver through a small internal CLI context-query mode for the generated shim, using the clone's existing `coord.cliEntry` and the real Git path. Return data, never shell source to evaluate."
- **Rule that must hold**: The git wrapper shim (`.coord/bin/git`) sits on the critical execution path of every git invocation in an agent clone. It must execute with negligible overhead and must not create circular process dependencies or performance regressions.
- **Concrete failure**: Spawning a Node.js process (`coord.cliEntry`) from inside `.coord/bin/git` on every git command introduces 100–300ms of startup latency per git invocation. In git-heavy operations (status, diffs, pre-commit checks, hook chains), this overhead compounds rapidly, causing tool call timeouts. Furthermore, invoking coord from inside git wrapper shims creates risk of recursive invocation loops when coord internals call git.
- **Smallest correction**: Keep the git wrapper shim's staleness detection in lightweight shell logic (checking `COORD_MANUAL=1` and whether the issue runtime exists and is completed/abandoned), while keeping rich session and lifecycle validation in `src/shellGuard.ts` for native tool calls.

### Finding 3 (Cursor plan `cde4a70b515558e80d32c422a85fd9e50529f1c4`: External CLI `coord nudge` command accessing in-memory run loop)
- **Plan claim or section**: Cursor plan (`cde4a70b515558e80d32c422a85fd9e50529f1c4`), section "Exact File List to be changed or deleted" and "Tests":
  > "`src/cli.ts` — (5) add `coord nudge [--agent <id>|--all]` that reuses `CoordinatorRunLoop.reminders()` / nudge delivery;"
- **Rule that must hold**: Coordination reminder state (captured action IDs, four-send limits, hold tracking, reminder timeouts) lives inside the running `CoordinatorRunLoop` instance in memory. Out-of-process commands cannot manipulate active run loop state without inter-process communication.
- **Concrete failure**: Running `coord nudge` as a separate CLI process cannot access the in-memory `CoordinatorRunLoop.reminders()` instance of a currently running coordinator. If it attempts to bypass the run loop and write directly or inject tmux keystrokes from the outside, it circumvents safety rate limits, send budget enforcement, and hold verification, risking runaway loops and uncoordinated state mutation.
- **Smallest correction**: Keep reminder controls within the existing interactive session (`n` key in `src/interactive.ts`), extending the interactive menu with an "All agents" choice that iterates over all currently pending reminders in-process.

### Finding 4 (Cursor plan `cde4a70b515558e80d32c422a85fd9e50529f1c4`: Spurious Codex app-server daemon restart logic)
- **Plan claim or section**: Cursor plan (`cde4a70b515558e80d32c422a85fd9e50529f1c4`), section "Exact File List to be changed or deleted" and "Exact file list to be created":
  > "`src/codexQuota.ts` (or the smallest existing Codex helper already used for app-server) — add a focused "stop leftover app-server for this agent home" helper reused by coord manual / issue start... if a split is required, the single new file is `src/codexAppServer.ts`"
- **Rule that must hold**: Code modifications must be strictly necessary and stay within the issue scope without re-solving already-resolved problems or creating speculative abstractions.
- **Concrete failure**: Issue 186 already resolved Codex app-server daemon context leakage at baseline `80a3e714afda3c63bc89726d77a0cd61aee08b17` by launching Codex with `--no-daemon` in `scripts/lib/launcher.sh` (commit `edab4cb`). Codex instances spawned by coord run isolated and do not consult a shared background app-server daemon. Adding process killing or restarting logic in `src/codexQuota.ts` or a new `src/codexAppServer.ts` adds dead complexity, risks terminating unrelated user Codex processes outside coord, and violates the rule to make the smallest change that fully solves the issue.
- **Smallest correction**: Remove `src/codexAppServer.ts` and app-server termination helpers from the plan, and rely on the verified `--no-daemon` flag already present in `scripts/lib/launcher.sh`.

### Finding 5 (Claude plan `3e67191cefbc89b732f7cf8c412b3b30e214bc5e`: Missing TypeScript session binding validation in native shell guard)
- **Plan claim or section**: Claude plan (`3e67191cefbc89b732f7cf8c412b3b30e214bc5e`), section "Exact File List to be changed or deleted" under `scripts/lib/launcher.sh`:
  > "The native guard (`guardShellRequest`) already consults this shim with `COORD_GIT_POLICY_CHECK=1`, so it inherits the same policy with no TS change."
- **Rule that must hold**: The native shell tool guard (`src/shellGuard.ts`) must detect stale session bindings when vendor requests provide session identifiers (`request.sessionId`), ensuring that owner-directed work or new sessions are not blocked by an inherited `COORD_ISSUE` environment variable.
- **Concrete failure**: Claude's plan alters only `scripts/lib/launcher.sh` to check if `cursors.json` contains `"completed": true` or `"abandoned": true`. However, when an automated issue is still active but an agent's harness has been restarted or superseded (meaning `request.sessionId` is retired or does not match `entry.sessionId` in `readAgentLifecycle`), `cursors.json` is neither completed nor abandoned. Under Claude's plan, `guardShellRequest` in `src/shellGuard.ts` will continue to treat the new or owner-directed session as part of the automated issue and deny git status/diff calls.
- **Smallest correction**: Update `guardShellRequest` in `src/shellGuard.ts` to inspect `request.sessionId` against `readAgentLifecycle(paths)` and allow requests if `request.sessionId` is retired or does not match the active session binding.

## Conclusion

All four plans correctly identify the necessity of adding `.pnpm-store/` to `.gitignore` and `DEFAULT_CLONE_IGNORES`, clarifying start-time refusal advice to point at `coord reset-clones <issue> --force` when uncommitted changes are untracked junk, and ensuring that detaching manual mode returns published, clean clones to base while refusing to discard unpushed or uncommitted work.

However, significant differences emerge in execution:
- **Codex (`be4b37b973bb3420d44cbe41f7238d9c1c167a05`)** overcomplicates the git shim by proposing a Node.js CLI subprocess query on every git command (Finding 2), while mistakenly declining to improve the status frame because `----` was already present (Finding 1).
- **Cursor (`cde4a70b515558e80d32c422a85fd9e50529f1c4`)** attempts to introduce an out-of-process `coord nudge` CLI command that cannot safely communicate with the running run loop (Finding 3), and introduces unnecessary Codex app-server termination code for an issue already solved by `--no-daemon` in issue 186 (Finding 4).
- **Claude (`3e67191cefbc89b732f7cf8c412b3b30e214bc5e`)** provides a well-structured plan with excellent clone-readiness and tmux placement diagnostics, but under-specifies native guard changes in `src/shellGuard.ts` by assuming the bash shim alone can detect all stale session bindings without checking `readAgentLifecycle` (Finding 5).
- **Antigravity (`d298175f625de94aeedd41a1d86c1f95d5cea268`)** keeps changes strictly scoped to existing files without speculative commands or processes, validates session bindings directly in `src/shellGuard.ts` using lifecycle and cursors state, handles `.pnpm-store/`, and implements safe clone base restoration and clear start-time refusal guidance.

The ideal implementation combines:
1. Clear, distinct status report framing in `src/issueReport.ts` (as in Claude `3e67191cefbc89b732f7cf8c412b3b30e214bc5e` and Antigravity `d298175f625de94aeedd41a1d86c1f95d5cea268`).
2. Adding `.pnpm-store/` to `.gitignore` and `DEFAULT_CLONE_IGNORES`.
3. Safe clone base-readiness restoration on `coord detach manual` (and `coord manual --done`), refusing when scratch branches have unpushed commits or uncommitted changes.
4. Accurate start-time refusal in `src/prepareAgentBranch.ts` advising `coord reset-clones <issue> --force` for untracked junk.
5. In-process "All agents" bulk option on interactive `n` without out-of-process CLI commands.
6. Robust stale session binding detection combining shell shim passthrough for `COORD_MANUAL=1`/missing runtime with TypeScript lifecycle checks in `src/shellGuard.ts`.
