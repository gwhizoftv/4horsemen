# Issue 204 — plan review (claude)

Reviewed pins:

- claude `d821fa9ca5100663b76132c7d81da928ecc6ddf2` (`.plans/issue-204/plan.md`)
- codex `367d46951b2365419c6ced0fa72cdaaca32ff7ed` (`.plans/issue-204/plan.md`)
- cursor `595a8c11fb79af5cd76599262dbd7b88c6dd9fad` (`.plans/issue-204/plan.md`)

All three were read from the bound input files at baseline
`855982b3f1639ec5bac7891f1c67f1e100dc2ab3`.

Facts checked against the baseline tree:

- `TmuxController.ensureSession` has only two callers:
  `CoordinatorRunLoop.restoreTerminals` (`src/runLoop.ts:1180`, startup and
  attach) and manual setup (`src/cli.ts:685`). It is not called per poll.
  `restoreTerminals` reopens Terminal clients with `{ onlyMissing: true }`.
- `vitest.config.ts` excludes `test/install.test.ts`; only
  `vitest.system.config.ts` includes it.
- `appendJournal` (`src/state.ts`) returns the existing event when the
  `eventId` repeats.
- `test/runLoop.test.ts:1098` ("keeps … minute-boundary probes out of durable
  cursor state") requires advisory pane probes not to rewrite `cursors.json`.
- On the local tmux 3.7b, the default `WheelUpPane` binding is
  `if-shell -F "#{||:#{alternate_on},#{pane_in_mode},#{mouse_any_flag}}" { send-keys -M } { copy-mode -e }`.
  An alternate-screen pane therefore never enters tmux history, which confirms
  that Codex needs `--no-alt-screen`. Ordinary panes leave copy mode at the
  bottom (`-e`).
- `set-option -w -q` with an unknown option exits 0. Without `-q`, the same
  call fails with "invalid option".

## Findings

### cursor (`595a8c11`)

**F1. Reuse and Scope, item 6 / Tests (`test/issueReport.test.ts`,
`test/interactive.test.ts`): `coord status` probes tmux live and prints the
notice for every pane in copy mode.**
Rule: the issue asks status to show *the deferral message*. That message
claims "scroll to the bottom to let coord send", so it may appear only while
coord's delivery is actually blocked by that pane. It must not appear just
because the owner is reading history.
Failure as written: the agent is `working` on R4, so there is nothing for coord
to send. The owner scrolls up to read its output and runs `coord status`.
`inspectPane` reports `ownerTyping`, and status prints "the claude pane is
scrolled back; scroll to the bottom to let coord send". The same happens with
the coordinator stopped, when nothing can send at all. The design also turns
`InteractiveCommands.status` async. It adds `src/cli.ts`, `src/interactive.ts`
and `test/interactive.test.ts` to the change, and makes status depend on a
tmux round trip. None of that is needed for what the issue asks.
Smallest correction: derive the status line from the refusal coord
recorded for the current ordered action, persisted beside `actionSafety`, and
drop the live probe and the async `status` change.

**F2. Reuse and Scope, item 5: the bucketed-`eventId` repeat fires on the
next poll after the first notice.**
Rule: a continuing wait repeats "every few minutes", and the plan's own test
says another tick with no clock advance adds no row and no log line.
Failure as written: the first observation journals under the existing
unbucketed id `deferral:…:owner-typing`. Repeats use an id that "includes
that time bucket". On the very next tick the current bucket's id is absent, so
`appendJournal` inserts it and the line is logged again at once. The plan's
own `safetyFixture` test (clock fixed at `12:00:00.000Z`, second tick with no
advance) fails. Even if the first observation also wrote its bucket row, a
`floor(now / 180000)` bucket makes the first repeat land anywhere from one poll
to 180 s after the first notice, depending on wall-clock alignment. The design
also appends a journal row every three minutes for as long as a pane stays
scrolled back: about 160 rows for one pane left scrolled overnight.
Smallest correction: record the last notice time per action, as the claude and
codex plans do, and repeat when 180 s have elapsed since it.

**F3. Reuse and Scope, items 1–2: `pane-scrollbars` is set without `-q`.**
Rule: an option missing from older tmux must not break session repair or
Terminal attach. `pane-scrollbars` first appeared in tmux 3.6, and coord
documents no minimum tmux version.
Failure as written: on tmux 3.5a, `set-option -w -t coord-N:claude
pane-scrollbars on` fails with "invalid option". In `ensureSession`, an
exit-checked call throws, so restoring terminals fails. In
`agentClientAttachCommand`'s `';'` sequence, the error aborts the remaining
commands.
Smallest correction: `set-option -w -q`. This was verified above to exit 0 on
an unknown option.

**F4. Tests, development command: `test/install.test.ts` is run under
`vitest.config.ts`, which excludes it.**
Rule: a focused command must actually run the test it names.
Failure as written: the command runs no install case, so a missing or
misplaced `--no-alt-screen` goes unnoticed until the pre-commit hook's
`test:system` step.
Smallest correction: run it with `--config vitest.system.config.ts`, as the
codex plan does.

### codex (`367d4695`)

**F5. Reuse and Scope, "Current wait…": `observeUnfinished()` pane
observations "refresh" the stored `scrollbackWait`.**
Rule: advisory pane probes do not write durable cursor state. This is enforced
by `test/runLoop.test.ts:1098` and documented on `paneObservations` ("Local
probes are advisory").
Failure as written: a wait is established by a refused delivery while the
owner stays scrolled back. Each per-minute probe then refreshes
`observedAt` (or `lastReminderAt`) through a cursor mutation. That rewrites
`cursors.json` and advances `stateRevision` every minute, for as long as the
pane stays in copy mode. The probe the existing test protects becomes a
writer, and a variant of that test with `ui.busy = true` would fail.
Smallest correction: probes may only *clear* an established wait. Only the
delivery path sets it, and only a due reminder updates `lastReminderAt`.

**F6. Tests: the test list goes well beyond "the fewest focused tests".**
Rule: the action asks for the fewest focused tests that fail before and pass
after, joining existing files.
Failure as written: the plan proposes:
- `test/state.test.ts` round trips for a defaulted optional field, which the
  `safetyFixture` restart-per-tick loop already exercises;
- five suppression variants in `test/issueReport.test.ts`;
- runLoop scenarios for action replacement, completion, a different blocker,
  failed observation and re-entry;
- real-tmux assertions about an unrelated session.
That adds about 15 cases and a tenth file for a three-part change. It also
widens the review and maintenance surface without covering a distinct
behaviour that one timing case, one status assertion and the tmux and
launcher expectations do not already fix.
Smallest correction: keep the launcher argv, attach/create/launch command
assertions, one runLoop repeat-and-clear case and one status assertion. Drop
`test/state.test.ts`.

**F7 (shared with claude). Reuse and Scope, "Scoped tmux options" item 2:
`pane-scrollbars on` goes on every agent window.**
Rule: the issue scopes mouse and scrollbars to "Claude and Cursor". Codex is
handled through `--no-alt-screen`, and Antigravity/Gemini are not named.
Failure as written: the Antigravity and Gemini windows also get an
always-on scrollbar that the issue did not ask for. The bar takes a column and
reflows their TUI. If that TUI uses the alternate screen (not verified here),
the wheel already goes to the app (`alternate_on` → `send-keys -M`), and the
bar sits over history the pane never fills.
Smallest correction: set `pane-scrollbars` only on windows whose agent id is
`claude`, `cursor` or `codex` (Codex is now inline). This is a literal reading
of the issue, which the cursor plan follows.

### claude (`d821fa9c`, own plan)

**F8. Alternatives Rejected, "Re-applying the session options on every
`ensureSession` (resume) call": the plan gives a false reason and leaves
issues that are already running without the feature.**
Rule: rejected alternatives must rest on correct facts. A coord upgrade
followed by resume should also give the issue in progress mouse scrolling.
Failure as written: the plan says re-applying would add "an extra runner call
per poll". In fact `ensureSession` runs only from `restoreTerminals`
(`src/runLoop.ts:1180`) and manual setup (`src/cli.ts:685`). If the plan is
followed, an owner who upgrades coord and resumes an issue with Terminals
open gets no mouse scrolling and no scrollbars:
- `coord-N` already exists, so no `new-session` runs;
- `restoreTerminals` reopens only missing clients (`onlyMissing: true`), so the
  attach command with `mouse on` never runs for open clients;
- live panes never pass through `launchAgent`.
Smallest correction: in `ensureSession`, set `mouse on` (and
`history-limit 50000` for future panes) on `coord-N` and on each existing
`coord-N-<agent>` client. Also set `pane-scrollbars` (with `-q`) on each live
agent window before the early `continue`. Update the
`["list-panes","respawn-pane","set-option"]` order assertion to match.

**F9. `src/runLoop.ts` `deliver()` clearing rule: `scrolledBackNoticeAt` is
cleared only after a `tmux.nudge` result.**
Rule: the status line must not report a scrolled-back wait that is no longer
the blocker.
Failure as written: the owner scrolls back, so the notice is set. The owner
then scrolls down and types the task into the pane by hand. Lifecycle reports
`working`, so `deliver()` returns early (`entry.execution === "working"`)
before reaching the nudge, and the field is never cleared. The cursor stays
`ordered` until completion, and `coord status` keeps printing "the claude pane
is scrolled back … (last seen …)" for the whole turn.
Smallest correction: also clear a non-null value on `deliver()`'s early
returns for working, pending input and background. Alternatively, have the
status line skip agents whose lifecycle execution is `working`.

**F10 (shared with cursor F4). Tests, development command:
`test/install.test.ts` is listed under `vitest.config.ts`, which excludes it.**
Rule and failure: as in F4.
Smallest correction: run it with `--config vitest.system.config.ts`.

### Scope check

- All three plans stay inside the issue. None uses `set -g`, a custom wheel
  binding, a new file or a new dependency, and all keep the `owner-typing`
  gate code and its safety behaviour.
- All three reuse `launchAgent`, `agentClientAttachCommand`,
  `journalDeferral`/`DEFERRAL_RATIONALE`, `renderIssueReport`,
  `launcher_command()` and the existing test fixtures (`commandsIn`,
  `safetyFixture`, `installOnce`).
- The cursor plan widens scope into `src/cli.ts` and `src/interactive.ts` for
  the live status probe (F1). The codex plan widens test scope (F6).
- The claude plan is the smallest, but it misses resume (F8) and one clearing
  path (F9).

## Conclusion

No plan is acceptable exactly as written.

- **claude** and **codex** share the right design: the deferral state is
  persisted on `actionSafety`, the last notice time is stored, and the status
  line is derived from that state.
  - claude needs F8 (re-apply the options on resume, and correct the false
    rationale) and F9 (clear the wait on early returns).
  - codex needs F5 (probes clear but never write) and trimmed tests (F6).
- **cursor** has the most serious defects. Its live-probe status reports a
  "let coord send" wait when coord has nothing to send (F1), its bucketed
  repeat fires on the next poll (F2), and it omits `-q` for `pane-scrollbars`
  (F3).
- Every adopted plan should limit `pane-scrollbars` to the windows the issue
  names, plus inline Codex (F7). Its focused command should run
  `test/install.test.ts` under `vitest.system.config.ts` (F4/F10).

I recommend choosing between the claude and codex plans with the listed
corrections, ahead of cursor.
