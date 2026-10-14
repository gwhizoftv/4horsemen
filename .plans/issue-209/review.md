# Issue 209 plan review

Plans reviewed, read from the bound input files:

- claude `fd898740835d2f037c8675f930f038c5d0cb4ece`
- codex `fd399021665fab51a1621f5921537bfe313f4239`
- cursor `e87d29faec1035954c1738980a71b1a6194f566e`
- antigravity `d9d40a1ad4771af09a1838b3209f35a4abeedb72`

All four agree on the core facts, and I checked them. The runs are 177, 195,
184, 204 and 206, ordered by `start.json.createdAt`/`started.at` and excluding
172 and 209. The older root `/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime` has
nothing newer than 186 (`createdAt` 2026-10-09T18:39Z), so the cohort is right
across both roots. All four also agree on a single new `docs/` file, no product
changes, and that the runtime has no documentation profile, so the new file
runs the product hooks.

Every symbol the plans cite exists:
- `derivePhases` (`src/analytics.ts:227`)
- `derivePausedMs` (`src/analytics.ts:425`)
- `buildAnalytics` and `renderAnalytics` (`src/analytics.ts:551`, `:827`)
- `readAnalyticsRuntime` and `readJournalForAnalytics` (`src/state.ts:1227`,
  `:1183`)
- `terminalLogs` (`src/paths.ts:334`)

Evidence I gathered for the findings below. All of it is read-only and no
product suite was run.

**Holds and pauses.**
- Every coordinator pause in the cohort is a hold on cursor:
  - 177: `delivery-uncertain` for 17 min in R1.join, then `nudge-loop` holds
    of 16.5 min in R3.review and 936 min in R5.compare.
  - 184: `nudge-loop` holds of 56.6 min in R4.implement and 176 min in
    R6.ballot.
  - 195: a `nudge-loop` hold of 2.7 min in R3.plan-ballot.
- 204 and 206 have no holds.

**Phase durations include pauses.** Per-phase `coord analytics` durations
include paused time. For example, 184 R6.ballot is 183.97 min, of which 176 min
is a hold.

**Issue 209's own R1.join.** The interval is already closed, from `started` to
the first `gate-advanced` at +160.0 s.
- Each agent's accepting `verify-result` landed at:

  | agent | accepted at |
  | --- | --- |
  | claude | +24.5 s |
  | codex | +66.2 s |
  | cursor | +76.0 s |
  | antigravity | +159.9 s |

- The coordinator advanced 0.1 s after the last acceptance.
- All four `nudged` events fell within +4.4 to +8.2 s.
- The phase content is a fixed JSON file that each agent commits and pushes,
  plus the containment probe.

**Phase sequence.** `src/steps.ts` always schedules R6.revise and R6.ballot
before R7.finalize in consensus. R7.finalize's task is "Finalize the authorized
revision, remove only current-issue coordination files, and publish
finalization evidence". The coordinator runs `final-check` and creates the PR
after the finalizer's signal; in 204 that happened at journal sequences
764–767.

## Findings

### F1 (all four plans): Reuse and Scope / document outline — the owner's R1.join question is not answered

- **Plan claim.** All four plans exclude issue 209 completely.
  - claude, Risks: "It does not read issue 209's own in-progress journal".
  - codex: "Exclude older #172 and the active #209".
  - cursor: "Issue 209 is not included".
  - antigravity lists only the five runs.
- **Plan claim, continued.** No plan commits to a per-agent breakdown of
  R1.join.
- **Rule.** Owner guidance on this action asks "why does phase 1 R1.join take
  over two minutes?". The analysis has to answer that question with measured
  causes. It cannot do that only through cohort medians that mostly stay under
  two minutes: 195 is 0.97, 184 is 1.32, 204 is 1.83 and 206 is 0.73 min.
- **Concrete failure.** If any plan is followed as written:
  - The only cohort R1.join over two minutes is 177's 21.29 min, and 17 of
    those minutes are a cursor `delivery-uncertain` hold.
  - The document would therefore say that R1.join is either short or
    dominated by holds.
  - The two-minute join the owner is most likely asking about is 209's own
    160 s join, which had no hold. It would not appear at all.
  - The real cause stays invisible: the gate waits on the slowest agent to
    commit and push a fixed-content file. Antigravity finished 84 s after
    cursor, and the coordinator added 0.1 s.
- **Smallest correction.** Keep the five-run cohort, and add a dedicated
  R1.join section.
  - For every cohort run, give per-agent acceptance times and the
    commit/push hook time from `verification-run`.
  - Add 209's closed R1.join interval (sequences from `started` up to the
    first `gate-advanced`) as a clearly labelled supplementary data point. That
    interval is complete and immutable. Reading it does not touch any
    in-progress phase, and it does not change the file map.

### F2 (cursor plan): Tests, fourth bullet — every implementer posts a comment during R4.implement

- **Plan claim.** "Push the commit, then post the committed file with
  `gh issue comment 209 … --body-file docs/issue-209-phase-efficiency.md`."
  This is part of the implementer's checks, and Risks repeats "Push first, then
  comment the committed file".
- **Rule.** An outward-facing publication must happen exactly once, from the
  coordinator-approved text, after the issue's review and ballot gates.
- **Concrete failure.** R4.implement's participants are the whole roster:
  claude, codex, cursor and antigravity.
  - All four post during R4.implement, so issue #209 gets four competing
    comments before R5.compare has chosen one.
  - None of them has been reviewed.
  - Any R6 revision then disagrees with all four published comments.
  - The plan has no duplicate check and no marker, so a restarted action
    posts a fifth comment.
- **Smallest correction.** Move posting to the single reviser after the
  R6.ballot approval, which is R7.finalize. Add a marker plus an
  existing-comment check before posting.

### F3 (antigravity plan): Tests, first bullet / Exact File List — a test file change is missing from the file map

- **Plan claim.**
  - Tests says: "Propose adding a focused test suite in
    `test/verify-config.test.ts` verifying that
    `docs/phase-efficiency-proposal.md` exists, contains complete quantitative
    data…".
  - "Exact File List to be changed or deleted" says "None".
- **Rule.** Every path the implementation changes must appear in a file-list
  section. Tests should be focused and must not assert prose or one machine's
  runtime data.
- **Concrete failure.** Followed as written, the implementer either:
  - edits `test/verify-config.test.ts`, which is outside the approved map and
    gets rejected at compare; or
  - skips the only test the plan proposes.

  If the test is added anyway:
  - It asserts specific numbers from local journals that do not exist in CI or
    in other clones.
  - It permanently couples `pnpm check:fast` and `pnpm check:docs` to a dated
    analysis document. `check:docs` runs `test/verify-config.test.ts`, filtered
    with `-t`.
  - It fails as soon as the document is edited or reformatted.
- **Smallest correction.** Drop the test and validate the document by
  reproducing it with `coord analytics`, as the other three plans do.

### F4 (antigravity plan): Conclusion and Risks — conclusions are stated before measuring, and holds are misattributed

- **Plan claim.**
  - Conclusion: the proposal "reveals that over 75% of total elapsed time
    stems from nudge-loop holds and straggler wait states, and proposes 6
    actionable architectural enhancements to shorten phase durations by up to
    60-80%".
  - Risks: "isolating the 950-minute hold in Issue 177 and the 184-minute hold
    in Issue 184".
- **Rule.** Every number in a plan or in the delivered analysis must come from
  the journals, and savings must be labelled as estimates with their
  assumptions. A plan sets the method. It must not fix the conclusions in
  advance.
- **Concrete failure.**
  - 950 and 184 min are the R5.compare and R6.ballot phase durations. The
    holds were 936 min (177, 00:36→16:12) and 176 min (184, 22:20→01:16).
  - An implementer following the plan reports hold durations that are wrong
    by 14 and 8 minutes.
  - The implementer also has to hit "6 proposals" and "60–80%" regardless of
    what the measurements show. No method is given for computing either
    figure.
  - There is no run-selection rule and no pause/phase breakdown method, so
    other agents cannot reproduce the document.
- **Smallest correction.** Replace the predetermined figures with a stated
  method:
  - the selection rule;
  - `coord analytics` per run;
  - per-phase pause overlap.

  Let the number of proposals follow from the data.

### F5 (antigravity plan): Reuse and Scope / Tests — the publication has no timing and no duplicate guard, and `.plans/` is listed as a deliverable

- **Plan claim.**
  - Reuse names `gh issue comment 209 --body-file docs/phase-efficiency-proposal.md`
    but does not say which phase or which agent posts.
  - Tests verifies the comment with `gh issue view 209 --comments`.
  - "Exact file list to be created" includes `.plans/issue-209/plan.md`.
- **Rule.** The same rule as F2: one approved publication. The implementation
  file map lists product deliverables; `.plans/` files are coordination
  artifacts that finalization removes.
- **Concrete failure.**
  - Each of the four implementers satisfies the "Verify successful
    publication" test by posting during R4.implement, which produces the same
    four-comment failure as F2.
  - Listing `.plans/issue-209/plan.md` as an implementation file invites a
    product pin that edits the coordination plan. R7.finalize then deletes the
    file, so the approved implementation's file list no longer matches the
    final tree.
- **Smallest correction.**
  - Name a single publisher after R6.ballot, with a marker and duplicate
    check.
  - Remove `.plans/issue-209/plan.md` from the file list.

### F6 (codex plan): Reuse and Scope, step 7 — the comment is published before the revision it shows is approved

- **Plan claim.** "During `R6.revise`, the coordinator-selected reviser
  consolidates the findings and publishes the single report's comment section
  to #209 … update only the previously identified report comment if a later
  revision changes it."
- **Rule.** The public comment must be the text approved by the final consensus
  ballot. `src/steps.ts` places R6.ballot after every R6.revise round.
- **Concrete failure.**
  - In R6.revise round 1, the reviser posts its revision.
  - If R6.ballot round 1 rejects it, the unapproved text is already public on
    #209. The 177 run did reach a second R6 round.
  - If the run ends in R6.follow-up with objections still open, the published
    comment stays as text that consensus never accepted.
  - The receipt with the comment URL lives inside the pinned file, which
    forces posting to happen before the revision commit. That locks
    publication ahead of the ballot.
- **Smallest correction.**
  - Post in R7.finalize, which handles the authorized revision, using the
    plan's existing marker, paginated duplicate check and body readback.
  - Report the URL in the finalization evidence or the PR body rather than in
    the pinned document.

### F7 (claude plan, self-review): Risks / Reuse hypotheses — pauses are attributed to "owner absence" instead of holds created by the coordinator

- **Plan claim.**
  - Hypothesis: "Owner absence and pauses dominate elapsed time (for example,
    177 has 969 min paused, and 184 spends 184 min in R6.ballot waiting on one
    agent)".
  - Risks: "handles owner absence as its own proposal, not as agent slowness".
- **Rule.** Time must be attributed to its recorded cause. Every cohort pause
  is a coordinator `hold-created` on cursor (reason `nudge-loop` or
  `delivery-uncertain`), and per-phase durations include that paused time.
- **Concrete failure.** Following the plan produces an "owner absence"
  proposal, such as owner alerting. The recorded trigger, however, is one agent
  (cursor) repeatedly consuming its nudge budget: 5 of 5 holds. The proposal
  that would actually shorten these runs is never ranked. That proposal is to
  diagnose cursor's deferral codes before the nudge-loop hold, or to drop or
  quorum a looping agent. Also, "184 min in R6.ballot" is presented as agent
  waiting even though 176 of those minutes are paused.
- **Smallest correction.**
  - Report pause minutes per phase, broken down by `hold-created` reason and
    agent.
  - Treat time to owner release as a separate, secondary component.

### F8 (claude plan, self-review): Reuse and Scope, Publishing — posting is gated on a coordinator step the finalizer cannot observe

- **Plan claim.** "During R7.finalize, after final checks pass, the finalizing
  agent posts…"
- **Rule.** An agent can act only on conditions visible inside its own action.
  The coordinator runs `final-check` after the finalizer publishes its
  `finalization-ready` signal, and then creates the PR. In 204, `final-check`,
  `publication-pending` and `pr-created` are sequences 764–767.
- **Concrete failure.** The finalizer never sees a passed final check inside
  R7.finalize. Read literally, it either waits indefinitely or skips posting,
  and then falls back to an owner post that the issue did not ask for.
- **Smallest correction.** Post during R7.finalize, which handles the revision
  R6.ballot authorized, using the approved file and a duplicate check. Do not
  condition posting on coordinator final checks.

### F9 (cursor plan, minor): Reuse and Scope, first paragraph — the stated order contradicts the listed order

- **Plan claim.** "In createdAt order they are 206 (solo), 204, 184, 195, and
  177."
- **Rule.** Run ordering stated as fact must match `createdAt`. Ascending order
  is 177, 195, 184, 204, 206.
- **Concrete failure.** A table or narrative built from this sentence presents
  descending order as `createdAt` order. That reverses claims such as "the most
  recent runs improved", which leads straight to wrong trend conclusions. The
  set of runs is correct, so this is minor.
- **Smallest correction.** Say "newest first", or list the runs in ascending
  order.

## Conclusion

Scope is right in every plan: one new document, no product, test or
configuration changes, no implementation of the proposals, and no
configuration edits to dodge hooks. The exception is antigravity's
out-of-map test file (F3).

**Ranking for selection: codex, then claude, then cursor, then antigravity.**

1. **codex** has the strongest method:
   - it cites sequence evidence;
   - it uses the union of runner intervals clipped per phase;
   - it checks whether a proposed improvement already exists before
     recommending it;
   - its publication protocol has a marker, paginated duplicate check and
     readback.

   It needs F6, posting after R6.ballot, and F1.
2. **claude** has a sound method and the same publication safeguards. It needs
   F1, F7 and F8.
3. **cursor** has correct per-phase pause semantics and evidence thresholds for
   each proposal. However, F2 would publish four unreviewed comments, so it
   must not be selected without that correction.
4. **antigravity** should not be selected. Its numbers are fixed in advance
   and some are wrong (F4), it changes a test outside the file map (F3), and
   its publication is unguarded (F5).

Whichever plan is selected must answer the owner's R1.join question with a
per-agent breakdown (F1) and publish exactly once, from the text R6.ballot
approved.
