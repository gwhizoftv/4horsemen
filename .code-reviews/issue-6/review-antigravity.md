# Code review: Antigravity branch for issue 6

- Reviewed head: `origin/issue-6/antigravity` @ `7ba010f`
- Baseline: `origin/main` @ `f9d0084`
- Scope: short plan + misplaced review file — **no implementation**
- Reviewer: Cursor

## Verdict

Not a viable trunk. The plan is incomplete for R2 mechanical acceptance and for
R1–R8 binding decisions; the post-plan review path is outside
`.code-reviews/issue-6/**`, which breaks phase-pin rules; there is no
implementation.

## Findings

### 1. `.code-reviews/codex.md:1`

**Rule.** After an immutable issue-6 plan pin, the branch may advance only
through `.plans/issue-6/**`, `.signals/issue-6/**`, or `.code-reviews/issue-6/**`.

**Failure.** Commit `7ba010f` adds `.code-reviews/codex.md` after plan pin
`75ffc3a`. `validatePhasePin` returns `cross-issue-coordination-change`, so
later evidence cannot bind this tip to the published plan.

**Test.** Call `validatePhasePin` for issue 6 with pin `75ffc3a` and tip
`7ba010f` and require `{ ok: true }` only after the review lives under
`.code-reviews/issue-6/`.

---

### 2. `.plans/issue-6/plan.md:15`

**Rule.** `checkPlan` (`src/evidence.ts:60-70`) requires File Map / Proposed
Architecture, Tests / Validation, Alternatives, Risks, and Conclusion headings.

**Failure.** The plan’s headings do not match; Alternatives, Risks, and
Conclusion are absent. Gate 2 cannot accept this blob as `plan-published`
evidence.

**Test.** Evaluate the plan blob as `plan-published` and require no outstanding
section errors.

---

### 3. `.plans/issue-6/plan.md:34`

**Rule.** Issue N must be fetched from `config.origin` via argv-safe
`gh issue view … --repo <owner/repo>`.

**Failure.** The plan shows `gh issue view N --json title,body` without
`--repo`, so cwd can select the wrong repository’s issue for the digest.

**Test.** Resolve product A with cwd in repo B; assert runner argv contains
`--repo <A>`.

---

### 4. (branch tip) missing implementation

**Rule.** Implementation candidates must include production code for bootstrap /
onboard / digest / `coord N`.

**Failure.** Only a 60-line plan and a four-line review exist on origin.

**Test.** Diff vs `main` must include `src/` / `scripts/` / `test/` files.
