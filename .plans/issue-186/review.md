# Issue 186 plan review

Pins reviewed (bound inputs only):

- cursor `d076173d30216e31583862e01bd12f5478c8ce44`
- claude `25daecbd4dae7694a80e30b3b7c285b11e40ee8d`
- codex `9a7921a29926ccade26cd73512bfd3f35ef316fa`

## Findings

1. **Cursor plan — Goal / Exact File List (omits owner item 3).** The plan
   claims to fix unsubmitted composers and `delivery-uncertain` holds via submit
   keys and broader chrome recognition, and its file map never touches launchers,
   lifecycle routing, or containment diagnostics. The issue (as of the owner's
   mid-session edit) also requires fixing Codex guard/probe context that names
   issue 139 and fails with `session or installed policy unknown`. Peer plans
   cite live evidence that Codex hooks still run with `COORD_ISSUE=139` while the
   issue-186 pane is 186, so lifecycle never accepts on 186. If this plan is
   followed as written, item 3 stays broken and `delivery-uncertain` can continue
   whenever nudges land on a busy Codex whose Working line is briefly absent.
   Smallest correction: adopt an issue-scoped Codex launch fix (Claude's
   `--no-daemon` or Codex's verified launch binding) plus probe diagnostics in
   the file map, or explicitly reject item 3 with owner authority (not present
   on this pin).

2. **Cursor plan — Exact File List (`src/tmux.ts` “broaden Codex live-turn /
   submitted-nudge recognition”).** That wording targets the same live-turn
   concept today implemented by `codexTurnChrome`, which also vetoes *pre-send*
   readiness. The Alternatives section correctly forbids treating scrollback
   `• Opened` / browsing lines as a pre-send veto. The rule that must hold: idle
   panes with historical tool lines in the 40-line capture must still be
   nudgeable. If the implementer widens the shared `codexTurnChrome` helper, an
   idle Codex whose scrollback still shows `Browsing the web` / `• Opened …`
   refuses forever (`codex-turn-chrome`) even with an empty composer. Smallest
   correction: widen only the *post-submit* acceptance predicate used by
   `codexNudgeSubmitted` (or a sibling), leave pre-send `codexTurnChrome`
   unchanged.

3. **Cursor plan — setupWorkspace / submit sequence `Escape` then `Enter`.** The
   plan sends Escape+Enter whenever the composer still holds the nudge after
   `C-j`/`C-m`, while also admitting submission proof may stay “too narrow.”
   Rule: fallback keys must not be typed into a turn that already accepted the
   nudge. If `C-j` already submitted under unrecognized chrome and the composer
   paint still shows the draft for one capture, Escape interrupts or corrupts
   that turn and can still charge mid-send uncertainty. Smallest correction:
   prove acceptance (lifecycle or submitted-message + empty composer) before any
   Escape; prefer bounded `C-m` re-press only while `codexComposerHolds` (Claude)
   over Escape into a possibly live TUI.

4. **Claude plan — Defect C / Tests (outcome stays `sent` after exhausted
   retries).** The plan keeps today's outcome contract: after bounded extra `C-m`
   presses, the nudge still returns `sent` / `complete` even when the test case
   asserts the composer never cleared. Rule: a tmux write is not proof of TUI
   submission; `deliver` must not mark injected when the composer still holds
   the exact nudge. If followed as written, a stuck composer is recorded as a
   successful send, no `delivery-uncertain` hold appears, and the action sits
   unsubmitted exactly as in the issue screenshot. Smallest correction: after
   retries, if `codexComposerHolds` is still true, return busy mid-send (retain
   existing uncertain hold); only return `sent` when the composer is cleared or
   acceptance is proved.

5. **Claude plan — Defect C step (b) on the ordinary path.** Extra `C-m`
   presses go through `send()` without the override-only `codexNudgeSubmitted` /
   lifecycle `accepted` early-exit. Rule: do not send further submit keys into a
   turn that already started on this nudge. If `C-j` submits and the composer
   paint lags while still showing the nudge text, the ordinary-path retry types
   `C-m` into the live turn. Smallest correction: before each confirmation
   re-press on every Codex path, stop on acceptance / submitted-message proof
   (Codex plan's ordinary-path observation), not only when `IdleOverride` is set.

6. **Codex plan — Reuse and Scope (“Send the conventional `i` prelude only with
   positive current vim NORMAL evidence”).** Rule: when the footer cannot be
   parsed, the first character of the nudge must not be consumed as a vim
   command. Claude's rejected alternative states the failure mode: unreadable
   footer + actual NORMAL means the leading `R` of `Read and execute…` enters
   Replace mode and garbles the text. If this plan is followed, panes without a
   readable `Vim:` footer lose the fail-safe `i` that today's defaults and
   Claude's plan keep. Smallest correction: skip `i` only on positive
   `Vim: Insert` evidence; keep sending `i` when the Codex footer is unreadable.

7. **Codex plan — Exact File List / Reuse (`C-m` only; normalize `["C-j","C-m"]`
   → `C-m`).** Rule: the default sequence must submit from Codex vim INSERT (the
   usual footer). Current defaults and Claude's live diagnosis treat `C-j` as the
   INSERT submit with `C-m` as fallback; OpenAI keymap docs do not prove this
   install drops Ctrl-J. If followed as written, INSERT panes that ignore bare
   `C-m` keep the unsubmitted-composer symptom. Smallest correction: keep
   `C-j` then `C-m` (optionally with one bounded confirmation `C-m`), and do not
   strip `C-j` from legacy configs until a live INSERT probe shows `C-m` alone
   submits.

## Conclusion

Prefer Claude's diagnosis and file map for issue-scoped launch (`--no-daemon`)
and INSERT-aware prelude skipping, but only after correcting findings 4 and 5 so
confirmation cannot report `sent` while the composer still holds the nudge and
cannot re-key into an already-started turn on the ordinary path. Reject Cursor's
pin as incomplete for owner item 3 and as too willing to send Escape into a live
Codex. Reject Codex's `C-m`-only default and “`i` only on positive NORMAL” rules
for the concrete INSERT/unreadable-footer failures above; keep Codex's stronger
ideas of ordinary-path acceptance observation, mid-send uncertainty when
confirmation fails, and clearer containment-probe mismatch diagnostics—merged
into Claude's smaller launcher+tmux shape rather than the full eleven-file map
unless an amendment proves the snapshot/`COORD_ISSUE` bind is required instead
of `--no-daemon`.

No product tests were run for this evidence-only review.
