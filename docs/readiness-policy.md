# Readiness policy — scrape, hooks, and workflow truth

Issue #102 documents how three independent signals interact when the coordinator
decides whether to type into an agent pane.

| Layer | Mechanism | Authority for |
| --- | --- | --- |
| Delivery readiness | tmux pane scrape (`harnessLooksReady` / `harnessPromptReadiness`) | whether it is safe to type into the pane |
| Observability | vendor lifecycle hooks (`SessionStart`, prompt-submit, `Stop`) | duplicate-send suppression after a successful paste |
| Workflow truth | `complete` file plus the pushed commit SHA | whether the workflow advances |

## Precedence rules

1. **Scrape is a veto, never an authorization.** When the pane is busy, has input
   disabled, shows trust or verification UI, or displays in-flight turn chrome,
   the coordinator must not send keys — even if hooks report `idle`.
2. **Hooks are the duplicate-suppression authority.** After a successful tmux
   send (`delivery: injected`), further sends require a new eligible idle
   transition from lifecycle hooks (or the narrow lost-injection recovery below).
   A ready scrape alone must not authorize a second paste.
3. **Pre-injection retries use scrape only.** While delivery is still `ordered`
   with `retryableInjectionAt` set, retries are allowed when the pane becomes
   prompt-ready; hooks are not required for the first successful paste.
4. **`complete` is workflow truth.** When an agent writes `complete` and the
   gate accepts the submission, workflow completion clears a sticky degraded
   health alert and forbids a new degrade for the same action.

## Lost-delivery recovery

A lost first nudge may be retried only on **positive scrape proof**: a live,
prompt-ready pane whose capture does not contain the current action UUID, with
no pending input or background work. Elapsed time alone never authorizes retry.

## Reason codes

### Gate (`InjectionGateResult`)

| Code | Operator meaning |
| --- | --- |
| `pane-dead` | The tmux pane is dead |
| `owner-typing` | The operator is typing in the pane |
| `input-off` | Pane input is disabled (copy mode, etc.) |
| `foreground-mismatch` | Foreground process is not the harness |

### Prompt (`PromptBlockedReason`)

| Code | Operator meaning |
| --- | --- |
| `trust-dialog` | Trust-folder dialog is showing |
| `claude-no-prompt` | Claude idle prompt not visible |
| `cursor-turn-chrome` | Cursor in-flight turn chrome visible |
| `antigravity-turn-chrome` | Antigravity in-flight turn chrome visible |
| `antigravity-verify-overlay` | Antigravity account verification overlay |
| `antigravity-no-prompt` | Antigravity idle prompt not visible |

### Lifecycle wait (`WaitCode`)

| Code | Operator meaning |
| --- | --- |
| `idle-transition-already-used` | This idle epoch already authorized a nudge |
| `queued` | Lifecycle is queued (older turn, pending input, etc.) |
| `working` | Agent is working on the current turn |
| `pending-input` | Pending input is active |
| `background-active` | Background work is active |
| `unmatched-action` | Lifecycle action does not match the current order |
| `workflow-complete` | Workflow already completed for this action |

## Degraded observability

When no lifecycle hook correlates with the last nudge within the watchdog window,
health becomes `degraded` and duplicate sends are suppressed.

- **`hooks-never-seen`** — no `SessionStart` has ever arrived; restart the CLI
  so it loads coordinator lifecycle hooks.
- **`correlation-lagged`** — hooks are loaded but did not correlate with this
  send yet; the agent may still be finishing the previous turn.

## Agent idle sentinel

After writing `complete`, if `actionId` is unchanged, agents print:

`COORD-IDLE: waiting for the next coordinator action file`

This is positive readiness evidence only; it does not authorize a duplicate send.
