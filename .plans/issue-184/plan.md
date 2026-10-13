# Issue 184 implementation plan

Protocol version: 1. Agent: codex. Planning action: bd217bd0-5b65-4e83-a4c2-000059732f31.
Issue session: issue-184:0e0a07b93b61be5f76224650468d50c3bbf06d5d.
Baseline: 0e0a07b93b61be5f76224650468d50c3bbf06d5d.
Automation digest: a934160294fc6019916a22eaaefbd640f9d4966af45eed4e58ba9535a8df5b45.

On a fresh automated run, finish bounded update attempts for the selected agents,
then obtain, print, and persist their installed versions before launching any
agent. Failures warn and allow startup to continue. Existing-run commands do not
update agents. Every generated Codex launch disables its startup update check.

## Exact File List to be changed or deleted

Change these nine existing files; delete none:

| File | Change |
| --- | --- |
| `src/cli.ts` | Add the small vendor-command table and fresh-start maintenance helper; call it only from `startIssue`, using the selected roster and the existing injected process runner. Print versions and pass the resulting map into initialization. |
| `src/runLoop.ts` | Extend `ProcessRunner`/`runArgv` with optional bounded-execution options needed for update/version commands, including an environment override. Existing calls retain their current behavior. Do not add maintenance to run-loop effects. |
| `src/state.ts` | Add optional `agentVersions` to `startStateSchema`, mapping agent IDs to nonblank version strings or null for unknown. Reuse the derived `StartState` and `StartStateInput` types and existing atomic initialization. |
| `scripts/lib/launcher.sh` | Add `-c check_for_update_on_startup=false` to the canonical Codex command, preserving its other flags and grants. |
| `test/cli.test.ts` | Extend existing startup/recovery fixtures with vendor stubs and focused ordering, roster, failure, version-persistence, and no-repeat regressions. |
| `test/runLoop.test.ts` | Add focused tests of the production `runArgv` timeout/cleanup path using harmless local child processes. |
| `test/state.test.ts` | Extend start-state schema coverage for the optional version map, unknown versions, and legacy state without the field. |
| `test/install.test.ts` | Extend the existing real generated-launcher argv test to require Codex's suppression setting and preserve existing flags/grants. |
| `docs/coord-driver.md` | Document fresh-start update timing, warnings, version recording, skipped recovery updates, and regeneration of existing Codex launchers. Correct the nearby startup ordering description to match state creation before agent launch. |

## Exact file list to be created

None for the implementation. The maintenance policy fits in the existing CLI
startup code; process execution and runtime serialization already have owners.
No dependency, configuration file, separate version manifest, or new test fixture
file is needed. The implementation writes the additional field through the
existing runtime initialization rather than adding a runtime file.

## Reuse and Scope

Reuse `runCli`'s `startIssue`, `resolvedAgents`, selected `roster`, `runner`,
`CliIo`, `prepareAgentIssueBranches`, and `startEffects`. Both explicit start and
the fresh branch of numeric dispatch already call `startIssue`. An existing
numeric run, `attachIssue`, resume/run, and `CoordinatorRunLoop.restoreTerminals`
do not, which provides the update boundary without a persisted “already updated”
flag or a check on every recovery.

Reuse `ProcessRunner`, `ProcessResult`, and `runArgv` in `src/runLoop.ts` rather
than introducing a second subprocess framework. Its current argv-based spawn
ignores stdin but has no timeout. Give it an optional third options argument;
existing two-argument test runners remain assignable. Bound only opted-in calls,
preserving ordinary commands and `hermeticGitEnv` behavior. The lifecycle ideas
in `readCodexQuota` (`src/codexQuota.ts`) are relevant precedent, but its app-server
protocol and account binding must not be reused for vendor maintenance.

Reuse `startStateSchema`, `initializeOperationalState`, `atomicWriteJson`, and
`readStartState` for the version snapshot. Keep runtime format 4 and make the new
field optional so older `start.json` files remain readable. The field is an
observation, not an automation-digest input, a quota `validatedVersion`, or
containment attestation.

Reuse `launcher_command` and `write_launcher` in `scripts/lib/launcher.sh`, plus
the existing `writeAgentLauncher` install/regeneration path. Do not edit
generated untracked launchers, owner-global vendor settings, or product hooks.

The exit-output part of the issue already has implementation at this baseline:
`TmuxController.launchAgent` in `src/tmux.ts` configures `remain-on-exit` and
`pipe-pane` on a placeholder before `respawn-pane`; recovery records previous
exit details before relaunch. Preserve that implementation and reuse the
existing `test/tmux.test.ts` cases “ensureSession recreates missing agent windows
and respawns a dead pane” and “keeps cleared startup output and exit details
across relaunch and teardown.” No additional retention mechanism is needed.

Reuse `setup`, `successfulStartGit`, `resolvableStartGit`, `fakeLoop`, and the
`startEffects` injection in `test/cli.test.ts`; reuse `initialize` in
`test/state.test.ts` and the stub binaries, `CAPTURE`, temporary home, and
`installOnce` in `test/install.test.ts`. In particular, intercept vendor argv
before `resolvableStartGit` reaches its real `execFileSync` fallback: tests must
never update the developer's installed agents.

Implementation sequence:

1. Add optional `timeoutMs` and `env` execution options to the existing runner.
   Bounded calls drain both output streams while retaining at most 64 KiB of
   diagnostics. On supported Unix hosts, start a separate process group and
   terminate that group on timeout so a spawned installer cannot continue
   updating after the caller moves on. Use a short TERM-to-KILL cleanup interval,
   await child closure, clear timers/listeners on all terminal paths, and return
   an explicit timeout failure rather than reporting a killed process as success.
   Do not implement the timeout as an uncancelled `Promise.race`. Ordinary runner
   calls without the options preserve their existing process behavior.
2. After the existing fresh-start validation and branch preparation, and before
   `initializeOperationalState`/`startEffects`, run maintenance once for each
   selected agent, sequentially. Use a 60-second update timeout plus at most a
   one-second termination grace. Log which agent is being updated before waiting.
   The table is codex -> `codex update`, claude -> `claude update`, cursor ->
   `agent update`, antigravity -> `agy update`. Execute argv directly in the
   agent's resolved clone directory, using the normal owner environment; for
   Antigravity, match the launcher's home-local-bin PATH precedence. Do not use
   `harnessProcess` as an executable or treat a custom agent ID as a shell command.
   Unknown/custom agents get a warning and an unknown version without a guessed
   updater. Nonzero exits, missing executables, timeouts, and thrown launch
   errors are caught per agent, warn with a short diagnostic, and do not prevent
   attempts for later agents or startup with the available installation.
3. After all update attempts settle, query every supported selected executable
   with `--version`, using the same cwd/environment and a five-second timeout
   plus the same cleanup bound. Keep the trimmed reported version rather than
   trying to infer it from updater messages. Failed, empty, or missing version
   output produces a warning and null, printed as “unknown.” Print one version
   line for each selected agent and pass exactly that roster's map as
   `agentVersions` to initialization. Persist it before any `startEffects` call
   so SessionStart hooks cannot race version-state creation. Do not rewrite the
   snapshot or run maintenance on attach, resume, numeric continuation, run-loop
   recovery, or manual mode.
4. Add Codex's suppression override to the single launcher template so first
   launch and regenerated-pane launch both receive it. Preserve `--no-daemon`,
   approval/sandbox options, and narrow mailbox/input grants. There is no update
   command in any launcher, tmux method, or recovery loop.

The command table follows the issue and the vendor references inspected during
planning: [Codex update](https://learn.chatgpt.com/docs/cli/reference#codex-update),
[Claude update](https://code.claude.com/docs/en/setup#update-manually),
[Cursor update](https://cursor.com/docs/cli/installation#updates), and
[Antigravity installation/version](https://www.antigravity.google/docs/cli/install/).
OpenAI documents the startup-check setting in its
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
Support can vary by installation; unsupported update commands take the same
warning-and-continue path rather than invoking a guessed package-manager fallback.

## Tests

Add the following focused coverage to the files in the map. All vendor commands
are simulated; no real installation or network update is part of verification.

1. In `test/cli.test.ts`, extend startup coverage with a deferred injected updater:
   neither version probing nor `startEffects` may happen while an update is
   pending; all updates precede version probes, and the printed/persisted map is
   available inside `startEffects`. Exercise both explicit and numeric fresh
   entry points, the four command mappings, and a solo roster excluding unused
   configured agents. These fail before the feature because no maintenance or
   recorded versions exist.
2. In `test/cli.test.ts`, use a small parameterized failure case for nonzero,
   thrown/missing, and timeout results, plus an empty/failed version probe. Assert
   warnings, later-agent execution, startup continuation, and null instead of
   a fabricated version. Include an unsupported custom agent without guessing
   a command. Extend the existing attach/resume/numeric-continuation cases with
   a runner that fails the test if maintenance is requested and verify the
   original version snapshot remains byte-for-byte unchanged. Reuse existing
   pane-recovery coverage rather than duplicating tmux fixtures.
3. In `test/runLoop.test.ts`, exercise the production bounded runner with local
   Node children: successful output, spawn failure, and a hanging process with
   an inheriting descendant. The timeout case must finish within the bound,
   report failure, and leave neither process able to write a delayed marker.
   Include large-output draining/capping in that case; clean up fixture children
   even when an assertion fails. Keep a success assertion without options to
   protect existing callers. This tests real cancellation, not only mocked
   timeout labels.
4. In `test/state.test.ts`, round-trip a version map containing a known string
   and null, reject blank/malformed entries, and keep the existing initializer
   fixture working with the field absent. In `test/install.test.ts`, extend
   “passes each harness exactly its own current drop, and nothing in manual
   mode” to assert the two Codex override argv tokens in a real rendered launcher,
   retaining its existing exact flag/grant assertions. Also exercise Codex with
   an empty grant array through that same fixture.

Focused implementation commands, taken from the actual Vitest configurations:

```sh
pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts test/install.test.ts
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/state.test.ts test/tmux.test.ts
```

The existing isolated-tmux regression is conditional on tmux being installed;
report a skip explicitly rather than claiming live retention verification.
The workspace's declared precommit hook runs `pnpm run check:fast` (lint,
typecheck, fast and system tests), and prepush runs `pnpm run test:e2e`. Do not
manually duplicate those suites immediately before their hooks. The coordinator
owns the final configured `pnpm run check` at the approved pin. If a later action
switches verification ownership, follow its recorded candidate results and
instructions. This plan publication itself needs only digest, headings, exact
file-map, and artifact validation; no product test suite is required now.

## Alternatives Rejected

- Updating inside launchers or `ensureSession`: repeats updates on recovery and
  allows the installed version to move during an existing issue.
- Updating every configured agent before applying the profile: a solo run would
  change installations it will not use.
- Starting update tasks in the background or merely racing a timer: agents could
  launch while their executables are still being replaced.
- New updater modules, a second process-runner abstraction, configuration knobs,
  package-manager fallbacks, or a separate manifest: the existing startup,
  runner, and state seams cover this issue without those additions.
- New tmux retention work: the baseline already retains panes and records
  startup output and exit details, with a real tmux regression.

## Risks and Mitigations

- A vendor's updater can be unavailable, interactive, offline, or unable to write
  its installation. Ignored stdin, a real process timeout, per-agent warnings,
  and continued version probing preserve the requested fallback. Report the
  installation observed after the attempt; do not claim update success means a
  particular new release was installed.
- Killing only the immediate CLI can leave an installer child changing files
  after launch. Terminate the bounded command's process group and verify cleanup
  with a descendant fixture before proceeding to version collection.
- Extending the shared runner could affect unrelated commands. Keep all limits,
  environment changes, and process-group behavior opt-in; preserve Git's
  hermetic environment and test an existing call without options.
- Newly recorded versions must not break older resumable runs. The field stays
  optional under the existing strict schema and absent data stays unknown;
  recovery does not fill it by silently running updates or rewriting history.
- Tests could execute installed vendor tools through a permissive fixture.
  Stub both update and version commands before enabling startup calls, especially
  in `resolvableStartGit`, and run only harmless processes in timeout tests.
- Generated launchers in existing installations are not tracked and do not
  change simply because the template changed. Document regeneration through the
  established install path; do not overwrite owner customizations at each start.
- The snapshot describes the executable observed at fresh start. Skipping
  coordinator updates preserves that lifecycle boundary but does not pin binary
  files against an owner, another workspace, or a vendor's independent updater.
  Installation isolation and suppressing every vendor's auto-updater are outside
  this issue's requested Codex suppression and fresh-start update sequence.

## Conclusion

Implement fresh-run update/version preparation at the existing startup boundary,
persist an optional version snapshot before launch, and disable Codex's startup
update check in the canonical launcher. Nine existing files cover behavior,
focused regressions, compatibility, and documentation; no new product files,
dependencies, hook changes, version bump, or duplicate exit-retention code are
needed.
