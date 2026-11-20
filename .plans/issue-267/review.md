# Plan Review — Issue #267

Reviewed bound plans:
- **Claude** (`97409c3f955c3c7173776ef08f17803f81e1eecb`)
- **Codex** (`9e8d67c7bc6eb1665efd60550ae25683b8b8bd37`)
- **Antigravity** (`efac99cd51e776e118ea6d7930a82804872af86a`)

## Findings

### Plan from Claude (`97409c3f955c3c7173776ef08f17803f81e1eecb`)

1. **Exact File List / Reuse and Scope (lines 49-62) and Risks and Mitigations (lines 171-177) — unscoped server-wide `copy-command`**:
   - *Rule that must hold*: Clipboard behavior must be scoped to coordinator-managed agent windows and must not alter clipboard behavior for unrelated tmux sessions on the same server (Issue #204 scoping invariant tested via `hook-holder` in `test/tmux.test.ts:1625-1639`, and owner guidance).
   - *Concrete failure*: Setting `set-option -s -q copy-command /usr/bin/pbcopy` directly on the server causes any unrelated tmux session on the owner's default tmux server (such as personal sessions or `hook-holder`) to pipe copy-mode selections into `/usr/bin/pbcopy` and overwrite the macOS pasteboard whenever `copy-pipe-and-cancel` runs.
   - *Smallest correction*: Guard execution inside `copy-command` with a per-session environment variable set only on coordinator-managed sessions (for example, `COORD_COPY_TO_CLIPBOARD=1`, draining stdin to `/dev/null` otherwise) so unrelated sessions experience no clipboard side effect.

2. **Tests (lines 123-132) — option-string assertion only, missing behavioral delivery check and all-7-agent coverage**:
   - *Rule that must hold*: Acceptance tests must verify actual clipboard delivery from tmux copy-mode across all seven supported agent windows (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`) regardless of the active issue roster, prove unrelated-session isolation, and run deterministically without requiring `process.platform === "darwin"` or touching the host clipboard.
   - *Concrete failure*: The isolated tmux test only inspects `show-options -sv copy-command` for a single `claude` agent (and expects `""` on non-darwin). It passes even if `copy-pipe-and-cancel` fails to invoke the command or fails to deliver selected bytes, leaves `codex`, `cursor`, `antigravity`, `muse`, `gemini`, and `opencode` untested, and never verifies that unrelated `hook-holder` copies do not reach the clipboard.
   - *Smallest correction*: Inject a deterministic temp-file sink as the clipboard command in `TmuxController` and execute `copy-mode` + `copy-pipe-and-cancel` in the isolated tmux test across managed sessions vs `hook-holder`, plus cover all 7 supported agents in the attach/session tests.

3. **Problem and root cause (lines 22-28) — unmeasured `mouse_any_flag=0` assumption for Cursor**:
   - *Rule that must hold*: Any mouse-enabled coordinator agent window whose harness turns on terminal mouse reporting (`mouse_any_flag=1`) without copying dragged text to the macOS pasteboard must still allow drag-to-copy.
   - *Concrete failure*: Cursor is not in the active issue-267 roster; if Cursor enables `mouse_any_flag=1` and emits only OSC 52 or ignores drags, tmux's default `MouseDrag1Pane` forwards drags to the application (`send-keys -M`) and never enters copy-mode or runs `copy-command`, leaving Cursor drag-to-copy broken.
   - *Smallest correction*: Verify Cursor's live `mouse_any_flag` during implementation; if Cursor sets `mouse_any_flag=1` without native clipboard copy, handle that path explicitly without breaking copy-mode scrollback drags.

4. **Reuse and Scope / Exact File List (lines 51-53) — format-comma hazard in `if-shell -F '#{==:#{copy-command},}'`**:
   - *Rule that must hold*: Preserving an existing owner-configured `copy-command` must work for any valid shell command string.
   - *Concrete failure*: In tmux format comparisons `#{==:a,b}`, an owner `copy-command` containing a literal comma breaks the two-argument comma delimiter of `#{==:...}` and can mis-evaluate the guard.
   - *Smallest correction*: Read `show-options -sv copy-command` directly in `TmuxController` and emit `set-option -s -q copy-command ...` only when `exitCode === 0 && stdout.trim() === ""`.

---

### Plan from Codex (`9e8d67c7bc6eb1665efd60550ae25683b8b8bd37`)

1. **Reuse and Scope (item 2, line 20) — `MouseDrag1Pane` running `copy-mode -M -t =` breaks drag selection in scrolled-back history**:
   - *Rule that must hold*: When a pane is already in copy-mode (`#{pane_in_mode}` is `1`, such as after wheel/trackpad scrolling into history), `MouseDrag1Pane` in the `root` key table must forward the drag via `send-keys -M` so the `copy-mode` / `copy-mode-vi` table's `MouseDrag1Pane` (`select-pane ; send-keys -X begin-selection`) starts a selection at the scrolled offset.
   - *Concrete failure*: Empirically verified on tmux 3.7b: executing `copy-mode -M -t <pane>` while `pane_in_mode=1` (e.g., `scroll_position=177`) exits 0 but leaves `selection_present=0` without starting a selection. Following the plan as written breaks dragging to copy from wheel-scrolled history—contradicting the plan's own acceptance criterion ("Repeat from wheel-scrolled history", line 29).
   - *Smallest correction*: In any marked-pane `MouseDrag1Pane` branch, check `#{pane_in_mode}` first and run `send-keys -M` whenever `pane_in_mode` is `1`, invoking `copy-mode -M -t =` only when `pane_in_mode` is `0`.

2. **Exact File List (line 7), Reuse and Scope (item 1, line 19), and Tests (line 26) — restricts clipboard setup to only Codex and Cursor**:
   - *Rule that must hold*: Per owner guidance, Issue #267 must cover every supported agent window (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`) regardless of the active issue roster, scoping clipboard behavior to coordinator-managed windows while preserving scrolling.
   - *Concrete failure*: Marking only `codex` and `cursor` panes and skipping clipboard setup when neither is in the roster leaves `claude`, `antigravity`, `muse`, `gemini`, and `opencode` uncovered (including primary `coord-<n>` attachments where `mouse on` applies to every window and scrollbar/wheel copy-mode drags in `claude`), and fails the all-7-agent acceptance requirement.
   - *Smallest correction*: Apply coordinator-managed clipboard scoping and acceptance test coverage uniformly across all 7 supported agent windows (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`).

3. **Reuse and Scope (items 2-3, lines 20-21) and Tests (line 26) — violates retained `no bind-key` test invariant and adds fragile `list-keys` parsing while missing double/triple-click copy**:
   - *Rule that must hold*: Existing test assertions the plan commits to retaining must pass (`test/tmux.test.ts:590` asserts `expect(calls.some((args) => args.includes("-g") || args[0] === "bind-key")).toBe(false)`), and key-table wrappers must not break multi-command/braced bindings or omit standard mouse copy gestures.
   - *Concrete failure*: Issuing `bind-key` during `startSession`/`ensureSession` directly fails `test/tmux.test.ts:590` once managed agents trigger clipboard setup, contradicting "Retain the existing Claude, history, scrollbar and scoped-option assertions" (line 26). Additionally, parsing and re-wrapping arbitrary `list-keys` output (which already contains nested `{ ... }` blocks, `\;` chains, and binding flags) is brittle (and `tmux list-keys -T <table?> <key>` prints nothing on tmux 3.7b, requiring full table parsing), while rebinding only `MouseDragEnd1Pane` leaves `DoubleClick1Pane` and `TripleClick1Pane` still piping to an empty `copy-command`.
   - *Smallest correction*: Prefer a session-scoped `copy-command` (which requires zero `bind-key` calls, covers drag-release, double-click, triple-click, and keyboard copy across both `copy-mode` and `copy-mode-vi`, and preserves `test/tmux.test.ts:590`), and only touch `MouseDrag1Pane` (with an explicit `test/tmux.test.ts:590` update and `pane_in_mode` guard) if live measurement proves a supported harness needs it for `mouse_any_flag=1`.

4. **Exact File List (line 9) and Tests (line 28) — unnecessary doc edit and inaccurate hook command statement**:
   - *Rule that must hold*: Keep changes minimal within issue scope, and cite the real hook commands configured for this repository (`AGENTS.md` specifies `verify.precommit` is `pnpm check:fast`; `pnpm test:e2e` runs under coordinator-owned `pnpm check`).
   - *Concrete failure*: Editing `docs/coord-driver.md` expands the file map unnecessarily for a runtime tmux fix, and stating that `pnpm run test:e2e` is a configured local hook command misrepresents what local commit/push hooks enforce versus coordinator-owned final verification.
   - *Smallest correction*: Drop `docs/coord-driver.md` from the implementation file list unless docs are explicitly requested, and list `pnpm check:fast` as the hook-owned check and `pnpm check` as coordinator-owned final verification.

---

### Plan from Antigravity (`efac99cd51e776e118ea6d7930a82804872af86a`)

1. **Reuse and Scope (lines 46-49) and Tests (lines 74-91) — incomplete coverage of all 7 supported agent windows (omits Muse and OpenCode)**:
   - *Rule that must hold*: Per owner guidance, Issue #267 must cover every supported agent window (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`) regardless of the active issue roster, with acceptance checks for all seven agents.
   - *Concrete failure*: The plan's unit and isolated tmux tests explicitly check `claude`, `codex`, `cursor`, `antigravity`, and `gemini`, omitting `muse` and `opencode`. A regression in `muse` or `opencode` client attach options or primary-session copy behavior would not be caught.
   - *Smallest correction*: Parameterize the attach-command unit tests and isolated real-tmux acceptance tests in `test/tmux.test.ts` over the complete 7-agent set (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`), verifying both mouse-enabled clipboard copy and non-mouse native selection clients plus scrolling preservation.

2. **Root Cause (line 9) and Reuse and Scope (lines 62-63) — unmeasured `mouse_any_flag=0` assumption for Cursor (and other non-roster harnesses)**:
   - *Rule that must hold*: Every mouse-enabled supported agent window must capture dragged selections to the macOS clipboard even if the underlying CLI enables terminal mouse tracking (`mouse_any_flag=1`) without writing to the macOS pasteboard.
   - *Concrete failure*: Because Cursor, Muse, Gemini, and OpenCode are not running in the live `coord-267` session, assuming `mouse_any_flag=0` for Cursor without measuring it risks leaving Cursor broken if its TUI enables `mouse_any_flag=1` and ignores drags or relies on OSC 52.
   - *Smallest correction*: Verify live `mouse_any_flag` behavior (or test both `mouse_any_flag=0` and `mouse_any_flag=1` scenarios) during implementation so any mouse-reporting harness without native clipboard support is explicitly handled.

3. **Reuse and Scope (line 40) — bare `pbcopy` instead of `/usr/bin/pbcopy`**:
   - *Rule that must hold*: The macOS clipboard command executed by the tmux server should not depend on an interactive shell `PATH`.
   - *Concrete failure*: If the tmux server was spawned with a minimal `PATH` omitting `/usr/bin`, bare `pbcopy` fails with exit 127 while `/usr/bin/pbcopy` succeeds.
   - *Smallest correction*: Return `"/usr/bin/pbcopy"` from `defaultClipboardCommand("darwin")`.

## Conclusion

- **Scope, reuse, and test discipline**: Both **Antigravity (`efac99cd`)** and **Claude (`97409c3f`)** stay strictly within `src/tmux.ts` and `test/tmux.test.ts`, create zero new files, and reuse the existing scrolling and isolated-tmux helpers. **Codex (`9e8d67c7`)** creates no new files but expands into `docs/coord-driver.md` and adds complex `list-keys`/`bind-key` rewriting that conflicts with `test/tmux.test.ts:590`.
- **Recommendation**: **Antigravity (`efac99cd`)** is the strongest baseline—it is the only plan that simultaneously keeps `mouse on` scrolling intact, avoids `bind-key` mutations, preserves owner-configured `copy-command`, scopes clipboard piping strictly to coordinator-managed sessions (`COORD_COPY_TO_CLIPBOARD=1` with `hook-holder` isolation), and proves end-to-end `copy-pipe-and-cancel` delivery via a real isolated tmux test with a temp-file sink. Before finalizing implementation, incorporate three targeted fixes: (1) extend coverage and acceptance checks to all 7 supported agents (`codex`, `cursor`, `claude`, `antigravity`, `muse`, `gemini`, `opencode`) per owner guidance; (2) use `/usr/bin/pbcopy`; and (3) verify whether Cursor (or any other mouse-enabled supported agent) sets `mouse_any_flag=1` without native clipboard copy (and if so, guard any drag override on `#{pane_in_mode}` so scrolled-back drags keep working).
