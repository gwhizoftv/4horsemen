# Issue 181 — Codex idle detection still fails

## Diagnosis

The issue-161 journal (`coord-runtime/issue-161/journal.jsonl`) shows the stall
precisely. Every Codex action after the first follows the same pattern:

- seq 431/432 `action-prepared codex ce2adaf4` → `nudge-deferred codex-turn-chrome`
  (Codex was still painting the end of the previous turn);
- seq 446 `nudge-deferred codex-composer-not-ready`, then **no further Codex
  event for 91 minutes** until the owner typed `continue` (seq 579, 12:41).
- The same pair repeats at seq 588/601 and 681/700.

Codex has no correlated lifecycle hooks (`hooks.execution: "unknown"`), so the
only delivery route is the file-backed override: `RunLoop.deliver`
(`src/runLoop.ts:1188`) finds the ready receipt and passes
`staleOverride.source = "ready-file"`, which makes `TmuxController.nudge`
(`src/tmux.ts:1037-1040`) require `codexSentinelAtTail(paneText, false)`.

The issue screenshot shows the live Codex pane bottom (cropped and read):

```
  COORD-IDLE: waiting for the next coordinator action file

  Worked for 5m 21s • 5:42 AM

› Ask Codex to do anything                          (dim placeholder)

  Context 36% left · weekly 75% left · 258K window · 188K used · … Vim: Insert
  ← for agents · ? for shortcuts                       ⚠ 1 warning · f2 to view
```

Two predicates in `src/tmux.ts` reject this idle pane:

1. **Footer (root cause of the stall).** `CODEX_FOOTER` (`src/tmux.ts:130`) is
   `/^(?:\?\s+for shortcuts|Context \d+% left|\d+% context left)/`. The current
   Codex footer's second line begins `← for agents · ? for shortcuts`, so
   `codexTail` (`src/tmux.ts:179-191`) fails `footer.every(...)` and returns
   null. `codexSentinelAtTail(pane, false)` is then false, and every tick defers
   with `codex-composer-not-ready` (deduplicated in the journal, so it looks
   like coord is "doing nothing").
2. **Turn summary line (sentinel path).** With `requireSentinel = true` (the
   `idle-sentinel` source used for owner reminders and the stale-`working`
   override), `linesAfterCodexSentinel` (`src/tmux.ts:171-175`) returns the
   lines below the sentinel, whose first line is now the dim
   `Worked for 5m 21s • 5:42 AM` turn summary, not `›`. So `codexTail` fails
   `composer[0].startsWith("›")`, and `harnessPromptReadiness` downgrades the
   real sentinel to `vendor-prompt`. An owner reminder then defers with
   `no-idle-sentinel`. `codexNudgeSubmitted` (`src/tmux.ts:210-229`) shares
   `linesAfterCodexSentinel` and fails the same way: it requires
   `transcript[0]` to be the `›` message, so the acceptance proof after `C-j`
   is lost and a redundant fallback `C-m` is sent.

The Antigravity line in the issue (`deferred: working; the agent is mid-turn`,
seq 444) is correct behaviour, not a defect. Antigravity had been nudged at
seq 438 and its hooks reported a live turn (seq 440-441). It finished the
review normally. The whole workflow then waited on Codex's review, which
predicate 1 blocked.

The fix keeps the fail-closed design. It admits exactly the two newly
observed Codex chrome lines and nothing else.

## Exact File List to be changed or deleted

- `src/tmux.ts`
  - `CODEX_FOOTER` (line 130): also accept the footer line that starts with
    Codex's `← for agents ·` prefix before `? for shortcuts`. The pattern stays
    anchored at the start of the trimmed line:
    `/^(?:(?:←\s+for agents\s+·\s+)?\?\s+for shortcuts|Context \d+% left|\d+% context left)/`.
  - Add one anchored constant beside it for Codex's end-of-turn summary, e.g.
    `CODEX_TURN_SUMMARY = /^[─\s]*Worked for \d+[hms](?:\s*\d+[hms])*(?:\s*•\s*\d{1,2}:\d{2}(?:\s*[AP]M)?)?[─\s]*$/`.
    It matches the line Codex paints only after a turn ends (`Worked for 5m 21s • 5:42 AM`,
    and the older rule form `─ Worked for 12s ─────`). It does not match
    `Working (…)` turn chrome or a bulleted or quoted prose mention.
  - `linesAfterCodexSentinel` (lines 171-175): when the first non-blank line
    after the last sentinel matches `CODEX_TURN_SUMMARY`, drop that single
    line. `codexTail(…, true)` and `codexNudgeSubmitted(…, true)` both
    consume this helper, so both are fixed without other changes. Only one
    leading summary line is skipped. Any other line still fails closed.
  - Update the doc comment above `linesAfterCodexSentinel` to name the
    admitted turn-summary line.
- `test/tmux.test.ts` — fixtures and assertions; see Tests.
- `docs/readiness-policy.md` (lines 92-96): change the Codex paragraph's footer
  list to `? for shortcuts` / `← for agents · ? for shortcuts` /
  `Context N% left`. Also state that one `Worked for …` turn-summary line may
  sit between the sentinel and the composer. The documented policy then
  matches the predicate.

No other file changes. `src/runLoop.ts` override selection, deferral codes and
messages, the `PromptBlockedReason` union, and the protocol templates stay
unchanged.

## Exact file list to be created

None. `.plans/issue-181/plan.md` is this coordination artifact, not product
work. No new source, test, or fixture file is needed: the fix is two pattern
constants and one helper in `src/tmux.ts`, and the cases join the existing
Codex block in `test/tmux.test.ts`.

## Reuse and Scope

Reused unchanged:

- `paneLines`, `codexTail`, `codexSentinelAtTail`, `codexComposerHolds`,
  `codexComposerEmpty`, `codexNudgeSubmitted`, `codexVimNormal`,
  `codexTurnChrome` (`src/tmux.ts`). Only the two inputs they share change:
  the `CODEX_FOOTER` constant and the `linesAfterCodexSentinel` helper.
- `harnessPromptReadiness` and `TmuxController.nudge` keep their order of
  blocking checks. The `codex-turn-chrome` veto still runs before any
  sentinel or composer proof.
- `RunLoop.deliver` / `readyForNextAction` (`src/runLoop.ts`): unchanged. The
  receipt logic was correct; only the pane predicate was too strict.
- Test fixtures in `test/tmux.test.ts`: `esc`, `codexComposer`,
  `codexFooter`, `codexPane`, the `attempt` mini-Codex harness in the
  `it.each(["idle-sentinel", "ready-file"])` nudge test, `ok`, and
  `noopSleep`.

Scope: Codex pane-readiness predicates only. Codex hook correlation
(`COORD_ISSUE` on Codex Stop, issue 176) is out of scope. This fix is what
makes the existing file-backed path work while hooks stay unknown.

## Tests

All cases join the existing Codex block in `test/tmux.test.ts` (around lines
752-860). No new test file.

1. **Make the shared fixture match the live capture.** Change `codexFooter`'s
   second line to `  ← for agents · ? for shortcuts …⚠ 1 warning · f2 to view`
   and update the fixture comment to cite the issue-181 capture. This
   immediately makes the existing
   `it.each(["idle-sentinel","ready-file"])("sends a %s nudge only while the idle proof holds at each key")`
   cases reproduce the bug. Before the fix, `attempt()` for both sources returns
   `busy` (`codex-composer-not-ready` / `no-idle-sentinel`) instead of
   `sent`. After the fix, every existing expectation passes again, including
   the owner-draft, mid-send-edit and lifecycle-changed refusals. That shows
   the fail-closed checks still hold with the new footer.
2. **Turn summary between sentinel and composer.** In the same `it.each`,
   change the default `idle-sentinel` body to
   `` `• ${COORD_IDLE_SENTINEL}\n\n  Worked for 5m 21s • 5:42 AM` ``. The
   existing `submitOnCtrlJ` case then also covers `codexNudgeSubmitted`
   recognising acceptance through the summary line (`keys: ["-l", "C-j"]`, no
   fallback `C-m`). This fails before the fix and passes after.
3. **Readiness assertions** in the existing
   `"vetoes a live Codex turn and reads its idle sentinel only above an empty composer"` test:
   - `` codexPane(`• ${COORD_IDLE_SENTINEL}\n\n  Worked for 5m 21s • 5:42 AM`) `` → `{ ready: true, reason: "idle-sentinel" }` (fails before: `vendor-prompt`).
   - The same pane built with the legacy footer `  ? for shortcuts …` still
     returns `idle-sentinel`, so older Codex builds keep working.
   - Fail-closed guards, all expected `vendor-prompt`: a summary line *above*
     the sentinel does not count, and two different lines after the sentinel
     (summary + `  2. No, continue without the server`) do not count. A prose
     bullet `• I printed Worked for 5m earlier` after the sentinel does not
     count either.
   - The turn-chrome veto still wins:
     `` codexPane(`• ${COORD_IDLE_SENTINEL}\n\n  Worked for 3s\n• Working (1s • esc to interrupt)`) `` → `codex-turn-chrome`.

Commands I will run while developing:
`pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts`,
`pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts` (its
Codex fixture at line 2199 uses the legacy `? for shortcuts` footer and must
stay green), then `pnpm lint` and `pnpm typecheck`. The pre-commit hook owns
`pnpm check:fast`. Full `pnpm check` (build + check:fast + e2e) is the
coordinator's final check at the approved pin.

## Alternatives Rejected

- **Drop footer matching and accept any lines below the composer.** This loses
  the fail-closed property the readiness policy documents. A Codex dialog or
  approval prompt rendered under the composer would read as idle, and coord
  would type into it.
- **Match `for shortcuts` anywhere on the line.** That is simpler, but it
  stops anchoring the footer. Any transcript or dialog line that mentions
  shortcuts would then be accepted as chrome. The anchored optional
  `← for agents ·` prefix admits exactly the observed form.
- **Skip every line between the sentinel and the composer.** That would let
  an approval dialog or a new transcript item through. Skipping only one line
  that matches the anchored turn-summary pattern keeps every other line fail-closed.
- **Let Codex bypass the composer check when a ready file exists** (that is,
  trust the receipt alone). The composer proof exists so a nudge is never
  appended to an unsent owner draft (issue 161's fix). Removing it would bring
  back that hazard.
- **Fix it in `runLoop.ts`** (e.g. fall back to `vendor-prompt` delivery after N
  deferrals). That masks a wrong predicate with a timeout, still risks typing
  into a draft, and changes the lifecycle policy for every vendor.
- **Add a new deferral code or an owner-facing warning.** That is not needed
  to fix the stall and widens scope. The existing
  `codex-composer-not-ready` message stays accurate for real drafts.

## Risks and Mitigations

- **Codex changes its footer or summary copy again.** The predicate stays
  fail-closed, so the failure mode is a stall, not a mis-typed nudge. The
  fixture now mirrors a dated live capture, and the docs list the accepted
  lines, so the next drift is a one-line regex change with a matching fixture
  update.
- **The turn-summary pattern matches prose.** It is anchored to the whole
  trimmed line, allows only rule characters and whitespace around it, and
  requires a bare duration with an optional clock time. A bulleted
  (`• … Worked for …`) or quoted line, or one with any trailing text, does not
  match. Test 3 covers the prose case.
- **A summary line hides a live turn.** `codexTurnChrome` runs first in
  `harnessPromptReadiness` and at every key in `nudge`. Test 3 covers a
  `Working (…)` line after a summary.
- **The legacy footer regresses.** The optional prefix keeps the original
  `? for shortcuts` match. Test 3's legacy-footer assertion and the
  untouched `runLoop.test.ts:2199` fixture cover it.
- **Concurrent peer vitest runs time out in the pre-commit `check:fast`.**
  Wait for the peers' suites to finish and retry. This is not a reason to
  skip the hook.

## Conclusion

The Codex stall in issue 161/181 comes from a fail-closed pane predicate that
no longer recognises the current Codex chrome. The new
`← for agents · ? for shortcuts` footer line rejects every file-backed
delivery (`codex-composer-not-ready`), and the `Worked for … • time`
turn-summary line hides a real `COORD-IDLE` sentinel from owner reminders and
from the post-submit acceptance proof. The fix touches `src/tmux.ts` only:
widen `CODEX_FOOTER` by one anchored optional prefix, and let
`linesAfterCodexSentinel` skip a single anchored turn-summary line. It updates
the matching fixture and cases in `test/tmux.test.ts` and the policy text in
`docs/readiness-policy.md`. Every other veto, the override selection in
`runLoop.ts`, and the deferral codes stay unchanged.
