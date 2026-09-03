# Plan — the coordinator must detect an agent that cannot complete its action

## Problem

`docs/readiness-policy.md` names three signal layers, and each answers exactly
one question:

| Layer | Mechanism | Answers |
| --- | --- | --- |
| Delivery readiness | `harnessPromptReadiness` (`src/tmux.ts:139`) | is it safe to type into this pane |
| Observability | `applyLifecycleObservation` (`src/agentLifecycle.ts:360`) | would a second send be a duplicate |
| Workflow truth | `readCompletion` (`src/action.ts:292`) plus a Git pin | did the work actually happen |

None of them answers **is the agent making progress**. An agent stuck in a retry
loop — a denied sandbox permission, a command that is not on `PATH`, an
exhausted usage window — emits hook traffic continuously. `decideLifecycleNudge`
(`src/agentLifecycle.ts:544`) therefore returns `{ kind: "wait", code: "working" }`
or `"queued"` forever; `journalDeferral` (`src/runLoop.ts:1081`) logs that once
and drops to `verbose` on repeats; and `markObservabilityDegraded`
(`src/agentLifecycle.ts:589`) self-suppresses the moment any lifecycle event
arrives after the injection, which a looping agent produces constantly. The
result is the reported failure: the coordinator waits indefinitely on an agent
that will never write `complete`, and the operator sees nothing but a silent
tick.

Nothing in the runtime counts turns against an action, and nothing observes
whether the artifact the action asked for has changed. That absence — not a bug
in any of the three layers — is what this plan closes.

## Scope decision

This plan adds a **fourth layer, progress**, and a **bounded escalation** that
consumes it. It deliberately stops at *detect, ask, and hand to the owner*.
Automatic remedies (restarting a CLI in its pane, `/clear` for a full context,
dropping an agent from the roster) are not included: each is destructive, each
needs a different diagnosis, and `src/runLoop.ts:1173` already documents why a
wrong remedy is expensive — it can kill the turn that was about to write
`complete`. Detection with a correct, named hand-off is the whole of the
reported problem; recovery is a separate change with a separate risk budget.

Two rules carry over from the readiness policy and constrain every choice below:

- **Elapsed time alone never authorizes an action.** Time may open a door;
  positive evidence walks through it. A stall requires observed turn boundaries,
  not a clock.
- **A false "stuck" costs more than a false "busy."** Every escalation rung is
  non-destructive, and the first one only asks a question.

## Design

**Progress evidence** for an action is the digest of what the action asked the
agent to produce. For a `git`-mode action that is the tuple
(`requiredPath` contents in the agent clone, the agent branch tip recorded on the
cursor, the `complete` marker). For a `response`-mode action it is the response
JSON under `responsesDir` plus the marker. All three are already known to the
coordinator; none requires a new read of a peer branch.

**A stall** is: `stalledTurns` accepted turn boundaries have been observed for
this action since injection, and the progress digest has not changed across any
of them. Turn boundaries come from the hook traffic that
`applyLifecycleObservation` already handles — a `prompt-submitted` whose
`turnId` differs from the last one counted. This is vendor-neutral: it needs no
transcript parsing and no pane pattern.

**Escalation** is a two-rung ladder stored on the action:

1. `probe` — inject a prompt that is *not* a re-read of `action.md`, asking the
   agent to report its blocker. A distinct prompt yields an observable that a
   repeated nudge cannot: whether the agent can respond at all.
2. `halt` — pause the issue with `setPaused` (`src/state.ts:1085`) and print an
   `Owner action required:` line naming the agent, the turn count, and the
   agent's own reason if it gave one.

**The agent's own report** short-circuits the ladder. `complete` is already the
one file an agent writes, into a mailbox directory granted per issue and per
agent (`src/paths.ts:105-115`). Adding a third accepted line to that same file —
`blocked <reason> <actionId>` — gets a labelled cause with no new file, no new
grant, and no new polling site. An agent that knows why it is stuck says so
immediately instead of being detected after N turns.

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts`
  - Extend `lifecycleActionSchema` (line 14) with three fields, each declared
    with a Zod `.default()` so an `agent-lifecycle.json` written by the current
    build still parses and `AGENT_LIFECYCLE_FORMAT_VERSION` (line 8) stays at
    `1`: `progressDigest: z.string().nullable().default(null)`,
    `turnsSinceProgress: z.number().int().nonnegative().default(0)`,
    `escalation: z.enum(["none", "probed", "halted"]).default("none")`. This is
    the same additive pattern already used for `retiredSessionIds` (line 34) and
    `degradedCause` (line 41).
  - Add `export const recordActionProgress = (paths, agent, actionId, digest, now?)`
    beside `markActionWorkflowComplete`. It uses the existing
    `mutateAgentLifecycle` / `replaceEntry` helpers: when `digest` differs from
    `progressDigest` it stores the new digest and resets `turnsSinceProgress` to
    `0`; when it matches it leaves both untouched. It never counts turns — that
    is the observation path's job.
  - In `applyLifecycleObservation` (line 360), in the existing
    `observation.kind === "prompt-submitted"` branch, increment
    `action.turnsSinceProgress` when the submitted `turnId` differs from
    `action.turnId`. No new branch and no new observation kind.
  - Add `export type StallDecision = { kind: "ok" } | { kind: "stalled"; rung: "probe" | "halt"; turns: number }`
    and `export const decideActionStall = (entry, actionId, stalledTurns)`,
    placed next to `decideLifecycleNudge` (line 544) and mirroring its shape.
    It returns `ok` unless the action matches, `workflowCompleteAt` is `null`,
    and `turnsSinceProgress >= stalledTurns`; it then returns rung `probe` when
    `escalation === "none"` and `halt` when `escalation === "probed"`, and `ok`
    when `escalation === "halted"` so the ladder cannot fire twice.
  - Add `export const markActionEscalated = (paths, agent, actionId, rung, now?)`,
    same `mutateAgentLifecycle` shape as `markActionInjected` (line 210), which
    advances `escalation` and resets `turnsSinceProgress` to `0` so the next rung
    requires a fresh stall rather than the same one.
  - Add `export const AGENT_STALLED_TURNS = 3` beside
    `AGENT_OBSERVABILITY_WATCHDOG_MS` (line 9).

- `src/action.ts`
  - Add `| { status: "valid"; kind: "blocked"; reason: BlockedReason; actionId: string }`
    to `CompletionParseResult` (line 259), and
    `export type BlockedReason = "permission" | "path" | "budget" | "unclear-action" | "tool-failure" | "other"`.
  - In `parseCompletion` (line 265), before the existing `response` match, accept
    `^blocked (permission|path|budget|unclear-action|tool-failure|other) (<uuid>)$`
    against the same `actionIdSchema` the response branch already uses. The
    single-line, unpadded, no-newline validation above it is unchanged and
    applies to the new form for free.

- `src/state.ts`
  - Add `"agent-blocked"`, `"action-stalled"`, and `"action-escalated"` to
    `journalEventTypeSchema` (line 583). No other schema changes:
    `agentCursorSchema` (line 333) already carries the `paused` status, and
    `cursorsStateSchema` already carries `paused`.

- `src/runLoop.ts`
  - Add `stalledTurns?: number` to `RunLoopDependencies` (line 170) next to the
    existing `nudgeRetryMs` (line 182), resolved in the constructor at line 789
    the same way, so tests can drive the threshold without waiting on real turns.
  - Add `private actionProgressDigest(start, cursors, agent, cursor): string` —
    a `sha256` (from `src/hash.ts`) over the action's `requiredPath` contents in
    the agent clone when present, the cursor's `submissionSha`, and the raw
    `complete` bytes; for a `response`-mode cursor, over the response file under
    `responsesDir` instead of `requiredPath`. A missing file contributes a fixed
    empty token, so "still absent" is stable and "appeared" is a change.
  - In `runTick` (line 2164), inside the existing
    `completion.status === "missing"` branch, before the
    `cursor.status === "ordered"` nudge call: call `recordActionProgress` with
    that digest, then `decideActionStall`. On `probe`, journal `action-stalled`
    and call the new probe send described below. On `halt`, journal
    `action-escalated`, `setPaused(cursors, true)`, and `this.log` an
    `Owner action required:` line — matching the existing wording at lines 1983,
    2194 and 2237 — that names the agent, `turns`, the last `NudgeWaitCode` from
    `loggedDeferral`, and the agent's blocked reason when one was seen.
  - Add a `completion.status === "valid" && completion.kind === "blocked"` branch
    at the same site: journal `agent-blocked` with the reason, `setPaused`, log
    the `Owner action required:` line, and `clearCompletion(runtime.complete)`
    using the existing helper already called at lines 1344/1459/1537 so a stale
    marker cannot re-trigger.
  - Add `private async sendProbe(start, cursors, agent, actionId)`, modelled on
    the send half of `maybeLifecycleNudge` (lines 1252-1290): it calls
    `this.tmux.nudge` with a one-line probe text instead of `runtime.action`,
    honours the same `sent` / `busy` / `gone` outcomes, and calls
    `markActionEscalated` on `sent`. It does **not** rewrite `action.md` and does
    not call `orderAgentAction`, so the pending action is untouched.
  - Extend `deferralRationale`'s exhaustive union handling (the switch noted at
    line 733) only if the new journal types require it; `NudgeWaitCode` itself is
    unchanged.

- `templates/product/AGENTS.protocol.md`
  - After the `COORD-IDLE` paragraph (lines 51-63), add a short block: if you
    cannot complete the action — a denied permission, a command that is not
    found, an exhausted budget, an action you cannot parse, or the same tool call
    failing repeatedly — write `blocked <reason> <actionId>` to the same
    `complete` path instead of looping, using one of the six reason words, then
    print `COORD-IDLE`. State explicitly that retrying a failing command more
    than three times is itself a reason to write `blocked`.

- `AGENTS.md` — the tracked copy of the same protocol text, kept in step with the
  template so the two do not drift.

- `docs/readiness-policy.md` — add `Progress` as a fourth row of the layer table
  and a short section stating the stall rule, the two rungs, and that elapsed
  time alone still authorizes nothing.

- `test/agentLifecycle.test.ts`, `test/action.test.ts`, `test/runLoop.test.ts` —
  new cases listed under Tests.

Nothing is deleted. No version bump: `AGENTS.md` states the `0.0.N` advance is
checked only on the PR into `main`.

## Exact file list to be created

None.

Every piece has an existing home: progress and escalation are action-scoped
lifecycle state, so they belong in `src/agentLifecycle.ts` beside the delivery
state they extend; the `blocked` marker is a third line form of a file
`src/action.ts` already parses; the tick wiring belongs in the method that
already polls `complete`. A new `src/agentProgress.ts` was considered and
rejected below. No new dependency is added — `sha256` already exists in
`src/hash.ts` and is already used for `sha256OfFile` in `src/runLoop.ts`.

## Reuse and Scope

Reused production code, with no new abstraction:

- `mutateAgentLifecycle` / `replaceEntry` / `agentLifecycleEntrySchema`
  (`src/agentLifecycle.ts:132-166`) — the locked read-modify-write path every new
  mutator uses unchanged, so progress state gets the same atomicity and
  `stateRevision` bump as delivery state.
- The `.default()` idiom on `retiredSessionIds` (line 34) and `degradedCause`
  (line 41) — the established way this schema has added fields without moving
  `AGENT_LIFECYCLE_FORMAT_VERSION`. Following it is what keeps a live runtime's
  `agent-lifecycle.json` readable after upgrade.
- `decideLifecycleNudge` (line 544) as the shape for `decideActionStall`: a pure
  function over one entry returning a closed union, so the policy is testable
  without a runtime directory.
- `markActionInjected` (line 210) as the shape for `markActionEscalated`,
  including its guard that the action id and digest still match.
- `parseCompletion` (`src/action.ts:265`) — its single-line/unpadded/no-CR
  validation runs before any form match, so the new `blocked` form inherits it.
- The completion mailbox (`src/paths.ts:105-115`, `agentRuntimePaths` line 338).
  `blocked` is written to the existing `complete` path, so it needs no new
  harness grant. This is the reason the marker is a line in `complete` rather
  than a sibling file.
- `readCompletion` / `clearCompletion` (`src/action.ts:292-299`) and the single
  polling site at `src/runLoop.ts:2176` — the blocked branch is added there, not
  in a second poller.
- `setPaused` (`src/state.ts:1085`), `appendJournal`, `this.log`'s existing
  `Owner action required:` convention (`src/runLoop.ts:1983`, `2194`, `2237`) —
  the halt rung composes these three and introduces no new operator channel.
- `TmuxController.nudge` and `NudgeOutcome` (`src/tmux.ts:311`) — the probe reuses
  the send path verbatim, so it inherits every gate, readiness veto and
  `GateReason` the nudge already honours. Scrape stays a veto: a probe into a
  busy pane is refused exactly like a nudge.
- `sha256` (`src/hash.ts`), already used via `sha256OfFile` at
  `src/runLoop.ts:938`.
- `nudgeRetryMs` (`src/runLoop.ts:182`) as the precedent for a test-injectable
  threshold.

Reused test fixtures:

- The runtime-directory and `RunLoopDependencies` fake-tmux harness already used
  throughout `test/runLoop.test.ts`, including the injected `TmuxRunner` seam, so
  no new fixture module is needed.
- The direct-entry construction style in `test/agentLifecycle.test.ts`, which
  already exercises `applyLifecycleObservation` and `decideLifecycleNudge` as
  pure functions.

Scope boundary, established by inspection:

- `markObservabilityDegraded` (`src/agentLifecycle.ts:589`) is **not** modified.
  It answers "did anything correlate with the last delivery", which stays true
  and stays orthogonal; the stall detector answers "did anything change", and
  the two can fire independently.
- `decideLifecycleNudge` and `NudgeWaitCode` (line 530) are unchanged. Stall
  detection runs *beside* the nudge decision, never inside it, so no existing
  deferral code path changes meaning.
- `src/transcriptRead.ts` and `src/analytics.ts` are untouched. Per-turn token
  and tool-call parsing would enrich the operator message with the failing
  command's name, but it is vendor-specific, its coverage is already modelled as
  possibly `partial`/`unsupported`, and the ladder does not need it to fire.
  Deferred, not designed around.
- No new pane pattern is added to `src/tmux.ts`. Vendor limit banners and
  permission prompts are attractive signals but they are version-brittle prose,
  the capture is only 40 lines (`src/tmux.ts:840`), and the `inFlightStatusLine`
  comment (lines 96-104) already documents how agents' own prose defeats such
  matching. The `blocked` marker gets the same causes from the agent directly.
- No change to `src/steps.ts`, `src/evidence.ts`, `src/finalization.ts`, or the
  gate logic: a halted issue is a paused issue, which those already handle.

## Tests

`test/action.test.ts` — extend the existing `parseCompletion` describe:

- **"accepts a blocked marker with a reason and action id"** — every one of the
  six reason words parses to `{ status: "valid", kind: "blocked", reason, actionId }`.
- **"rejects an unknown blocked reason"** — `blocked wedged <uuid>` is
  `malformed`, not silently treated as a SHA.
- **"rejects a blocked marker with a non-UUID action id"** — `malformed`.
- **"still accepts a bare SHA and a response marker"** — asserts the new branch
  did not shadow the two existing forms.

`test/agentLifecycle.test.ts` — pure-function cases, no runtime directory:

- **"a differing turn id increments turnsSinceProgress"** — two
  `prompt-submitted` observations with different `turnId`s take the counter to
  `2`; a repeat of the same `turnId` leaves it unchanged.
- **"recordActionProgress resets the counter when the digest changes"** — and
  leaves it alone when the digest matches.
- **"decideActionStall returns ok below the threshold"** and
  **"…returns probe at the threshold, then halt, then ok"** — driving
  `markActionEscalated` between calls proves the ladder advances once per rung
  and cannot loop.
- **"decideActionStall returns ok once workflowCompleteAt is set"** — workflow
  truth still outranks the new layer.
- **"an entry written by the previous format parses"** — feed
  `agentLifecycleEntrySchema` an object with `formatVersion: 1` and an `action`
  lacking the three new keys; it must parse with the documented defaults. This is
  the migration guard.

`test/runLoop.test.ts` — using the existing fake-tmux harness and
`stalledTurns: 1`:

- **"pauses the issue and names the agent when a blocked marker is written"** —
  write `blocked permission <actionId>` to the agent's `complete` path, run a
  tick, assert `cursors.paused === true`, an `agent-blocked` journal event
  carrying `reason: "permission"`, an `Owner action required:` log line naming
  the agent, and that the marker was cleared.
- **"probes once, then halts, when turns pass with no progress"** — feed enough
  distinct-`turnId` prompt-submitted observations to cross the threshold; assert
  the first tick sends a probe whose text is not `action.md`'s path and journals
  `action-stalled`, and that a second stall halts and pauses.
- **"does not escalate while the required artifact keeps changing"** — mutate the
  `requiredPath` file between ticks across more turns than the threshold; assert
  no `action-stalled` event. This is the false-positive guard, and it is the most
  important case in the plan.
- **"does not escalate after the action reaches workflow completion"** — a valid
  SHA in `complete` before the threshold leaves `paused` false.
- **"a probe refused by a busy pane does not advance the rung"** — the fake tmux
  returns `busy`; assert `escalation` stays `none` so the pane veto still wins.

Commands to run before committing, from `AGENTS.md`: `pnpm check:fast`
(`pnpm lint && pnpm typecheck && pnpm test:fast`). The coordinator's stricter
list on an approved commit is `pnpm check` (`pnpm build && pnpm check:fast &&
pnpm test:e2e`).

## Alternatives Rejected

- **Time-based stall detection ("no `complete` within N minutes").** Simplest to
  write and the reason this problem is easy to get wrong. A long verification run
  or a large plan legitimately exceeds any threshold, so the coordinator would
  probe or pause agents that were working correctly — the exact cost
  `src/runLoop.ts:1173` warns about. Counting *observed turn boundaries with an
  unchanged artifact* has no such failure: an agent that produced three turns and
  changed nothing is stuck under any workload.
- **Escalating from `markObservabilityDegraded`.** It already has a timer, so
  reusing it looks free. But it is explicitly documented (`src/agentLifecycle.ts:565`)
  to prove one thing only — no correlated event — and it self-clears the moment
  any event arrives. A looping agent emits events constantly, so it never fires
  for this case. Overloading it would also destroy the `hooks-never-seen` versus
  `correlation-lagged` split that keeps the restart remedy off healthy CLIs.
- **A new `NudgeWaitCode` such as `"stalled"`.** `decideLifecycleNudge` answers
  "would this be a duplicate send", and a stalled agent's answer to that question
  is genuinely still "yes, wait". Folding a second question into it would make
  the deferral union mean two things and would put escalation inside a function
  the tick calls only when `cursor.status === "ordered"`.
- **A new `src/agentProgress.ts` module.** The state is action-scoped and lives
  in `lifecycleActionSchema`; a separate module would either duplicate that
  schema or import and re-export it, and would need its own lock discipline
  around the same file `mutateAgentLifecycle` already guards.
- **Escalating by re-sending `action.md`.** That is what already happens and is
  the reported symptom. A repeated identical nudge produces no new observable —
  which is precisely why the probe rung must send different text.
- **Automatic recovery: restart the CLI, `/clear`, or drop the agent.** Each
  needs a diagnosis this change does not produce, and each is destructive if the
  diagnosis is wrong; `agentCursorSchema` already has `failed`/`dropped` for a
  later change to use. Out of scope, stated in Scope decision above.
- **Pane-scrape detection of usage-limit and permission-prompt copy.** Version-
  brittle vendor prose, a 40-line capture, and the documented false-positive
  hazard of agents writing those words in their own plans. The `blocked` marker
  gets the same information from the only party that actually knows it.
- **Transcript repetition detection (same tool, same input, repeated failure).**
  The highest-signal detector available and the only one that can name the
  failing command, but it needs a new extractor in `src/transcriptRead.ts`, it is
  vendor-specific, and its coverage is already modelled as sometimes
  `unsupported`. Deferred to a follow-up whose value is a better operator
  message, not a working ladder.
- **A separate `blocked` file beside `complete`.** Would need a second polling
  site and a second harness grant into the mailbox. A third accepted line in the
  file agents already write needs neither.
- **Bumping `AGENT_LIFECYCLE_FORMAT_VERSION` to 2.** `readAgentLifecycle`
  (`src/agentLifecycle.ts:129`) throws on a schema mismatch, so a bump would make
  every in-flight issue's `agent-lifecycle.json` unreadable at upgrade, taking
  down running coordinators to add three optional fields. Defaulted fields are
  the pattern the schema already uses for exactly this.

## Risks and Mitigations

- **A false stall interrupts an agent that was about to finish.** The dominant
  risk. Mitigations: the first rung only sends a question and never touches
  `action.md` or the pending order; `decideActionStall` returns `ok` whenever
  `workflowCompleteAt` is set, so workflow truth still outranks the new layer;
  the probe goes through `TmuxController.nudge`, so a busy pane vetoes it exactly
  as it vetoes a nudge; and the "does not escalate while the required artifact
  keeps changing" test pins the guarantee.
- **The progress digest is too coarse and misses real work.** An agent editing
  scratch files makes no digest change. Mitigation: that is intended — the digest
  tracks the artifact the action *asked for*, and three turns with no movement on
  it is a legitimate reason to ask what is happening. The consequence of the
  miss is one question, not a dropped agent.
- **The progress digest is too fine and never fires.** A file whose bytes change
  every turn — a timestamp, a scratch note under `requiredPath` — resets the
  counter forever. Mitigation: the digest covers `requiredPath`, the recorded
  submission SHA and the `complete` bytes only, not the whole clone; if this
  proves too permissive in practice the follow-up is to also cap total turns per
  action, which is a threshold change rather than a redesign.
- **An upgraded coordinator cannot read a live `agent-lifecycle.json`.** Mitigated
  by keeping `AGENT_LIFECYCLE_FORMAT_VERSION` at `1` and declaring all three new
  fields with `.default()`, and pinned by the explicit previous-format parse test.
- **Agents do not adopt the `blocked` marker.** The protocol text only reaches a
  clone when `writeCloneAgentsProtocol` runs (`src/agentsProtocol.ts:124`), so
  clones prepared before this change keep the old block, and a model may ignore
  the instruction regardless. Mitigation: the marker is an accelerator, not the
  mechanism — the turn-counting ladder fires with no agent cooperation at all,
  which is why both are in this plan rather than the marker alone.
- **An agent writes `blocked` spuriously and stalls its own issue.** Mitigation:
  the reason word is a closed enum, the event is journalled with the reason, the
  marker is cleared after handling so one bad write cannot loop, and the outcome
  is a pause the owner can resume — not an abandoned issue.
- **The probe text is mistaken for a new action.** Mitigation: the probe does not
  call `orderAgentAction` and does not rewrite `action.md`, so `actionId` in the
  front matter is unchanged; an agent following the protocol's re-read rule sees
  the same action and correctly does not restart it.
- **Two escalation paths race on the same lifecycle file.** Mitigation:
  `markActionEscalated` goes through `mutateAgentLifecycle`, which holds the
  exclusive lock and bumps `stateRevision` like every other mutator.

## Conclusion

The coordinator has three signal layers and none of them measures progress, so an
agent looping on a failing command reads as permanently busy and is deferred
forever. The fix is a fourth layer: count accepted turn boundaries against a
digest of the artifact the action asked for, and when three turns pass without
that digest moving, escalate once — first by asking the agent what is blocking
it, then by pausing the issue with an `Owner action required:` line that names
the agent and the turn count. In parallel, an agent that already knows why it is
stuck says so by writing `blocked <reason> <actionId>` to the `complete` file it
is already granted, which short-circuits the wait entirely and supplies the
cause the coordinator cannot infer.

The change is additive: three defaulted fields on an existing schema, three pure
policy functions shaped like the ones beside them, one extra line form in an
existing parser, and one branch at the single site that already polls `complete`.
No existing decision path changes meaning, `AGENT_LIFECYCLE_FORMAT_VERSION` stays
at `1`, scrape remains a veto, workflow truth still outranks everything, and
elapsed time still authorizes nothing on its own. Automatic recovery is
deliberately left out; this plan makes the failure visible and correctly
attributed, which is what the issue asks for. Verified with `pnpm check:fast`.
