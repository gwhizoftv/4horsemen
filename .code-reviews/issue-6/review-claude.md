# Code review: Claude plan for issue 6

- Reviewed head: `origin/issue-6/claude` @ `51b9fe78de89eedc3bac7a19dd471a10b804f5e2`
- Baseline: `origin/main` @ `f9d00841db8e5a95acb4e2956266825869e0758c`
- Scope: `.plans/issue-6/plan.md`
- Reviewer: Codex

## Verdict

**Changes required.** The plan has a strong transaction boundary for the issue
snapshot and a complete flat/nested config resolver, but it does not pass the
current R2 plan predicate. Its outer-runtime state model also collides across
nested products, and two proposed convenience paths can start work that is not
bound to the requested product's real GitHub issue.

## Findings

### [P1] Make the plan satisfy the mechanical R2 section contract

**Path:** `.plans/issue-6/plan.md:465`. **Rule:** A published R2 plan must contain headings accepted by `checkPlan` in `src/evidence.ts:60-70`: File Map/Proposed Architecture, Tests/Validation, Alternatives, Risks, and Conclusion. **Failure:** `## Test plan` is not one of the accepted exact headings, and this plan also has no Alternatives or Conclusion heading, so `evaluateEvidence` rejects the plan with three outstanding errors and gate 2 cannot accept Claude's submission. **Test:** feed this exact blob to the `plan-published` evidence evaluator and require a satisfied observation with no outstanding section errors.

### [P1] Scope issue and mirror state to the selected workspace

**Path:** `.plans/issue-6/plan.md:107-111`. **Rule:** When multiple products share an outer coord-root, each product must have its own mirror and issue runtime namespace; config namespacing alone cannot isolate runs. **Failure:** the plan keeps `mirror.git` and every `issue-N/` under the outer coord-root even for nested products, so product A issue 42 and product B issue 42 address the same `issue-42/start.json`; the second invocation either resumes A under B's selection or refuses because A's state already exists. **Test:** onboard two products into one coord-root, start issue 42 for both, and assert their mirror paths and `start.json` paths are distinct and bind different origins.

### [P1] Keep the GitHub issue mandatory in production starts

**Path:** `.plans/issue-6/plan.md:150-155`. **Rule:** Every production start for issue N must read issue N from the configured GitHub repository and fail when that issue is missing or unreadable; test fixtures should use an injected fetcher rather than a user-facing bypass. **Failure:** `--issue-snapshot <file>` substitutes arbitrary owner bytes for the fetch, so `coord start 999 --issue-snapshot fake.json` can create a valid run and digest even when GitHub issue 999 does not exist, defeating the issue-first invariant and its required remediation. **Test:** provide a syntactically valid snapshot file while the injected GitHub lookup returns 404 and require start to fail before creating runtime or tmux state.

### [P1] Do not select the sole registry entry from an unrelated worktree

**Path:** `.plans/issue-6/plan.md:63`. **Rule:** Flagless `coord N` may infer a product only from the current registered Git worktree; otherwise it must require `--product` rather than guessing machine-global state. **Failure:** with exactly one registered product, running `coord 42` from an unrelated repository silently starts that sole product, creating agent branches and runtime state against the wrong origin for the issue the operator intended to run. **Test:** register product A, invoke numeric dispatch with cwd set to unrelated product B, and require an error naming `--product` without creating A's `issue-42` directory.
