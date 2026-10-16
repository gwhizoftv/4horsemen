# Issue 231 plan — discover the shared branch from GitHub's default branch

## Problem

`install()` resolves the shared branch as `options.baseBranch ?? "main"`, and
`coord onboard` never passes one. That single value feeds everything the issue
names: the workspace `config.json` `baseBranch` (via `buildWorkspaceConfig`),
each agent clone's `.git/config` `consensus.sharedBranch` (via
`configureCloneIdentity`), the generated launcher, and the clone checkout. A
repository whose GitHub default branch is, say, `release/alpha` is therefore
onboarded against `main`. A re-install without `--base-branch` also silently
resets a previously chosen branch back to `main`.

The fix: before `install()`/`onboard()` run, the CLI asks GitHub for the
repository's `default_branch` and passes it in as `baseBranch`. Nothing
downstream changes, because every consumer already reads that one value.

Precedence, highest first:

1. explicit `--base-branch <branch>` (install already has it; onboard gains it),
   with no GitHub call;
2. GitHub `default_branch` from `gh api repos/<owner>/<repo> --jq .default_branch`,
   run through the workspace's selected GitHub account when there is one;
3. the `baseBranch` already saved in the workspace config (a re-onboard whose
   lookup fails keeps what it had and does not flip back to `main`);
4. `"main"`.

Origins that are not github.com skip step 2 without comment. When the lookup
fails for a GitHub origin (offline, gh missing, auth or access error, empty
answer), the CLI prints one warning on stderr naming the repository, the
reason, and `--base-branch`, then continues with steps 3–4. A failed lookup
never blocks onboarding, because onboarding without an account needs no network
today.

## Exact File List to be changed or deleted

- `src/githubIssue.ts` — add exported `fetchGitHubDefaultBranch({ origin, cwd, runner }): Promise<string>`.
  It resolves the repository with the existing `githubRepositoryFromOrigin`
  (and throws when that returns null), runs
  `["gh", "api", "repos/<repository>", "--jq", ".default_branch"]` through the
  supplied `CommandRunner`, and returns the trimmed branch. It throws an
  `Error` naming the repository when the runner throws, exits non-zero (the
  message carries the first stderr line), or answers empty or whitespace-bearing
  output. This follows the error style of the existing `fetchGitHubIssue` in the
  same module.
- `src/cli.ts`:
  - add a local `discoverBaseBranch(productRoot, origin, account)` helper next to
    `verifyInstallAccount`. It takes the remote from `origin ??
    localConfigGet(productRoot, "remote.origin.url")` and returns `undefined`
    when there is no remote or `githubRepositoryFromOrigin` returns null.
    Otherwise it calls `fetchGitHubDefaultBranch` with
    `withGitHubAccount(runner, account ?? null)`, logs
    `GitHub default branch for <repo>: <branch>` on stdout, and returns the
    branch. On any error it writes the single fallback warning to stderr and
    returns `undefined`.
  - `onboard`: allow a `base-branch` flag. When the flag is absent, call
    `discoverBaseBranch` after the existing account verification and pass the
    result to `onboard({... baseBranch })`.
  - `install`: when `--base-branch` is absent, call `discoverBaseBranch(installProduct,
    parsed.flags.get("origin"), effectiveAccount)` after the existing account
    verification and pass the result as `baseBranch`.
  - help text: add `[--base-branch <branch>]` to the `coord onboard` and
    `coord install` usage lines.
- `src/install.ts`:
  - `OnboardOptions` gains `baseBranch?: string`, which `onboard()` forwards to
    `install()`.
  - `install()` resolves `const baseBranch = options.baseBranch ??
    readPreviousConfig(workspace.configPath)?.baseBranch ?? "main"`. The previous
    config is already read at that point for the GitHub account, so it is read
    once and reused for both. The existing `refs/heads/<baseBranch>` check and
    its error message stay as they are.
- `test/githubIssue.test.ts` — new cases for `fetchGitHubDefaultBranch` (see Tests).
- `test/onboard.test.ts`:
  - one new case (see Tests);
  - the module-level `runner` fake answers `gh api … --jq .default_branch` with
    `main`, and every existing `runCli(["onboard", …])` call that currently
    injects no `processRunner` (including the shared `quiet` dependency
    objects) passes `processRunner: runner`. Their origins are fake
    `https://github.com/acme/<name>.git` URLs, so without this they would call
    the real `gh` against a real, possibly existing, repository.
- `test/cli.test.ts` — the `installArgs` callers in "CLI — install, doctor, and
  the hook bridge" inject a fake runner that answers the default-branch lookup
  with `main`, for the same reason (origin `https://github.com/example/myserver.git`).
  The existing `gh(token)` fake in "verifies a saved GitHub account before a
  repair install changes anything" answers `.default_branch` with `main`.
  Without that, its catch-all `example/myserver` reply would become the base
  branch.

No file is deleted.

## Exact file list to be created

None. `.plans/issue-231/plan.md` (this coordination artifact) is the only new
file. Every product change extends an existing module and an existing test
file.

## Reuse and Scope

Reused without change:

- `githubRepositoryFromOrigin` and the `CommandRunner` type (githubIssue module)
  for repository parsing and the runner contract. `fetchGitHubIssue` there is
  the error-message pattern.
- `withGitHubAccount` (githubAuth module) binds the lookup to the workspace's
  selected account, as every other gh call already is. `verifyInstallAccount`
  and `savedGitHubAccount` keep their current order: account first, then branch.
- `readPreviousConfig` (install module) for the saved `baseBranch` fallback.
- All downstream consumers of `baseBranch` stay untouched:
  `buildWorkspaceConfig`, `configureCloneIdentity` (writes
  `consensus.sharedBranch`), `ensureAgentClone`, `writeAgentLauncher`, and
  `writeProductAgentsProtocol`. They already write the issue's two targets,
  `.git/config` and `config.json`, from this one value, so the issue is solved
  by choosing the value correctly rather than by new writers.
- Test fixtures: `makeProduct`, `ensureBuilt`, `git`, and `repoRoot` from the
  shared workspace fixture; the existing `runner` fake in the onboard test file;
  `installedWorkspace`/`installArgs` in the CLI test file.

Out of scope: moving existing clones that sit on an old branch (the existing
`syncAgentClone` already refuses to switch them and logs why), non-GitHub
hosts, and any change to how issue start resolves `baseBranch` (it reads the
config value this change sets).

## Tests

Each new case fails before the change and passes after it.

1. `test/githubIssue.test.ts`, new `describe("GitHub default branch")`:
   - "reads the default branch of the origin's repository": the runner records
     argv and answers `release/alpha\n`. The case expects the result
     `release/alpha` and argv exactly
     `["gh", "api", "repos/acme/app", "--jq", ".default_branch"]` for origin
     `https://github.com/acme/app.git`, with cwd passed through.
   - "rejects failed, empty, and non-GitHub lookups": a non-zero exit (stderr
     `HTTP 404: Not Found`) rejects with a message containing `acme/app` and
     `HTTP 404`; an empty stdout rejects; a local-path origin (/tmp/app.git) rejects with no
     runner call.
   Before the change, the import of `fetchGitHubDefaultBranch` fails.
2. `test/onboard.test.ts`, new case "onboards on the GitHub default branch and
   keeps it when a later lookup fails":
   - Set up the `product()` fixture, create a local `release/alpha` branch, and
     set `refs/remotes/origin/release/alpha` to HEAD.
   - Run `runCli(["onboard", productRoot, "--agents", "claude", "--profile",
     "solo"])` with a `processRunner` that answers the default-branch lookup
     with `release/alpha`. Expect exit 0; `readConfig(configPath).baseBranch`
     is `release/alpha`; the claude clone's `consensus.sharedBranch` is
     `release/alpha`; and the clone's current branch is `release/alpha`.
   - Re-onboard with a `processRunner` whose lookup exits 1. Expect exit 0, the
     stderr warning naming `acme/myserver` and `--base-branch`, and `baseBranch`
     still `release/alpha`.
   Before the change, `baseBranch` is `main`, so the first assertion fails.

Existing tests are updated only to inject the fake lookup described in the file
list. Their assertions do not change.

Commands I will run while developing:

- `pnpm exec vitest run --config vitest.config.ts test/githubIssue.test.ts`
- `pnpm exec vitest run --config vitest.system.config.ts test/onboard.test.ts test/cli.test.ts`

The pre-commit hook runs `pnpm check:fast`. The coordinator owns the final
`pnpm run check` at the approved pin.

## Alternatives Rejected

- **`git ls-remote --symref origin HEAD` instead of the GitHub API.** It is
  host-neutral, but the issue asks for the GitHub API. It would also need its
  own credential wiring before any clone exists, and it duplicates the gh
  account binding that `withGitHubAccount` already provides.
- **Making `install()` async and doing the lookup inside it.** `install()` and
  `onboard()` are synchronous and called directly by many tests. Resolving the
  branch in the async CLI layer, exactly where the account is already verified,
  keeps `install()` pure with respect to the network.
- **Failing onboarding when the lookup fails.** Onboarding without a selected
  account needs no network today. Making it fatal would break offline
  re-onboarding and turn a gh outage into a hard stop, where the saved branch
  and an explicit `--base-branch` already give a correct answer.
- **Saved config before GitHub in the precedence order.** Workspaces already
  onboarded against `main`, like the one that motivated this issue, would
  never pick up the real default branch, and neither would a later default
  branch change on GitHub.
- **Reusing `verifyGitHubAccess`'s `repos/<repo>` call to also return
  `default_branch`.** It runs only when an account is selected. Ambient-credential
  workspaces would still get `main`.
- **A documentation update.** No current document states the `main` default.
  The help-text flag lines are the user-visible change.

## Risks and Mitigations

- **Tests calling real `gh`.** Every `runCli` onboard/install path in the test
  suite whose origin is a fake GitHub URL is given an injected runner, as listed
  above. A missed call site would still pass, through the warning-and-fallback
  path. It would not hang on a prompt, because `withGitHubAccount` already sets
  `GH_PROMPT_DISABLED` for account-bound calls, and an ambient `gh api` does
  not prompt.
- **GitHub default branch missing locally.** If the product checkout has no
  local `refs/heads/<default>`, the existing install check throws
  `The product … has no '<branch>' branch.` before any effect. The owner can
  fetch that branch or pass `--base-branch`. This is the same behaviour an
  explicit flag has today.
- **Existing clones on the old branch.** Re-onboarding after the default changes
  updates `config.json` and `consensus.sharedBranch`, but `syncAgentClone`
  deliberately leaves a clone on another branch untouched and logs it. Issue
  preparation already checks clones out from `origin/<baseBranch>` with an
  explicit refspec fetch, so automated issues use the new branch. This change
  does not alter that behaviour.
- **Account-bound lookup when the token is unavailable on a dry run.** The
  lookup's errors are caught and turned into the fallback warning, so a dry run
  never fails because of the branch lookup.
- **Branch names with unusual characters.** The returned name is used only
  where an explicit `--base-branch` value already goes, and the existing
  `rev-parse --verify refs/heads/<branch>` check rejects anything Git does not
  accept.

## Conclusion

The fix resolves the shared branch from GitHub's `default_branch` in the CLI.
An explicit `--base-branch` wins, the saved workspace value is the fallback,
and `main` is last. The result is passed through the existing `baseBranch`
input, so `config.json`, each clone's `consensus.sharedBranch` in
`.git/config`, the launcher, and the clone checkout all follow without new
writers. The change touches three source files (`src/githubIssue.ts`,
`src/cli.ts`, `src/install.ts`) and three existing test files
(`test/githubIssue.test.ts`, `test/onboard.test.ts`, `test/cli.test.ts`). It
adds no new product file and no dependency.
