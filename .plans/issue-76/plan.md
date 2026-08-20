# Implementation Plan — Issue #76: Manual coordination of agent supported

## Exact File List to be changed or deleted

### Files to change

1. `src/cli.ts`
   - Add argument parsing, help documentation, and command dispatch for `coord manual` and `coord detach manual`.
   - Support workspace resolution from `--product <path>`, `--config <path>` + `--coord-root <path>`, or the current working directory.
   - Validate agent launchers, launch/repair manual tmux session and per-agent windows using `ensureSession("manual", agents)` without initializing issue runtimes, GitHub snapshots, or the coordinator run loop.
   - Open only missing macOS Terminal client windows for manual mode (`openOwnerAgentClients("manual", agents, { onlyMissing: true })`).
   - Enforce mutual exclusion: reject `coord manual` if an automated issue session is active for the workspace, and reject `coord start` / `coord <issue>` if a manual session is active.
   - Implement `coord detach manual` by calling `detachIssue` with issue target `"manual"`.

2. `src/tmux.ts`
   - Generalize session, window target, and Terminal window title helpers (`sessionName`, `target`, `ownerTerminalWindowTitle`, `ownerTerminalTitlesToClose`, `agentAttachLaunches`, `listIssueSessions`, `killIssueSessions`, `closeOwnerAgentClients`, `openOwnerAgentClients`, `startSession`, `stopSession`, `ensureSession`) to accept `issue: number | "manual"`.
   - For `issue === "manual"`, format session name as `coord-manual` (un-namespaced) or `coord-manual-${safeName(group)}` (namespaced/grouped), preserving numeric formatting `coord-${issue}[-${safeName(group)}]` for automated issues.
   - Ensure `ensureSession("manual", ...)` creates the session without setting `COORD_ISSUE` or sets it only when an issue number is present.
   - Ensure pane inspection, respawning dead panes, and `onlyMissing` window filtering work seamlessly with `"manual"`.

3. `src/detachIssue.ts`
   - Update `sessionPrefix`, `discoverCoordIssues`, `filterSessionsForIssue`, `detachIssue`, and `detachAllOwnerUiSync` to support `"manual"` sessions alongside numeric issues.
   - In `detachAllOwnerUiSync`, always include workspace-scoped manual tmux sessions and Terminal window titles in teardown during uninstall, even when no `issue-*` runtime directories exist.

4. `src/install.ts`
   - Update post-install and post-onboard output messages to advertise `coord manual` as a supported next step alongside `coord <issue>`.
   - Ensure uninstall summary properly reflects teardown of manual sessions.

5. `templates/product/AGENTS.md`
   - Document manual mode: when working without an automated issue action, agents take tasks directly from owner chat messages and work on scratch branches (`<agent>/<name>`).
   - Reiterate that git safety rules, hook verification, no-force, and no-main-commit rules remain fully in force.

6. `templates/product/AGENTS.protocol.md`
   - Clarify that `action.md` formats, evidence directories (`.plans/`, `.signals/`, `.code-reviews/`), and publication artifacts apply exclusively to automated issue actions; manual tasks do not fabricate coordinator artifacts.

7. `scripts/lib/launcher.sh`
   - Update the startup banner to describe both `coord next --issue <n>` for automated issues and direct owner chat tasks on scratch branches for `coord manual`.

8. `scripts/setup_claude.sh`
   - Update the generated Claude identity and session start checklist to accept either an issue number or an owner-driven manual task on a scratch branch.

9. `scripts/setup_codex.sh`
   - Update the generated Codex global identity block in `~/.codex/AGENTS.md` to be manual-mode and scratch-branch aware.

10. `scripts/setup_cursor.sh`
    - Update the generated Cursor rule file (`.cursor/rules/coordination.mdc`) to support manual mode and scratch branches.

11. `scripts/setup_antigravity.sh`
    - Update the generated Antigravity identity files (`AGENT_IDENTITY.md` and `GEMINI.md`) to support manual mode and scratch branches.

12. `AGENTS.md`
    - Update the coordinator repository's `AGENTS.md` to document the distinction between automated issue protocol and manual owner-driven workflow.

13. `README.md`
    - Document `coord manual` and `coord detach manual`, explaining issue-free operation, scratch branches, idempotency, non-concurrency rules, and teardown.

14. `docs/coord-driver.md`
    - Add comprehensive documentation for manual mode authority, lifecycle, session naming, exclusions, recovery, and lack of coordinator artifacts/publication.

15. `docs/setup-workspace.md`
    - Document manual mode usage after onboarding and during uninstall cleanup.

16. `package.json`
    - Bump package version from `0.0.11` to `0.0.12`.

17. `config.product.example.json`
    - Update coordination version stamp to `0.0.12`.

18. `test/cli.test.ts`
    - Test `coord manual` and `coord detach manual` CLI invocation, argument parsing, help output, version bump, resolution via `--product` or `--config` + `--coord-root`, mutual exclusion errors with active issue sessions, and absence of issue runtime artifacts.

19. `test/tmux.test.ts`
    - Test manual session naming, Terminal titles with and without workspace groups, `ensureSession("manual", ...)` pane reuse and respawn behavior, and `openOwnerAgentClients` with `onlyMissing`.

20. `test/detachIssue.test.ts`
    - Test `detachIssue` with target `"manual"`, verifying that Terminal windows close before tmux sessions are killed, dry run behavior, and `detachAllOwnerUiSync` tearing down manual UI when 0 issue directories exist.

21. `test/install.test.ts`
    - Update version expectations, verify generated launcher/template instructions include manual mode guidance, and test uninstall teardown of manual sessions.

22. `test/onboard.test.ts`
    - Verify that `coord onboard` output advertises both `coord <issue>` and `coord manual`.

### Files to delete

None.

## Exact file list to be created

None.

## Tests

### Automated Suite

Run the full project test and verification suites:
- `pnpm check:fast` — runs ESLint, TypeScript typecheck across `src` and `test`, and fast unit tests via Vitest.
- `pnpm check` — runs build, `check:fast`, and end-to-end tests.

### Specific Unit and Integration Test Cases

1. **CLI Tests (`test/cli.test.ts`)**:
   - `coord --help` and usage text displays `coord manual` and `coord detach manual`.
   - `coord --version` outputs `0.0.12`.
   - `coord manual` successfully launches manual tmux session and reports opened Terminal windows without creating `.plans/`, `.signals/`, `issue-*` runtime dirs, or querying GitHub/git baseline.
   - `coord manual` is idempotent: running it a second time reuses healthy panes and returns `already-open` for Terminal windows.
   - Mutual exclusion check: `coord manual` fails when an issue session is active for the same workspace.
   - Mutual exclusion check: `coord start <issue>` / `coord <issue>` fails when a manual session is active for the same workspace.
   - `coord detach manual` successfully closes Terminal windows and kills manual tmux sessions.
   - `coord detach manual --dry-run` reports planned closures without executing them.

2. **Tmux Controller Tests (`test/tmux.test.ts`)**:
   - `sessionName("manual")` returns `coord-manual` (flat) and `coord-manual-<group>` (namespaced).
   - `ownerTerminalWindowTitle("manual", "claude", group)` returns `coord-manual-<group>/claude`.
   - `ownerTerminalTitlesToClose("manual", ["claude", "codex"], group)` returns correct titles.
   - `ensureSession("manual", ...)` creates session, creates agent windows, respawns dead panes, and avoids setting `COORD_ISSUE`.
   - `openOwnerAgentClients("manual", agents, { onlyMissing: true })` ignores already open titles and opens only missing ones.

3. **Detach Tests (`test/detachIssue.test.ts`)**:
   - `detachIssue` with `"manual"` closes `coord-manual[-<group>]/<agent>` Terminal titles first, then kills `coord-manual[-<group>]` and client tmux sessions.
   - `detachAllOwnerUiSync` discovers and tears down `coord-manual[-<group>]` sessions even when `issues` list is empty.

4. **Install & Onboard Tests (`test/install.test.ts`, `test/onboard.test.ts`)**:
   - Verify `packageVersion` returns `0.0.12`.
   - Verify generated template and launcher files contain manual mode and scratch branch instructions.
   - Verify onboarding logging includes `coord manual`.
   - Verify uninstall tears down manual sessions and Terminal titles.

## Alternatives Rejected

1. **Modeling Manual Mode as a Workflow Profile (e.g. `profile: "manual"` in state machine)**:
   - *Rejected*: Manual mode is strictly an owner-driven UI lifecycle, not a state-machine execution. It requires no cursors, no round transitions, no consensus ballots, no GitHub snapshots, and no automated publication. Injecting it into `runLoop.ts` would introduce unnecessary complexity and risks.

2. **Global Unscoped Tmux Discovery for Manual Sessions**:
   - *Rejected*: In multi-workspace setups, killing all tmux sessions matching `coord-manual*` globally would destroy manual sessions belonging to other onboarded products. Manual sessions must be scoped using `terminalGroup` / `workspaceTerminalGroup(workspace.workspaceRoot)`.

3. **Weakening or Disabling Git Hooks during Manual Mode**:
   - *Rejected*: The git safety hooks already support agent scratch branches (`<agent>/<name>`) while guarding against accidental commits on `main`, peer branch pollution, force-pushes, and failed verification checks. No hook changes are needed.

4. **Allowing Concurrent Manual and Automated Sessions**:
   - *Rejected*: Operating automated and manual modes concurrently on the same working trees would cause git index collisions, checkout races, and conflicting commits. Strict mutual exclusion ensures safety.

## Risks and Mitigations

1. **Risk: Collision of Terminal window titles across multiple products in manual mode.**
   - *Mitigation*: Terminal custom titles will incorporate the unique workspace `terminalGroup` hash (e.g. `coord-manual-a1b2c3d4/claude`), matching the isolation model used for issue sessions.

2. **Risk: Lingering dead processes or detached shells in Terminal tabs after restart.**
   - *Mitigation*: Terminal windows are closed before killing tmux sessions in `detachIssue`, matching by unique title and window name. `ensureSession` checks pane liveliness and respawns dead panes with `-k`.

3. **Risk: Agent confusion when running in manual mode without an `action.md`.**
   - *Mitigation*: Clear guidance will be added across all agent identity templates, `AGENTS.md`, and launcher banners informing agents that `action.md` is only present in automated issue mode and that in manual mode they should follow chat instructions on their scratch branches.

4. **Risk: Version bump omission blocking ship gates.**
   - *Mitigation*: `package.json` and `config.product.example.json` will be updated to `0.0.12` as part of this plan, and verified against `origin/main` with `pnpm check:version-bump`.

## Conclusion

This plan introduces a clean, robust `coord manual` and `coord detach manual` lifecycle. It provides an owner-driven interactive mode that leverages existing agent harnesses, terminal management, and hook protections while completely bypassing automated issue state machines, coordinator artifacts, and GitHub polling.
