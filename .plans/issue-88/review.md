# Plan Review — Issue 88

## Findings

### 1. [P1] The Codex no-op plan preserves confirmed agent-facing leaks

**Plan claim:** The baseline-verification conclusion in the Codex plan at
`0027cb4c64efcf06da255aaea482bdf5baf939fe` claims issue 88 is already fully
implemented and directs the implementation to make no product changes.
**Rule:** No internal phase, gate, or delivery jargon may remain in prose an
agent reads, and the implementation plan must close any surviving baseline
violations rather than merely rerun tests whose coverage omits them.
**Concrete failure:** Following the plan leaves the tracked `AGENTS.md` recovery
paragraph saying “typed nudge” and “when a nudge did not land,” leaves its checks
paragraph saying “checks gate,” and leaves `src/hookPolicy.ts` diagnostics saying
“must not commit ungated” and “declare both phases empty.” Agents read the first
file directly and receive the latter diagnostics in their terminal, so both
acceptance criteria remain false even though the existing focused suite passes.
**Smallest correction:** Replace the no-op with a bounded cleanup of the
remaining agent-facing prose plus regression coverage that scans those actual
surfaces.

### 2. [P1] The Claude plan adds a test for a file that does not exist

**Plan claim:** The prose-surface list and tests in the Claude plan at
`ff3ec41c02507e28ad3087ba2ac53c5646b87701` include `CLAUDE.md`, assert that
every listed file exists, and state that `CLAUDE.md` imports `AGENTS.md`, while
the creation section says no files will be created.
**Rule:** Every path a mechanical test reads must exist in the bound repository
or be included in the exact creation list.
**Concrete failure:** `CLAUDE.md` is absent from baseline
`76cfd1550c3e74c0b6281cd83be04da9049f5814`; the proposed `readFileSync` and
existence assertion therefore fail with `ENOENT`, so `test/agentLanguage.test.ts`
and `pnpm check:fast` cannot pass after following the plan.
**Smallest correction:** Remove `CLAUDE.md` from the tracked prose list and its
existence/import assertion unless the plan explicitly creates and justifies
that file.

### 3. [P1] The Claude plan deliberately clears the protected AGENTS.md index flag

**Plan claim:** The `AGENTS.md` implementation procedure in the Claude plan at
`ff3ec41c02507e28ad3087ba2ac53c5646b87701` uses
`git update-index --cacheinfo`, explicitly notes that this clears
`skip-worktree`, and then restores the bit later.
**Rule:** The active clone protocol forbids clearing `skip-worktree` on
`AGENTS.md` or changing its index flags; if the file is wrong, the agent must
escalate rather than repair that state by hand.
**Concrete failure:** Executing the procedure necessarily puts `AGENTS.md` into
the prohibited non-skip state before the final command and bypasses the exact
protection that keeps the clone-local protocol overlay out of tracked content.
The plan is therefore not executable by an automated agent under the governing
workflow even if the intended blob is correct.
**Smallest correction:** Treat the tracked root-guidance edit as owner-required
work, or identify an owner-approved source-of-truth change that does not mutate
this clone's `AGENTS.md` index flags.

### 4. [P2] The Claude audit still permits workflow-sequence framing in generated instructions

**Plan claim:** The boundary section in the Claude plan at
`ff3ec41c02507e28ad3087ba2ac53c5646b87701` declares five surfaces complete
after adding tracked prose and hook diagnostics, without changing the existing
banned-term vocabulary or the generated “this/current step” sentences.
**Rule:** Agent instructions must describe the current outcome and action, not
make the agent reason about coordinator sequencing or transitions.
**Concrete failure:** `src/action.ts` continues to say “this step does not
re-derive,” `src/orderScaffold.ts` continues to say the format is authoritative
“for this step,” and the product protocol template continues to describe the
“current step” and “that step's action.md.” The proposed tests pass because the
current oracle does not detect those phrases, leaving the original rote-role
simplification incomplete.
**Smallest correction:** Reword these sentences around “this action” or the
required outcome and add narrowly scoped sequence-phrase regression cases.

### 5. [P1] The Cursor plan weakens the oracle so known gate and phase leaks become legal

**Plan claim:** The oracle changes in the Cursor plan at
`a58b4d38e13a1a66f81a240c11deb382ee6ca278` drop the bare `phase`, `gate`,
`R1`–`R7`, and join checks and intentionally leave the root phrase “checks
gate” unchanged.
**Rule:** Internal coordinator phase labels and gate vocabulary must remain
absent from agent-facing prose; narrowing a test must not legalize the exact
class of leaks the issue requires it to catch.
**Concrete failure:** Following the plan makes “the current phase,” “R7
finalization,” and the existing “checks gate” sentence pass the language test.
At least the last phrase remains in an instruction file agents read, so the
acceptance criterion fails while CI reports green.
**Smallest correction:** Retain the current phase, gate, and round-label bans;
reword real agent-facing hits, and only add narrowly targeted inflection or
sequence patterns where coverage is missing.

### 6. [P1] The Cursor plan also instructs implementers to violate skip-worktree protection

**Plan claim:** The `AGENTS.md` risk mitigation in the Cursor plan at
`a58b4d38e13a1a66f81a240c11deb382ee6ca278` tells implementers to lift
`skip-worktree` long enough to stage the tracked edit and restore it afterward.
**Rule:** The active protocol says never clear that bit and to escalate when
`AGENTS.md` looks wrong.
**Concrete failure:** Following the plan performs the forbidden state change
and exposes the clone-local overlay to accidental staging; restoring the bit
later does not make the intermediate protocol violation safe or authorized.
**Smallest correction:** Remove that procedure and route the tracked root file
through owner-authorized work that does not alter this clone's protected index
state.

### 7. [P1] The Cursor plan changes the protected hook tree to satisfy its new checker

**Plan claim:** The exact file map in the Cursor plan at
`a58b4d38e13a1a66f81a240c11deb382ee6ca278` adds a checker over emitted hook
strings and then changes `githooks/lib/identity.sh` and
`templates/hooks/shim.sh` so that checker passes.
**Rule:** The repository workflow explicitly forbids modifying the product
`githooks/` tree as the way to satisfy checks.
**Concrete failure:** The implementation would alter the canonical hook body
specifically to turn a newly asserted language failure green, so it conflicts
with the required verification discipline before its product behavior can be
accepted.
**Smallest correction:** Keep `githooks/` out of the automated implementation
file map and escalate any required hook-message product change for an
owner-authorized path rather than using it as a check-satisfaction edit.

## Conclusion

None of the three bound plans is mechanically safe as written. The Codex plan
misses real remaining leaks; the Claude plan is closest in preserving the
existing strict oracle but contains a guaranteed missing-file test, an
unauthorized index-flag procedure, and incomplete sequence-language coverage;
the Cursor plan finds more surfaces but weakens core acceptance checks and
directly conflicts with the skip-worktree and hook-tree rules. A selectable
revision should preserve the strict language bans, remove the nonexistent-file
fixture, cover action-oriented sequencing phrases, and route protected
`AGENTS.md` or hook changes through owner-authorized work rather than automated
index or hook manipulation.
