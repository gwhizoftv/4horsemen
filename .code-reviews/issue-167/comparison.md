# Issue 167 implementation comparison

## Comparison

Bound implementation pins compared:

- claude `e291099d78f28c5538c5176cd47cfc37675105d0`
- codex `654c95664b1eb3752f460071f1d8c83f7231fa1e`
- cursor `cb86b961055c15b72e81e56e0a9032c279173c0c`

All three stay inside the issue and the approved product paths
(`.github/workflows/version-bump-on-merge.yml`, `docs/coord-driver.md`,
`docs/repo-map.md`, `test/workflows.test.ts`): no new modules, no
`package.json` bump, no second workflow, no npm publish. Each reuses the
existing bump retry loop and extends `test/workflows.test.ts` with structural
YAML cases rather than inventing a release framework.

### Shared correct core

On the release mechanics that answer the issue, the three pins agree:

1. Tag `v${version}` after the bump commit (`git tag -f`).
2. Push commit and tag together with
   `git push --atomic origin "HEAD:main" "refs/tags/v${version}"`.
3. Emit `version=` to `$GITHUB_OUTPUT` only after that push succeeds.
4. A later step runs
   `gh release create "v${VERSION}" --verify-tag … --generate-notes` with
   `GH_TOKEN` / `VERSION` from env (not inline `${{ }}` in the shell text).
5. Docs in `coord-driver.md` and `repo-map.md` mention the tag and GitHub
   Release.

That atomic + `--verify-tag` shape is what keeps `v0.0.N` on the bump commit
even when the Release API fails, and prevents `gh` from minting a tag at a
later `main` tip.

### Finding — cursor omits `queue: max`

- File/line: `cursor` pin
  `.github/workflows/version-bump-on-merge.yml` lines 27–29
  (`concurrency` has `cancel-in-progress: false` only; no `queue`).
- Rule: when promising a bump/release per merge under a concurrency group,
  pending runs must queue (`queue: max`) rather than the default single
  pending slot that replaces earlier pending runs.
- Failure: with run A in progress and B pending, merge C replaces B; B never
  gets its own `0.0.N` / GitHub Release even though its commit is on `main`.
- Smallest test (already present on the other pins): assert
  `concurrency.queue === "max"` alongside `cancel-in-progress: false` in
  `test/workflows.test.ts` (claude lines 84–90; codex lines 86–92).

Claude (`e291099d…` lines 32–35) and codex (`654c9566…` lines 23–26) both set
`queue: max` and lock it in tests. Cursor’s pin matches the letter of the
selected plan’s “leave concurrency unchanged” note but loses the per-merge
cadence under burst merges.

### Finding — no other blocking divergence

- Codex release step (`654c9566…` line 93) omits `set -euo pipefail`; `gh`
  still exits non-zero on failure, so this is style-only versus claude/cursor.
- Claude’s comments and recovery wording (`e291099d…` lines 14–21, 94–96) are
  the clearest operator guide for “do not re-run; `gh release create
  --verify-tag` by hand.”
- Codex’s tests are slightly stricter on step ordering and exact release
  command text; all three adequately fail on a baseline without atomic tag /
  verify-tag.

### Scope and reuse verdict

| Pin | Within issue | Reuse | Extra surface | Focused tests |
| --- | --- | --- | --- | --- |
| claude `e291099d…` | yes | existing workflow + workflow tests | `queue: max` only | atomic, release, queue |
| codex `654c9566…` | yes | same | `queue: max` only | atomic, release, queue (stricter strings) |
| cursor `cb86b961…` | yes | same | none beyond plan | atomic + release; no queue assertion |

Prefer **claude `e291099d78f28c5538c5176cd47cfc37675105d0`**: same durable
tag/release path as the peers, plus `queue: max` and matching coverage.
Codex `654c95664b1eb3752f460071f1d8c83f7231fa1e` is equivalently shippable.
Cursor `cb86b961055c15b72e81e56e0a9032c279173c0c` is acceptable only after
adding `queue: max` (and a one-line test) so burst merges cannot drop a
pending release run.
