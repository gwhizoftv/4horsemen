# Issue 231 — discover the shared branch during onboarding

Issue 231 requires onboarding to read the GitHub repository's default branch and persist it in the runtime configuration and agent Git configuration. The current installer selects `options.baseBranch ?? "main"`; the existing downstream wiring already writes that value to runtime `baseBranch`, clone-local `consensus.sharedBranch`, and generated launchers. For a repository whose default is `release/alpha`, those consumers must all receive `release/alpha`.

The issue snapshot is the coordinator's issue-231 github-issue.json; the baseline is `884df5fe1200f1cfbd3cecae887488d8c376fdf9`. GitHub documents repository metadata, including `default_branch`, in [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository).

## Exact File List to be changed or deleted

1. `src/githubIssue.ts` — add a small asynchronous repository-default-branch reader beside the existing GitHub metadata helpers. Reuse `githubRepositoryFromOrigin` and `CommandRunner`; invoke `gh api repos/<owner>/<repo>` with argv, parse the JSON response, and require a nonempty string `default_branch`. Reject missing, null, whitespace-padded, multiline, or malformed values and failed/thrown commands with an actionable lookup error. Accept additional repository response fields. Return no discovery result for unsupported/non-GitHub origins without invoking gh. Keep issue-snapshot behavior unchanged.
2. `src/cli.ts` — resolve the effective origin and shared branch in both `onboard` and `install` command handlers, before calling the synchronous installer. Add `--base-branch` to onboard's accepted options and document the flag for both commands in help. Use the existing account selection/preflight and injected `processRunner`; bind discovery with `withGitHubAccount` using the effective explicit or saved account, or ambient credentials when none is selected. Apply a bounded 30-second timeout to the metadata call through the existing runner options. Honor install's `--origin` when identifying the repository. Pass the single resolved branch into installation rather than independently resolving it downstream.
3. `src/install.ts` — add optional `baseBranch` to `OnboardOptions` and forward it into `install`. Validate the effective branch with Git's branch-name validation before clone/config writes. Replace the local-branch-only preflight with acceptance of either a local branch commit or the corresponding `refs/remotes/origin/<branch>` commit. A product checked out on a feature branch may already have the correct remote-tracking default without a local branch of that name. If neither ref exists, give an actionable fetch/create-branch error naming the selected branch; do not switch or reset the owner checkout. Keep synchronous install/onboard APIs: CLI callers supply discovery results, and embedded callers can supply the same explicit branch. Their omitted-branch compatibility default remains `main`.
4. `test/githubIssue.test.ts` — extend the existing metadata helper tests with repository-default success and invalid/unavailable response cases, using injected runners.
5. `test/onboard.test.ts` — add the end-to-end CLI onboarding regression for a non-main default and refresh behavior. Adapt the existing GitHub-origin fixture calls to inject deterministic metadata responses, including tests with a restricted PATH, so the suite never queries real GitHub.
6. `test/cli.test.ts` — cover install command routing, explicit override, selected-account discovery, dry-run, and failure-before-install behavior. Update existing GitHub-origin installer runners to distinguish repository metadata from account verification and issue lookups instead of using real gh or returning unrelated canned values.
7. `test/install.test.ts` — extend existing installer fixture tests to cover a supplied slash-containing branch available only as an origin tracking ref, branch validation, and the actionable missing-ref error. Assert actual runtime and clone-local configuration values.
8. `docs/setup-workspace.md` — explain GitHub default discovery, the existing configuration keys it fills, `--base-branch`, lookup-error recovery, re-onboarding, non-GitHub fallback, and dry-run behavior next to onboarding instructions.

No files are deleted.

## Exact file list to be created

No product or test files are created. This plan is the only new coordination artifact. The implementation fits the existing metadata, CLI, installer, documentation, and test modules; it needs no new dependency or configuration schema.

## Reuse and Scope

Reuse `githubRepositoryFromOrigin` for the already supported github.com HTTPS, username-bearing HTTPS, and scp-style SSH origins. Reuse `withGitHubAccount`, `resolveGitHubToken`, `savedGitHubAccount`, and `verifyInstallAccount` so the metadata request uses the workspace's selected identity without changing gh's active account or persisting a token. A selected account retains the existing HTTPS-only Git origin requirement.

The branch selection rule for the two CLI commands is explicit `--base-branch` first; otherwise GitHub's current `default_branch` for a supported GitHub origin; otherwise the existing `main` default for a non-GitHub origin. An explicit branch skips default-branch discovery, but does not bypass existing account verification. GitHub lookup failure is an error, not permission to silently select `main` or a stale saved value. Re-onboarding without an override refreshes the default from GitHub; owners choosing a different shared branch pass the override on subsequent setup runs too. Schema defaults for existing configs and already-running issue snapshots stay unchanged.

Reuse `buildWorkspaceConfig`, `writeWorkspaceConfig`, `configureCloneIdentity`, `ensureAgentClone`, and `writeAgentLauncher` without changing their implementations. They already distribute one `baseBranch` value to the required destinations. Here, “.git/config” means each agent clone's existing local `consensus.sharedBranch`; the owner's product checkout retains its existing workspace locator and normal Git behavior. Do not introduce `init.defaultBranch`, rewrite `origin/HEAD`, or alter global Git configuration. Existing agent clones on working branches remain on those branches; setup refreshes their managed configuration and launcher without resetting work.

Dry-run performs read-only GitHub discovery unless an explicit branch bypasses it, then uses the existing effect suppression. It may therefore require working gh credentials, but creates no clones or runtime configuration. Log the chosen shared branch and whether it was explicit, discovered, or the non-GitHub compatibility default.

Reuse `makeProduct`, `ensureBuilt`, `git`, `tryGit`, `writeDeclaration`, existing per-file `product`/`installedWorkspace` helpers, and runner stubs. Build the slash-branch fixture with the existing local bare origin before assigning a fake GitHub URL. Keep fake GitHub calls injected and clone seeding local. No new fixture framework, asynchronous installer conversion, repository-URL expansion, branch renaming, hook changes, or version bump is needed.

## Tests

Add the smallest grouped regressions to the existing files:

- Metadata reader: a table of supported GitHub origin forms returns the exact `release/alpha` value and calls the origin's repository endpoint, independent of cwd. A non-GitHub origin makes no API call. A parameterized error table covers unavailable gh/thrown runner, nonzero API response, malformed JSON, and missing/null/blank/multiline branch values. These are tests of the new helper in `test/githubIssue.test.ts`.
- Onboarding: prepare an origin tracking `release/alpha` with no local `main` or local `release/alpha`, while the owner's HEAD remains on a feature branch. Return `release/alpha` from the injected API and assert success, runtime `baseBranch`, clone `consensus.sharedBranch`, clone branch/commit, and launcher branch all agree. Assert the owner's HEAD and tracked tree are unchanged. Re-onboard with a changed GitHub default while the agent clone is on a working branch; assert configuration/launcher refresh and preservation of its HEAD and work. These extend `test/onboard.test.ts`; the first case currently fails on the missing-main preflight.
- CLI routing: parameterize onboard/install explicit override and assert the metadata endpoint is not called. Cover install's `--origin`, a saved selected account with a conflicting ambient token, discovery failure leaving clone/config outputs absent or existing bytes unchanged, and dry-run discovery with no writes. Assert the discovery request actually receives the selected account token. Group these cases in `test/cli.test.ts`; override and automatic non-main persistence fail before the change.
- Installer preflight: in `test/install.test.ts`, verify a supplied branch with only an origin tracking commit succeeds without creating an owner branch; invalid branch names and a branch absent from both ref namespaces fail before clone/config writes. Preserve the existing local-origin `main`, idempotence, dirty-clone, and no-product-change coverage rather than duplicating it.

Focused implementation commands, using the repository's actual Vitest tiers:

```sh
pnpm exec vitest run --config vitest.config.ts test/githubIssue.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts test/cli.test.ts test/install.test.ts
```

This plan publication requires heading, scope, and evidence validation only; no product suite is claimed. For later product commits, let the installed precommit hook own `pnpm check:fast` (lint, typecheck, fast tests, and system tests) rather than duplicating it immediately before committing. Let the installed prepush hook run its declared checks. The current frozen issue start lists the coordinator's final check as `pnpm run check`, which includes build, check:fast, and e2e. The coordinator owns that final result; cite its recorded evidence when available. If a later action changes verification mode, follow that action's responsibility split.

## Alternatives Rejected

- Continuing to infer `main`, the current local branch, or cached `origin/HEAD`: none reliably identifies GitHub's configured default, which is the issue's source of authority.
- Silently falling back after a GitHub error: it could wire a valid but incorrect `main` while appearing successful. Fail with authentication/network recovery guidance and the explicit override instead.
- Duplicating synchronous gh token handling inside installation or converting all synchronous installer callers to promises: the CLI already has an asynchronous, injected, account-aware process boundary. Discover there and pass a resolved value through the existing options.
- Changing all downstream branch consumers or adding another Git config key: the existing runtime and identity wiring already accepts arbitrary branch names and is sufficient once supplied correctly.
- Fetching/resetting the owner's checkout automatically: existing tracking refs can seed agent clones; missing refs should produce a clear owner remedy without expanding onboarding's checkout effects.

## Risks and Mitigations

- Private repositories must use the selected account. Bind the metadata runner exactly like other GitHub calls and assert its environment with an ambient-token conflict fixture; never log tokens.
- Branch names with slashes must survive untouched, while invalid names must not enter Git/config effects. Parse the response as data, pass argv arrays, use Git validation, and cover the real slash-containing example plus malformed inputs.
- Discovery adds a network dependency, including to dry-run. Bound the call, report failure before installation, explain credential recovery and the explicit override, and stub every affected test call.
- A renamed GitHub default might not exist in the local checkout's fetched refs. Accept remote-tracking-only branches; when both local and tracking refs are absent, fail with a fetch remedy. Preserve the existing clone sync rules and all owner/agent working branches.
- Re-onboarding can intentionally refresh a stale configured branch. Document the precedence and require owners with a deliberate alternate shared branch to repeat `--base-branch`; do not change frozen state for issues already started.

## Conclusion

Resolve GitHub's default once at each CLI setup invocation, pass it through the existing installer options, and verify that runtime `baseBranch` and clone-local `consensus.sharedBranch` agree. The implementation is bounded to eight existing files, extends existing tests, preserves account isolation and working checkouts, and needs no new dependency or schema.
