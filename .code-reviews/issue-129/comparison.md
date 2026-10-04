# Issue 129 — implementation comparison

## Comparison

Reviewed the coordinator-exported source and tests at all three exact pins:

- Claude: `0f04c419068f70d5452d0798423a4ae4548a8665`.
- Cursor: `e329a8706499f95edd3926155924da9cea41fa81`.
- Codex: `95b888dd77a79316d6efaffc43442de19d929fa4`.

**Recommend Codex.** All three fix the reported missing-working-directory error at the shared synchronous Git boundary, including callers such as onboarding that bypass workspace resolution. None changes wipe admission, repository selection, normal Git exit handling, or the hermetic environment. Codex most completely implements the selected plan's diagnostics and non-mutation regression contract.

### Finding

- **Claude — `src/gitExec.ts:18` (P2, diagnostic correctness):** missing paths and paths containing a non-directory component must remain distinguishable. The combined `ENOENT`/`ENOTDIR` branch reports both as “does not exist.” Consequently, passing `<regular-file>/child` as the product path conceals the actual obstruction and gives the same diagnosis as a missing directory, despite the selected plan's explicit distinction. Reproduced directly against the exported implementation using its existing `package.json/child`; Cursor and Codex correctly report “not a directory.” A focused regression can create a regular file and require the non-directory diagnosis from `resolveWorkspaceFromProduct(join(file, "child"))`. This is not evidence of repository mutation.

### Scope, reuse, and coverage

All candidates stay within the same four existing product files: `src/gitExec.ts`, `test/workspace.test.ts`, `test/cli.test.ts`, and `docs/coord-driver.md`. None introduces product files, dependencies, exported abstractions, cleanup-policy changes, or unrelated refactors. Each follows directory symlinks, rechecks the directory after a launch failure, preserves non-ENOENT launch errors, and documents `--product` as a caller-relative filesystem path rather than a registry nickname. The documentation appropriately avoids asserting that the reported errors disprove earlier damage.

- **Claude:** the smallest private helper and shortest CLI regression. Reuses `makeProduct` and the existing locator test. Covers missing/file/dangling paths, absent Git, and successful subdirectory/symlink resolution. Its CLI snapshot checks owner refs, porcelain status, config, and a runtime sentinel, but does not construct or inspect an agent clone or completion mailbox, nor snapshot index/tracked/untracked bytes as required by the selected plan. It also lacks focused permission/race coverage. Its brevity therefore omits meaningful acceptance coverage, rather than merely removing duplication.
- **Cursor:** correctly separates `ENOTDIR` and `ENOENT`. Its private discriminated union plus two helpers is more machinery than the one-helper implementations need, though still confined to this boundary. Reuses the workspace fixture and locator test, but hand-builds the CLI owner/clone fixture instead of extending `makeProduct`. The CLI regression checks both repositories' HEADs, selected file bytes, owner config, runtime/mailbox sentinels, and parent entries; it does not cover staged index bytes, all refs, or agent config. No focused permission/race tests. Importantly, the earlier plan's proposed false-return discovery changes were **not** carried into this implementation; that plan-review concern does not apply to this pin.
- **Codex:** one private helper shared by preflight and recheck, with explicit directory-access checking and a cautious “could not find or launch git” diagnostic retaining the original OS error. Reuses `makeProduct`, fixture Git helpers, runtime/mailbox path builders, and the existing locator test. Adds four grouped workspace cases plus one CLI case: file-component errors, genuine inaccessible paths, disappearance between preflight and spawn, other launch errors, and the common cases covered by peers. The permission test is appropriately skipped for Windows/root; the spawn mock and PATH are restored in `finally`. The CLI fixture includes staged, unstaged, and untracked work in owner and agent repositories, snapshots HEAD/config/index/file bytes and owner/agent/origin refs, and checks runtime/config/mailbox preservation after each failed invocation. These additions are focused on the approved contract rather than speculative features. No blocking defect found in this pin.

### Verification

- Ran each exported pin's complete `workspace.test.ts` plus its new issue-shaped CLI regression through the installed Vitest API, using one worker, the existing setup file, dependency aliases to this clone's installed packages, and disabled result caching. No bound source was modified: Claude **9 passed**, Cursor **9 passed**, Codex **11 passed**; the other 39 CLI cases were deliberately filtered out for each pin.
- Bundled each exported `src/gitExec.ts` and its imports in memory with the installed esbuild, then exercised a missing path and `package.json/child`. All three produce the new missing-path diagnosis; only Claude misclassifies the file-component failure described above.
- During Codex implementation validation, its full focused suite passed **50 tests**, `pnpm check:fast` passed **685 tests**, and `pnpm check` passed **685 fast tests plus 2 e2e tests** (the latter run used the supported two-worker limit). These are Codex results, not claims that the peers' full suites were rerun.
- Reran unmodified `pnpm check:fast` before publishing this comparison: lint, typecheck, and all **685 tests** passed.

The preferred pin fixes the reproduced diagnostic failure and locks down existing pre-wipe refusal. None of these implementations purports to repair unproven historical repository damage.
