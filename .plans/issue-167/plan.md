# Issue 167 — GitHub releases for automatic version advances

Protocol version: 1. Baseline: `26f53972ddf036310c24f41ffd746e699976079b`.

The frozen issue asks whether the existing automatic version increments should
also produce GitHub releases. Yes: publish a source release for each successful
post-merge version bump, not for issue creation, branch pushes, coordinator
completion, or an unmerged PR. Preserve the existing push-to-main policy (which
also includes direct main pushes); do not introduce an issue-number dependency.

## Exact File List to be changed or deleted

1. `.github/workflows/version-bump-on-merge.yml` — extend the existing workflow
   with recoverable bump identification, exact-commit tags, and release creation.
   Keep its main-only trigger, quoted self-commit guard, bot identity, full-history
   checkout, Node/pnpm setup, installation/build, and `contents: write` permission.
2. `test/workflows.test.ts` — extend existing parsed-workflow assertions and add
   focused offline execution tests for the actual release-related shell bodies.
3. `docs/coord-driver.md` — update the existing versioning paragraph under
   “Starting and running” with release policy, tag naming, recovery, and limits.

No files are deleted. In particular, do not change `package.json`, the lockfile,
product hooks, installer, coordinator state machine, or version arithmetic.

## Exact file list to be created

No new product, dependency, script, or test-support files are required. The only
new coordination artifact is this required `.plans/issue-167/plan.md`; it is not
an implementation module. Extend the workflow and its existing test file rather
than adding a parallel publishing system.

## Reuse and Scope

Reuse the workflow's fetch/recompute/non-force-push retry, `src/bumpVersion.ts`
and its `bumpManifestSource`/`bumpPatchVersion` implementation in
`src/versionBump.ts` unchanged. Reuse `test/workflows.test.ts`'s `Workflow` type,
`parse`, `workflowFiles`, and `triggersOf` helpers, extending their local types
only as needed to inspect steps, permissions, and concurrency. Existing
`test/versionBump.test.ts` already covers manifest formatting and arithmetic;
do not duplicate those cases. For isolated Git tests reuse `makeProduct("plain")`,
`git`, and `tryGit` from `test/support/workspaceFixture.ts`; add only a small
file-local fake `gh` executable/response fixture and cleanup, following the
existing fake-command pattern in `test/bootstrap.test.ts`. The fake publisher
must never call the network or read live credentials.

Implementation sequence and invariants:

1. Keep a single serialized workflow covering bump, tag, and release. Add
   `queue: max` alongside `cancel-in-progress: false` so a third arriving push
   does not replace the pending second push. GitHub documents a 100-pending-run
   limit and does not guarantee dispatch order; do not promise an unlimited queue
   or an exact one-issue-only source snapshot. The existing workflow bumps the
   fetched main tip, which can already include subsequent merges.
   [GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
2. Make the bump recoverable across a whole-job rerun. Add an exact
   `Coord-Release-Source: <GITHUB_SHA>` commit trailer to new bump commits while
   preserving their `chore: release <version>` subject. Validate the source SHA;
   on each existing fetch/retry iteration, look for that exact trailer in
   origin/main's first-parent history before creating another bump. An existing
   match must be unambiguous, be reachable on main with the source in its ancestry,
   and have a subject/version consistent with its own manifest. Reuse that bump's
   SHA and version, not the current main manifest. Otherwise retain the existing
   bounded two-attempt recompute-and-push behavior. Emit the selected SHA/version
   as step outputs only after a successful push or verified recovery. This also
   covers a push that succeeded remotely but whose response was lost. Reruns keep
   the original `GITHUB_SHA`, making it a stable operation identity.
   [GitHub rerun documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs).
3. In a subsequent step, use those outputs to ensure the remote lightweight tag
   `v<version>` points to that exact bump commit. If absent, create and push only
   that tag. If present, resolve its commit (including annotated-tag peeling)
   and require equality. Never force, move, or delete a tag; fail on conflict or
   an unresolvable remote rather than treating it as absence. Do not tag the
   triggering merge SHA or a newly fetched main tip.
4. Publish a non-draft, non-prerelease GitHub Release named `v<version>` with
   `gh release create`, `--verify-tag`, `--title`, and `--generate-notes`, scoped
   explicitly to `GITHUB_REPOSITORY`. Supply `GH_TOKEN` from `github.token` only
   to the publishing step; pass dynamic values through quoted environment
   variables, not interpolated executable shell text. Let GitHub determine
   Latest automatically rather than forcing an older recovered release to Latest.
   No binary assets or npm package are published: GitHub's source archives are
   sufficient. The CLI's existing-tag verification and generated-notes options
   avoid tagging a moving default-branch head or maintaining a second changelog.
   [GitHub CLI release-create documentation](https://cli.github.com/manual/gh_release_create).
5. Release existence must be checked by exact tag. A published matching release
   is a no-op only after validating the tag target; a draft, conflicting tag,
   unexpected response, or authentication/network error is not success. Only a
   confirmed missing release authorizes creation. Creation failures remain
   visible; if recovering an ambiguous successful create, re-read and validate
   the actual matching published release before accepting success. A tag-only
   partial failure is repaired by rerunning the original workflow without another
   bump. Keep publishing in this workflow: do not depend on a second push/tag
   workflow triggered by a `GITHUB_TOKEN` write.

There is no release backfill, npm publication, compiled distribution, manual
version reservation, new framework, or live GitHub mutation during implementation
tests. The owner-controlled merge is the point at which this automation activates.

## Tests

Extend `test/workflows.test.ts` with three focused groups. Tests must read and
execute the relevant YAML `run` bodies, not reimplement their logic in a helper.
Use local fixture repositories and a controlled fake `gh`; never run these shell
bodies against this agent checkout or the real remote.

1. **Workflow wiring:** preserve existing main-only/self-commit tests; assert
   non-cancelling queued serialization, `contents: write`, release-after-bump
   ordering, exact output/env wiring, scoped token, generated notes, and verified
   tag policy. New release assertions fail against the baseline's absent step.
2. **Publication and replay:** a fresh source creates exactly one bumped commit,
   matching remote tag, and published release. Simulate failure after bump push,
   after tag push, and after release creation; rerun with the same source SHA,
   including after main advances, and assert recovery of the original version
   and SHA with no extra bump, tag movement, or duplicate release. Table-drive
   the failure boundaries rather than adding redundant suites.
3. **Safety and retry:** a rejected main push recomputes from refreshed main;
   exhausted pushes never publish; a pre-existing tag at another commit, a draft
   release, and GitHub authentication/server errors fail closed. Two distinct
   source events produce distinct versions; recovery of the first does not
   consume another version. Assert no force commands and no release before a
   verified remote bump/tag. These checks expose the baseline's lack of source
   identity and release recovery.

Focused development command:
`pnpm exec vitest run --config vitest.config.ts test/workflows.test.ts test/versionBump.test.ts`.
Also run `pnpm typecheck` if needed while extending the test's parsed types.
For product commits, let the installed precommit hook own `pnpm check:fast`;
do not manually duplicate that suite immediately before committing. The frozen
issue's final check is `pnpm run check`, run by the coordinator at its approved
pin. Report focused/hook results separately from coordinator-owned results.
This plan publication needs only heading/file-map/evidence validation, not a
product suite. Local tests cannot prove repository permissions or hosted queue
behavior; after merge the owner should inspect the first Actions run and confirm
that the release tag's manifest version equals its title/version.

## Alternatives Rejected

- A separate tag-triggered workflow: default-token writes need not trigger it;
  it also splits version identity and failure recovery across workflows.
- Publishing at issue close or coordinator finalization: neither proves the PR
  has merged, and both omit normal contributor merges already covered by main.
- A bare `gh release create` without a verified tag: an absent tag defaults to
  the current default branch, which can differ from the successful bump commit.
- Simply rerunning the current bump after a failed release: consumes another
  version and leaves the failed version permanently without its release.
- New release scripts/dependencies, a changelog generator, or build assets: no
  need to expand distribution policy to deliver source releases and notes.

## Risks and Mitigations

- **Partial remote success:** persist source identity in the already-required
  bump commit; validate immutable tag identity and published release state on
  recovery. Do not suppress API failures with unconditional success.
- **Concurrent merges and bounded queues:** retain non-force push retries, queue
  rather than replace pending work, document queue capacity and possible main-tip
  aggregation. Cancelled/failed runs require owner review and rerun; the workflow
  does not promise recovery from arbitrary history rewrites.
- **Repository policy:** Actions still requires permission to push main and
  create tags/releases. Fail visibly when branch/tag rules or token restrictions
  prohibit it; do not add a PAT, bypass protections, or weaken permissions.
- **First release and release notes:** initial generated notes may cover more
  history than one issue, and nearby merges may share a source snapshot. Document
  this instead of promising an issue-isolated changelog. Do not backfill releases.
- **Workflow-only tests:** parse real YAML, retain quoted-expression regression
  coverage, and exercise the actual shell offline. Hosted behavior remains a
  post-merge observation, not a verification result we can claim locally.

## Conclusion

Extend the existing version-bump workflow, its tests, and its existing versioning
documentation only. Each successful automatic version advance gains an exact
`v0.0.N` tag and source release with generated notes, with retry recovery that
does not advance the version again. Keep all issue-branch version and merge
authority rules unchanged.
