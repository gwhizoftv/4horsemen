# Issue 126 — classified agent failures and durable resource holds

## Authority and objective

Owner-requested manual plan on intended branch `issue-126/codex`. This plan is
explicitly requested for review; it is not a fabricated coordinator action.
Do not create signals, reviews, action files, or completion markers.

The controlling requirements are the owner's
[corrected issue comment](https://github.com/gwhizoftv/coordination/issues/126#issuecomment-5763600731),
not the superseded rollout-first recommendation in the issue body. Repository
baseline inspected: `ae991b81ba3508b3ef233d2392b88e9eb0569ad1`.

An unavailable agent remains in the roster. Preserve its unfinished work and
pause issue advancement; two available agents do not authorize continuation,
replacement of the selected writer, or approval of missing work. Implement
classification, durable whole-issue holds, bounded observation, and safe recovery.

## Exact File List to be changed or deleted

No deletions. Implementation changes are limited to:

| File | Change |
| --- | --- |
| `src/state.ts` | Resource evidence/hold schemas, backward-compatible pause ownership, atomic hold transitions, retry state, and journal event types. |
| `src/agentLifecycle.ts` | Bounded per-session evidence cache, observation provenance and cancellation/failure detail; retain existing action correlation and lifecycle locking. |
| `src/agentEvent.ts` | Preserve classified errors, accept Claude quota telemetry and launch provenance, correlate evidence, and install holds without granting workflow completion authority. |
| `src/agentHookSync.ts` | Install/inspect/remove an ownership-aware Claude statusline multiplexer through existing lifecycle-hook entry points; preserve effective owner statusline and output. |
| `scripts/lib/launcher.sh` | Record non-secret Codex launch context for the exact generated launch before `exec`; no changes to Git-wrapper restrictions or permissions. |
| `src/runLoop.ts` | Resource observation and recovery scheduling before pause early returns; prohibit dispatch, decisions, publication, and finalization while held; bounded missing-evidence handling. |
| `src/cli.ts` | Scoped owner hold-release command flags, accurate pause/resume output, and hook ingestion for launch context. |
| `src/issueReport.ts` | Display pause owners, affected agent/resource, classification, retry owner, deadline/unknown state, and owner recovery instructions. |
| `docs/coord-driver.md` | Document evidence limits, whole-issue pause/recovery, retry ownership, restart behavior, and operational validation. |
| `test/state.test.ts` | Legacy pause adoption, independent holds, locked/revisioned mutation, deduplication, and persistent retry budgets. |
| `test/agentLifecycle.test.ts` | Session/action freshness, retired-session rejection, cancellation, and cached telemetry behavior. |
| `test/agentEvent.test.ts` | Vendor classification and matching-evidence tests using the existing runtime fixture. |
| `test/agentHookSync.test.ts` | Claude statusline preservation, stdin/stdout forwarding, install idempotence, inspect, dry-run, and safe removal. |
| `test/install.test.ts` | Generated launch-context provenance using the existing stub-harness launcher tests, and unchanged launcher safety behavior. |
| `test/runLoop.test.ts` | Held-role safety, bounded scheduling, native retry ownership, arrivals while paused, restart, and recovery races. |
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
| `src/agentResource.ts` | Pure classification, evidence matching, all-window blocking decisions, and retry eligibility shared by hooks and the coordinator; avoids putting vendor policy into workflow decisions. |
| `src/codexRateLimits.ts` | Small bounded read-only App Server subprocess adapter; isolates protocol framing, timeout, identity checks, and process cleanup from the run loop. |
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
sessions, unrelated accounts, future/malformed times, and older observations;
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

### 3. Claude and Cursor

Claude: forward the unchanged statusline stdin to the owner's command and
atomically cache documented `rate_limits` windows with session and observation
identity. Join `StopFailure.error` and optional `error_details` to matching
telemetry. Billing/authentication/account holds do not inherit a quota timer.
Missing data or a repeated render does not prove fresh account availability.
See [statusline telemetry](https://code.claude.com/docs/en/statusline#rate-limit-usage)
and [StopFailure](https://code.claude.com/docs/en/hooks#stopfailure).

Use an explicit retry owner: `vendor`, `coordinator`, or `owner`. For interactive
Claude, default to vendor/owner recovery, never an independent coordinator
continuation prompt. Supported Claude versions can resume natively, as described
in [interactive waiting](https://code.claude.com/docs/en/interactive-mode#wait-for-a-usage-limit-to-reset).
Observe native continuation without dispatching a second prompt. A callback
with cached low usage is insufficient for release: require matching post-hold
successful work plus applicable refreshed evidence, otherwise retain the hold
for owner confirmation. Native activity cannot clear a manual pause or validate
an expired action. Coord pause prevents workflow advancement, not execution
already underway inside a vendor process; report that distinction explicitly.

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
otherwise use capped exponential backoff with jitter and a finite attempt budget
(initial policy: at most three coordinator-owned attempts per action/failure).
Malformed delays fail closed. CLI-native retries are not duplicated; when retry
ownership cannot be established, pause for the owner. Reserve attempts durably
before external effects so a crash cannot reset the budget.

Probe Codex on correlated failures and at bounded observation intervals, not
every issue poll and not only Stop. Extend the existing observability watchdog
to report unavailable/missing evidence without calling it quota exhaustion.
After a bounded unresolved observation budget, pause visibly as unknown rather
than repeatedly nudging. Healthy long-running work alone is not a failure.

All held paths retain roster, current actions, selected implementation/reviser,
accepted artifacts, dirty worktrees, and pins. Do not clean/reset branches,
synthesize completion, drop agents, change ballot eligibility, or finalize.
Already-running actions can write their normal completion/response artifacts;
leave these intact and record each observed arrival once without advancing the
gate or publishing ballots. Reconcile via existing validation after recovery.
Repeat authority checks around awaited probes/effects and prior to publishing
or nudging; late evidence must not overwrite a new owner pause or restarted action.

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

Commands verified against this repository's `package.json` and Vitest configs:

```sh
pnpm exec vitest run --config vitest.config.ts test/agentResource.test.ts test/codexRateLimits.test.ts test/state.test.ts test/agentLifecycle.test.ts test/agentEvent.test.ts test/agentHookSync.test.ts test/install.test.ts test/runLoop.test.ts test/cli.test.ts test/issueReport.test.ts
pnpm check:fast
pnpm check
```

Run `pnpm check:fast` before each commit, including the plan commit. Run full
`pnpm check` before implementation acceptance. Fast checks are lint, typecheck,
and fast tests; full check also builds TypeScript and runs integration e2e.
No ordinary issue-branch version bump is required.

Before enabling automatic recovery in a real workspace, capture sanitized,
version-labeled read-only Codex identity/limits evidence in the monitored launch
context; exercise Claude telemetry/native waiting and Cursor error/cancellation
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
  dispatch and advancement, preserve incoming work, and tell the owner the
  session may still run. Do not claim that coord can stop vendor-native retries.
- **Statusline ownership:** preserve effective configuration, stdout, stdin and
  owner edits; test inherited settings and uninstall. Refuse ambiguous ownership.
- **Polling/log growth:** bounded helper lifetimes, persistent attempt limits,
  transition-only journals, bounded reminders, deduplication and fake-clock tests.
- **Scope growth:** no automatic roster/handoff protocol, no spending changes,
  no new dependencies or unrelated cleanup. Expand the file map only by a
  reviewed plan amendment if inspection during implementation exposes a gap.

## Conclusion

Implement trustworthy classification and durable whole-issue resource holds
first, with supported Codex observation, conservative Claude/native recovery,
and Cursor pause-with-unknown-reset. A deadline authorizes observation, not
unconditional resumption. Preserve manual ownership, every required role and
artifact, and all unfinished work. Submit this plan for review before changing
implementation files.
