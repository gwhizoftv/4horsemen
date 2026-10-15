# Issue 227 — Per-workspace GitHub account selection for git and gh

Coord today inherits whatever `gh` and Git consider the shared active
credentials. Two workspaces under different GitHub accounts cannot run at once
without `gh auth switch`, and `https://user@github.com/...` origins fail
`githubRepositoryFromOrigin`. This plan stores only the **account name** in
workspace config, retrieves the token from gh’s existing keyring/credential
store per process, and applies that binding to coordinator Git, the bare
mirror, `gh` invocations, install/clone creation, and agent terminals — without
switching the global active account.

## Exact File List to be changed or deleted

- `src/state.ts` — extend `coordinatorConfigSchema` with optional
  `github: { account: string }` (strict object; account is a non-empty GitHub
  login). Preserve unknown-free strictness elsewhere.
- `src/githubIssue.ts` — teach `githubRepositoryFromOrigin` to accept HTTPS
  origins with userinfo (`https://login@github.com/owner/repo[.git]`) and still
  return `owner/repo`; SSH and path forms unchanged. Userinfo is never treated
  as the workspace auth binding when `github.account` is set.
- `src/setupWorkspace.ts` — `sameRemote` compares origins after stripping
  `.git`, trailing slashes, **and** HTTPS userinfo so
  `https://login@github.com/o/r` matches `https://github.com/o/r`. During
  install/onboard wiring, set each agent clone’s local
  `credential.helper` to `!coord git-credential` (managed, idempotent). Pass
  the selected account into `buildWorkspaceConfig` / `writeWorkspaceConfig`.
- `src/install.ts` — during `onboard` (and install paths that write workspace
  config), resolve or prompt for the workspace GitHub account, verify repo
  access with that account’s token, persist `github.account`, and run Git
  clone/fetch under the auth env. Do not call `gh auth switch`.
- `src/cli.ts` — add `coord auth status` and `coord auth login`; add internal
  `coord git-credential` (Git credential-helper protocol on stdin/stdout).
  Before `start` / resume-into-run / install clone work that needs remotes,
  resolve and validate the workspace binding; on expiry print the actionable
  message naming the account and `coord auth login`. Merge auth env into the
  process runner used for `git`/`gh` at start (including `gh issue view` and
  `git ls-remote`). Help text lists the new commands.
- `src/runLoop.ts` — when constructing default `processRunner` / Git env for
  the live loop, apply the workspace GitHub binding so PR/`gh` and hermetic
  Git calls use the same token; resume and agent-restart paths inherit that
  runner.
- `src/mirror.ts` — after scrubbing, allow a post-hermetic auth overlay on
  Git env (credential helper / askpass / `GH_TOKEN` as supplied by
  `githubAuth`); ensure the bare mirror’s local config gets the same
  `credential.helper` when the mirror is created or reconciled.
- `src/gitExec.ts` — installer synchronous Git uses the same auth overlay as
  the mirror when a binding is in scope for install/onboard.
- `src/doctor.ts` — report missing/invalid `github.account`, failed token
  resolution, or username mismatch; remediation is `coord auth login` (not
  keychain surgery). Accept userinfo origins once parsing is fixed.
- `scripts/lib/launcher.sh` — in generated launchers, after
  `launcher_environment`, resolve workspace credentials at runtime via
  `coord auth env` (or equivalent) and export `GH_TOKEN` for that process only;
  never embed a PAT in the launcher file. Agent Git continues to use the
  clone-local credential helper.
- `config.example.json` — document optional `github.account`.
- `config.product.example.json` — same optional field if product declares
  overlap; otherwise leave untouched beyond any schema example already shared.
- `docs/setup-workspace.md` — document account selection at onboard,
  `coord auth status` / `coord auth login`, and that tokens stay in gh’s
  store.
- `docs/repo-map.md` — list the new auth module under Git access / entry
  points.
- `test/githubIssue.test.ts` — userinfo HTTPS origins parse; unsupported
  forms still null.
- `test/cli.test.ts` — auth subcommands, start failure message when auth is
  expired/missing, help mentions `auth`.
- `test/onboard.test.ts` / `test/install.test.ts` — account persisted in
  config; clone wiring sets credential helper; no `gh auth switch` argv.
- `test/doctor.test.ts` — auth-related findings and remediation text.
- `test/mirror.test.ts` or focused env unit coverage via the new auth test
  file for hermetic+overlay composition.

## Exact file list to be created

- `src/githubAuth.ts` — list known gh logins (`gh auth status --json hosts`);
  resolve token with `gh auth token --user <account>` (never `gh auth switch`);
  verify login via `gh api user -q .login` under `GH_TOKEN`; verify repository
  access for the workspace origin; build process env (`GH_TOKEN` plus Git
  credential helper invocation); implement Git credential-helper fill/approve
  for `github.com`; format
  `GitHub authentication for <account> has expired or been revoked.\nRun: coord auth login`;
  TTY account picker for onboard (“known logins” + “Sign in with another
  account”); `auth status` / `auth login` / `auth env` / `git-credential`
  helpers consumed by the CLI.
- `test/githubAuth.test.ts` — unit tests with a fake `ProcessRunner` / argv
  recorder: token resolution by user, refusal to switch accounts, expired
  token message, credential-helper fill, userinfo-agnostic repo checks,
  env overlay after hermetic scrub.
- `.plans/issue-227/plan.md` — this plan.

## Reuse and Scope

- Reuse `coordinatorConfigSchema` / `readConfig` / `buildWorkspaceConfig` /
  `writeWorkspaceConfig` for persistence of `github.account` only (no token
  fields).
- Reuse `githubRepositoryFromOrigin`, `fetchGitHubIssue`, and the existing
  `ProcessRunner` / `runArgv` / `hermeticGitEnv` / `BareMirror` / `git` /
  `gitOrThrow` / `localConfigSet` paths; extend them rather than adding a
  second Git or gh stack.
- Reuse `ensureAgentClone`, `writeGitWrapper`, and `write_launcher` /
  `launcher_environment` so install, mirror, and agent terminals share one
  binding.
- Reuse CLI `confirm` / readline patterns and doctor `finding()` for owner
  messaging; reuse onboard→install flow instead of a parallel installer.
- Reuse `gh auth token --user`, `gh auth status --json`, and `gh auth login`
  as the credential store integration; do not invent a parallel Keychain
  writer when gh already stores the token.
- New file justification: `src/githubAuth.ts` is the single owner of account
  listing, token resolve/verify, env overlay, credential-helper protocol, and
  expired-auth copy so CLI/install/runLoop/doctor do not each reimplement it.
  `test/githubAuth.test.ts` holds the fake-runner cases that do not belong in
  `test/githubIssue.test.ts`.
- Out of scope: changing ballot/workflow semantics; shipping a custom Keychain
  backend beside gh; rewriting global `~/.gitconfig`; embedding PATs in
  workspace JSON or launchers; using `gh auth switch`.

## Tests

- `test/githubIssue.test.ts` — `https://gwhizofss@github.com/acme/app.git`
  (and with `.git`) → `acme/app`; bare path / non-github still null. Fails
  before the regex change.
- `test/githubAuth.test.ts` — resolve uses `gh auth token --user <account>`
  and never `gh auth switch`; verify fails → exact expired/revoked message;
  credential-helper `get` returns username=account and password=token for
  `host=github.com`; hermetic scrub then auth overlay still exposes helper /
  `GH_TOKEN`.
- `test/onboard.test.ts` / `test/install.test.ts` — written config contains
  `github.account`; agent clone local config includes `credential.helper`
  invoking `coord git-credential`; install Git argv env carries the binding.
- `test/cli.test.ts` — `coord auth status` prints workspace account + auth
  state; start/run without valid auth exits non-zero with `coord auth login`
  remediation; help lists `auth`.
- `test/doctor.test.ts` — missing or mismatched account produces a finding
  naming `coord auth login`.
- Commands while developing: focused
  `pnpm vitest run test/githubAuth.test.ts test/githubIssue.test.ts test/onboard.test.ts test/install.test.ts test/cli.test.ts test/doctor.test.ts`
  (subset as touched). Product commits rely on the hook’s `pnpm check:fast`;
  do not claim coordinator-owned full `pnpm check`.

## Alternatives Rejected

- **`gh auth switch` per workspace** — mutates shared active account and races
  concurrent coord processes (explicitly forbidden by the issue).
- **PAT in workspace config or launcher scripts** — durable secret sprawl;
  issue requires account selection in config and token in gh/Keychain only.
- **`GH_TOKEN` alone without a Git credential helper** — fixes `gh` but not
  HTTPS Git for mirror/clone/agent pushes under `GIT_TERMINAL_PROMPT=0`.
- **Global `credential.helper` / rewriting user gitconfig** — would affect
  personal projects outside the workspace.
- **Trusting URL userinfo as the account binding** — origin can be stale or
  copied; `github.account` is the explicit choice; userinfo is only accepted
  for parsing/comparison.
- **Prompting unattended agents for a PAT on failure** — agents must fail
  closed with the owner-facing `coord auth login` message.

## Risks and Mitigations

- *Existing workspaces lack `github.account`*: start/doctor fail with
  remediation to run `coord auth login` (which may set the account) or
  re-onboard; no silent fallback to the active gh user.
- *`hermeticGitEnv` strips `GIT_CONFIG_*`*: apply the auth overlay **after**
  the scrub at shared helper call sites so ambient config stays blocked while
  coord-supplied helper settings remain.
- *Token briefly present in agent process env*: required for `gh` in the
  terminal; not written to disk; launchers call `coord auth env` at start so
  files stay PAT-free.
- *Re-onboard must not clobber a working account choice without intent*:
  default to existing `github.account` when still valid; prompt only when
  missing or when login replaces credentials.
- *SSH remotes*: account binding still governs `gh`; Git SSH continues to use
  the user’s SSH agent — document that HTTPS+helper is the concurrent-account
  path the issue targets.
- *post-merge regenerates launchers*: keep auth export in `write_launcher` so
  regenerations stay consistent with install.

## Conclusion

Persist `github.account` per workspace, resolve that account’s token through
gh’s store without switching the global active user, apply one auth overlay to
coordinator Git/`gh`, mirror, install clones, and agent launchers, accept
userinfo HTTPS origins for parsing, and give owners `coord auth status` /
`coord auth login` with a clear expiry path — enabling two concurrent coord
workspaces on different GitHub accounts.
