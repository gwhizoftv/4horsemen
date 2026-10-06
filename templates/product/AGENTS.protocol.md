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
bytes are; do not use `git show <sha>:<path>` for that same content once the
section is present (enforcement coverage is described below). If the action says not every bound input could be exported,
the pinned read stays available for the ones that are missing.

During an automated issue, do not run `git status` or `git diff` against this
clone, or pinned `git show` for exported Bound input files. The action already
supplies this information. The only exception is the harmless containment probe
described below and requested initially by the join action. Native shell-tool guards enforce recognized literal
commands where the harness has been verified; `.coord/bin/git` is the fallback
where it actually resolves. Installation alone does not prove either layer.
Other repositories and owner-driven manual mode remain unrestricted.

The guard is bounded static recognition, not a sandbox or shell interpreter:
scripts, dynamic commands, unsupported shell syntax and subsequent input to an
already-open terminal are outside its guarantee. Do not use those gaps to work
around this protocol. Report a refusal that blocks real work.

Measure resolution and an actual tool refusal once per session and again after
a harness restart or hook/policy configuration change. The join action supplies
the initial instructions; after a restart/configuration change, request only
`git status --porcelain` through the actual harness shell tool, without changing
PATH or wrapping it in another shell. It is expected to be refused; do not work
around the refusal. Then, through the same tool, run:

```sh
coord containment-probe --issue <current-issue-number> --resolved-git "$(command -v git)" --tool-result <hook-denied|shim-refused|executed|unknown> --vendor-version <actual-cli-version>
```

Use `hook-denied` only for a tool request rejected before execution,
`shim-refused` only for the coordinator shim's exit-2 refusal, `executed` if Git
ran, or `unknown` if uncertain. Do not invent a CLI version or run another probe
merely because coverage remains unknown; report the missing capability/identity
and continue. The observation is agent-reported, not tamper-proof attestation.
Do not repeat for every action. A hook
emitting deny is not proof the harness enforced it. `coord status` reports
separate hook/shim evidence; inactive or unverified coverage is a warning, not a
claim of containment. Doctor checks installation only, not the harness PATH.

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
to propose exact additional files with a nonblank `explanation` of the omission
and a `reason` for each file. Commit only that coordination artifact, leave
product edits unstaged, push, and complete the Git action with
the request commit SHA. No product pin is required for a request.

The request is not permission to use those files. Every active agent must
explicitly approve their necessity for the existing issue; `revise` rejects
the request, not the implementation. Ballots use private response JSON, not
Git commits. Wait for a new implementation/revision action with the approved
map and `scopeHash` before submitting product work. Preserve the revision's
single `basedOn` product parent; scope approvals are separate evidence.

## Checks that actually run

In an explicitly declared coordinator-mode issue, coord owns candidate suites
at the submitted implementation/revision pin and the final checks. Bound hooks
retain integrity rules and the declared cheap checks. Cite coordinator results
and logs rather than rerunning mandatory candidate suites; keep focused tests
while developing. Missing/broken issue bindings and manual branches retain the
local verification policy. Never claim a missing result as a pass.

Publishing only coordination evidence (plans, reviews, signals, amendments,
escalations) requires artifact/format/evidence validation, not a manual product
suite. For product commits the hook owns its mandatory check; do not manually
duplicate it immediately before committing. Use focused tests while developing.
Reviewers read existing verification results for unchanged implementations and
run additional tests only to investigate a finding; missing results are not a
pass. Response-mode ballots still do not commit or push.

Hooks classify the staged index and outgoing push ranges. Explicitly allowlisted
documentation uses the declared documentation profile; unknown or mixed changes
retain product checks. The coordinator owns final checks at the approved pin,
classified from the frozen issue baseline, never just the last cleanup commit.
Report only checks you actually ran; do not claim coordinator-owned checks.

Do not modify the product `githooks/` tree as the way to satisfy checks. Follow
the named commands in the action or plan.

Passing the clone’s commit/push hooks is not enough for final acceptance. The
coordinator may run a stricter check list on the approved commit before the PR.
In plans, name real commands; do not guess them from tracked hook files.
