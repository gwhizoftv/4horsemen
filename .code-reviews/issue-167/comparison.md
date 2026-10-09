# Issue 167 implementation comparison (claude)

Bound implementation pins compared:

- claude `e291099d78f28c5538c5176cd47cfc37675105d0`
- codex `654c95664b1eb3752f460071f1d8c83f7231fa1e`
- cursor `cb86b961055c15b72e81e56e0a9032c279173c0c`

Method:

- I read each pin's workflow in full from the bound worktrees.
- I diffed each peer's `test/workflows.test.ts`, `docs/coord-driver.md` and
  `docs/repo-map.md` against the claude pin.
- I re-ran no product suites for this comparison.
- My own pin's checks, run while implementing, were:
  - focused `test/workflows.test.ts`: 8/8;
  - the same file against the baseline workflow: the 3 new cases fail;
  - the pre-commit `pnpm check:fast` passed;
  - the pre-push `pnpm test:e2e` passed.
- I have no verification results for the codex or cursor pins and claim none.

## Comparison

### Shared behavior

All three pins implement the selected plan's mechanism almost byte for byte in
`.github/workflows/version-bump-on-merge.yml`:

- **Bump step.** It gains `id: bump`.
- **Tag.** `git tag -f "v${version}"` runs after the commit, inside the existing
  two-attempt retry.
- **Atomic push.** `git push --atomic origin "HEAD:main" "refs/tags/v${version}"`
  sends the bump commit and its tag together.
- **Output.** `version=${version}` is written to `$GITHUB_OUTPUT` only on
  success.
- **Release.** A following step runs
  `gh release create "v${VERSION}" --verify-tag --title "v${VERSION}" --generate-notes`.
  `GH_TOKEN` and `VERSION` come from `env`, not from interpolation inside the
  script.

Shared scope:

- All three touch exactly the four approved product paths.
- None adds files or dependencies, or changes source modules or `package.json`.
- All extend the existing `version-bump-on-merge` describe block in the
  existing test file and reuse its `parse` helper.
- The trigger, the `chore: release ` guard, the bot identity and the
  permissions are unchanged in all three.

### Differences

| | claude | codex | cursor |
| --- | --- | --- | --- |
| `queue: max` | yes, with rationale comment | yes | **no** |
| Original "Serialize, never cancel" rationale kept | yes, extended | replaced with a shorter comment | yes |
| Manual-recovery note in workflow | header comment | comment above release step | header comment |
| Manual recovery in `docs/coord-driver.md` | one inline sentence + command | dedicated paragraph + code block, plus queue limits | **absent** |
| `docs/repo-map.md` | one clause | clause + link to the recovery section | one clause |
| Tag argument asserted in release test | `"v${VERSION}"` | exact full command string | **not asserted** |
| Output written only after successful push asserted | presence only | line order relative to push and `exit 0` | presence only |
| Release-step env asserted | per key | exact object | per key |
| `permissions.contents: write` asserted | no | yes | no |

### Findings

**F1: `.github/workflows/version-bump-on-merge.yml:27-29` (cursor). The
concurrency block keeps the default single pending slot.**

- **Rule.** If every merge to `main` should produce its own `v0.0.N` release,
  a merge's pending bump run must not be replaced by a later one.
- **Failure.**
  - Merge A's run is executing. Merge B's run is pending. Merge C arrives.
  - GitHub's default `queue: single` cancels B's pending run and keeps C's.
  - A and C each bump. B's code ships inside C's release, and B never gets a
    version or release of its own.
- **Severity.** This is inherited behavior, not a regression. Cursor's pin
  follows the selected plan's text ("leave the concurrency block unchanged")
  literally. All three plan reviews flagged the gap, though, and the claude and
  codex pins close it within the same approved file.
- **Test.** The case in the claude and codex pins:
  `expect(parse("version-bump-on-merge.yml").concurrency?.queue).toBe("max")`.

**F2: `test/workflows.test.ts:101-110` (cursor). The release-step test never
checks the tag argument.**

- **Rule.** The release step must name the same `v`-prefixed tag that the bump
  step pushed. Otherwise `--verify-tag` fails at runtime on every merge.
- **Failure.**
  - Suppose the release step is edited to `gh release create "${VERSION}" --verify-tag --generate-notes`
    (the `v` is dropped).
  - It still satisfies every assertion in cursor's case: `gh release create`,
    `--verify-tag` and `--generate-notes` are present, and the env is
    unchanged.
  - On the runner, `--verify-tag` finds no tag `0.0.N`. Every merge then ends
    with a red release step and a version that has no release.
- **Test.** Add `expect(script).toContain('"v${VERSION}"')`. That is what the
  claude pin asserts at line 118. The codex pin pins the whole command string.

**F3: `docs/coord-driver.md` "Starting and running" (cursor). The operator
documentation omits the recovery procedure.**

- **Rule.** A failure mode where the obvious remedy (re-running the red job)
  does harm must be documented where operators read about the bump. The
  workflow source is not enough.
- **Failure.**
  - The release API call fails after the atomic push.
  - The owner, reading only the docs, re-runs the job.
  - The `if:` guard still sees the original merge commit, so the job bumps
    again. That burns `0.0.N+1` and leaves `v0.0.N` with no release.
  - The warning exists only in the workflow header (lines 17-19).
- **Fix sketch.** Add the one-sentence warning and the command, as in the
  claude and codex pins. A test cannot express this.

**F4: `test/workflows.test.ts:102` (claude). The output assertion checks only
that the line is present, not where it sits.**

- **Rule.** `version=` should be emitted only after the atomic push succeeds.
- **Failure.** Moving the `echo` above the `if git push` still passes. In
  practice this is benign:
  - GitHub keeps the last value written, so a rejected attempt followed by a
    successful one still yields the right version.
  - Two rejections exit 1, so the release step never runs.
- **Severity.** Robustness gap in the test, not a defect. Codex's ordering
  assertions are stricter and cover it.

### Scope and focus

- **claude.** Smallest diff that closes all reviewed gaps.
  - Three focused cases. Each one fails on the baseline: I checked this by
    swapping in the baseline workflow.
  - Keeps and extends the existing concurrency rationale rather than replacing
    it.
  - `queue: max` goes beyond the selected plan's literal text. It stays inside
    the approved file and is tested.
- **codex.** Same workflow behavior as claude.
  - Strictest tests: the exact command strings, push → output → `exit 0`
    ordering, no `${{` inside the release script, and `contents: write`.
  - Exact-equality assertions on the concurrency and env objects are brittle.
    Adding any harmless key, such as an extra env var on the release step, fails
    them. They are still focused.
  - Best operator docs: a recovery code block, the queue limits, the
    first-release note, and a repo-map link to the recovery section.
  - Its concurrency comment drops the original "never cancel / skip a release
    number" rationale. That loses explanation, not behavior.
  - Same `queue: max` deviation from the plan text as claude.
- **cursor.** Most literal to the selected plan, and its workflow mechanism
  matches the others. Weaknesses are F1 (no `queue: max`), F2 (the tag argument
  is not asserted) and F3 (no recovery note in the docs).

### Recommendation

Prefer **codex `654c95664b1eb3752f460071f1d8c83f7231fa1e`**. Its workflow
behavior is identical to claude's, and it has the stronger tests and the more
complete recovery documentation. **claude `e291099d78f28c5538c5176cd47cfc37675105d0`**
is an equivalent and acceptable alternative: it differs only in test strictness
(F4) and doc depth. **cursor `cb86b961055c15b72e81e56e0a9032c279173c0c`** is
functionally correct for the plan as written, but should take F1–F3 before
being selected.
