# Plan — issue 176 (Codex stop hook) with sub-issue 174

## Problem, from runtime evidence

Issue 176 reports that Codex stops after printing `COORD-IDLE` and is never
nudged. Sub-issue 174 reports the same symptom and asks whether agents should
re-check `action.md` after going idle. It also mentions the missing Stop hook
and a stale or version-mismatched Codex app-server.

The persisted state of issue 170 (`coord-runtime/issue-170/agent-lifecycle.json`)
shows the exact failure:

- codex `execution: "working"`, `lastEvent: "UserPromptSubmit"`, `idleEpoch: 0`
  (no Stop was ever applied in that session);
- the next codex action `032690f0…` sat at `delivery: "ordered"`,
  `injectedAt: null`, so it was **never sent once**.

Two gates produce this, both keyed only on lifecycle `execution`:

1. `CoordinatorRunLoop.deliver` (`src/runLoop.ts`, the guard
   `if (entry?.execution === "working" || …) return cursors;`) silently skips
   the initial send that `prepare…` issues right after acceptance.
2. On later ticks `maybeLifecycleNudge` calls `decideLifecycleNudge`
   (`src/agentLifecycle.ts`), which returns `wait / "working"`, and the run
   loop journals `nudge-deferred` with the rationale "the agent is mid-turn".

The agent printed `COORD-IDLE` after its last action, but
`harnessPromptReadiness` treats the sentinel only as an extra reason a pane
counts as ready. It never clears a lifecycle wait. For Codex the sentinel is
not recognized at all: Codex renders an assistant message as
`• COORD-IDLE: …`, followed by its composer (`› …`) and footer lines.
`sentinelAtTail` requires the last non-empty line to equal the sentinel
exactly, so it can never match a Codex pane. Codex readiness also has no
turn-chrome veto: the `case "codex"` branch returns ready unconditionally,
even while the pane shows `• Working (2m 27s • esc to interrupt)`. That line
comes from a live capture of the issue-176 Codex pane.

Why Codex's Stop hook does not fire is decided inside the Codex runtime. That
covers hook trust or review, and app-server state. The installed
`.codex/hooks.json` is correct and its `UserPromptSubmit` entry fires. So this
plan makes the coordinator recover when Stop is missing. It does not try to
repair the vendor.

The rule this plan adds: **before an action's first send there is nothing to
duplicate.** A stale `working` lifecycle record therefore may be overruled by
positive pane evidence that the agent is idle. That evidence is the
`COORD-IDLE` sentinel at the tail of the pane, with every pane veto passing.
After the first send, every existing duplicate-protection rule is unchanged.

## Exact File List to be changed or deleted

- `src/tmux.ts`
  - Add `"codex-turn-chrome"` and `"no-idle-sentinel"` to `PromptBlockedReason`.
  - Codex sentinel recognition: generalize `sentinelAtTail(plain)` into
    `sentinelAtTail(plain, agentId)`. For `codex`, accept the last line whose
    text, after an optional leading `•` and whitespace are removed, equals
    `COORD_IDLE_SENTINEL`. Every later non-empty line must be on a closed
    allowlist, or the check fails closed:
    - at most one composer line starting with `›`;
    - footer lines matching `^\?\s+for shortcuts`, `^Context \d+% left` or
      `\d+% context left`.

    Any other line means "no sentinel proof". That includes a `•` transcript
    item, a second `›`, a numbered modal option, or an app-server or approval
    question. Every other agent keeps its current exact-tail behavior.
  - `harnessPromptReadiness` `case "codex"`: first return
    `{ ready: false, reason: "codex-turn-chrome" }` when one of the last 8
    non-empty lines matches the line-anchored in-flight status
    `^[\s•⠀-⣿]*Working \(.*esc to interrupt`. Otherwise return
    `ready()`, which now reports `idle-sentinel` when the Codex sentinel rule
    above holds. Prose that quotes the status in a bullet or in backticks does
    not match the anchor.
  - `TmuxController.nudge`: add a trailing parameter
    `requireIdleSentinel = false`. When it is true, a readiness that is
    `ready` but not `reason: "idle-sentinel"` returns
    `{ status: "busy", reason: "no-idle-sentinel", stage: "prompt" }` before
    any key is sent. That means no reservation is made and no send is charged.
- `src/runLoop.ts`
  - `deliver`: compute `staleWorking`. It holds when lifecycle
    `execution === "working"` and the lifecycle action is this exact
    `actionId` with `delivery === "ordered"` and `injectedAt === null`, so the
    action has never been sent. The existing early return still applies to
    `working` when `staleWorking` is false. Background activity and pending
    input still always block. When `staleWorking` is true, call
    `tmux.nudge(…, requireIdleSentinel = true)`.

    On success, add `lifecycleOverride: "working"` to the `nudged` journal
    details. Also log one operator line to stdout naming the agent: lifecycle
    hooks still report it mid-turn, its pane printed `COORD-IDLE`, so the
    action was delivered; its Stop hook has not reported, so check the
    vendor's hook trust (for Codex, `/hooks`).

    A `no-idle-sentinel` busy result takes the existing busy branch. That
    branch records `markActionInjectionDeferred` and a scrape-layer deferral.
  - `maybeLifecycleNudge`: when `decideLifecycleNudge` returns
    `wait / "working"` for an action whose lifecycle record is still
    `delivery: "ordered"` with `injectedAt === null`, fall through to
    `deliver` instead of journalling the `working` deferral. `deliver` then
    enforces the sentinel requirement. Every other wait code, and `working`
    after any send, keeps today's deferral path unchanged.
  - `DEFERRAL_RATIONALE`: add `"codex-turn-chrome"` ("the pane shows in-flight
    turn chrome") and `"no-idle-sentinel"` ("lifecycle hooks report the agent
    mid-turn and its pane shows no COORD-IDLE line since its last action").
    The doc comment above this map requires an entry for every
    `PromptBlockedReason`.
- `docs/readiness-policy.md`
  - Under "Positive evidence is additive", document the single exception.
    Before an action's first send, a tail `COORD-IDLE` sentinel that passes
    every veto can overrule a lifecycle `working` record, and the send is
    journalled with `lifecycleOverride`. Describe the Codex sentinel shape and
    its fail-closed trailing-line allowlist.
  - Add `codex-turn-chrome` and `no-idle-sentinel` to the prompt-readiness
    code table.
- `test/tmux.test.ts`: new cases (see Tests).
- `test/runLoop.test.ts`: new case (see Tests).

Nothing is deleted.

## Exact file list to be created

None, apart from this coordination artifact (`.plans/issue-176/plan.md`). The
implementation creates no product, test or doc file.

## Reuse and Scope

Reused, not reimplemented:

- `COORD_IDLE_SENTINEL`, `stripAnsi`, `idleSentinelAfterAction`,
  `harnessPromptReadiness`, `PromptReadiness`, `SPINNER_PREFIX` in
  `src/tmux.ts`. The Codex rule is a branch of the existing sentinel helper,
  not a second detector.
- `TmuxController.nudge`, `injectionGate` and `capturePane`. The sentinel
  requirement is checked on the capture `nudge` already takes, so there is no
  extra pane read and no race window between two captures.
- `CoordinatorRunLoop.deliver`, `maybeLifecycleNudge`, `journalDeferral`,
  `DEFERRAL_RATIONALE` and `deferralRationale`. Also the existing busy branch
  with `markActionInjectionDeferred`, and `markActionInjected`, which leaves
  later duplicate protection to `decideLifecycleNudge` unchanged.
- `decideLifecycleNudge` and `applyLifecycleObservation` stay untouched.
  Lifecycle state is not rewritten to `idle`, so the coordinator never
  fabricates an execution state or a Stop event. The override exists only
  inside the delivery decision.
- Tests reuse the `fixture()` helper, `TmuxController` with a fake runner,
  `observeAgentLifecycle`, `readAgentLifecycle` and `readJournal`. They follow
  the existing codex nudge test "does not warn at 45 seconds and nudges once
  after a positive idle transition" (`test/runLoop.test.ts`). The tmux cases
  join the existing `harnessPromptReadiness` sentinel block in
  `test/tmux.test.ts`, the one asserting `idleSentinelAfterAction`.

Scope boundaries:

- **Codex Stop hook root cause.** Not changed. Hook loading and trust are
  vendor-runtime state, and the installed hook document is correct. The new
  operator log line surfaces the gap whenever the override is used.
- **174's "agents should re-check `action.md` after going idle".** No
  protocol change. See Alternatives Rejected.
- **174's stale app-server and version-mismatch prompt.** No dedicated
  detector. The prompt's wording could not be found in the installed
  `codex-cli 0.160.1` binary, and guessing a regex would be speculative. The
  fail-closed allowlist means such a prompt below the sentinel blocks the
  override. Restarting Codex's app-server stays an operator action and is a
  candidate for a follow-up issue.
- A separate observation: in the live issue-176 session Codex runs in the
  `control` tmux window and the `codex` window is gone. That explains this
  issue's `delivery-uncertain` holds. It is an operator and session condition
  and is out of scope here.

## Tests

Each case fails before the change and passes after it.

`test/tmux.test.ts`, joining the existing `harnessPromptReadiness` sentinel
block:

1. **Codex turn chrome vetoes.** A Codex pane modelled on the live capture:
   transcript items, then `• Working (2m 27s • esc to interrupt)`, then
   `› Ask Codex to do anything`, then the two footer lines. It returns
   `{ ready: false, reason: "codex-turn-chrome" }`. Today it returns ready.
2. **Codex sentinel recognized, fail closed.**
   - `• COORD-IDLE: waiting for the next coordinator action file`, then the
     `›` composer, then both footer lines, returns
     `{ ready: true, reason: "idle-sentinel" }`. Today it returns
     `vendor-prompt`.
   - In the same test, the same pane with an extra `  2. No, continue
     without …` line after the sentinel returns `reason: "vendor-prompt"`.
   - In the same test, a pane where the current action id appears after the
     sentinel returns `reason: "vendor-prompt"`.

`test/runLoop.test.ts`, next to "does not warn at 45 seconds and nudges once
after a positive idle transition":

3. **A stale `working` record is overruled only by the sentinel, and only
   before the first send.**
   - Setup: codex `delivery: "both"`, `harnessProcess: "codex"`. Before the
     first tick, call `observeAgentLifecycle` with a `prompt-submitted` for
     session-1 and no Stop, so execution is `working`.
   - Tick with a pane that has no sentinel: no literal `send-keys`. The
     lifecycle action stays `delivery: "ordered"`, and a `nudge-deferred` is
     journalled (`no-idle-sentinel` or `working`).
   - Set the pane to the Codex sentinel fixture and tick: exactly one literal
     send. The journalled `nudged` details include
     `readiness: "idle-sentinel"` and `lifecycleOverride: "working"`, and
     lifecycle `delivery` is `injected`.
   - Tick again with the same pane: still exactly one send. Duplicate
     protection resumes after the first send.

   Today the first assertion holds, but the second fails: no send ever
   happens.

Checks: during development, run these focused tests with
`pnpm vitest run --config vitest.config.ts test/tmux.test.ts test/runLoop.test.ts`.
The pre-commit hook runs `pnpm check:fast` (lint, typecheck, fast and system
tests). The coordinator owns the final `pnpm check` at the approved pin.

## Alternatives Rejected

- **Make agents poll `action.md` after going idle (174's suggestion).** A turn
  that sleeps and re-reads stays in flight. It keeps lifecycle `working`,
  which is exactly what blocks nudges, and it spends vendor quota while idle.
  Once the turn ends the agent has no trigger to re-read. The protocol already
  requires one re-read before `COORD-IDLE`, so delivery has to come from the
  coordinator.
- **Treat the sentinel as a lifecycle `idle` observation** (write
  `execution: "idle"` and bump `idleEpoch`). That would fabricate a vendor
  event that `docs/readiness-policy.md` forbids. It would also authorize
  resends of *already sent* actions through `decideLifecycleNudge`, which
  would turn a pane scrape into duplicate authority.
- **Time out a stale `working` state.** Elapsed time cannot distinguish a long
  quiet turn from a lost Stop. The policy ("Quiet work is normal") rules out
  time as authority, and typing into a running Codex turn appends to or
  cancels that turn.
- **Synthesize a Stop from Codex's transcript or rollout files.** This
  depends on vendor-internal file formats. It is larger, and it is still
  inference rather than a vendor event.
- **Detect the app-server mismatch prompt by text now.** Its wording is not
  available locally, and a guessed pattern could either miss it or
  false-match. The fail-closed allowlist already keeps the override from
  typing into it.
- **Allow the override for `queued` and `unknown` too.** `queued` already
  encodes pending input or background work. `unknown` does not block the
  initial send, and the reported failure is specifically a stale `working`
  record. Keeping the exception to that one code limits blast radius.

## Risks and Mitigations

- **Typing into a live Codex turn.**
  - The override requires that the action has never been sent, that the
    sentinel is at the tail and comes after any mention of the action id, and
    that the new `codex-turn-chrome` veto passes.
  - Pending input and background activity still block.
  - `injectionGate` still vetoes owner typing, copy mode, disabled input,
    foreground mismatch and a dead pane.
  - A false busy is recoverable; the design prefers it to a false send.
- **Codex footer or composer wording changes.** Unknown trailing lines fail
  closed, so the result is today's behavior (deferral), never an unsafe send.
  The tests pin the observed layout.
- **Prose that quotes the in-flight status line.** The match is line-anchored
  to whitespace, `•` or a braille spinner, limited to the last 8 non-empty
  lines, and requires `esc to interrupt`. Bulleted or backticked prose does
  not match. A residual false match only delays delivery.
- **The new veto also applies to ordinary Codex nudges.** It only removes
  sends during a visible in-flight turn, so it makes no previously unsafe
  send happen. Existing codex nudge tests use panes without that chrome, so
  they keep their behavior.
- **A stale sentinel from an earlier action.** The capture keeps 40 lines.
  The sentinel must be the last transcript item with only the allowlisted
  chrome after it. Any later work adds `•` items and invalidates it. The
  override also applies only before the first send of the current action.
- **The missing Stop stays undiagnosed.** Each override logs an operator line
  that names the hook gap and the vendor's hook review surface, so the
  workaround does not hide it.

## Conclusion

The workflow stalls because a missing Codex Stop event leaves lifecycle
`working` forever. Both the initial send and every later nudge are gated on
that field, so a new action is never sent even though the agent printed
`COORD-IDLE`.

The smallest complete fix is a narrow delivery exception. Before an action's
first send, a Codex-aware tail `COORD-IDLE` sentinel that passes every pane
veto overrules a stale `working` record. Codex readiness also gains a
turn-chrome veto. All changes are in `src/tmux.ts` and `src/runLoop.ts`, plus
the policy doc and three focused tests in the existing test files. There are
no new files, no vendor-hook rewrites and no fabricated lifecycle events.
Duplicate protection after the first send is unchanged. The Stop-hook root
cause and app-server handling remain vendor and operator concerns, and each
use of the override names them in the operator log.
