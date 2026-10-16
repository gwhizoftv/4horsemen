# Issue 231 plan review

Reviewed bound plans:

- cursor `3f3c127cc93244ef39a390b73c06ba7e69147739`
- codex `26a6740a64f13199c35922922a8062af82f77976`
- claude `70d11af63f38cb21dfd791fc3a0ca92f55eda87a`

Issue #231: on onboard/install, read GitHub’s `default_branch` and persist it as
runtime `config.json` `baseBranch` and agent-clone `.git/config`
`consensus.sharedBranch` (today both are fed by `options.baseBranch ?? "main"`
in `src/install.ts`).

## Findings

1. **claude Problem / Precedence / Alternatives — warn and continue on GitHub
   lookup failure; fall back through saved `baseBranch` then `"main"`.** Claim:
   failed `gh api` must not block onboarding; offline re-onboard and ambient
   workspaces need a soft path. Rule: for a supported github.com origin, a
   failed or empty default-branch lookup must not silently select `main` (or
   retain a stale wrong `main` from a prior onboard) while reporting success—
   that is the bug the issue describes. Failure if followed as written: first
   onboard of a `release/alpha` default while `gh` is briefly unavailable (or
   ambient auth cannot see the private repo) prints a warning, writes
   `baseBranch: "main"` / `consensus.sharedBranch=main`, and later
   `coord start` cannot resolve `origin/main`; a re-onboard that fails lookup
   again keeps that wrong saved value forever under step 3. Smallest
   correction: match cursor/codex—GitHub-origin lookup failure throws with
   `--base-branch` / `gh auth` remediation; `"main"` only when the origin is
   not a supported github.com remote; explicit `--base-branch` still skips
   discovery.

2. **cursor Exact File List / install preflight and claude install() — keep
   the local-only `refs/heads/<baseBranch>` check.** Claim: leave the existing
   product local-branch preflight unchanged. Rule: agent clones are already
   seeded from `refs/remotes/origin/<baseBranch>` when present
   (`ensureAgentClone` in `src/setupWorkspace.ts`); onboarding must accept a
   shared branch that exists as a remote-tracking tip even when the owner’s
   worktree has no local branch of that name (common when HEAD is on a feature
   branch). Failure if followed as written: GitHub correctly returns
   `release/alpha`, but install throws `The product … has no 'release/alpha'
   branch` before writing `config.json` or clone identity, so the issue’s two
   stores are never updated. Smallest correction: adopt codex’s preflight—
   accept `refs/heads/<branch>` **or** `refs/remotes/origin/<branch>`; if
   neither exists, fail with an actionable fetch remedy; do not checkout or
   reset the owner tree.

3. **cursor Exact File List — `fetchGitHubDefaultBranch` (async runner) plus
   resolution inside synchronous `install()` via an unspecified sync adapter /
   injectable seam.** Claim: one resolution site in `install` keeps all
   entry points aligned. Rule: account-bound GitHub calls must use the same
   injected, timeout-bounded, `withGitHubAccount` path the CLI already uses for
   verification; a second sync `spawnSync("gh"…)` / ad-hoc token path must not
   diverge from that contract or leave fixtures calling live `gh`. Failure if
   followed as written: implementers either (a) add a parallel sync credential
   path that can miss `GH_PROMPT_DISABLED` / ambient-token stripping, or (b)
   throw from every existing `install({ origin: https://github.com/acme/… })`
   fixture that does not yet stub discovery—large incidental churn. Smallest
   correction: resolve in the async CLI handlers (codex/claude placement) with
   `withGitHubAccount` + injected `processRunner`, pass a single `baseBranch`
   into sync `onboard`/`install`; keep an injectable seam only if library
   callers must discover without the CLI.

4. **claude `fetchGitHubDefaultBranch` signature — `Promise<string>` that
   throws when `githubRepositoryFromOrigin` is null.** Claim: non-GitHub
   origins reject inside the helper. Rule: unsupported origins must skip the
   API and fall through to the compatibility `"main"` default without treating
   that as a lookup failure. Failure if a caller invokes the helper without the
   CLI’s null-guard: a `file://` or bare path origin throws instead of
   installing with `main`, breaking embedded install paths that never used
   GitHub. Smallest correction: return `null` (or only call the helper after a
   non-null repository), matching cursor/codex; reserve throws for github.com
   origins with failed/malformed API answers.

5. **cursor Tests — omit `test/cli.test.ts` account-binding and
   failure-before-install coverage.** Claim: `test/onboard.test.ts` plus the
   helper unit tests are enough. Rule: install’s `--origin`, selected-account
   token env, dry-run discovery, and “lookup failure leaves no partial
   clones/config” are CLI routing responsibilities and already live in
   `test/cli.test.ts` fixtures. Failure if followed as written: a regression
   that discovers with the wrong account (ambient token wins) or writes clones
   before a failed lookup can pass onboard-only tests. Smallest correction:
   add the focused cli cases codex lists (override skips API; account-bound
   env; failure leaves outputs unchanged; dry-run discovers without writes).

6. **codex Exact File List — `docs/setup-workspace.md`.** Claim: document
   discovery, keys, `--base-branch`, and recovery next to onboarding. Rule:
   stay within the issue; prefer the smallest change that fully solves it.
   Failure if treated as mandatory product scope: docs-only lag can block or
   bloat the pin without changing behavior. Smallest correction: keep the docs
   edit optional/follow-up; help-text flag lines (codex/claude) are enough for
   the user-visible contract. The rest of codex’s map (CLI discovery, fail-hard,
   origin-tracking preflight, test updates) remains in scope.

## Conclusion

Prefer **codex `26a6740a64f13199c35922922a8062af82f77976`**: discovery in the
async CLI with `withGitHubAccount`, fail-hard on github.com lookup errors,
explicit `--base-branch` override, pass-through to existing
`baseBranch`→`config.json` / `consensus.sharedBranch` writers, and the
origin-tracking preflight needed for non-`main` defaults when the owner has no
local branch of that name. Drop or defer the docs file if consensus wants a
tighter map; keep the cli/onboard/install/githubIssue tests.

**cursor `3f3c127c…`** correctly refuses silent `main` on GitHub failure and
reuses the right writers, but leaves the local-only preflight that can block
the motivating case and underspecifies sync discovery inside `install()`.

**claude `70d11af6…`** places discovery in the right CLI layer and reuses
consumers well, but its warn-and-fallback / saved-`main` precedence reintroduces
the issue’s failure mode whenever lookup fails.
