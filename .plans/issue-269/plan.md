# Issue 269 — Attribute agent commits to the selected GitHub account

Onboarding SoundSplore with `gwhizofss` should make an ordinary commit record `gwhizofss <155764113+gwhizofss@users.noreply.github.com>` as both author and committer. The source for both fields is the authenticated GitHub user. The repository owner can be an organization or a different user. GitHub matches the email in the commit header to an account. [GitHub commit attribution](https://docs.github.com/en/pull-requests/how-tos/commit-changes/troubleshooting-commits) · [GitHub noreply address format](https://docs.github.com/en/account-and-profile/reference/email-addresses-reference)

## Exact File List to be changed or deleted

- `src/githubAuth.ts` — Have `verifyGitHubAccess` request just `{login,id}` in its existing account-bound `gh api user` call. Validate the canonical login, case-insensitive match to the selection, and positive safe-integer ID. Keep the repository access check and its errors. Return the verified profile through `GitHubAccess`. Define the mapping to Git's name and ID-based noreply address once here.
- `src/cli.ts` — Return the verified profile from `verifyInstallAccount` and pass it through both `onboard` and `install`, including the saved-account repair path. Supply the verified author to `defaultStartEffects` when it initializes the issue mirror. Keep dry-run's existing exemption from credential verification.
- `src/state.ts` — Extend the strict workspace `github` object with an optional verified profile (canonical login and numeric ID). Validate it against the selected account. An existing config containing only `account` must still parse. The profile lets a mirror created after onboarding recover the same identity without another lookup.
- `src/install.ts` — Thread the profile through `OnboardOptions`, `InstallOptions`, the workspace config builder and the per-agent loop. Resolve the effective account once before wiring any clone. Keep the synchronous programmatic entry points usable with an account alone. For a real direct install without a preverified CLI result, resolve the named credential with ambient tokens removed and fetch the authenticated profile once, using the same validation. For dry-run use a matching saved profile if available and defer unresolved values. On repair, refresh the local author pair in an existing workspace mirror as well as in adopted clones. Use the selected flat or nested workspace root, validate the existing mirror path and bare repository, and leave first creation to the runtime.
- `src/setupWorkspace.ts` — Carry the profile through `buildWorkspaceConfig` and `configureCloneIdentity`. Compare and write both `user.name` and `user.email` in local config when a verified profile is available. Reuse the installer’s effect reporting and local Git config operations for both clones and an existing mirror. A rerun repairs either stale field even when `coord.githubAccount` already matches. Keep user-owned author keys out of the unconditional uninstall key list.
- `src/mirror.ts` — Let `BareMirror.initialize` apply the supplied author to the bare repository's local config after either creating or reopening it. Cover the current early return after creating the origin. A detached worktree shares this config, including when a previously materialized worktree is reused. [Git worktree configuration](https://git-scm.com/docs/git-worktree#_configuration_file)
- `src/runLoop.ts` — Reuse the workspace config read in `initializeEffects` to pass the saved profile to mirror initialization when its account matches the frozen `start.githubAccount`. Preserve the existing recovery path for older workspaces or an unavailable config. An initialization without a profile leaves any previously installed local author in place.
- `test/githubAuth.test.ts` — Extend the existing login/access test for the ID-bearing response and malformed identity data.
- `test/cli.test.ts` — Update the account runner’s authenticated-user fixture and assert the verified identity reaches start effects.
- `test/onboard.test.ts` — Exercise selected-account onboarding and saved-account repair through `runCli` with a real clone.
- `test/install.test.ts` — Extend the account-bound install/reinstall fixture for direct calls, dry-run and local author settings.
- `test/mirror.test.ts` — Extend the real bare-mirror fixture to verify commit metadata from a detached worktree across mirror creation and repair.
- `README.md` — Update the account-selection paragraph that currently says only the account name is stored. Document the public login/ID, the local author settings, and re-onboarding an older installation.

## Exact file list to be created

None. All implementation changes and regression cases fit existing modules and test suites.

## Reuse and Scope

`withGitHubAccount`, `resolveGitHubToken`, `withoutAmbientTokens` and `githubLoginSchema` already establish which GitHub account answered. Reuse the current CLI verification request for all agents in the workspace. Persist only the public profile in the validated owner config using `writeWorkspaceConfig`. Pass credentials only through the existing subprocess credential mechanism.

`ensureAgentClone` already validates adoption and handles both fresh and existing clones. Apply attribution after adoption through `configureCloneIdentity`, using `act`, `localConfigGet` and `localConfigSet`. Scope writes to managed agent clones and the workspace's own mirror. Keep the product checkout's author settings and the user's global Git configuration intact. For an unbound workspace, skip author writes and preserve existing values. A repeated real install with the same verified values should report no author changes.

`BareMirror.materializeWorktree` serves bound inputs, verification and evidence. Configuring their common repository covers ordinary Git commands in all three. `createEvidenceCommit` deliberately supplies `COORDINATOR_EVIDENCE_AUTHOR` for a coordinator-published ballot. Preserve that explicit override and its existing regression test.

## Tests

1. In `test/githubAuth.test.ts`, extend the existing `fakeRunner` case to supply a canonical login with different capitalization from the selected login and a numeric ID. Check the resulting name and address. Verify a missing or invalid ID fails before clone setup. In `test/cli.test.ts`, extend the existing start/resume test to inspect the author passed to the mirror startup path.
2. In `test/onboard.test.ts`, use the existing product fixture and an injected account-bound runner. Return the SoundSplore account and ID from the user endpoint for a repo with a different owner. After onboarding, verify both clone-local values and the author and committer in an actual agent-branch commit. Assert the product's original local identity survives. Change one clone author field, re-onboard using the saved selection and verify repair. Use the fixture's local origin redirect for subsequent fetches. Run the commit with ambient Git identity overrides removed, since the shared fixture's `git` helper injects a synthetic author.
3. In `test/install.test.ts`, extend `installOnce`'s account-binding case. Exercise the account-only programmatic lookup with a fake `gh`, preserve credential-helper assertions, and check a repeat install is idempotent. Verify dry-run with stale identity leaves the settings intact and add an assertion to the existing unbound install for preservation of a custom local identity. Include an already-created mirror in the repair case.
4. In `test/mirror.test.ts`, use `repository`, `BareMirror.fetchBranch` and `materializeWorktree`. Make a plain detached commit and inspect `%an|%ae|%cn|%ce` with `git log -1`. Change the selected identity on reinitialization and verify an existing linked worktree observes both repaired values. Keep the existing evidence-author regression in `test/ballotPublication.test.ts`.

Run these focused suites during implementation.

```sh
pnpm exec vitest run --config vitest.config.ts test/githubAuth.test.ts test/mirror.test.ts test/ballotPublication.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts test/install.test.ts test/cli.test.ts
```

The issue’s declared product checks are `pnpm run check:fast` at commit, `pnpm run test:e2e` at push and `pnpm run check` at final coordinator verification. For this plan submission, validate the artifact headings, paths and cited issue values.

## Alternatives Rejected

- Hard-coding SoundSplore or deriving an address from the origin owner would misattribute commits for other accounts and organization-owned repositories.
- Setting a global Git identity would let onboarding one workspace change commits in another. Launcher environment variables would miss direct Git commands from a worktree.
- Writing local config in each detached directory would repeatedly modify the same bare repository. The mirror initialization and existing-mirror repair paths cover all linked worktrees without per-worktree configuration.

## Risks and Mitigations

- A failed or mismatched account lookup could pair one account's credentials with another account's author address. Validate the entire profile before setup effects and bind the saved profile to the effective selection. An explicit account switch refreshes both fields.
- Existing workspaces carry only an account name. Read that format, obtain the profile from the existing live verification on real re-onboarding, and update all adopted clones even if their auth wiring is already current. Dry-run must neither guess an ID nor require credentials to preview setup.
- An interrupted setup can leave one field installed. Compare both fields independently on retry, and propagate Git write failures. Keep mirror author updates out of agent-controlled files, use the workspace's contained mirror path, and apply the same check-before-write behavior on repair.

## Conclusion

The acceptance check is the metadata of a new commit. With SoundSplore's account selected, a commit made in an onboarded agent clone and one made in a coordinator-created detached worktree should both carry `gwhizofss <155764113+gwhizofss@users.noreply.github.com>` for author and committer.
