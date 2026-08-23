# Issue 102 plan review (cursor)

Bound plans reviewed:

- antigravity `ba6c7daa132cb6937aa1eca0032310e005611c9f`
- cursor `fe93f93e173bf52e0b5e5851994d3b2cb553150a`
- claude `4029b017e2a8c5f17c1d588a8267b8cd1e72e8a4`
- codex `f1a824657dd73f3b07c25bb367bdfbc735f28f1c`

## Findings

### Antigravity — direct `AGENTS.md` edit for agent waiting convention

**Claim:** the plan lists `AGENTS.md` under **Exact File List to be changed** to specify a standard agent output convention when awaiting the next action.

**Rule:** agent protocol overlays are installed from `templates/product/AGENTS.protocol.md`; tracked `AGENTS.md` in agent clones carries a coordination-managed block under `skip-worktree`, and AGENTS.md instructs agents not to clear that bit or replace the file to fix git status.

**Failure:** committing a protocol paragraph only to tracked `AGENTS.md` does not update the install source agents actually receive on `coord install` / branch prepare, and creates a second authority that diverges from the template the hook-sync path manages.

**Correction:** put the waiting-line contract in `templates/product/AGENTS.protocol.md` (and render it through `src/action.ts` if the completion contract belongs in every `action.md`), not in tracked `AGENTS.md`.

### Antigravity — acceptance criteria B2 and D5 are not in the file map

**Claim:** the plan concludes it “addresses all four concerns” including nudge suppression and hook authority, but its changed-file list stops at logging busy rationales in `runLoop.ts` and does not mention the degraded operator message at `src/runLoop.ts:699` or clearing sticky `health: "degraded"` after workflow completion.

**Rule:** issue #102 acceptance requires (a) degraded messaging that no longer unconditionally tells operators to restart the CLI, and (b) treating `intent-seen` / workflow completion as evidence that clears a sticky “hooks missing” narrative.

**Failure:** following the antigravity plan as written ships structured busy reasons but leaves the existing `"Restart ${agent}'s CLI so it loads coordinator lifecycle hooks."` log line and never clears degraded health when `markActionWorkflowComplete` runs, so operators still see false restart advice after a successful gate advance (concrete case B2 from the issue comment).

**Correction:** add `src/runLoop.ts` and `src/agentLifecycle.ts` changes that classify degrade cause and clear or downgrade `health` on workflow-complete / intent-seen, with tests asserting the restart string is absent for correlation-lag and present only when hooks truly never arrived.

### Antigravity — deferrals overload `agent-lifecycle` instead of a queryable journal type

**Claim:** under **Detailed Journalling**, deferred nudges are written as `type: "agent-lifecycle"` with `details.event: "nudge-deferred"`.

**Rule:** journal consumers (`src/analytics.ts`, issue reports, operator tooling) key off the top-level `type` enum in `journalEventSchema`; lifecycle events already carry vendor hook semantics and are not filtered by nested `details.event`.

**Failure:** deferral history becomes indistinguishable from hook observations in type-filtered readers; an operator searching for `nudge-deferred` events in the journal stream will miss them unless every consumer adds a nested-field predicate.

**Correction:** add `"nudge-deferred"` (and optionally `"agent-observability-recovered"`) to `journalEventSchema` in `src/state.ts`, as the cursor and claude plans specify.

### Antigravity — Cursor false-busy (case A1) has no concrete matcher

**Claim:** **Scrollback False-Positive Mitigation** says to inspect “the bottom active region” instead of all 40 capture lines, and the Cursor `/Thinking/i` problem is implied but not specified.

**Rule:** acceptance criterion 2 requires Cursor Thinking busy to match real turn chrome, not prose such as `status/thinking/stats`; a vague “bottom region” rule is not mechanically implementable or testable without naming the matcher.

**Failure:** an implementer can trim scrollback arbitrarily and still leave `/Thinking/i` matching prose in the active tail, or over-trim and miss legitimate in-flight chrome — the exact production false-positive from issue #102 persists.

**Correction:** specify the issue-92 stash fix explicitly: block only `Generating|Running|Working|Thinking` followed by `...` or `…` (plus `esc to cancel`), with a unit test using the `status/thinking/stats` pane fixture.

### Codex — fresh Stop overrides scrape refusals for delivery

**Claim:** the plan’s precedence states “a fresh idle Stop for the current delivery may override stale or ambiguous prompt text,” and `src/tmux.ts` will “accept an explicitly supplied fresh-lifecycle-Stop authority for overrideable screen refusals.”

**Rule:** typing safety must remain a scrape veto: `injectionGate` / `harnessPromptReady` must block `send-keys` when the pane shows in-flight chrome, trust UI, or input-off, regardless of hook execution state; hooks authorize duplicate suppression after a successful send, not overriding a busy pane.

**Failure:** on case C1 (hooks idle, scrape busy because Cursor still shows `Generating...` or Antigravity shows `esc to cancel`), the coordinator sends keys into an active turn, corrupting or cancelling the agent’s work — turning a journalling bug into a delivery corruption bug.

**Correction:** use fresh Stop evidence only in the lifecycle duplicate-authorization path (`decideLifecycleNudge` / lost-injection recovery), never to bypass a `harnessPromptReady` false result; document that policy in `docs/coord-driver.md`.

### Codex — one-use Stop retry while execution is already idle

**Claim:** `src/agentLifecycle.ts` will “allow that fresh Stop to authorize one retry even when execution was already idle and the numeric idle epoch did not transition.”

**Rule:** after a successful tmux send, further delivery requires a new eligible idle transition (`lastNudgedIdleEpoch !== idleEpoch`) unless the narrow lost-injection recovery proves the UUID is absent at a ready prompt; `idle-transition-already-used` exists precisely to prevent a second paste on the same idle epoch.

**Failure:** an agent that is idle on hooks but correctly busy on scrape receives a Stop for the prior turn, passes the “fresh Stop” check, and gets a duplicate nudge on the same idle epoch while the pane is still unsafe — violating the one-nudge-per-idle-transition invariant tested at `test/runLoop.test.ts:509-512`.

**Correction:** limit Stop-driven retries to actions still at `delivery: "ordered"` with `retryableInjectionAt` set, or to the existing lost-injection branch that requires `actionAbsentAtReadyPrompt` plus `turnId === null`.

### Codex — degraded operator messaging is unspecified

**Claim:** the plan focuses on “reason-coded/de-duplicated journal and verbose output” but never names the current degraded stdout at `src/runLoop.ts:699-701` or acceptance item “degraded message no longer unconditionally tells operators to restart the CLI.”

**Rule:** every bound plan must cover all acceptance criteria from the issue comment checklist, including B2/D2 operator text.

**Failure:** implementation passes new `nudge-deferred` tests while leaving `"Restart ${agent}'s CLI so it loads coordinator lifecycle hooks."` on the normal stdout path whenever the 45s watchdog fires, including the issue-96 false-positive where hooks were loaded and the gate later advanced.

**Correction:** add an explicit runLoop change that replaces undifferentiated restart advice with cause-specific text (`hooks-never-seen` vs `correlation-lagged`), matching the claude plan’s `markObservabilityDegraded` return shape.

### Claude — tracked `AGENTS.md` listed alongside the protocol template

**Claim:** **Exact File List** includes both `templates/product/AGENTS.protocol.md` and `AGENTS.md` “to keep the committed file and the template in sync.”

**Rule:** the install pipeline copies the managed block from the template into clone-local overlays; tracked root `AGENTS.md` in this repo is the product document plus a coordination appendix, not the file agents read after `coord install`.

**Failure:** editing tracked `AGENTS.md` does not change what a prepared agent clone receives, and creates merge friction with the skip-worktree overlay workflow described in `test/prepareAgentBranch.test.ts`.

**Correction:** change only `templates/product/AGENTS.protocol.md` and, if needed, the action completion scaffold in `src/action.ts`; drop `AGENTS.md` from the file map.

### Claude — broadened lost-delivery recovery adds behavior beyond messaging

**Claim:** **Broaden lost-delivery recovery** admits `idle-transition-already-used` plus watchdog elapsed time when `turnId === null`, still requiring `actionAbsentAtReadyPrompt`.

**Rule:** issue B4 states elapsed time or missing `complete` alone must never authorize retry; any broadening must preserve the positive UUID-absent scrape proof and must not send when the captured pane still contains the action UUID.

**Failure:** if the plan is followed without the test-13 guard (ready prompt but UUID scrolled out of the `-S -40` window while the agent is still processing the injected text), a second send can fire — the plan mitigates this in **Tests** item 13, but the file-map prose does not state the capture window constraint, so an implementer might weaken `actionAbsentAtReadyPrompt` independently.

**Correction:** keep the existing capture depth and UUID check explicit in the file-map bullet; add an assertion that a busy/in-flight pane with UUID still visible never sends even after watchdog elapsed.

### Cursor (self) — degraded message fix removes restart advice entirely

**Claim:** the cursor plan says to “replace the unconditional ‘Restart ${agent}'s CLI…’ degraded message with correlation-lag wording” without distinguishing hooks-never-seen from correlation-lagged.

**Rule:** acceptance requires stopping *unconditional* restart advice, not removing it when SessionStart truly never arrived and the hook bridge is genuinely unloaded — the issue comment’s suggested acceptance still wants a documented policy and tests for B2, not elimination of all restart guidance.

**Failure:** an agent whose lifecycle never records `SessionStart` (`lastEvent === null`, `sessionId === null`) gets the same correlation-lag message as issue-96’s healthy Claude, and the operator receives no actionable remedy for a dead hook bridge.

**Correction:** adopt claude’s `cause: "hooks-never-seen" | "correlation-lagged"` split from `markObservabilityDegraded` and keep the restart remedy only for `hooks-never-seen`.

## Conclusion

The four plans agree on the core defect — opaque `busy`, Cursor Thinking false-positives, misleading degraded text, and under-logged scrape/hook disagreement — and on structured reason codes plus a `nudge-deferred` journal type. Claude’s plan is the most mechanically complete: line-anchored edits, explicit acceptance-case tests, degrade-cause classification, and workflow-complete health clearing. Codex’s plan is the outlier on precedence: letting a fresh Stop override scrape refusals and bypass idle-epoch suppression risks duplicate or unsafe delivery and should not be merged as written. Antigravity’s plan covers structured busy reasons and scrollback scoping but omits B2/D5 operator messaging, uses the wrong journal top-level type, and lacks a concrete A1 matcher. The cursor plan is implementable but should adopt claude’s degrade-cause split so legitimate “restart CLI” guidance survives for truly dead hooks. Consensus implementation should take claude’s file map and tests as the spine, the cursor/antigravity structured reason codes for tmux gates, and reject codex’s Stop-over-scrape override.
