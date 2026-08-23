# Issue 102 Plan Review

Review of bound peer plans for Issue 102:
- Antigravity: `ba6c7daa132cb6937aa1eca0032310e005611c9f`
- Cursor: `fe93f93e173bf52e0b5e5851994d3b2cb553150a`
- Claude: `4029b017e2a8c5f17c1d588a8267b8cd1e72e8a4`
- Codex: `f1a824657dd73f3b07c25bb367bdfbc735f28f1c`

---

## Findings

### Finding 1: Lifecycle Stop hook overriding terminal activity chrome (Codex plan)

- **Plan Claim or Section**: Codex plan, Scope & `src/tmux.ts` ("accept an explicitly supplied fresh-lifecycle-Stop authority for overrideable screen refusals", "a fresh idle Stop for the current delivery may override stale or ambiguous prompt text").
- **Rule**: Screen inspection must remain the authoritative physical safety gate for keystroke injection (`send-keys`). The coordinator must never inject keystrokes into a pane whose active viewport indicates an in-flight turn (e.g., `esc to cancel` or active turn chrome), even if a recent `Stop` hook was received.
- **Concrete Failure**: If a `Stop` event arrives during a subagent turn or before the TUI finishes rendering its final turn state, overriding screen activity checks will cause the coordinator to inject nudge keystrokes into an actively running or cancelling process. The typed keys will either be consumed as raw input by in-flight tools or cause accidental turn aborts, resulting in corrupted agent state and lost actions.
- **Smallest Correction**: Retain terminal screen scraping as the strict physical typing gate; do not allow `Stop` hooks to bypass active turn indicators. Instead, fix false-positive screen scraping directly by tightening turn chrome regexes (such as requiring ellipsis on `Thinking...`/`Thinking…`) and focusing prompt detection on the live tail of the pane.

### Finding 2: Mandatory agent completion waiting line breaking backward compatibility (Codex plan)

- **Plan Claim or Section**: Codex plan, `src/action.ts` and `templates/product/AGENTS.protocol.md` ("require an agent whose re-read finds no replacement action to end its response with the exact standalone line `Waiting for the next coordinator action.`").
- **Rule**: Protocol additions for agent waiting cues must serve as additive, positive evidence and must not be a mandatory prerequisite for delivery or verification.
- **Concrete Failure**: If an agent produces a slightly different waiting sentence, omits the exact line, or formats it with trailing punctuation or markdown, screen detection that treats the exact line as a strict prerequisite will fail to recognize an otherwise ready prompt, causing permanent nudge deferrals.
- **Smallest Correction**: Use the waiting sentence as an optional additive positive hint in `harnessPromptReadiness`, while retaining standard vendor prompt patterns (`>`, `❯`, `-- INSERT --`) as fully valid readiness indicators.

### Finding 3: Sticky degraded health across workflow completion (General observation across plans)

- **Plan Claim or Section**: Agent lifecycle health transition handling in `src/agentLifecycle.ts` / `src/runLoop.ts`.
- **Rule**: When an agent successfully advances the workflow (via `intent-seen` or accepted commit SHA), any degraded observability state triggered by a watchdog timeout on a prior prompt submission must be cleared to `healthy`.
- **Concrete Failure**: If an agent finishes its work and writes `complete`, but its `health` remains marked as `"degraded"` because the `UserPromptSubmit` hook was delayed or missed, the coordinator will continue emitting misleading operator warnings advising that the CLI's observability is broken throughout subsequent workflow steps.
- **Smallest Correction**: In `src/runLoop.ts` (on `intent-seen` / action acceptance) and `src/agentLifecycle.ts`, add a transition helper to reset `health` to `"healthy"` and journal an `agent-observability-recovered` event when workflow advancement proves delivery succeeded.

### Finding 4: Cursor `Thinking` regex false-positive on prose (Convergence across Claude, Cursor, and Antigravity plans)

- **Plan Claim or Section**: `src/tmux.ts` Cursor prompt readiness check.
- **Rule**: Cursor turn chrome matching must match actual in-flight indicators (such as `Thinking...` or `Thinking…`) without false-positiving on arbitrary text containing the substring `thinking`.
- **Concrete Failure**: Any agent output discussing plans, thoughts, or statistics containing the word "thinking" (e.g., in `.plans/` or `.signals/`) matches `/Thinking/i` in the 40-line tmux capture buffer, permanently blocking subsequent action nudges.
- **Smallest Correction**: Update the regex in `src/tmux.ts` to `/esc to cancel|Generating\.\.\.|Running\.\.\.|Working\.\.\.|Thinking(\.\.\.|…)/i`.

---

## Conclusion

Claude's plan (`4029b017e2a8c5f17c1d588a8267b8cd1e72e8a4`) and Cursor's plan (`fe93f93e173bf52e0b5e5851994d3b2cb553150a`) provide the most robust architecture for Issue 102:
1. **Clear Layer Precedence**: Screen scraping vetoes keystroke injection to prevent corruption, lifecycle hooks suppress duplicate sends, and commit/completion artifacts represent workflow truth.
2. **Actionable Rationale**: Structured reason codes for every busy, deferred, and degraded state provide machine-readable journal entries (`nudge-deferred`) and de-duplicated operator logs.
3. **Targeted Heuristic Fixes**: Tightening Cursor's `Thinking` regex to require ellipsis resolves the prose false-positive without bypassing the physical typing gate.
4. **Health Recovery**: Clearing sticky degraded status upon `intent-seen` / action completion ensures operator logs remain accurate.
