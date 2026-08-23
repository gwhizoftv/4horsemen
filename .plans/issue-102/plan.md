# Plan — issue 102: better journalling, messaging and detection by the coordinator

## Problem this plan solves

Three signals disagree and the disagreement is under-recorded:

| Layer | Mechanism | Authority for |
| --- | --- | --- |
| Delivery readiness | pane scrape (`harnessLooksReady` / `harnessPromptReady`) | whether it is safe to type into the pane |
| Observability | vendor lifecycle hooks (`SessionStart`, prompt-submit, `Stop`) | duplicate-send suppression |
| Workflow truth | `complete` file plus the pushed commit SHA | whether the workflow advances |

Today `src/tmux.ts` collapses every readiness rejection to the single string
`"busy"` (`src/tmux.ts:702`, `src/tmux.ts:737`), so `src/runLoop.ts:615` and
`src/runLoop.ts:789` can only emit `nudge deferred for <agent>: busy` at
verbose level. The Cursor readiness regex at `src/tmux.ts:72` matches the bare
word `Thinking` anywhere in 40 lines of scrollback, so ordinary prose in an
agent's own output makes the pane look busy forever. The degraded message at
`src/runLoop.ts:699` unconditionally tells the operator to restart the CLI even
when `markObservabilityDegraded` (`src/agentLifecycle.ts:533`) only proved that
no hook correlated with the last send. And `markActionWorkflowComplete`
(`src/agentLifecycle.ts:315`) records that the workflow advanced without
clearing the `health: "degraded"` that the watchdog set, so the misleading
operator alert stays sticky after the work is demonstrably done.

The plan makes every readiness and suppression decision carry a machine-readable
reason code, corrects the Cursor false positive, replaces the restart advice
with a classified diagnosis, records scrape and hook disagreement as one journal
event, and gives agents a fixed idle sentence so scrape has a positive idle
signal instead of only negative chrome matches.

## Exact File List to be changed or deleted

Nothing is deleted. Files changed, with the anchor each change lands on:

- `src/tmux.ts`
  - `harnessPromptReady` (`src/tmux.ts:63`) becomes a thin wrapper over a new
    `harnessPromptReadiness(paneText, agentId): PromptReadiness`, where
    `PromptReadiness = { ready: true; reason: "ready" | "idle-sentinel" } | { ready: false; reason: PromptBlockedReason }`
    and `PromptBlockedReason` is the union
    `"trust-dialog" | "claude-no-prompt" | "cursor-turn-chrome" | "antigravity-turn-chrome" | "antigravity-verify-overlay" | "antigravity-no-prompt"`.
    The wrapper keeps the existing boolean signature so unrelated call sites and
    `test/tmux.test.ts:606`–`652` keep compiling.
  - Cursor branch (`src/tmux.ts:72`): replace
    `/esc to cancel|Generating|Running\.\.\.|Working\.\.\.|Thinking/i` with a
    chrome-anchored matcher. `esc to cancel` stays as-is (it is real chrome).
    The status words only count when they are the visible status line: matched
    per line with `/^\s*\W{0,3}\s*(?:Thinking|Generating|Working|Running)(?:\s*[…]|\.\.\.|\s+for\s+\d|\s*\(\d)/im`.
    Prose containing `thinking about the alternatives` or the word `stats` no
    longer matches; `Thinking…`, `Generating...`, and `Working... (12s)` still do.
  - `inspectPane` (`src/tmux.ts:677`) is unchanged; `injectionGate`
    (`src/tmux.ts:702`) changes its return type from
    `"ok" | "busy" | "gone"` to
    `{ status: "ok" | "busy" | "gone"; reason: GateReason; detail?: string }`
    where `GateReason` is
    `"ok" | "pane-dead" | "owner-typing" | "input-off" | "foreground-mismatch"`,
    and `detail` carries the observed `pane.foreground` for the mismatch case.
  - `nudge` (`src/tmux.ts:737`) changes its return type from
    `"sent" | "disabled" | "busy" | "gone"` to
    `NudgeOutcome = { status: "sent" | "disabled" | "busy" | "gone"; reason: string; detail?: string }`.
    `reason` is `"delivery-disabled"`, a `GateReason`, a `PromptBlockedReason`,
    or `"antigravity-recapture-busy"` for the post-wait recapture rejection.
    The inner `send` closure keeps returning the gate result and its reason is
    surfaced as `reason: "gate-<GateReason>-mid-send"` so a pane that goes busy
    between keystrokes is distinguishable from one that was busy up front.
  - `actionAbsentAtReadyPrompt` (`src/tmux.ts:722`) adopts the new gate shape
    (`gate.status !== "ok"`), and gains an optional sentinel check used by the
    broadened recovery below: a new exported
    `idleSentinelAfterAction(paneText, actionId, sentinel): boolean` returns true
    only when the sentinel's last index in the stripped buffer is greater than
    the action UUID's last index, so a sentinel left in scrollback from a prior
    action is never mistaken for present-tense idleness.
  - New exported constant `COORD_IDLE_SENTINEL = "COORD-IDLE: waiting for the next coordinator action file"`.
    `harnessPromptReadiness` returns `{ ready: true, reason: "idle-sentinel" }`
    when the sentinel is the last non-empty line, before any per-agent branch
    other than the trust dialog.
- `src/agentLifecycle.ts`
  - `NudgeDecision` (`src/agentLifecycle.ts:508`) gains a stable `code` field:
    `{ kind: "send"; reason: "eligible-idle"; code: "eligible-idle" } | { kind: "wait"; reason: string; code: WaitCode }`
    with `WaitCode = "unmatched-action" | "workflow-complete" | "pending-input" | "background-active" | "queued" | "working" | "unknown" | "failed-execution" | "idle-transition-already-used"`.
    `decideLifecycleNudge` (`src/agentLifecycle.ts:510`) fills it; the existing
    `reason` strings are preserved so no current assertion changes meaning.
  - `markObservabilityDegraded` (`src/agentLifecycle.ts:533`) returns
    `{ changed, state, cause }` where
    `cause = "hooks-never-seen" | "correlation-lagged" | null`.
    `hooks-never-seen` requires `entry.lastEvent === null && entry.sessionId === null`
    (no `SessionStart` has ever arrived for this agent); every other degrade is
    `correlation-lagged`. It also refuses to degrade at all when
    `action.workflowCompleteAt !== null` — the workflow already proved delivery
    worked, so the watchdog has nothing left to warn about.
  - `markActionWorkflowComplete` (`src/agentLifecycle.ts:315`) clears a sticky
    alert: when the matched entry has `health === "degraded"`, the replacement
    entry is written with `health: "healthy"`. It returns
    `{ state, clearedDegraded: boolean }` so the run loop can journal the
    downgrade. (Existing callers use the return value only as state; the one
    call site is updated in the same commit.)
- `src/state.ts`
  - `journalEventSchema` type enum (`src/state.ts:397`) gains two members:
    `"nudge-deferred"` and `"agent-observability-recovered"`. `details` is
    already `z.record(z.string(), z.unknown())` (`src/state.ts:423`), so no
    schema shape change is needed for the payload.
- `src/runLoop.ts`
  - Order-time delivery (`src/runLoop.ts:586`–`616`): read `result.status`
    instead of the bare string, and on `busy` call a new private
    `journalDeferral(...)` instead of the bare `this.verbose` at
    `src/runLoop.ts:615`.
  - Watchdog block (`src/runLoop.ts:682`–`702`): use the new `cause`. For
    `hooks-never-seen` keep the restart remedy. For `correlation-lagged` emit
    `Issue <n>: no lifecycle signal correlated with the last delivery to <agent> within <ms>ms; duplicate send suppressed. The agent may still be finishing the previous turn — no action needed unless it stays quiet.`
    The journal `details` for `agent-observability-degraded` gains `cause`.
  - Lifecycle wait (`src/runLoop.ts:711`–`751`): replace the verbose-only
    `nudge deferred for <agent>: <reason>` at `src/runLoop.ts:734` with
    `journalDeferral(...)` carrying `layer: "lifecycle"` and
    `code: decision.code`.
  - Broaden lost-delivery recovery (`src/runLoop.ts:720`–`733`): the current
    `canProveLostInjection` predicate additionally admits the case
    `injected.delivery === "injected" && injected.turnId === null &&
     entry.execution === "idle" && decision.code === "idle-transition-already-used"`
    when `this.now() - injected.injectedAt >= this.observabilityWatchdogMs`.
    The positive scrape proof (`actionAbsentAtReadyPrompt`) remains mandatory in
    every branch, so no path can send twice on the strength of elapsed time
    alone. This is what unsticks B4/B5.
  - Post-send deferral (`src/runLoop.ts:786`–`789`): same `journalDeferral(...)`
    treatment, with `layer: "scrape"`.
  - New private `journalDeferral(start, cursors, agent, actionId, actionDigest, layer, code, detail?)`:
    appends one `nudge-deferred` journal event with
    `details: { layer, code, detail, human, hooks: { execution, health, pendingInputCount, backgroundActive }, gateWaiting }`.
    When scrape says busy while `entry.execution === "idle"` and
    `entry.health !== "degraded"`, the same single event carries
    `details.splitBrain: true` — hooks and scrape are recorded on one event, not
    split across two axes. It prints on normal stdout (`this.log`) when the
    workflow is waiting on that agent (its cursor `status` is `ordered` or
    `working` for the current step) or when `splitBrain` is true, and at
    `this.verbose` otherwise. A private `Map<string, string>` keyed
    `<agent>:<actionId>` holds the last printed code so an unchanged reason
    repeating every tick does not repeat on stdout.
  - Workflow-complete call site (`src/runLoop.ts:896`): destructure the new
    return and, when `clearedDegraded` is true, append an
    `agent-observability-recovered` event with
    `details: { reason: "workflow-complete-after-degraded" }` and log
    `Issue <n>: <agent> completed its work; the earlier lifecycle warning is cleared.`
    This is the D5 / "intent-seen is evidence" fix.
- `src/issueReport.ts`
  - Agent lines (`src/issueReport.ts:58`–`67`) append `, alert=<cause>` when the
    entry is degraded, sourced from a new optional `degradedCause` field the
    run loop stores — implemented without a schema change by reading the newest
    `agent-observability-degraded` journal event for that agent in
    `renderIssueReport`'s existing caller. If that plumbing proves to need a new
    parameter, the parameter is added as an optional third argument and the two
    existing call sites (`src/runLoop.ts:1315`, `src/runLoop.ts:1323`) pass it.
- `templates/product/AGENTS.protocol.md`
  - Add one paragraph to the block that already covers post-`complete` behaviour
    (`templates/product/AGENTS.protocol.md:26`): after writing `complete` and
    re-reading `action.md`, if `actionId` is unchanged, print the exact line
    `COORD-IDLE: waiting for the next coordinator action file` as the final line
    of the reply, and print nothing after it. The wording avoids every term in
    `AGENT_FACING_BANNED_TERMS` (`src/agentLanguage.ts:47`), which
    `test/agentLanguage.test.ts:285` enforces.
- `AGENTS.md`
  - The tracked copy carries the same overlay block, so the identical paragraph
    is added to keep the committed file and the template in sync. The
    `skip-worktree` bit is not touched, and no index flags are changed.
- `docs/repo-map.md`
  - The "Harness surface" row (`docs/repo-map.md:28`) gains
    `docs/readiness-policy.md` as the place the scrape-versus-hooks precedence
    is written down; the routing table (`docs/repo-map.md:101`) points readiness
    questions at the same doc.
- `package.json`
  - `version` `0.0.17` → `0.0.18`. `origin/main` is at `0.0.17`, and the
    pre-1.0 ship gate requires a strictly greater version on a non-`main`
    branch. `test/cli.test.ts` and `test/install.test.ts` version assertions are
    rewritten by `pnpm test:fast` itself, so they need no manual edit.
- `test/tmux.test.ts`
  - `test/tmux.test.ts:588`'s assertion `expect(await controller.nudge(...)).toBe("disabled")`
    becomes a `.status` assertion against the new outcome object; the four
    `controller.nudge(...)` call sites at lines 90, 132, 203, 245 are unaffected
    because they discard the return value. New cases listed under **Tests**.
- `test/agentLifecycle.test.ts`, `test/runLoop.test.ts`
  - New cases listed under **Tests**. One existing assertion changes:
    `test/runLoop.test.ts:480` (`expect(messages.join("\n")).toContain("Restart codex's CLI")`)
    becomes an assertion on the correlation-lagged wording, because that fixture
    has already delivered a `SessionStart`-bearing lifecycle and therefore must
    not be told to restart.

## Exact file list to be created

- `docs/readiness-policy.md` — the documented precedence policy required by the
  issue's acceptance list. Contents: the three-layer table above; the rule that
  **scrape is a veto, never an authorization** (a busy scrape always blocks
  typing, because typing into a busy pane corrupts the other turn); the rule
  that **hooks are the duplicate-suppression authority, never a delivery
  blocker for an action that was never sent**; the rule that **`complete` is
  workflow truth and outranks both** (it clears a degraded alert and forbids a
  new degrade for the same action); the full list of reason codes
  (`PromptBlockedReason`, `GateReason`, `WaitCode`) with the operator-facing
  sentence each one maps to; and the explicit statement that a lost delivery is
  only ever retried on positive scrape proof that the action UUID is absent at a
  ready prompt.

No new source module is created: every change lands in a file that already owns
that concern, which is what `docs/repo-map.md` asks for.

## Tests

All tests are added to existing suites and run under `pnpm check:fast`
(`pnpm lint && pnpm typecheck && pnpm test:fast`). Each maps to a lettered case
from the issue.

`test/tmux.test.ts`

1. **A1, Cursor false positive.**
   `harnessPromptReady("I am thinking about the alternatives and their stats\n> ", "cursor")`
   is `true`; `harnessPromptReady("Thinking…\nesc to cancel", "cursor")` is
   `false`; `harnessPromptReady("Generating...\nAuto · 1%", "cursor")` stays
   `false` (regression guard for `test/tmux.test.ts:651`).
2. **A2, busy carries a predicate.**
   `harnessPromptReadiness("Do you trust this folder?", "claude").reason` is
   `"trust-dialog"`; `harnessPromptReadiness("Antigravity CLI\n> \nVerifying your account", "antigravity").reason`
   is `"antigravity-verify-overlay"`.
3. **A2, gate carries a predicate.** With a runner whose `display-message`
   returns `0\tbash\t0\t0`, `nudge` resolves to
   `{ status: "busy", reason: "foreground-mismatch", detail: "bash" }` for an
   agent whose `harnessProcess` is `codex`; with `pane_input_off` set the reason
   is `"input-off"`; with `pane_dead` set the status is `"gone"` and the reason
   is `"pane-dead"`.
4. **Idle sentinel.** `harnessPromptReadiness("<prose>\nCOORD-IDLE: waiting for the next coordinator action file", "cursor")`
   is `{ ready: true, reason: "idle-sentinel" }` even when the prose contains
   `Thinking…` earlier in the buffer, and
   `idleSentinelAfterAction(buffer, actionId, COORD_IDLE_SENTINEL)` is `false`
   when the sentinel precedes the UUID and `true` when it follows it.

`test/agentLifecycle.test.ts`

5. **B2, degrade cause classification.** An entry whose `lastEvent` is `null`
   and `sessionId` is `null`, degraded past the watchdog, yields
   `cause === "hooks-never-seen"`. An entry that has recorded a `SessionStart`
   and a prior turn but no hook after the newest send yields
   `cause === "correlation-lagged"`.
6. **D5, no degrade after workflow truth.** An entry whose
   `action.workflowCompleteAt` is set never degrades: `changed` is `false` and
   `cause` is `null`, however far past the watchdog `now` is.
7. **D5, sticky alert cleared.** `markActionWorkflowComplete` on a `degraded`
   entry returns `clearedDegraded === true` and leaves
   `health === "healthy"`; on a healthy entry it returns `false` and changes
   nothing else.
8. **Wait codes are stable.** `decideLifecycleNudge` returns
   `code === "idle-transition-already-used"` when `lastNudgedIdleEpoch` equals
   `idleEpoch`, `code === "queued"` for a queued execution, and
   `code === "unmatched-action"` for a digest mismatch.

`test/runLoop.test.ts`

9. **A2/D1, deferral is journalled with a code.** Fixture with a pane whose
   foreground never matches: after a tick, the journal contains a
   `nudge-deferred` event with
   `details: { layer: "scrape", code: "foreground-mismatch" }` and the operator
   log contains the human sentence once, not once per tick — a second tick with
   the same reason adds a second journal event but no second stdout line.
10. **B2/D2, degraded message no longer says restart.** The existing watchdog
    fixture (`test/runLoop.test.ts:435`) delivers lifecycle events, so its
    degrade must be classified `correlation-lagged`: assert the messages contain
    `duplicate send suppressed` and **not** `Restart`. A second fixture that
    never emits any lifecycle observation asserts the restart remedy is still
    produced for `hooks-never-seen`.
11. **C1/D4, split brain is one event.** Lifecycle observations put the agent at
    `execution: "idle"`, `health: "healthy"`; the pane scrape reports busy. One
    tick produces exactly one `nudge-deferred` event whose details carry both
    `splitBrain: true` and the hook snapshot `{ execution: "idle", health: "healthy" }`,
    and the message reaches normal stdout.
12. **C2/B3, `Stop` for an older turn still defers, and says why.** After a
    prompt-submit for turn 1 and an action ordered for turn 2, a `Stop` carrying
    turn 1 leaves execution non-idle; the tick journals `nudge-deferred` with
    `layer: "lifecycle"` and a `code` drawn from `WaitCode`, and does not send.
13. **B4/B5, broadened recovery still needs scrape proof.** With an injected
    action, `turnId === null`, `execution: "idle"`,
    `idle-transition-already-used`, and the watchdog elapsed: when the captured
    pane still contains the action UUID, no second send happens; when the pane
    is ready and the UUID is absent, exactly one further send happens and a
    third tick sends nothing more.
14. **D5, recovery event.** After a degrade, writing `complete` and advancing
    produces an `agent-observability-recovered` journal event and leaves
    `health === "healthy"`.

`test/agentLanguage.test.ts`

15. The existing invariant at `test/agentLanguage.test.ts:285` covers the new
    protocol paragraph; no new case is needed, but the sentinel string is added
    to that test's explicit assertions so a future reword cannot smuggle a
    banned term into agent-facing text.

Command run before every commit: `pnpm check:fast`. The coordinator's stricter
gate is `pnpm check` (build, `check:fast`, e2e); the e2e suite
(`vitest.e2e.config.ts`) is unaffected by these changes but is the acceptance
command of record.

## Alternatives Rejected

- **Make hooks authoritative over scrape when they disagree.** Rejected: the
  scrape veto exists because typing into a pane that is mid-turn corrupts the
  other turn and can submit half a prompt. Hook `execution: "idle"` can be stale
  by seconds across a turn boundary — exactly case C3 — so promoting it would
  turn a logging bug into a corruption bug. The chosen fix removes the *false*
  busy (A1) instead of overriding a true one.
- **Retry a suppressed send after a timeout with no scrape proof.** Rejected:
  elapsed time cannot distinguish "the nudge was lost" from "the agent is
  working on it slowly", and a duplicate action delivery makes an agent publish
  twice against one `requiredPath`. Every new recovery branch keeps
  `actionAbsentAtReadyPrompt` mandatory.
- **Drop the 45s watchdog entirely.** Rejected: it is the only signal that a
  vendor hook bridge is genuinely dead, which is a real failure the operator
  must see. The defect is the remedy sentence, not the detection, so the fix
  classifies the cause rather than deleting the check.
- **A new `src/readiness.ts` module for reason codes.** Rejected: the codes are
  produced inside the two functions that already own the decisions
  (`src/tmux.ts`, `src/agentLifecycle.ts`) and consumed in one place
  (`src/runLoop.ts`). A third module would add an import cycle risk and split a
  single concern across files, against the module-group table in
  `docs/repo-map.md`.
- **Have agents emit a machine-readable JSON status line instead of a sentence.**
  Rejected: the scrape reads a rendered TUI viewport with ANSI stripped and
  wrapping applied; a long JSON line wraps and stops matching. A short fixed
  sentence survives wrapping and stays readable to the operator watching the
  pane.
- **Parse the sentinel as authorization to send.** Rejected: the sentinel is
  treated as *positive readiness evidence only*, and only when it is newer than
  the current action UUID in the buffer. Anything stronger would let stale
  scrollback authorize a duplicate delivery.

## Risks and Mitigations

- **Loosening the Cursor regex lets a real in-flight turn through, and a nudge
  is typed into a working pane.** Mitigation: `esc to cancel` — the chrome
  Cursor shows for the whole in-flight turn — keeps its unanchored match, so the
  window where the new anchored status match is the only signal is the sliver
  before that hint renders. Test 1 pins both directions.
- **The `nudge` return-type change is a breaking API change across files.**
  Mitigation: it is a compile-time change with exactly two production call sites
  (`src/runLoop.ts:588`, `src/runLoop.ts:756`) and one test assertion
  (`test/tmux.test.ts:588`); `pnpm typecheck` fails loudly on any missed site,
  and `harnessPromptReady` keeps its boolean signature so the wider surface is
  untouched.
- **New normal-level stdout lines become noise.** Mitigation: a deferral prints
  at normal level only when the workflow is actually waiting on that agent or
  when scrape and hooks disagree, and the per-agent last-printed-code map
  suppresses repeats of an unchanged reason. Every deferral still lands in the
  journal at full detail regardless of what was printed.
- **Broadened recovery double-delivers an action.** Mitigation: the scrape proof
  is mandatory in every branch, `markInjectedActionAbsent` still consumes the
  opportunity, and test 13 asserts that a third tick sends nothing further.
- **Clearing `health` on workflow-complete hides a genuinely dead hook bridge.**
  Mitigation: the clear is scoped to the entry whose action just completed, and
  a later action with no hook traffic degrades again on its own watchdog — with
  cause `hooks-never-seen` if `SessionStart` truly never arrived, which is the
  case where the restart remedy is correct.
- **Agents ignore the new sentinel instruction.** Mitigation: the sentinel is
  additive evidence. Every existing readiness path is unchanged when it is
  absent, so a non-compliant agent is exactly as detectable as it is today.
- **Two new journal event types break a consumer.** Mitigation: `src/analytics.ts`
  filters by `event.type` (`src/analytics.ts:148`, `:201`, `:249`, `:322`,
  `:354`) and never switches exhaustively, so unknown-to-it types are ignored;
  `test/analytics.test.ts` runs unchanged as the guard.

## Conclusion

The defect is that three independent signals are collapsed into one opaque word
at the moment they disagree. This plan keeps the existing precedence — scrape
vetoes typing, hooks suppress duplicates, `complete` is truth — and makes the
disagreement legible: reason codes at every rejection point, one journal event
that carries both sides of a split brain, a degraded message that names what was
actually observed instead of prescribing a restart, a sticky alert that clears
when the workflow proves the agent was fine, a Cursor readiness match that no
longer fires on prose, and an agent-emitted idle sentence that gives the scrape
something positive to see. The one behavioural change beyond messaging — a
broadened lost-delivery recovery — stays gated on the same positive scrape proof
that guards it today, so nothing in this plan can deliver an action twice.
