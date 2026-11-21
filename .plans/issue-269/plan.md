# Plan — issue 269: set Git author identity when coord sets up agent clones

## Problem

`coord onboard` / `coord install` record the selected GitHub account as
`coord.githubAccount` and wire a credential helper for it
(`configureCloneIdentity`, `configureCloneGitHubCredential` in
`src/setupWorkspace.ts`), but never set `user.name` / `user.email` in the
clone. Agents' commits therefore carry whatever the owner's global Git identity
is (e.g. `gwhizoftv <personal email>`), so a SoundSplore clone selected for
`gwhizofss` produces commits GitHub does not link to `gwhizofss`.

GitHub links a commit to an account by email. The account's private noreply
address is `<id>+<login>@users.noreply.github.com`, where `<id>` is the numeric
user id; the id is not derivable from the login, so it has to come from
`gh api user` at verification time and be saved for later offline repairs.

## Behaviour after the change

When a GitHub account is selected and its numeric id is known, every agent
clone coord creates or adopts gets clone-local (`git config --local`):

- `user.name=<account>`
- `user.email=<id>+<account>@users.noreply.github.com`

Concretely, `--github-account gwhizofss` yields `user.name=gwhizofss` and
`user.email=155764113+gwhizofss@users.noreply.github.com`.

- The id comes from the same `gh api user` call `verifyGitHubAccess` already
  makes, and is saved in the workspace config as `github.userId` so a
  repair/dry-run install with no network reproduces the same values.
- If the account changes, both keys are rewritten for the new account.
- If the account is deselected or coord is uninstalled, coord removes the keys
  **only when they still hold the value coord writes for the clone's recorded
  `coord.githubAccount`** (name equals the account, email matches
  `^\d+\+<account>@users\.noreply\.github\.com$`, case-insensitive). An
  identity the owner set by hand is never removed.
- A legacy workspace config with an account but no `userId` (written by
  ≤ 0.0.98) gets the id on its next verified install/onboard; a dry run on such
  a workspace leaves `user.*` untouched rather than guessing.

## Exact File List to be changed or deleted

- `src/githubAuth.ts`
  - `GitHubAccess` (line 133) gains `id: number`.
  - `verifyGitHubAccess` (lines 136–169): request `gh api user --jq '.login, .id'`
    and parse two lines; a missing or non-numeric id throws a
    `GitHubAuthError` (`Cannot verify GitHub account <a>: GitHub returned no numeric user id`).
  - New exported pure helper `githubCommitIdentity(account, id)` →
    `{ name: account, email: \`${id}+${account}@users.noreply.github.com\` }`,
    plus `isCoordCommitIdentity(account, name, email)` used for safe removal.
- `src/state.ts` — workspace config schema line 319:
  `github: z.object({ account: githubLoginSchema, userId: z.number().int().positive().optional() }).strict().optional()`.
  Optional so existing configs still parse.
- `src/setupWorkspace.ts`
  - `WorkspaceConfigInput` (≈ line 194) gains `githubUserId?: number | null`;
    `buildWorkspaceConfig` (line 240) writes `github: { account, userId }` when
    both are known, `{ account }` otherwise.
  - `CloneIdentity` (line 603) gains `commitIdentity: { name: string; email: string } | null`.
  - `configureCloneIdentity` (line 645): when `commitIdentity` is non-null, add
    `["user.name", name]` and `["user.email", email]` to the `desired` list
    (reusing the existing stale-diff / `act` / `localConfigSet` path so
    idempotence and dry-run reporting are unchanged). When `commitIdentity` is
    null and `githubAccount` is null, remove `user.name`/`user.email` only if
    `isCoordCommitIdentity(<previous coord.githubAccount>, …)` holds — read the
    previous account before the loop rewrites it. When `commitIdentity` is null
    and an account is set, leave `user.*` alone.
  - `clearCloneIdentity` (line 672): before unsetting `IDENTITY_KEYS`, remove
    `user.name`/`user.email` under the same `isCoordCommitIdentity` test.
    `user.*` are **not** added to `IDENTITY_KEYS`, which would unconditionally
    wipe an owner-set identity.
- `src/install.ts`
  - `InstallOptions` (line 125) and `OnboardOptions` (line 892) gain
    `githubUserId?: number`; `onboard` forwards it (line 950).
  - At line 372, resolve `githubUserId`: the option when given (it belongs to the
    effective account the CLI verified), otherwise the previous config's
    `github.userId` only if the previous config's account equals the effective
    account; validate as a positive integer.
  - Pass `githubUserId` into `buildWorkspaceConfig` (≈ line 450) and
    `commitIdentity: githubAccount !== null && githubUserId !== null ? githubCommitIdentity(githubAccount, githubUserId) : null`
    into `configureCloneIdentity` (lines 496–508).
- `src/cli.ts`
  - `verifyInstallAccount` (lines 987–994) returns the `GitHubAccess`.
  - `onboard` command (lines 1459–1475) passes `githubUserId: access.id` when an
    account was verified.
  - `install` command (lines 1522–1534) passes `githubUserId: access.id` when the
    effective (explicit or saved) account was verified; dry-run is unchanged
    (no verification, so install falls back to the saved id).
- `test/githubAuth.test.ts` — extend "verifies the login and repository access…"
  (lines 108–121): stubs return `"Acct\n4242\n"`, expected result gains `id: 4242`,
  plus one assertion that `"acct\n"` (no id) rejects.
- `test/install.test.ts` — extend the existing selected-account wiring test
  (≈ lines 398–428) and add one focused case (see Tests).
- `test/cli.test.ts` — the three `gh api user` stubs that answer `"acct\n"`
  (lines 798, 2219, 2266) answer `"acct\n4242\n"`; the install test at ≈ 2210
  asserts the clone's `user.email` is `4242+acct@users.noreply.github.com` and
  `config.github` is `{ account: "acct", userId: 4242 }`.

## Exact file list to be created

None. Every change extends an existing module and an existing test file.

## Reuse and Scope

Reused, not reimplemented:

- `configureCloneIdentity` / `clearCloneIdentity` and their `desired` /
  stale-diff / `act(options, …)` pattern, `localConfigGet`, `localConfigSet`,
  `localConfigUnset` (`src/setupWorkspace.ts`) — the new keys ride the same
  idempotent, dry-run-aware write path as `coord.githubAccount`.
- `verifyGitHubAccess` and its `withGitHubAccount` token binding
  (`src/githubAuth.ts`) — the id is read in the call already made with the
  selected account's token; no new network call and no new gh invocation shape
  beyond the `--jq` expression.
- `githubLoginSchema`, `coordinatorConfigSchema` `github` object
  (`src/state.ts`), `readPreviousConfig` and the existing "omitted option keeps
  the saved account" rule in `install` (`src/install.ts`).
- `buildWorkspaceConfig` for persisting the id beside the account.
- Test fixtures: `product()`, `installOnce`, `uninstallOnce`, `git`/`tryGit`,
  `readConfig` in `test/install.test.ts`; `fakeRunner` in
  `test/githubAuth.test.ts`; `installedWorkspace`, `installArgs`,
  `accountRunner` in `test/cli.test.ts`.

Scope boundaries:

- Commit sites covered: agent clones, which coord creates (`ensureAgentClone`
  "clone origin/<base> into …") or adopts, and on which coordination checks out
  `issue-<n>/<agent>` for every automated action. These are where agents
  create commits.
- Not changed: coordinator evidence commits (`createEvidenceCommit`,
  `src/ballotPublication.ts`), which deliberately use the fixed
  `COORDINATOR_EVIDENCE_AUTHOR` ("never a voting agent", asserted in
  `test/ballotPublication.test.ts:202`) and pin it with `-c user.*` plus
  `GIT_AUTHOR_*` env; and the bare mirror's detached worktrees
  (`materializedInputs.ts`, `verificationRunner.ts`), which are read-only bound
  inputs/check sandboxes in which agents do not commit. See Alternatives.
- No new files, dependencies, CLI flags, or doctor checks. No version bump.

## Tests

All join existing files; each fails before the change and passes after.

1. `test/githubAuth.test.ts` — "verifies the login and repository access with
   actionable failures": `"Acct\n4242\n"` resolves to
   `{ account: "acct", login: "Acct", id: 4242, repository: "acme/app" }`;
   `"acct\n"` (no id line) and `"acct\nnull\n"` reject with
   `GitHub returned no numeric user id`. Fails today: no `id` in the result.
2. `test/install.test.ts` — extend the existing selected-account test
   (`installOnce(fixture, { origin, githubAccount: "acct" })`, ≈ line 403) to
   pass `githubUserId: 4242` and assert:
   - `git config --local user.name` is `acct` and `user.email` is
     `4242+acct@users.noreply.github.com`;
   - `readConfig(...).github` equals `{ account: "acct", userId: 4242 }`;
   - the existing dry-run repair without options still reports `changes: []`
     (saved id reproduces the identity offline);
   - after the existing `uninstallOnce`, both `user.*` keys are gone.
   Fails today: `user.name` is unset in the clone.
3. `test/install.test.ts` — new case "never removes an identity the owner set
   in a clone": install with `githubAccount: "acct", githubUserId: 4242`, then
   `git config --local user.email owner@example.com`; uninstall leaves
   `user.email=owner@example.com`. Also: a re-install whose config has an
   account but no `userId` and no `githubUserId` option leaves an existing
   `user.*` untouched. Guards the removal rule.
4. `test/cli.test.ts` — install with `--github-account acct` (≈ line 2210) with
   the stub answering `"acct\n4242\n"`: the clone's `user.email` is
   `4242+acct@users.noreply.github.com`. Proves the CLI threads the verified id
   into `install`. The other two stub updates are fixture maintenance only.

Development: `pnpm vitest run test/githubAuth.test.ts test/install.test.ts test/cli.test.ts`.
The pre-commit hook owns `pnpm check:fast`; final `pnpm check` (build,
check:fast, e2e) is coordinator-owned at the approved pin.

## Alternatives Rejected

- **Derive the email without the id (`<login>@users.noreply.github.com`).**
  No network needed, but GitHub only attributes that legacy form for accounts
  created before July 2017; for current accounts commits would stay unlinked —
  the exact failure in the issue. The issue specifies the `<id>+<login>` form.
- **Separate `gh api user --jq .id` lookup inside `install`.** `install` is
  synchronous and runs offline in tests and dry runs; a second network call
  would also duplicate the verification already done with the same token.
- **Store the id only in the clone (no config field).** A fresh clone added on
  a later offline repair, or a re-created clone, would have no source for it.
- **Add `user.name`/`user.email` to `IDENTITY_KEYS`.** `clearCloneIdentity`
  unsets those unconditionally; uninstall or deselection would delete an
  identity the owner configured themselves.
- **Use the owner's primary GitHub email.** Leaks a private address into every
  agent commit and needs the `user:email` scope; the noreply address is what
  the issue asks for and is always available.
- **Set `user.*` in the bare mirror config (covers mirror-linked worktrees) or
  change `COORDINATOR_EVIDENCE_AUTHOR`.** Agents do not commit in materialized
  or verification worktrees, and evidence commits are fixed to the driver
  author by protocol (and override any config with `-c` + env). Doing so would
  require freezing the id into issue start state and plumbing it through
  `startEffects`/`RunLoop` for no commit an agent makes.
- **Set `GIT_AUTHOR_*` in the generated launcher.** Covers only sessions
  started through the launcher, not manual commits in the clone, and is not
  visible in `git config`.

## Risks and Mitigations

- **Existing test stubs answer only the login for `gh api user`.** Requiring an
  id would fail them; the three `cli.test.ts` stubs and the `githubAuth.test.ts`
  stubs are updated in this change. Real `gh api user` always returns `id`.
- **Legacy configs without `userId`.** Schema field is optional; the next
  verified onboard/install records it; dry runs leave `user.*` untouched and
  report no spurious change.
- **Removing an owner's identity.** Removal requires the exact coord-written
  shape tied to the clone's recorded account; covered by Test 3.
- **Login casing.** `user.name` uses the configured account string, which the
  CLI has verified case-insensitively against `gh api user`; the email local
  part is case-insensitive for GitHub attribution.
- **Start preflight (`cli.ts:920`) also calls `verifyGitHubAccess`.** It ignores
  the new `id`; its stub is updated so start tests keep passing.
- **Launcher's own `gh api user` check (bash) is untouched**, so the
  `install.test.ts` launcher fake stays valid.

## Conclusion

Read the account's numeric id during the existing `verifyGitHubAccess` call,
save it as `github.userId` in the workspace config, and have
`configureCloneIdentity` write clone-local `user.name=<account>` and
`user.email=<id>+<account>@users.noreply.github.com` into every agent clone
through the same idempotent path that already writes `coord.githubAccount`.
Remove those keys on deselection/uninstall only when they still hold the value
coord wrote. Changes are confined to `githubAuth.ts`, `state.ts`,
`setupWorkspace.ts`, `install.ts`, `cli.ts` and three existing test files, with
no new files or dependencies.
