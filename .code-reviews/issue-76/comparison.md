# Issue 76 implementation comparison — Claude

## Comparison

Bound implementation pins compared:

| Agent | Implementation pin | Fast suite | Lint + typecheck |
| --- | --- | --- | --- |
| cursor | `2857bc3ec2a2bc096a954299d454b67dea973fbf` | 350 passed | clean |
| antigravity | `40647d94c0e4a1c6d9166b97fed9b9475b926ea5` | 341 passed | clean |
| claude | `40157df58f5fe280e10c694e8579f004536c9928` | 371 passed | clean |
| codex | `5402e1d02c8cca3dd9307281e242c4600dc2b83b` | 352 passed | clean |

### How these were verified

Each pin was checked out into its own worktree, built, then linted, typechecked,
and run under `vitest run --config vitest.config.ts`. All four are green. (An
initial run showed 12 shared failures in `test/doctor.test.ts` and
`test/cli.test.ts`; those were an artifact of an unbuilt `dist/` in a fresh
worktree and disappeared after `tsc -p tsconfig.json`. They are not defects in
any implementation.)

Because all four suites pass, the suites cannot by themselves separate these
implementations. The one thing every implementation's manual-mode tests stub is
tmux itself, so the emitted argv is asserted only against a fake runner. I
therefore ran the argv each implementation emits against real tmux (3.7b):

```text
$ tmux set-environment -u -t "$SESS" COORD_ISSUE     # cursor, antigravity, codex
exit=0
$ tmux set-environment -u COORD_ISSUE -t "$SESS"     # claude
command set-environment: too many arguments (need at most 2)
exit=1
```

That probe is what finding 1 rests on, and it is the single most consequential
difference between these four implementations.

All four converge on the same architecture — `SessionKey = number | "manual"`,
`ensureSession` for idempotent relaunch, `openOwnerAgentClients({ onlyMissing:
true })`, no issue runtime, hooks untouched, `0.0.12`. All four correctly
*unset* `COORD_ISSUE` for a manual session rather than merely skipping the
write. All four preflight the configured launchers before touching the UI.

### Finding 1 — `claude` `40157df58f5fe280e10c694e8579f004536c9928` emits invalid tmux argv, so `coord manual` cannot start

**Location.** `src/tmux.ts:648`, in `ensureSession`:

```ts
? await this.runner(["set-environment", "-u", "COORD_ISSUE", "-t", session])
```

**Rule that must hold.** `tmux set-environment` is
`set-environment [-hgru] [-t target-session] name [value]`: options, including
`-t` and its value, must precede the `name` operand. Once `COORD_ISSUE` is
consumed as `name`, the trailing `-t <session>` becomes two extra operands, and
with `-u` no value operand is accepted at all.

**Concrete failure.** Real tmux answers `command set-environment: too many
arguments (need at most 2)` and exits 1 (verified above on tmux 3.7b).
`ensureSession` then hits `src/tmux.ts:651-653` and throws `cannot set
coordinator issue environment in coord-manual-<group>`. The failure lands
*after* `new-session` has already created `coord-manual-<group>` and *before*
any agent window is created, so `coord manual` aborts with zero agent windows
and leaves a stray control-only session behind. Re-running `coord manual` finds
that session present, reaches the same line, and throws again: manual mode is
not merely degraded, it is unreachable on every invocation. The three peers are
unaffected because all three order the flags correctly.

**Why the suite missed it.** Every manual test in all four implementations
drives `ensureSession` through a fake `TmuxRunner` that returns `exitCode: 0`
for any argv, so argv *shape* is unconstrained. My own
`test/tmux.test.ts` asserts `toContainEqual(["set-environment", "-u",
"COORD_ISSUE", "-t", session])` — it pins the broken argv as expected.

**Smallest test.** Assert the argv against tmux's documented grammar rather
than against a recorded string, in `test/tmux.test.ts`:

```ts
const env = calls.find((args) => args[0] === "set-environment");
// -t and its value must precede the variable name operand.
expect(env?.indexOf("-t")).toBeLessThan(env?.indexOf("COORD_ISSUE") ?? -1);
```

The fix is to reorder to `["set-environment", "-u", "-t", session,
"COORD_ISSUE"]`, which is what all three peers already do.

### Finding 2 — `antigravity` `40647d94c0e4a1c6d9166b97fed9b9475b926ea5` leaves `coord run` outside the mode guard

**Location.** `src/cli.ts:1031-1039`. The manual-session guard
(`if (await tmux.hasSession("manual"))`) appears at `src/cli.ts:613` for
`coord <issue>`, `src/cli.ts:722` for `start`, and `src/cli.ts:937` for
`attach`. The `run` handler has none.

**Rule that must hold.** The exclusion exists because both modes drive the same
agent clones. It must therefore sit on every entry point that drives them, not
only the ones that create an issue. `run` is its own dispatch branch: it
resolves existing runtime via `existingContext` and calls
`makeRunLoop(paths).run()` without passing through the numeric or `start`
branches.

**Concrete failure.** The owner starts issue 76, detaches, and later runs
`coord manual` to work by hand. In a second shell they resume the coordinator
the documented way — `COORD_ISSUE=76 coord run --coord-root …`, which is the
exact form `src/install.ts` prints in its post-install next steps. No guard
fires. The run loop nudges each agent, writes `action.md`, and waits on
`complete` from harnesses the owner is simultaneously driving in chat, then runs
file-map and pin checks against working trees the owner has been editing. This
is the race requirement 4 exists to prevent, reachable without ever typing
`coord 76` or `coord start`. cursor covers this by placing the guard inside
`startIssue` (`src/cli.ts:659`) plus explicit calls at `src/cli.ts:776` and
`src/cli.ts:1069`; codex guards all four sites explicitly
(`src/cli.ts:780`, `966`, `976`, `1071`).

**Smallest test.** In `test/cli.test.ts`, start an issue, then run
`coord run --issue 1` with a runner reporting `coord-manual-<group>` live, and
assert a non-zero exit and that the injected `makeRunLoop` was never invoked.

### Finding 3 — `antigravity` `40647d9` closes manual Terminal titles only when a manual tmux session is still listed

**Location.** `src/detachIssue.ts:222-226` in `detachAllOwnerUiSync`:

```ts
if (manualSessions.length > 0) {
  for (const title of ownerTerminalTitlesToClose("manual", options.agentIds, titleGroup)) {
```

where `manualSessions` (line 210) comes from filtering the live
`tmux list-sessions` output.

**Rule that must hold.** Title closing must not be conditional on tmux liveness.
The close-before-kill ordering exists precisely because tmux state and Terminal
state can diverge — the comment above it records that killing tmux first "leaves
idle bash shells and can clear custom titles, so close fails." The issue path in
the same function honours this: it derives titles from `issues`, which come from
durable `issue-*` directories, and closes them unconditionally (lines 217-221).
The manual path does not.

**Concrete failure.** The owner runs `coord manual`, then the tmux server dies —
a reboot, `tmux kill-server`, or a crash — while the four Terminal.app windows
stay open with dead shells. They then run `coord uninstall`.
`listSessionsLive()` returns `[]` because the server is gone, so
`manualSessions` is empty, so the `coord-manual-<group>/<agent>` titles are
never passed to the closer. Uninstall reports success and removes the workspace
config, leaving four orphaned Terminal windows that no remaining command can
close: the workspace config they would be resolved from has just been deleted.
cursor (`src/detachIssue.ts:216`), codex (`src/detachIssue.ts:227`), and claude
all close manual titles whenever `includeManual` is set and a group exists,
independent of the session list.

**Smallest test.** Call `detachAllOwnerUiSync({ includeManual: true, issues: [],
terminalGroup, listSessions: () => [] , terminalCloser })` and assert
`closedTerminalTitles` still contains `coord-manual-<group>/<agent>`.

### Finding 4 — `antigravity` `40647d9` keeps the un-grouped `coord-manual` name and pins it as expected behaviour

**Location.** `src/tmux.ts:470` and `src/tmux.ts:255-256`:

```ts
return group === null || group === "" ? "coord-manual" : `coord-manual-${safeName(group)}`;
```

and `test/tmux.test.ts:62`:

```ts
expect(new TmuxController(runner).sessionName("manual")).toBe("coord-manual");
```

**Rule that must hold.** Requirement 3 asks for an identity that "cannot collide
with issue sessions or with another onboarded product." Numeric sessions may
keep the legacy flat `coord-N` form for compatibility; a manual session has no
such legacy, and a bare `coord-manual` is process-global across every product on
the host. The group is always available from `workspaceTerminalGroup()`, so the
safe construction is total and the unscoped branch buys nothing.

**Concrete failure.** Today antigravity's own CLI call sites all compute
`terminalGroup` before constructing the controller (`src/cli.ts:745`,
`src/cli.ts:955`), so `coord manual`, `coord detach manual`, and `uninstall` do
not currently reach the unscoped branch. The defect is that nothing prevents
them from doing so: `ownerTerminalWindowTitle` and `sessionName` default
`group` to `null`, and the fallback silently yields a valid-looking global name
instead of failing. Any future call site that omits the group — the same class
of omission the existing comments at `ownerTerminalTitlesToClose` were written
about — gets product A's `coord manual` and product B's `coord manual` on one
tmux session, and a `coord detach manual` in either killing the other's
harnesses. The test at line 62 makes this worse than a latent gap: it pins the
unsafe output as correct, so the natural fix breaks a passing test.
cursor (`requireManualGroup`), codex (`src/tmux.ts:248-250`), and claude all
throw instead.

**Smallest test.** Replace `test/tmux.test.ts:62` with
`expect(() => new TmuxController(runner).sessionName("manual")).toThrow()`.

### `cursor` `2857bc3ec2a2bc096a954299d454b67dea973fbf` and `codex` `5402e1d02c8cca3dd9307281e242c4600dc2b83b`

No defect found in the invariants audited here. Both:

- require the workspace group for every manual name and throw otherwise;
- unset `COORD_ISSUE` with argv real tmux accepts;
- guard every automated entry point, including `coord run` — cursor by placing
  the check inside `startIssue` so `coord <issue>` and `coord start` cannot
  diverge, codex by guarding all four sites explicitly including `attach`;
- close manual titles independently of tmux liveness;
- preflight configured launchers before touching the UI.

codex is the most conservative on teardown: `listIssueSessions(key,
manualAgentIds)` (`src/detachIssue.ts:161-162`, `src/tmux.ts:498`) matches
linked client sessions against the configured agent ids rather than by prefix,
so an unrelated session named `coord-manual-<group>-something` could never be
killed. The prefix approach the other three use is safe in practice — the group
is a per-workspace-root hash — but codex's is exact by construction.

### Recommendation

**codex `5402e1d02c8cca3dd9307281e242c4600dc2b83b`**, with cursor
`2857bc3ec2a2bc096a954299d454b67dea973fbf` as an equally correct alternative.

My own implementation, claude `40157df58f5fe280e10c694e8579f004536c9928`,
must not be selected as it stands:
finding 1 means `coord manual` — the entire feature — fails on every invocation
against real tmux, and its test suite pins the broken argv. The remaining work
in it is sound, but that defect is disqualifying and I am reporting it against
myself rather than relying on a green suite that stubs the failure away.

antigravity `40647d94c0e4a1c6d9166b97fed9b9475b926ea5` carries three defects
(findings 2-4), two of which were raised against its plan in R3 and shipped
unchanged. It should not be selected without at least findings 2 and 3 fixed.

Between the two clean implementations, codex has the more precise session
matching and the broader guard placement; cursor's `startIssue` guard placement
is the more maintainable of the two. Either is safe to take forward.
