# Issue 172 — manual-session lifecycle and owner controls

Protocol version: 1. Planning action: `a2249177-f0ab-46a6-a7d6-c4e5a6c8a7bf`.
Issue session: `issue-172:80a3e714afda3c63bc89726d77a0cd61aee08b17`.
Baseline: `80a3e714afda3c63bc89726d77a0cd61aee08b17`.
Requirements are the coordinator's frozen `github-issue.json` for issue 172.

The change will make manual-to-automated transitions preserve owner work, stop stale issue environments from activating automated restrictions, infer an installed runtime consistently, and complete the existing reminder control. It will verify the actual agent panes before declaring startup successful. It will not introduce a new workflow profile.

## Exact File List to be changed or deleted

No files will be deleted. Change only these existing files:

| File | Intended change |
| --- | --- |
| `.gitignore` | Ignore `.pnpm-store/` in this repository. |
| `src/productIgnore.ts` | Add `.pnpm-store/` to `DEFAULT_CLONE_IGNORES` so ordinary installed clones receive it through their managed exclude block. |
| `templates/product/gitignore.coordination.block` | Keep the shipped product ignore template consistent with the managed defaults. |
| `scripts/lib/launcher.sh` | Clear inherited automation context on an explicit manual launch; make the generated Git shim consult validated session context; retain Codex's existing `--no-daemon` and narrow grants. |
| `src/shellGuard.ts` | Resolve current automated context before applying restrictions, sharing that resolution between the native guard and the generated shim. |
| `src/agentEvent.ts` | Avoid binding manual callbacks or stale inherited issue callbacks to the wrong runtime; validate prompt-derived action identity before preferring it to stale environment context. |
| `src/workspace.ts` | Add a narrow installed-location resolver using existing owner/clone locators and unambiguous runtime/config locations. |
| `src/cli.ts` | Wire shared context discovery, safe manual completion/reconciliation, internal shim context lookup, startup diagnostics, and updated help. |
| `src/prepareAgentBranch.ts` | Add a non-discarding manual branch readiness path alongside the existing issue cleanup path; classify start-time refusals accurately. |
| `src/tmux.ts` | Inspect exact session/window/pane ownership and foreground process evidence; reconcile stale manual UI and verify newly launched/reused panes; normalize mode environment in both launch paths. |
| `src/interactive.ts` | Extend the existing `n` menu with an all-current-tasks choice using captured individual reminder requests. |
| `docs/coord-driver.md` | Document the transition rules, implicit runtime selection, verification of terminals, reminder choices, and recovery commands. |
| `test/shellGuard.test.ts` | Extend native guard fixtures with current/stale/manual session context and retain existing command-classification cases. |
| `test/agentEvent.test.ts` | Add manual callback and stale-environment/current-action routing cases. |
| `test/workspace.test.ts` | Extend installed-location discovery and ambiguity/foreign-locator coverage. |
| `test/cli.test.ts` | Exercise the affected command entry points, cleanup ordering, refusals, discovery, and startup reporting through injected dependencies. |
| `test/prepareAgentBranch.test.ts` | Exercise clean, pushed/merged manual branches, refusals preserving all work, and classified remediation. |
| `test/tmux.test.ts` | Exercise inherited mode variables, wrong/dead/busy panes, exact ownership, and safe cleanup/relaunch with fake runners. |
| `test/interactive.test.ts` | Test the bulk reminder selection and per-agent results without weakening the existing single-agent behavior. |
| `test/install.test.ts` | Execute generated launcher/shim behavior with stubs and assert package-cache exclusion in default and product-write installs. |

## Exact file list to be created

No new product files, test files, fixtures, dependencies, or runtime schemas are needed. This action creates only `.plans/issue-172/plan.md`, the required coordination artifact. Extend the existing modules and fixtures listed above. If implementation needs another file, request a scope amendment before submitting product changes.

## Reuse and Scope

### Existing behavior to retain

`renderIssueReport` in `src/issueReport.ts` already wraps the whole report in `----` lines. `test/issueReport.test.ts` already asserts both boundaries, and both `coord status` and interactive `s` call that renderer. This satisfies the status-separation request at the baseline; keep those assertions and run that existing test file rather than introducing another report renderer.

`launcher_command` already passes `--no-daemon` to Codex, and the generated-launcher test already asserts that argument. Preserve it and extend execution coverage to manual and successive issue environments. Do not restart or kill a user-global Codex daemon: the existing per-launch isolation addresses that part of the issue without affecting other projects.

Interactive `n` and `CoordinatorRunLoop.reminders()` already exist. Reuse their captured action ID, digest, session, and hook sequence, and the existing send reservation, spacing, four-send limit, composer checks, and hold handling. Add only the missing all-agents choice; do not create another delivery mechanism or a second coordinator process.

### 1. Validate automation context and remove stale manual context

Extend `src/shellGuard.ts` with one read-only context resolver, using `resolveWorkspaceFromWorktree`/`resolveWorkspaceConfig`, `workspaceLocationFromConfig`, `readStartState`, `readCursorsState`, `readAgentLifecycle`, `agentRuntimePaths`, and existing Git delegation. Its result distinguishes a current binding from manual/stale context and unavailable evidence. `COORD_ISSUE` alone must never establish a current binding.

A current binding must match the configured clone root and agent, the runtime's config and agent root, the active roster, a noncompleted/nonabandoned issue, and the prepared issue branch. Validate vendor session identity against the stored lifecycle session when a native request supplies it. A mismatched native session is stale even if its inherited issue and clone are correct. The standalone shim must require positive launch/session evidence, using the exact tmux pane/session and clone ownership (and a vendor session identity when available), rather than treating an issue number as proof. Missing or unreadable evidence returns an explicit unverified diagnostic and does not manufacture either an automated denial or a claim of coverage. Paused issues remain automated; temporary absence of an action between workflow steps does not by itself retire a valid binding.

Expose this resolver through a small internal CLI context-query mode for the generated shim, using the clone's existing `coord.cliEntry` and the real Git path. Return data, never shell source to evaluate. Keep the four-argument `write_git_wrapper` interface and existing installer/post-merge callers. `guardShellRequest` checks normalized request identity and uses the same resolver and existing literal-command policy; the context query does not call the shim recursively. Keep subprocess time/output bounds and warnings. Use the resolved current action path for the existing complete/partial Bound-input test, including workspace-scoped nested runtime locations. Existing local `HEAD:path`, other-repository, and incomplete-export allowances remain intact.

At generated launcher entry, explicit `COORD_MANUAL=1` clears `COORD_ISSUE` before computing any grants or starting any harness. In `TmuxController.startSession` and numeric `ensureSession`, remove inherited `COORD_MANUAL`; manual `ensureSession` removes the issue variable and sets manual mode. Setting tmux environment does not change an already-running child's environment: never report that alone as a repaired harness.

Pass manual-mode context to `handleAgentEvent` so a manual session cannot be adopted through its unique-active-issue fallback. When an automated prompt provides an action path/ID/digest, validate all of them against that agent's current action and runtime before using them instead of a conflicting inherited issue. Nonprompt callbacks with a known session must match the selected lifecycle session; stale callbacks must not overwrite a newer session or append misleading activity. Preserve explicit owner inputs and the existing session-start establishment path when a validated automated launch is being observed.

### 2. Resolve the installed workspace once

Reuse `resolveWorkspaceFromWorktree`, `resolveWorkspaceFromProduct`, `workspaceLocationFromConfig`, `existingIssueRuntime`, and `withStoredMailbox`. Make `resolveStart` and applicable maintenance commands use the same validated selection when flags are omitted. Cover numeric issue entry, `start`, `manual`, `attach`, `detach`, `reset-clones`, `wipe-issue`, existing issue controls, `doctor`, and `uninstall`. An install refresh with an explicit product may reuse that product's installed root; first-time installation still needs a root or the existing onboarding default.

Resolution order is explicit arguments first, then a validated owner/registered-clone locator from the current worktree. For an onboarded workspace directory outside Git, consider only its exact installed config/runtime layout, including its conventional `coord-runtime` child; accept a single validated workspace and reject multiple candidates. An explicit config without a root may derive its workspace directory. Do not scan unrelated parent directories or choose a runtime from an inherited issue number. Reject conflicting flags, foreign/stale locators, and ambiguous nested layouts with actionable messages.

Use `workspaceRoot` for issue state and the enclosing `coordRoot` where install/doctor/uninstall require the outer location. Keep the existing legacy nested-runtime conflict detection and the completion root frozen in `start.json`. Missing defaults must not create a new runtime or silently redirect a destructive command.

### 3. Finish manual sessions safely and reconcile leftovers

Add `coord manual --done [--dry-run]` as explicit completion and make `coord detach manual` use the same safe clone-readiness preflight before completing teardown. Reuse `detachIssue` and its exact workspace-grouped Terminal titles and linked-session filtering; no changes to the detach implementation or numeric detach semantics are required.

Add a manual-specific readiness function in `src/prepareAgentBranch.ts`. Reuse the existing snapshot, protocol capture/lift/restore, Git helpers, and result reporting, but do not reuse `finished-issue-only` or `force-wipe` discard behavior for manual work. Preflight every configured clone before changing a worktree or stopping a live session:

- Accept only the configured base branch or that clone's own `<agent>/<name>` branch; refuse detached HEADs, peer branches, and unrelated issue branches.
- Require no staged, unstaged, or nonignored untracked work, including owner changes hidden alongside the managed AGENTS protocol. Ignore only the existing managed overlay and declared ignore rules.
- A manual branch's HEAD must be reachable from a freshly verified corresponding remote branch or from the fetched base branch. An unavailable remote, missing upstream evidence, unpushed commit, or divergence refuses the operation. Preserve all branch refs even on success.
- Preserve local base history: only switch/fast-forward when the local base is an ancestor of the verified base target. Refuse divergent local base commits instead of resetting them.
- Capture and restore the protocol in `finally`, including failure paths. Never hard-reset, clean, stash, delete branches, or force-push as part of this manual transition.

The next numeric start/resume/run entry will inspect the exact manual session before the existing mutual-exclusion check. Automatically reconcile only sessions whose configured panes are dead/finished or positively idle with an empty composer and no active tool/background descendant, and whose clones pass the same non-discarding preflight. Include linked sessions in inspection. A missing inspection, unexpected live window/process, owner typing, or active harness work is a refusal, not cleanup permission. Report the agent, pane/session, observed process and recovery command. Revalidate the pane/process and Git snapshots immediately before effects; stop on changes and report any partial operational failure accurately.

On an eligible transition, close only the workspace's manual UI, return eligible clones to base with the manual readiness path, and continue normal issue preparation. Repeated completion/reconciliation is idempotent. Manual launch itself stays nonblocking and creates no issue state, action, ballot, or completion artifacts. The explicit `--done` command establishes owner intent to end live manual harnesses, but does not permit discarding unpublished work or an actively changing clone.

Add `.pnpm-store/` to all three listed ignore sources. This keeps the package cache out of readiness checks for this project and default installed clones, without requiring `--write-product`. Do not delete the cache or broadly ignore other untracked files.

Improve `prepareAgentIssueBranches` refusal text using the existing dirty snapshot. Show the affected paths. Keep commit/stash advice for tracked edits. For untracked-only blockers, explain that untracked files may be owner work; offer the exact scoped `coord reset-clones <issue> ... --dry-run` inspection and `--force` recovery only if the owner intends to discard them. Never classify arbitrary untracked files as disposable junk or run forced recovery automatically. Preserve all-or-nothing start preflight and same-issue WIP reuse.

### 4. Verify terminal placement and extend reminders

Extend the existing `TmuxController` runner-based inspection to record the target session/window, pane ID/PID, current working directory, and foreground process. Verify cwd against the configured clone and process evidence against the expected harness, reusing `harnessLooksReady`; for generic `node` foregrounds, use bounded process ancestry/arguments tied to that pane instead of assuming any Node process is the agent. Inspect newly launched panes with a bounded startup wait and reused panes before declaring readiness. Missing/dead panes may follow the existing repair path. A live wrong process, clone, or session is reported and preserved; never respawn it with `-k` merely because its window name looks right. No host-wide `pkill`, Terminal-title-only proof, or unrelated process cleanup.

Use the same inspection for manual cleanup and automated/manual startup. Verify owner client attachments through tmux session/window targets as well as the existing grouped-title behavior; report unavailable Terminal inspection on nonmacOS systems with exact attach commands rather than claiming GUI verification. Inject all process/tmux inspection in tests so verification never manipulates the owner's real terminals.

For `n`, append an “All agents with current tasks” menu row when multiple captured requests exist. Its callback invokes each captured `request()` once and reports each result; one stale/rejected request does not hide another result or retarget a replacement action. There is no bulk bypass: holds, manual pause, delivery uncertainty, task changes, and send limits continue to be enforced by the unchanged run loop. Update help and the controls table to describe both choices.

## Tests

Extend existing fixtures: `makeProduct`, `git`, `tryGit`, and `ensureBuilt` from `test/support/workspaceFixture.ts`; `seedClone` in the branch tests; CLI `setup` and injected IO/run-loop/session dependencies; fake tmux runners and owner-client executors; the PassThrough interactive fixture; and existing lifecycle/action fixture builders. Do not create another test harness or operate on host tmux, real vendor CLIs, GitHub, or a shared daemon.

Add the fewest focused, table-driven cases that cover the changed contracts:

1. **Guard and lifecycle — `test/shellGuard.test.ts`, `test/agentEvent.test.ts`, and generated-shim cases in `test/install.test.ts`:** a numeric inherited issue with manual mode, no matching runtime, a finished/dropped issue, a wrong branch/clone, or a mismatched vendor session does not activate automated restrictions or mutate the wrong lifecycle. A fully current binding still refuses restricted commands, including while paused. A verified current action can route past stale environment context; a forged/mismatched action cannot. Update existing automated guard fixtures to contain real binding evidence instead of only `COORD_ISSUE`. Retain complete/partial materialization, native vendor response shape, other-repository, and local-history cases.
2. **Launch and ignore rules — `test/install.test.ts`, `test/tmux.test.ts`:** execute generated launchers with stub harnesses across issue A, manual mode with stale A, and issue B. Assert received mode/environment and grant arguments; Codex keeps `--no-daemon` each time, and manual receives no issue grants. Create cache contents and use fixture Git to prove default clone excludes and explicit product ignore writes ignore the cache while unrelated files remain visible.
3. **Manual completion — `test/prepareAgentBranch.test.ts`, `test/cli.test.ts`:** a clean pushed/merged own manual branch returns to base and remains recoverable by its ref; retry is a no-op. Table-test unpushed commits, tracked/untracked WIP, hidden owner AGENTS edits, wrong/detached branches, divergent base, and fetch failure. Verify branch SHAs, index/worktree bytes, protocol/skip-worktree restoration, and no teardown or change to another clone when preflight refuses. Cover `--dry-run`, a failed checkout, and stale snapshot detection.
4. **Session reconciliation/placement — `test/tmux.test.ts`, `test/cli.test.ts`:** an idle/finished exact manual session plus safe clones permits the next issue command without a separate detach; busy/typing/unknown/wrong-cwd/wrong-process panes refuse without kills or new issue effects. Test dead-pane recovery, startup timeout, linked-session scoping, and a foreign workspace with the same issue number. Fake runners assert cleanup ordering and that unrelated sessions/clients are untouched.
5. **Discovery — `test/workspace.test.ts`, parameterized `test/cli.test.ts`:** owner repo, registered clone/subdirectory, workspace directory, flat and nested runtime, explicit overrides, and config-derived roots. Reject multiple workspaces and stale/foreign/conflicting locators before mutation. Check stored completion roots and legacy nested state remain honored. Exercise maintenance commands as well as start/manual paths; do not treat passing only `status` as complete coverage.
6. **Reminders — `test/interactive.test.ts`:** retain single-agent selection; bulk selection calls each captured closure once, reports a stale member, and does not invoke an unselected/replacement task. Reuse the existing `test/runLoop.test.ts` owner-reminder cases to verify unchanged readiness, deduplication, spacing, holds, and budget. Reuse `test/issueReport.test.ts` boundary assertions for the already-satisfied status request.

Focused development commands (test tiers are taken from the actual Vitest configs):

```sh
pnpm test:fast test/shellGuard.test.ts test/agentEvent.test.ts test/prepareAgentBranch.test.ts test/tmux.test.ts test/interactive.test.ts test/issueReport.test.ts
pnpm test:fast test/runLoop.test.ts -t 'owner reminders and advisory diagnostics'
pnpm test:system test/cli.test.ts test/workspace.test.ts test/install.test.ts
```

Run the relevant focused command when implementing each behavior and establish failure-before/pass-after for the new regression cases. Existing tests for already-present separators and `--no-daemon` are preservation checks, not claims of newly fixed failures. The fixture build helper rebuilds the CLI when generated-shim tests need it.

The frozen issue configuration uses local verification: the product commit hook owns `pnpm run check:fast` (lint, typecheck, fast tests, and system tests); the push hook owns `pnpm run test:e2e`. Do not duplicate those full suites immediately before their hooks. The coordinator's configured final check is `pnpm run check`, which includes build, fast/system checks, and e2e. Cite those final results as coordinator-owned, not agent-run. No version bump, package change, or hook-tree edit is needed.

For this plan-only action, validate required headings, nonempty sections, exact file map, bound identity, and actual command names; commit/push hooks handle the evidence classification. No product suite is required to publish the plan.

## Alternatives Rejected

- Trusting `COORD_ISSUE`, merely unsetting it in tmux, or disabling the guard: inherited child context survives tmux updates, and current automated sessions still need the existing policy.
- Restarting a shared Codex daemon globally: the baseline already uses `--no-daemon`; global restarts can interrupt unrelated work.
- Applying the existing finished-issue discard policy to manual branches: it can reset/clean files and reset a divergent base, whereas manual completion must preserve unpublished owner work.
- Unconditionally killing manual sessions on issue start: a live harness may still be doing owner work. Reconcile only inspected safe sessions, with explicit completion for deliberate shutdown and refusal when evidence is uncertain.
- Inferring a workspace from an arbitrary neighboring directory or choosing the first nested config: maintenance commands could target another product.
- Adding a standalone bulk nudge sender or changing status formatting again: reuse the existing guarded reminders and already-tested report boundaries.
- Broad ignore rules, deleting all untracked files, new dependencies, and unrelated refactors: the concrete cache exception is `.pnpm-store/`, and the existing modules can implement the requested behaviors.

## Risks and Mitigations

Session evidence can be absent or stale, and process displays vary between vendors. Keep unknown distinct from verified, use bounded inspection and explicit diagnostics, and never infer that a live session is safe to kill merely from its name or an idle-looking screenshot. Native hook/shim containment remains advisory bounded recognition, not a security sandbox; preserve the existing once-per-session probe workflow after installation changes.

Git and processes can change between inspection and effects. Preflight the whole batch, recheck snapshots just before mutations, stop on disagreement, preserve branch refs, and restore protocol state on every exit. An operational failure after teardown must report the actual state and a retry path; do not promise rollback of terminal processes. Manual cleanup must not inherit the existing force-wipe behavior.

Adding a shared resolver to the shim introduces a coordinator subprocess. Resolve the existing trusted CLI entry, avoid recursion through delegated Git, bound runtime/output, and report unavailable resolution without falsely claiming a successful containment check. Exercise the generated script, not only source-string assertions.

Runtime discovery can misroute cross-product operations. Preserve canonical clone/product identity checks, distinguish workspace and outer roots, reject ambiguity, and test destructive command resolution in dry-run fixtures. The plan does not change persisted issue schemas or broaden agent write grants.

## Conclusion

Implement the remaining manual lifecycle, binding, discovery, terminal verification, cache, and bulk-reminder gaps in the listed files. Retain the baseline's status boundaries and Codex daemon isolation, with existing and extended regression coverage. Publish this plan first; product changes begin only under the coordinator's implementation action and approved scope.
