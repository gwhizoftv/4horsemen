# Restore drag-to-copy in Codex and Cursor terminals

Releasing an ordinary left-button drag in either agent's macOS Terminal window should put the selected text on the system pasteboard. The owner can then press ⌘V in another app. Wheel and trackpad scrolling must still work. [Issue 267](https://github.com/gwhizoftv/4horsemen/issues/267) · [Existing scrolling requirement](https://github.com/gwhizoftv/4horsemen/issues/204)

## Exact File List to be changed or deleted

- `src/tmux.ts` — configure drag selection and copying for coordinator-owned Codex and Cursor panes on macOS. Apply the configuration during session creation and repair.
- `test/tmux.test.ts` — exercise drag handling, clipboard delivery and isolation using the existing tmux tests.
- `docs/coord-driver.md` — add the drag, release and paste gesture to the Terminal.app attach instructions. Also explain how to use a native Terminal selection with ⌘C.

## Exact file list to be created

None. The implementation fits the existing tmux controller, its test suite and the owner guide.

## Reuse and Scope

The live Codex client reports `mouse=1` and its application reports `mouse_any_flag=0`. On this server, both copy-mode tables end a drag with `copy-pipe-and-cancel`, and the server's `copy-command` is empty. A tmux selection can therefore reach a paste buffer without reaching the Mac pasteboard. Cursor is absent from this issue's roster. Its fix must handle a TUI that requests mouse input, since the default root binding forwards drags to such applications. [tmux mouse bindings](https://github.com/tmux/tmux/blob/3.7b/key-bindings.c) · [tmux clipboard guide](https://github.com/tmux/tmux/wiki/Clipboard)

1. Mark the exact coordinator-created Codex and Cursor panes with a local tmux user option on Darwin. Reuse the target and option application paths in `TmuxController.launchAgent` and the existing-live-pane branch of `ensureSession`. This covers new, respawned and already-open panes in both issue and manual sessions. A pane-local marker follows the pane into a linked session and distinguishes an unrelated window also named `codex`.
2. Install one mouse policy on the running tmux server when a target pane is present. tmux shares its key tables across sessions, so guard each changed binding using the marker on the pane under the mouse (`if-shell -F -t =`). For a marked pane, the root table's `MouseDrag1Pane` starts selection with `copy-mode -M -t =`, even when the application requests mouse events. In `copy-mode` and `copy-mode-vi`, route `MouseDragEnd1Pane` to `send-keys -t = -X copy-pipe-and-cancel /usr/bin/pbcopy`. That command pipes the selected bytes directly, keeps the tmux paste buffer and exits copy mode. Use tmux command arguments and the existing `TmuxRunner`. Keep selected text out of shell command strings.
3. For unmarked panes, delegate each of those three events to its previously installed action. Read the effective bindings with `list-keys`, including owner customizations, before installing a conditional wrapper. Preserve unbound behavior, command sequences and binding flags. Make the wrapper recognizable and installation idempotent per binding so reattach, concurrent starts and a retry after partial setup cannot wrap an existing wrapper again. Limit the installation to macOS. Keep the existing `sessionScrollOptions`, `windowScrollOptions`, `agentClientAttachCommand`, history limit, wheel bindings and Cursor scrollbar.
4. Document that a tmux drag copies on release. For a native ⌘C selection, Terminal's View → Allow Mouse Reporting toggle temporarily returns mouse handling to Terminal. The owner can turn reporting back on to scroll the pane. [Apple Terminal mouse reporting](https://support.apple.com/guide/terminal/turn-on-mouse-reporting-trmlc69728a5/mac)

## Tests

- Extend the existing start/ensure coverage in `test/tmux.test.ts` with the injected `TmuxRunner`, `commandsIn` and temporary launcher fixtures. Check that both target agents receive the pane marker through new and existing-pane paths, including resume of an open linked client. Retain the existing Claude, history, scrollbar and scoped-option assertions. Check that a non-Darwin controller and a roster containing only other agents skip clipboard setup.
- Add one isolated tmux regression in the same file, reusing `tmuxInstalled`, `runTmux`, a private socket and the existing cleanup pattern. Use a temporary file as the clipboard command's stdin sink so the test is deterministic and leaves the developer's clipboard alone. Exercise a drag from an idle pane and one which enables mouse reporting, across the emacs and vi tables. Assert that releasing the button writes the exact selected substring, exits copy mode and retains the tmux buffer. Repeat setup and verify that an unrelated pane with a distinctive custom drag action still runs it. The baseline leaves the sink empty.
- Run `pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts` during implementation. The configured product hook commands are `pnpm run check:fast` and `pnpm run test:e2e`. The coordinator owns the final `pnpm run check` at the approved pin.
- On a Mac with both CLIs, use fresh and resumed owner windows. Drag different substrings in Codex and Cursor, release, then paste each into TextEdit with ⌘V. Repeat from wheel-scrolled history, scroll back to the prompt, and check that plain clicking does not replace the last copy. Verify the documented native ⌘C gesture separately. Record which checks were observed.

## Alternatives Rejected

Turning mouse reporting off by default would discard the tmux wheel interaction requested in issue 204. A server-wide `copy-command` would affect unrelated sessions and still allow an application to consume the initial drag. Reading the latest tmux buffer after release could copy another pane's selection during concurrent use.

## Risks and Mitigations

The owner may have custom key tables or multi-command bindings. Touch only the named events in the standard tables, preserve their previous actions on unmarked panes and test with a custom binding. If an installed tmux cannot expose a binding reliably, leave it intact and report the native Terminal copy gesture. Clipboard setup failure should leave the owner able to attach and continue working. A platform clipboard cannot be verified by inspecting tmux options alone, so the acceptance check includes pasting into another application.

## Conclusion

A drag in either affected pane will copy the selected bytes on release, including text in scrollback. The acceptance criterion is the exact text appearing in another Mac application while the owner's existing scrolling gestures continue to work.
