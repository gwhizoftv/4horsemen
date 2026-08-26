# Issue 121 plan review

## Findings

### High — Cursor's plan requires an edit this automated clone is forbidden to stage

**Plan claim:** The Cursor plan at
`d744ba08125eaed6d7ad138c79c563c465e3bc59` lists `AGENTS.md` as a product
file to change while also saying not to clear its `skip-worktree` bit.

**Rule:** An implementation plan must be executable under the repository
protocol; automated agents must not clear `skip-worktree`, replace the local
protocol file, or use index plumbing to work around it.

**Concrete failure:** Following the file map leaves the tracked `AGENTS.md`
change unstaged, while the only ways to stage it require exactly the forbidden
index-state manipulation. The implementation therefore cannot produce the
complete commit promised by the plan.

**Smallest correction:** Remove `AGENTS.md` from the implementation map and
put action-local guidance in the existing scaffold renderer. If standing
protocol prose is retained, change only its tracked template and let the normal
installer refresh clone-local overlays.

### High — Cursor's proposed Tests check does not verify a real command

**Plan claim:** The Cursor plan at
`d744ba08125eaed6d7ad138c79c563c465e3bc59` proposes that `checkPlan` accept a
Tests section when it contains any backticked text, presenting that as
mechanical enforcement that the plan names a real command.

**Rule:** A mechanical acceptance rule must test the property its diagnostic
claims; otherwise valid plans must not be rejected and invalid plans must not
be certified as compliant.

**Concrete failure:** A Tests body containing only a backticked test-file path
passes the proposed regular expression without naming an executable command,
while a body that plainly says to run pnpm check:fast without backticks fails.
The new refusal path adds implementation and fixture cost but does not enforce
test efficiency or even command validity.

**Smallest correction:** Keep command and test-budget advice in the plan
scaffold and existing review process; do not add this acceptance rule for issue
121.

### Medium — Cursor's architecture duplicates the policy it calls canonical

**Plan claim:** The Cursor plan at
`d744ba08125eaed6d7ad138c79c563c465e3bc59` calls a new discipline module the
single source of truth, but also requires independently copied wording in the
protocol, root instructions, static task strings, documentation, and a Cursor
shell heredoc.

**Rule:** This issue's implementation must itself prefer existing interfaces,
avoid parallel sources of truth, and add only the smallest surfaces needed to
put guidance in front of agents during planning and coding.

**Concrete failure:** The shell copy cannot import the proposed TypeScript
constant and is explicitly left to manual synchronization. One later wording
change can therefore make Cursor receive different rules from other agents;
the new module and its dedicated test do not prevent that drift. The eleven-file
map also expands into review, comparison, docs, setup, and acceptance behavior
beyond the requested plan and implementation reminders.

**Smallest correction:** Reuse the existing action-specific scaffold switch
and its existing unit-test file, as proposed by the narrower Codex plan.

### High — Claude's mandatory heading is mechanically present but semantically empty

**Plan claim:** The Claude plan at
`87fb50874e90cdf3f8ddac6f23da9d35430aa5a4` says a required Reuse and Scope
section makes reuse and scope a condition of acceptance rather than advice.

**Rule:** If a new acceptance contract is justified as mechanical enforcement,
the verifier must establish the promised reuse claim and justification, not
merely the existence of a heading.

**Concrete failure:** Under the proposed `markdownSection` check, a plan with a
Reuse and Scope body of just "None." is accepted. It can still introduce every
unnecessary file and duplicate helper that issue 121 targets, so the new
heading, template edits, section stripper, and fixture churn do not deliver the
claimed enforcement.

**Smallest correction:** Do not add a mandatory heading for a semantic property
the verifier cannot establish. Put concise reuse and scope criteria directly in
the plan and implementation action scaffolds, where reviewers can evaluate the
actual proposal.

### High — Claude's test map omits existing plan fixtures broken by its new contract

**Plan claim:** The Claude plan at
`87fb50874e90cdf3f8ddac6f23da9d35430aa5a4` updates one existing split-file-list
case, adds one missing-heading case, and updates the integration canary, while
claiming the fast suite grows by only one case.

**Rule:** When `checkPlan` gains a required section, every existing test fixture
expected to satisfy plan evidence must be updated or deliberately converted
into a rejection test; the named `pnpm check:fast` command must pass after the
listed work.

**Concrete failure:** The existing evidence cases that validate a legacy Exact
File Map plan and a monorepo file-map plan both omit the proposed Reuse and
Scope heading and expect `status: "satisfied"`. Following the plan's enumerated
test edits leaves those cases failing, so the implementation is not
mechanically complete.

**Smallest correction:** If the heading is retained, enumerate and update every
satisfying plan fixture. Prefer removing the heading requirement, which avoids
unrelated fixture growth.

### Medium — Claude's section stripper does not make file lists the sole authority

**Plan claim:** The Claude plan at
`87fb50874e90cdf3f8ddac6f23da9d35430aa5a4` says stripping only the new reuse
section makes the two file lists the sole source of approved implementation
paths.

**Rule:** A claimed approved-path boundary must exclude path citations from all
non-file-map sections, not only one newly introduced section.

**Concrete failure:** The existing extractor still scans backticked paths in
Tests, Alternatives Rejected, Risks, and Conclusion. A rejected alternative
that cites a repository path can still silently add that path to
`approvedPaths`, so the plan's stated ceiling remains false even after its new
helper is implemented.

**Smallest correction:** Do not couple issue 121's prompt guidance to a partial
extractor rewrite. Treat file-map-only extraction as a separate, fully scoped
change if the owner wants that invariant.

The Codex plan at `002095e039ed483b729701abaf569a6929bb15e1` confines the
change to `src/orderScaffold.ts` and `test/orderScaffold.test.ts`, reuses the
existing action construction path, covers planning, implementation, and
revision work, preserves configured checks, and adds no module, fixture, or
policy subsystem. I found no blocking execution failure in that plan.

## Conclusion

Select the Codex plan at `002095e039ed483b729701abaf569a6929bb15e1`.
It most directly practices the simplicity, scope control, reuse, and
test-efficiency discipline requested by issue 121. Do not select the Cursor
plan at `d744ba08125eaed6d7ad138c79c563c465e3bc59` because it contains a
forbidden-to-stage file, a non-semantic command check, and duplicated policy
surfaces. Do not select the Claude plan at
`87fb50874e90cdf3f8ddac6f23da9d35430aa5a4` because its new required heading
does not enforce its semantic claim, its test map leaves existing cases red,
and its extractor change does not establish the promised path boundary.
