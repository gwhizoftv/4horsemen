# Issue 172 implementation comparison

Bound implementation pins, all implementing the selected Claude plan
`3e67191cefbc89b732f7cf8c412b3b30e214bc5e`:

- cursor `abb2cf2b4afdcf38c67bec77a556385c282410e3`
- claude `38d0460c436ade9a8fb7bdba6070ae923e2d1d80`
- codex `e62ba296c26b0602dbefb300604e83a057e200d6`
- antigravity `7427ebfca2a4969916aabf54d698146a49d4b2c9`

**Method.** I read each bound worktree directly. I compared it with plain
`diff -ru` against a `git archive` export of baseline `80a3e71`, and did not run
`git diff` in this clone.

**Checks I ran.**

- **Shim probes.** I generated each pin's shim from its own
  `scripts/lib/launcher.sh` (`write_git_wrapper`) into a scratch Git repo. Its
  `coord.workspaceConfig` was `…/rt/workspaces/app/config.json`. Each run was
  `COORD_ISSUE=42 COORD_GIT_POLICY_CHECK=1 <shim> status`, where exit 2 means
  refuse and exit 0 means allow.
  - **Live nested issue** (`…/workspaces/app/issue-42/cursors.json`, not
    completed): antigravity **0**; cursor 2, codex 2, claude 2.
  - **Live legacy outer issue** (`…/rt/issue-42`): cursor **0**; antigravity 2,
    codex 2, claude 2.
- **Antigravity's pin.** On a scratch copy with this clone's `node_modules`
  linked, `npx vitest run --config vitest.config.ts test/issueReport.test.ts`
  ran 9 tests: 1 failed and 8 passed.
- **My own pin's earlier results.** At claude `38d0460`, the commit hook's
  `pnpm check:fast` passed (lint, typecheck, fast and system tests), and so did
  the push hook.

I ran no other peer suite, and I make no claims about checks the coordinator
owns.

## Comparison

All four pins cover the same surface:

- labeled status frame;
- `.pnpm-store/` in `.gitignore` and `DEFAULT_CLONE_IGNORES`;
- the "All agents" `n` row;
- `set-environment -r` in both tmux modes;
- shim relaxation on `COORD_MANUAL` and on stale issues;
- `makeManualClonesBaseReady`;
- start-time refusal advice;
- the `confirm` dependency;
- leftover-session prompts;
- `agentPlacementDiagnostics` wired into `reportStartup`;
- runtime inference in `resolveStart` and `doctor`.

They differ in how safely they handle the guard and the manual-cleanup ordering.

### Findings

**F1 — antigravity `scripts/lib/launcher.sh:198-200`.** `coord_runtime_root`
returns the outer runtime for a nested layout. The shim then delegates when
`$outer/issue-$COORD_ISSUE` is absent.

- *Rule:* staleness must be judged where the live issue actually lives. Current
  nested issues are created under the workspace directory: `resolveStart` uses
  `runtimeRoot = workspace.workspaceRoot`, and `startIssue` builds
  `issueRuntimePaths(coordRoot, issue)` from it.
- *Failure:* in every current nested workspace the shim allows `git status` and
  `git diff` throughout a live automated issue. The guard is silently disabled.
  The probe above proves it: exit 0 for a live, non-completed
  `workspaces/app/issue-42`.
- *Test:* in `test/shellGuard.test.ts`, write a nested `config.json` and a live
  `workspaces/app/issue-42/cursors.json`, then expect `git status` with
  `COORD_ISSUE=42` to be denied.

**F2 — antigravity `test/issueReport.test.ts:212`.** The pin changes the frame in
`src/issueReport.ts` to `==== coord status: issue N ====` but leaves the
existing assertion `/^----\n\[ACTION\] Issue 1: paused/` unchanged.

- *Rule:* the implementation pin must pass the declared fast suite.
- *Failure:* `test/issueReport.test.ts` fails at this pin ("frames the whole
  report…", 1 failed of 9), so `pnpm check:fast` and the coordinator's final
  `pnpm check` fail.
- *Fix:* update the two frame assertions, as the other three pins do.

**F3 — antigravity `src/cli.ts:724` then `:748`.** `detachManual` calls
`detachIssue` (killing the manual tmux sessions and closing Terminal windows)
before `makeManualClonesBaseReady` decides whether any clone is ready.

- *Rule:* a refusal for uncommitted or unpushed manual work must be decided
  before teardown. Then the owner's agents can still commit and push it.
- *Failure:* `coord detach manual` with one clone holding unpushed commits kills
  every manual agent, then reports the refusal. The work is intact on disk, but
  the running sessions that were finishing it are gone. The same happens on the
  confirmed path from `coord <issue>`.
- *Test:* in `test/cli.test.ts`, use one unpushed scratch clone, run
  `detach manual`, and expect the tmux runner never to receive `kill-session`.

**F4 — antigravity `src/prepareAgentBranch.ts:669`.**
`makeManualClonesBaseReady` decides and checks out per clone inside one loop.

- *Rule:* the manual transition is all-or-nothing, as the plan requires: "a
  single clone with … refuses every clone".
- *Failure:* with clones A (clean, published) and B (unpushed), A is switched to
  `main` before B is refused. The owner ends with a half-transitioned workspace.
- *Test:* in `test/prepareAgentBranch.test.ts`, make a two-clone batch with B
  unpushed, and expect A's HEAD still on its scratch branch.

**F5 — antigravity `src/cli.ts:428` and `:188`/`:1087`.**

- *Rule:* stay within the approved plan.
  - Item 9 requires `--config` alone to work. This pin keeps
    `hasConfig !== hasCoordRoot` → "must be supplied together", although its
    help text now advertises "or from --config alone".
  - The plan explicitly rejected `coord manual --done`, and this pin adds it as
    a second teardown verb.
- *Failure:* `coord reset-clones 7 --dry-run --config <path>` still exits 2,
  contradicting the help, and owners get two teardown commands for one
  behavior.

**F6 — cursor `scripts/lib/launcher.sh:202-208`.** `coord_runtime_root` returns
only the workspace directory, and the shim treats a missing
`$dir/issue-$COORD_ISSUE` as stale.

- *Rule:* a live issue that coord still resumes must keep the guard. For nested
  installs, `existingIssueRuntime` still resolves and runs legacy runtimes under
  `workspace.coordRoot`.
- *Failure:* for a legacy nested issue resumed with `coord <issue>`, the shim
  allows `git status`/`diff` during automation (probe: exit 0).
- *Fix:* treat the issue as live if either location exists, as the claude pin
  does, or keep refusing when only the outer one exists, as the codex pin does.

**F7 — claude `src/cli.ts:933`, cursor `src/cli.ts:971`, antigravity
`src/cli.ts:948`.** On a declined or non-TTY leftover-session prompt, each tells
the owner to "Run `coord detach N` first". In these pins the numeric `detach`
with no runtime still passes `tmuxNamespace: null` (claude `:1341`, cursor
`:1397`, antigravity `:1375`).

- *Rule:* recovery advice must act only on this workspace's sessions.
- *Failure:* with a null namespace, `listIssueSessions(N)` matches every
  `coord-N-*` session. Following the advice kills another workspace's live
  issue-N session and its linked clients.
- *Fix:* codex `src/cli.ts:1284` falls back to
  `workspaceUiIdentity(resolution.runtimeRoot)` when the runtime is missing;
  the other pins should do the same.
- *Test:* in `test/cli.test.ts`, run `detach 7` with no runtime and an injected
  session list holding `coord-7-<this ns>` and `coord-7-<other ns>`, and expect
  only the first to be killed.

**F8 — codex `src/cli.ts:751` and cursor `src/cli.ts:836`.**
`assertIssueCanRun` builds the manual cleanup from `start.agents` (the issue
roster), not the configured agents.

- *Rule:* the manual session opened by `coord manual` covers every configured
  agent, so its cleanup must too.
- *Failure:* for a `solo`-profile issue, confirming cleanup from `coord run`
  closes only the roster agent's linked client and readies only that clone.
  Other agents' manual Terminal clients survive, and their clones stay off
  base. This is low severity because it affects only `run` for reduced
  rosters.

**F9 — codex `src/tmux.ts:859`.** The pin reports
`[WARN] … live pane placement unavailable` whenever `pane_start_path` is empty.

- *Rule:* an advisory check should report unknown as unknown. The plan review's
  M1 correction was applied by the cursor, claude and antigravity pins.
- *Failure:* on a tmux build without that format, every agent warns at every
  startup.

**F10 — codex `src/prepareAgentBranch.ts:658`.** The pin refuses the whole manual
batch when any configured clone is missing.

- *Failure:* a deleted or never-created clone blocks `coord detach manual`
  indefinitely, until the config is edited.
- *Severity:* low, because `coord manual` itself refuses to launch with a
  missing clone.

### Scope, reuse and tests

**codex.** It is the closest to the plan with the safest effects:
- It runs a batch preflight before teardown, through a `beforeCheckout`
  callback.
- It re-checks HEAD, branch and dirt after the UI closes, and refuses if a
  clone changed meanwhile.
- It fast-forwards the base without `-B`, and refuses when publication cannot
  be verified offline.
- It is conservative about legacy nested runtimes, and scopes numeric detach to
  the workspace (F7 fixed).

It also wires placement into `coord manual` and refactors
`snapshotCloneReadiness` to take a branch function, which is justified by
reuse. It extracts the shared `checkOutCloneBase` helper and keeps tests in
existing files. Minor: F8, F9 and F10.

**claude.** It follows the plan and the review corrections:
- Batch preflight runs before teardown, with all-or-nothing refusal.
- Nested runtimes are checked in both locations.
- An empty start path is treated as unknown.
- The shared helper is extracted verbatim.

Tests stay in the eight approved test files. Its weaknesses are F7, and that it
does not re-check clones between preflight and checkout (codex does). It uses
`checkout -B base origin/base` only after proving the local base is an ancestor,
which makes it a fast-forward.

**cursor.** Its manual path is sound: batch preflight, a fast-forward-only
manual checkout, and refusal on detached HEAD. It handles the confirm prompt
and its tests are focused. Weaknesses: F6 (guard open for legacy nested
issues), F7 and F8. Its diff is the largest (+884 lines), mostly in tests and
a second copy of the checkout block (`checkOutCloneBaseManual`) beside the
extracted `checkOutCloneBase`.

**antigravity.** It is not acceptable as is:
- F1 disables the guard in current nested workspaces.
- F2 fails the fast suite.
- F3 and F4 tear down sessions and switch clones before refusing.
- F5 omits `--config` alone and adds the rejected `manual --done`.

It also leaves `test/interactive.test.ts` untested for the new row.

**Ranking:** codex > claude > cursor > antigravity.

Codex's pin is the strongest implementation of the selected plan. The claude pin
is close behind and differs only by F7 and the absent re-check after teardown.
Cursor needs F6 fixed before its guard is trustworthy. Antigravity needs F1–F5.
