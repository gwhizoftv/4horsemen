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

**Scrape always vetoes unsafe typing; it never authorizes a duplicate.** A pane that looks busy always
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
pattern matched; it never clears a pane veto. Every blocking pane check runs first,
and the sentinel counts only when it appears *after* the current action id in
the captured buffer — the 40-line capture keeps the sentinel from the previous
action on screen long after it stopped being true.

For Codex only, a stale lifecycle `working` record may be overruled before an
exactly matching action's first send: it must still be `ordered`, never injected
or accepted, unfinished, with zero reserved or completed send attempts and no
pending input or background work. The recovery requires a current idle sentinel
and the observed empty Codex composer (`›` or `› Ask Codex to do anything`). The
sentinel may have Codex's leading `•`; only recognized shortcut/context/Vim
footer lines may follow the composer. Draft text, unknown chrome and prompts
fail closed. Other agents keep their existing lifecycle gates.

Codex pane readiness and lifecycle evidence are checked again before every
key. During recovery, the composer may contain only the exact nudge this attempt
has typed (allowing terminal wrapping); the coordinator's own draft and send
reservation do not invalidate its idle proof. The vim `i` prelude is skipped
when the current footer already reports INSERT. New lifecycle evidence cancels the
attempt. If a submit key produces a correlated prompt acceptance, remaining
fallback keys are skipped. A refusal after any earlier key keeps the durable
reservation and creates a delivery-uncertain hold. No idle state or Stop event is
synthesized. Successful recovery journals `lifecycleOverride: "working"` and
names the missing Stop report and hook inspection in the operator log.

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
| `codex-turn-chrome` | Codex shows a live `Working (... esc to interrupt)` line |
| `no-idle-sentinel` | first-send recovery lacks a current sentinel and safe composer |
| `lifecycle-changed` | lifecycle evidence changed during delivery |
| `cursor-turn-chrome` | a turn is in flight |
| `antigravity-turn-chrome` | a turn is in flight |
| `antigravity-verify-overlay` | the account-verify overlay is up and discards keys |
| `antigravity-no-prompt` | splash or no prompt yet |

In-flight status words (`Thinking`, `Working`, `Generating`, `Running`) match
only at the start of a line, after whitespace or a spinner glyph, and only with
a trailing ellipsis or elapsed timer. Codex additionally recognizes its observed
`• Working (... esc to interrupt)` line among the last eight nonempty lines.
Agents write those words inside plans and reviews; quoted or backticked prose
does not match this live status shape.

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
