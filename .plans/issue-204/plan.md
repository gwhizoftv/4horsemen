# Issue 204 — Scroll agent tmux panes with the mouse instead of copy mode

Baseline `855982b3f1639ec5bac7891f1c67f1e100dc2ab3`. Agent panes get a deeper
history, mouse scrolling and a scrollbar. Codex writes to normal scrollback.
The deferral shown while a pane is scrolled back gets the issue's wording,
repeats every three minutes, and appears in `coord status`. Every option is
scoped to coord's own sessions and windows; nothing uses `set -g`.

## Exact File List to be changed or deleted

- `src/tmux.ts`
  - Session creation, in both `startSession` and `ensureSession` (the
    `has-session` miss branch), becomes one tmux command list:
    `new-session -d -s <session> -n control ; set-option -t <session> history-limit 50000 ; set-option -t <session> mouse on`.
    The options are built by a new module-private helper,
    `sessionScrollOptions(session): string[]`, which both call sites share.
    `history-limit` applies only to panes created later. Setting it on the
    session before any `new-window` therefore gives every agent pane 50000
    lines. Existing `exitCode` handling of `created` is unchanged.
  - `agentClientAttachCommand` appends `set-option mouse on` after
    `set-option destroy-unattached on`, using the same `';'` joiner. Each
    Terminal client is a grouped session (`new-session -A -s <client> -t <session>`)
    with its own session options, so `mouse` has to be set on the client too.
    `history-limit` is not set on the client because a grouped session creates
    no panes.
  - `launchAgent` adds `; set-option -w -q -t <target> pane-scrollbars on`
    right after the existing `remain-on-exit on`, before `@coord-log`,
    `pipe-pane` and `respawn-pane`. `pane-scrollbars` is a window option, and
    `launchAgent` already runs for every new window and every dead-pane
    relaunch. `-q` makes tmux older than 3.6, which lacks the option, accept it
    silently. Without it, the error would cancel the rest of the command list,
    including `respawn-pane`, and the agent would never start.
  - `GateReason` keeps the code `"owner-typing"`, so journal and
    test consumers are unaffected; only its operator wording changes (in
    `runLoop.ts`).
- `scripts/lib/launcher.sh`
  - `launcher_command()`, `codex)` case: add `--no-alt-screen` to the `exec codex …`
    printf (before `--no-daemon`), with a one-line comment explaining that
    Codex output then goes to normal scrollback, so the wheel scrolls tmux
    history as it does for Claude and Cursor. `codex-cli 0.162.1` on this machine
    lists `--no-alt-screen  Disable alternate screen mode` in `codex --help`.
- `src/state.ts`
  - `actionSafetySchema` gains
    `scrolledBackNoticeAt: timestampSchema.nullable().default(null)`. It holds
    the last time the "scrolled back" notice was printed for this action. A
    non-null value means the latest pane gate found the pane scrolled back.
    Because of the default, cursors files written by older coordinators still
    parse.
- `src/runLoop.ts`
  - `DEFERRAL_RATIONALE["owner-typing"]` becomes the agent-neutral
    `"the pane is scrolled back; scroll to the bottom to let coord send"`.
    The key stays, so `journalDeferral`'s known-code check is unaffected.
  - `deferralRationale(code, agent?)`: when `code === "owner-typing"` and an
    agent is given, return `scrolledBackNotice(agent)` (from `issueReport.ts`),
    i.e. `the <agent> pane is scrolled back; scroll to the bottom to let coord send`.
    The scrape-layer call in `deliver()` (the `result.status === "busy"` branch)
    passes `agent`.
  - New constant `SCROLLED_BACK_REPEAT_MS = 180_000`, next to
    `NUDGE_REPEAT_DELAYS_MS`.
  - `journalDeferral`: for the first `owner-typing` deferral of an action,
    the existing path runs unchanged: one journal event, deferral key recorded,
    and the line printed. The same `mutate` also sets `scrolledBackNoticeAt` to
    now. When `owner-typing` is already in `safety.deferrals`, it no longer
    returns at once. If `scrolledBackNoticeAt` is null or at least
    `SCROLLED_BACK_REPEAT_MS` old, it sets `scrolledBackNoticeAt` to now and
    prints the same `[WAIT] … waiting to send to <agent>; <notice>` line
    through the existing `gateWaiting || splitBrain ? log : verbose` choice.
    It appends no new journal event, so the `deferral:` eventId stays unique.
    Every other code keeps its once-per-action behaviour.
  - `deliver()`: after the `tmux.nudge` result is authority-checked, any
    outcome other than `busy`/`owner-typing` resets a non-null
    `cursors.actionSafety[agent].scrolledBackNoticeAt` to `null` with one
    `mutate`. It writes nothing when the value is already null, so
    the repeated-tick "no rewrite" guarantees in existing tests still hold.
  - `ensureActionSafety`'s literal (`deferrals: [], holdGeneration: 0, …`) adds
    `scrolledBackNoticeAt: null`.
- `src/issueReport.ts`
  - New exported `scrolledBackNotice(agent: string): string` returning
    `the ${agent} pane is scrolled back; scroll to the bottom to let coord send`.
    It lives here because `runLoop.ts` already imports from `issueReport.ts`
    (`holdDescription`, `holdRecoveryCommand`, …), and both the log line and
    the status line then share one sentence.
  - `renderIssueReport` adds a line for each active-roster agent whose
    `actionSafety.scrolledBackNoticeAt` is non-null while its cursor is
    `ordered` on the same `actionId`:
    `[WAIT] ${scrolledBackNotice(agent)} (last seen ${scrolledBackNoticeAt}).`
    The line goes after the holds and resource-observation lines and does not
    depend on `lifecycle`. The cue computation is unchanged.
- `test/tmux.test.ts` — expectations updated or extended (see Tests).
- `test/install.test.ts` — the `expected.codex` argv gains `"--no-alt-screen"`.
- `test/runLoop.test.ts` — one new case (see Tests).
- `test/issueReport.test.ts` — the existing `const safety = { … }` literal
  in the resource-observation case adds `scrolledBackNoticeAt: null` so the test
  project still typechecks against the stricter output type; no new case.
- `docs/readiness-policy.md` — the `owner-typing` row of the pane-gate table
  now reads "the pane is scrolled back (tmux copy mode); coord repeats the
  notice every three minutes and `coord status` shows it".
- `docs/coord-driver.md` — the Codex launcher paragraph (beside `--no-daemon`)
  gains one sentence on `--no-alt-screen`. Like the other Codex flags, it
  reaches existing clones only after `coord install` rewrites `start-codex.sh`.

Nothing is deleted.

## Exact file list to be created

- `.plans/issue-204/plan.md` (this coordination artifact only).

No product file is created.

## Reuse and Scope

Reused, not reimplemented:

- `TmuxController.launchAgent` (`src/tmux.ts`): the existing
  per-window `set-option -w … ;` command list is where `pane-scrollbars` joins.
  It already covers new windows in `startSession`/`ensureSession` and
  dead-pane relaunches.
- The existing `new-session` calls in `startSession` and `ensureSession`, run
  through the same injected `TmuxRunner`, with their existing `exitCode` checks.
- `agentClientAttachCommand` and its `';'` joiner, which keeps macOS
  Terminal `do script` from splitting the sequence.
- `injectionGate` / `inspectPane` (`pane_in_mode` → `ownerTyping` →
  `GateReason "owner-typing"`): already detects a scrolled-back pane, because
  tmux's default `WheelUpPane` binding enters `copy-mode -e`. The detection is
  unchanged. Only the operator text, the repetition and the status line change.
- `journalDeferral`, `DEFERRAL_RATIONALE`, `deferralRationale`, `mutate`,
  `ensureActionSafety` and `actionSafetySchema` (`src/runLoop.ts`,
  `src/state.ts`) for the per-action, restart-durable deferral record. The
  repeat timestamp lives beside `deferrals` and resets with each new action.
- `renderIssueReport` (`src/issueReport.ts`), which already serves both
  `coord status` (`src/cli.ts`) and the interactive `s` key.
- `launcher_command()` in `scripts/lib/launcher.sh`, the single place vendor
  flags live.
- Test helpers and fixtures: `commandsIn`, `ok` and the fake `TmuxRunner` in
  `test/tmux.test.ts`; `safetyFixture` (`ui.busy` drives `pane_in_mode`,
  `messages` captures `log`, `advance` moves the clock) in
  `test/runLoop.test.ts`; `installOnce` with the argv-capturing stubs in
  `test/install.test.ts`.

New code is limited to one private helper (`sessionScrollOptions`, shared by
the two session-creation sites), one exported sentence builder
(`scrolledBackNotice`, shared by the log and status), one constant and one
schema field. No new file, no dependency, no global tmux option, and no custom
wheel binding (the issue says none is needed). The session options are applied
when coord creates the session and when it opens each Terminal client, as the
issue specifies. A session resumed from an older coord gets `mouse` through its
Terminal client and gets `pane-scrollbars` on the next relaunch.

## Tests

Each case below fails at the baseline and passes after the change. Focused
runs during development:
`pnpm vitest run --config vitest.config.ts test/tmux.test.ts test/runLoop.test.ts test/install.test.ts test/issueReport.test.ts`.
The pre-commit hook runs `pnpm check:fast`; the coordinator owns the final
`pnpm check`.

1. `test/tmux.test.ts` — "builds one attach command per agent window with
   terminal profiles": both expected `command` strings end with
   `';' set-option mouse on`.
2. `test/tmux.test.ts` — "ensureSession recreates missing agent windows and
   respawns a dead pane", extended:
   - The `launch` command list contains
     `["set-option", "-w", "-q", "-t", "coord-3:claude", "pane-scrollbars", "on"]`,
     while `launch[0]` stays `remain-on-exit on` and the last command stays
     `respawn-pane`.
   - In the `fresh` `startSession(4, …)` run, `commandsIn` of the
     `new-session` call equals `[["new-session","-d","-s","coord-4","-n","control"],
     ["set-option","-t","coord-4","history-limit","50000"],
     ["set-option","-t","coord-4","mouse","on"]]`.
   - The existing `["list-panes","respawn-pane","set-option"]` ordering
     assertion still holds, because launch stays one runner call.
3. `test/tmux.test.ts` — "creates and repairs manual sessions without exposing
   COORD_ISSUE", extended: the `new-session` call made by
   `ensureSession("manual", …)` carries the same `history-limit 50000` and
   `mouse on` commands for `coord-manual-abc12def00`. This covers the
   `ensureSession` creation branch.
4. `test/install.test.ts` — the launcher argv case: `expected.codex` becomes
   `["-c", "check_for_update_on_startup=false", "--ask-for-approval", "never",
   "--sandbox", "workspace-write", "--no-alt-screen", "--no-daemon"]`.
5. `test/runLoop.test.ts`, joining `describe("durable delivery safety")`:
   new case "repeats the scrolled-back notice every three minutes and shows it
   in status". Using `safetyFixture("codex")` with `f.ui.busy = true`:
   - The first `tick` logs exactly one
     `[WAIT] Issue <n>: waiting to send to codex; the codex pane is scrolled back; scroll to the bottom to let coord send`.
   - After `advance(179_999)` and a tick there is still one such line. After
     `advance(1)` and a tick there are two.
   - The journal still holds exactly one `nudge-deferred` event with code
     `owner-typing`.
   - `renderIssueReport(readStartState, readCursorsState, readAgentLifecycle)`
     contains `[WAIT] the codex pane is scrolled back; scroll to the bottom to let coord send (last seen`.
   - Then `f.ui.busy = false` and a tick: `f.ui.sends` is 1,
     `actionSafety.codex.scrolledBackNoticeAt` is `null`, and the status no
     longer contains the notice.

No other new tests. The existing "deduplicates A/B/A …" and "retains distinct
unknown deferral diagnostics …" cases keep guarding the once-per-action
behaviour of every other code and the no-rewrite property.

## Alternatives Rejected

- **`set -g mouse on` / `set -g history-limit` / global `pane-scrollbars`.**
  These would change every other tmux session on the owner's server; the issue
  forbids it.
- **A custom `WheelUpPane`/`WheelDownPane` binding.** The issue says none is
  needed, and key bindings are server-global, so a binding would reach
  non-coord sessions.
- **Setting `history-limit` after `new-window`, or in `launchAgent`.** tmux
  reads it only when a pane is created, so agent panes would keep 2000 lines.
- **Re-applying the session options on every `ensureSession` (resume) call.**
  The issue scopes the change to session creation and Terminal client opening.
  An extra runner call per poll also breaks the existing call-order
  assertion and adds tmux traffic for no gain, since the client already
  carries `mouse`.
- **Repeating the deferral by appending a new journal event every interval.**
  That would duplicate the `deferral:` eventId and grow the journal while the
  owner reads history. The repeat is an operator line; the durable record of
  the cause stays one event.
- **Having `coord status` probe tmux live.** Status is a read-only report built
  from runtime state, and it is also rendered inside the run loop's
  interactive `s` key. A persisted timestamp, shown with "last seen", keeps it
  read-only and honest about staleness.
- **Adding a new `GateReason` code such as `scrolled-back`.** That changes a
  closed union consumed by journal readers and tests, with no behavioural
  difference; only the wording needed to change.

## Risks and Mitigations

- **Mouse mode changes Terminal text selection.** With `mouse on`, a plain drag
  selects in tmux copy mode, not in Terminal.app. Mitigation: this applies only to
  coord's own sessions. Option-drag still makes a native Terminal selection, and
  the change is what the issue asks for.
- **tmux before 3.6 has no `pane-scrollbars`.** Mitigation: `-q` (checked
  on this machine's tmux 3.7b: `set-option -w -q` on an unknown option exits
  0). The command list therefore continues to `respawn-pane`. `mouse` and
  `history-limit` are long-standing options and need no `-q`.
- **Scrolling now enters copy mode more often, which pauses delivery.** That is
  the existing, correct safety gate. Mitigation: the wording tells the owner
  exactly what to do, and the default wheel binding (`copy-mode -e`) leaves
  copy mode when scrolled back to the bottom. The repeat and the status line
  make a forgotten scroll visible. Copy mode entered with prefix-`[` still
  needs `q`; the notice still names the cause correctly.
- **Codex inline mode (`--no-alt-screen`) and readiness scraping.** The
  pane capture (`capture-pane -S -40`) now includes earlier Codex turns in
  history. Mitigation: Claude already runs inline under the same capture
  logic. Codex readiness predicates are positional (idle sentinel only directly
  above an empty composer), and the existing `test/tmux.test.ts` Codex
  readiness cases stay unchanged and must still pass. The coordinator's final
  checks run at the approved pin.
- **Existing clones keep their old `start-codex.sh`.** Mitigation: as
  documented for the other Codex flags in `docs/coord-driver.md`, `coord install`
  rewrites it. The docs sentence added there says so.
- **Cursor write per repeat.** A scrolled-back pane rewrites `cursors.json`
  at most once every three minutes per agent, plus once when it clears.
  Mitigation: writes go through the existing authority-checked `mutate`; no
  write happens while the notice is not due or is already clear.
- **Stale status after the coordinator stops.** Mitigation: the status line is
  limited to an `ordered` agent on the same action and prints its
  "last seen" timestamp.

## Conclusion

Implement the change in `src/tmux.ts`, `scripts/lib/launcher.sh`,
`src/state.ts`, `src/runLoop.ts` and `src/issueReport.ts`, plus two documentation
touch-ups. The tmux part scopes `history-limit 50000` and `mouse on` to the
coord session, scopes `mouse on` to each Terminal client and scopes
`pane-scrollbars on` to each agent window. Codex launches with
`--no-alt-screen`. The existing `owner-typing` gate now says
"the <agent> pane is scrolled back; scroll to the bottom to let coord send",
repeats every three minutes while the wait lasts, and appears in
`coord status`. The tests are three extended `test/tmux.test.ts` cases, one
updated `test/install.test.ts` expectation and one new `test/runLoop.test.ts`
case, all of which fail at the baseline. There is no new file and no new
dependency, and no global tmux state changes.
