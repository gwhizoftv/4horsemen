# Issue 121 implementation comparison

Bound implementation pins (protocolVersion 1):

- Cursor: `a56990ab9da86c59d8f96b6610eed00ad39ad841` at `.signals/issue-121/implementation-ready-cursor.json`
- Claude: `225c476b732e40ca8c0681afdc2d091fb8b1e956` at `.signals/issue-121/implementation-ready-claude.json`
- Codex: `a82456a50a7e586752c7e36cc57c55ae44c1eea9` at `.signals/issue-121/implementation-ready-codex.json`

All three pins change the same eight product paths (`src/evidence.ts`, `src/orderScaffold.ts`,
`src/steps.ts`, `templates/product/AGENTS.protocol.md`, and four existing test files). None
creates new source or test modules. Agent-specific plan, review, and participation signal
paths differ and are out of scope for product comparison.

## Comparison

### Shared behavior

Every pin lands the same core contract for issue #121:

- `checkPlan` requires a **Reuse and Scope** section (aliases **Reuse** / **Scope and Reuse**).
- `extractApprovedPaths` strips reuse sections before scanning backticks so reuse citations do
  not widen the implementation ceiling.
- `BUILD_DISCIPLINE_NOTE` is appended to R2.plan, R4.implement, and R6.revise task strings in
  `src/steps.ts`.
- Plan, review, and compare scaffolds in `src/orderScaffold.ts` gain reuse/scope/test-efficiency
  guidance.
- `templates/product/AGENTS.protocol.md` adds the **Reuse and Scope** plan heading and reuse
  prose.
- `test/evidence.test.ts` adds a rejection case for a missing reuse section and a case proving
  a reuse-only path citation stays out of `approvedPaths`.

### Diff size and test growth

Product-only diff volume ( `src/`, `templates/`, `test/` at each pin):

| Pin | Approx. changed lines | New test files | Notable test additions |
|-----|----------------------:|----------------|------------------------|
| Cursor `a56990a` | 108 | 0 | reuse rejection; split-file-list path isolation |
| Codex `a82456a5` | 142 | 0 | above plus alias heading fixture; scaffold string asserts; integration task asserts |
| Claude `225c476b` | 190 | 0 | above plus `BUILD_DISCIPLINE_NOTE` step-targeting test; richer evidence comments |

Cursor is the smallest product diff. Claude adds the most prose, exports, and tests. Codex sits
between them on size while adding depth-aware section stripping and end-to-end integration
assertions for discipline text in coordinator orders.

### Protocol template and install coverage

- **Cursor** and **Codex** keep inline reuse guidance under the plan heading block; **Codex**
  also adds a separate `## Implementation discipline` section mirrored in
  `test/install.test.ts`.
- **Claude** moves build discipline into a dedicated `## Build discipline` section in
  `templates/product/AGENTS.protocol.md` and documents why `BUILD_DISCIPLINE_NOTE` is limited to
  planning/implementing/revising steps. Claude's opt-in `--write-product` install test no longer
  asserts that appended `AGENTS.md` contains `## Reuse and Scope` (the full clone install test
  still does).

### `stripSections` correctness (central mechanical difference)

The three pins disagree on how reuse sections are removed before path extraction. Nested
subheadings under **Reuse and Scope** and repeated reuse alias sections are the stress cases.

### Findings

#### Cursor — `src/evidence.ts:48-54` — regex strips only the first reuse section

**Rule:** Every reuse alias section (**Reuse and Scope**, **Reuse**, **Scope and Reuse**) must be
removed before `extractApprovedPaths` scans backticks; otherwise a reuse citation buys rewrite
permission.

**Concrete failure:** `stripSections` calls `String.replace` once on a multiline regex. A plan
with `## Reuse and Scope` citing `` `src/leak1.ts` `` and a later `## Reuse` citing
`` `src/leak2.ts` `` leaves `` `src/leak2.ts` `` in the scan; verification accepts edits to
`src/leak2.ts` even though it appears only under reuse prose.

**Test:** Plan with two reuse alias sections each backticking a distinct `src/*.ts` path; expect
`approvedPaths` to exclude both.

#### Cursor — `src/evidence.ts:48-54` — nested subheadings leak reuse citations

**Rule:** Content under a reuse section heading, including nested ATX subheadings, must not
contribute paths to `approvedPaths`.

**Concrete failure:** A plan whose **Reuse and Scope** body contains `### Submodule detail` and
`` `src/leaked.ts` `` before the next sibling section keeps `` `src/leaked.ts` `` in the scan
because the regex stops at the first `#` line (`### …`), treating it as the section boundary.

**Test:** Reuse section with a `###` subheading and a backticked path beneath it; expect that
path to stay out of `approvedPaths`.

#### Claude — `src/evidence.ts:129-142` — nested subheadings leak reuse citations

**Rule:** Same as above: nested headings inside a reuse section remain part of the section body.

**Concrete failure:** The line filter sets `skipping = headings.includes(matched[1])` on every
ATX line. Encountering `### Submodule detail` clears skipping because that title is not in
`REUSE_SECTION_HEADINGS`, so `` `src/leaked.ts` `` on following lines is extracted into
`approvedPaths`.

**Test:** Same nested-subheading fixture as the Cursor case; expect `approvedPaths` to exclude
the nested citation.

#### Claude — `test/install.test.ts:205-214` — opt-in install no longer guards reuse heading

**Rule:** Product install with `--write-product` must still append the full coordination protocol,
including the **Reuse and Scope** plan heading agents see during planning.

**Concrete failure:** The opt-in append test at Claude's pin asserts only
`## Exact File List to be changed or deleted` and `action.md`. A regression that drops
`## Reuse and Scope` from the appended protocol block would pass this test while the full-clone
install test still passes, leaving product repos without the new required heading until an agent
plans.

**Test:** Restore `expect(agents).toContain("## Reuse and Scope")` (and optionally
`## Build discipline`) in the opt-in append case.

#### Codex — `src/evidence.ts:120-138` — depth-aware strip handles nested and repeated sections

**Rule:** Reuse sections must be removed completely, including nested subheadings and multiple
alias sections, before path extraction.

**Concrete failure:** None observed on the nested-subheading or double-reuse fixtures; Codex's
depth-tracked loop skips until an ATX heading at the same or higher level and strips each alias
section independently.

**Test:** Existing evidence tests plus the nested/double-reuse fixtures above; Codex passes both.

### Weighing implementations against issue #121 goals

| Criterion | Cursor `a56990a` | Codex `a82456a5` | Claude `225c476b` |
|-----------|------------------|------------------|-------------------|
| Smallest product diff | Best (+108 lines) | Middle (+142) | Largest (+190) |
| Correct reuse path ceiling | Weakest (`stripSections` bugs) | Strongest (depth-aware) | Middle (nested leak) |
| Build discipline in standing protocol | Inline paragraph only | `## Implementation discipline` | `## Build discipline` + step-scoped note docs |
| Action-time discipline (R2/R4/R6) | Short note | Medium note + integration asserts | Longest note + step-target unit test |
| New files / modules | None | None | None |

**Cursor `a56990a`** delivers the ballot-selected Claude plan shape with minimal diff but ships
the weakest `stripSections` implementation, undermining the main mechanical guarantee of issue
#121.

**Claude `225c476b`** is the most documented and adds valuable tests (reuse isolation comment,
`BUILD_DISCIPLINE_NOTE` step scoping), but shares the nested-heading leak and loosens an install
regression guard.

**Codex `a82456a5`** best satisfies the reuse-ceiling rule with no new files, adds focused
scaffold and integration coverage, and lands a dedicated implementation-discipline protocol
section without the largest prose expansion.

For consensus revision, merge **Codex's `stripSections`** into whichever base is chosen, retain
**Claude's step-scoping test** for `BUILD_DISCIPLINE_NOTE`, and restore **opt-in install
assertions** for reuse (and discipline) headings.
