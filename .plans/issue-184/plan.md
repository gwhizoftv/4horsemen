# Issue 184: Update configured agents before a fresh start

`coord start` (and `coord <n>` when no runtime exists yet) updates each agent
that will actually run, records the version that will run, then launches.
Attach, resume, and pane recovery do not update. The Codex launcher also
disables Codex's own startup self-update, which is what closes the pane
before `remain-on-exit` can keep it.

## Exact File List to be changed or deleted

- `src/cli.ts`
  - Add optional `CliDependencies.updateAgents`.
  - In the `startIssue` closure inside `runCli`, after the existing refusals
    (manual session, existing runtime, leftover tmux session, unreadable
    GitHub issue, invalid origin baseline, invalid trusted source commit) and
    before `prepareAgentIssueBranches`, call the updater on `roster` only.
    `roster` is already `agents.slice(0, 1)` for `solo` and the full resolved
    list otherwise — the same list later passed to `startEffects`.
  - Print one stdout line per roster agent, then pass the records into
    `initializeOperationalState` as `agentVersions`.
  - A failed update is a warning on stderr. It must not throw, so the existing
    start rollback does not treat it as a failed start.
  - `defaultStartEffects`, `defaultManualUi`, `attachIssue`, and `coord run` /
    numeric resume stay unchanged. They reach `TmuxController.startSession` or
    `ensureSession` and must not call the updater.
  - When `updateAgents` is omitted and `process.env.VITEST` is set, do not
    spawn and do not write `agentVersions`. That matches the existing
    `sessionExists` test default, which refuses to touch host tmux. Production
    (no `VITEST`) uses `updateConfiguredAgents`.
- `src/state.ts`
  - Add optional `agentVersions` to `startStateSchema`. Absent on a
    `start.json` written before this change still parses. Do not bump
    `RUNTIME_FORMAT_VERSION`.
  - `initializeOperationalState` copies `agentVersions` into the existing
    `started` journal `details` when the field is present. Callers that omit
    it keep `{ issue, profile }`.
- `scripts/lib/launcher.sh`
  - In `launcher_command` for `codex`, change the exec line to
    `exec codex -c check_for_update_on_startup=false --ask-for-approval never --sandbox workspace-write --no-daemon ${coord_grant[@]+"${coord_grant[@]}"}`.
  - No other vendor command changes. `githooks/post-merge` and
    `src/setupWorkspace.ts` already call `write_launcher` / `launcher_command`;
    do not edit the hook.
- `docs/coord-driver.md`
  - In the `coord start` sequence, state that a fresh start updates the roster
    before branch preparation and launch, warns and continues on failure,
    prints and stores versions, and that attach, resume, and pane recovery do
    not update.
  - Next to the existing `--no-daemon` sentence, state the
    `check_for_update_on_startup=false` flag and that an already generated
    `start-codex.sh` changes only when `coord install` or `githooks/post-merge`
    rewrites it.
- `test/cli.test.ts` — extend the CLI start/attach coverage.
- `test/install.test.ts` — extend the executed Codex launcher argv.
- `test/state.test.ts` — extend the existing start.json parse coverage.

## Exact file list to be created

- `src/agentUpdate.ts` — the only new production module. The timeout, kill,
  and version capture do not belong in `cli.ts` (command dispatch) or
  `codexQuota.ts` (Codex app-server JSON-RPC). No new dependency.
- `test/agentUpdate.test.ts` — direct tests of that module. No existing test
  file runs vendor update commands.

## Reuse and Scope

Reuse without changing:

- `resolvedAgents` and the `roster` split already computed in `startIssue`.
- `initializeOperationalState`, `appendJournal`, and the `started` event.
  `journalEventSchema.details` is already an open record, so no new journal
  event type.
- `startEffects` → `TmuxController.startSession` → `launchAgent` for the
  launch that follows the update.
- `RunLoop.restoreTerminals` → `TmuxController.ensureSession` for attach
  (`attachIssue`), resume (`RunLoop.run` / `initializeEffects`), and dead-pane
  relaunch. No new call in `src/tmux.ts`.
- `launcher_command` as the only vendor-flag source (`docs/repo-map.md`).
- The SIGTERM-then-SIGKILL shape in `readCodexQuota` is the pattern for the
  new bounded spawn. Do not call `readCodexQuota` or `runArgv`. `runArgv` has
  no timeout, and `resolvableStartGit` in `test/cli.test.ts` would `execFileSync`
  a real `codex update` if the updater went through `processRunner`.
- `test/install.test.ts` ("passes each harness exactly its own current drop"),
  `test/cli.test.ts` (`successfulStartGit`, `fakeLoop`, `setup`), and
  `test/state.test.ts` ("freezes a verification policy at start, and still
  parses a start.json written without one").

`src/agentUpdate.ts` exports:

- `AGENT_UPDATE_TIMEOUT_MS = 180_000` and `AGENT_VERSION_TIMEOUT_MS = 10_000`.
- `selectAgentUpdater(env)` — returns `updateConfiguredAgents` when `VITEST`
  is unset, otherwise `null`.
- `updateConfiguredAgents(agents, options?)`.

Command table, keyed by agent id, is the whole vendor surface:

| id | update | version |
| --- | --- | --- |
| `codex` | `codex update` | `codex --version` |
| `claude` | `claude update` | `claude --version` |
| `cursor` | `agent update` | `agent --version` |
| `antigravity` | `agy update` | `agy --version` |

Any other id, including `gemini`, does not spawn. Record
`update: "unsupported"`, `version: null`, `detail: "no update command for <id>"`.

Per roster agent, in order, cwd `agent.root`, sequential:

1. Run the update argv with `AGENT_UPDATE_TIMEOUT_MS`.
2. Always run the version argv afterward with `AGENT_VERSION_TIMEOUT_MS`,
   including when the update failed.
3. Never throw for a non-zero exit, spawn error, or timeout.

Antigravity's environment prepends `${HOME}/.local/bin` to `PATH`, matching
the `export PATH` already emitted for `agy` in `launcher_command`. Other
agents inherit the caller environment unchanged. Tests pass `home` so this
does not read the developer home directory.

Bounded spawn (default runner inside the module): stdin ignored; stdout and
stderr capped at 64 KiB, keeping the tail; on timeout, SIGTERM, then SIGKILL
after 1 second, then resolve. `detail` stored on the record is at most 500
characters.

Version text is the first non-empty trimmed line of stdout, or of stderr when
stdout is empty, and only when the version command exits 0. Otherwise
`version` is null.

Record shape, also the `start.json` array element:

```ts
{ id: string; update: "updated" | "failed" | "unsupported"; version: string | null; detail: string | null }
```

`update: "updated"` only for exit 0 before the timeout. `detail` is null when
the update exited 0 and a version line was recorded; otherwise it says which
step failed (timeout, exit code, or spawn error).

Stdout, one line per agent, with the trailing newline `io.stdout` already uses:

`Agent <id> version: <version or unknown> (update <updated|failed|unsupported>)`

Stderr, only when `update !== "updated"` or `version === null`:

`[WARN] <id>: <detail>; continuing with the current version.`

`coord manual` is out of scope. It uses `ensureSession` and must not update.

No `package.json` version bump. No edit under `githooks/`. No change to
`remain-on-exit`, terminal logs, or nudge behavior (those landed for the
exit-output half of this report in issue 199).

## Tests

`test/agentUpdate.test.ts` (new). The decision tests inject a
`BoundedCommandRunner` so they do not wait 180 seconds and do not spawn
vendor CLIs:

- Codex update exit 0 then `--version` stdout `codex-cli 1.2.3` records
  `{ update: "updated", version: "codex-cli 1.2.3", detail: null }` and does
  not spawn a second agent.
- Update exit 1 still runs `--version` and records `update: "failed"` with
  that version and a non-null detail.
- A runner that reports `timedOut: true` records `failed` and still requests
  the version command.
- Spawn error (`error` set, as for ENOENT) records `failed`, `version: null`
  when the version command fails the same way, and resolves rather than rejects.
- Agent id `gemini` performs zero runner calls and records `unsupported`.
- Antigravity's runner `env.PATH` starts with `${home}/.local/bin`.
- Two-agent roster preserves order and runs update-then-version for each
  before the next agent.
- `selectAgentUpdater({})` is `updateConfiguredAgents`;
  `selectAgentUpdater({ VITEST: "1" })` is `null`.
- One real spawn: `node -e "setInterval(() => {}, 1000)"` with `timeoutMs`
  200 resolves `timedOut: true` well under a second and does not leave the
  child running.

`test/cli.test.ts` — one new case on the existing `setup()` fixture, injected
`updateAgents`, `successfulStartGit`, and `fakeLoop`:

- `coord start` of a consensus issue calls the updater once with codex,
  claude, and cursor, writes those records to `start.json` `agentVersions`,
  copies them onto the `started` journal details, and prints
  `Agent codex version:`.
- A record with `update: "failed"` still lets start return 0 and writes a
  `[WARN]` line to stderr.
- `coord start --profile solo` calls the updater with only the first agent.
- After that start, `coord attach` and numeric `coord <n>` (existing runtime)
  do not call the updater again.
- A start that omits `updateAgents` under Vitest still returns 0 and leaves
  `agentVersions` unset, so current start tests keep passing.

`test/install.test.ts` — in "passes each harness exactly its own current
drop", the executed Codex argv becomes
`["-c", "check_for_update_on_startup=false", "--ask-for-approval", "never", "--sandbox", "workspace-write", "--no-daemon"]`
followed by the existing `--add-dir` grants. Claude, Cursor, and Antigravity
expected argv stay as they are.

`test/state.test.ts` — next to the verification-policy case: a `start.json`
without `agentVersions` still parses; a well-formed array round-trips through
`readStartState`; `update: "nope"` fails `startStateSchema`.

While developing, run:

```bash
pnpm vitest run test/agentUpdate.test.ts test/cli.test.ts test/install.test.ts test/state.test.ts
```

The commit hook owns `pnpm check:fast` (lint, typecheck, `test:fast`,
`test:system`). This change is product code plus `docs/coord-driver.md`, so
the hook keeps the product checks. Do not claim that hook run as a check
already performed. No e2e is required for this plan: launch flags are asserted
by executing the generated launcher in `test/install.test.ts`, and start does
not gain a tmux behavior.

## Alternatives Rejected

- Updating inside `ensureSession` or `startSession`. Both run for attach,
  resume, and dead-pane relaunch, so a recovery would change the version the
  run already recorded.
- Updating inside `start-<agent>.sh` before `exec`. Recovery relaunches that
  script, `set -e` would kill the pane when an update fails, and `coord start`
  must not rewrite launchers inside clones (`write_launcher` is install-time
  and post-merge only).
- Failing `coord start` when an update fails. The issue says warn and continue
  with the current version.
- Parallel updates. The issue says wait for each update to finish, and
  sequential output stays attributable to one agent. Worst case is one
  180-second timeout per roster agent.
- Routing the updater through `processRunner` / `runArgv`. That runner cannot
  time out, and the CLI test double executes unexpected argv on the host.
- Calling `readCodexQuota`. It speaks app-server JSON-RPC for one vendor and
  is capped at 10 seconds.
- A new journal event type. `started.details` already stores open JSON.
- Parsing versions as semver. Cursor reports values like
  `2026.10.01-e373342`; the first non-empty line is the recorded text.
- Suppressing Codex startup checks without `codex update`. The issue asks for
  both: update first, then launch with the startup check off so Codex does
  not update again inside the pane.

## Risks and Mitigations

- A fresh start can spend up to 180 seconds times the roster size before
  launch. Each agent has its own cap; failure continues; `solo` updates one
  agent.
- `codex update` replaces a shared binary other Codex processes may be using.
  Updates run only on a fresh start. Attach, resume, and pane recovery skip
  them, which is what keeps one run on one version.
- Clones that already have `start-codex.sh` keep the old flags until
  `coord install` or a post-merge rewrite. The doc states that, as it already
  does for `--no-daemon`.
- `agy` is not always on `PATH`. The antigravity spawn prepends
  `~/.local/bin`, the same prefix the launcher exports. A still-missing binary
  is ENOENT: warn, record `failed`, launch anyway.
- An updater that prompts cannot read stdin (stdin is ignored) and cannot
  hang past the timeout. The child is reaped with SIGTERM then SIGKILL.
- Vendor version text differs. The record stores one trimmed line, not a
  parsed number. A failed version command stores `null` and warns, and start
  still launches.
- Vitest skips the real updater when the dependency is omitted, so existing
  start tests do not download CLIs. `selectAgentUpdater` and the injected CLI
  test lock the production choice and the start-versus-resume split.
- An optional `agentVersions` field does not invalidate an older `start.json`.
  Unknown `update` values still fail the strict schema.

## Conclusion

A fresh start updates the four known CLIs for the roster that will run, waits
at most 180 seconds each, warns and continues on failure, prints the version
that will run, and stores it on `start.json`. Attach, resume, and pane
recovery do not update. Codex launches with
`-c check_for_update_on_startup=false` so it does not self-update again inside
the pane.
