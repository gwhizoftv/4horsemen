# Issue 121 implementation comparison

## Comparison

The three bound product pins implement the selected eight-file plan without
creating source or test files:

| Agent | Bound implementation pin | Product delta | Assessment |
| --- | --- | ---: | --- |
| cursor | `a56990ab9da86c59d8f96b6610eed00ad39ad841` | 85 additions, 7 deletions | Smallest diff, but its section-removal expression fails at end of input and removes only the first matching section. |
| claude | `225c476b732e40ca8c0681afdc2d091fb8b1e956` | 165 additions, 9 deletions | Clear guidance and direct task-placement coverage, but accepted lowercase heading aliases bypass its path exclusion. |
| codex | `a82456a50a7e586752c7e36cc57c55ae44c1eea9` | 118 additions, 8 deletions | Correct case-insensitive, repeated-section, and end-of-input handling; focused additions to existing tests; full checks pass. |

All three add the Reuse and Scope plan contract, repeat build discipline on
planning, implementation, and revision actions, add review/comparison criteria,
update the installed protocol template, and extend existing test files. Their
important difference is whether a reuse citation is reliably excluded from
`approvedPaths` under every accepted document shape.

### High — Cursor leaves a final or repeated reuse section in the approved-path scan

**File and line:** `src/evidence.ts:53` at Cursor pin
`a56990ab9da86c59d8f96b6610eed00ad39ad841`.

**Rule:** Every accepted Reuse and Scope alias must be removed through the next
heading or end of input, and every occurrence must be removed, before
backticked paths are extracted.

**Concrete failure:** JavaScript does not define `\z` as an end-of-input anchor,
and `raw.replace(pattern, "")` has no global flag. A plan ending with
`## Reuse and Scope` followed by a backticked `src/reused.ts` leaves the whole
section intact; a plan with two reuse sections removes only the first. In both
cases `src/reused.ts` enters `approvedPaths`, so an implementation can rewrite a
file that the plan described as read-only reuse.

**Smallest illustrative test:** Pass a plan whose final section is Reuse and
Scope, and another with both Reuse and Scope and Reuse aliases, to
`extractApprovedPaths`; expect neither cited helper path in the result.

### Medium — Cursor requires reviewers to fabricate a scope finding for a clean plan

**File and line:** `src/orderScaffold.ts:126` at Cursor pin
`a56990ab9da86c59d8f96b6610eed00ad39ad841`.

**Rule:** A plan-review finding must identify a concrete failure; scope and reuse
must be evaluated, but a reviewer must not be required to report a defect when
the plan has none.

**Concrete failure:** The instruction says to include at least one scope/reuse
finding unconditionally. When a plan is already minimal and reuses existing
code, the reviewer must either invent a failure to obey that sentence or omit a
required finding to obey the repository's finding contract. That biases ballots
against otherwise sound plans and makes findings less trustworthy.

**Smallest correction:** Use the conditional criterion in the Claude or Codex
scaffold: evaluate scope and reuse, and report them only when they cause a
concrete failure.

### High — Claude accepts a heading spelling that its extractor does not remove

**File and line:** `src/evidence.ts:136` at Claude pin
`225c476b732e40ca8c0681afdc2d091fb8b1e956`.

**Rule:** Required-heading recognition and reuse-section removal must apply the
same case-insensitive alias semantics; otherwise a plan accepted under an alias
can widen its own approved path set.

**Concrete failure:** `markdownSection` accepts `## reuse and scope` because its
regular expression uses the case-insensitive flag, but `headings.includes` is
case-sensitive. The lowercase section is therefore accepted as satisfying the
new plan contract while its backticked helper paths remain in the text scanned
by `extractApprovedPaths`, granting permission to edit those helpers.

**Smallest illustrative test:** Use a lowercase `## reuse and scope` heading
with a backticked helper path; expect plan evidence to be satisfied and the
helper absent from `approvedPaths`.

### Selection

Select Codex pin `a82456a50a7e586752c7e36cc57c55ae44c1eea9`.
Its line-based remover normalizes accepted headings to lowercase, processes the
whole document, continues through end of input, and keeps nested content inside
the removed section until a same-or-higher heading. It also models issue 121's
test-efficiency goal: one new evidence case plus assertions in existing cases
and existing test files, rather than new suites or fixtures. The implementation
passed `pnpm check:fast`, `pnpm check`, and the pre-push end-to-end check.

Cursor pin `a56990ab9da86c59d8f96b6610eed00ad39ad841` is shorter but breaks the
approved-path invariant in ordinary Markdown layouts. Claude pin
`225c476b732e40ca8c0681afdc2d091fb8b1e956` has the most explanatory prose and
the strongest direct placement assertion, but its case mismatch produces the
same security-shaped scope failure. Neither advantage outweighs incorrect path
authorization.
