# Plan Review — Issue 76

Reviewed the bound plans from Cursor
`873c6b403f005930f76710999edfb783df228b5e`, Antigravity
`857dde07fcd6a3ff8e3b79766bfe8f7edeeb071d`, Codex
`7ef62d1a768369db755580e181187c2d2c8a0a10`, and Claude
`fd94704ec62d3a309ed07ca257e1fa743cd04d15`.

## Findings

1. **Antigravity plan — `src/tmux.ts` item 2 and its tmux test list:** The
   plan claims that `sessionName("manual")` may return bare `coord-manual` for a
   flat workspace and only appends a group for a namespaced workspace. Every
   manual session must carry the stable workspace group even when numeric issue
   sessions retain the legacy flat `coord-N` form. If implemented as written,
   two products installed into separate flat coordination roots would address
   the same process-global `coord-manual` tmux session: the second product could
   reuse the first product's agent panes, and `coord detach manual` or uninstall
   from either product could kill the other's harnesses. The smallest correction
   is to always derive `coord-manual-<terminalGroup>` and its titles from the
   mandatory group and reject manual naming when that group is absent.

2. **Cursor plan — `src/tmux.ts` generalization and idempotency sections:** The
   plan claims that the existing numeric tmux helpers, including
   `ensureSession`, can be generalized to a manual key, but it does not account
   for `ensureSession`'s current unconditional
   `set-environment ... COORD_ISSUE String(issue)` operation or require a test
   that excludes it. A manual harness must not receive any issue identity,
   because owner chat is its only task authority and no coordinator action
   exists. A literal implementation of the proposed signature widening would
   set `COORD_ISSUE=manual`; agent lifecycle consumers and `coord next` would
   then observe an invalid synthetic issue and could enter issue-oriented error
   or recovery behavior instead of waiting for the owner's task. The smallest
   correction is to set `COORD_ISSUE` only for numeric keys, explicitly remove
   any inherited/stale value for the manual session, and pin that absence in
   `test/tmux.test.ts`.

No additional blocking defect was found in the bound Claude or Codex plans;
both make the workspace group mandatory for manual UI and explicitly prevent a
manual session from advertising `COORD_ISSUE`.

## Conclusion

The common launch-only architecture is sound, and the Claude and Codex plans
are mechanically complete candidates. The Antigravity plan is unsafe as
written because its flat manual name is globally unscoped, while the Cursor
plan needs an explicit manual environment branch to avoid creating a synthetic
issue identity. Any selected implementation should use
`coord-manual-<workspace-group>` for every workspace, preserve numeric naming,
and ensure manual panes have no `COORD_ISSUE` before proceeding.
