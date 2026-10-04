# Review — issue 137 plans

Bound inputs reviewed (exact copies of the cited pins):

- cursor `bc5f9ae75426112fa1eb2379bdc0c278eb0b3844` — `.plans/issue-137/plan.md`
- claude `283f72447e43206d1ef6c8fe104382a7df0ec713` — `.plans/issue-137/plan.md`
- antigravity `c91a1c98e239aab9cc534c46d9b88956300948bf` — `.plans/issue-137/plan.md`
- codex `82873282557e9c24e08621ed4356b736618fd7df` — `.plans/issue-137/plan.md`

Facts checked against the baseline (`3d1bf99`):

- `src/machine.ts:35-49` — `normalizeCurrentStep`/`nextStep` treat any step
  missing from `stepsForProfile(profile)` as already done and jump to the next
  step in `globalOrder` that the profile does contain.
- `src/machine.ts:214-217` — ballot completion is
  `hasResponse(cursors, current, agent, round)`, keyed only by
  `(stepId, agent, round)`, and `round` is `null` for every step outside `R6.*`.
- `src/runLoop.ts:606-623` — `resolveApprovedPaths` returns the re-extracted
  selected-plan paths whenever they are non-empty and ignores the frozen list,
  so an overlay must be unioned *after* re-extraction, not just added to
  `approvedPathsForOrder`.
- `src/evidence.ts:136-148` — `extractApprovedPaths` accepts every backticked
  token outside the Reuse section that `isFileMapPath` passes. That includes
  dotted identifiers such as `R4.implement` and directory globs such as `src/**`.

## Findings

### cursor (`bc5f9ae75426112fa1eb2379bdc0c278eb0b3844`)

**C1. File list for `src/steps.ts`/`src/evidence.ts`: "add `R4.amend-scope`
… accept amend-scope proposals".**
Rule: every new git-mode step has to name the artifact path the agent writes,
because `evaluateEvidence` reads only `order.requiredPath`
(`src/evidence.ts:256`) and a step definition requires `requiredPath`.
Failure: the plan never says where the proposal goes, or how an agent on
`R4.implement` (required path `implementation-ready-<agent>.json`) submits it.
Two implementers following the plan would pick incompatible paths. An agent
that writes the proposal anywhere other than the `R4.implement` required path
gets `required artifact … is missing` and is reissued: the same deadlock the
issue reports.
Correction: name the proposal path and its schema discriminant, and say
whether it replaces the ready signal at the `R4.implement` required path or
lives at its own path.

**C2. `src/machine.ts`: "keep amend steps off the normal linear profile
progression".**
Rule: a step that is absent from `stepsForProfile` must be handled before
`nextStep`/`normalizeCurrentStep` run. Otherwise `src/machine.ts:40-43`
normalizes it forward.
Failure: when the issue cursor is on `R4.amend-ballot`, `nextStep` sends a
consensus issue to `R5.compare` and a reviewed issue to `R7.finalize`. That
skips the vote and the unfinished implementation. The plan states the intent
but names no change to `normalizeCurrentStep` and no test of this path.
Correction: return early for amend steps in `decide` before normalization, and
add a machine test that an amend ballot never advances to `R5`/`R7`.

**C3. Risks: "hard cap (default 2 accepted amendments per issue)".**
Rule: a mechanism that fixes a deadlock must not reintroduce it at a fixed
count. Ballot responses are also keyed by `(stepId, agent, round)`, and
`round` is `null` on R4.
Failure: a third overlooked file deadlocks the issue exactly as today. Before
the cap is even reached, a second ballot finds the first ballot's responses
already present (`hasResponse(…, "R4.amend-ballot", agent, null)` is true).
The second ballot completes instantly on stale votes. `derived.scopeAmendment`
(singular) also cannot hold two amendments.
Correction: key amendment ballots by a per-issue sequence and store amendments
as a list. Replace the cap with escalation to the owner on rejection.

**C4. Scope: 20 files, including `docs/repo-map.md`, `test/install.test.ts`,
`src/cli.ts`, and a template change.**
Rule (action discipline): the smallest change that fully solves the issue,
with fewest focused tests.
Failure: three docs, the installed protocol overlay, and install-test churn
ride along with a new step/ballot/derive pipeline. The review and regression
surface is far larger than the defect. The "implement order scaffold embeds
that union" case also has an in-flight action rewrite with "same action id
where possible", which is not specified precisely enough to test
deterministically.

### claude (`283f72447e43206d1ef6c8fe104382a7df0ec713`) — self-review

**A1. Design §3 / Risks: "agreement happens in the ballots the workflow
already runs".**
Rule: the issue asks for "a way for the agents to agree to modify the plan".
Widening scope must require an explicit judgment from a peer, not only after
the fact.
Failure: in the `reviewed` profile the sequence is `R4.implement → R7.finalize`
(`src/steps.ts:199-206`). An implementer that declares `scopeAmendments`
for an arbitrary path with any reason is accepted, finalized, and opened as a
PR, and no other agent ever sees the declaration. In `consensus` the comparison
ballot chooses between whole implementations. If every implementer adds the
same path, no vote can reject the amendment on its own, and the only lever is
an R6 `revise` that the reviser cannot satisfy without the path. The plan
removes the deadlock, but in the reviewed profile it does so by self-grant,
which the other three plans reject.

**A2. File list surfaces: identifiers extracted as approved paths.**
Rule: the plan's backticked tokens outside the Reuse section become the
approved map (`src/evidence.ts:136-148`).
Failure: the published plan's map includes `R4.implement`, `R6.revise`,
`cursors.accepted`, `decision.scopeAmendments` and `observation.scopeAmendments`.
That is harmless for enforcement, but `implementation-ready.approvedPaths` must
reproduce those pseudo-paths verbatim. They are noise in every compare action.
Correction: un-backtick identifiers outside the Reuse section.

### antigravity (`c91a1c98e239aab9cc534c46d9b88956300948bf`)

**G1. `src/evidence.ts`: "extract proposed approved paths using
`extractApprovedPaths`" from a markdown amendment.**
Rule: an amendment has to grant only the exact files peers agreed to.
`extractApprovedPaths` accepts directory roots and globs (`dir/`, `dir/**`) and
any dotted identifier as a root file.
Failure: an amendment whose prose mentions `src/**` (or `src/`) silently
approves the whole tree once voted through. A reviewer reading the rationale
sees one test file and approves the whole tree. Every backticked identifier in
the rationale (`R4.implement`) also becomes an approved path.
Correction: use a strict JSON list of exact file paths validated by
`repositoryPathSchema`, with directories and globs rejected.

**G2. `src/machine.ts`: "transitioning to `R4.amend-ballot`" with no change
to step normalization.**
Rule: same as C2. `R4.amend-ballot` is not in any `stepsForProfile` list, and
the plan does not add it to one.
Failure: on the next tick `nextStep`/`normalizeCurrentStep` advance a consensus
issue to `R5.compare` (reviewed → `R7.finalize`). The ballot is skipped and
implementation is abandoned mid-flight.
Correction: special-case the detour in `decide` before normalization, and test
it in `test/machine.test.ts`.

**G3. Ballot identity: responses for `R4.amend-ballot` use the R4 round
(`null`).**
Rule: each ballot needs a distinct response key (`src/machine.ts:214-217`).
Failure: the second amendment in an issue is "complete" on the first ballot's
votes, and a previously approved disposition approves a different path set
unseen.
Correction: add an amendment sequence used as the ballot round, as codex does.

**G4. Scope: `R6.revise` is not covered.**
Rule: revision is checked against the same approved map
(`src/evidence.ts:342-347`).
Failure: a revision that must touch an overlooked file (for example a test
exposed by a comparison finding) hits the identical deadlock, because the plan
wires the detour only from `R4.implement`.

**G5. Missing state.** The file list changes `stepIdSchema`/`ballotBatchSchema`
but adds no persisted record of the pending amendment, its source step, or the
approved additions. `resolveApprovedPaths` is told to "incorporate paths from
accepted amendments", but no field stores them. A coordinator restart between
approval and resume therefore loses the additions.

### codex (`82873282557e9c24e08621ed4356b736618fd7df`)

**X1. Scope: 15 product files, 2 docs, 12 test files (including
`test/integration.test.ts` and `test/cli.test.ts`).**
Rule (action discipline): the smallest change that fully solves the issue,
and fewest focused tests.
Failure: the plan adds a scope hash on ready signals, suspension and fresh
reissue of peer actions, drop/reselection semantics, materialized amendment
packets, and format-4 state additions. Each is defensible, but together they
are a protocol subsystem. The implementing agent is likely to exceed one
iteration's review budget, and every listed test file becomes a regression
surface for a defect the issue frames as "a mistake was made in the file map".
Correction: drop the scope hash (an approved addition is monotonic, and a
stale ready signal is still checked against the effective map), drop the
integration-test extension, and defer drop/reselection interplay to the
existing reset logic.

**X2. "`{ actionId, disposition: "approve" | "revise", rationale }` … Here
`revise` rejects the proposal".**
Rule: a ballot vocabulary must not change meaning per step. Response parsing
selects schemas by step id (`src/ballotResponse.ts:79`), and agents learn
`revise` from `R6.ballot`, where it means "change the product".
Failure: an agent that means "approve the path but fix the code" votes
`revise`, which this plan counts as rejection. The overlooked file stays
unapproved, and the deadlock continues for a reason no agent intended.
Correction: use `approve | reject`.

**X3. Strength, recorded for the ballot.** This is the only plan that
explicitly handles the three defects above: detour before profile
normalization, amendment sequence distinct from revision round, and literal
file paths only. It also lets the requester ask without pushing a
failing product commit, which the issue's scenario needs, since tests fail
before the path is approved.

## Conclusion

- **claude** is the smallest and removes the deadlock, but it does so without
  prior peer agreement. In the reviewed profile that is self-grant (A1), which
  falls short of the issue's "agents agree".
- **cursor** and **antigravity** add the right kind of agreement step, but as
  written they skip their own ballot through profile normalization (C2, G2),
  reuse stale votes on a second amendment (C3, G3), and leave the proposal
  path or the path-granting rule unsafe or unspecified (C1, G1). antigravity
  also omits revision (G4) and persisted state (G5).
- **codex** is the only plan whose agreement mechanism is correct as written.
  It is over-scoped (X1) and its `revise`-as-reject vocabulary should change
  (X2).

Preferred: **codex**, trimmed per X1 and X2. Second choice: claude's plan
with an explicit peer ballot added for reviewed/consensus. cursor and
antigravity need C1–C3 and G1–G5 fixed before they are implementable.
