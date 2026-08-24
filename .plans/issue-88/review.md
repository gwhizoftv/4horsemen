# Issue 88 plan review

Bound plans reviewed:

- claude `ff3ec41c02507e28ad3087ba2ac53c5646b87701` at `.plans/issue-88/plan.md`
- codex `0027cb4c64efcf06da255aaea482bdf5baf939fe` at `.plans/issue-88/plan.md`
- cursor `a58b4d38e13a1a66f81a240c11deb382ee6ca278` at `.plans/issue-88/plan.md`

## Findings

### Claude — Exact File List omits hook `ungated` stderr outside `verifyCommands`

**Plan claim:** Remaining work is four strings in `AGENTS.md` and
`src/hookPolicy.ts:67` (“declare both phases empty”), plus widening test
coverage via `AGENT_FACING_PROSE_FILES` and hook-diagnostic cases through
`verifyCommands` / `runVerifyPhase`. Changed files are `AGENTS.md`,
`src/hookPolicy.ts`, `src/agentLanguage.ts`, `test/agentLanguage.test.ts`, and
`docs/coord-driver.md`.

**Rule:** Every agent-readable surface that still carries coordinator
phase/gate/delivery jargon must be in the change set. At baseline `76cfd155`,
`must not commit ungated` is thrown from `src/hookPolicy.ts:37` and echoed from
`githooks/lib/identity.sh:59` and `templates/hooks/shim.sh:23`. The shipped
oracle’s `\bgates?\b` rule does not match `ungated`, so those strings are live
leaks the test suite cannot see today.

**Failure if followed:** `verifyCommands`’s “phases empty” message is fixed,
but the next failed pre-commit on a clone with no workspace config still prints
`must not commit ungated` to the agent terminal. Acceptance (“no internal
coordinator phase/delivery jargon in agent-facing prose”) fails on the path
agents hit most often.

**Correction:** Add `githooks/lib/identity.sh` and `templates/hooks/shim.sh` to
the changed list with the same declared-checks reword, and extend hook-diagnostic
coverage to `resolveWorkspaceConfig` / emitted hook text, not only
`verifyCommands`.

### Claude — Exact File List omits workflow-sequence framing still in generated actions and templates

**Plan claim:** Fixing the four enumerated strings plus prose-file enumeration
“finishes the job” with no product changes beyond those surfaces.

**Rule:** Agent instructions must describe the current outcome and publication
contract, not the agent’s position in the coordinator workflow. Baseline still
ships “the current step” / “that step's” in tracked `AGENTS.md:32`, in
`templates/product/AGENTS.protocol.md:10`, “for this step” in
`src/orderScaffold.ts`, “this step does not re-derive” in `src/action.ts:66`,
and “final cleanup step” in `templates/product/AGENTS.md:44`. None of these are
in Claude’s file map.

**Failure if followed:** Nudge and one gate-vocabulary hit are removed, but
every rendered plan/review/comparison scaffold and the installed product
templates still frame rote work as a coordinator step sequence. The issue title
(“Simplify agent role in rote work”) stays unmet for those surfaces.

**Correction:** Add `src/action.ts`, `src/orderScaffold.ts`, and both product
AGENTS templates to the changed list with outcome-oriented rewordings, and add
sequence-phrase coverage to the language test.

### Claude — `AGENT_FACING_PROSE_FILES` lists a file that does not exist in this repository

**Plan claim:** The exported list must contain `AGENTS.md` and `CLAUDE.md`, and
a test asserts every listed file exists and is non-empty.

**Rule:** Plans must name real paths. At baseline `76cfd155`, `CLAUDE.md` is
absent from the tree (`git show 76cfd155:CLAUDE.md` fails). This is the
coordination driver repo, not a product clone that loads `@AGENTS.md` through a
separate instruction stub.

**Failure if followed:** The “scans the instruction files an agent actually
loads” case fails on first run because `CLAUDE.md` cannot be read, blocking
implementation before any leak is fixed.

**Correction:** Drop `CLAUDE.md` from the list for this repo, or gate it behind
an existence check with a comment that product clones may extend the list.

### Claude — Tracked `AGENTS.md` “current step” leak is left in place

**Plan claim:** Two edits to tracked `AGENTS.md` — recovery lines 44–46 and
the “checks gate” sentence at 125–126.

**Rule:** Root `AGENTS.md` is agent-facing in this driver clone. Baseline line
32 still reads “The required response format for the current step also appears
in that step's `action.md`…”, which is sequencing jargon under the issue’s
goal even though it is not caught by today’s oracle.

**Failure if followed:** Agents loading the upper protocol section still read
coordinator-sequence framing after the nudge rewrite. Only the recovery
paragraph and one gate-word hit are removed.

**Correction:** Replace “current step” / “that step's” in the tracked upper
section with action-oriented wording, matching the clean overlay template.

### Codex — Exact File List declares zero product changes while baseline leaks remain

**Plan claim:** “The issue's product work is already present in the bound
baseline… The correct implementation is therefore a verification-only,
zero-product-diff pin rather than a second rewrite.”

**Rule:** Acceptance requires no coordinator phase/delivery jargon in
agent-facing prose. Running the shipped checker against baseline-shaped strings
still reports `delivery-vocabulary: nudge` on recovery prose, `phase-vocabulary:
phases` on the `verifyCommands` error, and `gate-vocabulary: gate` on the
“checks gate” sentence; hook stderr still emits `ungated`; rendered scaffolds
and templates still say “current step” / “for this step” / “final cleanup step”.

**Failure if followed:** Implementers run the named test suite, observe green
results over the three surfaces the suite already scans, and ship no fix. All
demonstrable baseline leaks above remain. Acceptance fails.

**Correction:** Abandon the no-op pin. Plan concrete string rewrites and audit
extensions for every remaining agent-readable surface.

### Codex — Tests section treats passing rendered-action coverage as proof the boundary is closed

**Plan claim:** A focused run of eight test files (202 tests) on the baseline
“passed all tests,” so the product tree needs no edits.

**Rule:** `test/agentLanguage.test.ts` at baseline does not scan root
`AGENTS.md`, does not walk hook `echo`/`printf` operands, and never renders
non-empty `contextPaths` / `changeScope` sections. Green tests over enumerated
actions do not imply those unscanned surfaces are clean.

**Failure if followed:** The audit stops at rendered actions, injected text, and
installed overlay templates. Root guidance and hook stderr leaks survive with
a passing suite — exactly the structural gap the prior round identified.

**Correction:** Extend the audit preconditions to include root `AGENTS.md`, hook
emissions, and populated action sections before claiming verification-only
completion.

### Cursor — Tests section does not require stripping the installed protocol overlay before scanning `AGENTS.md`

**Plan claim:** `test/agentLanguage.test.ts` must “assert root `AGENTS.md` is
clean” alongside template and rendered-action scans.

**Rule:** In agent clones, the working-tree `AGENTS.md` concatenates tracked
content with an installed overlay after `<!-- coordination protocol — coord
install -->`. The overlay is rendered from `templates/product/AGENTS.protocol.md`
and is already covered separately. Scanning the working-tree file without
removing the managed block either double-counts overlay prose or fails for
overlay content that will not change until the next install, independent of the
tracked fix.

**Failure if followed:** A test that reads the working-tree file can fail on
overlay “current step” wording after the tracked upper section is fixed, or
pass/fail depending on install age rather than the committed blob the plan edits
via skip-worktree index plumbing.

**Correction:** Strip the managed block with `removeManagedBlock` (or assert
against `git show HEAD:AGENTS.md`) before applying `findAgentLanguageViolations`.

### Cursor — Risks mention skip-worktree index plumbing but Exact File List omits the exact staging procedure

**Plan claim:** Implementers may lift skip-worktree “only for that path long
enough to stage the tracked fix,” with index plumbing referenced only under
Risks.

**Rule:** Tracked `AGENTS.md` carries `skip-worktree`; `git add AGENTS.md` reads
the working-tree copy that includes the installed overlay. Committing that copy
would append ~120 lines of generated protocol into the tracked file while
`git status` stays misleadingly clean — the failure mode Claude documents with
exact `--cacheinfo` commands.

**Failure if followed:** An implementer clears skip-worktree or runs a plain
`git add AGENTS.md`, silently committing the overlay into the tracked blob or
leaving the clone with `H` instead of `S` on the index flag.

**Correction:** Move Claude’s `--cacheinfo` / `git hash-object` / restore
`--skip-worktree` sequence into the `AGENTS.md` change instructions, with
post-commit checks against `git show HEAD:AGENTS.md`, not the working tree.

### Shared — no single bound plan covers the full residual surface set alone

**Plan claim:** Claude presents four strings plus enumeration as sufficient;
Codex presents zero diff as sufficient; Cursor presents the merged delta as
sufficient.

**Rule:** The issue’s agent-facing boundary covers (a) delivery jargon, (b)
phase/gate metaphors in text agents actually read or are shown on stderr, and
(c) not forcing agents to reason about coordinator sequencing — while keeping
internal ids for analytics/operators.

**Failure if followed:** Claude alone leaves ungated hook stderr and all
step-sequencing surfaces; Codex alone leaves every leak; Cursor alone is
closest but needs overlay stripping and explicit skip-worktree staging in the
file-map body. Selecting any one plan without merging corrections reproduces at
least one demonstrable baseline failure.

**Correction:** Implement Cursor’s merged file map and oracle reshaping; add
Claude’s exported `AGENT_FACING_PROSE_FILES` list (minus nonexistent
`CLAUDE.md`), overlay stripping, and index-plumbing commands; reject Codex’s
no-op scope entirely.

## Conclusion

No bound plan is implementable alone against the full residual baseline at
`76cfd155`. Codex’s verification-only scope is factually wrong: multiple
agent-facing leaks remain in root `AGENTS.md`, hook stderr, and
step-sequencing prose, and the existing suite does not scan all of them.
Claude correctly identifies root `AGENTS.md` and the `verifyCommands`
diagnostic, documents skip-worktree staging, and proposes durable prose-file
enumeration — but omits `ungated` hook emissions, all step-sequence surfaces,
and lists a nonexistent `CLAUDE.md`. Cursor is the only plan whose file map
closes the full leak inventory (nudge, ungated, phases, step framing, oracle
holes, hook walk, populated action sections) and correctly defers version bump
to PR time; it should be selected as the base implementation plan after adding
Claude’s overlay-stripping test rule and explicit `--cacheinfo` staging steps.
Do not ship Claude or Codex as written; do not ship Cursor without those two
mechanical corrections.
