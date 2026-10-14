# Issue 209 Plan Review

## Findings

### 1. Cursor Plan: Premature public comment publication during R4 implementation
- **Plan claim or section**: Cursor's plan, §Tests (line 50): *"Push the commit, then post the committed file with `gh issue comment 209 --repo gwhizoftv/4horsemen --body-file docs/issue-209-phase-efficiency.md`."*
- **Rule that must hold**: Outward-facing public mutations (such as posting comments to GitHub issues) must occur exactly once from an approved implementation pin, never concurrently from unapproved candidate branches during R4.implement.
- **Concrete failure**: In consensus mode, all active agents implement concurrently in R4. If an agent executes `gh issue comment` upon pushing its implementation commit, multiple competing, unapproved drafts will be posted publicly to GitHub Issue #209 before review, comparison, or consensus selection takes place, cluttering public issue history.
- **Smallest correction**: Restrict publication of the issue comment to R7.finalize by the finalizing agent after final checks pass, or authorize only the selected reviser during finalization, accompanied by an idempotency check (`gh issue view 209 --comments`) to avoid duplicates.

### 2. Codex Plan: Publication during R6.revise before final acceptance
- **Plan claim or section**: Codex's plan, §Reuse and Scope (lines 104-107): *"During `R6.revise`, the coordinator-selected reviser consolidates the findings and publishes the single report's comment section to #209."*
- **Rule that must hold**: Outward-facing deliverables must not be published until candidate verification and revision ballots have confirmed acceptance of the revision.
- **Concrete failure**: If a revision submitted during R6 fails verification or is rejected in `R6.ballot` (triggering another revision round, as occurred in Issue 177 where R6 repeated twice), an incomplete or rejected revision text will already have been published to GitHub Issue #209.
- **Smallest correction**: Defer publication to R7.finalize once `R6.ballot` approves the revision and the issue advances to finalization.

### 3. All Peer Plans: Omission of R1.join latency root cause and mitigation (Owner Guidance)
- **Plan claim or section**: The peer plans in §Reuse and Scope and §Proposals omit a dedicated analysis of Phase 1 (R1.join) overhead, despite explicit Owner Guidance asking: *"why does phase 1 R1.join take over two minutes?"*
- **Rule that must hold**: The analysis and proposal must examine every coordination phase and directly investigate bottlenecks highlighted by owner guidance.
- **Concrete failure**: If the proposal focuses only on execution phases (R4, R5, R6), it overlooks why R1.join consistently takes 1.5–2.5 minutes (e.g. 2.68 min in Issue 209, 21.29 min in Issue 177). The root causes—barrier synchronization waiting for the slowest agent to boot and complete its turn, multi-step containment probe execution (`git status` refusal + `coord containment-probe`), and remote branch pushing—remain undocumented, and opportunities to streamline agent join protocols are missed.
- **Smallest correction**: Include a dedicated R1.join section in the proposal detailing:
  1. *Straggler barrier synchronization*: In Issue 209, Claude finished R1 in 20.7s, Codex in 62.4s, Cursor in 71.6s, and Antigravity in 154.9s. The phase took 2m 40s because gate advancement requires 100% participation; faster agents spend 2+ minutes completely idle waiting for the slowest agent.
  2. *Containment probe chaining*: The mandatory containment diagnostic requires serial tool execution (requesting `git status --porcelain`, capturing the refusal, executing `coord containment-probe`, writing the JSON signal, staging, committing, and pushing).
  3. *Concrete mitigation*: Propose switching R1 to response-mode private JSON (avoiding Git commit/push overhead for readiness signals) and caching containment probe results across runs when the harness environment and hooks are unchanged.

### 4. File Path Harmonization
- **Plan claim or section**: The plans propose varying deliverable paths: Claude and Cursor propose `docs/issue-209-phase-efficiency.md`, Codex proposes `docs/issue-209-efficiency-analysis.md`, and Antigravity proposed `docs/phase-efficiency-proposal.md`.
- **Rule that must hold**: Peer implementations must converge on a single canonical deliverable path to enable meaningful comparison and clean review.
- **Concrete failure**: Divergent file paths across implementations create unnecessary file conflicts during consensus comparison.
- **Smallest correction**: Standardize on `docs/issue-209-phase-efficiency.md` (the majority convention shared by Claude and Cursor), which aligns with repository conventions like `docs/issue-193-plan.md` and `docs/issue-197-plan.md`.

## Conclusion

All four plans correctly identify that Issue #209 is an analytical and proposal deliverable that modifies no existing product code, correctly select the five most recent completed runs (issues 177, 184, 195, 204, and 206), and recognize that `coord analytics` provides the foundational metrics.

Claude's plan provides the most robust methodology for dissecting phase durations (separating coordinator lead, delivery, pickup, active agent work, straggler wait, coordinator tail, and pause/hold time). Adopting Claude's structure, combining it with Codex's rigorous verification overlap analysis, standardizing on `docs/issue-209-phase-efficiency.md`, deferring GitHub comment publication strictly to R7.finalize, and incorporating the detailed root-cause analysis for R1.join provides the optimal implementation blueprint.
