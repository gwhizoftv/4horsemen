# Issue 267 plan review (claude)

These are the bound plans I reviewed:

- claude `97409c3f955c3c7173776ef08f17803f81e1eecb`
- codex `9e8d67c7bc6eb1665efd60550ae25683b8b8bd37`
- antigravity `efac99cd51e776e118ea6d7930a82804872af86a`

All three, each read from `.plans/issue-267/plan.md` at its pin, agree on the root cause. Commit `ce71b24` turned tmux `mouse on` for the Claude, Cursor and Codex sessions. Codex's pane reports `mouse_any_flag=0`, so a drag enters tmux copy-mode. On release, `copy-pipe-and-cancel` runs with an empty `copy-command`, and its only output is OSC 52, which Terminal.app ignores. Claude Code captures the mouse itself (`mouse_any_flag=1`) and copies the selection on its own.

Scope and reuse are acceptable in all three plans:

- None creates a file.
- Each reuses `sessionScrollOptions`, `configureSessionScrolling`, `commandsIn`, `ok()` and the isolated `-L` tmux test in `test/tmux.test.ts`.
- Codex alone also edits `docs/coord-driver.md`, and that edit is justified as owner instructions.

I independently confirmed one fact the antigravity plan depends on, using a scratch `tmux -L` server (3.7b). A `copy-command` job runs with the environment of the session doing the copy. In session `coord-9`, `$COORD_ISSUE` read `9`, the value set with `set-environment -t coord-9`. Another session fell back to the server's global value. `copy-command` itself is not format-expanded.

The owner guidance for this action adds two requirements:

- Drag-to-copy, and its acceptance checks, must cover all seven agent windows (Codex, Cursor, Claude, Antigravity, Muse, Gemini, OpenCode).
- Clipboard behavior must stay scoped to windows coord manages, and scrolling must be preserved.

## Findings

### F1. claude plan: unscoped server-wide `copy-command` (blocking)

- **Plan claim.** Under Exact File List and Risks ("Server-wide effect"), my plan sets `set-option -s -q copy-command /usr/bin/pbcopy` whenever the option is empty, and accepts that this affects every session on the owner's tmux server.
- **Rule.** Clipboard behavior must be scoped to coordinator-managed agent windows (owner guidance). This matches the suite's existing invariant that coord leaves unrelated sessions unchanged: the `hook-holder` comparison in the isolated tmux test, and the no-`-g` and no-`bind-key` assertion at `test/tmux.test.ts:590`.
- **Failure.** After any `coord start` on macOS, the owner works in an unrelated session `work` on the default tmux server and copies something in copy-mode. That copy silently replaces the macOS pasteboard. The change outlives the coord issue and lasts as long as the tmux server does. The guidance rules this out.
- **Correction.** Replace the bare `pbcopy` with antigravity's guarded command: `if [ "${COORD_COPY_TO_CLIPBOARD:-}" = 1 ]; then pbcopy; else cat >/dev/null; fi`. Set the marker with `set-environment` on coord's sessions. In unrelated sessions, copying then behaves exactly as it does today.

### F2. codex plan: wrapping the owner's global tmux key bindings (blocking)

- **Plan claim.** Reuse and Scope steps 2–3 have the plan:
  - read the current `MouseDrag1Pane` binding (root table) and the `MouseDragEnd1Pane` bindings (`copy-mode` and `copy-mode-vi` tables) with `list-keys`;
  - install conditional wrappers that delegate to the previous action for unmarked panes;
  - make that installation idempotent.
- **Rule.** Coord must not rewrite the owner's server-wide key tables, and the existing test asserts that no `bind-key` is issued (`test/tmux.test.ts:590`). Any owner binding must survive exactly as it was.
- **Failure.**
  - `list-keys` prints each binding as tmux command text, such as `bind-key -T root MouseDrag1Pane if-shell -F "#{||:…}" { send-keys -M } { copy-mode -M }`. Reinstalling it inside a wrapper means parsing and re-quoting tmux's own syntax: braces, nested quoting, `-N` notes and `-r` repeat flags. A binding the owner defined with a `-N` note or `-r` loses that flag when it is wrapped.
  - The read-modify-write has no lock. Two `coord start` runs for different issues on the same server can both read the default binding and install wrappers, or one can wrap the other's wrapper.
  - The wrappers stay in the owner's key tables after every coord session ends.
  - The plan names a goal ("recognizable … idempotent") but no mechanism that prevents any of this.
- **Correction.** Drop the key-table rewrite and use a scoped `copy-command`, as antigravity does. The default bindings already route drag, double- or triple-click, and keyboard copies through `copy-pipe-and-cancel`.

### F3. codex plan: the integration test can't produce mouse events (blocking for that test)

- **Plan claim.** Under Tests ("one isolated tmux regression"), the plan would "exercise a drag from an idle pane and one which enables mouse reporting, across the emacs and vi tables". It asserts that releasing the button writes the selection, and that an unrelated pane's custom drag action still runs.
- **Rule.** Each proposed test must be runnable with the existing helpers (`runTmux`, a private `-L` socket) and must fail before the change and pass after it.
- **Failure.**
  - tmux mouse events come only from an attached client's terminal input. `send-keys -M` only replays the mouse event that is currently being handled inside a binding.
  - The existing isolated tests run a detached server with no client, so nothing in this test can fire `MouseDrag1Pane` or `MouseDragEnd1Pane`.
  - The implementer is left with two choices. One is a new pseudo-terminal client harness, which is neither in the file map nor among the dependencies. The other is to fall back to `send-keys -X copy-pipe-and-cancel`, which bypasses exactly the bindings this plan changes. In that case the test passes without exercising the change.
- **Correction.** Test the copy pipe with `send-keys -X`, as the claude and antigravity plans do, which is valid when the bindings are left alone. Keep the drag gesture itself in the manual acceptance check.

### F4. All three plans: no acceptance coverage for all seven agent windows (blocking)

- **Plan claim.**
  - The claude plan's Tests use a Claude agent fixture and assert only that the guarded command is sent.
  - The codex plan marks and tests only Codex and Cursor panes.
  - The antigravity plan's integration test covers Codex and Cursor. Its unit checks cover Claude, Codex, Cursor, Antigravity and Gemini. It only asserts that Muse and OpenCode work natively.
- **Rule.** Drag-to-copy and its acceptance checks must cover Codex, Cursor, Claude, Antigravity, Muse, Gemini and OpenCode, whichever agents are on the current issue roster (owner guidance).
- **Failure.**
  - Suppose a later change adds Muse or OpenCode to `mouseScrollingAgent`, so its window gets `mouse on`, without setting the clipboard marker. Every proposed test still passes, but drag-to-copy in that window breaks the same way issue 267 did.
  - Under the codex plan, the owner can attach the primary `coord-<n>` session (which always has `mouse on`) and drag in the Muse, Antigravity, Gemini or OpenCode window. That pane is unmarked, so the drag gets the empty-`copy-command` behavior and nothing reaches the pasteboard.
- **Correction.**
  - Add one table-driven case in `test/tmux.test.ts` over all seven ids, checking `agentClientAttachCommand` and the `ensureSession` client repair. Each id must either get `mouse on` together with the clipboard marker, or have mouse off so native Terminal selection works. Any other combination fails the test.
  - Mark the primary session as well, which antigravity already does through `configureSessionScrolling(session)`.
  - Extend the manual acceptance check to all seven windows, recording which ones the owner actually observed.

### F5. All three plans: whether Cursor, Gemini and OpenCode capture the mouse is not measured (blocking until measured)

- **Plan claim.**
  - claude, Root cause: "Cursor gets the same `mouse on` and doesn't capture the mouse either."
  - antigravity, Root Cause: "no app mouse tracking for Cursor", and Antigravity, Muse, OpenCode and Gemini "perform native macOS Terminal.app selection".
  - Neither plan measured Cursor, Gemini or OpenCode; none of them is on issue 267's roster. Only Codex and Claude are measured live. I measured Muse 1.4.24 separately (no mouse tracking, no alternate screen).
- **Rule.** The fix must hold for every agent window as its TUI actually behaves, and the plan's stated root cause must be evidence, not assumption.
- **Failure.**
  - If Cursor's `agent` TUI turns on mouse tracking (`mouse_any_flag=1`), tmux's default root binding sends the drag on to Cursor with `send-keys -M` and never enters copy-mode. Under the claude and antigravity plans, `copy-command` never runs and Cursor stays broken, while every proposed test still passes.
  - In a mouse-off session (OpenCode or Gemini), tmux passes the pane's own mouse mode through to Terminal.app. If OpenCode turns on mouse tracking, Terminal's native selection is blocked, and copying then depends on OpenCode's own copy, which may use only OSC 52.
- **Correction.**
  - Before implementation, measure `#{mouse_any_flag}` and `#{alternate_on}` for `agent` (Cursor), `gemini` and `opencode` in a scratch `tmux -L` server, and record the results in the plan.
  - If any of them captures the mouse without delivering its own copy to the pasteboard, handle that agent explicitly. The codex plan's forced `copy-mode -M` for marked panes is the only proposal that addresses this case, but it should be gated to agents measured to need it, not done by rewriting global bindings (F2).

### Plan-level assessment

- **antigravity** is the strongest base. It keeps the scope to two files, stays scoped to coord sessions through the session-environment marker, issues no `bind-key` or `-g`, and never overwrites an owner `copy-command`. It tolerates tmux older than 3.2 (it checks the `show-options` exit code), keeps `assertAuthority()` between awaited runner calls, and its tests are hermetic: an injected sink command, and `COORD_COPY_TO_CLIPBOARD` removed from the private server's environment. It needs F4 and F5.
- **claude** (my own plan) is minimal and its test proposal is sound, but F1 rules it out as written. It also has the F4 and F5 gaps.
- **codex** is the only plan that handles a pane which captures the mouse, but F2 and F3 make its central mechanism and its integration test unsafe or unrealizable. The docs edit is reasonable but optional.

## Conclusion

Proceed on the antigravity plan, with three amendments:

1. Add one table-driven attach and repair test over all seven agent ids, plus a seven-window manual acceptance check (F4).
2. Measure and record mouse capture for Cursor, Gemini and OpenCode, and handle any agent that captures the mouse without delivering its own copy to the pasteboard (F5).
3. Keep the env-guarded `copy-command` in place of my plan's unscoped `pbcopy` (F1).

Reject the codex plan's key-table wrapping (F2) and its mouse-event integration test (F3). Reject the claude plan as written (F1).

I ran no product checks for this review. My only verification was the scratch tmux probes described above, against an isolated `-L` server.
