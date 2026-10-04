# Issue 129: Clear diagnostics for missing/non-directory `--product` paths

## Problem

`coord wipe-issue … --product coordinator` (typo for `coordination`) resolves a
nonexistent path and calls `worktreeRoot()` → `git()` with that path as `cwd`.
Node reports `spawnSync git ENOENT` when the `cwd` is missing (and `ENOTDIR`
when it is a regular file), which looks like a broken Git install or corrupted
repo even though discovery never reached wipe effects.

Confirmed still present on `main` at `8392d92`: `worktreeRoot` / `isGitWorktree`
do not verify the path is an existing directory before spawning Git. An
`existsSync`-only guard is incomplete (regular files still yield `ENOTDIR`).
Genuine Git-launch failures (valid directory, `git` absent from `PATH`) must
remain visible as spawn errors.

## Exact File List to be changed or deleted

- `src/gitExec.ts` — before spawning, treat non-directory / missing paths as
  non-worktrees (`worktreeRoot` → `null`, `isGitWorktree` → `false`); leave
  `git()` itself unchanged so real spawn failures still throw
- `src/workspace.ts` — in `resolveWorkspaceFromProduct`, distinguish missing
  path, non-directory, and non-worktree before the existing onboarding checks;
  keep valid directory symlinks working via `statSync` (follows links)
- `src/wipeIssue.ts` — tighten local `isGitRepo` the same way (existing
  `existsSync` allows regular files through to `git()`)
- `test/workspace.test.ts` — product-resolution diagnostics and symlink success
- `test/cli.test.ts` — `wipe-issue` with bad `--product` exits non-zero with a
  clear message and does not mutate fixtures

## Exact file list to be created

- None for implementation. This plan file is the only new path for the planning
  action (`.plans/issue-129/plan.md`).

## Reuse and Scope

Reuse:

- `worktreeRoot` / `isGitWorktree` / `git` in `src/gitExec.ts` — same return
  contracts (`null` / `false` / throw on spawn error); only add a directory
  pre-check
- `resolveWorkspaceFromProduct` and `recordOwnerWorkspace` in `src/workspace.ts`
  — already handle `worktreeRoot === null`; extend the former with explicit
  missing / non-directory messages
- `makeProduct`, `recordOwnerWorkspace`, `runCli` fixtures in
  `test/support/workspaceFixture.ts` and existing suites — extend
  `test/workspace.test.ts` and `test/cli.test.ts` rather than adding a new
  `test/gitExec.test.ts`
- Existing “not onboarded” / config-mismatch errors in
  `resolveWorkspaceFromProduct` — unchanged once the path is a real worktree

New files: none. No new dependencies. No docs or version bump.

Out of scope: proving or disproving historical repository invalidation; changing
wipe semantics for valid onboarded products; rewriting `git()` to remap all
spawn errors.

## Tests

Commands: `pnpm check:fast` before commit; coordinator acceptance uses
`pnpm check`.

Extend `test/workspace.test.ts`:

1. Missing product path → throws a message that the path does not exist (not
   `spawnSync git ENOENT`)
2. Regular-file product path → throws that the path is not a directory (not
   `ENOTDIR` / spawn wrapper)
3. Directory that is not a Git worktree → existing “not a Git worktree” class of
   error (still no spawn wrapper)
4. Symlink to an onboarded product directory → `resolveWorkspaceFromProduct`
   succeeds (same as resolving the real path)
5. `worktreeRoot` / `isGitWorktree` on missing and file paths return `null` /
   `false` without throwing (exercise through workspace helpers or direct import)

Extend `test/cli.test.ts`:

6. `runCli(["wipe-issue", "<n>", "--force", "--product", <missing>], …)` from a
   temp cwd → exit `2`, stderr names the missing/non-directory product path,
   fixture tree contents unchanged (no wipe side effects)

Do not add a PATH-scrubbed Git-absent case unless a tiny `spawnSync` mock is
already easy in-suite; the contract is preserved by not catching errors inside
`git()` after the directory guard.

## Alternatives Rejected

- **`existsSync` only in `worktreeRoot`** — Codex repro showed existing regular
  files still produce `spawnSync git ENOTDIR`; must require a directory
  (`statSync(path).isDirectory()`, which preserves directory symlinks)
- **Map every `git()` spawn error to “product not found”** — `ENOENT` also means
  `git` missing from `PATH` with a valid cwd; that must stay a launch error
- **Catch only in the `wipe-issue` CLI branch** — `resolveStart` /
  `resolveWorkspaceFromProduct` / doctor / clone setup share the same helpers;
  fixing discovery once covers all
- **New abstraction module or large path-validation framework** — a few lines in
  `gitExec.ts` plus clearer messages in `resolveWorkspaceFromProduct` are enough
- **Dismiss the issue title’s invalidation claim as false from these two
  messages alone** — out of scope; this issue’s confirmed defect is the
  diagnostic

## Risks and Mitigations

- **Callers that expected a throw from `worktreeRoot` on a missing path** —
  every production caller already treats `null` as “not a worktree”
  (`workspace.ts`, `doctor.ts`, `cli.ts`, `setupWorkspace.ts`); behavior becomes
  safer, not looser
- **Error-string churn** — no current tests assert the spawn-wrapper text; new
  cases lock the clearer messages
- **Dangling symlinks** — `statSync` fails like a missing path; message should
  say the path does not exist (or is not a usable directory), not imply Git is
  broken
- **`isGitRepo` change in wipe** — only skips spawn for non-directories; real
  repos unchanged

## Conclusion

After this change, a typo’d or non-directory `--product` fails fast with an
explicit path diagnostic and exit `2`, without `spawnSync git ENOENT`/`ENOTDIR`
and without running wipe. Valid directory symlinks to onboarded products keep
working, and a true Git-launch failure on an existing directory still surfaces
as a spawn error from `git()`.
