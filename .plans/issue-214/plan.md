# Issue 214: preserve execution evidence across action handoffs

Protocol version: 1. Issue session: `issue-214:0ead5e6ce15b6563bb6134a84997e79b0c0042cd`.
Baseline: `0ead5e6ce15b6563bb6134a84997e79b0c0042cd`.
Automation digest: `55bec267ac95e3bb85a76f2460b409f6f8b3cf8ad60ea4ed5afd16893cbc5d26`.

The issue describes four related failures: an older Cursor Stop overwrites newer activity, a Claude prompt callback reuses the preceding turn ID and permits a false idle transition, agents execute replacement actions without a delivery acknowledgment, and normal accepted work is reported as waiting for delivery. The implementation will keep action acceptance, execution evidence, and workflow completion distinct.

## Exact File List to be changed or deleted

| Existing path | Change |
| --- | --- |
| `src/agentLifecycle.ts` | Preserve current execution against stale turn observations; distinguish prompt acceptance from execution starting; persist pending-handoff and action-start evidence with backward-compatible defaults; apply correlated tool/start observations without granting idle credit. |
| `src/agentEvent.ts` | Normalize Cursor tool callbacks as execution observations as well as usage events, retaining the existing identity validation and independent usage accounting. |
| `src/action.ts` | Render start-acknowledgment instructions in both Git and response actions; add the bounded `started` receipt parser/reader beside the existing readiness reader. |
| `src/paths.ts` | Add the `started` sibling path to the existing per-agent completion mailbox. |
| `src/runLoop.ts` | Ingest matching start receipts before automatic delivery decisions and recheck before sending; preserve accepted start evidence through injection races; report accepted work without delivery warnings. |
| `templates/product/AGENTS.protocol.md` | Require acknowledgment when beginning an action, including a replacement found by the completion reread. Preserve the existing completion and ready handshake. |
| `docs/readiness-policy.md` | Document prompt acceptance, execution evidence, ambiguous Stops, start receipts, and reporting behavior. |
| `test/agentLifecycle.test.ts` | Extend existing lifecycle policy cases for stale Stops, queued handoffs with reused IDs, current activity recovery, receipt idempotence, and legacy state loading. |
| `test/agentEvent.test.ts` | Extend Cursor normalization/routing coverage to verify both execution recovery and unchanged usage records. |
| `test/action.test.ts` | Extend both-mode action rendering and bounded mailbox-read coverage for start acknowledgments. |
| `test/paths.test.ts` | Extend mailbox path/isolation assertions for `started`. |
| `test/runLoop.test.ts` | Extend delivery fixtures for reread pickup, acknowledgment/send races, restart behavior, false-idle prevention, and accepted-work reporting. |
| `test/agentLanguage.test.ts` | Extend the existing installed-protocol handshake assertion to cover acknowledgment on replacement actions. |

No files will be deleted. The clone-local `AGENTS.md`, product `githooks/`, package version, dependency files, and runtime permission configuration are outside the implementation map.

## Exact file list to be created

No new tracked product or test files are required. This action creates only `.plans/issue-214/plan.md` as its coordination artifact.

The implementation introduces one runtime receipt, `<completeDir>/started`, in each agent's already writable completion mailbox. Its exact location is derived by `agentRuntimePaths`, alongside `complete` and `ready`; it is not a repository file or a new permission grant. It is necessary because neither a vendor prompt callback nor a tmux send occurs when the agent discovers a replacement by rereading the order.

## Reuse and Scope

Reuse `LifecycleAction`, `AgentLifecycleEntry`, `LifecycleObservation`, `applyLifecycleObservation`, `observeAgentLifecycleWithResult`, `mutateAgentLifecycle`, `orderAgentAction`, `markActionInjected`, `markActionWorkflowComplete`, `positiveIdle`, and `decideLifecycleNudge`. Extend this state machine rather than introducing a second scheduler. Reuse the existing lifecycle lock and atomic persistence. Keep lifecycle format version 1 with explicit defaults for additive fields so older runtime files remain readable.

Reuse `normalizeAgentEvent`, `normalizeCursorUsageEvent`, and `handleAgentEvent` for hook processing. Cursor's `postToolUse` and `postToolUseFailure` handlers are already installed by `src/agentHookSync.ts`; no new vendor hook or hook installation change is necessary. `afterAgentResponse` token statistics and Claude status-line quota telemetry remain telemetry.

Reuse `renderGitAction`/`renderResponseAction`, the `readReady` bounded regular-file/no-symlink/stat-identity pattern, `containedPath`, `assertNoSymlink`, `agentRuntimePaths`, and `sha256OfFile`. Any small common receipt-reader helper stays private to `src/action.ts`, serves both mailbox readers, and preserves existing `ready` behavior. No general receipt framework, dependency, CLI subcommand, or new source module is needed.

Reuse `CoordinatorRunLoop`'s existing per-action safety state, `reconcileSubmitted`, `maybeLifecycleNudge`, `deliver`, pre-send authority/reservation callbacks, and `journalDeferral`. Keep workflow cursors and submission validation authoritative for completion. Reuse `renderIssueReport` unchanged: it already distinguishes accepted delivery and working execution once supplied the correct lifecycle state.

Reuse the `entry()` lifecycle fixture, `runtimeFixture()` event fixture, `order()` action fixture, `workspace()` mailbox fixture, and `fixture()`/`TmuxController`/injected clock facilities in `test/runLoop.test.ts`. Tests use synthetic event sequences and temporary workspaces, not the owner's live consensus runtime or copied terminal transcripts.

### 1. Separate accepted input from an executing action

A matching prompt callback acknowledges the exact action UUID/digest and session. It must not by itself prove that a new execution turn has started. Record the pending accepted input separately from the currently proven execution identity. Preserve evidence of an already working turn; where the new action has no execution evidence, describe its input as queued without inventing a vendor queue count.

Persist enough handoff metadata to distinguish the accepted prompt identity, the preceding execution identity, and whether the accepted action has actually started. A same-ID or missing-ID prompt received during an active turn is explicitly ambiguous. Duplicate callbacks for the same accepted action must not create another pending handoff or erase start evidence. A new action can start within an existing turn; action identity is not a replacement for vendor turn identity.

A Stop known to belong to an older turn must preserve the newer execution state, current turn, pending-input/background fields, action acceptance, `stoppedAt`, and `idleEpoch`. Do not assign the incoming older turn ID before deciding whether it is current. Apply the same stale-turn protection to failed Stops so an old failure cannot fail the newer action or create a correlated resource hold.

For the Claude sequence, acceptance of action B with action A's turn ID followed by A's Stop must leave B accepted and awaiting execution, or preserve B's working state if an explicit start acknowledgment already proves it started. It must never produce idle/readiness for B. Ambiguous callbacks cannot manufacture a fresh idle epoch. With reused or absent IDs, do not resolve ambiguity merely by callback arrival order; retain the conservative handoff state until distinct current execution evidence, completion/ready evidence, or explicit owner recovery resolves it. Continue accepting an unambiguous current Stop under the existing background-work policy. Keep the existing Antigravity status/queue semantics.

Reset pending execution correlation on genuine session replacement, reject retired-session events, and preserve receipt replay protection across replacement. Advisory Stop-warning bookkeeping may record observations but must not become execution authority.

Validated workflow completion retires only the completed action's pending-handoff metadata. It must not leave a synthetic queued flag that prevents the existing next-action `ready` receipt from working, and must not clear a real vendor-reported pending-input count or claim that the agent's turn ended. Ordering the next action preserves any genuinely current execution evidence.

### 2. Use current activity to repair stale execution

Normalize Cursor `postToolUse` and `postToolUseFailure` to `working` observations carrying the conversation and generation IDs already used by usage normalization. A failed individual tool invocation still proves an executing agent; it is not an agent-turn failure.

Repair a queued/stale execution state only when the session and turn correlate with the currently executing or pending accepted turn. An older known turn must not overwrite the execution identity, a foreign/retired session must not be adopted, and a usage-only callback with insufficient correlation must not accept an arbitrary outstanding action. Preserve the existing analytics event and tool-count semantics exactly once per callback. Repeated valid activity can update the hook receipt while semantic lifecycle journaling remains deduplicated.

### 3. Acknowledge actions discovered through rereading

Both action renderers and the installed protocol will tell the agent to write `started <actionId> <actionDigest>` as the sole line of `<completeDir>/started` after reading the action and before executing its task. The digest is the SHA-256 of the exact action bytes the agent read. Instructions must explain computing that digest when the action was found through rereading; do not embed an action's own digest inside its body. The same rule applies to initially delivered actions and to Git and response modes, with no Git commit for the receipt.

Read this as a bounded, strict, regular-file receipt with no followed symlinks and stable before/after file identity. Match its UUID/digest against the active agent cursor, the current action bytes, and the lifecycle action. Missing, malformed, partial, oversized, stale, superseded, completed, or wrong-digest receipts have no effect. A receipt predating the applicable order or replacement session must not revive work. Do not trust an agent-supplied timestamp.

Persist the observed receipt identity and start evidence so polling/restart cannot repeatedly reapply it, manufacture activity, or resurrect a stopped/failed action. Use the original receipt observation for acceptance timing rather than refreshing it on every poll. A later replacement receipt can be considered independently; leave files in place so a cleanup race cannot remove a new acknowledgment.

An accepted start receipt proves that this action was picked up and is working, including when no prompt was injected. It does not prove that a new vendor turn began, that the agent is idle, or that the workflow artifact passed validation. It must not increment `idleEpoch`, fabricate a turn ID, spend a send, release unrelated holds, or advance a workflow cursor.

Ingest receipts before resource/delivery decisions, including pull-only agents and observation-only handling while paused. Recheck at the automatic pre-send authority/reservation boundary, because a receipt can arrive after the initial tick read. Before any key is sent, newly observed acceptance cancels the automatic send without a charge; after transport starts retain the existing uncertain-send accounting and reconcile only the exact correlated attempt. Preserve receipt-backed acceptance if `markActionInjected` returns after the receipt was observed. Receipt timing and action identity must prevent an older receipt from releasing a newer send's reservation.

Do not bypass process/pane gates, copy-mode protection, pause/hold authority, send budgets, or the existing explicit-owner-reminder contract. A completion remains sufficient to validate work even if no start acknowledgment was observed.

### 4. Report the actual delivery state

Compute the delivery-wait condition using the current action UUID/digest and lifecycle delivery state as well as the workflow cursor. An `ordered` workflow cursor can describe an agent already doing accepted work; it is not sufficient to print `waiting to send`.

For accepted work, present working when execution is proven, and accepted/queued when it is not yet proven. Do not print advice suggesting another automatic prompt during normal accepted activity. Retain bounded diagnostic detail for investigations and retain real unsent/split-brain warnings when the action actually needs delivery. Keep deferral deduplication and restart behavior. Verify the existing status report shows `agent acknowledged the task` and `working; no intervention needed` for receipt-backed work.

## Tests

Add the fewest behavior-focused regressions by extending existing cases and using table-driven variants where the invariant is shared:

1. **`test/agentLifecycle.test.ts`: newer work and older Stop.** Accept/start turn B, then deliver Stop/failure from A. Assert B remains working with the same turn, acceptance, background/queue fields and idle epoch; a current B Stop still behaves correctly. Include duplicate older Stops and a replaced session.
2. **`test/agentLifecycle.test.ts`: reused-ID handoff.** Start action A, accept B with the same or missing turn ID, then Stop A. Assert B is never idle or eligible for an automatic duplicate. Explicit start evidence makes B working without inventing a new turn; repeated prompt/start/Stop observations do not create idle credit. Extend the existing legacy-schema assertion for every added default.
3. **`test/agentEvent.test.ts`: correlated Cursor tools.** Extend the existing analytics test to distinguish insufficiently correlated usage-only traffic from current-turn `postToolUse`/`postToolUseFailure`. Current work repairs queued state and still records the original usage row; stale sessions/generations cannot change current execution or accept another action. Token-only and status-line telemetry remain non-activity.
4. **`test/action.test.ts`, `test/paths.test.ts`, `test/agentLanguage.test.ts`: mailbox contract.** Extend both-mode rendering, installed-protocol and path-isolation cases. Exercise exact valid syntax and missing/malformed/oversized/non-regular/symlink receipts using the existing readiness fixture. Check the instructions apply before replacement execution and preserve completion/ready behavior.
5. **`test/runLoop.test.ts`: reread pickup and races.** Publish a replacement, write its exact start receipt without a prompt callback, and poll/restart: expect accepted working state, zero additional sends, unchanged workflow completion state, and no waiting-to-send warning. Table-driven variants cover receipt arrival at the final pre-send boundary, receipt acceptance racing injection bookkeeping, wrong identity/digest, old receipt after session replacement, paused/pull-only observation, and repeated receipt ingestion. Assert invalid receipts cannot suppress a legitimate unsent action and cannot release an unrelated/newer hold.
6. **`test/runLoop.test.ts`: false-idle and reporting.** Replay the reused-turn prompt/old-Stop sequence through delivery decisions and assert no repeat send. Extend the existing deferral/report fixture to distinguish accepted working/queued states from an actually unsent order and preserve deduplication across restart. Assert the ordinary current-Stop and owner-reminder behavior still works.

Focused development commands, verified against the checked-in Vitest configuration:

```sh
pnpm exec vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/agentEvent.test.ts test/action.test.ts test/paths.test.ts test/agentLanguage.test.ts
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts
```

The workspace configuration declares `pnpm run check:fast` for precommit and `pnpm run test:e2e` for prepush. Let those hooks own their mandatory checks; do not duplicate the full commands immediately before committing. `check:fast` currently includes lint, typecheck, fast tests, and system tests. The frozen start state declares coordinator final check `pnpm run check`, which also builds and runs e2e. Cite its recorded result when available; do not claim it was run by the implementing agent. No version bump is required for ordinary issue commits.

For this plan-only action, validate the required headings, explicit file map, source/helper references, bound identifiers, and artifact contents. No product suite is needed or claimed.

## Alternatives Rejected

- **Ignore only mismatched Stop IDs.** This fixes Cursor's regression but leaves Claude's reused-ID handoff and unacknowledged reread pickup broken.
- **Treat every prompt submission as execution starting.** It cannot distinguish accepted input queued during an existing turn and is the source of false idle when that preceding turn stops.
- **Infer pickup from arbitrary tool use or reading `action.md`.** Old-turn/background activity does not identify which action the agent is executing. A small explicit receipt supplies the missing action identity; correlated tools repair execution separately.
- **Require agents to await a fresh prompt for every action.** This removes the documented immediate-reread behavior and adds unnecessary sends instead of tracking actual pickup.
- **Add delays, relax terminal vetoes, or resend because completion is missing.** Timing is not execution evidence and would create duplicates. Existing positive-readiness and owner-recovery rules remain.
- **Add another CLI command, service, or hook family.** The existing writable mailbox and installed Cursor callbacks cover the necessary inputs without new dependencies or installation work.

## Risks and Mitigations

- **Vendor IDs may be reused or absent.** Explicitly model the ambiguous handoff, keep action-start evidence separate from vendor turns, and refuse false idle credit. Do not use arrival time as proof that an ambiguous Stop ends the new work. Completion/ready evidence and explicit owner recovery remain available when the vendor cannot disambiguate.
- **Receipt replay or action rewrite.** Bind to exact UUID/digest, active assignment, current file and applicable session/order timing; persist consumption identity across polls and restart. Digest changes require a new acknowledgment and must not silently inherit the previous action bytes' start evidence.
- **Races with terminal delivery.** Recheck immediately before reservation/transport and preserve accepted evidence through late injection bookkeeping. Keep charged uncertain sends durable; an older receipt cannot clear a newer reservation.
- **Advisory evidence gaining workflow authority.** Start receipts only affect delivery/execution observations. They cannot validate an artifact, finish a ballot, advance a gate, mint idle credit, or remove unrelated holds.
- **Hook traffic increasing write/log volume.** Reuse semantic deduplication and the existing activity-hook receipt sequence, keeping usage records unchanged and avoiding a lifecycle journal row for every identical working callback.
- **Compatibility with existing runtimes and tests.** Default all additive schema fields; preserve genuine current Stop, Antigravity queue/background policy, `ready` receipt behavior, resource correlation, and owner-reminder semantics. Use the declared hook/final suites after focused regressions.

## Conclusion

Implement the lifecycle handoff correction and one explicit start receipt within the listed existing files. Acceptance will no longer imply a distinct execution turn, older Stops will not overwrite newer work, current Cursor tool activity will repair stale execution, and actions picked up through rereading will be acknowledged before another automatic send. Reports will distinguish accepted work from actual delivery waits while retaining the existing workflow validation and readiness protections.
