# Issue 195 — operator nudge is not gated on readiness or spacing

## Exact File List to be changed or deleted

- `src/runLoop.ts` — `CoordinatorRunLoop.reminders`, `deliver`, and the owner-reminder branch of `runTick`
- `src/tmux.ts` — `IdleOverride` and `TmuxController.nudge`
- `src/interactive.ts` — `n` help text
- `src/cli.ts` — foreground-control help text that says reminders keep readiness checks and send limits
- `docs/coord-driver.md` — `n` key contract and the delivery-budget paragraph that currently includes owner reminders in the 60/120/240s spacing
- `docs/readiness-policy.md` — owner-reminder exception to lifecycle and scrape gates
- `test/runLoop.test.ts` — owner-reminder cases in `describe("owner reminders and advisory diagnostics")` and the Codex owner-reminder assertion in the stale-working test
- `test/tmux.test.ts` — owner-override nudge cases next to the existing prompt-refusal tests

## Exact file list to be created

None. The menu, delivery, and pane gate already exist; this issue changes who may be selected and which of those gates an explicit owner request skips.

## Reuse and Scope

Journal of issue 177 at `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-177/journal.jsonl`, action `9f6923bb-5537-40e3-9a52-aa6f92ded7d2`:

- `2026-10-11T00:28:18.076Z` `nudged` readiness `stop-hook`, then `00:28:19.628Z` `nudge-deferred` code `idle-transition-already-used`.
- Each of the next three sends (`00:29:19.673Z`, `00:31:20.302Z`, `00:35:21.813Z`, all readiness `vendor-prompt`) was followed by `agent-lifecycle` event `prompt-ready-action-absent` while `execution` stayed `idle`. Spacing between them is `NUDGE_REPEAT_DELAYS_MS` (`60_000`, `120_000`, `240_000`) in `deliver`.
- `2026-10-11T00:36:06.447Z` hold `01edf7dd-e0b8-46d0-88b4-963dc4751100` reason `nudge-loop` (`sends >= 4`). Released `2026-10-11T16:12:03.734Z` with `resetNudgeBudget: true`. That is the overnight stall: a whole-issue hold, not a failure to notice the pane. Status text "task file published; not yet sent; idle; activity reports unknown" is `issueReport.ts` for delivery `ordered`, execution `idle`, health `unknown`, which is what `markInjectedActionAbsent` plus `markActionInjected` leave behind.
- After release, automatic `nudged` at `16:12:06.114Z`, then `prompt-ready-action-absent` at `16:12:50.906Z` (still idle), then another automatic `nudged` at `16:13:07.161Z`. An owner `n` in the 60s after `16:12:06` hits the silent spacing return in `deliver` (`lastSendAt` newer than `NUDGE_REPEAT_DELAYS_MS[sends - 1]`). `runTick` then prints one sentence for every non-increase: "reminder deferred by readiness, send spacing or a hold". The journal has no owner-specific reason because that return does not journal a code.
- `2026-10-11T16:13:28.413Z` code `working` is a later automatic `maybeLifecycleNudge` deferral, not the owner refusal. `2026-10-11T16:20:03.561Z` code `idle-transition-already-used` is one second after the `16:20:02.415Z` stop-hook send of `ff2e6ee7`; `journalDeferral` prints each code once, so the line stays on screen after the send has already happened.

Reuse `deliver` for the actual paste. Reuse `deferralRationale` for the single refusal sentence. Reuse `TmuxController.nudge` and `injectionGate`. Reuse `reminders()` as the menu source `startInteractiveSession` already calls. Reuse `safetyFixture` and the existing `TmuxController` nudge tests. Do not add a delivery mode, a new journal type, or a new command.

Operator `n` contract:

- `reminders()` lists every agent in `readStartState().agents` that is not in `droppedAgents`, whether or not `status === "ordered"`. Issue 187: the menu is no longer the algorithm's remindable subset. An agent with no action file is still listed; `request()` does not throw for that, and the tick logs that there is no current task. `All agents` uses this same list. Dropped agents stay off the menu.
- `request()` still rejects `manualPaused`, `completed`, `abandoned`, a replaced `actionId`, and an agent that has since been dropped. A nudge-loop or other hold does not reject it and does not require `r` first.
- On a hold-only pause, `runTick` delivers queued owner reminders before the existing pause return. It does not release the hold, reset `sends`, or run automatic nudges, acceptance, or publication on that tick. `manualPaused` still cancels the request with the existing pause sentence and returns after resource observation.
- `deliver(..., "owner")` skips: `NUDGE_REPEAT_DELAYS_MS`, `sends >= 4` / `nudge-loop`, execution `working` / `queued` / `unknown` / `idle-transition-already-used`, pending input, background work, and the hook-sequence / session-id equality check in `runTick`. It still charges `sends` and `lastSendAt` on a send that begins, and it still holds `delivery-uncertain` when `reserved` is already set or a send becomes ambiguous after the first key.
- The tick no longer drops an owner request because `hookReceipt.sequence` or `sessionId` changed. It still requires the captured `actionId` and action-file digest, a nudge/`both` delivery config, and `workflowCompleteAt === null`.
- Add `source: "owner"` to `IdleOverride`. For that source, `nudge` still refuses `injectionGate` failures (`pane-dead`, `owner-typing`, `input-off`, `foreground-mismatch`) and the keystroke-loss prompt reasons `trust-dialog`, `claude-usage-wait`, and `antigravity-verify-overlay`. It does not refuse turn chrome, missing sentinel, missing vendor prompt, `no-idle-sentinel`, or a lifecycle hook that arrives before the batch. Codex keeps the empty-composer refusal (`codex-composer-not-ready`) so a nudge cannot submit the owner's unsent draft. An action-file digest change during the send still aborts through the existing `assertAuthority` conflict. A completion file that appears before any key cancels the send with `workflow-complete` and does not charge a send.
- Every owner refusal logs one sentence, including when that code was already journaled for the automatic path: `[WAIT] ${agent}: reminder not sent; ${deferralRationale(code)} (${code}).` Delete the combined "readiness, send spacing or a hold" sentence. The request acknowledgement no longer says the coordinator will check readiness.
- Automatic `maybeLifecycleNudge`, lost-delivery proof, spacing, and the four-send hold stay as they are. This issue does not treat a fresh `COORD-IDLE` line as a new idle epoch.

## Tests

Focused command the implementation runs while developing:

`pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/tmux.test.ts test/interactive.test.ts`

The pre-commit hook owns `pnpm check:fast` for this product change. Do not claim that suite from the plan commit.

Extend `test/runLoop.test.ts` (do not add a test file):

- In "reminds the same accepted task only on explicit request and fresh idle proof, retaining spacing and budget": an owner request inside the spacing window sends. Automatic ticks with no new request still do not send. Owner requests do not create a `nudge-loop` hold at four sends. A later automatic-only sequence still holds at four sends. Two `request()` calls before one tick still queue once.
- Split "refuses a queued reminder on %s": `no-idle`, `queued`, `background`, `session`, and `new-hook` send. `digest`, `pause`, `foreground`, `typing`, and `missing-capture` still do not send and do not increase `sends`. Each refusal message contains the one code and does not contain "readiness, send spacing or a hold".
- Add a case on `safetyFixture`: with a `nudge-loop` hold already pausing the issue, `request()` does not throw, the next tick sends once, the hold id remains, and `manualPaused` stays false.
- Add a case: an agent whose cursor `status` is `verifying` is listed by `reminders()` and can be sent its current action file. An agent in `droppedAgents` is absent.
- Keep the Codex stale-working test's owner assertion that a non-empty composer does not send and an empty composer does (`owner: true` on the nudged journal event).

Extend `test/tmux.test.ts`:

- `TmuxController.nudge` with `IdleOverride.source === "owner"` sends when the Cursor pane shows `esc to cancel` / in-flight chrome and when the idle sentinel is absent. The same override still returns `trust-dialog` without `reserveSend`, and a Codex pane with an undimmed composer draft still returns `codex-composer-not-ready`.

`test/interactive.test.ts` stays behaviorally the same: it renders whatever `reminders()` returns. Update only if the help-text assertion is added; the existing captured-request tests already pass labels through.

## Alternatives Rejected

- Removing automatic spacing and the four-send hold. The journal's four `prompt-ready-action-absent` retries are what created hold `01edf7dd`; without the budget the coordinator would keep typing into an idle Cursor pane that never retains the action. The operator path is the escape, not an unlimited automatic loop.
- Treating `COORD-IDLE` as a new `idleEpoch`. The `16:20:03` line is the duplicate guard one second after a real stop-hook send. A new epoch there would paste the same action again immediately.
- Keeping the three-cause sentence and documenting that "send spacing" means 60/120/240 seconds. The owner cannot tell which clause fired, and spacing is the wrong gate for an explicit request after a send that `prompt-ready-action-absent` already disproved.
- Letting an owner nudge ignore a trust dialog, a usage wait, a verify overlay, a dead or wrong-foreground pane, copy-mode, or a non-empty Codex composer. Those drop or corrupt keystrokes; they are not the idle-detection bug.

## Risks and Mitigations

- An owner nudge can interrupt a live turn or duplicate a prompt the agent already has. Mitigation: it is an explicit `n` selection, one queued request per agent, still bound to the captured action digest, and automatic delivery is unchanged. The success log remains `[OK] Reminder sent to ${agent} for its current task.`
- Sending during a nudge-loop hold does not accept a completion until `r` releases the hold. Mitigation: the tick logs that the hold remains. Do not clear `paused` as a side effect of `n`.
- Owner sends still increment `sends`. After the hold is reset, automatic spacing applies from that `lastSendAt`. Mitigation: cover this in the updated budget test so a following automatic tick inside 60s does not send.
- A refusal that used to be silent (spacing, queued, background, pending input) must now carry a code on the owner path only. Automatic `journalDeferral` stays once-per-code. If those owner returns stay silent, the bug in the issue remains.

## Conclusion

Cursor looked idle because it was idle. After four lost deliveries, issue 177 sat on nudge-loop hold `01edf7dd` from `2026-10-11T00:36:06.447Z` until the owner released it at `16:12:03.734Z`. The following `n` was then refused by the 60-second spacing return in `deliver`, and `runTick` reported that as readiness, spacing, or a hold. The later "working" and "waiting for fresh activity" lines are separate once-per-code automatic deferrals, not that refusal.

Issue 195 makes `n` list every non-dropped agent and send the current task immediately, including during a hold and including when lifecycle or scrape readiness would block an automatic nudge. Spacing, the four-send budget, and idle-epoch duplicate protection stay on the automatic path. A refusal names the one code that fired.
