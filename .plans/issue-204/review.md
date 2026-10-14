# Issue 204 plan review

Reviewed pins: claude `d821fa9ca5100663b76132c7d81da928ecc6ddf2`, codex `367d46951b2365419c6ced0fa72cdaaca32ff7ed`, cursor `595a8c11fb79af5cd76599262dbd7b88c6dd9fad`. All three stay inside the issue, reuse `launcher_command`, `inspectPane` / `owner-typing`, `journalDeferral`, and `renderIssueReport`, and add no product file. The failures below are what happens if each plan is implemented as written.

## Findings

### Claude `d821fa9ca5100663b76132c7d81da928ecc6ddf2`

Claim (Reuse and Scope, and Alternatives Rejected "Re-applying the session options on every ensureSession"): `history-limit 50000` is set only in the `has-session` miss branch, before `new-window`, because tmux supposedly reads it only when a pane is created. `mouse on` is appended only to `agentClientAttachCommand`. `pane-scrollbars` is added only inside `launchAgent`, so a live pane gets it on the next relaunch. Resume is not supposed to set the session options again.

Rule: the operator's already-open Terminal is a grouped client whose session options are independent of the base session, and resume opens clients with `onlyMissing`, so it will not re-run the attach command. `history-limit` and `mouse` have to be set on the sessions that are actually in use, including ones `ensureSession` finds already present. On tmux 3.7, `set-option -t <session> history-limit 50000` changes `#{history_limit}` on a pane that already exists; it is not limited to the next `new-window`. `mouse on` set on the base session does not show up on the linked client.

Failure: a resumed issue whose Terminals are already open keeps history at 2000, mouse off, and no pane scrollbar. The wheel still does nothing, and the agent panes do not keep the longer history, which is the bug the issue is fixing. New agent windows created later into that existing session also inherit 2000, because the repair path never sets the option.

Correction: on every `ensureSession`, set `history-limit 50000` and `mouse on` on the base session and on each linked client that already exists, and set `pane-scrollbars on` for live Claude and Cursor windows. Keep the same commands in the attach string for a client that is opening now.

### Claude `d821fa9ca5100663b76132c7d81da928ecc6ddf2`

Claim (`src/issueReport.ts` in the file list): status prints `[WAIT] the <agent> pane is scrolled back; scroll to the bottom to let coord send (last seen <scrolledBackNoticeAt>)` while `scrolledBackNoticeAt` is non-null and the cursor is `ordered`. That timestamp is cleared only in `deliver()`, when a nudge result is something other than `busy` / `owner-typing`.

Rule: the issue's sentence is the whole notice, and it describes a wait that is still going on because the pane is scrolled back. A paused `runTick` returns before delivery, so `deliver()` will not run again while the issue is paused.

Failure: status never shows the issue's sentence; it always appends a "last seen" timestamp. After the owner scrolls to the bottom, or pauses the issue, the notice stays until some later nudge returns a different result. While paused that nudge never happens, so status keeps telling the owner to scroll to the bottom to let coord send when coord is not sending.

Correction: store the notice only as current pane state, clear it when an inspection shows copy mode has ended, and print the issue sentence with no suffix.

### Codex `367d46951b2365419c6ced0fa72cdaaca32ff7ed`

Claim (Scoped tmux options, points 1 and 3): repair sets `history-limit` and `mouse` on `<coord-session>`. Mouse on a linked client is set inside `agentClientAttachCommand`, "every time a Terminal client opens." Scrollbars are applied to each agent window, "including Claude, Cursor, and inline Codex," and the tmux test is told to assert that every agent window gets them.

Rule: grouped clients do not inherit `mouse` from the base session, and resume does not re-run attach for a Terminal that is already open. `pane-scrollbars on` is the Claude and Cursor window option; Codex's change is `--no-alt-screen`, so the wheel scrolls history. Antigravity and Gemini are not given a scrollbar.

Failure: an already-open Claude, Cursor, or Codex Terminal stays mouse-off across resume, so the trackpad and wheel still do not scroll that client. The same plan also turns `pane-scrollbars on` for every agent window, which narrows and reflows Antigravity and Gemini even though the issue does not ask for that.

Correction: from `ensureSession`, set `mouse on` on each existing Claude, Cursor, and Codex client session, and set `pane-scrollbars` only on the Claude and Cursor windows.

### Cursor `595a8c11fb79af5cd76599262dbd7b88c6dd9fad`

Claim (Reuse and Scope item 5, and the `test/runLoop.test.ts` case): the first `owner-typing` row keeps today's unbucketed event id. A repeat is a second `nudge-deferred` row whose event id includes the 180000 ms bucket, and the log line is emitted only when `appendJournal` inserts that row. `safetyFixture`'s `tick` builds a new run loop each time. A tick that does not advance the clock must not log again.

Rule: a new process has no in-memory clock. `appendJournal` returns the previous event when the event id is already present and returns the new event when it inserts; the caller has to tell those apart. The silence interval is measured from the last announcement, including the first unbucketed one.

Failure: the first row's id contains no bucket. The next `tick` is a new run loop, does not see a row for the current bucket, and appends one immediately. The notice repeats on the next poll instead of after three minutes, and the plan's own no-advance assertion fails. After a real insert, a caller that logs on every `appendJournal` return also logs again on every later poll inside that same bucket, because a duplicate id still returns the stored event.

Correction: take the clock from the latest `owner-typing` journal `at`, bucketed or not, and insert the next row only when `now - at` is at least 180000 ms. Log only when the returned event's `at` is the timestamp just written.

### Cursor `595a8c11fb79af5cd76599262dbd7b88c6dd9fad`

Claim (Reuse and Scope item 6): `coord status`, interactive `s`, and the reports from `CoordinatorRunLoop.run` print the sentence for every live pane whose `inspectPane` result has `ownerTyping`, with no check that coord is waiting to send.

Rule: the sentence is the deferral "until the scrolling is back to the bottom" so coord can send. Copy mode while the agent is working is the owner reading the pane, not a delivery wait.

Failure: status tells the owner to scroll to the bottom to let coord send during an ordinary turn, whenever the pane happens to be in copy mode. That fights the reason the owner scrolled.

Correction: include an agent only when its current cursor is `ordered` (delivery not yet accepted) and the live pane is in copy mode. Keep the tmux failure path that omits the line.

## Conclusion

None of the three plans is safe to implement unchanged. Claude `d821fa9ca5100663b76132c7d81da928ecc6ddf2` never reapplies the tmux options on a session that already exists, and its status line is a stale paraphrase. Codex `367d46951b2365419c6ced0fa72cdaaca32ff7ed` repairs history and live-window scrollbars, but leaves mouse off on a Terminal that resume does not reopen, and it puts scrollbars on every agent. Cursor `595a8c11fb79af5cd76599262dbd7b88c6dd9fad` does reapply client mouse and limits scrollbars to Claude and Cursor, but the three-minute repeat fires on the next process and status shows the send-wait sentence when coord is not waiting to send.
