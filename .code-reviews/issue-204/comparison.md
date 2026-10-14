# Issue 204 — implementation comparison (claude)

Compared bound implementation pins, read from the exported worktrees:

- claude `f5b1085136ab54505b4c63a4aca8a7a96f4bee67`
- codex `ce71b24b540206d01c0c035d692bab85c846057d`
- cursor `b32cccf1d91eedf8f48cb834586070f06b25fe21`

All three implement the selected codex plan (`367d4695`), and their product
changes stay inside the approved ten paths. I compared them with `diff -u`
between the worktrees. I ran no product suites for this comparison and claim
no coordinator-owned results. The claude pin's suites are the ones I ran while
implementing it, before this action.

## Comparison

### Shared behaviour, the same in all three

- `scripts/lib/launcher.sh`: Codex gets `--no-alt-screen` before
  `--no-daemon`, and the other flags and grants are unchanged.
- `src/state.ts`: `actionSafety.scrollbackWait` is an optional
  `{ observedAt, lastReminderAt }`, so older cursors files still parse.
- The `owner-typing` code and the pane gate are unchanged.
  `DEFERRAL_RATIONALE["owner-typing"]` and the log/status sentence are the
  issue's exact wording.
- The journal keeps one `nudge-deferred` row per action. Only the console line
  repeats, every 180 000 ms, timed from the persisted `lastReminderAt`, so the
  timing survives restarts.
- Status shows the wait only for an active, `ordered` agent on the matching
  action whose lifecycle has not accepted or completed it.
- tmux settings use explicit `-t` (no `-g`, no key bindings). `history-limit`
  is set before any agent `new-window`. `pane-scrollbars` uses `-q`, and
  required session options still fail loudly. All three also re-apply settings
  on resume to the base session, to live windows and to linked clients that
  are already open.

### Differences

| | claude | codex | cursor |
| --- | --- | --- | --- |
| `pane-scrollbars` windows | every agent | claude, cursor | every agent |
| Linked-client `mouse` | every agent | claude, cursor, codex (history only for others) | every agent |
| Existing-client detection | one `list-sessions`, exact name set | `has-session -t =<client>` (exact) | `has-session -t <client>` (tmux prefix/fnmatch fallback) |
| Wait cleared on completion receipt | no | yes, plus every tick when status would hide it | yes |
| Wait cleared on working/pending/background early return | yes | yes | no (status filter hides it instead) |
| `observedAt` across reminders | kept (episode start) | reset to each reminder | kept |
| New exports | `scrolledBackNotice` | `scrollbackWaitMessage`, `currentScrollbackWait` | `scrollbackWaitNotice`, `SCROLL_HISTORY_LIMIT`, `sessionScrollArguments`, `scrollbarArguments` |
| Source lines (4 src files) | 6690 | 6692 | 6786 |

### Findings

**F1 (claude and cursor): scrollbar and mouse scope is wider than the issue.**
- Where: claude `src/tmux.ts:461`, used at `:1063` and `:1106`; cursor
  `src/tmux.ts:1102`, `:1129`, and the attach command at `:476–485`.
- Rule: the issue scopes "mouse on, and pane-scrollbars on" to Claude and
  Cursor, and gives Codex `--no-alt-screen` instead. The codex plan's own
  reviewers (cursor, and claude F7) asked for exactly that limit.
- Failure: the Antigravity and Gemini windows also get an always-on scrollbar,
  which takes a column and reflows their TUI. Their Terminal clients also get
  `mouse on`, which the issue never asked for.
- Test sketch: in `test/tmux.test.ts`, build `agentAttachLaunches(7, [antigravity])`
  and assert the command contains no `pane-scrollbars` and no `mouse on`.
  Codex's pin satisfies this through `windowScrollOptions` and
  `mouseScrollingAgent` (codex `src/tmux.ts:450`, `:458`).

**F2 (claude): the wait is not cleared when a completion receipt arrives.**
- Where: claude `src/runLoop.ts:3246`.
- Rule: once the agent has submitted, the action is no longer waiting to be
  sent.
- Failure: a pane stays scrolled back while the agent writes `complete`. Until
  the coordinator moves the cursor off `ordered`, `coord status` still prints
  "scroll to the bottom to let coord send". After a `complete` arrives,
  `deliver()` is never called again, so nothing clears the record.
- Severity: low, because the window lasts only until acceptance.
- Test sketch: in `test/runLoop.test.ts`, use `safetyFixture`, tick with
  `ui.busy = true`, write the agent's `complete`, tick, and assert
  `scrollbackWait` is undefined. Codex (its per-tick `currentScrollbackWait`
  check) and cursor (its receipt branch) both satisfy this.

**F3 (codex): every reminder resets `observedAt` to the reminder time.**
- Where: codex `src/runLoop.ts:2032`, `scrollbackWait: { observedAt: now, lastReminderAt: now }`.
- Rule: the plan and the schema define `observedAt` as when the wait was
  observed, separate from the last reminder.
- Failure: the paused status line (`src/issueReport.ts:137`, "Last observed
  scrollback wait … at ${observedAt}") reports the last reminder time, not when
  the wait began. The field then carries no information that `lastReminderAt`
  does not.
- Severity: cosmetic. Delivery, reminders and clearing are unaffected.
- Fix sketch: `observedAt: safety.scrollbackWait?.observedAt ?? now`.

**F4 (cursor): `has-session -t <client>` is not an exact match.**
- Where: cursor `src/tmux.ts:1114`.
- Rule: per tmux(1), a `target-session` without `=` falls back to prefix and
  then `fnmatch` matching. Scoping to coord's own client must use the exact
  name, as codex does with `=`.
- Failure: if `coord-N-<agent>` does not exist but another session whose name
  starts with it does, `applyLinkedClientScroll` sees success. It then runs
  `set-option -t coord-N-<agent>`, which resolves the same way, and changes
  the other session's `mouse` and `history-limit`.
- Severity: unlikely with today's naming, but it removes the "only coord's own
  sessions" guarantee.
- Fix sketch: `["has-session", "-t", `=${client}`]`, with the same `=` on
  `set-option -t`.

**F5 (cursor): a misplaced doc comment and unneeded exports.**
- Where: cursor `src/tmux.ts:450–459`.
- Rule: keep the change minimal and keep each doc comment on the symbol it
  describes.
- Failure: the `agentClientAttachCommand` JSDoc now sits above
  `SCROLL_HISTORY_LIMIT`, so the attach command loses its documented reason for
  quoting `';'`. `SCROLL_HISTORY_LIMIT`, `sessionScrollArguments` and
  `scrollbarArguments` are exported, but no test or other module imports them.
- Severity: no behavioural failure.

### Scope, reuse and tests

All three reuse `launchAgent`, `agentClientAttachCommand`, `injectionGate`,
`journalDeferral`, `renderIssueReport` and `launcher_command()`. Each adds
cases only to the five existing test files, using `commandsIn`,
`safetyFixture`, `installOnce` and the isolated `-L` tmux server, with no new
files or dependencies.

- **codex** has the tightest scope (F1 satisfied), the most complete clearing
  (receipt, a per-tick status-eligibility check, early returns, dead pane) and focused
  tests. It has three runLoop cases, including "does not repeat a scrollback
  reminder when the pane cannot be observed", plus one case each in tmux, state
  and issueReport.
- **claude** is the smallest source change. It covers repeat across restarts,
  re-entry, another blocker and the owner submitting by hand. It also extends
  the real-tmux test to check that the server defaults stay untouched. It has
  F1 and F2.
- **cursor** is the largest source change (+~95 lines over codex). It splits
  the logic into `announceDeferral`, `repeatScrollbackNotice`,
  `scrollbackDue` and `scrollNoticeEligible`, and has F1, F4 and F5.

Ranking: **codex** first, **claude** second, **cursor** third. Codex is the
only pin that matches the issue's per-agent scope, and its only finding (F3)
is cosmetic.
