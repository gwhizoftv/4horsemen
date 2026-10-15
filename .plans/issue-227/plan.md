# Issue 227 — workspace GitHub credentials

Protocol version: 1. Agent: codex. Baseline: `fcc3cbcda53a8e130b5366e6e623891b3c0c46ed`.

Implement the requirements in the owner runtime's issue-227 GitHub snapshot: save one account selection per workspace, retrieve its credentials when needed, and apply it to owner/coordinator/agent Git and GH operations, including installation, clone creation, resume, and restart. Also accept username-bearing HTTPS GitHub origins without using the URL username as account-selection authority.

## Exact File List to be changed or deleted

No deletions. Change only these existing files:

| File | Change |
| --- | --- |
| `src/state.ts` | Strict optional `github: { account }` config and nonsecret start-state binding; validation and legacy parsing. |
| `src/githubIssue.ts` | Structured origin parsing, username-bearing HTTPS support, and auth remediation. |
| `src/setupWorkspace.ts` | Carry selection through config generation; manage local credential settings; authenticate initial clone/fetch; generate an untracked GH wrapper. |
| `src/install.ts` | Resolve/validate selection before remote effects, preserve it on reinstall, wire owner/clones/existing mirror, and conservatively remove owned settings on uninstall. |
| `src/cli.ts` | Selection UI and `--github-account`; auth status/login/exec and internal credential/GH dispatch; startup and recovery validation. |
| `src/runLoop.ts` | Bound runners for GH, PR, and follow-up calls; validate resume/terminal recovery and refresh credentials. |
| `src/mirror.ts` | Optional explicit auth binding on `BareMirror`; local helper wiring before network access while preserving environment scrubbing. |
| `src/wipeIssue.ts` | Apply binding to remote cleanup and direct GH API fallback; retain authentication failures. |
| `scripts/lib/launcher.sh` | Authenticated harness execution and GH wrapper rendering; no embedded token or tmux-global token. |
| `scripts/bootstrap.sh` | Selected-account private source clone/update before the installed driver exists. |
| `package.json` | Add only the justified OS credential-store dependency below; no version bump or check-script changes. |
| `pnpm-lock.yaml` | Lock the dependency and platform packages. |
| `test/state.test.ts` | Account schema/start compatibility. |
| `test/githubIssue.test.ts` | Origin parsing/remediation regression cases. |
| `test/cli.test.ts` | Auth commands, selected startup/recovery, failure ordering. |
| `test/runLoop.test.ts` | Bound GH/PR execution, refresh, recovery. |
| `test/mirror.test.ts` | Real Git credential/config boundary in the mirror fixture. |
| `test/install.test.ts` | Initial clone, helper wiring, reinstall/uninstall/dry run, executable launcher/wrapper regressions. |
| `test/onboard.test.ts` | Selection persistence and owner onboarding workflow. |
| `test/bootstrap.test.ts` | Private bootstrap before installation and subsequent update. |
| `test/wipeIssue.test.ts` | Bound API fallback and auth failure propagation. |
| `test/integration.test.ts` | Extend the lifecycle fixture for two independent account bindings. |
| `test/support/workspaceFixture.ts` | Minimal shared fake GH/store support for the integration cases. |
| `config.example.json` | Nonsecret account field example. |
| `README.md` | Selected-account onboarding and owner issue-creation commands. |
| `docs/setup-workspace.md` | Storage, selection, renewal, private bootstrap, local wiring, migration. |
| `docs/coord-driver.md` | Auth command reference and lifecycle binding. |

## Exact file list to be created

- `src/githubAuth.ts`: one shared module for named-account lookup, credential validation/storage, child environments, safe errors, and the Git credential protocol. Centralizing this boundary prevents divergent selection precedence among existing raw subprocess calls. Keep installation effects and command routing in their current files.
- `test/githubAuth.test.ts`: isolated tests of this new boundary with injected stores and subprocess responses. There is no existing auth unit test file; lifecycle tests stay in the listed existing suites.

This action creates only `.plans/issue-227/plan.md`. The product file map above is for later implementation. Generated wrappers and nonsecret installation recovery metadata are untracked outputs, not additional source files. Any additional tracked path requires an amendment.

## Reuse and Scope

Reuse `coordinatorConfigSchema`, `CoordinatorConfig`, the existing start schema, `readConfig`, and `atomicWriteJson`. Resolve context with `resolveWorkspaceFromWorktree`, `resolveWorkspaceFromProduct`, `workspaceLocationFromConfig`, and `selectWorkspaceLocation`, preserving flat/nested and owner/agent validation. Do not introduce a parallel config format.

Reuse `install`, `onboard`, `buildWorkspaceConfig`, `ensureAgentClone`, `syncAgentClone`, `writeAgentLauncher`, `writeGitWrapper`, and the existing effect/dry-run machinery. Reuse `localConfigGet`/`localConfigSet`/`localConfigUnset` and `git`/`gitOrThrow`. Once local helpers are installed, `prepareAgentIssueBranches`, `makeAgentClonesBaseReady`, and `makeManualClonesBaseReady` use the selected credential without separate auth implementations. Preserve their dirty-worktree and branch rules.

Reuse `ProcessRunner`, `ProcessOptions`, `CommandRunner`, `GitRunner`, `runArgv`, `hermeticGitEnv`, and `BareMirror`. `fetchGitHubIssue` and `assessFollowUpIssue` already accept runners; make default PR functions use the bound runner as well. Auth context belongs to runner/instance closures, never mutable `process.env` or a singleton selected account. Linked verification/publication worktrees inherit mirror Git configuration.

Reuse `shellQuote`, validated CLI entry paths, executable-resolution patterns, and the launcher renderer. Keep all harness flags/grants and the existing containment shim. `TmuxController` still starts the generated launcher, which resolves its own credentials after tmux inheritance; no secret belongs in tmux commands or its global/session configuration.

Reuse `makeProduct`, `ensureBuilt`, `git`, `tryGit`, `writeDeclaration`, CLI `setup`/`successfulStartGit`, mirror `repository`, and bootstrap `fixture`/`bootstrap`. Extend the existing actual-launcher execution test, which covers four harnesses and spaces in paths. Tests use synthetic tokens, isolated homes, injected stores, and fake GH; never the owner's credentials.

### Selection and URL handling

Add optional `github.account`, validating a trimmed nonempty login without shell/path/control characters and comparing authenticated identities case-insensitively. Optionality preserves old config parsing and local/non-GitHub workflows. It does not permit ambient authentication for a GitHub operation: an unselected GitHub workspace must choose an account via onboarding or `coord auth login --account <login>`. Offline help/status diagnostics remain usable.

Onboarding offers GH's known account names, the saved selection, and “Sign in with another account.” An explicit `--github-account` supports unattended onboard/install; otherwise reuse the saved selection on reinstall. Without a saved/explicit account and without a TTY, fail with a selection command rather than choosing the active GH user. Dry run describes selection/wiring without logging in, writing storage, fetching, or claiming remote validation.

Replace the HTTPS regex with structured parsing: exact `github.com`, exactly owner/repository segments, optional `.git`/trailing slash, and optional username-only userinfo. Retain SCP-style SSH input. Reject password-bearing URLs, queries/fragments, malformed paths, and lookalike hosts without echoing secrets. The configured login wins over URL userinfo.

Selected operations use canonical HTTPS transport. Preserve the original remote spelling through exact-origin, repository-local URL rewrite settings for supported SSH and username-bearing inputs; do not silently continue authenticating through a different SSH identity. Do not rewrite global Git configuration or unrelated remotes.

### Credential resolution and safe replacement

Resolve by the selected login only. An existing coord OS-store entry wins; otherwise read the named GH credential with `gh auth token --hostname github.com --user <account>`, removing ambient GH/GITHUB token overrides from that lookup. An invalid existing coord entry fails; it does not authorize a fallback to another token/account. Keep credential stdout internal. Named-user token lookup is explicitly supported by GH. [GH token documentation](https://cli.github.com/manual/gh_auth_token)

Add `@napi-rs/keyring` behind a small injectable adapter, loaded only when needed. Store replacements under a coord-specific service, e.g. `coord:github.com`, keyed by login. Require persistent secure storage (Keychain on macOS, Secret Service on Linux), with a clear failure if unavailable; do not silently save plaintext or choose a nonpersistent fallback. During implementation lock a release supporting explicit backend controls and Node 26. This dependency is justified because it writes secrets without argv exposure or shared GH active-account changes; no custom encryption or token file is needed. [Credential binding documentation](https://github.com/Brooooooklyn/keyring-node)

`coord auth login` preserves the workspace account and accepts a PAT from a masked terminal prompt or `--with-token` stdin. Changing/initializing the selected account requires an explicit account choice. Validate `gh api user` against that login and `gh api repos/<owner>/<repo>` using the proposed token before saving. Distinguish missing repository permissions from invalid credentials. Cancellation, identity mismatch, denied access, or storage failure leaves the prior credential/config intact. A successful replacement updates that account's secure entry only. “Sign in with another account” uses this secure PAT flow; a new browser OAuth client is outside scope.

Do not call ordinary `gh auth login` or `gh auth switch` for renewal. GH's implementation writes a host-wide active keyring slot, so merely changing `GH_CONFIG_DIR` is not sufficient isolation. A coord-specific service avoids that mutation. [GH auth implementation](https://github.com/cli/cli/blob/trunk/internal/config/config.go)

`coord auth status` reports workspace, selected account, authenticated login, storage source, and repository access, never a token. Invalid/expired/revoked credentials name the account and say `Run: coord auth login`; network outages and permission failures remain distinguishable. No token may appear in config, start state, journals, actions, launchers, local Git config, argv, or diagnostics. Sanitize low-level errors and suppress diagnostic tracing around credential operations.

### Git, GH, and terminal boundaries

Implement internal `coord auth credential ... get|store|erase`. Validate Git credential input against the bound HTTPS host/repository. `get` retrieves the selected token and emits only credential protocol fields; conflicting URL usernames do not change the identity. Ignore `store`/`erase`, so Git rejection does not delete saved credentials. Missing/invalid credentials emit `quit=true` and sanitized stderr, stopping fallback helpers and unattended prompts. Never return a token for another host/repository. Git defines this stop behavior explicitly. [Git credential protocol](https://git-scm.com/docs/gitcredentials)

Install a GitHub-scoped empty helper entry followed by the selected helper and enable `useHttpPath` in the owner worktree, agent clones, and bare mirror. Reset inherited competing helpers/authorization headers for the selected context while preserving unrelated settings. Save prior and installed nonsecret local values in Git metadata; reinstall is idempotent and uninstall restores only still-owned settings, retaining owner edits. Validate install inputs before mutations. Do not use global `gh auth setup-git`.

For remote probes/clones before a repository exists, pass equivalent token-free `git -c` arguments bound to the explicit account/repository/provider. Helpers retrieve the token themselves. Do not rely on inherited `GIT_CONFIG_*`: `hermeticGitEnv` intentionally removes it. Preserve its repository-redirection and author-identity scrubbing. Local helper settings then cover fetch/push, branch preparation, mirror publication, linked worktrees, and cleanup.

Build a fresh child-only environment for each selected GH command: replace `GH_TOKEN`, clear conflicting token/host/repository overrides, bind github.com, and disable unattended prompting. Do not wrap unrelated subprocesses. Cover issue snapshot, follow-up lookup, PR list/create/ready/merge, and wipe's direct `gh api` fallback. Authentication errors must not be reduced to missing refs or followed by an ambient-account retry.

Provide `coord auth exec -- <argv...>` for owner commands and harness launch, with the existing workspace selectors and argument boundaries preserved. Owner examples use `coord auth exec -- gh issue create ...`; the owner can also open a scoped shell. Direct owner Git uses its local helper. An arbitrary unwrapped GH process does not automatically discover this workspace; document that limitation rather than changing global shell behavior.

Each generated launcher invokes the installed auth execution path, which validates the binding and spawns the original harness with its unchanged flags/grants. Generate an untracked `.coord/bin/gh` wrapper that resolves fresh credentials per invocation and calls a captured real GH executable, not itself. Thus agents can use renewed credentials on their next Git/GH command; restarts validate before launching even with a stale tmux environment. The Git containment wrapper remains in force. Wrappers contain context/executable references, never tokens.

### Bootstrap, install, and lifecycle ordering

Resolve credentials, verify `/user`, and verify repository access before clone creation/synchronization, issue snapshot/baseline lookup, branch changes, or terminal launch. Pass the binding through initial `ls-remote` and remote-clone fallback in `ensureAgentClone`; post-clone wiring alone is insufficient. `BareMirror.initialize` applies local helper settings after local initialization and before fetching, including existing mirror repair.

Private driver bootstrap adds `--github-account`. Before the driver/dependency exists, a small POSIX-shell named-GH reader/helper applies the same explicit host/account checks and validates identity/source repository before clone/update. Reuse a built installed coord credential endpoint on later updates so coord-stored replacements are honored. Save only the bootstrap account in existing bootstrap metadata. Scrub ambient token overrides, disable prompts, reset helper precedence, and keep the token out of argv/URLs/logs. Public/local bootstrap without selection retains current behavior. Selected-account failure never retries anonymously/as another user. Document named GH credentials as the first private bootstrap's prerequisite, since the native coord store adapter is not installed yet.

Freeze the nonsecret selected account in new start state. Resume/run/attach resolve fresh credentials and check the current config agrees before effects. Legacy start files without the field require an explicit current selection, never an inferred ambient account. Token renewal cannot change automation digest or action identity: no secret is serialized. A changed account during a bound active issue fails with a clear mismatch instead of silently rebinding. Direct launcher restart and terminal recovery perform this same check using the issue context. Existing workflow holds remain unchanged by authentication recovery.

## Tests

Use the fewest regression scenarios that cover distinct boundaries; table-drive variants and keep existing fixtures. No live GitHub/keychain calls.

1. `test/githubAuth.test.ts`: interleave two account contexts with a conflicting ambient token. Assert named lookup, `/user`/repo validation, child-environment independence, same-account renewal without shared active-state changes, and redacted failure behavior. Cover missing/expired credential, denied repo, identity mismatch, cancelled login, and failed storage without replacing the old credential.
2. Extend `test/state.test.ts` and `test/githubIssue.test.ts` for schema/legacy behavior and valid username-bearing HTTPS with a different selected login; reject malformed/password-bearing/lookalike URLs without leaking their contents.
3. Extend `test/install.test.ts`/`test/mirror.test.ts` with real Git credential protocol calls against synthetic credentials. Competing global helpers and poisoned `GIT_CONFIG_*` must not win in owner/clone/bare/linked-worktree contexts. Missing credentials stop fallback; foreign hosts get no token. Exercise initial remote clone with no local tracking ref, account-preserving reinstall, side-effect-free dry run, and conservative uninstall. Scan generated settings/scripts/logs for the fake token.
4. Extend `test/cli.test.ts`/`test/onboard.test.ts` for prompt/explicit/saved selection, status/login/exec, start-state binding, and failure before startup/recovery effects. Update GitHub fixture configuration and fake runners explicitly; do not add a production test bypass.
5. Extend `test/runLoop.test.ts` at actual runner boundaries for follow-up and PR list/create/ready/merge. Renew a token while preserving the account and workflow state. Extend the existing integration lifecycle to interleave A/B workspaces through start/resume/publication and verify no account cross-contamination.
6. Extend the executable launcher test in `test/install.test.ts` for stale inherited tokens, two workspaces, all four harness argv/grants, actual wrapped GH execution, and relaunch after renewal. Authentication failure prevents harness execution; wrapper recursion is tested.
7. Extend bootstrap's fake-bin fixture for selected first private clone and update, with failure before Git and no shared GH mutation/secret metadata. Extend `test/wipeIssue.test.ts` for the Git-to-GH deletion fallback and retained auth failures.

These cases expose absent behavior in the baseline; assertions must observe credentials reaching subprocess/helper boundaries, not merely configuration text. The existing local repository scenarios remain unchanged where no GitHub selection is needed.

Commands verified in `package.json` and the Vitest configs:

```sh
pnpm exec vitest run --config vitest.config.ts test/githubAuth.test.ts test/githubIssue.test.ts test/state.test.ts test/mirror.test.ts test/runLoop.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts test/install.test.ts test/onboard.test.ts test/bootstrap.test.ts test/wipeIssue.test.ts
pnpm exec vitest run --config vitest.e2e.config.ts test/integration.test.ts
```

Run focused commands during implementation. The commit hook owns mandatory `pnpm check:fast`; do not duplicate it immediately before committing. Honor the current implementation action's verification mode. Frozen issue configuration names final `pnpm run check`, owned by the coordinator at the approved pin; do not claim it as locally run. This evidence-only action needs plan heading/path/evidence validation, not a product suite.

## Alternatives Rejected

- Shared `gh auth switch`, global Git helper writes, or mutable process-wide tokens: simultaneous workspaces can use each other's account.
- Only exporting `GH_TOKEN`: ordinary Git still lacks selected credentials and long-lived agents can retain stale tokens.
- Wiring after clone/start: private clone and initial remote access can already have failed or used another identity.
- `GH_CONFIG_DIR` plus ordinary GH login: directory isolation alone does not isolate GH's shared active keyring slot; the native credential adapter is justified by secure independent renewal.
- PATs in URL/config/script/argv, custom plaintext storage, or application encryption: unnecessary secret exposure and lifecycle complexity.
- New OAuth, generic host/provider frameworks, SSH-key management, or global owner-shell wrapping: beyond the requested GitHub workspace account behavior.

## Risks and Mitigations

- **Secure-store availability/native packaging:** lazy-load and inject the adapter, require persistent secure storage, verify the pinned release with Node 26/pnpm, and fail clearly instead of falling back to plaintext.
- **Fallback or secret leakage:** validate identity/host/repo, reset helper precedence, use `quit=true`, pass secrets only through pipes or child environments, and test absence from durable artifacts and errors.
- **Partial install/stale settings:** authenticate before remote effects, preserve installer dry-run/order/idempotence, and record/restore only owned local settings. Test first-clone and existing-mirror paths.
- **Long-lived process/account drift:** bind identity in start state, reread tokens per GH/helper call, and validate every launcher/recovery path without releasing workflow holds or changing tmux-global state.
- **Legacy and SSH workspaces:** preserve schema readability/local workflows, require explicit GitHub selection on migration, scope HTTPS rewriting to the selected origin, and document owner `auth exec` usage.
- **Missed subprocess entry point:** cover the inspected raw GH calls in CLI startup, PR operations, follow-up verification, and wipe fallback as well as clone/mirror Git paths. Request an amendment if another required source file is discovered.

## Conclusion

One explicit workspace account binding, fresh credential resolution, secure same-account replacement, and repository-local Git helpers will keep concurrent projects independent from installation through publication and recovery. Preserve shared GH/Git state and existing workflow/containment behavior. Publish only this plan now; implement and verify the exact file map under a subsequent authorized action.
