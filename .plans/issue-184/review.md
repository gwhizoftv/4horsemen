# Issue 184 plan review

Pins reviewed:

- claude `c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd`
- codex `7b72a1c74d198d6aba1ebf32fb66e954f08f86a4`
- cursor `bb5e9f701556f3bcb49f2a4897a52b26c210c4c3`

## Findings

### Claude `c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd` — update inside `defaultStartEffects`

Plan claim: Summary and Exact File List. `updateAgentHarnesses` runs inside `defaultStartEffects`, before `tmux.startSession`, and that placement limits updates to a fresh start because only `startIssue` calls `startEffects`.

Rule: The roster's update attempts must finish before any pane for that run is launched. Once `start.json` exists, `coord <n>` and `coord attach` take the existing-runtime path and launch through `ensureSession`.

Failure: `initializeOperationalState` writes `start.json` before `startEffects`. `matchesConfig` treats that file as a live issue. A second `coord <n>` or `coord attach` while the first process is still inside the 180-second update calls `RunLoop.restoreTerminals` → `TmuxController.ensureSession` → `launchAgent`. Codex starts while `codex update` is still replacing the binary, which is the vanishing pane this issue is closing. The plan's Tests section says this placement needs no test, because CLI tests replace `startEffects`. Following that section, an implementation that never calls `updateAgentHarnesses` from `defaultStartEffects` still passes every named test.

Correction: Run the updates in `startIssue` before `createIssueRuntime`, and inject the runner on `CliDependencies` so the suite does not spawn vendor CLIs. Assert that a second `coord <n>` during an in-progress update is impossible because `start.json` does not exist yet, and that the updater is invoked before `startEffects`.

### Claude `c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd` — PATH prefix on every vendor

Plan claim: Summary, and the `defaultTimedRunner` description under Exact file list to be created. The child environment prepends `$HOME/.local/bin` to `PATH`, described as the same prefix the Antigravity launcher uses.

Rule: The binary that is updated and versioned must be the binary `launcher_command` execs. In `scripts/lib/launcher.sh`, `export PATH="$HOME/.local/bin:$PATH"` is only on the `antigravity` branch.

Failure: The default runner prepends that directory for Claude, Codex, and Cursor as well. When `~/.local/bin/codex` and a different `codex` earlier on `PATH` both exist, the updater replaces and records the `~/.local/bin` binary, and the generated launcher execs the other one. The journaled version is not the process in the pane.

Correction: Prepend `$HOME/.local/bin` only when the agent id is `antigravity`.

### Claude `c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd` — `execFile` timeout, and doctor does not see a stale launcher

Plan claim: Risks and Mitigations. "`execFile` `timeout` kills the child at 180 s." Reuse and Scope. "`coord doctor` flags clones that haven't" picked up the new Codex flag; the install digest covers `scripts/lib/launcher.sh`.

Rule: A timed-out update must stop the installer it started before the agent is launched. A claim that doctor detects a stale `start-codex.sh` must match the check doctor runs.

Failure: Node's `execFile` `timeout` signals the direct child pid. `codex update` can leave a downloader running after that pid exits, so the binary is still being replaced when `startSession` runs. The plan's tests stub `TimedRunner` and never spawn a descendant, so they pass for a runner that does not reap the group. Separately, `checkClone` in `src/doctor.ts` only reports a launcher that is missing or not executable. A clone that still has the old `start-codex.sh` produces no launcher finding. The owner can read a clean doctor report and still launch Codex with the startup self-update enabled. `coord install` does rewrite a launcher whose render differs; doctor does not detect that the rewrite has not happened.

Correction: Spawn the update in its own process group and signal the group (SIGTERM, then SIGKILL), and cover it with a descendant that must not write a marker after the timeout. State that existing launchers change on `coord install` or `githooks/post-merge`, and drop the doctor claim.

### Cursor `bb5e9f701556f3bcb49f2a4897a52b26c210c4c3` — timeout reaps only the direct child

Plan claim: Reuse and Scope, bounded spawn. On timeout, SIGTERM, then SIGKILL after 1 second. Risks. "The child is reaped with SIGTERM then SIGKILL." Tests. The real spawn is `node -e "setInterval(() => {}, 1000)"` and must not leave that child running.

Rule: Waiting for an update to finish includes stopping installers that the vendor command spawned. Launch happens only after those processes are gone.

Failure: The specified spawn signals the child pid and the specified test has no grandchild. An implementation that follows the plan kills `codex` and leaves its downloader in the same process group. `startIssue` then reaches `startEffects` while that downloader is still replacing the binary, so the pane still starts on a file that is being rewritten.

Correction: Use the same process-group kill Codex specifies for `runArgv`, and change the real-spawn test to a parent that forks a descendant. The descendant must be unable to write a marker after the timeout returns.

## Conclusion

Claude `c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd` and cursor `bb5e9f701556f3bcb49f2a4897a52b26c210c4c3` are not safe to implement as written. Claude commits `start.json` before the update, so resume and attach can launch during it; it versions a different binary than the launcher execs; and its timeout plus doctor claim do not do what they say. Cursor updates before runtime exists and versions only the Antigravity PATH override, but its timeout leaves installer descendants alive.

Codex `7b72a1c74d198d6aba1ebf32fb66e954f08f86a4` keeps the update before `initializeOperationalState`, skips attach, resume, and pane recovery, kills the updater's process group, and tests that with a descendant. It reuses `runArgv`, `startStateSchema`, and the existing launcher argv test, adds no new product file, and stays inside issue 184. No finding against that plan.
