# Plan Review: Issue #88

Reviewing bound peer plans for Issue #88:
- Antigravity plan commit: `8b7fd403a4d4441d88c68d8e3820184707832f01` at `.plans/issue-88/plan.md`
- Cursor plan commit: `036cecb07f6e56ad74374a0007bd0bf610b0bb28` at `.plans/issue-88/plan.md`
- Codex plan commit: `80c62df4da7871161c1ecfb77fb75354117c27e5` at `.plans/issue-88/plan.md`
- Claude plan commit: `1327fe2423d9144ab6b3ca955fac4a6c0786d069` at `.plans/issue-88/plan.md`

## Findings

### Finding 1: Scope of Join Artifact Schema and Path Renaming (Antigravity plan `8b7fd403a4d4441d88c68d8e3820184707832f01`)
- **Plan claim or section:** Antigravity plan `.plans/issue-88/plan.md` section "Alternatives Rejected" rejected renaming the `.signals/issue-${issue}/joined-${agent}.json` path and `"artifact": "join"` schema token.
- **Rule that must hold:** Issue #88 mandates: "Agent-visible schema tokens and paths that currently expose phase-specific jargon are audited and renamed where needed."
- **Concrete failure if followed as written:** If the `"artifact": "join"` schema token and `joined-${agent}.json` path are retained, agents will still receive and author JSON artifacts containing phase-specific "join" jargon in the first step.
- **Smallest correction:** Adopt the consensus approach from Claude (`1327fe2423d9144ab6b3ca955fac4a6c0786d069`), Codex (`80c62df4da7871161c1ecfb77fb75354117c27e5`), and Cursor (`036cecb07f6e56ad74374a0007bd0bf610b0bb28`) by updating `R1.join` requiredPath to `.signals/issue-${issue}/participation-ready-${agent}.json` and `joinArtifactSchema` discriminator to `"artifact": "participation-ready"`.

### Finding 2: `order.evidenceId` Leakage in Evidence Pin Validation Diagnostics (Claude plan `1327fe2423d9144ab6b3ca955fac4a6c0786d069`)
- **Plan claim or section:** Claude plan `.plans/issue-88/plan.md` section "Implementation Details" identifying `src/evidence.ts:211` (`validatePhasePin`).
- **Rule that must hold:** No internal coordinator phase, gate, or evidence identifiers (`implementation-pinned`, `reviser-authorized`, `revision-pinned`) may be emitted into agent-facing `outstanding` correction messages.
- **Concrete failure if followed as written:** In `src/evidence.ts`, `pinErrors` currently passes `${order.evidenceId} artifact` as `subject` to `validatePhasePin`. If a pin check fails, the internal `evidenceId` string is formatted into the error message returned in `outstanding` and appended to the reissued `action.md`.
- **Smallest correction:** Map `order.evidenceId` to clean outcome-oriented descriptions (e.g., "implementation signal", "reviser authorization", "revision signal") before passing `subject` to `validatePhasePin`.

### Finding 3: Automated Language Invariant Test Across All Steps (Claude plan `1327fe2423d9144ab6b3ca955fac4a6c0786d069`, Codex plan `80c62df4da7871161c1ecfb77fb75354117c27e5`, Cursor plan `036cecb07f6e56ad74374a0007bd0bf610b0bb28`)
- **Plan claim or section:** Test coverage sections in peer plans specifying an exhaustive iteration over all workflow steps.
- **Rule that must hold:** Acceptance criterion: "Tests inspect every generated action type for internal phase/delivery terminology."
- **Concrete failure if followed as written:** If tests only verify a hand-picked subset of steps or only unit-test string constants, regressions in other generated actions or scaffolds will escape detection.
- **Smallest correction:** Implement the loop over `Object.keys(STEP_DEFINITIONS)` rendering `renderAction` for each step and asserting the absence of internal step IDs (`R\d+\.`), gate tokens (`gate-\d+`), and delivery terms (`nudge`, `nudged`).

## Conclusion

All four plans agree on the fundamental objective and design for Issue #88. Claude's plan (`1327fe2423d9144ab6b3ca955fac4a6c0786d069`), Codex's plan (`80c62df4da7871161c1ecfb77fb75354117c27e5`), and Cursor's plan (`036cecb07f6e56ad74374a0007bd0bf610b0bb28`) provide a complete and mechanically sound specification:
1. Atomically rename the join artifact discriminator to `"participation-ready"` and path to `.signals/issue-${issue}/participation-ready-${agent}.json`.
2. Update the `action.md` footer and AGENTS protocol templates to the outcome-oriented re-read instruction without delivery jargon.
3. Map internal evidence IDs in `src/evidence.ts` to clean agent-facing strings for validation error reporting.
4. Enforce this public boundary with an automated test iterating over all generated action types across `STEP_DEFINITIONS`.
5. Retain internal identifiers, state machine transitions, journals, and analytics intact.
