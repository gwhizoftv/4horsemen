# Issue 231 — Discover GitHub default branch on onboard/install

When `coord onboard` / `coord install` omit an explicit shared branch, they
hardcode `main` (`src/install.ts`). Repositories whose GitHub default branch is
something else (for example `release/alpha`) get the wrong `baseBranch` in
runtime `config.json` and the wrong `consensus.sharedBranch` in agent-clone
`.git/config`, so later `coord start` cannot resolve `origin/<baseBranch>`.

Discover the branch with the same GitHub API the issue cites
(`gh api repos/<owner>/<repo>` → `.default_branch`), then feed the existing
install path that already writes both stores.

## Exact File List to be changed or deleted

- `src/githubIssue.ts` — add `fetchGitHubDefaultBranch({ origin, cwd, runner })`
  that derives `owner/repo` via existing `githubRepositoryFromOrigin`, runs
  `gh api repos/<owner>/<repo> --jq .default_branch`, trims a non-empty single
  token, and returns `null` for a non-github origin (caller falls back). On a
  github origin, a failed/empty/malformed response throws with remediation to
  pass `--base-branch` or repair `gh` auth — do not silently substitute `main`.
- `src/install.ts` — replace `options.baseBranch ?? "main"` with resolution
  order: explicit `options.baseBranch` → `fetchGitHubDefaultBranch` (via a
  small sync `gh` adapter used only here, or an injectable `resolveDefaultBranch`
  seam defaulting to that adapter) → `"main"` only when the origin is not a
  supported github.com remote. Pass the resolved value into
  `buildWorkspaceConfig` and the existing clone identity / launcher / clone
  paths unchanged. Extend `OnboardOptions` with optional `baseBranch` and
  forward it to `install`. When `githubAccount` is set, run the `gh` call under
  the same account-bound env already used elsewhere (`withoutAmbientTokens` +
  `GH_TOKEN` from `gh auth token --user <account>`), matching
  `withGitHubAccount` / wipe-issue’s `ghEnv` pattern.
- `src/cli.ts` — allow `--base-branch` on `onboard` (install already has it) and
  pass it through to `onboard` / `install`. No separate CLI discovery path:
  install owns resolution so every entry point behaves the same.
- `test/githubIssue.test.ts` — cases for success (`release/alpha`), non-github
  origin → `null`, and failed github lookup → thrown remediation.
- `test/onboard.test.ts` (or `test/install.test.ts` if that fixture is closer) —
  extend an existing onboard/install fixture: inject/mocked `gh api` returning a
  non-`main` default branch; assert runtime `config.json` `baseBranch` and each
  agent clone’s `consensus.sharedBranch` match; assert explicit `--base-branch` /
  `baseBranch` wins over the API; assert a non-github origin still lands on
  `main` without calling `gh`.

## Exact file list to be created

- `.plans/issue-231/plan.md` (this plan).

No other new product source files: discovery belongs next to the existing
origin→repository helper and the install path that already persists `baseBranch`
and `consensus.sharedBranch`.

## Reuse and Scope

- Reuse `githubRepositoryFromOrigin` (`src/githubIssue.ts`) for `owner/repo`.
- Reuse `buildWorkspaceConfig` / `configureCloneIdentity` /
  `writeAgentLauncher` / `ensureAgentClone` — they already consume `baseBranch`
  and write runtime `config.json` plus clone-local `consensus.sharedBranch`.
- Reuse `withoutAmbientTokens`, account token lookup, and the account-bound `gh`
  env pattern from `src/githubAuth.ts` / `wipeIssue.ts` so discovery honors the
  workspace account the same way repository access checks do.
- Reuse existing onboard/install fixtures in `test/onboard.test.ts` /
  `test/install.test.ts` and the injectable `runner` style from
  `test/githubIssue.test.ts`.
- Out of scope: rewriting historical workspace configs (re-onboard/re-install
  refreshes); changing PR target logic beyond using the corrected `baseBranch`;
  adopting the currently checked-out local branch (rejected by prior #4 review);
  setting a product-worktree `consensus.sharedBranch` (hooks read agent clones);
  docs-only edits unless a one-line flag mention is required by an existing
  onboard flag list in-tree.

## Tests

- `test/githubIssue.test.ts` — `fetchGitHubDefaultBranch`: mocked runner returns
  `release/alpha` for `repos/acme/app`; non-github origin returns `null` with no
  `gh` call; non-zero `gh` / empty stdout throws mentioning `--base-branch` /
  `gh auth`.
- `test/onboard.test.ts` (preferred join) — fixture with injectable `gh`:
  default branch `release/alpha` → written `config.baseBranch` and
  `localConfigGet(clone, "consensus.sharedBranch")` are `release/alpha`;
  `baseBranch: "develop"` (or CLI `--base-branch`) ignores the API value;
  `file://` / non-github origin keeps `main` and does not invoke `gh api`.
- Commands while developing: `pnpm vitest run test/githubIssue.test.ts test/onboard.test.ts`
  (add `test/install.test.ts` only if the onboard fixture cannot host the
  install-path assertion). Pre-commit owns `pnpm check:fast`.

## Alternatives Rejected

- **Keep hardcoding `main` and require `--base-branch`:** fails the issue’s
  Soundsplore-style onboard; owners should not need to know the remote default.
- **Adopt `git branch --show-current` from the product worktree:** already
  rejected in issue-4 review — transient checkout is not repository policy.
- **`git ls-remote --symref origin HEAD` only:** useful offline fallback, but the
  issue explicitly requires the GitHub default-branch API; symref can also
  disagree with GitHub’s configured default in edge cases.
- **Discover only in the CLI, leave `install()` on `main`:** programmatic
  `onboard`/`install` would still misconfigure; one resolution site in install
  keeps CLI and library callers aligned.
- **New config key or product `.git/config` shared-branch key:** unnecessary;
  `baseBranch` + existing `consensus.sharedBranch` already are the two stores
  the issue names (runtime config and clone `.git/config`).
- **New module for default-branch fetch:** `githubIssue.ts` already owns
  origin→repo and `gh` repository reads.

## Risks and Mitigations

- *GitHub API / auth failure on a real github.com origin:* throw with
  `--base-branch` and `gh auth` remediation instead of recording a wrong
  `main`.
- *Fixtures using fake `https://github.com/acme/...` origins:* either pass
  explicit `baseBranch: "main"` or inject a `gh` stub; do not rely on a live
  API. Prefer the injectable seam so CI stays offline.
- *Default branch exists on GitHub but not as `refs/heads/<branch>` locally:*
  keep the existing local-ref check and its error; owners fetch or pass
  `--base-branch` after aligning the product clone — no silent skip.
- *Account-bound vs ambient credentials:* when `github.account` / onboard
  account is set, bind `gh` to that account so discovery cannot see another
  login’s private default branch.
- *Re-onboard of an existing workspace:* intentional refresh of `baseBranch` /
  `consensus.sharedBranch` from GitHub (or explicit flag); call out in the
  install log which branch was chosen and whether it came from flag vs API.

## Conclusion

Smallest fix: query GitHub’s `default_branch` when onboard/install do not get an
explicit shared branch, then reuse the existing `baseBranch` → runtime
`config.json` and `consensus.sharedBranch` → agent `.git/config` writes. Explicit
`--base-branch` still wins; non-github origins keep today’s `main` fallback.
