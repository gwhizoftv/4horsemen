# Implementation Plan — Issue 181: Fix Idle Detection Failures for Codex and Antigravity

## Exact File List to be changed or deleted

- `src/tmux.ts`
- `src/agentEvent.ts`
- `src/runLoop.ts`
- `test/tmux.test.ts`
- `test/agentEvent.test.ts`
- `test/runLoop.test.ts`

## Exact file list to be created

None. All modifications update existing implementation and test files.

## Reuse and Scope

The implementation reuses existing functions, structures, and tests without introducing new abstractions, dependencies, or files:
- In `src/tmux.ts`: reuses `stripAnsi`, `paneLines`, `codexComposerEmpty`, `codexTail`, `codexSentinelAtTail`, `linesAfterCodexSentinel`, `harnessPromptReadiness`, and `codexNudgeSubmitted`.
- In `src/agentEvent.ts`: reuses `normalizeAgentEvent`, `boolField`, and existing event normalization structures.
- In `src/runLoop.ts`: reuses `maybeLifecycleNudge`, `journalDeferral`, `decideLifecycleNudge`, and `readAgentLifecycle`.
- In `test/tmux.test.ts`: reuses `codexPane`, `codexComposer`, and `codexFooter` test fixtures.
- In `test/agentEvent.test.ts`: reuses the Antigravity lifecycle normalization test cases.
- In `test/runLoop.test.ts`: reuses `safetyFixture`, `makeLoop`, and existing run loop test helpers.

Scope is strictly limited to fixing the three root causes identified in Issue #181:
1. Codex live footer parsing failure (`CODEX_FOOTER` regex failing to match `← for agents · ? for shortcuts`).
2. Codex completion summary line (`Worked for ...`) breaking idle sentinel detection.
3. Antigravity `Stop` event normalization defaulting `fullyIdle` to `false` when omitted, causing false `backgroundActive: true` and `queued` execution state.
4. False `nudge-deferred` logging and "waiting to send" console messages for already-injected in-flight actions.

## Tests

The following focused test cases will be added to existing test files:

1. In `test/tmux.test.ts` joining `it("vetoes a live Codex turn and reads its idle sentinel only above an empty composer")`:
   - Verify that a Codex footer containing `← for agents · ? for shortcuts ⚠ 1 warning · f2 to view` alongside a context usage line is recognized as a valid footer, allowing `codexSentinelAtTail` and `harnessPromptReadiness` to succeed (fails before fix, passes after).
   - Verify that pane text where `• COORD-IDLE: waiting for the next coordinator action file` is followed by `Worked for 6m 15s • 4:10 AM` and an empty composer `›` is recognized with `reason: "idle-sentinel"` (fails before fix returning `reason: "vendor-prompt"` or `codex-composer-not-ready`, passes after).
   - In `it.each(["idle-sentinel", "ready-file"])`: verify that `ready-file` nudge delivery succeeds for Codex when the pane exhibits the updated footer and empty composer (fails before fix with `codex-composer-not-ready`, passes after).

2. In `test/agentEvent.test.ts` joining `it("uses Antigravity queue, task, agent-state, and fullyIdle signals")`:
   - Verify that `normalizeAgentEvent("antigravity", { conversationId: "agy-1" }, "Stop")` without an explicit `fullyIdle` field returns `{ kind: "stopped", backgroundActive: false, allowInjectedIdle: true }` (fails before fix returning `backgroundActive: true`, passes after).

3. In `test/runLoop.test.ts` joining `describe("effectful run loop")`:
   - Verify that once an action is injected (`delivery !== "ordered"` and `sends > 0`), subsequent run loop ticks with the agent in `working` execution state do not record a `nudge-deferred` event in the journal or log a "waiting to send" message to stdout.

## Alternatives Rejected

1. **Unconditionally skipping all lines between sentinel and composer**: Rejected because unhandled interactive dialogs or unexpected harness output must fail closed. Only the recognized completion summary line (`/^Worked for\s+/`) should be permitted.
2. **Relaxing the empty composer check for Codex**: Rejected because typing into a composer with an unsent owner draft would corrupt the turn or submit unintended text.
3. **Suppressing all `maybeLifecycleNudge` ticks when `status === "ordered"`**: Rejected because lost-delivery detection and reissues must continue to check whether an injected action needs recovery. Only the false deferral journaling of healthy in-flight work should be suppressed.
4. **Altering agy CLI instead of the coordinator**: Rejected because coordination must reliably support installed CLI versions without requiring external tooling updates.

## Risks and Mitigations

1. **Risk:** Relaxing `CODEX_FOOTER` regex could match non-footer lines.
   - **Mitigation:** The regex strictly anchors to specific prefixes (`← for agents`, `? for shortcuts`, `Context \d+% left`, `\d+% context left`).
2. **Risk:** Permitting `Worked for ...` lines could mask in-flight work.
   - **Mitigation:** Active turns are identified by `Working (… esc to interrupt)` via `codexTurnChrome`, which always vetoes delivery before checking idleness. `Worked for ...` is purely a post-completion summary.
3. **Risk:** Changing `fullyIdle` default might overlook background tasks.
   - **Mitigation:** Payloads explicitly setting `fullyIdle: false`, or telemetry reporting pending tasks (`task_count > 0` or `tool_confirmation_pending: true`), still correctly set `backgroundActive: true`.

## Conclusion

This plan addresses all specific failure modes reported in Issue #181: updating Codex footer and turn-summary parsing so idle sentinels and ready files are recognized, fixing the Antigravity `Stop` normalization default so background work is not falsely inferred, and stopping spurious deferral logging for actions that have already been injected. The changes are minimal, targeted, and fully covered by focused regression tests.
