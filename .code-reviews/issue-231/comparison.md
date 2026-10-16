## Comparison

Reviewed the complete exported worktrees at these exact product pins:

| Agent | Implementation pin | Assessment |
| --- | --- | --- |
| Codex | `3832b1ae2683c8bfe3860bd5eeb24f65d0408ca6` | Recommended; no blocking findings. |
| Cursor | `1917e58ce6ed0472bcdb9ca1abe3d7f1f83cbc95` | Acceptable; no blocking findings. |
| Claude | `180a769ecf633a0b176f531c0bac9e54f08f4105` | Acceptable; no blocking findings. |

All three implement the selected plan's behavior: an explicit `--base-branch`
on either command takes precedence; otherwise GitHub's repository metadata
determines the branch through the selected account, with a 30-second lookup
timeout. Non-GitHub origins retain `main`. API failure stops setup without a
guessed or stale branch. Install's `--origin` override determines the repository
queried. Dry-run performs discovery without publishing configuration or clones.

Each installer accepts a local branch or an `origin/<branch>` commit and passes
the result through the existing configuration, clone identity, clone setup, and
launcher paths. Each integration test starts with a non-main default available
only as a tracking ref, verifies runtime `baseBranch`, clone
`consensus.sharedBranch`, clone checkout and launcher output, and checks that
the owner's feature branch remains selected. Re-onboarding refreshes setup
configuration while preserving the existing agent branch. Existing issue
snapshots are outside the changed paths.

### Scope and reuse

All three stay within the same eight approved product paths: `src/githubIssue.ts`,
`src/cli.ts`, `src/install.ts`, the four existing corresponding test files, and
`docs/setup-workspace.md`. The additional paths listed by the coordinator are
coordination evidence. None introduces a product file or dependency, changes
hooks, bumps a version, or refactors the downstream installer machinery.
All reuse `githubRepositoryFromOrigin`, `withGitHubAccount`, existing fixture
builders, `buildWorkspaceConfig`, `configureCloneIdentity`, `ensureAgentClone`,
and `writeAgentLauncher`.

Codex leaves the shared `CommandRunner` contract unchanged and applies the
timeout in the CLI adapter. Claude instead gives the new metadata helper a
local runner signature with timeout support; this is also well contained.
Cursor extends the shared runner contract with an optional options argument and
exports `CommandRunnerOptions`, although this issue only needs that option on
the new lookup. That extension is compatible and not a blocking defect, but
Codex and Claude achieve the same behavior with a narrower interface change.

### Focused coverage

All extend existing tests for supported GitHub origin forms, non-GitHub origins,
malformed or unusable metadata, command errors, explicit overrides, initial
lookup failure, account handling, dry-run, branch preflight, and re-onboarding.
These tests exercise the issue rather than unrelated functionality.

Codex explicitly tests both initial and subsequent metadata failures leaving
configuration unchanged, a saved account overriding an ambient token during
discovery, timeout propagation at the CLI boundary, and preservation of dirty
tracked agent work during a default-branch refresh. Its override tests use a
non-main branch for both commands. Claude also tests a non-main override for
both commands, failed refresh preserving configuration, selected-account token
precedence, and preservation of a committed agent tip. Cursor covers a missing
new default ref before successful refresh and preservation of an untracked work
file; its explicit-override tests use `main`. Cursor and Claude assert the
timeout directly at their metadata helper boundary. These are coverage
differences, not demonstrated product failures.

### Verification evidence

Read the existing `verification-run` records in
`/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-231/journal.jsonl`.
The recorded successful `pnpm run check:fast` precommit observations match the
exact trees of the bound product pins:

| Agent | Bound pin's tree, matching recorded index identity |
| --- | --- |
| Codex | `41359ec0f83ba8bd6de7637b7e5e826b19369015` |
| Cursor | `0314a8cccb7b2ae4c8b62dbbc8cf315478bf50d9` |
| Claude | `3b16ce826b4c751ac7b510c4e4d2ff5a809098b6` |

The journal also records successful `pnpm run test:e2e` prepush runs for their
implementation publication ranges ending at `fe23f68d9420ba6bcd9120d1ab7ac1bbeac9603b`
(Codex), `9f948164330a4b457bd5b11e0f73d25e5404c2ab` (Cursor), and
`810f19bcfb18b9a26445a13db0a50bd9fc5e4965` (Claude). These are existing hook
observations, not coordinator final-verification receipts or suites rerun for
this comparison. Codex's tree first recorded a failed precommit attempt caused
by the pathspec commit's inherited temporary index; a normal staged commit
subsequently passed for the same tree without bypassing or altering hooks.

No additional product suite was run for this review: inspection did not identify
a concrete failure needing an experimental test. The comparison artifact was
checked for its required heading and all three exact implementation citations.

### Recommendation

Select Codex `3832b1ae2683c8bfe3860bd5eeb24f65d0408ca6`. Its unchanged shared
runner interface and explicit coverage of failed refreshes, saved-account
discovery, and dirty tracked work provide the strongest combination of narrow
scope and regression evidence. Claude and Cursor remain viable alternatives;
there is no blocking code finding against either bound pin.
