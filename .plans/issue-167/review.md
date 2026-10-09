# Issue 167 — plan review

Protocol version: 1. Reviewed the exported `.plans/issue-167/plan.md` files at:

- Claude: `9ce80a0081ae28217e2e26f94febbed030aadce4`.
- Codex: `10eecaca18ec334c19c38a2dd75ea069a75a24b1`.
- Cursor: `482f75fecda3f916c9973e0e97055ebf6a87e543`.

## Findings

### 1. Cursor: verify an existing tag before publishing against it (P2)

**Plan claim/section:** Cursor's Exact File List requires a release targeting
the bump SHA, while Reuse and Scope describes publication as a one-shot `gh`
invocation. Neither the algorithm nor its Tests requires checking an already
existing remote tag's commit.

**Rule:** A release named `v<version>` must resolve to the exact successfully
pushed bump commit, including when that tag already exists. Passing a target
SHA for automatic tag creation is not verification of an existing tag.

**Concrete failure:** Suppose `v0.0.50` already exists at a different commit
(for example, from a mistaken manual recovery), but has no GitHub release.
After pushing the new 0.0.50 bump, the proposed one-shot
`gh release create v0.0.50 --target <bump-sha> --generate-notes` can publish
against that existing wrong tag. The release's source archive then disagrees
with the versioned bump the plan promises to publish. The planned tests still
pass: they check invocation, tag prefix, placement, and permission, not tag
identity. `--target` controls creation of an absent tag, and `--verify-tag` alone
would only establish existence, not commit equality.
[GitHub CLI documentation](https://cli.github.com/manual/gh_release_create).

**Smallest correction/test:** Require a non-forcing explicit tag push that
rejects a conflicting remote tag, or resolve and compare an existing tag before
release creation. Add one focused case in `test/workflows.test.ts` with a
pre-existing wrong-target tag; publication must fail without moving it or
creating a release. Claude's atomic push and Codex's explicit target validation
already protect this case.

### 2. Claude and Cursor: unchanged concurrency does not support the per-merge claim (P2)

**Plan claim/section:** Claude's Problem says the pipeline runs once per landed
issue and its Exact File List explicitly leaves concurrency unchanged. Cursor's
Goal promises the cadence for every main merge and its workflow file-map entry
also keeps concurrency unchanged.

**Rule:** A plan that claims one bump/release per merge must retain pending merge
runs, or explicitly narrow that promise to releases for the bumps that actually
execute. `cancel-in-progress: false` alone is not a queue of all merge events.

**Concrete failure:** Run A is executing, merge B has a pending run, then merge
C arrives. With the existing default single-pending concurrency policy, C
replaces B even though A is not cancelled. B never gets its own bump/release;
C's later release may include its code, but this is not the promised per-issue
cadence. This is an inherited scheduler limitation, not a newly introduced
regression, but both plans rely on it as the basis for satisfying this issue.
GitHub documents pending-run replacement and the optional bounded multi-run
queue separately from cancellation of a running job.
[GitHub concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

**Smallest correction/test:** Either add `queue: max` and state its 100-pending
capacity/order limitations, with a parsed-YAML assertion in the existing test
file, or explicitly describe the policy as one release per successful bump
with possible coalesced merges rather than one per issue. Do not claim unlimited
or strictly dispatch-ordered execution. Codex's plan already addresses these
limitations.

### Scope, reuse, tests, and recovery assessment

- All three plans contain the required headings, keep publication at the
  existing post-merge workflow, reuse the bump helper and workflow test file,
  and avoid branch-side version edits, npm publishing, new dependencies, or new
  product files. Their documentation edits describe the changed behavior and
  are not unrelated cleanup. The additional `docs/repo-map.md` and
  `CONTRIBUTING.md` edits in peer plans are reasonable, not necessary grounds
  for rejection.
- Claude's atomic push is a compact way to keep the tag and main update
  consistent. Its two structural tests are focused, but do not prove the
  retry's runtime behavior. An offline rejected-push/same-version retry case
  would strengthen evidence without a live GitHub API test. The statement that
  a hosted workflow cannot run locally does not preclude testing its extracted
  shell body against local Git fixtures.
- Both peer plans explicitly choose manual release repair after a publishing
  failure. I do not treat automatic whole-job rerun safety as an unstated issue
  requirement: a clearly documented manual repair policy can be acceptable.
  Preserve that warning in the delivered operator documentation, because
  rerunning their job advances the version again. Cursor's manual repair also
  needs the original bump SHA when the tag is absent, not a floating main target.
- Codex adds more logic than the peers for durable source identification and
  replay. That complexity is tied to explicit recovery guarantees, not new
  distribution scope; its tests exercise those guarantees using existing
  `makeProduct`, `git`, and `tryGit` support. No additional blocking finding in
  the Codex plan. Keep those tests table-driven and local rather than building
  a general release framework.

## Conclusion

- **Codex `10eecaca18ec334c19c38a2dd75ea069a75a24b1`: ready to implement.**
- **Claude `9ce80a0081ae28217e2e26f94febbed030aadce4`: revise the concurrency/cadence
  claim in finding 2.** The atomic publishing approach itself is sound, and
  documented manual recovery is a legitimate smaller alternative.
- **Cursor `482f75fecda3f916c9973e0e97055ebf6a87e543`: revise findings 1 and 2.**
  In particular, state and test the existing-tag identity rule before adoption.

Reviewed bound plan bytes, the unchanged local workflow/test support, and the
official GitHub behavior cited above. No product suite or live publication was
run for this coordination-only review; no hosted execution result is claimed.
