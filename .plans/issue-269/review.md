# Plan review — issue 269

Reviewed bound plans:

- claude `6367a41864df4fd1fbbcce0879939d74abdaa87e` (`.plans/issue-269/plan.md`)
- codex `f4882fc2ecab6914dd53937b877e8ca29ddb8a5a` (`.plans/issue-269/plan.md`)
- antigravity `c308aacb18113fd52084f8fb64c19d0161c99c61` (`.plans/issue-269/plan.md`)

All three plans agree on the core. Read `id` from the `gh api user` call that
`verifyGitHubAccess` already makes. Derive `<id>+<login>@users.noreply.github.com`.
Write clone-local `user.name`/`user.email` through `configureCloneIdentity`'s
idempotent `desired` list. Keep `COORDINATOR_EVIDENCE_AUTHOR` for evidence
commits. Keep `user.*` out of `IDENTITY_KEYS`. They differ on coordinator-created
worktrees, on how install obtains the id, and on how much diagnostic surface to add.

Investigation I ran (no product suite; I ran no tests): two throwaway Git
experiments in the scratchpad on Git 2.54.0. Each used a bare repository with a
`worktree add --detach` linked worktree, mirroring `BareMirror.materializeWorktree`.
Results are cited below.

## Findings

### F1 — antigravity, §6 `src/mirror.ts` (`extensions.worktreeConfig` + `config --worktree`) — blocking

**Plan claim.** `materializeWorktree` sets `core.repositoryformatversion 1` and
`extensions.worktreeConfig true` on `mirror.git`. It then writes
`--worktree user.name/user.email` in the target, "covering all three call sites"
(bound inputs, verification, evidence).

**Rule.** Every worktree materialized from the mirror must remain a usable
non-bare work tree. `createEvidenceCommit` (`src/ballotPublication.ts:510–537`)
runs `git add` and `git commit` inside one. `verificationRunner.ts:219` runs
product checks inside another.

**Failure.** The mirror is bare: `core.bare=true` sits in its common `config`.
With `extensions.worktreeConfig` enabled and `core.bare` not moved to
`config.worktree`, Git applies `core.bare=true` to every linked worktree. I
reproduced this exactly as the plan sequences it:
`git -C wt1 rev-parse --is-bare-repository` → `true`;
`git -C wt1 add f` → `fatal: this operation must be run in a work tree` (exit 128);
`git -C wt1 commit` → same. A second worktree materialized *without* an author
(`wt2`) was also broken (`git -C wt2 status` → same fatal). The extension is
repository-wide, so the plan's "no leak to an unselected worktree" isolation
does not hold. Followed as written, the first ballot batch after a bound
workspace materializes a worktree fails at `git add failed for evidence commit`.
Every later evidence publication, for any workspace sharing that mirror, fails
the same way. The plan's own Test 6 (`createEvidenceCommit` still authors as
`COORDINATOR_EVIDENCE_AUTHOR`) would fail before it reached the author assertion.

**Smallest correction.** Drop `extensions.worktreeConfig`. Write `user.name`/`user.email`
into the mirror's local config as codex proposes. I verified that a linked
worktree then commits as `gwhizofss <155764113+gwhizofss@users.noreply.github.com>`
for both author and committer. An evidence-style commit with `-c user.*` plus
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` in the same worktree still records
`Coordination Driver <coordination@local>`.

### F2 — antigravity, §7 `src/cli.ts` (`preflightGitHubAccount` passes `access.gitAuthor` to `cloneGitHubWiringProblem`)

**Plan claim.** The preflight for `coord start`, `run`, `attach`, `auth status`
and `auth login` refuses when a clone's `user.name`/`user.email` is missing or
differs. The doctor flags legacy configs without `gitAuthor`.

**Rule.** Upgrading coord must not stop an already-wired workspace from resuming
an in-flight issue because of a gap that only affects attribution.
`preflightIssueGitHub` (`src/cli.ts:928–941`) runs on resume, run and attach for
every active agent clone.

**Failure.** Every workspace onboarded by ≤ 0.0.98 has `coord.githubAccount` and
no clone-local `user.*`. This workspace is one: its clones carry
`coord.githubaccount gwhizoftv` and only the global identity. After upgrading to
the implementation, `coord run`/`attach` for the active issue throws
`…Run: coord onboard …` before any work, so the issue is stuck until the owner
re-onboards mid-issue. The plan offers no in-place repair. The refusal is also
scope beyond the issue, which asks onboarding to *set* the identity.

**Smallest correction.** Leave `preflightGitHubAccount` unchanged. If a
diagnostic is wanted, make it a non-fatal doctor warning. Re-onboarding repairs
the clones through `configureCloneIdentity`.

### F3 — antigravity, scope (17 files: `doctor.ts`, start-state schema + refinement, `runLoop` legacy fallback, preflight)

**Plan claim.** Doctor findings, a new frozen `start.json` field `githubAuthor`
with a cross-field refinement, a `runLoop` legacy-config fallback, preflight
author checks, and README changes, all under "strictly within issue #269".

**Rule.** Make the smallest change that fully solves the issue and justify each
added mechanism (AGENTS.md "Implementation discipline").

**Failure.** Doctor, preflight and the start-state freeze are not needed to set
the identity. Codex shows the mirror can get the author from the workspace
config the run loop already reads. Each addition widens the review and test
surface: test files for `doctor`, `state`, `runLoop` and `cli` preflight. Each
also adds a failure path of its own (F2). The plan justifies none of them
against a smaller option.

**Smallest correction.** Drop the doctor, preflight and `startStateSchema`
changes and the `runLoop` fallback. Persist the author once in the workspace
config, and apply it to clones at install and to the mirror at initialization.

### F4 — codex, `src/install.ts` ("for a real direct install without a preverified CLI result … fetch the authenticated profile once")

**Plan claim.** `install` stays synchronous and usable with an account alone. A
non-dry-run direct call without a CLI-verified profile resolves the credential
and calls GitHub itself.

**Rule.** Reuse the existing account-bound lookup rather than add a second
implementation. Tests stay hermetic. `install` (`src/install.ts:316`) and
`onboard` (`:926`) are synchronous. `resolveGitHubToken`, `withGitHubAccount`
and `verifyGitHubAccess` are all async `ProcessRunner` code.

**Failure.**
- **Duplicated auth code:** the lookup needs a new `spawnSync` copy of the token
  resolution, ambient-token scrubbing and `/user` validation, outside the tested
  async path. Otherwise `install`/`onboard` become async and every caller and
  `installOnce` changes.
- **Existing tests reach the real `gh`:** two account-bound tests run with no
  fake `gh` on PATH. One is the selected-account wiring test
  (`installOnce(fixture, { origin, githubAccount: "acct" })`,
  `test/install.test.ts:403`), with its offline `dryRun` repair. The other is the
  launcher test (`:433`). Followed as written, both run the developer's real
  `gh auth token --user acct`. On CI or any machine without that login, the
  install throws. Where a login happens to exist, the result depends on the
  machine.

**Smallest correction.** Make the verified profile an input: the CLI already
verifies before every non-dry-run install and onboard. Fall back to the saved
profile for a matching account. Otherwise leave `user.*` untouched, or refuse,
without calling GitHub from inside `install`.

### F5 — claude, Scope boundaries ("bare mirror's detached worktrees … not changed")

**Plan claim.** Only agent clones are commit sites. Mirror-linked worktrees are
read-only inputs, so they get no author.

**Rule.** The issue requires the selected identity "wherever agents create
commits, including coordinator-created worktrees".

**Failure.** Bound implementation and revision pins are exported as full
detached worktrees under `coord-runtime/issue-<n>/worktrees/<agent>-<sha8>/`
(`src/materializedInputs.ts:94–95`), and the action tells agents to work from
them. Any `git commit` there reads the mirror's config and then the global
config. For this owner that records `gwhizoftv <personal email>`, the
misattribution the issue reports. The plan defers to a protocol expectation
instead of meeting the issue's explicit requirement. My own rejected
alternative was more costly than claimed: codex shows the mirror can take the
author from config the run loop already reads, with no start-state freeze.

**Smallest correction.** Adopt codex's mirror-local `user.*` in
`BareMirror.initialize` (plus repair of an existing mirror). Evidence authorship
is unaffected (F1 experiment).

### F6 — claude, Risks ("`user.name` uses the configured account string")

**Plan claim.** `user.name` is the account string as typed or saved. GitHub
login casing is treated as irrelevant.

**Rule.** The issue specifies `user.name=gwhizofss`, GitHub's login.
`verifyGitHubAccess` accepts the selection case-insensitively
(`src/githubAuth.ts:151`), so the saved account can differ in case from the login.

**Failure.** `coord onboard … --github-account GWhizOFSS` passes verification.
It then writes `user.name=GWhizOFSS` and `user.email=155764113+GWhizOFSS@…`
into every clone, so the commit header no longer shows the canonical login the
issue asks for.

**Smallest correction.** Persist and use `access.login` (canonical) beside the
id, as codex and antigravity do.

### Scope, reuse and tests — summary

- **codex:** stays within the issue apart from F4 and adds no new files.
  - **Reuse:** it reuses `verifyGitHubAccess`, `configureCloneIdentity`,
    `act`/`localConfig*`, `BareMirror.initialize` and the existing fixtures.
  - **Tests:** each test fails before the change. The README edit is justified
    because the README currently says only the account name is stored.
  - **Vitest configs:** the plan's split matches the repo.
    `onboard`/`install`/`cli` are excluded from `vitest.config.ts` and included
    in `vitest.system.config.ts`.
- **claude:** smallest and focused, but it under-delivers the stated requirement
  (F5, F6).
- **antigravity:** a correct clone path, but the mirror mechanism is broken (F1)
  and the plan is over-scoped (F2, F3).

## Conclusion

Prefer the **codex** plan, with F4 corrected: the CLI-verified profile becomes an
input to `install`/`onboard`, with the saved profile as the offline fallback and
no GitHub lookup inside synchronous `install`. It is the only plan that both
meets the issue's "including coordinator-created worktrees" requirement and uses
a mirror mechanism I could confirm works. The antigravity plan should not be
selected as written: F1 breaks evidence publication and verification worktrees
on a bare mirror. My own (claude) plan is a sound subset for clones but falls
short of the issue (F5) and should take the canonical login (F6).
