# Plan Review — Issue 137

Review of bound plans for issue 137:
- Cursor: `bc5f9ae75426112fa1eb2379bdc0c278eb0b3844`
- Claude: `283f72447e43206d1ef6c8fe104382a7df0ec713`
- Antigravity: `c91a1c98e239aab9cc534c46d9b88956300948bf`
- Codex: `82873282557e9c24e08621ed4356b736618fd7df`

## Findings

### Finding 1: Claude (`283f72447e43206d1ef6c8fe104382a7df0ec713`) bypasses peer agreement entirely in `reviewed` profile

1. **Plan claim or section:** Design §3 and Risks & Mitigations ("Solo and reviewed profiles have no post-implementation ballot. There the amendment is still recorded in the committed `implementation-ready` artifact and on the accepted submission in `cursors.json`, and the PR is opened unmerged for the owner by default (`coord-open-unmerged`).")
2. **Rule that must hold:** When the issue mandates that agents must agree to modify the plan when discoveries happen during implementation, the agreement protocol must operate across all multi-agent profiles (`consensus` and `reviewed`), rather than allowing an implementer in `reviewed` profile to unilaterally expand scope and advance directly to finalization without reviewer concurrence.
3. **Concrete failure if followed as written:** In the `reviewed` profile, the workflow sequence defined in `src/steps.ts` is `["R1.join", "R2.plan", "R3.review", "R3.plan-ballot", "R4.implement", "R7.finalize"]`. There is no `R5.compare` or `R6.ballot`. If an implementing agent in `reviewed` mode encounters an omitted file and declares it in `scopeAmendments` on `implementation-ready.json`, `evaluateEvidence` immediately marks the submission satisfied, and the state machine transitions straight to `R7.finalize`. The reviewing agent never receives an action, never sees the amendment rationale, and has no opportunity to approve or reject the change. This permits unilateral scope expansion without peer agreement.
4. **Smallest correction:** Introduce an in-flight amendment ballot step (`R4.amend-ballot`) when an amendment is proposed, so that active reviewers in `reviewed` profile explicitly vote to approve or reject the file map modification before implementation is accepted.

---

### Finding 2: Claude (`283f72447e43206d1ef6c8fe104382a7df0ec713`) leaves concurrent implementers in `consensus` profile blocked on unamended paths

1. **Plan claim or section:** Design §2 and §3 (implementer declares `scopeAmendments` in `implementation-ready`, which is accepted by evidence; agreement is deferred to subsequent `R5.compare` and `R5.compare-ballot`).
2. **Rule that must hold:** In `consensus` profile, all active roster agents implement concurrently during `R4.implement`. If an overlooked test or dependency blocks test execution (`pnpm check:fast`), agreement on modifying the plan must take effect during `R4.implement` to update the effective approved paths for all active implementers, rather than leaving peer implementers bound to the defective file map.
3. **Concrete failure if followed as written:** When Agent A discovers that an essential test file was omitted from the plan's file map, Agent A publishes `implementation-ready` with `scopeAmendments`. Agent A is satisfied, but Agents B, C, and D remain active in `R4.implement`. Because Claude's plan does not update `approvedPaths` on peer actions during `R4.implement`, Agents B, C, and D cannot touch the test file without being rejected by `evaluateEvidence` for touching paths outside their approved file map. They are forced to either fail pre-commit test checks or duplicate Agent A's amendment declaration independently without shared alignment.
4. **Smallest correction:** Resolve the amendment during implementation via an intermediate `R4.amend-ballot`. Once approved, re-issue `R4.implement` actions with the unioned `approvedPaths` so all implementers share the corrected file map.

---

### Finding 3: Cursor (`bc5f9ae75426112fa1eb2379bdc0c278eb0b3844`) omits the proposal artifact path and action dispatch in `evaluateEvidence`

1. **Plan claim or section:** Exact File List (`src/steps.ts`, `src/evidence.ts`) and Design ("add `R4.amend-scope` / `R4.amend-ballot` (and matching `EvidenceId`s) ... keep amend steps off the normal linear profile progression (entered only from implement/revise)").
2. **Rule that must hold:** Actions in `coord` require a deterministically known artifact path and clear dispatch rules in `evaluateEvidence` so the coordinator can verify submission commits when an agent writes `complete`.
3. **Concrete failure if followed as written:** Cursor's plan states that `R4.amend-scope` is entered only from implement/revise upon accepting an amend-scope proposal, but does not define the repository path for the proposal artifact, nor how `evaluateEvidence` during `R4.implement` recognizes an amendment submission when `order.requiredPath` expects `implementation-ready`. An implementing agent that pushes an amend-scope artifact will be rejected by `evaluateEvidence` because `order.requiredPath` (`.signals/issue-N/implementation-ready-AGENT.json`) is missing from the commit.
4. **Smallest correction:** Define a concrete artifact path (e.g. `.plans/issue-${issue}/amendment-${agent}.md`) and extend `evaluateEvidence` during `R4.implement` to check for this alternate artifact whenever `implementation-ready` is not present.

---

### Finding 4: Codex (`82873282557e9c24e08621ed4356b736618fd7df`) reuses the `implementation-ready` artifact path for unready amendment requests

1. **Plan claim or section:** §1 "Request without claiming implementation completion" ("Implementation and revision actions offer two mutually exclusive outcomes: their existing ready signal, or a protocol-v1 `plan-amendment-request` JSON artifact at that action's existing required artifact path").
2. **Rule that must hold:** Coordination artifact paths should match their semantics. A path named `.signals/issue-${issue}/implementation-ready-${agent}.json` must signify implementation readiness, not an incomplete work-in-progress requesting a plan amendment.
3. **Concrete failure if followed as written:** Writing a `plan-amendment-request` to `implementation-ready-${agent}.json` means a commit on origin contains an artifact claiming in its path to be "implementation-ready" while its JSON contents state the opposite. Later, when the amendment is approved and implementation finishes, the agent must overwrite that same file on its branch with the actual `implementation-ready` payload. Any tooling or inspection logic checking historical commits for `artifact: "implementation-ready"` at that path will fail schema validation.
4. **Smallest correction:** Place amendment requests at a dedicated, distinct path such as `.plans/issue-${issue}/amendment-${agent}.md` or `.signals/issue-${issue}/plan-amendment-${agent}.json`, preserving clean artifact separation.

---

### Finding 5: Codex (`82873282557e9c24e08621ed4356b736618fd7df`) introduces excessive scope and complexity with `scopeHash`

1. **Plan claim or section:** Exact File List and Scope (§1, §3) modifying 15 product files and 12 test files to introduce coordinator-supplied and validated `scopeHash` fields across `InternalOrder`, `action.md`, and signal schemas.
2. **Rule that must hold:** The plan must make the smallest change that fully solves the issue, avoiding speculative flexibility, unnecessary abstractions, and broad surface expansions.
3. **Concrete failure if followed as written:** Introducing `scopeHash` requires altering `implementationReadyArtifactSchema`, `revisionReadyArtifactSchema`, `InternalOrder`, scaffold generation, action rendering, and evidence verification across 15 production files. An implementing agent that completes a valid implementation within the approved paths but omits or mismatches `scopeHash` will have its product work rejected, creating a new failure mode without adding scope safety beyond what `approvedPaths` already guarantees.
4. **Smallest correction:** Omit `scopeHash` and rely directly on `approvedPaths` for scope enforcement in `evaluateEvidence` and `resolveApprovedPaths`.

---

## Conclusion

The four bound plans propose distinct approaches to solving issue 137:

- **Claude (`283f72447e43206d1ef6c8fe104382a7df0ec713`)** attempts a minimal, zero-step solution by attaching `scopeAmendments` to `implementation-ready` and voting during comparison. However, this completely fails in `reviewed` profile (where no comparison ballot exists, allowing unilateral implementer expansion) and leaves concurrent implementers in `consensus` profile blocked.
- **Cursor (`bc5f9ae75426112fa1eb2379bdc0c278eb0b3844`)** correctly recognizes the need for an in-flight agreement ballot (`R4.amend-ballot`), but omits concrete proposal artifact paths and dispatch mechanics in `evaluateEvidence`.
- **Codex (`82873282557e9c24e08621ed4356b736618fd7df`)** provides a detailed model for an on-demand detour, but over-engineers the solution by introducing `scopeHash` across 15 product files and overloads the `implementation-ready` filename for unready amendment requests.
- **Antigravity (`c91a1c98e239aab9cc534c46d9b88956300948bf`)** provides the most robust, balanced, and complete design:
  1. It uses a dedicated `.plans/issue-${issue}/amendment-${agent}.md` artifact with clear required sections, parsed using existing `extractApprovedPaths` helpers.
  2. It supports multi-agent agreement via `R4.amend-ballot` across both `consensus` and `reviewed` profiles, while cleanly auto-approving in `solo` profile.
  3. Upon approval, it unions the approved paths into `approvedPaths` and re-issues `R4.implement` without disturbing product commits, overwriting filenames, or adding complex hashing schemes.

Antigravity's plan (`c91a1c98e239aab9cc534c46d9b88956300948bf`) is recommended for adoption.
