# Plan review — issue 176 (with sub-issue 174)

Bound plans reviewed:

- claude `7fa11abb8c9f49ae44bf9891bd9e9933024bb612` (`.plans/issue-176/plan.md`)
- codex `d039ad6d99dded4c7188eb3558d64f8889683046` (`.plans/issue-176/plan.md`)
- cursor `d1bf5b904a25b5372904fbec43faac67df8c0220` (`.plans/issue-176/plan.md`)

## Runtime evidence gathered for this review

All of this was read from the workspace runtime under
`/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime`. Nothing was modified.

1. **Codex's Stop hook does fire; its events go to the wrong issue or are
   dropped.**
   - `issue-139/journal.jsonl` holds 57 Codex `Stop` lifecycle events, the last
     at `2026-10-06T19:44:50Z`. Issue 139's PR was created on 2026-10-02.
   - `issue-106/journal.jsonl` holds Codex `SessionStart` ×2,
     `UserPromptSubmit` ×7, `Stop` ×6 and `SessionEnd` ×1, all between
     `2026-10-06T19:48Z` and `21:08Z`. Issue 106 started on 2026-09-02, so
     these events came from a session working on a different issue.
   - `issue-106/agent-lifecycle.json` reports Codex `failed / SessionEnd`,
     `idleEpoch: 40`.
2. **Issue 170's Codex session never delivered a SessionStart or a Stop
   anywhere.**
   - Session `01a11337…` recorded `UserPromptSubmit` in issue 170 at
     `2026-10-06T21:56:07Z` and `2026-10-07T04:27:39Z`.
   - No issue directory received any Codex `SessionStart` or `Stop` after
     `2026-10-06T21:08Z`.
   - Issue 170's Codex entry is therefore `working`, `idleEpoch: 0`.
3. **Why the routing fails.** `handleAgentEvent` (`src/agentEvent.ts`)
   resolves the issue in this order:
   1. `--issue`;
   2. the hook process's `COORD_ISSUE` (`src/cli.ts`,
      `environmentIssue: io.env.COORD_ISSUE`);
   3. the action path inside a prompt (`issueFromRaw`);
   4. the single runtime that lists the agent and is neither `completed` nor
      `abandoned`.

   `UserPromptSubmit` carries the action path, so it routes correctly even
   without `COORD_ISSUE`. `Stop` and `SessionStart` carry no prompt. Today the
   fallback finds two candidates for Codex, `issue-106` and `issue-176`.
   Issue 106 is stale but never marked completed or abandoned. With two
   candidates `issue` resolves to `null` and the event is silently dropped
   (`observed: false`). On 2026-10-06 between 19:48 and 21:08, 106 was the
   only candidate, so Codex events from an unrelated session were written
   into issue 106.
4. **Why `COORD_ISSUE` is missing.**
   - Codex hooks are absent from the environment the launcher sets, unlike
     Claude and Cursor, whose hooks run as children of the tmux-launched CLI.
   - The installed `codex-cli 0.160.1` `--help` documents `--no-daemon`: "Run
     without the shared background server, even if it is already running".
   - The generated launcher (`scripts/lib/launcher.sh`) runs
     `codex --ask-for-approval never --sandbox workspace-write …` without it.

   This is consistent with hooks being executed by a shared app-server that
   never received the issue's tmux environment. That is exactly 174's "codex
   can have its app-server running on an old issue".
5. **Issue 176 itself.**
   - Codex's lifecycle entry is `unknown` with no events at all, and `coord
     status` reports "session identity unavailable".
   - Codex's planning action `6ff345da…` received a `delivery-uncertain` hold
     at `17:36:25.099Z`. That is 1.8 s after Codex's join was seen
     (`intent-seen` at `17:36:23.294Z`): the next action is prepared and
     delivery attempted within about 2 s of the agent's `complete`, while the
     agent is still inside its post-completion re-read.

## Findings

### F1 — All three plans misidentify the cause: Stop is misrouted, not missing (blocking for all three)

- **Plan claims.**
  - claude, "Problem, from runtime evidence": the Stop root cause lies inside
    the Codex runtime and "this plan makes the coordinator recover when Stop
    is missing".
  - cursor, "Problem" step 2 and Approach: the Stop hook "never journals",
    and the fix clears stale `working` at order time.
  - codex, "Evidence and limits" and Risks: the cause "has not been proven",
    and `--no-daemon` "prevents a known class of shared-process reuse".
- **Rule.** A plan must fix the cause the runtime evidence shows, or at least
  stop the coordinator from losing or misapplying vendor lifecycle events. A
  recovery heuristic must not stand in for a routing defect that is still
  writing into other issues.
- **Failure if followed as written.**
  - Under the claude and cursor plans, Codex `Stop` and `SessionStart` keep
    resolving to `null` and being dropped whenever more than one runtime lists
    Codex as active (today: 106 and 176). They also keep being written into a
    stale issue whenever only one candidate remains, which is how issue 106
    got `idleEpoch: 40` and `execution: failed` from an unrelated session.
  - Issue 176's Codex stays `unknown`, with containment "session identity
    unavailable", because `SessionStart` never lands.
  - The claude plan's override only engages on `working`, so it does nothing
    for issue 176's actual state.
  - The codex plan's launcher change likely restores `COORD_ISSUE`, but it
    leaves the `agent-event` fallback able to write into a stale runtime for
    any session that still lacks the variable.
- **Smallest correction.** Make issue resolution in `handleAgentEvent` safe
  for prompt-less events. When neither `COORD_ISSUE` nor a prompt names the
  issue, route by the event's `session_id`. Choose the single non-completed
  runtime whose lifecycle entry for this agent already holds that
  `sessionId`. `UserPromptSubmit` establishes it, as it did in issue 170.
  Otherwise drop the event and journal nothing; never pick "the only active
  issue" for an event whose session is unknown to it. Add a regression case
  to `test/agentEvent.test.ts`: a prompt-submit with an action path, then a
  `Stop` with the same `session_id` and no `COORD_ISSUE`, while a second stale
  runtime lists the agent. Today the Stop is dropped; after the fix it reaches
  the prompt's issue and idles it. Pair this with the codex plan's
  `--no-daemon` launch, so Codex hooks inherit `COORD_ISSUE` like the other
  vendors.

### F2 — cursor: clearing `working` at order time types into a live turn (blocking)

- **Plan claim.** Exact File List, `src/agentLifecycle.ts`: in
  `orderAgentAction`, when the previous action has `workflowCompleteAt`, set
  `execution` to `idle`, clear `turnId` and advance `idleEpoch`.
- **Rule.** `workflowCompleteAt` proves the artifact was published, not that
  the turn ended. The protocol requires every agent to re-read `action.md`
  after writing `complete` and to execute a changed action at once. The
  readiness policy forbids fabricating execution state ("Quiet work is
  normal … does not fabricate acceptance, execution state or completion").
- **Failure if followed as written.**
  - Issue 176 shows the next action prepared 1.8 s after Codex's `complete`
    was seen. `prepareAction` then calls `deliver(…, "initial")`.
  - With `execution` forced to `idle`, the only remaining guard is the pane
    scrape, and the Codex branch of `harnessPromptReadiness` returns ready
    unconditionally. The coordinator types the new prompt into Codex's
    still-running turn.
  - Meanwhile the agent, following the protocol, has already read the
    changed `action.md` and started executing it. The injected prompt queues
    a second execution of the same action, with a duplicate commit and
    `complete`.
  - This hits every vendor, including those whose Stop hook works, because
    every agent writes `complete` before its turn ends. The advanced
    `idleEpoch` also hands `decideLifecycleNudge` a fabricated idle
    transition.
- **Smallest correction.** Do not rewrite lifecycle state at order time. If
  the cause in F1 is fixed, the real Stop clears `working`.

### F3 — cursor: lost-delivery retry for `working` re-types into a long Codex turn (blocking)

- **Plan claim.** Exact File List, `src/runLoop.ts`: let
  `execution === "working"` qualify for the lost-delivery branch when the
  delay has elapsed, the injection is uncorrelated, and
  `actionAbsentAtReadyPrompt` succeeds.
- **Rule.** Lost-delivery retry needs positive proof that the send was lost.
  A ready prompt plus an absent action id must not be satisfiable while the
  agent is working on that action.
- **Failure if followed as written.**
  - `actionAbsentAtReadyPrompt` uses `harnessPromptReady`, which is always
    true for Codex, and a 40-line capture.
  - Codex accepts the injected action, but its `UserPromptSubmit` is not
    correlated: in issue 176 no Codex hook event reaches the runtime at all.
  - After 45 s of tool output, the action id scrolls out of the 40-line
    capture. The branch then marks the action absent and re-types it into
    the running turn.
  - This repeats up to the four-send budget before a `nudge-loop` hold.
- **Smallest correction.** Drop this extension. If it is kept, it needs a
  Codex turn-chrome veto (the claude plan's `codex-turn-chrome`) first.

### F4 — codex: the 1-second waits in agent instructions cannot be followed by Claude (blocking for that step)

- **Plan claim.** Implementation step 5: both action renderers and
  `templates/product/AGENTS.protocol.md` instruct "wait one second and reread,
  then wait one more second and reread once more".
- **Rule.** Agent-facing protocol text must be executable by every roster
  harness, because the coordinator accepts only literal compliance.
- **Failure if followed as written.**
  - Claude Code's shell tool refuses foreground `sleep` (its tool contract:
    "Foreground `sleep` is blocked"). The Claude agent therefore cannot
    perform the instructed wait as written. It either breaks the protocol or
    improvises a workaround inside an issue clone guarded by the coord shell
    guard.
  - The two seconds also do not reliably cover the publication gap. Issue
    176 shows about 1.8 s from `intent-seen` to the next `action-prepared`,
    measured after the poll interval that elapsed before `complete` was even
    seen.
- **Smallest correction.** Drop the timed rereads from the protocol and both
  renderers. This also removes `src/action.ts`, the template and
  `test/action.test.ts` from the file list. Coordinator delivery (F1) is the
  real fix for 174's request.

### F5 — codex: the strict positive Codex prompt check is underspecified and gates all Codex delivery (non-blocking, but must be made concrete)

- **Plan claim.** Implementation step 4: "Require a recognizable empty Codex
  input prompt in the active tail … Unsupported UI remains unknown and
  blocks", applied to every Codex delivery.
- **Rule.** A new readiness veto that applies to every delivery must name the
  exact rendering it accepts, so that review and tests can check it.
- **Failure if followed as written.**
  - Codex's composer shows a rotating placeholder: the live issue-176 pane
    shows `› Ask Codex to do anything`. In plain `capture-pane` text that
    placeholder is indistinguishable from a typed draft, and its footer
    varies (`Context 71% left · … Vim: Insert`, `? for shortcuts … ⚠ 1
    warning`).
  - An implementation that matches "empty prompt" too narrowly blocks every
    Codex nudge, which is this issue's own symptom, now for healthy sessions
    too. One that matches too loosely re-creates today's always-ready
    behavior.
- **Smallest correction.** Specify the accepted shape: an in-flight veto on
  the anchored `Working (… esc to interrupt)` line, and a closed allowlist of
  trailing composer and footer lines, as in the claude plan. Keep every
  non-matching state as "not sentinel-proven" rather than "blocked" for the
  normal path.

### F6 — codex: scope larger than the fix needs (non-blocking)

- **Plan claim.**
  - Exact File List: 15 files, including a new persisted
    completed-turn record in `agentLifecycleEntrySchema`, `src/issueReport.ts`,
    `src/action.ts`, the protocol template, `docs/coord-driver.md` and six
    test files.
  - Step 1: a launcher help-parse that exits when `--no-daemon` is not
    advertised.
- **Rule.** Make the smallest change that fully solves the issue, and justify
  every new abstraction and every piece of persisted state.
- **Failure if followed as written.**
  - The completed-turn record adds a schema field with invalidation rules
    across prompt, working, session-change, session-end, queue and
    background events. Every future event kind must keep those rules in sync.
  - The only property it guards, that the successor was never sent and the
    previous action was accepted, is already derivable from
    `delivery === "ordered"` and `injectedAt === null`. The coordinator only
    orders a successor after acceptance.
  - The launcher exits on a help-text mismatch, which converts a
    harmless vendor wording change into a dead Codex pane (`harness-gone`
    hold).
- **Smallest correction.**
  - Keep `--no-daemon`, the part that matches the evidence in F1.
  - Drop the completed-turn record, the issue-report text and the reread text.
  - Make the capability check warn instead of exit.

### F7 — claude: the recovery path does not cover the observed issue-176 state and duplicates the real fix (non-blocking)

- **Plan claim.** Exact File List, `src/runLoop.ts`: the sentinel override
  applies only when lifecycle `execution === "working"` and the action was
  never sent. The Conclusion says the Stop-hook cause "remains a vendor
  concern".
- **Rule.** Per F1, the plan must fix event routing. A pane-based override is
  acceptable only as an extra safeguard.
- **Failure if followed as written.**
  - Issue 176's Codex is `unknown`, not `working`, so the override never
    engages there.
  - In issue 170 it would deliver the action, but every later Codex `Stop`
    is still dropped, and the operator log line would wrongly direct the
    owner to Codex `/hooks` trust. The hooks are trusted and firing; the
    events are being misrouted.
- **Smallest correction.** Lead with the F1 routing fix and `--no-daemon`.
  The Codex turn-chrome veto (`codex-turn-chrome`) is still valuable on its
  own, because it closes the always-ready Codex scrape that makes F2 and F3
  dangerous. Keep the sentinel override only if reviewers want a safeguard
  for vendors whose Stop is genuinely lost, and correct the operator message.

### Scope, reuse and tests across plans

- **Reuse.** All three plans reuse existing helpers and add no new files;
  none needs a new file.
- **Tests.** The claude and cursor plans propose focused tests in existing
  files. The codex plan's test list spans six files and is broader than the
  fix.
- **Missing test.** None of the plans includes the one test that matters
  most: the `test/agentEvent.test.ts` routing regression in F1.

## Conclusion

**Revise all three plans.** None of them may proceed to implementation as
written.

- **Root cause.** The issue-176 and issue-174 stall is caused by Codex
  lifecycle events that cannot be routed (F1). The `Stop` and `SessionStart`
  hooks fire, but they carry no prompt, and the Codex hook process has no
  `COORD_ISSUE`, most likely because hooks run in the shared app-server
  without the issue's environment. So `agent-event` either drops them, when
  several runtimes list Codex as active, or writes them into a stale runtime
  (issue 106). Nothing in the vendor has failed.
- **cursor plan.** It fabricates idle at order time and widens lost-delivery
  retry for a harness whose scrape is always ready. Both type into live turns
  (F2, F3).
- **codex plan.** It comes closest on cause (`--no-daemon`). It still leaves
  the misrouting in place and adds harness-incompatible timed rereads (F4),
  an underspecified global Codex readiness rule (F5) and unneeded persisted
  state (F6).
- **claude plan (mine).** It works around a symptom that does not match
  issue 176's state (F7).

**Recommended combined direction.**

1. Routing fix in `src/agentEvent.ts`: route by `session_id` to the issue
   whose lifecycle already holds that session, and never choose "the only
   active issue" for an unknown session. Regression test in
   `test/agentEvent.test.ts`.
2. `--no-daemon` in `scripts/lib/launcher.sh` for Codex, without a fatal help
   parse, extending `test/install.test.ts`.
3. The `codex-turn-chrome` veto in `src/tmux.ts`, with its
   `test/tmux.test.ts` case.
4. A `docs/readiness-policy.md` note.

No agent-side polling and no fabricated lifecycle state.

Checks run for this review: I read the bound plan files and the runtime files
listed above. I ran `codex --version` and `codex --help` to confirm
`--no-daemon`. I ran no product tests, since this is an evidence-only review.
