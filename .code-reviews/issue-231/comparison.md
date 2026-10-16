# Issue 231 implementation comparison (claude)

Bound implementation pins:

- codex `3832b1ae2683c8bfe3860bd5eeb24f65d0408ca6`
- cursor `1917e58ce6ed0472bcdb9ca1abe3d7f1f83cbc95`
- claude `180a769ecf633a0b176f531c0bac9e54f08f4105`

I read each pin from its exported worktree and diffed it file by file against
an extracted copy of baseline `884df5fe1200f1cfbd3cecae887488d8c376fdf9`. I ran
no product suite for this comparison. The only extra commands were two `git`
probes in a scratch repository: `check-ref-format --branch '@{-1}'` and the
matching `rev-parse`, both cited below. My own pin's tests passed in its
pre-commit hook (`pnpm check:fast`). That is not a coordinator check, and I
cite no coordinator results for the other pins.

## Comparison

### Shared design

All three pins implement the selected codex plan in the same shape and touch the
same eight product paths, all inside the approved map:

- `src/githubIssue.ts`, `src/cli.ts`, `src/install.ts`;
- the four test files;
- `docs/setup-workspace.md`.

Common to every pin:

- **Lookup helper.** `fetchGitHubDefaultBranch` in `src/githubIssue.ts` reuses
  `githubRepositoryFromOrigin` and runs `gh api repos/<owner>/<repo>`. It
  returns `null` for a non-GitHub origin without a process call, and throws
  with `--base-branch` remediation on a thrown, non-zero, non-JSON, missing,
  null, blank, padded or multiline answer.
- **Resolution.** The CLI resolves the branch in both `onboard` and `install`
  after the existing account verification. The order is explicit
  `--base-branch`, then GitHub's default, then `main` for non-GitHub origins.
- **Account and timeout.** Discovery is bound with `withGitHubAccount` to the
  explicit or saved account and runs with a 30-second `timeoutMs`.
- **Fail before effects.** A failed lookup stops before any clone or
  configuration is written. `onboard` gains `--base-branch`.
- **Installer.** `install()` stays synchronous. It validates the name with
  `git check-ref-format --branch` and accepts `refs/heads/<b>` or
  `refs/remotes/origin/<b>`. `OnboardOptions.baseBranch` is forwarded.
- **Downstream writers unchanged.** `buildWorkspaceConfig`,
  `configureCloneIdentity` (`consensus.sharedBranch`), `ensureAgentClone` and
  `writeAgentLauncher` are untouched. All three pins rely on the existing
  single `baseBranch` input.
- **Test isolation.** Every existing GitHub-origin `runCli` onboard/install
  fixture in `test/onboard.test.ts` and `test/cli.test.ts` is given an injected
  lookup, so no pin's suite reaches real GitHub.

No pin adds a file, dependency, schema field or unrelated refactor. Source
change sizes in `src/` (changed lines from the diff): codex 79, claude 114,
cursor 156. Cursor's extra size comes from separate error constructors per
failure and from widening the exported `CommandRunner` type. Codex is the
tightest.

### Findings

**F1 — cursor `src/install.ts:372`: `check-ref-format` exit status only, without comparing its output to the input.**
- Rule: the shared branch must be a literal branch name. Git's
  `check-ref-format --branch` expands revision shorthands such as `@{-1}`, so
  exit 0 alone does not prove the name is literal.
- Failure: in a repository with a previous checkout, `git check-ref-format
  --branch '@{-1}'` exits 0 and prints the expanded name (verified in a
  scratch repository). Cursor's validation accepts `--base-branch '@{-1}'`.
  The only thing that stops it is the next check:
  `rev-parse --verify refs/heads/@{-1}^{commit}` and the origin form both fail
  (also verified). The owner therefore gets "no local branch '@{-1}' and no
  origin/@{-1} tip … fetch it". That remedy is wrong: the name is invalid, and
  fetching cannot fix it. No wrong configuration is written, so this is
  non-blocking.
- Codex (`src/install.ts:372–375`) and claude (`src/install.ts:372–376`) both
  compare `stdout.trim()` to the input. Codex's `test/install.test.ts` covers
  `@{-1}` explicitly.
- Illustrative test: `expect(() => installOnce(fixture, { baseBranch: "@{-1}" })).toThrow(/Invalid shared branch/)`
  after `git checkout -qb feature/work`, as codex's table already does.

**F2 — codex `src/cli.ts:961`: `resolveInstallBaseBranch` throws its own missing-origin error before `install()` runs.**
- Rule: an owner-facing setup error must keep the remedy the existing check
  provides. Baseline `src/install.ts:360` says "Agents publish evidence to a
  shared remote; add one or pass --origin."
- Failure: `coord onboard <repo>`, or `coord install` without `--origin`, on a
  product with no `origin` remote now fails with only "The product … has no
  'origin' remote." The installer's actionable sentence is never reached.
  Claude returns `undefined` in this case, and cursor returns `main` with a
  notice; both let `install()` report its original message.
  Non-blocking: the message is still correct, it just lost the remedy.
- Fix sketch: return `"main"` (or `undefined`) when there is no remote and let
  `install()` raise its existing error.

**F3 — claude `test/cli.test.ts:1978`: the lookup-failure, no-effects regression covers `install` only.**
- Rule: fail-before-effects is a behaviour of both commands, because each
  calls the resolver independently.
- Failure: if a future change in the `onboard` handler moved `resolveBaseBranch`
  after `onboard(...)`, or caught its error, claude's suite would still pass.
  A failed lookup could then write `main` into a fresh workspace, which is the
  failure the selected plan exists to prevent. Codex's
  `test/cli.test.ts:1956` parameterizes the same case over `onboard` and
  `install`. It also asserts that the clone's `.git/config` and launcher bytes
  are unchanged after a failed refresh. Cursor's `test/cli.test.ts:1994`
  covers `install` only, like claude's.
- Illustrative test: change the claude case to
  `it.each(["onboard", "install"])` with codex's onboard argv.

**F4 — test focus.** Every pin's new tests fail at baseline and pass with the
change, and all reuse existing files and fixtures (`installedWorkspace`,
`installArgs`, `product`, `installOnce`, the module `runner`). Differences in
coverage:

| | Codex | Claude | Cursor |
| --- | --- | --- | --- |
| Account token and 30 s timeout | End to end through the CLI, with an ambient-token conflict, on a dry run | Token through the CLI with an ambient conflict; timeout in the unit test | Token through the CLI; timeout in the unit test |
| Dry-run discovery | With saved account; asserts no writes | Asserts no writes | Asserts the message only |
| Re-onboard keeps agent's working branch | Yes | Yes | Yes, plus an extra preflight-failure step mid-test that partly repeats `test/install.test.ts` |

None adds tests outside the issue.

### Within issue, reuse, and documentation

All three are in scope. Each documents the precedence, the fail-hard lookup,
the non-GitHub `main` fallback, dry-run behaviour and the tracking-ref
requirement in `docs/setup-workspace.md`, with no contradiction between them.
Cursor also edits the existing "Overrides kept on the simple command" sentence
to list `--base-branch`, which is accurate. Codex and claude also add
`--base-branch` to the `install` help line; claude adds `--origin` there too,
which the baseline already accepted but did not list.

## Verdict

All three pins are correct implementations of the selected plan, and none has
a blocking defect.

- **Codex `3832b1ae2683c8bfe3860bd5eeb24f65d0408ca6` — preferred.** It has the
  smallest source change, literal-name validation with a test for `@{-1}`, and
  the most complete regressions: both commands' failure paths, byte-stable
  refresh, and the account token plus timeout end to end. F2 is a small
  message regression worth fixing in revision.
- **Claude `180a769ecf633a0b176f531c0bac9e54f08f4105` — equivalent behaviour.**
  Its failure regression covers `install` only (F3).
- **Cursor `1917e58ce6ed0472bcdb9ca1abe3d7f1f83cbc95` — larger, with a
  misleading `@{-1}` remedy (F1).**
