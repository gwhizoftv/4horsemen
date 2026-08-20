# Implementation Plan — Issue 76

Implement manual coordination as a workspace-scoped owner-UI lifecycle. It will
reuse the installed launchers, tmux pane repair, and macOS Terminal attachment
boundaries, but it will not create an issue identity or enter any automated
workflow code.

## Exact File List to be changed or deleted

No files will be deleted. Change exactly these files:

- `src/cli.ts`
  - Add help and parsing for
    `coord manual [--product <path> | --config <path> --coord-root <path>]`
    and `coord detach manual` with the same workspace forms plus the existing
    detach `--dry-run` behavior. With no explicit selector, `coord manual`
    resolves the onboarded product from the current working directory, just as
    `coord <issue>` does.
  - Split the reusable product/config/workspace resolution from the
    issue/profile-specific start resolution. Manual mode will load the same
    validated config, resolve every configured agent root relative to that
    config, and validate every configured launcher before changing tmux.
  - Add a manual launch path that checks for live automated issue UI belonging
    to this workspace, creates or repairs the workspace's manual tmux session,
    opens only missing owner Terminal clients, reports the outcome, and returns
    immediately. It must not call `fetchGitHubIssue`, `BareMirror`,
    `prepareAgentIssueBranches`, `createIssueRuntime`, operational-state or
    lifecycle initialization, the coordinator run loop, nudging, checks,
    finalization, or publication.
  - Enforce the inverse exclusion before any new or resumed automated issue
    startup/attach: if the exact workspace manual session is live, fail with a
    message directing the owner to `coord detach manual`. Manual startup will
    likewise identify live numeric sessions only from this workspace's durable
    `issue-*` entries and exact tmux names, so an unrelated product cannot
    produce a false conflict.
  - Route `coord detach manual` to exact manual UI teardown without requiring
    an issue directory, issue number, GitHub access, or coordinator state.
    Preserve numeric `coord detach N`, shorthand `coord N`, `start`, `run`, and
    `attach` semantics.
- `src/tmux.ts`
  - Introduce a typed owner-UI session key that supports numeric issues and the
    manual key. Keep numeric names byte-for-byte compatible
    (`coord-N` for flat installs and `coord-N-<namespace>` for nested installs),
    while deriving manual names and Terminal titles from the mandatory stable
    workspace group, for example `coord-manual-<group>` and
    `coord-manual-<group>/<agent>`.
  - Generalize target, attach-launch, title, list/has-session, and exact-session
    helpers around that key. Manual listing/killing will match only the primary
    manual session and the linked client sessions for configured agent IDs;
    it will not use an unscoped global `coord-manual` prefix.
  - Reuse the `ensureSession` create/reuse/repair behavior for manual sessions:
    retain live configured panes, create missing agent windows, and
    `respawn-pane` dead panes with the validated launcher and clone cwd. Do not
    set an issue identity in a manual session; explicitly remove a stale
    `COORD_ISSUE` tmux environment value rather than exposing a fake issue.
  - Reuse `openOwnerAgentClients(..., { onlyMissing: true })` and the exact
    Terminal-title probe so repeat launches neither duplicate healthy harnesses
    nor reopen already-present macOS Terminal windows. Non-macOS fallback
    commands remain supported.
- `src/detachIssue.ts`
  - Add manual teardown using the generalized session key. Close the exact
    workspace-grouped Terminal titles before killing tmux, then kill only the
    exact primary and configured linked manual sessions; preserve failure
    reporting and dry-run behavior.
  - Extend bulk owner-UI teardown so uninstall always considers this
    workspace's manual session and titles even when there are no `issue-*`
    runtime directories. Keep the current rule that flat automated sessions
    are never discovered from an unscoped global tmux listing.
- `src/install.ts`
  - Add the product-resolved `coord manual` command to install/onboard next-step
    output alongside doctor and automated issue commands.
  - Pass the workspace group through uninstall's owner-UI cleanup and report
    manual teardown together with automated teardown, without broadening clone,
    runtime, or other-workspace deletion.
- `AGENTS.md`
  - Separate automated issue mode from manual owner-chat mode. Keep identity,
    commit-prefix, verification, no-main, no-peer, no-force, hook, and
    skip-worktree rules universal, but scope issue branches, `action.md`,
    `complete`, evidence formats, and the post-completion action watch to an
    actual automated coordinator action. In manual mode, direct agents to
    follow the owner's chat task and create their own `<agent>/<name>` scratch
    branch unless the owner explicitly names an issue branch.
- `templates/product/AGENTS.md`
  - Teach newly generated product guidance the manual owner-chat authority and
    scratch-branch convention while preserving every installed hook and
    verification constraint.
- `templates/product/AGENTS.protocol.md`
  - State up front that the plan/review/evidence schemas apply only when the
    coordinator has published an automated `action.md`; manual work must not
    invent `.plans`, `.signals`, `.code-reviews`, `action.md`, or `complete`.
- `scripts/lib/launcher.sh`
  - Change the generated launcher banner from an issue-only prompt to a clear
    two-mode prompt: automated sessions read `coord next --issue <n>`, while a
    manual session waits for and executes the owner's direct chat task on the
    agent's scratch branch. Keep launcher commands and toolchain setup intact.
- `scripts/setup_claude.sh`
  - Make the generated Claude identity/session checklist accept either a real
    automated issue action or an owner-provided manual task, and give the
    manual scratch-branch instruction without weakening its guard.
- `scripts/setup_codex.sh`
  - Make the managed global Codex identity block distinguish automated issue
    startup from manual owner-chat work and select `codex/<name>` for manual
    tasks rather than demanding an issue number.
- `scripts/setup_cursor.sh`
  - Apply the same mode distinction and `cursor/<name>` manual branch contract
    to the generated Cursor rule.
- `scripts/setup_antigravity.sh`
  - Apply the same mode distinction and `antigravity/<name>` manual branch
    contract to the generated Antigravity identity, retaining its terminal and
    automation safety rules.
- `README.md`
  - Document the daily `coord manual` command, implicit and explicit workspace
    resolution, configured-agent launch/repair behavior, idempotency,
    scratch-branch policy, absence of issue/runtime/workflow/publication
    effects, the manual-versus-automated exclusion, and
    `coord detach manual`/uninstall cleanup.
- `docs/coord-driver.md`
  - Add a manual lifecycle section defining owner chat as the only authority,
    the workspace-grouped tmux/Terminal naming, launch/repair/recovery and
    teardown behavior, mode-conflict errors, and all operations deliberately
    bypassed. Keep manual mode outside the state-machine and evidence model.
- `docs/setup-workspace.md`
  - Add manual use to post-onboarding next steps and explain workspace-isolated
    repeat launch, detach, scratch branches, non-concurrency, and uninstall
    cleanup even for workspaces with no issue runtime directories.
- `package.json`
  - Bump the pre-1.0 release version from `0.0.11` to `0.0.12`; do not change
    scripts or dependencies.
- `config.product.example.json`
  - Keep `coordination.version` aligned at `0.0.12`.
- `test/cli.test.ts`
  - Add injected owner-UI tests for implicit onboarded-product, `--product`,
    and explicit `--config`/`--coord-root` resolution; all-configured-agent and
    launcher validation; immediate/idempotent launch; missing-window reporting;
    manual/automated conflict errors in both directions; `detach manual`, dry
    run, invalid/mixed arguments, help text, and the `0.0.12` assertion.
  - Assert manual launch makes no GitHub/process-runner calls, no run-loop or
    nudge calls, and creates no `issue-*`, mirror, snapshot, start/cursor/journal,
    action, or completion files.
- `test/tmux.test.ts`
  - Cover flat and nested numeric-name compatibility, mandatory
    workspace-isolated manual session/title names, no manual `COORD_ISSUE`, new
    session creation, healthy reuse, missing window creation, dead pane
    respawn, exact session filtering, only-missing Terminal reopening, and
    unsupported-platform attach commands.
- `test/detachIssue.test.ts`
  - Cover close-before-kill for manual UI, exact primary/linked session and
    grouped-title selection, cross-product non-matches, dry run, and bulk
    uninstall cleanup of manual UI when the workspace has no issue directories.
- `test/install.test.ts`
  - Update version/config expectations and assert generated install output,
    launcher text, product protocol, and all vendor identity artifacts describe
    manual mode and scratch branches while retaining hook/safety language.
  - Verify uninstall supplies exact workspace-scoped manual cleanup inputs and
    reports cleanup without affecting another product.
- `test/onboard.test.ts`
  - Assert onboarding output advertises `coord manual` from the registered
    product and retains isolated manual group identities for multiple products.

The automated workflow modules `src/runLoop.ts`, `src/state.ts`,
`src/action.ts`, `src/evidence.ts`, `src/finalization.ts`, `src/githubIssue.ts`,
and `src/mirror.ts`, plus `githooks/**` and `src/hookPolicy.ts`, remain
unchanged. Manual mode calls none of them and requires no schema or hook-policy
extension.

## Exact file list to be created

None. The feature is implemented by extending existing CLI, owner-UI,
instruction, documentation, release-metadata, and test files; it introduces no
manual runtime file, schema, state directory, or new source module.

## Tests

1. Run the focused fast tests while iterating:

   ```sh
   pnpm exec vitest run --config vitest.config.ts test/cli.test.ts test/tmux.test.ts test/detachIssue.test.ts test/install.test.ts test/onboard.test.ts
   ```

2. Run the declared precommit suite before every implementation commit:

   ```sh
   pnpm check:fast
   ```

   This covers ESLint, source/test TypeScript, all fast tests, generated
   instruction/launcher assertions, and the non-main pre-1.0 version gate.

3. Run the coordinator acceptance suite on the final implementation:

   ```sh
   pnpm check
   ```

   This adds the production build and end-to-end tests to `check:fast`.

4. On macOS, smoke-test an onboarded disposable product with at least two
   configured agents: run `coord manual`; confirm one correctly titled Terminal
   per agent and no issue runtime/artifacts; assign independent owner-chat tasks
   on agent scratch branches; rerun `coord manual` to confirm healthy panes and
   windows are reused; terminate one harness and close one Terminal, rerun to
   confirm only those pieces are repaired; verify `coord N` refuses until
   manual UI is detached; run `coord detach manual`; and confirm only that
   workspace's manual Terminal/tmux clients are removed. Repeat with two
   onboarded products sharing an outer coordination root to verify isolation.

## Alternatives Rejected

- Reusing `coord start 0`, a synthetic GitHub issue, or a reserved string in
  `issue-*` state is rejected because it would still invoke issue lookup,
  baseline/digest/state initialization, evidence, nudging, and publication, and
  would turn manual mode into a schema-visible workflow profile.
- Adding a second long-running coordinator/run-loop profile is rejected. The
  owner, not a cursor or action file, drives manual work, so the command must
  finish after repairing the UI.
- Disabling or relaxing hooks is rejected. Existing agent-owned scratch
  branches already support issue-free work while enforcing clone ownership,
  commit prefixes, declared checks, no-main commits, and no-force pushes.
- Using a global `coord-manual` tmux session or ungrouped Terminal titles is
  rejected because different onboarded products would collide and teardown
  could close another workspace's agents.
- Launching fresh harness processes and Terminal windows on every invocation is
  rejected because it loses owner context and violates idempotent daily use;
  existing healthy panes and exact titles must be probed and reused.
- Discovering flat-workspace automated sessions from every global `coord-N`
  tmux name is rejected because another coordination root may own them. Manual
  conflict checks are bounded by this workspace's durable issue identities,
  while manual cleanup uses its unique workspace-grouped name.
- Creating a manual action, completion sentinel, evidence directory, branch
  publication path, or PR helper is rejected because manual chat is the only
  task source and publication remains explicitly owner-controlled.

## Risks and Mitigations

- **Cross-product teardown:** Prefix matching can kill similarly named sessions
  or close another product's terminals. Derive manual names from
  `workspaceTerminalGroup`, match only the primary and configured linked client
  names, close exact custom titles, and add two-product negative tests.
- **Mode overlap:** An owner could otherwise start automated work while manual
  harnesses are alive, or vice versa. Probe the exact manual session on every
  automated launch/resume/attach path and probe only this workspace's durable
  numeric sessions on manual launch; fail before GitHub, runtime, branch, or UI
  effects and include the required detach remedy in the error.
- **False issue identity in manual harnesses:** Inherited tmux environment could
  make hooks or agents believe an issue is active. Never synthesize an issue
  number and explicitly unset `COORD_ISSUE` for the manual session; tests inspect
  the tmux argv and assert that no issue runtime exists.
- **Idempotency regressions:** Repeat launch could duplicate Terminal windows or
  restart an owner's healthy agent. Reuse `ensureSession` and exact title probes,
  and test healthy, missing, and dead pane states independently.
- **Automated-mode regressions:** Generalizing session keys could change existing
  numeric names, nudge targets, or cleanup. Preserve all numeric outputs and
  current method behavior in compatibility tests, and leave the state machine,
  evidence, GitHub, mirror, finalization, and hook-policy modules untouched.
- **Instruction drift:** Root, product-template, launcher, and four vendor
  identities could give contradictory startup directions. Use the same explicit
  two-mode terms in each and assert generated artifacts in install tests. Edit
  the tracked root `AGENTS.md` without clearing its clone-local skip-worktree bit.
- **Platform-only Terminal behavior:** CI cannot prove live AppleScript window
  behavior. Keep opener/closer/title-probe injection points, unit-test exact
  calls and ordering, and perform the documented macOS smoke test.
- **Pre-1.0 ship gate:** A feature commit with version `0.0.11` will fail on the
  issue branch, or mismatched example metadata will stale installs. Bump both
  `package.json` and `config.product.example.json` to `0.0.12` and run both
  declared check suites.

## Conclusion

This plan adds `coord manual` as a small, idempotent, workspace-isolated
launch/attach lifecycle over the already installed agent harnesses. It provides
owner-driven chat work and exact teardown without inventing an issue, weakening
git safety, or extending the coordinator state machine, and it preserves all
automated issue behavior behind explicit bidirectional mode-exclusion checks.
