## Comparison

Compared bound implementation pins against issue #269 and the selected plan (`f4882fc2ecab6914dd53937b877e8ca29ddb8a5a`):

- **antigravity**: `ff396b3133e38227179375cd5a19ff4a36353e39`
- **claude**: `7e2b1c39be95ada9c63aa87de41f4eb29397506f`
- **codex**: `c16f985990d637db91a10d2be26d4bbe8f944559`

### Scope, Reuse, and Test Focus

All three implementations stay strictly within the issue and `approvedPaths`, create zero new files or dependencies, reuse `verifyGitHubAccess` (`gh api user --jq "{login,id}"`), `configureCloneIdentity`, `localConfigGet`/`localConfigSet`, `act`, `BareMirror.initialize`, and existing test fixtures, keep `config.github.profile` optional for backward compatibility with coord 0.0.92 configs, preserve `COORDINATOR_EVIDENCE_AUTHOR` on ballot commits, and update `README.md`.

They differ meaningfully on three design axes:

1. **Mirror worktree isolation and ambient cleanup**: Only **codex** (`c16f985990d637db91a10d2be26d4bbe8f944559`) safely migrates `core.bare`/`core.worktree` to `config.worktree` under `config.lock` before enabling `extensions.worktreeConfig`, scoping each frozen issue's author to its own worktree while also maintaining workspace defaults and restoring ambient attribution when unbound. Both **antigravity** (`ff396b3133e38227179375cd5a19ff4a36353e39`) and **claude** (`7e2b1c39be95ada9c63aa87de41f4eb29397506f`) write `user.name`/`user.email` only into shared `<mirror.git>/config` and never clear it on ambient unbind or mirror uninstall.
2. **Owner-identity provenance on uninstall/unbind**: **codex** (`c16f985990d637db91a10d2be26d4bbe8f944559`) records a small provenance receipt (`coord.managedGitAuthor`) per changed key so uninstall/unbind restores prior owner values (or unsets if originally absent) while preserving post-install owner edits in both clones and `mirror.git`. **antigravity** (`ff396b3133e38227179375cd5a19ff4a36353e39`) unsets matching values on clones only (losing pre-existing owner values and skipping `mirror.git`). **claude** (`7e2b1c39be95ada9c63aa87de41f4eb29397506f`) leaves coord-written `user.name`/`user.email` behind on uninstall.
3. **Programmatic `install({ githubAccount })` without `githubProfile`**: **claude** (`7e2b1c39be95ada9c63aa87de41f4eb29397506f`) and **codex** (`c16f985990d637db91a10d2be26d4bbe8f944559`) both implement the selected plan's synchronous `gh` fallback, with **claude** reusing a matching saved profile first and **codex** re-querying `gh` on non-dry-run repairs. **antigravity** (`ff396b3133e38227179375cd5a19ff4a36353e39`) avoids duplicating synchronous `gh` calls, but as a consequence a direct programmatic first install without `githubProfile` skips setting `user.name`/`user.email`.

---

### Findings — codex (`c16f985990d637db91a10d2be26d4bbe8f944559`)

1. **`src/install.ts:396-399`**
   - **Rule**: A non-dry-run programmatic repair (`install()` without `githubProfile`) on an already-configured workspace whose saved `previous.github.account` matches `githubAccount` should reuse `previous.github.profile` without requiring a live `gh` lookup, matching the `dryRun: true` branch on line 398.
   - **Concrete failure**: When `options.githubProfile` is omitted and `options.dryRun` is `false`, line 397 unconditionally runs `resolveInstallProfile(githubAccount, productRoot)` (`spawnSync("gh", ...)`) even when `previous.github.profile` is already saved for the exact same account. An offline programmatic repair fails with `GitHubAuthError` instead of reusing the saved profile.
   - **Illustrative test**: In `test/install.test.ts`, after installing with `githubAccount: "acct"` and `githubProfile: { login: "Acct", id: 42 }`, point `PATH` at a `gh` stub that exits `1`, then call `installOnce(fixture, { origin })`; expect it to succeed with `changes: []` using the saved profile.

2. **`src/githubAuth.ts:192-208`**
   - **Rule**: When `gh api user` succeeds for a different or empty login (e.g. `{"login":"someone-else","id":null}` or `{"login":"","id":null}`), `authenticatedProfile` should report the actionable login-mismatch error (`Run: coord auth login`) rather than only a missing numeric ID error.
   - **Concrete failure**: `githubProfileSchema.parse(JSON.parse(result.stdout))` executes at line 199 before the login check at line 203, so a credential returning `{"login":"someone-else","id":null}` throws `"expected a login and a positive numeric user ID"` instead of `"The saved GitHub credential for acct authenticates as someone-else.\nRun: coord auth login"`.
   - **Illustrative test**: In `test/githubAuth.test.ts`, invoke `verifyGitHubAccess` with `gh api user` returning `JSON.stringify({ login: "someone-else", id: null })` and assert it rejects with `"authenticates as someone-else"` and `"Run: coord auth login"`.

3. **`test/ballotPublication.test.ts` (untested interaction with `src/mirror.ts:217-263`)**
   - **Rule**: Because `BareMirror.materializeWorktree` migrates `core.bare` to `config.worktree`, enables `extensions.worktreeConfig`, and writes `--worktree user.name`/`user.email`, `createEvidenceCommit` must be verified against a profile-bound `BareMirror` to guard against regressions in evidence publication authorship or worktree behavior.
   - **Concrete failure**: `test/ballotPublication.test.ts` was left untouched in `c16f985990d637db91a10d2be26d4bbe8f944559` and only constructs `new BareMirror(mirrorPath, origin)` (`auth = null`), so the `enableWorktreeConfig()` + `--worktree user.*` path is never exercised under `createEvidenceCommit`.
   - **Illustrative test**: In `test/ballotPublication.test.ts`, initialize `new BareMirror(mirrorPath, origin, undefined, { account: "gwhizofss", cliEntry: "/coord/dist/main.js", profile: { login: "gwhizofss", id: 155764113 } })` via `await mirror.initialize({ login: "gwhizofss", id: 155764113 })`, run `createEvidenceCommit`, and assert the resulting commit author is still `${COORDINATOR_EVIDENCE_AUTHOR.name} <${COORDINATOR_EVIDENCE_AUTHOR.email}>`.

---

### Findings — antigravity (`ff396b3133e38227179375cd5a19ff4a36353e39`)

1. **`src/mirror.ts:124-137` and `src/install.ts:775`**
   - **Rule**: Detached worktrees created for a frozen issue must keep that issue's author if another issue changes workspace mirror defaults, ambient (unbound) runs must not inherit a previously bound account's author from `mirror.git`, and `uninstall` without `--wipe-runtime` must clean up coord-written `mirror.git` author settings.
   - **Concrete failure**: `BareMirror.initialize` writes `user.name`/`user.email` only into shared `<mirror.git>/config` and skips cleanup when `author === null`; `uninstall()` clears clones (`src/install.ts:775`) but never touches `mirror.git`. Opening a detached worktree for `acctA` and then initializing `mirror.git` for `acctB` causes the open `acctA` worktree to commit as `acctB`, and switching the workspace to ambient credentials (or uninstalling without `--wipe-runtime`) leaves `acctA` active in `mirror.git/config` for all future detached worktrees.
   - **Illustrative test**: Initialize `mirror.git` with `acctA`, materialize detached worktree `wtA`, then initialize the same `mirror.git` with `acctB` (and later with `null` for an ambient run); commit in `wtA` and in a newly materialized ambient worktree, asserting `wtA` still records `acctA` and the ambient worktree does not inherit `acctA` or `acctB`.

2. **`src/install.ts:390-410`**
   - **Rule**: Per the selected plan (`f4882fc2ecab6914dd53937b877e8ca29ddb8a5a`, `src/install.ts`), a non-dry-run programmatic `install({ ..., githubAccount })` call without a preverified `githubProfile` must still resolve and apply `user.name`/`user.email` rather than silently leaving them unset.
   - **Concrete failure**: Calling `install({ origin, githubAccount: "acct", ... })` directly on a new workspace without `githubProfile` resolves `githubProfile = null` and completes with `coord.githubAccount=acct` set but `user.name` and `user.email` unset in every clone.
   - **Illustrative test**: In `test/install.test.ts`, put a fake `gh` on `PATH` returning `{"login":"Acct","id":42}`, run `installOnce(fixture, { origin, githubAccount: "acct" })` without `githubProfile`, and assert `git(clone, "config", "--local", "--get", "user.email")` is `"42+Acct@users.noreply.github.com"`.

3. **`src/setupWorkspace.ts:686-700`**
   - **Rule**: When `coord install` overwrites a pre-existing local `user.name` or `user.email` in an adopted clone, `coord uninstall` should restore the pre-existing owner value (when unmodified since install) rather than unsetting it.
   - **Concrete failure**: `clearCloneGitHubAuthor` records no prior values; adopting a clone that already had `user.name="Owner Name"`, binding `acct`, and uninstalling deletes `user.name` instead of restoring `"Owner Name"`.
   - **Illustrative test**: Pre-create a clone with `user.name="Owner Name"`, run `installOnce` with `githubAccount: "acct"` and `githubProfile`, then run `uninstallOnce`; assert `localConfigGet(clone, "user.name")` is `"Owner Name"`.

---

### Findings — claude (`7e2b1c39be95ada9c63aa87de41f4eb29397506f`)

1. **`src/install.ts:526-534`**
   - **Rule**: Repairing an existing `<workspaceRoot>/mirror.git` must verify symlink containment (`assertNoSymlink`) before invoking `git config --local`, so a symlink inside the workspace root cannot redirect writes to an external bare repository.
   - **Concrete failure**: Line 527 uses `containedPath(workspace.workspaceRoot, "mirror.git")` (lexical containment only) without `assertNoSymlink`. If `<workspaceRoot>/mirror.git` is a symlink to a bare repository outside the workspace, `rev-parse --is-bare-repository` returns `"true"` and `configureRepositoryAuthor` overwrites `user.name`/`user.email` in that external repository.
   - **Illustrative test**: Create a bare repo outside `fixture.coordRoot`, symlink `join(fixture.coordRoot, "mirror.git")` to it, run `installOnce(fixture, { origin, githubAccount: "acct", githubProfile: { login: "acct", id: 4242 } })`, and assert it throws a symlink containment error without modifying the external repo.

2. **`src/setupWorkspace.ts:706-712` and `src/install.ts:750-780`**
   - **Rule**: `coord uninstall` must remove or restore coord-written `user.name`/`user.email` in agent clones and `mirror.git` while preserving owner-configured or owner-edited values, matching `clearCloneGitHubCredential`.
   - **Concrete failure**: Neither `clearCloneIdentity` nor `uninstall()` touches `user.name`/`user.email` in clones or `mirror.git`. After `coord uninstall`, `coord.githubAccount` and the credential helper are gone, but `user.name=acct` and `user.email=4242+acct@users.noreply.github.com` remain stranded in every clone and in `mirror.git`.
   - **Illustrative test**: In `test/install.test.ts` after `uninstallOnce(fixture)` (line 447), assert `tryGit(clone, "config", "--local", "--get", "user.email").exitCode !== 0` and `tryGit(mirror, "config", "--local", "--get", "user.email").exitCode !== 0`.

3. **`src/state.ts:448-490`, `src/runLoop.ts:1159-1187`, and `src/mirror.ts:119-138`**
   - **Rule**: An issue's verified GitHub profile must be frozen with the issue (not lost when `config.json` changes), open worktrees must retain their issue's author when another issue changes workspace defaults, and switching a workspace back to ambient credentials must not leave a previous account's `user.name`/`user.email` active in `mirror.git/config`.
   - **Concrete failure**: `startStateSchema` does not freeze `githubProfile`, `runLoop.ts:1165` only reads `config.github.profile` when `config.github.account` still matches `start.githubAccount`, and `BareMirror.initialize` writes only to shared `<mirror.git>/config` while returning early on `author === null`. Switching to ambient credentials leaves the prior bound account active for all new detached worktrees, and switching `config.json` to `acctB` overwrites `mirror.git/config` for any open `acctA` worktree and prevents a resumed `acctA` issue from applying its own author.
   - **Illustrative test**: Same multi-issue / ambient mirror test as Antigravity Finding 1.

---

### Summary Ranking

1. **codex (`c16f985990d637db91a10d2be26d4bbe8f944559`)** — Best implementation: solves all clone, mirror-worktree isolation, ambient unbind, provenance-safe uninstall, symlink-containment, frozen start-state, and direct-install requirements; only needs minor follow-up fixes for offline saved-profile repair reuse (`src/install.ts:396-399`), login-before-id error precedence (`src/githubAuth.ts:199-206`), and a bound-mirror regression check in `test/ballotPublication.test.ts`.
2. **antigravity (`ff396b3133e38227179375cd5a19ff4a36353e39`)** — Clean and well-tested (including `test/ballotPublication.test.ts` and symlink-checked mirror repair), but lacks per-worktree mirror isolation, ambient/mirror uninstall cleanup, owner-value restoration, and direct programmatic `install` lookup.
3. **claude (`7e2b1c39be95ada9c63aa87de41f4eb29397506f`)** — Cleanly implements direct `install` with saved-profile reuse and solid tests, but lacks symlink containment on mirror repair, `uninstall` cleanup of `user.*`, frozen `start.json` profile, and per-worktree / ambient mirror isolation.
