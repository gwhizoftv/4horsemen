## Comparison

Pins: Claude `f5b1085136ab54505b4c63a4aca8a7a96f4bee67`, Codex `ce71b24b540206d01c0c035d692bab85c846057d`, Cursor `b32cccf1d91eedf8f48cb834586070f06b25fe21`.

All three stay inside the issue. Each product diff is the approved launcher, tmux, state, report, run-loop, and existing test files. Plans, reviews, and participation signals are coordination files for this issue. None add a product file, a dependency, a global `set -g`, or a custom wheel binding. Each reuses `inspectPane`, `injectionGate`, `journalDeferral`, `renderIssueReport`, and the existing tmux, install, state, report, and run-loop tests. `test/install.test.ts` is the same on all three pins: Codex gets one `--no-alt-screen`, and the other harness argv is unchanged. Each sets `history-limit 50000` and `mouse on` on the base coord session before agent windows, repeats the scroll sentence from a cursor timestamp every 180000 ms without a second journal row, and does not start a wait from an observation alone.

Cursor is the implementation to keep. It applies history, mouse, and pane scrollbars to every agent window and to an already-open linked client, and it drops the scroll notice when the pane dies. Claude leaves that notice up after the pane dies. Codex never gives inline Codex or Antigravity a scrollbar, and it leaves the Antigravity Terminal's mouse off.

### Claude leaves the scroll notice up after the pane dies

`src/runLoop.ts` line 1494. A fresh inspection that finds the pane dead must clear `scrollbackWait` before the harness-gone hold, so status stops telling the operator to scroll. The dead branch returns the hold immediately. The clear on the next line runs only for a live pane. The hold pauses the issue, and later polls do not deliver, so nothing else removes the record. Status keeps `the <agent> pane is scrolled back; scroll to the bottom to let coord send` next to the dead-pane hold. Smallest test: with `safetyFixture`, set `ui.dead` after a scroll wait and tick once; `scrollbackWait` must be absent. Codex line 1490 and Cursor line 1486 already clear before that hold.

### Codex skips scrollbars on Codex and Antigravity

`src/tmux.ts` lines 458-460. Every agent window, including inline Codex, gets `pane-scrollbars on` with `-q` on create, respawn, and an already-live pane. `windowScrollOptions` returns that command only for `claude` and `cursor`. A Codex pane and an Antigravity pane never get a scrollbar, so the operator has no scrollbar there. Smallest test: `ensureSession` for codex and antigravity must include `set-option -w -q pane-scrollbars on` on the new, dead, and live paths. Claude and Cursor set that option for every agent window.

### Codex leaves mouse off on the Antigravity client

`src/tmux.ts` line 450, applied at line 1048 and in `agentClientAttachCommand`. Mouse and history must be set on the linked client the operator attaches, because a grouped client does not inherit session options from the base session. `mouseScrollingAgent` is false for Antigravity, so repair and attach set history on that client and leave mouse off. The wheel in that Terminal is not handled by tmux. Smallest test: the Antigravity attach command and an existing `coord-<issue>-antigravity` client both include `set-option -t <client> mouse on`. Claude and Cursor set mouse on every linked client.

### Cursor hides the sentence for a different accepted action

`src/issueReport.ts` line 243. Status shows the sentence for the current ordered action, and suppresses it only when that same action is accepted or workflow-complete. The check treats any lifecycle `delivery === "accepted"` or any `workflowCompleteAt` as enough, without comparing `action.actionId` to the ordered cursor. A scrolled replacement action stays invisible while an older lifecycle record is still accepted. Smallest test: ordered cursor and `scrollbackWait` for one action id, lifecycle `delivery: "accepted"` for another; the report must contain the sentence. Claude lines 162-163 and Codex lines 17-18 already require the ids to match.
