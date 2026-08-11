# Code review: Cursor implementation for issue 1

- Reviewed head: `184f5b66fbb3bf96cf8987e931af804707857eeb`
- Baseline: `origin/main` at `14d052a3bd52997b79dd5806f47e4ef384cf9d2b`
- Validation: `nvm use 26 && pnpm check` passed in a detached worktree.

## Verdict

**Major changes required; do not use as the primary revision base.** The package compiles and its focused tests pass, but the operational workflow is largely a scaffold. The integration suite never advances all agents through even the join gate, so it does not exercise the missing selection, revision, finalization, tmux, or PR behavior. Across all three implementations my ranking is **Codex first, Claude second, Cursor third**; the detailed base recommendation and Codex prerequisites are recorded in `review-claude.md`.

## Findings

### [P0] Multi-step gates are overwritten/skipped, and the machine can never finalize

For a gate with multiple steps, `src/machine.ts:38-44` emits every `prepare-action` for every agent in one decision batch. `src/runLoop.ts:147-159` stores only one `stepId` and one action per agent, so each later preparation overwrites the previous one. Then `src/machine.ts:63-66` treats the agent's generic `status === "complete"` as satisfying every step in the gate, allowing the overwritten review/compare/revision work to be skipped.

Finalization is also unreachable: the machine only emits `advance-gate` (`src/machine.ts:33-50`) and never emits its `finalize` decision. At the last gate `applyDecisions` cannot advance further, while its `finalize` case would only append a journal event anyway (`src/runLoop.ts:139-176`). Redesign cursor state around per-step satisfaction and ordered participation, implement coordinator-internal selection/declaration/finalization decisions, and prove R0-R7 end to end before revision work starts.

### [P1] `start` binds the run to fabricated all-zero commits and can succeed without a mirror

`src/cli.ts:97-115` hard-codes both `baselineSha` and `trustedSourceCommit` to forty zeroes instead of fetching and resolving origin's configured base branch. That makes the join contract fictional and causes later ancestry checks to fail. `src/cli.ts:160-165` then swallows every mirror initialization error and still reports a successful start.

Fetch origin explicitly, persist the real immutable baseline/trusted-source values, classify startup failures, and do not create a usable run until the mirror is ready.

### [P1] Tmux startup/delivery and final checks/PR creation are not connected to the product

The CLI does not import `src/tmux.ts`; `cmdStart` only writes pull actions and never validates or launches `start-<agent>.sh`. The run loop never checks panes or performs the Claude-only buffer nudge. Likewise, it never imports or calls `verifyFinalization`, never creates a clean worktree, never runs configured explicit-argv checks, and never opens an authorized unmerged PR; the `finalize` branch at `src/runLoop.ts:170-176` only journals.

Wire these boundaries into `start`, delivery, liveness/recovery, and R7, with injected runners and integration coverage. Retain non-Claude pull-only behavior and no merge capability.

### [P1] Pause and abandon do not stop the loop, and `answer` is absent

`executePause` persists `cursors.paused`, but neither `runTick` nor `decide` reads that field (`src/runLoop.ts:18-83`, `src/machine.ts:15-52`), so evidence continues to be consumed and gates can advance while paused. `cmdAbandon` at `src/cli.ts:269-275` only journals and persists no abandoned state, so `runLoop` continues as well. The required `answer` command is missing from dispatch at `src/cli.ts:22-31`.

Make all owner controls durable machine inputs, suppress effects while paused/abandoned, implement restart recovery and `answer`, and test controls with pending valid completions.

### [P1] Action IDs expose the exact internal step and attempt

`src/action.ts:19-22` returns `issue-${issue}:${agent}:${stepId}:${attempt}` while claiming the value is opaque. This directly exposes the forbidden internal step through both `action.md` and `coord next` (`src/cli.ts:197-201`). Replace it with an opaque UUID or digest whose rendered value does not encode step/gate/phase/evidence/global state, and add negative leakage tests.

### [P1] Ballots are accepted without validating their bound inputs or decisions

`src/evidence.ts` deliberately leaves `inputCommits` unused in plan, comparison, and consensus ballot evaluators (`evaluatePlanBallot`, `evaluateCompareBallot`, and `evaluateConsensusBallot`). Those predicates accept an envelope-valid ballot without checking citations, input-set hashes, choices/pins, rounds, or consensus disposition. Meanwhile `src/runLoop.ts:86-95` derives inputs from each peer's single most recent submission instead of the exact commits published for the required source step. There is no tally for plan selection, implementation selection, or consensus.

Persist published commits per step, bind actions to exact active-roster inputs, validate every cited pin/hash/round/disposition at the submitted SHA, and add deterministic selection/revision tallies including drop rederivation.

### [P1] Unvalidated agent IDs can escape the external control root

Config is parsed as unchecked JSON (`src/cli.ts:88-97`), and path helpers pass the agent ID directly to `resolve` (`src/paths.ts:34-60`). An ID such as `../../../outside` can redirect action/completion writes outside the issue tree. Only the top-level root symlink is checked; derived paths and intermediate symlinks are not containment-checked.

Use strict config/state schemas, restrict agent IDs, and containment/symlink-check every derived read/write path before any filesystem mutation.

### [P2] Every fetch failure is treated as transient

`src/mirror.ts:24-34` maps missing refs, authentication errors, repository errors, and network outages to the same `MirrorFetchError`; `src/runLoop.ts:29-40` preserves completion and silently retries all of them. The required boundary distinguishes transport failure from an origin-confirmed missing branch/artifact so permanent absence can produce concrete outstanding work. Return a typed fetch outcome and test both classes.

## Test coverage required before reconsideration

Replace the current shallow canary with the planned four-agent origin-backed workflow through finalization: exact-SHA join for all agents, plans/reviews/ballots, selection, implementations and comparison, one owner drop with rederived inputs, one requested revision, consensus declaration, cleanup-only verification, configured checks, and proof that no merge occurs. Include negative cases for pause/abandon, wrong-branch SHA, missing ref versus transient outage, and path traversal.
