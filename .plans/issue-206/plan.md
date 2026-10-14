# Plan — issue 206: Codex does not always enter INSERT before the nudge text

## Problem

Issue 206 reports that Codex sometimes does not enter vim INSERT before the
nudge prompt is typed. Changing the insert key to `"a "` did not help, and the
owner asks why Codex gets no delay between the INSERT key and the prompt when
other keys do get one.

Cause, from `src/tmux.ts` `TmuxController.typeAndSubmit` (non-Antigravity
branch): Codex, Claude and Cursor get one blocking tmux command batch. Blocking
`run-shell 'sleep …'` gaps come after the literal text (`NUDGE_AFTER_TEXT_MS`,
300 ms) and between submit keys (`NUDGE_BETWEEN_SUBMIT_MS`, 150 ms). The
prelude keys get no gap:

```ts
const commands = [
  ...preludeKeys.map((key) => ["send-keys", "-t", target, key]),
  ["send-keys", "-l", "-t", target, text],
  ...submit.flatMap(/* sleep, key */)
];
```

So Codex's `i` (default `agentOwnerUiDefaults("codex").nudgePrelude`, also
`nudgePrelude: ["i"]` in the runtime `config.json`) reaches the pty in the same
burst as the prompt bytes. `docs/coord-driver.md` already gives the reason for
the text gap: TUIs run paste detection on a fast burst, so a key that arrives
with the text is not handled as a separate key event. The mode-switch key has
the same problem. If it is folded into the burst, the prompt lands while Codex
is still in NORMAL, and the result depends on timing ("erratic"). Configuring
`"a "` only puts a space into the same burst; it adds no gap. Only Antigravity's
branch sends each key with its own `send` call. Its separate tmux invocations
are the only "delay" any agent gets before the text. The same missing gap also
puts the Claude/Cursor VISUAL prelude `["Escape", "a"]` back to back, which can
be read as Alt+a.

Cursor (checked at the owner's request) has the same defect. On this host
`~/.cursor/cli-config.json` sets `editor.vimMode: true`, so `readCursorVimMode`
is true. When the pane does not show INSERT,
`cursorNudgePrelude` → `vimInsertPrelude(paneText, "cursor")` returns `["a"]`
(`["Escape", "a"]` from VISUAL). That prelude goes into the same batch with no
gap, directly before the text, so Cursor can miss the mode switch the same way
Codex does. Cursor's submit side (`Escape`, 150 ms, `Enter`) is already gapped
and stays unchanged.

Fix: inside the existing blocking batch, follow every prelude key with a
blocking `run-shell 'sleep …'` gap, as the submit keys already are.

## Exact File List to be changed or deleted

- `src/tmux.ts`
  - Add one exported constant next to `NUDGE_AFTER_TEXT_MS` /
    `NUDGE_BETWEEN_SUBMIT_MS`:
    `export const NUDGE_AFTER_PRELUDE_MS = 150;` with a one-line doc comment
    (let the TUI handle each mode key as its own event, outside paste-burst
    detection, before the next key or the text).
  - In `typeAndSubmit`'s batched (non-Antigravity) branch, replace
    `...preludeKeys.map((key) => ["send-keys", "-t", target, key])` with
    `...preludeKeys.flatMap((key) => [["send-keys", "-t", target, key], ["run-shell", `sleep ${NUDGE_AFTER_PRELUDE_MS / 1000}`]])`.
    The batch stays one tmux operation, `run-shell` stays blocking (no `-b`),
    and an empty prelude yields exactly today's batch.
  - Update the comment above that batch to name the prelude gap.
  - The Antigravity branch, `resolveNudgeKeys`, `vimInsertPrelude`, the
    `codexVimInsert`/`codexVimNormal` prelude suppression, readiness and gates
    stay unchanged.
- `test/tmux.test.ts` — update the three batch-layout expectations that
  currently pin a prelude key directly before the text, and add one Cursor vim
  nudge case (see Tests).
- `docs/coord-driver.md` — in the batch paragraph ("Codex, Claude and Cursor
  receive one tmux command batch …"), state that each prelude key is followed by
  a blocking 150 ms gap so the vim mode switch is handled before the text. Also
  note under `nudgePrelude` that entries are tmux key names sent before that
  gap, so a trailing space (`"a "`) types a space into the prompt rather than
  adding a delay.

## Exact file list to be created

None. The change fits in the existing transport function, test file and driver
doc.

## Reuse and Scope

Reused, unchanged in behaviour:

- `TmuxController.typeAndSubmit` (`src/tmux.ts`) — the single shared transport
  for `nudge` and `remind`. Changing it once fixes both automatic nudges and
  owner reminders.
- The existing blocking `run-shell 'sleep N'` gap pattern and the
  `NUDGE_AFTER_TEXT_MS` / `NUDGE_BETWEEN_SUBMIT_MS` naming convention. The new
  constant follows them. It is a separate name, not a reuse of
  `NUDGE_BETWEEN_SUBMIT_MS`, because that constant is documented as the
  Escape/Enter Alt-key separator. The two values may need to diverge.
- `resolveNudgeKeys`, `agentOwnerUiDefaults` (`src/setupWorkspace.ts`),
  `vimInsertPrelude`, `codexVimInsert`, `codexVimNormal` — they still pick
  which prelude keys to send. This plan changes only when they are sent.
- Test helpers already in `test/tmux.test.ts`: `runnerWithPrompt`,
  `commandsIn`, `codexPane`, `promptFor`, `noopSleep`, `ok`.

Out of scope: Antigravity delivery (separate per-key sends, no reported
problem); a configurable delay field in `config.json` / `AgentConfig`; polling
Codex's footer for `Vim: Insert` between prelude and text; any change to which
prelude key Codex uses.

## Tests

All four cases join `test/tmux.test.ts`. Cases 1–3 are existing expectations
that pin today's back-to-back prelude+text layout. Case 4 is a new Cursor case.
Each fails before the change and passes after it. No new test file.

1. "uses per-agent nudgePrelude and nudgeSubmit for Codex vim" (configured
   `nudgePrelude: ["i"]`): the batch's last-arg sequence becomes
   `["i", "sleep 0.15", "Read and execute your current coordinator action at /runtime/action.md", "sleep 0.3", "Enter"]`.
2. "sends Codex text and Enter once in %s mode without waiting for paint"
   (default Codex prelude, footer `Vim: Normal`): expected
   `["i", "sleep 0.15", "-l", "sleep 0.3", "Enter"]`. The `Insert` case stays
   `["-l", "sleep 0.3", "Enter"]`: no prelude, no gap. It still asserts one
   batch and `sleeps` empty, which proves the gap is inside tmux, not a Node
   sleep.
3. "uses configured keys when capture is unavailable" (owner `remind`, Cursor
   `nudgePrelude: ["a"]`): expected
   `["a", "sleep 0.15", "owner reminder", "sleep 0.3", "Escape", "sleep 0.15", "Enter"]`.
   This covers the shared owner-reminder path.
4. New case next to "submits %s vim INSERT with gaps after text and Escape in
   one batch": Cursor `nudge` with clone `.cursor/cli.json`
   `{ editor: { vimMode: true } }`, the default (unset) `nudgePrelude`, and a
   pane without INSERT (`"Auto ·\n"`). It asserts exactly one send-keys batch
   whose `commandsIn` is
   `[["send-keys", "-t", "coord-1:cursor.0", "a"], ["run-shell", "sleep 0.15"], ["send-keys", "-l", "-t", "coord-1:cursor.0", <text>], ["run-shell", "sleep 0.3"], ["send-keys", …, "Escape"], ["run-shell", "sleep 0.15"], ["send-keys", …, "Enter"]]`.
   No existing test drives Cursor's vim-derived `a` through `nudge` (the
   current Cursor vim test covers only `resolveNudgeKeys`), so this case pins
   the Cursor nudge path the owner asked about. It reuses `runnerWithPrompt`,
   `commandsIn`, `noopSleep`, the `roots` cleanup, and the clone-overlay setup
   from the adjacent INSERT test.

Existing cases that must stay green unchanged and serve as regression guards:
empty-prelude Codex ("honors explicit empty prelude over Codex defaults"),
Cursor/Claude INSERT ("submits %s vim INSERT …"), the Cursor non-vim nudge, and
the Antigravity sleep assertions (`[NUDGE_BEFORE_ANTIGRAVITY_MS]`).
`test/runLoop.test.ts` reads only the `-l` text from send-keys args and is
unaffected.

Commands: during development, `pnpm vitest run --config vitest.config.ts test/tmux.test.ts`.
The commit hook runs `pnpm check:fast`. The coordinator owns final `pnpm check`.

## Alternatives Rejected

- **Send prelude keys as separate tmux invocations (Antigravity style).** This
  reopens the gap that issue 193's single blocking batch closed. Each extra call
  re-runs the injection gate and pane capture, and the gap length is whatever
  process spawn takes, not a fixed bound.
- **Gap only for Codex.** The defect is the batch layout, not a Codex quirk.
  Claude's VISUAL prelude `["Escape", "a"]` has the same back-to-back problem
  (Alt+a). One rule in the shared transport is smaller than a vendor branch.
- **A configurable `nudgePreludeDelayMs` in `config.json`.** New schema, docs
  and validation for a value no operator has needed to tune. A constant matches
  how the text and submit gaps are handled.
- **Poll Codex's footer for `Vim: Insert` after the prelude, before the text.**
  This adds extra captures, latency and a new failure mode. It also contradicts
  the documented rule that the coordinator does not poll for the pasted prompt.
- **Recommend `"a "` or another prelude string.** The owner tried this. A
  trailing space is just another key in the same burst. It adds no delay and
  types a space into the composer.

## Risks and Mitigations

- **150 ms may be too short for a slow Codex repaint.** It is the gap already
  proven between Escape and Enter, and it is roughly 10× a typical paste-burst
  window. The value lives in one named constant, and the owner's live Codex
  pane confirms it. If it is insufficient, the follow-up is a one-line constant
  change, not a redesign.
- **The added latency affects every non-empty prelude.** That is 150 ms per
  prelude key (one key in the common case). It is negligible next to the
  existing 300 ms text gap, and empty preludes are unchanged.
- **A non-blocking sleep would let the text overtake the gap.** The plan reuses
  the existing `run-shell 'sleep …'` form without `-b`. The `sleeps` empty /
  single-batch assertions in test 2 guard against moving the wait into Node.
- **The mechanism is inferred, not observed.** The failure is intermittent and
  only a gap can affect it. The fix addresses the one difference between the
  prelude key and every other gapped key in the batch. Acceptance still relies
  on the vendor prompt-submit hook, so a miss stays visible as a
  delivery-uncertain hold, not a silent success.

## Conclusion

Codex's `i` reaches the pty in the same tmux burst as the prompt text, because
`typeAndSubmit` puts prelude keys back to back with the text while every other
key in the batch gets a blocking gap. Add `NUDGE_AFTER_PRELUDE_MS = 150` and a
blocking `run-shell 'sleep 0.15'` after each prelude key, inside the existing
single batch. Cursor with `editor.vimMode` (on for this host) has the same
back-to-back `a` and gets the same fix. Update the three `test/tmux.test.ts`
layout expectations, add one Cursor vim nudge case, and update the batch
paragraph in `docs/coord-driver.md`. No new files, config fields or vendor
branches. Owner reminders get the same fix through the shared transport. The
owner should keep `nudgePrelude: ["i"]` (not `"a "`) for Codex.
