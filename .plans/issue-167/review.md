# Issue 167 plan review (claude)

Bound plans reviewed:

- claude `9ce80a0081ae28217e2e26f94febbed030aadce4`
- codex `10eecaca18ec334c19c38a2dd75ea069a75a24b1`
- cursor `482f75fecda3f916c9973e0e97055ebf6a87e543`

All three plans give the same answer to the issue: yes, publish a `v0.0.N` tag
and a GitHub release for every bump, inside the existing
`.github/workflows/version-bump-on-merge.yml`. All three agree that a
tag-triggered second workflow cannot work, because writes made with
`GITHUB_TOKEN` do not trigger workflows. None of them changes `package.json`,
creates a new file, or adds a dependency. They differ in how they bind the tag
to the bump commit, how much failure recovery they build, and how they test it.

Checks I ran:

- I read each bound plan file.
- I confirmed against GitHub's concurrency documentation that Codex's
  `concurrency.queue: max` key is real: it allows up to 100 pending runs instead
  of 1, and cannot be combined with `cancel-in-progress: true`.
- I confirmed that dist/ is gitignored and that `pnpm check:fast` does not run
  `pnpm build`.
- I confirmed that `makeProduct`, `git` and `tryGit` exist in the test support
  fixture that Codex cites.

I ran no product tests. None are needed to review plans.

## Findings

### F1 — codex: the Tests section executes the bump step's shell body, which needs a build artifact the required suite never produces (blocking)

**Claim.** Tests: "Tests must read and execute the relevant YAML `run` bodies,
not reimplement their logic." Group 2 requires that "a fresh source creates
exactly one bumped commit, matching remote tag, and published release." These
cases join `test/workflows.test.ts`, which is part of the fast suite.

**Rule.** A test in the hook-owned `pnpm check:fast`, and in the coordinator's
check at the pin, must pass in a fresh checkout using only what that command
produces.

**Failure.** The bump step's run body calls `node dist/bumpVersion.js`. dist/
is gitignored, and `check:fast` runs lint, typecheck, test:fast and test:system
with no build.

- In a fresh worktree, every case that executes the bump body fails with
  ENOENT on `dist/bumpVersion.js`.
- On a developer clone where dist/ happens to exist, the same cases run stale
  compiled code rather than the source at the pin.

In both cases the result does not depend on the code under review. Stubbing
`node` to work around this would leave the bump untested, which defeats the
stated purpose of executing real bodies.

**Smallest correction.** Assert the workflow's structure in `test/workflows.test.ts`,
as the existing cases do, and do not execute run bodies.

### F2 — codex: the trailer-based rerun recovery more than doubles the issue's scope and moves untestable logic into YAML shell (blocking)

**Claim.** Reuse and Scope steps 2–5 add the following:

- a `Coord-Release-Source` commit trailer,
- a first-parent history search for that trailer,
- validation that the recovered bump commit's manifest matches its subject,
- remote tag resolution with annotated-tag peeling,
- release-state classification (draft, conflicting tag, auth/network error),
- and a table-driven matrix of failure boundaries.

**Rule.** AGENTS.md "Implementation discipline" calls for the smallest change
that fully solves the issue, the fewest focused tests, and no speculative
flexibility. The repo's precedent also matters: the plan for issue 108 rejected
putting logic in workflow shell because "No test can reach it", and moved the
only non-trivial step into src/versionBump.ts.

**Failure.** The issue asks whether releases should exist.

- **Pre-existing hazard, not this issue's.** A rerun after a partial failure
  bumps again, but that happens today. The two non-codex plans document a
  one-command manual recovery instead.
- **Untestable logic in YAML.** Followed as written, the plan puts the largest
  shell program in the repository inside YAML. It parses `git log` trailers,
  peels tags, and classifies `gh` API errors.
- **Wrong test environment.** Local tests run that shell on macOS: bash 3.2 and
  BSD userland, with a fake `gh`. Production runs it on ubuntu-latest: bash 5,
  GNU tools, and the real API. A passing suite therefore does not show the
  runner behaves the same way. Any mismatch reveals itself only after merge,
  on `main`, where the workflow pushes directly.

**Smallest correction.** Drop steps 2 and 5's recovery machinery. Keep:

- the exact-commit tag,
- `--verify-tag`,
- `--generate-notes`,
- the env-passed values,
- the documented manual recovery for a failed release call.

### F3 — cursor: the release test does not bind the tag to the bump commit (should fix)

**Claim.** Tests case 2 says the workflow "contains a post-bump release step
that invokes `gh release create` with a `v${version}` (or equivalent
`v`-prefixed) tag argument". The file list says the release targets "the bump
commit SHA".

**Rule.** Tag `v0.0.N` must point at the `chore: release 0.0.N` commit, and
the test that guards this workflow must fail when it does not.

**Failure.** Consider an implementation that runs `gh release create "v${version}" --generate-notes`
without `--target` and without a pre-pushed tag. It passes case 2.

- With no existing tag, GitHub creates the tag at the default branch's
  current head.
- Workflow runs are serialized, but merges are not. A PR that merges between
  the bump push and the API call becomes the tag target.
- The result: `v0.0.50` names a tree that contains the next issue's code and
  whose package.json still says 0.0.50.

The plan's Risks table claims the version is read once and reused, but nothing
asserts the target.

**Smallest correction.** Have the test require either `--verify-tag` on a tag
pushed with the bump commit, or `--target` set to the pushed SHA.

### F4 — cursor: the tag is published separately from the main push, so a failed release call leaves a version with no tag (non-blocking)

**Claim.** File list: "after a successful bump push, create tag `v${version}`
and a GitHub Release for that tag". Risks: "if only `gh release create` failed,
create that tag/release manually once."

**Rule.** Every `0.0.N` that reaches `main` should be recoverable to its exact
commit without reading history by hand.

**Failure.** If the tag is created by the release API call, an API failure after
the push leaves `0.0.N` on `main` with no tag. The documented manual recovery
then has to locate the `chore: release 0.0.N` commit by hand. If the owner
instead re-runs the job, as is natural for a red run, the version is bumped a
second time.

**Smallest correction.** Push the tag with `git push --atomic` together with the
bump commit. The manual step then becomes a single `gh release create
"v0.0.N" --verify-tag --generate-notes` against a tag that already exists.

### F5 — claude (self-review): Codex's `queue: max` is a valid improvement the claude plan omits (non-blocking)

**Claim.** The claude plan's Exact File List says to leave the concurrency block
unchanged.

**Rule.** If each merge is meant to yield a release, a burst of merges should not
silently collapse into fewer releases than the owner expects.

**Failure.** With the default `queue: single`, a third push arriving while one
run is in progress and one is pending cancels the pending run.

- The two remaining runs produce two versions for three merges.
- The cancelled merge's PR still appears in the next release's generated notes,
  so no merged work goes unreleased.
- So the claude plan as written loses no content. It does give some merges no
  release of their own.
- The workflow's own comment ("Two merges landing seconds apart must produce
  two bumps") is accurate only up to two.

**Smallest correction (optional).** Add `queue: max` beside `cancel-in-progress: false`.
GitHub documents that this combination is valid. Assert it in the existing
`version-bump-on-merge` describe block.

### Scope, reuse, and tests across plans

- **claude.** Four files, no new files. Reuses the existing retry loop, bump
  entry point, and test helpers. Two focused structural cases, both failing on
  the baseline. It documents the rerun-bumps-again limitation and its manual
  recovery. It does not touch CONTRIBUTING.md, whose wording ("the PR-into-main
  release workflow handles the pre-1.0 version advance") stays true.
- **cursor.** Five files, no new files, reuse well identified. Adding
  CONTRIBUTING.md is defensible documentation scope. Its case 3 ("no second
  workflow file introduced") adds little, but costs little. It correctly
  addresses issue 108's "tag is not wanted pre-1.0" as superseded by this
  issue. The claude plan does not mention that, but releases require tags, so
  the conclusion is the same.
- **codex.** Three files, no new files, accurate reuse citations. However, its
  scope and test design fail F1 and F2. Its docs change also skips
  docs/repo-map.md, which still describes the advance as only a commit. That is
  incomplete but not false.

## Conclusion

Select the claude plan (`9ce80a0081ae28217e2e26f94febbed030aadce4`). Optionally
adopt Codex's `queue: max` from F5. It is the smallest plan that fully answers
the issue, and it is the only one that both:

- pushes the tag atomically with the bump commit, and
- has tests that pin the tag to that commit.

The cursor plan (`482f75fecda3f916c9973e0e97055ebf6a87e543`) is acceptable only
after F3: its test must bind the tag to the bump commit. F4 is recommended.

The codex plan (`10eecaca18ec334c19c38a2dd75ea069a75a24b1`) should not be
implemented as written. Its execution tests depend on an unbuilt dist/ (F1),
and its rerun-recovery machinery expands the issue into a large shell program
in YAML that the suite cannot faithfully exercise (F2).
