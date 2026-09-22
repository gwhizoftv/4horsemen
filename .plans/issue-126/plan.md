# Issue 126 — stop repeated nudges and unbounded deferral journals first

## Authority and objective

Owner-requested manual plan on `issue-126/codex`. This revision incorporates
Cursor findings 1–4 and Claude R1–R7 supplied in chat. It supersedes `aab218a`
where that plan preferred disabling Claude's waiter, parsing rendered deadlines,
or subscribing to Codex notifications. The owner's latest feedback and the
dispositions below supersede those parts of the earlier
[issue comment](https://github.com/gwhizoftv/coordination/issues/126#issuecomment-5763600731).
No implementation is approved by this document. Do not fabricate action,
signal, review, or completion files.

Two immediate defects are independent: `journalDeferral` appends every tick
although its in-memory map deduplicates only stdout; each fresh idle/failed
epoch can authorize another nudge. Fix both before vendor integration.
Preserve roster, required writer/reviewer roles, accepted pins, current actions,
and dirty work. An unavailable agent is not a dropped agent.

## Exact File List to be changed or deleted

No deletions. Only this plan changes in the review submission. The complete
implementation map follows; stages are independently reviewable below.

| File | Stage | Change |
| --- | --- | --- |
| `src/runLoop.ts` | 1–3 | Durable dedupe before `journalDeferral` append; central nudge reservation; later held observation/recovery and bounded process/watchdog checks. |
| `src/state.ts` | 1–3 | Deferral keys, nudge budgets/latches, pause ownership, journal idempotency; later resource holds/probe budgets and optional minimal Codex binding in agent config. |
| `src/cli.ts` | 1–3 | Scoped release/budget reset and accurate paused output; later vendor evidence routing without launch-setting mutation. |
| `test/runLoop.test.ts` | 1–3 | Journal growth/restart, all nudge paths, role fences, probe budgets and silent-death fixtures. |
| `test/state.test.ts` | 1–3 | Compatibility, persistent dedupe/reservations, crash recovery, independent holds and probe caps. |
| `test/cli.test.ts` | 1–3 | Manual pause versus scoped release, explicit budget reset and unchanged action/roster authority. |
| `src/issueReport.ts` | 2–3 | Holds, unknown deadlines/causes, retry owner, budgets and owner recovery instructions. |
| `test/issueReport.test.ts` | 2–3 | Redacted reports, null deadlines and unavailable telemetry. |
| `src/tmux.ts` | 2 | Claude live wait/quota veto before positive prompt/sentinel checks and at last send boundary. |
| `test/tmux.test.ts` | 2 | Wait/menu/cancellation with visible prompts; stale quotes; last-moment refusal. |
| `src/agentLifecycle.ts` | 3 | Bounded correlated failure/telemetry cache and freshness, retaining lifecycle locks. |
| `test/agentLifecycle.test.ts` | 3 | Current/retired session and action correlation; stale telemetry. |
| `src/agentEvent.ts` | 3 | Preserve actual failure fields, correlate observations and feed holds without fabricated launcher provenance. |
| `test/agentEvent.test.ts` | 3 | Claude/Cursor field contracts and matching evidence in existing runtime fixtures. |
| `src/agentHookSync.ts` | 3 | Ownership-preserving Claude statusline tee/cache install, inspect and remove; no retry-setting changes. |
| `test/agentHookSync.test.ts` | 3 | Tee stdin/stdout, inherited owner settings, idempotence, dry-run and uninstall. |
| `docs/coord-driver.md` | 2–3 | Owner recovery, absolute deadlines, hard budgets, limitations and staged delivery. |

Remove `scripts/lib/launcher.sh` and `test/install.test.ts` from the prior map.
Existing install tests still run in the required suite. No launcher recorder,
`--settings` injection, product `githooks/` change, dependency change, AGENTS.md
edit, index-flag change, ballot-denominator change or ownership handoff.
`src/machine.ts` keeps using effective aggregate `cursors.paused`; preserve
aggregate `paused`/`resumed` journal semantics for existing analytics.

## Exact file list to be created

None in stages 1–2. Stage 3 adds only:

| File | Justification |
| --- | --- |
| `src/agentResource.ts` | Small pure vendor classification/window-matching policy shared by hooks and run loop; not a framework or breaker dependency. |
| `test/agentResource.test.ts` | Table-driven evidence/deadline cases with inline sanitized fixtures. |
| `src/codexRateLimits.ts` | One-shot read-only query with fixed timeout/output bounds; no subscription/connection manager. |
| `test/codexRateLimits.test.ts` | Fake subprocess/response tests; no paid calls or account credentials. |

This plan exists and is revised in place. Extend existing `cursors.json` and
`agent-lifecycle.json`; no new persistent file family or fixture directory.

## Reuse and Scope

Reuse `CoordinatorRunLoop.journalDeferral`, initial delivery,
`maybeLifecycleNudge`, `authority`, `mutate`, `runTick`, `run` and injected
`now`/`sleep`. Reuse `decideLifecycleNudge`, `markObservabilityDegraded`,
`readAgentLifecycle` and existing action/pin/completion validation.

Reuse `cursorsStateSchema`, `setPaused`, `mutateCursorsState`,
`requireStateMutation`, `atomicWriteJson`, `appendJournal` and `readJournal`.
Extend the existing `decision-derived` idempotent-append pattern narrowly to
deferral identities; do not invent a transactional storage framework.

Reuse `TmuxController.inspectPane`, `capturePane`, `nudge`,
`harnessPromptReadiness`, `stripAnsi` and existing effect fences.
For enrichment reuse `normalizeAgentEvent`, `handleAgentEvent`,
`extractPromptActionIdentity`, `observeAgentLifecycleWithResult`,
`mutateAgentLifecycle`, hook sync/inspect/remove entry points and Antigravity's
statusline ownership pattern, without altering its vendor behavior.

Extend the run-loop `fixture`, accepted-response/ballot helpers, agent-event
`runtimeFixture`, hook-sync `fixture`, state/CLI/report fixtures and tmux
`promptFor`, `runnerWithPrompt`, `ok`, `noopSleep`.

**Cadence versus observability:** `NUDGE_RETRY_MS` aliases
`AGENT_OBSERVABILITY_WATCHDOG_MS` (45,000 ms). The deprecated `nudgeRetryMs`
injection sets `observabilityWatchdogMs`; its documented meaning is not resend
authority. Retain that behavior. Add one local policy constant in runLoop:
`NUDGE_REPEAT_DELAYS_MS = [60_000, 120_000, 240_000]`, not a user tuning option.
A diagnostic override must not shorten delivery protection. Test with the
existing injected clock and explicitly test independence from `nudgeRetryMs`.

### 1. First implementation commit: dedupe and breaker alone

Files: `src/runLoop.ts`, `src/state.ts`, `src/cli.ts` and their existing tests.
No new modules, vendor evidence, launcher, installer, statusline or App Server
dependency. This commit must independently stop recurring journals and
unlimited nudges and be safe to ship before stages 2–3.

**Fix journalDeferral itself.**
- Check a durable `(agent, actionId, code)` key **before appendJournal**.
  `loggedDeferral` currently gates stdout only; it is not durable authority.
- Persist seen keys per outstanding action in cursors under the cursor lock.
  Emit each code once per action: A → B → A appends only A and B. Timestamps,
  detail text, or a digest rewrite do not create a new key. Dynamic diagnostic
  values belong in details under a fixed code, not novel codes.
- Scope the deterministic append identity by issue session and that tuple.
  Extend journal-locked idempotency so a crash after append but before cursor
  replacement cannot duplicate it. Reconcile once at restart; never reread a
  multi-day journal every tick.
- Return/thread updated cursor revisions through callers so dedupe writes do
  not create stale effect authority. Repeated identical deferrals perform no
  cursor writes, append, or repeated stdout/verbose output.
- Bound keys to the fixed coordinator code set plus one unknown-code bucket.
  Prune current-action summaries on validated completion/authorized replacement,
  keeping audit history. No periodic journal reminders; status is on-demand.
  Meaningful hold create/change/release events provide subsequent transitions.

**Vendor-independent breaker, explicitly including Antigravity.**
Every configured agent uses it; Antigravity receives no quota classifier here.
Initial delivery, lifecycle repeats, reissue, lost/ambiguous delivery recovery
and later post-reset continuation pass one reservation path.

- Permit initial delivery plus at most **three automatic repeat nudges** for the
  same unfinished action, at minimum **60/120/240 seconds** after the preceding
  send. Longer valid provider delays win; jitter cannot reduce minima. Time
  removes a spacing restriction only, never creates send eligibility.
- If the third repeat returns idle/failed without validated completion, latch a
  `nudge-loop` pause before a fourth repeat. Do not interrupt an attempt still
  working. Missing transitions are stage 2's observation concern, not quota proof.
- Persist count, last/next-send time and one in-flight reservation before sending.
  Definitively unsent readiness/busy outcomes refund it; ambiguous/partial sends
  retain it pending reconciliation. Concurrent ticks cannot reserve twice.
- Restarts, CLI reconnects, idle epochs, failure wording, digest rewrites,
  cosmetic progress or other-agent progress never reset counts. Automatic
  reissue carries the budget even if its representation/ID changes. Retire only
  on validated completion/new authorized work or audited owner reauthorization.
- A later confirmed blocking failure pauses immediately, not after three more
  probes. A breaker trip has unknown cause, not confirmed exhausted quota.
- Stage 1 needs only manual-pause ownership, nudge latches, reservations and
  dedupe keys. Keep paused aggregate; adopt legacy paused=true as manual.
  A latch increments cursor revision and stops decisions/publication through
  existing fences, without changing actions, roster, pins or dirty work.
- Plain resume clears manual ownership only. Support
  `coord resume --hold <id> --reset-nudge-budget` for one current nudge latch;
  audit the reset, preserve other/manual holds and reject expired actions or
  cancellation. Print this recovery instruction once when latching.

### 2. Second implementation commit: holds, pane guard and silent death

Generalize the first commit's pause ownership without weakening its breaker.
Add reports/docs and local guards; still no vendor network traffic.

**Durable holds:** paused = manualPaused OR any active hold. Persist reason,
agent/resource/action/session identity, evidence ID, observed time, nullable
deadline, separate classification/deadline confidence, retry owner and budgets.
Plain resume clears manual pause; `resume --hold <id>` releases only that hold,
with the extra explicit reset flag for nudge latches. Audit releases and suppress
the identical prior evidence; a genuinely new failure can re-hold.

No roster shrink, writer/reviser transfer, implied review/ballot approval,
cleanup, synthetic completion, gate advancement, PR or finalization while held.
Retain arriving artifact/response bytes, record intent once, and validate through
existing paths after recovery. Pausing workflow authority does not stop already
running vendor processes. Recheck authority after awaits and before effects.

**Claude pane guard:** before prompt/mode/sentinel readiness, reject active
usage-limit/wait/menu and cancelled/stopped-wait UI; recheck at the last send
boundary. Distinguish active chrome from quoted scrollback; ambiguity defers.
Banner disappearance cannot release a hold. Do not change any retry setting.

**Cursor silent death is a primary detection path, not a hook footnote.**
Check unfinished action evidence and process/readiness even if cached lifecycle
says working. Do not wait forever for Stop or for the nudge count to increase.
- Missing/dead harness with unfinished required work creates an unknown hold
  immediately; retain already-arrived artifacts without advancing the gate.
- After the existing observability watchdog reports missing/stale correlation,
  inspect process/readiness at most once per **60 seconds**, at most **three
  checks** per unresolved episode. Persist budget/episode across restart.
- Also start that bounded inspection episode for an already-accepted action
  with **five minutes without fresh lifecycle or observable process activity**.
  This check is independent of delivery correlation: a historical working flag
  must not prevent it from running. Replayed old callbacks do not reset freshness;
  absence of terminal output alone does not prove a dead process or quota.
- If correlation/process/readiness remains unavailable or current activity
  cannot be established, latch unknown/unobservable and notify once. No quota
  label, no prompt to test liveness, and no unlimited retries.
- Fresh working/background lifecycle evidence is not failure. A static old
  working flag is not an eternal heartbeat. Insufficient observability can
  conservatively pause a long-running task; leave process/work intact and
  explain the uncertainty rather than claiming exhaustion.
- Only when observed, distinguish stop.status=error from aborted/cancellation.
  Authenticated/Pro metadata is never capacity. Reject Admin API/SQLite, guessed
  billing-cycle resets and a new headless-launch integration.

These local missing-evidence safeguards cover all agents; Cursor's incomplete
hook delivery makes explicit no-hook/stuck-working tests mandatory.

### 3. Third stage: small vendor evidence adapters

Separate reviewable increments after stages 1–2. Enrichment improves reasons
and measured recovery but cannot delay the first-stage symptom fix.

**Shared policy:** distinguish renewable windows, billing/spend, temporary
throttling, context overflow, auth/account hold, cancellation, transport and
unknown. Generic 429, Stop, silence, token counts, zero credits or reset times
alone do not establish exhaustion. Match account/session/action and reject
retired/stale/unrelated observations. Redact bounded errors. Deduplication must
not reset budgets. Avoid nested lifecycle/cursor locks; revalidate identity under
cursor authority. Provider absolute epochs are the only exact quota deadlines.

**Claude: failure context versus absolute deadline outcomes.**
Preserve StopFailure.error, optional error_details and last_assistant_message.
The last is rendered API error context; do not invent error_type/error_message.
Store it redacted for reports, never parse its local time into a deadline.
- A classified matching session/five-hour or weekly failure may use fresh
  rate_limits.five_hour.resets_at or seven_day.resets_at Unix epochs as exact
  recheck deadlines. Keep every applicable exhausted window.
- Opus/Sonnet/other unsupported family or bucket → resetsAt:null, notify, owner
  release. Do not borrow a general window's epoch for that family failure.
  Missing/stale/mismatched telemetry also means null. No date/locale/DST parser.
- The statusline tee exists specifically to obtain supported absolute epochs.
  Preserve effective owner command, stdin/stdout and ownership on uninstall;
  cache bounded matching session/window evidence. Rendering again is not proof
  of a fresh provider fetch.

Retry owner defaults to vendor when interactive auto-continue is effectively on
or a native wait is observed. Coord holds advancement and sends no competing
prompt. Verified effective off is necessary for coordinator ownership; unknown
ownership means owner/no retry. Read existing effective-setting evidence only;
do not implement a configuration rewriter. This reduced first version adds no
autonomous Claude recovery prompts: with native waiting off, coord re-evaluates
evidence at a known deadline, then retains the hold for the owner if unresolved.
Native cancellation/exhaustion never triggers automatic takeover.

At an exact epoch +30 seconds, re-evaluate matching evidence once. Never prompt
Claude just to refresh telemetry. Elapsed time, a stale low percentage, a gone
banner or native activity alone cannot clear manual/other/unsupported-family
holds. Preserve arriving work while native continuation proceeds.
[Claude hooks](https://code.claude.com/docs/en/hooks#stopfailure),
[statusline](https://code.claude.com/docs/en/statusline#rate-limit-usage),
[native waiting](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset).

**Codex: bounded one-shot query and minimal explicit binding.**
Use initialized `codex app-server --listen stdio://`, account/read and
account/rateLimits/read, then close it. No model turn, login, credit redemption,
usage polling or notification subscription. Account identity fields are
capability-checked, not guaranteed across versions/auth modes.
[Official OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server).

Add an optional owner-confirmed binding in existing per-agent config: absolute
CODEX_HOME plus expected accountId, snapshotted with issue agent config.
Query with that home, compare returned identity every time, invalidate on
missing/change. No launcher recorder or executable/profile provenance system.
If the home/account cannot be matched to the monitored agent, do not substitute
coordinator defaults: unknown/owner recovery. Never extract credentials. The
narrow supported path does not claim home selects every possible auth mode.

Parse App Server rateLimitReachedType, windowDurationMins, usedPercent and
resetsAt explicitly. No rollout reader or universal usage_limit_reached marker;
reject rollout-shaped input instead of casing conversion. Keep all applicable
rateLimitsByLimitId buckets and primary/secondary windows, deduplicating the
compatibility rateLimits view. Missing fields do not clear holds; do not infer
model mapping from opaque bucket IDs/labels. Unknown applicability prevents
unsupported release. Zero spending credits with ordinary usage allowed is not
a hold. Only fresh clearance of all applicable restrictions permits release.

**Fixed observation caps, tested with injected time:**
- Zero periodic idle polling; no persistent App Server connection.
- Trigger only for new correlated failure/watchdog episodes, an authorized
  initial binding check, or outstanding exact hold deadline + **30 seconds**.
- Coalesce by account/home: **one helper in flight**, no more than **one start
  per five minutes**. A new failure inside that interval holds immediately and
  defers the read; a pre-failure snapshot cannot establish recovery.
- A failed query has at most **two retries**, no sooner than 5 then 10 minutes.
  Across detection and deadlines, at most **six helper starts per unresolved
  action/hold episode**, counting startup failures/timeouts. Persist reservation,
  attempts and due times before spawning. Restart, wording changes or shifted
  deadlines cannot replenish it.
- An exhausted successful read schedules only its next outstanding exact
  deadline, not interval polling. Do not replay a past/unchanged deadline each
  tick. Null deadline, exhausted budget or unresolved identity → owner.
- **10-second** total helper timeout, **256 KiB** output limit; terminate/reap on
  timeout, failure or completion. Subscription reconnect budget is **zero**.
- Transition-only journals: hold/reason change/release or budget exhausted.
  Unchanged observations, failure retries and deferrals do not create periodic
  rows. Store diagnostic/budget updates in state; report on demand.

Run due observations before runTick's pause return. Held run mode does only
due observations and owner-state checks, sleeping between them; no normal
effect initialization, dispatch, or per-second journal. Preserve manual-only
pause behavior. Read-only checks are not nudges. A normal continuation after
fresh resource clearance still obeys all remaining holds, lifecycle eligibility
and shared nudge budget. No special model-send bypass of aggregate pause.

Display banked-reset availability only if already returned by the bounded read;
unknown differs from zero. This is optional polish, not a stage 1/2 acceptance
blocker. Consumption stays an external owner action; even after external
redemption, recheck matching limits before release. Notification subscriptions
are deferred until a separate spike demonstrates cross-process/idle-reset
delivery; no spike or connection manager ships here.

## Tests

Use existing fixtures, inline sanitized cases and fake clocks. No intentional
quota exhaustion, paid requests or credentials in CI.

**Stage 1 independently shippable acceptance:**
1. Thousands of identical journalDeferral calls append one tuple row, including
   after restart. A → B → A appends two; changed detail/digest does not defeat
   dedupe. Crash between append/cursor replacement stays idempotent. Repeats
   cause no cursor writes or stdout/verbose flood.
2. Initial delivery plus three unsuccessful repeats never sends a fourth;
   unchanged roster/action/work/pins, no gate/finalization. Exercise every send,
   reissue and lost-send path, concurrent reservations, unsent refund, ambiguous
   sends and restart. Do not interrupt a working third attempt.
3. Enforce 60/120/240 minima and longer provider delay. The 45-second watchdog/
   injected nudgeRetryMs does not authorize or accelerate a send. Idle epochs,
   failure wording and session reconnects cannot replenish the budget.
4. Same breaker for Codex, Claude, Cursor and Antigravity without adapters.
   Manual pause survives latch/release; reset is scoped and audited; old state
   adopts paused as manual.

**Stages 2–3 acceptance:**
5. Selected implementer/reviser held with two peers: no roster shrink, transfer,
   implicit review/ballot approval, advancement or publication. Preserve arrivals
   and validate after recovery; reject stale actions.
6. Claude live wait/menu/cancelled/stopped chrome beats prompt/sentinel, including
   a last-send race; quoted scrollback alone does not. Settings unchanged;
   native continuation/exhaustion/cancellation never causes competing nudges.
7. Cursor dead process with no hook, static historical working state and missing
   readiness reach bounded unknown holds. Fresh working signals are not quota.
   Check inspection caps/restart and independence from nudge count.
8. Rendered resets 3:45pm never becomes exact, regardless of host clock/locale.
   Only matching fresh supported session/weekly Unix epochs schedule rechecks;
   family failures and stale/missing telemetry do not. Preserve tee ownership.
9. Codex missing/changed/matching account IDs and homes, optional fields, zero
   credits with ordinary usage allowed, every applicable window and unknown
   model mapping fail safely. No cross-parsing of rollout shapes, subscription,
   model request or account-mutating method.
10. Thousands of ticks/restarts enforce one helper, five-minute spacing, two
    retries, six starts per episode, one deadline opportunity, timeout/output
    caps and transition-only journal. Five-hour recovery cannot bypass weekly.
11. Separate billing/throttling/context/auth/cancel/transport/unknown paths.
    An exact deadline alone does not release; owner/recheck races cannot replace
    a newer pause. Plain/scoped resume cannot replenish a nudge latch.
12. Reports redact sensitive data and show null deadlines/recovery instructions.
    If banked resets are displayed, assert no consume call and recheck after
    externally changed availability.

Commands (new tests run only once their stage creates them):

```sh
# Stage 1 focus
pnpm exec vitest run --config vitest.config.ts test/state.test.ts test/runLoop.test.ts test/cli.test.ts
# Additional stages 2–3 focus
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts test/issueReport.test.ts test/agentLifecycle.test.ts test/agentEvent.test.ts test/agentHookSync.test.ts test/agentResource.test.ts test/codexRateLimits.test.ts
# Before every commit, including plan commits
pnpm check:fast
# Before accepting each independently shippable implementation stage
pnpm check
```

Full check builds TypeScript and runs fast checks plus integration e2e.
No version bump on ordinary issue-branch commits. Live adapter checks require
owner-approved disposable sessions and version-labeled sanitized observations;
unproved automatic recovery remains disabled. Plan review does not claim the
new adapters/tests already exist or pass.

## Alternatives Rejected

- Waiting for provider integrations before fixing the loop: ship six-file dedupe/
  breaker first.
- Stdout-only maps or frequency limits alone: neither bounds journal growth
  across restart or total repeated sends.
- Wall-clock reset parsing, disabling Claude's waiter, or automatic takeover:
  use absolute epochs and native ownership without launch-setting mutations.
- Notification connection manager without delivery proof: one-shot capped reads
  suffice; no subscription/reconnect storm.
- Private rollout/SQLite/billing scraping, model probes, auto redemption/spend,
  new headless mode or automatic drop/handoff: out of scope.

## Risks and Mitigations

- **Crash races:** cursor locking plus narrowly idempotent deferral appends;
  test append-before-replacement and reservation-before-send.
- **Conservative false pauses:** insufficient observability or three legitimate
  repeats can need owner attention. Preserve process/work and report uncertainty,
  never keep nudging because classification was unavailable.
- **Native work during pause:** coord fences advancement, not vendor execution;
  retain arrivals/manual holds and do not promise to stop a native wait.
- **Identity/telemetry gaps:** optional/mismatched fields stay unknown. Minimal
  bindings must still match the actual monitored resource.
- **Stale Claude cache at deadline:** no prompt to refresh it; keep hold for
  native recovery evidence or explicit owner release.
- **Scope:** first commit has six existing files only; no launch changes,
  subscriptions, date parsers or Antigravity classifier. Expand the map only
  through a reviewed amendment.

## Conclusion

Ship journal dedupe and the vendor-independent breaker first, then durable
holds/pane/silent-death safety, then bounded vendor enrichment. Use only provider
epochs as exact deadlines, preserve Claude's waiter, and cap one-shot Codex
reads over the entire unresolved episode. Preserve workflow roles and work.
Review this revised plan before implementation.

## Feedback not accepted as written, and rationale

All Cursor findings 1–4 are accepted. Claude R1–R4 and R6 are accepted, including
staged delivery, Antigravity breaker coverage, removal of launcher changes and
deferral of subscriptions. Claude R7 is accepted through its offered alternative
of explicitly justifying a separate cadence constant. These narrow parts are
not adopted literally:

1. **Claude R5: CODEX_HOME as the sole account selector and accountId guaranteed
   in every limits response.** Accept the home + accountId simplification and
   remove launcher provenance. Do not infer that home alone proves the monitored
   identity or every version/mode supplies it: official App Server documentation
   includes external-token and other auth modes. Require an owner-confirmed
   binding and capability-check returned identity; missing/mismatch means owner
   recovery. This is a small guard, not restoration of the provenance system.

2. **Claude R7: derive delivery cadence from the 45-second knob.** Do not choose
   that option. Source comments explicitly make it an observability watchdog
   and deprecate the retry name. Coupling it to send spacing lets a diagnostic/
   test override silently shorten protection. Keep justified fixed 60/120/240
   minima without adding a configurable tuning knob.
