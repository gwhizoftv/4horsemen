# Issue 184 plan review (claude)

Reviewed the bound plans from the exported input files:

- claude `c4056f3e7dfdf9f614dfa5ebb7b005faf0b291fd`
- codex `7b72a1c74d198d6aba1ebf32fb66e954f08f86a4`
- cursor `bb5e9f701556f3bcb49f2a4897a52b26c210c4c3`

The three plans agree on the core design, and each agreement matches the
baseline code:

- Add `-c check_for_update_on_startup=false` to `launcher_command codex` in
  `scripts/lib/launcher.sh` and extend the executed-launcher argv test in
  `test/install.test.ts`.
- Update each rostered agent once, sequentially, before any pane launches. A
  failure warns and startup continues.
- Read `--version` after the update and print and record the result.
- Keep the update on the fresh-start path only. `startIssue` is the only
  caller of `startEffects` (`src/cli.ts:1006`). Attach, resume, and recovery
  go through `TmuxController.ensureSession` (`src/runLoop.ts:1129`,
  `src/cli.ts:634`), so they never update.
- Leave the exit-output half of the issue alone. It already shipped in issue
  199 (`launchAgent`, `recordPaneExits`).

The plans differ in where the call sits, where versions are stored, how a
timeout is enforced, and what is tested. The findings below are about those
differences.

## Findings

### F1 — claude and cursor plans: a timeout kills only the direct child (blocking)

**Plan claims.**

- claude: "The default implementation is `execFile` with `timeout`", plus the
  risk entry saying the timeout "kills the child at 180 s".
- cursor: "Bounded spawn … on timeout, SIGTERM, then SIGKILL after 1 second,
  then resolve", plus the test that the timed-out child is not left running.

**Rule.** A timed-out update must not keep modifying the installation once
`coord start` has moved on to launching the agents. The issue's "wait for
completion" sequence depends on that. Every descendant of the update command
must be stopped before the next step runs.

**Failure if followed as written.** Take an npm-installed CLI whose `update`
subcommand runs a package-manager child, for example `codex update` invoking a
global `npm install`. When the timer fires, `execFile`'s `timeout` (claude) or
a single-pid SIGTERM/SIGKILL (cursor) kills only `codex`. The `npm` child is
reparented and keeps replacing files in the global prefix. Coordination then
probes `--version` and launches `start-codex.sh` against a binary that is
still being rewritten. The pane can then fail to start, or vanish again — the
symptom this issue exists to fix. Meanwhile the journal or `start.json` records
a version that no longer matches what is installed a minute later. Cursor's
planned real-spawn test runs a single `node -e "setInterval(…)"` with no
descendant, so it passes and does not detect this.

**Smallest correction.** Start the bounded command in its own process group
(`detached: true`). On timeout, signal the group (`process.kill(-pid, …)`) and
wait for `close` before resolving. Extend the one real-spawn test so the
fixture spawns a descendant that would write a marker after the timeout, and
assert that the marker never appears. The codex plan already specifies this
(Implementation sequence step 1 and Tests item 3).

### F2 — claude plan: nothing tests that `defaultStartEffects` calls the update, or calls it before launch (blocking)

**Plan claim.** Under Tests, the attach/resume skip "needs no new test"
because of where the call sits. All three planned tests target
`updateAgentHarnesses` directly.

**Rule.** The issue's ordering requirement is "update → print/record versions
→ launch the agents" on fresh start only, and at least one test has to fail if
that wiring breaks. A unit test of the helper alone cannot cover it.

**Failure if followed as written.** Any of the following leaves every planned
test passing:

- deleting the `updateAgentHarnesses` call from `defaultStartEffects`;
- moving it after `tmux.startSession(...)`, so the panes launch first and
  Codex can still self-update in its pane on a clone whose launcher predates
  the new flag;
- passing the configured agents instead of the solo roster.

Every CLI test replaces `startEffects` (`src/cli.ts:728-732`), and
`defaultStartEffects` builds a real `TmuxController`. So nothing in the plan
ever runs this wiring, and a regression ships green.

**Smallest correction.** Inject the updater at a seam that the start-path CLI
tests already exercise, as the codex and cursor plans do. Then add one
`test/cli.test.ts` case on the existing `setup()` / `successfulStartGit` /
`fakeLoop` fixture that checks three things:

1. The injected updater runs before the injected `startEffects` is entered.
2. A solo start passes only the first agent.
3. A later `coord attach` / numeric resume never calls it.

### F3 — claude plan: omits the `docs/coord-driver.md` update that the existing Codex-flag precedent requires (minor)

**Plan claim.** Out of scope: "Documentation pages, unless a reviewer finds an
existing doc that describes the `coord start` sequence step by step."

**Rule.** User-visible launcher flags and startup ordering are documented in
`docs/coord-driver.md`. Line 413 records `--no-daemon` along with "Existing
clones keep their old `start-codex.sh` until `coord install` rewrites it", and
lines ~299–310 describe the `coord start` sequence step by step.

**Failure if followed as written.** After the change, an owner reading the
driver doc would not know three things:

- `coord start` now waits up to 3 × 180 s on vendor updates before panes
  appear, so a slow start looks like a hang.
- The new Codex flag reaches existing clones only after `coord install`.
- Attach and resume intentionally do not update.

The doc that the condition in my own plan asked for exists, so by the plan's
own rule it is in scope.

**Smallest correction.** Add `docs/coord-driver.md` to the file list, as the
codex and cursor plans do. Add one sentence to the start-sequence paragraph and
one beside the `--no-daemon` note.

### F4 — cursor plan: updates run before the cheap fail-fast refusals in `prepareAgentIssueBranches` (minor)

**Plan claim.** "…call the updater on `roster` only … before
`prepareAgentIssueBranches`."

**Rule.** Cheap local refusals should come before slow, network-bound side
effects. A start that is going to be refused should fail in seconds, not after
the update phase has spent minutes changing global CLI installs.

**Failure if followed as written.** Suppose an owner runs `coord start 184`
while one clone is dirty or on a peer branch. `prepareAgentIssueBranches`
refuses that in milliseconds. Under this plan, the owner first waits for up to
three sequential updates (up to 9 minutes when they time out), and the global
installations change, before the refusal appears. Fixing the clone and running
again repeats the whole update phase. The window between the
`existsSync(paths.issueRoot)` check and `createIssueRuntime` also grows from
milliseconds to minutes, which makes concurrent duplicate starts of the same
issue much more likely to pass that check.

**Smallest correction.** Run the update after `prepareAgentIssueBranches` and
before `initializeOperationalState` / `startEffects`, which is where the codex
plan places it.

### F5 — codex plan: the 60-second update timeout is short enough to kill healthy updates (minor)

**Plan claim.** Implementation sequence step 2: "Use a 60-second update
timeout plus at most a one-second termination grace."

**Rule.** The timeout should catch a hung or prompting updater without
routinely interrupting a normal one. With process-group termination (which this
plan correctly specifies), each interruption is an abort in the middle of an
install.

**Failure if followed as written.** Some vendor updates download and replace
large native binaries. On an ordinary slow or congested link, a healthy update
can take more than 60 s. The plan then kills the installer's process group
partway through. Whether that leaves the old version intact or a partly
replaced install depends on each vendor's installer. The owner gets a
"timed out" warning on a working network, and a later `coord start` repeats
the same interrupted download.

**Smallest correction.** Use a longer bound for the update step, such as the
180 s both other plans chose, and keep the short bound for `--version`.

### Scope, reuse, and test focus

- **claude.** Smallest file set: 3 changed and 2 new, journal-only recording,
  no docs. The new module is justified by the timed-spawn logic. Subject to
  F1–F3.
- **codex.** Creates no new files. It extends the shared
  `ProcessRunner` / `runArgv` with an opt-in third options argument, which
  existing two-argument runners stay assignable to, and persists versions as an
  optional `start.json` field. Nine changed files, each justified in the plan.
  It names the real hazard in `test/cli.test.ts`: `resolvableStartGit`
  (`test/cli.test.ts:207-215`) `execFileSync`s any argv it does not recognise,
  so a start test using it would run a real `codex update` unless vendor argv
  is intercepted first. The plan requires that interception. I checked the
  other start-path tests: they inject `successfulStartGit`, which returns exit
  1 for unexpected argv (line 205), and the two start calls without a runner
  stop before the update step. The runner-based approach is therefore safe for
  existing tests. The tests are more numerous than in the other plans but
  focused, and the descendant-process timeout test is the one that matters
  for F1.
- **cursor.** One new module plus `test/agentUpdate.test.ts`, docs, and an
  optional `start.json` field. Gating the default updater on
  `process.env.VITEST` follows the existing `sessionExists` default in
  `src/cli.ts`, so it is precedented. Subject to F1 and F4.
- All three plans stay within the issue: no version bump, no `githooks/`
  edits, no new dependency, no changes to `remain-on-exit` or pane logging.

## Conclusion

No plan is acceptable unchanged, and the codex plan is the strongest base.

- **codex:** the only plan that enforces the timeout against the updater's
  whole process tree (F1). It places the update after branch preparation and
  before state is written and agents launch. It tests the fresh-start versus
  attach/resume split through the real CLI path (F2), and updates the driver
  doc (F3). It needs only F5: raise the update timeout from 60 s.
- **claude (my plan):** needs F1, F2, and F3.
- **cursor:** needs F1 and F4.

All three can be corrected without changing their file maps much, except the
claude plan, which needs `docs/coord-driver.md` and a CLI-level test. Recommend
selecting the codex plan with F5 applied.
