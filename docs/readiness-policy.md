# Readiness policy — scrape, hooks, and workflow truth

Three signals tell the coordinator about an agent. They can disagree. This file
says which one wins for which question, and names every reason code a refusal
can carry.

| Layer | Mechanism | Authority for |
| --- | --- | --- |
| Delivery readiness | tmux pane scrape (`harnessLooksReady`, `harnessPromptReadiness`) | whether it is safe to type into the pane |
| Observability | vendor lifecycle hooks (`SessionStart`, prompt-submit, `Stop`) | whether a second send would be a duplicate |
| Workflow truth | the `complete` file plus Git pin **or** accepted response + published batch | whether the work actually happened |

## The three rules

**Scrape is a veto, never an authorization.** A pane that looks busy always
blocks typing, whatever the hooks say. Keystrokes sent into a running turn are
appended to that turn's input or cancel it, so a false stall is recoverable and
a false send is not. Hooks reporting `execution: "idle"` never override a
blocking scrape.

**Hooks authorize duplicates, and only duplicates.** Before the first successful
send there is nothing to duplicate: an action still at `delivery: "ordered"`
may be retried whenever the scrape becomes ready. After a send succeeds, another
send needs `decideLifecycleNudge` to return `send`, or the lost-delivery
recovery below.

**Workflow truth outranks both.** For Git-mode actions, `complete` plus a
pushed commit proves the action arrived. For ballot response-mode actions,
workflow truth is the completion marker (`response <actionId>`) plus an
accepted private response, and the gate advances only after the coordinator
publishes that roster's evidence batch. Quiet work continues through normal
completion validation. Completing an action also clears a legacy degraded alert
already raised against it by an older coordinator.

## Positive evidence is additive

Agents print `COORD-IDLE: waiting for the next coordinator action file` when
they finish an action and find no new one. It can confirm a pane that no vendor
pattern matched; it can never clear a blocker. Every blocking check runs first,
and the sentinel counts only when it appears *after* the current action id in
the captured buffer — the 40-line capture keeps the sentinel from the previous
action on screen long after it stopped being true.

Codex renders the sentinel as an assistant item (`• COORD-IDLE: …`) above its
composer and footer, so it counts there only when everything below it is the
single `›` composer — empty or holding just Codex's dimmed placeholder, never an
unsent draft — and known footer lines (`? for shortcuts`, `Context N% left`).
Any other line fails closed.

**One exception: a stale `working` record before the first send.** A Stop event
that never reaches this issue leaves lifecycle at `working`, which would block
the next action forever. While an action has never been sent (no send charged,
`delivery: "ordered"`, no injection), a current sentinel that passes every veto
may overrule that `working` record, and only that one. The same never-sent gate
also accepts a mailbox `ready <actionId>` file beside `complete` when the marker
names the issue's last accepted action, its mtime is strictly after the latest
hook receipt or lifecycle event, and every scrape veto still passes — including
for Codex, where composer/vim/submit checks run without requiring a visible
COORD-IDLE line. The coordinator deletes the receipt after a successful send.
The pane is rechecked at every key, with the turn-chrome veto always applied:

- the lifecycle record must be unchanged, or the send stops with
  `lifecycle-changed`;
- until the nudge is typed, the composer must be empty, so Codex's vim `i`
  prelude is sent only from vim NORMAL;
- before every submit key, the composer must hold exactly this nudge, so an
  owner edit is never submitted with it;
- once a submit key is out, a correlated prompt hook for this action, or Codex
  showing exactly this nudge as the submitted message of a running turn with
  an empty composer again, ends the send without the remaining fallback submit
  keys. An unrelated turn with the nudge still in the composer is not proof.

A refusal before any key costs nothing; after a key, the existing
`delivery-uncertain` hold applies. The send is journalled with
`lifecycleOverride: "working"`, and stdout names the missing Stop. Lifecycle state is not rewritten; after that first send, a
`working` record blocks exactly as before.

## Lost delivery is retried only on positive proof

A send that was never accepted may be retried when, and only when,
`actionAbsentAtReadyPrompt` shows a live, ready prompt whose captured viewport
no longer contains the action id. Unknown or exhausted-idle delivery must first
pass the 45-second delivery wait; no degraded-health flag is required. Unknown
execution also requires no lifecycle event at or after injection, so a delayed
`SessionStart` cannot reopen delivery. Queue, background, turn-correlation and
send-budget checks still apply. Elapsed time or a missing `complete` never
authorize a retry on their own.

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
| `cursor-turn-chrome` | a turn is in flight |
| `antigravity-turn-chrome` | a turn is in flight |
| `antigravity-verify-overlay` | the account-verify overlay is up and discards keys |
| `antigravity-no-prompt` | splash or no prompt yet |
| `codex-turn-chrome` | Codex's `Working (… esc to interrupt)` status line is up |
| `no-idle-sentinel` | lifecycle reports `working` and neither a current sentinel nor a fresh mailbox `ready` receipt authorizes the override, or the composer no longer holds exactly the nudge |
| `lifecycle-changed` | lifecycle hooks reported new activity while an override send was being prepared |

In-flight status words (`Thinking`, `Working`, `Generating`, `Running`) match
only at the start of a line, after whitespace or a spinner glyph, and only with
a trailing ellipsis. Agents on this workflow write those words inside plans and
reviews; a quoted or bulleted line is prose and must not read as chrome.

Lifecycle wait (`NudgeWaitCode`): `unmatched-action`, `workflow-complete`,
`pending-input`, `background-active`, `unknown`, `queued`, `working`,
`idle-transition-already-used`.

## Quiet work is normal

Lifecycle hooks describe transitions, not a continuous heartbeat. An unfinished,
delivered action is presumed to continue until evidence says otherwise. Missing
hooks do not create degraded health, an `unobservable` hold, a restart warning or
permission to resend. This policy applies even when acceptance has not yet
correlated, and does not fabricate acceptance, execution state or completion.

Quota/resource evidence, vendor waits, harness loss and delivery uncertainty keep
their existing controls. An operator question or a wait for coordinator work must
not be inferred from silence. Inspecting the pane can veto delivery, but a failed
observation cannot establish progress. Observation exceptions emit a verbose
diagnostic and are retried at the bounded pane-check cadence.

Legacy degraded states remain readable. Already persisted `unobservable` holds
still require scoped owner recovery with `coord resume --issue N --hold HOLD_ID`;
this change neither migrates them nor releases other holds or manual pauses.

## Journalling

Every refusal appends a `nudge-deferred` event carrying `layer`, `code`,
`human`, `gateWaiting`, the hook snapshot, and `splitBrain: true` when the
scrape refused while hooks reported idle and healthy. Both sides of a
disagreement live on one event. `gateWaiting` is true while the action is out
and unanswered, which is what makes a deferral operator-relevant rather than
background detail; every delivery path in the run loop today defers only in that
state, so the field currently reads true wherever it appears, and it is recorded
so a consumer can tell the difference without re-deriving cursor state. The line
reaches normal stdout when `gateWaiting` holds or the layers disagree; an
unchanged code repeating on later ticks stays verbose.
Clearing a legacy degraded alert on workflow completion appends
`agent-observability-recovered`. The run loop no longer emits
`agent-observability-degraded` merely because lifecycle events are missing.
