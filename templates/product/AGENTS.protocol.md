## Plans and reviews

This file is the protocol. Follow it when writing coordinator artifacts.
The required response format for the current step also appears in that step's
`action.md` and may change each time — match the headings or JSON scaffold
listed there. The validator checks the published file, not this document.

A **plan** (`.plans/issue-<n>/plan.md`) must include every heading below,
each with a non-empty body:

```markdown
## Exact File List to be changed or deleted

## Exact file list to be created

## Tests

## Alternatives Rejected

## Risks and Mitigations

## Conclusion
```

A **plan review** (`.plans/issue-<n>/review.md`) must include:

```markdown
## Findings

## Conclusion
```

A **code review** (`.plans/issue-<n>/review.md`) must include:

```markdown
## Findings

- File path and line number
- the rule that must hold
- a concrete failure that follows from breaking the rule
- optionally, the smallest test or bucfix sketch, if a test cannot express it.
- The rule and the failure are the deliverable.
- delete the sketch and the finding must still be actionable.
- Prefer a test over a fix.

## Verdict
```

Aliases: Review Findings; Conclusion (for Verdict).

A **comparison** (`.code-reviews/issue-<n>/comparison.md`) must include a heading
line that is exactly one of:

```markdown
## Comparison
```

or

```markdown
## Findings
```

No subtitle on that same line (e.g. `# Comparison — issue 12` fails). Cite every
bound implementation pin SHA from the current `action.md`.

## Checks that actually run

Don’t modify the product githooks/ as the way to satisfy checks. Follow the named commands in the action or plan.

Passing the clone’s commit/push hooks is not enough for final acceptance. The coordinator may run a stricter check list on the approved commit before the PR. In plans, name real commands; do not guess them from tracked hook files.
