# Plan — issue 129: clear diagnostic for a missing or non-directory `--product`

Baseline: `8392d92d365f298bf9d04dd8d19793705a3ff77e` (0.0.38).

## Problem

`coord wipe-issue 392 --force --product coordinator` (typo for `coordination`)
printed `Cannot run git rev-parse --show-toplevel in …/coordinator: spawnSync git ENOENT`.
`resolveStart()` in `src/cli.ts` resolves `--product` against `io.cwd` and passes
it to `resolveWorkspaceFromProduct()` (`src/workspace.ts:149`), which calls
`worktreeRoot()` → `git(path, …)` with a nonexistent `cwd`. Node reports a
missing `cwd` as `spawnSync git ENOENT` (and a regular file as `ENOTDIR`), so the
message reads like a broken Git install or repository.

The owner review on the issue confirms the CLI rejects these inputs with exit 2
before any wipe effect, so the confirmed defect is the **diagnostic**, not data
loss. The broader "repository invalidated" claim is unproven from this report and
is out of scope for this change; the plan does not claim to disprove it.

Requirements taken from the review:

1. A missing product path (including a dangling symlink) must say the path does
   not exist.
2. An existing non-directory must say it is not a directory (an `existsSync`
   guard alone would still yield `ENOTDIR`).
3. Valid directory symlinks to an onboarded product must keep working.
4. A genuine Git launch failure (`git` absent from `PATH`) must stay visible and
   must not be rewritten as "product not found".
5. The existing "not a Git worktree" and "not onboarded" messages stay as they are.

## Exact File List to be changed or deleted

- `src/workspace.ts` — in `resolveWorkspaceFromProduct`, before calling
  `worktreeRoot`, `statSync(resolve(productOrClone), { throwIfNoEntry: false })`
  (follows symlinks):
  - `undefined` → throw `Product path '<path>' does not exist; pass --product for an onboarded product.`
  - `!isDirectory()` → throw `Product path '<path>' is not a directory; pass --product for an onboarded product.`
  - otherwise continue to the unchanged `worktreeRoot` / onboarding checks.
  Add `statSync` to the existing `node:fs` import. No other function changes.
- `test/workspace.test.ts` — one new `it` in the existing `workspace layout` describe block.
- `test/cli.test.ts` — one new `it` exercising the reported command through `runCli`.

No changes to `src/gitExec.ts`, `src/cli.ts`, `src/wipeIssue.ts`, or any other file.

## Exact file list to be created

- `.plans/issue-129/plan.md` (this plan; coordination artifact only).

No product source or test files are created.

## Reuse and Scope

- Reuse `resolveWorkspaceFromProduct` (`src/workspace.ts`) as the single choke
  point: `resolveStart()` routes every `--product` (and the cwd default) through
  it, so `wipe-issue`, `start`, and the other product-resolved commands all get the
  new diagnostic from one edit.
- Reuse `worktreeRoot` / `git` (`src/gitExec.ts`) unchanged. Leaving `git()`'s
  spawn-error wrapping alone is deliberate: it is what keeps a real
  `git`-not-on-`PATH` `ENOENT` visible (requirement 4), and the new guard only
  runs when the path itself is missing or not a directory, so that case can no
  longer reach `git()` to be misreported.
- Reuse `makeProduct` / `ProductFixture` from `test/support/workspaceFixture.js`
  and the existing `writeConfig` / `recordOwnerWorkspace` helpers in
  `test/workspace.test.ts` to build an onboarded product for the symlink case.
- Reuse `runCli` with an injected `CliIo` (`cwd`, `stdout`, `stderr`) in
  `test/cli.test.ts`, as existing tests there already do.
- Scope exclusions: `isGitWorktree`, `doctor.ts`, `setupWorkspace.ts`,
  `prepareAgentBranch.ts` (which already checks `existsSync` first), and
  `wipeIssue.ts`'s private `isGitRepo` take internally derived paths, not the
  user's `--product` value, so they are not part of the reported defect. No new
  file, abstraction, or dependency is introduced.

## Tests

Both cases fail on the baseline (messages contain `spawnSync git ENOENT` /
`ENOTDIR`) and pass after the change.

1. `test/workspace.test.ts` (join the `workspace layout` describe) —
   "names missing and non-directory product paths before running git":
   - nonexistent path → `toThrow(/does not exist/)` and `not.toThrow(/spawnSync/)`;
   - regular file → `toThrow(/is not a directory/)`;
   - dangling symlink (`symlinkSync` to a missing target) → `toThrow(/does not exist/)`;
   - a symlink to an onboarded `makeProduct` directory (recorded with
     `recordOwnerWorkspace`) → `resolveWorkspaceFromProduct(link).configPath`
     equals the recorded config (requirement 3, regression guard).
2. `test/cli.test.ts` — "wipe-issue reports a missing --product path without
   spawning git": temp dir as `io.cwd`, run
   `runCli(["wipe-issue", "392", "--force", "--product", "coordinator"], { io })`;
   expect exit `2`, stderr containing `does not exist` and the resolved path, no
   `spawnSync`, and the temp dir's entries unchanged afterwards.

Existing cases (`not a Git worktree`, not onboarded, flat/nested resolution) stay
green unchanged. A git-absent-from-`PATH` test is not added: `git()` is untouched,
and `hermeticGitEnv()` makes simulating a missing binary in-process brittle.

Required checks before committing: `pnpm check:fast`. The coordinator runs full
`pnpm check` on the approved commit. No version bump on the issue branch.

## Alternatives Rejected

- **`existsSync` guard inside `worktreeRoot`/`isGitWorktree` (issue comment's
  suggestion).** It still yields `ENOTDIR` for a regular file and silently turns a
  missing path into `null`, producing the misleading "is not a Git worktree"
  message instead of "does not exist".
- **Catch the spawn error in `git()` and translate `ENOENT`.** `ENOENT` also means
  `git` is missing from `PATH`; translating it would misdiagnose that case
  (requirement 4) and change behaviour for every git caller.
- **Validate in `resolveStart()` in `src/cli.ts`.** Works, but would leave
  `resolveWorkspaceFromProduct` (exported and directly tested) with the bad
  message, and the cwd-default path would need the same check twice.
- **Hardening `wipeIssue.ts`'s `isGitRepo` for regular files.** Not reached by
  user input in the reported flow; out of scope.

## Risks and Mitigations

- **Symlinked products break.** `statSync` follows links, so a valid directory
  symlink passes; covered by test 1's symlink-to-onboarded-product assertion.
- **Message changes affect scripts or tests matching old text.** Only the
  previously-crashing inputs get new text; the "not a Git worktree" and onboarding
  messages are untouched, and the existing tests asserting them remain.
- **Permission errors from `statSync`.** `throwIfNoEntry: false` only suppresses
  `ENOENT`; `EACCES` and similar still throw with Node's own path-specific message,
  which is accurate and still exits 2 through the CLI's error handler.
- **Over-reading the issue.** The plan fixes only the confirmed diagnostic and
  states that the repository-invalidation claim remains unproven, matching the
  owner review.

## Conclusion

Add a directory check at the top of `resolveWorkspaceFromProduct` so a missing
`--product` (or dangling symlink) reports "does not exist" and a non-directory
reports "is not a directory", before any Git process is spawned. Git launch errors,
valid directory symlinks, and existing worktree/onboarding diagnostics are
unchanged. One source file and two existing test files change, with two focused
test cases.
