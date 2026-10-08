# Issue 181 — plan review (claude)

Bound plans reviewed:

- claude `e5799ab1db49b0bb61d8d333b1c515c4d378a50a`
- cursor `849745d7cee1911d5ce7f0d5d12d87a2de3e39c8`
- codex `ea32c444439647a453ad05ebd45ea135a5237dce`
- antigravity `9fa11cb87b296c072d853f13b218897c25231b55`

The evidence all four plans must answer to is the following.

- The issue screenshot shows the Codex pane bottom as `COORD-IDLE …`, then
  `Worked for 5m 21s • 5:42 AM`, then `› Ask Codex to do anything` (a dim
  placeholder), then `Context 36% left · … Vim: Insert`, then
  `← for agents · ? for shortcuts … ⚠ 1 warning · f2 to view`.
- The issue-161 journal: every stalled Codex action
  (`ce2adaf4`, `3f5e85a7`, `131f6b29`) went `codex-turn-chrome` →
  `codex-composer-not-ready` and then nothing until the owner typed. Codex
  lifecycle is `unknown` (no correlated hooks). Its ready receipt made
  `fileReady` true in `maybeLifecycleNudge` (`src/runLoop.ts:1820`). So
  `deliver()` already ran with a `ready-file` override, and
  `TmuxController.nudge` refused at `src/tmux.ts:1038` because `CODEX_FOOTER`
  (`src/tmux.ts:130`) rejects the `← for agents` line.
- Antigravity's issue-161 deferral (seq 444, `working`) came three seconds
  after it was nudged (seq 438), during a hook-confirmed live turn. Its
  review was then accepted normally. It is not a defect.

## Findings

### F1 — antigravity plan, Exact File List / Scope item 3 (`src/agentEvent.ts` `fullyIdle` default) — blocking

- **Plan claim:** Antigravity `Stop` without `fullyIdle` should normalize to
  `backgroundActive: false, allowInjectedIdle: true`. The plan calls this a
  root cause of issue 181.
- **Rule:** Lifecycle evidence that is missing must fail closed. The documented
  contract (`docs/coord-driver.md:441-443`) is that Antigravity queue depth,
  pending tool confirmations and `fullyIdle: false` keep an agent non-idle
  after a stop callback. Only positive `fullyIdle: true` may authorize
  injected-idle, which `test/agentEvent.test.ts:271-275` pins. A change must
  also be justified by the issue's evidence.
- **Failure if followed:** An agy build or payload that omits `fullyIdle` while
  a background task is still running would now emit
  `allowInjectedIdle: true`. `decideLifecycleNudge` (`src/agentLifecycle.ts:792`)
  stops returning `background-active`, and the coordinator types the next
  action into a pane whose agent is still working. Meanwhile issue 181 is not
  fixed by it: no issue-161 Antigravity deferral in the reported window was
  `background-active`. Seq 444 is `working` during a real turn, and the only
  `background-active` (seq 2563, 13:26) came from a `queued` status-line,
  not a Stop default.
- **Correction:** Drop `src/agentEvent.ts` and `test/agentEvent.test.ts` from
  the file map.

### F2 — antigravity plan, Scope item 4 / Tests 3 (suppress `nudge-deferred` for injected `working` actions) — blocking

- **Plan claim:** Deferrals for an injected action in `working` are "false"
  and should no longer be journaled or logged.
- **Rule:** A deferral that is truthful must stay observable. The
  `journalDeferral` record (`src/runLoop.ts:1852-1861`) is the only owner-facing
  explanation of why an in-flight action is not progressing. Changes must
  stay within the issue's defect.
- **Failure if followed:** In the issue-176 shape (a Stop that never reaches
  this issue), an injected action sits in `working` forever. With this change,
  `coord status` and the coordinator log say nothing, so the owner loses the
  very diagnostic the issue reporter used to find the stall. The Codex stall
  is not affected at all: it was a `scrape`-layer refusal, not a lifecycle
  deferral.
- **Correction:** Remove this item. The plan's Scope also says "three root
  causes" and then lists four. The fixed plan should list only the two Codex
  parsing defects.

### F3 — cursor plan, Exact File List `src/runLoop.ts` (treat never-sent `unknown` like stale `working`) — blocking

- **Plan claim:** A never-sent action with lifecycle `unknown` is
  lifecycle-deferred before `deliver()` can use file or terminal proof, and
  the `neverSentWorking` gate should be extended to `unknown`.
- **Rule:** Only proven idleness may unlock a send that lifecycle would
  otherwise veto. That proof is a ready receipt or a current sentinel
  carried as `staleOverride`. A change must also fix an observed failure.
- **Failure if followed:** The premise is false for the reported stall.
  `fileReady` already admits `unknown` with a receipt (`src/runLoop.ts:1820-1821`),
  and the journal shows `deliver()` ran and was refused by the pane parser.
  The extension only changes the no-proof case. There, `deliver()` builds
  `staleOverride` only for `receipt !== null || staleWorking || owner`
  (`src/runLoop.ts:1188`), and `staleWorking` requires `execution === "working"`.
  So an `unknown` never-sent action now goes to `nudge` with no override. For
  Codex, `harnessPromptReadiness` then returns `vendor-prompt` whenever no
  turn chrome is visible (`src/tmux.ts:305-308`). The composer-empty check
  (`src/tmux.ts:1038`) is skipped because it applies only to the
  `ready-file` path. On every idle poll, the action text is appended to an
  owner's unsent draft and submitted with it.
- **Correction:** Remove the `src/runLoop.ts` change and its
  `test/runLoop.test.ts` case 4.

### F4 — cursor plan, `src/tmux.ts` wrapped-placeholder and Antigravity/Claude sentinel-above-prompt items — blocking (scope and completeness)

- **Plan claim:** Treat a wrapped dim placeholder as an empty composer.
  Count COORD-IDLE above Antigravity's prompt chrome ("and Claude, if the
  same last-line rule is shared").
- **Rule:** The plan must make the smallest change that fixes the observed
  defect, and its file map must be mechanically complete, without
  conditional scope.
- **Failure if followed:**
  - The captured composer is one line (`› Ask Codex to do anything` in a pane
    more than 100 columns wide). No evidence shows a wrapped placeholder, so
    the item adds untested acceptance for a layout no one observed.
  - The Antigravity item fixes no observed failure (see the Antigravity
    evidence above).
  - "Claude, if shared" leaves an implementer unable to tell whether Claude
    readiness (`src/tmux.ts:289-292`) changes. That is a scope decision
    deferred to implementation time, and a reviewer cannot check it against
    the plan.
  - Separately, the plan never names the actual root cause, the
    `← for agents · ? for shortcuts` footer (`CODEX_FOOTER`,
    `src/tmux.ts:130`). Its Tests 1 uses "known footer", so an implementation
    that follows the plan as written keeps the stall: with the live footer,
    every ready-file send still returns `codex-composer-not-ready`.
- **Correction:** Replace these items with the footer fix. Restrict the
  `tmux.ts` change to the two observed Codex lines.

### F5 — codex plan, Exact File List (no `docs/readiness-policy.md` update) — non-blocking

- **Plan claim:** Change `src/tmux.ts` and two test files only.
- **Rule:** The documented readiness policy must describe the predicate
  coord enforces. `docs/readiness-policy.md:92-96` lists the accepted Codex
  chrome as exactly `? for shortcuts` and `Context N% left`, with "any other
  line fails closed".
- **Failure if followed:** After the fix, coord accepts
  `← for agents · ? for shortcuts` and a `Worked for …` line that the policy
  doc says are refused. An operator who diagnoses a future
  `codex-composer-not-ready` from the doc will look for the wrong lines.
- **Correction:** Add `docs/readiness-policy.md` to the file map.

### F6 — codex plan, Tests 3 (`test/runLoop.test.ts` workflow regression) — non-blocking

- **Plan claim:** Add a combined run-loop scenario: real acceptance, the
  ready receipt kept while busy, delivery once idle, coordinator restart
  reconstruction, and an accepted Antigravity peer that must not be resent.
- **Rule:** Add the fewest focused tests that fail before the change. The
  plan itself states that `readyForNextAction`, `deliver`,
  `maybeLifecycleNudge` and `decideLifecycleNudge` stay unchanged.
- **Failure if followed:** This scenario's only pre-fix failure comes from
  the footer predicate, which `test/tmux.test.ts`'s ready-file `attempt()`
  already exposes. The restart and Antigravity-peer legs test unchanged code
  and add a large fixture to an already slow suite. That is the suite that
  times out under concurrent peer runs in the pre-commit `check:fast`.
- **Correction:** Keep at most one `runLoop.test.ts` case that delivers a
  never-sent Codex action from a ready receipt with the live footer. Drop the
  restart and peer legs.

### F7 — antigravity plan, Alternatives 1 (`/^Worked for\s+/`) — non-blocking

- **Plan claim:** Allow the completion summary matching `/^Worked for\s+/`.
- **Rule:** Pane chrome patterns must be anchored to the whole line, so text
  that only starts the same way is not accepted
  (`src/tmux.ts:93-109`, `codexTurnChrome`).
- **Failure if followed:** A line between the sentinel and the composer such
  as `Worked for the reviewer: choose 1 or 2` would be skipped as chrome, so
  coord would treat a pane holding unknown content as idle proof.
- **Correction:** Match the whole line. Allow only a duration plus an
  optional `• h:mm AM/PM`, as the claude and codex plans specify.

### claude plan (e5799ab1) — no blocking findings

It names the footer root cause and the turn-summary line, cites the journal
sequence, keeps `runLoop.ts` unchanged, and includes the docs update. Its
tests extend the existing `codexPane` / `attempt` fixtures. One clarification
for implementation, which needs no plan change: `codexVimNormal` and
`codexComposerHolds` also consume `codexTail` /
`linesAfterCodexSentinel`, so they inherit the fix. The `vim: "Normal"`
`attempt` case covers that.

### Scope and reuse summary

- **claude:** within scope; reuses existing helpers and fixtures; no new
  files; focused tests.
- **codex:** within scope; reuses existing helpers; no new files; tests
  heavier than needed (F6); docs gap (F5).
- **cursor:** expands into `runLoop.ts` and Antigravity/Claude readiness
  without evidence (F3, F4), introduces an unsafe path (F3), and misses the
  footer root cause (F4).
- **antigravity:** expands into `agentEvent.ts` and deferral logging without
  evidence (F1, F2), inverts a fail-closed default (F1), and loosens the
  summary pattern (F7).

## Conclusion

**claude** and **codex** are acceptable; prefer claude for its smaller test
footprint and its docs update. If codex is chosen, apply F5 and trim per F6.

**cursor** needs revision (F3, F4) before it could be implemented safely:
followed as written, it leaves the stall in place and adds a draft-append
hazard.

**antigravity** needs revision (F1, F2, F7): its Codex parsing items are
right, but the `fullyIdle` default flip and the deferral suppression remove
fail-closed protections and fall outside issue 181.
