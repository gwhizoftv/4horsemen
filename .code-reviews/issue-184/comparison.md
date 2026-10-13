# Issue 184 implementation comparison

## Comparison

Bound implementation pins compared:

- claude `94c9c01537d14c9d8333b37a4b41475ee310a121`
- codex `a342daa65dbeec0371b69983cb881b7b93ac6a26`
- cursor `e0335ca7c88f3356403a1eba456517a56ae29723`

Each pin was read from its bound worktree and diffed against the issue
baseline `0e0a07b93b61be5f76224650468d50c3bbf06d5d` (parent of the first issue
commit on this branch). All three pins change only the nine approved paths
(`docs/coord-driver.md`, `scripts/lib/launcher.sh`, `src/cli.ts`,
`src/runLoop.ts`, `src/state.ts`, and the four test files); no pin adds a
product file or a dependency.

Shared behaviour, present in all three:

- Codex launcher gains `-c check_for_update_on_startup=false`; the install
  test's expected argv is updated, and a manual-mode (empty grant) Codex launch
  is asserted.
- Fresh `coord start` / first numeric entry updates the selected roster
  sequentially (`codex update`, `claude update`, `agent update`, `agy update`)
  after `prepareAgentIssueBranches` and before `createIssueRuntime` and
  `initializeOperationalState`, so no `start.json` exists while an updater runs
  and attach/recovery cannot launch a pane mid-update.
- `--version` probes run after all updates; results go to an optional
  `startStateSchema.agentVersions` record (null = unknown); old `start.json`
  files still parse.
- Unknown agent ids (e.g. `gemini`) warn and are never run as commands.
- `ProcessRunner` gains an optional third options argument (`timeoutMs`, `env`);
  calls without it keep the historical spawn path. Bounded calls spawn a
  detached process group, signal the group with SIGTERM then SIGKILL, and cap
  retained output.
- Attach, resume and numeric continuation are tested to perform no maintenance
  and to leave `start.json` bytes unchanged.

Differences:

| | claude | codex | cursor |
|---|---|---|---|
| Update timeout | 60 s (plan) | 180 s (plan says 60 s) | 60 s (plan) |
| Updater environment | owner env (`io.env`); agy gets `$HOME/.local/bin` first (plan) | `bash` sources `scripts/lib/launcher.sh` and runs the new `launcher_environment` (nvm + agy PATH), the same function the generated launcher embeds | `process.env` (ignores `io.env`); agy gets `$HOME/.local/bin` first |
| Launcher template | Codex flag only | Codex flag; nvm block and agy PATH export moved into `launcher_environment()` embedded via `declare -f` for every agent | Codex flag only |
| Timeout with leader exited, SIGTERM-ignoring descendant | group SIGKILL on `close` — reaped | escalation kept after `close` — reaped | timers cleared on `close` — **leaks** |
| Output cap | first 64 KiB per stream | last 32 KiB per stream | last 64 Ki chars per stream |
| Version value | first non-empty line | first non-empty line | whole trimmed stdout |
| Same-install integration test | no | yes (real generated launcher, fake nvm, codex + agy) | no |

Probe I ran: a scratch copy of each pin's `src/` (bound worktree bytes, with
this clone's `node_modules`) ran one vitest case. The leader process exits on
SIGTERM. It has spawned a descendant with `stdio: "ignore"` that ignores
SIGTERM and writes a marker 1.7 s later. `runArgv(..., { timeoutMs: 200 })`
is then awaited and the marker checked at +2.5 s. Results: claude passed,
codex passed, cursor **failed** (`timedOut: true`, marker written). A second
probe on a copy of the claude pin, with the `close`-time SIGKILL at
`src/runLoop.ts:190` removed, also failed. This confirms that line is what
reaps the descendant in claude's runner.

## Findings

1. **cursor — `src/runLoop.ts:214`–`223` (bounded runner `close` handler and
   escalation timer).**
   - **Rule:** a timed-out maintenance call must not return while any member
     of its process group is still running. The selected plan's step 1 says a
     spawned installer must not "continue updating after the caller moves on".
   - **Failure:** `finish()` clears all timers, including the pending SIGKILL
     escalation, as soon as the leader's pipes `close`. Take an updater whose
     leader exits on the timeout's SIGTERM but whose installer child ignores
     SIGTERM and does not hold the pipes. `runArgv` resolves `timedOut: true`,
     and the installer keeps running unsupervised. `coord start` then probes
     `--version`, records it, and launches the pane while that installer may
     still be replacing the executable. This reopens the race issue 184 is
     about. Reproduced by the probe above: the marker was written after
     `runArgv` returned.
   - **Smallest test:** codex's `test/runLoop.test.ts:81` "closed pipes" case,
     or the probe above.
   - **Fix sketch:** on `close` after a timeout, signal the group with SIGKILL
     (as claude does), or keep the escalation timer alive until it fires (as
     codex does).

2. **codex — `src/cli.ts:138` (`AGENT_UPDATE_TIMEOUT_MS = 180_000`) and
   `src/cli.ts:153`–`155` with `scripts/lib/launcher.sh:19`–`33` and `:354`–`355`.**
   - **Rule:** the implementation follows the selected plan. Changes to its
     stated behaviour go through a revision or amendment, not the
     implementation. The selected plan (codex `7b72a1c7`, step 2) specifies "a
     60-second update timeout". It also says to "execute argv directly in the
     agent's resolved clone directory, using the normal owner environment", and
     step 4 says only to "add Codex's suppression override to the single
     launcher template".
   - **Failure:** the approved behaviour and the code now disagree on three
     points:
     - A hung updater blocks `coord start` for up to 3 minutes per agent
       instead of 1. With four agents that is up to about 12 minutes before
       any pane appears, against the approved 4-minute bound.
     - Maintenance shells out through `bash` and sources the coordinator's
       copy of `launcher.sh`.
     - Every generated launcher, not just Codex's, changes: the nvm block
       becomes an embedded `launcher_environment` function. Antigravity's
       `$HOME/.local/bin` PATH entry now comes before the corepack/pnpm
       setup, where it used to come just before `exec agy`.

     None of this was in the plan reviewers approved.
   - **Note:** these deviations do address findings that all three plan
     reviews raised: the short timeout, and that the updater could update a
     different install than the nvm-pinned launcher runs. The codex pin is
     the only one that tests that the updated install and the launched
     install are the same.
   - **Ask:** the owner/ballot should accept them explicitly rather than
     inherit them silently.

3. **claude and cursor — updater environment: claude `src/cli.ts:641`–`644`
   and `:647`; cursor `src/cli.ts:622`–`632`, `:660` and `:684`.**
   - **Rule:** issue 184 asks to "print and record the versions that will
     run". The update and the `--version` probe must resolve the same
     executable that the generated launcher later `exec`s.
   - **Failure:** both pins run `codex update` and `codex --version` from
     coord's own PATH. The launcher first runs `nvm use` for the clone's
     `.nvmrc` (this repo pins `26`). Suppose a vendor CLI is installed
     globally under the nvm Node and a different copy sits on coord's PATH.
     Then the copy that launches is never updated, and `agentVersions`
     records the wrong copy's version.
   - **Scope:** on this host all four vendors resolve to `~/.local/bin`, and
     neither nvm v26 bin directory contains one, so the failure is latent
     here. Both pins follow the plan as written, which is why the plan
     itself is at fault.
   - **Smallest test:** codex's "updates and launches the same %s
     installation after nvm setup" (`test/cli.test.ts`, in its "fresh-start
     agent maintenance" describe block). It fails against both pins.
   - **Cursor only:** it also reads `process.env` rather than the injected
     `io.env`, so a caller-supplied environment is ignored for every vendor.

4. **claude — `test/runLoop.test.ts:514`–`538` ("stops a timed-out command and
   its descendants…").**
   - **Rule:** the reaping path that `src/runLoop.ts:190` exists for must
     have a regression test.
   - **Failure:** in the only timeout test, the leader ignores SIGTERM and the
     descendant inherits the pipes. So `close` happens only after the
     1-second group SIGKILL, and the descendant has already died from
     SIGTERM. Deleting line 190 leaves the suite green, yet the second probe
     above shows the deletion leaks a SIGTERM-ignoring descendant. That is
     the same defect as finding 1.
   - **Smallest test:** parameterize the existing case on the descendant's
     `stdio` (`"inherit"` / `"ignore"`). In the `"ignore"` case, the leader
     exits on SIGTERM and the descendant ignores it, as in codex's
     `test/runLoop.test.ts:81`.

5. **cursor — `src/cli.ts:693` (`const reported = result.stdout.trim()`).**
   - **Rule:** the per-agent version line and `agentVersions` value is one
     version string.
   - **Failure:** if a vendor's `--version` prints a banner or update notice
     after the version, the whole multi-line stdout is persisted and printed
     as the "version", splitting the per-agent line.
   - **Note:** low severity; the plan's "keep the trimmed reported version"
     permits it. Claude and codex keep the first non-empty line.

Discipline comparison:

- **Scope:** all three stay within the issue and the approved paths. claude
  and cursor make exactly the planned launcher change. codex broadens it to a
  shared launcher-environment refactor that touches every agent's generated
  launcher (finding 2).
- **Reuse:**
  - All three extend the existing `runArgv`/`ProcessRunner` rather than
    adding a new process helper.
  - All three reuse `setup`, `successfulStartGit`/`resolvableStartGit`,
    `fakeLoop`, the `startEffects` injection, `initialize`, and
    `installOnce`.
  - codex also reuses `writeAgentLauncher` for its integration test.
  - cursor splits `runArgv` into `runArgvUnbounded`/`runArgvBounded`, which
    keeps the old path byte-identical at the cost of a second spawn
    implementation. claude and codex fold the bound into one function.
- **Unnecessary files/refactors:** none add files.
  - codex's launcher refactor goes beyond the plan.
  - cursor adds a `refuseMaintenance` runner to the existing attach and
    interactive-resume tests, a reasonable reuse.
- **Coverage:** all three add focused cases:
  - The deferred-update ordering gate.
  - Solo roster and numeric entry.
  - Failure/timeout/missing warnings with null versions, and an unknown agent.
  - No maintenance on attach/resume.
  - State schema round-trip.
  - Bounded-runner timeout.

  codex's coverage is strongest: both pipe topologies, plus the real-launcher
  same-install test. Gaps: claude has finding 4; cursor's timeout test kills
  its descendant with SIGTERM, so it cannot detect finding 1.

## Verdict

Rank by correctness:

1. **codex `a342daa65dbeec0371b69983cb881b7b93ac6a26`.** It has no correctness
   defect found. Its process-tree cleanup is correct in both pipe topologies.
   It is the only pin that updates and records the install the launcher will
   actually run, and its tests are the strongest. It deviates from the
   selected plan (180 s timeout, launcher-environment refactor; finding 2), and
   those deviations need explicit acceptance.
2. **claude `94c9c01537d14c9d8333b37a4b41475ee310a121`.** It conforms to the
   selected plan, and its process-tree cleanup is correct (probe passed). It
   keeps the plan's latent environment gap (finding 3) and lacks a regression
   test for its `close`-time reap (finding 4).
3. **cursor `e0335ca7c88f3356403a1eba456517a56ae29723`.** It conforms to the
   plan's surface but has a confirmed process leak on timeout (finding 1).
   That leak defeats the plan's own guarantee that no installer keeps running
   after start moves on, so it must not be selected without that fix.

Recommendation:

- Prefer codex if the owner/ballot accepts its two deviations. They fix
  issues every plan review raised.
- If strict plan conformance is required, claude is the conforming
  candidate. Its revision should add the "closed pipes" timeout case.
- Cursor needs finding 1 fixed in any case.

Checks I ran for this comparison: the two scratch vitest probes described
above (bounded-runner leak probe on all three pins; claude pin re-run with
`src/runLoop.ts:190` removed). I ran no product suite. Pin verification and
final checks are the coordinator's.
