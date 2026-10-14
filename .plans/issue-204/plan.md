# Issue 204 — scroll agent panes with the mouse

Operator request: trackpad, wheel, and scrollbar scrolling in coord's agent panes, a 50000-line history, Codex on the normal screen, and a repeated "scrolled back" notice in the log and in `coord status`.

tmux 3.7 on this machine scopes the options as follows: `history-limit` and `mouse` are session options; `pane-scrollbars` is a window option. Grouped sessions keep independent session options, so a value set on `coord-N` does not apply to the linked client `coord-N-<agent>`. No option may be set with `-g`.

## Exact File List to be changed or deleted

- `src/tmux.ts`
- `scripts/lib/launcher.sh`
- `src/runLoop.ts`
- `src/issueReport.ts`
- `src/cli.ts`
- `src/interactive.ts`
- `docs/readiness-policy.md`
- `docs/coord-driver.md`
- `test/tmux.test.ts`
- `test/runLoop.test.ts`
- `test/install.test.ts`
- `test/issueReport.test.ts`
- `test/interactive.test.ts`

## Exact file list to be created

None. Session options, the Codex flag, the deferral sentence, and the status line all extend functions that already own those behaviors.

## Reuse and Scope

Reuse these existing pieces:

- `agentClientAttachCommand`, `TmuxController.startSession`, `TmuxController.ensureSession`, and `launchAgent` in `src/tmux.ts`. They already target one coord session or one linked client and already set `destroy-unattached` and `remain-on-exit` without `-g`.
- `inspectPane`, which already reads `pane_in_mode` into `PaneState.ownerTyping`. Copy mode remains the signal that the viewport is scrolled back. Do not add a `GateReason`.
- `journalDeferral` and `DEFERRAL_RATIONALE` in `src/runLoop.ts`. The refusal code stays `owner-typing`. `appendJournal` already ignores a repeated `eventId`, which is how a later process can tell whether this three-minute bucket was already announced.
- `renderIssueReport` in `src/issueReport.ts`, including the three `CoordinatorRunLoop.run` call sites and the `coord status` / interactive `s` call sites in `src/cli.ts`.
- `launcher_command()` in `scripts/lib/launcher.sh`. Install and the post-merge hook both read this function; there is no second Codex command to edit. The issue text points at line 41; the `codex)` arm's `exec` printf is the line that launches Codex (the printf that already passes `--no-daemon`).
- Existing tests: the attach-command and `ensureSession` cases in `test/tmux.test.ts`, the `safetyFixture` delivery cases in `test/runLoop.test.ts` (`f.ui.busy`, `f.advance`, `f.messages`, `f.tick`), the exact Codex argv in `test/install.test.ts`, `renderIssueReport` cases in `test/issueReport.test.ts`, and the `s` key case in `test/interactive.test.ts`.

Behavior to implement:

1. Owning session (`startSession` and every `ensureSession`, including an already-existing session and a manual session). After the session exists, run `set-option -t <session>` (never `-g`) for `history-limit 50000` and `mouse on`. On every Claude window and every Cursor window, including a pane that is already alive, run `set-option -w -t <session>:<agent> pane-scrollbars on`. `ensureSession` today returns early for a live pane; that path must still apply these options, because resume uses `onlyMissing` and will not re-run the attach command for a Terminal that is already open.
2. Linked client, when the client session already exists during `ensureSession`, and again inside `agentClientAttachCommand` so a newly opened client is correct immediately. On every client session: `history-limit 50000`. On Claude, Cursor, and Codex client sessions: `mouse on`. On Claude and Cursor windows: `pane-scrollbars on`. Antigravity and Gemini clients get history only. A missing client session is not an error.
3. No `bind-key` and no wheel binding. With `mouse on`, tmux already scrolls pane history from the wheel and trackpad.
4. Codex `exec` gains `--no-alt-screen` before the mailbox-grant expansion, beside the existing long flags. Its output then stays in tmux scrollback so the wheel moves through history the way it does for Claude and Cursor. Do not set `pane-scrollbars` on the Codex window.
5. Replace the `owner-typing` sentence with `the <agent> pane is scrolled back; scroll to the bottom to let coord send`. The first observation still journals one `nudge-deferred` row under the current event id, still records `owner-typing` once in `actionSafety.deferrals`, and still logs the `[WAIT]` line. While that refusal keeps being observed, repeat the same operator sentence every 180000 ms. Persist the repeat as another `nudge-deferred` journal row whose `eventId` includes that time bucket, and log only when `appendJournal` inserts that row. Do not write `cursors.json` for a repeat. Other refusal codes stay once, including across restarts. Do not cancel copy mode on the automatic path; `remind` may keep its existing `-X cancel`.
6. `renderIssueReport` takes an optional list of agent ids that are scrolled back and prints one exact sentence per id before the active-step footer. An empty list leaves the report unchanged. `coord status`, the interactive `s` snapshot, and the three reports printed from `CoordinatorRunLoop.run` pass ids for which `inspectPane` reports a live pane with `ownerTyping`. A tmux failure or a missing session omits the lines and does not fail status. `InteractiveCommands.status` may return `string | Promise<string>`, and the `s` handler awaits it, so the live inspect finishes before the snapshot is printed.

## Tests

Focused cases join existing files. Each fails on the current tree and passes after the change.

- `test/tmux.test.ts`: the Claude attach command contains `history-limit 50000`, `mouse on`, and `pane-scrollbars on`, each with an explicit `-t` and none with `-g`. The Codex attach command contains `history-limit` and `mouse` and does not contain `pane-scrollbars`. An Antigravity attach command contains `history-limit` and does not contain `mouse` or `pane-scrollbars`. `startSession` / `ensureSession` record the same owning-session options, set `pane-scrollbars` on a Claude window that is already alive, and set `mouse` on a Codex client session that already exists. A missing client session does not fail `ensureSession`.
- `test/runLoop.test.ts`: with `safetyFixture` and `ui.busy`, the first tick journals one `owner-typing` row and logs `the codex pane is scrolled back; scroll to the bottom to let coord send`. Another tick with no clock advance does not add a journal row or a log line. `advance(180000)` plus a tick adds one bucketed journal row and one more log line, and `actionSafety` still lists `owner-typing` once. The existing A/B/A dedup case and the minute-boundary cursor-bytes case stay as they are.
- `test/install.test.ts`: the Codex argv expectation includes `--no-alt-screen` and still excludes `danger-full-access`.
- `test/issueReport.test.ts`: a scrolled-back id renders the exact sentence; an empty list does not.
- `test/interactive.test.ts`: a `status` implementation that returns a promise is awaited, and `s` prints that text.

While developing, run:

```sh
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/runLoop.test.ts test/install.test.ts test/issueReport.test.ts test/interactive.test.ts
```

The product commit is source plus docs, so the clone hook runs the declared precommit `pnpm check:fast` (lint, typecheck, `test:fast`, and `test:system`). Do not bump the package version. The coordinator owns the final suites at the approved pin.

## Alternatives Rejected

- `set -g` for `mouse`, `history-limit`, or `pane-scrollbars`. That changes every other tmux session on this server. The issue forbids it.
- A custom `WheelUpPane` binding. `mouse on` already scrolls history, and the issue says not to add one.
- A new gate code beside `owner-typing`. `pane_in_mode` is already the scrolled-back observation. A second code would refuse the same pane twice and split the journal consumers that match `owner-typing`.
- Repeating by writing `cursors.json`, or by logging on every fresh process with no stored time. Ticks in `safetyFixture` construct a new run loop on purpose, and the minute-boundary test forbids advisory cursor writes. A journal event id that includes the three-minute bucket is the existing exact-once mechanism.
- Cancelling copy mode so coord can type while the owner is reading history. That jumps the viewport to the bottom. Only the owner's own reminder keeps the current cancel.
- `pane-scrollbars` on Codex, Antigravity, or Gemini. Codex's missing piece is the alt screen. The scrollbar option is the one the issue names for Claude and Cursor.
- Mouse only on the owning session. The Terminal the operator looks at is the linked client, and its session options are independent.

## Risks and Mitigations

- History already discarded under the default 2000 lines is not restored. The new limit applies to output after the option is set. Set it on the owning session, where the panes live, and on each client session, because grouped sessions do not share session options.
- An already-open Terminal is not relaunched on resume. `ensureSession` applies owning-session options, Claude/Cursor window scrollbars, and existing client-session options on every pass, so those windows pick up the change without a new attach. A client created before this build still needs that ensure pass, which resume already runs.
- `mouse on` on the owning session also covers a direct attach to `coord-N`, including an Antigravity window viewed that way. The Antigravity Terminal client itself stays mouse-off. If that direct-attach path fights Antigravity's own mouse handling, the follow-up is to drop `mouse` from the owning session and keep it only on the Claude, Cursor, and Codex clients.
- `pane-scrollbars on` narrows the pane and reflows text. That is the value the issue asks for (`on`, not `modal`).
- Generated `start-codex.sh` files keep their old command until `coord install` or the post-merge rewrite runs. The flag lives in `launcher_command()`, which both of those already call.
- `coord status` must stay usable when tmux is down. Inspection failures produce no scroll lines and a zero exit, which is what the current status test already depends on.

## Conclusion

Coord's own sessions and linked clients get a 50000-line history and mouse scrolling without a global tmux option or a custom wheel binding. Claude and Cursor windows show pane scrollbars. Codex launches with `--no-alt-screen` so its wheel scrolls the same history. While a pane stays in copy mode, coord keeps the existing `owner-typing` refusal, tells the operator to scroll that agent to the bottom, repeats the sentence every three minutes, and shows it in `coord status`.
