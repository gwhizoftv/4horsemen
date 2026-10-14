# Issue 209 efficiency analysis

Candidate report for the selected plan. The comment payload begins at the marker below and ends before Publication receipt. This implementation does not post to GitHub.

Measured with `coord` 0.0.65 from `<coord-runtime>`, the `coordRoot` in issue 209's start record. Machine paths are omitted so the doc stays portable. Cohort cutoff is issue 209 `start.json` `createdAt` `2026-10-14T03:55:51.161Z`. Issue text: analyze the last five `coord <issue>` runs and propose ways to shorten phases, as a comment on issue 209.

## Source inventory

| Issue | Session | Baseline | Profile | Roster | Journal sha256 | Start sha256 | Terminal gate sequence |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 177 | `issue-177:8d38734a93bc374560d2728e8cff6f9636181585` | `8d38734a93bc374560d2728e8cff6f9636181585` | consensus | claude, codex, cursor, antigravity | `36bcaddf0125205122803bfab15eb4f4eec60a2cad2e7749217e91c077690d86` | `428991d6179d8024aefb50c06696266e2ee6631ac406dc262a65166e9fd8ecf0` | 3418 |
| 195 | `issue-195:6a04d57e524ad53daa082568e146c5300e93dfeb` | `6a04d57e524ad53daa082568e146c5300e93dfeb` | consensus | claude, codex, cursor | `652a589df2786f373daadf2c45aea03e9f4d82a022540826cfc9a90fffcc0f16` | `8b7feadbb1e1ed5c3b93c249601040889928cc23c85dac13247b845cec513591` | 723 |
| 184 | `issue-184:0e0a07b93b61be5f76224650468d50c3bbf06d5d` | `0e0a07b93b61be5f76224650468d50c3bbf06d5d` | consensus | claude, codex, cursor | `6d4c349f512c1d5ad68b1f7d21736647518097de1d60bbd6c83cc6f803243c49` | `9191e256e87c6c03c81879ead39a7629a6eb7b485f33154ac90c398dc7b37c57` | 625 |
| 204 | `issue-204:855982b3f1639ec5bac7891f1c67f1e100dc2ab3` | `855982b3f1639ec5bac7891f1c67f1e100dc2ab3` | consensus | claude, codex, cursor | `22964e3682553800c51fc83a43c7c51ae342c8f61176826d8a76ce4473211016` | `dcd7684644766c4dc0f996151a714d33ae546ed36848b215568dd8e8999a3fa0` | 768 |
| 206 | `issue-206:5217f5ccad04d7664d81529e51191e6e053e2e1a` | `5217f5ccad04d7664d81529e51191e6e053e2e1a` | solo | claude | `67f0cdef40d1803bb2aa5763d2c46512e4ef6c2009ec394a27cf604f6f5d254e` | `ab4e7f09f4871981b623879ff72be159c5421f3e8e54d490ce52b5687640408e` | 71 |

Each frozen `checks` list is the single command `check`. `documentation` is null on every start record. A later `agent-lifecycle` event is not the run end (177 ends at sequence 3418 and has one later lifecycle record).

`issue-N/verification-logs/` has one log each (177: 80168 bytes, 195: 79721, 184: 83390, 204: 87332, 206: 86304). Terminal logs exist only for 184, 204, and 206 (`agents/<agent>/terminal/run-*.log`). Issues 177 and 195 have no terminal directory. Those logs are raw pane bytes, so they are not used as clocks.

## Reproduction

Official phase, wait, and verification figures are the output of:

```sh
coord analytics --issue N --coord-runtime <coord-runtime>
```

for N in 177, 195, 184, 204, 206. The #206 smoke line in the plan matches this tree: 18.98 elapsed minutes, four phases, final check 171.7s.

Independent phase math, checked against that output:

- A phase runs from the previous boundary to each `gate-advanced`. The name is `details.from`. The run starts at the `started` event. It ends at the gate whose `details.to` is null.
- Pause spans follow `derivePausedMs`: a second `paused` while one is open does not nest, and a `resumed` with no open pause is ignored. Each span is clipped to the phase. Per-phase pause sums equal run pause. Phase elapsed sums equal terminal time minus start (difference under 1 ms) for every run, including 177's two R6 rounds, 184's paused phases, 204's empty pause list, and 206's four solo gates.
- Displayed minutes are `duration / 60000` to two decimals, the same rounding as `renderAnalytics`. Unpaused is elapsed minus pause on the unrounded seconds. A displayed subtraction can differ by 0.01 min.
- Median for four consensus runs is the value at index `floor(n/2)` after sorting ascending, the same index `src/analytics.ts` uses. That is the third of four values. Solo 206 is not in those medians. Sample size is 4 unless noted.
- Action joins are per `(agent, actionId)`: first `action-prepared`, first `nudged` (later nudges do not move it), following `intent-seen`, then `verify-result` or `response-accepted`. Missing ends stay missing. `intent-seen` is written when the coordinator reads the completion marker (`src/runLoop.ts` around the git completion path and the ballot response path). It is not the start of agent work. Nudge-to-intent therefore includes the agent turn. Intent-to-verify is coordinator acceptance after that marker and is usually under a second on git actions. Concurrent agents are not added into the phase total. Acceptance spread is first acceptance to last acceptance, wall clock, and it includes any pause inside that gap.

<!-- coord-issue-209-analysis -->

# Phase length of the last five coord runs

## Cohort

Chronological order by `start.json` `createdAt`, excluding older issue 172 and in-progress issue 209:

| Issue | Started (UTC) | Profile | Elapsed min | Paused min | Unpaused min |
| --- | --- | --- | ---: | ---: | ---: |
| 177 | 2026-10-10T22:48:18.145Z | consensus | 1072.90 | 969.47 | 103.43 |
| 195 | 2026-10-12T22:43:41.151Z | consensus | 74.08 | 2.68 | 71.41 |
| 184 | 2026-10-13T20:31:20.486Z | consensus | 290.67 | 232.62 | 58.04 |
| 204 | 2026-10-14T01:55:48.449Z | consensus | 79.72 | 0.00 | 79.72 |
| 206 | 2026-10-14T03:24:28.568Z | solo | 18.98 | 0.00 | 18.98 |

Elapsed and paused match `coord analytics`. Issue 206 is one solo task. It is not a speed multiplier for the consensus runs.

## Phase table

Cell shape is elapsed / pause / unpaused, in minutes. `n/a` means that profile never entered the phase. Analytics action counts are in the source inventory's gate table below, and they match `coord analytics`.

| Phase | 177 | 195 | 184 | 204 | Median unpaused (n=4) | 206 |
| --- | --- | --- | --- | --- | ---: | --- |
| R1.join | 21.29 / 17.01 / 4.28 | 0.97 / 0 / 0.97 | 1.32 / 0 / 1.32 | 1.83 / 0 / 1.83 | 1.83 | 0.73 / 0 / 0.73 |
| R2.plan | 8.12 / 0 / 8.12 | 8.03 / 0 / 8.03 | 6.18 / 0 / 6.18 | 8.60 / 0 / 8.60 | 8.12 | 4.14 / 0 / 4.14 |
| R3.review | 29.20 / 16.50 / 12.70 | 6.28 / 0 / 6.28 | 5.14 / 0 / 5.14 | 5.14 / 0 / 5.14 | 6.28 | n/a |
| R3.plan-ballot | 0.85 / 0 / 0.85 | 11.65 / 2.68 / 8.98 | 0.89 / 0 / 0.89 | 1.90 / 0 / 1.90 | 1.90 | n/a |
| R4.implement | 40.51 / 0 / 40.51 | 20.26 / 0 / 20.26 | 76.38 / 56.62 / 19.76 | 34.12 / 0 / 34.12 | 34.12 | 10.11 / 0 / 10.11 |
| R5.compare | 950.65 / 935.95 / 14.70 | 6.92 / 0 / 6.92 | 5.95 / 0 / 5.95 | 8.42 / 0 / 8.42 | 8.42 | n/a |
| R5.compare-ballot | 4.98 / 0 / 4.98 | 5.48 / 0 / 5.48 | 0.51 / 0 / 0.51 | 5.00 / 0 / 5.00 | 5.00 | n/a |
| R6.revise round 1 | 2.13 / 0 / 2.13 | 9.31 / 0 / 9.31 | 4.55 / 0 / 4.55 | 5.41 / 0 / 5.41 | 5.41 | n/a |
| R6.ballot round 1 | 0.59 / 0 / 0.59 | 0.84 / 0 / 0.84 | 183.97 / 176.01 / 7.97 | 3.13 / 0 / 3.13 | 3.13 | n/a |
| R6.revise round 2 | 8.82 / 0 / 8.82 | n/a | n/a | n/a | n=1 | n/a |
| R6.ballot round 2 | 1.27 / 0 / 1.27 | n/a | n/a | n/a | n=1 | n/a |
| R7.finalize | 4.50 / 0 / 4.50 | 4.35 / 0 / 4.35 | 5.77 / 0 / 5.77 | 6.17 / 0 / 6.17 | 5.77 | 4.00 / 0 / 4.00 |

Consensus rank by median unpaused time: R4.implement 34.12, R5.compare 8.42, R2.plan 8.12, R3.review 6.28, R7.finalize 5.77, R6.revise round 1 5.41, R5.compare-ballot 5.00, R6.ballot round 1 3.13, R3.plan-ballot 1.90, R1.join 1.83. Elapsed rank is different because three holds dominate it: 177 R5.compare, 184 R6.ballot round 1, and 184 R4.implement.

`coord analytics` phase lines include pause. The run line already separates it. A 950.65 min compare is 14.70 min unpaused.

## Holds

Every `paused` span in the cohort is one `hold-created` / `hold-released` pair. The held agent is cursor on all five.

| Issue | Phase | Reason | Seconds | Sequences | When (UTC) |
| --- | --- | --- | ---: | --- | --- |
| 177 | R1.join | delivery-uncertain | 1020.815 | 9–24 | 22:48:21Z–23:05:22Z |
| 177 | R3.review | nudge-loop | 990.133 | 771–773 | 23:25:36Z–23:42:06Z |
| 177 | R5.compare | nudge-loop | 56157.287 | 2999–3003 | 00:36:06Z–16:12:03Z next day |
| 195 | R3.plan-ballot | nudge-loop | 160.598 | 258–260 | 23:06:46Z–23:09:27Z |
| 184 | R4.implement | nudge-loop | 3397.040 | 288–310 | 20:52:42Z–21:49:19Z |
| 184 | R6.ballot round 1 | nudge-loop | 10560.431 | 585–590 | 22:20:05Z–01:16:05Z next day |

204 and 206 have no holds. Deferral counts are not themselves delay. The most common `nudge-deferred` code is `working` (177: 33, 195: 24, 184: 20, 204: 23, 206: 4). `no-idle-sentinel` is next on every run. Analytics max nudge-to-intent values such as 177 cursor 57036.1s and 184 cursor 11034.5s are the first-nudge anchor carried across these holds. They are not minutes of typing.

## Joins on the long unpaused phase

R4.implement, issue 204, no pause, phase 34.12 min, gate sequence 538. Intent-to-verify is coordinator acceptance after the marker. The hook's `check:fast` / `test:e2e` time sits inside nudge-to-intent, because the agent commits before the marker exists.

| Agent | Sequences (nudge, intent, verify) | Nudge to intent (s) | Intent to verify (s) |
| --- | --- | ---: | ---: |
| claude | 268, 313, 314 | 673.828 | 0.814 |
| codex | 271, 420, 421 | 1046.821 | 1.039 |
| cursor | 279, 535, 537 | 2043.694 | 0.752 |

Cursor's verify-result at sequence 537 is the last acceptance. The first-to-last acceptance spread is 1372.0s inside the same 34.12 min phase. That spread is not an extra 23 min on top of the phase, and it is not the sum of the three turns. Recorded runner union clipped to this phase is 471.1s, so most of the 34 min is outside the recorded test commands.

The same shape shows up elsewhere with no pause: 204 R1.join is 1.83 min and cursor is last (nudge 10, intent 72, verify 75; nudge-to-intent 104.923s; intent-to-verify 0.513s). 177 R4.implement has no pause and antigravity is last (verify sequence 2890); the acceptance spread is 1307.3s inside 40.51 min.

## R1.join

Inside the cohort, join exceeds two minutes only on 177: 21.29 elapsed, 17.01 paused, 4.28 unpaused. The pause is the delivery-uncertain hold on cursor, sequences 9–24. Codex was nudged at sequence 6, before the hold, and its 1023.8s nudge-to-intent includes that hold. Claude's first nudge is sequence 26, after release, so 1024.2s of prep-to-nudge is the hold blocking delivery. After release, intent-to-verify is about half a second for each agent. The other cohort joins are 0.97, 1.32, 1.83, and 0.73 min, with no pause.

Supplemental, not in the five-run medians or the median column: issue 209's own join is already closed, 159.956s from `started` at `2026-10-14T03:55:51.161Z` to gate sequence 165 at `2026-10-14T03:58:31.117Z`. No pause. All four first nudges are within about 8s of start.

| Agent | Sequences (nudge, intent, verify) | Nudge to intent (s) | Intent to verify (s) |
| --- | --- | ---: | ---: |
| claude | 6, 41, 43 | 18.525 | 1.641 |
| codex | 10, 87, 89 | 60.830 | 0.643 |
| cursor | 12, 99, 104 | 70.122 | 0.504 |
| antigravity | 17, 161, 164 | 151.162 | 0.558 |

The gate moved 19ms after antigravity's verify-result. The eight recorded precommit and prepush observations in that interval have `command: null` and skip reason `coordination evidence only`, so the product suites did not run. The journal does not split antigravity's 151s into reading, tools, commit, and push. The two minutes are the slowest participation commit, not coordinator validation after the marker.

## Verification

`coord analytics`, reused results 0 and time avoided 0.0s on every run. Queue wait 0. Final checks all exit 0. Commands actually executed are hook `check:fast` (precommit), hook `test:e2e` (prepush), and coordinator `check` (finalization). Skipped rows are observations with `command: null`. Manual commands are unobserved. Runner union below is clipped to the phase and is not added to the final-check duration; the final-check seconds are the finalization runner.

| Issue | Runners | Skipped | Aggregate s | Critical-path s | Final check s | Share of unpaused run |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 177 | 13 | 44 | 903.6 | 875.0 | 146.0 | 14% |
| 195 | 10 | 31 | 740.7 | 670.5 | 151.9 | 16% |
| 184 | 7 | 32 | 555.3 | 555.3 | 166.9 | 16% |
| 204 | 10 | 31 | 783.7 | 783.7 | 182.7 | 16% |
| 206 | 4 | 8 | 420.8 | 420.8 | 171.7 | 37% |

Failed hook attempts, counted inside those runner totals, not as a separate phase: 177 `check:fast` sequences 2784 (exit 2) and 2819 (exit 1); 195 sequence 487 (exit 2); 204 sequence 345 (exit 1). 184 and 206 recorded no non-zero runner exit.

Implement unions: 177 610.0s of a 40.51 min phase, 195 400.4s of 20.26 min, 184 388.5s of 19.76 unpaused min, 204 471.1s of 34.12 min, 206 249.1s of 10.11 min. Finalize is mostly the one final `check`: 146.0s of 4.50 min, 151.9s of 4.35, 166.9s of 5.77, 182.7s of 6.17, 171.7s of 4.00.

Ballot publication is not the cost. Evidence-publication median is 1.8s (177, n=4), 2.1s (204, n=3), and at most 4.9s. 206 has no ballot batch.

Token coverage is partial or unavailable. Token totals are not used as evidence for any proposal.

## Proposals

Savings are estimates. They are not added together. Review, comparison, and verification gates stay.

1. **Cursor holds are the elapsed-time outliers. Measure them per phase, and treat a nudge-loop hold as the thing to shorten.** Evidence: the six holds above, all naming cursor. 177 is paused 969.47 of 1072.90 min. 184 is paused 232.62 of 290.67 min. 195 is paused 2.68 of 74.08 min. Four holds are `nudge-loop` and one is `delivery-uncertain`. The current run line already subtracts pause; the phase line does not (`derivePhases` versus `derivePausedMs`). Printing per-phase pause does not shorten the run. It stops a 950 min compare from being read as work. The wall-clock question is why cursor's nudge budget ends in a hold while `working` is the dominant deferral code. The overnight minutes are owner-release time after the hold exists, so a code change does not automatically recover 969 min. Confidence: high on the measurement, medium on the deferral mechanism, low on recovering the whole pause. Validation for the next four consensus runs: recorded pause under 3 min unless the owner pauses on purpose, and `coord analytics` phase lines show pause separately. Do not add this figure to the verification estimate.

2. **Unpaused time is mostly R4.implement, and the gate is the slowest agent, not the test runner.** Median unpaused implement is 34.12 min (n=4), about four times the next phase. On 204, cursor's submission turnaround is 2043.7s against Claude's 673.8s on the same action, and intent-to-verify is under 1.1s. Clipped runner union on that phase is 471s. Shortening the phase means shortening the slowest submission, not deleting the implement gate and not double-counting the 22.9 min acceptance spread. Confidence: medium. Validation: the next consensus R4 unpaused time is at most 20 min (the 184 and 195 band), or the last agent's nudge-to-intent is within 1.5 times the median of the others. Risk: nudging an agent that is actually working.

3. **Final `check` repeats hook work, and receipt reuse recorded nothing.** The coordinator already has `verification-reused` and avoided-time accounting. All five runs show reused 0 and avoided 0.0s. Final checks are 146–183s and are most of R7.finalize. If a final `check` can be satisfied by hook receipts for the same tree, the estimate is those 2.4–3.0 min per run and not also the hook time. On consensus runs the whole verification critical path is 14–16% of unpaused time, so this is smaller than implement and smaller than the holds. On solo 206 it is 37% of an 18.98 min run (420.8s), which is one short run, not a consensus formula. Confidence: medium. Validation: a later run reports reused greater than 0 and a final runner near 0s when the hooked commands already passed. Risk: skipping a final check whose tree does not match the receipt.

4. **Profile choice already exists. One solo run does not price it.** Issue 206 took 18.98 unpaused minutes and four phases. Consensus unpaused runs took 58–103 min, and the median ceremony outside R4.implement is several minutes per phase. Those are different tasks. The owner can already start a small issue as solo or reviewed. This proposal does not remove consensus steps and does not claim a minute saving. Validation is the owner's profile choice, not a new code path.

Not proposed: issue 177's high-frequency lifecycle `status` and `working` records. Those kinds are absent on 184, 195, 204, and 206. Not proposed: ballot publication, which is a few seconds. Not proposed: a quorum that stops waiting for the last R1 agent. On 209 that would shrink the join toward the next-slowest turn (about 70s) by abandoning a participation requirement. The participation gate stays.

## Publication receipt

Not posted. This file is one implementation candidate. The selected plan says not to post competing comments during implementation. The selected reviser publishes the comment section, from the marker through the proposal section above, during R6.revise, after checking existing issue comments and updating only a comment that already carries `<!-- coord-issue-209-analysis -->`. No comment URL exists yet. A pull request does not replace that comment.
