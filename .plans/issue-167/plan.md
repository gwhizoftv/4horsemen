# Issue 167: publish a GitHub release for every version bump

## Problem

Every merge into `main` already produces a new version: the
version-bump-on-merge workflow advances package.json and pushes a
`chore: release 0.0.N` commit. Nothing marks that commit as a release, though.
The repository has no tags and no GitHub releases (`gh release list` returns
nothing; `git ls-remote --tags origin` is empty). So the version reported by
`coord --version` points to no browsable artifact, and nobody can see what
changed between two versions without reading the commit log.

The issue asks whether each issue should produce a release. Yes, and the
existing pipeline already runs once per landed issue (one PR per issue, one
bump per merge). The release should come from that same workflow run and use
the number it just pushed. A second mechanism would have to rediscover that
number. Each bump publishes:

1. a tag v0.0.N on the `chore: release 0.0.N` commit, pushed **atomically**
   with that commit, so a tag cannot exist for a version that `main` never
   received, and
2. a GitHub release for that tag, titled v0.0.N, with GitHub-generated notes.
   The notes list the PRs merged since the previous release tag.

Nothing on an issue branch changes. Branches still sit at `main`'s version, and
no plan lists package.json for a bump. npm publishing stays out of scope
(`"private": true` is unchanged).

## Exact File List to be changed or deleted

- `.github/workflows/version-bump-on-merge.yml`
  - Give the existing "Bump package.json and push to main" step `id: bump`.
  - Inside its existing retry loop, after `git commit`, create the tag with
    `git tag -f "v${version}"`. The `-f` matters: if an attempt is rejected and
    the retry recomputes the same number, the stale local tag is replaced, not
    an error.
  - Replace `git push origin "HEAD:main"` with
    `git push --atomic origin "HEAD:main" "refs/tags/v${version}"`. With
    `--atomic`, a rejected `main` update also rejects the tag, so the retry
    re-reads origin/main exactly as it does today and no orphan tag is left
    on the remote.
  - On success, write `version=${version}` to `$GITHUB_OUTPUT` before
    `exit 0`.
  - Add one step after it, "Publish GitHub release", with
    `env: GH_TOKEN: ${{ github.token }}` and
    `VERSION: ${{ steps.bump.outputs.version }}`, running
    `gh release create "v${VERSION}" --verify-tag --title "v${VERSION}" --generate-notes`.
    `--verify-tag` makes `gh` fail rather than silently create a new tag at
    some other commit if the pushed tag were missing. The version reaches the
    script through `env`, not inline `${{ }}` interpolation.
  - Extend the header comment with a short paragraph on the tag, the release,
    and why the push is atomic. Keep `permissions: contents: write`, which
    already covers both tag pushes and release creation, and leave the
    `concurrency` block and the `chore: release ` guard unchanged.
- `test/workflows.test.ts`: two new cases in the existing
  `describe("version-bump-on-merge")` block (see Tests).
- `docs/coord-driver.md`: in the "Starting and running" paragraph about the
  0.0.N advance, add one sentence. Each bump also pushes a v0.0.N tag with
  the release commit and publishes a GitHub release for it, so the installed
  `coord --version` maps to a release page with generated notes.
- `docs/repo-map.md`: in "Commands that actually run", where the doc says the
  advance lands as a `chore: release 0.0.N` commit, add that CI tags it
  v0.0.N and publishes a GitHub release.

No source module changes. package.json is **not** changed.

## Exact file list to be created

None. The behavior belongs in the existing workflow that already owns the
version number, and the tests join the existing workflow test file.

## Reuse and Scope

- **Reused unchanged:** the existing version-bump-on-merge job, including its
  checkout, `pnpm build`, bot identity env, serialized `concurrency` group,
  `chore: release ` self-trigger guard, and two-attempt fetch/reset/bump/commit/push
  retry. The bump itself still comes from the existing bump entry point and the
  manifest helper (src/bumpVersion.ts and src/versionBump.ts, both unchanged).
  The release reads the version the same way the step already does
  (`node -p 'require("./package.json").version'`).
- **Reused test infrastructure:** in `test/workflows.test.ts`, the existing
  `parse` helper, the `Workflow` type (widened only as far as needed to read
  step `id`, `run`, and `env`), and the existing per-file YAML-validity and
  quoted-`if:` cases, which automatically cover the new step.
- **Tooling:** `gh` is preinstalled on `ubuntu-latest` runners, and the
  workflow's own `GITHUB_TOKEN` authenticates it. This adds no dependency and
  no third-party action.
- **New files:** none.
- **Out of scope:** backfilling tags or releases for 0.0.1–0.0.49, changelog
  files, npm publishing, release assets, and any change to how or when the
  version advances.

## Tests

Both cases join the existing `describe("version-bump-on-merge")` block in
`test/workflows.test.ts`. Each one parses the YAML inside the case, as the
block's comment requires. Both fail on the baseline, whose workflow has no tag,
no `--atomic`, and no release step, and both pass after the change.

1. **"pushes the release tag atomically with the bump commit"**: finds the step
   with `id: bump` and asserts that its `run` script:
   - creates the tag (`git tag -f "v${version}"`),
   - pushes with `--atomic` and names both `HEAD:main` and
     `refs/tags/v${version}` in the same push command, and
   - writes `version=` to `$GITHUB_OUTPUT`.

   If someone splits the tag into its own push, `main` can advance without a
   tag, or a rejected attempt can leave a tag for a number another run then
   takes. This case fails if that happens.
2. **"publishes a GitHub release for the pushed tag after the bump"**: asserts
   that a later step in jobs.bump.steps, positioned after the `bump` step:
   - runs `gh release create` with `--verify-tag` and `--generate-notes`,
   - sets `GH_TOKEN` in its `env`, and
   - takes its version from steps.bump.outputs.version.

The existing `it.each(workflowFiles)` validity and quoted-`if:` cases keep
covering the edited file.

Validation for the product commit: the hook runs `pnpm check:fast` (the
declared verify.precommit). While developing, run the focused file with
`pnpm vitest run --config vitest.config.ts test/workflows.test.ts`. A workflow
cannot be run locally. The first real tag and release appear on the merge that
lands this issue, which is the end-to-end proof.

## Alternatives Rejected

- **A separate release.yml triggered by tag pushes or by the
  `chore: release` commit.** Tags and commits pushed with `GITHUB_TOKEN` do not
  trigger other workflows, so it would never run unless a PAT were introduced.
  A PAT is exactly what the existing guard comment warns would re-enable
  self-triggering. It would also have to rediscover the version that the bump
  step already holds.
- **Creating the tag through `gh release create --target <sha>` alone (no git
  tag).** The release would then be created in a separate API call after the
  push. If that call fails, `main` holds a version with no tag at all. The
  atomic push guarantees the durable part (tag ↔ commit) even when the release
  API call fails.
- **Third-party release actions (release-please, semantic-release,
  softprops/action-gh-release).** These add a dependency and their own
  versioning rules, which would compete with the 0.0.N advance that issue 95
  deliberately centralized in this workflow.
- **Releasing per issue from the coordinator during finalization.** Finalization
  happens before the merge, while the PR's version is still the old number.
  Only the post-merge workflow knows the number the release should carry.
- **Backfilling releases for 0.0.1–0.0.49.** Unrequested, and a one-off owner
  operation. Generated notes for the first new release already cover the
  history before it.
- **Maintaining a CHANGELOG.md.** `--generate-notes` produces the per-release
  list from merged PRs, and a hand-kept file would duplicate it.

## Risks and Mitigations

- **Release creation fails after the tag and commit are pushed** (for example
  an API outage): the run fails visibly, and `main` and the tag are already
  consistent. Re-running the job would bump again, because the `if:` guard sees
  the original merge commit. Recovery is therefore to create the missing
  release by hand with the same
  `gh release create "v<version>" --verify-tag --generate-notes`. The workflow comment states this.
- **A retry recomputes the same version after a rejected push** (the race lost
  to a non-bump push): `git tag -f` replaces the stale local tag. Because the
  push is atomic, the remote never received the first attempt's tag.
- **The first release's generated notes span the whole history** because no
  earlier tag exists. This is acceptable and happens once.
- **Tag push re-triggering this workflow:** the trigger is
  `push: branches: [main]`, which does not match tag refs, and `GITHUB_TOKEN`
  pushes do not trigger workflows anyway. The existing `chore: release ` guard
  remains as the explicit backstop.
- **Repository rules blocking `v*` tag creation by the bot:** none exist today
  (no tags or rulesets are present). If one is added later, the atomic push
  fails as a whole and the run reports it. No half-published state results.
- **Script injection through the version value:** the version comes from our
  own manifest and is passed through `env`, not interpolated into the script.

## Conclusion

Reuse the single workflow that already owns the 0.0.N advance. Push a v0.0.N
tag atomically with each `chore: release` commit, then publish a GitHub release
with generated notes from that tag in a following step. This touches one
workflow, one existing test file (two cases), and two doc paragraphs. It adds
no new files, dependencies, or branch-side version rules.
