# Issue 88 plan: finish agent-facing language cleanup

## Scope

Issue 88 keeps coordinator internals out of anything an agent must read to do
rote publication work, so the agent role stays outcome-only: required artifact,
exact inputs, path, and completion signal. Internal workflow IDs, journals,
analytics, CLI verbose logs, and owner docs stay unchanged.

### Already on baseline `76cfd155` (do not redo)

The prior coordinated implementation already shipped:

- `artifact: "participation-ready"` and
  `.signals/issue-<n>/participation-ready-<agent>.json`
- Outcome task/footer prose in `src/steps.ts` / `src/action.ts`
- `agentFacingSubject` for pin-validation subjects in `src/evidence.ts`
- Product templates `templates/product/AGENTS.protocol.md` and
  `templates/product/AGENTS.md` without delivery/phase jargon
- `src/agentLanguage.ts` plus `test/agentLanguage.test.ts` covering every
  `STEP_DEFINITIONS` render, correction blocks, and injected text
- Internal ids `R1.join`, `gate-1-join`, `join-published` preserved

### Remaining gaps this plan closes

1. **Tracked `AGENTS.md` still teaches delivery jargon.** The recovery paragraph
   still says “typed nudge” / “when a nudge did not land.” Agents in this driver
   clone read that file; acceptance fails while it remains.
2. **Language audit does not scan root `AGENTS.md`.**
   `test/agentLanguage.test.ts` checks rendered actions, nudge text, and product
   templates only, so the leak above stays green under `pnpm check:fast`.
3. **Forbidden-pattern oracle is broader than the issue.** Bare
   `\bphases?\b`, `\bgates?\b`, `\bR[1-7]\b`, and `\bjoin(ed|ing)?\b` ban ordinary
   English the issue explicitly allows. That over-ban also flags the legitimate
   sentence “what the coordinator `checks` gate” in `AGENTS.md`. Narrow the
   oracle to phase/gate/delivery *shapes* and join-phase token/path forms.

Authoritative recovery wording for `AGENTS.md` (match
`templates/product/AGENTS.protocol.md`):

> After you write `complete`, do not stop. Before waiting for more input, re-read
> your `action.md`. If `actionId` in the front matter has changed, execute the new
> instructions immediately; do not wait for another coordinator message.

(`src/action.ts` already uses the same re-read rule with action-file wording; do
not change it unless it drifts.)

### Out of scope

- Renaming internal step/gate/evidence ids or journal `nudged` events
- Rewriting operator docs (`docs/`, README) or config field names such as
  `nudgePrelude`
- Deriving clerical workflow steps in the coordinator (separate efficiency work)
- Bumping `package.json` on ordinary issue-branch commits (`pnpm check:version-bump`
  / PR workflow only, per issue 95)

## Exact File List to be changed or deleted

### Changed

- `AGENTS.md` — replace the post-`complete` recovery paragraph so it uses the
  authoritative re-read wording above with no “nudge” / delivery mechanics.
  Keep the surrounding skip-worktree and heading rules. Leave the
  “`checks` gate” sentence as ordinary English once the oracle is narrowed; do
  not invent a paraphrase unless a remaining shape-ban still matches it.
- `src/agentLanguage.ts` — replace the over-broad `AGENT_FACING_BANNED_TERMS`
  list with issue-shaped patterns only:
  - keep dotted step ids: `\bR[1-7]\.[a-z][a-z-]*\b`
  - keep gate ids as used today: `\bgate-[1-7]\b` (matches real `GateId`
    prefixes such as `gate-1-join`); do not ban the bare word “gate”
  - keep delivery stems: `\bnudg[a-z]*\b`
  - keep exact `EvidenceId` alternation and `\b(?:stepId|gateId|evidenceId)\b`
  - replace bare join ban with phase-shaped forms only:
    `\bjoin artifact\b`, `"artifact"\s*:\s*"join"`, and path segment `joined-`
  - drop bare `\bphases?\b`, `\bgates?\b`, and `\bR[1-7]\b` round-label bans
- `test/agentLanguage.test.ts` — assert
  `findAgentLanguageViolations(readFileSync("AGENTS.md","utf8"))` is empty;
  update the “reports the leaks” cases to the narrowed shapes; add positive
  controls that ordinary “phase” / “gate” / bare “R6” / non-phase “join” prose
  is allowed while `R1.join`, `gate-1-join`, `nudge`, `join artifact`, and
  `"artifact": "join"` still fail.

### Deleted

- None.

## Exact file list to be created

- None.

## Tests

While implementing:

```bash
pnpm exec vitest run --config vitest.config.ts test/agentLanguage.test.ts
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

Tests must prove:

- Root `AGENTS.md` has no delivery/phase/gate-id/join-phase jargon under the
  narrowed oracle.
- Every `STEP_DEFINITIONS` rendered `action.md`, correction outstanding block,
  injected `renderNudgeText`, and product AGENTS templates remain clean.
- Narrowed oracle still catches the historical leaks (`R1.join`, `gate-1-join`,
  “nudged”, `"artifact": "join"`, evidence ids) and no longer fails ordinary
  “phase”/“gate”/bare round words.
- Internal step/gate/evidence identifiers in `STEP_DEFINITIONS` are unchanged.

## Alternatives Rejected

- **Re-implement the full participation-ready cutover.** Rejected: baseline
  already contains it; redoing it risks churn without closing the open gap.
- **Leave `AGENTS.md` alone and rely on the product protocol overlay.**
  Rejected: this driver clone’s tracked `AGENTS.md` is agent-facing and still
  names nudges; overlays do not erase that prose.
- **Keep the broad bare-word bans and rewrite “checks gate”.** Rejected: the
  issue allows ordinary task English; the prior plan ballot preferred a
  shape-scoped oracle. Broad bans fight the “simplify rote work” goal.
- **Ban every occurrence of “join”.** Rejected: only phase-named join forms are
  in scope.
- **Bump package version on every commit.** Rejected: issue 95 moved that gate
  to PR/merge only.

## Risks and Mitigations

- **Risk: narrowing the oracle misses a real leak.** Mitigation: keep exact
  evidence-id alternation, dotted step ids, gate ids, nudge stems, and
  join-phase token/path forms; add explicit regression cases for each.
- **Risk: root `AGENTS.md` drifts from `templates/product/AGENTS.protocol.md`
  again.** Mitigation: shared recovery wording; audit both files in
  `test/agentLanguage.test.ts`.
- **Risk: skip-worktree clone overlays hide the tracked fix until reinstall.**
  Mitigation: change the tracked source of truth; next prepare/install refresh
  re-applies the protocol block from the clean template. Live `action.md`
  footers are already clean.
- **Risk: over-editing `AGENTS.md` and stripping required plan/review heading
  docs.** Mitigation: only replace the recovery paragraph and leave heading
  contracts intact.

## Conclusion

Finish issue 88 as a small delta on the already-merged cutover: remove the
remaining nudge (and only-by-overbroad-ban) leaks from tracked `AGENTS.md`,
narrow the language oracle to the shapes the issue actually forbids, and extend
the mechanical audit so root agent guidance cannot regress while internal
coordinator vocabulary stays available to analytics and operators.
