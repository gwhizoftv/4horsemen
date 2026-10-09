# Issue 167: Publish a GitHub Release with each version bump

## Goal

Yes — each successful pre-1.0 `0.0.N` advance on `main` should also produce a
GitHub Release (with tag `v0.0.N`). Today `version-bump-on-merge` only commits
`chore: release 0.0.N` and pushes; the Releases page stays empty even though
`package.json` and `coord --version` move forward.

Cadence stays tied to the existing bump workflow (every merge that lands on
`main`), not a new per-issue protocol step. Coordinated issues already reach
that path when their PR merges; owner/manual merges get the same release.

## Exact File List to be changed or deleted

- `.github/workflows/version-bump-on-merge.yml` — after a successful bump push,
  create tag `v${version}` and a GitHub Release for that tag targeting the bump
  commit SHA; keep existing trigger, concurrency, loop guard, and retry.
- `docs/coord-driver.md` — state that the bump job also publishes a GitHub
  Release / `v0.0.N` tag (not only the `chore: release` commit).
- `docs/repo-map.md` — same one-sentence release note next to the bump-version
  command description.
- `CONTRIBUTING.md` — note that merges produce a GitHub Release via the bump
  workflow; npm publishing remains out of scope.
- `test/workflows.test.ts` — assert the bump workflow creates a `v`-prefixed
  release (e.g. `gh release create`) after the push path, without weakening the
  existing main-only trigger and `chore: release ` loop-guard cases.

## Exact file list to be created

- None. Release publishing stays inside the existing workflow; no new TypeScript
  module, action composite, or workflow file.

## Reuse and Scope

Reuse:

- `.github/workflows/version-bump-on-merge.yml` — sole publisher of `0.0.N`;
  extend the success path after `git push` rather than adding a second workflow.
- `node dist/bumpVersion.js` / `package.json` version read already used in the
  bump step — the release tag and title use that same `version` shell variable.
- `test/workflows.test.ts` — YAML parse helpers, main-only trigger assertion,
  and quoted-`if:` suite; add focused cases there instead of a new test file.
- Existing `permissions: contents: write` — sufficient for tags and Releases
  with the default `GITHUB_TOKEN`; no new PAT or permission scope.

Do not change: `src/bumpVersion.ts`, `src/versionBump.ts`, `package.json`
scripts, agent protocol, or issue-branch version rules. Issue branches still
must not list `package.json` for a bump.

New files: none — justified because release creation is a one-shot `gh`
invocation that needs the post-push remote SHA; putting it in TypeScript would
add a CLI surface only CI would call, with no local test beyond what the
workflow YAML assertions already cover.

## Tests

Commands (real, as declared in this repository):

- `pnpm check:fast` — lint, typecheck, fast/system tests (hook-owned
  `verify.precommit` for product commits; focused run while developing).
- `pnpm check` — build, check:fast, e2e (coordinator/PR acceptance when
  product code changes).

Focused cases in `test/workflows.test.ts` (extend; do not add a new file):

1. `version-bump-on-merge.yml` still triggers only on pushes to `main` and
   still guards with `startsWith` / `chore: release ` (existing cases remain).
2. The workflow file contains a post-bump release step that invokes
   `gh release create` with a `v${version}` (or equivalent `v`-prefixed) tag
   argument — fails before the YAML change, passes after.
3. The release step appears only in this workflow (no second workflow file
   introduced); `permissions.contents` remains write.

No live GitHub API test: workflows are not executed locally; structural YAML
assertions match the existing suite’s purpose (catch unreadable/`on:` breakage
and missing release wiring).

## Alternatives Rejected

**Separate workflow on `chore: release` commits.** The bump push uses
`GITHUB_TOKEN`, which does not trigger further workflow runs, so a follow-up
workflow would never fire without a PAT. Release creation must stay in the same
run that pushes the bump.

**`npm version patch` / tags from npm.** Issue 108 rejected this for serializer
and message-format churn; keep `bumpVersion.js` and add `gh release create`
beside the existing git commit.

**Per-issue protocol artifact or finalize-time release in `runLoop`.** Would
miss owner/manual merges and duplicate the “visible after reinstall” contract
already owned by `push: main`. The issue’s “each issue” intent is satisfied by
the merge→bump path.

**Backfill Releases for historical `0.0.N`.** Out of scope; publish forward from
the next bump after this lands.

**Release assets / npm publish.** The package is private; a notes-only GitHub
Release is enough for discoverability.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| `GITHUB_TOKEN` cannot start a second workflow after the bump push | Create the Release in the same job immediately after a successful `git push`. |
| Job re-run after a successful bump could advance `0.0.N` again (pre-existing) | Document: do not re-run a green bump job; if only `gh release create` failed, create that tag/release manually once. |
| First Release has no previous tag for `--generate-notes` | Use `gh release create … --generate-notes`; GitHub handles the initial range. |
| Tag/`Release` name drift from `package.json` | Read `version` once after `bumpVersion.js` and reuse it for commit message, tag `v${version}`, and release title. |
| Issue 108 said tags were unwanted pre-1.0 | This issue supersedes that for GitHub Releases only; tags are required by Releases and match `coord --version`. |
| Workflow YAML `if:` quoting regressions | Keep expressions double-quoted; existing `workflows.test.ts` quoted-`if:` case continues to guard. |

## Conclusion

Extend `version-bump-on-merge` so that after it commits and pushes
`chore: release 0.0.N`, it creates GitHub Release `v0.0.N` on that commit.
Update the three agent/human docs that describe the bump, and lock the wiring
in `test/workflows.test.ts`. No new modules, no issue-branch version edits, no
npm publish — the smallest change that makes each version advance show up on
GitHub’s Releases page.
