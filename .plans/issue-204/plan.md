# Issue 204: mouse scrolling and visible scrollback waits

Protocol version: 1. Plan for action `96a83097-2702-42db-b303-94c355dda911`, against issue baseline `855982b3f1639ec5bac7891f1c67f1e100dc2ab3`. Requirements come from the coordinator's frozen github-issue.json: enable local mouse scrolling and scrollbars, retain 50,000 history lines, launch Codex inline, and explain a continuing scrollback delivery wait in logs and status.

## Exact File List to be changed or deleted

Change these existing files; delete none:

| File | Change |
| --- | --- |
| `src/tmux.ts` | Apply session-local history and mouse settings in session creation/repair and Terminal attachment, and window-local scrollbars on agent windows. Preserve delivery gates and session ownership. |
| `scripts/lib/launcher.sh` | Add `--no-alt-screen` to the Codex command emitted by `launcher_command()`, preserving all existing flags and grants. |
| `src/state.ts` | Extend `actionSafetySchema` with an optional current scrollback-wait record containing observation and last-reminder timestamps. |
| `src/runLoop.ts` | Track and clear the current scrollback delivery wait, use the requested wording, and repeat its console notice at a bounded interval without duplicating journal evidence or sending input. |
| `src/issueReport.ts` | Render the current action's scrollback wait in the shared status report and provide the small shared message formatter used by the run loop. |
| `test/tmux.test.ts` | Extend session, attachment, and isolated-server coverage for settings, scope, ordering, and unsupported scrollbars. |
| `test/install.test.ts` | Update the existing executable generated-launcher argv test for the Codex flag in automated and manual modes. |
| `test/state.test.ts` | Cover legacy state without the optional wait record and persistence of the record through schema validation and disk round trips. |
| `test/runLoop.test.ts` | Cover wording, reminder timing across restarts, unchanged journal/send counts, and clearing/replacing the wait. |
| `test/issueReport.test.ts` | Cover the visible current wait and suppression of resolved, historical, or ineligible waits. |

## Exact file list to be created

No new product, test, fixture, dependency, or configuration files. This action creates only `.plans/issue-204/plan.md`, the required coordination artifact; implementation will use the existing files listed above.

## Reuse and Scope

### Scoped tmux options

Reuse `TmuxController.startSession()`, `ensureSession()`, `launchAgent()`, `agentClientAttachCommand()`, `agentAttachLaunches()`, `safeName()`, `TmuxRunner`, and the existing placeholder-before-launch sequence.

1. Set `history-limit 50000` and `mouse on` with explicit `set-option -t <coord-session>` commands. Run them after base session creation and before creating any agent window, so new agent panes inherit the history capacity. Apply the same settings when `ensureSession()` repairs an existing issue or manual session. Keep creation-time setup inside the existing cleanup boundary; preserve `assertAuthority()` checks after awaited operations in repair paths.
2. Apply `pane-scrollbars on` with `set-option -w -q -t <coord-session>:<agent-window>`. Configure new and respawned windows before launching the harness, and existing live windows before `ensureSession()` takes its early `continue`. This applies consistently to the agent windows, including Claude, Cursor, and inline Codex.
3. Extend `agentClientAttachCommand()` to set mouse and history on the explicitly named linked client session and scrollbars on its explicitly named agent window every time a Terminal client opens. Grouped sessions share windows but have separate session options, so configuring only the base session is insufficient. Preserve the quoted tmux command separators, per-agent focus, and `destroy-unattached` behavior. Small option-command builders within `src/tmux.ts` may be shared by creation/repair and attachment to avoid divergent settings; no general configuration framework is needed.
4. Never use `-g`, modify a user's tmux config, or install custom wheel bindings. Use `-q` only for the optional scrollbar option so an older tmux can still attach and launch agents. Required session settings retain normal error handling; do not blanket-ignore command failures.

The [tmux manual](https://man.openbsd.org/tmux.1#OPTIONS) documents the session/window option scopes and quiet handling of unknown options. Its [scrollbar entry](https://man.openbsd.org/tmux.1#pane-scrollbars) describes `on` as an always-visible scrollbar. These settings are local to coord-owned sessions and windows.

### Codex launcher

Modify only the `codex)` arm of the shared `launcher_command()` template. Keep `--no-daemon`, disabled startup self-update, workspace-write sandbox, approval mode, and mailbox/input/worktree grants intact. Both workspace setup and post-merge generation already use this template; generated `start-codex.sh` files and the product hook tree must not be edited. Local `codex --help` for the installed 0.162.1 CLI confirms that `--no-alt-screen` preserves terminal scrollback by using inline mode.

### Current wait, recurring notice, and status

Reuse the existing `owner-typing` refusal code: `inspectPane()` derives it from tmux's `pane_in_mode`, and `injectionGate()` already blocks automated input. Keep this machine-readable code and its safety behavior. Use the exact human sentence `the <agent> pane is scrolled back; scroll to the bottom to let coord send`, substituting the agent ID, in both the log and report. A small exported formatter in `src/issueReport.ts` fits the existing import direction from the run loop and prevents wording drift.

Add an optional `scrollbackWait` record to each action's existing safety state, with `observedAt` and `lastReminderAt` validated using `timestampSchema`. Absence means no current wait; the enclosing `actionId` provides correlation. Optional state preserves old runtimes and existing typed fixtures without a format-version change. This is operational display state, not a new workflow hold, readiness signal, or delivery permission.

In `journalDeferral()`, update the current scrollback state and decide whether to log before the existing `deferrals.includes(code)` early return. Log the first observed wait immediately, then repeat at most once per 180,000 ms while current observations still confirm it. Persist `lastReminderAt` using the existing cursor mutation/authority path, so restarting the coordinator does not restart the reminder clock. Leave the unique `nudge-deferred` event and `deferrals` collection deduplicated per action/code; recurring notices are console output, not extra journal events. Other refusal codes retain their present logging behavior.

Use existing pane observations in `observeUnfinished()` and subsequent delivery outcomes to refresh or clear an established wait; no new polling loop, timer, or tmux probe stream is needed. An observation alone must not create a delivery wait merely because an actively working agent is being scrolled. Clear the record when a fresh successful inspection shows mode exited, a delivery attempt reports another blocker or succeeds, the action is acknowledged/completed/retired, or its identity changes. Unavailable inspection must not produce a reminder claiming newly confirmed scrollback. Process clearing before lifecycle early returns where needed, so an old copy-mode refusal cannot remain the displayed current blocker after recovery.

Only repeat for an active, ordered, unanswered action that is still waiting for delivery, with no pause/hold preventing that delivery. Suppress or retire the notice for a completion receipt, accepted work, dropped agent, replacement action, or finished/abandoned issue. Keep all existing lifecycle, reservation, retry-budget, and mid-send gates intact. Do not cancel copy mode or send keys to fix scrolling automatically.

`renderIssueReport()` already powers both `coord status` and interactive `s`. Read the optional current record there, checking roster membership, matching action ID, ordered state, and applicable lifecycle completion/acceptance before showing the shared sentence. Do not infer a live wait from the historical `deferrals` array. A paused report may label an existing observation as the last observed scrollback wait rather than implying that scrolling alone resumes delivery. Status remains a read-only snapshot of coordinator observations; it does not probe or mutate tmux.

Reuse `test/tmux.test.ts`'s `ok`, `commandsIn`, injected runners, temporary launcher roots, and isolated `-L` server pattern; `test/install.test.ts`'s `product`, `installOnce`, and stub harness argv capture; `test/runLoop.test.ts`'s `safetyFixture`, mutable `ui.busy` flag, injected clock, `advance`, `tick`, journal reads, and restart-per-tick behavior; `test/state.test.ts`'s `initialize`; and `test/issueReport.test.ts`'s `start`/`complete` fixtures. No new fixtures or public abstractions are required.

## Tests

Add or extend the following focused cases in the mapped existing files:

1. **Tmux creation, repair, and attachment (`test/tmux.test.ts`):** assert mouse/history settings target both base and linked client sessions; history is configured before the first agent `new-window`; each agent window gets scrollbar settings on new, dead, and already-live paths; manual sessions retain their environment isolation. Update exact attach-command expectations. Assert no global option or binding commands. Exercise the unsupported-scrollbar path without suppressing required-option failures. Extend the existing isolated-server test to inspect actual agent `history_limit`, effective local options, and unchanged options in an unrelated session. Keep the same test's isolated-server cleanup; never target the operator's server.
2. **Launcher (`test/install.test.ts`):** extend `passes each harness exactly its own current drop, and nothing in manual mode` to expect exactly one `--no-alt-screen` for Codex, with all other argv and grants preserved. Its real shell execution covers both template generation and quoting.
3. **Durable timing and recovery (`test/runLoop.test.ts`):** with `safetyFixture`, block an unsent action via the fixture’s busy flag, assert the exact sentence immediately, advance to just before and then to the three-minute boundary, and assert a single repeat despite intervening ticks and fresh run-loop instances. Assert one journal refusal and zero sends while blocked. Leave copy mode and verify the notice clears and ordinary safe delivery proceeds; re-enter a qualifying wait in the same action and verify a new episode can report immediately despite historical deduplication. Cover a transition to a different blocker, action replacement/completion, and failed observation without spurious reminders. Preserve the existing foreground-mismatch once-across-restarts test.
4. **State and report (`test/state.test.ts`, `test/issueReport.test.ts`):** validate legacy absent-field parsing and timestamp round trips; render an active correlated wait and suppress it for stale action IDs, resolved records, inactive agents, accepted work, and completed issues. Verify both callers benefit from the existing shared report without adding CLI plumbing.

The new assertions fail against the baseline's absent settings/flag, one-time generic refusal, and missing status state. Keep them inside these suites instead of duplicating the implementation in new test files.

Development commands, verified against the actual package scripts and Vitest configurations:

```sh
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/runLoop.test.ts test/state.test.ts test/issueReport.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts -t 'passes each harness exactly its own current drop'
bash -n scripts/lib/launcher.sh
```

The current runtime config declares `pnpm run check:fast` for product precommit and `pnpm run test:e2e` for product prepush. Let the installed hooks own those checks; do not manually duplicate the mandatory suite just before commit. Frozen start.json declares the coordinator's final check as `pnpm run check`, which includes build, fast/system tests, and e2e. If a later action enables coordinator-owned candidate verification, cite its recorded results and follow that action's allocation. This planning submission needs only heading, scope, evidence, and artifact validation; no product test suite is claimed as run.

## Alternatives Rejected

- Global tmux options or wheel bindings would affect unrelated sessions and exceed the issue's explicit scope.
- Setting only the base session misses the independently configured Terminal client sessions; setting history only after window creation risks missing the new pane's history allocation.
- Editing generated launchers duplicates the authoritative template and loses the flag on regeneration.
- Removing the copy-mode gate or automatically cancelling it could interrupt the operator and misdirect input.
- Removing all deferral deduplication floods logs/journal on every poll. In-memory reminder timing resets on every restart. Historical deferral codes alone cannot describe a current status wait.
- A generic notification scheduler, extra runtime file, new dependency, or new CLI status path is unnecessary for one recurring condition.

## Risks and Mitigations

- Older tmux may lack `pane-scrollbars`; limit quiet fallback to that option. Mouse and history still work, and tests distinguish optional capability handling from real setup failures.
- Existing panes may retain their old allocated history on tmux versions that apply history depth only when panes are created; set the limit before all new agent panes, reapply settings on resume, and never restart live work merely to enlarge history. Already-discarded output cannot be recovered.
- An always-visible scrollbar reduces pane width and can reflow output. This is the issue's requested `on` behavior; retain readiness/capture regression coverage.
- Repeated notices must neither consume nudge budget nor authorize a retry. Persist only display timing, preserve authority checks, and assert no sends while copy mode is active.
- Stored observations can become stale between polls or while coord is stopped. Clear on observed recovery and action lifecycle changes; label paused observations accurately and do not treat an old journal code as current pane evidence.
- More retained output consumes more memory. The explicit 50,000-line cap stays local to coord sessions instead of increasing the server default.

## Conclusion

Implement the ten-file change above using the existing tmux, launcher, delivery-state, and shared-report paths. Agents gain scoped mouse scrolling and larger history; Codex runs inline; an actual scrollback delivery wait becomes visible immediately, every three minutes while it continues, and in status. Existing input-safety gates, unrelated tmux sessions, and the workflow protocol retain their behavior.
