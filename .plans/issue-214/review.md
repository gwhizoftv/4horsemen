# Issue 214 plan review

Protocol version: 1. Reviewed the exported `.plans/issue-214/plan.md` at each exact bound pin:

| Agent | Plan commit |
| --- | --- |
| Codex | `9ec5d2d04efc1d890625fb8b1227c84d3c13e861` |
| Claude | `db10819fb42817204292af7add329f7ce46890df` |
| Cursor | `b3171cc5d6e2f7166cc501f1a09cbce689989cde` |

All three exported files match their manifest SHA-256 values. The source references below describe the existing implementation used to trace the proposed behavior; the plans are not implemented candidates.

## Findings

### 1. [P1] Claude: clearing the queued-turn identity lets a duplicate old Stop authorize another send

**Plan claim:** Under `Exact File List to be changed or deleted`, fix 2 (`plan.md:63-70`), the Stop for `queuedBehindTurnId` clears that marker, clears `action.turnId` and the entry turn, and resets the observed turns, explicitly so that “the next Stop of any id ends the queued work.” Test 2 requires that any following Stop produce idle.

**Rule:** An old or duplicate Stop must not end newer accepted work or create a fresh idle epoch. Consuming the first old Stop is not evidence that the next callback belongs to the new execution.

**Concrete failure:** A runs on turn T; B is accepted with the same T and gets `queuedBehindTurnId: T`. The first Stop(T) follows the proposed branch and leaves B working with all turn-disambiguation fields cleared. A duplicate Stop(T) now has no current turn to mismatch, so the ordinary Stop branch (`src/agentLifecycle.ts:662`) produces idle and `positiveIdle` advances the epoch. `decideLifecycleNudge` can then send B again. This recreates the issue's duplicate prompt, and Stop-backed transport deliberately permits sending despite stale busy pane chrome (`src/tmux.ts:1245-1252`).

**Smallest correction/test:** Retain enough consumed/ambiguous turn identity to reject repeated old Stops until positive evidence identifies B's execution. Replace the “any following Stop” test with Stop(T), duplicate Stop(T), distinct current-turn evidence, and that current turn's Stop; only the last event may grant idle credit.

### 2. [P1] Cursor: speculative reread acceptance disables recovery if the preceding Stop is missing

**Plan claim:** The `orderAgentAction` and prepare-path changes (`plan.md:17,21`) immediately store a replacement as `delivery: "accepted"`, `acceptance: "reread"` when the predecessor is complete, lifecycle still says working, and no matching ready file exists yet. The same-ID early return preserves that acceptance. The stated recovery (`Risks and Mitigations`, `plan.md:72`) requires a Stop for the joined turn.

**Rule:** Completion of the predecessor plus absence of a ready receipt is not proof that the replacement was read. A never-delivered replacement must retain the existing positive-readiness recovery when a Stop callback is missing, including a ready receipt arriving after publication.

**Concrete failure:** A completes and rereads its unchanged action. Before it writes ready, coord publishes B and infers reread acceptance. A then writes a valid ready receipt and ends its turn, but its Stop callback never arrives. A never read B. Subsequent polls keep B accepted/working: the proposed accepted-work early return suppresses delivery, `readyForNextAction` rejects accepted actions (`src/runLoop.ts:1331`), and `staleWorking` also requires `delivery === "ordered"` (`src/runLoop.ts:1365-1367`). Even the later valid ready file and idle pane cannot recover B. It remains unstarted indefinitely until owner intervention while reporting that it was accepted.

**Smallest correction/test:** Keep a reread expectation distinct from proven acceptance, or obtain a positive acknowledgment before closing first-send recovery. Extend the run-loop case with a ready file written after B's preparation and no Stop; the next poll must safely deliver the still-unread B once. Also preserve the existing missing-Stop sentinel recovery when no receipt is available.

### 3. [P2] Claude: the reread expectation is lost after the first action picked up within the same turn

**Plan claim:** Fix 3 requires the previous action's `sessionId` to equal the current non-null session before setting `rereadExpected` (`plan.md:84-93`). A replacement remains ordered and unaccepted; completion adds only the `pickedUpByReread` result flag and journal/log acknowledgment (`plan.md:98-102,132-138`).

**Rule:** The protocol permits one execution turn to handle multiple successive actions by rereading. Handoff tracking and reporting must continue to work after an action that itself had no submit callback.

**Concrete failure:** A is accepted on session S and completes. B is ordered with `rereadExpected`, then is picked up and completed without injection or a prompt callback. The existing order constructor sets B's action `sessionId` to null (`src/agentLifecycle.ts:308-319`), and the planned completion change does not bind it. When C is ordered during the same live turn, B's null session fails the proposed predecessor-session condition. C therefore lacks `rereadExpected`; `rereadPickupPending` is false, and the plan's reporting change again emits `waiting to send` while the agent can already be executing C. The post-hoc B completion log does not repair that state.

**Smallest correction/test:** Define how validated reread pickup preserves its execution/session relationship for the next handoff without fabricating delivery acceptance. Add an A → B → C sequence with only A receiving a submit callback, and assert both B and C are tracked and reported correctly.

### 4. [P2] Codex: the new post-tool activity path can invalidate the ready receipt that the tool just wrote

**Plan claim:** `Reuse and Scope`, section 2 (`plan.md:61-65`), maps Cursor `postToolUse`/`postToolUseFailure` to working observations and allows repeated valid activity to update the hook receipt. The file map and risks also require preserving the existing completion/ready behavior, but no proposed test covers the ready-writing command's own post-tool callback.

**Rule:** The ready handshake must continue to provide positive recovery when a Stop is absent. A completion callback for the command that published ready is not, by itself, proof that new foreground work started after that receipt. Genuine later work must still revoke readiness.

**Concrete failure:** Cursor finishes A, writes `ready A` using a shell tool, and then the current-turn `postToolUse` for that command arrives. Under the planned ordinary working-observation path, `observeAgentLifecycleWithResult` advances `hookReceipt.at` even when the execution value is unchanged (`src/agentLifecycle.ts:748-755`). `readyForNextAction` requires the receipt's mtime to be strictly later than that hook receipt (`src/runLoop.ts:1335-1339`), so the callback invalidates the very receipt it completed. If Stop is missing and the terminal lacks a qualifying sentinel, B cannot use the file-backed recovery the plan promises to preserve. The new `started` receipt does not help: B has not yet been delivered or discovered.

**Smallest correction/test:** Specify how post-tool completion is distinguished from activity that begins after readiness, rather than routing all such callbacks through the ordinary readiness-invalidating path. Add the sequence ready write → that tool's post callback → no Stop → B published, with a prompt-ready pane lacking the sentinel. It must still allow one safe first send, while a genuinely subsequent tool/action start invalidates the receipt. This is a needed correction to the Codex plan itself.

### Scope, reuse, and validation assessment

All three plans stay within issue 214's lifecycle/handoff/reporting problem and reuse existing reducers, event normalization, run-loop delivery logic, and test fixtures. None adds a dependency or a new tracked product module. Claude and Cursor have smaller file maps, but their narrower acknowledgment approaches do not remove the concrete failures above.

Codex's additional action-rendering, mailbox-path, protocol, and documentation changes are tied to an explicit start receipt. The new runtime file is justified by the absence of a prompt event during reread pickup and fits the existing writable mailbox. Its wider test list covers distinct identity, replay, race, and compatibility behavior rather than unrelated cleanup. It still needs the ready/post-tool regression in finding 4.

The proposed tests are otherwise focused and extend existing files. The missing cases above concern externally observable false idle, stalled delivery, or incorrect reporting, rather than implementation shape. Claude's test explicitly expecting any second Stop to end queued work must change. Cursor's reread test currently asserts inferred acceptance without exercising late readiness or a missing Stop.

I checked source and existing tests to trace these findings, and ran only this focused baseline command to investigate the readiness/recovery contracts:

```sh
pnpm exec vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/runLoop.test.ts -t 'records duplicate working receipts|keeps ready through actual acceptance|automatically overrides stale working only before the first send'
```

Result: 3 tests passed, 264 skipped, across 2 test files. This confirms the existing duplicate-activity receipt and positive-readiness recovery contracts; it does not claim that any proposed implementation was tested. No full product or coordinator-owned suite was run for this review.

## Conclusion

Request revision of all three plans before implementing them unchanged. Claude must preserve old-Stop identity and support successive reread handoffs; Cursor must not convert a possible reread into acceptance that blocks missing-Stop recovery; Codex must reconcile post-tool observations with the ready-writing command's own callback. The plans' issue scope and reuse choices are appropriate, but these handoff failures must be resolved and covered by the focused cases above.
