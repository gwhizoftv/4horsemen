# Code review: Claude implementation for issue 1

- Reviewed head: `6b3ad7917b26af06157ad3eb1de4d0e146da1c5e`
- Baseline: `origin/main` at `14d052a3bd52997b79dd5806f47e4ef384cf9d2b`
- Validation: `nvm use 26 && pnpm check` passed in a detached worktree.

## Verdict

**Changes required.** This is the strongest peer implementation: it has the clearest I/O/pure-machine separation and the broadest unit-test suite. After also comparing it with the Codex implementation, however, I recommend Codex—not Claude—as the overall revision base. Claude is not ready to drive a real consensus run because several core state transitions are still disconnected.

## Findings

### [P1] Consensus dispositions never affect the workflow or revision round

`src/runLoop.ts:280` always passes `revisionRequested: false` to the machine. In addition, `src/evidence.ts:348-367` accepts any schema-valid consensus ballot after checking only its envelope, round, and pin; it never interprets `disposition`, even though `src/protocol.ts:35` permits `approve`, `revise`, and `escalate`. Consequently `src/machine.ts:183-198` advances to finalization after the first complete ballot set even when every voter requested revision or escalation. The three-round cap is unreachable in the production loop, no later round is created, and no consensus result is actually declared.

Before using this as the revision base, persist and tally ballot dispositions, advance/reissue R6 with rounds 1 through 3 when revision is requested, stop for owner action after an unsuccessful round 3, and bind the declared consensus SHA to the approving ballots. Add a run-loop/integration case with a round-1 `revise` result followed by a round-2 approval, plus the no-round-4 case.

### [P1] Implementation comparison ballots cannot select the implementation or reviser

The gate transition in `src/runLoop.ts:426-445` retains the existing `selected` agent whenever it is still active. `selectFromBallots` at `src/runLoop.ts:535-578` reads only `R3.plan-ballot`; nothing tallies `R5.compare-ballot`. Thus the plan winner remains selected after multiple consensus-profile implementations are compared, regardless of the comparison ballot result. R6 can revise and finalize the wrong implementation.

Keep plan selection and implementation/reviser selection as distinct persisted decisions, tally the R5 ballots against exact implementation pins, and use that result for R6 inputs and finalization. Test a case where the plan winner and implementation winner differ.

### [P1] R7 verifies an empty range instead of a cleanup-only final commit

`src/runLoop.ts:601-614` sets `finalSha = consensusSha` unconditionally. The finalization verifier therefore inspects an empty range and the clean worktree is not materialized at an independently proposed final head. There is no path that obtains or validates the cleanup commit that deletes this issue's coordination files, despite the presence of a finalization-record schema.

Model the final head explicitly, fetch it from origin, require it to descend from the consensus-approved pin, run `verifyFinalization` over the real consensus-to-final range, and run checks at that exact final SHA. The integration canary should create a cleanup-only commit and prove a product-file change after consensus is rejected.

### [P1] The production CLI cannot honor `coord-open-unmerged`

`finalize` only opens a PR when an injected `openPullRequest` exists (`src/runLoop.ts:674-678`), but production `defaultDeps` at `src/runLoop.ts:721-727` never supplies that capability. The tests inject a fake, so `prPolicy: "coord-open-unmerged"` silently becomes “do not open a PR” in the shipped CLI. A failed injected opener is also reduced to `prOpened: false` while the outcome remains successful.

Wire an explicit-argv, no-shell PR opener into production dependencies, target the verified final SHA/branch, surface opener failure as a failed or owner-action outcome, and retain the no-merge boundary.

### [P1] `start` reports success without launching agents when tmux is unavailable

`src/cli.ts:263-315` writes the runtime state and journal before mirror/session/launcher startup. If `createTmuxController().available` is false, launcher validation and every launch are skipped and the command still reports success. Mirror or launcher failure also leaves a durable run that was already journaled as started.

Validate tmux and every executable `start-<agent>.sh` before committing the started state, treat unavailable tmux as a named startup failure, and make startup failure atomic or explicitly recoverable. Add a CLI test for unavailable tmux and for partial launcher failure.

### [P2] `action.md` has an extra front-matter field

`src/action.ts:110-121` permits and emits `completePath` in front matter. The accepted action protocol limits front matter to `actionId`, `agent`, and `requiredPath`; the completion path belongs only in the human body, where this implementation already renders it. Remove the key and tighten the parser/tests to the exact three-field contract.

### [P2] `restart-action` can reinterpret a stale completion as the restarted action

`src/cli.ts:451-468` resets the cursor but neither clears the agent's `complete` file nor removes/replaces the old action atomically. On the following ticks the loop can prepare the replacement action and then evaluate the pre-restart SHA against it. Clear pending intent as part of restart and test restart with a valid SHA already present.

### [P2] Three TypeScript sources contain literal NUL bytes

`src/action.ts`, `src/evidence.ts`, and `src/protocol.ts` contain 4, 3, and 2 literal NUL bytes respectively. The separators work at runtime, but Git classifies these text sources as binary, hiding line diffs from normal review tooling. Replace the literal bytes in source with escaped `\0` string syntax and verify Git treats the files as text.

## Required changes before adopting the Claude base

At minimum, resolve all P1 findings before beginning feature-level revision work. I would also fix the exact action-front-matter contract immediately because it is a public protocol. The stale-restart and NUL-source issues can be handled in the same hardening series. After those changes, rerun the full four-agent canary with (1) a dropped agent, (2) an implementation winner different from the plan winner, (3) at least one requested revision, and (4) cleanup-only finalization plus unmerged PR creation.

## Overall base recommendation

Use the Codex implementation at `04445b43078a419ad1d7c1b6025d3394048fbea0` as the revision base. Its full Node 26 `pnpm check` passes, and its origin-backed canary already reaches cleanup-only finalization. More importantly, it already handles ballot dispositions and rounds without round 4, uses the exact three-field opaque action protocol, resolves a real origin baseline, verifies a distinct final cleanup SHA, runs configured checks in a clean worktree, and wires authorized draft-PR creation in production. Those are central missing paths in Claude rather than test-only gaps.

Before revising from Codex, I would require this focused hardening series:

1. Mechanically tally plan and comparison ballots and persist the selected implementation/reviser. The current Codex path accepts a claimed selection/authorization but does not prove it from ballot choices, never updates `cursors.reviser`, and binds round-1 revision to every implementation rather than the comparison winner.
2. Apply the approved file-map and copied `validatePhasePin` policy to revision pins as well as implementation pins, including rejection of post-pin product changes.
3. Make automatic selection, reviser authorization, and consensus declaration coordinator-owned effects, or at minimum mechanically validate the corresponding published artifacts so a designated agent cannot choose arbitrary results.
4. Make `start` failure atomic around mirror/tmux/launcher initialization and add negative coverage for partial startup.
5. Bring over Claude's useful boundary-test depth—especially malformed schemas, real tmux behavior, restart cases, and failure-path finalization—while retaining Codex's end-to-end canary.
