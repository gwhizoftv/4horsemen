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

Coordination checks this clone out on `issue-<n>/<agent>` and re-sets the
`skip-worktree` bit on `AGENTS.md` before your CLI starts. The branch already
exists and is already current: do not create it, do not switch to it, and do not
check out or pull the shared branch first. Every automated action names the
branch you are already on.

When an action lists a `## Bound input files` section, read those paths directly.
They are exact copies the coordinator took from the same mirror that verifies the
pins, so fetching a peer branch to read a plan, a review, or an implementation is
redundant work. The cited SHAs remain the authority; the files are where the
bytes are, and `git show <sha>:<path>` for that same content is refused once the
section is present. If the action says not every bound input could be exported,
the pinned read stays available for the ones that are missing.

During an automated issue, `git status` and `git diff` against this clone are
refused by `.coord/bin/git`, which coordination installs and puts on your PATH.
Coordination checked this clone out and already resolved what changed, and both
readings are in your action. The refusal applies to this clone only: git against
any other repository, and every command in owner-driven manual mode, is
untouched. Do not try to work around it — report it if it blocks real work.

Commit and push only when the current action's `submissionMode` is `git` (or the
action text requires a pushed commit SHA). Response-mode ballot actions must not
commit or push: write only the private response JSON and the completion marker
`response <actionId>`, then stop Git work for that action.

Do not clear `skip-worktree` on `AGENTS.md`, strip this protocol block, or
replace the file to “fix” git status. Coordination sets that bit so the
clone-local protocol section stays hidden. If `AGENTS.md` looks wrong, escalate;
do not change index flags.

After you write `complete`, do not stop. Before waiting for more input, re-read
your `action.md`. If `actionId` in the front matter has changed, execute the new
instructions immediately; do not wait for another coordinator message. This
re-read applies to both Git-mode and response-mode actions.

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

## Reuse and Scope

## Tests

## Alternatives Rejected

## Risks and Mitigations

## Conclusion
```

Accepted aliases for the file lists: Exact File Map / File Map / File Creation
Order / Proposed Architecture (a single legacy file-map heading still satisfies
both list sections). Accepted aliases for Reuse and Scope: Reuse / Scope and
Reuse. Also accepted: Test / Validation; Alternatives; Risks.

In Reuse and Scope, name the existing functions, types, helpers, tests, and
fixtures the implementation will reuse, and justify every new file. A path
cited only in that section does not expand what the implementation may change;
also list every path intended for change in a file-list section.

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

## Implementation discipline

Keep the work within the issue and make the smallest change that fully solves
it. Inspect and reuse existing functions, types, helpers, tests, and fixtures
before creating new ones. Justify every new file, abstraction, and dependency;
avoid unrelated cleanup and speculative flexibility. Add the fewest focused
tests needed, prefer extending an existing test file, and still run every
required check.

## Necessary files missing from the approved plan

During implementation or revision, do not quietly expand the file map or
rewrite the selected plan. If the current action offers a
`plan-amendment-request` scaffold, use it at that action's required signal path
to propose exact additional files with reasons. Commit only that coordination
artifact, leave product edits unstaged, push, and complete the Git action with
the request commit SHA. No product pin is required for a request.

The request is not permission to use those files. Every active agent must
explicitly approve their necessity for the existing issue; `revise` rejects
the request, not the implementation. Ballots use private response JSON, not
Git commits. Wait for a new implementation/revision action with the approved
map and `scopeHash` before submitting product work. Preserve the revision's
single `basedOn` product parent; scope approvals are separate evidence.

## Checks that actually run

Do not modify the product `githooks/` tree as the way to satisfy checks. Follow
the named commands in the action or plan.

Passing the clone’s commit/push hooks is not enough for final acceptance. The
coordinator may run a stricter check list on the approved commit before the PR.
In plans, name real commands; do not guess them from tracked hook files.
