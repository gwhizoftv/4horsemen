# Plan review — issue 121

Bound plans reviewed:

- cursor `d744ba08125eaed6d7ad138c79c563c465e3bc59` at `.plans/issue-121/plan.md`
- codex `002095e039ed483b729701abaf569a6929bb15e1` at `.plans/issue-121/plan.md`
- claude `87fb50874e90cdf3f8ddac6f23da9d35430aa5a4` at `.plans/issue-121/plan.md`

## Findings

### 1. cursor — the AGENTS.md edit cannot be executed in the prepared clone

**Claim.** File list: "`AGENTS.md` — mirror the same **Implementation
discipline** block in the tracked portion (lines before the coordination
overlay); do not strip or clear `skip-worktree`."

**Rule.** Every path in a plan's file list must be a path the implementing agent
can actually change and commit from the clone the coordinator prepares. The
protocol also forbids clearing the skip-worktree bit on AGENTS.md.

**Failure.** Coordination sets that bit before the agent starts
(`git ls-files -v AGENTS.md` reports `S` in this clone). With the bit set,
staging the file is refused outright, not silently deferred:

```
$ git add A.md
The following paths and/or pathspecs matched paths that exist
outside of your sparse-checkout definition, so will not be
updated in the index:
A.md
$ echo $?
1
```

The implementer edits AGENTS.md, sees an exit-1 `git add`, and has exactly two
ways forward: commit without the change — leaving a file list entry whose work
never landed and a mirror that silently diverges from the template — or clear
skip-worktree, which the protocol forbids. Both outcomes are failures, and the
plan's own risk row ("Edit tracked template + `templates/product/AGENTS.protocol.md`
in repo; coordination reinstall refreshes overlays") describes the correct
approach while the file list contradicts it.

**Smallest correction.** Drop `AGENTS.md` from the file list. Editing
`templates/product/AGENTS.protocol.md` alone is sufficient: the overlay is
rendered from the template and refreshed into every clone on install and
reinstall.

### 2. cursor — the new test file cannot fail unless an existing test already fails

**Claim.** Created file `test/agentDiscipline.test.ts` — "assert exported
fragments are non-empty and contain no banned internal vocabulary
(`test/agentLanguage.test.ts` pattern)".

**Rule.** In a plan whose stated subject is unchecked test-suite growth, a new
test file must cover a behavior no existing test covers. A test that cannot fail
independently is pure run-time cost.

**Failure.** `test/agentLanguage.test.ts` already renders an action for every
workflow step and scans the rendered body
(`test/agentLanguage.test.ts:218`, `:237`, `:246`), and separately scans every
file in `AGENT_FACING_PROSE_FILES` — which includes the protocol template
(`:357`). The discipline constants reach an agent only through those two
surfaces, so the proposed language assertions fail exactly when the existing
ones do, never sooner. The "non-empty constant" assertion is weaker still: a
`const` initialised to a string literal cannot be empty at run time without the
source saying so, which typecheck and review already show. The plan therefore
adds a file and its startup cost to every `pnpm check:fast` run while producing
no signal — the precise behavior issue 121 asks to stop, inside the plan meant
to stop it.

**Smallest correction.** Remove `test/agentDiscipline.test.ts` from the created
list; add the one substring assertion the wiring actually needs to
`test/orderScaffold.test.ts`, which the plan already touches.

### 3. cursor — the plan defers a design decision to implementation time and institutionalises an unchecked duplicate

**Claim.** `WORKING_STYLE_RULES` — "reuse `agentDiscipline.ts` via a small
build-time copy or duplicate the bullets in the shell heredoc from the same
wording as `WORKING_STYLE_RULES`; prefer importing in a `pnpm` script only if it
stays simpler — **default: duplicate the five bullets in the heredoc verbatim
from `WORKING_STYLE_RULES` in TypeScript comments at top of file for manual
sync**".

**Rule.** A plan is the artifact an implementer executes: it must resolve the
choice, not present it. And when the same text must exist in two artifacts, the
plan must name one authority plus a check that binds the copies, or accept
documented drift.

**Failure.** As written, the implementer must first decide between a build-time
copy and a verbatim duplicate, and the decision is unreviewable because the
selection happens after the plan was accepted. Taking the plan's own default,
`scripts/setup_cursor.sh` grows a heredoc copy of five bullets whose only link to
`src/agentDiscipline.ts` is a comment asking a human to sync it. No test reads
`.cursor/rules/working-style.mdc` today (no match for `working-style` anywhere
under `test/`), and the plan adds none, so the first wording change to
`WORKING_STYLE_RULES` leaves the Cursor rule file stating the old rules with
nothing reporting it. The plan's own risk table lists this drift and offers
"manual sync" as the mitigation, which is a restatement of the risk.

**Smallest correction.** Leave `scripts/setup_cursor.sh` out of this issue. Every
agent already reads the rendered action and the protocol overlay during an
automated issue, which is the surface the issue asks about.

### 4. cursor — the new Tests check is trivially satisfiable, and its stated migration mitigation has no mechanism

**Claim.** `src/evidence.ts` — "tighten `checkPlan`: require the **Tests**
section to name at least one backticked command argv", sketched as
``if (!/`[^`\n]+`/.test(extractSection(raw, "Tests")))``. Risk row: "Stricter
Tests check rejects legacy plans on re-verify → Check applies only to new
submissions; fixtures updated in same PR".

**Rule.** An acceptance rule must reject the thing it names and accept
everything else; and a mitigation must correspond to a mechanism that exists in
the code.

**Failure — the rule.** The sketched regex matches any backticked token, so a
Tests section reading "Run the tests for ``src/product.ts``." passes while naming
no command at all, and a section reading "Run the fast check suite before every
commit." — which names the right work in prose — is rejected. The check buys no
guarantee that a real command was named, which was its entire purpose.

**Failure — the mitigation.** `checkPlan` is a pure function of the plan blob;
nothing in the plan artifact, the submission, or the cursors state records which
coordinator build accepted a plan. There is no place to express "only new
submissions", so any re-evaluation of an existing submission — a reissued action
after an unrelated outstanding item, or verification retried after a fetch
failure — applies the new rule to plan text written under the old one. The three
plans bound to this very action are the concrete case: none of them would satisfy
a "backticked argv in Tests" rule interpreted strictly, and the plan offers no
migration beyond a claim that cannot be implemented as stated.

**Smallest correction.** Either match a command-shaped token (a backticked run of
two or more space-separated words) and update the in-repo fixtures in the same
commit, or drop the check and keep the guidance in the scaffold prose.

### 5. codex — the change is advisory only, so nothing rejects a plan that ignores it

**Claim.** "The checklist will use the existing action-scaffold renderer rather
than add a new policy layer, state field, configuration option, dependency, or
enforcement system", with the file list limited to `src/orderScaffold.ts` and
`test/orderScaffold.test.ts`.

**Rule.** A change intended to alter what agents produce needs at least one
condition that fails when the guidance is ignored. Otherwise the outcome depends
on an agent reading prose it has already been shown.

**Failure.** The clone protocol overlay already tells agents to prefer the
smallest correction and to prefer a test over a fix, and the reported behavior —
new modules instead of reuse, a test suite that grows every issue — happened
anyway. After codex's change, a plan proposing three new modules and two new test
files is accepted exactly as it is today: `checkPlan` is untouched, so acceptance
is unchanged, and the only new pressure is a reviewer who may or may not raise
it. The measurable result of the change is longer action text.

**Smallest correction.** Pair the checklist with one condition in `checkPlan` —
a required section naming reused code and justifying each new file is enough —
so that a plan which ignores the checklist is returned with a named outstanding
item rather than accepted.

### 6. codex — the scaffold is told to demand a value the action never binds

**Claim.** For a plan action, "Require the plan to name both a narrow feedback
command and the repository's configured validation without weakening required
checks."

**Rule.** Rendered action text must not ask an agent for a value the action does
not supply. The protocol states this directly: in plans, name real commands, do
not guess them.

**Failure.** `ArtifactScaffoldContext` (`src/orderScaffold.ts:4`) carries the
step id, issue, session id, agent, baseline, digest, inputs, choices, round,
approved paths, and action id — and no workspace configuration. The configured
validation lives in the workspace config
(`config.product.example.json:19`, `verify.precommit` argv), which the renderer
never receives. So the rendered instruction asks every agent, in every installed
product, to name a command the action has just declined to tell it. The
predictable outcome is agents copying `pnpm check:fast` into plans for
repositories that use `go vet ./...` — a guessed command in the one section a
reviewer trusts to be real, which is worse than the silence it replaces.

**Smallest correction.** Either add the configured check names to
`ArtifactScaffoldContext` and render them, or ask only for "the commands this
repository's own instructions name", which is a value the agent can verify
locally.

### 7. codex — reviewers get no criterion, so nothing downstream selects for the discipline

**Claim.** Alternatives Rejected: adding the advice to the installed protocol
"would repeat advice on unrelated ballots and reviews", and the file list adds
guidance to the plan, implementation, and revision scaffolds only.

**Rule.** In a workflow where peer review and ballots choose which plan is
implemented, guidance that reaches only the author cannot change which plan wins.

**Failure.** With the review and comparison scaffolds untouched, an agent that
ignores the checklist writes an over-built plan and the reviewer has no stated
criterion to cite against it. Under the existing finding contract a reviewer must
state a rule that must hold; "this plan adds files it does not need" is a matter
of taste until some artifact says otherwise, so reviewers will keep raising
correctness findings and ballots will keep selecting on other grounds. The
over-built plan is then just as likely to be implemented as before, which is the
outcome the issue reports.

**Smallest correction.** One criterion sentence in each of the review and
comparison scaffold branches — the same two branches codex already edits in
`src/orderScaffold.ts` — at no new file cost.

### 8. claude — the new required heading rejects plans already written, including the three bound here

**Claim.** `src/evidence.ts` gains a required `## Reuse and Scope` section;
Risks and Mitigations accepts in-flight rejection as "the intended cost of a
mechanically enforced contract".

**Rule.** A change to an acceptance contract must state which existing artifacts
stop being acceptable, not only that some will.

**Failure.** None of the three plans bound to this action carries a
`## Reuse and Scope` heading, and only claude's does under any accepted alias.
If the change lands and any of those submissions is re-evaluated — a reissued
action carrying an unrelated outstanding item is the ordinary path — the plan is
returned as missing a section that did not exist when it was written. The
mitigation (the outstanding item names the heading, and the reissued action's
scaffold lists it) makes the recovery one section long, which is proportionate,
but the plan understates the blast radius by not naming it.

**Smallest correction.** Keep the alias list broad, land the check together with
the fixture updates in one commit, and state in the plan that plans written
before the change are rejected until a reuse section is added.

### 9. claude — a path cited only under reuse loses its approval with no report

**Claim.** `extractApprovedPaths` scans `stripSections(raw, REUSE_SECTION_HEADINGS)`,
so paths cited in the reuse section do not widen the approved set.

**Rule.** When a mechanism removes an agent's permission based on where text
appears in a document, the removal must be visible to the agent before the
implementation is submitted.

**Failure.** An agent that lists `src/helper.ts` only in its reuse section, and
then edits it during implementation, has its implementation rejected for touching
a path outside the approved list — after the work is done — with an outstanding
item that points at the path but not at the reason. The scaffold sentence
mitigates this for agents who read it, which is the same prose-reliance this
review faults elsewhere; the residual is real but small, since the two file lists
sit directly above the reuse section in the same scaffold.

**Smallest correction.** State in the scaffold, in the same sentence, that a path
the plan intends to change belongs in a file list even when it is also reused.

## Conclusion

All three plans agree on the diagnosis and on two rejections that hold up: no
numeric cap on diff size, file count, or test duration, and no new analytics or
workflow machinery. They differ on whether anything mechanical changes.

- **cursor** is the largest and carries the only finding that stops execution
  outright: the `AGENTS.md` edit cannot be staged in the prepared clone
  (finding 1). It also adds a test file that cannot fail (2), defers a design
  decision to implementation time while institutionalising an unchecked
  duplicate (3), and proposes an acceptance rule that both under- and
  over-rejects while claiming a migration exemption with no mechanism (4). Its
  five-surface spread is itself the behavior the issue names. Not implementable
  as written.
- **codex** is the cleanest scope — two files, no new module, no new test file —
  and its `renderArtifactScaffold` placement is the right home for the checklist.
  But it changes nothing that can fail (5), instructs the renderer to demand a
  value it never receives (6), and leaves reviewers without a criterion (7). As
  written it makes actions longer and results identical.
- **claude** is the only plan pairing the guidance with a condition that fails
  when ignored, and the only one that closes the approved-path widening that
  reuse citations would otherwise open. Its costs are honest but understated
  (8, 9), and both are one-sentence fixes.

Recommended shape: claude's required `## Reuse and Scope` section and the
extraction fix, rendered through codex's discipline checklist confined to the
plan, implementation, and revision scaffolds, plus codex's one-sentence criterion
in the review and comparison branches (finding 7). Drop cursor's
`src/agentDiscipline.ts`, `test/agentDiscipline.test.ts`, `scripts/setup_cursor.sh`,
and `AGENTS.md` from scope, and drop the backticked-argv check in favour of the
reuse section. That lands in five source files and four existing test files, with
one net new test case.
