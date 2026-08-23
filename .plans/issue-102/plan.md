# Issue 102: Coordinator busy/deferred/degraded journalling and detection

## Problem

Three independent signals disagree and the operator sees opaque or wrong remedies:

| Layer | Mechanism | Authority for |
| --- | --- | --- |
| Delivery readiness | tmux pane scrape (`harnessPromptReady` / `harnessLooksReady`) | Whether it is safe to type a nudge |
| Observability | CLI lifecycle hooks | accepted → working → idle; duplicate-nudge suppression |
| Workflow truth | `complete` + git SHA | Whether the gate actually advances |

Concrete failures already hit in production (issue comment): Cursor `/Thinking/i` false-busy on plan prose (`status/thinking/stats`); journal/log lines that only say `busy`; degraded watchdog text that tells operators to restart a healthy CLI; lifecycle wait reasons only under `-v`; scrape vs hooks split-brain with no combined event.

## Scope

Ship acceptance criteria from the issue comment:

1. Every busy / deferred / degraded path records a machine-readable reason code plus a short human rationale in the journal, and prints degraded / gate-deferred lines on normal stdout (not only `-v`).
2. Cursor Thinking busy matches real turn chrome (ellipsis form), not arbitrary prose containing “thinking”.
3. Degraded messaging no longer unconditionally tells operators to restart the CLI.
4. Document scrape-vs-hooks priority when they disagree; add tests for A1, B2, C1, C2.
5. When `intent-seen` arrives after `degraded` with no correlated `UserPromptSubmit`, clear the sticky “hooks missing / restart CLI” narrative.

Out of scope for this issue (see Alternatives Rejected): requiring agents to print a fixed “waiting for next action.md” line; broadening lost-injection recovery beyond today’s UUID-absent ready-prompt proof; changing the rule that scrape decides whether keys may be typed.

## Policy (scrape vs hooks)

Document this in `docs/coord-driver.md` and enforce it in code/tests:

- **Typing safety (scrape wins):** never `send-keys` when `injectionGate` / `harnessPromptReady` says busy/gone. Hooks reporting `idle` do not override a busy pane.
- **Duplicate authorization (hooks win after first successful send):** after `injected`, further sends require `decideLifecycleNudge` → `send` (or the existing narrow lost-injection recovery). A ready scrape alone must not authorize a second paste.
- **Pre-injection retries:** while delivery is still `ordered` with `retryableInjectionAt` set, retries are allowed when scrape becomes ready; hooks are not required for the first successful paste.
- **Split-brain:** when hooks say idle/healthy and scrape returns busy (or vice versa while a gate is waiting), journal one event that includes both sides’ reason codes so status/debug is not split across axes.
- **Degraded meaning:** `health=degraded` means “no lifecycle hook correlated with the last nudge within the watchdog window.” It is not proof that hooks are unloaded. Operator text must say that. Duplicate suppression after a successful send remains correct; only the remedy text and sticky alert change.
- **Workflow truth:** `intent-seen` / `complete` proves delivery worked even if hook correlation lagged; clear degraded health on that path so the restart narrative does not stick.

## Exact File List to be changed or deleted

### Changed

- `src/tmux.ts` — tighten Cursor in-flight chrome to require `...` or `…` after `Generating|Running|Working|Thinking` (apply the issue-92 stash fix); change `nudge` / `injectionGate` (and Antigravity recapture busy) to return structured busy reasons (`owner-typing`, `input-off`, `foreground-mismatch`, `prompt-chrome:<agent>`, `antigravity-recapture-busy`) instead of a bare `"busy"` string; keep `"gone"` / `"sent"` / `"disabled"` as today.
- `src/runLoop.ts` — on busy/deferred: journal machine-readable reason + short rationale; log degraded and gate-deferred reasons on normal stdout; replace the unconditional “Restart ${agent}'s CLI…” degraded message with correlation-lag wording; when journalling a scrape busy while lifecycle is idle/healthy (or lifecycle wait while scrape is ready), include both sides in one journal `details` object; on `intent-seen`, if that agent’s lifecycle `health` is `degraded`, clear it to `healthy` (and journal the downgrade rationale) before verification continues.
- `src/agentLifecycle.ts` — add a small helper to clear/downgrade degraded health when workflow evidence proves delivery (called from the intent-seen path); keep `decideLifecycleNudge` wait reason strings stable (`queued`, `working`, `pending-input`, `idle-transition-already-used`, `unmatched-action`, …) so runLoop can journal them unchanged.
- `src/state.ts` — allow a new journal type `nudge-deferred` (and, if needed, `agent-observability-recovered`) with `details.reason` / `details.rationale` / optional split-brain fields; do not overload `nudged` for failures.
- `docs/coord-driver.md` — document the scrape-vs-hooks policy above; update the watchdog section so degraded no longer reads as “hooks missing, restart CLI”; note Cursor Thinking chrome requires ellipsis.
- `test/tmux.test.ts` — A1: plan prose containing `status/thinking/stats` is prompt-ready; real `Thinking...` / `Thinking…` remains busy; cover structured busy reason codes from the gate helpers.
- `test/runLoop.test.ts` — B2: after nudge + watchdog, degraded journal/stdout must not tell the operator to restart the CLI; C1: hooks idle + scrape busy journals split-brain / scrape reason; C2: `decideLifecycleNudge` wait (`queued` / older-turn Stop path) is journaled (and visible without requiring only `-v` when the gate is waiting); intent-seen after degraded clears sticky degraded health / restart narrative.
- `test/agentLifecycle.test.ts` — degraded clear/downgrade helper; keep existing watchdog mark tests.
- `package.json` — bump version `0.0.17` → `0.0.18` (strictly greater than `origin/main` for the non-main ship gate).

### Deleted

- None.

## Exact file list to be created

- None. Prefer extending `src/tmux.ts`, `src/runLoop.ts`, `src/agentLifecycle.ts`, and existing tests over a new module. If a tiny pure helper for reason-code formatting becomes necessary during implementation, place it beside the call sites in those files rather than adding a new top-level source file unless reuse forces one.

## Tests

Named commands (do not invent from hooks alone):

- Unit / focused: `pnpm exec vitest run test/tmux.test.ts test/runLoop.test.ts test/agentLifecycle.test.ts`
- Pre-commit gate: `pnpm check:fast` (lint, typecheck, fast tests; no Vite build)
- Coordinator acceptance before PR: `pnpm check` (build + check:fast + e2e) as run by the coordinator `checks` gate

Required coverage mapped to acceptance / failure cases:

| Case | Assertion |
| --- | --- |
| A1 | Cursor pane text with `status/thinking/stats` → `harnessPromptReady` true; `Thinking...` / `Thinking…` → false |
| A2 / D1 | `nudge` busy returns a reason code; runLoop journals `nudge-deferred` with `reason` + `rationale` |
| B1 / B2 / D2 | Degraded operator log mentions correlation lag / suppressed duplicate; must not say “Restart … CLI” / “loads coordinator lifecycle hooks” |
| C1 | Lifecycle idle + scrape busy → one journal event with both sides |
| C2 | Stop leaves `queued` (older turn / injected-awaiting-acceptance) → deferred reason journaled when gate waits |
| D5 | `intent-seen` while `health=degraded` → health becomes `healthy` (or equivalent recovered journal) so the restart narrative does not stick |

## Alternatives Rejected

- **Hooks override scrape for typing when idle:** rejected — typing into a pane that still shows in-flight chrome or input-off drops or mis-routes keys; scrape remains the typing gate.
- **Scrape override hooks for duplicate sends when the pane looks idle:** rejected — that recreates double-paste races the idle-epoch / injected model already prevents; keep narrow UUID-absent recovery only.
- **Require agents to print a fixed “waiting for next action.md” line (issue body item 4):** rejected for this issue — needs cross-agent protocol/`AGENTS.md` changes and does not fix false-busy or opaque journalling; optional follow-up if scrape idle detection still needs a stronger positive marker after A1 lands.
- **Broaden lost-injection recovery to time-elapsed or missing `complete` alone:** rejected — too easy to double-nudge mid-turn; keep today’s positive proof (ready prompt, UUID absent, no pending input/background).
- **Remove the 45s degraded watchdog:** rejected — still useful to suppress duplicates and surface correlation lag; only the operator remedy and sticky false “hooks missing” narrative change.
- **Apply the stash by cherry-picking issue-92 WIP blindly:** rejected — take the Cursor ellipsis regex and its unit test only; re-validate against current `main`/`issue-102` rather than restoring unrelated stash noise.

## Risks and Mitigations

- **Cursor chrome without ellipsis:** if a future Cursor build shows bare `Thinking` without `...`/`…`, we may false-ready and type mid-turn. Mitigation: match both ASCII `...` and unicode `…`; keep `esc to cancel` as an independent busy signal; add a follow-up if live panes show a new chrome form.
- **Journal schema churn:** new event types must pass `journalEventSchema` and any analytics consumers that switch on `type`. Mitigation: extend the zod enum; treat unknown types as non-fatal in readers that already default unknown; add a row in `docs/analytics.md` only if that doc enumerates every type (update if present).
- **Stdout noise:** logging every busy tick at normal level could flood operators. Mitigation: log degraded always; log gate-deferred / split-brain at normal level on state change or at most once per actionId+reason until cleared; keep per-tick chatter behind `-v`.
- **Call-site churn for `nudge` return type:** structured results touch `runLoop` and tests. Mitigation: keep a narrow result union; adapt tests that compare `=== "busy"` to reason-aware helpers.
- **Clearing degraded on intent-seen hides a truly broken hook bridge:** mitigation — only clear when `complete`/intent proves this action advanced; SessionStart-never-seen / bridge-down cases still surface via absent lifecycle events on the *next* nudge’s watchdog.

## Conclusion

Issue 102 is an observability and detection-correctness fix: make busy/deferred/degraded explain themselves, stop Cursor Thinking prose false-positives, stop telling operators to restart healthy CLIs, document that scrape guards typing while hooks guard duplicate sends, and clear sticky degraded when workflow truth (`intent-seen`) shows delivery already worked. No workflow gate graph changes; version bump to `0.0.18` with `pnpm check:fast` before commit and full `pnpm check` for coordinator acceptance.
