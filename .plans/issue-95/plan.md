# Issue 95: Move the package-version ship gate to PR/merge only

## Approach

Separate the two concerns that the fast suite currently conflates. The normal
developer and coordinator suites will validate the code without comparing the
working branch's package version with the base branch. The existing dedicated
version command and the pull-request workflow will remain the only gate that
requires an advance before a PR can merge to main.

At the same time, remove the temporary test runner that rewrites tracked test
sources. Version-output assertions will derive their expected value directly
from the repository manifest, so a late merge-preparation bump will not require
companion test edits or make the tests self-modify.

## Exact File List to be changed or deleted

- `.github/workflows/version-bump.yml` — replace the obsolete comment claiming
  local fast-suite/precommit enforcement with an explicit statement that this
  pull-request workflow is the merge-time gate. Preserve the pull-request-to-main
  trigger, full-history checkout/fetch, base-ref environment variable, and
  `pnpm run check:version-bump` step unchanged.
- `AGENTS.md` — remove the instruction that every non-main fast-suite run needs a
  package version greater than the base. State instead that precommit
  `pnpm check:fast` and coordinator `pnpm check` do not enforce the ship version,
  while a PR must advance it before merge. Preserve the clone-local skip-worktree
  overlay and its index bit while updating the tracked documentation.
- `docs/coord-driver.md` — document the late ship procedure: ordinary issue,
  review, revision, and coordinator-check commits keep the base version; the PR
  branch chooses the next available dotted version only after refreshing the
  main base and immediately before merge; the dedicated workflow performs the
  comparison.
- `docs/repo-map.md` — remove the obsolete non-main fast-suite warning and the
  temporary-wrapper warning section. Replace them with the split between normal
  precommit/coordinator checks and the PR-only version gate.
- `package.json` — restore `test:fast` to the direct Vitest command
  `vitest run --config vitest.config.ts`, deleting the Node one-liner that edits
  and restores tracked tests. Leave `check`, `check:fast`, and
  `check:version-bump` composition unchanged, and do not advance the manifest
  version in the mid-protocol implementation commit.
- `src/cli.ts` — change the operator-facing help text from the ambiguous “bump on
  every ship” wording to “bump before merge to main.”
- `src/install.ts` — align the package-version API comment with the same
  merge-time policy; do not change package-version lookup behavior.
- `src/versionBump.ts` — clarify the dedicated check's documentation and failure
  detail as a before-merge-to-main requirement. Preserve all comparison and
  base-branch bypass behavior.
- `test/support/workspaceFixture.ts` — export a test-only expected repository
  version read directly and validated from the root manifest. This remains
  independent of the production package-version helper under test.
- `test/cli.test.ts` — replace the hardcoded version literal with the shared
  manifest-derived expected value for all three version command forms.
- `test/install.test.ts` — replace the hardcoded emitted coordination-version
  literal with the same shared expected value.
- `test/versionBump.test.ts` — delete the live test that compares the current
  checkout with origin/main during every Vitest run. Retain parser and ordering
  unit coverage, and replace the live assertion with a hermetic temporary-Git
  fixture proving that the dedicated check rejects an equal branch version and
  accepts a strictly greater branch version without depending on this checkout's
  branch or remote state.

No listed file is deleted.

## Exact file list to be created

None. The implementation changes existing tracked files only.

## Implementation Sequence

1. Make the version expectations in the CLI and installer tests consume the
   manifest-derived test value, then simplify the fast-test script. This first
   removes the companion-file and self-modifying-worktree traps.
2. Decouple the fast suite by replacing the current-checkout ship assertion
   with the hermetic dedicated-check tests. Do not add the dedicated version
   command to either normal check script.
3. Update the dedicated check's user-facing wording and the CLI/install wording
   without changing its decision logic.
4. Update the workflow comment and every tracked operator/agent document so the
   written policy matches the executable boundary.
5. Before eventual merge, refresh the PR against current main, choose a version
   strictly greater than that base, make the normal late manifest bump on the PR
   branch, and run both the normal suite and the dedicated ship gate. This late
   bump is merge preparation, not part of implement/review/revise gating.

## Tests

- `pnpm exec vitest run --config vitest.config.ts test/versionBump.test.ts test/cli.test.ts test/install.test.ts`
  — the focused suite passes without rewriting tracked sources; helper compare
  coverage remains; the hermetic equal/greater cases exercise the dedicated
  gate; CLI and emitted-config expectations follow the manifest.
- `pnpm check:fast` — passes on the issue branch while its manifest version is
  exactly the same as origin/main, proving precommit no longer contains the live
  ship gate.
- `pnpm check` — passes at that same version, proving the coordinator's full
  build, fast, and e2e gate remains free of the version comparison.
- `pnpm check:version-bump` — before the late bump, intentionally exits nonzero
  with the equal-version diagnostic. This is an expected negative acceptance
  check, not a failure of the normal suites.
- After the merge-preparation manifest bump, `pnpm check:version-bump` exits zero
  and `pnpm check` still passes without editing either version assertion test.
- Inspect the workflow diff to confirm it still runs only for pull requests into
  main and still invokes the dedicated command with the fetched PR base.
- `git diff --check` and `git status --short` — no whitespace errors and no
  tracked test files changed as a side effect of running the suites.

## Alternatives Rejected

- Keep the live comparison but automatically bump during implementation. This
  preserves the approved-path deadlock and forces agents to race for versions
  before the PR is ready to ship.
- Add the dedicated version command to `check` instead of the Vitest suite. That
  merely moves the same mid-protocol gate into the coordinator's hermetic check.
- Skip or condition the live test through an environment variable. Local hooks,
  coordinator runs, and ad-hoc invocations could then disagree, and the default
  suite would still depend on ambient Git state.
- Keep hardcoded expected versions and update the two tests with every late bump.
  This leaves the companion-file trap in place and requires unrelated test
  churn for a manifest-only release action.
- Keep the self-rewriting test runner. It makes assertions vacuous during the
  run, can leave a dirty checkout after interruption, and means final checks do
  not test the committed tree.
- Remove the dedicated command or PR workflow. Pre-1.0 merge visibility remains
  required; only the timing of enforcement is changing.
- Automatically bump in coordinator finalization. The issue explicitly leaves
  the late version selection as a normal PR-branch commit before merge.

## Risks and Mitigations

- **The only ship gate could be removed accidentally.** Preserve the workflow
  trigger and command step verbatim, retain the dedicated script, and cover the
  equal/greater decision in an isolated Git fixture plus the expected-negative
  command run.
- **A manifest-derived expected value could become tautological.** Read and
  validate the root manifest in test support rather than calling the production
  package-version helper, so the CLI/install behavior is still compared with an
  independent source.
- **Concurrent PRs can select the same next version.** Delay selection until
  merge preparation, refresh main first, and require the dedicated gate to run
  again after any base update.
- **The protected agent instructions could lose their clone-local overlay.** Do
  not clear skip-worktree or replace the working copy to stage the documentation
  edit; verify the bit remains set and inspect the committed AGENTS blob
  separately from the clone-local overlay.
- **Documentation can drift across entry points.** Update the agent protocol,
  driver guide, repository map, CLI help, source diagnostics, and workflow
  comment in the same implementation and search for stale claims about fast-suite
  or per-issue version enforcement.
- **The expected-negative ship-gate command can be mistaken for a broken test.**
  Run it separately from the all-green normal suites and record that exit 1 is
  required until the deliberate late bump.

## Conclusion

This plan removes ambient repository/version state from all mid-protocol checks,
keeps the existing PR workflow as the sole merge gate, and cleans up the
self-modifying workaround that version bumps forced into the fast suite. Agents
can implement and revise against the base version, while the owner still gets a
strict, documented version advance immediately before merge.
