# Issue 126 — classified agent failures and durable resource holds

## Authority and objective

Owner-requested manual plan on intended branch `issue-126/codex`. This plan is
explicitly requested for review; it is not a fabricated coordinator action.
Do not create signals, reviews, action files, or completion markers.

The controlling requirements are the owner's
[corrected issue comment](https://github.com/gwhizoftv/coordination/issues/126#issuecomment-5763600731),
not the superseded rollout-first recommendation in the issue body. Repository
baseline inspected: `ae991b81ba3508b3ef233d2392b88e9eb0569ad1`.

Revision dated 2026-09-22: incorporate the comment's corrected Claude fields,
explicit retry ownership and pane veto, Codex source-specific/multi-window
evidence, notification capability checks, reset-credit visibility, and a shared
nudge circuit breaker. This supersedes the plan submitted at `d816d7e`.

An unavailable agent remains in the roster. Preserve its unfinished work and
pause issue advancement; two available agents do not authorize continuation,
replacement of the selected writer, or approval of missing work. Implement
classification, durable whole-issue holds, bounded observation, safe recovery,
and protection against repeated nudges even when failure classification is absent.

## Exact File List to be changed or deleted

No deletions. Implementation changes are limited to:

| File | Change |
| --- | --- |
| `src/state.ts` | Resource evidence/window-set hold schemas, backward-compatible pause ownership, atomic hold transitions, persistent per-action nudge budgets/reservations, and journal event types. |
| `src/agentLifecycle.ts` | Bounded per-session evidence cache, observation provenance and cancellation/failure detail; retain existing action correlation and lifecycle locking. |
| `src/agentEvent.ts` | Preserve classified errors and Claude's rendered StopFailure message, accept supplemental telemetry and launch provenance, correlate evidence, and install holds without granting workflow completion authority. |
| `src/agentHookSync.ts` | Install/inspect/remove an ownership-aware Claude statusline multiplexer through existing lifecycle-hook entry points; preserve effective owner statusline and output. |
| `scripts/lib/launcher.sh` | Record non-secret Codex launch context before `exec`; apply and identify Claude's coordinator-owned retry setting only in managed issue launches, respecting precedence; no Git-wrapper or permission changes. |
| `src/runLoop.ts` | Observation/recovery scheduling before pause early returns, shared send reservation across all nudge paths, and bounded missing-evidence handling; gate normal effects while held. |
| `src/tmux.ts` | Veto Claude quota/native-wait UI before positive prompt/sentinel readiness, including the last pre-send readiness check. |
| `src/cli.ts` | Scoped owner hold-release and explicit nudge-budget-reset flags, accurate pause/resume output, and hook ingestion for launch context. |
| `src/issueReport.ts` | Display pause owners, affected windows, retry owner, deadline/unknown state, nudge count/spacing, banked-reset availability, and owner recovery instructions. |
| `docs/coord-driver.md` | Document evidence limits, whole-issue pause/recovery, retry ownership, restart behavior, and operational validation. |
| `test/state.test.ts` | Legacy pause adoption, independent holds, locked/revisioned mutation, deduplication, and persistent retry budgets. |
| `test/agentLifecycle.test.ts` | Session/action freshness, retired-session rejection, cancellation, and cached telemetry behavior. |
| `test/agentEvent.test.ts` | Vendor classification and matching-evidence tests using the existing runtime fixture. |
| `test/agentHookSync.test.ts` | Claude statusline preservation, stdin/stdout forwarding, install idempotence, inspect, dry-run, and safe removal. |
| `test/install.test.ts` | Generated launch-context provenance using the existing stub-harness launcher tests, and unchanged launcher safety behavior. |
| `test/runLoop.test.ts` | Held-role safety, bounded scheduling, native retry ownership, arrivals while paused, restart, and recovery races. |
| `test/tmux.test.ts` | Claude wait/menu/cancelled/stopped UI versus visible prompts/sentinels; current UI versus quoted scrollback; veto on recapture before send. |
| `test/cli.test.ts` | Manual pause and targeted hold release, invalid/stale release IDs, and unaffected owner commands. |
| `test/issueReport.test.ts` | Owner-facing held/unknown/recovering reports without credentials or raw payload leakage. |

`src/machine.ts` continues to use `cursors.paused`: that field remains the
effective aggregate pause, not merely the manual flag. No machine protocol,
ballot denominator, derived-decision identity, or finalization policy changes.
Existing `paused`/`resumed` journal events remain aggregate transitions so
analytics need no new interpretation. No product `githooks/` changes.

## Exact file list to be created

| File | Justification |
| --- | --- |
| `.plans/issue-126/plan.md` | This owner-requested review artifact; the only file in the plan submission. |
| `src/agentResource.ts` | Pure classification, evidence matching, window-set blocking decisions, and retry/nudge-budget eligibility shared by hooks and coordinator; avoids vendor policy in workflow decisions. |
| `src/codexRateLimits.ts` | Bounded read-only App Server adapter with optional connection-scoped notifications; isolates source schema, framing, identity/freshness checks, timeouts, and cleanup. |
| `test/agentResource.test.ts` | Table-driven policy cases for the new pure module, with inline sanitized fixtures. |
| `test/codexRateLimits.test.ts` | Fake subprocess/protocol tests; no paid model requests or account dependencies in CI. |

No new dependencies, daemon, generic adapter framework, fixture directory,
headless launch mode, or persistent file family. Evidence cache extends existing
`agent-lifecycle.json`; workflow-authoritative holds extend `cursors.json`.

## Reuse and Scope

Reuse `normalizeAgentEvent`, `handleAgentEvent`, `extractPromptActionIdentity`,
`observeAgentLifecycleWithResult`, `applyLifecycleObservation`,
`mutateAgentLifecycle`, and `decideLifecycleNudge`. Preserve their distinction
between lifecycle evidence and accepted workflow artifacts.

Reuse `cursorsStateSchema`, `setPaused`, `mutateCursorsState`,
`requireStateMutation`, `atomicWriteJson`, and `appendJournal` for durable
authority. Extend, rather than bypass, `CoordinatorRunLoop.authority`, `runTick`,
`run`, and the injected `now`/`sleep` dependencies. Reuse current immutable pin,
response, completion, and finalization validation unchanged after recovery.
Consolidate the existing initial-delivery and lifecycle/reissue send sites behind
one reservation path; reuse `TmuxController.nudge`, `harnessPromptReadiness`,
`stripAnsi`, and existing live-pane/authority checks rather than adding a second
terminal transport. Extend `promptFor`, `runnerWithPrompt`, `ok`, and `noopSleep`
in `test/tmux.test.ts` for focused wait-banner and send-race fixtures.

Reuse `syncAgentLifecycleHooks`, `removeAgentLifecycleHooks`, and
`inspectAgentLifecycleHooks` as install lifecycle boundaries, plus the existing
Antigravity multiplexer ownership/manifest pattern. Keep Antigravity behavior
unchanged. Resolve Claude's effective existing statusline, including inherited
user settings, rather than assuming the local settings file is the full config;
refuse unsupported configurations instead of silently replacing their output.

Extend `runtimeFixture` in `test/agentEvent.test.ts`, the existing hook-sync
`fixture`, and the run-loop fixture/accepted-response/ballot-batch helpers. Use
the existing state/CLI/report fixtures and fake clocks. New tests keep provider
payloads inline, mark synthetic cases as synthetic, and never save credentials.

### 1. Evidence and classifications

Replace the issue body's overloaded quota object with separately validated
evidence and recovery policy. Each observation identifies vendor, agent,
session/turn, action ID/digest when applicable, account/resource binding,
source, evidence ID, observation time, and provider-data freshness if known.
Keep nullable reset/retry times and separate classification confidence from
deadline confidence. Raw errors are size-bounded and redacted.

Classify renewable usage-window exhaustion, billing/spend exhaustion,
temporary throttling, context overflow, authentication/account hold,
cancellation, transport failure, and unknown failure distinctly. A generic 429
is not automatically a renewable quota event. `insufficient_quota` is not a
measured zero balance. Silence, token counts, a reset timestamp, normal Stop,
or a regex hint alone never establish exhaustion or authorize continuation.

Match evidence before mutating workflow state. Reject stale actions, retired
sessions, unrelated accounts, future observation times, malformed deadlines,
and older observations; legitimate future reset deadlines remain valid;
deduplicate the same failure rather than resetting its retry budget. A shared
account result may affect several matched agents, but cannot clear unrelated
holds. Cache writes and cursor writes must not nest locks; revalidate current
action/session and evidence identity under the cursor mutation before applying.

### 2. Codex supported account reader

Use `codex app-server --listen stdio://`, initialize/initialized, then
`account/read` and `account/rateLimits/read`; do not start a model turn. Use the
documented multi-bucket limits when present and inspect every applicable window.
The official contract and notifications are described in
[Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

Bind the helper to the actual launch executable, cwd, home/config/profile and
authentication mode, not the coordinator's default account. Generated launchers
record non-secret context through the existing event command; hooks bind it to
the running session. Custom launchers without verifiable provenance remain
unverified, with no account-based automatic release. Detect configuration or
account changes across observations and invalidate the previous binding.
Never copy credential values into runtime evidence or the journal.

The corrected comment reports a successful account read on CLI 0.155.1; this
plan does not claim to have repeated it. Its `ordinaryUsageAllowed` and spend
fields are version-observed capabilities, not guaranteed universal fields.
Zero credits while ordinary usage is allowed must not create a hold. Unknown
fields/modes remain unknown; request failures still matter after a successful
account read. Unsupported or failed queries get bounded backoff, not login,
credit purchases, or model-call probes. Bound output bytes and handshake/read
timeouts; always clean up the helper process.

Parse the App Server contract explicitly: `rateLimitReachedType`,
`windowDurationMins`, `usedPercent`, and `resetsAt`. The owner's corpus report
instead identifies rollout `rate_limit_reached_type` and `window_minutes`;
`usage_limit_reached` is not a verified universal rollout trigger. Do not build
a shared casing-conversion parser or scan quoted issue text for failure markers.
No rollout reader ships here. Any later fallback needs its own version-tested
parser before normalization; tests ensure rollout-shaped records cannot be
misread as valid App Server availability.

Store a set of `(account/resource, bucket, window)` observations/holds, each with
its own deadline and confidence. Reconcile the compatibility `rateLimits` view
with `rateLimitsByLimitId` without counting one bucket twice; retain primary
and secondary windows. A partial notification updates only its named scope,
never deleting other holds. Do not infer clearance from absent fields.
[openai/codex#36432](https://github.com/openai/codex/issues/36432) reports the
model-to-bucket mapping gap; do not hard-code `codex_bengalfox` or derive model
applicability from display labels. Unknown relevance cannot justify releasing
a known failure hold, nor prove that every unrelated model bucket blocks this
agent. Require fresh clearance of every applicable window and restriction.

Use `account/rateLimits/updated` on a matching live helper connection when
available. Verify delivery for a separately running monitored CLI, including
idle resets; the existence of the method does not prove cross-process coverage.
Keep bounded reads at startup/reconnect, relevant failures, deadlines, and stale
feed detection. Limit connection lifetimes/reconnect attempts, deduplicate
events, and retain holds after disconnect. No new background daemon is needed.

Surface `rateLimitResetCredits.availableCount` (unknown is not zero) as an owner
recovery option. Banked resets are distinct from ordinary spending credits.
For this first shipment, the adapter remains read-only: it never invokes
`account/rateLimitResetCredit/consume`. Document owner-authorized redemption as
an available recovery route, followed by a fresh limits read through the same
identity/window checks; an external redemption is not blanket resume authority.
An in-product redemption command is deferred to separate explicit authorization:
it would require a durable idempotency key, audit, safe handling of
`alreadyRedeemed`/`nothingToReset`/`noCredit`, and post-redemption revalidation.
`account/usage/read` is token-activity context, not remaining quota or recovery;
do not add usage polling to the detection path.

### 3. Claude and Cursor

Claude: preserve `StopFailure.error`, optional `error_details`, and optional
`last_assistant_message`. For this hook the latter is the rendered API error,
not an ordinary assistant answer. Do not invent `error_type`/`error_message`
aliases. Use this direct failure evidence first; holding the agent must not
depend on a statusline sample. The reported message
`You've hit your Opus limit · resets 3:45pm` supplies a family/reset hint, not
automatically an exact UTC deadline. Preserve bounded/redacted source text and
separate deadline confidence. Require known date/timezone and tested locale,
DST and midnight handling; do not guess tomorrow or another family's reset.
Ambiguous/conflicting times require the owner. Billing/auth/account holds never
inherit a quota timer. See [StopFailure](https://code.claude.com/docs/en/hooks#stopfailure).

Keep statusline telemetry as supplemental evidence: forward unchanged stdin to
the owner's command and atomically cache matching windows/session/observation
identity. Missing data remains unknown, and another rendering is not another
provider fetch. See [statusline telemetry](https://code.claude.com/docs/en/statusline#rate-limit-usage).

Establish one retry owner: `vendor`, `coordinator`, or `owner`. For newly managed
Claude issue launches, prefer coordinator ownership with effective
`autoContinueAtUsageLimit: false`, supplied through a narrow `--settings`
override that preserves existing launch settings. Do not alter global user
settings or manual launch behavior. The
[setting's scope](https://code.claude.com/docs/en/settings-reference#autocontinueatusagelimit)
includes user, `--settings`, and managed settings; a project/local occurrence
disables automatic waiting only when none of those sets the key. A local false
is therefore not an unconditional override. Respect managed policy and verify
effective version/behavior before allowing coordinator retries. If verification
is unavailable or settings change, ownership becomes unknown/owner, not assumed.

Claude can still have an already-active or manually selected wait. If native
waiting is active/enabled or ownership is uncertain, send no coordinator
continuation; retain `vendor`/`owner` ownership. Never automatically take over
after cancellation or exhaustion of native retries. The documented wait can be
displaced by a prompt and re-arms at most twice after repeated limit hits; it
does not replace durable holds. See [interactive waiting](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset).

In `harnessPromptReadiness`, veto current quota/wait UI before `❯`, mode text,
or the idle sentinel can authorize a send. Cover `Usage limit reached`,
`continuing automatically`, usage-limit options menus, and stopped/cancelled
wait states. Recheck at the last send boundary. Use active terminal chrome,
not matching arbitrary quoted scrollback; ambiguity defers delivery. A banner
veto can block, but its disappearance cannot release a hold or prove capacity.

At a trustworthy deadline use matching refreshed evidence, or the narrowly
authorized single recovery attempt below; a stale low-usage callback alone
cannot release the hold. Native activity cannot clear a manual pause, another
window/agent's hold, or validate an expired action. Coord pause prevents workflow
advancement, not already-running vendor execution; report that distinction.

Cursor: retain `stop.status=error` diagnostics and `sessionEnd.error_message`;
keep `aborted` as cancellation. Unclassified blocking errors pause with an
unknown deadline. See the supported [lifecycle hooks](https://cursor.com/docs/hooks#stop).
Authenticated/Pro metadata is not capacity evidence. No Admin API integration,
private databases, billing scraping, guessed monthly reset, or on-demand spend
change. The repository launches interactive agents, so adding headless launch
and stream-JSON handling is outside this issue; missing lifecycle evidence is
handled by the watchdog instead.

### 4. Durable holds and manual ownership

Keep `paused` as the effective value `manualPaused || activeHolds.length > 0`.
Add durable manual ownership and a bounded map of holds, containing agent and
resource/window identity, reason, evidence identity, observed time, retry owner,
nullable next-check/reset time, attempts, and notification state. Adopt older
state as `manualPaused = paused` with no holds, preserving existing pauses.
Default missing new cache fields for older runtimes without changing accepted
artifacts or requiring a wipe.

Resource observation atomically updates authoritative holds immediately; a
new hold increments cursor revision so existing effect fences reject stale work.
Emit `agent-resource-held/updated/released` only for meaningful transitions,
plus aggregate `paused`/`resumed` when effective state changes. Never emit a
second-by-second wait journal record. Cap retained diagnostics and reminders.

Plain `coord resume` clears only the manual pause. Add
`coord resume --hold <hold-id>` to acknowledge and release exactly one current
hold; it does not clear manual/other holds. Report remaining blockers. Record
the released evidence ID so an unchanged old callback cannot immediately
reinstall it; a new failure can. Releases do not grant permission to retry a
cancelled or superseded action. Cancellation/context/auth/billing/unknown
failures require owner recovery; no automatic compaction or history deletion.

Persist nudge budgets alongside holds in `cursors.json`, independently of the
lifecycle cache and individual failure text. To release a latched `nudge-loop`
hold require `coord resume --hold <hold-id> --reset-nudge-budget`; audit this
explicit reauthorization and reset only that action's budget. Plain resume or
ordinary hold release cannot replenish it. Keep manual and other holds intact.
Reject the reset flag on unrelated holds, expired actions, or cancellation.

### 5. Scheduling and workflow fences

In `runTick`, ingest/reconcile resource observations before the existing pause
return. In `run`, add an observation-only held state rather than exiting on
every resource pause or initializing dispatch effects while held. Retain
manual-only pause behavior. While resource-held, check due observations and
owner changes with bounded sleeps; persist deadlines and budgets across restart.
No second sleeper or scheduling authority lives in the nudge path.

At a trustworthy renewable deadline plus a small skew buffer, recheck; never
release on elapsed time alone. Every applicable window and restriction must
be clear. Unknown reset means owner intervention. A failed recheck retains the
hold and uses bounded backoff. Temporary throttling honors a valid Retry-After;
otherwise use capped exponential backoff with jitter. Every coordinator-issued
continuation also consumes the shared per-action nudge budget below, not a new
budget per failure string. Bound read-only observation retries separately.
Malformed delays fail closed; when retry ownership is uncertain, pause for the
owner rather than duplicating CLI-native retries.

Probe Codex on correlated failures and at bounded observation intervals, not
every issue poll and not only Stop. Extend the existing observability watchdog
to report unavailable/missing evidence without calling it quota exhaustion.
After a bounded unresolved observation budget, pause visibly as unknown rather
than repeatedly nudging. Healthy long-running work alone is not a failure.

Normal dispatch while held is prohibited. A recovery send is a narrow exception,
not `setPaused(false)`: only for a still-current action with verified coordinator
retry ownership, a trustworthy due deadline, available shared budget, no manual
pause/cancellation/latched circuit breaker, and no other unresolved blocker for
that target. Reuse the send path with an explicit recovery authority check and
one durable in-flight reservation. Keep the effective issue pause and gate
fences in place throughout the attempt; other agents' holds stay intact. If a
safe real retry cannot be established, remain held for owner intervention.
After success, reconcile matching evidence before releasing only its proven
resource/window holds. An availability read itself is not a nudge.

All held paths retain roster, current actions, selected implementation/reviser,
accepted artifacts, dirty worktrees, and pins. Do not clean/reset branches,
synthesize completion, drop agents, change ballot eligibility, or finalize.
Already-running actions can write their normal completion/response artifacts;
leave these intact and record each observed arrival once without advancing the
gate or publishing ballots. Reconcile via existing validation after recovery.
Repeat authority checks around awaited probes/effects and prior to publishing
or nudging; late evidence must not overwrite a new owner pause or restarted action.

### 6. Shared nudge count and frequency circuit breaker

Guard initial delivery, ordinary lifecycle repeats, automatic reissue, lost-send
recovery, and post-reset continuation through one run-loop reservation path.
The current `decideLifecycleNudge` admits fresh idle/failed epochs, so a quota
reply can repeatedly create send eligibility without meaningful progress.

- Allow one initial action delivery, then **at most three automatic repeat
  nudges for the same unfinished action**. When the third unsuccessful repeat
  returns idle/failed without validated completion, latch a `nudge-loop` hold
  before any fourth repeat. Do not interrupt a still-working third attempt;
  silence alone follows the bounded unknown-evidence policy, not a quota guess.
- Use repeat delays of **60, 120, and 240 seconds**, measured from the preceding
  send, with a longer valid provider delay taking precedence. Jitter must never
  reduce these minima. Elapsed time satisfies spacing only; all lifecycle,
  retry-owner, resource, pane-readiness, and authority conditions must still hold.
- Persist initial delivery status, repeat count, last/next-send times, and a
  unique in-flight reservation under issue-session/agent/action identity. Reserve
  under the cursor lock before sending, preventing concurrent ticks from sending
  twice. Definitively unsent readiness/busy deferrals refund the reservation;
  ambiguous/partial sends conservatively retain it until reconciled. Their
  logging/observation is bounded even when no actual nudge was delivered.
- Coordinator/CLI restarts, fresh idle epochs, changed failure wording, digest
  rewrites, other agents' progress, and unverified claims of work never reset the
  count. Automatic reissues carry the same budget even if representation changes.
  Retire it only for validated completion/new authorized work or an explicit,
  audited owner budget reset; automatic new IDs must not launder retry history.
- Confirmed blocking failures hold immediately rather than using up three
  probes. The circuit breaker catches unclassified loops too: call that a
  `nudge-loop` hold with unknown cause, not confirmed quota exhaustion.
- A latched breaker pauses dispatch and gate advancement, preserves work/roster,
  and notifies once with count, timestamps, last reason, and recovery command.
  It does not expire on a frequency interval or quota reset. Suppress subsequent
  duplicate journal entries and bound reminders. The conservative cap includes
  legitimate multi-turn repeats; the owner can authorize more explicitly.

Check pause/hold/retry ownership before lifecycle eligibility, then budget and
spacing, then current pane readiness. Reserve and recheck authority immediately
before the external effect. Post-reset attempts consume this same budget;
read-only quota checks do not. Do not add an alternative timer-driven nudge path.

## Tests

Use focused table-driven and run-loop integration cases rather than duplicate
vendor suites:

1. Timestamp plus remaining capacity and Codex zero credits/ordinary usage
   allowed do not pause. Credits-only restrictions, all-window exhaustion,
   mismatched account/profile, missing capabilities, failed queries, malformed
   protocol, and helper timeout/exit take their specified conservative paths.
2. Billing, renewable exhaustion, transient throttling, context overflow, auth,
   cancellation, transport, and unknown failures remain distinct. Reject stale,
   cross-session/action/account, duplicate, and malformed-time observations.
3. Five-hour clearance does not release a weekly hold. Restart preserves holds,
   retry reservation and budget. One resource's recovery cannot clear another
   hold or manual pause. Thousands of wait ticks produce bounded logs/probes.
4. Selected implementer/reviser held with two peers available: unchanged roster,
   action ID, selection, pins, branch and dirty bytes; no reassignment, missing
   review/ballot approval, advancement, ballot publication, PR or finalization.
   Record arrivals while paused and validate normally afterward. Retain stale
   action/drop rejection; no new ownership handoff is implemented here.
5. Race a hold/manual pause/restart against in-flight observation, nudge/check,
   and finalization effects. Stale results do not authorize the next effect.
6. Claude absent/stale telemetry stays unknown; preserve owner statusline
   stdout and restore ownership safely. Native continuation has no duplicate
   coord retry and does not clear manual pause or accept an old action. Cursor
   error differs from cancellation; Pro/authenticated status cannot release it.
7. CLI targeted release touches one hold only; plain resume retains resource
   holds. Reports show next check or owner action, without private payloads.
8. Initial delivery plus three failed/idle unfinished repeats latches the
   breaker; no fourth repeat is sent. Fake-clock tests enforce 60/120/240-second
   spacing and longer provider delays, without treating time as send authority.
   Cover all send/reissue/recovery paths, definitive unsent versus ambiguous
   sends, concurrent reservation and crash-after-send, restart, digest/session
   changes, changing error text, and other-agent progress. A working third
   attempt is not interrupted; valid completion follows normal verification.
9. Budget reset requires the explicit flag and current nudge-loop hold/action;
   ordinary resume, elapsed reset, or another hold release cannot replenish it.
   Controlled recovery remains gate-paused and cannot bypass owner/other holds.
10. Preserve Claude's direct rendered error without a statusline sample. Test
    family conflicts, date/timezone/locale/DST/midnight ambiguities, absent fields,
    and rejection of invented hook aliases. Verify `--settings`/user/managed
    precedence, unchanged manual launch settings, unknown effective ownership,
    and native cancellation/exhaustion without takeover. A visible `❯` or idle
    sentinel cannot override an active wait/menu, including a race at recapture;
    quoted old banners alone must not be mistaken for current waiting.
11. App Server records parse separately from reported rollout-shaped records;
    quoted trigger strings are not evidence. Compatibility/bucket duplication,
    primary/secondary windows, unknown model mapping, partial notifications,
    missing fields, and disconnects cannot erase holds or infer clearance.
    Missing cross-process notifications use bounded rechecks, never a tight loop.
12. Show known/unknown banked-reset counts without calling redemption/purchase
    methods. Owner-performed external redemption still requires a matching fresh
    limits read and cannot release manual/other holds; token-activity statistics
    alone never release a hold. An automated redemption command is not shipped
    or tested as implemented under this plan.

Commands verified against this repository's `package.json` and Vitest configs:

```sh
pnpm exec vitest run --config vitest.config.ts test/agentResource.test.ts test/codexRateLimits.test.ts test/state.test.ts test/agentLifecycle.test.ts test/agentEvent.test.ts test/agentHookSync.test.ts test/install.test.ts test/runLoop.test.ts test/tmux.test.ts test/cli.test.ts test/issueReport.test.ts
pnpm check:fast
pnpm check
```

Run `pnpm check:fast` before each commit, including the plan commit. Run full
`pnpm check` before implementation acceptance. Fast checks are lint, typecheck,
and fast tests; full check also builds TypeScript and runs integration e2e.
No ordinary issue-branch version bump is required.

Before enabling automatic recovery in a real workspace, capture sanitized,
version-labeled read-only Codex identity/limits evidence in the monitored launch
context, and test notification delivery from a separately running CLI; exercise
Claude direct failure/telemetry, effective retry ownership, active wait UI and
native cancellation/retry exhaustion, plus Cursor error/cancellation
delivery in owner-approved disposable sessions. Do not intentionally exhaust
paid quota. These live adapter checks remain unperformed by this plan; absent
proof keeps the corresponding automatic recovery path disabled, not assumed.

## Alternatives Rejected

- Rollout/private-log or terminal scraping as the primary Codex detector:
  superseded by the corrected supported-account-query approach. No undocumented
  fallback is necessary for the first shipment; unsupported cases stay unknown.
- A new Chat Completions quota probe: it tests the wrong resource and can spend
  tokens. No private OAuth credential extraction or automatic purchases either.
- A reset-only sleeper inside nudging: it cannot preserve independent/manual
  holds, survive restart correctly, or verify all windows have recovered.
- Frequency limiting alone or a fresh budget per idle/error: slows but never
  stops the loop. Use both persistent count and spacing across all send paths.
- Statusline-only Claude detection or unconditional local-settings override:
  discards direct failure evidence and ignores documented settings precedence.
- A single reset epoch, guessed model/bucket mapping, or push-only monitoring:
  can miss an exhausted window or silently lose evidence after disconnect.
- Automatic banked-reset redemption: consumes a scarce entitlement and broadens
  a read-only detector into an account mutation; surface the owner option first.
- Continue with two agents, automatically drop a writer, or transfer ownership:
  violates role and decision identity invariants. Handoff is a separate protocol.
- Treat every 429, zero credit balance, cancellation, or missing Stop as quota:
  produces false holds and unsafe automatic retries.
- New headless Cursor launcher, general provider SDK, or configurable scheduling
  framework: unnecessary for safe handling in the existing interactive workflow.

## Risks and Mitigations

- **Identity drift and optional provider fields:** bind launch/session/account
  context, capability-check versioned payloads, and fail to unknown, never to
  available. Do not treat owner-comment observations as universal API guarantees.
- **Cache freshness is not provider freshness:** distinguish both clocks and
  require post-hold evidence or explicit owner release. No reset-time inference.
- **Concurrent hooks, operator commands, and external effects:** reuse locks,
  revisions and authority fences; persist retry reservations and revalidate
  identity after awaits. No nested lifecycle/cursor locks.
- **Native sessions continue while coord is paused:** suppress all coordinator
  normal dispatch and advancement, preserve incoming work, and tell the owner
  the session may still run. Verify the retry setting and add the live-pane veto;
  do not claim a local setting universally stops native or manually selected waits.
- **Nudge-budget false positives:** normal multi-turn work may reach the cap;
  preserve its action/work and offer explicit audited reauthorization. A reply
  or cosmetic progress must not become a loophole that permits endless nudges.
- **Rendered times and partial quota feeds:** preserve independent confidence
  and per-window identity; reject ambiguous times, missing mapping, and inferred
  clearance. Keep recovery reads when notification coverage is unproven.
- **Statusline ownership:** preserve effective configuration, stdout, stdin and
  owner edits; test inherited settings and uninstall. Refuse ambiguous ownership.
- **Polling/log growth:** bounded helper lifetimes, persistent attempt limits,
  transition-only journals, bounded reminders, deduplication and fake-clock tests.
- **Scope growth:** no automatic roster/handoff protocol, no spending changes,
  no new dependencies or unrelated cleanup. Expand the file map only by a
  reviewed plan amendment if inspection during implementation exposes a gap.

## Conclusion

Implement trustworthy classification, durable whole-issue holds, and a persistent
nudge circuit breaker first. Use Codex source-specific/window-set evidence,
verified Claude retry ownership plus a pane veto, and Cursor unknown-reset holds.
A deadline never authorizes unconditional resumption or resets a nudge budget.
Surface banked-reset availability without automatic redemption. Preserve manual
ownership, every required role/artifact, and unfinished work. Submit this revised
plan for review before changing implementation files.
