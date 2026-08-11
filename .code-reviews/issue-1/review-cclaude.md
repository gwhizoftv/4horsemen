# Code review — `issue-1/claude`

**Reviewer:** Cursor  
**Target:** `origin/issue-1/claude` @ `6b3ad79`  
**Compared to:** merge-base with `main` (`14d052a`)  
**Authority:** `.plans/issue-1/plan.md`, `.plans/issue-1/workflow-algorithm.md`

## Findings

### [P1] Do not overwrite concurrent owner drop/pause/abandon from a live `coord run` — `src/runLoop.ts:518`

`cmdRun` loads cursors once into memory; every `runTick` ends with `saveCursors` from that in-memory snapshot. A parallel `coord drop` / `pause` / `abandon` writes `cursors.json`, then the next tick rewrites the file without those fields and silently undoes the control. Docs tell the owner to drop/pause while the control plane is live, so this is the intended concurrent path.

### [P1] Do not verify finalization against the consensus SHA itself — `src/runLoop.ts:610`

`finalize` sets `finalSha = consensusSha` and then calls `verifyFinalization` with both arguments identical. A same-SHA range always has an empty diff, so the cleanup-only ancestry/path check passes vacuously without requiring any post-consensus deletion commit. Configured checks and optional PR creation then run against the implementation/signal pin rather than a cleanup head. The adopted plan requires a distinct final SHA whose only changes are current-issue coordination deletions.

### [P1] Do not treat empty coordinator participant sets as a completed gate — `src/machine.ts:74`

`gateComplete` uses `participantsFor(...).every(...)`. For `participation: "coordinator"` steps, `participantsFor` returns `[]` (`src/steps.ts:283`), and `[].every(...)` is always true. `R7.finalize` is coordinator-only (`src/steps.ts:220-224`), so `gate-7-finalized` becomes complete as soon as it is entered and the machine emits `finalize` without any agent cleanup evidence. The same vacuous rule also makes `R6.declare` auto-satisfied once revise/ballot agents finish.

### [P1] Wire consensus-ballot dispositions into revision accounting — `src/runLoop.ts:280`

`machineInputFrom` hard-codes `revisionRequested: false`. `revisionExhausted` therefore never fires (`src/machine.ts:96`), and `decide` never routes a “revise” ballot outcome into another R6 round or an owner wait at `maxRevisionRounds`. Round is also not incremented past the initial `1` set on entering gate-6. After revise+ballot work is accepted, the gate advances toward finalization even when ballots asked for revision. `maxRevisionRounds: 3` is effectively dead configuration.

### [P1] Select the reviser from comparison ballots before gate-6 — `src/runLoop.ts:435`

`selected` is set from plan ballots when entering implementation. Advancing into gate-6 only reselects when `selected` is null or dropped, and `selectFromBallots` tallies only `R3.plan-ballot` (`src/runLoop.ts:532-571`). Gate-5 comparison `choice` values are ignored, so R6 revision can target the plan winner rather than the comparison winner.

### [P1] Wire a production `openPullRequest` when `prPolicy` is `coord-open-unmerged` — `src/runLoop.ts:725`

`defaultDeps` omits `openPullRequest`. `finalize` only opens a PR when that callback is present (`src/runLoop.ts:676-677`), and `cmdRun` uses `defaultDeps` unless tests inject otherwise. A config with `prPolicy: "coord-open-unmerged"` always reports success with no PR.

### [P2] Contain `finalChecks[].cwd` under the verification worktree — `src/runLoop.ts:651`

When `check.cwd` is set, the loop builds `${worktree}/${check.cwd}` by string concatenation with no containment check. The Zod schema allows any non-empty string (`src/state.ts:37`). A config value such as `../...` escapes the throwaway worktree and can run owner check argv against an arbitrary directory, contrary to the path-confinement policy used elsewhere.

### [P2] Stop `coord run` when the durable pause flag is set — `src/runLoop.ts:709`

`decide` returns `wait` while paused, but `runLoop` only exits on `finalized`, `awaitingOwner`, or `abandoned`. A running `coord run` therefore keeps polling forever after `coord pause`. Docs say pause lets the coordinator exit cleanly for a later `resume` + `run`; instead `run` spins forever.

### [P2] Clear the dropped agent’s `complete` file in the drop command — `src/cli.ts:405`

`coord drop` journals the drop and updates `droppedAgents`, but only reads a pending completion for a log line and never calls `clearCompletion`. Combined with the live-run overwrite bug above, that pending file may never be observed as dropped.

## Overall assessment

Stage A boundaries are solid: pure `machine.ts`, restricted `action.md` front matter, solid path confinement, mirror transient/fetch split, drop-final-agent refusal, required `--coord-root`, and a real four-agent canary with fast/e2e vitest split. The Bin-marked `action.ts` / `evidence.ts` / `protocol.ts` are valid UTF-8 with intentional `\0` hash delimiters, not corruption. The serious holes are Stage B wiring: owner controls vs the live loop, the entire revision/disposition loop, comparison→reviser selection, and R7 finalization/PR behavior.

## Material test gaps

- No test that a concurrent CLI `drop`/`pause` survives the next `runTick` save.
- No test that `verifyFinalization` is invoked with `finalSha !== consensusSha` and fails when non-cleanup paths remain.
- No machine test that a gate whose only step is `participation: "coordinator"` stays incomplete until an explicit coordinator effect succeeds.
- No end-to-end case where `disposition: "revise"` starts round 2, or that round 3 exhaustion blocks advancement.
- No assertion that comparison `choice` updates `selected`.
- No production-path test that `prPolicy: "coord-open-unmerged"` actually invokes an opener.
- `cmd drop` tests never assert the `complete` file is gone.
- No test that `finalChecks[].cwd` cannot escape the verification worktree.
