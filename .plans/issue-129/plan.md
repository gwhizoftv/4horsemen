# Issue 129 — fail clearly and without side effects on invalid repository paths

## Exact File List to be changed or deleted

- `src/gitExec.ts`: improve the existing synchronous `git` boundary's working-directory and executable-launch diagnostics. Check that the supplied working directory exists and is a directory before spawning Git. Report a missing directory, a non-directory path, and an inaccessible directory distinctly, including the attempted path. If spawning fails, recheck the directory so a directory removed between preflight and launch is not mislabeled as a missing executable; when the directory remains valid and the launch error is `ENOENT`, identify failure to find/launch `git` through PATH. Preserve other launch errors with their original details. Keep `GitResult`, normal Git exit codes, `gitOrThrow`, and the existing hermetic environment unchanged. This must be read-only validation: no directory creation, fallback cwd, repository initialization, checkout, reset, config repair, or automatic reinstall.
- `test/workspace.test.ts`: extend the existing workspace tests with focused Git/workspace-discovery error coverage and a compatibility assertion for resolving an onboarded repository from a subdirectory or symlink.
- `test/cli.test.ts`: add an end-to-end-through-`runCli` regression for the issue's failed `wipe-issue 392 --force` invocations, including relative `--product` resolution and assertions that failure does not change the surrounding owner repository, agent clone, or runtime.
- `docs/coord-driver.md`: extend the existing product-resolution/owner-reset documentation with the meaning of `--product <path>`, concrete invalid-path diagnostics, and safe troubleshooting. Explain that an existing non-repository parent directory and a nonexistent product path are different failures; neither error by itself proves that a repository was damaged.

No existing files will be deleted. No changes to hooks, branch cleanup policy, installer ownership, config schemas, dependencies, or package version are planned.

## Exact file list to be created

The only new file is this required coordination artifact, `.plans/issue-129/plan.md`. It records the implementation scope and validation contract for the coordinator. No new product source files, test files, fixtures, or dependencies are needed.

## Reuse and Scope

### Evidence and interpretation

The coordinator's `github-issue.json` supplies issue #129's title and two errors: the current directory is not a Git worktree, then `wipe-issue 392 --force --product coordinator` fails with `spawnSync git ENOENT` in a child directory named `coordinator`.

At baseline `8392d92d365f298bf9d04dd8d19793705a3ff77e`, `resolveStart` in `src/cli.ts` resolves `--product` against `io.cwd`, then calls `resolveWorkspaceFromProduct` before entering `wipeIssue`. `worktreeRoot` in `src/gitExec.ts` passes that path straight to `spawnSync`. A missing cwd and a missing Git executable can therefore produce the same misleading launch error. The reported second error is reproduced locally by:

```sh
node dist/main.js wipe-issue 392 --force --product .codex/tmp/issue-129-nonexistent-product
```

This exits 2 with `Cannot run git rev-parse --show-toplevel ... spawnSync git ENOENT`. The supplied path does not exist; this reproduction performs no wipe. The first reported error is already the correct refusal for an existing directory outside a Git worktree. There is no supplied preceding command or evidence demonstrating actual deletion/corruption, so this plan does not invent such a cause or attempt to reconstruct the owner's repositories. Its acceptance boundary is actionable diagnosis plus verified non-mutation on failed workspace selection, not a claim to repair unknown prior damage.

### Existing implementation and fixtures

- Reuse `git`, `gitOrThrow`, `worktreeRoot`, and `GitResult` in `src/gitExec.ts`, and retain `hermeticGitEnv` from `src/mirror.ts`. Keep any small directory-error helper private to `gitExec.ts`; it is justified only to share the pre-spawn and failed-spawn check, not to introduce a general repository-validation layer.
- Reuse `resolveWorkspaceFromProduct`, `recordOwnerWorkspace`, `OWNER_WORKSPACE_CONFIG_KEY`, and the canonical-path ownership check in `src/workspace.ts`. Do not change their locator validation or worktree-discovery semantics: a legitimate product subdirectory or symlink remains usable, and a stale/cross-product locator must still fail closed.
- Reuse `runCli`'s existing error handler and exit code 2, `resolveStart`'s caller-relative path resolution, and its ordering before `wipeIssue`. No CLI control-flow change is needed. In particular, `--force` remains irrelevant to workspace-selection validation and does not authorize guessing another repository.
- Extend `test/workspace.test.ts` using its `writeConfig`, `config`, `roots`, and `products` helpers and `test/support/workspaceFixture.ts`'s `makeProduct`, `git`, and `tryGit`. Extend `test/cli.test.ts` using its existing cleanup lists, IO capture pattern, and product fixtures. Use real isolated temporary repositories/local origins, not the owner's directories or live remote.
- Reuse the existing successful wipe, product-owner-work preservation, AGENTS.md restoration, and clone-readiness tests in `test/wipeIssue.test.ts` and `test/prepareAgentBranch.test.ts` unchanged as safety regression coverage. Those paths are reuse-only, not authorized implementation edits.

## Tests

Add the fewest focused cases, grouped in the existing files:

1. **`test/workspace.test.ts`: directory-versus-executable diagnostics.** Parameterize nonexistent/deleted directory and regular-file paths through the existing Git/workspace helpers. Require the attempted path and a directory-specific explanation, not raw `spawnSync git ENOENT`/`ENOTDIR`. Separately use a valid existing fixture directory with PATH temporarily pointing at an empty fixture directory; require a Git executable/PATH diagnostic rather than a nonexistent-repository diagnostic. Restore the real process environment in `finally` before any fixture teardown (the production helper reads `process.env`, not `runCli`'s injected IO environment). These message assertions fail before the fix. Keep non-ENOENT failures distinguishable instead of returning a fake successful Git result.
2. **`test/cli.test.ts`: issue-shaped refusal without effects.** From an isolated parent directory containing an owner repo, an agent clone, and runtime/mailbox sentinels, invoke `runCli(["wipe-issue", "392", "--force", "--product", ...])` with a missing relative product path and its absolute equivalent. Require exit 2, the fully resolved path and the new directory diagnosis, and no raw spawn error. Include the original no-product/non-worktree-parent refusal as a control. Snapshot and compare repository HEAD/refs, local config, index, tracked/untracked file bytes, and runtime/mailbox sentinels; ensure the missing path was not created and no wipe-success output appeared. Use only fixture repositories/local origins. The directory-message assertions fail on baseline; the preservation assertions lock down the existing pre-wipe ordering.
3. **Extend the existing successful locator test in `test/workspace.test.ts`**, rather than adding a new fixture family, to resolve the same onboarded config from an existing product subdirectory and directory symlink. Keep the existing malformed-config, not-onboarded-worktree, and CLI/installer coverage passing. This guards against accidentally requiring every read-only discovery path to equal the repository root or rejecting symlinked directories.

Commands, using the checked-in scripts/configuration:

```sh
# Focused development feedback:
pnpm exec vitest run --config vitest.config.ts test/workspace.test.ts test/cli.test.ts

# Required before every commit, including coordination artifacts:
pnpm check:fast

# Required implementation validation; also the coordinator's final acceptance suite:
pnpm check
```

Run the new failure-message assertions against the old behavior to establish regression sensitivity, then run the focused suite and both required validation commands after implementation. `pnpm check` performs build, lint, typecheck, fast tests, and e2e; commit hooks alone are not the acceptance criterion.

## Alternatives Rejected

- **Assume ENOENT means Git is uninstalled.** A missing cwd reproduces the exact report even when Git is installed. Diagnose the path before advising a PATH repair.
- **Catch every Git failure and call it “not a repository.”** That would conceal executable, permission, and filesystem failures and could turn operational errors into misleading missing-clone skips. Preserve failed-command behavior and distinguish launch errors.
- **Interpret `--product coordinator` as a project registry alias or search sibling repositories.** The existing contract is a path relative to the caller. Guessing a different target for a destructive command risks the owner's repository; report the actual resolved path instead.
- **Create/re-clone a directory, run `git init`, clear AGENTS.md flags, or reset a repo as recovery.** None is justified by the supplied failure, and these actions could overwrite or invalidate the very work the issue is concerned about. Provide read-only diagnosis only.
- **Rewrite wipe/reset/install safety policy based on the issue title alone.** The shown failure happens before those effects. Broader destructive-operation changes need a concrete failing reproduction and their own reviewed scope, rather than speculative cleanup in this fix.

## Risks and Mitigations

- **Shared Git-boundary behavior:** many callers use `git`. Limit the change to launch/path errors; retain command exit-code handling and environment scrubbing. The full suite exercises installation, doctor, readiness, hooks, and wipe callers.
- **Filesystem races:** a preflight cannot lock a directory into existence. Recheck after a spawn failure, preserve unclassified OS details, and fail without retrying in a different cwd. Do not claim this is a general concurrent-mutation defense.
- **Symlinks and legitimate subdirectories:** use directory semantics that follow symlinks, not an assumption that `.git` must be a directory at the supplied path. Preserve Git's discovery and canonical product ownership checks; add the focused compatibility assertions above.
- **Misdiagnosing permissions as absence:** inspect filesystem error codes rather than using a single `existsSync` boolean for every failure. Distinguish ENOENT/ENOTDIR from access errors and unexpected OS failures.
- **Overstating what the report proves:** document that these errors do not establish prior repository corruption. If the owner supplies a reproducible preceding command that removes or corrupts a repository, stop and request a scope amendment before changing destructive behavior; do not silently expand this plan.

## Conclusion

Fix the reproduced ambiguity at the existing Git execution boundary, verify that invalid product selection cannot enter destructive wipe behavior, and document safe path/PATH troubleshooting. The implementation stays within four existing files, preserves repository-selection and cleanup semantics, adds no dependencies or product files, and must pass `pnpm check:fast` and `pnpm check`.
