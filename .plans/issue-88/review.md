# Issue 88 plan review

Bound plans reviewed:

- claude `8b1d1d060e79bfb24df7c4a92a6ef0cf03eb5d93` at `.plans/issue-88/plan.md`
- cursor `35b6b5b578959d4f194c92f38832852294c16c1b` at `.plans/issue-88/plan.md`
- codex `1ead79c63e020394124deac2cc6bf7ba072835cc` at `.plans/issue-88/plan.md`

## Findings

### Claude — Exact File List omits the live `AGENTS.md` nudge leak

**Plan claim:** Remaining work is three holes: `hookPolicy.ts` “phases”,
widening `gate-vocabulary` for `ungated`/`gated`/`gating`, and covering
unscanned `contextPaths` / `changeScope` action sections; changed files are
`src/agentLanguage.ts`, `src/hookPolicy.ts`, `githooks/lib/identity.sh`,
`templates/hooks/shim.sh`, `test/agentLanguage.test.ts`, and `package.json`.

**Rule:** Every agent-readable surface that still carries coordinator
delivery/phase jargon must be in the change set. At baseline `76cfd155`,
tracked `AGENTS.md` still says agents recover “without a typed nudge” / “when a
nudge did not land,” and `test/agentLanguage.test.ts` does not scan that file.

**Failure if followed:** Hooks and action sections are cleaned, but agents in
this driver clone still read delivery jargon from `AGENTS.md`. Acceptance
(“no internal coordinator phase/delivery jargon in agent-facing prose”) fails.

**Correction:** Add `AGENTS.md` to the changed list; replace the recovery
paragraph with the outcome-only re-read wording already used in
`templates/product/AGENTS.protocol.md`; assert
`findAgentLanguageViolations` over root `AGENTS.md`.

### Claude — Alternatives/Risks require a non-`main` version bump the baseline no longer enforces

**Plan claim:** `package.json` must move `0.0.19` → `0.0.20` because the
“pre-1.0 ship gate on non-`main` branches requires a version strictly greater
than `origin/main`,” and `pnpm check:version-bump` is listed with the pre-handoff
suite.

**Rule:** Plans must name real gates. At `76cfd155`, `AGENTS.md` states the
`0.0.N` advance is checked only on the PR into `main`, and ordinary issue-branch
commits must not plan a version bump (issue 95).

**Failure if followed:** Implementers treat a stale non-`main` version gate as
blocking `pnpm check:fast`, churn version on every implementation commit, or
disagree with peer plans that correctly defer the bump to PR time.

**Correction:** Drop the implementation-commit version bump; mention
`pnpm check:version-bump` only as a PR/`main` merge concern.

### Cursor — Exact File List omits hook-emitted phase/gate metaphors

**Plan claim:** Remaining gaps are root `AGENTS.md` nudge prose, scanning that
file, and narrowing the over-broad oracle; changed files are only `AGENTS.md`,
`src/agentLanguage.ts`, and `test/agentLanguage.test.ts`.

**Rule:** Agent-facing prose includes text the installed hooks and
`HookPolicyError` paths print into the agent terminal. Baseline still emits
“declare both phases empty” (`src/hookPolicy.ts`) and “must not commit ungated”
(`src/hookPolicy.ts`, `githooks/lib/identity.sh`, `templates/hooks/shim.sh`).
`phases` is already banned but unscanned; `ungated` does not match
`\bgates?\b`, so the current oracle cannot see it even if scanned.

**Failure if followed:** Root `AGENTS.md` is fixed and the suite stays green,
while the next failed `pre-commit` / `coord hook-verify` still teaches agents
coordinator phase/gate metaphors on stderr. The acceptance criterion fails for
those surfaces.

**Correction:** Adopt Claude’s hook-surface inventory: reword the three ungated
strings and the “phases empty” string; scan `echo`/`printf` operands under
`githooks/` and `templates/hooks/` plus the real `HookPolicyError` paths; widen
or replace the gate rule so `ungated`/`gated`/`gating` are visible without
restoring a bare `\bgates?\b` ban.

### Cursor — Scope claim that the oracle+`AGENTS.md` delta is sufficient leaves step-sequencing leaks

**Plan claim:** Closing the three listed gaps finishes issue 88 on the already
merged cutover.

**Rule:** Agent instructions must describe the current outcome and publication
contract, not the agent’s position in the coordinator workflow. Baseline still
ships “current step” / “for this step” / “final cleanup step” in
`templates/product/AGENTS.protocol.md`, `templates/product/AGENTS.md`,
`src/action.ts`, and `src/orderScaffold.ts`.

**Failure if followed:** Delivery jargon is gone from `AGENTS.md`, but every
rendered action scaffold and installed protocol still frames work as a
coordinator step sequence. The “simplify agent role in rote work” title/goal
stays unmet for those surfaces.

**Correction:** Include Codex’s rewrites of those four surfaces (or an
equivalent outcome-only reword) and add regression phrases to the shared
language test.

### Codex — Baseline Assessment falsely treats step-sequencing as the only remaining leak

**Plan claim:** “One smaller leak remains” — workflow-sequence phrases such as
“this step,” “current step,” and “final cleanup step.”

**Rule:** A plan’s remaining-work claim must match the baseline. At `76cfd155`,
agent-facing delivery jargon (`nudge` in `AGENTS.md`) and hook-emitted
phase/gate metaphors (`phases`, `ungated`) are still present and are closer to
the issue’s explicit “gates / nudges / phase names” examples than “step”
phrasing is.

**Failure if followed:** Implementers change scaffolds/templates only. `AGENTS.md`
still teaches nudges; hook stderr still says `phases` / `ungated`. Acceptance
fails despite a green language suite that never scanned those surfaces.

**Correction:** Keep the step-sequence work, and add the `AGENTS.md` recovery
rewrite plus Claude’s hook emission fixes and scan coverage.

### Codex — Exact File List never touches `AGENTS.md` or hook emission paths

**Plan claim:** Changed files are `src/agentLanguage.ts`, `src/action.ts`,
`src/orderScaffold.ts`, `templates/product/AGENTS.protocol.md`,
`templates/product/AGENTS.md`, and `test/agentLanguage.test.ts`.

**Rule:** Same as above: every remaining agent-readable jargon surface must be
listed.

**Failure if followed:** Product templates lose “current step,” but the driver
clone’s tracked `AGENTS.md` recovery paragraph and the hook/`HookPolicyError`
strings are unchanged, so agents still see banned delivery/phase vocabulary.

**Correction:** Extend the file map with `AGENTS.md`, `src/hookPolicy.ts`,
`githooks/lib/identity.sh`, and `templates/hooks/shim.sh`, and require the
language audit to cover those emissions.

### Shared — none of the three plans alone covers the full residual surface set

**Plan claim:** Each plan presents itself as sufficient to finish issue 88.

**Rule:** The issue’s agent-facing boundary covers (a) delivery jargon, (b)
phase/gate metaphors in text agents actually read or are shown, and (c) not
forcing agents to reason about coordinator sequencing—while keeping internal
ids for analytics/operators.

**Failure if followed:** Picking any single bound plan leaves at least one
demonstrable baseline leak: Claude leaves `nudge` and step-sequencing; Cursor
leaves hooks and step-sequencing; Codex leaves `nudge` and hooks.

**Correction:** Prefer Claude’s hook-surface analysis and ungated false-negative
fix, Cursor’s `AGENTS.md` recovery rewrite + root audit + narrowing of bare
`phase`/`gate`/`R[1-7]`/`join` bans, and Codex’s outcome-only scaffold/template
reword for “current step” phrasing. Defer version bump to PR/`main` as Cursor
and Codex do.

## Conclusion

No bound plan is implementable alone against the full residual baseline.
Claude uniquely closes hook-emitted `phases`/`ungated` leaks and the unscanned
action-section gap, but skips the live `AGENTS.md` nudge leak and still plans a
stale non-`main` version bump. Cursor uniquely closes `AGENTS.md` and correctly
narrows the over-broad oracle, but never inventories hooks or step-sequencing
prose. Codex uniquely removes “current step” framing from actions and installed
templates, but its “one leak remains” claim is false and its file map omits
both `AGENTS.md` and hook emissions. Select a merge of those three residual
slices; do not ship any one plan as written.
