## Findings

### Claude — `6367a41864df4fd1fbbcce0879939d74abdaa87e`

1. **Reuse and Scope, lines 126–136, excludes coordinator-created worktrees.** Issue 269 explicitly includes those worktrees. `BareMirror.materializeWorktree` creates them from a separate bare repository, so writing both keys in the agent clone leaves a plain commit in the detached checkout using the machine's identity or failing for lack of one. Keep the intentional `COORDINATOR_EVIDENCE_AUTHOR` override and test a separate ordinary commit in a real mirror-linked checkout.

2. **Uninstall, lines 33–37 and 64–70, infers ownership from the account and the shape of the email address.** Cleanup must preserve values the owner supplied. A clone onboarded with 0.0.92 already has `coord.githubAccount`, and the owner may have manually applied the exact SoundSplore workaround. Running the proposed uninstall against that legacy installation deletes both settings even though coord wrote neither. Leave pre-existing author settings alone unless the installer has recorded enough information to distinguish its own changes.

### Antigravity — `c308aacb18113fd52084f8fb64c19d0161c99c61`

3. **Mirror setup, lines 59–64, enables `extensions.worktreeConfig` with `core.bare=true` still in the shared config.** The mirror must remain bare and its linked directories must remain usable working trees. In a disposable bare repository on Git 2.54.0, both proposed author writes succeeded, but `rev-parse --is-inside-work-tree` changed from `true` to `false` in the detached checkout. A plain commit then exited 128 with `fatal: this operation must be run in a work tree`. If using the extension, migrate the main repository's `core.bare` and any `core.worktree` settings to the proper scope before exposing linked worktrees to it. Exercise an existing checkout through that migration as well as a newly created one.

4. **Reuse and Scope, line 115, assumes every returned worktree passes through `materializeWorktree`.** Previously created worktrees must acquire the identity on upgrade or repair. In `src/materializedInputs.ts` lines 261–283, an existing checkout at the requested pin bypasses that method. After re-onboarding a 0.0.92 workspace, a resumed issue can return that checkout with the old author settings. Include the reuse path in the file map or apply the repair to existing issue worktrees during onboarding.

5. **Install and schema, lines 19–26 and 39–44, accept a separately supplied name/email pair and require one for a fresh account-bound installation.** The existing account-only setup call must resolve the selected account's identity. An explicit author for account B passes the proposed string checks when installing for account A, while the existing `install({githubAccount: "acct", …})` call fails on first install even with valid credentials. Under Claude's lines 73–81, the same call can succeed with both keys still missing. Resolve the profile once for real account-bound setup and derive the two fields from it.

6. **Preflight, line 69, adds author checks to attach, run and auth status.** A setup change should preserve access to existing authenticated issue sessions. A 0.0.92 clone with the correct token and helper but no local author now fails `preflightIssueGitHub` before `attachIssue` can restore its terminals. Reporting author drift during setup or doctor preserves that recovery path.

### Codex — `f4882fc2ecab6914dd53937b877e8ca29ddb8a5a`

7. **Mirror initialization and repair, lines 10–13 and test 4, change the common author for all issues sharing `mirror.git`.** A checkout for a frozen issue must retain that issue's author. `issueRuntimePaths` places the mirror at workspace scope. In a disposable mirror, changing the common settings from account A to B caused the next commit in A's already-open checkout to record B as both author and committer. Skipping author writes for an ambient issue likewise leaves the last bound account effective. Freeze the verified identity with the issue and scope it to that issue's worktrees. Test an A checkout again after creating a B or ambient checkout.

8. **The CLI test update on line 15 names only the shared account runner.** Every successful authenticated-user stub must supply the new login and ID. The independent install runners at `test/cli.test.ts` lines 2219 and 2266 each return only `acct`. Following the listed fixture change leaves both installs failing during verification, before either test reaches its dry-run or repair assertion. Update those two responses as part of the same change.

### Focused verification

9. **Claude's Tests line 169 and Antigravity's Tests line 152 use the default Vitest configuration for install and CLI cases.** The proposed development command must collect the regression being investigated. `vitest.config.ts` excludes both suites. A run that also selects `test/githubAuth.test.ts` can pass with neither install nor CLI assertions executed. Run those two files with `pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts test/cli.test.ts`. For commit-header assertions, the shared fixture's `git` and `tryGit` inject a synthetic author and committer. Use an identity-clean Git invocation for the commit under test.

## Conclusion

Revise before implementation. All three plans reuse the authenticated user lookup, existing clone wiring and test fixtures, and none needs a new source file or dependency. Claude's clone changes cover the smallest surface but omit an explicit acceptance case. Antigravity's frozen issue identity addresses account isolation, but its Git migration breaks commits and its preflight gates expand the issue into authentication and recovery. Codex exercises actual commit headers and covers repair, but its shared mirror setting changes attribution for existing checkouts.

Use a plain commit in an agent clone and in a coordinator-created worktree as the acceptance checks. Verify both headers again in the first worktree after a second account is bound, exercise a reused legacy worktree, and retain the existing ballot-author regression.
