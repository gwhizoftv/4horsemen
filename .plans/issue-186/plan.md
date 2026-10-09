# Issue 186 plan — Codex nudges stall, hold as `delivery-uncertain`, and hooks name a stale issue

## Diagnosis (evidence gathered on 2026-10-09, issue 186 live run)

The issue now covers three symptoms. The first two come from the issue body. The owner
added the third mid-session:

1. A Codex nudge sometimes stays in the composer and is never submitted.
2. Codex shows `delivery-uncertain` and a hold on almost every turn.
3. Codex's shell-guard denial names **issue 139**, and `coord containment-probe` fails
   with `session or installed policy unknown; containment remains unverified`.

One root cause explains all three, and a second, smaller defect explains the garbled
nudge text.

**Root cause A: Codex hooks run in a shared daemon that carries a stale `COORD_ISSUE`.**
`codex-cli 0.162.0` sends the TUI's hooks through a shared app-server daemon.
`ps eww` on this machine showed:

- The daemon (`codex app-server --listen unix:// … --managed-daemon`, pid 5269, started
  2026-10-08) has `COORD_ISSUE=139`.
- The issue-186 TUI (pid 17290, started by `start-codex.sh`) has `COORD_ISSUE=186`.

Hooks run with the daemon's environment, so every hook targets the wrong issue:

- **Shell guard.** `git-guard` reports issue 139, and the git shim does the same
  (symptom 3).
- **Lifecycle events.** `agent-event` gives `COORD_ISSUE` priority over the prompt in
  `handleAgentEvent` (`src/agentEvent.ts:333-337`). Today's Codex lifecycle events
  (18:39–18:41Z) appear in `coord-runtime/issue-139/journal.jsonl`.
- **Issue-186 lifecycle state.** Codex still has `sessionId: null`,
  `execution: "unknown"`, `hookReceipt: null`, and no `UserPromptSubmit` acceptance.

That missing lifecycle state causes the rest:

- `recordContainmentProbe` throws when `!entry?.sessionId` (`src/shellGuard.ts:327`)
  (symptom 3).
- `RunLoop.deliver` (`src/runLoop.ts`) does not see `execution: "working"`, so it nudges
  whenever Codex's `Working (…)` status line happens to be hidden. That happens during a
  live turn, for example while Codex is streaming a reply.
- The nudge's per-key gate or proof then fails mid-send. Typical causes are a foreground
  change while Codex runs a tool, `codex-turn-chrome`, or `codex-composer-not-ready`.
- `deliver` records that as a `delivery-uncertain` hold, which pauses the issue
  (symptom 2).
- Keys already sent stay in the composer unsubmitted (symptom 1). The issue's screenshot
  shows action `43fff81d…`, which is the action of the issue-167 `delivery-uncertain`
  hold at 01:16:25Z.

Issue 167 had nine such holds and issue 176 had twelve. Every recent Codex
`delivery-uncertain` hold has `sessionId: null`. The project memory for issue 176 records
the same misrouting through an earlier daemon.

**Defect B: the Codex `i` prelude is typed as text when Codex is already in vim INSERT.**
The live issue-186 pane shows the held nudge as a submitted message:
`› iRead and execute coordinator action 4b16949a…`. Its footer reads `Vim: Insert`.

- The override path (ready-file or sentinel) already skips the prelude unless the footer
  shows `Vim: Normal` (`src/tmux.ts`, `preludeKeys` in `TmuxController.nudge`).
- The ordinary path always sends the configured `["i"]`, so in INSERT mode an `i` lands
  at the start of the nudge text.

**Defect C: the nudge text can stay in the composer, never submitted.** The owner
reports that in the stalls the nudge text is correct and just never gets the Enter that
submits it. The current code cannot detect or repair that:

- **Ordinary path.** `TmuxController.nudge` sends `C-j` then `C-m` blind, 300 ms after
  typing (`NUDGE_AFTER_TEXT_MS`) and 150 ms apart (`NUDGE_BETWEEN_SUBMIT_MS`). It returns
  `sent` without checking that the composer was cleared. If Codex has not finished
  rendering the typed text, or takes a submit key as a newline, nothing retries. The
  text sits there and `deliver` thinks the action was delivered.
- **Override path.** The per-key proof requires the composer to hold exactly the nudge
  before each submit key (`codexComposerHolds`). If Codex paints the typed text a beat
  after the 300 ms wait, the proof fails with `codex-composer-not-ready` after the text is
  typed but before any submit key. The text sits there and `deliver` holds
  `delivery-uncertain`.

Root cause A makes this happen far more often, by typing into a Codex that is busy. Even
after A is fixed, a slow paint or a dropped submit key still strands the text. The fix
waits a bounded time for the composer to show the text, then re-presses `C-m` only while
the composer verifiably still holds exactly the nudge text. Once Codex clears the
composer, no further key is sent, so a real submit is never followed by a re-press. The issue-176 proof between keys is unchanged.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh`: in `launcher_command()`, add `--no-daemon` to the Codex
  `exec` line:
  `exec codex --ask-for-approval never --sandbox workspace-write --no-daemon ${coord_grant[@]+"${coord_grant[@]}"}`.
  With this flag, Codex runs its app server in-process, so its hooks inherit the pane's
  current `COORD_ISSUE` and the `.coord/bin` `PATH` the launcher just exported. Also
  extend the comment above the line with one sentence giving the reason.
- `src/tmux.ts`:
  - Add a `codexVimInsert(paneText)` predicate next to `codexVimNormal`. It returns true
    when `codexTail(paneText, false)` exists and its footer has a line matching
    `/Vim: Insert/`.
  - In `TmuxController.nudge`, change the `preludeKeys` expression. Codex sends no
    prelude in two cases: on an override, when `codexVimNormal(paneText, requireSentinel)`
    is false (today's rule, unchanged); otherwise, when `codexVimInsert(paneText)` is
    true.
  - In every other case the resolved prelude is sent as it is today. A pane without a
    readable Codex footer still gets `i`, so a Codex really in NORMAL never swallows the
    first character of the nudge.
  - **Codex submit confirmation (defect C).** Applies only when the first capture parses
    as a Codex composer (`codexTail(paneText, false) !== null`). Panes coord cannot read
    keep today's exact key and capture sequence.
    - (a) After typing and the existing `NUDGE_AFTER_TEXT_MS` wait, and before the first
      submit key, re-capture up to `CODEX_SUBMIT_SETTLE_CHECKS = 4` times,
      `NUDGE_BETWEEN_SUBMIT_MS` apart, until `codexComposerHolds(latest, text, false)`.
      This step only waits and never sends a key. On the override path the existing
      `send()` proof still decides whether the submit key is sent.
    - (b) After the submit loop, unless it already ended on acceptance, sleep
      `NUDGE_BETWEEN_SUBMIT_MS` and re-capture. While the composer still holds exactly the
      nudge text, send one more `C-m` through the existing `send()`, which re-runs the
      injection gate and, on an override, the full proof and acceptance check. Do this at
      most `CODEX_SUBMIT_RETRIES = 2` times.
    - The outcome contract stays the same: `sent` / `complete`, or the existing busy or
      mid-send refusals from `send()`.
- `test/install.test.ts`: extend the existing argv-capture test, "passes each harness
  exactly its own current drop, and nothing in manual mode". Its `expected.codex` array
  becomes
  `["--ask-for-approval", "never", "--sandbox", "workspace-write", "--no-daemon"]`.
- `test/tmux.test.ts`: add two cases to the `tmux boundary` describe, after the
  `codexPane` helper. Also make `C-m` submit the draft in the existing override test's
  `attempt` stub. See Tests.
- `docs/coord-driver.md`: in the nudge key list, edit the `nudgePrelude` bullet. It
  should say Codex's `i` is skipped when its footer already shows `Vim: Insert`. Add two
  sentences: one saying a Codex submit is confirmed (re-press `C-m`, bounded, while the
  composer still holds the nudge), and one saying the Codex launcher uses `--no-daemon`
  so hooks see the pane's issue environment.

## Exact file list to be created

None. All three fixes extend existing functions (`launcher_command`,
`TmuxController.nudge`) and existing tests. The plan itself
(`.plans/issue-186/plan.md`) is the only new file, and it is the coordination artifact
for this action.

## Reuse and Scope

Reused:

- `launcher_command()` / `write_launcher` in `scripts/lib/launcher.sh`, and the
  install-time launcher generation that `coord install` and `githooks/post-merge` both
  read.
- `codexTail`, `codexVimNormal`, `CODEX_FOOTER` and `paneLines` in `src/tmux.ts`. The new
  `codexVimInsert` is the INSERT counterpart of `codexVimNormal`, built on the same
  `codexTail` parse. The submit confirmation reuses `codexComposerHolds`,
  `this.capturePane`, `this.sleep`, the `send()` closure (gate, proof, acceptance) and
  `NUDGE_BETWEEN_SUBMIT_MS`. Its two bounds are module constants next to the existing
  `NUDGE_*` delays, not a new abstraction.
- In `test/tmux.test.ts`: the `codexPane(body, draft, vim)`, `codexComposer`,
  `codexFooter`, `ok` and `noopSleep` helpers, and the `TmuxController` runner-stub
  pattern from the override test.
- In `test/install.test.ts`: the argv-capture harness test (stub `codex` binary,
  `/bin/bash` execution).

No new file, abstraction or dependency. `src/codexQuota.ts` starts its own
`codex app-server --listen stdio://`, so it does not depend on the shared daemon and is
unaffected.

Out of scope, deliberately:

- Changing `agent-event` issue precedence. Rejected below.
- Changing the configured submit keys (`C-j`, `C-m`) or weakening the override proof.
- Cleaning up issue 139's runtime. That is an owner operation: the stale events written
  there today are a side effect, and fixing it is not a code change.

## Tests

Three focused cases. Each fails before the change and passes after it.

1. **`test/install.test.ts`**, existing test "passes each harness exactly its own current
   drop, and nothing in manual mode".
   - Change `expected.codex` to include `--no-daemon` after `workspace-write`.
   - Before: the captured argv has no `--no-daemon`, so the assertion fails.
   - After: the generated `start-codex.sh` passes it, in order, before the grants.
2. **`test/tmux.test.ts`**, new case in `describe("tmux boundary")`: "types Codex's `i`
   prelude only when INSERT is not visible".
   - Call `TmuxController.nudge` on the ordinary path (no `staleOverride`) with a
     display-message stub of `0\tcodex\t0\t0\n`.
   - The pane stub returns `codexPane("• done")`, whose default footer reads
     `Vim: Insert`.
   - Assert the recorded `send-keys` sequence is `["-l", "C-j", "C-m"]`. The current code
     sends `["i", "-l", "C-j", "C-m"]`, so this fails before the change.
   - Then repeat with `codexPane("• done", "", "Normal")` and assert
     `["i", "-l", "C-j", "C-m"]`, so NORMAL still enters insert.
   - The existing tests "Codex defaults" and "honors explicit empty prelude over Codex
     defaults" use a pane without a footer (`codex ready\n`). They keep passing unchanged
     and pin the fail-safe that an unreadable footer still gets `i`. They also show that a
     pane coord cannot read gets no extra captures or keys.
3. **`test/tmux.test.ts`**, new case in `describe("tmux boundary")`: "re-presses Enter
   while the Codex composer still holds the nudge".
   - Use a stub Codex built like the override test's `attempt` helper: text typed with
     `-l` goes to `pane.draft`, and the composer is rendered with `codexPane`.
   - The first `C-m` is lost (the draft stays). The second `C-m` submits it: the draft
     moves into the body with `• Working (0s • esc to interrupt)` and the composer
     empties.
   - Ordinary path: assert the keys are `["-l", "C-j", "C-m", "C-m"]` and the outcome is
     `{ status: "sent" }`. Today the keys stop at one `C-m`, so this fails before the
     change.
   - Also assert that a `C-m` that never submits stops after `CODEX_SUBMIT_RETRIES`
     extra presses (`["-l", "C-j", "C-m", "C-m", "C-m"]`), so the retry stays bounded.
   - Render lag: the typed text appears only on the second capture. Assert the override
     path (`source: "ready-file"`) waits and then sends `C-j`, `C-m`, instead of refusing
     with `codex-composer-not-ready`. That refusal is today's behavior, so this also fails
     before the change.
   - Required edit to the existing stub: in the "sends a %s nudge only while the idle
     proof holds at each key" `attempt` helper, `C-m` must submit the draft the way
     `submitOnCtrlJ` already does for `C-j`. Otherwise the new confirmation would see the
     nudge still in the composer and re-press. With that edit, every existing expectation
     in that test keeps its current key list.

Checks:

- Run the two files while developing with
  `pnpm exec vitest run test/tmux.test.ts test/install.test.ts`.
- The pre-commit hook runs `pnpm check:fast`; I will not run it again by hand.
- The coordinator owns final `pnpm run check` at the approved pin.

Manual check after merge: re-run `coord install` so existing clones regenerate
`start-codex.sh`, then restart the Codex pane. After that, `ps eww` should show the hook
processes with the pane's `COORD_ISSUE`. `coord containment-probe` should then succeed
for Codex, and Codex lifecycle events should land in the current issue's journal.

## Alternatives Rejected

- **Make `agent-event` prefer the issue named in the prompt over `COORD_ISSUE`.** Only
  `UserPromptSubmit` carries a prompt. `Stop`, `SessionStart`, `SessionEnd` and the shell
  guard would still use the daemon's stale issue, so lifecycle state stays wrong. It also
  changes precedence for Claude and Cursor, whose environments are correct.
- **Route events by `session_id` to the issue already holding that session.** This is
  the remedy the issue-176 memory suggests. It cannot route the first event of a session,
  and it cannot help the git shim or `git-guard`, which read `COORD_ISSUE` directly.
  `--no-daemon` removes the cause with a one-flag change.
- **Stop or restart the shared Codex daemon from `coord start`.** The daemon is shared
  with the owner's other Codex clients (the VS Code extension and the Codex app are
  running on this machine). Killing it would interrupt work outside coordination.
- **Change the configured submit keys (drop `C-j`, or always send a second `Enter`).**
  The stalls are erratic: the same keys usually work, so the keys are not wrong. Codex
  timing or state sometimes defeats them. An unconditional extra `Enter` would land in
  whatever Codex is doing. The confirmation re-presses only on positive proof that the
  exact nudge is still unsubmitted, and only a bounded number of times. I did not run a
  live Codex keystroke probe: it would have needed trusting a scratch folder, which
  writes permanently to the owner's `~/.codex` config.
- **Lengthen `NUDGE_AFTER_TEXT_MS` for everyone.** Slows every agent's nudge, and a
  fixed delay is still a guess. The settle wait ends as soon as the composer shows the
  text.
- **Send `i` only when `Vim: Normal` is visible, on every path.** A pane whose footer
  cannot be parsed would then get no `i`. If Codex really is in NORMAL, the first nudge
  character `R` would enter Replace mode and corrupt the text. Skipping `i` only on
  positive INSERT evidence is strictly safer than today's behavior.

## Risks and Mitigations

- **Existing clones keep their old `start-codex.sh`.** `githooks/post-merge` regenerates
  a launcher only when one is missing. Mitigation: the docs sentence and the PR body tell
  the owner to re-run `coord install` and restart Codex panes. Until then, behavior is
  exactly as today, with no new failure.
- **`--no-daemon` is a vendor flag that could change.** It is in `codex --help` for the
  installed 0.162.0 ("Run without the shared background server, even if it is already
  running"). If a future Codex drops it, the launcher fails loudly at start. It does not
  misroute silently.
- **Each Codex pane runs its own in-process server, using more memory.** That is one
  process per agent pane, which is acceptable. The quota reader already starts its own
  stdio server per read.
- **The `Vim: Insert` match could be fooled by transcript prose.** `codexTail` reads only
  the footer lines below the last `›` composer, and those must all match `CODEX_FOOTER`.
  Prose above the composer is never considered, the same guarantee `codexVimNormal`
  relies on.
- **A re-pressed `C-m` could reach Codex after the nudge was actually submitted.** It
  is sent only while the composer still renders exactly the nudge text, and through
  `send()`, which re-checks the gate and, on overrides, acceptance and the turn chrome.
  If Codex cleared the composer, nothing is sent.
- **Extra captures add up to roughly 0.6 s before the first submit key, plus up to
  2 × 0.15 s after it.** This applies only to Codex panes coord can parse. The bounds
  are small constants.
- **Issue 139's runtime already holds misrouted Codex events from today.** Not repaired
  by code. The owner should mark issue 139 completed or wipe it so stale-runtime fallback
  in `handleAgentEvent` cannot pick it.

## Conclusion

Three small changes, each tied to observed evidence:

1. **Launch Codex with `--no-daemon`** so its hooks inherit the pane's current
   `COORD_ISSUE`. This restores Codex lifecycle state, makes `coord containment-probe`
   work, stops the guard naming issue 139, and stops nudges being typed into a busy
   Codex. Those nudges are what produced the constant `delivery-uncertain` holds.
2. **Confirm the Codex submit.** Wait, within a bound, for the typed nudge to render,
   then re-press `C-m` at most twice, and only while the composer still holds exactly the
   nudge text. This fixes the stall the owner reported: the text is right but it is never
   submitted.
3. **Skip Codex's `i` prelude when the footer already shows `Vim: Insert`.**

The changes are two source edits, focused test changes in two existing test files, and
one docs paragraph. No new files. The submit keys and the issue-176 delivery proof are
kept.
