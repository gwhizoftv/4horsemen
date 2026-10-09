# Issue 172 plan — coord manual issues

Issue 172 lists ten owner-reported problems. Each is mapped below to the
smallest change that removes it, or to the existing code that already does.

| # | Issue item | Resolution |
|---|---|---|
| 1 | Status report has no clear start/stop | Labeled begin/end frame in `renderIssueReport` |
| 2 | Guard treats an inherited `COORD_ISSUE` as proof of automation | Shim honors `COORD_MANUAL=1` and positive staleness evidence; tmux sessions *remove* (not merely unset) the other mode's variable |
| 3 | Codex app-server keeps a previous issue's context | Already fixed at baseline by issue 186 (`codex --no-daemon` in `scripts/lib/launcher.sh`); no change |
| 4 | `coord detach manual` must be run by hand before `coord <issue>` | Leftover manual session is detected and, after owner confirmation, torn down by the same routine as `coord detach manual` |
| 5 | `coord <issue>` after manual fails on clone dirt | Items 6–8 remove the cause and fix the advice |
| 6 | `.pnpm-store/` counts as dirt | Add to this repo's `.gitignore` and to the per-clone managed exclude list |
| 7 | `coord detach manual` leaves clones off base | Detach manual returns clean, fully published clones to base; refuses (never discards) otherwise |
| 8 | Start-time refusal says "Commit/stash" for untracked junk | Name the paths and point at `coord reset-clones <issue> --force` when a clone's blocking paths are all untracked |
| 9 | `--coord-runtime` needed even inside an onboarded workspace/clone | Infer runtime from the current worktree (owner checkout *or* registered agent clone), or from `--config` alone; `doctor` likewise |
| 10a | No `n`udge for all agents | Add an "All agents" row to the existing interactive `n` reminder menu |
| 10b | Agents not verified in correct tmux session/terminal; leftovers not detected | Startup placement diagnostic per agent pane; pre-start detection of a leftover session for the same issue with owner-confirmed cleanup |

## Exact File List to be changed or deleted

- `.gitignore` — add `.pnpm-store/` (item 6, this repository's own clones).
- `src/productIgnore.ts` — add `".pnpm-store/"` to `DEFAULT_CLONE_IGNORES` so every
  product clone's `.git/info/exclude` hides a sandbox-local pnpm store (item 6,
  "could also happen during a normal issue run").
- `src/issueReport.ts` — replace the two bare `"----"` frame lines in
  `renderIssueReport` with `==== coord status: issue <N> ====` and
  `==== end coord status: issue <N> ====` (item 1). Callers in `cli.ts` (`status`,
  interactive `s`) and `runLoop.ts` (paused/finished log) are unchanged.
- `src/interactive.ts` — in the `n` handler, when more than one reminder is
  offered, append an `All agents` item whose `run` calls every captured
  `request()` independently, printing each result or each per-agent error so one
  refusal does not suppress the others; update the `help` text line for `n`
  (item 10a). No change to `InteractiveCommands` or `CoordinatorRunLoop.reminders`.
- `scripts/lib/launcher.sh` (`write_git_wrapper` template only) — item 2:
  - Extract the existing root resolution in `coord_action_lists_files` into
    `coord_runtime_root` (same nested-vs-flat logic, same fail-open returns) and
    call it from `coord_action_lists_files`.
  - After the existing `COORD_ISSUE` regex check: `COORD_MANUAL=1` → `delegate`.
  - After the existing "targets this clone" check: when `coord_runtime_root`
    resolves, `delegate` if `$root/issue-$COORD_ISSUE` does not exist, or its
    `cursors.json` has a top-level `"completed": true` or `"abandoned": true`
    (matched with the two-space-indented key line that `atomicWriteJson`'s
    `JSON.stringify(value, null, 2)` writes). An unresolvable root keeps today's
    refusal. Only positive evidence of staleness relaxes it.
  - The native guard (`guardShellRequest`) already consults this shim with
    `COORD_GIT_POLICY_CHECK=1`, so it inherits the same policy with no TS change.
- `src/tmux.ts` — item 2 and item 10b:
  - `ensureSession("manual")`: `set-environment -r` (remove from child
    environment) instead of `-u` for `COORD_ISSUE`, so a `COORD_ISSUE` in the tmux
    server's global environment cannot leak into manual panes.
  - `startSession(issue)` and `ensureSession(issue)`: also `set-environment -r -t
    <session> COORD_MANUAL`, so a leaked `COORD_MANUAL=1` can never disarm the
    shim in an automated pane.
  - New `agentPlacementDiagnostics(issue, agents)`: for each agent,
    `display-message -p -t <target(issue, agent)> '#{pane_dead}\t#{pane_start_path}'`.
    It returns a `[WARN]` line when the pane is missing or dead, or when the start
    path is not `resolve(agent.root)`. If `titleProbe` is available, it also warns
    when an expected `agentAttachLaunches(...).windowTitle` Terminal window is
    absent, and names `coord attach <issue>`. It returns `[OK]` per agent otherwise.
    The method reads only and never kills or relaunches anything.
- `src/runLoop.ts` — `reportStartup()`: after the existing
  `issueEnvironmentDiagnostic` call, log each line from
  `this.tmux.agentPlacementDiagnostics(start.issue, activeAgents)` behind the same
  `typeof ... === "function"` guard used for fakes (item 10b).
- `src/prepareAgentBranch.ts` — items 7 and 8:
  - `prepareAgentIssueBranches` refusal: list each dirty clone with its blocking
    paths. When every blocking line in a clone is untracked (`??`), say these are
    untracked leftovers and give `coord reset-clones <issue> --force` (which
    discards them and returns the clone to base). Otherwise keep "Commit/stash
    them". It keeps "Nothing has been changed" and keeps the existing
    `uncommitted changes in <clone>` substring.
  - New exported `makeManualClonesBaseReady({ agents, baseBranch, installRoot?,
    dryRun?, log? }): CloneBaseReadyResult[]`. It refuses, without touching a
    clone, when `blockingDirtyPaths` is non-empty, or when after
    `resolveCloneBaseTarget` HEAD is not an ancestor of the resolved base target
    and not an ancestor of its upstream (`@{u}`), or when local `<base>` has
    commits absent from the target. Otherwise it checks out base. To share code,
    the checkout + protocol lift/restore + post-checkout verification block of
    `makeAgentClonesBaseReady` is extracted unchanged into a private helper
    (`checkOutCloneBase`) and called by both. `makeAgentClonesBaseReady`
    behavior is unchanged. The function never resets, cleans, stashes or deletes
    branches.
- `src/cli.ts` — items 4, 7, 9, 10b:
  - `resolveStart`: no flags → `resolveWorkspaceFromWorktree(io.cwd)` (accepts the
    owner checkout and registered agent clones) instead of
    `resolveWorkspaceFromProduct(io.cwd)`. `--config` alone → runtime root is
    `workspaceLocationFromConfig(config).workspaceRoot`. `--coord-runtime` alone
    remains an error, and its message says `--config` may be given alone.
  - `doctor`: when `--coord-runtime` is omitted, take `coordRoot` (and, without
    `--product/--project`, the project) from `resolveWorkspaceFromProduct(--product)`
    or `resolveWorkspaceFromWorktree(cwd)`.
  - New `detachManual(...)` closure used by `coord detach manual` and by leftover
    cleanup. It calls the existing `detachIssue({ issue: "manual", ... })`, then
    `makeManualClonesBaseReady` (honoring `--dry-run`). It prints a
    clone-readiness summary and returns 1 with per-clone reasons on any refusal.
  - New optional `CliDependencies.confirm?: (question: string) => Promise<boolean>`.
    The default is `false` under Vitest or when stdin/stdout is not a TTY.
    Otherwise it uses a `node:readline/promises` question accepting `y`/`yes`.
  - `assertNoManualSession(root, cleanup)`: when the manual session is live,
    ask "Close manual session <name> and return its clones to <base>?". On yes,
    run `detachManual` and continue only if no clone was refused. On no or
    non-TTY, throw the existing error, which still names `coord detach manual`.
    All four existing callers (`coord <issue>`, `start`, `attach`,
    `run`/`assertIssueCanRun`) pass the agents/base/installRoot they already hold.
  - Before `startIssue` (fresh `coord <issue>` and `start`): if the issue's tmux
    session already exists with no runtime, ask to close it via the existing
    `detachIssue`. On no, refuse with `coord detach <issue>` before branches or
    runtime are touched. Today `startSession` throws only after both exist.
  - `help`/`commandDescriptions`: document runtime inference and `--config`-only;
    note that `detach manual` returns clones to base and refuses unpublished work.

Deleted: none.

## Exact file list to be created

- `.plans/issue-172/plan.md` (this plan; coordination evidence only).

No product source, test, fixture or documentation file is created. Every product
change extends an existing module and every test joins an existing test file.

## Reuse and Scope

Reused, not reimplemented:
- `detachIssue` (`src/detachIssue.ts`) for every session/Terminal teardown,
  including the leftover-session cleanup. Its Vitest no-op runner/closer keeps
  the tests off the host UI.
- `blockingDirtyPaths`, `resolveCloneBaseTarget`, `captureCloneAgentsProtocol`,
  `liftCloneAgentsProtocol`, `restoreProtocol`, `cloneAgentsProtocolState`, and
  the `CloneBaseReadyResult` type (`src/prepareAgentBranch.ts`) for manual clone
  readiness. The checkout block is extracted, not copied.
- `resolveWorkspaceFromWorktree`, `resolveWorkspaceFromProduct`,
  `workspaceLocationFromConfig` (`src/workspace.ts`) for runtime inference.
  `existingContext` already uses them for issue commands, and this extends the
  same inference to `resolveStart` and `doctor`.
- `TmuxController.target`, `agentAttachLaunches`, `titleProbe`, and the existing
  `issueEnvironmentDiagnostic` pattern for placement checks. `reportStartup`'s
  existing one-shot reporting is the call site.
- `CoordinatorRunLoop.reminders()` and its captured per-agent request guards for
  "All agents". No new reminder path or bypass of readiness/send limits.
- The shim's own `delegate`, `coord_action_lists_files` resolution and fail-open
  conventions. `guardShellRequest` reuses the shim policy unchanged.
- `DEFAULT_CLONE_IGNORES` / `writeManagedIgnoreFile` for the clone exclude.
- Test fixtures: `makeProduct`, `writeGitWrapper`, `effectOptions`
  (`test/support/workspaceFixture.ts`, `src/setupWorkspace.ts`), the fake tmux
  runners in `test/tmux.test.ts`, `setup()`/`installedWorkspace()`/`fakeLoop` in
  `test/cli.test.ts`, and the clone fixtures in `test/prepareAgentBranch.test.ts`.

Scope limits: no new command (`coord manual --done` is not added, because
`detach manual` gains the behavior). No change to `githooks/`, hook policy,
containment ingestion, the agent-event path, `uninstall`, or `install`. No new
dependency (`node:readline/promises` is built in). No version bump.

## Tests

Each case below fails at baseline `80a3e71` and passes after the change. All
join existing files.

- `test/issueReport.test.ts`: update "frames the whole report…" to expect
  `^==== coord status: issue 1 ====\n\[ACTION\] Issue 1: paused` and a trailing
  `Queued guidance: 0\n==== end coord status: issue 1 ====\n$`.
- `test/interactive.test.ts`: new case. With two reminders, the first throws and
  the second returns a message. `n`, then the `All agents` number, prints both the
  error and the success, and calls each `request` exactly once. With one reminder,
  no `All agents` row is shown.
- `test/shellGuard.test.ts`: new case in "native shell guard shared policy" using
  the existing `fixture()` plus `coord.workspaceConfig`/`consensus.agentId`, as
  in the pinned-read test. `git status` with `COORD_ISSUE=42`:
  - denied while `issue-42/` exists with `cursors.json` `"completed": false`;
  - allowed with `COORD_MANUAL=1`;
  - allowed after `cursors.json` is rewritten with top-level `"completed": true`;
  - allowed after `"abandoned": true`;
  - allowed when `issue-42/` is removed.
  The existing first test, which has no workspace config, keeps proving that an
  unresolvable binding still denies.
- `test/tmux.test.ts`:
  - the manual-environment test expects `set-environment -r … COORD_ISSUE`;
  - a new assertion expects `set-environment -r -t coord-<n>… COORD_MANUAL` from
    `startSession`/`ensureSession(issue)`;
  - a new `agentPlacementDiagnostics` case, beside `issueEnvironmentDiagnostic`,
    with a fake runner covering a correct pane (`[OK]`), a dead pane, a pane whose
    start path differs, and a missing Terminal title (each `[WARN]`).
- `test/runLoop.test.ts`: extend the existing `reportStartup` case (line ~311).
  A fake tmux exposing `agentPlacementDiagnostics` has its lines logged once,
  across both calls.
- `test/prepareAgentBranch.test.ts`:
  - an untracked-only dirty clone's refusal contains
    `coord reset-clones 7 --force`, while a tracked modification keeps
    `Commit/stash`;
  - `makeManualClonesBaseReady`: a clean branch merged into `origin/main` returns
    `checked-out` on main with the overlay restored;
  - a clean branch with an unpushed commit is `refused`, with HEAD, branch and
    commit unchanged;
  - a dirty clone is `refused`, with the worktree unchanged;
  - local `main` ahead of origin is `refused`.
- `test/cli.test.ts`:
  - extend "rejects new and resumed automated entry points while manual UI is
    live". With `confirm: async () => true` and a clean fixture, `start` proceeds
    past the manual check. With the default `confirm`, it still exits 2 naming
    `coord detach manual`;
  - extend "dispatches exact manual teardown…" so the summary includes
    `Clone readiness`;
  - extend "infers owner and registered clone context…" so
    `reset-clones 89 --dry-run` and `detach 89 --dry-run` succeed from the agent
    clone cwd with no runtime flags, and `start` accepts `--config` without
    `--coord-runtime`.
- `test/install.test.ts`: extend the `.git/info/exclude` assertion at line ~830
  with `.pnpm-store/`.

Developer runs: focused `pnpm vitest run --config vitest.config.ts <file>` per
touched test file. The commit hook owns `pnpm check:fast`. The coordinator owns
final `pnpm check`.

## Alternatives Rejected

- **Auto-detaching a live manual session without asking.** It would kill agent
  CLIs the owner may still be using. The issue's own last item asks to "ask the
  owner", so cleanup is gated on confirmation, and non-TTY runs keep today's
  refusal.
- **Discarding manual-branch dirt on detach (reuse `force-wipe`).** The owner
  asked that unpushed or unmerged work cause a refusal, not deletion.
  `reset-clones --force` remains the explicit discard path.
- **Adding `staleness` logic to `guardShellRequest` in TypeScript.** That would
  fork the policy. The guard already asks the shim, so one shell-side change
  covers both the native guard and direct `git` calls.
- **Treating an absent `action.md` as stale.** The protocol allows `action.md` to
  be missing during a live issue after acceptance, so that would open the guard
  mid-issue. Issue-directory absence and a top-level completed/abandoned flag
  are durable.
- **Restarting the Codex app-server daemon from `coord manual`.** Issue 186
  already launches Codex with `--no-daemon`, so a stale daemon is no longer
  consulted. Restarting a user-global daemon would also affect unrelated Codex
  sessions.
- **A new `coord nudge` command.** Nudges are delivered by the foreground runner's
  readiness-gated path. A separate process would need a new cross-process
  request channel. The interactive `n` menu already owns this path.
- **Defaulting `--coord-runtime` for `uninstall`.** It is destructive, so its
  explicit-path contract is kept.
- **A `coord manual --done` command.** `detach manual` already exists and is what
  owners run, so extending it avoids a second teardown verb.

## Risks and Mitigations

- **Shim relaxation could disarm containment in a live issue.** It relaxes only on
  `COORD_MANUAL=1`, which automated sessions now actively remove, or on positive
  durable evidence (issue directory absent, or top-level completed/abandoned).
  An unresolvable config keeps the refusal. Tests cover both live-deny and each
  stale-allow path.
- **Existing clones keep the old shim and exclude list until regenerated.** Both
  are written by `coord install` (and the shim also by `githooks/post-merge`), as
  today. The binding hash changes with the shim bytes, so stale probes are
  invalidated by design (`containmentPolicy`).
- **The `-r` vs `-u` tmux semantics.** `-r` marks the variable for removal from
  every process started in that session, which is the needed behavior, and the
  test asserts the exact argv.
- **False placement warnings during CLI startup.** The check uses
  `pane_start_path` and `pane_dead`, which are fixed at creation, not the racy
  foreground command. It is advisory `[WARN]` output only and never blocks
  work.
- **A confirmation prompt in non-interactive callers.** The default `confirm`
  returns false without a TTY and under Vitest, so scripted runs keep the exact
  current refusal and exit code 2.
- **Extracting the checkout block from `makeAgentClonesBaseReady`.** It is a
  verbatim move. The existing readiness tests in
  `test/prepareAgentBranch.test.ts` must pass unchanged.
- **Report frame text change.** Only `issueReport.test.ts` asserts the frame. The
  run loop logs the same function, so the frame stays consistent everywhere.

## Conclusion

Every item in issue 172 is addressed with small extensions to existing modules:

- a labeled status frame;
- a shim that recognizes manual mode and stale issue bindings, with tmux sessions
  that remove the other mode's variable;
- owner-confirmed cleanup of leftover manual or same-issue sessions;
- `detach manual` returning published, clean clones to base and refusing
  otherwise;
- `.pnpm-store/` ignored in this repository and in every clone;
- an accurate start-time refusal;
- runtime inference from any onboarded worktree or `--config`;
- an "All agents" reminder;
- a per-agent placement diagnostic.

The Codex app-server item is already resolved at baseline by issue 186. The plan
creates no product files and adds no dependency. Its tests extend eight existing
test files.
