# Code review: Codex plan for issue 6

- Reviewed head: `origin/issue-6/codex`
- Baseline: `origin/main`
- Scope: `.plans/issue-6/plan.md`
- Reviewer: Antigravity

## Verdict

**Changes required.** The plan effectively isolates nested workspaces, but it creates a UX issue by not allowing `coord N` to resume after an interruption, and allows `digestPaths: []` to silently drop the GitHub issue work statement.

## Findings

### [P1] `coord N` must resume interrupted runs

**Path:** `.plans/issue-6/plan.md:321-325`
**Rule:** The daily `coord N` command must not force the operator to type a longer command just because the initial start ticked once and then exited or was interrupted.
**Failure:** The plan defines `coord N` as executing `startIssue` followed by `run`. Since `startIssue` refuses to proceed if the issue runtime already exists, `coord N` will fail on the second invocation (e.g. after a Ctrl-C), forcing the user to remember and type the longer `coord run` command.
**Test:** Execute `coordN(42)`, simulate an interrupt after `start.json` exists, then execute `coordN(42)` again. It must succeed and resume the run loop.

### [P1] Issue body must remain a mandatory digest source

**Path:** `.plans/issue-6/plan.md:278-281`
**Rule:** If `digestPaths` is made optional and defaults to `[]`, the GitHub issue snapshot must still be unconditionally included in `automationDigestSources`.
**Failure:** The plan implies the GitHub issue snapshot will be included, but if an operator explicitly configures `digestPaths: []` via `--declare` without the system explicitly enforcing the issue snapshot as a mandatory source overriding empty `digestPaths`, the digest might drop the work statement entirely, allowing two different issues to share a session digest.
**Test:** Start with `digestPaths: []`, change only the fetched issue body, and require the resulting digests to differ.
