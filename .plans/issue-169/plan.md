# Issue 169 — durable idle receipt beside `complete`

Baseline: `cd2798983651198c865cd37c494e8ac38062c109`.

## Diagnosis

Three separate things show up as "coord cannot tell the agent is idle". The
evidence comes from this issue's own runtime (`coord-runtime/issue-169/journal.jsonl`)
and from live `tmux capture-pane` reads of the agent panes.

1. **For Claude and Cursor, the COORD-IDLE line can never pass the pane test.**
   `harnessPromptReadiness` (`src/tmux.ts`) counts the sentinel only through
   `sentinelAtTail`, which requires it to be the *last non-blank line* of the
   capture. Claude Code always draws its `────` rule, the `❯` composer, a
   second rule and a configurable status line (model, ctx, 5h/7d, `auto mode
   on`) *below* the transcript. Cursor draws `→ Add a follow-up` and two
   footer lines. So for those two agents the line the agent "reliably prints"
   is on screen but never at the tail. The only consumer that needs the
   sentinel is the stale-`working` override in `deliver()` (`src/runLoop.ts`).
   When a Stop hook never reaches the issue, that override always refuses with
   `no-idle-sentinel`, and its operator text says "its pane shows no COORD-IDLE
   line", which is false. Only Codex has a footer-aware parser
   (`codexSentinelAtTail`).
2. **"Mid-turn" / "cannot determine" lines are printed after delivery has
   already succeeded.** `journalDeferral` prints whenever the cursor is still
   `ordered`. That stays true until `complete` is accepted, so the first idle
   tick after a successful send prints `delivery to claude deferred: working;
   the agent is mid-turn`. In this issue that happened at 22:49:50, one second
   after `nudged` at 22:49:49. For Codex, whose hooks are not correlated, it
   prints `unknown; no lifecycle signal has been correlated yet` (22:49:41,
   after `nudged` at 22:49:40). Nothing is wrong in either case; delivery is
   done.
3. **The startup `foreground-mismatch (bash)` is unrelated, transient
   and correct.** The first tick runs right after `new-window` starts the
   launcher, before the harness has replaced the shell as the pane's
   foreground process. The gate correctly refuses. In issue 169, Claude's
   `SessionStart` arrived and the nudge went out within one second
   (22:48:48 → 22:48:49). The only defect is the wording: it reads like a
   misconfiguration instead of "the harness is still starting".

The owner's proposed design fixes item 1 without scraping the pane. Items 2
and 3 are one-condition and one-string fixes to the messages the owner
actually sees.

## Exact File List to be changed or deleted

- `src/paths.ts`: add `ready` to `AgentRuntimePaths` (`containedPath(completeDir, "ready")`)
  and export `readyReceiptPath(completePath)`, so the renderer and the reader use one definition.
- `src/action.ts`: add `parseReadyReceipt`, `readReadyReceipt` and `clearReadyReceipt`
  next to `parseCompletion`/`readCompletion`/`clearCompletion`. In both
  `renderGitAction` (the closing paragraph) and `renderResponseAction`, add the
  instruction: if the re-read shows the same `actionId`, write
  `ready <that actionId>` as the only contents of the rendered ready path, then
  end with the COORD-IDLE line.
- `src/agentLifecycle.ts`: add `lastAcceptedActionId: actionIdSchema.nullable().default(null)`
  to `agentLifecycleEntrySchema`, and `null` to `emptyEntry`. Set it in
  `markActionWorkflowComplete`, which is already called on acceptance at
  `runLoop.ts` 1875/2123. `orderAgentAction` spreads `...current`, so the field
  survives the next order. Add the pure
  `readyReceiptProvesIdle(entry, receipt): boolean`, which is true only when
  `receipt.actionId === entry.lastAcceptedActionId` and
  (`entry.lastEventAt === null` or `lastEventAt` is strictly earlier than the
  receipt's mtime).
- `src/tmux.ts`: change `nudge()`'s last parameter from `() => OverrideLifecycle` to
  `StaleOverride = { proof: "idle-sentinel" | "ready-receipt"; lifecycle: () => OverrideLifecycle }`.
  Apply the two "must read `idle-sentinel`" checks (the initial readiness check
  and the pre-typing check inside `send`) only when `proof === "idle-sentinel"`.
  Keep every other per-key check for both proofs: the gate (dead pane, owner
  typing, input off, foreground), the vendor blockers, `lifecycle-changed`, the
  Codex composer-holds check and submit-acceptance.
- `src/runLoop.ts`:
  - `deliver()`: when `staleWorking` holds, read the receipt with
    `readReadyReceipt(runtime.ready)` and choose
    `proof: readyReceiptProvesIdle(entry, receipt) ? "ready-receipt" : "idle-sentinel"`.
    On any `sent` result, `clearReadyReceipt(runtime.ready)`, matching the owner's
    "delete ready once that nudge is sent". Add `overrideProof` next to
    `lifecycleOverride` in the `nudged` journal details. Make the existing
    stdout override line name the proof that was used.
  - `DEFERRAL_RATIONALE["no-idle-sentinel"]`: change to "lifecycle hooks report
    the agent mid-turn, and neither a ready receipt for its last accepted action
    nor a COORD-IDLE line at the end of its pane shows it finished".
  - `deliver()` busy branch: for `foreground-mismatch` while the lifecycle entry
    has no `sessionId` yet, journal and print the human text "the harness has
    not started in this pane yet; the launcher shell is still in the
    foreground". The code stays `foreground-mismatch`, so consumers of the
    closed union are unaffected.
  - `journalDeferral`: `gateWaiting` additionally requires that the lifecycle
    action for this `actionId` is still `delivery: "ordered"` (never sent).
    After a send, the deferral is journaled but goes to `verbose`. `splitBrain`
    lines are still always printed.
- `templates/product/AGENTS.protocol.md`: in the "If that re-read shows the same
  `actionId`" paragraph, require writing `ready <actionId>` to the `ready` file
  next to `complete` before printing COORD-IDLE, and state that it is the
  durable idle proof.
- `docs/readiness-policy.md`: in "One exception: a stale `working` record",
  document the ready receipt as the second admissible proof, with its two
  conditions, its deletion on send, and that it never bypasses a pane veto.
- `docs/coord-driver.md`: add `ready` to the mailbox tree and to "Agents write at most…".
- `test/runLoop.test.ts`, `test/action.test.ts`, `test/tmux.test.ts`: see Tests.

## Exact file list to be created

- `.plans/issue-169/plan.md` (this coordination artifact only).

No product file is created. Every helper joins the module that already owns its
neighbour: completion parsing in `action.ts`, mailbox paths in `paths.ts`,
lifecycle decisions in `agentLifecycle.ts`.

## Reuse and Scope

Reused, not reimplemented:

- **Mailbox:** `agentRuntimePaths`/`containedPath` and the existing per-agent
  mailbox grant `<completesRoot>/issue-<n>/<agent>`. The `ready` file sits in
  the directory every harness can already write (`--add-dir`/sandbox
  root), so no launcher, grant or `doctor` change is needed.
- **Receipt parsing:** the `parseCompletion` style for the one-line UUID format
  (`actionIdSchema`, the same unpadded single-line rule, the optional trailing
  newline). `lstatSync` + `isFile()` supplies the mtime and refuses a symlinked
  receipt.
- **Acceptance record:** the `markActionWorkflowComplete` call already made on
  acceptance records `lastAcceptedActionId`. No new acceptance hook is added.
- **Override path:** the whole `staleWorking` path in `deliver()`, with its
  never-sent preconditions (`sends === 0`, `delivery: "ordered"`,
  `injectedAt === null`, matching digest), `lifecycleSnapshot`, the per-key
  `staleOverride` re-check, the `reserve` charge, the `delivery-uncertain`
  hold and the `nudge-loop` budget. The ready receipt is only a second way to
  satisfy the one veto the sentinel satisfies today. It cannot authorize a
  second send, a send to a `queued`/`background`/`pending-input` agent, or
  anything after a pane blocker.
- **Messages:** `journalDeferral` and `DEFERRAL_RATIONALE` for the message
  fixes. The deferral codes are unchanged.
- **Test fixtures:** `fixture()`, `observeAgentLifecycle`, `orderAgentAction`,
  `markActionWorkflowComplete`, `readJournal` and the fake `TmuxController`
  runner in `test/runLoop.test.ts`, plus `order()` in `test/action.test.ts`.

Out of scope: pane parsing for Claude/Cursor (see Alternatives), Codex hook
routing (issue 176), the `unknown` lifecycle state itself, and the agent
`AGENTS.md` in this clone (skip-worktree; it is regenerated from the template).

## Tests

All new cases join existing files. Focused runs while developing:
`pnpm vitest run test/runLoop.test.ts test/action.test.ts test/tmux.test.ts test/agentLifecycle.test.ts`.
The pre-commit hook owns `pnpm check:fast`.

1. `test/runLoop.test.ts`, new case **"a ready receipt for the last accepted
   action overrules a stale working record before the first send"**:
   - Arrange a Claude pane fixture (`display-message` → `claude`; capture shows
     the transcript ending `COORD-IDLE: …`, then the `────`/`❯`/status-line
     footer, so the sentinel is not at the tail). Order action A, mark it
     workflow-complete (accepted), then observe `UserPromptSubmit` (working,
     no Stop). Order action B.
   - Receipt `ready <B>` (the current action, not the accepted one): no
     literal send, deferral `no-idle-sentinel`. This step pins the identity
     rule; it passes both before and after.
   - Receipt `ready <A>` with mtime **before** `lastEventAt`: no send.
   - Receipt `ready <A>` with mtime after `lastEventAt`: exactly one literal
     send, `nudged.details` includes
     `{ lifecycleOverride: "working", overrideProof: "ready-receipt" }`, and
     the receipt file is gone. *This step fails before the change*: today the
     pane reads `vendor-prompt`, not `idle-sentinel`, and the result is
     `no-idle-sentinel`.
   - Next tick: still one send (no duplicate). The lifecycle `working`
     deferral for B is journaled with `gateWaiting: false` and not printed.
     *This step fails before the change*: today it prints "the agent is
     mid-turn".
2. `test/runLoop.test.ts`, existing **"journals each deferred reason once
   across repeated ticks and restarts"**: change the `human` expectation to the
   harness-starting wording, since the fixture has no lifecycle session. This
   fails before the change.
3. `test/action.test.ts`, extend **"renders only the restricted public front
   matter and exact inputs"** and the response-action render case: `raw`
   contains `` `ready <actionId>` `` with the order's actionId and the path
   `readyReceiptPath(order.completePath)`, and still does not contain `nudge`.
   This fails before the change.
4. `test/tmux.test.ts` **"sends a sentinel-required nudge…"**: mechanical
   call-site update to `{ proof: "idle-sentinel", lifecycle: … }`. No
   expectation changes, which shows the sentinel path is untouched.

`agentLanguage`/`check:docs` already cover action and template wording. No new
test file.

## Alternatives Rejected

- **Teach `sentinelAtTail` to skip Claude's and Cursor's footer** (the way
  `codexTail` does for Codex). Claude's footer includes the owner-configurable
  status line, which coord tees but does not control. Cursor's chrome copy
  changes between releases (see the existing "do not match it" comment). A
  whitelist that is wrong fails open into a live turn, and one that is too
  strict leaves the bug in place. A receipt in the mailbox does not depend on
  rendering.
- **Treat the receipt as idle whenever it names any earlier action, or without
  the hook-event check.** If the owner types a new prompt after the agent went
  idle, `UserPromptSubmit` bumps `lastEventAt`, and only the strict ordering
  check stops a send into that turn. Matching `lastAcceptedActionId`
  prevents a leftover receipt from a dropped or reissued action from being
  reused.
- **Let the receipt also authorize re-sends or bypass pane vetoes.** That
  creates duplicates. The owner's design limits it to the next action's nudge
  "after the usual dialog and owner-typing checks".
- **Write `ready` under `agents/<agent>/` beside `action.md`.** That
  directory is coordinator-owned and not granted to harnesses (see
  `paths.ts`'s mailbox rationale). The mailbox directory already is.
- **Silence `foreground-mismatch` at startup entirely.** If the harness
  never starts, the owner would get no stdout signal at all. Accurate wording
  keeps that signal.
- **Rewrite lifecycle `execution` to `idle` from the receipt.** Hook state
  stays hook-owned, as with the sentinel override today. The receipt only
  answers the one delivery question.

## Risks and Mitigations

- **An agent writes `ready` and keeps working, against protocol.** Claude has no
  tool hooks in lifecycle, so `lastEventAt` does not move. Mitigation: every
  pane veto and the per-key `lifecycle-changed` guard still apply. Cursor's
  turn chrome and Codex's `Working` line block. In Claude, typed input
  during a turn is queued or steered, not lost. The receipt is single-use and
  deleted on send.
- **Clock and mtime precision.** Both are local-machine clocks. A tie fails
  closed (strictly earlier `lastEventAt`). Tests set mtime with `utimesSync`
  against the injected `now`.
- **Persisted lifecycle files from older coordinators.** `.default(null)` parses
  them. A null `lastAcceptedActionId` never matches, which keeps today's
  behaviour.
- **Protocol text drift.** The renderer derives the path from
  `readyReceiptPath(order.completePath)`, the same helper `agentRuntimePaths`
  uses. Test 3 pins the rendered text.
- **Hidden reliance on stdout deferral lines after a send.** Only
  `runLoop.test.ts:1658` asserts `gateWaiting`, and it is pre-send. The journal
  keeps every row, and `coord status`/debug read the journal, not stdout.

## Conclusion

The COORD-IDLE line fails for Claude and Cursor because the pane test requires
it to be the last rendered line, and both harnesses draw chrome below it.
Separately, coord prints "mid-turn"/"unknown" deferrals after delivery has
already succeeded. The fix is the owner's design: the agent writes
`ready <actionId>` beside `complete`, coord records the last accepted action in
lifecycle state, and a receipt that names it and is newer than the latest hook
event is accepted as a second proof for the existing never-sent, stale-`working`
override. The receipt is deleted once the send succeeds. Two small message fixes
come with it: post-send deferrals stop printing, and the startup foreground
refusal says the harness is still starting. Changes are confined to `paths.ts`,
`action.ts`, `agentLifecycle.ts`, `tmux.ts`, `runLoop.ts`, the protocol template
and two docs. Every new case goes into an existing test file.
