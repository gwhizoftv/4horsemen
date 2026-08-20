## Plans and reviews

This file is the automated-action protocol. Follow it only when the coordinator
has published an `action.md`. In owner-driven manual mode, the owner's chat
message is the task authority; work belongs on the agent's own
`<agent>/<name>` scratch branch unless the owner explicitly supplies an issue
branch, and agents must not fabricate `.plans/`, `.signals/`, `.code-reviews/`,
`action.md`, or `complete`. Installed hook, verification, identity, no-main,
and no-force rules remain active.
The required response format for the current step also appears in that step's
`action.md` and may change each time — match the headings or JSON scaffold
listed there. The coordinator accepts only the published artifact. If this file
and `action.md` disagree on format, `action.md` wins.

Do not clear `skip-worktree` on `AGENTS.md`, strip this protocol block, or
replace the file to “fix” git status. Coordination sets that bit so the
clone-local protocol section stays hidden. If `AGENTS.md` looks wrong, escalate;
do not change index flags.

After you write `complete` for an automated action, do not stop. Re-read your
coordinator `action.md`.
If `actionId` in the front matter has changed, execute that new action even
without a typed nudge. Delivery still comes from the coordinator; this watch
is how you recover when a nudge did not land.

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

Accepted aliases for the file lists: Exact File Map / File Map / File Creation
Order / Proposed Architecture (a single legacy file-map heading still satisfies
both list sections). Also accepted: Test / Validation; Alternatives; Risks.

A **plan review** (`.plans/issue-<n>/review.md`) must include:

```markdown
## Findings

## Conclusion
```

Plan-review findings must state, in order: the plan claim or section; the rule
that must hold; a concrete failure if the plan is followed as written; then
optionally the smallest correction. The rule and the failure are the
deliverable: delete any sketch and the finding must still be actionable.

A **code review** finding (when reviewing implementation or revision) must
state, in order: file path and line number; the rule that must hold; a concrete
failure that follows from breaking it; then optionally the smallest
illustrative test — or a fix sketch if a test cannot express it. The rule and
the failure are the deliverable: delete the sketch and the finding must still
be actionable. Prefer a test over a fix.

Code-review style write-ups use:

```markdown
## Findings

## Verdict
```

(`Conclusion` is accepted as an alias for Verdict.)

A **comparison** (`.code-reviews/issue-<n>/comparison.md`) must include a
heading line that is exactly one of:

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

Do not modify the product `githooks/` tree as the way to satisfy checks. Follow
the named commands in the action or plan.

Passing the clone’s commit/push hooks is not enough for final acceptance. The
coordinator may run a stricter check list on the approved commit before the PR.
In plans, name real commands; do not guess them from tracked hook files.
