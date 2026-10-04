# Issue 129 — peer plan review

Reviewed bound plans (protocolVersion 1):

- cursor `148a424e454e3c4de6a9fec7d809ad79d94f4e14` — `.plans/issue-129/plan.md`
- claude `885c34bdc34d5f4b3b7e80570ac4008272584a58` — `.plans/issue-129/plan.md`
- codex `5b801354c2cab2ea45a0bde2e773acbfba53f18b` — `.plans/issue-129/plan.md`

All three correctly identify the confirmed defect as a misleading path diagnostic
before wipe, keep genuine `git`-not-on-`PATH` failures out of a blanket
“product not found” rewrite, preserve directory-symlink products, and extend
existing test files rather than inventing new product modules. Differences are
where the guard lives and how wide the file map is.

## Findings

### 1. Codex — putting the directory preflight inside `git()` changes `worktreeRoot`’s contract

**Plan claim (codex Exact File List / Reuse and Scope):** Improve diagnostics at
the shared synchronous `git` boundary by rejecting missing/non-directory cwd
inside `git()` before `spawnSync`, and distinguish PATH/`ENOENT` launch failure
after a recheck.

**Rule:** `worktreeRoot` must keep returning `null` when a path is not a usable
worktree root (callers in `src/workspace.ts`, `src/doctor.ts`, `src/cli.ts`, and
`src/setupWorkspace.ts` branch on `=== null`). `git()` may throw only for true
process-launch failures against a cwd that was already acceptable for spawning.

**Concrete failure if followed as written:** `worktreeRoot` always calls `git()`.
If `git()` throws on a missing or non-directory path, `worktreeRoot` throws
instead of returning `null`. Every null-check call site becomes an unexpected
exception path; doctor/setup/CLI behavior diverges from today’s
“not a worktree” handling; and every other `git()` caller inherits new throw
semantics for path mistakes that used to surface as non-zero Git exits or the
spawn wrapper. That is a cross-cutting contract change larger than issue 129’s
`--product` diagnostic.

**Smallest correction:** Keep `git()`’s spawn-error wrapping unchanged. Put the
directory preflight in `worktreeRoot` / `isGitWorktree` (return `null` /
`false`). Put product-facing “does not exist” / “not a directory” strings in
`resolveWorkspaceFromProduct`. Drop the post-spawn directory recheck and the
`docs/coord-driver.md` edit unless a later amendment asks for operator docs.

### 2. Claude — rejecting all `gitExec` changes leaves the spawn diagnostic in shared discovery helpers

**Plan claim (claude Exact File List / Alternatives Rejected / Reuse and Scope):**
Change only `resolveWorkspaceFromProduct` with `statSync`; leave
`src/gitExec.ts` unchanged; reject guarding `worktreeRoot` / `isGitWorktree`
because an `existsSync`-only guard is incomplete and would turn a missing path
into a misleading “not a Git worktree” message.

**Rule:** The issue’s failure mode is “spawnSync git ENOENT/ENOTDIR for a
non-directory or missing cwd.” Any public helper that still passes such a path
to `spawnSync` as `cwd` can reproduce that message. Rejecting `existsSync`-only
does not justify rejecting a directory check (`statSync`/`isDirectory`) that
returns `null`/`false` without spawning.

**Concrete failure if followed as written:** `--product` through
`resolveWorkspaceFromProduct` is fixed, but `worktreeRoot` /
`isGitWorktree` still call `git()` on a regular file or missing path. A direct
or future caller (and `recordOwnerWorkspace`, which calls `worktreeRoot` with
no directory pre-check) can still emit
`Cannot run git …: spawnSync git ENOENT` / `ENOTDIR`. The Alternatives section
steers the implementer away from the shared-helper fix that would close that
hole while Claude’s own product-layer messages still supply the clear wording.

**Smallest correction:** Keep Claude’s explicit product-path messages and tests;
also add a directory preflight in `worktreeRoot` / `isGitWorktree` that returns
`null` / `false` without spawning (cursor’s approach). Do not change `git()`.

### 3. Cursor — `wipeIssue.ts` is in the change list without a matching test

**Plan claim (cursor Exact File List / Tests):** Tighten `isGitRepo` in
`src/wipeIssue.ts` the same way as the discovery helpers, but the listed tests
only cover `resolveWorkspaceFromProduct` / `worktreeRoot` behavior and one
`wipe-issue --product` CLI case.

**Rule:** Every behavioral edit named in the file map must have a focused test
that fails before the change and passes after it, or the edit must be removed
from scope.

**Concrete failure if followed as written:** An implementer can ship a green
suite while omitting or botching the `isGitRepo` directory check; a regular-file
cwd still reaches `git()` inside wipe helpers with `ENOTDIR`, and nothing in the
proposed cases fails. Conversely, changing wipe without a test invites unrelated
wipe churn under a diagnostic issue.

**Smallest correction:** Either add one assertion that a regular-file path is
not treated as a git repo without a spawn-wrapper error, or drop
`src/wipeIssue.ts` from the file map (acceptable: the reported flow never reaches
`isGitRepo` after a failed product resolve).

### 4. Codex — PATH mutation and docs widen the acceptance surface beyond the defect

**Plan claim (codex Tests / Exact File List):** Temporarily point `process.env.PATH`
at an empty fixture directory inside vitest, and update `docs/coord-driver.md`
with invalid-path / PATH troubleshooting.

**Rule:** Prefer the fewest focused tests and the smallest file map that fully
solves the confirmed diagnostic; avoid process-global env mutation and docs
churn unless they are required to lock the defect.

**Concrete failure if followed as written:** PATH scrubbing reads production
`process.env` (not `runCli` IO), so a leaked or partially restored PATH fails
unrelated tests in the same worker; docs become part of the acceptance surface
for a one-line class of CLI diagnostic. Neither is needed once `git()` is left
alone and product-path messages are asserted.

**Smallest correction:** Rely on “do not catch or remap spawn errors inside
`git()`” plus directory preflight above `git()`; assert missing/non-directory
product messages in `test/workspace.test.ts` and `test/cli.test.ts` only; omit
the PATH-empty case and the docs edit from the first implementation.

## Conclusion

Accept a merge of **cursor’s shared discovery guards** and **claude’s explicit
`resolveWorkspaceFromProduct` messages/tests**; do **not** accept codex’s plan
to rework `git()` or to add PATH/docs scope. Concrete shape:

1. `src/gitExec.ts` — directory preflight on `worktreeRoot` / `isGitWorktree`
   only; `git()` unchanged.
2. `src/workspace.ts` — missing vs non-directory vs non-worktree messages as in
   claude (symlink-to-onboarded success retained).
3. `src/wipeIssue.ts` — optional; include only with a dedicated test, else omit.
4. Tests — extend `test/workspace.test.ts` and `test/cli.test.ts` as claude/cursor
   describe; no new product files; `pnpm check:fast` / `pnpm check`.

All three plans stay inside the issue’s diagnostic defect and reuse existing
fixtures; none justify new source modules. Codex over-scopes the Git boundary;
claude under-scopes shared helpers; cursor is closest but must tie or drop the
wipeIssue edit.
