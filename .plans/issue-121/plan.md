# Issue 121: Emphasize simplicity, scope, efficiency, and reuse to agents

## Problem restated

Agents often expand beyond the GitHub issue, add new modules instead of extending
existing ones, and grow the test suite with every issue without weighing runtime
cost. The coordination driver already constrains *where* agents may edit
(`approvedPaths` from the plan file map) but says little about *how* to plan or
implement: stay minimal, reuse what exists, and keep tests lean.

Issue #121 asks for agent-facing emphasis during **plan** and **implementation**
(and the review/compare steps that gate them), not a new analytics product or
workflow step.

## Exact File List to be changed or deleted

- `src/agentDiscipline.ts` — **created** (see below); single source of truth for
  discipline prose reused by scaffolds and docs
- `src/orderScaffold.ts` — append discipline blocks to `R2.plan`, `R3.review`,
  `R4.implement`, `R5.compare`, and `R6.revise` scaffolds via imports from
  `agentDiscipline.ts`
- `src/steps.ts` — extend `task` strings for those same steps with one-line
  reminders (kept short; detail lives in scaffolds and `AGENTS.md`)
- `src/evidence.ts` — tighten `checkPlan`: require the **Tests** section to name
  at least one backticked command argv (matches the existing AGENTS.md rule that
  plans must name real commands); export `checkPlan` helpers for unit tests if
  needed
- `templates/product/AGENTS.protocol.md` — add **Implementation discipline**
  section (planning, implementing, reviewing, test budget) before **Checks that
  actually run**
- `AGENTS.md` — mirror the same **Implementation discipline** block in the
  tracked portion (lines before the coordination overlay); do not strip or clear
  `skip-worktree`
- `scripts/setup_cursor.sh` — expand the generated `.cursor/rules/working-style.mdc`
  template to match the discipline bullets (Cursor has no global identity file;
  this is its main steering surface besides `AGENTS.md`)
- `test/agentDiscipline.test.ts` — assert exported fragments are non-empty and
  contain no banned internal vocabulary (`test/agentLanguage.test.ts` pattern)
- `test/orderScaffold.test.ts` — assert plan/review/implement scaffolds include
  scope/reuse/test-budget guidance
- `test/evidence.test.ts` — plan rejected when Tests section omits a backticked
  command; still accepted when present
- `test/install.test.ts` — expect the new discipline heading in rendered protocol
  overlay when `--write-product` fixtures are exercised
- `docs/coord-driver.md` — short operator note: discipline text is injected into
  every plan/implement action and enforced lightly at plan verification

## Exact file list to be created

- `src/agentDiscipline.ts` — exported string constants:
  - `PLAN_DISCIPLINE` — scope boundary, reuse-before-create, smallest diff, test
    budget (extend existing `test/*.test.ts` before adding files; name
    `verify.precommit` / fast vs full checks)
  - `REVIEW_DISCIPLINE` — plan-review findings must call out scope creep,
    unnecessary new files, duplicate logic, and test-suite growth
  - `IMPLEMENT_DISCIPLINE` — implement only `approvedPaths`, read surrounding
    code first, prefer editing existing functions, no drive-by refactors
  - `COMPARE_DISCIPLINE` — comparison findings should note diff size, new files
    vs edits, and test additions relative to the bound pins
  - `REVISION_DISCIPLINE` — same as implement, plus fix only what consensus
    requested
  - `WORKING_STYLE_RULES` — bullet list for `setup_cursor.sh` (reuse
    `agentDiscipline.ts` via a small build-time copy or duplicate the bullets in
    the shell heredoc from the same wording as `WORKING_STYLE_RULES`; prefer
    importing in a `pnpm` script only if it stays simpler — **default: duplicate
    the five bullets in the heredoc verbatim from `WORKING_STYLE_RULES` in
    TypeScript comments at top of file for manual sync**, since shell cannot
    import TS)
- `.plans/issue-121/plan.md` — this file

## Design (discipline content)

**One module, many surfaces.** `agentDiscipline.ts` holds the canonical wording.
`orderScaffold.ts` concatenates the right fragment after the existing heading
lists / JSON preamble so every `action.md` carries the reminder even after
context compaction. `AGENTS.md` and `AGENTS.protocol.md` repeat the same rules
for manual mode and for agents that read protocol before the action file.

**Plan step (`R2.plan`).** After the required heading list, append `PLAN_DISCIPLINE`
instructing agents to:

- Restate issue scope in the opening paragraphs; list explicit **out of scope**
  items in **Alternatives Rejected** or **Conclusion**
- Name existing functions/modules to reuse before proposing new ones
- Keep the file map minimal: prefer changing listed paths over creating parallel
  modules
- In **Tests**, name real commands (e.g. `` `pnpm check:fast` ``) and justify
  each **new** `test/*.test.ts` file; otherwise extend an existing test file

**Review step (`R3.review`).** Append `REVIEW_DISCIPLINE`: at least one finding
should address whether the bound plan stays within issue scope, reuses existing
code, and avoids unnecessary test files. (Not a new required heading — prose
guidance in the scaffold, same pattern as existing "findings must state…"
text.)

**Implement / revise (`R4`, `R6`).** Prepend `IMPLEMENT_DISCIPLINE` /
`REVISION_DISCIPLINE` before the JSON scaffold. Remind agents that paths outside
`approvedPaths` fail verification and that the smallest correct diff wins.

**Compare (`R5`).** Append `COMPARE_DISCIPLINE` alongside the existing finding
format rules.

**Mechanical plan check.** Extend `checkPlan` in `evidence.ts`:

```typescript
// Tests section must name at least one backticked command argv
if (!/`[^`\n]+`/.test(extractSection(raw, "Tests"))) {
  errors.push("plan Tests section must name at least one real command in backticks");
}
```

Add a small `extractSection` helper (heading to next `##`) reused only for this
check; do not require new plan headings.

**Cursor clone setup.** Expand `working-style.mdc` with the same five bullets as
`WORKING_STYLE_RULES` so Cursor sessions that never see an automated action still
get the guidance (this repo's `.cursor/rules/working-style.mdc` is the live
example to align with).

## Tests

Commands (this repository):

- `pnpm check:fast` — lint, typecheck, `vitest run --config vitest.config.ts`;
  run before each commit (`verify.precommit`)
- `pnpm check` — `pnpm build && pnpm check:fast && pnpm test:e2e`; run before PR
  acceptance

New/updated unit tests:

1. `test/agentDiscipline.test.ts` — each exported constant is non-empty; passes
   `findAgentLanguageViolations`
2. `test/orderScaffold.test.ts` — `R2.plan` scaffold contains "reuse" and
   "out of scope"; `R4.implement` contains "approvedPaths"; `R3.review` mentions
   test growth or scope creep
3. `test/evidence.test.ts` — plan with headings but Tests section `"Run tests."`
   → rejected; same plan with `` `pnpm check:fast` `` → satisfied (existing
   file-map fixture)
4. `test/install.test.ts` — protocol overlay includes `Implementation discipline`

No new top-level `test/*.test.ts` files unless splitting would obscure ownership;
extend the files above.

## Alternatives Rejected

**New required plan heading (`## Scope`).** Rejected: would break every existing
plan fixture and peer plans mid-flight; scope belongs in prose under existing
headings plus review discipline.

**LLM-only user rules outside coordination.** Rejected: Cursor/Codex/Claude setup
is inconsistent; `action.md` and `AGENTS.protocol.md` are the only surfaces every
agent sees during automated issues.

**Hard cap on new test files in `checkPlan`.** Rejected: issue types differ; a
numeric cap would reject legitimate work. Prefer scaffold guidance + review
findings + requiring named verify commands.

**Post-hoc analytics gate on diff size (issue 89-style).** Rejected: out of scope
for #121; discipline at authoring time is the goal, not measuring after merge.

**Changing `approvedPaths` extraction rules.** Rejected: file-map parsing already
works; the gap is agent behavior inside approved paths.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Discipline prose duplicates across `AGENTS.md`, protocol, scaffolds, Cursor rules | Single module for TS surfaces; shell heredoc copies a fixed bullet list documented in `agentDiscipline.ts` header comment |
| Stricter Tests check rejects legacy plans on re-verify | Check applies only to new submissions; fixtures updated in same PR |
| Agents ignore prose-only guidance | Pair with plan-review scaffold requiring scope/reuse findings; implement step repeats `approvedPaths` enforcement (already mechanical) |
| `AGENTS.md` skip-worktree blocks editing overlay from clone | Edit tracked template + `templates/product/AGENTS.protocol.md` in repo; coordination reinstall refreshes overlays |
| Verbose actions increase token use | Keep each discipline block to ~6–8 short bullets; no essays |

## Conclusion

Add `src/agentDiscipline.ts` and wire its prose into plan, review, implement,
compare, and revise action scaffolds plus `AGENTS.md` / `AGENTS.protocol.md`.
Enforce one lightweight plan rule: the **Tests** section must name at least one
backticked verify command. Expand Cursor `working-style.mdc` generation to match.
That gives every agent repeated, issue-visible emphasis on simplicity, staying in
scope, reusing existing code, and keeping the test suite efficient — without new
workflow steps or analytics scope.
