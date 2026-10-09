# Issue 167 plan review

Reviewed bound plans:

- claude `9ce80a0081ae28217e2e26f94febbed030aadce4`
- codex `10eecaca18ec334c19c38a2dd75ea069a75a24b1`
- cursor `482f75fecda3f916c9973e0e97055ebf6a87e543`

All three correctly answer the issue: publish a GitHub Release from the existing
`version-bump-on-merge` run (merge→`0.0.N`), not a second protocol path, not
finalize-time, and not a `GITHUB_TOKEN`-triggered follow-up workflow. None invent
new product modules. Differences are durability of tag↔commit, concurrency
queuing, recovery after partial failure, docs coverage, and test depth.

## Findings

1. **Cursor Exact File List / Risks (tag after push, docs-only re-run mitigation);
   Claude Exact File List (atomic tag + `--verify-tag`) is the rule that must
   hold.**  
   Rule: the durable `v0.0.N` tag must point at the bump commit before
   `gh release create`, and creation must use `--verify-tag` so a missing or
   wrong tag cannot silently retarget the default branch.  
   Failure if Cursor is followed as written: an implementer can push
   `chore: release` alone, then call `gh release create` without a prior atomic
   tag push / `--verify-tag`; if that API call fails, `main` has a new version
   with neither tag nor Release, and a job re-run (Cursor’s only mitigation is
   “do not re-run”) bumps again and orphans the failed number.  
   Correction: adopt Claude’s `git tag` + `git push --atomic` of `HEAD:main` and
   `refs/tags/v${version}`, then a later `gh release create … --verify-tag
   --generate-notes` step fed by step outputs / env (not inline script
   interpolation).

2. **Cursor Tests (string presence of `gh release create` only).**  
   Rule: focused workflow tests must fail if the tag is split from the bump
   push or if `--verify-tag` / version output wiring is dropped—the invariants
   that keep tag, commit, and Release aligned.  
   Failure if followed as written: a workflow that pushes `main` then runs a
   bare `gh release create "v…"` still satisfies Cursor’s cases while losing
   atomic tag durability and verify-tag safety.  
   Correction: keep Cursor’s “no second workflow / contents: write” checks, and
   add Claude’s two cases (atomic tag push + GITHUB_OUTPUT; post-bump release
   step with `--verify-tag`, `GH_TOKEN`, and bump outputs).

3. **Claude Exact File List / Cursor Exact File List (“leave concurrency
   unchanged”); Codex Reuse and Scope (`queue: max`).**  
   Rule: every push to `main` that should bump must still get a bump/release
   when several merges land during one run; with Actions concurrency, default
   `queue` is `single`, so a new pending run replaces any existing pending run
   even when `cancel-in-progress: false`.  
   Failure if Claude or Cursor is followed as written: three merges while one
   bump job runs → the middle pending run is canceled → that merge never gets
   `0.0.N` or a GitHub Release, contradicting “each merge/issue advance
   publishes a release.”  
   Correction: add Codex’s `queue: max` beside `cancel-in-progress: false` (do
   not pair `queue: max` with `cancel-in-progress: true`).

4. **Codex Reuse and Scope / Tests (trailer recovery + execute YAML `run`
   bodies offline).**  
   Rule: keep the smallest change that fully solves the issue; reuse existing
   parse-only workflow tests; justify speculative recovery machinery.  
   Failure if followed as written: implementation grows a `Coord-Release-Source`
   trailer protocol, first-parent history scans, and a fixture harness that
   extracts and executes live workflow shell against fake `gh`—far beyond
   empty Releases today—while delaying the atomic tag + `gh release create`
   fix and coupling tests to YAML formatting.  
   Correction: ship Claude’s atomic tag + verify-tag release step (plus
   `queue: max`); document manual `gh release create --verify-tag` if only the
   Release API fails after tag push. Defer automatic re-run recovery unless a
   later issue asks for it.

5. **Codex Exact File List (docs: only `docs/coord-driver.md`).**  
   Rule: every human/agent doc that describes the merge→version path must state
   the new tag/Release behavior so readers are not left with a commit-only
   story.  
   Failure if followed as written: `docs/repo-map.md` still describes the advance
   as only a `chore: release 0.0.N` commit, so agents planning from the repo map
   miss Releases/tags.  
   Correction: update `docs/repo-map.md` as Claude/Cursor do; optionally one
   sentence in `CONTRIBUTING.md` (Cursor) where it already names the release
   workflow.

## Conclusion

Prefer Claude’s mechanical shape (atomic tag with the bump commit, then
`gh release create --verify-tag --generate-notes` in-process, parse-level tests
in `test/workflows.test.ts`, `coord-driver` + `repo-map` docs, no new files),
amended with Codex’s `concurrency.queue: max`. Reject Cursor’s underspecified
post-push release and docs-only re-run story, and reject Codex’s trailer/shell
recovery harness as out of scope for this issue. Within the issue, reuse the
existing bump workflow and workflow tests; create no new modules; keep
issue-branch version rules unchanged.
