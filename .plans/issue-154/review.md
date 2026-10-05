# Issue 154 — bound-plan review

Reviewed the coordinator-exported plans against the issue snapshot and baseline code:

- Cursor: `8c76de93d699e281c92b810d5b1f502d5a2acb45`, `.plans/issue-154/plan.md`.
- Claude: `19b7ba5ca9d8e1b197497395d1c712eb235928cd`, `.plans/issue-154/plan.md`.
- Codex: `131258cea58ee0c673ed9c4c0634c74deb8bcf09`, `.plans/issue-154/plan.md`.

## Findings

### 1. [P1] Cursor — clearing guidance in each `prepareAction` loses recipients and reissues

**Plan claim:** The `src/runLoop.ts` file-map entry, run-loop test, and “Guidance applied to the wrong agent/step” mitigation copy the pending queue into an order and clear it in that action's preparation mutation.

**Rule:** Guidance for the next multi-agent step must remain available to every recipient of that step and to subsequent regeneration of the same action; it cannot be consumed by the first recipient alone.

**Concrete failure:** `applyDecisions` prepares agents sequentially, passing the first preparation's updated cursors to the second (`src/runLoop.ts:2593–2599`). With one pending instruction and three review recipients, the first receives the instruction and clears the queue; the other two receive none. A later `reissue` or `rewriteOrderedAction`, which rebuilds from cursors, also loses the first recipient's instruction. Atomic clearing prevents a write race but does not preserve the guidance snapshot. The proposed test asserting only one prepared action and an empty queue would certify this broken behavior.

Persist a shared active snapshot before recipient preparation; test multiple recipients, an enqueue between preparations, and a restart/reissue.

### 2. [P2] Claude — `(stepId, round)` does not identify a new owner-retried ballot

**Plan claim:** Lines 58–69 make binding a no-op whenever the stored step/round matches; lines 216–219 explicitly reject handling owner-answer resets as boundaries.

**Rule:** Newly queued steering must be available to the next fresh batch of agent turns authorized by an owner retry, while reissues of an existing batch must retain their original snapshot.

**Concrete failure:** At an `R6.ballot` owner question, queue guidance and choose Retry. The existing answer handler keeps the same round and step but clears the prior ballot responses and action IDs (`src/cli.ts:1568–1602`). Every newly prepared ballot still matches the old binding key, so none gets the new guidance. At the revision limit, repeated Retry choices can leave that guidance pending indefinitely, defeating steering precisely when the owner is being asked to intervene. This is different from a malformed-response reissue of the same action.

Give fresh workflow batches a durable identity that can change on an owner retry without changing on ordinary reissue; add a same-step/same-round retry regression.

### 3. [P2] Codex — promotion on every transition can discard guidance before any action uses it

**Plan claim:** “Durable guidance and its boundary” items 3–6 promote pending entries during transitions, including amendment cancellation on drop, then replace the active snapshot at every later boundary, even with an empty list.

**Rule:** An acknowledged instruction must reach the next eligible agent order or remain visibly unapplied; merely visiting a workflow cursor that produces no action must not consume its lifetime.

**Concrete failure:** During an amendment ballot originating from `R6.revise`, queue guidance and drop the other participant, retaining the authorized reviser as the sole agent. Cancellation restores the resume cursor `R6.revise` (`src/state.ts:1269–1288`), which the plan treats as a promotion boundary. The next machine decision normalizes the now-solo workflow directly to `R7.finalize`, without preparing any revision action (`src/machine.ts:202–208`; solo steps in `src/steps.ts`). The planned `advance` promotion then replaces the nonempty active snapshot with the empty pending queue. Finalization receives no guidance, and the instruction is no longer pending despite never appearing in an action.

Preserve unrendered guidance across skipped/no-action transitions, or bind pending entries at the first actual preparation for a separately identified fresh batch. Add the amendment-cancel/drop-to-solo regression; do not silently change workflow normalization.

### 4. [P2] Claude — racing `sleep` with abort does not release the sleep timer

**Plan claim:** Lines 74–76 limit runner changes to racing the poll sleep against abort; the proposed test uses a never-resolving injected sleep.

**Rule:** After foreground quit and terminal cleanup, the polling mechanism must not keep the Node process alive or retain abort listeners from previous polls.

**Concrete failure:** The default sleep creates a referenced `setTimeout` (`src/runLoop.ts:867`). Winning `Promise.race` with abort does not cancel that timer, so `runCli` can return while the shell still waits for the original poll delay (configurable up to 60 seconds). A never-resolving bare Promise owns no event-loop handle, so the proposed test misses this failure. A local Node reproduction resolved the abort race at 11 ms but did not exit until the 250 ms sleep timer fired.

Use a cancellable wait with timer/listener cleanup, and test actual timer/process liveness rather than only resolution of `run()`.

### 5. [P2] Claude — a normal return after abort is not proof that completion cleanup is authorized

**Plan claim:** Lines 28–29 retain `detachCompletedIssue` after a “normal return,” relying on its `completed` check to guarantee that `q` never detaches tmux.

**Rule:** A foreground-stop request must leave agent tmux sessions and windows intact, including when an already-running finalization effect finishes concurrently.

**Concrete failure:** Press `q` while the last tick is completing finalization. That tick can persist `completed: true` and return normally from `run(signal)`; abort is not an exception. The retained cleanup reads the now-completed state and calls `detachIssue` (`src/cli.ts:786–795`), killing the sessions the quit operation promised to preserve. The proposed ordinary-quit test with an incomplete issue does not cover this race.

Check explicit foreground-stop intent before completion cleanup, and test abort while a fake final tick transitions to completed.

### 6. [P2] Cursor and Claude — unchanged status rendering omits the requested active step/roster

**Plan claim:** Both reuse `renderIssueReport` unchanged for `s`; Claude explicitly excludes `issueReport.ts` changes (lines 114 and 155), and neither specifies supplemental step/roster rendering.

**Rule:** The issue explicitly requires the inline status snapshot to show the active step and active roster, including while paused or held.

**Concrete failure:** The existing report replaces the step with the word `paused` when any pause/hold is active (`src/issueReport.ts:51–59`). Its optional agent section iterates the original `start.agents`, not `activeRoster`, and does not identify dropped members (`src/issueReport.ts:153–167`). After dropping an agent and pausing, `s` therefore does not identify the active step or distinguish the remaining roster. Calling that renderer unchanged cannot provide the requested snapshot.

Add explicit active-step/round and active-roster output, either through the shared report and its file map or a specified inline supplement, with a paused/dropped-roster case.

### Scope, reuse, and test assessment

- **Cursor:** The two source modules have relevant responsibilities and reuse existing lock/mutation/order facilities. No dependency or unrelated product feature is proposed. The separate `test/ownerControls.test.ts` duplicates the existing CLI invariant tests the plan also retains; prefer extending the current tests unless extraction introduces uncovered behavior. `src/tmux.ts` is listed speculatively even though the needed `openOwnerAgentClients` API already exists and `reportOwnerAgentClients` is in `cli.ts`. Its named `pnpm check:fast` is real; full `pnpm check` remains the coordinator's acceptance suite and should not be confused with hook coverage.
- **Claude:** The terminal adapter and shared-control extraction are cohesive and justified; existing fixtures and tests are reused, and the new terminal test file covers a genuinely new resource lifecycle. No dependencies, agent-pane interception, or unrelated workflow changes are proposed. Both required verification suites are named. Its test set needs the specific boundary and quit cases above rather than more generic hotkey cases.
- **Codex:** One new terminal adapter is justified; it passes callbacks rather than importing the CLI, and existing test files are extended. External `coord steer` and report additions serve the same queued-guidance/control-plane feature rather than a separate framework. Its explicit transition integration is more invasive than Claude's binding site, so the skipped-transition failure must be addressed without expanding into a workflow redesign. Both verification suites and real-terminal verification limitations are stated.

## Conclusion

All three plans require corrections before implementation. Cursor's per-action queue clearing is the main correctness blocker. Claude has a coherent shared-snapshot approach but needs a fresh-batch identity, cancellation cleanup, an explicit quit-versus-finalization guard, and the requested status fields. Codex covers those latter concerns but must retain guidance through no-action transitions. Keep the fixes focused on these concrete cases and reuse the existing mutation, rendering, and test infrastructure.
