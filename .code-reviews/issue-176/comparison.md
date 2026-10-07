# Implementation comparison — issue 176

Bound implementation pins compared:

- claude `5461bac8a5165f2a7fc1c0deee3e7739de52fb98`
- cursor `174754e30bd40cb6fd98e6fa12a8fc71374f3eff`
- codex `5aa03e9cdd09627a81b41e9f4baa8ee61cce8dbc`

## Comparison

### Method

- **Baseline diffs.** I extracted the baseline files at
  `6fba7643f3cd7b8dd758c13f3ae2371c0936d75e` with `git archive`. I then
  compared them with plain `diff` against each bound worktree, for
  `src/tmux.ts`, `src/runLoop.ts`, `docs/readiness-policy.md`,
  `test/tmux.test.ts` and `test/runLoop.test.ts`.
- **Live-pane probe.** I copied each worktree's `src/` into a scratch
  directory and called each pin's exported `harnessPromptReadiness(…,
  "codex", actionId)` from a throwaway vitest file. The input was the raw
  ANSI composer and footer lines captured read-only from the live issue-176
  Codex 0.160.1 pane, in three variants:
  - the dimmed placeholder `Ask Codex to do anything`;
  - the binary's other dimmed placeholder `Ask a follow-up question`, found
    with `strings` on the installed CLI;
  - an undimmed owner draft `Please inspect my changes`.

  Each variant was preceded by `• COORD-IDLE: waiting for the next
  coordinator action file`.

| pin | placeholder | follow-up placeholder | owner draft |
| --- | --- | --- | --- |
| claude `5461bac8` | `idle-sentinel` | `idle-sentinel` | `vendor-prompt` (refused) |
| cursor `174754e3` | `idle-sentinel` | `idle-sentinel` | **`idle-sentinel`** |
| codex `5aa03e9c` | **`vendor-prompt`** | **`vendor-prompt`** | `vendor-prompt` |

- **Correct results:** sentinel proof for both placeholders and none for a
  draft.
- **cursor:** accepts the draft.
- **codex:** never produces sentinel proof on the real pane.

### Shared shape

All three pins implement the selected plan's mechanism in the same five
approved files:

- a `codex-turn-chrome` veto on the anchored `Working (… esc to interrupt)`
  line;
- Codex-aware sentinel recognition;
- `requireIdleSentinel` on `TmuxController.nudge`;
- a `staleWorking` first-send exception in `CoordinatorRunLoop.deliver`;
- the `maybeLifecycleNudge` fall-through;
- `lifecycleOverride` in the `nudged` journal;
- the policy doc update.

None adds files. None touches `src/agentEvent.ts` or `scripts/lib/launcher.sh`,
so the event-routing cause identified in review remains for a follow-up under
any pin.

### Findings

**C1 — cursor `src/tmux.ts:112-116` (`codexTrailingAllowlisted`) accepts any
`›` line, so an unsent owner draft counts as idle proof.** (blocking)

- **Rule:** the sentinel override may type only into an empty composer. Text
  the owner has typed but not sent must veto, because the nudge is appended
  to it and submitted with it. The `owner-typing` gate only reflects tmux
  `pane_in_mode`, so it does not catch a draft.
- **Failure:** in the live-pane probe above, cursor returns
  `{ ready: true, reason: "idle-sentinel" }` for `› Please inspect my
  changes`. In `deliver` with `staleWorking`, the coordinator would then
  type `Read and execute coordinator action …` after the owner's draft and
  press Enter, submitting one merged prompt.
- **Test:** the claude pin's `test/tmux.test.ts` case "vetoes a live Codex
  turn and reads its idle sentinel only above an empty composer" asserts
  `vendor-prompt` for exactly this draft. It fails on cursor.

**C2 — cursor `src/tmux.ts:950` (`send`) never rechecks the pane at key
boundaries on the override path.** (blocking)

- **Rule:** an exception that overrules a lifecycle `working` veto must
  still hold when the first key is sent. Codex's own review of the plan
  raised this (finding 3).
- **Failure:** the first capture shows the sentinel. Before the prelude key,
  the owner submits a prompt and Codex paints `• Working (1s • esc to
  interrupt)`. cursor's `send` re-runs only `injectionGate`, plus a capture
  for Claude only. The coordinator therefore types and submits into the new
  turn.
- **Test:** the claude pin's "sends a sentinel-required nudge only while the
  idle proof holds at each key" case scripts exactly this capture sequence.
  It expects `codex-turn-chrome` and no keys sent; cursor sends keys.

**C3 — codex `src/tmux.ts:120-122` (footer regex) and `:128` (exact
placeholder list) reject the real Codex 0.160.1 pane.** (blocking)

- **Rule:** the sentinel's trailing-line check must accept the footer and
  placeholder Codex actually renders. Otherwise the selected fix never fires,
  and issue 170's stall is unchanged on the real harness.
- **Failure:** the live footer lines are
  - `Context 13% left · weekly 93% left · 258K window · 261K used · …
    Vim: Insert`
  - `? for shortcuts … ⚠ 1 warning · f2 to view`

  The `$`-anchored regex admits only `Context N% left( · Vim: …)?` and
  `? for shortcuts( N% context left)?`, so neither live line matches and
  `codexIdlePane` returns `null`. The probe confirms codex returns
  `vendor-prompt` for the plain placeholder. With lifecycle at a stale
  `working`, every send then ends in `no-idle-sentinel` forever.

  Separately, the exact list `["", "Ask Codex to do anything"]` rejects the
  binary's `Ask a follow-up question` placeholder.
- **Test:** feed the captured raw footer lines, with
  `• COORD-IDLE…` and the dimmed `Ask Codex to do anything` composer, to
  `harnessPromptReadiness(…, "codex", id)` and expect `idle-sentinel`. It
  fails at codex's pin. Distinguishing placeholder from draft by the
  dim attribute (claude's `codexComposerEmpty`) avoids both brittle lists.

**C4 — claude `src/runLoop.ts:1094` relies on pane rechecks, not lifecycle
rechecks, between capture and first key.** (non-blocking)

- **Rule:** a lifecycle prompt-submit that arrives after the readiness
  capture should cancel the override before any key, without charging a
  send.
- **Failure:** a hook-reported prompt that Codex has not yet painted as
  `Working (…)` at the instant of the per-key recapture would not stop the
  first key. The window is a few milliseconds, so this is far narrower than
  C2.
- **Comparison:** codex's `deliveryState` snapshot
  (`src/runLoop.ts:1116`) closes this precisely and is worth porting to the
  selected pin.

**C5 — cursor `src/runLoop.ts:1137` misdirects the operator.** (non-blocking)

- **Rule:** the log line must name the observed gap.
- **Failure:** it says "check vendor hook trust (for Codex, /hooks)". The
  issue-176 evidence is that Codex hooks are trusted and firing, but their
  events are dropped or misrouted by `COORD_ISSUE` and fallback routing.
  claude's message names `COORD_ISSUE`; codex's names "hook routing".

### Scope, reuse and test focus

- **claude:**
  - Smallest diff: 81, 28, 18, 54 and 37 changed lines across the five
    files.
  - It reuses `stripAnsi`, `idleSentinelAfterAction`, `harnessPromptReadiness`,
    `journalDeferral` and the existing busy branch.
  - Two focused tmux cases and one runLoop regression, added to existing
    files.
  - `staleWorking` is vendor-neutral, but only Codex's renderer can satisfy
    it beyond an exact last line.
- **cursor:**
  - Similar logic, but `src/runLoop.ts` changes 144 lines. Most of that is
    re-indenting the unchanged lost-delivery block inside `if
    (!neverSentWorking)`, an avoidable refactor.
  - Tests are focused but miss the draft and race cases (C1, C2).
- **codex:**
  - The broadest diff: 95, 33, 33, 119 and 95 lines.
  - Valuable extras: lifecycle freshness (`deliveryState`), skipping the
    Codex `i` prelude when the composer is already in Vim INSERT, and
    stopping before a fallback Enter once a correlated prompt hook proves
    acceptance.
  - It limits the exception to `agent === "codex"` with
    `acceptedAt`/`workflowCompleteAt` null.
  - Its readiness gate rejects the real pane (C3), so the extra machinery
    never runs in practice.

### Ranking

1. **claude `5461bac8a5165f2a7fc1c0deee3e7739de52fb98`.** It is the only pin
   whose readiness accepts the real Codex placeholder and rejects an owner
   draft. It rechecks at every key, has the smallest scope and has focused
   tests. Optional improvement: port codex's lifecycle snapshot (C4).
2. **codex `5aa03e9cdd09627a81b41e9f4baa8ee61cce8dbc`.** It has the
   strongest send-boundary logic, but is inert on the real pane (C3).
3. **cursor `174754e30bd40cb6fd98e6fa12a8fc71374f3eff`.** It fires on the
   real pane but types into owner drafts and live turns (C1, C2).

Checks run for this comparison:

- the file diffs against the baseline described above;
- the scratch live-pane probe, one vitest file importing each pin's copied
  `src/tmux.ts`; outputs are in the table above.

No product suite was run, and no coordinator checks are claimed.
