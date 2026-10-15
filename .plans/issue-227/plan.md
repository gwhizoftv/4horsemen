# Issue 227 plan — per-workspace GitHub account for git and gh

## Goal

A workspace config selects one GitHub account (`github.account`). Each run
resolves that account's token from gh's own credential storage
(`gh auth token --hostname github.com --user <account>`). The token then goes to
every git and gh operation coord starts or launches: install/onboard clone
creation and sync, the owner bare mirror, `gh issue`/`gh pr`/`gh api` calls,
`git ls-remote` at start, wipe-issue's `gh api` fallback, and every agent
terminal, including resume, attach and agent restart. Coord never runs
`gh auth switch` to select an account and never writes a token to config,
launchers or git config. When the credential is missing, expired, revoked, or
signed in as a different user, coord stops with an actionable message and does
not fall back to another account. Workspaces with no `github.account` behave
exactly as they do today and keep using ambient gh/git credentials.

Design points (all in the new `src/githubAuth.ts`):

- **Token lookup:** `gh auth token --hostname github.com --user <account>`, with
  `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN` and
  `GITHUB_ENTERPRISE_TOKEN` stripped from the lookup's environment. An ambient
  token then cannot answer for the selected account.
- **gh:** coord-started `gh` processes get `GH_TOKEN=<token>` in their
  environment. The token is resolved per call, so a token replaced by
  `coord auth login` takes effect without restarting the coordinator.
- **git:** an account-aware credential helper.
  - Settings:
    - `credential.https://github.com.helper = ""` resets inherited helpers such
      as osxkeychain or `gh auth git-credential`.
    - `credential.https://github.com.helper = !/usr/bin/env node '<cliEntry>' auth git-credential --account <account>`.
  - Where they apply:
    - Agent clones: persisted in local git config, written by install.
    - Coordinator-side git (mirror, start `ls-remote`, clone creation before
      local config exists): passed as `-c` arguments.
  - Helper behaviour: `get` for `protocol=https`/`host=github.com` prints
    `username=<account>` / `password=<token>`. On lookup failure it prints
    `quit=1` plus the actionable message to stderr, so git never prompts an
    unattended agent for a PAT. `store` and `erase` do nothing.
- **Agent terminals:** the generated launcher reads the clone-local
  `coord.githubAccount`. When it is set, the launcher resolves the token the
  same way at launch time and exports `GH_TOKEN`. If the token cannot be
  resolved, it prints the actionable message and exits 1 before starting the
  harness. Launch, respawn (restart/attach) and manual mode all go through the
  launcher, so all of them re-resolve the token.
- **Verification** (`verifyGitHubAccess`):
  - `gh api user --jq .login` must equal the account (case-insensitive).
  - `gh api repos/<owner>/<repo> --jq .full_name` must succeed.
  - Expired/revoked token (HTTP 401 / "Bad credentials") produces exactly:
    `GitHub authentication for <account> has expired or been revoked.\nRun: coord auth login`.
  - A missing credential produces
    `GitHub authentication for <account> is unavailable.\nRun: coord auth login`.
- **Origin form:** a selected account requires an `https://[user@]github.com/<owner>/<repo>[.git]`
  origin. With an SSH origin, git authenticates with SSH keys and the selection
  could not be enforced, so install refuses that combination with a clear message.
- **Freezing:** the account is frozen into `start.json` (`githubAccount`), like
  `origin`. Resume, attach and the run loop use the account the issue started
  with.

## Exact File List to be changed or deleted

- `src/githubIssue.ts`
  - `githubRepositoryFromOrigin` accepts an optional `user@` userinfo in the
    https form (`https://gwhizofss@github.com/owner/repo(.git)`).
  - The userinfo is ignored for repository identity. The configured account,
    not the URL user, is the authentication choice.
- `src/state.ts`
  - `coordinatorConfigSchema` gains optional
    `github: z.object({ account: githubLoginSchema }).strict()`.
  - `startStateSchema` gains optional `githubAccount`.
  - `githubLoginSchema` is the GitHub login pattern
    `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$`, exported from `src/githubAuth.ts`.
- `src/setupWorkspace.ts`
  - `WorkspaceConfigInput.githubAccount` (`string | null`), emitted by
    `buildWorkspaceConfig` as `github: { account }`.
  - `CloneIdentity.githubAccount`, written as clone-local `coord.githubAccount`
    and added to `IDENTITY_KEYS`, so `clearCloneIdentity` removes it.
  - `ensureAgentClone` takes `gitAuthArgs: readonly string[]` and prepends them
    to its `clone`, `ls-remote` and sync `fetch` invocations.
  - New `configureCloneGitHubCredential(clone, account | null, cliEntry, options)`
    and `clearCloneGitHubCredential(clone, options)`. Each acts only on the
    `credential.https://github.com.helper` values coord owns, identified by the
    `auth git-credential` marker. Configure runs inside `ensureAgentClone`
    right after creation and before an existing clone's sync fetch.
- `src/install.ts`
  - `InstallOptions.githubAccount?: string | null`.
  - When omitted, the previous config's `github.account` is carried forward, so
    a repair run of `coord install` keeps the selection.
  - When an account is set, the https origin form is required (refused before
    any effect). The account goes to `buildWorkspaceConfig`, `ensureAgentClone`
    (as `gitAuthArgs`) and `configureCloneIdentity`.
  - `uninstall` calls `clearCloneGitHubCredential`.
  - `OnboardOptions.githubAccount` is passed through to `install`.
- `src/mirror.ts`
  - `BareMirror` gains an optional fourth constructor parameter
    `auth: { account: string; cliEntry: string } | null`.
  - When it is set, every mirror git invocation is prefixed with the helper
    `-c` arguments.
  - Failure stderr from `fetchBranch` and `GitCommandError` is decorated with
    the actionable auth message when it matches an authentication failure.
- `src/runLoop.ts`
  - The default `BareMirror` is built with `start.githubAccount`.
  - A new `githubRunner = withGitHubAccount(this.processRunner, start.githubAccount)`
    is used for `assessFollowUpIssue` and for the default PR opener and merger.
  - `openDraftPullRequest` and `mergePullRequest` take an optional
    `runner: ProcessRunner = runArgv` second parameter. Product check commands
    keep the unwrapped `processRunner`.
- `src/wipeIssue.ts`: the `gh api -X DELETE` fallback accepts an optional
  `ghEnv` (`NodeJS.ProcessEnv`) that `cli.ts` supplies when the workspace
  selects an account.
- `src/cli.ts`
  - `coord auth status`, `coord auth login`, and the hook-only
    `coord auth git-credential --account <a> <get|store|erase>`. The workspace
    is resolved via the existing `resolveStart` (`--product` / `--config` /
    inferred).
  - `--github-account <name>` on `onboard` and `install`.
  - The onboarding prompt asks once. It runs only when no flag is given, the
    existing config has no selection, and stdin/stdout are TTYs.
    - Choices: the logins from
      `gh auth status --hostname github.com --json hosts`, plus
      "Sign in with another account".
    - The prompt is injectable as `CliDependencies.choose`. It defaults to
      null (no prompt) under Vitest or without a TTY.
  - `verifyGitHubAccess` runs before `install`/`onboard` write anything.
  - `startIssue`:
    - Calls the start preflight before `fetchGitHubIssue`.
    - Passes `withGitHubAccount(runner, account)` to `fetchGitHubIssue` and the
      origin `git ls-remote`.
    - Freezes `githubAccount` in `start.json`.
    - `defaultStartEffects` builds the mirror with the account.
  - `runIssue` and `attachIssue` call the same preflight from `start.json`
    before any loop or terminal effect. This covers `coord <n>` resume,
    `coord run`, `coord resume --run`, `coord attach` and interactive `a`.
  - `wipe-issue` supplies `ghEnv`.
  - Help text and `commandDescriptions` gain the `auth` commands and the flag.
- `scripts/lib/launcher.sh`: `write_launcher` emits the `coord.githubAccount` →
  `GH_TOKEN` block, placed before the harness command. It writes no token into
  the file.
- `README.md`: the Requirements/Quick start text documents
  `--github-account`, `coord auth status` and `coord auth login`.
- Tests extended (details under Tests): `test/githubIssue.test.ts`,
  `test/cli.test.ts`, `test/install.test.ts`, `test/mirror.test.ts`,
  `test/runLoop.test.ts`.

No file is deleted.

## Exact file list to be created

- `src/githubAuth.ts`. The single owner of account-scoped credential logic:
  - `githubLoginSchema` and `GITHUB_HOST`.
  - `coordCliEntry()`: `dist/main.js` resolved from the module location, the
    same entry install records as `cliEntry`.
  - `gitCredentialArgs(account, cliEntry)`: the `-c` pairs.
  - `gitCredentialHelperCommand(account, cliEntry)`.
  - `resolveGitHubToken(account, runner)`: async, with stripped token
    environment.
  - `withGitHubAccount(runner, account | null)`:
    - Identity when the account is null.
    - `gh` argv gets `GH_TOKEN`.
    - `git` argv gets the `-c` credential arguments.
    - Anything else passes through unchanged.
  - `verifyGitHubAccess({ account, origin, runner })`.
  - `assertCloneGitHubWiring(account, clones)`: compares each clone-local
    `coord.githubAccount`.
  - `explainGitHubAuthFailure(account, stderr)`.
  - `gitCredentialResponse(...)`: helper protocol parsing and output.
  - `readGitHubAccounts(runner)`: parses `gh auth status --json hosts` for the
    onboarding choices and the active login.

  **Why a new file:** this logic is shared by `cli.ts`, `install.ts` (through
  cli-supplied values), `runLoop.ts`, `mirror.ts` and the helper command.
  `githubIssue.ts` is issue-snapshot/follow-up parsing, and putting credential
  storage there would mix two concerns that already have separate callers.
- `test/githubAuth.test.ts`. Unit tests for the new module's pure and
  runner-injected functions. **Why a new file:** no existing test file covers a
  module with these responsibilities, and the cases need no fixture repository.

## Reuse and Scope

Reused, not reimplemented:

- `githubRepositoryFromOrigin` (`src/githubIssue.ts`) for repository identity
  in verification, `assessFollowUpIssue`, doctor and wipe. It gets the one
  regex fix.
- `ProcessRunner` / `runArgv` (`src/runLoop.ts`), wrapped by
  `withGitHubAccount`. `hermeticGitEnv` (`src/mirror.ts`) still scrubs git
  redirectors, and the `-c` arguments are argv, not `GIT_CONFIG_*`, so the
  scrub does not remove them.
- `BareMirror` and its `GitRunner` seam (`src/mirror.ts`) for mirror
  credentials. `GitCommandError` and `isTransientGitFailure` are unchanged
  (auth failures stay non-transient).
- `git`, `gitOrThrow`, `localConfigGet`, `localConfigSet`, `localConfigUnset`
  (`src/gitExec.ts`) for clone-local keys. No new git exec helper is needed:
  multi-valued helper writes use `gitOrThrow(clone, "config", "--local", "--add", …)`.
- `configureCloneIdentity`, `clearCloneIdentity` and `IDENTITY_KEYS`
  (`src/setupWorkspace.ts`) for `coord.githubAccount`.
- `ensureAgentClone`, `buildWorkspaceConfig`, `readPreviousConfig`, `install`,
  `onboard` and `uninstall` (`src/install.ts`, `src/setupWorkspace.ts`) for the
  install path.
- `resolveStart`, `parseArgs`, `allowedFlags`, `booleanFlags`, `defaultConfirm`
  (pattern for the default `choose`), `startIssue`, `runIssue`, `attachIssue`
  and `defaultStartEffects` (`src/cli.ts`).
- `write_launcher` (`scripts/lib/launcher.sh`), which already reads clone-local
  keys (`coord.completesRoot`, `coord.workspaceConfig`). `githooks/post-merge`
  regenerates launchers through the same template, so it needs no change.
- Test fixtures:
  - `setup()`, `fakeLoop`, `successfulStartGit` and the `processRunner`
    injection in `test/cli.test.ts`.
  - The install fixtures in `test/install.test.ts`.
  - The fake `GitRunner` pattern in `test/mirror.test.ts`.
  - The existing follow-up verification setup in `test/runLoop.test.ts`.

Scope limits:

- No `gh auth switch` is used to select an account. `coord auth login` restores
  the previously active gh account after an owner-attended `gh auth login`,
  only if login changed it, and says so. That restore is the only time coord
  changes gh's active account.
- No token is stored by coord. gh's keyring entry stays the single store, and
  `coord auth login` replaces it through `gh auth login`.
- SSH origins with a selected account are refused rather than given per-account
  SSH key handling.
- `scripts/bootstrap.sh` (which clones the coordinator source before any
  workspace exists) is unchanged: no workspace selection exists at that point.
- `coord doctor` is unchanged. Account/credential state is reported by
  `coord auth status`, and missing clone wiring is caught by the start/resume
  preflight.

## Tests

Fewest focused tests that fail before the change and pass after it:

1. `test/githubIssue.test.ts` (existing "GitHub issue snapshots" case): add
   assertions that `githubRepositoryFromOrigin("https://gwhizofss@github.com/acme/app.git")`
   and `"https://gwhizofss@github.com/acme/app"` both return `"acme/app"`.
   Today both return null.
2. `test/githubAuth.test.ts` (new):
   - **`withGitHubAccount` wrapping** (one case):
     - `gh` argv gets `GH_TOKEN` from `gh auth token --hostname github.com --user acct`.
     - The lookup runs with ambient `GH_TOKEN`/`GITHUB_TOKEN` removed.
     - `git` argv gets both helper `-c` pairs.
     - A non-gh/git argv and its env pass through unchanged.
     - A null account returns the base runner untouched.
   - **Token failure** (one case): the token lookup fails →
     - the wrapped gh call rejects with
       `GitHub authentication for acct is unavailable.\nRun: coord auth login`;
     - the base runner never receives the gh argv.
   - **`verifyGitHubAccess`** (one case):
     - 401 → the exact "has expired or been revoked" message;
     - login mismatch → mismatch message;
     - repo 404 → access message.
   - **`gitCredentialResponse`** (one case):
     - `get` for https/github.com → `username=acct`/`password=<token>`;
     - lookup failure → `quit=1`;
     - `store`/`erase` and non-github hosts → no output.
3. `test/cli.test.ts`:
   - **`coord start`** with a config carrying `github.account`:
     - (a) A failing token lookup exits non-zero with the actionable message.
       No `gh issue view`, no runtime directory, no `startEffects`.
     - (b) A successful lookup gives `gh issue view` `GH_TOKEN` in env and
       `git ls-remote` the `-c` credential args, and `start.json` records
       `githubAccount`.
   - **`coord auth status`**:
     - Prints account, repository and "authenticated" on success.
     - Exits 1 with the expired message on 401.
     - Without a selection, names `--github-account`.
   - **Resume** (`coord <n>` on existing runtime with `githubAccount`) refuses
     before `makeRunLoop().run` when the lookup fails.
4. `test/install.test.ts`: install with `githubAccount: "acct"` and an
   `https://acct@github.com/example/fixture.git` origin:
   - **Config:** writes `github.account`.
   - **Clones:** each clone gets local `coord.githubAccount=acct` and exactly
     the two coord-owned `credential.https://github.com.helper` values.
   - **Launcher:** contains the `coord.githubAccount` block and no token.
   - **Second install** without the option keeps the selection.
   - **Uninstall** removes both keys.
   - **SSH origin:** the same install with `git@github.com:…` is refused before
     any clone is created.

   A local fixture remote stands in for clone creation. The helper is
   URL-scoped to https://github.com, so no network or gh is needed.
5. `test/mirror.test.ts`: a `BareMirror` constructed with `auth` passes the
   helper `-c` pairs before `--git-dir` on `fetchBranch` and `publishBranch`,
   checked with a capturing fake `GitRunner`. Without `auth` it does not.
6. `test/runLoop.test.ts` (existing follow-up verification setup): with
   `start.githubAccount` set, the follow-up `gh issue view` reaches the
   injected `processRunner` with `GH_TOKEN` in its options env.

Validation: focused `pnpm vitest run` of the touched files while developing.
The pre-commit hook owns `pnpm check:fast` (lint, typecheck, fast + system
tests). The coordinator owns the final `pnpm check`. `pnpm check:docs` covers
the agent-facing language in the launcher and help text changed here.

## Alternatives Rejected

- **`gh auth switch` per run.** It changes gh's shared active account, so two
  concurrent coord processes race on it. The issue rules it out.
- **A per-workspace `GH_CONFIG_DIR`** with a synthetic `hosts.yml`. It depends
  on gh's private config format and keyring key naming, and breaks silently on
  a gh upgrade.
- **Storing a PAT in workspace config, the launcher, or git config.** The issue
  requires the token to stay in Keychain/gh storage. Resolving per call also
  makes `coord auth login` effective without re-onboarding.
- **`gh auth git-credential` as the git helper with `GH_TOKEN` in the
  environment.** The mirror and installer would depend on the caller's
  environment, and an agent process missing `GH_TOKEN` would silently use gh's
  active account. That is exactly the fallback the issue forbids. The
  coord-owned helper is keyed by the explicit `--account`.
- **Persisting the helper in the mirror's git config** instead of `-c`
  arguments. Existing mirrors would need re-initialisation, and a config change
  would leave stale helpers behind. `-c` arguments derived from `start.json`
  apply on every resume.
- **A `.coord/bin/gh` shim** for agents. That is a new installed file type with
  install/uninstall/doctor lifecycle. Exporting `GH_TOKEN` from the launcher
  covers gh with no new artifact, and the launcher already re-runs on every
  restart.
- **Making the account mandatory.** That would break every existing workspace
  on upgrade. With no selection, behaviour stays ambient and unchanged.

## Risks and Mitigations

- **Token exposure in agent environment.**
  - Risk: `GH_TOKEN` is visible to the agent process and its children.
  - Mitigation: that is the issue's chosen mechanism for gh, and it already
    holds for any owner with gh logged in. The token never lands in files,
    tmux session environment, config or argv. It is never passed as an argv
    element, only in env or helper stdout.
- **Inherited credential helpers.**
  - Risk: a global `credential.helper=osxkeychain` could answer with another
    account.
  - Mitigation: the leading empty `credential.https://github.com.helper` resets
    the helper list, and `quit=1` on failure stops further helpers and prompts.
    `GIT_TERMINAL_PROMPT=0` stays set for coordinator git via `hermeticGitEnv`.
    The install test asserts the exact helper values.
- **Ambient `GH_TOKEN` hijacking the lookup.**
  - Risk: an ambient `GH_TOKEN` could answer `gh auth token`.
  - Mitigation: the lookup strips the four token variables, both in
    `resolveGitHubToken` and in the launcher (`env -u …`). Covered by the
    `githubAuth` wrapper test.
- **Token expiring mid-run.**
  - Risk: a long-running coordinator hits an expired token between preflights.
  - Mitigation: the token is resolved per gh call and per helper `get`.
    `explainGitHubAuthFailure` decorates gh/mirror auth failures with
    `Run: coord auth login`, so a refreshed token is picked up on the next
    operation without restart.
- **Account changed mid-issue.**
  - Risk: editing or re-onboarding to a different account while an issue runs.
  - Mitigation: the account is frozen in `start.json`, and the resume preflight
    checks clone wiring against it, failing clearly (`Run: coord onboard …`)
    rather than mixing accounts.
- **Older workspaces.**
  - Risk: clones installed before this change lack wiring.
  - Mitigation: with no `github.account` nothing changes. Once one is selected,
    the start/resume preflight refuses clones whose `coord.githubAccount`
    differs and names `coord onboard <product>` as the fix.
- **`coord auth login` changing the active gh account.**
  - Risk: `gh auth login` makes the new account active.
  - Mitigation: login records the active account first, verifies the new login
    equals the workspace account, and restores the previous active account.
    It refuses (after restoring) when the owner signed in as a different
    account. It is owner-attended only and never runs from the run loop or an
    agent.
- **Helper invocation path.**
  - Risk: the helper must find node and the coordinator.
  - Mitigation: it uses `/usr/bin/env node '<cliEntry>'`, the same form the
    installed agent hooks already use. `cliEntry` is the install-recorded
    `dist/main.js`, re-written by every install.

## Conclusion

The change adds one module (`src/githubAuth.ts`) that resolves the selected
account's token from gh's own credential storage on every use. It applies that
token through three channels: `GH_TOKEN` for gh, an account-keyed git
credential helper for git (local config in agent clones, `-c` arguments for
coordinator git and the mirror), and a launcher-time export for agent
terminals. Onboarding and install save only the account name. Start, resume,
attach and agent restart re-resolve and verify the token, and fail with
`Run: coord auth login` instead of falling back. Two commands are added:
`coord auth status` and `coord auth login`. The origin parser accepts
`https://user@github.com/...`. Existing workspaces without a selection are
unaffected.
