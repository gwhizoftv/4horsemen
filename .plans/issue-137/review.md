# Issue 137 — plan review (cursor)

Reviewed bound plans: cursor `bc5f9ae75426112fa1eb2379bdc0c278eb0b3844`, claude `283f72447e43206d1ef6c8fe104382a7df0ec713`, antigravity `c91a1c98e239aab9cc534c46d9b88956300948bf`, codex `82873282557e9c24e08621ed4356b736618fd7df`.

## Findings

1. **Claude — Design §§2–3 (declare in ready signal; “agreement” via R5/R6 ballots).**
   The issue requires agents to *agree to modify the plan/file map* when an omission is discovered during implementation — new paths must become authorized only after that agreement.
   If followed as written, `evaluateEvidence` treats declared `scopeAmendments` as immediately enforceable exclusions from `disallowed`, so the pin is accepted before any peer vote; in solo/reviewed there is no post-implementation ballot at all, so one agent unilaterally widens the effective map.
   Smallest correction: keep declarations visible, but grow the enforceable map only through an accepted agreement record (ballot/derive or solo-recorded judgment) before out-of-map paths pass the pin check.

2. **Antigravity — Exact File List / Evidence (`amendment-${agent}.md` when `implementation-ready` is absent).**
   Git admission reads only `order.requiredPath` and rejects when that blob is missing (`src/evidence.ts` reads `requiredPath` before any evidence-id branch).
   Publishing `.plans/issue-N/amendment-${agent}.md` while `R4.implement` still requires `.signals/.../implementation-ready-${agent}.json` yields `required artifact … is missing` on every completion; the alternate markdown is never evaluated.
   Smallest correction: use a mutually exclusive request artifact *at the existing implement/revise requiredPath* (as codex does), or change admission and the action’s `requiredPath` text together.

3. **Cursor — Exact File List / machine (`R4.amend-scope` entered by accepting a proposal during `R4.implement`).**
   Same admission rule: while the issue cursor remains on `R4.implement`, only the implementation-ready path is fetched.
   The plan never specifies an alternate artifact at that path, and never prepares `R4.amend-scope` as the current step before the proposal exists, so an implementer cannot publish a proposal the driver will accept.
   Smallest correction: dual-outcome at the implement/revise requiredPath (request vs ready), *or* an explicit prepare/advance into `R4.amend-scope` with its own `requiredPath` before any ballot.

4. **Cursor and Antigravity — machine / steps (`R4.amend-ballot` off the linear profile sequence).**
   `normalizeCurrentStep` remaps any `WorkflowStepId` absent from `stepsForProfile` to the next profile step by `globalOrder` rank (`src/machine.ts`); off-sequence steps must be special-cased before that remap.
   If `R4.amend-ballot` is absent from profile sequences (cursor: “off the normal linear progression”; antigravity: transition into it without naming the guard), the first `decide` after advancing there rewrites the cursor forward (or, if omitted from `globalOrder`, mis-ranks) and skips returning to implement/revise with the amended map.
   Smallest correction: follow codex — handle the amend detour before `normalizeCurrentStep`, and test reviewed/solo/consensus resume.

5. **Antigravity — Exact File List vs ballot/schema work.**
   Every path the implementation will change must appear in a file-list section; Reuse alone does not authorize edits.
   The plan relies on new ballot batch kinds, response dispositions, and machine transitions but omits `src/protocol.ts`, `src/agentLanguage.ts`, and docs/protocol-overlay paths that existing ballot steps always touch; an implementer who edits only the listed files fails `agentLanguage`/schema/install coverage or ships an undocumented protocol fork.
   Smallest correction: add those paths (or prove schemas/labels need zero edits and say so under Alternatives).

6. **Claude — Risks (solo/reviewed have no post-implementation ballot).**
   The issue’s success criterion is agent agreement on the file-map fix, not merely recording a reason for a later owner glance.
   Treating unmerged-PR owner review as sufficient agreement leaves reviewed/consensus-adjacent profiles able to merge an undeclared-scope pin without any peer disposition on the amendment itself.
   Smallest correction: require the same pre-authorization agreement path in every profile (solo may auto-record; reviewed needs the non-implementer).

## Conclusion

Prefer **codex** (`82873282557e9c24e08621ed4356b736618fd7df`) as the base: mutually exclusive request at the existing implement/revise requiredPath, unanimous amend ballot before the map grows, immutable selected plan SHA, effective map = plan ∪ approved additions, and an explicit normalize/resume detour. **Cursor** matches that agreement model but is not mechanically shippable until admission and `normalizeCurrentStep` are specified. **Antigravity** has the right ballot shape but fails requiredPath admission and under-lists files. **Claude** is the smallest diff and correctly avoids new steps, yet authorizes overlooked paths before agreement and therefore does not solve the issue as stated.

All four stay inside the issue, avoid new `src/` modules, and propose extending existing tests; codex’s larger test surface is justified by concurrency/drop/resume risks the thinner plans leave untested. Implement the codex admission + detour mechanics; keep cursor’s hard amendment cap and additive-only exact-path checks if codex’s sequence machinery is trimmed.
