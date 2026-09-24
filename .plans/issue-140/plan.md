# Issue 140 plan — vendor quota evidence and evidence-based recovery on top of #126

Baseline `5b2c3050bdb11e112fa890b7d064c4c65f5d6eb4` already ships the parts of #126 this plan relies on:
durable `cursors.holds` (`src/state.ts:535`), the scoped `releaseHold` (`src/state.ts:1119`), the
`actionSafety` send budget (4 sends, never replenished except by `--reset-nudge-budget`), the crash-idempotent
`CoordinatorRunLoop.hold()` (`src/runLoop.ts:877`), the no-hook watchdog in `observeUnfinished`
(`src/runLoop.ts:971`) and the Claude pane-wait veto (`claude-usage-wait`). This issue does **not** change any
of that. It adds three things:

1. **Evidence**: vendor failure evidence is captured, classified, redacted and bounded.
2. **Enrichment**: that evidence is attached to the holds (new hold or existing #126 hold), with
   classification confidence kept separate from deadline confidence.
3. **Recheck-before-release**: a narrowly gated automatic release of a *resource* hold. It runs only after a
   provider-supplied exact epoch, and only on fresh matching evidence.

Anything the plan cannot prove stays with the owner (`resetsAt: null`, `retryOwner: owner`).

Vendor surfaces were rechecked against the installed CLIs: `codex-cli 0.155.1` and Claude Code `2.1.281`.
For Codex, `codex app-server generate-ts` shows the following:
- `GetAccountRateLimitsResponse` has `ordinaryUsageAllowed: boolean | null`, where null means "must not infer
  recovery". It also has `rateLimits`, `rateLimitsByLimitId`, `accountId: string | null` and
  `rateLimitResetCredits`.
- `RateLimitSnapshot` has `limitId`, `primary`, `secondary`, `credits`, `spendControlReached` and
  `rateLimitReachedType`.
- `RateLimitWindow` has `usedPercent`, `windowDurationMins` and `resetsAt` (Unix seconds, nullable).
- `Account` is `{type:"apiKey"} | {type:"chatgpt", email, planType} | {type:"amazonBedrock", …}`.

The implementation re-runs that generator and records the version in the fixture header, because none of these
fields are assumed stable.

## Exact File List to be changed or deleted

- `src/state.ts`
  - Widen `holdSchema` so that every existing field and value still parses. Old `cursors.json` files stay
    valid, and `RUNTIME_FORMAT_VERSION` is not bumped:
    - `reason` gains `"vendor-failure"`.
    - `failureClass` is added: `usage-window | billing | throttled | context-overflow | auth-account |
      cancelled | transport | unknown`, default `"unknown"`.
    - `confidence` becomes `"unknown" | "vendor-reported" | "probed"` (was `z.literal("unknown")`), default
      `"unknown"`.
    - `resetsAt` becomes `timestampSchema.nullable()` (was `z.null()`).
    - `windows` is added: an array (max 8) of `{ source: "claude-statusline" | "codex-app-server", bucket:
      string, usedPercent: number | null, resetsAt: timestamp | null }`, default `[]`.
    - `detail` is added: a redacted string (max 512 chars) or null, default null.
    - `recovery` is added, default null: `{ kind: "claude-native" | "codex-probe", nextAt: timestamp | null,
      lastDeadline: timestamp | null, outcome: "pending" | "owner" }`.
  - Extend `actionSafetySchema` with `probe: { starts (0–6), failures (0–2), lastStartAt, nextAt }`, with
    defaults of zero or null.
  - Add `"hold-updated"` to `journalEventTypeSchema`.
  - Add an optional `codexAccount: { home: absolute path, accountId: non-empty string }` (strict) to
    `agentConfigSchema`. It is refined so that only `id === "codex"` may carry it. This is the owner-confirmed
    per-agent binding, and it flows into `start.json` through the existing agent copy.
  - Owner `releaseHold` also resets `probe` to zero. An owner release begins a new episode.
  - Add `releaseResourceHold(cursors, id, now)`. It removes one `vendor-failure`/`vendor-wait` hold of class
    `usage-window` for the current action, and throws for any other reason, class, or retired work. It
    increments `holdGeneration` but keeps `sends`, `lastSendAt` and `probe`, and it recomputes
    `paused = manualPaused || holds.length > 0`.
- `src/agentLifecycle.ts`
  - Add the entry fields `lastFailure` and `claudeRateLimits` (both nullable, default null). `lastFailure` is
    `{ vendor, failureClass, error: string|null, detail: string|null, sessionId, turnId, actionId, observedAt,
    windows, resetsAt, confidence }`. `claudeRateLimits` is `{ sessionId, observedAt, fiveHour, sevenDay }`,
    each window `{ usedPercent, resetsAt }` or null.
  - `LifecycleObservation` gains an optional `failure` (unclassified raw fields) and a new kind `"telemetry"`.
  - `applyLifecycleObservation` does the following:
    - Stores a classified `lastFailure` only when the observation's session equals the entry session.
    - Applies a `telemetry` observation to `claudeRateLimits` only. It does not change `execution`,
      `lastEvent`, `lastEventAt`, the session or the idle epoch. A render is not activity and must not
      replenish #126's watchdog.
    - Returns the same entry for unchanged telemetry, so `mutateAgentLifecycle` does not write.
- `src/agentEvent.ts`
  - Claude `StopFailure`: pass `error`, optional `error_details` and optional `last_assistant_message`
    verbatim into `failure`. No `error_type`/`error_message` aliases.
  - Claude `status-line` (explicit event): normalize `session_id` plus `rate_limits.five_hour` and
    `rate_limits.seven_day`, each `{used_percentage, resets_at}` (Unix seconds), into a `telemetry`
    observation.
  - Cursor `stop`: `status=aborted` becomes failure class `cancelled`; `status=error` becomes `unknown`. The
    lifecycle kind stays `failed`, so #126 behaviour is unchanged.
  - Cursor `sessionEnd`: optional `reason`/`error_message` are captured. `error` becomes `unknown`;
    `aborted` and `user_close` become `cancelled`.
  - `handleAgentEvent` classifies through `src/vendorFailure.ts` against the entry's cached telemetry before
    persisting.
  - `handleAgentEvent` never journals a `telemetry` observation. It journals a failure once per distinct
    `lastFailure` using the existing `agent-lifecycle` row, extended with `failureClass`.
- `src/agentHookSync.ts`
  - Generalize the Antigravity status-line multiplexer (`statusLinePaths`, `StatusLineManifest`,
    `renderStatusLineWrapper`, `sync…`/`remove…`) into a vendor-parameterized form.
  - Add a Claude tee in the clone. It sets `statusLine` in `<clone>/.claude/settings.local.json` (the file that
    already holds our Claude hooks). The wrapper and manifest live at `<clone>/.claude/coord-statusline.sh` and
    `<clone>/.claude/coord-statusline.json`. `.claude/` is already in `DEFAULT_CLONE_IGNORES`
    (`src/productIgnore.ts:41`), so the clone stays clean.
  - The downstream command is the owner's effective command, recorded in the manifest at install. Precedence
    is: local `statusLine`, then `<clone>/.claude/settings.json`, then `~/.claude/settings.json`.
  - Prior object fields such as `padding` are preserved, as the Antigravity path does. The wrapper forwards
    stdin asynchronously (`agent-event --vendor claude --event status-line --clone <clone>`) and pipes the
    same bytes to the downstream command, so stdout is exactly the owner's.
  - Uninstall restores the prior local value, or deletes the key when there was none. If the wrapper has been
    edited, uninstall leaves it in place and reports it as kept.
  - `inspectAgentLifecycleHooks` reports `modified` when the recorded effective command no longer matches.
  - The tee does not mutate Claude settings or the launcher beyond `statusLine`.
- `src/install.ts`: call the Claude tee sync next to `syncAgentLifecycleHooks` for a `claude` agent clone, and
  the removal on uninstall. The wiring mirrors the existing Antigravity calls at `src/install.ts:455` and
  `:639`.
- `src/runLoop.ts`
  - `RunLoopDependencies.codexLimits?: CodexLimitsReader` is injectable. The default is `readCodexLimits`.
  - `hold()` takes an optional enrichment (`failureClass`, `confidence`, `resetsAt`, `windows`, `detail`,
    `retryOwner`, `recovery`). The evidence identity rule and append-before-cursor recovery are unchanged.
  - New `holdOnVendorFailure()` runs in `runTick` for each active agent, before `observeUnfinished`. It
    creates one `vendor-failure` hold when a lifecycle `lastFailure` matches the current action and session,
    and was observed after `injectedAt`. The evidence id is `failure:<observedAt>`. Duplicates and stale
    failures are no-ops.
  - `retryOwner` is `vendor` only when the Claude pane shows the native wait (existing `harnessPromptReadiness`
    → `claude-usage-wait`). Otherwise it is `owner`. Unknown ownership is never coordinator-owned.
  - New `maintainResourceHolds()` runs at the top of `runTick`, after the abandoned/completed check and before
    the `paused` early return. When `manualPaused` is set, or no hold has pending recovery or unenriched
    matching evidence, it returns immediately without I/O. It does three things:
    1. **Enriches** an existing hold for the same agent, action and session with a later `lastFailure`. This
       covers a #126 `vendor-wait` hold that pre-empted the StopFailure. It journals one `hold-updated` row
       per transition (`eventId: hold-update:<id>:<key>`).
    2. **Claude recheck.** A hold is eligible only when it is `usage-window`, its only buckets are
       `five-hour`/`seven-day`, and it has an exact `resetsAt`. The first evaluation runs at
       `resetsAt + 30 s`. It releases through `releaseResourceHold` only when all of these hold:
       - The same session later produced a non-failure lifecycle boundary (`stopped`/`prompt-submitted`)
         whose timestamp is after `resetsAt`.
       - No `lastFailure` is newer than that boundary.
       - Any `claudeRateLimits` observed after `resetsAt` shows no held window at or above 100.

       If that evaluation cannot release, the hold stays. Each later lifecycle change for that session gets
       one local re-evaluation, with no prompt and no probe. Otherwise the hold waits for the owner, and a
       single `hold-updated` row with `outcome: owner` is written.
    3. **Codex probe.** Runs when `recovery.nextAt ≤ now`, through `codexProbe()`.
  - New `codexProbe()` is used for detection and for deadline checks. It enforces the caps from **Tests**
    below. The start is reserved durably, in `actionSafety.probe` and the per-binding throttle file, *before*
    spawning. Its outcomes:
    - **Identity gap or mismatch**: missing binding, non-`chatgpt` account, null or changed `accountId`. The
      hold becomes class `auth-account` with the owner as recovery.
    - **Exhausted**: at least one of `ordinaryUsageAllowed === false`, a non-null `rateLimitReachedType`, a
      window at or above 100, or `spendControlReached === true`. The hold is enriched with
      `confidence: probed` and every blocking window.
      - When all blocking windows have non-null epochs, the next check is scheduled at the **latest** blocking
        `resetsAt` + 30 s. Clearing a shorter window never bypasses a longer one.
      - A null epoch, or a deadline no later than `recovery.lastDeadline`, sets `outcome: owner` with no
        reschedule.
    - **Clear**: requires `ordinaryUsageAllowed === true`, no reached type in any bucket, no window at or
      above 100, and `spendControlReached !== true`. It applies to *every* bucket, because mapping models to
      buckets is not inferred. A clear read releases a `vendor-failure`/`usage-window` hold, or a detection
      hold created while a read was deferred. It never releases a #126 hold (for example, an enriched
      `unobservable`); it only updates that hold's report.
    - **Failed or timed out**: retry after 5 then 10 minutes. After two retries, or when the episode's six
      starts are spent, the recovery becomes `outcome: owner`.
  - In `deliver()`, for `reason === "idle"` with `safety.sends ≥ 1` on a `codex` agent that has a binding, a
    detection read runs before charging the re-send. This is the "new correlated failure episode" trigger:
    the agent stopped after an injected action without completing.
    - **Clear**: the send proceeds normally.
    - **Exhausted**: a `vendor-failure` hold is created.
    - **Deferred** (in flight, or less than 5 minutes since the last start): a `vendor-failure`/`unknown`
      hold is created immediately, with `recovery.nextAt` set to the earliest allowed start. An old snapshot
      is never read as clearance.
  - When #126 `hold()` creates any hold for a bound `codex` agent, it sets `recovery: {kind: "codex-probe",
    nextAt: now}` so that the next `maintainResourceHolds` runs one enriching read. This is the "watchdog
    episode" trigger.
- `src/issueReport.ts`: replace the fixed "cause unknown, reset unknown" line with the hold's class and
  confidence. The report shows:
  - the exact reset only when `resetsAt` came from a provider epoch, otherwise `reset unknown`;
  - the blocking windows;
  - the redacted detail;
  - either "automatic recheck at <nextAt>" or "owner release required".

  The existing `coord resume --hold` recovery line is kept. `--reset-nudge-budget` still appears only for
  `nudge-loop`.
- `test/agentEvent.test.ts`, `test/agentHookSync.test.ts`, `test/runLoop.test.ts`, `test/state.test.ts`,
  `test/issueReport.test.ts`, `test/install.test.ts`: extended as described in **Tests**.

Not changed: `src/cli.ts` (`coord resume --hold` already releases any reason; `agent-event --event` already
passes arbitrary event names), `src/tmux.ts`, `githooks/`, `package.json` (no version bump, no new
dependency).

## Exact file list to be created

- `src/vendorFailure.ts` holds pure, I/O-free logic:
  - the failure-class type;
  - `redactDiagnostic()`: strips ANSI through the existing `stripAnsi`, masks bearer/`sk-`/token-like runs and
    emails, collapses whitespace and bounds the result to 512 chars;
  - `classifyClaudeFailure(failure, telemetry, now)`;
  - `classifyCursorFailure(...)`;
  - `claudeReleaseDecision(...)`.

  It is justified as a new file because `agentEvent.ts` (hook normalization) and `runLoop.ts` (hold release)
  both need the same classification and release rules. Keeping them in one module lets the table tests
  exercise every class without a runtime fixture.

  Claude rules:
  - `authentication_failed` becomes `auth-account`, `billing_error` becomes `billing`, and `server_error`
    becomes `transport`.
  - `invalid_request` becomes `context-overflow` only when the redacted detail states that the prompt or
    context is too long. Otherwise it is `unknown`.
  - `rate_limit` becomes `usage-window`, with exact epochs, only when the cached telemetry meets all of the
    following:
    - it has the same `session_id`;
    - it was observed at or after the action's `injectedAt` and no more than 10 minutes before the failure;
    - it shows `five_hour` and/or `seven_day` at or above 100;
    - its `resets_at` values are in the future.
  - If the detail names a model-family limit (Opus, Sonnet or another model), the result is
    `usage-window/model-family` with `resetsAt: null`, and a general-window epoch is never borrowed.
  - A `rate_limit` with fresh matching telemetry below 100 in both windows becomes `throttled`.
  - Every other case is `unknown` with a null deadline.
  - Rendered clock text such as "resets 3:45pm" is never parsed.
- `src/codexLimits.ts` holds the one-shot App Server reader:
  - `readCodexLimits({home, timeoutMs: 10_000, maxBytes: 262_144})` spawns `codex app-server --listen
    stdio://` with `CODEX_HOME=<home>`.
  - It sends `initialize` (`clientInfo: {name: "coord", …}`), then the `initialized` notification, then
    `account/read` and `account/rateLimits/read`, and closes stdin. No model turn, login, subscription,
    `account/usage/read` or `account/rateLimitResetCredit/consume`.
  - On success, timeout, error, the output cap or a thrown exception, it SIGTERMs and then SIGKILLs the child
    and awaits exit.
  - `parseCodexLimits()` checks the named fields explicitly. It keeps `rateLimitsByLimitId` buckets and their
    primary and secondary windows, and uses the compatibility `rateLimits` only when it has a `limitId` not
    already present. Missing or ill-typed fields become `null`, and null never counts as clear.
  - `rateLimitResetCredits.availableCount` is kept for display only.
  - The file also contains the per-binding throttle record at
    `<coordRoot>/codex-probes/<sha256(home\0accountId)[0..16]>.json`, holding `{inFlightSince, lastStartAt}`
    under the existing `acquireExclusiveLock`/`atomicWriteJson`. It allows one in-flight helper per binding
    and one start per 5 minutes. A stale in-flight marker older than timeout + 5 s counts as ended, but its
    `lastStartAt` still spaces the next start.

  It is justified as a new file because it is child-process I/O with its own kill/reap and cap handling. It
  does not belong in the 2.4k-line run loop, and it gives tests one injectable seam (`CodexLimitsReader`).
- `test/vendorFailure.test.ts` covers the classification and release table for the new pure module.
- `test/codexLimits.test.ts` covers the parser and the helper process. It uses a fake `codex` executable
  written into a temp dir and put on `PATH`, following the temp-dir pattern the existing tests already use.
- `test/support/fixtures/codex-rate-limits-0.155.1.json` is a sanitized `GetAccountRateLimitsResponse`
  fixture with multiple buckets, zero credits and ordinary usage allowed. It is justified as a new file
  because the parser must be pinned to the real field shape, and the file records the CLI version it came
  from.

## Reuse and Scope

**Reused, not re-implemented:**
- Holds and budget: `CoordinatorRunLoop.hold()`, including its `holdGeneration` evidence identity,
  append-before-cursor id recovery and single `paused` row. Also `releaseHold`, `actionSafety`,
  `ensureActionSafety`, `mutate`/`requireStateMutation` (the compare-and-swap effect fence), `authority()`
  after every await, and `appendJournal` idempotence by `eventId`. No parallel hold store, sleeper or timer:
  recovery runs on the existing `runTick` cadence.
- Lifecycle: `mutateAgentLifecycle`, `applyLifecycleObservation`, `readAgentLifecycle`, `handleAgentEvent`
  routing (clone → agent → issue), `normalizeAgentEvent` and its `stringField`/`object` helpers.
- The #126 no-hook path (`observeUnfinished`) and the Claude wait veto (`harnessPromptReadiness`,
  `claude-usage-wait`) are consumed as they are. Cursor silent death stays on the watchdog.
- Status line: the Antigravity multiplexer machinery in `src/agentHookSync.ts:268–401` (manifest ownership,
  prior-object preservation, edited-wrapper retention) is parameterized rather than copied. So are
  `shellQuote`, `readDocument`, `AGENT_LIFECYCLE_HOOK_MARKER` and `atomicWriteJson`.
- Process and lock primitives: `spawn` as used by `runArgv` (`src/runLoop.ts:92`), `acquireExclusiveLock` and
  `atomicWriteJson` from `src/state.ts`. From `src/tmux.ts`: `stripAnsi`.
- Tests: `safetyFixture` in `test/runLoop.test.ts:167`, with its fake clock `advance()`, fake UI and
  `working()`/`stop()` helpers. Also `fixture()`, `readJournal`, `mutateCursorsState` and `writeCursorsState`
  for crash/restart simulation, the `test/agentEvent.test.ts` clone-routing setup, the
  `test/agentHookSync.test.ts` temp-home setup and the `test/issueReport.test.ts` cursors builder.

**Scope boundary (#126 stays #126):** no change to journal deferral dedupe, nudge spacing, the 4-send breaker,
manual-pause semantics, pane or watchdog readiness, or Antigravity (it gets no new classifier). This issue does
not add any of the following:
- a rollout reader or a shared casing-conversion parser;
- an `account/rateLimits/updated` subscription;
- usage polling or reset-credit consumption;
- Cursor Admin, SQLite or billing scraping;
- a headless launch or launcher/settings mutation beyond the `statusLine` tee;
- disabling Claude auto-continue;
- autonomous Claude continuation prompts.

## Tests

Each case below fails on the baseline, where holds are fixed at `confidence: "unknown"`/`resetsAt: null`,
there is no failure capture, telemetry, tee or probe, and Cursor `aborted` is indistinguishable from an
error. Each case passes after the change. They run under `pnpm check:fast`.

**`test/vendorFailure.test.ts` (new)**
1. A table test that keeps the classes distinct:
   - `authentication_failed`, `billing_error`, `server_error` and `invalid_request`+"prompt is too long" map
     to their classes, and `max_output_tokens`/`unknown` map to `unknown`.
   - `rate_limit` with no telemetry, stale telemetry, other-session telemetry or telemetry from before
     `injectedAt` is `unknown` with `resetsAt` null.
   - `rate_limit` with fresh matching `five_hour ≥ 100` gives `usage-window` with the exact epoch as ISO.
   - Both windows at or above 100 keep both windows, and `resetsAt` is the later one.
   - A detail naming an Opus or Sonnet limit with `five_hour ≥ 100` telemetry gives `model-family` with
     `resetsAt` null.
   - A detail "resets 3:45pm" alone never produces a timestamp.
2. `redactDiagnostic` masks `sk-…`, `Bearer …` and emails, strips ANSI, and bounds output to 512 chars.
3. `claudeReleaseDecision` refuses before `resetsAt+30s`. It refuses a family bucket, a boundary from another
   session, a newer failure and post-reset telemetry still at 100. It releases only on a same-session
   non-failure boundary after the reset.

**`test/codexLimits.test.ts` (new)**
4. The sanitized fixture parses into multiple buckets. The compatibility view is deduplicated.
   `hasCredits: false` with `ordinaryUsageAllowed: true` is **clear** and never creates a hold.
   `ordinaryUsageAllowed: null` is never clear. `resetsAt: null` gives no deadline. Opaque `limitId`s are not
   mapped to models.
5. A fake `codex` on `PATH` exercises the process path: success, hang past 10 s, over-256 KiB output and
   non-zero exit each give a result or error, and the child is dead afterwards (checked with `process.kill(pid,
   0)`). The request log shows exactly `initialize`, `initialized`, `account/read` and
   `account/rateLimits/read`, with none of `turn/*`, `login`, `…/updated`, `…/usage/read` or
   `…/rateLimitResetCredit/consume`.

**`test/agentEvent.test.ts` (extend `vendor lifecycle event normalization`)**
6. The following are checked:
   - A Claude `StopFailure` with `error`, `error_details` and `last_assistant_message` stores a redacted
     `lastFailure` for the matching session and journals one row. A replay journals nothing.
   - A Claude `status-line` payload updates `claudeRateLimits` but not `execution`, `lastEventAt` or the
     session, and journals nothing across 100 identical renders.
   - Cursor `stop` `aborted` gives `cancelled`, `error` gives `unknown`, and `sessionEnd` `reason: "error"`
     gives `unknown`.

**`test/agentHookSync.test.ts` (extend)**
7. The Claude tee:
   - It installs into `settings.local.json`. It preserves an existing local `statusLine` object (command and
     `padding`) and, when no local one exists, uses the project and then the user command as downstream.
   - Its stdout matches the owner command byte for byte (the wrapper is run with a fixture payload), and a
     second sync is a no-op.
   - Uninstall restores the prior value exactly, or deletes the key. An edited wrapper is kept and reported.
   - A changed effective command is inspected as `modified`.

**`test/install.test.ts` (extend `coord uninstall` / an existing Claude-clone install case)**
8. Install on a Claude clone writes the tee, and uninstall removes it. Clone `git status` stays clean because
   `.claude/` is excluded.

**`test/state.test.ts` (extend `operational state`)**
9. `releaseResourceHold` removes only the target `usage-window` hold. It keeps `manualPaused`, the other
   hold, `sends` and `probe`, and it throws for `nudge-loop`, `delivery-uncertain`, `harness-gone`,
   `unobservable`, a non-`usage-window` class and retired work. An old-shape hold (`confidence: "unknown"`,
   `resetsAt: null`, no new fields) still parses. `codexAccount` on a non-codex agent or with a relative home
   is rejected.

**`test/runLoop.test.ts` (extend the `safetyFixture` describe block; fake clock, injected `codexLimits`)**
10. **Claude**:
    - A matching `rate_limit` StopFailure with fresh telemetry creates one `vendor-failure` hold with the exact
      `resetsAt`, and no send happens.
    - 1000 ticks before `resetsAt+30s` write nothing.
    - A native `Stop` for the same session after the reset releases only this hold. A manual pause and an
      unrelated `unobservable` hold stay, `sends` is unchanged and there is exactly one `hold-released` row.
    - A variant with a pane native wait records `retryOwner: vendor`.
    - A variant where a #126 `vendor-wait` hold came first is enriched through one `hold-updated` row instead
      of a second hold.
11. **Claude unsupported**: a model-family, stale-telemetry or no-telemetry failure advanced 7 days over 1000
    ticks and restarts produces a byte-identical journal and cursors, and no release. Native activity does not
    release it either.
12. **Codex caps**: bound agent, fake reader, 5000 ticks across 7 simulated days with `writeCursorsState`
    restarts in the middle of a reservation.
    - The detection read before the first idle re-send gives exhausted, so a hold is created.
    - Reads never overlap. Starts are at least 5 minutes apart. After a failure, retries come at +5 and +10
      minutes and no more.
    - There are at most 6 starts per episode. Restarts, changed reset epochs or changed detail do not
      replenish them.
    - The next read is at `max(blocking resetsAt)+30s`. An unchanged or past deadline is never replayed.
    - A clear read releases only this hold and does not refill the nudge budget: the fourth idle stop still
      latches `nudge-loop`.
    - `hold-updated`/`hold-released` rows appear only on transitions.
13. **Codex identity**: a null `accountId`, a different `accountId`, an `apiKey` account or a missing binding
    gives `auth-account` with owner release and no further reads. Zero credits with ordinary usage allowed at
    detection gives a normal send and no hold. A second idle re-send within 5 minutes of the last read gives
    an immediate deferred hold that a later clear read releases.
14. **Cursor**: `stop` `error` gives a `vendor-failure/unknown` hold that never auto-releases. `aborted` gives
    `cancelled`. With no hooks, the existing #126 silent-Cursor case still passes unchanged.
15. **Retired work**: a resource hold for a superseded or abandoned action is never auto-released, and a
    stale `complete` is not accepted because of a release.

**`test/issueReport.test.ts` (extend `reports unknown holds…`)**
16. An exact-epoch hold shows class, confidence, windows and "automatic recheck at …". An unknown hold still
    says "reset unknown" and "owner release required". Redacted detail appears and raw secrets do not.

Commands: `pnpm check:fast` before every commit. `pnpm check` (build, `check:fast` and e2e) before acceptance.

## Alternatives Rejected

- **Parse Claude's rendered "resets 3:45pm" or the pane banner into a deadline.** Rejected by the issue and
  unsafe across locale, DST and midnight. Only the statusline `resets_at` Unix epochs, matched to session and
  window, are used.
- **Disable Claude auto-continue, or add a coordinator "continue" prompt at the deadline.** Rejected because it
  mutates the owner's settings and races native retry ownership. Release instead requires native activity
  after the reset, and coordinator-owned Claude retry stays disabled.
- **Subscribe to `account/rateLimits/updated`, keep a long-lived App Server, or poll while idle.** Rejected:
  cross-process and idle delivery are unproved, and polling violates the zero-idle cap. One-shot reads only.
- **One hold reason per failure class, or a separate hold store and timer.** Rejected because it duplicates
  #126's hold identity, fencing and report. One `vendor-failure` reason plus a `failureClass` field enriches
  the existing structure.
- **Automatically releasing enriched #126 holds (`unobservable`, `nudge-loop`, `delivery-uncertain`) when
  quota clears.** Rejected: quota evidence does not prove the pane is observable or the send unambiguous, and
  `nudge-loop` is a latched breaker.
- **A Node-based statusline command.** Rejected because a cold Node start delays every render. The shell
  wrapper forwards asynchronously, as the Antigravity multiplexer already does.
- **Using the release's earliest window reset** (for example, five-hour before weekly). Rejected because it
  would release under a still-blocking weekly window. The latest blocking epoch is used.
- **Reading Codex rollouts, or using `account/usage/read` token counts as remaining quota.** Rejected by the
  issue, and not capacity evidence.

## Risks and Mitigations

- **Vendor field drift.** StopFailure `error` values, statusline `rate_limits` and App Server field names can
  change. Every parser is explicit and fails to `unknown`/null, which never clears or schedules. The Codex
  fixture is regenerated from `codex app-server generate-ts` and named by version. The Claude fields are
  rechecked against the installed 2.1.281 hook and statusline docs during implementation, and live checks use
  only owner-approved disposable sessions without deliberately exhausting paid quota.
- **Statusline tee breaks the owner's display or config.** The wrapper tees asynchronously and passes the
  identical bytes to the recorded effective command. Ownership is manifest-based. Uninstall restores the value
  exactly or keeps an edited wrapper. Drift is shown as `modified`, and reinstall refreshes it. Only
  `statusLine` in the clone-local, ignored `settings.local.json` is touched.
- **Statusline render frequency causes write churn or looks like activity.** Unchanged telemetry is a no-op
  write, telemetry is never journaled, and it never updates `lastEventAt`/`activityAt`, which test 6 asserts.
- **Probe storms across ticks, restarts or issues.** Reservations are persisted in `actionSafety.probe` and
  the per-binding lock file before spawning. The caps are: one in flight, 5-minute spacing, 2 retries, and 6
  starts per episode, which only an owner release resets. Tests 12–13 hammer 5000 ticks with restarts.
  *Residual:* coordinators under different `coordRoot`s sharing one `CODEX_HOME` do not share the throttle
  file. This is documented in the report line, and each still obeys its own caps.
- **A helper hangs or floods output.** A 10 s total timer and a 256 KiB cap trigger SIGTERM → SIGKILL → await
  exit on every path, including thrown parse errors (test 5).
- **Wrong account.** The coordinator's default `CODEX_HOME` is never assumed. The binding is explicit, and
  identity is rechecked on every read. A null or changed id, or an `apiKey`/Bedrock account, becomes an owner
  hold.
- **Automatic release races owner controls.** Release goes through the same compare-and-swap `mutate` and
  `authority()` checks as every effect. It never runs while `manualPaused`, never touches another hold, a
  cancellation, the nudge budget or the roster, and a stale `complete` is still validated by action id
  (test 15).
- **Forward compatibility of `cursors.json`.** The widened schema reads every baseline file. A baseline binary
  cannot read a file containing a `vendor-failure` hold. This is the same one-way upgrade #126 made, and the
  runtime is per-machine.
- **Behaviour change: Cursor `aborted`/`error` now hold instead of being re-nudged.** This is intended by the
  issue (no automatic takeover after cancellation, and a generic error is an unknown hold). The report says
  how to release it.

## Conclusion

This plan adds vendor evidence as data on #126's existing holds. It uses one new hold reason, an optional
failure class and exact-epoch windows, plus two small modules: pure classification and a bounded one-shot
Codex reader. It also adds a Claude statusline tee reusing the Antigravity multiplexer. Automatic recovery is
limited to `usage-window` resource holds with provider epochs. It rechecks after the latest blocking reset +
30 s and releases only that hold on fresh matching evidence: native same-session activity for Claude, or a
clear, identity-matched App Server read for Codex. The nudge budget, manual pause, other holds, the roster and
pins are not touched. Everything unproven remains an owner-released unknown hold. Verification is `pnpm
check:fast` per commit and `pnpm check` before acceptance, with no version bump.
