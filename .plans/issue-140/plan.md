# Issue 140 — vendor-specific quota evidence and conservative recovery

## Authority and objective

Follow-up to #126 (merged via PR #141). #126 already ships durable
`journalDeferral` dedupe, the shared nudge circuit breaker, durable whole-issue
holds with manual-pause ownership, Claude pane/wait veto, and bounded local
process/watchdog observation. This issue is **only** the deferred enrichment:
classify available vendor failure evidence, attach supported absolute reset
epochs, and perform recheck-before-release recovery that never bypasses #126
pause ownership, role safety, or nudge budgets.

Historical stage-3 text at `1e8ed5f:.plans/issue-126/plan.md` is a starting
point, not authority to reopen stages 1–2. Live adapter behavior is not assumed
proven by docs; use sanitized fixtures. Unproved automatic recovery stays
disabled until evidence and caps are covered by tests.

## Exact File List to be changed or deleted

No deletions. Extend these existing files only:

| File | Change |
| --- | --- |
| `src/state.ts` | Widen hold schema beyond `resetsAt: null` / `confidence: "unknown"` for classified evidence; persist per-hold/per-episode probe budgets (`observationChecks`-style: in-flight, starts, retries, next due); optional Codex binding fields on `agentConfigSchema` (`codexHome` absolute path + expected `accountId`); journal event types for hold reason/deadline/release transitions only. |
| `src/runLoop.ts` | Wire vendor classification into hold create/enrich; run due resource observations before pause return; schedule exact-deadline rechecks at epoch+30s; release only the cleared resource hold; never clear manual pause, other holds, cancellation, or latched nudge breaker; do not replenish nudge budget. |
| `src/cli.ts` | Surface vendor evidence / deadlines in pause/hold reporting paths; no launcher or settings mutation; keep scoped `resume --hold` / `--reset-nudge-budget` semantics from #126. |
| `src/issueReport.ts` | Redacted failure text, classification vs deadline confidence, null vs exact `resetsAt`, recovery instructions; optional banked-reset availability display when already present on a bounded Codex read. |
| `src/agentLifecycle.ts` | Bounded correlated failure/telemetry cache and freshness (session/action matching); retain lifecycle locks; reject stale/retired observations. |
| `src/agentEvent.ts` | Preserve Claude `StopFailure.error`, optional `error_details`, optional `last_assistant_message` (no invented aliases); enrich Cursor `stop.status=error` / session-end diagnostics without assuming hooks; keep `aborted` as cancellation; feed classification without fabricated launcher provenance. |
| `src/agentHookSync.ts` | Ownership-preserving **Claude** statusline tee (mirror Antigravity pattern): retain owner effective command, stdin/stdout, install/inspect/remove; cache bounded matching session/window `rate_limits.*.resets_at` observations. Do not alter Antigravity statusline behavior. |
| `src/install.ts` | Call Claude statusline sync/remove alongside existing Antigravity statusline wiring during install/uninstall. |
| `docs/coord-driver.md` | Document classification policy, absolute-deadline rechecks, hard probe caps, ownership rules, and #140 recovery limits (replace the “deferred to #140 / no automatic recovery” gap left by #126). |
| `test/state.test.ts` | Hold schema widening, probe-budget persistence across restart, independent holds vs manual pause, Codex binding validation. |
| `test/runLoop.test.ts` | Enrichment/recovery paths, fake-clock probe caps, one-window recovery cannot release another, deadline+30s recheck, nudge budget preserved. |
| `test/cli.test.ts` | Reporting/routing of evidence without settings mutation; scoped resume still cannot clear unrelated holds or replenish breaker. |
| `test/issueReport.test.ts` | Redaction, null deadlines, unsupported-family copy, banked-reset display without consume. |
| `test/agentLifecycle.test.ts` | Current vs retired session/action correlation; stale telemetry rejected. |
| `test/agentEvent.test.ts` | Claude StopFailure field contract; Cursor error vs aborted; no rendered-clock deadline. |
| `test/agentHookSync.test.ts` | Claude tee stdin/stdout, inherited owner settings, idempotence, dry-run, uninstall ownership restore. |
| `test/install.test.ts` | Claude statusline install/remove wired; Antigravity path unchanged. |
| `test/tmux.test.ts` | Only if recovery interaction with existing `claude-usage-wait` / `vendor-wait` requires an assertion; no new pane scraper or locale clock parser. |

Out of scope for change: product `githooks/`, `AGENTS.md`, launcher settings rewriters, `src/tmux.ts` wait-banner detection (already #126), Antigravity quota classifier, Codex subscription/`account/usage/read`/`account/rateLimitResetCredit/consume`, Admin/SQLite/billing scraping, roster/handoff/ballot changes, ordinary issue-branch version bump.

## Exact file list to be created

| File | Justification |
| --- | --- |
| `src/agentResource.ts` | Pure vendor classification and window-matching policy shared by hooks and run loop; keeps taxonomy out of `runLoop`/`state` and is not a breaker framework. |
| `test/agentResource.test.ts` | Table-driven sanitized fixtures for failure classes, matching rules, deadline confidence, and multi-window preservation. |
| `src/codexRateLimits.ts` | One-shot `codex app-server --listen stdio://` helper for `account/read` + `account/rateLimits/read` with 10s timeout and 256 KiB output cap; no subscription manager. |
| `test/codexRateLimits.test.ts` | Fake subprocess/response tests; no paid calls or credentials. |
| `.plans/issue-140/plan.md` | This plan (coordination artifact). |

No new persistent file family, fixture directory, or npm dependency.

## Reuse and Scope

**Reuse (#126 foundations — do not reimplement):**
- `CoordinatorRunLoop` paths: `journalDeferral`, `hold`, `observationEvidence`, `deliver`, `observeUnfinished`, `maybeLifecycleNudge`, `authority`, `mutate`, `runTick`, `run`, injected `now`/`sleep`.
- Constants: `NUDGE_REPEAT_DELAYS_MS`, `OBSERVATION_INTERVAL_MS`, existing observation episode caps; keep delivery policy separate from `AGENT_OBSERVABILITY_WATCHDOG_MS` / `NUDGE_RETRY_MS`.
- State: `cursorsStateSchema`, `holdSchema` / `actionSafetySchema`, `setPaused`, `releaseHold`, `mutateCursorsState`, `requireStateMutation`, `atomicWriteJson`, `appendJournal`, `readJournal`, aggregate `paused = manualPaused \|\| holds.length > 0`.
- Lifecycle/events/hooks: `decideLifecycleNudge`, `markObservabilityDegraded`, `readAgentLifecycle`, `mutateAgentLifecycle`, `observeAgentLifecycleWithResult`, `normalizeAgentEvent`, `handleAgentEvent`, `extractPromptActionIdentity`, `syncAgentLifecycleHooks` / inspect / remove, Antigravity `syncAntigravityStatusLine` / `removeAntigravityStatusLine` ownership pattern (Claude tee mirrors it; Antigravity behavior unchanged).
- Tmux (read-only reuse): `harnessPromptReadiness`, `claudeUsageWait` / `vendor-wait` already gate sends; this issue enriches holds, does not replace the veto.
- Tests: existing run-loop `fixture`, agent-event `runtimeFixture`, hook-sync `fixture`, state/CLI/report fixtures, injected clock / `noopSleep`.

**New files justified above.** Paths cited only in this section do not expand the change list.

**Behavioral scope (implementation must satisfy):**

1. **Shared classification:** Distinct classes — renewable usage-window exhaustion, billing/spend exhaustion, temporary throttling, context overflow, auth/account hold, cancellation, transport, unknown. Keep classification confidence separate from deadline confidence. Generic 429, silence, token count, reset timestamp alone, zero credits, normal Stop, or rendered message alone do not prove exhausted capacity.
2. **Matching:** Evidence must match monitored account/resource, agent/session, and current action where applicable. Reject stale/unrelated observations; redact and bound diagnostic text.
3. **Deadlines:** Only provider-supplied absolute Unix epochs establish exact quota deadlines. A deadline permits a recheck, **not** unconditional resume. Preserve every applicable blocking window (e.g. five-hour clearance cannot bypass weekly/family). Unsupported Opus/Sonnet/other family or bucket → `resetsAt: null`, owner release.
4. **Claude:** Preserve StopFailure fields as named; never parse locale clock text (“resets 3:45pm”). Statusline tee caches matching `rate_limits.five_hour.resets_at` / `seven_day.resets_at`. Native wait / effective auto-continue → `retryOwner: vendor`; unknown ownership → owner / no automatic retry. No settings/launcher mutation; no speculative continuation prompts. Recheck once at exact epoch+30s; a new statusline render is not proof of newly fetched capacity. Native cancel/exhaustion never auto-takeover and cannot defeat manual/other/unsupported-family holds.
5. **Codex:** One-shot initialized app-server queries only; close helper after read. Owner-confirmed per-agent binding: absolute `CODEX_HOME` + expected `accountId` in existing agent config; capability-check identity every time; mismatch → owner recovery. Parse `rateLimitReachedType`, `windowDurationMins`, `usedPercent`, `resetsAt` explicitly; keep `rateLimitsByLimitId` + primary/secondary windows; dedupe compatibility `rateLimits` view. Missing fields do not clear holds. Zero spending credits with ordinary usage allowed is not a hold. **No** `account/rateLimits/updated` subscription, usage polling, or reset-credit consume in this issue.
6. **Probe caps (coordinator policy defaults):** Zero idle polling / subscription reconnects. Trigger only on new correlated failure/watchdog episode, authorized initial binding check, or outstanding exact deadline+30s. Per account/home: one helper in flight, ≤1 start / 5 minutes; coalesce triggers (hold immediately while deferred). ≤2 retries after failed query (5 then 10 minutes). ≤6 helper starts per unresolved action/hold episode including failures/timeouts; persist reservation/attempts/deadlines before spawn; restarts/wording/shifted resets never replenish. Exhausted successful read schedules only next outstanding exact deadline — never replay unchanged/past deadline each tick. Null deadline or exhausted budget → owner. 10s total helper timeout; 256 KiB output; terminate/reap all exit paths. Journal only meaningful transitions.
7. **Cursor:** Enrich observed error/session-end diagnostics; generic error or silent death remains unknown (not confirmed quota). Reuse #126 no-hook/process/watchdog path. No remaining-quota/Admin/SQLite/billing-cycle or new headless launch integration.
8. **Antigravity:** Covered only by #126 vendor-independent protections; no new quota classifier here.
9. **Recovery fence:** Automatic recovery releases only the resource hold whose evidence has cleared. Never clear manual pause, another hold, cancellation, or latched nudge circuit breaker. Preserve roster, selected writer/reviser, required reviews/ballots, unfinished work, and pins. No automatic drop, handoff, cleanup, or synthetic completion.

## Tests

Fewest focused tests that fail before and pass after; prefer extending existing files. No intentional paid quota exhaustion or credentials in CI.

**Extend existing:**
- `test/agentEvent.test.ts` — StopFailure preserves `error` / `error_details` / `last_assistant_message`; rendered clock text never becomes `resetsAt`; Cursor `aborted` stays cancellation; generic Cursor error stays unknown.
- `test/agentHookSync.test.ts` + `test/install.test.ts` — Claude statusline tee ownership (stdin/stdout, uninstall restore); Antigravity unchanged.
- `test/agentLifecycle.test.ts` — stale/cross-session/action telemetry cannot hold or release unrelated work.
- `test/agentResource.test.ts` (**new**) — table: renewable vs billing vs throttle vs context vs auth vs cancel vs transport vs unknown; multi-window preservation; family/unsupported → null deadline; classification confidence ≠ deadline confidence.
- `test/codexRateLimits.test.ts` (**new**) — fake subprocess: identity match/mismatch/missing; optional/malformed fields; zero credits + ordinary usage allowed; primary+secondary windows; timeout/output cap; no consume/subscription calls.
- `test/runLoop.test.ts` — fake clock: probe caps (1 in flight, 5 min spacing, 2 retries, 6 starts/episode, deadline+30s once); transition-only journal; five-hour recovery cannot release weekly; resource release cannot replenish nudge breaker or clear manual pause.
- `test/state.test.ts` — probe budget persistence across restart; Codex binding schema.
- `test/issueReport.test.ts` — redaction; null vs exact deadlines; recovery copy.
- `test/cli.test.ts` — scoped resume / budget reset unchanged vs new evidence fields.

**Commands:**
```sh
pnpm exec vitest run --config vitest.config.ts \
  test/state.test.ts test/runLoop.test.ts test/cli.test.ts \
  test/issueReport.test.ts test/agentLifecycle.test.ts test/agentEvent.test.ts \
  test/agentHookSync.test.ts test/install.test.ts \
  test/agentResource.test.ts test/codexRateLimits.test.ts
pnpm check:fast   # before every commit
pnpm check        # before acceptance / PR
```

No ordinary issue-branch version bump. Live adapter validation only with owner-approved disposable sessions and sanitized fixtures.

## Alternatives Rejected

- Pulling #126 stages 1–2 into this issue or delaying #126 for provider work — already shipped; this issue is enrichment only.
- Parsing Claude rendered clock text into UTC deadlines — rejected in #126 discussion; locale/DST/midnight inference is unsafe.
- Disabling or rewriting Claude native wait / auto-continue via launcher or settings — native ownership must be preserved; unknown means owner.
- Codex `account/rateLimits/updated` subscription or persistent app-server connection — unproved cross-process/idle delivery; defer to a separately authorized spike.
- `account/usage/read` token polling or `account/rateLimitResetCredit/consume` — usage is not remaining quota; redemption stays external.
- Inferring model↔bucket mapping from opaque Codex limit IDs/labels — fail safe with owner recovery.
- Cursor Admin/SQLite/private billing scraping or guessed billing-cycle reset — out of scope; silent death stays unknown under #126 path.
- New Antigravity quota classifier — #126 vendor-independent protections suffice.
- Parallel sleeper, idle polling, per-tick journals, or a new storage family — reuse cursors/lifecycle/journal mechanisms with transition-only rows.
- Unconditional resume at deadline — deadline only authorizes a recheck; evidence must still clear the specific hold.
- Autonomous Claude continuation prompts to refresh telemetry — not in the initial implementation.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| False clearance from stale/cross-account evidence | Strict session/action/account matching; missing/changed Codex identity → owner; never substitute coordinator default account. |
| Locale clock or statusline re-render treated as fresh capacity | No clock parsing; only matching Unix epochs; re-render ≠ new fetch; unsupported family keeps `resetsAt: null`. |
| Probe storms / unpaid API cost | Hard caps (1 in flight, 5 min, 2 retries, 6/episode, 10s/256 KiB); persist budgets before spawn; zero idle polling. |
| Recovery bypasses #126 safety | Release only the cleared resource hold; manual pause, other holds, cancellation, and nudge latch untouched; continuation still obeys aggregate pause and shared nudge budget. |
| Native Claude wait races coordinator retry | `retryOwner: vendor` when native wait/auto-continue observed; no competing prompts; verified-off necessary but not sufficient alone. |
| Docs/adapters drift from live vendor shapes | Sanitized fixtures; revalidate installed versions during implementation; keep unproved recovery disabled until tests pass. |
| Multi-window partial recovery | Preserve all applicable windows; clearing one never bypasses another. |

## Conclusion

Issue 140 enriches #126 holds with vendor-specific failure classification, Claude statusline absolute epochs, bounded Codex App Server reads, and conservative deadline+30s recheck-before-release — without reopening loop-prevention work, without settings mutation, subscriptions, or ownership transfer. Smallest ship: four new modules/tests (`agentResource`, `codexRateLimits`) plus focused extensions to state, run loop, events, lifecycle, hooks/install, reports, CLI, and docs, verified by `pnpm check:fast` / `pnpm check`.
