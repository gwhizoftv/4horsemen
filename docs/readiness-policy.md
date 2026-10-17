# Readiness policy — ready file, keystroke safety, and workflow truth

The coordinator sends an agent its next action when the agent says it is ready.
Hook execution state never decides delivery. This file names the authorizations,
the keystroke-safety checks that guard every send, the stall watchdog, and the
refusal codes. Explicit owner reminders follow the separate contract below.

| Layer | Mechanism | Authority for |
| --- | --- | --- |
| Delivery authority | the `ready` file, JOIN, a fresh session, a hold release | whether the next action may be sent |
| Keystroke safety | pane gate and vendor prompt checks | whether typed keys land safely now |
| Stall watchdog | transcript growth, tool hooks, pane repaint | whether owed work needs one resend |
| Workflow truth | the `complete` file plus Git pin **or** accepted response + published batch | whether the work actually happened |

## Explicit owner reminders

The interactive `n` command lists every configured agent and sends each selected
owner reminder on the next poll, even during a manual pause or hold. An agent
that owes work (an ordered action whose `complete` is missing) is resent its
current action with the resend prefix below. An agent that owes nothing is sent
nothing; the run loop logs that and journals `nudge-deferred` with
`code: "no-owed-action"`. Owner sends bypass automatic prompt, composer,
foreground, spacing, budget and reservation gates. Copy mode is cancelled before
typing; capture is optional and used only to choose vim keys. Configured
pull-only delivery does not prevent an explicit owner send.

Every selection has a unique request ID and a journal outcome: `nudged` for
successful terminal injection and `nudge-deferred` for failures, uncertainty or
a skipped agent. A concurrent assignment/submission change is reported as failed
before typing, or uncertain between keys. A change noticed after the complete
submit succeeds does not undo terminal delivery. Owner sends do not spend or
reset automatic send credit, clear reservations, release holds or remove
submitted files, and automatic delivery adds no send to the same agent in that
poll.

## Sending on ready

After completing an action and rereading the order, agents write
`ready <completed-actionId>` in the `ready` file beside `complete` if the order
is unchanged **or missing**. A changed action is executed immediately instead,
and no ready file is written.

Every poll, for every active agent, the coordinator reads that file and deletes
it. A receipt naming the agent's current action or its last accepted action is
recorded in the agent's lifecycle entry as `ready`. A receipt naming the last
accepted action once the current action was already sent predates that send and
is ignored, as is any other UUID. The journal records `ready-consumed` or
`ready-ignored`.

An agent owes work while its cursor is ordered, `complete` is missing and
`action.md` exists. An unsent current action (UUID and digest) is sent when any
one of these holds:

- the agent is recorded `ready`;
- **JOIN**: the agent has never had an action accepted in this issue;
- a **fresh session**: `SessionStart` (or Antigravity's status payload)
  established a new session ID and no prompt has been submitted since;
- a **hold release**: the action was last sent under an older hold generation.

Whichever of the receipt or the order arrives second triggers the send. A
successful send clears `ready` and the fresh-session flag, so each send is
authorized exactly once. No Stop, turn ID, idle epoch, execution state, idle
sentinel or hook-versus-file timestamp takes part.

The reread protocol is compatible with this. If the reread finds a newer action
B, the agent executes it and writes no ready file, so B is never sent. If B is
published after the agent wrote ready, the agent never saw B, so it is sent.

A reissue under the same action UUID has a new digest and is therefore unsent;
the agent is idle and waiting, so its ready receipt authorizes the send.

## Keystroke safety

Every automatic send passes these checks, re-read before each key batch:

- the pane gate: pane alive, not in copy mode (`owner-typing`), input enabled,
  and the harness in the foreground;
- the vendor prompt checks: trust dialogs, Claude usage-limit screens,
  Antigravity's verify overlay, a visible prompt after startup, and live turn
  chrome where an Escape-bearing submit would cancel the turn;
- vim/INSERT prelude selection, and for Codex an empty composer (an owner draft
  would be submitted with the prompt).

A refusal before any key costs nothing and is retried on a later poll. A
transport failure after reservation keeps its durable charge and creates a
`delivery-uncertain` hold. The 60/120/240-second repeat spacing and the
four-send budget remain as a backstop.

Codex, Claude and Cursor receive one tmux command batch: literal prompt text
followed by actual submit-key events, with blocking `run-shell` sleeps of 300 ms
after the text and 150 ms between submit keys. AGY keeps its separate
literal-text/Enter delivery and delays.

## Acknowledgment is display-only

`UserPromptSubmit` (Codex and Claude) or `beforeSubmitPrompt` (Cursor) matching
the current action UUID and digest marks the action acknowledged for the status
report, and resolves that attempt's `delivery-uncertain` hold. It never gates or
triggers a send. There is no acknowledgment timer.

## Stall watchdog

Once a minute, for each agent that owes work, the coordinator fingerprints:

1. the Claude or Codex session transcript's modification time and size;
2. the tool-hook sequence (`PreToolUse`/`PostToolUse` for Claude and Codex,
   `postToolUse`/`postToolUseFailure` for Cursor, invocation hooks for AGY);
3. a digest of the pane above its last composer line, so the owner's draft and
   the footer are ignored while spinners and timers count.

The agent is quiet when the fingerprint is unchanged since the previous check
and no tool call is open (a `PreToolUse` without its end). Hook or journal
silence alone never counts as quiet. On the first quiet check the current action
is resent once through the same keystroke-safety checks; if the composer still
holds this action's unsent prompt, only the submit keys are sent. Still quiet
after that, one `[WAIT]` line names the agent, the action and how long it has
been quiet, and `nudge-deferred` is journaled with `code: "stalled"`. There is
no further resend. Both outcomes are durable for that action and digest.

Resends (watchdog and owner) begin with `If you already wrote complete for this
action, only write its ready file.`, so a resend that crosses a just-finished
turn cannot redo the work.

## Workflow truth outranks everything

For Git-mode actions, `complete` plus a pushed commit proves the action arrived.
For ballot response-mode actions, workflow truth is the completion marker
(`response <actionId>`) plus an accepted private response, and the gate advances
only after the coordinator publishes that roster's evidence batch. Completing an
action also clears a legacy degraded alert already raised against it.

## Reason codes

Every refusal carries one of these, plus a `stage` saying where in the attempt
it happened (`gate`, `prompt`, `antigravity-recapture`, `mid-send`).

Pane gate (`GateReason`):

| Code | What was observed |
| --- | --- |
| `pane-dead` | the pane is gone |
| `owner-typing` | the pane is in copy mode, or the owner is typing |
| `input-off` | the pane has input disabled |
| `foreground-mismatch` | the foreground process is not the agent's harness (`detail` names it) |

Prompt readiness (`PromptBlockedReason`):

| Code | What was observed |
| --- | --- |
| `trust-dialog` | the harness is on its trust-this-folder prompt |
| `claude-no-prompt` | no idle prompt is visible |
| `claude-usage-wait` | Claude is waiting for a usage limit |
| `cursor-turn-chrome` | a turn is in flight |
| `antigravity-turn-chrome` | a turn is in flight |
| `antigravity-verify-overlay` | the account-verify overlay is up and discards keys |
| `antigravity-no-prompt` | splash or no prompt yet |
| `codex-turn-chrome` | Codex's `Working (… esc to interrupt)` status line is up |
| `codex-composer-not-ready` | the Codex composer holds a draft that is not this action's message |
| `muse-turn-chrome` | Muse's `(… esc to interrupt)` status line is up; Enter would steer that turn |
| `muse-no-prompt` | no Muse composer, or an unknown screen (splash, menu, dialog) |
| `muse-composer-not-ready` | the Muse composer holds text other than this action's complete current prompt |

In-flight status words (`Thinking`, `Working`, `Generating`, `Running`) match
only at the start of a line, after whitespace or a spinner glyph, and only with
a trailing ellipsis or timer. A quoted or bulleted line is prose and must not
read as chrome.

## Journalling

Every automatic readiness refusal appends a `nudge-deferred` event carrying
`layer`, `code`, `human`, `gateWaiting` and the hook health. `gateWaiting` is
true while the action is out and unanswered; the line reaches normal stdout only
then, and an unchanged code repeating on later ticks stays verbose. Sends record
`nudged` with the reason (`initial`, `idle`, `reissue` or `resend`) and, for a
ready-authorized send, `readyFor`. A late submission hook that resolves
uncertainty records an automatic `hold-released` event with
`reason: "prompt-submitted"`.

## Issue 177 incident evidence (issue 195)

The retained issue-177 journal separates idle observation, terminal injection and
workflow completion. These are its UTC timestamps on 2026-10-11 and journal
`sequence` values:

| Time | Sequence | Recorded event |
| --- | --- | --- |
| 00:21:06.554 | 2707 | Cursor implementation submission validated |
| 00:21:31.431 | 2737 | Cursor Stop recorded as idle |
| 00:28:18.076–00:35:21.813 | 2900, 2954, 2987, 2995 | Four comparison sends without a matching prompt-submit acknowledgement |
| 00:36:06.447 | 2999–3000 | Automatic budget exhausted; hold `01edf7dd-e0b8-46d0-88b4-963dc4751100` paused the issue |
| 16:12:03.734 | 3003–3004 | Owner released that hold and reset the automatic allowance |
| 16:12:06.114, 16:13:07.161 | 3006, 3009 | Automatic sends resumed |
| 16:13:28.235 | 3010 | Prompt-submit callback reported working |
| 16:19:01.110, 16:19:01.292 | 3121, 3123 | Comparison ballot delivered and acknowledged |
| 16:19:17.186 | 3145 | Ballot validation failed: private response file missing |
| 16:19:27.034 | 3158 | Cursor Stop recorded as idle |
| 16:20:02.415, 16:20:03.561 | 3180, 3181 | Corrected ballot action sent, then automatic idle observation reported already used |
| 16:22:52.519, 16:23:51.203 | 3182, 3195 | Next prompt-submit callback, then valid ballot accepted |

The overnight wait was the approximately 15-hour-36-minute hold, even though
Cursor's idle transition had been recognized. The old owner path shared automatic
readiness and the 60/120/240-second repeat delays, so the operator could not use
`n` as an independent recovery action. Injection consumes an idle observation;
`idle-transition-already-used` describes that automatic duplicate guard, not a
claim that the agent is working. The status explanation now says so and points to
`n` for owner delivery.

The old journal did not record the owner's request timestamp or the exact early
return behind its combined “readiness, send spacing or a hold” message. Nor does
it retain the historical pane captures showing why Cursor failed to acknowledge
the sends. Spacing and a same-action UUID remaining in scrollback are possible
explanations for particular waits, not established terminal observations. The new
owner outcome records provide specific causes without changing automatic
lost-delivery proof or equating an idle line with a valid submission.
