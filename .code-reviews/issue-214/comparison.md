# Issue 214 implementation comparison (claude)

Bound implementation pins compared:

- claude `dff89f8eb3ce9739574e6186e88fe6719ed98ae3` (my own pin; I compared it against the same scenarios as the others)
- codex `810672de6fe3d5344459cc22ca5dd4ba70062000`
- cursor `283f89b1e913c77d9f98075ad480cc8b7ccfee4a`

## Comparison

### Method

The guard refuses `git show` in this clone, so I did not export a baseline. Instead I diffed each bound worktree against the others with plain `diff -u`.

I then ran one scratch Vitest probe, unchanged, against a copy of each pin's `src/`. It replays the issue's scenarios through `applyLifecycleObservation` and `decideLifecycleNudge`, and reports `execution/decision`:

| Scenario | claude | codex | cursor |
| --- | --- | --- | --- |
| S1 prompt queued into live turn `t`, then Stop `t` | working/working | working/working | working/working |
| S1 repeated Stop `t` | working/working | working/working | **idle/eligible-idle** |
| S2 after S1, Stop of a distinct later turn `u` (queued work's own turn, not yet complete) | idle/eligible-idle | **working/working** | idle/eligible-idle |
| S2b as S2, but the action is already workflow-complete when Stop `u` arrives | **working** | **working** | idle |
| S3 Cursor 9:44: older-generation Stop | working/working | working/working | working/working |
| S3 older-generation *failed* Stop (`aborted`) | working/working | working/working | **failed/eligible-idle** |
| S3 older Stop with `pendingInputCount: 1` | working/pending-input | working/pending-input | **queued**/pending-input |
| S5 StopFailure of the queued-into turn `t` | **failed/eligible-idle, correlated** | working/working, advisory | **failed/eligible-idle, correlated** |
| S4 owner prompt `n` after idle, then Stop `n` | working | working | working |

Bold cells are the defects listed below. S4 shows that all three still classify the newest turn's Stop as older in that case (see C-shared).

### Scope, reuse, and test focus

**Scope and reuse.** All three pins change exactly the eight approved product and test files and add no new files. They share one design:

- the optional fields `queuedBehindTurnId` and `rereadExpected` on the strict action schema
- a `tool-activity` observation kind, exempt from the `hookReceipt` bump
- a shared `rereadPickupPending` helper
- the `journalDeferral` `gateWaiting` change
- a `pickedUpByReread` acknowledgement at both accept sites
- the reread status line in `issueReport.ts`

Each reuses `applyLifecycleObservation`, `positiveIdle`, `recordFailure`, `mutateAgentLifecycle`, and the existing fixtures.

Differences in scope:

- **claude** adds one more optional field, `queuedBehindStopped`.
- **codex** additionally matches the action digest in `journalDeferral` (`src/runLoop.ts:2003`). This is slightly stricter and correct.
- **codex** binds a reread-completed action's `sessionId` so that A→B→C chains keep the expectation (`markActionWorkflowComplete`).
- **cursor** adds two small private helpers, `withoutReread` and `withoutQueuedBehind`.

None of these is an unrelated refactor.

**Tests.** Every pin extends the four existing test files.

- **claude** (4 lifecycle cases, 1 runLoop `it.each`) is the smallest set. Its runLoop coverage does not exercise restart or the late Cursor ready-proof path.
- **codex** (4 lifecycle, 4 runLoop) is the most thorough and still focused. It adds:
  - restart behavior for the reporting case
  - the post-tool ready-proof race
  - repeated preceding Stops with no resource hold
  - a single acknowledgement
- **cursor** (5 lifecycle, 1 runLoop) has no failed-Stop case and no repeated-Stop case. Those are the gaps behind C3 and C4.

### Findings

**C1 — claude and codex: a queued action's own Stop is treated as an older turn once the action is complete.**

- **Location:**
  - claude: `src/agentLifecycle.ts:613`, where `queuedBehind` is gated on `workflowCompleteAt === null` and that gate also disables `queuedWorkStop` at line 619
  - codex: `src/agentLifecycle.ts:611-616`
- **Rule:** after the queued-into turn has stopped, the Stop of the next distinct turn ends the queued work. This must hold whether or not coord has already accepted that work's `complete`.
- **Failure:**
  - The normal order is: the agent writes `complete`, coord accepts it (setting `workflowCompleteAt`), and then the turn's Stop `u` arrives.
  - At that point `currentActionTurn` is still `action.turnId = t`, so Stop `u` is classified as older and execution stays `working` (S2b).
  - That Stop still advances `hookReceipt` after the agent's `ready` write, so `readyForNextAction` (`src/runLoop.ts:1339`) rejects the receipt.
  - The next action can then go out only through the `staleWorking` COORD-IDLE scrape, which logs the misleading "No Stop event … reached this issue".
  - Cursor's pin does not have this defect: it clears `action.turnId` at the first Stop.
- **Smallest test:** extend claude's "does not let the Stop of the turn a prompt was queued into end the queued action" with the S2b sequence: stop `t`, then set `workflowCompleteAt`, then stop `u`. Expect `execution: "idle"`.
- **Fix sketch (claude):** do not gate `queuedWorkStop` on `workflowCompleteAt`. Fire it whenever `action.queuedBehindStopped === true` and the stopped turn differs from `queuedBehindTurnId`.

**C2 — codex: the queued work's own distinct-turn Stop never ends it, even before completion.**

- **Location:** codex `src/agentLifecycle.ts:612`. `olderTurn` compares against `action.turnId`, which stays `t` after the queued-into Stop, and line 616 returns the entry unchanged.
- **Rule:** an accepted action must reach a state where the genuine end of its work makes it eligible for the next automatic decision, without owner recovery.
- **Failure:**
  - If Claude runs the queued prompt under a new turn id `u` and that turn ends without `complete` (a question to the owner, or a failed push), Stop `u` is ignored (S2).
  - The action stays `working`, and `decideLifecycleNudge` waits forever.
  - It is `accepted`, so neither the ready-file rescue nor the `staleWorking` rescue applies (`src/runLoop.ts:1331`, `1365-1367`).
  - Only a new submit callback or the owner's `n` recovers it.
  - claude's pin returns `idle/eligible-idle` here. All three pins would still stall if Claude instead reused `t` for that turn, which is the deliberate trade-off against C3.
- **Smallest test:** queue B into `t`, stop `t`, stop `u`. Expect `decideLifecycleNudge(...).kind === "send"`.

**C3 — cursor: a repeated Stop of the queued-into turn makes the queued action idle, which re-sends it.**

- **Location:** cursor `src/agentLifecycle.ts:733-737`. The first Stop `t` clears `queuedBehindTurnId`, `action.turnId`, `entry.turnId`, and `turns`.
- **Rule:** an old or repeated Stop must not end newer accepted work or create an idle epoch.
- **Failure:**
  - A second Stop `t`, for example a re-delivered hook, finds no turn to mismatch and takes the ordinary branch.
  - That gives `idle`; `positiveIdle` advances the epoch and `decideLifecycleNudge` returns `send` (S1 repeated).
  - Coord types the action a second time into a turn that is already running it. This is the issue's 9:53:17 duplicate.
- **Smallest test:** the S1 repeated row. After two Stops `t`, expect `decideLifecycleNudge(...).code === "working"`.

**C4 — cursor: an older-generation failed Stop fails the newer action and authorizes a send.**

- **Location:** cursor `src/agentLifecycle.ts:718`. The `failed` branch has no older-turn check.
- **Rule:** the issue's fix ("preserve newer activity when older Stops arrive") covers every Stop variant. Cursor `stop` with `status: "error"|"aborted"` normalizes to `failed`.
- **Failure:**
  - Replay 9:44 with the late `gen-old` Stop carrying `aborted`.
  - Execution becomes `failed`, which is an eligible idle, so `decideLifecycleNudge` returns `send` (S3 failed).
  - The newer turn is still running, so coord sends a duplicate prompt.
- **Smallest test:** the S3 failed row. Expect `working`.

**C5 — claude and cursor: a StopFailure of the queued-into turn is attributed to the queued action.**

- **Location:**
  - claude: `src/agentLifecycle.ts:621` (`stoppingOlderTurn` is false because `action.turnId === t`) together with the unchanged `failed` branch
  - cursor: `src/agentLifecycle.ts:718`
- **Rule:** the failure ends the *preceding* turn that the prompt was queued into. It must not be correlated to the queued action as its own episode, and must not by itself authorize resending input the vendor may still run.
- **Failure:**
  - S5 yields `failed/eligible-idle` with `lastFailure.actionId` equal to the queued action.
  - That opens a correlated resource hold for B and permits an automatic resend of a prompt Claude may still have queued.
  - codex's pin returns the entry unchanged and records the failure as advisory.
  - The opposite risk is real but smaller: if the vendor dropped the queued input, codex leaves B `working` until owner recovery.
- **Smallest test:** the S5 row. Expect no correlation and no `send`.

**C6 — cursor: pending input still turns an older Stop into `queued`, and A→B→C reread chains lose the expectation.**

- **Location:** cursor `src/agentLifecycle.ts:743` and `src/agentLifecycle.ts:314`.
- **Rule:** an older Stop never changes the live turn's execution. Successive reread pickups in one turn keep their reporting state.
- **Failure:**
  - With `pendingInputCount: 1`, a `gen-old` Stop reports "input queued" for a turn that is still working (S3 pending).
  - B, picked up by reread, completes with `sessionId: null`. Cursor's predecessor test at line 314 then fails for C, so C prints `[WAIT] waiting to send` while the agent is already executing it.
  - claude (via `previous.rereadExpected`) and codex (via the session bound at completion) both carry the expectation to C.
- **Smallest test:** order A (accepted on `s`), complete it, order B, complete B, order C during the same working turn. Expect `rereadPickupPending(entry, C)`.

**C-shared — all three: a Stop for a newer non-action turn is classified as older.**

- **Location:** claude `:612`, codex `:611`, cursor `:729`. Each derives `currentActionTurn` as `action.turnId ?? turns.at(-1) ?? entry.turnId`.
- **What happens (S4):** after an action goes idle on `t`, an owner prompt starts turn `n`, and Stop `n` is classified as older. Execution stays `working`, where the baseline said `queued`. Both block Stop readiness.
- **Assessment:** this is not a regression versus the baseline and does not distinguish the pins. The smallest fix is to prefer the newest submitted turn (`turns.at(-1)`) over `action.turnId` when classifying Stops.

### Ranking

**1. claude.**

- Avoids every duplicate-send path in the table except C5, where it inherits the baseline's eligibility on a failure.
- Covers successive rereads.
- Has the smallest change.
- Needs the one-line C1 fix. Adopting codex's advisory handling for C5 would also be reasonable.

**2. codex.**

- The most careful on failures (C5) and the strongest tests.
- Its C2 stall also covers the not-yet-complete case, which claude handles, so a stalled queued turn there needs owner recovery.
- Shares C1.

**3. cursor.**

- Two concrete duplicate-send paths (C3, C4), plus C5 and C6.
- Correct only on C1/S2b, because it drops the very guard C3 needs.

### Verification

What I ran:

- The scratch probe described above, once per pin. It uses scratch copies of each pin's `src/` and my clone's `node_modules`, and does not modify any worktree.
- `diff -u` between the bound worktrees.

No product suites were run for this comparison. Each pin's committed hook results and the coordinator's final checks are not claimed here.
