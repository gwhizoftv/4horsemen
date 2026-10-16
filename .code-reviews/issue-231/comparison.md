# Issue 231 implementation comparison

Compared bound product pins (implementation-ready commits):

- codex `3832b1ae2683c8bfe3860bd5eeb24f65d0408ca6`
- cursor `1917e58ce6ed0472bcdb9ca1abe3d7f1f83cbc95`
- claude `180a769ecf633a0b176f531c0bac9e54f08f4105`

All three implement the selected Codex plan’s core: CLI discovery of GitHub
`default_branch` via `gh api repos/<owner>/<repo>`, account binding with
`withGitHubAccount`, fail-hard on github.com lookup errors (claude’s published
plan soft-fail was corrected in the pin), explicit `--base-branch`, pass-through
to existing `baseBranch` → runtime `config.json` and
`consensus.sharedBranch`, and acceptance of
`refs/remotes/origin/<branch>` when the owner has no local branch of that name.
No pin invents a new product module or schema key.

## Comparison

1. **cursor `src/install.ts:372–377` vs codex `:372–374` / claude `:372–375`.**
   Cursor accepts any `git check-ref-format --branch` exit 0 and then uses the
   *caller’s* string as the shared branch. Rule: the shared branch must be the
   literal name that will be written to config and Git refs—not a Git shorthand
   that `check-ref-format --branch` resolves and reprints. Failure: `git
   check-ref-format --branch '@{-1}'` exits 0 and prints the previous branch
   (e.g. `main`); cursor still stores and seeks `refs/heads/@{-1}` /
   `origin/@{-1}`, so setup fails after discovery with a confusing missing-ref
   error, or (worse) if such a ref were ever created, config would disagree with
   Git’s notion of the name. Codex and claude require
   `validated.stdout.trim() === baseBranch`. Illustrative test: call
   `install({ baseBranch: "@{-1}" })` on a fixture whose previous branch is
   `main` and expect the invalid-name error before any clone/config write
   (already the shape of codex/claude install preflight cases).

2. **codex `src/githubIssue.ts:116–129` — timeout only at the CLI wrapper.**
   Codex applies `{ timeoutMs: 30_000 }` in `src/cli.ts:966` when wrapping
   `withGitHubAccount`, and `test/cli.test.ts` asserts that timeout on the
   metadata call. The exported helper itself still uses a two-argument
   `CommandRunner` and does not pass options. Rule: a network call on the setup
   path must stay bounded wherever the helper is invoked. Failure: a future
   library caller of `fetchGitHubDefaultBranch` with an unbounded runner can
   hang forever on a stalled `gh`, unlike cursor (`src/githubIssue.ts:152–154`)
   and claude (`:210–212`), which bake `DEFAULT_BRANCH_LOOKUP_TIMEOUT_MS` into
   the helper. Smallest correction: pass `timeoutMs` inside the helper (cursor/
   claude) while keeping the CLI account binding.

3. **cursor `src/cli.ts:973–976` — missing origin → `"main"`.** Rule: when the
   product has no `origin` remote, setup must surface that as the installer’s
   existing origin requirement, not invent a shared branch. Failure: logs
   “Shared branch: main (no origin remote…)” then still fails inside `install`
   on the missing origin, which muddies diagnostics for owners debugging
   onboarding. Codex throws immediately (`src/cli.ts:961`); claude returns
   `undefined` so install’s own origin error remains primary (`src/cli.ts:968–970`).
   Prefer either peer behavior; optional test: onboard/install with origin
   removed and assert the message names the missing remote without claiming a
   chosen shared branch.

**Scope / reuse.** Each pin stays on the approved map (`src/githubIssue.ts`,
`src/cli.ts`, `src/install.ts`, the four test files, `docs/setup-workspace.md`),
reuses `githubRepositoryFromOrigin`, `withGitHubAccount`,
`buildWorkspaceConfig`, `configureCloneIdentity`, and existing fixtures, and
adds focused regressions for `release/alpha`, override-skips-API, lookup
failure-before-writes, and remote-tracking-only preflight. Docs coverage is
comparable; test depth is strongest in codex’s CLI ambient-token /
timeout cases and claude’s helper timeout assertion.

## Verdict

Prefer **codex `3832b1ae2683c8bfe3860bd5eeb24f65d0408ca6`**: correct fail-hard
discovery, literal branch-name validation, origin-tracking preflight, and the
strongest CLI account/timeout evidence. Adopt cursor/claude’s in-helper
`timeoutMs` if the helper is treated as a public API.

**claude `180a769e…`** is a close second (same validation and helper timeout;
clear `@{-1}` comment).

**cursor `1917e58c…`** solves the issue functionally (fail-hard, CLI discovery,
origin tracking) but should take the literal `check-ref-format` stdout check
before it is treated as the merge candidate.
