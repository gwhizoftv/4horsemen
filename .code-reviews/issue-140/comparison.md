# Issue 140 — implementation comparison

Compared bound implementation pins (protocol version 1):

- claude `2cfbcb43bcdfafb7ee2e44bbe6fcb94053b41ae6`
- codex `508562edaca337175e1d5c93bbb4672976f41f3d`
- cursor `49262150ce3084b564b82343e870d063f9bfaddf`

Authority: GitHub issue #140 and the selected Codex plan (vendor evidence + recheck-before-release on top of #126). Critical fences: Claude automatic release stays owner-only unless independently validated fresh capacity; statusline render / native Stop are not clearance; unreaped Codex helpers stay owner-only without wall-clock age-out; automatic recovery must not call owner `releaseHold`; `run()` must stay alive for authorized scheduled observation; missing/null Codex fields never clear holds.

## Comparison

All three pins stay inside the vendor-evidence follow-up: they reuse #126 holds, `actionSafety`, lifecycle correlation, and journal identity; add `resourceEvidence` / `codexQuota` / `claudeStatusLine`; and keep Antigravity without a new quota classifier. Claude and Codex also extend doctor/CLI/tee tests; Cursor leaves `doctor.ts` / `cli.ts` / `agentHookSync` tee tests unchanged relative to baseline and adds little `#140` coverage in `test/runLoop.test.ts`.

**Claude release.** All three correctly refuse auto-release on native activity or statusline renders. Claude `2cfbcb43` `consumeClaudeDeadline` (`src/runLoop.ts:1185–1201`) journals `owner-release-required` and marks the deadline consumed without calling `releaseResourceHold`. Codex `508562ed` consumes `recheckAt` once and journals `outcome: "owner"` while retaining the hold (`src/runLoop.ts:979–988`). Cursor `49262150` sets `recovery.outcome = "owner"` in `maintainResourceObservations` (`src/runLoop.ts:2366–2410`). Intent matches the issue on all three.

**`run()` keep-alive.** Claude `resourceWorkPending` (`src/runLoop.ts:1109–1117`, used at `:2759`) keeps the loop alive while a Claude hold still has an unconsumed exact deadline or a Codex probe is due. Codex `hasResourceWork` similarly retains Claude `recheckAt` and probe `nextAt` (`src/runLoop.ts:961–970`, `:2655–2677`) and refuses `initializeEffects` while held. Cursor `hasDueResourceObservation` (`src/runLoop.ts:2679–2686`) is true only when work is due *now*; `run()` at `:2908` returns immediately when paused with a future `recovery.nextAt`, so a Claude `deadline+30s` schedule never wakes, and the held-start path at `:2921` always returns without resuming workflow after release. That breaks the selected plan’s held-observation runner.

**Codex orphan / clearance.** Claude terminates unreaped helpers to owner-only without age-out and uses a durable binding record. Cursor leaves `inFlightId` set when unreaped so a second spawn is refused. Codex `508562ed` treats in-flight older than 10s as `orphan` and forces `terminal` (`src/runLoop.ts:1029–1040`) without proving reap — unsafe relative to the hard one-in-flight / proved-reap rule. Separately, Codex `parseCodexQuota` sets `unknownType` for any non-null `rateLimitReachedType` (`src/codexQuota.ts:43`) and returns before classifying `usedPercent >= 100` as `usage-window` (`:60`), so live App Server exhaustion that includes a reached type never becomes a schedulable usage hold. `recoveryProven` is declared and required by clearance (`:11`, `:75`) but never set `true` in the live parser (only test mocks supply it), so automatic Codex release cannot succeed against real helper output.

**Automatic release surface.** All three use `releaseResourceHold` for automation rather than owner `releaseHold`, and preserve nudge `sends` / probe budgets on resource release. Cursor’s `releaseResourceHold` also accepts `vendor-wait` (`src/state.ts:1261–1263`), which can clear a native-wait hold that is not proven resource clearance.

**Tee / docs / tests.** Claude and Codex ship byte-preserving Claude tees (temp-file `cat` / Node stream) with trailing-newline tests; Cursor uses `tee >(recv)` (no `$(cat)`) but adds no dedicated tee test. Claude and Codex update doctor diagnostics; Cursor does not. Codex and Claude have fake-clock `#140` run-loop cases (Claude non-release via `run()`, probe caps, multi-issue coalesce); Cursor’s `runLoop` suite remains essentially the #126 set.

### Findings

1. `cursor-49262150` `src/runLoop.ts:2908` — Rule: `run()` must stay alive for authorized scheduled observation (exact deadline + 30s), not only work already due. Failure: a held Claude recovery with `nextAt` in the future makes `hasDueResourceObservation` false and `run()` returns, so the deadline recheck never runs after restart. Smallest test: held Claude with `resetsAt = now+60s`, call `run()` with fake clock, advance past deadline+30s, expect one owner-outcome journal and no `initializeEffects`.

2. `cursor-49262150` `src/runLoop.ts:2921` — Rule: after held observation clears pause, the runner may resume normal workflow authority. Failure: the paused-start branch always `return`s after the observation loop, so an automatic/manual release while that path is active never reaches `initializeEffects` / normal ticks. Smallest test: start paused with a Codex hold, inject a clear probe that removes the only hold, assert a subsequent tick prepares/delivers.

3. `cursor-49262150` `src/state.ts:1261` — Rule: automatic recovery releases only a cleared resource hold, not native `vendor-wait` ownership. Failure: `releaseResourceHold` accepts `vendor-wait`, so a mistaken caller can clear a native wait without resource proof. Smallest test: `expect(() => releaseResourceHold(state, vendorWaitId, now)).toThrow()`.

4. `codex-508562ed` `src/runLoop.ts:1029` — Rule: an unreaped helper reservation stays owner-only until termination is proved; elapsed time alone must not redefine the reservation. Failure: `orphan ||= inFlight && age >= 10_000` forces `terminal` without a reap proof, encoding “timed out ⇒ orphan” into binding state. Smallest test: leave `inFlight` true, advance 10_001ms, assert still busy/owner-only without age-based terminal, then assert unreaped path without a second spawn.

5. `codex-508562ed` `src/codexQuota.ts:43` — Rule: known provider reached types plus window evidence must classify renewable exhaustion; unknown enums fail closed without blocking known shapes. Failure: any non-null `rateLimitReachedType` sets `unknownType` and returns before `usedPercent >= 100` can become `usage-window` (`:60–68`), so live exhausted responses that include a reached type stay owner/unknown without an exact deadline. Smallest test: fixture `{ rateLimitReachedType: "rate_limit_reached", primary.usedPercent: 100, ordinaryUsageAllowed: false }` → expect `outcome: "exhausted"` / `failureClass: "usage-window"`.

6. `codex-508562ed` `src/codexQuota.ts:11` / `:75` — Rule: automatic clearance requires attainable affirmative proof from the live parser, not only mocks. Failure: `recoveryProven` is required by `clearsCodexResource` but never assigned `true` in `parseCodexQuota`, so production clearance is permanently closed while unit tests pass with `recoveryProven: true` mocks. Smallest test: parse a fully clear, identity-matched fixture through the real parser and assert clearance is possible, or remove the dead flag from the predicate.

### Verdict

**Prefer claude `2cfbcb43bcdfafb7ee2e44bbe6fcb94053b41ae6` as the merge base.** It is the only pin that jointly keeps Claude recheck owner-only, keeps `run()` alive for pending Claude deadlines, treats unreaped Codex helpers without a 10s age-out, ships doctor/tee coverage, and exercises `#140` paths in `runLoop` tests.

**codex `508562edaca337175e1d5c93bbb4672976f41f3d`** is strong on Claude non-release and fake-clock loop tests, but findings 4–6 block shipping its Codex observer as written. Borrow its cross-issue scan / test shapes only after fixing orphan age-out and the live parser/clearance flag.

**cursor `49262150ce3084b564b82343e870d063f9bfaddf`** matches Claude non-release intent and uses a byte-oriented tee, but findings 1–3 (and missing doctor/tee/`runLoop` `#140` coverage) make it unsafe as the held-observation runner until `run()` and `releaseResourceHold` are rewritten to match Claude/Codex keep-alive and resource-only release rules.
