# Issue 214 plan review (claude)

Reviewed bound pins:

- codex `9ec5d2d04efc1d890625fb8b1227c84d3c13e861`
- claude `db10819fb42817204292af7add329f7ce46890df` (my own plan, reviewed with the same bar)
- cursor `b3171cc5d6e2f7166cc501f1a09cbce689989cde`

All three plans share the same diagnosis:

- An older Stop forces `queued` (`src/agentLifecycle.ts:662-672`).
- A same-turn prompt submit lets the preceding turn's Stop count as idle.
- A reread pickup is never acknowledged.
- `journalDeferral`'s `gateWaiting` (`src/runLoop.ts:2002`) ignores lifecycle acceptance.
- Cursor `postToolUse` is usage-only.

They differ in how the queued-input turn is closed out, how reread pickup is evidenced, and where the tool-activity guard runs. Those differences are where the findings below come from.

## Findings

### F1 — cursor plan: a queued-input action has no transition back to idle

- **Claim** (cursor, `applyLifecycleObservation` for `prompt-submitted` / `stopped`): A same-turn submit stores `acceptance: "queued-input"`, `action.turnId: null`, and `joinedTurnId: t1`. A Stop for `joinedTurnId` keeps `working`. The plan's only route out is "a later prompt submit for B with turn `t2` binds `acceptance: "execution"`".
- **Rule:** after the preceding turn's Stop has been consumed, the next Stop that ends the queued work must be able to produce `idle`. Otherwise `decideLifecycleNudge` can never authorize another automatic send for that action.
- **Failure:** The issue's own Claude evidence is that the queued prompt gets no second `UserPromptSubmit`; the callback was already spent when the input was queued. So no `t2` submit ever arrives, and the follow-on Stop goes one of two ways:
  - It carries `t1` again. It matches `joinedTurnId`, and the plan says that keeps `working`, so the action stays `working` forever.
  - It carries a new id. None of the plan's four Stop rules matches a `queued-input` action with a non-`joinedTurnId` Stop. The existing fallback then computes `currentActionTurn = stopObservation.turns.at(-1)`, which is `t1`, and treats the Stop as older. Under the plan's preserve rule, that also keeps `working`.

  If B's turn ends without publishing (the agent stops to ask the owner something, or the publish fails), coord waits on `working` indefinitely. The ready-file rescue cannot help either: `readyForNextAction` requires `delivery: "ordered"` (`src/runLoop.ts:1331`) and B is already `accepted`. Plan test 2 only passes because it invents the `t2` submit.
- **Smallest correction:** When the `joinedTurnId` Stop is consumed, also clear `joinedTurnId` and `entry.turnId`, and reset `stopObservation.turns`. Then the next Stop of any id ends the queued work as `idle`. The claude plan does this with `queuedBehindTurnId`. Add a test where the follow-on Stop has no preceding submit.

### F2 — cursor plan: the tool-repair guard runs outside the lifecycle lock and emits an unconditional `working`

- **Claim** (cursor, `src/agentEvent.ts`): After `normalizeCursorUsageEvent`, the plan checks entry `sessionId`/`turnId`/`stoppedAt`/`execution` and then calls `observeAgentLifecycleWithResult` with `kind: "working"`.
- **Rule:** A precondition that guards a lifecycle mutation must be evaluated inside `mutateAgentLifecycle`'s exclusive lock, in `applyLifecycleObservation`, against the state being replaced. Activity that is not current must never clear `stoppedAt`.
- **Failure:**
  - Every Cursor hook is a separate `coord agent-event` process. The final tool's `postToolUse` and the turn's `stop` fire within milliseconds of each other.
  - The `postToolUse` process reads `execution: "queued"` and `stoppedAt: null`, passes the guard, and then loses the race to the `stop` process, which records `idle` and `stoppedAt`.
  - The `postToolUse` process then applies `kind: "working"`, whose existing branch (`src/agentLifecycle.ts:650`) unconditionally sets `working` and `stoppedAt = null`.
  - The real idle is erased and no idle epoch remains for the nudge. The agent looks busy until some other event arrives.
- **Smallest correction:** Make tool activity its own observation kind whose guard (current session, newest submitted turn, `stoppedAt === null`, execution `queued`/`unknown`) is evaluated inside `applyLifecycleObservation`, returning the same entry otherwise. This is the claude plan's `tool-activity`.

### F3 — codex and cursor plans: tool callbacks advance `hookReceipt` and invalidate the ready-file rescue

- **Claim:**
  - codex: "Repeated valid activity can update the hook receipt."
  - cursor: routes tool repair through `observeAgentLifecycleWithResult` with a non-telemetry kind, which bumps `hookReceipt` on every callback (`src/agentLifecycle.ts:752-755`).
- **Rule:** `readyForNextAction` accepts a ready file only when `writtenAt > lastHook` (`src/runLoop.ts:1339`). A callback describing the very tool call that wrote the file must not count as a later hook.
- **Failure:**
  - That ready-file path is the recovery when a Stop never reaches the issue.
  - A Cursor agent writes `ready` with a shell tool call. Cursor's `postToolUse` for that call fires after the write completes, so `hookReceipt.at > mtime`.
  - The receipt is then rejected permanently, and the next action can only go out through the COORD-IDLE scrape. Under the codex plan that rescue is the only one left; under cursor's reread acceptance there is none (see F5).
- **Smallest correction:** Exempt tool activity from the `hookReceipt` bump, as `telemetry` already is. Assert this with a no-op tool event, which is claude plan test 3.

### F4 — codex plan: the reused-ID handoff is left unresolved, and the follow-on Stop is unspecified

- **Claim** (codex §1): After the same-turn submit and A's Stop, B stays "accepted and awaiting execution". "With reused or absent IDs … retain the conservative handoff state until distinct current execution evidence, completion/ready evidence, or explicit owner recovery resolves it."
- **Rule:** Every accepted action must reach a state where a genuine end of its work makes it eligible for the next automatic decision, without owner recovery.
- **Failure:**
  - Claude reuses the id, which is the exact case the issue documents.
  - B's own turn ends with a Stop carrying that same id. Under the plan the Stop is "ambiguous", so B is never idle.
  - If B's turn ends without `complete` (a question to the owner, or a failed push), there is no completion. There is no `ready` either: the protocol writes `ready` only after `complete`.
  - That leaves only explicit owner recovery: a routine stalled turn becomes a hold-equivalent.
  - The `started` receipt does not help. The plan says it "does not prove that a new vendor turn began", so it cannot disambiguate the next Stop either.
- **Smallest correction:** Treat the first Stop of the joined turn as consumed and clear the joined turn id. Then the next Stop, whatever its id, ends the queued work (as in F1).

### F5 — cursor plan: marking a reread action `accepted` at order time removes both missing-Stop rescues

- **Claim** (cursor, `orderAgentAction` `continueInFlightTurn`): The replacement is stored `delivery: "accepted"`, `acceptance: "reread"`. It is reopened only "by a Stop for `joinedTurnId`".
- **Rule:** An inference that has not been confirmed by any agent signal must not disable the recoveries that exist for missing Stop hooks. Those recoveries are:
  - the ready-file override (`readyForNextAction`, which requires `delivery: "ordered"`, `src/runLoop.ts:1331`)
  - the `staleWorking` COORD-IDLE override (`src/runLoop.ts:1365-1367`, which requires `delivery: "ordered"` and `injectedAt === null`)
- **Failure:**
  - The agent rereads before coord writes B. That is the race the plan's own risk section concedes, because `readReady` at prepare time can precede the agent's `ready` write.
  - The agent writes `ready A`, prints COORD-IDLE, and ends its turn, but its Stop hook does not reach this issue. That is the failure `staleWorking` exists for: wrong `COORD_ISSUE`, or a hook timeout.
  - B is now `accepted`, so `readyForNextAction` and `staleWorking` both return null. Nothing reopens `ordered`, and B is never sent.
  - Before this change, either rescue would have delivered B.
- **Smallest correction:** Keep the inferred action `ordered` and use the inference only for reporting. Acknowledge the pickup when a never-sent action completes (claude plan), or rely on an explicit agent receipt (codex plan).

### F6 — claude and cursor plans: a failed Stop from an older turn still fails the newer action

- **Claim** (claude fix 1, cursor `stopped` rules): Only `kind: "stopped"` gets stale-turn protection. The `failed` branch (`src/agentLifecycle.ts:652-659`) is unchanged.
- **Rule:** The issue's fix statement ("preserve newer activity when older Stops arrive") applies to every Stop variant. Cursor's `stop` with `status: "error" | "aborted"` and Claude's `StopFailure` normalize to `failed` (`src/agentEvent.ts:134-145`, `185-192`).
- **Failure:**
  - Replay the Cursor 9:44 sequence, but have the late old-generation Stop carry `status: "aborted"`.
  - For an accepted action, the branch sets `execution = "failed"`.
  - `positiveIdle` then advances `idleEpoch`, and `decideLifecycleNudge` treats `failed` as eligible, returning `send`.
  - The newer turn is still working, and coord types a duplicate prompt into it. That is worse than the `queued` mislabel the issue reports.
  - The codex plan covers this ("Apply the same stale-turn protection to failed Stops").
- **Smallest correction:** Compute `stoppingOlderTurn` for `failed` as well. When it is true, preserve `execution`, `stoppedAt`, and `turnId`. The failure stays recorded as advisory, which `recordFailure` already does because the turn does not correlate. Add one row to the older-Stop test.

### F7 — codex plan: scope and test volume exceed the issue

- **Claim** (codex file map): A new agent-written `started <actionId> <digest>` receipt that every action must produce. Implementing it touches:
  - `src/action.ts` renderers and parser
  - `src/paths.ts`
  - `templates/product/AGENTS.protocol.md`
  - `docs/readiness-policy.md`
  - six test files, with table-driven race matrices
- **Rule:** The plan must make the smallest change that fully solves the issue, propose only the fewest focused tests, and avoid speculative flexibility (AGENTS.md "Implementation discipline").
- **Failure:**
  - The receipt changes the protocol contract for every agent in every coord-managed product, and requires agents to hash `action.md` themselves.
  - It still cannot help when coord rewrites the action in flight. `rewriteOrderedAction` changes the digest, and the plan says "digest changes require a new acknowledgment" that the agent, already executing, will never write.
  - So the issue's `[WAIT] waiting to send` symptom returns for exactly those actions.
  - Meanwhile the issue's acknowledgment need is met without a protocol change: pickup is proven after the fact when a never-sent action completes, and reporting only needs to stop calling live, inferred-pickup work "waiting to send".
- **Smallest correction:** Drop the `started` receipt and its five supporting files from this issue. If explicit start receipts are wanted, file them as a follow-up protocol issue.

### F8 — claude plan (self-review): one risk bullet misstates the recovery path

- **Claim** (claude, Risks, first bullet): "the agent's `ready` file and the existing `staleWorking` rescue only apply to never-sent actions. The next action, however, is never-sent."
- **Rule:** A risk mitigation must name a recovery that actually applies to the action at risk.
- **Failure:**
  - If a queued-behind detection misfired, the stuck action B is already `accepted`, so neither rescue applies to B.
  - The bullet reads as if B were recoverable.
  - In fact only the *next* action C regains delivery, after B completes. A B that never completes needs an owner reminder.
- **Smallest correction:** Reword the bullet to say that B relies on the detection's three-part guard and on the owner `n` reminder. Only C is covered by the ready/sentinel rescues.

### Scope, reuse, and test focus

- **claude:**
  - Four product files and four existing test files; no new files.
  - Reuses `stoppingOlderTurn`, `positiveIdle`, the `telemetry` hookReceipt exemption, `journalDeferral`'s `remind` predicate, and the `clearedDegraded` result pattern.
  - Tests are four lifecycle cases plus one case each for event, runLoop, and report.
  - Needs F6 added.
- **cursor:**
  - Stays in scope and is mostly reusable.
  - The `docs/readiness-policy.md` update is proportionate.
  - Its correctness gaps are F1, F2, F5, and F6.
- **codex:**
  - Correct on the failed-Stop protection (F6) and on receipt safety in principle.
  - Broadest scope (F7). The ambiguity it deliberately preserves becomes a stall (F4). Its tool-activity receipt behavior breaks the ready rescue (F3).

## Conclusion

Recommend the **claude plan** (`db10819fb42817204292af7add329f7ce46890df`) as the base, amended with:

- **F6:** stale-turn protection for `failed` Stops, adopted from the codex plan.
- **F8:** the corrected risk wording.

Both are small and confined to files already in its map (`src/agentLifecycle.ts`, `test/agentLifecycle.test.ts`).

The cursor plan needs F1, F2, F5, and F6 resolved before it is safe. F1 and F5 can each leave an action permanently unsent or unidle under conditions the issue itself documents.

The codex plan needs F3 and F4 resolved, and its protocol-receipt scope (F7) removed or split into a follow-up.

No product tests were run for this review. Validation was limited to reading the three bound plan files and checking their cited code paths (`src/agentLifecycle.ts`, `src/agentEvent.ts`, `src/runLoop.ts`) at the baseline.
