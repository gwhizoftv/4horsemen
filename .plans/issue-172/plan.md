# Issue 172 — Coord manual-session robustness and owner UX

Issue 172 bundles several owner-visible failures around manual mode, clone
dirtiness after Codex sandbox writes, status readability, session binding, and
operator controls. This plan solves each bullet with the smallest reuse of
existing helpers; it does not redesign the workflow driver.

Canonical flag name is `--coord-runtime` (legacy `--coord-root` remains
rejected). Plan text uses `--coord-runtime` everywhere.

## Exact File List to be changed or deleted

- `src/productIgnore.ts` — add `.pnpm-store/` to `DEFAULT_CLONE_IGNORES` so every
  clone's managed exclude (and product `.gitignore` when `--write-product` is
  used) stops treating Codex's workspace store as committable dirt.
- `.gitignore` — add `.pnpm-store/` for this coordination repo's own working tree
  (same one-line rule the issue calls out).
- `src/prepareAgentBranch.ts` — when `prepareAgentIssueBranches` refuses a dirty
  checkout, classify untracked-only leftovers and point at
  `coord reset-clones <issue> --force` (matching the completion-path advice in
  `makeAgentClonesBaseReady` / `detachCompletedIssue`); keep Commit/stash only
  when tracked modifications are present.
- `src/issueReport.ts` — replace bare `----` start/end framing with unmistakable
  begin/end banners so owner `status` / interactive `s` output cannot blend into
  adjacent prompt or log lines.
- `src/interactive.ts` — when printing status from `s`, keep the same banners;
  extend the `n` reminder menu with an "all agents" entry that invokes every
  current reminder from `reminders()`.
- `src/shellGuard.ts` — stop treating a numeric `COORD_ISSUE` alone as proof of a
  live automated session: bind the same way `hookVerificationRecorder` already
  does (issue branch + matching `start.json` roster/root/`issueSessionId`). A
  stale inherited env with no matching live session must fall through as manual
  (allow), not deny.
- `scripts/lib/launcher.sh` — mirror the shell-guard binding rule for the git
  shim so shim and native guard agree when `COORD_ISSUE` is stale.
- `src/cli.ts` — (1) after `detach manual` UI teardown, call
  `makeAgentClonesBaseReady` with the same refuse-unpushed-work policy used by
  `detachCompletedIssue`; (2) when starting `coord N`, if a leftover manual tmux
  session exists, detach it and base-ready the clones before continuing instead
  of forcing a separate `coord detach manual`; (3) on `coord manual`, restart any
  leftover Codex app-server for configured codex agents before opening panes;
  (4) allow onboarded-cwd inference when only one of `--config` /
  `--coord-runtime` is missing by resolving the other from the product/worktree
  locator; (5) add `coord nudge [--agent <id>|--all]` that reuses
  `CoordinatorRunLoop.reminders()` / nudge delivery; (6) before launch, run the
  expanded session/process check and surface mismatches (see tmux changes).
- `src/tmux.ts` — expand `issueEnvironmentDiagnostic` (or a sibling used from
  start/manual) to verify each agent window's pane is in the expected session
  and appears to host the configured `harnessProcess`; report concrete mismatches
  rather than a single env-string warning.
- `src/codexQuota.ts` (or the smallest existing Codex helper already used for
  app-server) — add a focused "stop leftover app-server for this agent home"
  helper reused by `coord manual` / issue start; do not invent a second quota
  stack.
- `docs/coord-driver.md` — document status banners, auto-cleanup of leftover
  manual sessions on `coord N`, detach-manual base-readiness, `.pnpm-store/`
  ignore, nudge CLI, and the session/process check.
- `test/issueReport.test.ts` — update framing assertions to the new banners.
- `test/interactive.test.ts` — status banner through `s`; "all agents" on `n`.
- `test/prepareAgentBranch.test.ts` — dirty refusal message for untracked-only vs
  tracked; `.pnpm-store/` no longer blocks after ignore install (via exclude).
- `test/install.test.ts` — `DEFAULT_CLONE_IGNORES` / exclude contains `.pnpm-store/`;
  launcher/shim stale-`COORD_ISSUE` passthrough; keep existing manual-mode cases.
- `test/shellGuard.test.ts` — stale env + wrong/missing session → allow; live
  matching session → existing deny behavior unchanged for blocked git.
- `test/cli.test.ts` — detach manual base-ready; auto-cleanup before `coord N`;
  onboarded inference without paired flags; `coord nudge`; manual triggers Codex
  app-server cleanup hook (injected).
- `test/tmux.test.ts` — per-agent session/process diagnostic messages.
- `test/detachIssue.test.ts` / `test/prepareAgentBranch.test.ts` — detach-manual
  readiness integration where the existing suites already cover detach/base-ready.

## Exact file list to be created

- `.plans/issue-172/plan.md` — this plan (coordination artifact only).

No new production modules unless the Codex app-server stop helper cannot live in
`src/codexQuota.ts` without muddying that file's quota responsibility; if a
split is required, the single new file is `src/codexAppServer.ts` exporting one
stop/restart function, justified only by keeping quota I/O separate from process
lifecycle. Prefer the in-file helper first.

## Reuse and Scope

**Reuse (do not reimplement):**

- `renderIssueReport` / `test/issueReport.test.ts` framing pattern for status.
- `detachCompletedIssue` → `detachIssue` + `makeAgentClonesBaseReady` for the
  manual detach and auto-cleanup paths (`src/cli.ts`, `src/detachIssue.ts`,
  `src/prepareAgentBranch.ts`).
- `blockingDirtyPaths` / `snapshotCloneReadiness` for dirt classification; extend
  the prepare refusal string only.
- `DEFAULT_CLONE_IGNORES` + `writeManagedIgnoreFile` (`src/productIgnore.ts`,
  `src/setupWorkspace.ts`, `src/install.ts`) for `.pnpm-store/`.
- `hookVerificationRecorder`'s branch/`start.json` binding
  (`src/verificationLog.ts`) as the model for `guardShellRequest` /
  `runtimeFor` and the launcher shim.
- `CoordinatorRunLoop.reminders()` and `tmux.nudge` for interactive "all" and
  `coord nudge`.
- `issueEnvironmentDiagnostic`, `sessionExists`, `assertNoManualSession`,
  `inspectStartupAgent` pieces for the stronger start-time check.
- `resolveWorkspaceFromProduct` / `resolveWorkspaceFromWorktree` /
  `existingContext` / `resolveStart` for default runtime inference.
- Codex launcher `--no-daemon` already in `scripts/lib/launcher.sh`; add process
  cleanup beside that, not a second launch mode.

**New surface justified:**

- Clearer status banners (same file, stronger strings).
- One ignore line (clone + repo).
- One CLI verb `nudge` (thin wrapper over existing reminder machinery).
- Optional `src/codexAppServer.ts` only if quota file cannot host the stop helper.

**Out of scope:** redesigning delivery/holds; changing harnessProcess defaults;
migrating owners' existing exclude files beyond normal install/setup rewrite of
the managed block; force-discarding unpushed real branch work on detach.

## Tests

Named commands (repository-declared):

- Focused while developing: `pnpm exec vitest run test/issueReport.test.ts test/interactive.test.ts test/prepareAgentBranch.test.ts test/shellGuard.test.ts test/install.test.ts test/cli.test.ts test/tmux.test.ts test/detachIssue.test.ts` (subset as touched).
- Hook-owned precommit: `pnpm check:fast` (do not duplicate immediately before commit).
- Full product before PR (coordinator-owned at the pin): `pnpm check`.

Fewest cases that fail before / pass after:

1. **Status banners** (`test/issueReport.test.ts`): report matches
   `^==== STATUS BEGIN ====\n` and ends with `==== STATUS END ====\n`; recovery
   quoting unchanged.
2. **Interactive status** (`test/interactive.test.ts`): `s` output includes both
   banners and is not glued to the controls line without a delimiter.
3. **`.pnpm-store/` ignore** (`test/install.test.ts`): managed exclude after
   install/setup contains `.pnpm-store/`.
4. **Prepare refusal** (`test/prepareAgentBranch.test.ts`): untracked-only dirt
   message cites `coord reset-clones`; tracked modification still mentions
   commit/stash.
5. **Stale binding** (`test/shellGuard.test.ts`, `test/install.test.ts`): env
   `COORD_ISSUE=N` without a matching live `issue-N/<agent>` + start roster →
   guard/shim allow; matching live session keeps deny for blocked git.
6. **Manual cleanup** (`test/cli.test.ts`): `detach manual` invokes base-ready;
   starting `coord N` while a manual session exists cleans it instead of
   throwing the current "Run coord detach manual first" error (inject
   `sessionExists` / detach / readiness doubles).
7. **Runtime default** (`test/cli.test.ts`): from an onboarded product cwd,
   issue/status/manual commands succeed without an explicit `--coord-runtime`
   when the locator can supply it; paired-flag rule relaxes only when the
   missing half is inferable.
8. **Nudge** (`test/interactive.test.ts`, `test/cli.test.ts`): `n` menu offers
   all-agents; `coord nudge --all` / `--agent` call the reminder path.
9. **Session check** (`test/tmux.test.ts`): diagnostic lists a specific agent
   when pane/session/harnessProcess mismatch is injected.
10. **Codex app-server** (`test/cli.test.ts`): `coord manual` calls the stop
    helper for codex agents (dependency injection), once per manual open.

## Alternatives Rejected

- **Leave status as `----`.** Already present and tested, but the issue reports
  start/stop ambiguity in real owner terminals; stronger unique banners are a
  one-file string change and match the ask.
- **Require owners to keep calling `coord detach manual`.** Explicitly rejected
  by the issue; auto-cleanup on the next `coord N` plus base-ready on detach is
  the stated fix.
- **Always `git clean -fd` / force reset on detach.** Would throw away unpushed
  real work; reuse `makeAgentClonesBaseReady`'s refuse path instead.
- **Only document `.pnpm-store/` without ignoring it.** Documentation does not
  stop dirty-tree refusals; the ignore line is the durable fix.
- **Treat `--coord-root` as an alias.** Flag was deliberately renamed; keep
  rejection and fix inference for `--coord-runtime` / onboarded cwd.
- **New daemon manager for Codex.** Launchers already use `--no-daemon`; only
  stop leftover app-server processes bound to the agent home.
- **Replace interactive `n` with CLI-only nudge.** Keep `n`, add all-agents and a
  thin CLI for non-interactive use.
- **Silent kill of foreign tmux sessions.** Report mismatches and clean only the
  workspace's leftover **manual** session on automated start; do not kill
  unrelated owner sessions without a clear error path.

## Risks and Mitigations

- **Auto-detach of manual on `coord N` destroys in-progress manual UI.** Mitigate
  by logging the cleanup, only targeting this workspace's manual session name,
  and still refusing clone base-ready when unpushed real work exists (owner must
  commit/push or use `--force` reset paths already documented).
- **Stale-binding looseness lets automated agents escape the guard.** Mitigate by
  requiring the same positive branch+start match as verification recording; when
  the match succeeds, behavior stays deny-on-blocked-git.
- **Process checks false-positive on slow harness startup.** Mitigate by treating
  the check as start/attach diagnostic with clear `[WARN]`/`[ACTION]` text, not
  an immediate hard fail on the first empty pane; fail hard only when a foreign
  session/process is positively identified or the expected session is wrong.
- **App-server stop affects an unrelated Codex the owner is using.** Scope the
  stop to the configured agent home / resource-binding record already used by
  quota messaging; do not broadcast `pkill -x codex` machine-wide.
- **Managed ignore rewrite on old clones.** Mitigate by relying on existing
  install/setup managed-block rewrite; document `coord install` / setup as the
  way existing clones pick up `.pnpm-store/`.

## Conclusion

Issue 172 is a robustness pack, not a new workflow phase. The implementation
keeps one ignore line, clearer status banners, prepare-error parity with
reset-clones, detach/start cleanup that reuses `makeAgentClonesBaseReady`,
stale-`COORD_ISSUE` binding aligned with verification, onboarded runtime
inference gaps closed, nudge all + CLI, and a concrete tmux/process diagnostic —
all by extending existing modules and tests listed above, with at most one
optional new Codex process helper file.
