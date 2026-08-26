## Plans and reviews

This file is the automated-action protocol. Follow it only when the coordinator
has published an `action.md`. In owner-driven manual mode, the owner's chat
message is the task authority; work belongs on the agent's own
`<agent>/<name>` scratch branch unless the owner explicitly supplies an issue
branch, and agents must not fabricate `.plans/`, `.signals/`, `.code-reviews/`,
`action.md`, or `complete`. Installed hook, verification, identity, no-main,
and no-force rules remain active.
The required response format for the current action also appears in that action's
`action.md` and may change each time — match the headings or JSON scaffold
listed there. The coordinator accepts only the published artifact. If this file
and `action.md` disagree on format, `action.md` wins.

For `submissionMode: git`, write the instructed repository artifact, commit, and
push the prepared issue branch. For `submissionMode: response`, write only the
small JSON response at the instructed private response path; do not create a
ballot artifact, commit, or push. Both modes finish with the exact completion
marker described by `action.md`.

Coordination checks this clone out on `issue-<n>/<agent>` and re-sets the
`skip-worktree` bit on `AGENTS.md` before your CLI starts. The branch already
exists and is already current: do not create it, do not switch to it, and do not
check out or pull the shared branch first. Every automated action names the
branch to push to, and that is the branch you are already on.

Do not clear `skip-worktree` on `AGENTS.md`, strip this protocol block, or
replace the file to “fix” git status. Coordination sets that bit so the
clone-local protocol section stays hidden. If `AGENTS.md` looks wrong, escalate;
do not change index flags.

After you write `complete`, do not stop. Before waiting for more input, re-read
your `action.md`. If `actionId` in the front matter has changed, execute the new
instructions immediately; do not wait for another coordinator message.

If that re-read shows the same `actionId` — there is no new work yet — end your
reply with this exact line, on its own, with nothing after it:

```
COORD-IDLE: waiting for the next coordinator action file
```

Coordination reads your terminal to decide whether it is safe to type into it.
That line is how it can tell an idle window from one that is still rendering.
Print it only when you are genuinely finished and waiting; never print it while
work is still in progress.

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
