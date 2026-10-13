# Issue 184 implementation comparison

Protocol version: 1. Reviewing action `fdf3f33a-187f-4fdd-aeb7-3c8e10fad3b1`.

## Comparison

Reviewed the complete exported worktrees at these bound product pins:

| Agent | Implementation pin | Recommendation |
| --- | --- | --- |
| Claude | `94c9c01537d14c9d8333b37a4b41475ee310a121` | Revise: maintenance can target a different installation from launch. |
| Codex | `a342daa65dbeec0371b69983cb881b7b93ac6a26` | Select: shares the launch environment and passes the timeout descendant reproduction below. |
| Cursor | `e0335ca7c88f3356403a1eba456517a56ae29723` | Revise: installation mismatch and an updater descendant can survive timeout completion. |

### Finding 1 — Claude and Cursor can update and record the wrong installation

Claude `src/cli.ts:641` and `src/cli.ts:647`; Cursor `src/cli.ts:632` and `src/cli.ts:660`. Update and version commands must resolve the installation that the generated launcher will execute. Both implementations run the vendor directly with the coordinator's inherited Node/PATH environment, with only an Antigravity home-local-bin adjustment. Their launchers subsequently source nvm and select the clone's `.nvmrc` version (Claude `scripts/lib/launcher.sh:346`, Cursor `scripts/lib/launcher.sh:345`).

If the owner's PATH selects Node installation A while the clone pins Node installation B, and each has a global Codex binary, maintenance updates A and writes A's version into `start.json`; the pane then executes the still-unupdated B. Startup succeeds with an inaccurate version snapshot and the actual running installation was never updated. Merely using the clone as cwd does not perform `nvm use`. This is a blocking behavioral difference, established by the command construction and launcher source.

Focused regression: provide distinguishable owner-PATH and pinned-Node vendor stubs plus a harmless nvm fixture that switches PATH. Run maintenance and the generated launcher; assert that update, version, and launch all reach the pinned stub. Codex already exercises this for Codex and Antigravity in `test/cli.test.ts:322`, and its `src/cli.ts:154` invokes the same `launcher_environment` function embedded into the generated launcher. The peer tests that stub direct vendor argv do not exercise this environment transition.

### Finding 2 — Cursor cancels group cleanup when only the updater parent exits

Cursor `src/runLoop.ts:214`, together with `src/runLoop.ts:195` and `src/runLoop.ts:223`. A timed-out updater's process group must be terminated before its runner resolves and startup advances. Here the parent's `close` event calls `finish`, which clears the scheduled SIGKILL timer; the escalation also skips its signal once `settled` is true.

An updater can spawn an installer that ignores SIGTERM and closes or redirects its output pipes. SIGTERM kills the updater parent, whose pipes close immediately, but the installer remains alive. The runner resolves, version collection and pane launch proceed, and that installer can continue replacing the installation underneath the launched agent. This violates the intended ordering even though the result reports a timeout.

I reproduced this against the exact runner source from all three exported pins. The harmless Node parent spawned a child with `stdio: "ignore"`; the child ignored SIGTERM and scheduled a file write after two seconds. The runner timeout was 500 ms. I checked the marker after 2.3 seconds and cleaned up every fixture process and temporary directory. Results:

| Runner | Returned after | Result | Descendant wrote after return |
| --- | --- | --- | --- |
| Claude | 505 ms | exit 124, timedOut true | No |
| Codex | 1504 ms | exit 124 | No |
| Cursor | 507 ms | exit 1, timedOut true | **Yes** |

The focused harness transpiled each unchanged runner section with the installed TypeScript compiler and used real `node:child_process.spawn`; it did not run a vendor updater. The minimal regression is the parent-default-SIGTERM/child-ignores-SIGTERM case with closed child pipes. Cursor's existing timeout case keeps the parent alive through SIGTERM, so it does not expose cancellation of escalation on early parent closure. Codex covers both inherited and closed descendant pipes in `test/runLoop.test.ts:81`.

### Scope, reuse, and coverage

All three stay within the nine approved existing product files. None adds a product file, dependency, runtime manifest, or unrelated change to the existing tmux exit-output retention. All use the selected fresh-start roster before runtime initialization and pane creation, finish the update loop before version collection, preserve recovery without repeated maintenance, and add an optional version map compatible with legacy state. All add Codex's startup-check suppression in the canonical launcher while preserving existing flags and grants.

Claude and Codex extend the existing runner directly. Cursor creates separate bounded and unbounded implementations inside the same file, duplicating spawn/capture lifecycle code; that adds maintenance cost without solving the early-parent-exit case. Codex's extraction of the launcher's existing environment setup is justified reuse: it gives maintenance and launch one source for nvm and PATH selection. Its 180-second update limit also gives a slow successful installer more time than the peers' 60-second limit; all use five seconds for version reads.

Each implementation extends the existing CLI, runner, state, and install test files with issue-focused coverage. The decisive coverage differences are real launch-environment parity and a descendant that outlives its parent. No broad refactor or extra test file is needed to address either finding.

### Verification evidence and conclusion

I read the issue journal's successful advisory hook observations: Claude sequences 290/292, Codex 295/297, and Cursor 405/410 record `pnpm run check:fast` and `pnpm run test:e2e`, respectively, with exit code 0 for each submitted implementation. These are existing hook records, not new full-suite executions or final coordinator verification. This comparison adds only the focused process reproduction reported above; product suites were not repeated for unchanged pins.

Select Codex `a342daa65dbeec0371b69983cb881b7b93ac6a26`. I found no blocking issue in that pin in this review. Claude needs launch-environment parity; Cursor needs that parity and timeout cleanup that survives the parent's early closure. The passing peer hook suites do not exercise these concrete failures. Final verification remains the coordinator's responsibility.
