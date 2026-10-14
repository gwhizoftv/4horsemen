# Issue 222 plan: send on `ready`, delete idle detection, add a stall watchdog

## Summary of the algorithm being implemented

Sources: the issue body and the owner's review comment (items 1–11). Where the
two disagree, the comment wins: there is **no 30-second ack retry** (item 4).

1. **Consume `ready`.** Every tick, for every active agent, coord reads the
   `ready` mailbox file. A receipt is valid when its action ID is the agent's
   current cursor `actionId` or its `lastAcceptedActionId`. It is invalid when
   it names an earlier action and the current action has already been sent: in
   that case the receipt predates that send. A valid receipt is recorded in the
   agent's lifecycle entry as `ready: { actionId, at }`. Coord then deletes the
   file, valid or not, and journals `ready-consumed` or `ready-ignored`.
2. **Send.** An agent owes work when its cursor is `ordered`, `complete` is
   missing, and `action.md` exists. If the current `(actionId, actionDigest)`
   is unsent and a send is authorized, coord delivers it. Whichever comes second
   (the ready receipt or the order) triggers the send. A successful send clears
   `ready`. A send is authorized by any one of:
   - a recorded `ready`;
   - **JOIN**: the agent has no `lastAcceptedActionId` yet;
   - a **fresh session**: a `SessionStart` or status payload established a new
     session ID, and no prompt has been submitted since;
   - a **hold release**: the action was sent under an older `holdGeneration`
     than the current one.

   No hook execution state, Stop, turn ID, idle epoch, sentinel or
   hook-versus-file timestamp takes part.
3. **Keystroke safety only.** Every automatic send still passes the
   gate/readiness checks in item 5 of the review. These are pane dead,
   owner-typing (copy mode), input-off, foreground-mismatch, trust dialog,
   `claude-usage-wait`, Antigravity verify overlay, the vendor prompt-visible
   checks (`claude-no-prompt`, `antigravity-no-prompt`, turn chrome), vim/INSERT
   prelude selection and the Codex composer check. Only the sentinel logic is
   removed.
4. **Ack is display-only.** A matching prompt-submit still marks the action
   `accepted`, which drives the status line and `reconcileSubmitted`'s release
   of a `delivery-uncertain` hold. It never gates or triggers a send. No ack
   timer exists.
5. **Watchdog** (item 10). Every 60 s, for each agent that owes work, coord
   fingerprints three things:
   - the vendor transcript's `mtimeMs:size`, for Claude and Codex;
   - the tool-hook sequence;
   - a digest of the pane above the composer.

   The agent is **busy** if the fingerprint changed since the previous check,
   or if a `PreToolUse` has no matching post-tool event yet. Otherwise it is
   **quiet**. On a quiet check:
   - first time for this action: one resend, with the same keystroke-safety
     checks. If the composer still holds this action's unsent prompt, only the
     submit keys are sent.
   - after that: a single `[WAIT]` line naming the agent, the action and how
     long it has been quiet. No further resend.

   Both outcomes are durable per `(actionId, actionDigest)`.
6. **Owner `n`** (item 9) resends the current action to an agent that owes work.
   For an agent that owes nothing, it types nothing and logs that.
7. **Resend wording.** Both the watchdog resend and owner `n` prefix the prompt
   with "If you already wrote complete for this action, only write its ready
   file. " The prefix comes *before* `Read and execute coordinator action …`, so
   `extractPromptActionIdentity`, which captures `at <path>` to end of line,
   still parses the path.
8. **Reread protocol stays** (item 6). An agent writes `ready A` only when its
   reread did not find a newer action. If the reread finds B, the agent writes
   no `ready A` and coord never sends B, because B has no authorization. If coord
   publishes B after `ready A` was written, the agent never saw B, so coord sends
   it. Neither path produces a duplicate, and no guard is added for it.
9. **`COORD-IDLE`** is removed from the protocol template and from every action
   body (item 7). Nothing reads it any more. Issue #216 becomes obsolete because
   its code path is deleted.

## Exact File List to be changed or deleted

Source:

- `src/agentLifecycle.ts`
  - Delete:
    - entry fields `execution`, `turnId`, `recentTurnIds`, `stoppedTurnIds`,
      `pendingInputCount`, `backgroundActive`, `stoppedAt`, `idleEpoch`,
      `stopObservation` (with `emptyStopObservation`/`stopObservationSchema`);
    - action fields `retryableInjectionAt`, `lastNudgedIdleEpoch`,
      `queuedBehindTurnId`, `queuedBehindStopped`, `rereadExpected`;
    - the `queuedIntoTurnStop`, `queuedWorkStop`, `stoppingOlderTurn` and
      `repeatedStop` logic;
    - `positiveIdle`, `markInjectedActionAbsent`, `markActionInjectionDeferred`,
      `hasStopReadiness`, `rereadPickupPending`, `stopObservationWarning`,
      `NudgeWaitCode`, `NudgeDecision` and `decideLifecycleNudge`;
    - the `working` observation kind and the
      `execution`/`pendingInputCount`/`backgroundActive`/`allowInjectedIdle`
      observation fields.
  - Add entry fields:
    - `ready: {actionId, at} | null`;
    - `freshSession: boolean`;
    - `toolActivity: {sequence, pending, at}`, defaulting to `{0, 0, null}`.
  - Add action fields:
    - `sentHoldGeneration: number | null`;
    - `resentAt: timestamp | null`;
    - `waitReportedAt: timestamp | null`;
    - `watch: {checkedAt, quietSince, fingerprint} | null`.
  - Add the `tool-start` observation kind.
  - Drop `.strict()` from `lifecycleActionSchema` and
    `agentLifecycleEntrySchema` only. Zod's default strip then lets runtimes
    written before this change load, discarding the removed keys. The top-level
    state schema stays strict.
  - Rewrite `applyLifecycleObservation` to keep only these behaviors:
    - retired-session and session-replacement guards (unchanged);
    - telemetry (unchanged);
    - session change resets an unfinished action to unsent, including clearing
      the new watchdog fields;
    - `freshSession` is set when a session-start or status observation
      establishes a new session ID, and cleared on any prompt-submit;
    - a matching prompt-submit marks the action accepted, as today;
    - tool events bump `toolActivity`: `tool-start` increments `pending`,
      `tool-activity` decrements it (floor 0), and both increment `sequence`;
    - `pending` resets on stopped, failed, session-start and session-end;
    - `recordFailure` correlation is unchanged and still uses `action.turnId`;
    - containment is cleared on session change or end;
    - health, `lastEvent` and `lastEventAt` are updated as today.
  - In `observeAgentLifecycleWithResult`, remove the Antigravity idle-status
    special case. `tool-start` joins `telemetry` and `tool-activity` in not
    advancing `hookReceipt`.
  - `markActionInjected` gains `options: {holdGeneration, resent}`. It records
    `sentHoldGeneration`, sets `resentAt` when `resent` is true, and clears
    `entry.ready` and `freshSession`. The idle-epoch, `rereadExpected` and
    `stoppedAt` handling is dropped.
  - `orderAgentAction` drops `rereadExpected` and initializes the new action
    fields.
  - `markActionWorkflowComplete` drops the `stopObservation` and
    `rereadExpected` handling. It keeps `pickedUpByReread`, which is
    informational.
  - New `recordAgentReady(paths, agent, actionId, now)`: idempotent for the
    same action ID.
  - New `updateActionWatch(paths, agent, actionId, actionDigest, patch)`: sets
    `watch` and `waitReportedAt` on the matching action.
  - `markObservabilityDegraded`, `AGENT_OBSERVABILITY_WATCHDOG_MS`, containment
    and failure code are untouched.
- `src/agentEvent.ts`
  - Claude and Codex: `PreToolUse` maps to `tool-start`. `PostToolUse` maps to
    `tool-activity`, and so does `PostToolUseFailure` for Claude.
  - Antigravity: `PreInvocation`/`PostInvocation` map to `tool-activity`
    instead of `working`. The `status-line` observation becomes session identity
    only, with no execution, queue or background fields.
  - Claude and Cursor Stop/StopFailure drop `backgroundActive`.
  - `handleAgentEvent` does not journal `tool-start`/`tool-activity`, just as
    it skips telemetry, and drops the `execution` journal detail.
- `src/agentHookSync.ts`
  - `nestedEvents` adds `PostToolUse` for Codex, and `PostToolUse` plus
    `PostToolUseFailure` for Claude.
  - `plannedDocument` emits a list of managed entries per event, so
    `PreToolUse` carries two:
    - the existing `matcher: "Bash"` shell guard;
    - a matcher-less (all tools) lifecycle entry using
      `renderAgentLifecycleHookCommand(…, "PreToolUse")` with a 5 s timeout.
  - Removal and inspection reuse `nestedEvents`, so no other change is needed
    there.
  - Update the `cursorLifecycleEvents`/`cursorUsageEvents` comments: Cursor's
    post-tool hooks now also count as watchdog activity.
- `src/transcriptRead.ts`: export
  `locateTranscript(vendor, root, sessionId): string | null`. It wraps the
  existing `locateClaudeTranscript`/`locateCodexTranscript` with the same
  session-ID validation `readTranscript` applies, and `readTranscript` calls
  it. No parsing changes.
- `src/tmux.ts`
  - Delete:
    - `COORD_IDLE_SENTINEL`, `sentinelAtTail`, `linesAfterCodexSentinel` and
      `idleSentinelAfterAction`;
    - the `requireSentinel` parameters of `codexTail`/`codexVimNormal`;
    - the `IdleOverride`/`OverrideLifecycle` types;
    - the `no-idle-sentinel`, `lifecycle-changed` and
      `pane-capture-unavailable` reasons;
    - `harnessPromptReady` and `actionAbsentAtReadyPrompt`.
  - Rename `codexSentinelAtTail` to `codexComposerEmpty`, which keeps the
    empty-composer check.
  - `harnessPromptReadiness(paneText, agentId)` keeps every blocking check and
    only ever returns `vendor-prompt` when ready.
  - `nudge` loses `staleOverride` and the stop-hook bypass. It gains
    `options: {resend?: boolean}`.
  - For Codex, a non-empty composer refuses with `codex-composer-not-ready`
    unless it holds this action's prompt. This check used to apply only on the
    ready-file path; it now applies to every Codex send, because that path is
    now the main one.
  - On a resend, `pendingPromptInComposer(paneText, agentId, actionId)` decides
    whether only the resolved submit keys are sent. For Codex it looks at the
    `codexTail` composer lines; for other vendors, the last 6 non-blank lines.
    Any key still goes through `send`, so every gate re-check before each key
    is kept.
  - `renderNudgeText` gains an optional `resend` flag that adds the "If you
    already wrote complete…" prefix.
  - New export `paneActivityDigest(paneText)`: `sha256` of the ANSI-stripped
    lines **above** the last composer line (a trimmed line starting with `❯`,
    `›` or `>`), or of the whole pane when there is none. The owner's draft and
    the vendor footer/status line below it are therefore ignored, while
    spinner and timer lines above the composer still count.
- `src/runLoop.ts`
  - Delete:
    - `readyForNextAction` and the `writtenAt > lastHook` rule;
    - the `staleWorking`/`staleOverride`/`lifecycleOverride` paths;
    - the lifecycle execution/background/pending gates in `deliver`;
    - the `decideLifecycleNudge` gate and lost-injection proof
      (`actionAbsentAtReadyPrompt`, `markInjectedActionAbsent`,
      `prompt-ready-action-absent`) in `maybeLifecycleNudge`;
    - the `markActionInjectionDeferred` calls and the `paneObservations` gate
      in `maybeLifecycleNudge`;
    - `reportStopWarnings` and its `stopWarnings` map;
    - `lostDeliveryDelayMs`, the deprecated `nudgeRetryMs` dependency and
      `NUDGE_RETRY_MS`;
    - the `rereadPending`/`splitBrain` branches and the `execution`/`pending`/
      `background` hook details in `journalDeferral`;
    - the `DEFERRAL_RATIONALE` entries for the removed codes;
    - the "pane shows COORD-IDLE" log.
  - New private `consumeReady(cursors, agent)`, which implements summary
    step 1. `runTick` calls it for each active agent after `reconcileSubmitted`
    and before the pause check. It only records observations, so it is safe
    while held.
  - `maybeLifecycleNudge` (name kept) becomes:
    1. rewrite the ordered action (existing `rewriteOrderedAction`);
    2. order it (existing `orderAgentAction`);
    3. return if the action is already sent under the current `holdGeneration`;
    4. return, with a `verbose` diagnostic, if no authorization from summary
       step 2 holds;
    5. otherwise call `deliver`.
  - `deliver` keeps:
    - the owner-same-tick skip, minus the deferral mark;
    - the reservation, `delivery-uncertain`, `nudge-loop` budget and spacing
      logic;
    - the `vendor-wait`, `harness-gone` and mid-send handling;
    - `journalDeferral` for scrape refusals.

    It passes `{resend}` to `nudge`, and passes `{holdGeneration, resent}` to
    `markActionInjected`. The JOIN and initial send from `prepare` is unchanged.
  - New private `watchOwedWork(start, cursors, agent, actionId)`, which
    implements summary step 5. It runs in the `runTick` per-agent loop after
    `observeUnfinished`, only when the cursor is `ordered` and `complete` is
    missing.
    - Its interval is gated by the durable `watch.checkedAt` (60 s, reusing
      `OBSERVATION_INTERVAL_MS`).
    - It uses `this.tmux.capturePane` and `paneActivityDigest`, a
      `statSync(locateTranscript(...))` stamp, `entry.toolActivity`, and
      `sha256` from `hash.ts`.
    - It resends via `deliver(..., "resend")`, or logs
      `[WAIT] Issue <n>: <agent> owes action <id> and has been quiet for <m> min; inspect its terminal`
      and journals `nudge-deferred` with code `stalled`.
  - New `RunLoopDependencies.transcriptRoots`, defaulting to
    `~/.claude`/`~/.codex` through `os.homedir()` exactly as `cli.ts` already
    does for analytics. Tests inject temporary directories.
  - `ownerReminderMessage` returns the resend text only for an agent that owes
    work. Otherwise `sendOwnerReminder` types nothing, logs
    `[OK] <agent> has no outstanding action; nothing sent.` and journals
    `nudge-deferred` `{owner: true, code: "no-owed-action"}`. The
    `submission-pending`/`unassigned` texts are deleted.
- `src/action.ts`: remove the `COORD-IDLE` paragraph from `readyInstructions`.
  The ready-file instruction and `readReady`/`clearReady`/`parseReady` stay.
- `src/issueReport.ts`
  - Agent lines drop execution, queue, background and reread text. The line
    shows delivery (`not yet sent` / `sent` / `acknowledged`), then
    `; ready for its next action` when `entry.ready` is set, then
    `; resent after a quiet minute` / `; quiet, waiting on the owner` from
    `resentAt`/`waitReportedAt`.
  - `uncertain` no longer uses `stopObservationWarning`.
  - Imports are trimmed accordingly.
- `src/interactive.ts`: the help line for `n` says it resends the current
  outstanding action and skips agents that have none.
- `templates/product/AGENTS.protocol.md`: delete the
  "Then end your reply with this exact line … `COORD-IDLE` …" paragraph and its
  code block. Change "Coordination uses the ready file as durable idle evidence
  and still checks your terminal before typing" to "Coordination sends your
  next action when it reads the ready file." Delete the two sentences about
  keeping and printing the line.
- `docs/readiness-policy.md`: rewrite the automatic-delivery sections to match
  the summary above. This covers the authorizations, the keystroke-safety list,
  display-only ack, the watchdog and owner `n`. The removed refusal codes are
  deleted from its code table.
- `docs/analytics.md`: remove `retryableInjectionAt` from the two lifecycle
  timestamp lists (lines 123 and 324). Note that `execution` appears only in
  journals written before issue 222.

Tests (all existing files):

- `test/runLoop.test.ts`, `test/agentLifecycle.test.ts`,
  `test/agentEvent.test.ts`, `test/agentHookSync.test.ts`,
  `test/tmux.test.ts`, `test/transcriptRead.test.ts`, `test/action.test.ts`,
  `test/agentLanguage.test.ts`, `test/issueReport.test.ts`,
  `test/integration.test.ts`. See Tests.

Nothing is deleted at file level.

## Exact file list to be created

- `.plans/issue-222/plan.md` (this coordination artifact).

No product file is created. All new code and tests go into the existing files
above.

## Reuse and Scope

Reused unchanged or nearly unchanged:

- **Ready mailbox:** `readReady`, `clearReady` and `parseReady` (`action.ts`),
  `readyReceiptPath`/`agentRuntimePaths(...).ready` (`paths.ts`), and the
  completes-root symlink checks.
- **Send transport and safety:**
  - `TmuxController.injectionGate`, `inspectPane`, `capturePane`,
    `typeAndSubmit`, `resolveNudgeKeys`, `vimInsertPrelude`, the Cursor vim
    helpers, `codexTail`/`codexComposerEmpty`/`codexVimNormal`, and
    `harnessPromptReadiness` minus the sentinel;
  - `TmuxController.remind` for owner `n`.
- **Delivery accounting:** `CoordinatorRunLoop.deliver`'s reservation,
  `ensureActionSafety`, `hold`/`holdMutation`, `reconcileSubmitted`,
  `journalDeferral`, `clearScrollbackWait`/`currentScrollbackWait`,
  `observeUnfinished` (the `vendor-wait` and `harness-gone` holds),
  `observeResources`, `rewriteOrderedAction`, `releaseHold`'s
  `holdGeneration` bump (`state.ts`, unchanged), `actionSafety`
  `sends`/`lastSendAt`/budget, and `OBSERVATION_INTERVAL_MS`.
- **Lifecycle:** `orderAgentAction`, `markActionInjected`,
  `markActionWorkflowComplete`, `mutateAgentLifecycle`, `replaceEntry`,
  `recordFailure`, `applyTelemetry`, `containmentCoverage` and
  `recordContainmentEvidence`.
- **Hooks:** `renderAgentLifecycleHookCommand`, `withoutManagedNestedHandlers`
  and `syncAgentLifecycleHooks`/`removeAgentLifecycleHooks`/
  `inspectAgentLifecycleHooks` (driven by `nestedEvents`), plus the Cursor
  `postToolUse`/`postToolUseFailure` hooks already installed
  (`agentHookSync.ts:114`).
- **Transcripts:** `locateClaudeTranscript`/`locateCodexTranscript`
  (`transcriptRead.ts`), exported through one wrapper rather than duplicated.
- **Hashing:** `sha256`/`sha256OfFile` (`hash.ts`).
- **Tests:** the `safetyFixture` fake tmux (`test/runLoop.test.ts:234`), with
  its `ui.text`, `sends`, `sentTexts`, `advance`, `working` and `stop` helpers,
  plus `fixture`, `observeAgentLifecycle`, `initialAgentLifecycle`, the
  `test/support/fixtures/transcript-*.jsonl` files, and the existing hook-sync
  and tmux test scaffolds.

Scope boundaries:

- **No new files, abstractions or dependencies.**
- **Kept on purpose:**
  - `health`/`degradedCause`/`markObservabilityDegraded`, which are
    observability rather than idle detection;
  - the `nudge-loop` budget and spacing, a safety backstop that is now rarely
    reached;
  - `pickedUpByReread` logging;
  - the `action.turnId` failure correlation.
- **Out of scope:** the optional Claude `Notification` hook, Cursor-specific
  composer layouts beyond the tail heuristic, and analytics changes.
  `docs/issue-209-efficiency-analysis.md` and `docs/issue-193-plan.md` are
  historical records and stay unchanged.
- **Paths named only here** (`paths.ts`, `state.ts`, `hash.ts`, `cli.ts`,
  `setupWorkspace.ts`, the fixtures) are reused, not modified.

## Tests

Each test fails on the baseline and passes after the change. During
development, run focused tests with
`pnpm exec vitest run --config vitest.config.ts <file>`. The commit hook runs
`pnpm check:fast`. The coordinator owns final `pnpm check`.

**`test/runLoop.test.ts`**, new `describe("ready-driven delivery and stall watchdog")`

These use `safetyFixture` with one persistent `makeLoop()` where watchdog
memory matters, and a temporary `transcriptRoots` directory. Fixture
timestamps reproduce the issue's journals.

1. **396 send at order time.**
   - Setup: `ready` for the last accepted action has an mtime 4 s *before* the
     latest hook receipt. The pane shows a Claude prompt with no sentinel.
   - Expected: the next action is typed on the first tick after it is ordered,
     and no `no-idle-sentinel` or `working` deferral is journaled.
   - Baseline failure: `writtenAt > lastHook` rejects it.
2. **Ready consumed once.**
   - Expected: after the tick the `ready` file is gone and
     `lifecycle.ready === null`. Ten further ticks with pane activity produce
     exactly one send.
3. **Ready before verification.**
   - Setup: `ready A` is written while `complete A` is pending.
   - Expected: no send; `ready` is recorded and the file deleted. After A is
     accepted and B ordered, B is sent exactly once.
   - Variant: a failed verification reissues A under a new digest, and the
     reissue is sent once.
4. **413 queued-into-turn.** Claude acknowledges the review action with the
   live turn's ID. The Stop of that turn, a repeated Stop, and a later Stop all
   arrive. Over the following ticks there is no second send.
5. **415 six actions in one turn.** Codex receives six actions in sequence.
   Each is preceded by `ready <previous>` and acknowledged with the *same* turn
   ID, with no Stop in between. The result is exactly six `send-keys -l`, one
   per action ID.
6. **JOIN, new session and hold release.**
   - JOIN: the first action is sent without `ready`.
   - New session: after a `session-start` with a new session ID while an
     action is owed and was sent, it is re-sent once without `ready`.
   - Hold release: after `releaseHold`, the current action is re-sent once
     without `ready`.
7. **Watchdog, idle (396).**
   - Setup: the action is sent, then the pane, transcript and hooks stay
     static.
   - Expected: exactly one resend within 2 min. That resend text carries the
     "already wrote complete" prefix and the unchanged `coordinator action <id>
     digest <d> at <path>` tail. Then one `[WAIT]` line naming agent, action
     and quiet minutes. No further send through +15 min.
8. **Watchdog, busy (415).** The Codex rollout file
   (`sessions/YYYY/MM/DD/rollout-…-<session>.jsonl` under the injected root)
   grows every 50–66 s for 18 min while the pane is static and no journal
   events arrive. There is no resend and no `[WAIT]`.
9. **Watchdog, long tool.**
   - Setup: a `tool-start` with no matching post-tool event, while the
     transcript and pane stay static for 10 min.
   - Expected: no resend. After a `tool-activity` and two quiet minutes, one
     resend.
10. **Lost prompt, no ack timer.**
    - Setup: no prompt-submit ever arrives.
    - Expected: no send at +30 s. At the watchdog resend, the composer still
      shows this action's text (`ui.text`), so only the submit key is sent: no
      second `-l` text.
11. **Owner `n`.**
    - An agent with no owed action gets nothing typed, plus the `[OK] … nothing
      sent` log and a `no-owed-action` journal entry.
    - An agent that owes work receives the resend text.

Existing `runLoop.test.ts` cases that assert the removed behavior are deleted
or rewritten to the rules above. These are the cases for idle-transition, the
stale-working sentinel override, lost-injection retry, `nudgeRetryMs`,
`lifecycleOverride`, the `no-idle-sentinel` deferral and the
unassigned/submission-pending reminders.

**`test/agentLifecycle.test.ts`**

- A legacy entry and action containing every removed key parse, and the keys
  are dropped.
- `tool-start`/`tool-activity` counters work, and `pending` resets on Stop.
- A session change resets an unfinished action and sets `freshSession`, which
  a prompt-submit clears.
- `markActionInjected` clears `ready` and `freshSession` and records
  `sentHoldGeneration`/`resentAt`.
- `recordAgentReady` is idempotent.

The idle-epoch, `decideLifecycleNudge`, queued-turn and reread cases are
deleted.

**`test/agentEvent.test.ts`**

- Claude/Codex `PreToolUse` maps to `tool-start`, and
  `PostToolUse`/`PostToolUseFailure` map to `tool-activity`.
- Antigravity invocation hooks map to `tool-activity`.
- `handleAgentEvent` journals no tool events.

**`test/agentHookSync.test.ts`**

- The Claude and Codex documents contain the Bash guard *and* a matcher-less
  lifecycle `PreToolUse` entry, plus the new post-tool events.
- Re-sync is a no-op.
- Removal strips every managed handler and keeps owner handlers.

**`test/tmux.test.ts`**

- A Claude pane whose tail is only the old sentinel line is
  `claude-no-prompt`; the sentinel is no longer evidence.
- `paneActivityDigest` ignores owner draft and footer changes below the
  composer, but changes with a `Thinking… (45s)` timer.
- `pendingPromptInComposer` covers Codex and Cursor tails.
- A resend `nudge` with the prompt pending sends only the submit keys.

The sentinel and `staleOverride` cases are deleted.

**Other test files**

- **`test/transcriptRead.test.ts`:** `locateTranscript` returns the fixture
  path for Claude and Codex, and `null` for an invalid session ID.
- **`test/action.test.ts`:** the line-81 expectation becomes
  `not.toContain("COORD-IDLE")`.
- **`test/agentLanguage.test.ts`:** the protocol block no longer contains the
  sentinel, but still contains ``write `ready <actionId>` ``. The
  `COORD_IDLE_SENTINEL` import is removed.
- **`test/issueReport.test.ts`:** the agent line shows the delivery, ready and
  watchdog wording without execution text.
- **`test/integration.test.ts`:** the "lifecycle nudge canary" switches from
  Stop-driven to ready-driven expectations.

## Alternatives Rejected

- **Keeping the 30-second ack retry from the issue body.** The owner's review
  (item 4) supersedes it. It would be a second recovery mechanism for the
  state the watchdog already covers.
- **A hook-only quiet signal.** It would resend in the middle of real work: 18
  minutes of Codex silence in 415, and 7 minutes without a Claude hook in 396.
  The transcript and pane signals are required.
- **Turn IDs or Stop to decide quiet or idle.** This is exactly the state
  machine being deleted.
- **Owner-reminder transport for the watchdog**, which bypasses all
  readiness. The review says the resend uses the same keystroke-safety checks.
- **Keeping watchdog state only in memory.** The tests construct a new
  coordinator per tick to prove durability, and a coord restart must not
  repeat a resend. So `resentAt`, `waitReportedAt` and `watch` live on the
  lifecycle action.
- **Bumping `AGENT_LIFECYCLE_FORMAT_VERSION` with a migration function.** This
  is more code than letting Zod strip removed keys on the two inner schemas,
  and gives the same result for in-flight runtimes.
- **Reading `transcript_path` from hook payloads.** That stores
  agent-supplied paths. The existing locators already resolve the file from
  the bound session ID under the vendor root.
- **Adding the Claude `Notification` hook.** It is optional in the review and
  not required by any acceptance test, so it stays out to keep scope tight.

## Risks and Mitigations

- **Hook latency.** The all-tools `PreToolUse`/`PostToolUse` hooks start Node
  per tool call: two short processes per call, with a 5 s timeout and no
  stdout.
  - They do not journal and only touch the lifecycle file under its existing
    lock.
  - Without them, the watchdog still has the transcript and pane signals.
- **A post-tool event never arrives.** For example, a tool denied by the Bash
  guard leaves `pending` raised.
  - `pending` resets on Stop, StopFailure, SessionStart and SessionEnd. The
    raised count can only *delay* a resend, never cause one.
  - `PostToolUseFailure` is installed for Claude for the same reason.
- **Clones need re-sync for the new hooks.** Existing clones keep their old
  hook files until `coord install` (`install.ts:419`) re-syncs them;
  `inspectAgentLifecycleHooks`/doctor report `modified` until then. Coverage
  degrades to transcript plus pane, which is still safe because hook silence
  never counts as quiet.
- **Pane noise reads as busy.** A changing owner status line could hide a
  stall. The digest ignores everything from the last composer line down,
  including the footer and status line. The test covers a footer change.
- **The resend crosses a just-finished turn.** The resend prefix tells the
  agent to only write `ready` if `complete` is written. The watchdog also
  never runs when `complete` exists.
- **A stale `ready` from before a send authorizes a later duplicate.**
  `consumeReady` ignores a receipt naming an earlier action once the current
  action was already sent, and every successful send clears `ready`.
- **Mid-turn sends are refused by turn chrome** (Codex `Working`, Cursor
  spinner). The send defers to the next poll, as today, and the deferral is
  journaled with its existing code. This keeps keystroke safety: Escape-bearing
  submits cancel turns in Cursor and Antigravity.
- **Owner `n` no longer sends neutral reminders.** This is intentional (item 9).
  The log line states nothing was sent, and the journal records
  `no-owed-action`.
- **A runtime written before this change** loads because removed keys are
  stripped. Old journals keep their `execution` detail; analytics does not read
  it.

## Conclusion

The plan deletes the hook-driven idle/working state machine and the
sentinel/override paths. The fields removed are listed in the file list above.
Delivery becomes: consume `ready` into lifecycle state and delete the file,
then send the next unsent action on `ready`, JOIN, fresh session or hold
release. Every send passes only the keystroke-safety checks.

A durable, one-minute stall watchdog replaces all retry logic. It reads
transcript, tool-hook and pane activity, resends once, then reports `[WAIT]`.

Changes stay inside 12 existing source, template and doc files and 10 existing
test files, with no new files or dependencies. The acceptance cases for issues
396, 413 and 415, ready consumption, lost prompt, ready-before-verification,
JOIN and new session, and the three watchdog cases are each covered by a
focused test. Issue #216 can close as obsolete once this lands.
