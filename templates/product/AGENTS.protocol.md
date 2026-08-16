## Plans and reviews

This file is the protocol. Follow it when writing coordinator artifacts.
The required response format for the current step also appears in that step's
`action.md` and may change each time — match the headings or JSON scaffold
listed there. The validator checks the published file, not this document.

A **plan** (`.plans/issue-<n>/plan.md`) must include every heading below,
each with a non-empty body:

```markdown
## Exact File Map

## Tests

## Alternatives Rejected

## Risks and Mitigations

## Conclusion
```

Aliases the validator also accepts: File Map / File Creation Order /
Proposed Architecture; Test / Validation; Alternatives; Risks.

A **review** (`.plans/issue-<n>/review.md`) must include:

```markdown
## Findings

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

Do not plan against a tracked `githooks/` tree. Git in an agent clone
leaves `core.hooksPath` unset. `.git/hooks/<name>` is a shim that execs
`$(git config --local coord.installRoot)/githooks/<name>`. Those bodies
run `verify.precommit` / `verify.prepush` from the workspace config
(`git config --local coord.workspaceConfig`).

An empty list for a phase means that phase runs no commands and exits 0,
even if the hook printed that checks were required. Coordinator `checks`
run later in a throwaway worktree at the approved commit and gate
publication. They can be a stricter suite than the commit hook (for
example full `pnpm check` including a build, while `verify.precommit` is
`pnpm check:fast`). Name the live argv in Tests; do not infer them from
tracked hook files.
