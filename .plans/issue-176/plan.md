# Issue 176: Unblock Codex (and peers) when Stop never clears `working`

Also covers GitHub issue **#174** (same failure mode: Codex finishes / prints
`COORD-IDLE`, other agents continue, Codex never gets the next nudge because
lifecycle stays `working` and the Stop hook often never journals).

## Problem

Vendor lifecycle hooks are the only authority that a delivered turn has ended.
Pane scrape — including `COORD-IDLE` — is a typing veto / readiness hint, never
a lifecycle idle signal (`docs/readiness-policy.md`).

Observed stall:

1. Codex receives an action; `UserPromptSubmit` sets `execution: "working"`.
2. Codex finishes, writes `complete`, prints `COORD-IDLE`. `.codex/hooks.json`
   defines a Stop hook, but no Codex Stop row appears in the journal (hook not
   loaded/trusted, or never invoked).
3. `markActionWorkflowComplete` sets `workflowCompleteAt` but leaves
   `execution: "working"`.
4. Gate advances; `prepareAction` → `orderAgentAction` replaces the action
   record but **keeps** `execution` (`src/agentLifecycle.ts` `orderAgentAction`).
5. `deliver` returns immediately when `execution === "working"` with no nudge
   and no `nudge-deferred` journal (`src/runLoop.ts` ~1089). Peer agents that
   did emit Stop proceed; the consensus/solo path stalls on Codex.
6. Later ticks call `maybeLifecycleNudge` → `decideLifecycleNudge` waits on
   `working` (“agent is mid-turn”). Fresh `COORD-IDLE` does not override that.

Issue **#174** also asks whether agents should re-poll `action.md` after idle,
and notes Codex app-server / version prompts. Those are secondary: the agent
cannot watch files after its turn ends without another trigger, and app-server
hygiene is orthogonal to the nudge gate.

## Approach

Smallest fix that fully clears the reported stall: when ordering a **new**
action after the prior action is workflow-complete, clear inherited stale
`working`/`queued` to `idle` (bump `idleEpoch`, clear `turnId`) so initial
`deliver` and later idle nudges are not blocked by a missing Stop.

Keep the Stop hook observational (do not make it inject continuation). Do not
treat `COORD-IDLE` as a general lifecycle authorization (policy stays
hooks-authorize-duplicates). Optionally harden lost-delivery recovery so a
long-stuck `working` turn with positive scrape proof can re-nudge once — only
as defense in depth for the same missing-Stop class, not as a substitute for
the order-time clear.

Out of scope for product code: forcing Codex `/hooks` trust, restarting
app-server, inventing lifecycle events when Stop never ran for an unfinished
action (quiet work remains normal).

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts` — in `orderAgentAction`, when replacing the action
  with a new `actionId`/`actionDigest` and the previous action has
  `workflowCompleteAt !== null`, if `execution` is `working` or `queued`,
  `backgroundActive` is not true, and `pendingInputCount` is 0/null: set
  `execution` to `idle`, clear `turnId`, and advance `idleEpoch` via the same
  `positiveIdle` rule used for `stopped` observations. Do not clear
  `sessionId` or containment. Leave `failed` untouched.
- `src/runLoop.ts` — extend the lost-delivery positive-proof branch inside
  `maybeLifecycleNudge` so `execution === "working"` can qualify when
  `deliveryDelayElapsed`, injection was never turn-correlated
  (`injected.turnId === null`), no pending input / background, and
  `actionAbsentAtReadyPrompt` succeeds. Reuse the existing
  `markInjectedActionAbsent` + journal `prompt-ready-action-absent` path; do
  not invent a new hold reason. Do not change the hard `deliver` mid-turn
  gate except insofar as lifecycle is already idle after the order-time clear.
- `docs/readiness-policy.md` — document that workflow truth clearing a
  completed action also clears inherited `working`/`queued` on the next
  `orderAgentAction`, and that lost-delivery retry may use the same positive
  scrape proof when Stop never arrived. Keep “scrape is a veto, never an
  authorization” and “COORD-IDLE never clears a blocker” unchanged for typing.
- `docs/coord-driver.md` — short note under nudge/lifecycle: missing Codex Stop
  after a completed action no longer permanently blocks the next order’s
  initial deliver; operators should still trust `/hooks` after install
  (point at existing setup-workspace guidance). Mention issue-174 app-server
  restart / version skew as operator hygiene, not a coordinator gate.

## Exact file list to be created

- None. All behavior and docs land in existing modules and test files.

## Reuse and Scope

Reuse:

- `orderAgentAction`, `markActionWorkflowComplete`, `positiveIdle`,
  `decideLifecycleNudge`, `applyLifecycleObservation` / `stopped` semantics in
  `src/agentLifecycle.ts`.
- `deliver`, `maybeLifecycleNudge`, `journalDeferral`,
  `markInjectedActionAbsent`, existing lost-delivery delay
  (`lostDeliveryDelayMs`) in `src/runLoop.ts`.
- `actionAbsentAtReadyPrompt`, `idleSentinelAfterAction`, `COORD_IDLE_SENTINEL`
  in `src/tmux.ts` (scrape helpers stay as-is; plan does not promote the
  sentinel to lifecycle authority).
- Hook install shape in `src/agentHookSync.ts` / `coord agent-event` fail-open
  path — no change; Stop remains observational.
- Tests/fixtures: `test/agentLifecycle.test.ts`, `test/runLoop.test.ts`,
  existing Codex Stop canary patterns in `test/integration.test.ts` /
  `test/agentEvent.test.ts` as reference only (extend the two primary files).

No new files, abstractions, or dependencies. No changes to
`.codex/hooks.json` template shape, `AGENTS` protocol text, or agent-side
multi-poll loops.

## Tests

Focused unit/integration cases (prefer extending existing files; fail before /
pass after):

1. `test/agentLifecycle.test.ts` — after `orderAgentAction` A, observe
   `prompt-submitted` → `working`, `markActionWorkflowComplete` for A, then
   `orderAgentAction` B: expect `execution === "idle"`, `turnId === null`,
   `idleEpoch` advanced, action B `delivery === "ordered"`, and
   `decideLifecycleNudge` for B returns `send` once injected epoch rules allow.
   Negative: ordering B while A is still `working` with
   `workflowCompleteAt === null` must **not** clear execution (unfinished work).
2. `test/runLoop.test.ts` — prepare/deliver next action while lifecycle is
   stale `working` but prior action workflow-complete: expect an initial nudge
   (or at least that `deliver` is no longer a silent no-op solely because of
   inherited `working`). Second case: injected action, `execution: "working"`,
   turn never correlated, delivery delay elapsed, ready prompt lacks action id
   → lost-delivery retry path runs; without the scrape proof, still defer with
   `working`.

Commands while developing: focused vitest on those files. Product commits use
hook-owned `pnpm check:fast` (lint, typecheck, fast + system tests). Do not
claim coordinator-owned `pnpm check` / e2e as agent-run unless actually run.

## Alternatives Rejected

- **Treat `COORD-IDLE` as lifecycle idle for Codex (or all vendors).** Would
  fix the visible pane/lifecycle split-brain, but weakens
  hooks-authorize-duplicates and risks false idle if a model prints the
  sentinel while tools still run. Order-time clear after workflow truth is
  stricter and matches the reported gate-advance stall.
- **Make the Stop hook inject a continuation prompt.** Wrong layer: hooks are
  fail-open and observational (`coord agent-event`); duplicates coordinator
  nudge ownership; does nothing when Stop never fires (#174/#176 root symptom).
- **Agent-side re-read `action.md` N times / sleep after idle (#174).** Agents
  cannot monitor later file changes after the turn ends without another
  trigger (issue 176 already states this). Coordinator delivery remains the
  authority; fixing stale `working` restores nudges.
- **Reset `working` on every `orderAgentAction` even without workflow
  complete.** Could interrupt a true mid-turn if the coordinator re-orders
  while the agent is still working.
- **Operational-only (`/hooks` trust + Codex restart).** Necessary hygiene and
  already documented, but does not recover an issue already stuck in stale
  `working` after a completed pin.
- **Codex app-server / version-skew auto-restart.** Orthogonal process
  management; document only, do not couple to the nudge gate in this issue.

## Risks and Mitigations

- **False idle after complete while tools still run.** Mitigate by requiring
  `workflowCompleteAt` on the prior action and no pending input / background
  before clearing. Agents that publish `complete` early are already violating
  protocol; coordinator must advance.
- **Lost-delivery extension re-nudges a live turn.** Mitigate with existing
  positive proof (`actionAbsentAtReadyPrompt`), turn-correlation null check,
  delivery delay, and send budget / `nudge-loop` hold. Never authorize on
  elapsed time or missing `complete` alone.
- **Masking real Stop-hook install failures.** Clearing stale `working` recovers
  the workflow; docs still point operators at Codex restart + `/hooks` trust so
  journal Stop rows return. Optional follow-up (not this file map): status
  surface for `working` + completed prior action.
- **Silent `deliver` skip remains for true mid-turn.** Intentional: unfinished
  `working` without workflow-complete must still block. Tests cover the
  negative case.

## Conclusion

Issue 176/174 stall because a missing Codex Stop leaves `execution: "working"`
across `orderAgentAction`, and `deliver` / `decideLifecycleNudge` treat that as
mid-turn forever even after workflow truth and `COORD-IDLE`. Clear inherited
stale `working`/`queued` when ordering the next action after
`workflowCompleteAt`, harden lost-delivery for uncorrelated `working` with
positive scrape proof, and document the policy exception and operator hygiene.
No new files; Stop stays observational; agent multi-poll and app-server restart
are rejected as product fixes.
