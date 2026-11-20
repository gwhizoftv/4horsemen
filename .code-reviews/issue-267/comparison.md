## Comparison

Recommend the Codex implementation as the base for revision. Its linked-client test exercises drag and release for Codex, Cursor, Claude, Antigravity, Muse, Gemini and OpenCode. One reproducible clipboard isolation defect needs a fix before approval.

| Candidate | Bound implementation |
| --- | --- |
| Antigravity | `e5c9a43f1b050d6e6e551c9b56d7b295f4a60378` |
| Claude | `ea9a12ba08a62bf179911997ce292ab7438de3c2` |
| Codex | `adfe985c7853c748ae1855268235cc6f8a045265` |

### Findings

1. **Antigravity `src/tmux.ts:574` and Claude `src/tmux.ts:582`.** An ordinary drag and release must deliver the selected text from every supported agent’s linked owner window. Both attach paths enable the clipboard integration only for Claude, Cursor and Codex. With stock settings, a linked Muse window has tmux mouse handling off and no clipboard marker. A native Terminal selection can still be copied with Command-C, but releasing the drag supplies no coordinator clipboard copy. Antigravity, Gemini and OpenCode take the same attach path. Antigravity’s test at `test/tmux.test.ts:1823` copies from the primary session for those four agents. Claude’s test at `test/tmux.test.ts:1767` explicitly expects the linked Muse selection to be absent from the sink.
2. **Antigravity `src/tmux.ts:549` and Claude `src/tmux.ts:557`.** The coordinator’s macOS clipboard integration must apply only to its managed agent windows. Both candidates mark the whole primary session. On both pins, copying the synthetic text `control selection` in its control window wrote those bytes to the clipboard sink. This happens with the window still focused.
3. **Codex `src/tmux.ts:1022`.** Clipboard eligibility must be determined by the window where the selection was made. The asynchronous copy command looks up the session’s current window after the copy starts. On the pinned controller, queueing a copy in Muse followed immediately by selecting control discarded the Muse text. Reversing the two windows wrote the control text to the sink. A regression test can issue `copy-pipe-and-cancel` and `select-window` in one tmux command list, wait for the copy job, and check the sink in both directions.

### Scope and verification

All three candidates limit product changes to `src/tmux.ts` and `test/tmux.test.ts`, reuse the controller’s startup and resume paths, and add no dependencies. Antigravity uses seven pane fixtures but duplicates the tmux process runner and bypasses mouse dispatch. Claude reuses `runTmux` and checks owner configuration and older-tmux fallback, but its clipboard fixture covers three agents and enters copy mode programmatically. Codex adds a window marker and adapts the stock drag binding for applications that capture mouse input. Its pseudo-terminal test drives actual mouse events through all seven linked fixtures, including a fresh Muse attach, and copies a line from wheel-scrolled Codex history.

For this review I exercised the three pinned controllers on isolated tmux 3.7b servers with synthetic text and a file as the clipboard sink. The probe covered a linked Muse client, a stationary control window and both immediate window switches. The issue journal records successful `check:fast` and `test:e2e` hooks for each submission. Codex’s first precommit attempt failed and its retry passed on the same staged tree. Live Terminal.app paste was outside this probe.
