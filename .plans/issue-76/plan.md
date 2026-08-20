# Issue 76 implementation plan — Claude

## Scope and baseline

Implement [issue #76](https://github.com/gwhizoftv/coordination/issues/76),
"Manual coordination of agent supported," from baseline
`f71a3f70961373a8cadfc2e601c9062b242bc4d2` (`main`).

The deliverable is a second **launch/attach lifecycle**, not a second workflow
profile:

```sh
cd <onboarded-product>
coord manual          # open/repair one agent window per configured agent, return
coord detach manual   # tear that UI down
```

`coord manual` resolves the onboarded workspace exactly as `coord N` does,
validates launchers, creates or repairs one tmux window per configured agent
inside a workspace-scoped session, opens only the missing macOS Terminal
windows, prints what it did, and returns. There is no long-running coordinator
process, no GitHub call, no `issue-*` runtime directory, no `action.md`, no
nudging, no consensus, and no PR. The owner's chat messages are the only task
source.

### Binding design decisions

**1. Session identity.** The manual UI is keyed by the literal string
`manual` plus the workspace fingerprint already computed by
`workspaceTerminalGroup()`: tmux session `coord-manual-<group>`, Terminal custom
titles `coord-manual-<group>/<agent>`. The group suffix is **mandatory** for
manual (unlike numeric issues, where a flat layout keeps legacy `coord-N`), so
two onboarded products can never share a manual session name. `manual` is not
digits, so it cannot collide with `coord-<n>` names nor be matched by
`discoverCoordIssues()`'s `^coord-(\d+)` patterns.

**2. One naming code path.** Rather than add a parallel set of manual-only
helpers, widen the existing tmux key parameter from `number` to
`SessionKey = number | "manual"`. Numeric behaviour is byte-identical to today;
only the `"manual"` branch is new. This is what keeps `detach manual` and
`uninstall` from drifting away from `coord manual`'s own naming.

**3. Idempotency comes from `ensureSession`.** `TmuxController.ensureSession()`
already reuses healthy panes, respawns dead ones, and adds missing windows;
`openOwnerAgentClients(..., { onlyMissing: true })` already skips Terminal
titles that are open. `coord manual` composes those two, so a repeated
`coord manual` is idempotent by construction. `startSession()` (which *throws*
when the session exists) is deliberately not used.

**4. Mode exclusion is derived from live tmux, not from a new lock file.**
Requirement 4 of the issue forbids writing runtime state in this path, so the
exclusion check must not create a lock. `coord manual` enumerates this
workspace's issue numbers with the existing `listIssueNumbersInWorkspace()` and
probes `tmux has-session` for each; the automated entry points
(`coord <issue>`, `coord start`, `coord run`) probe `coord-manual-<group>`.
Either direction fails with the exact command needed to clear the conflict.
Discovery is always workspace-scoped — never a global `tmux list-sessions`
sweep, which is the bug the existing `discoverCoordIssues()` comments warn
about.

**5. `COORD_ISSUE` is not set in a manual session.** `ensureSession` sets
`COORD_ISSUE` for numeric keys only; the manual session gets
`COORD_MANUAL=1` instead. An agent in a manual window therefore cannot resolve
a coordinator action by accident, and `coord next` keeps failing there with its
existing "--issue or COORD_ISSUE is required" error.

**6. Test safety.** Manual launch is injected through a new
`CliDependencies.manualUi` hook, mirroring the existing `startEffects` hook, and
the conflict probes go through the existing `dependencies.processRunner`. Unit
tests therefore never spawn tmux or `osascript`. Teardown needs no new hook:
`detachIssue()` already no-ops tmux and the Terminal closer under Vitest.

## Exact File List to be changed or deleted

### Deleted

None.

### Changed — command and owner-UI lifecycle

- **`src/paths.ts`** — extract the workspace UI identity derivation currently
  inlined in `issueRuntimePaths()` into
  `export const workspaceUiIdentity = (workspaceRoot: string): { tmuxNamespace: string | null; terminalGroup: string }`
  (nested layout ⇒ namespace = group, flat ⇒ `null`), and have
  `issueRuntimePaths()` call it. `coord manual` has no issue number and so
  cannot call `issueRuntimePaths()`; this shared helper is what stops the two
  derivations from drifting. No behaviour change for issue paths.

- **`src/tmux.ts`** —
  - add `export type SessionKey = number | "manual";`
  - `sessionName(key: SessionKey)`: numeric unchanged
    (`coord-<n>[-<namespace>]`); `"manual"` ⇒ `coord-manual-<safeName(group)>`,
    throwing `Manual tmux sessions require a workspace group id.` when
    `terminalTitleGroup()` is `null`/empty.
  - widen `target`, `agentAttachLaunches`, `ownerTerminalTitles`,
    `listIssueSessions`, `killIssueSessions`, `stopSession`,
    `closeOwnerAgentClients`, `openOwnerAgentClients`, `ensureSession`,
    and module-level `ownerTerminalWindowTitle` / `ownerTerminalTitlesToClose`
    from `issue: number` to `key: SessionKey`.
  - `ensureSession`: set `COORD_ISSUE=<n>` only for a numeric key; for
    `"manual"` set `COORD_MANUAL=1`. Pane reuse/respawn/create logic unchanged.
  - `startSession` keeps its `number` parameter — manual never uses it.
  - `agentClientAttachCommand()` already takes a session string; unchanged.

- **`src/cli.ts`** —
  - add `manualUi` to `CliDependencies` and a `defaultManualUi` that builds a
    `TmuxController(undefined, tmuxNamespace, undefined, undefined, undefined, terminalGroup)`,
    calls `preflight(config.agents)` (launcher resolution + tmux availability),
    `ensureSession("manual", config.agents)`, then
    `openOwnerAgentClients("manual", config.agents, { onlyMissing: true })`.
  - add `assertNoConflictingSession(mode, { runtimeRoot, tmuxNamespace, terminalGroup, issues }, runner, cwd)`:
    for `mode: "manual"`, probe each `sessionName(issue)` from
    `listIssueNumbersInWorkspace(runtimeRoot)` and throw
    `` Issue <n> is running for this workspace (tmux session <name>). Run `coord detach <n>` before `coord manual`. ``;
    for `mode: "automated"`, probe `coord-manual-<group>` and throw
    `` Manual mode is active for this workspace (tmux session <name>). Run `coord detach manual` first. ``
  - new `manual` command: `allowedFlags(parsed, ["product", "config", "coord-root"])`,
    zero positionals, `resolveStart()` for resolution,
    `workspaceUiIdentity(resolution.runtimeRoot)` for naming,
    conflict check, `manualUi(...)`, `reportOwnerAgentClients(...)`, a summary
    line naming the session and the agent windows, then `return 0`. It must not
    touch `BareMirror`, `createIssueRuntime`, `writeStartState`, `writeAction`,
    `makeRunLoop`, or `githubIssue`.
  - `detach`: when the single positional is exactly `manual`, skip
    `parseIssue()` and call `detachIssue({ issue: "manual", agentIds: resolution.config.agents.map(a => a.id), tmuxNamespace, terminalGroup, dryRun })`,
    printing `Detached manual mode: …`. Any other positional keeps today's
    numeric path unchanged.
  - `coord <issue>`, `start`, and `run`: call `assertNoConflictingSession("automated", …)`
    before starting effects or entering the run loop. `attach`/`status`/`next`
    are unaffected (they neither launch agents nor drive the working trees).
  - extend `help` with `coord manual [--product <path> | --config <path> --coord-root <path>]`,
    `coord detach manual [...]`, and a paragraph covering issue-free behaviour,
    the `<agent>/<name>` scratch-branch convention, and the non-concurrency rule.

- **`src/detachIssue.ts`** —
  - import `SessionKey`; widen `DetachIssueOptions.issue` to `SessionKey` with a
    doc comment ("issue number, or `\"manual\"` for the owner-driven manual
    UI"). Widening rather than renaming keeps `src/wipeIssue.ts:378` and
    `src/cli.ts:536` compiling untouched.
  - generalize `sessionPrefix(key, namespace, group)`: `"manual"` ⇒
    `coord-manual-<safeName(group)>`, ignoring `namespace`; numeric unchanged.
  - widen `filterSessionsForIssue` to accept a `SessionKey` (numeric callers
    unchanged); `discoverCoordIssues` stays digits-only.
  - `detachAllOwnerUiSync`: add `includeManual?: boolean`. Move the
    `issues.length === 0` early return so it only short-circuits when there is
    also no manual work to do; when `includeManual` is set and a
    `terminalGroup` exists, add the `coord-manual-<group>/<agent>` titles to the
    close set and the exactly-matching manual sessions from the listed names to
    the kill set.

- **`src/install.ts`** — add `coord manual --product <productRoot>` to the
  post-install "Next steps" block and an owner-driven alternative to the
  `onboard()` success block; pass `includeManual: true` to the
  `detachAllOwnerUiSync` call in `uninstall()` so the manual UI is torn down
  even when `listIssueNumbersInWorkspace()` returns `[]`, and keep the existing
  `effects.changes` "detach owner UI" entry accurate for that case.

### Changed — agent instructions and generated launch text

- **`AGENTS.md`** — scope the issue/action/evidence protocol with an explicit
  "applies when a coordinator `action.md` exists" clause and add a manual-mode
  section: the owner's chat message is the task, work happens on
  `<agent>/<name>`, and no coordinator artifacts are fabricated.
- **`templates/product/AGENTS.md`** — same contract in the generated product
  intro.
- **`templates/product/AGENTS.protocol.md`** — state that `action.md` formats,
  `.plans/`, `.signals/`, and `.code-reviews/` artifacts apply only to automated
  issue actions.
- **`scripts/lib/launcher.sh`** — banner describes both
  `coord next --issue <n>` (automated) and manual owner-driven operation with
  the scratch-branch name.
- **`scripts/setup_claude.sh`** — the generated session checklist accepts either
  an issue number or an owner-provided manual task instead of demanding an issue
  number. The `git push` guard at line 84 is untouched.
- **`scripts/setup_codex.sh`**, **`scripts/setup_cursor.sh`**,
  **`scripts/setup_antigravity.sh`** — same manual-aware wording in each
  vendor's generated identity block/rule.

All four setup scripts and both templates keep every existing identity, hook,
verification, no-force-push, and no-`main`-commit rule verbatim.

### Changed — documentation and release metadata

- **`README.md`** — document `coord manual`, issue-free behaviour, the
  `<agent>/<name>` convention, non-concurrency, and `coord detach manual`.
- **`docs/coord-driver.md`** — manual-mode authority, lifecycle, naming
  (`coord-manual-<group>`), exclusions, recovery, and the absence of coordinator
  artifacts/publication.
- **`docs/setup-workspace.md`** — manual use after onboarding, and uninstall
  cleanup/isolation.
- **`package.json`** — `version` `0.0.11` → `0.0.12` (non-`main` branches
  require a version strictly greater than `origin/main`, which is also at
  `0.0.11`).
- **`config.product.example.json`** — install stamp `version` `0.0.11` →
  `0.0.12` to stay aligned.

### Changed — tests

- `test/cli.test.ts`, `test/tmux.test.ts`, `test/detachIssue.test.ts`,
  `test/install.test.ts`, `test/onboard.test.ts` — enumerated under **Tests**.

### Intentionally unchanged

- `src/runLoop.ts`, `src/state.ts`, `src/action.ts`, `src/evidence.ts`,
  `src/finalization.ts`, `src/machine.ts`, `src/steps.ts` — manual mode must not
  enter or extend the automated workflow.
- `githooks/**` and `src/hookPolicy.ts` — `githooks/pre-commit:41` and
  `githooks/pre-push:94` already permit `<agent>/<name>` scratch branches while
  blocking `main`, peer branches, bad prefixes, and force pushes. That is
  already the correct policy for manual work.
- `src/githubIssue.ts`, `src/mirror.ts` — bypassed, not given no-issue states.
- `src/wipeIssue.ts` — issue-scoped by definition; widening
  `DetachIssueOptions.issue` leaves its call site compiling unchanged.

## Exact file list to be created

None. Every change lands in a file that already exists.

## Tests

All new tests are Vitest unit/integration tests in the existing `test/` suite,
run by `pnpm test:fast` (and therefore by `pnpm check:fast` and `pnpm check`).

### `test/tmux.test.ts`

1. `sessionName("manual")` with `titleGroup = "abc123"` returns
   `coord-manual-abc123`, and differs for a second group id (workspace
   isolation).
2. `sessionName("manual")` with no namespace and no title group throws — a
   manual session must never be created unscoped.
3. `ownerTerminalWindowTitle("manual", "claude", "abc123")` returns
   `coord-manual-abc123/claude`; `ownerTerminalTitlesToClose("manual", ids, group)`
   returns exactly those grouped titles and no bare agent names.
4. Regression: `sessionName(76)` is still `coord-76` flat and `coord-76-<ns>`
   namespaced, and `ownerTerminalWindowTitle(76, "claude", g)` is unchanged.
5. `ensureSession("manual", agents)` against a fake runner creates the session
   once, creates one window per agent, and sets `COORD_MANUAL` — asserting the
   recorded argv contains no `COORD_ISSUE` set-environment call.
6. `ensureSession("manual", …)` run a second time against a runner reporting an
   existing session with all windows present and panes alive issues **no**
   `new-session`, `new-window`, or `respawn-pane` (idempotent relaunch).
7. `ensureSession("manual", …)` with one window present but its pane dead issues
   exactly one `respawn-pane -k` for that agent and no `new-window`.
8. `openOwnerAgentClients("manual", agents, { onlyMissing: true })` with a title
   probe reporting one of two titles already open opens exactly the missing one
   and returns `count: 1`.

### `test/cli.test.ts`

9. `coord manual --product <onboarded>` resolves through
   `coord.ownerWorkspaceConfig`, calls the injected `manualUi` once with the
   workspace's namespace/group, and exits 0.
10. `coord manual --config <path> --coord-root <path>` resolves explicitly and
    behaves identically; supplying `--product` together with `--config` fails
    with the existing "not both" error.
11. **No automated side effects**: after `coord manual`, the workspace root
    contains no `issue-*` directory and no `mirror.git`; the injected
    `makeRunLoop` was never constructed; the injected `processRunner` recorded
    no `gh` invocation. (Fails today because the command does not exist; after
    the change it pins requirement 4.)
12. Idempotency at the CLI level: two successive `coord manual` runs both exit
    0, and the second reports "already open" rather than erroring — i.e. the
    command uses `ensureSession`, not `startSession`.
13. **Mode conflict, manual side**: with an `issue-76` runtime directory present
    and a `processRunner` answering `tmux has-session -t coord-76…` with exit 0,
    `coord manual` exits non-zero and the message names ``coord detach 76``.
14. **Mode conflict, automated side**: with a `processRunner` answering
    `tmux has-session -t coord-manual-<group>` with exit 0, `coord 76` exits
    non-zero, names ``coord detach manual``, and never invokes `startEffects`
    or the run loop. Same assertion for `coord start 76` and `coord run --issue 76`.
15. `coord detach manual --product <onboarded>` closes exactly the
    `coord-manual-<group>/<agent>` titles for the configured agents and kills
    only sessions matching `coord-manual-<group>`; `--dry-run` reports without
    acting.
16. `coord detach 76` still parses as a number and is unaffected by the new
    branch; `coord detach manual extra` (two positionals) still errors.
17. `coord manual --issue 3` errors with `Unknown option --issue.`
18. `coord --help` output contains `coord manual` and `coord detach manual`.
19. Version assertion at `test/cli.test.ts:100` updated to `0.0.12`.

### `test/detachIssue.test.ts`

20. `detachIssue({ issue: "manual", terminalGroup: "abc123", … })` closes titles
    **before** killing tmux (assert recorded call order), matching the existing
    close-before-kill invariant.
21. Exact scoping: with a session list containing `coord-manual-abc123`,
    `coord-manual-def456`, and `coord-76-abc123`, the manual detach kills only
    `coord-manual-abc123` and its `coord-manual-abc123-<agent>` client sessions.
22. `detachIssue({ issue: "manual", terminalGroup: null })` throws rather than
    tearing down an unscoped name.
23. `detachAllOwnerUiSync({ includeManual: true, issues: [], terminalGroup, listSessions })`
    with an injected list containing `coord-manual-<group>` still closes the
    manual titles and kills that session — the "no `issue-*` directories" case
    from requirement 5.
24. Cross-product safety: the same call with only `coord-manual-<otherGroup>`
    listed kills nothing.
25. `detachAllOwnerUiSync({ includeManual: true, dryRun: true, … })` reports
    `would kill` / `would close` and calls neither injected mutator.
26. Regression: existing `discoverCoordIssues` cases still return digits-only
    results when `coord-manual-<group>` is present in the list.

### `test/install.test.ts`

27. `config.coordination.version` assertion at line 134 updated to `0.0.12`.
28. Post-install log contains both the `coord start <issue> …` line and a
    `coord manual` line.
29. The clone `AGENTS.md` written by install contains the manual-mode /
    scratch-branch contract **and** still contains the existing no-`main`,
    no-force-push, and verification rules (guards against the protocol block
    being weakened rather than scoped).
30. `uninstall` with a workspace that has no `issue-*` directories and an
    injected session list containing `coord-manual-<group>` records a
    "detach owner UI" change and kills that session.

### `test/onboard.test.ts`

31. The `onboard()` success output advertises `coord manual` alongside
    `coord <issue>` from the registered product worktree.

### Acceptance checks

- `pnpm check:fast` (lint + typecheck + fast tests) before every commit.
- `pnpm check` (build + `check:fast` + e2e) as the coordinator gate.
- Manual smoke test from an onboarded product, which the unit suite cannot
  cover because it deliberately stubs tmux and Terminal: run `coord manual`,
  type an independent task into each opened agent window, run `coord manual`
  again and confirm no duplicate windows or sessions, confirm `coord 76` refuses
  while manual is up, then `coord detach manual` and confirm only that
  workspace's manual UI is gone (a second product's sessions and any
  `coord-<n>` sessions survive).

## Alternatives Rejected

**A. A `manual` workflow profile in the state machine.** Adding a fourth
profile alongside `solo|reviewed|consensus` would reuse `runLoop`, `cursors`,
and `action.md`. Rejected: it reintroduces exactly the machinery requirement 4
forbids, and every step function would need a "no issue" special case, spreading
optionality through `machine.ts`, `steps.ts`, and `evidence.ts` for a feature
that is only a launcher.

**B. Synthetic issue number (`coord 0` / `issue-manual`).** Cheap to name, but
`issueRuntimePaths()` rejects non-positive integers by design, and any synthetic
number would create a real `issue-*` directory that `listIssueNumbersInWorkspace()`,
uninstall, and `wipe-issue` would then treat as automated work. Rejected as a
correctness trap.

**C. A lock file (`manual.lock`) for mode exclusion.** Simplest to implement,
but it writes runtime state into the workspace, which requirement 4 forbids, and
a stale lock after a crash would block `coord N` with no session to detach.
Live tmux presence is self-healing: if the session is gone, the conflict is gone.

**D. Parallel manual-only helpers (`manualSessionName()`, `detachManual()`).**
No changes to existing signatures, but two naming code paths that must agree
forever. The current `ownerTerminalTitlesToClose` comments record that title/kill
drift is precisely what caused earlier cross-product teardown bugs. Rejected in
favour of one `SessionKey`-parameterised path.

**E. Reusing `startSession()` for manual launch.** It throws when the session
already exists, so a repeated `coord manual` would fail instead of repairing.
`ensureSession()` gives requirement 3's idempotency directly.

**F. Renaming `DetachIssueOptions.issue` to `session`.** Clearer name, but it
forces edits to `src/wipeIssue.ts`, which the issue's file map deliberately
leaves alone. Widening the field's type achieves the same with no churn.

**G. Weakening or bypassing the hooks for manual work.** Unnecessary:
`githooks/pre-commit` and `githooks/pre-push` already allow `<agent>/<name>`.
Any hook change here would remove a safety gate for no gain.

## Risks and Mitigations

**R1 — Widening `number` to `SessionKey` silently changes numeric behaviour.**
*Mitigation:* every widened function keeps its numeric branch byte-identical,
and tests 4 and 26 pin the existing `coord-<n>` names, titles, and
`discoverCoordIssues` results as regressions.

**R2 — Manual teardown kills another product's or another issue's sessions.**
This is the failure class the existing comments in `detachIssue.ts` were written
about. *Mitigation:* the manual prefix always carries the workspace group, and
tests 21 and 24 assert that a second group's manual session and a `coord-<n>`
session both survive.

**R3 — Unit tests spawn real tmux or AppleScript and destroy the operator's
live dogfood session.** *Mitigation:* the `manualUi` dependency hook and the
existing `processRunner` injection keep every manual code path stubbed;
`detachIssue`'s existing `underVitest()` guards already no-op the runner and the
Terminal closer. No new default-live code path is added to the CLI.

**R4 — The exclusion check has a race:** an issue can be started in the window
between the probe and `ensureSession`. *Mitigation:* accepted and documented.
The check targets the realistic owner mistake (starting one mode while the other
is plainly open), not concurrent invocations; both modes still hold the same
tmux/clone invariants, and the hooks remain the real safety boundary.

**R5 — Manual windows are missing `COORD_ISSUE`, so an agent tries `coord next`
and gets a confusing failure.** *Mitigation:* deliberate (decision 5), and the
launcher banner plus the four vendor identity blocks are updated in this same
change to tell the agent to follow the owner's chat request instead.

**R6 — Scoping the AGENTS/protocol language accidentally weakens automated-mode
requirements.** *Mitigation:* the edits add an "applies when an action exists"
clause and a manual section; they delete no rule. Test 29 asserts the clone's
generated `AGENTS.md` still carries the no-`main`, no-force-push, and
verification rules after the change.

**R7 — Version bump gate.** `package.json` and `origin/main` are both at
`0.0.11`, so the pre-1.0 ship gate fails until the bump. *Mitigation:* the bump
to `0.0.12`, the `config.product.example.json` stamp, and the two test
assertions (tests 19 and 27) are part of this plan's file map, and
`pnpm check:fast` on the branch enforces it.

**R8 — `coord manual` succeeds but silently opens nothing on a non-macOS
host.** *Mitigation:* `openOwnerAgentClients` already returns
`status: "unsupported"` with the attach commands, and `reportOwnerAgentClients`
prints them; the tmux session and windows are still created, so `tmux attach`
works. No new behaviour needed, but it is called out in `docs/coord-driver.md`.

## Conclusion

Manual mode is implemented as a launch/attach lifecycle over the tmux and
Terminal machinery that already exists, parameterised by a single new
`SessionKey = number | "manual"` so that launch, detach, and uninstall cannot
drift apart in how they name a workspace's manual UI. `coord manual` resolves
the onboarded workspace, refuses to run while that workspace has a live issue
session, validates launchers, creates or repairs the agent windows, opens only
the missing Terminal windows, and returns — writing no issue runtime, no
`action.md`, and no GitHub state. `coord detach manual` and `coord uninstall`
tear down exactly that workspace's manual session and titles and nothing else.

No schema, issue-runtime, evidence, state-machine, or hook-policy change is
required, and the safety gates that make agent work reviewable — no commits on
`main`, no commits to a peer's branch, no force pushes, declared checks — remain
in force unchanged for manual work on `<agent>/<name>` scratch branches.

Twenty-two of the thirty-one listed tests are new; the rest are regression pins
or version updates on existing assertions. `pnpm check:fast` gates every commit,
`pnpm check` gates acceptance, and the documented manual smoke test covers the
tmux/Terminal effects the unit suite deliberately stubs.
