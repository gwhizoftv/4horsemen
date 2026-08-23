# Agent readiness and delivery policy

The coordinator observes three independent facts. They deliberately do not
collapse into one `busy` flag:

| Layer | Source | Authority |
| --- | --- | --- |
| Typing safety | live tmux pane/process inspection | whether keys may be sent now |
| Lifecycle observability | vendor session, prompt, work, and Stop hooks | whether a second delivery is authorized |
| Workflow truth | `complete`, its Git SHA, and evidence verification | whether the workflow advances |

## Precedence

Pane inspection is a veto, never a duplicate-send authorization. A dead pane,
copy mode/owner typing, disabled input, foreground-process mismatch, trust UI,
account-verification overlay, real in-flight chrome, or missing required vendor
prompt prevents `send-keys`. An idle hook does not override those checks.

Hooks are the duplicate-suppression authority after the first successful send.
Pending input, background activity, an older turn, or a previously consumed idle
epoch keeps the action waiting even when the pane looks ready. An action that is
still only `ordered` may be retried after a transient pane refusal because no
successful paste has occurred yet.

`complete` plus accepted evidence is workflow truth. When it proves that an
action completed, the coordinator closes that lifecycle action and clears a
degraded correlation warning for it. A new action can degrade independently.

The only lost-injection recovery after a successful paste still requires
positive pane proof: no hook correlated a turn, there is no pending/background
work, and a fresh ready capture does not contain the exact action UUID. Neither
elapsed time nor a missing `complete` file authorizes a duplicate by itself.

## Reason codes

Pane gate codes are `pane-dead`, `owner-typing`, `input-off`, and
`foreground-mismatch`. Prompt codes are `trust-dialog`, `claude-no-prompt`,
`cursor-turn-chrome`, `antigravity-turn-chrome`,
`antigravity-verify-overlay`, and `antigravity-no-prompt`. Lifecycle wait codes
are `unmatched-action`, `workflow-complete`, `pending-input`,
`background-active`, `unknown`, `queued`, `working`, and
`idle-transition-already-used`.

The journal records refusals as `nudge-deferred` with separate `layer`, `code`,
and `stage` fields, a bounded human rationale, and the current lifecycle
snapshot. Captured pane text is never journaled. When hooks say healthy/idle but
the pane vetoes typing, the same record has `splitBrain: true` so both sides of
the disagreement are queryable together.

The observability watchdog means that no hook correlated with the latest
delivery inside its window. `hooks-never-seen` is the case where the runtime has
never observed a session/hook and may warrant restarting the CLI;
`correlation-lagged` means hooks have existed but this delivery has not yet been
correlated and does not, by itself, justify a restart.

## Positive idle hint

Installed agent protocol asks a finished agent to end with:

```text
COORD-IDLE: waiting for the next coordinator action file
```

This sentinel is additive. Existing vendor prompts remain valid, live activity
and verification blockers are evaluated first, and recovery still requires the
action-UUID absence proof above.
