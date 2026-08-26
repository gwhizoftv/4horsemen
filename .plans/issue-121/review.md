# Issue 121 peer plan review

Bound inputs:

- Cursor plan: `d744ba08125eaed6d7ad138c79c563c465e3bc59` at `.plans/issue-121/plan.md`
- Codex plan: `002095e039ed483b729701abaf569a6929bb15e1` at `.plans/issue-121/plan.md`
- Claude plan: `87fb50874e90cdf3f8ddac6f23da9d35430aa5a4` at `.plans/issue-121/plan.md`

All three plans correctly target agent-facing discipline during planning and
implementation inside the coordination driver, not analytics, new workflow steps,
or product-repo hooks. They differ on how much to enforce mechanically versus
through scaffold prose, and on how many files to touch.

## Findings

### 1. Claude — `extractApprovedPaths` must ignore reuse citations

**Plan claim:** Claude plan §Reuse and Scope and **Exact File List** state that
`extractApprovedPaths` must scan `stripSections(raw, REUSE_SECTION_HEADINGS)`
instead of the full plan, because backticked paths in a reuse section would
otherwise widen the implementation ceiling.

**Rule:** Any new plan prose that invites agents to cite existing modules in
backticks must not expand `approvedPaths` beyond the declared file lists; that
ceiling is the sole authority over what an implementation may change.

**Concrete failure:** Cursor and Codex both add discipline text telling agents
to name reused functions and modules, but neither changes `extractApprovedPaths`
in `src/evidence.ts`. The first plan that backticks a reused path under
**Alternatives Rejected**, **Conclusion**, or new scaffold prose silently grants
permission to rewrite that path; verification then accepts out-of-map edits with
no outstanding item.

**Smallest correction:** Land Claude's `stripSections` change (or equivalent)
in whichever plan is selected, even if the selected plan does not adopt Claude's
full required **Reuse and Scope** heading.

### 2. Claude — required **Reuse and Scope** section is the strongest mechanical guard

**Plan claim:** Claude **Conclusion** and **Exact File List** add
`## Reuse and Scope` to `checkPlan`, `orderScaffold`, and `AGENTS.protocol.md`,
with one new rejection case in `test/evidence.test.ts`.

**Rule:** Issue #121 asks to change agent behavior, not merely repeat advice;
a plan that omits reuse justification should fail the same way a plan missing
**Tests** fails today.

**Concrete failure:** Codex's prose-only scaffold change and Cursor's backticked-
command check still accept plans that propose three new modules and five new test
files with no named reuse target and no peer-review hook beyond optional findings
text. Ballots then choose among bloated plans that passed verification.

**Smallest correction:** Adopt Claude's required section and acceptance test, or
add an equivalent mechanical rule (not prose-only) before implementation.

### 3. Codex — smallest diff, but under-enforces the issue

**Plan claim:** Codex **Exact File List** limits changes to `src/orderScaffold.ts`
and `test/orderScaffold.test.ts`; **Exact file list to be created** is "None."

**Rule:** The fix must reach every automated step where agents choose scope and
tests — at minimum plan, implement, and revise scaffolds, and the standing
protocol agents read outside a single action.

**Concrete failure:** With Codex alone, discipline appears only in three
scaffold branches; `templates/product/AGENTS.protocol.md` is unchanged, review
and compare actions gain no scope/reuse criterion, and nothing rejects a plan that
ignores the new checklist. That matches the failure mode Claude documents for
prose-only guidance.

**Smallest correction:** Keep Codex's two-file footprint but add the protocol
template edit and one review-scaffold sentence from Claude; add at least one
acceptance rule in `evidence.ts`.

### 4. Cursor — breadth conflicts with the issue's simplicity goal

**Plan claim:** Cursor **Exact file list to be created** introduces
`src/agentDiscipline.ts` and `test/agentDiscipline.test.ts`, and the changed-
file list touches `AGENTS.md`, `scripts/setup_cursor.sh`, `docs/coord-driver.md`,
and four test files beyond scaffold/evidence.

**Rule:** Issue #121 asks agents to minimize scope, reuse existing surfaces, and
avoid growing the test suite; the selected plan should model that behavior.

**Concrete failure:** Implementing Cursor's plan as written adds a new source
module, a new test file, Cursor-only setup changes, and duplicated prose across
six surfaces while Codex achieves the same scaffold injection in two files and
Claude covers acceptance in four source files with zero new test files. A ballot
choosing Cursor teaches the opposite of the stated goal.

**Smallest correction:** Drop `test/agentDiscipline.test.ts` (extend
`test/orderScaffold.test.ts` and `test/agentLanguage.test.ts` instead), drop
`docs/coord-driver.md` unless the owner wants operator docs, and fold constants
into `orderScaffold.ts` unless a second consumer appears.

### 5. Cursor — `AGENTS.md` listed despite skip-worktree constraint

**Plan claim:** Cursor **Exact File List** includes `AGENTS.md` with a note not
to clear skip-worktree; Claude **Risks** explicitly omits it from the file map.

**Rule:** A plan file map must list only paths an implementer can actually commit
from an agent clone; coordination forbids clearing skip-worktree to stage
`AGENTS.md`.

**Concrete failure:** An implementer on `issue-121/<agent>` follows Cursor's map,
attempts to commit `AGENTS.md`, and either fails to stage the tracked half or
violates protocol by clearing skip-worktree. The discipline text agents read in
clones comes from `templates/product/AGENTS.protocol.md`, not the worktree copy.

**Smallest correction:** Remove `AGENTS.md` from the file map; rely on
`templates/product/AGENTS.protocol.md` and per-action scaffolds, as Claude does.

### 6. Cursor — Tests-section backtick rule is necessary but insufficient

**Plan claim:** Cursor **Design** extends `checkPlan` so the **Tests** section
must contain at least one backticked command argv.

**Rule:** Plans must name real verify commands (already stated in AGENTS.md); the
check should not duplicate weaker wording that omits reuse and file-map discipline.

**Concrete failure:** A plan whose **Tests** section contains `` `pnpm check:fast` ``
but whose file map adds `test/new-feature.test.ts`, `test/new-feature-edge.test.ts`,
and `src/discipline/` still satisfies Cursor's new rule and passes verification.
Test-suite growth and scope expansion remain unchecked.

**Smallest correction:** Keep the backtick check as a supplement to Claude's
**Reuse and Scope** section, not a substitute.

### 7. Codex — negative scaffold assertion is valuable and missing elsewhere

**Plan claim:** Codex **Tests** requires asserting that an unrelated scaffold does
not receive the coding checklist.

**Rule:** Discipline prose must not leak into every action type; unbounded prompt
growth increases token cost on ballots and reviews that do not need coding guidance.

**Concrete failure:** Cursor and Claude do not require a negative assertion; a
regression that appends `IMPLEMENT_DISCIPLINE` to join or ballot scaffolds would
not fail CI under their test plans.

**Smallest correction:** Add Codex's negative `orderScaffold.test.ts` case to the
selected plan regardless of which plan wins the ballot.

## Conclusion

**Verdict: revise Claude's plan, then treat it as the initial implementation
plan**, incorporating bounded pieces from Codex and Cursor.

Claude best matches issue #121 because it pairs mechanical plan acceptance
(**Reuse and Scope**) with a real bugfix in path extraction, keeps every change
in existing files, adds only one net test case, and documents why prose-only
approaches fail. Codex is the right minimal scaffold strategy but must not ship
alone. Cursor identifies useful surfaces (review/compare discipline, Tests
backtick enforcement, Cursor `working-style.mdc`) but is too large and lists
`AGENTS.md` incorrectly.

Before implementation, merge these corrections into the Claude plan:

1. Land `stripSections` / reuse-section exclusion in `extractApprovedPaths`
   (Claude — non-negotiable).
2. Keep the required **Reuse and Scope** heading and its rejection test (Claude).
3. Add Codex's negative scaffold assertion so discipline text stays off unrelated
   actions (Codex).
4. Optionally add Cursor's **Tests** backtick check and a single sentence each in
   review and compare scaffolds (Cursor), without new modules or test files.
5. Remove `AGENTS.md` from any file map; edit only `templates/product/AGENTS.protocol.md`.
6. Update `scripts/setup_cursor.sh` only if the ballot owner wants Cursor-specific
   rules beyond the protocol overlay — not required for coordinated agents.

Do not implement Codex alone (under-enforcement) or Cursor as written (scope and
file-map violations relative to the issue's own goals).
