# Readiness and Nudge Policy

This document defines the precedence, readiness detection, and recovery policy governing agent delivery in the coordination driver.

## Signal Hierarchy and Authority

The coordinator evaluates three independent layers:

| Layer | Mechanism | Authority For |
| --- | --- | --- |
| Delivery readiness | Pane scrape (`harnessLooksReady` / `harnessPromptReadiness`) | Physical typing safety: whether it is safe to inject keystrokes into the pane |
| Observability | Vendor lifecycle hooks (`SessionStart`, prompt-submit, `Stop`) | Duplicate suppression: tracking state transitions (`accepted` → `working` → `idle`) |
| Workflow truth | Completion file (`complete`) and committed SHA | Advancing workflow gates and declaring deliverables accepted |

### Core Invariants

1. **Scrape is a physical safety veto, never an authorization to duplicate**:
   - `send-keys` is never issued when pane inspection indicates copy mode (`ownerTyping`), disabled input (`inputOff`), missing process, trust dialogue, or active in-flight turn indicators (e.g. `esc to cancel`, `Generating...`, `Working...`, `Thinking...`).
   - Hooks reporting `execution: "idle"` cannot override a physically busy pane.

2. **Hooks are the duplicate-suppression authority, not a delivery blocker for unsent actions**:
   - Once an action delivery succeeds (`delivery: "injected"`), subsequent sends require an eligible idle transition (`lastNudgedIdleEpoch !== idleEpoch`) or proof that the delivery was lost.
   - An action that is still `ordered` with `retryableInjectionAt` set is permitted to retry when pane scrape becomes ready without requiring a hook transition.

3. **Workflow truth outranks both observability and scrape heuristics**:
   - When an agent writes `complete` and its deliverable advances the workflow, any sticky `health: "degraded"` warning from a watchdog timeout is cleared to `"healthy"`.
   - Watchdog degradation does not trigger if `action.workflowCompleteAt !== null`.

## Reason Codes and Outcomes

### Gate Reasons (`GateReason`)
- `ok`: Pane is alive and ready for keystroke injection.
- `pane-dead`: Target tmux pane has exited.
- `owner-typing`: User is interacting with the pane (e.g. copy mode).
- `input-off`: Pane input is disabled.
- `foreground-mismatch`: The foreground process does not match the expected harness process.

### Prompt Blocked Reasons (`PromptBlockedReason`)
- `trust-dialog`: Claude or other harness is displaying a folder trust confirmation.
- `claude-no-prompt`: Claude TUI prompt indicator (`❯`, `-- INSERT --`, etc.) is missing.
- `cursor-turn-chrome`: Cursor is actively executing or displaying turn chrome (`esc to cancel`, `Thinking...`, etc.).
- `antigravity-turn-chrome`: Antigravity is generating or working (`esc to cancel`, `Running...`).
- `antigravity-verify-overlay`: Antigravity account eligibility/verification overlay is active.
- `antigravity-no-prompt`: Antigravity prompt indicator is missing.

### Lifecycle Wait Codes (`WaitCode`)
- `unmatched-action`: Entry action ID or digest does not match current target.
- `workflow-complete`: Action has already completed.
- `pending-input`: Agent has pending queued inputs.
- `background-active`: Agent background tasks or crons are running.
- `queued`: Agent execution is queued.
- `working`: Agent is actively working.
- `unknown`: Agent execution state is unknown.
- `failed-execution`: Agent execution failed.
- `idle-transition-already-used`: Current idle epoch has already received a delivery.

## Lost-Delivery Recovery

When an action was marked `injected` but no turn activity occurred, the coordinator retries if and only if:
1. `turnId === null`, `pendingInputCount === 0`, and `backgroundActive !== true`.
2. Positive scrape proof (`actionAbsentAtReadyPrompt`) confirms the pane shows a live, ready prompt and does not contain the target action UUID.
3. Either:
   - Lifecycle state shows `execution === "queued"` with hook observation after injection, OR
   - Lifecycle state shows `execution === "unknown"` with degraded health, OR
   - Lifecycle state shows `execution === "idle"`, `code === "idle-transition-already-used"`, and the observability watchdog (`45_000ms`) has elapsed.
