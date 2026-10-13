# Issue 199 — Preserve tmux startup output and agent exit diagnostics

Owner-driven implementation on `issue-199/claude`. Adds diagnostics only: no
prompt answering, no new restart policy, launchers keep `exec`, and the existing
owner-driven recovery and pause/hold paths are unchanged.

## Exact File List to be changed or deleted

- `src/tmux.ts`
  - Every agent launch (`startSession` `new-window`, `ensureSession`
    `new-window` and dead-pane relaunch) first starts the pane on a silent,
    bounded placeholder (`sleep 60`; a dead pane is respawned onto it because
    tmux refuses to pipe a dead pane). The new private `launchAgent` then sends
    `set-option -w remain-on-exit on ; set-option -w @coord-log <log> ; pipe-pane 'cat >> <log>' ; respawn-pane -k <launcher>`.
    `respawn-pane` keeps the pipe, so retention and recording are in place
    before the agent exists, even if a tmux hook blocks the command queue.
    Without a log directory (manual sessions) only `remain-on-exit on` is set.
  - `#` in the `pipe-pane` command is doubled, because tmux expands formats in
    it; the piped file is then the literal path stored in `@coord-log`.
  - Per-run log `<terminalLogDir>/run-<UTC timestamp>.log`; never reused, and
    `cat >>` only appends, so a relaunch cannot overwrite earlier evidence.
  - New private `recordPaneExits(listArgs)`: reads
    `#{pane_dead}\t#{pane_dead_status}\t#{pane_dead_signal}\t#{pane_dead_time}\t#{@coord-log}`
    via `list-panes` and, for each dead pane with a log, writes
    `run-<id>.exit.json` beside that run's log (create-exclusive, never
    overwritten). Called before `respawn-pane` in `ensureSession` and before
    `kill-session` in `stopSession` / `killIssueSessions`.
  - `startSession(issue, agents, terminalLogDir?)` and
    `ensureSession(key, agents, assertAuthority, terminalLogDir?)` gain an
    optional `(agentId) => directory` callback; existing callers and test
    doubles stay valid.
  - `agentPlacementDiagnostics` also reads exit status/signal and `@coord-log`,
    reports the log location for live and exited panes, and states that exit
    details do not explain why the agent exited.
- `src/paths.ts` — add `terminalLogs` (`<issue>/agents/<agent>/terminal`) to
  `AgentRuntimePaths` so both callers share one location under the existing
  issue runtime.
- `src/cli.ts` — `defaultStartEffects` passes
  `(id) => agentRuntimePaths(paths, id).terminalLogs` to `startSession`.
- `src/runLoop.ts` — `restoreTerminals` passes the same callback to
  `ensureSession` (resume/attach relaunch path).
- `test/tmux.test.ts` — extend the existing `ensureSession` and placement
  diagnostics tests; add one isolated real-tmux test.
- `test/paths.test.ts` — one assertion for the new `terminalLogs` path.

## Exact file list to be created

- `.plans/issue-199/plan.md` (this plan; requested by the owner).

No product source files are created.

## Reuse and Scope

- Reuses `TmuxController`, `TmuxRunner`/`runTmux` (an isolated server is just a
  runner that prepends `-L <socket> -f /dev/null`), `resolveAgentLauncher`,
  `safeName`, `inspectPane`, and `agentPlacementDiagnostics` (already called
  by `RunLoop.reportStartup`).
- Reuses `agentRuntimePaths`/`containedPath` for the log directory and
  `shellQuote` from `src/agentHookSync.ts` for the `pipe-pane` command.
- The run's log path is stored in the tmux window user option `@coord-log`, so
  exit recording before respawn/kill needs no new state file or schema.
- Reuses the existing `test/tmux.test.ts` fixtures (`ok`, `commandsIn`, mock
  runners, `roots` cleanup).
- Out of scope (stays in #184): CLI self-update suppression and preflight
  updates. No change to restart policy, delivery gating, or launchers.

## Tests

- `test/tmux.test.ts` — **isolated tmux** (skipped when `tmux` is not
  installed): a private `-L` server runs launchers that print a startup line,
  switch to the alternate screen and clear it, then exit 0, exit 3, or
  `kill -KILL` themselves. Asserts each run's log keeps the startup line, each
  `.exit.json` records the right `status`/`signal`, relaunch writes a new log
  without altering the previous one, and `killIssueSessions` records the last
  run's exit before destroying the pane. The server carries a blocking
  `after-new-window` hook and the log directory contains `#{pane_id}`, so the
  test fails if recording starts after the agent or the pipe path is expanded;
  the log advertised by diagnostics must hold the run's output.
- `test/tmux.test.ts` — mock-runner assertions: launch command lists contain
  `remain-on-exit on` and `pipe-pane` in the same invocation; `list-panes`
  exit capture runs before `respawn-pane`; manual sessions get
  `remain-on-exit` without `pipe-pane`; diagnostics report status/signal and
  the log path.
- `test/paths.test.ts` — `terminalLogs` path.
- Commands: focused `pnpm vitest run test/tmux.test.ts test/paths.test.ts`
  while developing; the pre-commit hook runs `pnpm check:fast`.

## Alternatives Rejected

- **`pipe-pane` as a separate tmux call after `new-window`**: the agent can
  print and clear its dialogue, or exit, between the two calls.
- **Launcher plus settings in one tmux command list** (the first revision):
  an inherited `after-new-window` hook running a blocking `run-shell` pauses
  the queue, so the agent can exit before retention and the pipe are set
  (review of `3477c5a`).
- **Placeholder that blocks forever**: an interrupted launch would leave a
  live pane that recovery never relaunches; `sleep 60` exits and is relaunched.
- **Global `remain-on-exit` (`set -g`)**: leaks into the owner's other tmux
  sessions on the shared server.
- **One appended log per agent with marker lines**: mixes coordinator text into
  raw terminal bytes and makes run boundaries ambiguous.
- **New exit-state JSON in the issue runtime state files**: the `@coord-log`
  window option already ties a pane to its run, so no schema change is needed.

## Risks and Mitigations

- *Dead panes now stay visible* (`Pane is dead`) instead of the window closing.
  This is the issue's requirement; `ensureSession` already respawns dead panes
  and `agentPlacementDiagnostics` already reports them.
- *Logs grow with long sessions*: they are under the issue runtime and removed
  with it by `coord wipe`; a rotation policy is not requested.
- *Legacy windows without `@coord-log`* (sessions started before this change):
  exit recording is skipped for them; their respawn attaches logging from then on.
- *A coord crash between placeholder and agent launch*: the placeholder exits
  within 60 s and the pane is dead (or gone), so the next `ensureSession`
  relaunches it as before.
- *Older tmux without `pane_dead_signal`*: the field records as `null`; the
  status and log are still kept.

## Conclusion

Retain exited panes, pipe every agent run to its own log from the first byte,
and save tmux's exit status/signal beside that log before any respawn or
teardown, all within the existing `TmuxController` launch paths and issue
runtime layout.
