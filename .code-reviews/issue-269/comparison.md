# Implementation comparison — issue 269

Bound implementation pins compared:

- antigravity `ff396b3133e38227179375cd5a19ff4a36353e39`
- claude `7e2b1c39be95ada9c63aa87de41f4eb29397506f`
- codex `c16f985990d637db91a10d2be26d4bbe8f944559`

Method: plain `diff -u` between the three bound worktrees, using the claude pin as
the reference. I also ran one throwaway shell replica in the scratchpad (Git
2.54.0) of codex's `BareMirror.enableWorktreeConfig` + `materializeWorktree`
sequence on a real bare mirror. I did not run any product test suite. All
pass/fail claims below come from reading the code or from that replica. I
report no coordinator check results.

## Comparison

### What all three share

All three implement the selected plan's core:

- **Profile lookup:** `verifyGitHubAccess` requests `gh api user --jq {login,id}`
  and validates a positive numeric id. It keeps the canonical login and the
  existing 401 and login-mismatch messages.
- **Saved profile:** an optional `github.profile` in the workspace config,
  refined to belong to `github.account`, so legacy `{ account }` configs still
  parse.
- **Clone author:** clone-local `user.name=<login>` and
  `user.email=<id>+<login>@users.noreply.github.com`, written through the
  existing `configureCloneIdentity` / `act` / `localConfig*` path.
- **CLI:** `verifyInstallAccount` returns the verified profile, and onboard and
  install pass it in.
- **Mirror and docs:** an author applied to the workspace mirror, repair of an
  existing mirror at install time, and a README update.

None adds a file or dependency. All stay inside the approved paths: codex
leaves `test/ballotPublication.test.ts` untouched, and the other two extend it.

They differ in three places: how coordinator-created worktrees are attributed,
what uninstall does, and what a direct `install()` call does when the CLI has
not supplied a profile.

| | antigravity | claude | codex |
|---|---|---|---|
| Mirror-worktree author | shared mirror config; issue profile frozen in `start.json` and re-applied on every initialize | shared mirror config from saved workspace profile | mirror config as workspace default **plus** per-worktree `config --worktree` from the frozen issue profile, after migrating `core.bare` to `config.worktree` |
| Isolation across issues / account switch | no (F1) | no (F1) | yes (verified, below) |
| Direct `install()` without a profile | silently no author (F3) | one sync lookup, else saved profile | sync lookup on **every** real run, even with a matching saved profile (F4) |
| Uninstall | removes values equal to coord's, without provenance (F5) | leaves coord-written author behind (F2) | restores originals from a `coord.managedGitAuthor` receipt, only where the owner hasn't edited |
| Size / complexity | medium | smallest | largest (receipt JSON, config migration) |

**Codex's config migration works.** This is the mechanism that broke
antigravity's *plan*, so I checked it directly. On a bare mirror with a linked
worktree created *before* migration, I ran codex's sequence: copy `config`
to `config.lock`, move `core.bare` to `config.worktree`, set
`repositoryformatversion=1` and `extensions.worktreeConfig=true`, then rename.
Results:

- The mirror stays bare: `rev-parse --is-bare-repository` returns `true` via
  `--git-dir` and via `-C`.
- The pre-existing worktree is still a work tree, and commits there use the
  mirror's local default author.
- A new worktree with `--worktree user.*` commits as the issue's author, for
  both author and committer.
- An evidence-style commit (`-c user.*` plus `GIT_AUTHOR_*`/`GIT_COMMITTER_*`)
  in that same worktree still records the driver.
- `fetch` and `worktree remove` work, and a worktree materialized without a
  profile gets only the mirror default.

### Findings

**F1 — claude `src/mirror.ts:119–136` with `src/runLoop.ts:1167,1187`, and antigravity `src/mirror.ts:124–137` with `src/runLoop.ts:1186–1191`. Shared mirror author.**

- **Rule:** a coordinator-created worktree must keep the author of the issue it
  was materialized for. `issueRuntimePaths` puts `mirror.git` at workspace
  scope, so every issue in the workspace shares its config.
- **Failure (claude):** issue A is frozen to account `a` and has an open
  worktree. The owner re-onboards with `--github-account b` and starts issue
  B, which writes `b` into the shared mirror config. A's next commit in its
  already-open worktree records `b` as author and committer. When A resumes,
  `runLoop` sees that the saved account no longer matches A's frozen account,
  so it passes `null` and leaves `b` in place.
- **Failure (antigravity):** the same switch occurs, but each run's
  `initialize` re-applies its own frozen profile to the shared config. Two
  active issues flip the mirror back and forth, and whichever resumed last
  decides the author of the other issue's open worktrees.
- **Test:** codex's
  `test/mirror.test.ts` "retains the issue author in its worktree after
  another issue changes the mirror defaults". It commits in A's worktree after
  B initializes and expects A's author. It fails against both pins, because
  neither writes per-worktree config.

**F2 — claude `src/setupWorkspace.ts:706` (`clearCloneIdentity`) and `src/install.ts` uninstall. Coord-written author left behind.**

- **Rule:** uninstall reverts the clone-local settings coord wrote. It already
  does this for `coord.githubAccount` and the credential helper. Values the
  owner set must survive.
- **Failure:** onboard with `gwhizofss`, then run `coord uninstall`.
  `coord.githubAccount` and the helper are removed, but `user.name=gwhizofss`
  and `user.email=155764113+gwhizofss@…` remain in every former agent clone
  and in the mirror. A later manual commit in that clone is still attributed
  to an account the workspace no longer selects.
- **Test:** codex's install case. Install with a profile, set
  `user.name "Owner edit"`, uninstall, then expect `user.name` to still be
  `Owner edit` and `user.email` to be unset in both the clone and the mirror.
  The `user.email` assertion fails on claude.

**F3 — antigravity `src/install.ts:392–410`. Direct account-only install sets no author.**

- **Rule (selected plan, `src/install.ts`):** a real direct install without a
  CLI-verified profile must resolve the profile once ("Keep the synchronous
  programmatic entry points usable with an account alone").
- **Failure:** a fresh workspace calls
  `install({ githubAccount: "acct", dryRun: false, … })` with no
  `githubProfile`. `githubProfile` stays `null`, the clones get no
  `user.name`/`user.email`, `config.github` is written without `profile`, and
  nothing says so. This is the issue's original failure, and the
  programmatic `onboard()` entry point has it too.
- **Test:** claude's `test/install.test.ts` "resolves the commit author once for a direct
  account-only install". With a fake `gh` on `PATH`, `installOnce(fixture,
  { origin, githubAccount: "acct" })` should leave `user.email` equal to
  `4242+Acct@users.noreply.github.com`. It fails on antigravity.

**F4 — codex `src/install.ts:397`. A saved profile is never reused on a real run.**

- **Rule:** re-running `install` to repair a workspace that already has a
  matching saved profile must not add a new network or credential dependency.
  Before this issue, repair was purely local, and the CLI already supplies the
  verified profile whenever it has one.
- **Failure:** `if (!githubProfile) { if (!options.dryRun) githubProfile =
  resolveInstallProfile(…) … }` checks the saved `previous.github.profile` only
  for dry runs. A direct `install()` or `onboard()` repair on a machine with no
  `gh` login for that account, or offline, now throws `GitHub authentication
  for acct is unavailable`. It throws before any wiring, even though the saved
  profile already holds the exact values. Codex's own install tests work
  around this by putting a fake `gh` on `PATH` for the repair runs.
- **Test:** install once with `githubProfile: { login: "acct", id: 42 }`.
  Remove the fake `gh` from `PATH`, then run `installOnce(fixture, { origin })`,
  which should succeed with `changes: []`.
- **Fix sketch:** when not a dry run, prefer a matching
  `previous.github.profile` before calling `resolveInstallProfile`.

**F5 — antigravity `src/setupWorkspace.ts:694` (`clearCloneGitHubAuthor`). Removal without provenance.**

- **Rule:** cleanup must keep values the owner supplied, and the code can
  only tell its own writes apart if it recorded them.
- **Failure:** an owner applied the issue's manual workaround before
  upgrading, setting `user.email=155764113+gwhizofss@…` in a clone. They then
  onboard, and later uninstall. The value equals coord's, so uninstall deletes
  it even though coord never wrote it. The mirror's author is not cleared on
  uninstall at all.
- **Comparison:** codex's `gitAuthorEdits`
  (`src/githubAuth.ts:162`) records `{ original, installed }` per key and
  restores `original` only while the current value is still `installed`.

**Note — codex `src/mirror.ts:217` (`enableWorktreeConfig`).** The migration
permanently sets `core.repositoryformatversion=1` and `extensions.worktreeConfig`
on the shared mirror, and nothing reverts them for an ambient workspace or on
uninstall. That needs Git ≥ 2.20 and changes on-disk format for any older tool
that opens the mirror. I found no functional failure, since the replica above
passed. It is a one-way change reviewers should accept knowingly.

### Scope, reuse and tests

- **claude:** the smallest diff that follows the plan, and it reuses
  `configureCloneIdentity`'s `desired` list directly.
  - **Tests:** real commits checked by header fields: mirror worktree, clone
    after onboard, and evidence author with a mirror author present. It has
    offline repair, a direct-lookup case, and owner-identity preservation.
  - **Gaps:** F1 and F2.
- **codex:** the most complete behaviour and the only pin that closes F1 and F2.
  - **Cost:** more new logic, namely the receipt JSON in `githubAuth.ts`, a
    hand-written config-lock migration in `mirror.ts`, and a new `start.json`
    field with a refinement.
  - **Reuse:** factoring `tokenLookupArgs`/`selectedGhEnv` out of
    `resolveGitHubToken` keeps the sync path from duplicating token handling.
  - **Tests:** cross-issue isolation, ambient restore, and uninstall
    provenance.
  - **Remaining defect:** F4.
- **antigravity:** close to claude in shape, and adds a frozen `start.json` profile.
  - **Effect of the frozen profile:** it does not isolate issues (F1), because
    it writes to the shared config.
  - **Plan deviation:** it drops the plan's direct-install lookup (F3).
  - **Uninstall:** it removes author values without provenance (F5).

**Ranking.** codex, then claude, then antigravity.

- **codex** is the only implementation that keeps an issue's author correct
  when the workspace account changes (F1). It also handles uninstall without
  deleting owner values (F2, F5). F4 is a small, local fix.
- **claude** meets the issue for the single-account case. F1 is real and
  covered by a peer test that would fail against it.
- **antigravity** shares F1 and adds a silent no-author path on direct
  installs (F3).
