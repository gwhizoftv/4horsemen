# Readiness policy — scrape, hooks, and workflow truth

Three signals tell the coordinator about an agent. They can disagree. This file
says which one wins for which question, and names every reason code a refusal
can carry.

| Layer | Mechanism | Authority for |
| --- | --- | --- |
| Delivery readiness | process/pane gates, vendor Stop, fallback pane inspection | whether the next prompt can be delivered |
| Observability | vendor lifecycle hooks (`SessionStart`, prompt-submit, `Stop`) | whether a second send would be a duplicate |
| Workflow truth | the `complete` file plus Git pin **or** accepted response + published batch | whether the work actually happened |

## The three rules

**A current Stop authorizes the next delivery.** Background work remains
telemetry and does not block the next prompt or action. A Stop from an old
session or a known older turn is not current. New foreground activity, queued
input, session replacement, or a new delivery revokes this readiness. No
Working-text, idle-sentinel, or empty-composer confirmation of Stop is required.
Process identity, pane liveness, copy mode, disabled input, trust/account dialogs,
vendor usage waits, manual pause, holds and send budgets still apply.

**A matching submit hook confirms acceptance.** `UserPromptSubmit` (Codex and
Claude) or `beforeSubmitPrompt` (Cursor) must match the current action UUID,
digest, and session. No subsequent pane evidence is needed. Matching hooks also
clear that attempt's delivery reservation and corresponding `delivery-uncertain`
hold, even after a restart or delayed receipt. Other holds, manual pause and
charged send counts remain intact. AGY retains its existing delivery and Stop
path without acquiring a prompt-submit-hook requirement.

A successful tmux write proves injection only. Codex, Claude and Cursor receive
one tmux command batch: literal prompt text followed by actual submit-key events.
The coordinator does not wait for the prompt to paint, poll the composer, or
press fallback submit keys. Codex uses Enter, including old configurations with
`["C-j", "C-m"]` or `["C-m"]`. AGY keeps its separate literal-text/Enter delivery
and existing delays. Without Stop evidence, pane readiness remains the fallback.
After an injection, a repeat requires a new eligible idle transition or the
lost-delivery proof below; a delayed hook alone never authorizes a duplicate.

**Workflow truth outranks both.** For Git-mode actions, `complete` plus a
pushed commit proves the action arrived. For ballot response-mode actions,
workflow truth is the completion marker (`response <actionId>`) plus an
accepted private response, and the gate advances only after the coordinator
publishes that roster's evidence batch. Quiet work continues through normal
completion validation. Completing an action also clears a legacy degraded alert
already raised against it by an older coordinator.

## Positive evidence is additive

After completing an action and rereading the order, agents write
`ready <completed-actionId>` in the `ready` file beside `complete` if the order
is unchanged **or missing**. Acceptance removes the order while peers may still
be working, so a missing file must not lose this handshake. A changed action is
executed immediately instead. Other read errors do not authorize a receipt.
The agent then prints the idle line and ends its turn.

The receipt is a delivery hint, not workflow completion. Its UUID must match
the agent cursor's durable last accepted action (Git, private response, or an
accepted amendment request), and differ from the next action being delivered.
An unanswered peer order retired by an amendment is not an accepted action.
The amendment request's action UUID must equal the current order's UUID;
validation rejects a different UUID before advancing the accepted identity.
Acceptance and preparation leave the receipt in place. Only a successful send
consumes the observed receipt; a replacement file is preserved. The existing
mailbox directory grant covers this sibling without new permissions.

File proof is eligible only before the next action's first charged send, with
no pending input or delivery reservation. Background work blocks file-only
proof unless a current Stop already authorizes delivery. Its mtime must be
strictly newer than the last activity-hook receipt and not in the future;
millisecond timestamp ties fail closed. A separate per-agent hook receipt
timestamp/sequence includes duplicate activity callbacks, unlike semantic
`lastEventAt`. The sequence and file identity are rechecked before the batch (and each AGY key).
Status-bar telemetry is deliberately excluded: an idle status render is not
new activity, and must not invalidate the ready file just written. Identical
Antigravity status observations explicitly reporting idle, no pending input,
and no background work also retain semantic deduplication: they neither
rewrite lifecycle state nor count as a heartbeat after a new order. This
prevents a harmless redraw between paste and submit from interrupting delivery.
Do not exclude all status observations: repeated working/unknown reports,
queue/background activity, session changes and other semantic changes still
revoke readiness. Neither receipt field fabricates execution or an idle epoch.

A valid file can overrule stale `working` or `unknown` for that first send
without needing the idle line visible in the pane. It never bypasses process,
dialog, live-turn, owner-input, pause/hold, authority or send-budget checks.
For file-only Codex proof, the composer must be empty before the batch; the
coordinator never waits for the pasted message to become visible. Changed proof
before delivery defers for free. An ambiguous transport failure after reservation
retains its durable charge and creates a delivery-uncertain hold, which a matching
submit hook can resolve. Legacy lifecycle files default to no Stop receipt.

Startup `foreground-mismatch (bash)` is a separate, intentional refusal before
terminal text is considered: the launcher may not yet have handed control to
the harness. If it persists, the harness may have failed or exited. Neither
an idle line nor a ready file permits typing into that shell. A pre-send
refusal preserves readiness so delivery can proceed once the harness is ready.

Agents print `COORD-IDLE: waiting for the next coordinator action file` when
they finish an action and find no new one. It can confirm a pane that no vendor
pattern matched; it can never clear a blocker. Every blocking check runs first,
and the sentinel counts only when it appears *after* the current action id in
the captured buffer — the 40-line capture keeps the sentinel from the previous
action on screen long after it stopped being true.

Codex renders the sentinel as an assistant item (`• COORD-IDLE: …`) above its
composer and footer, so it counts there only when everything below it is at
most one end-of-turn summary line (`Worked for 5m 21s • 5:42 AM`), the single
`›` composer — empty or holding just Codex's dimmed placeholder, never an
unsent draft — and known footer lines (`? for shortcuts` or
`← for agents · ? for shortcuts`, `Context N% left`). Any other line fails
closed. The file-backed path applies the same composer and footer rules
without requiring the sentinel.

**Legacy terminal proof: a stale `working` record before the first send.** A Stop event
that never reaches this issue leaves lifecycle at `working`, which would block
the next action forever. While an action has never been sent (no send charged,
`delivery: "ordered"`, no injection), a current sentinel that passes every veto
may overrule that `working` record, and only that one. Lifecycle and pane proof
are rechecked immediately before the batch; AGY retains its per-key checks.
Codex must show an empty composer, and its vim `i` prelude is sent only from
NORMAL. A refusal before any key costs nothing. The send is journalled with
`lifecycleOverride: "working"`, and stdout names the missing Stop. Lifecycle
state is not rewritten; after that first send, `working` blocks another send.

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
| `no-idle-sentinel` | lifecycle reports `working` and the pane shows no current sentinel to overrule it, or its pre-send composer is not empty |
| `codex-composer-not-ready` | file-backed readiness cannot prove an empty Codex composer before the batch |
| `pane-capture-unavailable` | file-backed readiness cannot check pane vetoes because the capture failed or was empty |
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
File-backed sends record `readiness: "ready-file"` and the prior execution in
`lifecycleOverride`; their diagnostic does not claim a sentinel was visible.

Stop-authorized sends record `readiness: "stop-hook"`. A late submission hook
that resolves uncertainty records an automatic `hold-released` event with
`reason: "prompt-submitted"`.
