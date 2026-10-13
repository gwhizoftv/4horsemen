# Issue 184 plan — update agent CLIs once at `coord start`, suppress Codex's launch-time self-update

## Summary

Issue 184 has two halves. The "agent windows lose exit output" half already
shipped in issue 199 (`3477c5a`, `febb022`): `TmuxController.launchAgent` sets
`remain-on-exit`, pipes every pane to a per-run log, and `recordPaneExits`
saves tmux exit details. This plan does not touch that code.

The remaining half is the cause of the vanishing Codex window. Codex checks for
an update when it launches, self-updates, and replaces its own process in the
pane. The fix the issue specifies has two parts:

1. **Suppress the launch-time check** by adding
   `-c check_for_update_on_startup=false` to the Codex launch line.
2. **Update deliberately, only at `coord start`.** For each rostered agent, in
   roster order, run its vendor update command with a timeout and wait for it to
   finish. If an update fails or times out, print a warning and continue on the
   installed version. Then read `<cli> --version`, print the versions that will
   run, and record one journal event per agent. Only after that are the agents
   launched.

Attach, resume, and pane recovery never run the update. All of them go through
`TmuxController.ensureSession` (`src/runLoop.ts:1129`, `src/cli.ts:634`).
`startIssue` is the only caller of `startEffects` (`src/cli.ts:1006`), so
placing the update inside `defaultStartEffects` limits it to a fresh start by
construction. That keeps every agent in a run on the same version.

| Agent id      | Update argv          | Version argv            |
|---------------|----------------------|-------------------------|
| `claude`      | `claude update`      | `claude --version`      |
| `codex`       | `codex update`       | `codex --version`       |
| `cursor`      | `agent update`       | `agent --version`       |
| `antigravity` | `agy update`         | `agy --version`         |

An agent id with no entry (for example `gemini`) is recorded as `skipped` and
launched unchanged. The child environment prepends `$HOME/.local/bin` to `PATH`,
just as the Antigravity launcher line in `scripts/lib/launcher.sh` does. Without
it, `agy` would not be found here even though the launcher finds it.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh` — `launcher_command codex`: insert
  `-c check_for_update_on_startup=false` right after `exec codex`. Add a
  one-line comment citing issue 184: the update now happens once at
  `coord start`, and a self-update at launch replaces the pane's process. No
  other vendor line changes.
- `src/cli.ts` — in `defaultStartEffects`, call
  `updateAgentHarnesses({ paths, agents, log })` before
  `tmux.startSession(...)`. Nothing else in the file changes: the
  `startEffects` dependency signature stays the same, and resume and attach keep
  their current paths.
- `src/state.ts` — add `"agent-version"` to `journalEventTypeSchema`. It is the
  only schema change. The event uses the existing optional `agent` field and the
  free-form `details` record.
- `test/install.test.ts` — extend the existing test "passes each harness
  exactly its own current drop, and nothing in manual mode". Its `expected.codex`
  argv becomes
  `["-c", "check_for_update_on_startup=false", "--ask-for-approval", "never", "--sandbox", "workspace-write", "--no-daemon"]`.

## Exact file list to be created

- `src/agentUpdate.ts` — one exported function plus its types and constants:
  - `AGENT_UPDATE_COMMANDS: Readonly<Record<string, { update: readonly string[]; version: readonly string[] }>>`:
    the table above.
  - `AGENT_UPDATE_TIMEOUT_MS = 180_000` and `AGENT_VERSION_TIMEOUT_MS = 15_000`.
  - `type TimedRunner = (argv, cwd, timeoutMs) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }>`.
    The default implementation is `execFile` with `timeout`, stdin ignored, and
    the `$HOME/.local/bin` PATH prefix.
  - `updateAgentHarnesses({ paths, agents, log, run = defaultTimedRunner }): Promise<AgentVersionRecord[]>`
    works through the agents one at a time:
    1. Run the update command in `agent.root`.
    2. On a non-zero exit or timeout, log
       `WARNING: <agent> update <failed (exit N)|timed out after Ns>: <first stderr line>; continuing with the installed version.`
    3. Run the version command and keep the first non-empty stdout line, or
       `null` if that fails.
    4. Call `appendJournal(paths, { type: "agent-version", agent, details: { update: <argv joined>, outcome: "updated" | "failed" | "timed-out" | "skipped", version } })`.

    After the loop it logs `Agent versions for this run:` followed by one
    `  <agent>: <version|unknown>` line per agent.

    It never throws because of an update, a version probe, or an unknown agent.
    Only a journal write failure propagates, and `startIssue` already rolls the
    runtime back when start effects throw.

  This needs a new file because no existing module owns vendor-CLI process
  management. `src/tmux.ts` is pane transport. `src/codexQuota.ts` handles the
  Codex app-server protocol only. `src/cli.ts` is 1,620 lines of argument and
  flow handling, and putting the logic there would leave it testable only
  through the real tmux path, which every CLI test replaces.
- `test/agentUpdate.test.ts` — the focused cases listed under Tests. A new file
  because the module is new, and the CLI tests always replace `startEffects`, so
  they never reach this code.

## Reuse and Scope

Reused, not reimplemented:

- `appendJournal`, `JournalEventInput`, and `readJournal` (`src/state.ts`) for
  durable recording. The tests read the events back with `readJournal`.
- `createIssueRuntime` and `issueRuntimePaths` (`src/paths.ts`) for the temp
  runtime in tests. This is the same fixture pattern as
  `test/agentEvent.test.ts:47-48` and `test/agentLanguage.test.ts:44-45`.
- `AgentConfig` (`src/state.ts`): only `id` and `root` are read.
- `defaultStartEffects` and the existing `startEffects` dependency seam
  (`src/cli.ts:100`, `src/cli.ts:728-732`). Because every CLI test already
  replaces start effects, no test can run a real `claude update`.
- The existing generated-launcher argv test in `test/install.test.ts` for the
  Codex flag.
- The existing install drift detection: `writeAgentLauncher`
  (`src/setupWorkspace.ts:479`) rewrites a launcher whose render differs, and the
  install digest covers `scripts/lib/launcher.sh`. Existing clones pick up the
  flag on the next `coord install`, and `coord doctor` flags clones that haven't.

Out of scope:

- The exit-output and pane-logging work from issue 199.
- Owner configuration for opting out of updates, per-agent timeouts, and
  parallel updates (see Alternatives Rejected).
- Updates inside `ensureSession`, attach, resume, or manual mode.
- Version bumps (per AGENTS.md, the `0.0.N` bump happens only on the PR into
  `main`).
- Documentation pages, unless a reviewer finds an existing doc that describes
  the `coord start` sequence step by step.

## Tests

All in-repo tests in `test/agentUpdate.test.ts` use a stub `TimedRunner` that
records `(argv, cwd, timeoutMs)` and returns scripted results. No real vendor
CLI ever runs.

1. **Updates, then records versions, in roster order.** Roster: `claude`,
   `codex`. The runner sees exactly `claude update`, `claude --version`,
   `codex update`, `codex --version`. Each call uses `cwd === agent.root` and
   the update and version timeouts respectively. `readJournal(paths)` contains
   two `agent-version` events with `outcome: "updated"` and the stubbed version
   strings. The log contains `Agent versions for this run:` and both lines.
   *Fails before the change:* the module and the journal type don't exist.
2. **A failure or timeout warns and continues.** Claude's update returns exit 1
   with stderr `network down`, and Codex's update returns `timedOut: true`.
   Neither causes a throw. Both still get a version probe. The log contains one
   `WARNING: claude update failed (exit 1): network down; continuing…` line and
   one `WARNING: codex update timed out…` line. The journal outcomes are
   `failed` and `timed-out`, and the versions are still recorded.
3. **Unknown agent and failed probe.** An agent `gemini` gets no runner calls,
   `outcome: "skipped"`, and `version: null`. A `--version` call with a non-zero
   exit records `version: null` and logs `unknown`.

Also: the extended `test/install.test.ts` launcher argv case. It fails before
the change because the Codex argv lacks `-c check_for_update_on_startup=false`.

That attach, resume, and recovery skip the update needs no new test. It follows
from where the call is placed (only `startIssue` calls `startEffects`), and a
CLI test could only check a stubbed `startEffects`, which would prove nothing
about the default.

Commands: run `pnpm vitest run test/agentUpdate.test.ts test/install.test.ts`
while developing. The pre-commit hook owns `pnpm check:fast`. The coordinator
owns the final `pnpm run check`.

## Alternatives Rejected

- **Run `<cli> update` inside the generated launcher.** Every pane respawn
  (recovery, attach repair) runs the launcher too. That would update in the
  middle of a run and break the issue's version-consistency rule. Passing an
  "update now" environment variable only at start would also need tmux
  environment plumbing per launch.
- **Update in `startIssue` itself, outside `startEffects`.** CLI tests replace
  start effects but not `startIssue`, so a default updater there would run real
  vendor updates in the test suite unless another dependency were added.
  Placing it in `defaultStartEffects` gets that isolation for free.
- **Update in parallel.** `claude` and `codex` may both be global npm installs.
  Concurrent global installs can conflict, and interleaved output is harder to
  read. Sequential worst case: about 3 × 180 s for three agents, and only at
  start.
- **Record versions in `start.json`.** That needs a `startStateSchema` and
  format change, and `start.json` is written before the update runs. Journal
  events are append-only, already timestamped, and already read by analytics.
- **Rely only on Codex startup suppression.** The window would stop vanishing,
  but agents would drift onto stale versions indefinitely. The issue asks for
  both.
- **Make updating configurable now.** Nothing in the issue asks for an opt-out.
  This is speculative flexibility.

## Risks and Mitigations

- **A vendor update hangs or prompts.** stdin is ignored, and `execFile`
  `timeout` kills the child at 180 s. The run then continues on the installed
  version with a warning (Test 2).
- **The update resolves a different binary than the launcher.** Launchers run
  `nvm use` from the clone's `.nvmrc`, while `coord` runs under its own Node.
  For npm-installed CLIs, the global under coord's Node could differ from the
  one the pane uses. Mitigation: the printed and journaled version is what the
  coordinator's PATH resolves. If it differs from what the pane runs, the
  difference is visible in the startup output, and that surfaces the
  misconfiguration rather than hiding it. The `$HOME/.local/bin` prefix matches
  the only PATH change the launchers make for agy.
- **The vendor command name or flags differ from the issue's table.** Each
  command is one entry in `AGENT_UPDATE_COMMANDS`, and an unknown or rejected
  update only warns. Startup never fails because of it.
- **Existing clones keep the old Codex launcher.** `coord install` rewrites
  launchers whose render differs. The launcher template is part of the install
  digest, which `coord doctor` checks.
- **Start takes longer.** Updates run only on a fresh `coord start`, and each
  probe is bounded by its timeout.
- **The journal schema is strict.** Adding one enum member is additive. Older
  journals stay valid, and no reader switches exhaustively over event types.

## Conclusion

The plan adds `-c check_for_update_on_startup=false` to the Codex launcher. It
adds a small `src/agentUpdate.ts`, called only from `defaultStartEffects`, that
updates each rostered agent once at `coord start`, waits with a timeout, warns
and continues on failure, and prints and journals the versions that will run
before any pane launches. Attach, resume, and recovery are untouched, which
keeps one version per run. It changes three files, creates two, adds one
journal event type, and adds three focused tests plus one extended launcher argv
assertion.
