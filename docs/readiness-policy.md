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
publishes that roster's evidence batch. An action that reached workflow
completion is never marked degraded, and completing one clears a degraded alert
already raised against it.

## Positive evidence is additive

Agents print `COORD-IDLE: waiting for the next coordinator action file` when
they finish an action and find no new one. It can confirm a pane that no vendor
pattern matched; it can never clear a blocker. Every blocking check runs first,
and the sentinel counts only when it appears *after* the current action id in
the captured buffer — the 40-line capture keeps the sentinel from the previous
action on screen long after it stopped being true.

## Lost delivery is retried only on positive proof

A send that was never accepted may be retried when, and only when,
`actionAbsentAtReadyPrompt` shows a live, ready prompt whose captured viewport
no longer contains the action id. Elapsed time, a missing `complete`, or a
watchdog alert never authorize a retry on their own. Time only opens the door;
the absence proof walks through it.

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

In-flight status words (`Thinking`, `Working`, `Generating`, `Running`) match
only at the start of a line, after whitespace or a spinner glyph, and only with
a trailing ellipsis. Agents on this workflow write those words inside plans and
reviews; a quoted or bulleted line is prose and must not read as chrome.

Lifecycle wait (`NudgeWaitCode`): `unmatched-action`, `workflow-complete`,
`pending-input`, `background-active`, `unknown`, `queued`, `working`,
`idle-transition-already-used`.

## Degraded means correlation lag

`health: "degraded"` means no lifecycle event correlated with the last delivery
inside the watchdog window. That is `correlation-lagged`, the ordinary case when
an agent is still finishing a previous turn, and the operator is told to wait.
Only an agent that never announced a session at all (`lastEvent` and `sessionId`
both null) is `hooks-never-seen`, and only that case is told to restart the CLI
— restarting kills the in-flight turn that was about to write `complete`.

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
Clearing a degraded alert appends `agent-observability-recovered`.
