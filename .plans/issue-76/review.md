# Plan review — issue 76

Bound plans reviewed:

| Agent | SHA | Path |
| --- | --- | --- |
| cursor | `873c6b403f005930f76710999edfb783df228b5e` | `.plans/issue-76/plan.md` |
| antigravity | `857dde07fcd6a3ff8e3b79766bfe8f7edeeb071d` | `.plans/issue-76/plan.md` |
| codex | `7ef62d1a768369db755580e181187c2d2c8a0a10` | `.plans/issue-76/plan.md` |
| claude | `fd94704ec62d3a309ed07ca257e1fa743cd04d15` | `.plans/issue-76/plan.md` |

## Findings

### 1. Antigravity — `src/tmux.ts` naming (`coord-manual` without group)

**Claim.** For `issue === "manual"`, format the session name as `coord-manual` when un-namespaced (flat) or `coord-manual-${group}` when namespaced; tests expect `sessionName("manual")` → `coord-manual` (flat).

**Rule.** Manual UI identity must be workspace-scoped as `coord-manual-<workspace-group>` for every layout. Tmux session names are machine-global; two flat products on one host must never share one session name. The issue’s researched answer and the Codex/Claude/Cursor binding decisions all require the group suffix on manual sessions, not only on Terminal titles.

**Failure.** Following Antigravity as written, product A and product B each running flat `coord manual` both create tmux session `coord-manual`. The second launch hits “session already exists” or attaches to the other product’s panes; `coord detach manual` for one product can tear down the other’s agents.

**Correction.** Always name the manual session `coord-manual-<safeName(terminalGroup)>` (and matching titles). Refuse to create or detach a manual session when `terminalGroup` is missing; do not mirror numeric flat `coord-N` unscoped naming for the manual key.

### 2. Antigravity — `discoverCoordIssues` widened for `"manual"`

**Claim.** Update `sessionPrefix`, `discoverCoordIssues`, `filterSessionsForIssue`, `detachIssue`, and `detachAllOwnerUiSync` to support `"manual"` sessions alongside numeric issues.

**Rule.** `discoverCoordIssues` must remain digits-only (`number[]`) and must never treat `coord-manual-…` as an issue identity. Manual teardown must use an exact session key / exact group-prefixed name, not issue discovery. Flat uninstall must not invent issue numbers from a global tmux list (existing `detachAllOwnerUiSync` comment).

**Failure.** Teaching `discoverCoordIssues` to recognize manual sessions either breaks its `number[]` return type or injects non-issue identities into callers that enumerate “active issues.” Uninstall/conflict logic that still goes through issue discovery then either type-checks incorrectly or mis-handles manual UI as automated work.

**Correction.** Keep `discoverCoordIssues` digits-only (Claude’s regression). Widen `filterSessionsForIssue` / `detachIssue` with `SessionKey = number | "manual"`, and teach `detachAllOwnerUiSync` an explicit `includeManual` (or equivalent) path that matches only `coord-manual-<group>`.

### 3. Cursor — `ensureSession` reuse without `COORD_ISSUE` rules

**Claim.** Generalize tmux helpers for a workspace-scoped `manual` session key and reuse create/reuse/respawn behavior for idempotent `coord manual` (Binding design / `src/tmux.ts` file bullet). The plan never states what happens to `COORD_ISSUE` in a manual session.

**Rule.** A manual session must not present an issue identity. Today `TmuxController.ensureSession` always runs `set-environment … COORD_ISSUE <issue>`. Manual mode must not set `COORD_ISSUE` (and should clear a stale value). Codex and Claude both bind this; Antigravity states it explicitly.

**Failure.** An implementer who only widens the parameter to `number | "manual"` and keeps the existing `String(issue)` environment write sets `COORD_ISSUE=manual` in every manual pane. Agents and `coord next` then treat the session as issue-bound, contradicting the “no coordinator artifacts / no issue runtime” requirement and producing confusing or wrong owner-control behavior.

**Correction.** Add the Codex/Claude rule: numeric keys set `COORD_ISSUE=<n>`; `"manual"` must not set it (prefer explicitly unsetting any stale `COORD_ISSUE`). Cover with a tmux argv assertion that manual `ensureSession` never records a `COORD_ISSUE` set-environment call.

### 4. Cursor — uninstall bulk teardown vs `issues.length === 0` early return

**Claim.** `src/detachIssue.ts` must include workspace-scoped manual UI in bulk uninstall cleanup even when there are no `issue-*` directories (Exact File List / Risks).

**Rule.** `detachAllOwnerUiSync` currently returns immediately when `issues.length === 0` before any title close or session kill. Requirement 5 of the issue needs uninstall to tear down this workspace’s manual UI with zero issue directories. Naming the goal is not enough unless that early return is moved or gated.

**Failure.** An implementer who only adds a manual branch inside the existing issue loop, or only documents “include manual,” leaves the early return in place. `coord uninstall` on a workspace that used only `coord manual` reports success and leaves `coord-manual-<group>` sessions and Terminal titles alive.

**Correction.** Adopt Claude/Codex’s explicit fix: short-circuit only when there is neither issue work nor manual work; when manual cleanup is requested and `terminalGroup` is present, close `coord-manual-<group>/<agent>` titles and kill the exact manual primary/linked sessions even if `issues` is empty. Add the empty-`issues` uninstall test both plans already describe.

## Conclusion

Codex (`7ef62d1a…`) and Claude (`fd94704e…`) are mechanically aligned with the issue: launch-only lifecycle, mandatory `coord-manual-<group>` identity, no `COORD_ISSUE` on manual sessions, durable workspace-bounded conflict checks, and uninstall that still clears manual UI with no `issue-*` dirs. Cursor (`873c6b40…`) matches the file map and high-level design but underspecifies `COORD_ISSUE` handling and the `detachAllOwnerUiSync` empty-issues early return, so following it literally can ship a poisoned env and a no-op uninstall. Antigravity (`857dde07…`) is the weakest on isolation: unscoped flat `coord-manual` plus widening `discoverCoordIssues` for manual would recreate cross-product collisions and confuse issue discovery. Implement from Codex or Claude; apply findings 1–4 as mandatory corrections to the other two plans before coding.
