# Issue 269 Implementation Plan: Configure Git `user.name` and `user.email` for Selected GitHub Accounts

## Problem Summary

When a workspace selects a GitHub account (`coord onboard ... --github-account <login>` or interactive account selection, or `coord install ... --github-account <login>`), `coord` binds `gh` tokens and Git HTTPS credentials (`coord.githubAccount` and `credential.https://github.com.helper`), but never configures Git's `user.name` or `user.email`. As a result, commits created by agents in agent clones or in coordinator-created worktrees inherit the machine's global Git author (often a different GitHub account), breaking GitHub commit attribution.

For a selected GitHub account whose authenticated `/user` response returns `{ id, login }` (for example `{ id: 155764113, login: "gwhizofss" }`), `coord` must configure:

- `user.name = <login>` (e.g. `gwhizofss`)
- `user.email = <id>+<login>@users.noreply.github.com` (e.g. `155764113+gwhizofss@users.noreply.github.com`)

in every agent clone and in every coordinator-created worktree materialized from the workspace mirror, while leaving unselected (ambient) workspaces and coordinator-authored ballot evidence commits (`COORDINATOR_EVIDENCE_AUTHOR`) untouched.

## Exact File List to be changed or deleted

No files will be deleted. The following existing files will be changed:

1. `src/githubAuth.ts`
   - Export `GitAuthor` (`{ name: string; email: string }`), `gitAuthorSchema` (strict Zod object with single-line non-empty trimmed `name` and whitespace-free non-empty trimmed `email`), `gitHubNoReplyEmail(id: number, login: string): string` returning `` `${id}+${login}@users.noreply.github.com` ``, and `gitHubAccountAuthor(id: number, login: string): GitAuthor` returning `{ name: login, email: gitHubNoReplyEmail(id, login) }`.
   - Extend `GitHubAccess` with `userId: number` and `gitAuthor: GitAuthor`.
   - Update `verifyGitHubAccess` to call `gh api user` (instead of `gh api user --jq .login`), parse JSON safely, preserve the existing HTTP 401/expired and login-mismatch error messages (checking `login.toLowerCase() !== input.account.toLowerCase()` before numeric-id validation), validate positive integer `id` and `githubLoginSchema` for `login`, and return `{ account: input.account, login, userId: id, gitAuthor: gitHubAccountAuthor(id, login), repository }`.

2. `src/state.ts`
   - Import `gitAuthorSchema` from `./githubAuth.js`.
   - Extend `coordinatorConfigSchema.shape.github` to `z.object({ account: githubLoginSchema, gitAuthor: gitAuthorSchema.optional() }).strict().optional()`. Keeping `gitAuthor` optional preserves backward compatibility when reading `config.json` files created by earlier versions (such as coord 0.0.92).
   - Extend `startStateSchema` with `githubAuthor: gitAuthorSchema.optional()` (frozen alongside `githubAccount` at issue start, optional for backward compatibility with older `start.json` files), and refine `startStateSchema` so `githubAuthor` is rejected when `githubAccount` is absent.

3. `src/setupWorkspace.ts`
   - Import `type GitAuthor` from `./githubAuth.js`.
   - Add `githubAuthor?: GitAuthor | null` to `WorkspaceConfigInput` and persist `gitAuthor` inside `github` in `buildWorkspaceConfig` whenever `githubAccount` and `githubAuthor` are both present.
   - Add `githubAuthor: GitAuthor | null` to `CloneIdentity`.
   - In `configureCloneIdentity`: when `identity.githubAuthor !== null`, include `["user.name", identity.githubAuthor.name]` and `["user.email", identity.githubAuthor.email]` in `desired` so local `user.name` and `user.email` are written idempotently on every agent clone (and updated when switching accounts). When `identity.githubAuthor === null`, do not include `user.name` or `user.email` in `desired` so ambient/owner local Git author config is never overwritten or unset.
   - Export `clearCloneGitHubAuthor(clone: string, author: GitAuthor | null | undefined, options: EffectOptions): void` to unset local `user.name` and/or `user.email` on uninstall only when each key's current local value matches what `coord` configured (preserving ambient or owner-customized values, mirroring `clearCloneGitHubCredential`). Do not add `user.name`/`user.email` to `IDENTITY_KEYS`.
   - Extend `cloneGitHubWiringProblem(clone: string, account: string, author?: GitAuthor | null): string | null`: when `author` is provided, also verify `localConfigGet(clone, "user.name") === author.name` and `localConfigGet(clone, "user.email") === author.email`, returning an actionable diagnostic naming the expected author and observed local values when missing or mismatched.

4. `src/install.ts`
   - Import `gitAuthorSchema, type GitAuthor` from `./githubAuth.js` and `clearCloneGitHubAuthor` from `./setupWorkspace.js`.
   - Add `githubAuthor?: GitAuthor` to `InstallOptions` and `OnboardOptions`.
   - In `install()`:
     - Read `previous` once from `workspace.configPath`.
     - Carry forward `previous.github.gitAuthor` only when `githubAccount !== null` and `previous?.github?.account?.toLowerCase() === githubAccount.toLowerCase()` (never carry forward an old account's author when switching to a different `--github-account`).
     - Reject `options.githubAuthor !== undefined && githubAccount === null`.
     - Validate non-null `githubAuthor` with `gitAuthorSchema`.
     - Reject `githubAccount !== null && githubAuthor === null && !options.dryRun` so no non-dry-run install/onboard with a selected GitHub account can succeed without configuring `user.name` and `user.email`. When `options.dryRun` is true and `githubAccount !== null && githubAuthor === null` (e.g. offline dry-run with a brand-new account), log a note that dry-run skips live GitHub author lookup without mutating anything.
     - Pass `githubAuthor` into `buildWorkspaceConfig(...)` and `configureCloneIdentity(...)`.
   - In `uninstall()`: call `clearCloneGitHubAuthor(clone, config.github?.gitAuthor, effects)` next to `clearCloneIdentity` and `clearCloneGitHubCredential`.
   - In `onboard()`: forward `options.githubAuthor` to `install(...)`.

5. `src/doctor.ts`
   - Import `cloneGitHubWiringProblem` from `./setupWorkspace.js`.
   - In `checkClone`: when `input.config.github !== undefined`:
     - If `input.config.github.gitAuthor === undefined`, emit a `DOCTOR_CODES.identity` finding explaining that the workspace selects GitHub account `input.config.github.account` without recorded `user.name`/`user.email`, with remediation to re-run `coord onboard` or `coord install`.
     - Otherwise, call `cloneGitHubWiringProblem(clone, input.config.github.account, input.config.github.gitAuthor)` and emit any returned problem as a `DOCTOR_CODES.identity` finding with remediation to re-run `coord onboard` or `coord install`.

6. `src/mirror.ts`
   - Import `type GitAuthor` from `./githubAuth.js`.
   - Extend `BareMirror`'s `auth` parameter type to `{ account: string; cliEntry: string; gitAuthor?: GitAuthor | null } | null`.
   - Add a private `worktreeGit(target: string, args: readonly string[]): Promise<CommandResult>` helper that invokes `this.runner(["-C", target, ...args])` and throws `GitCommandError` on non-zero exit.
   - In `BareMirror.materializeWorktree(target, sha)`: after `worktree add --detach`, when `this.auth?.gitAuthor` is non-null:
     - Read `--local --get core.repositoryformatversion` on `mirror.git` (allowing failure when unset); if unset or `"0"`, set `--local core.repositoryformatversion 1` (never downgrading higher format versions).
     - Set `--local extensions.worktreeConfig true` on `mirror.git`.
     - Write `--worktree user.name <author.name>` and `--worktree user.email <author.email>` inside `target` via `worktreeGit`.
     - Wrap worktree config writes in `try/catch` that calls `await this.removeWorktree(target)` before rethrowing so failed configuration never leaves a partially wired worktree behind.
     - When `this.auth?.gitAuthor` is null/undefined, write no worktree author config so ambient worktrees never inherit another account's author.

7. `src/cli.ts`
   - Import `type GitAuthor` from `./githubAuth.js`.
   - Add optional `githubAuthor?: GitAuthor | null` to `CliDependencies["startEffects"]` and `defaultStartEffects`, forwarding `gitAuthor` into `new BareMirror(...)`.
   - Update `preflightGitHubAccount` to pass `access.gitAuthor` into `cloneGitHubWiringProblem(agent.root, input.account, access.gitAuthor)` (covering `coord start`, `coord run`, `coord attach`, `coord auth status`, and `coord auth login`).
   - Update `verifyInstallAccount` to return `Promise<GitHubAccess>` instead of `Promise<void>`.
   - In `startIssue`: capture `access = await preflightGitHubAccount(...)`, freeze `githubAuthor: access.gitAuthor` into `initializeOperationalState(...)` (`start.json`), and pass `githubAuthor` into `startEffects(...)`.
   - In `onboard`: capture `githubAccess = await verifyInstallAccount(...)` and forward `githubAuthor: githubAccess.gitAuthor` into `onboard(...)`.
   - In `install`: capture `githubAccess = await verifyInstallAccount(...)` (when `effectiveAccount !== null && !dryRun`) and forward `githubAuthor: githubAccess.gitAuthor` into `install(...)`.

8. `src/runLoop.ts`
   - In `CoordinatorRunLoop`'s constructor when creating the default `BareMirror` from `start`: pass `gitAuthor` from `start.githubAuthor`, with a safe fallback (only when `start.githubAccount !== undefined && start.githubAuthor === undefined` for legacy `start.json` files resumed after re-onboarding) that reads `readConfig(start.configPath)?.github?.gitAuthor` when `existsSync(start.configPath)` and the saved account matches `start.githubAccount` case-insensitively (ignoring missing/unreadable config files).

9. `README.md`
   - Update the short `--github-account` explanation (lines 120-125) to note that `coord` stores only the account name and Git author identity (never tokens) and configures `user.name=<login>` and `user.email=<id>+<login>@users.noreply.github.com` on agent clones and coordinator-created worktrees.

10. `test/githubAuth.test.ts`
    - Update `verifyGitHubAccess` test mocks for `gh api user` to return JSON `{ id, login }` and add assertions for `userId`, `gitAuthor`, and invalid/missing `id` or malformed JSON failures.

11. `test/state.test.ts`
    - Add schema tests for `coordinatorConfigSchema.github.gitAuthor` and `startStateSchema.githubAuthor` (valid values, legacy documents without them, invalid empty/multiline/whitespace values, and `githubAuthor` without `githubAccount` rejection).

12. `test/install.test.ts`
    - Update existing `installOnce(..., { githubAccount: "acct" })` test calls to supply `githubAuthor`, verify local `user.name`/`user.email` writing, real commit attribution overriding global git config, idempotent reinstall/dry-run, account switching without stale author carry-over, refusal of non-dry-run `githubAccount` without `githubAuthor`, ambient preservation when no account is selected, and selective cleanup on `uninstall`.

13. `test/doctor.test.ts`
    - Add tests verifying `doctor` passes when a GitHub-account workspace has matching `user.name`/`user.email`, flags `DOCTOR_CODES.identity` when a clone's `user.name` or `user.email` is missing or drifted, and flags `DOCTOR_CODES.identity` for a legacy `config.json` that has `github.account` without `gitAuthor`.

14. `test/mirror.test.ts`
    - Add tests verifying `BareMirror.materializeWorktree` with `gitAuthor` configures worktree-local `user.name`/`user.email`, attributes commits inside the worktree even when `GIT_CONFIG_GLOBAL` specifies another user, does not leak that author to a subsequent worktree materialized without `gitAuthor`, and cleans up via `removeWorktree`.

15. `test/ballotPublication.test.ts`
    - Add a test confirming `createEvidenceCommit` against a `BareMirror` configured with `gitAuthor` still authors ballot publication commits as `COORDINATOR_EVIDENCE_AUTHOR`.

16. `test/cli.test.ts`
    - Update the `gh api user` mocks in `CLI GitHub account selection` and `install` dry-run/repair tests to return JSON `{ id, login }` (matching `argv[2] === "user"` before `argv.length === 3`), wire `user.name`/`user.email` in `wireClone`, and add cases for `coord onboard`/`coord install --github-account` setting `user.name`/`user.email`, `coord start`/`coord auth status` rejecting missing/mismatched clone author config, and `coord start` freezing `githubAuthor` into `start.json`.

17. `test/runLoop.test.ts`
    - Add a test verifying `CoordinatorRunLoop` passes the frozen `start.githubAuthor` (and legacy `config.json` fallback when `start.githubAuthor` is absent) into its default `BareMirror` so materialized worktrees get `user.name` and `user.email`.

## Exact file list to be created

None. All production logic and tests extend existing modules and test suites.

## Reuse and Scope

This change stays strictly within issue #269 by reusing existing GitHub auth, clone wiring, mirror worktree, schema, doctor, and test infrastructure:

- **GitHub API lookup (`src/githubAuth.ts`)**: Reuses `verifyGitHubAccess` and `withGitHubAccount` (which already calls `gh api user` on onboard, install, start, run, attach, and auth status/login) instead of adding a second `gh api` round trip. Reuses `githubLoginSchema` and `GitHubAuthError`.
- **Clone local config (`src/gitExec.ts`, `src/setupWorkspace.ts`, `src/install.ts`)**: Reuses `localConfigGet`, `localConfigSet`, `localConfigUnset`, `configureCloneIdentity`, `cloneGitHubWiringProblem`, `buildWorkspaceConfig`, and `act` (preserving dry-run reporting and idempotence). Models `clearCloneGitHubAuthor` directly on `clearCloneGitHubCredential` so owner-owned config is preserved on uninstall.
- **Coordinator worktrees (`src/mirror.ts`)**: Every coordinator-created worktree in the repository (`src/materializedInputs.ts`, `src/verificationRunner.ts`, `src/ballotPublication.ts`) already funnels through `BareMirror.materializeWorktree`. Wiring per-worktree `user.name`/`user.email` inside `BareMirror.materializeWorktree` covers all three call sites in one place with zero changes to `src/materializedInputs.ts`, `src/verificationRunner.ts`, or `src/ballotPublication.ts`.
- **Diagnostics and preflight (`src/doctor.ts`, `src/cli.ts`, `src/state.ts`)**: Reuses `DOCTOR_CODES.identity`, `preflightGitHubAccount`, `onboardRemedy`, `coordinatorConfigSchema`, and `startStateSchema`.
- **Tests**: Extends existing test files and reuses `makeProduct`, `git`, `tryGit`, `installOnce`, `uninstallOnce`, `fakeRunner`, `accountRunner`, and `BareMirror` fixtures already present in `test/support/workspaceFixture.ts` and the existing spec files. No new source or test files are created.

Out of scope (deliberately untouched):
- `scripts/lib/launcher.sh` and `githooks/`: exporting `GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the launcher environment would override `-c user.*` in product test fixtures (including this repository's own tests), so repo-local / worktree-local Git config is the right mechanism.
- `COORDINATOR_EVIDENCE_AUTHOR` in `src/ballotPublication.ts`: coordinator-authored ballot evidence commits intentionally keep their fixed `"Coordination Driver <coordination@local>"` identity via `-c` and env overrides.
- Unselected (ambient) workspaces: when no GitHub account is selected, `coord` does not write or clear `user.name` or `user.email`.

## Tests

Focused tests that fail before the change and pass after it, all added to existing test files:

1. `test/githubAuth.test.ts`
   - `verifyGitHubAccess` parses `{ id: 155764113, login: "gwhizofss" }` from `gh api user` and returns `userId: 155764113` and `gitAuthor: { name: "gwhizofss", email: "155764113+gwhizofss@users.noreply.github.com" }`.
   - `verifyGitHubAccess` rejects malformed JSON or missing/non-positive numeric `id` with `GitHubAuthError`, while preserving existing 401 and login-mismatch error messages.
2. `test/state.test.ts`
   - `coordinatorConfigSchema` accepts `github: { account, gitAuthor }` and legacy `github: { account }`, and rejects empty/whitespace/multiline `gitAuthor` fields.
   - `startStateSchema` accepts `githubAuthor` alongside `githubAccount`, accepts legacy `start.json` without `githubAuthor`, and rejects `githubAuthor` when `githubAccount` is omitted.
3. `test/install.test.ts`
   - Installing with `githubAccount` + `githubAuthor` writes `config.github.gitAuthor` and sets clone-local `user.name` and `user.email`; committing in the clone with a different `GIT_CONFIG_GLOBAL` attributes the commit to `gitAuthor`.
   - Re-running `install` (real and `--dry-run`) is a no-op (`changes: []`); switching to a second account updates `user.name`/`user.email` without carrying over the first account's author; non-dry-run `install` refuses `githubAccount` without `githubAuthor`.
   - Ambient installs (no `githubAccount`) leave pre-existing local `user.name`/`user.email` untouched across install and uninstall; uninstall of a bound workspace clears coord-written `user.name`/`user.email` while preserving owner-modified values.
4. `test/doctor.test.ts`
   - `doctor` reports 0 findings for a bound workspace with matching `user.name`/`user.email`, reports `DOCTOR_CODES.identity` when `user.name` or `user.email` is unset or altered in a clone, and reports `DOCTOR_CODES.identity` for a legacy `config.json` with `github.account` and no `gitAuthor`.
5. `test/mirror.test.ts`
   - `BareMirror.materializeWorktree` with `gitAuthor` sets `--worktree user.name` and `--worktree user.email` so a commit created inside the worktree uses `gitAuthor` even under a conflicting `GIT_CONFIG_GLOBAL`.
   - A second worktree materialized from the same `mirror.git` without `gitAuthor` does not inherit the first worktree's `user.name`/`user.email`, and `removeWorktree` cleanly removes the configured worktree.
6. `test/ballotPublication.test.ts`
   - `createEvidenceCommit` on a `BareMirror` carrying `gitAuthor` still creates the evidence commit with `COORDINATOR_EVIDENCE_AUTHOR`.
7. `test/cli.test.ts`
   - `coord onboard` / `coord install --github-account gwhizofss` resolves `{ id, login }` via `gh api user` and configures `user.name=gwhizofss` and `user.email=155764113+gwhizofss@users.noreply.github.com` in agent clones and `config.json`.
   - `coord start` and `coord auth status` fail preflight with an actionable `coord onboard` remedy when a clone is missing `user.name` or `user.email` (matching the coord 0.0.92 upgrade case).
   - `coord start` freezes `githubAuthor` into `start.json` and forwards it to `startEffects`.
8. `test/runLoop.test.ts`
   - `CoordinatorRunLoop` constructs its default `BareMirror` with `start.githubAuthor` (and falls back to `config.json` for a legacy `start.json` with `githubAccount` only), so `materializeWorktree` configures `user.name` and `user.email` on issue worktrees.

Validation commands during development: focused `pnpm vitest run <test-file>` runs for the touched spec files, followed by `pnpm build` (so `dist/main.js` used by hook/install integration tests stays current) and the repository's declared `pnpm check:fast` (enforced by precommit hook) / `pnpm check` when verifying full build + tests.

## Alternatives Rejected

1. **Reading `user.email` from `GET /user` or `/user/emails` instead of `<id>+<login>@users.noreply.github.com`**:
   - Rejected because `/user` returns `email: null` whenever "Keep my email addresses private" is enabled, `/user/emails` requires the `user:email` OAuth scope (often absent from `gh` tokens), and private emails can be blocked by GitHub's "Block command line pushes that expose my email" setting. In contrast, `GET /user` always returns `id` and `login` for any valid token, and `<id>+<login>@users.noreply.github.com` is the exact attribution format requested in issue #269.
2. **Writing `user.name` and `user.email` to `<mirror.git>/config` instead of per-worktree `config.worktree`**:
   - Rejected because writing directly to `<mirror.git>/config` would leak a selected account's author into any later unselected/ambient worktree or concurrent/resumed issue with a different frozen account, breaking `BareMirror`'s isolation invariant. Enabling `extensions.worktreeConfig = true` and writing `--worktree user.name`/`user.email` scopes author identity to each materialized worktree and cleans it up automatically on `removeWorktree`.
3. **Exporting `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_*` in `scripts/lib/launcher.sh`**:
   - Rejected because environment variables override `-c user.*` in child processes and would corrupt commits created by product test suites (including this repository's own Git fixtures). Repo-local config on clones and worktree-local config on materialized worktrees apply strictly to commits in those repositories without polluting child processes.
4. **Unconditionally unsetting `user.name`/`user.email` in `clearCloneIdentity` or ambient installs**:
   - Rejected because it would wipe out an owner's own local Git author config in adopted clones when no GitHub account is selected or when the owner intentionally customized their clone.

## Risks and Mitigations

- **Legacy workspaces upgraded from coord 0.0.92**: Existing `config.json` and `start.json` files have `github.account` / `githubAccount` without `gitAuthor` / `githubAuthor`.
  - *Mitigation*: Both new schema fields are `.optional()` so existing files parse cleanly. `coord doctor` and `preflightGitHubAccount` (`coord start`, `coord run`, `coord auth status`) immediately flag missing `user.name`/`user.email` and direct the operator to re-run `coord onboard` (which reuses the saved account, resolves `id` + `login`, and repairs all clones). `CoordinatorRunLoop` also safely falls back to `config.github.gitAuthor` when resuming a legacy `start.json` after re-onboarding.
- **Git repository format version upgrade on `mirror.git`**: `git config --worktree` requires `core.repositoryformatversion = 1` and `extensions.worktreeConfig = true`.
  - *Mitigation*: `BareMirror.materializeWorktree` checks the current local format version and upgrades only from unset/`0` to `1` (never downgrading higher versions), runs only when `gitAuthor` is configured, and wraps worktree config writes in a `try/catch` cleanup via `removeWorktree`. All modern Git versions (2.20+, released 2018) natively support `extensions.worktreeConfig`.
- **Account switching leaving stale author config**: Switching `--github-account` from account A to account B could accidentally retain account A's saved `gitAuthor`.
  - *Mitigation*: `install()` only carries forward `previous.github.gitAuthor` when `previous.github.account` matches `githubAccount` case-insensitively, and rejects non-dry-run installs where `githubAccount` is set without a resolved `githubAuthor`.
- **Evidence-branch commit authorship**: Setting `user.name`/`user.email` on materialized worktrees must not change coordinator-authored ballot publication commits.
  - *Mitigation*: `createEvidenceCommit` passes explicit `-c user.name=...`, `-c user.email=...`, and `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env vars, which take precedence over `config.worktree`; covered explicitly by a new test in `test/ballotPublication.test.ts`.
- **Offline `--dry-run` on `coord install`**: `cli.ts` intentionally skips `verifyInstallAccount` during `--dry-run`.
  - *Mitigation*: Already-installed workspaces carry forward `previous.github.gitAuthor` from `config.json` so `--dry-run` stays offline and reports `changes: []` when current; fresh `--dry-run` with a new `--github-account` is allowed without a live API lookup and mutates nothing.

## Conclusion

Resolving `{ id, login }` in `verifyGitHubAccess`, persisting `gitAuthor` (`{ name: login, email: "<id>+<login>@users.noreply.github.com" }`) in workspace config and frozen issue start state, configuring local `user.name`/`user.email` in agent clones via `configureCloneIdentity`, verifying it in `doctor` and `preflightGitHubAccount`, and configuring per-worktree `user.name`/`user.email` in `BareMirror.materializeWorktree` cleanly solves issue #269 across every location where agents create commits while preserving idempotence, ambient workspaces, backward compatibility, and coordinator evidence commit authorship.
