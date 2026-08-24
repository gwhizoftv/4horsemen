# Issue 88 implementation comparison

Bound implementation pins:

- cursor `14496c05001a9e72f0a72301c5f12d0ebd597f75`
- codex `b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11`
- claude `c90717513ce4935b78c37feba7e18cda55028613`

All three pins reword hook stderr (`ungated` → declared-checks,
`phases empty` → `lists empty`), remove workflow-sequence framing from
`src/action.ts`, `src/orderScaffold.ts`, and the product AGENTS templates,
add `shellEmittedText` plus hook-diagnostic coverage, and extend
`test/agentLanguage.test.ts` with populated `contextPaths` / `changeScope`
fixtures. They diverge on whether tracked root `AGENTS.md` is cleaned, how
strict the language oracle stays, and whether prose-file / skip-worktree
audit mechanics are durable.

## Comparison

### Codex — tracked `AGENTS.md` delivery and sequencing leaks are untouched

**File:** `AGENTS.md:32`, `AGENTS.md:45-46`, `AGENTS.md:126` on
`b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11`

**Rule:** Root `AGENTS.md` is agent-facing prose in this driver clone; issue
88 requires removing coordinator delivery jargon (`nudge`) and not teaching
agents coordinator position vocabulary.

**Failure if followed:** Agents loading the tracked protocol still read “the
current step”, “typed nudge”, and “what the coordinator `checks` gate”.
`test/agentLanguage.test.ts` on this pin scans rendered actions, templates,
and hook emissions only — not `AGENTS.md` — so `pnpm check:fast` stays green
while the highest-traffic instruction file still violates acceptance.

**Test:** `expect(findAgentLanguageViolations(execSync("git show :AGENTS.md",{encoding:"utf8"}))).toEqual([])`
fails on this pin until the recovery paragraph, sequencing line, and checks
sentence are rewritten (as on the cursor/claude pins).

### Codex — operator-doc edit is the only unique product path change

**File:** `docs/coord-driver.md:286-303` on
`b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11`

**Rule:** Issue 88 scopes agent-facing surfaces; operator documentation is
deliberately out of scope for sanitization.

**Failure if followed:** The implementation spends diff budget documenting
hook-emission coverage in operator docs while leaving the live agent leak in
tracked `AGENTS.md` unfixed. The doc change does not close any agent-visible
gap the suite would otherwise miss.

**Correction:** Drop the operator-doc delta or land it separately; spend the
change set on root `AGENTS.md` and a prose-file audit case.

### Claude — `AGENTS.md` recovery is fixed but the “checks gate” sentence remains

**File:** `AGENTS.md:125` on `c90717513ce4935b78c37feba7e18cda55028613`

**Rule:** Agent-facing prose must not teach coordinator gate vocabulary when
the issue’s goal is to keep internals out of rote instructions.

**Failure if followed:** Recovery no longer says “nudge”, but the checks
section still reads “what the coordinator `checks` gate.” The narrowed oracle
on this pin deliberately dropped bare `\bgates?\b`, so tests stay green while
agents still read gate framing in the file they load every session.

**Test:** After restoring a bare gate-vocabulary guard (or rewriting the
sentence to “runs on an approved commit”), the prose scan must fail until
line 125 is fixed.

### Claude — narrowed oracle drops round/phase/gate regression guards

**File:** `src/agentLanguage.ts:58-69` on
`c90717513ce4935b78c37feba7e18cda55028613`

**Rule:** The ballot-selected implementation should keep strict language bans
that catch historical leaks (`R7`, “the current phase”, bare “gate”) while
only removing shapes fixed by explicit string rewrites.

**Failure if followed:** Bare `\bR[1-7]\b`, `\bphases?\b`, and `\bgates?\b`
are gone. New agent-visible copy containing “R7 finalization”, “the current
phase”, or “they gate pull-request creation” would not fail
`test/agentLanguage.test.ts`, reopening the regression class the baseline
checker already flagged.

**Test:** The cursor pin’s `"reports the leaks issue 88 removed"` cases for
`internal-round-label`, `phase-vocabulary`, and `gate-vocabulary` fail when
run against claude’s `AGENT_FACING_BANNED_TERMS` list.

### Claude — prose audit reads the working tree, not the committed blob

**File:** `test/agentLanguage.test.ts:381-387` on
`c90717513ce4935b78c37feba7e18cda55028613`

**Rule:** Tracked `AGENTS.md` in agent clones carries a skip-worktree bit and
an installed overlay; the audit must judge the committed source of truth.

**Failure if followed:** `removeManagedBlock` over the working-tree file can
pass or fail based on install age and overlay content rather than the blob
staged through index plumbing. A green test does not prove the committed
`AGENTS.md` fix shipped.

**Correction:** Assert against `git show :AGENTS.md` (cursor pin) or document
and verify the `--cacheinfo` staging sequence after every AGENTS edit.

### Cursor — strict oracle retained alongside full prose and hook coverage

**Pin:** `14496c05001a9e72f0a72301c5f12d0ebd597f75`
(`src/agentLanguage.ts:49-65`, `test/agentLanguage.test.ts`)

**Rule:** Close the full residual leak inventory without weakening regression
guards agreed in the ballot rationale.

**Observation:** This pin keeps `\bR[1-7]\b`, `\bphases?\b`, widened
gate-vocabulary (`(?:un)?gat(?:e|es|ed|ing)`), evidence-id alternation, and
sequence-phrase rules while rewriting every string those rules still flag in
tracked `AGENTS.md` (including “checks gate” → “runs on an approved commit”).
It exports `AGENT_FACING_PROSE_FILES`, scans hook operands, exercises live
`HookPolicyError` paths, renders non-empty advisory sections, and reads
`:AGENTS.md` from the index so skip-worktree staging is testable.

### Cursor — out-of-scope branch artifact required a follow-up revert

**File:** `test/integration.test.ts` (reverted in `14496c05001a9e72f0a72301c5f12d0ebd597f75` relative to earlier cursor history)

**Rule:** Implementation pins may change only approved paths from the
selected plan.

**Failure if followed:** An earlier ancestor on the cursor branch had added a
language assertion to `test/integration.test.ts`; the corrected pin reverts
that file to baseline so the approved map holds. Selection should treat
`14496c0` as the authoritative product tip, not earlier cursor commits.

### Shared strengths (all three pins)

Each pin rewords the three hook stderr surfaces (`src/hookPolicy.ts`,
`githooks/lib/identity.sh`, `templates/hooks/shim.sh`), removes “for this
step” / “current step” / “final cleanup step” from scaffolds and product
templates, and extends `test/agentLanguage.test.ts` so populated
`contextPaths` / `changeScope` sections render before the clean check.
Internal ids (`R1.join`, `gate-1-join`, `join-published`) remain in
coordinator code.

## Verdict

**cursor** `14496c05001a9e72f0a72301c5f12d0ebd597f75` is the most complete
against issue 88: it fixes tracked `AGENTS.md` (including the checks
sentence), keeps the strict oracle guards, exports a prose-file list, and
audits hook emissions plus index-staged `AGENTS.md`. **claude**
`c90717513ce4935b78c37feba7e18cda55028613` is close on templates, hooks, and
recovery wording but leaves “checks gate” in `AGENTS.md` and weakens
round/phase/gate regression bans. **codex**
`b45393f18c9b0fe0ec0bf35e9bb7e41e5b19cb11` fixes the same rendered/hook
surfaces but never edits tracked `AGENTS.md`, leaving the largest remaining
leak class in place.
