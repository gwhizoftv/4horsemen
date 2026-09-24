# Issue 140 — vendor evidence and conservative resource recovery

Protocol version: 1. Baseline: `5b2c3050bdb11e112fa890b7d064c4c65f5d6eb4`.
Authority: the coordinator's saved issue-140 description. This is the vendor-specific follow-up to #126, not a replacement for its delivery, watchdog, manual-pause, or owner-release machinery.

## Exact File List to be changed or deleted

No deletions. Change only:

| File | Intended change |
| --- | --- |
| `src/state.ts` | Optional owner-confirmed Codex binding on agent configuration, copied into start state; backward-compatible resource evidence, per-episode observation reservations/budgets, scoped automatic resource release, and transition event schemas. |
| `src/paths.ts` | Safe owner-runtime location for a per-binding observation lock, using existing path containment conventions. No clone permissions expansion. |
| `src/agentEvent.ts` | Preserve sanitized actual Claude failure fields and Cursor diagnostics; route Claude statusline telemetry through existing clone/issue identity resolution. |
| `src/agentLifecycle.ts` | Bounded correlated failure/statusline observations alongside existing lifecycle state; reject retired sessions and superseded actions without making telemetry workflow authority. |
| `src/agentHookSync.ts` | Install, inspect, and remove ownership-preserving Claude statusline integration alongside existing lifecycle hooks. |
| `src/install.ts` | Wire Claude tee installation/removal, including dry-run and preservation of subsequent owner edits. |
| `src/doctor.ts` | Diagnose unavailable/ambiguous tee ownership or binding configuration without probes, mutation, or exposing secrets. |
| `src/cli.ts` | Internal tee command routing and bounded input handling; preserve existing explicit owner recovery commands. |
| `src/runLoop.ts` | Consume failure evidence before delivery; reserve and execute bounded observations, including while resource-held; recheck and release only proven cleared resource holds. |
| `src/issueReport.ts` | Report distinct cause/deadline confidence, retry ownership, remaining observation budget, blocked windows, and owner recovery requirements with bounded redacted context. |
| `README.md` | Document optional binding, tee ownership, safety caps, supported evidence, disabled/unproved recovery, and owner release. |
| `test/state.test.ts` | Schema compatibility, binding validation, and scoped recovery invariants. |
| `test/paths.test.ts` | Binding-lock containment and normalized binding identity. |
| `test/agentEvent.test.ts` | Actual vendor field normalization and correlation/redaction cases. |
| `test/agentLifecycle.test.ts` | Observation freshness, replay, and cross-session/action rejection. |
| `test/agentHookSync.test.ts` | Tee byte preservation, configuration precedence, repeat installation, and safe removal. |
| `test/install.test.ts` | Install/uninstall wiring and owner-edit preservation. |
| `test/doctor.test.ts` | Read-only diagnostics for unsupported or modified integration. |
| `test/cli.test.ts` | Tee dispatch and unchanged owner pause/release behavior. |
| `test/runLoop.test.ts` | Fake-clock observation caps, restart/race fences, deadline consumption, multi-window recovery, and #126 invariants. |
| `test/issueReport.test.ts` | Redacted evidence and actionable bounded recovery reporting. |

Do not modify `githooks/`, launcher templates, package versions, dependency manifests, completion acceptance rules, or workflow selection/ballot algorithms.

## Exact file list to be created

- `src/resourceEvidence.ts`: small pure, vendor-explicit evidence schemas/classifiers and clearance predicates. Shared policy belongs here rather than being duplicated in hooks and the run loop; no extensible provider framework or casing-conversion parser.
- `src/codexQuota.ts`: bounded App Server subprocess adapter. A separate module is justified by its framing, timeout, termination, identity, and byte-budget boundary, which must be tested independently of workflow effects.
- `src/claudeStatusLine.ts`: Claude-specific tee execution and effective-command ownership handling. Keep stream forwarding and Claude setting precedence out of the generic lifecycle normalizer; do not generalize or rewrite Antigravity's working integration.
- `test/codexQuota.test.ts`: the only new test file, for a fake stdio helper and sanitized inline protocol fixtures. Existing test files cover the remaining additions.

Runtime observations remain in existing `agent-lifecycle.json` and `cursors.json`; no separate monitoring database, daemon, or scheduled worker. The binding lock is an owner-runtime lock file, not a tracked source file. Tee scripts/manifests are generated local installation artifacts, not committed credentials or fixtures. This plan is the only artifact published during the current action.

## Reuse and Scope

### Existing foundations and implementation order

Reuse `normalizeAgentEvent`, `handleAgentEvent`, `observeAgentLifecycleWithResult`, `mutateAgentLifecycle`, `lifecycleActionSchema`, and the existing session/turn/action correlation. Reuse `agentConfigSchema`/`startStateSchema`, `cursorsStateSchema`, `actionSafetySchema`, `setPaused`, `requireStateMutation`, `acquireExclusiveLock`, `atomicWriteJson`, and `appendJournal`'s event identity deduplication. Extend schemas additively with safe defaults so existing v4 issues and lifecycle-v1 files still parse.

Use `CoordinatorRunLoop.hold`, `ensureActionSafety`, `observeUnfinished`, `journalDeferral`, and existing `authority` checks. Keep `TmuxController`'s readiness/native-wait veto and shared send count/spacing intact. The existing `releaseHold` is owner acknowledgment and resets observation fields/reservations: automatic recovery must NOT call it indiscriminately. Add a narrower resource-only transition that changes only the identified resource hold and its evidence; preserve `actionSafety` verbatim, including sends, last-send time, uncertain reservation, and hold generation. Recompute `paused = manualPaused || holds.length > 0`.

Reuse the ownership-manifest, dry-run, and owner-edit-preservation patterns from `syncAntigravityStatusLine`/`removeAntigravityStatusLine`, not their shell `$(cat)` implementation: that strips trailing newlines and is unsuitable for byte-exact forwarding. Reuse `containedPath`, `assertNoSymlink`, existing install `EffectOptions`, and existing CLI routing. Reuse `fixture`/`safetyFixture` and its injectable clock/tmux in `test/runLoop.test.ts`, hook/install temporary-home fixtures, and inline payload tables in `test/agentEvent.test.ts`.

Implement in this order: evidence/state contracts and regressions; vendor ingestion and tee; bounded Codex adapter; fenced run-loop integration; reports/documentation; full verification. No dependencies are needed beyond Node built-ins and existing Zod/Vitest.

### Evidence contract and correlation

Keep failure class separate from classification confidence and deadline confidence. Classes are renewable usage window, billing/spend exhaustion, temporary throttle, context overflow, authentication/account hold, cancellation, transport failure, and unknown. Store source/vendor, bounded diagnostic fields, observed time, issue-session identity, agent, session/turn and action ID/digest where available, and explicit resource/window identity. A provider absolute epoch can make a deadline exact only for a positively classified, matching supported resource. Otherwise `resetsAt` remains null; an epoch alone never proves exhaustion.

Require the current lifecycle action/session/turn match before promoting hook evidence. Hook delivery time alone does not make an old event current. Missing turn/action linkage is advisory only unless the existing accepted-session correlation unambiguously establishes the current episode; ambiguous events cannot hold or release unrelated work. Retired sessions, completed/replaced actions, changed binding, and stale observations cannot authorize automatic effects. Preserve a stable episode ID across duplicate hook deliveries, changed wording, hold generation changes, and shifted deadlines. Normal Stop, silence, token totals, a generic 429, zero credits, or a pane phrase alone cannot become confirmed renewable quota.

Sanitize before persistence or journaling: retain actual field names, strip terminal controls, redact credential-like values, URLs with sensitive query strings and account/personal identifiers, and cap each diagnostic string at 2 KiB and each observation at 8 KiB. Retain only the latest correlated failure and supported window records, not raw transcripts or unlimited history. Treat all rendered content as untrusted data. Unknown or unrecognized vendor fields do not become guessed classes. Cancellation is terminal for automatic recovery of that episode.

### Claude ingestion, telemetry, and ownership

Preserve `StopFailure.error`, optional `error_details`, and optional `last_assistant_message` as sanitized fields; do not invent `error_type`/`error_message`. The latter is direct API-failure context, not normal assistant prose. Typed rate-limit evidence still needs supported window-specific evidence to distinguish usage exhaustion from short throttling. Unsupported or ambiguous classifications remain unknown. Never interpret rendered local clock text, even with an apparent timezone, as a deadline.

The tee must resolve the owner's effective statusline command before installation, considering user/project/local/managed settings and overrides exposed by the supported installed version. Save both the effective downstream command and the exact target-layer prior value/absence. Install a clone-local owned override only when precedence is provable; managed/CLI overrides, unsupported command shapes, or ambiguous configuration result in a diagnostic and disabled telemetry, not a guessed replacement. Preserve other statusline properties and never edit `autoContinueAtUsageLimit` or launcher arguments. Detect effective-owner-command drift; do not silently replace a new owner command with an old captured one.

Forward original stdin bytes, stdout/stderr, working directory, environment, and downstream exit status to the owner's command. A telemetry failure must not change owner output or block it indefinitely. Bound the telemetry copy and discard excess rather than truncating the downstream stream. Use a bounded synchronous receiver or awaited child, not an unbounded background process per render. With no owner command, emit no invented display. Reinstallation must not nest wrappers; uninstall restores the target-layer prior value only while coordinator ownership still matches, preserving subsequent owner edits and unrelated configuration.

Cache only matching session observations for `rate_limits.five_hour` and `rate_limits.seven_day`. Use a conservative five-minute receipt freshness limit at failure correlation, first-seen payload identity, and action/session matching; an identical re-render must not refresh its original observation age. This freshness limit is policy, not a claim that rendering fetches capacity. A matching classified session/five-hour or weekly failure may attach the corresponding valid finite Unix-seconds epoch. Preserve both applicable restrictions. Family/bucket failures (Opus, Sonnet, or other unsupported resources), missing fields, stale/mismatched payloads, and spend restrictions retain null deadlines and owner recovery; do not borrow a general window's epoch.

Record retry ownership as vendor when effective native auto-continue is on or the existing pane reader observes a native wait. Unknown effective settings mean owner ownership, never coordinator ownership. Read effective settings conservatively; verified-off is necessary but does not itself authorize recovery. Native cancellation or retry exhaustion stays owner-only; no automatic takeover after a wait disappears.

At an eligible exact deadline plus 30 seconds, re-evaluate matching cached evidence once without sending a prompt. Mark the deadline consumed before evaluation. A render, an omitted expired window, or native activity alone is not proof of a fresh capacity fetch, so this initial Claude adapter does not automatically release on those signals and sends no autonomous continuation prompts. Unless an independently validated supported fresh-capacity signal exists, retain the hold for owner release. Never release unsupported-family holds or another pause on apparent native progress.

### Codex binding and one-shot query

Add optional `codexQuota: { codexHome, accountId }` to existing per-agent configuration, requiring an absolute canonical home and nonempty expected account ID. Explicit owner configuration is the binding confirmation; copy it into the issue's start configuration. No discovery from coordinator defaults, email matching, token extraction, authentication files, or rollout logs. Missing binding disables queries and leaves an owner-recoverable hold. Do not mutate the running agent's environment to make it match.

Only launch `codex app-server --listen stdio://` with that bound `CODEX_HOME`. Complete `initialize`/`initialized`, then issue read-only `account/read` and `account/rateLimits/read`; use `refreshToken: false` on account reads where supported. Request no login, model turn, subscription, token-usage query, spend mutation, or reset-credit redemption. Reject helper-initiated credential requests. Match JSON-RPC IDs, handle split/coalesced JSONL frames, ignore unrelated bounded notifications, and reject malformed required responses. Re-read identity within the same bounded helper after limits, or otherwise require a validated identity-stable protocol snapshot; an identity change invalidates the result. A missing/unsupported returned `accountId` is a capability failure, not permission to infer identity from another field.

Parse camelCase App Server fields explicitly: `rateLimitReachedType`, `windowDurationMins`, `usedPercent`, `resetsAt`. Validate finite numeric ranges and optional/null distinctions. Preserve all `rateLimitsByLimitId` buckets with both primary and secondary windows. Deduplicate the compatibility `rateLimits` by matching explicit identity; conflicting duplicate views fail closed. Do not map an opaque bucket/name to a model. Without proven applicability, report uncertainty and withhold automatic clearance. Zero spend credits with allowed ordinary usage creates no quota hold. Known provider failure types keep billing and renewable exhaustion distinct; unknown enum values remain unknown rather than a universal `usage_limit_reached` rule.

At query time, preserve every known blocking bucket/window. Recovery requires a fresh matching identity and affirmative complete evidence clearing every applicable previously blocked window, with no new applicable blockers; absent/malformed/null fields cannot count as clearance. Passing time alone does not clear a restriction. Banked reset information is omitted from the initial feature to keep scope minimal; external owner redemption is recognized only by a later authorized fresh limits check.

Enforce a ten-second total lifetime from spawn through shutdown and 256 KiB combined output cap (stdout plus stderr), including initialization and all requests. Close stdin, terminate on success/error/timeout/cap/cancellation, escalate termination within that same bounded shutdown budget, await process close, and remove listeners/timers on every path. Use injectable spawn/clock for deterministic tests. A process that cannot be proved reaped leaves an owner-only reservation; never start a second helper over it.

### Durable scheduling and scoped recovery

Store per-binding cooldown and per-action/hold episode starts, failed-query retry count, in-flight reservation identity, outstanding/consumed deadlines, and terminal budget exhaustion in cursor state. Preserve counters across hold enrichment and owner acknowledgment of the same unresolved action; only genuinely new work starts a new episode. Before any spawn, persist the reservation, consumed start, and next eligible time under existing revision/lock machinery. Crash after reservation consumes the attempt even if spawn is uncertain; restart must not silently replay it.

One helper in flight per canonical home/account binding, and no starts less than five minutes apart. Coalesce simultaneous agents/triggers sharing a binding. For concurrent issues in the same owner runtime, serialize reservations with a binding-keyed lock derived by `src/paths.ts`, and inspect/persist the relevant existing issue cursor reservations/cooldowns under that lock. Do not hold a cursor lock across subprocess I/O. Hold the binding exclusion through reap; a crash-recovered unresolved child/reservation is owner-only rather than assuming the PID is safe. A binding shared across independently managed runtime roots cannot be proven exclusive: document that unsupported arrangement and disable automatic observation until ownership is unambiguous.

Only a new correlated failure/watchdog episode, explicit initial binding configuration/check, or outstanding exact deadline plus 30 seconds authorizes observation. Initial validation is one persisted trigger, not a new read on every restart. Failed queries get at most two retries, no earlier than five then ten minutes, still subject to binding spacing and six total starts across the unresolved episode. Persist retry reservations too. Successful exhausted reads schedule only the next outstanding exact deadline. Consume each bucket/window/epoch identity before querying and never replay an unchanged or past deadline each tick; shifted resets never refill budget. Deferred reads immediately retain/create the corresponding hold; old snapshots cannot clear it. Null deadline, identity gap, unsupported mapping, or exhausted budget requires the owner. No idle polling and no subscription reconnects.

`runTick()` currently returns immediately when paused, and `run()` also exits on holds. Add an explicit observation-only path before that return: it may ingest correlated diagnostics or perform a due authorized read, but cannot prepare/reissue actions, accept completions, fetch implementation evidence, publish, or nudge. Keep the existing run loop alive only while it has authorized bounded observation work; otherwise report and return. A restarted resource-held run must not call `initializeEffects()` or attach/launch agents until normal workflow authority permits it. Use the existing loop sleep/clock, not a parallel sleeper. Manual and other holds continue blocking all workflow effects even if an independent resource observation succeeds.

Before launch and again before applying a result, fence against cursor revision, issue/action/digest, binding, session, current hold identity, and cancellation/abandonment/completion. A pause or action change during a query invalidates any previously decided release; re-evaluate under the latest revision, never resume from a cached decision. Check lifecycle revision as well so late native cancellation/session replacement cannot race a cursor-only fence. Automatic release removes only the matching cleared resource hold; local harness-gone, unobservable, delivery-uncertain, vendor ownership, manual pause, and nudge-loop holds remain unless their own authorized rule clears them. Do not promote a resource check into proof that the harness lives. No drop, handoff, action restart, pin change, synthetic completion, or send-budget refill.

Journal only new/enriched holds, meaningful evidence/ownership transitions, first terminal observation failure/budget exhaustion, and scoped release. Unchanged payloads, repeated failed reads, cooldown ticks, and statusline renders do not append recurring rows. Stable event IDs must survive append-before-cursor crashes. Reports distinguish exact recheck time from guaranteed availability and never display raw account IDs/homes or unredacted rendered errors.

## Tests

Use the smallest table-driven cases per boundary rather than one fixture tree per failure class:

1. Extend `test/agentEvent.test.ts` and `test/agentLifecycle.test.ts`: actual Claude fields survive sanitization; normal Stop/generic 429/rendered clock stay non-quota; supported window correlation versus stale, repeated, retired/cross-session/action evidence; distinct billing/auth/context/transport/cancel/unknown classes; Cursor `stop.status=error` stays unknown and `aborted` is cancellation. No-hook Cursor remains covered by existing watchdog tests.
2. Extend `test/agentHookSync.test.ts`, with one integration case each in `test/install.test.ts` and `test/cli.test.ts`: byte-exact stdin including trailing newlines and owner stdout/stderr/exit behavior; bounded failing telemetry; missing downstream; precedence ambiguity; idempotence; exact uninstall restoration; preservation of owner edits. Extend `test/doctor.test.ts` for read-only reporting. No tests touch real home settings.
3. New `test/codexQuota.test.ts`: inline sanitized identity/rate-limit tables plus fake executable stdio responses. Cover initialization/order/IDs, fragmented framing, missing/changed identity, malformed optional fields, duplicate compatibility buckets, multiple windows, unsupported mapping, zero credits with ordinary capacity, unknown types, EOF/nonzero exit/timeout/output overflow, and termination/reaping. Assert exact allowlisted RPCs and absence of turns/login/subscriptions/usage/reset-credit calls.
4. Extend `test/state.test.ts`, `test/paths.test.ts`, and `test/issueReport.test.ts`: old runtime schema defaults, absolute binding constraints, normalized safe lock key, resource-only release leaving all action safety intact, manual/other hold preservation, and bounded redacted confidence/deadline reports.
5. Extend `test/runLoop.test.ts`'s `safetyFixture`: thousands of fake-clock ticks with a fresh run-loop object each tick; one initial check, no idle polls, five-minute spacing, two delayed failure retries, six-start total, shared-binding coalescing/concurrent issue locks, crash-before/after-spawn accounting, terminal unknown child reservation, deadline+30 timing, unchanged/past/shifted epochs, and transition-only journal counts. Separate cases prove five-hour clearance cannot bypass weekly/model restrictions, missing fields cannot clear, manual pause/action replacement/native cancellation during a read cannot release, and positive validated Codex clearance removes only its resource hold. Assert unchanged roster, writer/reviser selection, reviews/ballots, pins, receipt validation, nudge budget/reservation, and unfinished work.
6. In the same loop tests, supported Claude deadlines cause one cache reevaluation with no prompt; repeated renders/missing expired fields are not fresh capacity. Native waiting, unknown ownership, cancellation/exhaustion, and unsupported family remain held. Exercise `run()` as well as `runTick()` to catch paused-start initialization and premature exit regressions.

Targeted commands during implementation: `pnpm exec vitest run --config vitest.config.ts test/codexQuota.test.ts test/agentEvent.test.ts test/agentLifecycle.test.ts test/agentHookSync.test.ts test/state.test.ts test/paths.test.ts test/runLoop.test.ts test/issueReport.test.ts test/install.test.ts test/doctor.test.ts test/cli.test.ts`.

Run `pnpm check:fast` before every commit, including the plan commit. Run full `pnpm check` (build, fast checks, e2e) before implementation acceptance. No ordinary issue-branch version bump.

Validation boundary: observed local versions are Codex CLI `0.155.1` and Claude Code `2.1.281`; local `codex app-server --help` confirms stdio transport and schema-generation commands. Attempted generation under `.codex/tmp/issue-140-app-server` was denied by this session's filesystem policy; do not claim generated schema validation. No live account queries, credentials, quota exhaustion, or settings mutations were performed while planning. During implementation revalidate installed schemas/versions and capture sanitized fixtures; any disposable live-session check requires owner approval and must not intentionally exhaust paid quota. Live recovery remains disabled for unproved version/auth/resource combinations; unit fixtures alone are not proof of live clearance semantics.

## Alternatives Rejected

- Rebuilding #126's generic circuit breaker, watchdog, or pause state: these are already implemented and remain authoritative.
- Treating statusline disappearance, token activity, authentication/Pro status, a 429, or zero credits as capacity evidence: each can produce false holds or unsafe release.
- Inferring local rendered reset dates or borrowing a five-hour deadline for a family restriction: fails locale/timezone and resource identity safety.
- Disabling native Claude continue or sending a continuation to refresh telemetry: violates native ownership and spends work to discover capacity.
- Codex subscriptions, long-lived App Servers, rollout/private billing readers, `account/usage/read`, credit consumption, and periodic polling: unauthorized and unnecessary for this bounded observer.
- Calling owner `releaseHold` for automation or globally unpausing: owner acknowledgment mutates safety fields and is broader than resource clearance.
- A new scheduler/database/provider framework or many new fixture files: existing cursor/lifecycle state, locks, loop, and test fixtures suffice.

## Risks and Mitigations

- **Unavailable identity and evolving vendor schemas:** capability-check returned fields every query; unsupported identity and enum/mapping gaps fail closed. A feature that only enriches an owner hold on an unsupported installation is correct, not grounds for inferring identity.
- **Claude cached renders are not fresh service checks:** distinguish render receipt from provider freshness, never refresh age from an identical payload, and retain owner release where fresh capacity cannot be proven.
- **Owner settings shadowed by a tee:** require proven effective-command precedence, preserve the original layer, byte streams and exit behavior, inspect drift, and do not install on ambiguity.
- **New observation path weakens whole-issue pause:** keep it explicitly separate from `authority()`-guarded workflow effects; test both runner entry points and races. A successful read does not authorize a send or mutate selection.
- **Restart/concurrency replenishes budgets:** durable pre-spawn reservations, binding-keyed exclusion, persisted cooldowns/consumed epochs, and action-episode identities independent of error wording. Unknown orphan state requires owner intervention.
- **Oversized or sensitive data:** bound input copies, helper output, persisted diagnostics and observation counts; never persist credentials/raw transcripts. Redact before journaling/reporting.
- **False recovery through partial windows:** preserve all blockers, demand complete fresh matching clearance, and never guess model-to-bucket mappings. Missing evidence is not cleared evidence.

## Conclusion

Deliver a vendor-evidence layer inside the existing safety runtime: ownership-preserving Claude telemetry, strict bounded Codex reads, conservative Cursor diagnostics, and resource-scoped recovery only when proof exists. Antigravity retains #126's generic protections with no new classifier. No speculative Claude continuation, settings mutation to disable waiting, background monitor, paid model probe, or workflow ownership transfer is part of this plan.

Sources checked for adapter planning: [official OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server) describes the initialized account/limits surface; [Claude StopFailure](https://code.claude.com/docs/en/hooks#stopfailure) documents the actual failure fields; [Claude statusline](https://code.claude.com/docs/en/statusline#rate-limit-usage) documents supported epoch fields and independently missing/expired windows; [Claude native waiting](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset) documents native continuation/cancellation. These establish interface candidates, not validation of this installation's live account identity or automatic recovery.
