# Issue 102 Plan: Better journalling, messaging and detection by the coordinator

## Scope and Problem Analysis

Issue 102 addresses four interrelated coordinator detection, messaging, and journalling reliability issues:

1. **Specific Busy Rationale in Logs and Journals**:
   Currently, when an agent pane is deemed busy or unready, `injectionGate`, `harnessPromptReady`, and `tmux.nudge` return generic `"busy"` strings without preserving the exact cause (e.g., `owner-typing`, `input-off`, `process-mismatch`, `account-verifying`, `in-flight-regex: esc-to-cancel`, `prompt-pattern-unmatched`). This makes diagnosing delayed or blocked nudges difficult.

2. **Nudge Suppression Recovery**:
   When a nudge fails due to a transient busy condition or missed injection, `markActionInjectionDeferred` was restricted to `delivery === "ordered"`. If an action was marked `"injected"` but the agent never processed it or tmux was busy during a re-nudge, `decideLifecycleNudge` could get stuck on `idle-transition-already-used`, suppressing subsequent nudges indefinitely.

3. **Hook Authority vs. Screen Scraping**:
   Authoritative lifecycle hooks (e.g., `stop` hook from Claude/Cursor/Codex/Antigravity or `status-line: idle` from Antigravity) are the primary source of truth for agent turn completion. Screen scraping currently runs broad regexes across the entire 40-line pane history buffer (`capture-pane -S -40`), where historical words like `Running...` or `Working...` from code or logs can permanently false-positive as "busy", overriding explicit `stop` events. Screen scraping should focus on recent lines / prompt areas, and authoritative idle hooks must take precedence unless physical blockers (`ownerTyping`, `inputOff`, trust dialog, account verify) exist.

4. **Agent Output Readiness Conventions & Prompt Matching**:
   When agents finish an action and await the next `action.md`, having a standardized output convention (e.g., explicit confirmation and ready-for-action statement) enables deterministic terminal scraping across all harnesses.

---

## Exact File List to be changed or deleted

### Changed

- `src/tmux.ts`:
  - Refactor `injectionGate` and `harnessPromptReady` to return structured results with specific rationale reasons (`PromptReadyResult`, `InjectionGateResult`) rather than simple booleans or flat `"busy"` tokens.
  - Scope prompt detection to active pane lines and explicit idle cues to avoid false positives from historical terminal scrollback.
  - Return detailed `busyReason` / `deferReason` from `nudge()`.
- `src/agentLifecycle.ts`:
  - Enhance `decideLifecycleNudge` and `markActionInjectionDeferred` so transient busy states during injection or re-nudging do not permanently exhaust the idle epoch.
  - Maintain clear distinction between hook-proven idle states and heuristic pane observations.
- `src/runLoop.ts`:
  - Log and journal explicit busy rationales (`details: { busyReason, gateReason, promptReason }`) in `nudged` and `agent-lifecycle` journal events.
  - Prevent duplicate nudge suppression when an agent is idle according to healthy lifecycle hooks.
- `src/agentEvent.ts`:
  - Propagate detailed lifecycle observations and hook rationale fields into journal records.
- `AGENTS.md`:
  - Specify the standard agent output convention upon completing an automated action and awaiting the next coordinator action.
- `package.json`:
  - Bump version from `0.0.17` to `0.0.18` to satisfy non-main branch ship gates.
- `config.product.example.json`:
  - Bump coordination version from `0.0.17` to `0.0.18`.
- `test/tmux.test.ts`:
  - Add test cases for structured prompt readiness reasons, pane scrollback isolation, agent ready output cues, and detailed busy rationale reporting.
- `test/agentLifecycle.test.ts`:
  - Add tests for nudge retry eligibility when prior injections were deferred or transiently busy, preventing permanent suppression.
- `test/runLoop.test.ts`:
  - Add tests for detailed busy logging, structured journal entries with specific rationales, and nudge recovery.
- `test/agentEvent.test.ts`:
  - Update tests to verify enriched lifecycle journal details.
- `test/cli.test.ts`:
  - Update version check assertion to `0.0.18`.
- `test/install.test.ts`:
  - Update version check assertion to `0.0.18`.

### Deleted

- None.

---

## Exact file list to be created

- None.

---

## Implementation Details

1. **Structured Readiness and Gate Types**:
   Define `PromptReadyResult`:
   ```ts
   export type PromptReadyResult =
     | { ready: true; promptKind: string }
     | { ready: false; reason: "trust-folder" | "account-verifying" | "in-flight-turn" | "prompt-not-found" | "custom"; detail?: string };
   ```
   Define `InjectionGateResult`:
   ```ts
   export type InjectionGateResult =
     | { status: "ok" }
     | { status: "gone" }
     | { status: "busy"; reason: "owner-typing" | "input-off" | "process-mismatch"; detail?: string };
   ```
   Update `nudge()` to return `{ status: "sent" | "disabled" | "gone" | "busy"; reason?: string }`.

2. **Scrollback False-Positive Mitigation**:
   Instead of searching for `esc to cancel` or `Running...` across all 40 lines of `capture-pane`, inspect the bottom active region of the viewport (the last 5-10 lines or around the active prompt line) or verify that active turn indicators are not preceded by an idle prompt / agent waiting marker.

3. **Nudge Recovery & Idle Epoch Handling**:
   When `tmux.nudge` returns `busy`, record the deferred injection without locking out future idle checks. When the agent's hook fires `stop` or `status-line: idle`, ensure `decideLifecycleNudge` permits the nudge even if a prior nudge encountered a transient busy state.

4. **Detailed Journalling and Logging**:
   When nudges are deferred or agents are determined to be busy, write structured records to `journal.jsonl`:
   ```json
   {
     "type": "agent-lifecycle",
     "agent": "antigravity",
     "actionId": "...",
     "details": {
       "event": "nudge-deferred",
       "reason": "prompt-not-ready",
       "rationale": "pane matching 'esc to cancel' in active turn footer"
     }
   }
   ```

5. **Agent Protocol Conventions**:
   Update `AGENTS.md` protocol instructions to ensure agents emit a standardized status line (e.g. `Waiting for next coordinator action...`) after writing completion, providing a secondary hook-correlated scraping anchor.

---

## Tests

1. Run unit test suites during implementation:
   ```bash
   pnpm vitest run --config vitest.config.ts test/tmux.test.ts test/agentLifecycle.test.ts test/runLoop.test.ts test/agentEvent.test.ts
   ```

2. Run repository fast verification:
   ```bash
   pnpm check:fast
   ```

3. Run full end-to-end integration and check suite:
   ```bash
   pnpm check
   ```

Verification criteria:
- Structured busy reasons are emitted in `journal.jsonl` and debug logs for all busy branches.
- Transient tmux busy states do not permanently suppress subsequent nudges when the agent becomes idle.
- Historical `Running...` / `Working...` text in scrollback does not block nudges when the bottom prompt is idle.
- Explicit `stop` lifecycle hook events reliably trigger action delivery.
- All pre-existing test suites continue to pass with full parity.

---

## Alternatives Rejected

- **Pure Hook Reliance without Pane Inspection**:
  Rejected because terminal multiplexers can have `ownerTyping` (user navigating in copy mode) or `inputOff` set even when the background process is idle. A physical gate check remains necessary, but it must be precise and report specific reasons.

- **Aggressive Blind Nudging on Every Tick**:
  Rejected because injecting keys while an agent is actively generating text or while the user is typing can corrupt commands, cancel in-flight turns, or lose keystrokes.

- **External Process Polling / Vendor Database Scraping**:
  Rejected in accordance with architectural principles; the coordinator must rely only on standard tmux inspection, lifecycle hooks, and owner runtime files.

---

## Risks and Mitigations

- **Risk: Strict prompt checks fail on customized agent themes or minor UI updates.**
  *Mitigation*: Support flexible regexes matching standard prompt anchors (`>`, `❯`, `-- INSERT --`) as well as standard agent waiting cues.
- **Risk: Nudge loops if an agent remains idle but rejects commands.**
  *Mitigation*: The existing `lastNudgedIdleEpoch` and observability degradation watchdog protect against continuous spinning while allowing recovery from transient busy states.
- **Risk: Backward compatibility with older journals and runtimes.**
  *Mitigation*: Add optional detail fields to journal schemas without altering existing required schema structures.

---

## Conclusion

This plan addresses all four concerns in Issue 102 by adding structured rationale to busy detection, repairing nudge suppression on transient gate rejections, prioritizing authoritative lifecycle hooks over stale scrollback scraping, and establishing standard agent waiting conventions.
