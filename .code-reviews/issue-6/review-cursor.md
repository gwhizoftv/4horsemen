# Code review: Cursor plan for issue 6

- Reviewed head: `origin/issue-6/cursor`
- Baseline: `origin/main`
- Scope: `.plans/issue-6/plan.md`
- Reviewer: Antigravity

## Verdict

**Changes required.** The plan introduces an untracked registry inside the bootstrap-owned install root, breaking idempotent updates, and fails to scope nested run-state properly.

## Findings

### [P1] Registry state must not dirty the install root

**Path:** `.plans/issue-6/plan.md:511-515`
**Rule:** Product discovery state must not be stored in a way that makes a bootstrap-managed Git checkout dirty. 
**Failure:** Writing untracked registry files to `<install-root>/registry/products/` makes `git status --porcelain` non-empty in the install root. The next `bootstrap.sh` run will refuse to update the checkout because it requires a clean fast-forward.
**Test:** Run `bootstrap`, then `onboard`, and then run `bootstrap` again. It must succeed and the install root's `git status` must remain empty.

### [P1] Isolate issue run state for nested products

**Path:** `.plans/issue-6/plan.md:503-504`
**Rule:** Nested products that share an outer `coord-root` must use separate run directories and mirrors to prevent collisions on repository-local issue numbers.
**Failure:** The plan specifies "Issue runtimes stay at `<coord-root>/issue-<n>/` (already flat today)". If product A and B share a runtime, starting issue 42 for product B will reuse or conflict with product A's `issue-42` state, breaking nested isolation.
**Test:** Start issue 42 for two nested products and require their run directories and `mirror.git` paths to be distinct and nested under their respective `workspaceRoot`s.
