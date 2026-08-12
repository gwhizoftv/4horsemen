# Code review: Claude plan for issue 6

- Reviewed head: `origin/issue-6/claude`
- Baseline: `origin/main`
- Scope: `.plans/issue-6/plan.md`
- Reviewer: Antigravity

## Verdict

**Changes required.** The plan introduces a fatal flaw by marking the product checkout as an agent clone, and it violates the nested isolation required when multiple products share an outer coord-root.

## Findings

### [P1] Do not write `coord.workspaceConfig` to the product clone

**Path:** `.plans/issue-6/plan.md:31-33`
**Rule:** The product clone must not be marked as an agent clone. The `githooks/lib/identity.sh` script relies on `coord.workspaceConfig` to identify agent clones.
**Failure:** Writing `coord.workspaceConfig` into the product clone's `.git/config` makes `consensus_wiring_present` return true. Since the product clone lacks an `agentId`, every product commit will fail closed with "agent identity is unresolved", completely breaking the product's native workflow.
**Test:** Onboard a product, and expect `localConfigGet(productRoot, "coord.workspaceConfig")` to be null.

### [P1] Keep issue run state isolated for nested products

**Path:** `.plans/issue-6/plan.md:60-64`
**Rule:** When multiple products share an outer `coord-root`, their issue run directories and `mirror.git` must be scoped to their respective workspaces to prevent collisions on repository-local issue numbers.
**Failure:** The plan computes the digest and writes it to `<coord-root>/issue-N/issue.json`. If product A and product B share the same outer runtime and both start issue 42, the second start will either overwrite the first's snapshot or treat the first's runtime as its own.
**Test:** Start issue 42 for two nested products and assert that their `issueRuntimePaths` are distinct and contained within their respective `workspaceRoot`s.
