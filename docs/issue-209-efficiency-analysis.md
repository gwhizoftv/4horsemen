# Issue 209: Phase-Length Analysis and Coordination Efficiency Proposal

## 1. Executive Summary

An empirical analysis of the five most recent coordinator runs (issues 177, 195, 184, 204, and 206) reveals that coordination wall-clock time is heavily dominated by two distinct categories of delay:
1. **Unresponsive-agent holds**: Coordinator holds caused by agents exhausting their nudge budget (`nudge-loop` and `delivery-uncertain`) contributed **1,204.77 minutes** (~20.1 hours) of idle pause time across issues 177, 184, and 195 while awaiting manual owner release.
2. **Straggler synchronization barriers and redundant execution**: In parallel consensus phases (R1.join, R2.plan, R4.implement, R5.compare), gate advancement requires barrier synchronization across the entire roster. Faster agents sit completely idle for 50–75% of a phase's active duration waiting for the slowest agent.

In contrast, Issue 206 run under the `solo` profile completed all gates in **18.98 minutes** without review, compare, or ballot overhead.

Implementing the ranked efficiency proposals detailed herein—specifically automated ballot quorum, circuit-breaker auto-dropping for looping agents, artifact-only bypass for finalization verification, and response-mode readiness—can reduce multi-agent consensus run times from **75–120+ active minutes down to 30–45 minutes**, while eliminating multi-hour unattended hold deadlocks.

---

## 2. Cohort Inventory and Methodology

The analyzed cohort comprises the five most recent completed issue runs under `<coord-runtime>`, ordered chronologically by `start.json.createdAt`:

| Issue | Start Time (UTC) | Profile | Original Roster | Terminal Status |
| --- | --- | --- | --- | --- |
| **177** | 2026-10-10T22:48:18.145Z | consensus | claude, codex, cursor, antigravity | complete (3,418 events) |
| **195** | 2026-10-12T22:43:41.151Z | consensus | claude, codex, cursor | complete (723 events) |
| **184** | 2026-10-13T20:31:20.486Z | consensus | claude, codex, cursor | complete (625 events) |
| **204** | 2026-10-14T01:55:48.449Z | consensus | claude, codex, cursor | complete (768 events) |
| **206** | 2026-10-14T03:24:28.568Z | solo | claude | complete (71 events) |

*Note: Issue 172 is older and excluded. Issue 184 started after Issue 195. Issue 209 is the active run and excluded from the historical cohort (analyzed separately as a supplemental diagnostic for R1.join).*

### Methodology & Reproducibility
All primary phase timings, paused intervals, verification totals, and agent latencies are directly reproduced via:
```sh
coord analytics --issue <N> --coord-runtime <coord-runtime>
```
- **Phase intervals**: Computed from `started` and `gate-advanced` event timestamps.
- **Paused intervals**: Computed from `paused`/`resumed` and `hold-created`/`hold-released` timestamps overlapping each phase.
- **Unpaused time**: Exact elapsed time minus intersecting pause duration.

---

## 3. Per-Issue, Per-Phase Duration Analysis

### 3.1 Overview of Elapsed vs. Unpaused Time

| Issue | Total Elapsed (min) | Total Paused (min) | Total Unpaused (min) | Active Phases |
| --- | ---: | ---: | ---: | :---: |
| **177** | 1,072.90 | 969.47 | 103.43 | 12 |
| **195** | 74.08 | 2.68 | 71.41 | 10 |
| **184** | 290.67 | 232.62 | 58.04 | 10 |
| **204** | 79.72 | 0.00 | 79.72 | 10 |
| **206** | 18.98 | 0.00 | 18.98 | 4 |

### 3.2 Phase Breakdown Table (Durations in Minutes)

| Phase | Issue 177 (Elapsed / Unpaused) | Issue 195 (Elapsed / Unpaused) | Issue 184 (Elapsed / Unpaused) | Issue 204 (Elapsed / Unpaused) | Issue 206 (Elapsed / Unpaused) | Consensus Unpaused Median |
| --- | :---: | :---: | :---: | :---: | :---: | :---: |
| **R1.join** | 21.29 / 4.28 | 0.97 / 0.97 | 1.32 / 1.32 | 1.83 / 1.83 | 0.73 / 0.73 | 1.58 |
| **R2.plan** | 8.12 / 8.12 | 8.03 / 8.03 | 6.18 / 6.18 | 8.60 / 8.60 | 4.14 / 4.14 | 8.08 |
| **R3.review** | 29.20 / 12.70 | 6.28 / 6.28 | 5.14 / 5.14 | 5.14 / 5.14 | N/A | 5.71 |
| **R3.plan-ballot** | 0.85 / 0.85 | 11.65 / 8.97 | 0.89 / 0.89 | 1.90 / 1.90 | N/A | 1.40 |
| **R4.implement** | 40.51 / 40.51 | 20.26 / 20.26 | 76.38 / 19.76 | 34.12 / 34.12 | 10.11 / 10.11 | 27.19 |
| **R5.compare** | 950.65 / 14.70 | 6.92 / 6.92 | 5.95 / 5.95 | 8.42 / 8.42 | N/A | 7.67 |
| **R5.compare-ballot** | 4.98 / 4.98 | 5.48 / 5.48 | 0.51 / 0.51 | 5.00 / 5.00 | N/A | 4.99 |
| **R6.revise (R1)** | 2.13 / 2.13 | 9.31 / 9.31 | 4.55 / 4.55 | 5.41 / 5.41 | N/A | 4.98 |
| **R6.ballot (R1)** | 0.59 / 0.59 | 0.84 / 0.84 | 183.97 / 7.96 | 3.13 / 3.13 | N/A | 1.99 |
| **R6.revise (R2)** | 8.82 / 8.82 | N/A | N/A | N/A | N/A | N/A |
| **R6.ballot (R2)** | 1.27 / 1.27 | N/A | N/A | N/A | N/A | N/A |
| **R7.finalize** | 4.50 / 4.50 | 4.35 / 4.35 | 5.77 / 5.77 | 6.17 / 6.17 | 4.00 / 4.00 | 5.14 |

---

## 4. Bottleneck Attribution and Evidence

### 4.1 Coordinator Holds and Stalls (The 80%+ Elapsed Delay Driver)
Every recorded hold in the cohort was triggered by a single agent (`cursor`) exhausting its nudge budget or failing delivery confirmation:
- **Issue 177**:
  - `delivery-uncertain` in R1.join: 17.01 min pause (22:48:21Z to 23:05:22Z).
  - `nudge-loop` in R3.review: 16.50 min pause (23:25:36Z to 23:42:06Z).
  - `nudge-loop` in R5.compare: **935.95 min pause** (~15.6 hours, 00:36:06Z to 16:12:03Z) overnight until owner released hold.
- **Issue 184**:
  - `nudge-loop` in R4.implement: 56.62 min pause (20:52:42Z to 21:49:19Z).
  - `nudge-loop` in R6.ballot: **176.01 min pause** (~2.9 hours, 22:20:05Z to 01:16:05Z) awaiting owner release.
- **Issue 195**:
  - `nudge-loop` in R3.plan-ballot: 2.68 min pause (23:06:46Z to 23:09:27Z).

*Impact*: When an agent enters a nudge-loop, the coordinator halts the entire issue until an owner executes `coord resume` or releases the hold. If the owner is away, progress stops completely.

### 4.2 Straggler Synchronization in Parallel Phases
In consensus runs, parallel phases cannot advance until the slowest agent completes:
- **R4.implement (Issue 204)**:
  - Claude finished in **11.3 min** (673.8s wait).
  - Codex finished in **17.5 min** (1,046.8s wait).
  - Cursor finished in **34.1 min** (2,043.7s wait).
  - *Result*: Claude sat idle for **22.8 minutes** waiting for Cursor before R5 could begin.
- **R2.plan (Issue 204)**:
  - Claude: 4.3 min; Codex: 4.9 min; Cursor: 8.6 min (Straggler gap: 4.3 min).
- **R5.compare (Issue 204)**:
  - Claude: 2.4 min; Cursor: 5.1 min; Codex: 8.4 min (Straggler gap: 6.0 min).

### 4.3 Verification Runner Overhead
Across all five runs, `verification-run` records show significant time spent executing test suites:
- **Issue 177**: 903.6s aggregate (13 runners, 44 skipped, 25 artifact validations).
- **Issue 195**: 740.7s aggregate (10 runners, 31 skipped, 17 artifact validations).
- **Issue 184**: 555.3s aggregate (7 runners, 32 skipped, 17 artifact validations).
- **Issue 204**: 783.7s aggregate (10 runners, 31 skipped, 17 artifact validations).
- **Issue 206**: 420.8s aggregate (4 runners, 8 skipped, 4 artifact validations).

*Key finding on Finalization*: In all consensus issues, R7.finalize takes 4.3–6.2 minutes. Over **146–183 seconds** (~3 minutes) of this phase is spent by the coordinator running the full product check (`pnpm run check`) in an isolated temporary worktree. Because `config.json` lacks a `documentation` profile, commits deleting coordination files (`.plans/`, `.signals/`, `.code-reviews/`) are classified as `product` changes and undergo full verification even though the approved pin already passed those exact checks.

---

## 5. Owner Guidance Investigation: Why R1.join Exceeds Two Minutes

Owner guidance on Issue 209 asked: *"why does phase 1 R1.join take over two minutes?"*

Analyzing the closed R1.join interval of Issue 209 itself (sequences 0–165, elapsed 159.956s / 2.67 min, zero pauses) provides the direct empirical answer:

### Turnaround Breakdown for Issue 209 R1.join:
1. **Initial Dispatch**: Coordinator dispatched action prompts to all 4 agents within **8.2 seconds** of start (`started` at 03:55:51.161Z; last nudge at 03:55:56.501Z).
2. **Submission Turnarounds**:
   - **Claude**: Nudged at 03:55:54.979Z → accepted at 03:56:15.690Z (**20.7s total turnaround**).
   - **Codex**: Nudged at 03:55:55.541Z → accepted at 03:56:57.399Z (**61.8s total turnaround**).
   - **Cursor**: Nudged at 03:55:55.942Z → accepted at 03:57:07.112Z (**71.2s total turnaround**).
   - **Antigravity**: Nudged at 03:55:56.501Z → accepted at 03:58:31.098Z (**154.6s total turnaround**).
3. **Coordinator Validation & Advancement**: Coordinator validated Antigravity's completion and advanced the gate to R2.plan at 03:58:31.117Z (**0.019s coordinator latency**).

### Root Causes:
1. **Barrier Synchronization on the Slowest Harness**: Gate advancement requires 100% roster readiness. Even though Claude completed in 20.7 seconds, the phase remained open for 160.0 seconds waiting for Antigravity (154.6s). Claude waited idle for **2 minutes 19 seconds**.
2. **Serial Diagnostic Tool Chaining**: In R1, agents must sequentially:
   - Request `git status --porcelain` to verify the pre-tool containment hook denial.
   - Run `coord containment-probe` via shell tool.
   - Write the JSON participation signal.
   - Run `git add`, `git commit`, and `git push` to origin.
   - Write the `complete` marker.
   On slower harnesses, this multi-step tool sequence takes 1.5–2.5 minutes of CLI invocation overhead.

---

## 6. Ranked Efficiency Proposals

### Proposal 1: Fast-Quorum and Auto-Abstention for Ballot Phases (R3, R5, R6)
- **Observed Problem**: Ballot phases (R3.plan-ballot, R5.compare-ballot, R6.ballot) are simple private JSON submissions, yet they took up to **11.65 min** (Issue 195) and **184 min** (Issue 184) because the coordinator waited for an unresponsive agent. In Issue 184 R6.ballot, Claude and Codex voted within 25 seconds, but the phase hung for 3 hours waiting for Cursor.
- **Proposed Change**:
  - Implement a **fast-quorum rule**: If a clear mathematical majority (e.g. 2 of 3, or 3 of 4) is reached, or if a straggler has not submitted within 60 seconds of the quorum, record the straggler as `abstain` and advance the gate immediately.
- **Estimated Savings**: **3–10 minutes** on healthy ballot phases; eliminates multi-hour stalls on lagging agents.
- **Risk / Safety**: Low. Majority consensus is preserved; abstaining agents cannot block collective progress.

### Proposal 2: Circuit-Breaker Auto-Sidelining for Nudge-Looping Agents
- **Observed Problem**: When an agent fails to respond to nudges, the coordinator creates a `hold-created` (`nudge-loop`), suspending the issue indefinitely until human intervention (accounting for **936 min** in Issue 177 and **176 min** in Issue 184).
- **Proposed Change**:
  - Instead of halting the entire issue on an agent-specific nudge loop, automatically transition the unresponsive agent to `sidelined`/`dropped` for the remainder of the phase or issue, provided the remaining active roster satisfies minimum quorum (e.g. at least 2 active consensus agents).
  - Send an asynchronous alert rather than entering a blocking hold.
- **Estimated Savings**: **100–900+ minutes** in unattended runs; prevents total pipeline deadlocks.
- **Risk / Safety**: Medium. Requires clear quorum rules so an issue does not degrade to an unmonitored solo run unintentionally.

### Proposal 3: Coordination Evidence Bypass for Finalization Verification
- **Observed Problem**: In R7.finalize, the coordinator runs full product verification (`pnpm run check`), consuming **146–183 seconds** (~3 minutes), even though the finalizing commit only removes `.plans/`, `.signals/`, and `.code-reviews/`.
- **Proposed Change**:
  - In `src/changeClassification.ts` and `src/runLoop.ts`, if `git diff <approvedPin> <finalCommit>` consists *exclusively* of deletions in coordination directories, bypass re-running the heavy test suite and inherit the verified status of the approved pin.
- **Estimated Savings**: **2.5–3.0 minutes** per issue run (reducing R7.finalize from ~5–6 min down to ~1–2 min).
- **Risk / Safety**: Zero. The product code at the approved pin was already 100% verified; deleting untracked markdown evidence files cannot introduce build or test regressions.

### Proposal 4: Response-Mode Participation Readiness for Phase 1 (R1.join)
- **Observed Problem**: R1.join takes 1.5–2.7 minutes because all agents must execute git add, git commit, and git push for a trivial 6-line participation signal.
- **Proposed Change**:
  - Convert R1.join from `submissionMode: git` to `submissionMode: response` (identical to ballot actions). Agents write their readiness JSON directly to their runtime response path.
  - Cache containment probe validation across issues for unchanged harness environments.
- **Estimated Savings**: **1.0–1.5 minutes** per issue start (reducing R1.join to < 30 seconds).
- **Risk / Safety**: Low. Participation readiness does not alter repository history; Git verification is unnecessary before R2.plan.

### Proposal 5: Adoption of "Solo-with-Review" (Hybrid Profile)
- **Observed Problem**: Issue 206 (Solo) completed in **18.98 minutes**, whereas Consensus issues required **74–103+ unpaused minutes** due to 3–4 agents independently implementing and reviewing duplicate solutions.
- **Proposed Change**:
  - Introduce a hybrid `assisted` or `reviewed-solo` profile: 1 agent plans and implements (avoiding 20–40 min of duplicate implementation in R4), while 2 peer agents conduct plan review (R3) and code review (R5).
- **Estimated Savings**: **35–50 minutes** per standard issue compared to full multi-agent consensus.
- **Risk / Safety**: Low. Retains multi-agent review rigor while eliminating redundant code generation.

---

## 7. Standalone GitHub Issue Comment Payload

The text below between the markers constitutes the exact payload to be published as a comment to GitHub Issue #209:

<!-- coord-issue-209-analysis -->
### Coordination Phase Duration Analysis & Efficiency Proposal (Issues 177, 195, 184, 204, 206)

An empirical analysis of the last 5 coordinator runs reveals the primary drivers of phase length across multi-agent consensus workflows:

#### 1. Phase Timing & Bottleneck Summary
- **Unattended Holds Dominate Elapsed Time**: In Issue 177 (969 min paused) and Issue 184 (233 min paused), over 80% of elapsed time was spent in `nudge-loop` coordinator holds on a stalled agent awaiting manual owner release (`coord resume`).
- **Unpaused Consensus Baseline**: Across healthy consensus runs without holds (Issue 204: 79.7 min; Issue 195: 71.4 min unpaused; Issue 184: 58.0 min unpaused), active time is dominated by:
  - **R4.implement (20–40 min)**: Dictated by straggler barrier synchronization (e.g. in Issue 204, Claude finished in 11.3 min but waited 22.8 min for Cursor to complete).
  - **R2.plan (6–8.6 min)**: Parallel planning waiting on slowest planner.
  - **R7.finalize (4.3–6.2 min)**: ~3 minutes spent re-running the full `pnpm run check` test suite (146–183s) on evidence deletion commits.
- **Solo Profile Efficiency**: Issue 206 ran in **18.98 minutes** (solo profile), demonstrating that multi-agent ballot and duplicate implementation overhead accounts for >50 min of wall-clock time.

#### 2. Why Phase 1 (R1.join) Exceeds Two Minutes
Direct analysis of Issue 209's R1.join (elapsed 160s, 0s pause) shows:
- Initial prompt delivery took only 8.2s.
- Claude finished readiness in **20.7s**, Codex in **61.8s**, Cursor in **71.2s**, and Antigravity in **154.6s**.
- The phase took 2m 40s solely because gate advancement requires 100% barrier synchronization; faster agents waited idle for over 2 minutes while slower harnesses executed multi-step serial tool calls (`git status` probe, `coord containment-probe`, JSON write, `git add/commit/push`).

#### 3. Top 4 Actionable Proposals to Shorten Phases
1. **Ballot Fast-Quorum (Saves 3–10 min, avoids multi-hour stalls)**: In R3, R5, and R6 ballots, close the vote once a mathematical majority has voted or after a 60s cutoff, treating unresponsive agents as abstentions.
2. **Circuit-Breaker Auto-Drop for Nudge-Loops (Saves 100–900+ min)**: Instead of entering an indefinite owner hold when an agent exhausts its nudge budget, sideline the unresponsive agent and continue the run if minimum quorum remains.
3. **Evidence-Only Bypass in Finalization (Saves 2.5–3 min per issue)**: If the finalization commit only deletes `.plans/`, `.signals/`, and `.code-reviews/`, skip the 180s full `pnpm run check` and rely on the already-passed verification from the approved pin.
4. **Response-Mode Readiness for R1 (Saves 1–1.5 min per issue)**: Switch R1 participation readiness from Git commit/push to private response JSON, eliminating branch push latency and tool chaining during join.
<!-- coord-issue-209-analysis -->

---

## 8. Publication Receipt

- **Target Issue**: `https://github.com/gwhizoftv/4horsemen/issues/209`
- **Publication State**: Ready for publication by the selected reviser during finalization.
- **Publication Command**:
  ```sh
  gh issue comment 209 --repo gwhizoftv/4horsemen --body-file docs/issue-209-efficiency-analysis.md
  ```
