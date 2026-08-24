# Issue 88 plan: finish agent-facing language cleanup

## Scope

Issue 88 keeps coordinator internals out of anything an agent must read to do
rote publication work. Agents get the current outcome, required artifact, exact
inputs, path, and completion signal — not phase IDs, gates, nudges, or
workflow-sequence framing. Internal workflow IDs, journals, analytics, CLI
verbose logs, and owner docs stay unchanged.

### Already on baseline `76cfd155` (do not redo)

The prior coordinated cutover already shipped:

- `artifact: "participation-ready"` and
  `.signals/issue-<n>/participation-ready-<agent>.json`
- Outcome task/footer prose in `src/steps.ts` / `src/action.ts` (footer already
  uses the re-read rule without “nudge”)
- `agentFacingSubject` for pin-validation subjects in `src/evidence.ts`
- Product templates without delivery/phase jargon *except* the residual
  “current step” / “final cleanup step” phrases listed below
- `src/agentLanguage.ts` plus `test/agentLanguage.test.ts` covering every
  `STEP_DEFINITIONS` render, correction blocks, and injected text
- Internal ids `R1.join`, `gate-1-join`, `join-published` preserved

### Remaining gaps this plan closes

Verified against HEAD (descends from baseline `76cfd155`):

1. **Tracked `AGENTS.md` still teaches delivery and sequencing jargon.**
   Recovery still says “typed nudge” / “when a nudge did not land.” The protocol
   block still says “the current step” / “that step's `action.md`” (appears in
   both the upper and lower protocol copies). Agents in this driver clone read
   that file.
2. **Hook-emitted phase/gate metaphors still reach the agent terminal.**
   `src/hookPolicy.ts` throws `declare both phases empty` and
   `must not commit ungated`. The same ungated sentence is echoed from
   `githooks/lib/identity.sh` and `templates/hooks/shim.sh`.
3. **Action scaffolds and product templates still frame work as a step
   sequence.** `src/action.ts` (`this step does not re-derive`),
   `src/orderScaffold.ts` (`for this step and may change`),
   `templates/product/AGENTS.protocol.md` (`current step` / `that step's`), and
   `templates/product/AGENTS.md` (`final cleanup step`) ask agents to reason
   about coordinator position rather than the current outcome.
4. **Language audit holes.** `test/agentLanguage.test.ts` does not scan root
   `AGENTS.md`, does not scan hook `echo`/`printf` operands, and never renders
   non-empty `contextPaths` / `changeScope` sections. The oracle’s bare
   `\bphases?\b`, `\bgates?\b`, `\bR[1-7]\b`, and `\bjoin(ed|ing)?\b` bans also
   fight ordinary English the issue allows (including “what the coordinator
   `checks` gate” in `AGENTS.md`) while `\bgates?\b` still misses `ungated`.

### Authoritative rewordings

**`AGENTS.md` recovery** (match `templates/product/AGENTS.protocol.md`):

> After you write `complete`, do not stop. Before waiting for more input, re-read
> your `action.md`. If `actionId` in the front matter has changed, execute the new
> instructions immediately; do not wait for another coordinator message.

**Protocol / scaffold sequencing** — replace “current step” / “for this step” /
“that step's” with outcome-only wording such as “the current action” / “this
action” / “that action's `action.md`”. Replace “final cleanup step” with
outcome wording such as “final cleanup deletes exactly those paths…”.

**Hook stderr** — `declare both phases empty` → `declare both lists empty`;
`must not commit ungated` → `must not commit without running the project's
declared checks`.

### Out of scope

- Renaming internal step/gate/evidence ids, `VerifyPhase`, `--phase`, or journal
  `nudged` events
- Rewriting operator docs (`docs/`, README) or config field names such as
  `nudgePrelude`
- Scanning whole hook files (comments explaining internals to maintainers stay
  legal); only emitted `echo`/`printf` operands are agent-facing
- Bumping `package.json` on ordinary issue-branch commits (`pnpm check:version-bump`
  / PR workflow only, per issue 95)

## Exact File List to be changed or deleted

### Changed

- `AGENTS.md` — replace the post-`complete` recovery paragraph with the
  authoritative re-read wording (no “nudge”). Replace “current step” /
  “that step's” in both protocol copies with action-oriented wording. Keep
  skip-worktree and heading-contract rules. Leave the ordinary-English
  “`checks` gate” sentence once the oracle no longer bans bare “gate”.
- `src/agentLanguage.ts` — reshape `AGENT_FACING_BANNED_TERMS`:
  - keep dotted step ids: `\bR[1-7]\.[a-z][a-z-]*\b`
  - keep gate ids: `\bgate-[1-7]\b`
  - keep delivery stems: `\bnudg[a-z]*\b`
  - keep exact `EvidenceId` alternation and `\b(?:stepId|gateId|evidenceId)\b`
  - replace bare join ban with phase-shaped forms only:
    `\bjoin artifact\b`, `"artifact"\s*:\s*"join"`, path segment `joined-`
  - drop bare `\bphases?\b`, `\bgates?\b`, and `\bR[1-7]\b`
  - add gate-inflection forms that miss today without restoring bare “gate”:
    `\b(?:ungated|gated|gating)\b`
  - add workflow-sequence phrases (not bare “step”):
    `(?:current|this|that|next|previous|every)\s+step\b` and
    `final cleanup step`
  - add `shellEmittedText(source)` returning double-quoted operands of lines
    whose first word is `echo` or `printf`; document hook stderr as an
    agent-facing surface in the module docstring
- `src/hookPolicy.ts` — reword the two `HookPolicyError` strings noted above;
  leave `VerifyPhase`, the `phase` parameter, and `coord ${phase}:` progress
  lines unchanged
- `githooks/lib/identity.sh` — same ungated → declared-checks reword on the
  agent-visible `echo` line
- `templates/hooks/shim.sh` — same reword on the agent-visible `echo` line
- `src/action.ts` — rewrite the changed-path advisory so it does not say
  “on this step”; keep pin SHA, path list, truncation marker, and approved-path
  authority warning
- `src/orderScaffold.ts` — replace “for this step and may change” in all three
  scaffolds with action-authoritative wording; keep every heading, alias,
  finding-order, comparison-heading, and citation rule
- `templates/product/AGENTS.protocol.md` — replace “current step” / “that
  step's” with action-oriented wording; keep recovery, idle sentinel,
  skip-worktree, and artifact-format rules
- `templates/product/AGENTS.md` — describe final cleanup as an outcome that
  deletes transient evidence paths, not as a named workflow step
- `test/agentLanguage.test.ts` — assert root `AGENTS.md` is clean; walk
  `githooks/` and `templates/hooks/` through `shellEmittedText` (count files so
  an empty walk cannot pass); exercise both `HookPolicyError` paths through
  real calls; render non-empty `contextPaths` / `changeScope` and assert both
  section headings appear before the clean check; update leak/positive-control
  cases for the narrowed and extended oracle

### Deleted

- None.

## Exact file list to be created

- None.

## Tests

While implementing:

```bash
pnpm exec vitest run --config vitest.config.ts test/agentLanguage.test.ts
```

Also run when touching scaffolds / action rendering / install text:

```bash
pnpm exec vitest run --config vitest.config.ts test/agentLanguage.test.ts test/action.test.ts test/orderScaffold.test.ts test/install.test.ts
```

Before commit:

```bash
pnpm check:fast
```

Before final acceptance / PR:

```bash
pnpm check
```

Before merging to `main`, bump `package.json` so `pnpm check:version-bump`
passes (PR workflow only; not required on intermediate commits).

Tests must prove against baseline-shaped fixtures:

- Root `AGENTS.md`, both product AGENTS templates, every rendered
  `STEP_DEFINITIONS` action (including non-empty context/change-scope
  sections), correction outstanding blocks, and injected nudge text are clean
  under the reshaped oracle.
- Every `echo`/`printf` operand under `githooks/**` and `templates/hooks/**` is
  clean; both live `HookPolicyError` messages are clean.
- Oracle still catches historical leaks (`R1.join`, `gate-1-join`, “nudged”,
  `"artifact": "join"`, evidence ids, `ungated`/`gated`/`gating`, “current
  step” / “final cleanup step”) and no longer fails ordinary “phase” / bare
  “gate” / bare “R6” / non-phase “join” prose.
- Internal step/gate/evidence identifiers in `STEP_DEFINITIONS` are unchanged.

## Alternatives Rejected

- **Ship any one prior bound plan alone.** Rejected: the prior review round
  showed Claude alone leaves `AGENTS.md` nudge + step sequencing (and planned a
  stale non-`main` version bump); Cursor alone leaves hooks + step sequencing;
  Codex alone leaves nudge + hooks. This plan is the merge of those residual
  slices.
- **Re-implement the full participation-ready cutover.** Rejected: baseline
  already contains it; redoing it risks churn without closing the open gaps.
- **Keep bare `\bphases?\b` / `\bgates?\b` / `\bR[1-7]\b` / bare join bans and
  rewrite every ordinary English hit.** Rejected: the issue allows ordinary task
  English; shape-scoped rules plus concrete string rewrites close real leaks
  without fighting “checks gate” prose.
- **Ban every occurrence of “step” or “join”.** Rejected: bound paths and
  ordinary procedural text can legitimately contain those words; only
  sequence/phase-shaped forms are in scope.
- **Scan whole hook files instead of emitted strings.** Rejected: maintainer
  comments about phases/gates are operator-facing and must stay legal.
- **Rename `VerifyPhase` / `--phase`.** Rejected: internal/operator CLI contract;
  fix the agent-visible sentence only.
- **Bump package version on every implementation commit.** Rejected: issue 95
  moved that gate to PR/merge only.
- **Runtime guard that aborts action publication on oracle hits.** Rejected:
  externally derived outstanding text and paths can false-positive and strand a
  run; keep the test-time invariant.

## Risks and Mitigations

- **Risk: narrowing the oracle misses a real leak.** Mitigation: keep evidence-id
  alternation, dotted step ids, gate ids, nudge stems, join-phase token/path
  forms, ungated/gated/gating, and sequence-phrase rules; add explicit
  regression cases for each.
- **Risk: `shellEmittedText` misses a future heredoc emitter.** Mitigation:
  document the echo/printf assumption; assert the walk finds the known hook
  bodies so an empty glob cannot pass; today no hook emits via `cat <<EOF`.
- **Risk: scaffold/template edits drop a mechanical heading or alias.**
  Mitigation: change only sequencing prose; keep headings/aliases/citation
  rules byte-stable where practical; `test/orderScaffold.test.ts` /
  `test/install.test.ts` must still pass.
- **Risk: root `AGENTS.md` drifts from `templates/product/AGENTS.protocol.md`
  again.** Mitigation: shared recovery and action-oriented wording; audit both
  in `test/agentLanguage.test.ts`.
- **Risk: skip-worktree clone overlays hide the tracked `AGENTS.md` fix until
  reinstall.** Mitigation: change the tracked source of truth; next
  prepare/install refresh re-applies the protocol block from the clean
  template. Live `action.md` footers are already clean.
- **Risk: editing `AGENTS.md` while skip-worktree is set.** Mitigation:
  implementers lift skip-worktree only for that path long enough to stage the
  tracked fix, then restore the bit (same pattern as other AGENTS edits on this
  branch); do not strip the protocol block to “fix” status.

## Conclusion

Finish issue 88 as a small delta on the already-merged cutover: remove the
remaining nudge, hook-emitted phase/gate, and “current step” leaks from every
agent-readable surface; reshape the language oracle to the shapes the issue
actually forbids (including ungated inflections and sequence phrases); and
extend the mechanical audit so root guidance, hook stderr, and populated action
sections cannot regress — while internal coordinator vocabulary stays available
to analytics and operators.
