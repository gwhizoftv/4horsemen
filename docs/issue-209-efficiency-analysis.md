# Issue 209: where the last five coord runs spent their time

Issue #209 asks for an analysis of the last five issues run with `coord <issue>`
and a proposal for shortening the phases. This report covers the measurements,
the method, ranked recommendations, and the exact body of the issue comment.
The recommendations are for later work: this issue changes no product
behaviour, configuration or tests.

All numbers come from the read-only journals under `<coord-runtime>/issue-<n>/`
(`<coord-runtime>` is the workspace's coord runtime root, recorded as
`coordRoot` in each run's `start.json`). They
can be reproduced with `coord analytics` (coord 0.0.65) and the script in
[Reproduction](#reproduction). Savings are estimates, and every estimate states
its assumptions. Five observational runs of different tasks are a small sample.

## Summary

- **Cursor sets the pace of most gates.** Cursor was the last agent accepted in
  27 of 33 multi-agent phases. All 6 holds in the cohort were cursor holds, and
  they account for every paused minute (1,204.8 min in total).
- **Cursor's prompts were often never delivered.**
  - Claude's first sends were followed by its `prompt-submitted` hook within
    5 s in 37 of 37 cases, and codex's in 40 of 40.
  - Cursor's first sends landed in only 11 of 22 cases, and its automatic
    resends in 1 of 29.
  - Lost first deliveries delayed gates by an estimated 13.3–15.2 unpaused
    minutes per consensus run, which is 14–26% of each run's unpaused time.
  - Issue #206, merged after all four consensus runs, targets this path.
  - Issue 209 is the first run with that fix. Its closed phases (through
    sequence 1138) show every first send to claude, codex and cursor landing
    (21 of 21), with no resends and no holds. Cursor was last in 1 of 7 phases.
    That is one run, so the early signal needs confirming; see
    [Issue 209 so far](#issue-209-so-far-supplementary).
- **Final verification is 48–72% of R7.finalize.** The full `pnpm run check`
  final check took 146–183 s of a 4.00–6.17 min R7 phase, never reusing a
  result. Coordinator-owned verification with cache receipts already exists,
  but this workspace has not configured it.
- **R1.join is short except when one agent is slow.**
  - Joins without a hold took 0.73–1.83 min, and the coordinator advanced the
    gate in under 0.1 s after the last acceptance.
  - Issue 209's own 160 s join was 84 s of waiting for antigravity's single
    turn after the other three agents had finished.
- **The coordinator itself is not a lever.** It added at most 5.2 s per gate,
  and ballot evidence batches published in 1.7–4.9 s.

## Source inventory

The cohort is the five most recent runs by `start.json.createdAt` before this
issue's start (`2026-10-14T03:55:51.161Z`). Issue 172 is older and excluded, and
issue 209 is the active run. The workspace's older, pre-4horsemen
coord runtime root has nothing newer than issue 186 (`createdAt` 2026-10-09T18:39:24Z). Issue
numbers do not follow run order: 184 started after 195.

| Issue | Start (UTC) | Profile | Roster | Baseline | Events | Terminal gate seq | `journal.jsonl` SHA-256 |
| --- | --- | --- | --- | --- | ---: | ---: | --- |
| 177 | 2026-10-10T22:48:18.145Z | consensus | claude, codex, cursor, antigravity | `8d38734a93bc` | 3,420 | 3,418 | `36bcaddf0125205122803bfab15eb4f4eec60a2cad2e7749217e91c077690d86` |
| 195 | 2026-10-12T22:43:41.151Z | consensus | claude, codex, cursor | `6a04d57e524a` | 725 | 723 | `652a589df2786f373daadf2c45aea03e9f4d82a022540826cfc9a90fffcc0f16` |
| 184 | 2026-10-13T20:31:20.486Z | consensus | claude, codex, cursor | `0e0a07b93b61` | 627 | 625 | `6d4c349f512c1d5ad68b1f7d21736647518097de1d60bbd6c83cc6f803243c49` |
| 204 | 2026-10-14T01:55:48.449Z | consensus | claude, codex, cursor | `855982b3f163` | 770 | 768 | `22964e3682553800c51fc83a43c7c51ae342c8f61176826d8a76ce4473211016` |
| 206 | 2026-10-14T03:24:28.568Z | solo | claude | `5217f5ccad04` | 73 | 71 | `67f0cdef40d1803bb2aa5763d2c46512e4ef6c2009ec394a27cf604f6f5d254e` |

Additional source files, with SHA-256, relative to `<coord-runtime>/issue-<n>/`:

| Issue | File | SHA-256 |
| --- | --- | --- |
| 177 | `start.json` | `428991d6179d8024aefb50c06696266e2ee6631ac406dc262a65166e9fd8ecf0` |
| 177 | `cursors.json` | `c31df160c4f02d2c81d3450cda2c493d347a8ff2b72bcb18398197815e51283e` |
| 177 | `verification-logs/c9d38d1e-5297-4655-8f7a-f2e76b58bf2f.log` | `d7944c1a4b8e2e1b4178b08e30ebc2342abb5f3aba0a3796f0835c62d73ab504` |
| 195 | `start.json` | `8b7feadbb1e1ed5c3b93c249601040889928cc23c85dac13247b845cec513591` |
| 195 | `cursors.json` | `0f300fc762ede14ceba6684895649322463938e9e3d8e57f51187701c553c82b` |
| 195 | `verification-logs/65495ca7-de82-4d5d-a033-fd1344a6ad38.log` | `83c5275b5b240d64031a74fa75404e0bb757bd409f3b062a991bd2d42a659108` |
| 184 | `start.json` | `9191e256e87c6c03c81879ead39a7629a6eb7b485f33154ac90c398dc7b37c57` |
| 184 | `cursors.json` | `afc2432cb44e5561aa85ec43f9f7635be743eace9e2cda1135ba3cb131acc90b` |
| 184 | `verification-logs/95e3ba63-b330-457a-bd49-2cbbbb53d932.log` | `fe8d77b862389ecd687a906f6d2df1d3bd7aeae77d805c1b8da8b87300ffaaf1` |
| 184 | `agents/claude/terminal/run-2026-10-13T20-31-20-571Z.log` | `dcb37afedc69ffde708574315f890f35564780b8f0a5f8dab01fd5e9a9bd875e` |
| 184 | `agents/codex/terminal/run-2026-10-13T20-31-20-583Z.log` | `c3c102c6db217296af4a4b0af45512015cf409044de57d1c25026b30091b1348` |
| 184 | `agents/cursor/terminal/run-2026-10-13T20-31-20-595Z.log` | `18c8a867e7a4aa35d35952447d7fe6b42ac9345b4d5c1c66b5a67cff8396ea00` |
| 204 | `start.json` | `dcd7684644766c4dc0f996151a714d33ae546ed36848b215568dd8e8999a3fa0` |
| 204 | `cursors.json` | `570f9852fd2efba12091fd7cb2fa405b48cbc4010b681c0731eae9f1461d70f4` |
| 204 | `verification-logs/4e445823-ce54-490c-9c0e-000d920cb662.log` | `1e0cb72f3f020f9eb3cb0606b2f0f178a8544738ac4707c73f288ef6fe706d8f` |
| 204 | `agents/claude/terminal/run-2026-10-14T01-55-48-540Z.log` | `396ad610449d9e9f126bcf77a191972a446423bdda7f348a1a4f73a7c40b4820` |
| 204 | `agents/codex/terminal/run-2026-10-14T01-55-48-551Z.log` | `9c8c5e822de84904656d85d742d4026f3b60c00eae759011aeb46c6904059de8` |
| 204 | `agents/cursor/terminal/run-2026-10-14T01-55-48-563Z.log` | `d9144d64d2f94c75741f53c9a24f0cc93cfa03813e3a6d9ae2eddb27ef833839` |
| 206 | `start.json` | `ab4e7f09f4871981b623879ff72be159c5421f3e8e54d490ce52b5687640408e` |
| 206 | `cursors.json` | `136417e175b7d40be126ca6efdf265f04b143c6cdd0d2ac6ac1c7449fd35a522` |
| 206 | `verification-logs/c68134a7-854a-4da2-830b-9cdc1d91a235.log` | `c94aa7c49f6cf6e3a2092d40ab597f551d028de1c7f1b308e877912f6388e02b` |
| 206 | `agents/claude/terminal/run-2026-10-14T03-24-28-637Z.log` | `5314690246c4746af216276f2c58192dc92fd114863437ee118bc96ea67da98d` |

The session id of every run is `issue-<n>:<baseline>`. All five share
`pollIntervalMs` 1000, `maxRevisionRounds` 3, `prPolicy` `coord-open-unmerged`,
a single final check `pnpm run check` with no cache declaration, and no frozen
`verification` block. The runtime `config.json` has no `documentation`
profile, and its hooks run `pnpm run check:fast` before commit and
`pnpm run test:e2e` before push.

Each run has exactly one `verification-logs/*.log` file (its final check).
Terminal logs exist only for 184, 204 and 206 (`agents/<agent>/terminal/*.log`).
They have no timestamps, so they are qualitative evidence only. 177 and 195
have no terminal logs.

## Method

- **Phase intervals** follow `derivePhases` in `src/analytics.ts`. A phase runs
  from the previous boundary (`started` for the first) to its `gate-advanced`
  event. Revision rounds stay separate. Phase durations *include* pauses.
- **Paused time** follows `derivePausedMs`. A second `paused` while one is open
  is ignored, an unmatched `resumed` is ignored, and each pause is clipped to
  each phase. Every per-phase value and run headline below equals the
  `coord analytics --issue <n> --coord-runtime <coord-runtime>` output to two
  decimal places.
- **Action joins** use `(agent, actionId)` and run from `action-prepared` to
  the first `nudged`, then `intent-seen`, then the first accepting
  `verify-result` or `response-accepted`. `intent-seen` is recorded when the
  coordinator reads the agent's completion marker, *not* when the agent starts.
  Nudge→intent is therefore submission turnaround: delivery, agent work, hooks
  and push. The report never sums concurrent agents' intervals into a phase.
- **Delivery** is measured as follows. A send (`nudged` with an `actionId`)
  counts as landed if the same agent's `agent-lifecycle` `prompt-submitted`
  event follows within 5 s. Antigravity emits no `prompt-submitted` kind, so
  it is excluded.
  - "First" is the first send of an action.
  - "Resend" is any later automatic send.
  - "Owner" is a send with `details.owner` (the `n` path).
- **Lost-delivery estimate.** This applies to cursor actions whose first send
  did not land. "Lost" is the unpaused time from that send to cursor's next
  `prompt-submitted`. "Gate impact" is the smaller of lost and the unpaused
  time by which cursor's acceptance followed the last peer's acceptance in the
  same phase. It assumes cursor's work would have taken the same time once
  delivered.
- **Verification** counts only `verification-run` records with a command.
  Skipped coordination-evidence records are counted separately. Runner time is
  measured from `startedAt` to `completedAt`. The union removes overlap between
  concurrent runners. `final-check` duplicates the finalization
  `verification-run`, so it is not counted again.

## Phase durations

Each cell is elapsed minutes, with paused minutes in parentheses where non-zero.
"—" means the phase does not exist in that profile or round.

| Phase | 177 | 195 | 184 | 204 | 206 (solo) |
| --- | ---: | ---: | ---: | ---: | ---: |
| R1.join | 21.29 (17.01) | 0.97 | 1.32 | 1.83 | 0.73 |
| R2.plan | 8.12 | 8.03 | 6.18 | 8.60 | 4.14 |
| R3.review | 29.20 (16.50) | 6.28 | 5.14 | 5.14 | — |
| R3.plan-ballot | 0.85 | 11.65 (2.68) | 0.89 | 1.90 | — |
| R4.implement | 40.51 | 20.26 | 76.38 (56.62) | 34.12 | 10.11 |
| R5.compare | 950.65 (935.95) | 6.92 | 5.95 | 8.42 | — |
| R5.compare-ballot | 4.98 | 5.48 | 0.51 | 5.00 | — |
| R6.revise round 1 | 2.13 | 9.31 | 4.55 | 5.41 | — |
| R6.ballot round 1 | 0.59 | 0.84 | 183.97 (176.01) | 3.13 | — |
| R6.revise round 2 | 8.82 | — | — | — | — |
| R6.ballot round 2 | 1.27 | — | — | — | — |
| R7.finalize | 4.50 | 4.35 | 5.77 | 6.17 | 4.00 |
| **Run elapsed** | 1,072.90 | 74.08 | 290.67 | 79.72 | 18.98 |
| **Paused** | 969.47 | 2.68 | 232.62 | 0.00 | 0.00 |
| **Unpaused** | 103.43 | 71.41 | 58.04 | 79.72 | 18.98 |

The next table ranks steps in the four consensus runs by unpaused minutes, with
R6 rounds summed per run. The median is the upper middle of four values, the
same convention as `coord analytics`. The share is of the four runs' combined
unpaused time (312.60 min). 206 is excluded: it is a different profile and a
different task.

| Step | 177 | 195 | 184 | 204 | Median | Share |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| R4.implement | 40.51 | 20.26 | 19.76 | 34.12 | 34.12 | 37% |
| R6.revise | 10.95 | 9.31 | 4.55 | 5.41 | 9.31 | 10% |
| R5.compare | 14.69 | 6.92 | 5.95 | 8.42 | 8.42 | 12% |
| R2.plan | 8.12 | 8.03 | 6.18 | 8.60 | 8.12 | 10% |
| R3.review | 12.70 | 6.28 | 5.14 | 5.14 | 6.28 | 9% |
| R7.finalize | 4.50 | 4.35 | 5.77 | 6.17 | 5.77 | 7% |
| R5.compare-ballot | 4.98 | 5.48 | 0.51 | 5.00 | 5.00 | 5% |
| R6.ballot | 1.85 | 0.84 | 7.97 | 3.13 | 3.13 | 4% |
| R3.plan-ballot | 0.85 | 8.98 | 0.89 | 1.90 | 1.90 | 4% |
| R1.join | 4.28 | 0.97 | 1.32 | 1.83 | 1.83 | 3% |

## Who each gate waited for

Every gate needs every required participant, so a phase lasts as long as its
last acceptance. The coordinator's own lag between the last acceptance and the
`gate-advanced` event was:

| Phase type | Lag |
| --- | --- |
| git-mode phases | 0.0 s |
| ballot phases (includes evidence-batch publication of 1.7–4.9 s) | 2.0–5.2 s |
| R7.finalize (after its final check) | 3.9–5.0 s |

Last accepted agent across the 33 multi-agent phases:

| Agent | Phases |
| --- | ---: |
| cursor | 27 |
| codex | 5 |
| antigravity | 1 |

The spread is the time from the first acceptance to the last in the same
phase. Cases over five minutes:

| Run | Phase | Last accepted | Spread |
| --- | --- | --- | ---: |
| 177 | R3.review | cursor (seq 802) | 1,648 s (includes a 16.50 min hold) |
| 177 | R4.implement | antigravity (seq 2890) | 1,307 s |
| 177 | R5.compare | cursor (seq 3100) | 56,951 s (includes a 935.95 min hold) |
| 195 | R3.plan-ballot | cursor (seq 272) | 679 s (includes a 2.68 min hold) |
| 195 | R5.compare-ballot | cursor (seq 638) | 314 s |
| 184 | R4.implement | cursor (seq 416) | 714 s (after a 56.62 min hold) |
| 184 | R6.ballot round 1 | cursor (seq 598) | 11,025 s (includes a 176.01 min hold) |
| 204 | R4.implement | cursor (seq 537) | 1,372 s |
| 204 | R5.compare | codex (seq 628) | 358 s |

### Holds

| Run | Agent | Reason | Phase | Minutes | Sequences |
| --- | --- | --- | --- | ---: | --- |
| 177 | cursor | `delivery-uncertain` | R1.join | 17.01 | 9–24 |
| 177 | cursor | `nudge-loop` | R3.review | 16.50 | 771–773 |
| 177 | cursor | `nudge-loop` | R5.compare | 935.95 | 2999–3003 |
| 195 | cursor | `nudge-loop` | R3.plan-ballot | 2.68 | 258–260 |
| 184 | cursor | `nudge-loop` | R4.implement | 56.62 | 288–310 |
| 184 | cursor | `nudge-loop` | R6.ballot round 1 | 176.01 | 585–590 |

A hold pauses the whole issue, by design (`docs/coord-driver.md`), and
completion intake waits with it. In 184 R4.implement, claude's
`agent-lifecycle` `stopped` came 568 s after its nudge, yet its submission was
seen only at +3,867 s (sequence 312), immediately after the hold released at
sequence 310. Some large "agent wait" maxima in `coord analytics` are therefore pause time,
not slowness by those agents: codex's 56,627.6 s in 177, and claude's
3,866.6 s and codex's 3,864.2 s in 184.
The phase could not have advanced without cursor anyway, so this freeze did not
lengthen the gates by itself.

`docs/readiness-policy.md` already reconstructs 177's 936-minute overnight
hold. It also notes that the owner path (`n`) has since been separated from
automatic readiness. 204, the first cohort run with owner sends in the journal
(8 sends), has no holds.

## Delivery to cursor

| Agent | Send | Sends | Prompt within 5 s |
| --- | --- | ---: | ---: |
| claude | first | 37 | 37 |
| claude | resend | 2 | 1 |
| codex | first | 40 | 40 |
| codex | resend | 3 | 3 |
| codex | owner | 1 | 1 |
| cursor | first | 22 | 11 |
| cursor | resend | 29 | 1 |
| cursor | owner | 5 | 4 |

Automatic resends to cursor happened about 61, 182 and 423 s after the first
send (for example 184 R4.implement, sequences 279, 282, 286). Almost none
landed. In 204, cursor's prompt was submitted 0.2–0.4 s after each successful
owner send:

| Owner send | Sequence | Cursor prompt submitted |
| --- | --- | --- |
| R4.implement, +449.4 s | 292 | +449.8 s |
| R5.compare, +50.3 s | 557 | +50.5 s |
| R5.compare-ballot, +282.8 s | 655 | +283.0 s |
| R6.ballot, +111.1 s | 711 | +111.4 s |

Lost first deliveries to cursor:

| Run | Phase: lost / gate impact | Lost (min) | Gate impact (min) | Share of unpaused |
| --- | --- | ---: | ---: | ---: |
| 177 | R3.review 484/484 s; R5.compare 553/409 s | 17.28 | 14.88 | 14% |
| 195 | R2.plan 124/21 s; R3.plan-ballot 484/484 s; R5.compare-ballot 308/291 s | 15.26 | 13.26 | 19% |
| 184 | R4.implement 471/471 s; R6.ballot round 1 468/441 s | 15.66 | 15.20 | 26% |
| 204 | R4.implement 450/450 s; R5.compare 50/0 s; R5.compare-ballot 283/249 s; R6.ballot round 1 111/111 s | 14.91 | 13.50 | 17% |

Qualitative evidence from the untimestamped 204 cursor terminal log, for the
R4.implement action `f789672f`:
- The composer shows `-- INSERT --`.
- The prompt is rendered with a stray leading `a` (`a Read and execute
  coordinator action …`).
- A `No matches` line appears beside the wrapped `/action.md`.

This is consistent with the vim-mode prelude key arriving while the composer
was already in INSERT, and with part of the text being read as a vim search.
The log cannot tie this to a specific send.

Issue #206 ("Cursor and Codex doesn't always enter INSERT mode when the prompt
is ready to send") was closed at 2026-10-14T03:45:52Z. Its change, "space-separate
nudge text after a prelude key", is in coord 0.0.65. All four consensus cohort
runs predate it.

### Delay before the first send (idle readiness)

The other half of a delivery delay is a send that is not attempted because
readiness does not see the agent as idle. Across the 107 cohort actions with a
recorded send (of 121 actions), only two first sends came more than 10 unpaused seconds after
`action-prepared`:

| Run | Phase | Agent | Unpaused delay | Sequences | Deferrals before the send |
| --- | --- | --- | ---: | --- | --- |
| 177 | R1.join | cursor | 161.9 s | 7–129 | `unknown` 1 (after a 17.01 min hold) |
| 177 | R4.implement | antigravity | 1,778.5 s (29.6 min) | 892–2489 | `lifecycle-changed` 1, `no-idle-sentinel` 1 |

The 177 R4.implement case delayed the gate by at most about 7.2 minutes, not
29.6. Cursor's acceptance came at about 33.4 of the phase's 40.51 minutes, so
the phase would have waited for cursor anyway.

14 cohort actions had no recorded send at all (177: 5, 195: 1, 184: 5,
204: 3). Those agents picked up the next action by re-reading `action.md`
after completing the previous one, as the protocol asks.

Idle misreading before the first send was therefore rare in this cohort but
costly when it happened. Lost sends after a prompt was typed (above) were the
common case.

## Verification

| Run | Executed runners (count, total seconds, non-zero exits) | Skipped | Union of runner time | Final check / R7 |
| --- | --- | ---: | ---: | --- |
| 177 | check:fast 7, 673 s, 2; test:e2e 5, 85 s, 0; final check 1, 146 s, 0 | 44 | 14.58 min | 146 s of 270 s (54%) |
| 195 | check:fast 5, 507 s, 1; test:e2e 4, 81 s, 0; final check 1, 152 s, 0 | 31 | 11.18 min | 152 s of 261 s (58%) |
| 184 | check:fast 3, 344 s, 0; test:e2e 3, 44 s, 0; final check 1, 167 s, 0 | 32 | 9.26 min | 167 s of 346 s (48%) |
| 204 | check:fast 5, 542 s, 1; test:e2e 4, 59 s, 0; final check 1, 183 s, 0 | 31 | 13.06 min | 183 s of 370 s (49%) |
| 206 | check:fast 2, 235 s, 0; test:e2e 1, 14 s, 0; final check 1, 172 s, 0 | 8 | 7.01 min | 172 s of 240 s (72%) |

- **Hook cost per product commit.** Each product commit runs the precommit
  `check:fast` (lint, typecheck, `test:fast`, `test:system`), 94–149 s when
  it passes. Each product push runs `test:e2e`, 14–38 s.
- **Coordination-evidence commits** skip both in about 1 ms.
- **Failed hook runs.** 4 of the 22 `check:fast` runs exited non-zero (6.2 s,
  7.2 s, 85.6 s and 91.7 s), and each needed a fix and another run.
- **No reuse.** `coord analytics` reports `Reused results=0; joined runs=0` for
  every run. Every final check records `not cached: no cache declaration`.
- **Where the time lands.** Runner time sits inside each agent's submission
  turnaround. Concurrent agents overlap, so the union is not a critical-path
  figure. Runner time that overlapped a pause is removed below before
  comparing with unpaused time:

| Run | Union (s) | Union outside pauses (s) | Share of unpaused run | R4.implement union (s) | R4.implement union outside pauses (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| 177 | 875.0 | 875.0 | 14.1% | 610.0 | 610.0 |
| 195 | 670.5 | 670.5 | 15.6% | 400.4 | 400.4 |
| 184 | 555.3 | 365.7 | 10.5% | 388.5 | 198.9 |
| 204 | 783.7 | 783.7 | 16.4% | 471.1 | 471.1 |
| 206 | 420.8 | 420.8 | 36.9% | 249.1 | 249.1 |

In 184, 189.6 s of runner time ran during the R4.implement `nudge-loop` hold.

The final-check logs (one per run, hashed above) show the suites inside each
final `pnpm run check`. These are historical coordinator results, not tests
run for this report.

| Run | `test:fast` tests / duration | `test:system` tests / duration | `test:e2e` tests / duration |
| --- | --- | --- | --- |
| 177 | 737 / 77.35 s | 189 / 39.86 s | 2 / 18.02 s |
| 195 | 770 / 76.91 s | 202 / 46.18 s | 2 / 18.05 s |
| 184 | 782 / 81.93 s | 210 / 54.32 s | 2 / 19.26 s |
| 204 | 790 / 89.91 s | 210 / 60.74 s | 2 / 20.59 s |
| 206 | 791 / 86.66 s | 210 / 55.25 s | 2 / 18.70 s |

`test:fast` is the largest single part of every final check. Issue #175
proposes splitting its slowest files.

## Issue 209 so far (supplementary)

Issue 209 is outside the cohort, but it is the first run after #206's prelude
change (coord 0.0.65). Its phases through the
R5.compare-ballot gate (journal sequences 0–1138) are closed.
- SHA-256 of those 1,139 lines:
  `87a8938c413c13dd1c38ff0c70a5b8e4771a1c317f4e350578b51797a4712fbb`.
- Roster: claude, codex, cursor and antigravity. The task is a documentation
  analysis, unlike the cohort's product changes.

| Phase | Elapsed (min) | Sequences | Last accepted |
| --- | ---: | --- | --- |
| R1.join | 2.67 | 0–165 | antigravity |
| R2.plan | 6.45 | 165–443 | antigravity |
| R3.review | 3.79 | 443–591 | cursor |
| R3.plan-ballot | 1.02 | 591–673 | codex |
| R4.implement | 18.58 | 673–964 | codex |
| R5.compare | 4.97 | 964–1078 | codex |
| R5.compare-ballot | 0.52 | 1078–1138 | codex |

- **Deliveries.** First sends followed by `prompt-submitted` within 5 s:
  claude 7 of 7, codex 7 of 7, cursor 7 of 7. There were no resends, owner
  sends or holds.
- **Readiness.** One first send came more than 10 s after preparation
  (antigravity, R4.implement, 12.3 s). No `idle-transition-already-used`
  deferral was recorded; the cohort had 1–3 per run.
- **Last agent.** Cursor was last in 1 of 7 phases, against 27 of 33 in the
  cohort.

This is consistent with the delivery fix working, but it is one run. The
metrics above should be repeated on the next consensus runs before the
delivery problem is treated as closed.

## R1.join (owner question: why over two minutes?)

| Run | Phase total | Per-agent prepare → accept |
| --- | --- | --- |
| 195 | 0.97 min | claude 23.7 s, codex 38.5 s, cursor 55.9 s |
| 184 | 1.32 min | claude 23.7 s, codex 45.7 s, cursor 76.4 s |
| 204 | 1.83 min | claude 19.4 s, codex 38.8 s, cursor 106.0 s |
| 206 | 0.73 min | claude 42.5 s (solo) |
| 177 | 21.29 min | — |

- **Every join was a single turn.** In all four consensus runs, each agent's
  join was its first action. Cursor was last in each, and the gate advanced
  0.0 s after the last acceptance.
- **177 is the exception.** It had 17.01 paused minutes: cursor's join send was
  `delivery-uncertain`, and the whole-issue pause also held back claude's
  first send (1,024 s from prepare to nudge).
- **Join hooks skip.** They see only coordination evidence and finish in
  ≤ 1 ms.

Supplementary data comes from issue 209's own closed R1.join interval:
journal sequences 0–165, SHA-256 of those 166 lines
`9f7020aa13ed13ed69be2e6efaf83fa62353b14c2136c496f8bb3d338c825ec6`. It took
159.956 s with no pause. The table gives seconds from `started`:

| Agent | Nudged | Containment guard denied | Precommit hook | Prepush hook | Accepted | Idle until gate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| claude | 4.4 | 10.2 | 18.8 | 19.8 | 24.5 | 135.4 |
| codex | 4.8 | 17.1 | 43.0 | 51.2 | 66.2 | 93.7 |
| cursor | 5.3 | 16.4 | 64.6 | 70.3 | 76.0 | 84.0 |
| antigravity | 8.2 | 21.1 | 138.0 | 152.2 | 159.9 | 0.0 |

The two-minute join is antigravity's single turn. Its containment probe was
recorded at +43.0 s (sequence 64), and its commit hook did not start until
+138.0 s. Antigravity emits no `prompt-submitted` or `stopped` events, so those
95 s are unattributed in the journal.

The rest of a join turn adds little time:
- **Containment step.** From guard denial to coverage record took 3.4 s for
  claude, 13.5 s for codex, 14.3 s for cursor and 21.9 s for antigravity.
- **Git work.** From precommit hook to acceptance took 5.7–23 s per agent.
- **Coordinator.** It sent all four nudges by +8.2 s and advanced the gate
  19 ms after the last acceptance.

The join artifact itself contains only values that `action.md` supplies.

## Recommendations

Recommendations are ranked by measured avoidable delay, then confidence. Each
names an existing mechanism where one exists. Savings overlap, so do not add
them.

1. **Confirm the delivery and idle-readiness fixes with these metrics, and
   make lost sends cheap only if they regress.**
   - *Evidence.* Cursor first sends landed 11 of 22 times and resends 1 of 29,
     against 37 of 37 for claude and 40 of 40 for codex. Cursor was last in
     27 of 33 gates. All 6 holds were on cursor. There is terminal evidence of
     prelude and vim-mode interference. Idle misreading before a first send
     cost 29.6 minutes once (177 R4.implement).
   - *Existing mechanism.* #206 (coord 0.0.65), the owner-reported readiness
     fixes, and owner `n` delivery. Issue 209's closed phases already show 21 of 21 first sends
     landing, no holds, and cursor last in 1 of 7 phases.
   - *Next step.* Repeat three numbers on the next two or three consensus
     runs:
     - the per-vendor first-send landing rate;
     - first sends more than 10 s after preparation;
     - cursor's holds.

     Only if cursor's landing rate falls below the other agents' again should
     a follow-up treat a send with no `prompt-submitted` within a few seconds
     as lost, and repeat it promptly instead of after the 61/182/423 s
     back-off.
   - *Estimated saving.* Up to 13.3–15.2 unpaused minutes per consensus run,
     plus the avoided holds. This assumes cursor's work time is unchanged once
     it is delivered.
   - *Validation.* The landing rate and lost-delivery minutes from
     [Delivery to cursor](#delivery-to-cursor), the delayed-first-send count,
     and `nudge-loop`/`delivery-uncertain` holds.
   - *Risk.* A duplicate prompt. Resend only on positive hook evidence that no
     prompt was submitted, and keep the same-action duplicate guard.
2. **Notify the owner when a whole-issue hold is created.**
   - *Evidence.* The time from hold to release was 17.01, 16.50, 935.95, 2.68,
     56.62 and 176.01 min. That is 1,204.8 elapsed minutes, or 78% of the
     cohort's 1,536.35 elapsed minutes.
   - *Existing mechanism.* Holds appear in `coord status` and are released with
     `coord resume`. No hold notification was found in `src/`; the `osascript`
     use there is for terminal windows.
   - *Estimated saving.* Owner reaction time, which the journals cannot
     estimate. This does not shorten unpaused time.
   - *Validation.* Minutes from `hold-created` to `hold-released`.
   - *Risk.* Notification noise. Notify only for holds that need the owner.
3. **Adopt coordinator-owned verification with cache receipts.** This is an
   existing feature that is not configured here.
   - *Evidence.* The final check takes 48–72% of R7.finalize, and nothing was
     reused in any of the five runs. Every implementer and reviser runs the
     full `check:fast` plus `test:e2e` through hooks.
   - *Existing mechanism.* `verification.mode: "coordinator"` with candidate
     checks and `tree-excluding-evidence` cache keys, as in
     `config.example.json` and `docs/coord-driver.md`. Related: #175 (split
     the slow test files).
   - *Estimated saving.* Most of the 146–183 s final check when the final tree
     matches a checked revision pin apart from coordination evidence. The net
     effect on R4 and R6 is unknown, because candidate checks move into the
     coordinator while the hooks drop to the cheap coordinated checks.
   - *Validation.* `coord analytics` reused results, time avoided, R7 duration,
     and hook-trigger seconds.
   - *Risk.* A stale receipt. The documented key, the dirty-tree refusal, and
     the retained final gate address this.
4. **Answer to the owner's R1.join question.**
   - *Finding.* A join over two minutes means one agent's first turn was slow.
     It is not coordinator or hook time.
   - *Possible follow-up.* Make R1.join a response-mode action, like ballots,
     so agents skip commit and push.
   - *Estimated saving.* Only the 5.7–23 s of git work per agent shown above,
     at most about 25 s per run. R1.join is 3% of consensus unpaused time.
   - *Recommendation.* Pursue this only if cheap. It does not remove the
     slow-agent wait.
5. **Choose the lighter profile for small, low-risk issues.** This is an owner
   decision using an existing feature.
   - *Evidence.* The consensus-only steps R5.compare, R5.compare-ballot and
     R6.* took 32.47, 22.55, 18.98 and 21.96 unpaused minutes in 177, 195, 184
     and 204: 28–33% of each run.
   - *Existing mechanism.* `--profile reviewed` keeps plan review and its
     ballot but drops those steps. `--profile solo` drops more.
   - *Caveat.* Solo 206 took 18.98 min, but it was a different task, so no
     speedup is inferred from it.
   - *Trade-off.* This gives up cross-implementation comparison and revision
     ballots.
   - *Validation.* Unpaused totals per profile.

Measured but not recommended for action:
- Coordinator gate lag is 0–5.2 s.
- Ballot batch publication takes 1.7–4.9 s.
- `nudge-deferred` counts are dominated by `working` (20–33 per run), which is
  normal deferral while an agent is busy. A count alone does not measure delay.

## Gaps

- **Tokens and tools.** Token and tool counts are omitted. They are needed for
  none of the conclusions, and transcript coverage differs by vendor
  (`docs/analytics.md`).
- **Antigravity.** It has no `prompt-submitted`/`stopped` lifecycle events, so
  its delivery and its idle time inside a turn are unmeasured. It appears only
  in 177 and in the issue 209 supplement.
- **Terminal logs.** They exist only for 184, 204 and 206 and have no
  timestamps, so they cannot be joined to sends.
- **Manual commands.** Test runs that agents start by hand are not
  instrumented, so unpaused time inside a turn is not proof of model work.
- **Sample.** The sample is five runs of different tasks across
  coord versions, and the run with four agents (177) differs from the others.

## Reproduction

```sh
for n in 177 195 184 204 206; do
  coord analytics --issue "$n" --coord-runtime "<coord-runtime>"
done
python3 -I issue209.py "<coord-runtime>"
```

`issue209.py` is read-only. It reads `start.json`, `cursors.json`,
`journal.jsonl`, the final-check logs and the terminal-log bytes (for hashing
only), and prints every table in this report. The issue 209 supplements read
journal sequences 0–165 and 0–1138 only, so later events in that live journal
do not change them:

```python
#!/usr/bin/env python3
# Read-only. Usage: python3 -I issue209.py <coord-runtime>
import glob, hashlib, json, os, re, sys
from collections import Counter, defaultdict
from datetime import datetime

ROOT, COHORT, W = sys.argv[1], (177, 195, 184, 204, 206), 5.0
T = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def ov(a, b, ivs):  # seconds of [a,b] covered by ivs
    return sum(max(0.0, min(b, y) - max(a, x)) for x, y in ivs)


def union(ivs):
    tot, cur = 0.0, None
    for s, e in sorted(ivs):
        if cur and s <= cur[1]:
            cur[1] = max(cur[1], e)
        else:
            tot += cur[1] - cur[0] if cur else 0
            cur = [s, e]
    return tot + (cur[1] - cur[0] if cur else 0)


def merge(ivs):
    out = []
    for x, y in sorted(ivs):
        if out and x <= out[-1][1]:
            out[-1][1] = max(out[-1][1], y)
        else:
            out.append([x, y])
    return out


def umed(xs):  # upper middle, the coord analytics convention
    return sorted(xs)[len(xs) // 2]


def run(issue, cutoff=None):  # cutoff: last journal sequence to read (inclusive)
    raw = open(f"{ROOT}/issue-{issue}/journal.jsonl", "rb").read()
    ev = [json.loads(l) for l in raw.decode().splitlines() if l.strip()]
    if cutoff is not None:
        ev = [e for e in ev if e["sequence"] <= cutoff]
        raw = b"".join(l + b"\n" for l in raw.splitlines()[:len(ev)])
    st = json.load(open(f"{ROOT}/issue-{issue}/start.json"))
    t0 = T(ev[0]["at"])
    ph, b, bs, rnd = [], t0, 0, None  # a phase's round is the one its opening gate carried
    for e in ev:
        if e["type"] == "gate-advanced":
            d = e["details"]
            ph.append(dict(name=d["from"] + (f" round {rnd}" if rnd else ""), step=d["from"],
                           a=b, b=T(e["at"]), seqs=(bs, e["sequence"])))
            b, bs, rnd = T(e["at"]), e["sequence"], d.get("round")
    end = ph[-1]["b"]
    pz, o = [], None  # derivePausedMs pairing
    for e in ev:
        if e["type"] == "paused" and o is None:
            o = T(e["at"])
        elif e["type"] == "resumed" and o is not None:
            pz.append((o, T(e["at"]))); o = None
    if o is not None:
        pz.append((o, end))
    acts, sent = {}, set()
    ps = defaultdict(list)
    for e in ev:
        k, ag, aid, t = e["type"], e.get("agent"), e.get("actionId"), T(e["at"])
        d = e.get("details", {})
        if k == "agent-lifecycle" and d.get("kind") == "prompt-submitted":
            ps[ag].append(t)
        if k == "action-prepared":
            acts[(ag, aid)] = dict(agent=ag, prep=t, nudge=None, intent=None, acc=None, accSeq=None, rej=0, sends=[],
                                   early=Counter(), prepSeq=e["sequence"], nudgeSeq=None)
            continue
        a = acts.get((ag, aid))
        if not a:
            continue
        if k == "nudged":
            kind = "owner" if d.get("owner") else ("first" if (ag, aid) not in sent else "resend")
            sent.add((ag, aid)); a["sends"].append((t, kind))
            if a["nudge"] is None:
                a["nudge"], a["nudgeSeq"] = t, e["sequence"]
        elif k == "nudge-deferred" and a["nudge"] is None:
            a["early"][d.get("code")] += 1
        elif k == "intent-seen":
            a["intent"] = a["intent"] or t
        elif k == "verify-result" and not d.get("ok"):
            a["rej"] += 1
        elif (k == "verify-result" or k == "response-accepted") and a["acc"] is None:
            a["acc"], a["accSeq"] = t, e["sequence"]
    for a in acts.values():
        a["phase"] = next((p["name"] for p in ph if p["a"] <= a["prep"] <= p["b"]), None)
    return dict(ev=ev, st=st, sha=hashlib.sha256(raw).hexdigest(), ph=ph, pz=pz, acts=acts, ps=ps, t0=t0, end=end)


R = {i: run(i) for i in COHORT}
m = lambda s: f"{s / 60:.2f}"

print("## Inventory")
for i, r in R.items():
    s = r["st"]
    print(f"| {i} | {s['createdAt']} | {s['profile']} | {','.join(s['originalRoster'])} | `{s['baselineSha'][:12]}` | "
          f"{len(r['ev'])} | {r['ph'][-1]['seqs'][1]} | `{r['sha'][:16]}` |")

print("\n## Phases (elapsed / paused / unpaused minutes)")
for i, r in R.items():
    el = r["end"] - r["t0"]; pa = sum(y - x for x, y in r["pz"])
    print(f"### {i}: elapsed {m(el)} paused {m(pa)} unpaused {m(el - pa)}")
    for p in r["ph"]:
        pp = ov(p["a"], p["b"], r["pz"])
        print(f"| {p['name']} | {m(p['b'] - p['a'])} | {m(pp)} | {m(p['b'] - p['a'] - pp)} | {p['seqs'][0]}–{p['seqs'][1]} |")

print("\n## Consensus step ranking (unpaused minutes, R6 rounds summed per run)")
cons = [i for i in COHORT if R[i]["st"]["profile"] == "consensus"]
per = defaultdict(dict)
for i in cons:
    for p in R[i]["ph"]:
        per[p["step"]][i] = per[p["step"]].get(i, 0) + (p["b"] - p["a"] - ov(p["a"], p["b"], R[i]["pz"]))
tot = {i: sum(per[s][i] for s in per) for i in cons}
for s, v in sorted(per.items(), key=lambda kv: -umed(list(kv[1].values()))):
    print(f"| {s} | " + " | ".join(m(v[i]) for i in cons) + f" | {m(umed(list(v.values())))} | "
          f"{100 * sum(v.values()) / sum(tot.values()):.0f}% |")

print("\n## Last accepted agent, acceptance spread, coordinator gate lag (multi-agent phases)")
last, lag = Counter(), defaultdict(list)
for i, r in R.items():
    for p in r["ph"]:
        acc = sorted((a["acc"], a["agent"], a["accSeq"]) for a in r["acts"].values() if a["phase"] == p["name"] and a["acc"])
        if acc:
            lag[p["step"]].append(p["b"] - acc[-1][0])
        if len(acc) > 1:
            last[acc[-1][1]] += 1
            print(f"| {i} | {p['name']} | {acc[-1][1]} (seq {acc[-1][2]}) | {acc[-1][0] - acc[0][0]:.0f} s |")
print("last-agent counts:", dict(last))
print("gate lag max s:", {k: round(max(v), 1) for k, v in lag.items()})

print("\n## Holds")
for i, r in R.items():
    op = {}
    for e in r["ev"]:
        if e["type"] == "hold-created":
            op[e["details"]["id"]] = e
        elif e["type"] == "hold-released" and op:
            h = op.pop(e["details"].get("id") or next(iter(op)))
            ph = next(p["name"] for p in r["ph"] if p["a"] <= T(h["at"]) <= p["b"])
            print(f"| {i} | {h['details']['agent']} | {h['details']['reason']} | {ph} | {m(T(e['at']) - T(h['at']))} | {h['sequence']}–{e['sequence']} |")

print(f"\n## Delivery: send followed by the agent's prompt-submitted within {W:.0f} s")
dl = defaultdict(lambda: [0, 0])
for r in R.values():
    for a in r["acts"].values():
        if a["agent"] == "antigravity":
            continue  # antigravity emits no prompt-submitted lifecycle kind
        for t, kind in a["sends"]:
            dl[(a["agent"], kind)][0] += 1
            dl[(a["agent"], kind)][1] += any(t <= x <= t + W for x in r["ps"][a["agent"]])
for k in sorted(dl):
    print(f"| {k[0]} | {k[1]} | {dl[k][0]} | {dl[k][1]} |")

print("\n## Cursor lost delivery: first send not followed by a prompt; unpaused time to the next prompt, and the part that delayed the gate")
for i in cons:
    r = R[i]; tl = ti = 0; rows = []
    for a in r["acts"].values():
        if a["agent"] != "cursor" or not a["nudge"] or not a["intent"]:
            continue
        x = a["nudge"]
        if any(x <= p <= x + W for p in r["ps"]["cursor"]):
            continue
        nxt = [p for p in r["ps"]["cursor"] if x + W < p <= a["intent"]]
        if not nxt:
            continue
        lost = nxt[0] - x - ov(x, nxt[0], r["pz"])
        peers = [b["acc"] for b in r["acts"].values() if b["phase"] == a["phase"] and b["agent"] != "cursor" and b["acc"]]
        mg = a["acc"] - max(peers) - ov(max(peers), a["acc"], r["pz"]) if peers else 0
        imp = max(0, min(lost, mg)); tl += lost; ti += imp; rows.append(f"{a['phase']} {lost:.0f}/{imp:.0f} s")
    un = r["end"] - r["t0"] - sum(y - x for x, y in r["pz"])
    print(f"| {i} | {'; '.join(rows)} | {m(tl)} | {m(ti)} | {100 * ti / un:.0f}% |")

print("\n## Verification runners (executed commands only)")
for i, r in R.items():
    vr = [e for e in r["ev"] if e["type"] == "verification-run"]
    ran = [e["details"] for e in vr if e["details"].get("command")]
    g = defaultdict(list)
    for d in ran:
        g[(d["trigger"], d["phase"], d["command"]["name"])].append((T(d["completedAt"]) - T(d["startedAt"]), d["exitCode"]))
    fin = next(p for p in r["ph"] if p["step"] == "R7.finalize")
    cells = "; ".join(f"{k[0]}/{k[1]} {k[2]}: n={len(v)}, {sum(x for x, _ in v):.0f} s, non-zero exits={sum(1 for _, c in v if c)}"
                      for k, v in sorted(g.items()))
    ivs = [(T(d["startedAt"]), T(d["completedAt"])) for d in ran]
    print(f"| {i} | {cells} | skipped={len(vr) - len(ran)} | union {m(union(ivs))} | R7 {m(fin['b'] - fin['a'])} |")

print("\n## Deferral codes (count of nudge-deferred records)")
for i, r in R.items():
    print(i, dict(Counter(e["details"].get("code") for e in r["ev"] if e["type"] == "nudge-deferred").most_common()))

print("\n## Supplementary: issue 209 R1.join (closed interval, journal start through first gate-advanced)")
s = run(209, cutoff=165); p = s["ph"][0]
print(f"interval {p['b'] - p['a']:.3f} s, sequences {p['seqs'][0]}–{p['seqs'][1]}, paused {ov(p['a'], p['b'], s['pz']):.1f} s")
for a in sorted(s["acts"].values(), key=lambda a: a["acc"] or 1e18):
    if a["phase"] != "R1.join":
        continue
    lc = {e["details"]["kind"]: T(e["at"]) - s["t0"] for e in s["ev"] if e["type"] == "agent-lifecycle" and e["agent"] == a["agent"]
          and e["sequence"] <= p["seqs"][1] and e["details"].get("kind") in ("containment-guard-denied",)}
    vr = [T(e["at"]) - s["t0"] for e in s["ev"] if e["type"] == "verification-run" and e["agent"] == a["agent"] and e["sequence"] <= p["seqs"][1]]
    print(f"| {a['agent']} | {a['nudge'] - s['t0']:.1f} | {lc.get('containment-guard-denied', float('nan')):.1f} | "
          f"{vr[0]:.1f} | {vr[-1]:.1f} | {a['acc'] - s['t0']:.1f} | {p['b'] - a['acc']:.1f} |")

print("\n## Verification runner union with pause overlap removed")
for i, r in R.items():
    ivs = [(T(e["details"]["startedAt"]), T(e["details"]["completedAt"])) for e in r["ev"]
           if e["type"] == "verification-run" and e["details"].get("command")]
    def clip(a, b):
        return [(max(a, x), min(b, y)) for x, y in ivs if min(b, y) > max(a, x)]
    def unp(a, b):  # union seconds in [a,b] not covered by a pause
        cl = clip(a, b)
        return union(cl) - sum(ov(x, y, r["pz"]) for x, y in [(c[0], c[1]) for c in merge(cl)])
    un = r["end"] - r["t0"] - sum(y - x for x, y in r["pz"])
    r4 = next(p for p in r["ph"] if p["step"] == "R4.implement")
    print(f"| {i} | {union(ivs):.1f} | {unp(r['t0'], r['end']):.1f} | {100 * unp(r['t0'], r['end']) / un:.1f}% | "
          f"{union(clip(r4['a'], r4['b'])):.1f} | {unp(r4['a'], r4['b']):.1f} |")

print("\n## Delay before the first send (unpaused seconds from action-prepared to first nudged), actions over 10 s")
for i, r in R.items():
    for a in sorted(r["acts"].values(), key=lambda a: a["prep"]):
        if a["nudge"] is None:
            continue
        dly = a["nudge"] - a["prep"] - ov(a["prep"], a["nudge"], r["pz"])
        if dly > 10:
            print(f"| {i} | {a['phase']} | {a['agent']} | {dly:.1f} | {a['prepSeq']}–{a['nudgeSeq']} | {dict(a['early'])} |")
for i, r in R.items():
    none = sum(1 for a in r["acts"].values() if a["nudge"] is None)
    print(f"{i}: actions={len(r['acts'])} without any recorded send={none}")

print("\n## Source hashes (relative to <coord-runtime>/issue-<n>/)")
for i in COHORT:
    base = f"{ROOT}/issue-{i}/"
    files = ["start.json", "cursors.json"] + sorted(glob.glob(base + "verification-logs/*.log")) + sorted(glob.glob(base + "agents/*/terminal/*.log"))
    for f in files:
        f = f if f.startswith(base) else base + f
        print(f"| {i} | `{f[len(base):]}` | `{hashlib.sha256(open(f, 'rb').read()).hexdigest()}` |")

print("\n## Final-check log suite summaries (fast, system, e2e)")
for i in COHORT:
    for f in sorted(glob.glob(f"{ROOT}/issue-{i}/verification-logs/*.log")):
        txt = re.sub(r"\x1b\[[0-9;]*m", "", open(f, errors="replace").read())
        tests = re.findall(r"^\s*Tests\s+(\d+) passed", txt, re.M)
        durs = re.findall(r"^\s*Duration\s+([\d.]+)(m?s)", txt, re.M)
        print(i, list(zip(tests, [d + u for d, u in durs])))

print("\n## Supplementary: issue 209 closed phases through sequence 1138 (first run with the #206 prelude change)")
s = run(209, cutoff=1138)
print(f"journal prefix sha256 {s['sha']}, holds={sum(1 for e in s['ev'] if e['type'] == 'hold-created')}, "
      f"paused={sum(y - x for x, y in s['pz']):.1f} s")
for p in s["ph"]:
    print(f"| {p['name']} | {m(p['b'] - p['a'])} | {p['seqs'][0]}–{p['seqs'][1]} |")
dl = defaultdict(lambda: [0, 0])
for a in s["acts"].values():
    if a["agent"] == "antigravity":
        continue
    for t, kind in a["sends"]:
        dl[(a["agent"], kind)][0] += 1
        dl[(a["agent"], kind)][1] += any(t <= x <= t + W for x in s["ps"][a["agent"]])
for k in sorted(dl):
    print(f"| {k[0]} | {k[1]} | {dl[k][0]} | {dl[k][1]} |")
slow = [(a["agent"], a["phase"], round(a["nudge"] - a["prep"], 1)) for a in s["acts"].values() if a["nudge"] and a["nudge"] - a["prep"] > 10]
print("first sends later than 10 s after preparation:", slow, "; without any recorded send:",
      sum(1 for a in s["acts"].values() if a["nudge"] is None and a["phase"]))
```

## Comment body

This section is posted to #209 once, by the coordinator-selected reviser, after
consensus approves the revision. The posted text is everything strictly between
the `comment-body:start` and `comment-body:end` lines. It begins with the
`coord-issue-209-analysis` marker so an existing comment can be found and
updated instead of duplicated.

<!-- comment-body:start -->
<!-- coord-issue-209-analysis -->
## Where the last five coord runs spent their time

I analyzed the five most recent coord runs before this issue: **177, 195, 184
and 204 (consensus) and 206 (solo)**, ordered by `start.json.createdAt`. Every
number comes from the read-only journals and can be reproduced with
`coord analytics --issue <n> --coord-runtime <coord-runtime>` plus the script in
`docs/issue-209-efficiency-analysis.md`. Savings are estimates, and five runs of
different tasks is a small sample.

**Unpaused time by step** (four consensus runs, 312.6 min combined):

| Step | Share |
| --- | ---: |
| R4.implement | 37% |
| R5.compare | 12% |
| R6.revise | 10% |
| R2.plan | 10% |
| R3.review | 9% |
| R7.finalize | 7% |
| Ballots (all three) | 14% |
| R1.join | 3% |

Elapsed time was much larger than unpaused time: 177 ran 1,072.90 min, of
which 969.47 min were paused.

### What the journals show

1. **Gates wait for cursor.**
   - Cursor was the last agent accepted in 27 of 33 multi-agent phases.
   - All 6 holds were cursor holds (5 `nudge-loop` and 1 `delivery-uncertain`).
     They lasted 17.01, 16.50, 935.95, 2.68, 56.62 and 176.01 min: every
     paused minute in the cohort.
   - The coordinator itself added only 0–5.2 s per gate.
2. **Cursor's prompts were often not delivered.** A send counts as landed when
   the agent's `prompt-submitted` hook follows within 5 s.
   - Claude: 37 of 37 first sends landed.
   - Codex: 40 of 40 first sends landed.
   - Cursor: 11 of 22 first sends, 1 of 29 automatic resends, and 4 of 5
     owner sends.
   - Lost first deliveries delayed gates by an estimated 13.3–15.2 unpaused
     minutes per consensus run, 14–26% of each run.
   - The 204 cursor pane shows `-- INSERT --` with a stray leading `a` and a
     `No matches` line beside `/action.md`. This fits the vim prelude problem
     that #206 addressed. All four consensus runs predate #206.
   - Idle misreading before a first send was rare but costly. Only 2 of 107
     first sends came more than 10 s after preparation. One of them, 177's
     antigravity R4 send, waited 29.6 min (`lifecycle-changed`,
     `no-idle-sentinel`) and delayed its gate by about 7 min.
3. **This issue is the first run after the fix, and so far it looks fixed.**
   - Phases R1–R5.compare-ballot (journal sequences 0–1138) had no holds.
   - First sends landed 7 of 7 for each of claude, codex and cursor.
   - No first send was more than 13 s late.
   - Cursor was last in 1 of 7 phases.
   - That is one run, so the metrics need repeating.
4. **Final verification is 48–72% of R7.finalize.**
   - `pnpm run check` took 146–183 s of a 4.0–6.2 min R7 phase. `test:fast`
     was its largest part (77–90 s).
   - Every implementer and reviser commit ran `check:fast` (94–149 s) and
     `test:e2e` (14–38 s) in hooks.
   - Reused results were 0 in every run. This workspace has no
     `verification` block, and the final check has no cache declaration.
5. **Why R1.join can take over two minutes.** It takes as long as the slowest
   agent's first turn.
   - Joins without a hold took 0.73–1.83 min, with cursor last each time.
   - This issue's 160 s join had claude accepted at +24.5 s, codex at +66.2 s
     and cursor at +76.0 s.
   - Antigravity was accepted at +159.9 s. 95 s of that passed between its
     containment probe and its commit hook, and the journal cannot attribute
     them.
   - Hooks skipped in about 1 ms, and the gate advanced 19 ms after the last
     acceptance.

### Proposals (ranked; savings overlap, so do not add them)

1. **Confirm the delivery and idle-readiness fixes with three numbers on the
   next two or three consensus runs:**
   - the per-vendor first-send landing rate;
   - first sends more than 10 s after preparation;
   - cursor's holds.

   This issue's early figures are 21 of 21, 1 and 0. Only if cursor regresses
   should a follow-up treat a send with no `prompt-submitted` within a few
   seconds as lost, and repeat it promptly instead of after the
   ~61/182/423 s back-off. Keep the duplicate guard. The upper bound on the
   saving is ~13–15 unpaused minutes per consensus run, plus the avoided holds.
2. **Notify the owner when a whole-issue hold starts.** Hold-to-release time
   was 78% of the cohort's elapsed time (1,204.8 of 1,536.35 min), including a
   936-minute overnight hold. Holds appear only in `coord status` today.
3. **Turn on coordinator-owned verification with cache receipts.**
   - The feature already exists: `verification.mode: "coordinator"` and the
     cache declarations in `config.example.json`. #175 is related.
   - Hook results never become receipts, so this needs the coordinator mode.
     Hook mode alone will not do it.
   - It should remove most of the 146–183 s final check when the final tree
     matches a checked pin.
   - Its effect on R4 and R6 has to be measured with the reused-results and
     time-avoided figures from `coord analytics`.
4. **R1.join.** A response-mode join would save only the 6–23 s of commit and
   push per agent, so at most about 25 s per run. The two-minute case is a
   slow agent, not coordinator overhead.
5. **Use `--profile reviewed` for small, low-risk issues.** R5.compare,
   R5.compare-ballot and R6.* took 28–33% of unpaused time, though this gives
   up comparing implementations. Solo 206 (18.98 min) was a different task, so
   no speedup is claimed from it.

Not worth pursuing on this evidence:
- Coordinator processing.
- Ballot batch publication (1.7–4.9 s).
- `nudge-deferred` counts, which are mostly normal `working` deferrals.
- Ballot quorums or automatically dropping slow agents, which would trade
  consensus for time while the delivery fix is still being confirmed.
<!-- comment-body:end -->

## Publication receipt

Not posted yet. The comment body above is posted once, after the revision
ballot approves this revision, during R7.finalize:
- extract the text between the delimiters into a temporary file;
- check the existing comments on `gwhizoftv/4horsemen#209` for the
  `coord-issue-209-analysis` marker, and update that comment instead of adding
  one if it exists;
- post with `gh issue comment 209 --repo gwhizoftv/4horsemen --body-file <file>`;
- read the posted body back and compare it with the file.

The resulting URL is reported in the finalization evidence and the pull
request body, not by editing this approved document.
