<!-- coord-issue-209-analysis -->
# Shortening coordinator phases: five recent runs

The first priority is reducing time spent waiting for delivery recovery. Across
the five most recent prior runs, **1,204.77 of 1,536.36 elapsed minutes (78.42%)**
were recorded pauses. Six holds caused those pauses, all associated with Cursor:
five `nudge-loop` holds and one `delivery-uncertain` hold. This measures time
until recovery, not proof that the owner was absent or the agent was computing.

Among the four consensus runs, **R4.implement accounts for 36.68% of unpaused
time**, followed by R5.compare at 11.51%. Recorded verification explains some of
that time, but its overlap with unpaused time is only 10.50–16.38% of the whole
consensus run. Prioritize delivery and submission-turnaround diagnosis, then use
the existing verification-receipt machinery where input equivalence is proved.

For the owner's join question, **#209's completed R1.join took 159.956 seconds**.
Every agent had been nudged within 8.217 seconds; Antigravity's submission arrived
151.162 seconds after its nudge. Its validation took 0.558 seconds and the gate
advanced 0.019 seconds later. No product checks ran in that join. The measured
bottleneck was the final readiness submission; its internal reading, tool, and
Git costs are not separately timed by these journal events.

## Cohort and measurement rules

The cutoff is #209's start, `2026-10-14T03:55:51.161Z`. The last five prior
starts in this workspace, ordered by `start.json.createdAt`, are #177, #195,
#184, #204, and #206. All completed. #172 is older and excluded; #209 appears
only as a supplemental, already-closed join interval. Issue numbers are not
chronological. The source root is written as `<coord-runtime>` below.

All five starts use runtime format 4. Roster abbreviations are C=Claude,
X=Codex, U=Cursor, A=Antigravity. Durations are minutes except where seconds are
explicitly stated. Values are rounded only for display.

| Issue | Start UTC | Profile / roster | Elapsed | Paused | Unpaused | Terminal sequence |
| --- | --- | --- | --- | --- | --- | --- |
| 177 | 2026-10-10T22:48:18.145Z | consensus / C,X,U,A | 1072.90 | 969.47 | 103.43 | 3418 |
| 195 | 2026-10-12T22:43:41.151Z | consensus / C,X,U | 74.08 | 2.68 | 71.41 | 723 |
| 184 | 2026-10-13T20:31:20.486Z | consensus / C,X,U | 290.67 | 232.62 | 58.04 | 625 |
| 204 | 2026-10-14T01:55:48.449Z | consensus / C,X,U | 79.72 | 0.00 | 79.72 | 768 |
| 206 | 2026-10-14T03:24:28.568Z | solo / C | 18.98 | 0.00 | 18.98 | 71 |

The four consensus runs total **312.60 unpaused minutes**; solo #206 contributes
another 18.98. Its shorter, different task and one-agent roster are not a
controlled experiment showing the benefit of changing profiles.

Reproduction uses `coord analytics` version **0.0.65**, checked against the
existing `readAnalyticsRuntime`, `buildAnalytics`, and `renderAnalytics`
implementations. Definitions for the independent calculation:

- A phase spans `started` or the previous `gate-advanced` through its closing
  `gate-advanced`; the terminal gate, not later lifecycle traffic, ends a run.
  Preserve R6 round numbers. All listed phases have complete boundaries.
- Pair `paused` with `resumed`, ignore duplicate opens and unmatched closes,
  union the intervals, and intersect them with each phase. Unpaused means elapsed
  minus recorded pauses; it does not mean CPU time or uninterrupted agent work.
- Match actions by agent and action UUID. Preparation-to-first-recorded-nudge
  measures recorded delivery delay. First outstanding nudge-to-`intent-seen`
  measures submission turnaround, including reading, work, local verification,
  Git operations and waits. `intent-seen` observes a completion marker, not task
  pickup. Its interval to successful `verify-result` measures coordinator
  validation; ballot acceptance uses `response-accepted`.
- A repeat nudge does not reset an outstanding interval. Missing nudge records
  yield unavailable delivery/turnaround values, not zero; self-pickup or an
  unrecorded/manual delivery may still lead to a valid submission.
- Ballot response latency and batch pending-to-published latency are separate.
  Concurrent agents' turnaround and first-to-last acceptance spread are not
  added to phase duration.
- Count executed `verification-run` records with a non-null command, including
  failed attempts. Sum their command durations for runner effort; union their
  start/end intervals, including recorded limiter queue wait, for wall overlap.
  Clip to each phase and also intersect with unpaused time. Do not count the
  execution again from its `final-check` summary. Hook observations are advisory;
  manually run commands have no guaranteed telemetry.
- Across-run phase medians use the ordinary middle value, or the mean of the
  middle two. Repeated R6 rounds are summed within each run first. The CLI's
  agent-latency medians use its existing upper-middle convention; those are
  separate statistics and are not averaged into an issue-wide agent metric.

## Every observed phase

V is the union of recorded executing verification intervals overlapping the
phase, not an extra additive category. V-unpaused excludes overlap with recorded
pauses. Last identifies the last accepted required action, including the
finalizer where it is the only participant. Sequence pairs refer to
`issue-N/journal.jsonl`; the number after each agent is its acceptance event.
Finalization acceptance includes coordinator final checks.

### Issue 177

| Phase | Elapsed | Paused | Unpaused | V | V-unpaused | Actions | Last | Boundary sequences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1.join | 21.29 | 17.01 | 4.28 | 0.00 | 0.00 | 4 | cursor @177 | 0–178 |
| R2.plan | 8.12 | 0.00 | 8.12 | 0.00 | 0.00 | 4 | cursor @637 | 178–638 |
| R3.review | 29.20 | 16.50 | 12.70 | 0.00 | 0.00 | 4 | cursor @802 | 638–803 |
| R3.plan-ballot | 0.85 | 0.00 | 0.85 | 0.00 | 0.00 | 4 | codex @878 | 803–883 |
| R4.implement | 40.51 | 0.00 | 40.51 | 10.17 | 10.17 | 4 | antigravity @2890 | 883–2891 |
| R5.compare | 950.65 | 935.95 | 14.69 | 0.00 | 0.00 | 4 | cursor @3100 | 2891–3101 |
| R5.compare-ballot | 4.98 | 0.00 | 4.98 | 0.00 | 0.00 | 4 | cursor @3195 | 3101–3200 |
| R6.revise r1 | 2.13 | 0.00 | 2.13 | 0.00 | 0.00 | 1 | codex @3226 | 3200–3227 |
| R6.ballot r1 | 0.59 | 0.00 | 0.59 | 0.00 | 0.00 | 4 | cursor @3273 | 3227–3277 |
| R6.revise r2 | 8.82 | 0.00 | 8.82 | 1.98 | 1.98 | 1 | codex @3312 | 3277–3313 |
| R6.ballot r2 | 1.27 | 0.00 | 1.27 | 0.00 | 0.00 | 4 | cursor @3392 | 3313–3397 |
| R7.finalize | 4.50 | 0.00 | 4.50 | 2.43 | 2.43 | 1 | codex @3415 | 3397–3418 |

### Issue 195

| Phase | Elapsed | Paused | Unpaused | V | V-unpaused | Actions | Last | Boundary sequences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1.join | 0.97 | 0.00 | 0.97 | 0.00 | 0.00 | 3 | cursor @58 | 0–59 |
| R2.plan | 8.03 | 0.00 | 8.03 | 0.00 | 0.00 | 3 | cursor @157 | 59–158 |
| R3.review | 6.28 | 0.00 | 6.28 | 0.00 | 0.00 | 3 | cursor @225 | 158–226 |
| R3.plan-ballot | 11.65 | 2.68 | 8.98 | 0.00 | 0.00 | 3 | cursor @272 | 226–278 |
| R4.implement | 20.26 | 0.00 | 20.26 | 6.67 | 6.67 | 3 | cursor @529 | 278–530 |
| R5.compare | 6.92 | 0.00 | 6.92 | 0.00 | 0.00 | 3 | codex @606 | 530–607 |
| R5.compare-ballot | 5.48 | 0.00 | 5.48 | 0.00 | 0.00 | 3 | cursor @638 | 607–643 |
| R6.revise r1 | 9.31 | 0.00 | 9.31 | 1.97 | 1.97 | 1 | codex @659 | 643–660 |
| R6.ballot r1 | 0.84 | 0.00 | 0.84 | 0.00 | 0.00 | 3 | cursor @696 | 660–702 |
| R7.finalize | 4.35 | 0.00 | 4.35 | 2.53 | 2.53 | 1 | codex @720 | 702–723 |

### Issue 184

| Phase | Elapsed | Paused | Unpaused | V | V-unpaused | Actions | Last | Boundary sequences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1.join | 1.32 | 0.00 | 1.32 | 0.00 | 0.00 | 3 | cursor @60 | 0–61 |
| R2.plan | 6.18 | 0.00 | 6.18 | 0.00 | 0.00 | 3 | cursor @164 | 61–165 |
| R3.review | 5.14 | 0.00 | 5.14 | 0.00 | 0.00 | 3 | cursor @226 | 165–227 |
| R3.plan-ballot | 0.89 | 0.00 | 0.89 | 0.00 | 0.00 | 3 | codex @259 | 227–263 |
| R4.implement | 76.38 | 56.62 | 19.76 | 6.47 | 3.31 | 3 | cursor @416 | 263–417 |
| R5.compare | 5.95 | 0.00 | 5.95 | 0.00 | 0.00 | 3 | cursor @503 | 417–504 |
| R5.compare-ballot | 0.51 | 0.00 | 0.51 | 0.00 | 0.00 | 3 | codex @531 | 504–535 |
| R6.revise r1 | 4.55 | 0.00 | 4.55 | 0.00 | 0.00 | 1 | codex @556 | 535–557 |
| R6.ballot r1 | 183.97 | 176.01 | 7.97 | 0.00 | 0.00 | 3 | cursor @598 | 557–603 |
| R7.finalize | 5.77 | 0.00 | 5.77 | 2.78 | 2.78 | 1 | codex @622 | 603–625 |

### Issue 204

| Phase | Elapsed | Paused | Unpaused | V | V-unpaused | Actions | Last | Boundary sequences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1.join | 1.83 | 0.00 | 1.83 | 0.00 | 0.00 | 3 | cursor @75 | 0–76 |
| R2.plan | 8.60 | 0.00 | 8.60 | 0.00 | 0.00 | 3 | cursor @176 | 76–177 |
| R3.review | 5.14 | 0.00 | 5.14 | 0.00 | 0.00 | 3 | cursor @228 | 177–229 |
| R3.plan-ballot | 1.90 | 0.00 | 1.90 | 0.00 | 0.00 | 3 | cursor @260 | 229–265 |
| R4.implement | 34.12 | 0.00 | 34.12 | 7.85 | 7.85 | 3 | cursor @537 | 265–538 |
| R5.compare | 8.42 | 0.00 | 8.42 | 0.00 | 0.00 | 3 | codex @628 | 538–629 |
| R5.compare-ballot | 5.00 | 0.00 | 5.00 | 0.00 | 0.00 | 3 | cursor @664 | 629–668 |
| R6.revise r1 | 5.41 | 0.00 | 5.41 | 2.16 | 2.16 | 1 | codex @690 | 668–691 |
| R6.ballot r1 | 3.13 | 0.00 | 3.13 | 0.00 | 0.00 | 3 | cursor @740 | 691–744 |
| R7.finalize | 6.17 | 0.00 | 6.17 | 3.05 | 3.05 | 1 | codex @765 | 744–768 |

### Issue 206

| Phase | Elapsed | Paused | Unpaused | V | V-unpaused | Actions | Last | Boundary sequences |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| R1.join | 0.73 | 0.00 | 0.73 | 0.00 | 0.00 | 1 | claude @14 | 0–15 |
| R2.plan | 4.14 | 0.00 | 4.14 | 0.00 | 0.00 | 1 | claude @32 | 15–33 |
| R4.implement | 10.11 | 0.00 | 10.11 | 4.15 | 4.15 | 1 | claude @52 | 33–53 |
| R7.finalize | 4.00 | 0.00 | 4.00 | 2.86 | 2.86 | 1 | claude @68 | 53–71 |

Solo #206 never entered R3.review, R3.plan-ballot, R5.compare,
R5.compare-ballot, R6.revise, or R6.ballot: those phases are **N/A**, not zero.
No cohort run entered the amendment or follow-up phase. #177 required two R6
rounds; the other consensus runs required one.

### Where consensus unpaused time accumulates

Each row has four run-level samples; shares use 312.60 total unpaused minutes.

| Rank | Phase | Total unpaused minutes | Median per run | Share |
| --- | --- | --- | --- | --- |
| 1 | R4.implement | 114.66 | 27.19 | 36.68% |
| 2 | R5.compare | 35.99 | 7.67 | 11.51% |
| 3 | R2.plan | 30.92 | 8.07 | 9.89% |
| 4 | R6.revise | 30.22 | 7.36 | 9.67% |
| 5 | R3.review | 29.25 | 5.71 | 9.36% |
| 6 | R7.finalize | 20.79 | 5.14 | 6.65% |
| 7 | R5.compare-ballot | 15.96 | 4.99 | 5.11% |
| 8 | R6.ballot | 13.79 | 2.49 | 4.41% |
| 9 | R3.plan-ballot | 12.62 | 1.40 | 4.04% |
| 10 | R1.join | 8.40 | 1.58 | 2.69% |

## Delivery, pauses, and slow submissions

### Six holds account for the recorded pauses

| Issue / phase | Reason / agent | Hold → resume UTC | Pause minutes | Hold / pause / resume sequences |
| --- | --- | --- | --- | --- |
| 177 / R1.join | delivery-uncertain / cursor | 2026-10-10T22:48:21.616Z → 2026-10-10T23:05:22.431Z | 17.01 | 9 / 10 / 25 |
| 177 / R3.review | nudge-loop / cursor | 2026-10-10T23:25:36.554Z → 2026-10-10T23:42:06.687Z | 16.50 | 771 / 772 / 774 |
| 177 / R5.compare | nudge-loop / cursor | 2026-10-11T00:36:06.447Z → 2026-10-11T16:12:03.734Z | 935.95 | 2999 / 3000 / 3004 |
| 195 / R3.plan-ballot | nudge-loop / cursor | 2026-10-12T23:06:46.608Z → 2026-10-12T23:09:27.206Z | 2.68 | 258 / 259 / 261 |
| 184 / R4.implement | nudge-loop / cursor | 2026-10-13T20:52:42.102Z → 2026-10-13T21:49:19.142Z | 56.62 | 288 / 289 / 311 |
| 184 / R6.ballot | nudge-loop / cursor | 2026-10-13T22:20:05.494Z → 2026-10-14T01:16:05.925Z | 176.01 | 585 / 586 / 591 |

#177's R5.compare was 950.65 minutes, but the associated pause was 935.95;
#184's R6.ballot was 183.97 minutes, but its pause was 176.01. Using whole
phase lengths as hold durations overstates the delay.

The five nudge-loop holds followed repeated sends, not merely deferral records.
For example, #184 R6.ballot records Cursor sends at sequences 565, 579, 581,
and 583, an `idle-transition-already-used` deferral at 567, and the hold at 585.
#195 R3.plan-ballot similarly records repeated sends through 256, a hold at
258, and resumption at 261. A deferred-send count is neither a retry count nor
a duration. It cannot establish that typing into a live pane was safe.

### Evidence by action, not a presumed thinking interval

Selected action breakdowns use seconds. P/N/I/A are preparation, first recorded
nudge, intent, and acceptance sequence numbers. Pauses remain inside these
elapsed action intervals; use the phase pause table to interpret them.

| Issue / phase / agent | P → N (s) | N → I (s) | I → A (s) | Sends | P / N / I / A |
| --- | --- | --- | --- | --- | --- |
| 177 / R4.implement / antigravity | 1778.55 | 650.06 | 0.65 | 3 | 892 / 2489 / 2885 / 2890 |
| 204 / R4.implement / claude | 0.56 | 673.83 | 0.81 | 1 | 267 / 268 / 313 / 314 |
| 204 / R4.implement / codex | 0.38 | 1046.82 | 1.04 | 1 | 269 / 271 / 420 / 421 |
| 204 / R4.implement / cursor | 1.75 | 2043.69 | 0.75 | 6 | 272 / 279 / 535 / 537 |
| 195 / R3.plan-ballot / cursor | 0.54 | 695.28 | 0.01 | 5 | 234 / 236 / 271 / 272 |
| 195 / R5.compare-ballot / cursor | 0.54 | 324.57 | 0.02 | 3 | 614 / 616 / 637 / 638 |
| 204 / R5.compare / codex | 0.39 | 503.09 | 0.84 | 1 | 542 / 544 / 627 / 628 |
| 204 / R5.compare-ballot / cursor | 0.58 | 296.30 | 0.02 | 4 | 636 / 637 / 663 / 664 |
| 184 / R4.implement / cursor | 0.53 | 4580.84 | 0.81 | 5 | 269 / 271 / 415 / 416 |

#177 Antigravity R4 was prepared at `23:47:46.582Z`, but its first recorded
nudge was at `00:17:25.131Z`: **29.64 minutes later**. Deferrals at 899 and
905 cited `lifecycle-changed` and `no-idle-sentinel`; the eventual send at
2489 used Stop-hook readiness. Its remaining submission turnaround was 10.83
minutes. The gate's 40.51 minutes therefore cannot all be attributed to coding.
If that agent had completed earlier, Cursor's acceptance at 2707 would still
have limited the phase to about 33.36 minutes; 29.64 minutes of delivery delay
is not 29.64 minutes of guaranteed phase savings.

In pause-free #204 R4, Claude, Codex, and Cursor were accepted 11.25, 17.48,
and 34.12 minutes after phase start (314, 421, 537). The final acceptance came
16.64 minutes after the second. Cursor had six recorded sends. These records
locate the bottleneck but do not distinguish coding, interrupted delivery, and
manual work within its 34.06-minute nudge-to-intent interval. The union of all
recorded tests in the phase was 7.85 minutes; the rest remains unattributed.

R5 comparison also needs attention: Codex was last in #195 (606) and #204
(628); Cursor was last in #177 and #184. This is not evidence that one vendor
is always slow. Baselines, issue complexity and rosters changed.

| Issue | Prepared actions | Recorded nudges | Nudges after first per action | Actions without recorded nudge | Deferrals by code |
| --- | --- | --- | --- | --- | --- |
| 177 | 39 | 46 | 12 | 5 | `claude-no-prompt` 1; `unknown` 1; `working` 33; `no-idle-sentinel` 7; `idle-transition-already-used` 3; `codex-turn-chrome` 4; `lifecycle-changed` 1; `background-active` 1; `queued` 1 |
| 195 | 26 | 33 | 8 | 1 | `claude-no-prompt` 1; `unknown` 1; `working` 24; `no-idle-sentinel` 4; `idle-transition-already-used` 3; `queued` 3; `codex-turn-chrome` 1 |
| 184 | 26 | 30 | 9 | 5 | `claude-no-prompt` 1; `working` 20; `no-idle-sentinel` 6; `codex-turn-chrome` 2; `idle-transition-already-used` 2 |
| 204 | 26 | 36 | 11 | 3 | `working` 23; `no-idle-sentinel` 5; `idle-transition-already-used` 2; `codex-turn-chrome` 2; `queued` 1 |
| 206 | 4 | 6 | 2 | 0 | `claude-no-prompt` 1; `working` 4; `no-idle-sentinel` 3; `idle-transition-already-used` 1 |

There were two rejected submission observations, both in #177: a review missing
bound plan citations (709), and a missing private response file (3145). This is
distinct from the four failed test-runner invocations below. #177's second
revise+ballot round added 10.09 minutes. That is an observed cost of resolving
objections, not authority to skip review.

### Ballot publication is already fast

| Issue | Published batches | Durations (s) | Pending → published sequences |
| --- | --- | --- | --- |
| 177 | 4 | 1.73, 2.01, 1.80, 1.78 | 880–881, 3196–3198, 3274–3276, 3393–3395 |
| 195 | 3 | 1.99, 1.99, 1.79 | 275–276, 639–641, 697–700 |
| 184 | 3 | 1.88, 1.82, 2.40 | 260–261, 532–533, 599–601 |
| 204 | 3 | 4.88, 2.01, 2.06 | 261–263, 665–666, 741–742 |
| 206 | 0 | N/A (solo) | N/A |

The 13 batches total only **28.139 seconds**, with a maximum of 4.884 seconds.
By contrast, Cursor's response latency in #195 R3.plan-ballot was 695.292
seconds including a pause (nudge 236 → acceptance 272); the batch took 1.987
seconds (275–276). In #204 compare-ballot, its response took 296.311 seconds
(637–664), while publication took 2.014 seconds (665–666). The existing private
ballot/batch mechanism is not the source of these multi-minute waits.

## Why R1.join took over two minutes

The cohort's joins ranged from 0.73 to 21.29 elapsed minutes. #177 alone had a
17.01-minute delivery-uncertain pause, leaving 4.28 unpaused minutes. The other
four joins were below two minutes. Per-agent acceptance offsets show who set
the barrier; all recorded join hook observations were evidence-only skips.

| Issue | Claude accepted at +s | Codex accepted at +s | Cursor accepted at +s | Antigravity accepted at +s | Last accept → gate (s) |
| --- | --- | --- | --- | --- | --- |
| 177 | 1049.335 | 1027.370 | 1277.512 | 1099.925 | 0.02 |
| 195 | 25.694 | 40.547 | 58.351 | N/A | 0.02 |
| 184 | 26.150 | 48.178 | 79.311 | N/A | 0.02 |
| 204 | 22.172 | 42.114 | 109.730 | N/A | 0.02 |
| 206 | 43.576 | N/A | N/A | N/A | 0.02 |

Acceptance citations in C/X/U/A order where present: #177 62/31/177/107;
#195 33/46/58; #184 30/46/60; #204 28/40/75; #206 14.
Recorded hook-skip intervals are only milliseconds; they are not measurements
of the full Git commit/push operation or containment-probe duration.

The supplemental **#209** join took **2m39.956s without a pause**, from
`03:55:51.161Z` to `03:58:31.117Z` on 2026-10-14:

| Agent | Prepared → nudge (s) | Nudge → intent (s) | Intent → accept (s) | Accepted at +s | P / N / I / A |
| --- | --- | --- | --- | --- | --- |
| claude | 0.55 | 18.52 | 1.64 | 24.529 | 5 / 6 / 41 / 43 |
| codex | 0.39 | 60.83 | 0.64 | 66.238 | 7 / 10 / 87 / 89 |
| cursor | 0.54 | 70.12 | 0.50 | 75.951 | 11 / 12 / 99 / 104 |
| antigravity | 2.88 | 151.16 | 0.56 | 159.937 | 13 / 17 / 161 / 164 |

#209 sequences 34, 35, 63, 71, 85, 95, 147, and 153 all have
`command: null`, `skipReason: coordination evidence only`, and a recorded
duration of 0–1 ms. Gate 165 follows the last acceptance at 164 by 19 ms.
Readiness currently asks each agent to read the protocol, perform the
once-per-session containment probe, write fixed bound JSON, commit, push, and
write completion. The journal times the overall turnaround, not those activities
individually. Removing a supposed two-minute test suite would not improve this
join: no such suite ran.

## Verification cost and what the logs establish

The measured commands were hook `pnpm run check:fast`, hook
`pnpm run test:e2e`, and coordinator final `pnpm run check`.
Every run recorded zero reused results, joined runs, and limiter queue wait.
No candidate-trigger execution was recorded; the start snapshots lack a
coordinator-verification policy. Hook records say `not cached: hook`;
the final checks say `not cached: no cache declaration`.

| Issue | Executed / skipped | Runner effort (s) | Interval union (s) | Union outside pauses (s) | Share of unpaused run | Failed executions |
| --- | --- | --- | --- | --- | --- | --- |
| 177 | 13 / 44 | 903.56 | 874.97 | 874.97 | 14.10% | 2 |
| 195 | 10 / 31 | 740.69 | 670.50 | 670.50 | 15.65% | 1 |
| 184 | 7 / 32 | 555.31 | 555.31 | 365.73 | 10.50% | 0 |
| 204 | 10 / 31 | 783.71 | 783.71 | 783.71 | 16.38% | 1 |
| 206 | 4 / 8 | 420.81 | 420.81 | 420.81 | 36.95% | 0 |

#184 is the useful counterexample: 189.580 seconds of tests overlapped a
coordinator pause. Its full 555.310-second verification union cannot simply be
subtracted from 58.04 unpaused minutes. Likewise concurrent tests overlap in
#177 and #195, so summed runner effort exceeds their interval union.

| Issue | Precommit count / seconds | Prepush count / seconds | Final count / seconds | Final runner / summary sequences |
| --- | --- | --- | --- | --- |
| 177 | 7 / 672.55 | 5 / 85.03 | 1 / 145.99 | 3413 / 3414 |
| 195 | 5 / 507.32 | 4 / 81.44 | 1 / 151.93 | 718 / 719 |
| 184 | 3 / 344.07 | 3 / 44.39 | 1 / 166.85 | 620 / 621 |
| 204 | 5 / 542.30 | 4 / 58.70 | 1 / 182.71 | 763 / 764 |
| 206 | 2 / 234.60 | 1 / 14.47 | 1 / 171.75 | 66 / 67 |

Failed precommit runs were #177 sequences 2784 and 2819 (6.224 and 91.682 s),
#195 sequence 487 (7.244 s), and #204 sequence 345 (85.637 s).
Those four attempts total **190.787 seconds**; retain them in cost totals.
All five final checks recorded exit 0. Final checks consume 48.22–71.58% of
R7 elapsed time; the phase table shows the remainder without assuming it is
all agent writing.

The retained final-check logs corroborate actual fast, system, and e2e runs:

| Issue | Fast tests / seconds | System tests / seconds | E2e tests / seconds | Log summary lines |
| --- | --- | --- | --- | --- |
| 177 | 737 / 77.35 | 189 / 39.86 | 2 / 18.02 | 395–398; 568–571; 751–754 |
| 195 | 770 / 76.91 | 202 / 46.18 | 2 / 18.05 | 385–388; 562–565; 745–748 |
| 184 | 782 / 81.93 | 210 / 54.32 | 2 / 19.26 | 371–374; 612–615; 795–798 |
| 204 | 790 / 89.91 | 210 / 60.74 | 2 / 20.59 | 393–396; 644–647; 827–830 |
| 206 | 791 / 86.66 | 210 / 55.25 | 2 / 18.70 | 395–398; 634–637; 817–820 |

These are historical coordinator results, not suites run for this report. Suite
durations omit other parts of the enclosing command and need not sum to its
entire duration. A passing log may contain “failed” in test names or expected
diagnostics; use its exit and summary, not keyword counts, to determine success.

Terminal recordings exist for Claude/Codex/Cursor in #184 and #204, and Claude
in #206. #177/#195 have no retained terminal logs. In the Cursor recordings,
the last `COORD-IDLE` occurrence in each of #184 and #204 is followed by a
rendered Working footer. Repeated screen redraws mean text-occurrence counts
are not action counts. Without event timestamps per frame, this corroborates
potentially conflicting UI signals but does not prove the exact pane was idle
when a particular send was refused. It does not justify bypassing readiness.

## Ranked proposals

### 1. Make blocked delivery and hold recovery visible earlier

**Evidence:** six holds consumed 1,204.77 minutes; five followed repeated Cursor
sends. #177 R4 additionally waited 29.64 minutes for its first Antigravity nudge.
See the hold and action tables.

**Change to consider:** show elapsed preparation-to-first-send time alongside
the exact deferral reason, and offer an opt-in owner notification with an
acknowledgement timer for a new hold. Distinguish a submitted artifact awaiting
acceptance from an action awaiting first delivery. Keep inspected recovery
controls rather than automatically dropping an agent, clearing a hold, or typing
over live work.

This is partly adoption and partly presentation: current
`docs/readiness-policy.md` already describes Stop-hook/ready-file evidence,
matching submit hooks, the explicit `n` reminder, and inspected hold release;
`src/runLoop.ts` already prints an ACTION message for a new hold. A follow-up
should add durable acknowledgement/elapsed diagnostics where missing, not claim
those controls do not exist. Earlier baseline behavior does not prove the same
defect remains in the current version.

**Impact and validation:** high potential, medium effort, uncertain realized
saving. If each historical hold had safely resolved within five minutes while
preserving all other work, the arithmetic reduction would be **1,177.10 minutes
across five runs**: sum(max(0, pause−5 min)). This is a counterfactual ceiling
under a strong recovery assumption, not a typical per-run forecast. Measure
preparation-to-first-send and hold-to-safe-resume p50/p95 on ten comparable runs;
require no increase in duplicate sends, incorrect acceptance, or unintended
roster changes. Human availability and blocked work can prevent the target.

### 2. Reduce fixed readiness work while preserving proof of participation

**Evidence:** #209 join is limited by 151.162 seconds of Antigravity submission
turnaround, with first nudges sent promptly and product checks skipped.
Consensus cohort median unpaused join is 1.58 minutes.

**Change to consider:** adapt the existing private-response/batch machinery to
a small readiness response so fixed JSON need not incur a separate agent commit
and push. Keep the session, baseline, digest, containment observation, and actual
agent acknowledgement bound and validated; never fabricate participation.
Supply a compact input packet that makes the exact write operation obvious.
Current R1 is Git mode in `src/steps.ts`; private ballots already work, but
extending their schemas and acceptance to R1 is future product work.

Containment is already once per agent session or policy/harness change. Do not
repeat it per action or reuse a probe across a changed session/policy. The Git
portion has no separate timer, so its savings are **not yet quantified**.
A pilot target of a join under 60 seconds would save about 100 seconds relative
to #209 if achieved; the logs do not establish that response mode alone achieves
it. Compare like-for-like rosters and require equally strong readiness
validation. Effort and risk: medium.

### 3. Trial existing coordinator verification and trusted receipt reuse

**Evidence:** final checks took 145.986–182.711 seconds per run and almost half
or more of finalization; every run recorded zero reuse. #206 ran two
precommits, one prepush, and a final check for 420.815 seconds total.
#177/#195 also show why parallel runner effort is not wall-clock savings.

**Change to consider:** adopt the already-supported configuration in
`config.example.json`, with coordinator candidate/final verification,
command-level cache declarations, and the dependency/environment/toolchain
identity checks in `src/verificationReceipts.ts` and
`src/verificationRunner.ts`. Use receipts only for proved equivalent inputs;
failed/interrupted commands and advisory hook telemetry are not receipts.
Retain every required candidate/final check and appropriate install/build/e2e
coverage. Local runtime configuration currently lacks this opt-in policy.

**Impact and validation:** medium effort and risk; opportunity, not measured
cache savings. The **2.43–3.05 minutes of final command time per run** is a
ceiling on that portion if equivalent successful receipts existed. These runs
do not prove equivalence or provide those receipts; install/build or receipt
overhead can remain. Compare fresh/reused/joined counts, runner effort,
unpaused interval union and finalization latency at the same coverage.
Do not deduct the full runner sum from phase duration or skip hooks today.

### 4. Reduce repeated preparation and review using existing evidence packets

**Evidence:** consensus planning, plan review, and implementation comparison
together consumed 96.16 unpaused minutes (30.76% of consensus time);
implementation itself consumed 114.66 minutes. #204's comparisons waited
503.093 seconds for Codex's submission versus 145.179 for Claude, while
post-submission validation stayed below one second for each. #177's rejected
review at 709 omitted required pin citations; its second revision round shows
the cost of incomplete convergence.

**Change to consider:** make the existing materialized input packet the first
read; include a concise phase-specific checklist of exact pins, changed files,
recorded verification, outstanding findings, and output scaffold. Use the
approved file map and test evidence to focus review rather than having agents
rediscover them or rerun unchanged suites. `src/materializedInputs.ts`, action
scaffolding, and the current protocol already provide much of this. Improve
missing presentation after checking the produced packet; do not build another
independent reporting service.

**Impact and validation:** low-to-medium effort; no causal savings estimate is
supported by current turnaround records. A **10% reduction target** for that
96.16-minute pool would be 9.62 minutes across four consensus runs, conditional
on equal correctness and scope. Measure phase medians, rejection/revision counts,
and finding quality; reject a change that misses defects. Add a compact R1
breakdown and per-phase pause/verification overlap to analytics as a measurement
follow-up, not a claim that reporting alone reduces execution time.

### 5. Choose existing profiles by required review depth

**Evidence:** solo #206 used four phases in 18.98 minutes; consensus used ten
phases, or twelve with an additional R6 round. The profile-specific tables show
the overhead but do not normalize for task complexity.

**Change to consider:** make an explicit owner choice of `solo`, `reviewed`,
or `consensus` before starting a suitably scoped issue, using existing
`src/steps.ts` profiles. Keep consensus for work that requires its independent
implementations and approval gates. This is operational selection, not silent
phase removal after an issue starts.

**Impact and validation:** low implementation effort; potentially substantial
quality risk if misapplied. No numerical speedup follows from one solo task.
Compare similar tasks and acceptance/rework outcomes over at least ten runs per
profile. Do not treat unentered phases as zero-cost observations in consensus
averages.

These scenarios overlap and **must not be added together**. Delivery recovery,
smaller packets and readiness responses can reduce the same turnaround;
verification can overlap pauses or another agent's work. No blanket 60–80%
improvement is established by these five runs.

## Coverage, provenance, and reproduction

Run `coord analytics --issue N --coord-runtime ROOT` for
`N = 177, 195, 184, 204, 206`, where ROOT is the retained workspace runtime.
The command was executed successfully for each run. Its latency output includes
pauses and follows the first-outstanding-nudge convention described above.

Token/tool coverage is not used to estimate savings. On this machine the reader
reported Claude complete for #195/#184/#204 and partial for #177/#206;
Codex and Cursor partial wherever present; Antigravity unavailable. Every
cross-roster token total was unavailable; no cross-roster tool total is reported.
Vendor stores can change independently of the journal, so these observations
are not immutable cohort-wide cost measurements.

| Issue | Baseline commit |
| --- | --- |
| 177 | `8d38734a93bc374560d2728e8cff6f9636181585` |
| 195 | `6a04d57e524ad53daa082568e146c5300e93dfeb` |
| 184 | `0e0a07b93b61be5f76224650468d50c3bbf06d5d` |
| 204 | `855982b3f1639ec5bac7891f1c67f1e100dc2ab3` |
| 206 | `5217f5ccad04d7664d81529e51191e6e053e2e1a` |

Each issue-session identity is `issue-N:<baseline commit>`. No vendor transcript
session identifier is needed. Agent versions were not stored in #177/#195/#184;
#204 recorded Claude 2.1.296, Codex 0.162.1, Cursor 2026.10.12-d47ca18;
#206 recorded Claude 2.1.299. These differences and issue scope limit causal
comparisons. Every frozen final check was `pnpm run check`.

### Source manifest

These SHA-256 values identify the exact local source bytes inspected. They are
source citations, not public download links. Full journals include a late
lifecycle record after the terminal gate, which is excluded from timings.

| Issue | File | SHA-256 |
| --- | --- | --- |
| 177 | `start.json` | `428991d6179d8024aefb50c06696266e2ee6631ac406dc262a65166e9fd8ecf0` |
| 177 | `journal.jsonl` | `36bcaddf0125205122803bfab15eb4f4eec60a2cad2e7749217e91c077690d86` |
| 177 | `cursors.json` | `c31df160c4f02d2c81d3450cda2c493d347a8ff2b72bcb18398197815e51283e` |
| 195 | `start.json` | `8b7feadbb1e1ed5c3b93c249601040889928cc23c85dac13247b845cec513591` |
| 195 | `journal.jsonl` | `652a589df2786f373daadf2c45aea03e9f4d82a022540826cfc9a90fffcc0f16` |
| 195 | `cursors.json` | `0f300fc762ede14ceba6684895649322463938e9e3d8e57f51187701c553c82b` |
| 184 | `start.json` | `9191e256e87c6c03c81879ead39a7629a6eb7b485f33154ac90c398dc7b37c57` |
| 184 | `journal.jsonl` | `6d4c349f512c1d5ad68b1f7d21736647518097de1d60bbd6c83cc6f803243c49` |
| 184 | `cursors.json` | `afc2432cb44e5561aa85ec43f9f7635be743eace9e2cda1135ba3cb131acc90b` |
| 204 | `start.json` | `dcd7684644766c4dc0f996151a714d33ae546ed36848b215568dd8e8999a3fa0` |
| 204 | `journal.jsonl` | `22964e3682553800c51fc83a43c7c51ae342c8f61176826d8a76ce4473211016` |
| 204 | `cursors.json` | `570f9852fd2efba12091fd7cb2fa405b48cbc4010b681c0731eae9f1461d70f4` |
| 206 | `start.json` | `ab4e7f09f4871981b623879ff72be159c5421f3e8e54d490ce52b5687640408e` |
| 206 | `journal.jsonl` | `67f0cdef40d1803bb2aa5763d2c46512e4ef6c2009ec394a27cf604f6f5d254e` |
| 206 | `cursors.json` | `136417e175b7d40be126ca6efdf265f04b143c6cdd0d2ac6ac1c7449fd35a522` |

Final-check log references used above:

| Issue | File beneath verification-logs/ | SHA-256 |
| --- | --- | --- |
| 177 | `c9d38d1e-5297-4655-8f7a-f2e76b58bf2f.log` | `d7944c1a4b8e2e1b4178b08e30ebc2342abb5f3aba0a3796f0835c62d73ab504` |
| 195 | `65495ca7-de82-4d5d-a033-fd1344a6ad38.log` | `83c5275b5b240d64031a74fa75404e0bb757bd409f3b062a991bd2d42a659108` |
| 184 | `95e3ba63-b330-457a-bd49-2cbbbb53d932.log` | `fe8d77b862389ecd687a906f6d2df1d3bd7aeae77d805c1b8da8b87300ffaaf1` |
| 204 | `4e445823-ce54-490c-9c0e-000d920cb662.log` | `1e0cb72f3f020f9eb3cb0606b2f0f178a8544738ac4707c73f288ef6fe706d8f` |
| 206 | `c68134a7-854a-4da2-830b-9cdc1d91a235.log` | `c94aa7c49f6cf6e3a2092d40ab597f551d028de1c7f1b308e877912f6388e02b` |

Terminal log inventory, relative to each issue directory:

| Issue | File | SHA-256 |
| --- | --- | --- |
| 184 | `agents/claude/terminal/run-2026-10-13T20-31-20-571Z.log` | `dcb37afedc69ffde708574315f890f35564780b8f0a5f8dab01fd5e9a9bd875e` |
| 184 | `agents/codex/terminal/run-2026-10-13T20-31-20-583Z.log` | `c3c102c6db217296af4a4b0af45512015cf409044de57d1c25026b30091b1348` |
| 184 | `agents/cursor/terminal/run-2026-10-13T20-31-20-595Z.log` | `18c8a867e7a4aa35d35952447d7fe6b42ac9345b4d5c1c66b5a67cff8396ea00` |
| 204 | `agents/claude/terminal/run-2026-10-14T01-55-48-540Z.log` | `396ad610449d9e9f126bcf77a191972a446423bdda7f348a1a4f73a7c40b4820` |
| 204 | `agents/codex/terminal/run-2026-10-14T01-55-48-551Z.log` | `9c8c5e822de84904656d85d742d4026f3b60c00eae759011aeb46c6904059de8` |
| 204 | `agents/cursor/terminal/run-2026-10-14T01-55-48-563Z.log` | `d9144d64d2f94c75741f53c9a24f0cc93cfa03813e3a6d9ae2eddb27ef833839` |
| 206 | `agents/claude/terminal/run-2026-10-14T03-24-28-637Z.log` | `5314690246c4746af216276f2c58192dc92fd114863437ee118bc96ea67da98d` |

Only short UI observations were retained from terminal recordings; no raw
transcripts, credentials, or absolute home paths are part of this report.

<details>
<summary>Independent calculation (Python standard library; read-only)</summary>

Save or extract this code and pass ROOT as its first argument. It emits the
phase, pause, action, command, publication and source-hash data used above.
Assertions check monotonic event order, runner duration consistency, and exact
reconciliation of phase, pause, and verification intervals before rounding.
For #209 it deliberately stops at the first closed gate so later work cannot
enter the supplemental join measurement. Missing nudge records remain null.
The displayed action examples have one accepted attempt; raw rejected
observations are retained separately, and CLI aggregate waits use the reader's
retry-pairing semantics.

```python
import collections, datetime as dt, hashlib, json, pathlib, sys
ROOT = pathlib.Path(sys.argv[1])
IDS = [177, 195, 184, 204, 206]
def ms(s):
    return round(dt.datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()*1000)
def union(intervals):
    result=[]
    for a,b in sorted(intervals):
        assert b >= a
        if result and a <= result[-1][1]: result[-1][1]=max(b,result[-1][1])
        else: result.append([a,b])
    return result
def overlap(intervals,a,b):
    return sum(max(0,min(y,b)-max(x,a)) for x,y in union(intervals))
def size(intervals): return sum(b-a for a,b in union(intervals))
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
reports=[]
for issue in IDS+[209]:
    directory=ROOT/f'issue-{issue}'
    start=json.loads((directory/'start.json').read_text())
    cursors=json.loads((directory/'cursors.json').read_text())
    raw=[json.loads(line) for line in (directory/'journal.jsonl').read_text().splitlines() if line.strip()]
    assert all(a['sequence'] < b['sequence'] for a,b in zip(raw,raw[1:]))
    gates=[r for r in raw if r['type']=='gate-advanced']
    if issue==209: gates=gates[:1]
    else:
        terminal=next(r for r in gates if r['details']['to'] is None)
        gates=[r for r in gates if r['sequence']<=terminal['sequence']]
    end=gates[-1]
    rows=[r for r in raw if r['sequence']<=end['sequence']]
    first=next(r for r in rows if r['type']=='started')
    begin=ms(first['at']);finish=ms(end['at'])
    pauses=[];pause=None
    for r in rows:
        if r['type']=='paused' and pause is None: pause=r
        elif r['type']=='resumed' and pause is not None:
            assert ms(r['at'])>=ms(pause['at'])
            pauses.append([ms(pause['at']),ms(r['at'])]);pause=None
    if pause: pauses.append([ms(pause['at']),finish])
    measurements=[r for r in rows if r['type']=='verification-run']
    runners=[r for r in measurements if r['details']['command'] is not None]
    for r in runners:
        d=r['details'];assert d['durationMs']==ms(d['completedAt'])-ms(d['startedAt'])
    intervals=union([[ms(r['details']['startedAt'])-r['details'].get('queueWaitMs',0),ms(r['details']['completedAt'])] for r in runners])
    phases=[];previous=first;active_round=None
    action_rows=[]
    for gate in gates:
        a,b=ms(previous['at']),ms(gate['at'])
        inside=[r for r in rows if previous['sequence']<r['sequence']<gate['sequence']]
        accepts=[r for r in inside if r['type']=='response-accepted' or (r['type']=='verify-result' and r['details'].get('ok'))]
        last=max(accepts,key=lambda r:r['sequence']) if accepts else None
        row={'phase':gate['details']['from'],'round':active_round if gate['details']['from'].startswith('R6.') else None,
             'sequences':[previous['sequence'],gate['sequence']],'startedAt':previous['at'],'endedAt':gate['at'],
             'elapsedMs':b-a,'pausedMs':overlap(pauses,a,b),'unpausedMs':b-a-overlap(pauses,a,b),
             'verificationMs':overlap(intervals,a,b),
             'unpausedVerificationMs':overlap(intervals,a,b)-sum(overlap(pauses,max(a,x),min(b,y)) for x,y in intervals if max(a,x)<min(b,y)),
             'actions':sum(r['type']=='action-prepared' for r in inside),'lastAgent':last.get('agent') if last else None,
             'lastAcceptanceSeq':last['sequence'] if last else None,'tailMs':b-ms(last['at']) if last else None,
             'deferrals':dict(collections.Counter(r['details'].get('code','unknown') for r in inside if r['type']=='nudge-deferred'))}
        phases.append(row)
        for prepared in [r for r in inside if r['type']=='action-prepared']:
            own=[r for r in inside if r.get('agent')==prepared['agent'] and r.get('actionId')==prepared['actionId']]
            nudge=next((r for r in own if r['type']=='nudged'),None)
            intent=next((r for r in own if r['type']=='intent-seen'),None)
            accept=next((r for r in own if r['type']=='response-accepted' or (r['type']=='verify-result' and r['details'].get('ok'))),None)
            action_rows.append({'phase':row['phase'],'round':row['round'],'agent':prepared['agent'],'actionId':prepared['actionId'],
                'sequences':{k:r['sequence'] if r else None for k,r in [('prepared',prepared),('nudge',nudge),('intent',intent),('accepted',accept)]},
                'preparedAt':prepared['at'],'acceptedAt':accept['at'] if accept else None,
                'deliveryMs':ms(nudge['at'])-ms(prepared['at']) if nudge else None,
                'turnaroundMs':ms(intent['at'])-ms(nudge['at']) if nudge and intent and ms(intent['at'])>=ms(nudge['at']) else None,
                'validationMs':ms(accept['at'])-ms(intent['at']) if accept and intent else None,
                'nudgeCount':sum(r['type']=='nudged' for r in own),
                'deferrals':dict(collections.Counter(r['details'].get('code','unknown') for r in own if r['type']=='nudge-deferred'))})
        previous=gate;active_round=gate['details'].get('round')
    assert sum(p['elapsedMs'] for p in phases)==finish-begin
    assert sum(p['pausedMs'] for p in phases)==overlap(pauses,begin,finish)
    assert sum(p['verificationMs'] for p in phases)==overlap(intervals,begin,finish)
    holds=[]
    for hold in [r for r in rows if r['type']=='hold-created']:
        pause=next((r for r in rows if r['type']=='paused' and r['details'].get('hold')==hold['details']['id']),None)
        resume=next((r for r in rows if pause and r['sequence']>pause['sequence'] and r['type']=='resumed'),None)
        holds.append({'seq':hold['sequence'],'agent':hold.get('agent'),'reason':hold['details']['reason'],
          'actionId':hold.get('actionId'),'at':hold['at'],'resumeSeq':resume['sequence'] if resume else None,
          'resumeAt':resume['at'] if resume else None,'pausedMs':ms(resume['at'])-ms(pause['at']) if pause and resume else None})
    commands=collections.defaultdict(lambda:{'count':0,'durationMs':0,'failures':0,'sequences':[]})
    for r in runners:
        d=r['details'];key=d['phase']+': '+' '.join(d['command']['argv'])
        commands[key]['count']+=1;commands[key]['durationMs']+=d['durationMs']
        commands[key]['failures']+=int(d['exitCode']!=0);commands[key]['sequences'].append(r['sequence'])
    final=[{'sequence':r['sequence'],**r['details']} for r in rows if r['type']=='final-check']
    publications=[];pending={}
    for r in rows:
        if r['type']=='ballot-batch-pending':pending.setdefault(r['details']['batchId'],r)
        elif r['type']=='ballot-batch-published':
            initial=pending.pop(r['details']['batchId'],None)
            if initial: publications.append({'sequences':[initial['sequence'],r['sequence']],'durationMs':ms(r['at'])-ms(initial['at'])})
    report={'issue':issue,'startedAt':first['at'],'endedAt':end['at'],'profile':start['profile'],
       'roster':start['originalRoster'],'activeRoster':cursors.get('activeRoster'),'baselineSha':start['baselineSha'],
       'issueSessionId':start['issueSessionId'],'formatVersion':start['formatVersion'],'agentVersions':start.get('agentVersions'),
       'elapsedMs':finish-begin,'pausedMs':size(pauses),'unpausedMs':finish-begin-size(pauses),
       'phases':phases,'actions':action_rows,'holds':holds,'commands':commands,'publications':publications,
       'verification':{'runners':len(runners),'skipped':len(measurements)-len(runners),
       'runnerMs':sum(r['details']['durationMs'] for r in runners),'unionMs':size(intervals),
       'unpausedUnionMs':sum(p['unpausedVerificationMs'] for p in phases),
       'failed':sum(r['details']['exitCode']!=0 for r in runners),
       'reuse':sum(r['type']=='verification-reused' for r in rows),'joined':sum(r['type']=='verification-joined' for r in rows),
       'queueWaitMs':sum(r['details'].get('queueWaitMs',0) for r in runners)},
       'counts':dict(collections.Counter(r['type'] for r in rows)),
       'rejected':[r for r in rows if r['type']=='verify-result' and not r['details'].get('ok')],
       'finalChecks':final,
       'hashes':{f:sha(directory/f) for f in ['start.json','journal.jsonl','cursors.json']} if issue!=209 else {},
       'logs':[{'path':str(p.relative_to(ROOT)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(directory.rglob('*.log'))] if issue!=209 else []}
    reports.append(report)
print(json.dumps(reports))
```

</details>

This report changes no coordinator behavior. The proposals are follow-up choices;
the measurements and their limitations are the basis for choosing them.
<!-- comment-body:end -->

## Publication tracking

Pending: this implementation is a candidate report for coordinator comparison.
Publish the body above only through the selected publication action, using
the stable `coord-issue-209-analysis` marker, a paginated existing-comment check,
and a readback comparison. Do not post one comment per candidate implementation.
The review recommends publication of the authorized revision during R7, without
waiting inside the agent action for coordinator-owned final checks. Keep the
eventual URL receipt in finalization communication rather than modifying an
already-approved product pin. No issue comment has been posted by this artifact.
