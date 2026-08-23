## Comparison

All four participating agents implemented the consensus plan from Claude for issue 102 across the full driver, test suite, and documentation surfaces.

### Bound Implementation Pins

- Claude: `62ed5b44096ddd622e9b8c1263faa6c21f429e5b`
- Codex: `176321636ce7660142c5a77f8be75701911c817a`
- Cursor: `ecc899ee10d92e7324106e056fd1f5ed34373013`
- Antigravity: `24106c134ae82a23917900374f300693c677774c`

---

### Key Areas Compared

#### 1. Structured Prompt Readiness and Screen Scraping (`src/tmux.ts`)
- **Claude (`62ed5b44096ddd622e9b8c1263faa6c21f429e5b`)**: Implemented `harnessPromptReadiness` returning a closed union of reasons (`PromptBlockedReason`). For Cursor turn chrome, added anchored status line checking (`^\s*(?:Thinking|Generating\.\.\.|\(esc to cancel|esc to interrupt)`) to prevent markdown text containing "thinking" or "generating" from blocking delivery. Integrated `COORD-IDLE` sentinel parsing with positional checking against the current action ID. Structured `injectionGate` and `nudge` to return `GateOutcome` and `NudgeOutcome` with explicit stages.
- **Codex (`176321636ce7660142c5a77f8be75701911c817a`)**: Implemented `harnessPromptReadiness`, `idleSentinelAfterAction`, and structured gate / nudge outcomes. Anchored Cursor turn chrome regex.
- **Cursor (`ecc899ee10d92e7324106e056fd1f5ed34373013`)**: Implemented closed reason unions and anchored regexes for Cursor and Antigravity turn chrome detection.
- **Antigravity (`24106c134ae82a23917900374f300693c677774c`)**: Implemented `PromptReadiness` with closed-union reasons, anchored regex matching for in-flight turn chrome, `idleSentinelAfterAction` correlation, and structured `InjectionGateResult` and `NudgeOutcome`.

#### 2. Lifecycle Decision Codes and Observability Degradation (`src/agentLifecycle.ts`)
- **Claude (`62ed5b44096ddd622e9b8c1263faa6c21f429e5b`)**: Added stable `WaitCode` to lifecycle wait decisions. Updated `markObservabilityDegraded` to distinguish `"hooks-never-seen"` (when `lastEventAt === null`) from `"correlation-lagged"`. Guarded completed actions (`workflowCompleteAt !== null`) against degradation. Updated `markActionWorkflowComplete` to clear degraded health to `"healthy"` and return `{ clearedDegraded: true }`.
- **Codex (`176321636ce7660142c5a77f8be75701911c817a`)**: Added wait codes to `decideLifecycleNudge`, classified degrade causes, and cleared degraded status upon workflow completion.
- **Cursor (`ecc899ee10d92e7324106e056fd1f5ed34373013`)**: Added wait codes, degrade cause classification, and recovery on workflow completion.
- **Antigravity (`24106c134ae82a23917900374f300693c677774c`)**: Implemented `WaitCode` in `NudgeDecision`, classified degrade causes, protected completed actions, and cleared degraded health with `{ state, clearedDegraded }`.

#### 3. Run Loop Journaling, Deduplication, and Recovery (`src/runLoop.ts`)
- **Claude (`62ed5b44096ddd622e9b8c1263faa6c21f429e5b`)**: Added `nudge-deferred` event with layer, code, hook snapshot, and splitBrain detection. Deduplicated repeated deferral logs via `lastPrintedDeferralCode`. Tailored watchdog log messages so CLI restart advice is only shown for `"hooks-never-seen"`. Emits `agent-observability-recovered` and logs recovery upon deliverable acceptance. Broadened lost delivery recovery for spent idle transitions (`idle-transition-already-used`) when watchdog elapsed and `turnId === null`.
- **Codex (`176321636ce7660142c5a77f8be75701911c817a`)**: Added `nudge-deferred` journaling, log deduplication, cause-tailored watchdog logs, recovery journaling, and expanded lost-delivery recovery.
- **Cursor (`ecc899ee10d92e7324106e056fd1f5ed34373013`)**: Implemented deferral journaling, log deduplication, recovery handling, and lost-delivery recovery.
- **Antigravity (`24106c134ae82a23917900374f300693c677774c`)**: Added `nudge-deferred` event recording, `lastPrintedDeferralCode` deduplication, cause-specific watchdog logging, `agent-observability-recovered` event recording, and expanded lost-delivery recovery for `idle-transition-already-used`.

#### 4. Readiness Policy Documentation and Protocol Alignment (`docs/readiness-policy.md`, `templates/product/AGENTS.protocol.md`)
- **Claude (`62ed5b44096ddd622e9b8c1263faa6c21f429e5b`)**: Created `docs/readiness-policy.md` detailing the signal hierarchy, invariants, closed reason code catalog, and recovery rules. Updated protocol templates with post-completion `COORD-IDLE` sentinel output.
- **Codex (`176321636ce7660142c5a77f8be75701911c817a`)**: Authored `docs/readiness-policy.md` and updated `AGENTS.protocol.md`.
- **Cursor (`ecc899ee10d92e7324106e056fd1f5ed34373013`)**: Authored `docs/readiness-policy.md` and updated `AGENTS.protocol.md`.
- **Antigravity (`24106c134ae82a23917900374f300693c677774c`)**: Created comprehensive `docs/readiness-policy.md`, updated `docs/repo-map.md`, and updated `templates/product/AGENTS.protocol.md`.

---

### Conclusion

All four implementations cleanly fulfill the plan requirements, pass full test and verification suites, resolve scrape/hook split-brain ambiguities, provide structured reason-coded deferrals, and successfully recover agent health. Claude's implementation (`62ed5b44096ddd622e9b8c1263faa6c21f429e5b`) provides especially thorough stage tracking and test coverage across all scrape stages, making it an excellent candidate for final selection.
