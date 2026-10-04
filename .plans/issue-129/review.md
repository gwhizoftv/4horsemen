# Plan review — issue 129

Reviewed pins:

- cursor `148a424e454e3c4de6a9fec7d809ad79d94f4e14` — `.plans/issue-129/plan.md`
- claude `885c34bdc34d5f4b3b7e80570ac4008272584a58` — `.plans/issue-129/plan.md`
- codex `5b801354c2cab2ea45a0bde2e773acbfba53f18b` — `.plans/issue-129/plan.md`

Baseline `8392d92`. All three plans correctly treat the defect as the
misleading diagnostic, not proven repository damage. All three reject a bare
`existsSync` guard (it misses `ENOTDIR`) and reject rewriting every `ENOENT`
as "product not found". They differ on **where** the check goes, and that
decides whether the reported class of input is fixed everywhere.

## Findings

### F1 — claude plan, "Exact File List" (guard only in `resolveWorkspaceFromProduct`)

- **Claim:** One check at the top of `resolveWorkspaceFromProduct` is "the
  single choke point" for user-supplied product paths.
- **Rule:** Every command that takes a user-typed product path must report a
  missing or non-directory path without the raw `spawnSync git ENOENT/ENOTDIR`
  wrapper.
- **Failure as written:** `coord onboard coordinator` (the same typo, on the
  onboarding command) resolves `productRoot` in `src/cli.ts:1116` and calls
  `onboard()` → `requireWorktree()` (`src/install.ts:230`), which calls
  `git(path, "rev-parse", "--show-toplevel")` directly. It never reaches
  `resolveWorkspaceFromProduct`, so the user still sees
  `Cannot run git rev-parse --show-toplevel in …/coordinator: spawnSync git ENOENT`.
  The claim that it is the single choke point is wrong.
- **Correction:** Move the directory pre-check into `git()` in
  `src/gitExec.ts`, as codex proposes (see Conclusion), or also guard
  `requireWorktree`. The `git()` boundary is the smaller and complete choice.

### F2 — cursor plan, "Exact File List" (`worktreeRoot`/`isGitWorktree` return `null`/`false`)

- **Claim:** Making `worktreeRoot`/`isGitWorktree` return `null`/`false` for
  missing or non-directory paths, plus explicit messages in
  `resolveWorkspaceFromProduct`, fixes the defect.
- **Rule:** Same as F1: every user-typed product-path entry point must give the
  path diagnostic.
- **Failure as written:** `requireWorktree` in `src/install.ts` uses neither
  helper; it calls `git()` directly, so `coord onboard <missing>` still prints
  `spawnSync git ENOENT`. The `gitExec` change also duplicates the
  `resolveWorkspaceFromProduct` check without adding coverage for the one
  remaining entry point that needs it. For a missing path, `recordOwnerWorkspace`
  and `setupWorkspace` would now report "is not a Git worktree" /
  "not the root of a git worktree" instead of saying the path does not exist.
  That is the less precise message the issue's review asked to avoid.
- **Correction:** Put the pre-check in `git()`, which every one of these helpers
  and `requireWorktree` already call, and drop the per-helper `null` mapping.

### F3 — cursor plan, `src/wipeIssue.ts` `isGitRepo` tightening

- **Claim:** Tighten `wipeIssue.ts`'s private `isGitRepo` so non-directories
  return `false`.
- **Rule:** Behaviour changes to a destructive command must be within the issue
  and backed by a test that fails before the change.
- **Failure as written:** `isGitRepo` gets only internally derived paths
  (configured clone roots, `productRoot`, the mirror), not the typed
  `--product`. The change does alter `wipe-issue`, though. Today a regular file
  at a configured clone root throws `ENOTDIR` and aborts the wipe. After the
  change, `src/wipeIssue.ts:240` (`if (!isGitRepo(root)) continue;`) silently
  skips that clone and the wipe proceeds. No proposed test covers this (tests
  1–6 never reach `wipeIssue`), so a silent change to a destructive path
  would ship without a test.
- **Correction:** Drop the `wipeIssue.ts` edit. With the check in `git()`, a
  regular file there throws a clear "not a directory" error and still aborts,
  which keeps today's fail-closed behaviour.

### F4 — cursor plan, Tests 3 and 5

- **Claim:** Test 3 (non-worktree directory gives "not a Git worktree") and
  test 5 (helpers return `null`/`false`) are among the new focused cases.
- **Rule:** New tests must fail before the change. Existing behaviour that
  already passes should only be added when it guards a stated regression risk.
- **Failure as written:** Test 3 passes at baseline: the issue's first error is
  exactly that message, and existing suites cover it. Test 5 locks in the
  `null`-mapping contract that F2 recommends against. Together they add
  maintenance without catching the defect.
- **Correction:** Keep tests 1, 2, 4 and 6. Drop 3 and 5, or turn 5 into a
  `git()`-level assertion if the pre-check moves there.

### F5 — codex plan, `docs/coord-driver.md`

- **Claim:** Extend `docs/coord-driver.md` with `--product` semantics and
  troubleshooting.
- **Rule:** Keep to the smallest change that solves the issue, and justify every
  touched path.
- **Failure as written:** The defect is the error text. Once the message names
  the resolved path and says "does not exist"/"is not a directory", it explains
  itself, so the docs edit adds a fourth file and prose review with no test
  behind it. The plan's justification ("neither error by itself proves a
  repository was damaged") is analysis for the issue thread, not product
  documentation.
- **Correction:** Drop the docs file, or justify it with a specific existing
  section that currently gives wrong guidance.

### F6 — codex plan, Tests 2 and 3 (scope of the CLI regression)

- **Claim:** The CLI test snapshots repository HEAD/refs, local config, index,
  tracked/untracked bytes, and runtime/mailbox sentinels, for relative and
  absolute paths plus a control case. Test 3 adds subdirectory resolution.
- **Rule:** Add the fewest focused tests that fail before and pass after.
- **Failure as written:** The plan says the preservation snapshots "lock down
  the existing pre-wipe ordering". They pass at baseline, because
  `resolveStart` already throws before `wipeIssue`. That makes the slowest new
  CLI case mostly a no-op guard: it builds an owner repo, an agent clone, a
  runtime and an origin for every variant, in a suite where long sync tests
  have already caused worker-RPC timeouts (issue 145). Subdirectory resolution
  in test 3 is likewise unchanged behaviour.
- **Correction:** Use one `runCli(["wipe-issue", "392", "--force", "--product",
  "<missing>"])` case: exit 2, resolved path plus "does not exist" in stderr,
  no `spawnSync`, missing path not created. Add a directory-symlink success
  assertion in `test/workspace.test.ts`. Drop the multi-repo byte snapshots
  and the subdirectory case.

### F7 — codex plan, `src/gitExec.ts` "recheck after spawn failure"

- **Claim:** After a spawn error, recheck the directory so a directory removed
  between preflight and spawn is not reported as missing `git`.
- **Rule:** Avoid speculative flexibility; every added branch needs a reason
  from the issue or a test.
- **Failure as written:** No proposed test exercises the race, and the issue
  does not report one. It is harmless, but it is an untested branch in the
  helper every sync git caller goes through.
- **Correction (optional):** Keep the single pre-spawn check. On a spawn
  error, keep today's message (which names `cwd` and the OS error) and add a
  "git could not be launched (check PATH)" hint only for `ENOENT` with a
  directory that passed the pre-check. If the recheck stays, cover it or say in
  a comment that it is best-effort.

### F8 — codex plan, Test 1 PATH manipulation (accepted, with a constraint)

- **Claim:** Simulate Git missing from `PATH` by pointing `process.env.PATH`
  at an empty directory and restoring it in `finally`.
- **Rule:** Tests must not leak process-global state into other cases.
- **Assessment:** It works. `hermeticGitEnv()` copies `process.env`
  (`src/mirror.ts:36`), and `spawnSync` resolves `git` from that `env.PATH`. So
  this is the only plan that actually tests requirement 4 (real launch errors
  stay visible), and that is worth keeping. Constraint: build every fixture
  (`makeProduct` uses `execFileSync("git", …)`) before changing `PATH`, and
  restore it in `finally` before `afterEach` cleanup runs. The plan already
  says so. No change needed beyond following it.

### Scope and reuse summary

- **cursor:** within the issue except the `wipeIssue.ts` edit (F3). It reuses
  existing fixtures and adds no files, but leaves `coord onboard` unfixed (F2).
- **claude:** the smallest plan, reuses existing fixtures, adds no files, but
  misses `coord onboard` (F1).
- **codex:** the right location (`git()`), so it covers onboard, product
  resolution and wipe from one edit. It reuses existing fixtures and adds no
  product files, but the docs edit (F5), the heavy snapshot test (F6) and the
  untested race branch (F7) go beyond the smallest change.

## Conclusion

None of the three plans should be implemented exactly as written.

- **Recommended approach:** codex's location. Add a directory pre-check
  (`statSync`, which follows symlinks) inside `git()` in `src/gitExec.ts`. Throw
  "`<cwd>` does not exist" or "`<cwd>` is not a directory" before spawning. Keep
  real launch errors visible, with a PATH hint for `ENOENT` when the directory is
  valid. This fixes `--product` resolution, `coord onboard`, and every other
  sync-git entry point, with no changes to `workspace.ts`, `wipeIssue.ts`, or
  docs.
- **Tests:** in `test/workspace.test.ts`, cover missing, regular-file and
  dangling-symlink paths plus a valid directory symlink that resolves, and add
  codex's PATH-absent case. In `test/cli.test.ts`, add one issue-shaped
  `wipe-issue --product <missing>` case.
- **Blocking findings:** F1 (claude), F2 and F3 (cursor). Each leaves the
  reported diagnostic unfixed on `coord onboard`, or silently changes
  `wipe-issue` behaviour without a test.
- **Non-blocking trims:** F4, F5, F6, F7.
