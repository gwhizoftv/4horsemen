# Issue 269 Plan Review

Reviewed bound plans:

- **claude** (`6367a41864df4fd1fbbcce0879939d74abdaa87e`): `.plans/issue-269/plan.md`
- **codex** (`f4882fc2ecab6914dd53937b877e8ca29ddb8a5a`): `.plans/issue-269/plan.md`
- **antigravity** (`c308aacb18113fd52084f8fb64c19d0161c99c61`): `.plans/issue-269/plan.md`

## Findings

### Claude plan (`6367a41864df4fd1fbbcce0879939d74abdaa87e`)

1. **Plan claim/section**: "Reuse and Scope — Scope boundaries" and "Alternatives Rejected" ("Set `user.*` in the bare mirror config (covers mirror-linked worktrees)... Doing so would require freezing the id into issue start state and plumbing it through `startEffects`/`RunLoop` for no commit an agent makes").
   - **Rule that must hold**: Issue #269 explicitly requires configuring `user.name` and `user.email` "wherever agents create commits, including coordinator-created worktrees."
   - **Concrete failure if followed as written**: Every detached worktree created by `BareMirror.materializeWorktree` (materialized input worktrees and verification worktrees) has no repo-local or worktree-local `user.name`/`user.email`. Any commit made in a coordinator-created worktree falls back to the machine's global `~/.gitconfig` (e.g. a different GitHub user), leaving the commit unlinked or misattributed on GitHub.
   - **Smallest correction**: Propagate the resolved author identity into `BareMirror` (freezing it in `start.json` alongside `githubAccount`) and configure per-worktree `user.name`/`user.email` in `BareMirror.materializeWorktree`, while keeping `createEvidenceCommit`'s explicit `COORDINATOR_EVIDENCE_AUTHOR` override untouched.

2. **Plan claim/section**: "Behaviour after the change", "Exact File List — `src/githubAuth.ts`, `src/install.ts`", and "Risks and Mitigations — Login casing" (`githubCommitIdentity(account, id)` constructs `user.name` and `user.email` from the user-supplied `account` string rather than `login` from `gh api user`).
   - **Rule that must hold**: `user.name` and `<id>+<login>@users.noreply.github.com` must use the canonical GitHub `login` returned by `GET /user`, not arbitrary input casing passed to `--github-account`.
   - **Concrete failure if followed as written**: Onboarding with `--github-account GWhizOfSS` succeeds (since `verifyGitHubAccess` compares logins case-insensitively), yet writes `user.name=GWhizOfSS` and `user.email=155764113+GWhizOfSS@users.noreply.github.com` instead of GitHub's canonical `gwhizofss`.
   - **Smallest correction**: Derive `user.name` and `user.email` from `access.login` returned by `gh api user` and store that canonical author/login in workspace config.

3. **Plan claim/section**: "Exact File List" (no updates to `cloneGitHubWiringProblem` in `src/setupWorkspace.ts`, `preflightGitHubAccount` in `src/cli.ts`, or `src/doctor.ts`) and "Risks and Mitigations — Start preflight (`cli.ts:920`) also calls `verifyGitHubAccess`. It ignores the new `id`."
   - **Rule that must hold**: Existing workspaces upgraded from coord 0.0.92 (which already have `coord.githubAccount` and a credential helper, but no `user.name`/`user.email`) and clones whose local author config drifted must be caught by `coord doctor`, `coord auth status`, and `coord start`/`coord run` preflight before misattributed commits are authored.
   - **Concrete failure if followed as written**: On a SoundSplore workspace onboarded under coord 0.0.92, `coord doctor`, `coord auth status`, and `coord start` all pass with zero findings (`agent clones wired`), allowing agents to continue committing with the global Git author until the operator manually thinks to re-run `coord onboard`.
   - **Smallest correction**: Extend `cloneGitHubWiringProblem` (called by `preflightGitHubAccount`) to verify clone-local `user.name`/`user.email`, and check `config.github` author wiring in `src/doctor.ts`.

4. **Plan claim/section**: "Exact File List" omits `README.md`.
   - **Rule that must hold**: Documentation describing what `--github-account` persists and configures must match the implemented behavior.
   - **Concrete failure if followed as written**: `README.md` line 120 continues to claim "Coord stores only the account name" after `github.userId` is persisted in `config.json` and `user.name`/`user.email` are written to clones.
   - **Smallest correction**: Update `README.md` lines 120–125.

- **Scope, reuse, new files, and tests**: Stays well within the issue, creates zero new files, reuses `verifyGitHubAccess`, `configureCloneIdentity`, `act`, and existing test helpers, and proposes concise, focused tests. Its main defects are the explicit omission of coordinator-created worktrees (Finding 1) and the lack of doctor/preflight verification for missing/drifted author config (Finding 3).

---

### Codex plan (`f4882fc2ecab6914dd53937b877e8ca29ddb8a5a`)

1. **Plan claim/section**: "Exact File List — `src/mirror.ts` and `src/runLoop.ts`" ("Let `BareMirror.initialize` apply the supplied author to the bare repository's local config... An initialization without a profile leaves any previously installed local author in place.") and "Alternatives Rejected" ("The mirror initialization and existing-mirror repair paths cover all linked worktrees without per-worktree configuration.").
   - **Rule that must hold**: Removing or switching a workspace's GitHub account must never leak a previous account's `user.name`/`user.email` into future ambient or differently bound worktrees, and an issue's frozen `start.json` identity must not depend on mutable `config.json` state surviving unchanged across resumes.
   - **Concrete failure if followed as written**: (a) If a workspace uses `--github-account acctA` (writing `user.name`/`user.email` into `<mirror.git>/config`) and later switches back to ambient credentials (removing `github` from `config.json`), `BareMirror.initialize` is explicitly specified to leave any previously installed local author in place, so every subsequent ambient worktree silently attributes commits to `acctA`. (b) Because the author profile is not frozen into `start.json`, resuming an issue after `config.json` is changed to another account or removed causes `initializeEffects` to skip passing a profile and leaves whatever stale author happened to sit in `mirror.git/config`.
   - **Smallest correction**: Freeze `githubAuthor` alongside `githubAccount` in `start.json` (with optional fallback to `config.json` only for legacy `start.json`), and write `user.name`/`user.email` per worktree via `extensions.worktreeConfig = true` + `git -C <target> config --worktree` in `BareMirror.materializeWorktree` so unselected worktrees inherit nothing and `removeWorktree` automatically removes the author config.

2. **Plan claim/section**: "Exact File List" omits `src/doctor.ts` and does not extend `cloneGitHubWiringProblem` in `src/setupWorkspace.ts` or `preflightGitHubAccount` in `src/cli.ts`.
   - **Rule that must hold**: `coord doctor`, `coord auth status`, and `coord start`/`coord run` preflight must detect clones missing or drifting from the selected account's `user.name`/`user.email` (including coord 0.0.92 installations).
   - **Concrete failure if followed as written**: An existing SoundSplore workspace onboarded under coord 0.0.92 passes `coord doctor`, `coord auth status`, and `coord start` without error even though every clone still lacks `user.name`/`user.email`, so agents continue authoring misattributed commits.
   - **Smallest correction**: Verify `user.name`/`user.email` inside `cloneGitHubWiringProblem` (used by `preflightGitHubAccount`) and emit a `DOCTOR_CODES.identity` finding in `src/doctor.ts` when `config.github` has no author profile or a clone's local author mismatches.

3. **Plan claim/section**: "Exact File List — `src/setupWorkspace.ts`" ("Keep user-owned author keys out of the unconditional uninstall key list") with no conditional uninstall cleanup.
   - **Rule that must hold**: `coord uninstall` must clean up clone-local `user.name`/`user.email` values that `coord` itself configured for a selected GitHub account while preserving owner-set values, matching `clearCloneGitHubCredential`.
   - **Concrete failure if followed as written**: Running `coord uninstall` removes `coord.githubAccount` and the GitHub credential helper, but leaves `user.name=gwhizofss` and `user.email=155764113+gwhizofss@users.noreply.github.com` stranded in every agent clone's `.git/config`, causing later manual commits in those clones to use the uninstalled workspace's noreply identity.
   - **Smallest correction**: Add a `clearCloneGitHubAuthor` helper invoked by `uninstall()` that unsets local `user.name` and/or `user.email` only when they match the values `coord` recorded in `config.github`.

4. **Plan claim/section**: "Exact File List — `src/install.ts`" ("Keep the synchronous programmatic entry points usable with an account alone. For a real direct install without a preverified CLI result, resolve the named credential with ambient tokens removed and fetch the authenticated profile once, using the same validation.").
   - **Rule that must hold**: GitHub token resolution and API verification must stay consolidated in `src/githubAuth.ts` (`resolveGitHubToken`, `withGitHubAccount`, `verifyGitHubAccess`) and async CLI callers (`src/cli.ts`), rather than duplicating synchronous `gh` subprocess logic inside `src/install.ts`.
   - **Concrete failure if followed as written**: Adding a synchronous `gh auth token` + `gh api user` path inside `src/install.ts` duplicates ambient-token scrubbing, timeout handling, and HTTP 401/error classification outside `src/githubAuth.ts`, creating two divergent auth paths and violating the existing boundary where `install()` performs local mutations while `cli.ts` performs async GitHub lookups.
   - **Smallest correction**: Require callers of non-dry-run `install()` to pass the verified author profile (supplied by `cli.ts`'s `verifyInstallAccount` or carried forward from a matching saved config), keeping all `gh` execution in `src/githubAuth.ts`.

5. **Plan claim/section**: "Exact File List — `test/cli.test.ts`" ("Update the account runner's authenticated-user fixture and assert the verified identity reaches start effects").
   - **Rule that must hold**: All existing `gh api user` test stubs in `test/cli.test.ts` — including the two inline `gh` mocks in the `install` dry-run and repair tests at lines 2218–2219 and 2265–2266 (not just `accountRunner` at line 798) — must match the updated `gh api user` invocation and JSON output format.
   - **Concrete failure if followed as written**: Updating only `accountRunner` leaves lines 2218–2219 and 2265–2266 returning plain `"acct\n"` (and branching on `argv.length === 3` before checking `argv[2] === "user"` if `--jq` is removed), breaking both existing `install` CLI tests.
   - **Smallest correction**: Explicitly update all three `gh api user` stubs in `test/cli.test.ts`.

- **Scope, reuse, new files, and tests**: Correctly covers both agent clones and coordinator-created worktrees, creates zero new files, updates `README.md`, and proposes focused real-commit tests (good catch on scrubbing the fixture helper's synthetic `GIT_AUTHOR_*` env when asserting real commit metadata). However, mutating `<mirror.git>/config` without ambient cleanup, omitting `start.json` freeze, omitting doctor/preflight checks and uninstall cleanup, and duplicating synchronous `gh` calls inside `src/install.ts` are concrete design flaws.

---

### Antigravity plan (`c308aacb18113fd52084f8fb64c19d0161c99c61`)

1. **Plan claim/section**: "Tests" (items 3 and 5 in `test/install.test.ts` and `test/mirror.test.ts` asserting real commit attribution against a conflicting `GIT_CONFIG_GLOBAL`).
   - **Rule that must hold**: Any test verifying that `git commit` reads repo-local or worktree-local `user.name`/`user.email` must run `git commit` with `GIT_AUTHOR_*` and `GIT_COMMITTER_*` unset, because `test/support/workspaceFixture.ts`'s `git()` helper unconditionally injects `GIT_AUTHOR_NAME=Fixture` / `GIT_AUTHOR_EMAIL=fixture@example.com` (lines 48–51).
   - **Concrete failure if followed as written**: Calling the shared `git()` helper from `test/support/workspaceFixture.ts` to run `git commit` in `test/install.test.ts` would override the clone's local `user.name`/`user.email` with `Fixture <fixture@example.com>` and fail the assertion (or pass vacuously if it didn't inspect `git log`).
   - **Smallest correction**: Invoke `execFileSync("git", ...)` directly with `hermeticGitEnv()` (plus `GIT_CONFIG_GLOBAL` set to a temp config) for the real-commit attribution assertions in `test/install.test.ts` and `test/mirror.test.ts`.

2. **Plan claim/section**: "Exact File List — `src/mirror.ts`" (`BareMirror.materializeWorktree` configures `--worktree user.name`/`user.email` on every newly created worktree).
   - **Rule that must hold**: Existing worktrees reused within an active issue (`src/materializedInputs.ts:261`, which skips `materializeWorktree` when `worktreeHead(localPath) === bound.commitSha`) and newly materialized worktrees should both behave consistently.
   - **Concrete failure if followed as written**: Only a narrow legacy-upgrade edge case is affected — if an issue was already mid-flight under coord 0.0.92 with a pre-existing `issue-N/worktrees/<agent>-<sha8>/` directory on disk, resuming that issue reuses that read-only directory without re-running `materializeWorktree` (all newly created worktrees after upgrade do get `config.worktree`).
   - **Smallest correction**: Acceptable as-is because reused materialized input worktrees are read-only (`makeFilesReadOnly`) and newly created worktrees receive `config.worktree`; no extra mutation path in `materializedInputs.ts` is warranted.

- **Scope, reuse, new files, and tests**: Covers both agent clones and coordinator-created worktrees (isolated per worktree via `extensions.worktreeConfig`), uses canonical `login` and numeric `id` from `verifyGitHubAccess` without duplicating `gh` calls, freezes `githubAuthor` into `start.json`, adds backward-compatible optional schemas, enforces wiring in both `doctor.ts` and `preflightGitHubAccount`, cleans up selectively on `uninstall`, updates `README.md`, creates zero new files, and adds focused tests in existing suites.

## Conclusion

- **Antigravity's plan (`c308aacb18113fd52084f8fb64c19d0161c99c61`)** is the most complete and mechanically sound plan: it satisfies every requirement of issue #269 (both agent clones and coordinator-created worktrees), avoids `<mirror.git>/config` author bleed via per-worktree `config.worktree`, preserves canonical GitHub login casing, catches legacy coord 0.0.92 clones in both `doctor` and `preflightGitHubAccount`, cleans up coord-managed author keys selectively on `uninstall`, keeps all `gh` calls in `src/githubAuth.ts`, and creates no new files (noting only the test-helper detail to scrub `GIT_AUTHOR_*` during real-commit tests).
- **Codex's plan (`f4882fc2ecab6914dd53937b877e8ca29ddb8a5a`)** covers both clones and worktrees and includes a strong real-commit test plan, but has concrete defects around `<mirror.git>/config` leakage into unbound workspaces, unfrozen `start.json` author state, missing doctor/preflight verification, missing uninstall cleanup, and duplicated synchronous `gh` execution in `src/install.ts`.
- **Claude's plan (`6367a41864df4fd1fbbcce0879939d74abdaa87e`)** is concise and clean for agent clones, but explicitly omits coordinator-created worktrees required by issue #269, uses raw account casing instead of canonical GitHub `login`, and omits doctor/preflight verification and `README.md`.
