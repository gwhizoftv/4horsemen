# Issue 186: Codex nudge must submit reliably and stop false delivery-uncertain holds

## Goal

Codex nudges sometimes leave the action text sitting in the `›` composer
(unsubmitted), and the owner UI often shows a `delivery-uncertain` hold on each
new turn. Fix both with the smallest change that makes submit conclude and makes
a successful first submit key end the send instead of charging a mid-send hold.

Observed failure modes on current code:

1. **Unsubmitted composer** — after `send-keys -l`, Codex defaults send `C-j`
   then `C-m`. When neither submits, the nudge remains in `›` (issue body).
2. **False mid-send hold** — under a ready-file / idle-sentinel override, after
   the first submit key the send requires either lifecycle `accepted` or
   `codexNudgeSubmitted`. That helper only treats `Working (… esc to interrupt)`
   as live turn chrome. When Codex starts the turn under tool chrome such as
   `Browsing the web` / `• Opened …` with an empty composer, recognition fails,
   the composer no longer holds the nudge, remaining keys are skipped, and
   `runLoop.deliver` records `delivery-uncertain` even though the nudge was
   submitted.

- The action digest matches and the branch is issue-186/codex. The containment
  probe was blocked by the hook, but its message referenced issue 139; recording
  the observation failed with “session or installed policy unknown.” Containment
  remains unverified. I’ll continue with the readiness artifact as instructed.

## Exact File List to be changed or deleted

- `src/tmux.ts` — broaden Codex live-turn / submitted-nudge recognition beyond
  bare `Working (… esc to interrupt)`; after the first Codex submit key on every
  send path (not only `IdleOverride`), stop as `sent` when submission is proved,
  continue remaining submit keys while the composer still holds exactly this
  nudge, and only return busy mid-send when the composer is cleared without
  proof; extend Codex default submit via `resolveNudgeKeys` upgrade of stale
  `["C-j", "C-m"]` to the new default sequence
- `src/setupWorkspace.ts` — Codex `agentOwnerUiDefaults().nudgeSubmit` becomes
  `["C-j", "C-m", "Escape", "Enter"]` so INSERT gets ctrl-submit first and, if
  the composer still holds the nudge, Escape then Enter leaves INSERT and
  submits
- `config.example.json` — match the Codex `nudgeSubmit` default
- `docs/coord-driver.md` — document the Codex submit sequence and early-exit
- `docs/readiness-policy.md` — document broadened submission proof (tool/turn
  chrome with empty composer) and that post-submit-key acceptance applies on
  every Codex send path
- `test/tmux.test.ts` — fixtures/assertions for tool-chrome acceptance, fallback
  Escape+Enter when `C-j`/`C-m` leave the composer holding the nudge, and stale
  `["C-j","C-m"]` upgrade

## Exact file list to be created

- `.plans/issue-186/plan.md` — this plan

## Reuse and Scope

Reuse existing helpers and call sites; no new modules or dependencies.

- `codexTurnChrome`, `codexNudgeSubmitted`, `codexComposerHolds`,
  `codexSentinelAtTail`, `codexVimNormal`, `resolveNudgeKeys`,
  `TmuxController.nudge`, `NUDGE_AFTER_TEXT_MS`, `NUDGE_BETWEEN_SUBMIT_MS` in
  `src/tmux.ts`
- `agentOwnerUiDefaults` in `src/setupWorkspace.ts`
- Mid-send → `delivery-uncertain` hold path already in `src/runLoop.ts`
  (`deliver`); do not change hold semantics when the send is genuinely
  ambiguous
- Extend `codexPane` / override send cases in `test/tmux.test.ts` rather than
  adding a new test file

Out of scope: owner `continue` / manual paste as the fix; changing Claude /
Cursor / Antigravity key sequences; relaxing pre-send vetoes for a non-empty
owner draft or unrelated turn with the nudge still in the composer; fabricating
Codex Stop hooks; lost-delivery retry policy; interactive CLI copy.

## Tests

Fewest focused cases that fail on current main and pass after the change (join
existing `test/tmux.test.ts`; hook still owns `pnpm check:fast` on product
commits):

1. Override send: after `C-j`, pane shows the nudge as the submitted `›`
   transcript message, empty composer, and tool/turn chrome such as
   `Browsing the web` / `• Opened …` (no `Working (… esc to interrupt)`) →
   outcome `sent`, keys stop at `C-j` (no fallback `C-m` into the turn).
2. Override send: `C-j` and `C-m` leave the composer still holding exactly the
   nudge → continue with `Escape` then `Enter` and end `sent` when that submits
   (or when acceptance appears); do not abort mid-send solely because the first
   ctrl key failed to submit.
3. Override send: after `C-j`, composer cleared but message/chrome do not prove
   this nudge was submitted, and lifecycle is not `accepted` → still busy
   mid-send (genuine ambiguity / hold unchanged).
4. `resolveNudgeKeys` for Codex with configured `nudgeSubmit: ["C-j", "C-m"]`
   upgrades to the new default; an explicit longer or different override is
   honored.
5. Non-override Codex send also early-exits when `codexNudgeSubmitted` becomes
   true after the first submit key (do not type remaining keys into the turn).

While developing, run the focused `test/tmux.test.ts` cases above. Do not claim
coordinator-owned pin checks.

## Alternatives Rejected

- **Only document “press Enter” / owner `continue`** — the coordinator already
  owns nudge delivery; the issue is automatic CR and false holds.
- **Replace Codex submit with bare `Enter` only** — in vim INSERT, Enter is a
  newline; that worsens the sitting-composer case.
- **Replace with Escape+Enter only (drop C-j/C-m)** — throws away the ctrl
  sequence that already works on many panes; keep it first, add Escape+Enter as
  fallback when the composer still holds the nudge.
- **Treat any empty composer after a submit key as success** — too open: an
  owner clear or unrelated UI change would look like delivery and skip
  fallbacks or clear the charge incorrectly.
- **Widen `codexTurnChrome` pre-send veto to all `• Opened` / browsing lines** —
  those lines can remain in the scrollback above an idle composer; submission
  proof must require the submitted `›` message match plus empty composer plus
  live chrome, not a pre-send veto on historical tool lines.
- **Clear `delivery-uncertain` automatically without proof** — unsafe duplicate
  risk; fix recognition and submit completion instead.

## Risks and Mitigations

- **Extra Escape+Enter into a live turn** if submission proof is still too
  narrow — mitigate by implementing broadened `codexNudgeSubmitted` in the same
  change and early-exiting before fallbacks whenever proof or lifecycle
  `accepted` holds; test tool-chrome acceptance without sending `C-m`.
- **Escape dismisses something other than INSERT** on a future Codex build —
  fallbacks run only while the composer still holds exactly this nudge; if
  Escape clears the composer without starting a turn, existing mid-send
  uncertain hold still protects against blind retries.
- **Stale runtime `config.json` keeps old two-key submit** — upgrade exact
  `["C-j","C-m"]` in `resolveNudgeKeys` (same pattern as Claude/Antigravity
  stale submit upgrades); operators with intentional custom lists are unchanged.
- **False busy if tool chrome is mis-detected while a draft remains** — keep the
  rule that an unrelated turn with the nudge still in the composer is not
  acceptance; only empty composer + matching submitted message + live chrome
  (or lifecycle accepted) ends the send.

## Conclusion

Extend Codex submit to `C-j`, `C-m`, then Escape+Enter while the composer still
holds the nudge; recognize tool/turn chrome as proof the nudge already
submitted so the send ends cleanly; apply that early-exit on every Codex send
path. That removes the sitting-composer failure and the routine false
`delivery-uncertain` hold without weakening owner-draft or ambiguity holds.
