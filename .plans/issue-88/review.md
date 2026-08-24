# Plan review — issue 88

Bound plans under review:

- claude `ff3ec41c02507e28ad3087ba2ac53c5646b87701` at `.plans/issue-88/plan.md`
- codex `0027cb4c64efcf06da255aaea482bdf5baf939fe` at `.plans/issue-88/plan.md`
- cursor `a58b4d38e13a1a66f81a240c11deb382ee6ca278` at `.plans/issue-88/plan.md`

Every claim below was checked against the bound blobs and against the baseline
tree `76cfd1550c3e74c0b6281cd83be04da9049f5814`, using the repository's own
`findAgentLanguageViolations` and `extractApprovedPaths`.

## Findings

### 1. codex `0027cb4c` — the baseline it certifies as clean still leaks, and its file map forbids the fix

**Claim.** "Exact File List to be changed or deleted: None. No tracked product
file should be changed or deleted," supported by "Issue 88 is already
implemented in the authoritative baseline and its focused acceptance suite
passes."

**Rule that must hold.** A plan that asserts a property already holds must be
false if the property does not hold. Separately, `extractApprovedPaths` in
`src/evidence.ts` derives the approved file map from every backticked repository
path in the selected plan, and `evaluateEvidence` rejects an implementation with
`implementation changes paths outside the approved file map`. The file map is
therefore not advisory: it is the outer bound on what the implementation may
touch.

**Concrete failure.** The property does not hold at the bound baseline:

```
git show 76cfd155:AGENTS.md          45: "...execute that new action even
                                     46:  without a typed nudge. ... when a
                                         nudge did not land."
                                    126: "what the coordinator `checks` gate."
git show 76cfd155:src/hookPolicy.ts  37: "...must not commit ungated."
                                     67: "...declare both phases empty..."
```

`findAgentLanguageViolations` on those lines returns `delivery-vocabulary:
nudge`, `gate-vocabulary: gate`, and `phase-vocabulary: phases`. `AGENTS.md` is
loaded into every agent session in this repository through `CLAUDE.md`'s
`@AGENTS.md`, and the `src/hookPolicy.ts:67` string is thrown from
`verifyCommands` and printed to the agent's own terminal by the pre-commit hook.
So acceptance criterion 1 — "No internal coordinator phase/delivery jargon
appears in agent-facing prose" — is false at the commit this plan proposes to
pin as the finished implementation.

The second half is worse than a missed fix. `extractApprovedPaths` on this plan
yields exactly:

```
package.json  src/action.ts  src/agentLanguage.ts  src/evidence.ts
src/orderScaffold.ts  src/steps.ts  src/tmux.ts
templates/product/AGENTS.md  templates/product/AGENTS.protocol.md
test/agentLanguage.test.ts
```

Neither `AGENTS.md` nor `src/hookPolicy.ts` appears. If this plan is selected, an
implementer who notices the leak cannot fix it: the implementation evidence is
rejected for changing paths outside the approved map. The plan does not merely
fail to close the issue — it makes closing it a rejected submission.

**Smallest correction.** Add `AGENTS.md` and `src/hookPolicy.ts` to the file list
with the five strings named above, and drop the zero-diff framing.

### 2. codex `0027cb4c` — the audit it relies on structurally cannot observe the leak it rules out

**Claim.** Risk 2's mitigation: "audit the three real boundaries—rendered
actions, injected instruction text, and installed guidance—and rely on the
existing step-driven test that enumerates every generated action type rather
than a hand-picked sample," backed by "A focused run of the relevant tests on
this baseline passed all 202 tests across eight files."

**Rule that must hold.** An audit offered as evidence of absence must read the
text whose absence it certifies. A passing suite is evidence only over the
inputs it actually loads.

**Concrete failure.** `test/agentLanguage.test.ts` reads exactly two things from
disk: `templates/product/AGENTS.md` (line 288) and
`renderAgentsProtocolBlock(repoRoot)` (line 286), which reads
`templates/product/AGENTS.protocol.md`. It never opens root `AGENTS.md`, never
opens `CLAUDE.md`, and never constructs a `HookPolicyError`. The three
boundaries the plan names are precisely the three that are already covered, so
the 202 passing tests are the reason the leak survived round one, not evidence
that it is absent. Following this plan, the audit passes, the implementation
pins an unchanged tree, and issue 88 closes with all five strings shipping.

**Smallest correction.** Name root `AGENTS.md`, `CLAUDE.md`, and the
`HookPolicyError` messages as audited surfaces, and require the audit to fail
before the fix and pass after it.

### 3. cursor `a58b4d38` — dropping bare `\bR[1-7]\b`, `\bgates?\b`, and `\bphases?\b` removes live guards for one rewordable sentence

**Claim.** Under `src/agentLanguage.ts`: "drop bare `\bphases?\b`, `\bgates?\b`,
and `\bR[1-7]\b`", justified by "The oracle's bare `\bphases?\b`, `\bgates?\b`,
`\bR[1-7]\b` … bans also fight ordinary English the issue allows (including
'what the coordinator `checks` gate' in `AGENTS.md`)."

**Rule that must hold.** The banned-term list is the only mechanical guard on
agent-facing text. A pattern may be dropped when it produces a false positive on
text that must stay; dropping one whose only hits are text the same plan is
already rewriting trades a caught leak class for nothing.

**Concrete failure.** Across the agent-facing surfaces the plan itself
enumerates, the hits are: `\bgates?\b` — one, the `AGENTS.md:126` sentence, which
the plan could reword in one line and which is ungrammatical as it stands ("is
what the coordinator `checks` gate" has no main verb); `\bphases?\b` — one,
`src/hookPolicy.ts:67`, which this same plan already rewords to "declare both
lists empty"; `\bR[1-7]\b` — zero, because round one removed "R7 finalization"
from `templates/product/AGENTS.md`. So after the plan's own rewordings, two of
the three patterns have no remaining hit at all and the third has one.

What the drop costs is concrete. It re-legalizes the two strings issue 88's first
round removed — "R7 finalization is deletion-only cleanup" and "they gate
pull-request creation" — and the plan simultaneously rewrites the positive
controls that pin them (`test/agentLanguage.test.ts:310-313`, which assert
`internal-round-label: R7` and `gate-vocabulary: gate`). After this change, a
template edit reintroducing "R6 revision phase" into installed guidance passes
the suite. The narrowed replacements do not cover it: `\bR[1-7]\.[a-z][a-z-]*\b`
requires the dot, and `\b(?:ungated|gated|gating)\b` does not match bare "gate".

**Smallest correction.** Keep all three patterns and reword `AGENTS.md:125-126`
to "…is what the coordinator runs on an approved commit." Add
`\b(?:ungated|gated|gating)\b` alongside `\bgates?\b` rather than in place of it.

### 4. cursor `a58b4d38` — lifting `skip-worktree` and `git add`-ing `AGENTS.md` commits the installed overlay

**Claim.** Risks: "implementers lift skip-worktree only for that path long
enough to stage the tracked fix, then restore the bit (same pattern as other
AGENTS edits on this branch); do not strip the protocol block to 'fix' status."

**Rule that must hold.** `writeCloneAgentsProtocol` appends the rendered
protocol block into the clone's **working-tree** `AGENTS.md`, between
`<!-- coordination protocol — coord install -->` and
`<!-- /coordination protocol -->`. The `skip-worktree` bit is the only thing
keeping that generated text out of the index. Any staging route that reads the
working-tree file therefore stages the overlay along with the fix.

**Concrete failure.** In this clone, working-tree `AGENTS.md` is 250 lines and
the tracked blob is 129; lines 131-250 are the installed overlay. After
`git update-index --no-skip-worktree -- AGENTS.md`, `git add AGENTS.md` stages
all 250 lines, committing 121 lines of generated block into the tracked file.
Every check in the plan's test list still passes — the new prose scan reads the
same working-tree file it always did, and `git status` is clean once the bit is
restored — so the implementer gets a green run and a corrupted `AGENTS.md`. The
next `coord install` then renders its block against a tracked file that already
contains one, and the duplication is permanent in history.

**Smallest correction.** Never read the working-tree copy. Build the corrected
tracked content from `git show HEAD:AGENTS.md`, then stage it with index
plumbing:

```sh
sha="$(git hash-object -w /tmp/agents-new.md)"
git update-index --cacheinfo "100644,$sha,AGENTS.md"
# ... commit ...
git update-index --skip-worktree -- AGENTS.md
```

`--cacheinfo` clears `skip-worktree` as a side effect (verified: `git ls-files
-v` reports `H`, not `S`, immediately after), so the trailing re-set is
mandatory, not hygiene. Verify against the commit, not the tree:
`git show HEAD:AGENTS.md | wc -l` and `git ls-files -v -- AGENTS.md`.

### 5. claude `ff3ec41c` — leaves sequence framing in the rendered action body, which is the primary agent-facing surface

**Claim.** The plan opens by asserting the residual set is four strings
(`AGENTS.md:45`, `:46`, `:126`, `src/hookPolicy.ts:67`) and closes with "it
removes the four remaining strings the shipped checker still flags in
agent-facing text."

**Rule that must hold.** The issue requires agent instructions to describe "only
the current outcome, required artifact, exact inputs, publication path, and
completion signal," and forbids presenting coordinator position as a phase or
transition. The rendered `action.md` body is the surface this applies to most
directly.

**Concrete failure.** `src/orderScaffold.ts:138,155,167` emit "the list here is
authoritative for this step and may change" into every plan, review, and
comparison action — that sentence is in the action this review answers.
`src/action.ts:66` emits "each agent on this step does not re-derive the same
diff" into any action carrying a change-scope section. `templates/product/
AGENTS.protocol.md:10` says "the current step … that step's `action.md`" and
`templates/product/AGENTS.md:44` says "The final cleanup step." The claude plan
changes none of these files and does not extend the banned-term list, so the
prose scan it adds passes over `templates/product/AGENTS.protocol.md` with that
sentence intact. "Four strings" is an undercount, and the plan's Conclusion
states the residual set is closed when it is not.

**Smallest correction.** Adopt cursor's sequence-phrase rule
(`(?:current|this|that|next|previous|every)\s+step\b` plus `final cleanup step`)
and add `src/action.ts`, `src/orderScaffold.ts`,
`templates/product/AGENTS.protocol.md`, and `templates/product/AGENTS.md` to the
file list.

### 6. claude `ff3ec41c` — misses the second agent-visible string in the file it edits

**Claim.** "In the `HookPolicyError` thrown by `verifyCommands` (line 67), replace
… Nothing else in `src/hookPolicy.ts` changes."

**Rule that must hold.** A file map entry that says "nothing else in this file
changes" must be true of the file, not of what the current checker happens to
flag.

**Concrete failure.** `src/hookPolicy.ts:37` reads "Coordination hooks are
present here, so this is an agent clone and must not commit ungated," and the
same sentence is echoed to the agent's terminal from `githooks/lib/identity.sh:59`
and `templates/hooks/shim.sh:23`. `\bgates?\b` does not match inside "ungated",
so the plan's own scan cannot see it, and the plan's audit therefore certifies a
file that still carries gate vocabulary in an agent-visible diagnostic. Only the
cursor plan names this string.

**Smallest correction.** Reword all three copies and add
`\b(?:ungated|gated|gating)\b` to the banned list, per Finding 3.

### 7. claude `ff3ec41c` and cursor `a58b4d38` — out-of-scope files are backticked, so the file map approves them

**Claim.** claude's Alternatives Rejected names `README.md`, `src/analytics.ts`,
`src/cli.ts` as deliberately out of scope and its Risks section says
`package.json` stays put; cursor's Out of scope section names "operator docs
(`docs/`, README)".

**Rule that must hold.** `extractApprovedPaths` scans the whole plan blob for
backticked repository paths — it does not restrict itself to the file-list
sections — and the resulting set is what `evaluateEvidence` enforces. Prose that
says "out of scope" has no mechanical force; the backtick does.

**Concrete failure.** claude's plan yields an approved map containing
`README.md`, `src/analytics.ts`, `src/cli.ts`, and `package.json`; cursor's
contains `docs/`, which as a tree root approves every file under it. An
implementation that rewrites the analytics tables or the operator documentation
— the exact edits both plans forbid, and which acceptance criterion 2 requires
to stay unchanged — passes the approved-path check. A `package.json` bump on an
issue-branch commit likewise passes, which both plans explicitly reject.

**Smallest correction.** Name out-of-scope files as plain text, without
backticks.

### 8. cursor `a58b4d38` — widens the boundary but leaves the document that defines it asserting the old one

**Claim.** Out of scope: "Rewriting operator docs (`docs/`, README)"; the file
list contains no `docs/` entry.

**Rule that must hold.** A document that states the invariant a change enforces
must not be left contradicting it, or the next reader implements the stale rule.

**Concrete failure.** `docs/coord-driver.md:288-290` reads "Three surfaces do
reach an agent and must stay free of that vocabulary: the rendered `action.md`
body, the typed injection text, and the protocol overlay installed into a
clone." The cursor plan adds root `AGENTS.md` and hook stderr to that set,
making the sentence false at the moment the change lands. An agent later adding
a fourth agent-facing file reads "three surfaces", finds its file unlisted, and
concludes it is out of scope — reproducing exactly the enumeration gap that let
these leaks survive round one. Updating that sentence is not "rewriting operator
docs"; it is keeping the change's own contract accurate.

**Smallest correction.** Add `docs/coord-driver.md` to the file list with a
one-paragraph update to that section, and keep the existing sentence that
analytics and CLI output are deliberately out of scope.

## Conclusion

**codex `0027cb4c64efcf06da255aaea482bdf5baf939fe` is not viable.** Its central
factual claim is false at the baseline it binds (Finding 1), the audit it offers
as proof cannot observe the failure it rules out (Finding 2), and its approved
file map excludes both files that need editing, so selecting it converts the fix
into a rejected implementation. This is not a scope disagreement; the strings are
in the bound tree and the repository's own checker flags them.

**cursor `a58b4d38e13a1a66f81a240c11deb382ee6ca278` has the best coverage and the
worst mechanics.** It is the only bound plan that finds the sequence framing in
`src/orderScaffold.ts` and `src/action.ts`, the "current step" wording in the
installed overlay, and the `ungated` diagnostic — three real leaks the other two
plans miss. Two corrections are required before it is safe: keep bare
`\bR[1-7]\b`, `\bgates?\b`, and `\bphases?\b` rather than trading live guards for
one rewordable sentence (Finding 3), and stage `AGENTS.md` through
`git hash-object` / `git update-index --cacheinfo` rather than lifting
`skip-worktree` and `git add`-ing a working-tree file that carries 121 lines of
generated overlay (Finding 4). Finding 8 adds one file to its map.

**claude `ff3ec41c02507e28ad3087ba2ac53c5646b87701` is correct but under-scoped.**
Its diagnosis, its index-plumbing procedure, and its treatment of the enumeration
gap hold up; its residual set is an undercount (Findings 5 and 6) and its file
map silently approves the operator surfaces it declares off-limits (Finding 7).

Recommended basis for selection: cursor's plan with Findings 3, 4, 7, and 8
applied, taking claude's `git update-index --cacheinfo` sequence verbatim as the
`AGENTS.md` staging procedure and its `AGENT_FACING_PROSE_FILES` list as the
enumeration mechanism. Verdict: none of the three is ready as published; cursor's
is the one worth correcting.
