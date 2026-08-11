# Code review — `issue-1/claude`

**Reviewer:** Cursor  
**Target:** `origin/issue-1/claude` @ `6b3ad79`  
**Compared to:** merge-base with `main` (`14d052a`)  
**Authority:** `.plans/issue-1/plan.md`, `.plans/issue-1/workflow-algorithm.md`

## Findings

### [P1] Do not verify finalization against the consensus SHA itself — `src/runLoop.ts:610`

`finalize` sets `finalSha = consensusSha` and then calls `verifyFinalization` with both arguments identical. A same-SHA range always has an empty diff, so the cleanup-only ancestry/path check passes vacuously without requiring any post-consensus deletion commit. Configured checks and optional PR creation then run against the implementation pin rather than a cleanup head. The adopted plan requires a distinct final SHA whose only changes are current-issue coordination deletions.

### [P1] Do not treat empty coordinator participant sets as a completed gate — `src/machine.ts:74`

`gateComplete` uses `participantsFor(...).every(...)`. For `participation: "coordinator"` steps, `participantsFor` returns `[]` (`src/steps.ts:283`), and `[].every(...)` is always true. `R7.finalize` is coordinator-only (`src/steps.ts:220-224`), so `gate-7-finalized` becomes complete as soon as it is entered and the machine emits `finalize` without any agent cleanup evidence. The same vacuous rule also makes `R6.declare` auto-satisfied once revise/ballot agents finish.

### [P1] Wire consensus-ballot dispositions into revision accounting — `src/runLoop.ts:280`

`machineInputFrom` hard-codes `revisionRequested: false`. `revisionExhausted` therefore never fires (`src/machine.ts:96`), and `decide` never routes a “revise” ballot outcome into another R6 round or an owner wait at `maxRevisionRounds`. After revise+ballot work is accepted, the gate advances toward finalization even when ballots asked for revision. `maxRevisionRounds: 3` is effectively dead configuration.

### [P2] Contain `finalChecks[].cwd` under the verification worktree — `src/runLoop.ts:651`

When `check.cwd` is set, the loop builds `${worktree}/${check.cwd}` by string concatenation with no containment check. The Zod schema allows any non-empty string (`src/state.ts:37`). A config value such as `../...` escapes the throwaway worktree and can run owner check argv against an arbitrary directory, contrary to the path-confinement policy used elsewhere.

### [P2] Stop `coord run` when the durable pause flag is set — `src/runLoop.ts:709`

`decide` returns `wait` while paused, but `runLoop` only exits on `finalized`, `awaitingOwner`, or `abandoned`. A running `coord run` therefore keeps polling forever after `coord pause`. Codex’s loop exits on pause; this implementation leaves the owner with no clean pause-induced shutdown path beyond killing the process.

### [P3] Clear the dropped agent’s `complete` file in the drop command — `src/cli.ts:405`

`coord drop` journals the drop and updates `droppedAgents`, but only reads a pending completion for a log line. Clearing is deferred to a later tick via `clear-completion`. The plan’s drop atomic change includes ignore/clear of that agent’s pending operational completion in the same local update.

## Overall assessment

Stage A/B structure is strong: pure `machine.ts`, restricted `action.md` front matter, solid path confinement, mirror transient/fetch split, drop-final-agent refusal, and a real four-agent canary with fast/e2e vitest split. The blocking gaps are in R6/R7 control flow—finalization never inspects a cleanup commit, coordinator gates complete vacuously, and revision dispositions are ignored—so the driver can declare success without the cleanup or revision behavior the adopted plan requires.

## Material test gaps

- No test that `verifyFinalization` is invoked with `finalSha !== consensusSha` and fails when non-cleanup paths remain.
- No machine test that a gate whose only step is `participation: "coordinator"` stays incomplete until an explicit coordinator effect succeeds.
- No test that ballot `disposition: "revise"` starts another revision round, or that round 3 revise requests owner action instead of round 4.
- No test that `finalChecks[].cwd` cannot escape the verification worktree.
