# Plan Review — Issue #76: Manual coordination of agent supported

## Findings

### 1. Manual Session Naming and Workspace Grouping

- **Plan Claim / Section**: `src/tmux.ts` and `src/detachIssue.ts` session key generalization across all peer plans (Cursor, Codex, Claude, Antigravity).
- **Rule That Must Hold**: When multiple onboarded products run manual mode on the same machine, their tmux sessions and Terminal window titles must be uniquely distinguished by workspace identity (i.e. `coord-manual-<group>` / `coord-manual-<group>/<agent>`) to prevent cross-product collision and accidental teardown during `coord detach manual` or `coord uninstall`.
- **Concrete Failure If Broken**: If a flat workspace uses an un-namespaced `coord-manual` session without factoring in the workspace `terminalGroup` (derived via `workspaceTerminalGroup(workspaceRoot)`), starting manual mode on Product A and then Product B would attach both products' agent windows into the same tmux session, causing cross-talk and race conditions. Furthermore, uninstalling Product A would terminate Product B's manual session.
- **Smallest Correction**: Ensure that `terminalGroup` / `workspaceTerminalGroup(workspaceRoot)` is always passed to `TmuxController`, `ownerTerminalWindowTitle`, `ownerTerminalTitlesToClose`, `detachIssue`, and `detachAllOwnerUiSync` so that `coord-manual-<group>` is consistently used for manual sessions across all workspace layouts.

### 2. Environment Variable Hygiene in Manual Session Windows

- **Plan Claim / Section**: `src/tmux.ts` `ensureSession` in Claude, Codex, and Antigravity plans.
- **Rule That Must Hold**: The manual tmux session must not inherit or set a stale `COORD_ISSUE` environment variable, so that agent harnesses and tools in manual mode do not mistakenly assume an automated issue workflow is active.
- **Concrete Failure If Broken**: If `ensureSession` unconditionally executes `tmux set-environment -t session COORD_ISSUE <value>` or inherits a `COORD_ISSUE` from the parent process, agent hooks and vendor CLIs may attempt to discover or require `issue-*` runtime directories and `action.md` files.
- **Smallest Correction**: In `ensureSession`, branch on `typeof issue === "number"`: only set `COORD_ISSUE` when an actual numeric issue is provided, and explicitly omit or unset `COORD_ISSUE` for `"manual"` sessions.

### 3. Bidirectional Mutual Exclusion Between Manual and Automated Modes

- **Plan Claim / Section**: `src/cli.ts` mutual exclusion checks in all peer plans.
- **Rule That Must Hold**: A workspace cannot run `coord manual` and `coord <issue>` simultaneously; each mode must detect an active session of the opposing mode for the same workspace and abort with an informative error before modifying git state, fetching GitHub issues, or spawning tmux sessions.
- **Concrete Failure If Broken**: If an owner starts `coord manual` while `coord <issue>` is running (or vice-versa), both sessions would execute against the same clone working trees, resulting in git index lock conflicts, checkout collisions, and corrupted commits.
- **Smallest Correction**: In `src/cli.ts`:
  1. In `coord manual`, check if any automated session (`coord-<issue>-<group>`) exists for this workspace before proceeding.
  2. In `coord start` / `coord <issue>`, check if `coord-manual-<group>` exists for this workspace before proceeding.

## Conclusion

All four peer plans (Cursor `873c6b403f005930f76710999edfb783df228b5e`, Antigravity `857dde07fcd6a3ff8e3b79766bfe8f7edeeb071d`, Codex `7ef62d1a768369db755580e181187c2d2c8a0a10`, and Claude `fd94704ec62d3a309ed07ca257e1fa743cd04d15`) converge on the exact same architecture, file list, and verification requirements. They correctly keep manual mode as a clean, idempotent launch and teardown lifecycle that leverages existing tmux controller capabilities and git safety hooks without extending the coordinator state machine, schemas, or GitHub polling.

The plans are approved for implementation.
