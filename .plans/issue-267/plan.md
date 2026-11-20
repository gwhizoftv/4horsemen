# Issue 267 plan — copy a mouse-dragged selection from Codex and Cursor panes

## Problem and root cause

Issue 267: in the Codex and Cursor owner terminals, dragging with the mouse and
then releasing (or pressing Cmd-C) no longer puts the text on the macOS
clipboard. Claude, Antigravity, and Gemini terminals still work.

Root cause (observed live on this machine, tmux 3.7b, Terminal.app clients
reporting `xterm-256color` with the `clipboard` feature):

- `ce71b24` ("enable scoped scrolling") set the tmux session option `mouse on`
  for `claude`, `cursor`, and `codex` only (`src/tmux.ts:529-534`). Because
  tmux then owns mouse reporting, Terminal.app can't make its own native
  selection, so Cmd-C has nothing to copy. Antigravity and Gemini keep
  `mouse off`, which is why they still copy natively.
- Claude still works because Claude Code captures the mouse itself. Its pane
  reports `mouse_any_flag=1 mouse_sgr_flag=1 alternate_on=1`, so tmux's root
  binding `MouseDrag1Pane` (`if -F "#{||:#{pane_in_mode},#{mouse_any_flag}}"
  { send-keys -M } { copy-mode -M }`) passes the drag to Claude Code, and
  Claude Code copies the selection itself.
- The Codex pane (launched `--no-alt-screen`) reports `mouse_any_flag=0`. Cursor
  gets the same `mouse on` and doesn't capture the mouse either. So a drag
  enters tmux copy-mode, and release runs the default
  `MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel` with no command.
  With the server's `copy-command ''` and `set-clipboard external`, the text
  goes only into a tmux paste buffer plus an OSC 52 sequence. Terminal.app
  ignores OSC 52, so the macOS pasteboard never receives it.

I checked this on an isolated `tmux -L` scratch server:

- `copy-pipe-and-cancel` with no argument runs the server option
  `copy-command`.
- `copy-command` isn't format-expanded, and it's server-scoped (tmux has no
  per-session copy pipe).
- `if-shell -F '#{==:#{copy-command},}' 'set-option -s copy-command /usr/bin/pbcopy'`
  sets it when the option is empty and leaves an existing owner value
  (`owner-cmd`) unchanged.
- After that, a copy-mode selection appeared in `pbpaste`.

Fix: when coord turns tmux mouse mode on for an issue on macOS, also point
tmux copy-mode at `/usr/bin/pbcopy`, but only if the owner hasn't already
configured a `copy-command`. This keeps mouse-wheel scrolling (the reason
mouse mode was enabled) and makes drag-and-release copy to the pasteboard.

## Exact File List to be changed or deleted

- `src/tmux.ts`
  - Next to `sessionScrollOptions` (around line 531), add an exported pure
    helper:
    `copyCommandOptions(os: NodeJS.Platform = platform()): string[][]`.
    On `darwin` it returns exactly
    `[["if-shell", "-F", "#{==:#{copy-command},}", "set-option -s -q copy-command /usr/bin/pbcopy"]]`.
    On any other platform it returns `[]`. A short comment explains the
    root cause above: mouse mode puts drags in copy-mode, Terminal.app ignores
    OSC 52, the option is server-scoped, and the empty guard preserves owner
    configuration.
  - In `TmuxController.configureSessionScrolling` (line 990), chain
    `...(mouse ? copyCommandOptions() : [])` after `sessionScrollOptions(...)`
    in the same single runner call. This runs it on `startSession` (line 961),
    on `ensureSession` resume (line 1098), and for linked mouse clients
    (line 1132). It adds no extra tmux round trip and changes no error message.
  - `sessionScrollOptions` and `agentClientAttachCommand` stay unchanged. The
    attach command joins arguments with spaces for a Terminal.app shell, and
    the server option is already set by the controller before any owner
    client attaches.
- `test/tmux.test.ts`: extend two existing tests; no new test file (see Tests).

Nothing is deleted. No other path changes: no docs, launcher, config, or
`githooks/` edits.

## Exact file list to be created

None. The plan artifact `.plans/issue-267/plan.md` is coordination evidence,
not an implementation file. The fix fits in the existing `src/tmux.ts` scroll
configuration, and the tests join the existing `test/tmux.test.ts`.

## Reuse and Scope

Reused:

- `sessionScrollOptions` / `mouseScrollingAgent` (`src/tmux.ts:529-534`):
  these already decide which sessions get `mouse on`. The new option is gated
  on the same `mouse` flag, so Antigravity and Gemini (mouse off, native
  selection already works) are untouched.
- `TmuxController.configureSessionScrolling` (`src/tmux.ts:990-994`): this is
  the existing single chained runner call that both start and resume already
  go through, so the copy-command arrives on fresh and resumed issues without
  a new call site.
- The `platform` import from `node:os` (`src/tmux.ts:3`), already used for the
  darwin-only Terminal opener and closer at lines 748 and 819-821.
- The `-q` pattern already used for `pane-scrollbars`
  (`windowScrollOptions`, line 537), so tmux older than 3.2 (no `copy-command`
  option) doesn't fail session start.
- Test helpers `commandsIn` (`test/tmux.test.ts:31`), `ok()`, the mocked
  `TmuxController` runner in the `ensureSession` scrolling test
  (`test/tmux.test.ts:~538-591`), and the isolated real-tmux server test
  `isolated tmux exit diagnostics` (`test/tmux.test.ts:1584+`, private `-L`
  socket with `-f /dev/null`).

Scope: one exported helper and one spread in an existing private method. No
new file, abstraction, dependency, or config key. The owner keeps control,
because an existing non-empty `copy-command` is never overwritten. Linux and
other platforms get no change; their terminals generally honor OSC 52.

## Tests

Both cases join `test/tmux.test.ts`. Run focused:
`pnpm vitest run --config vitest.config.ts test/tmux.test.ts`.

1. Extend the mocked-runner scrolling test that ends with
   `expect(calls.some((args) => args.includes("-g") || args[0] === "bind-key")).toBe(false)`
   (`test/tmux.test.ts:~584-591`):
   - Assert `copyCommandOptions("darwin")` equals the exact guarded
     `if-shell` command above.
   - Assert `copyCommandOptions("linux")` equals `[]`.
   - Assert `calls.flatMap(commandsIn)` from the `ensureSession` resume
     contains every entry of `copyCommandOptions()`. This is non-empty on the
     macOS owner host, so the test fails before the change, when the export
     and the call are missing.
   - The existing "no `-g`, no `bind-key`" assertion stays, which proves the
     fix doesn't rebind keys or set global session options.
2. Extend `isolated tmux exit diagnostics` (real tmux, private socket):
   - After the first `controller.startSession(3, [agent], logDir)`, read
     `show-options -sv copy-command`. Expect `/usr/bin/pbcopy` when
     `process.platform === "darwin"` and `""` otherwise.
   - Then, before the existing `ensureSession` resume, run
     `set-option -s copy-command owner-cmd`. After the resume, expect
     `owner-cmd`, which proves the guard never overrides owner configuration.
   - This fails before the change on macOS, because copy-command stays empty.
     It also confirms the `if-shell -F` format and `-q` are accepted by real
     tmux.

Required checks: the pre-commit hook owns `pnpm check:fast`, and I won't
duplicate it by hand right before committing. The coordinator owns final
`pnpm check` at the approved pin.

Manual confirmation, not a gate: in a coord-attached Codex or Cursor
Terminal.app window, drag over text, release, and paste elsewhere. Scrolling
with the wheel still scrolls tmux history.

## Alternatives Rejected

- **Turn `mouse` off for Codex and Cursor.** This restores Terminal.app's
  native selection and Cmd-C, but undoes the deliberate `ce71b24` scrolling
  behavior. Codex runs inline (`--no-alt-screen`), so its history lives in
  tmux, and without tmux mouse the wheel inside tmux's alternate screen turns
  into arrow keys sent to the composer.
- **Rebind `MouseDragEnd1Pane` in `copy-mode`/`copy-mode-vi` to
  `copy-pipe-and-cancel pbcopy`.** This overwrites the owner's global key
  bindings, needs per-mode-keys duplication, and breaks the existing test
  invariant that coord issues no `bind-key`.
- **Set `copy-command` unconditionally.** This clobbers an owner's own
  clipboard command (for example a custom pipe or OSC 52 helper). The
  empty-only guard avoids that.
- **Scope the copy pipe per session with `#{session_name}` or `$COORD_ISSUE`.**
  The scratch probe showed `copy-command` isn't format-expanded, and the job
  environment falls back to the server's global environment, which can carry
  a stale `COORD_ISSUE`. It's fragile and adds shell logic for no reliable
  gain.
- **Document a workaround only** (for example "hold Fn while dragging" to
  bypass mouse reporting in Terminal.app). The issue reports a regression in
  default behavior, and documentation doesn't restore drag-and-release copy.
- **Set the option in `agentClientAttachCommand` as well.** Not needed: the
  option is server-scoped and already set before any owner client attaches.
  Quoting `if-shell` format braces through the Terminal.app shell string adds
  risk.

## Risks and Mitigations

- **Server-wide effect.** `copy-command` applies to every session on the
  owner's default tmux server for the server's lifetime, not only coord
  sessions. Mitigation: it's only set when empty, so no owner value is
  replaced. It only adds a pasteboard copy after a copy-mode copy the owner
  already performed, so tmux buffers and OSC 52 behavior are unchanged. It's
  macOS-only, and it's limited to the case where coord enabled mouse mode.
  The risk is called out in the helper comment.
- **tmux older than 3.2 lacks `copy-command`.** Mitigation: `set-option -q`
  suppresses the unknown-option error, the same pattern as `pane-scrollbars`,
  so session start doesn't fail. The real-tmux test exercises the accepted
  syntax on the installed tmux.
- **pbcopy from the tmux server not reaching the user pasteboard** (the old
  `reattach-to-user-namespace` problem). Mitigation: verified working on
  tmux 3.7b on this macOS host. Absolute `/usr/bin/pbcopy` avoids depending
  on the server's PATH.
- **Chained-command failure masking.** The option rides in the same chained
  call as `history-limit` and `mouse`, so a failure still surfaces as the
  existing `cannot configure scrolling in <session>` error. No new silent
  path.
- **Platform-dependent test assertion.** Mitigation: the pure helper is
  asserted for both `darwin` and `linux` explicitly, and the integration
  assertions compare against `copyCommandOptions()` and `process.platform`,
  so CI on either platform stays deterministic.

## Conclusion

Codex and Cursor lost drag-to-copy because `ce71b24` enabled tmux mouse mode
for them. They don't capture the mouse the way Claude Code does, so drags land
in tmux copy-mode, whose copy only emits OSC 52, and Terminal.app ignores it.

The smallest complete fix is one guarded, macOS-only, owner-preserving
`set-option -s -q copy-command /usr/bin/pbcopy` chained into the existing
`configureSessionScrolling` call whenever mouse mode is enabled. It keeps
mouse scrolling, touches only `src/tmux.ts` and `test/tmux.test.ts`, adds no
files or dependencies, and is covered by two extensions of existing tests:
one with a mocked runner and one on a real isolated tmux server.
