# Issue 186 plan review (claude)

This review covers the three bound plans:

- cursor at `d076173d30216e31583862e01bd12f5478c8ce44`
- claude at `25daecbd4dae7694a80e30b3b7c285b11e40ee8d`
- codex at `9a7921a29926ccade26cd73512bfd3f35ef316fa`

All were read from the bound input files.

## Evidence used for this review

I re-checked these on the machine during this action. They decide several findings
below.

- **The shared Codex daemon carries the stale issue.** The daemon is pid 5269,
  `codex app-server --listen unix:// … --managed-daemon`, started 2026-10-08. `ps eww`
  shows its environment has `COORD_ISSUE=139`. The issue-186 Codex TUI (pid 17290) has
  `COORD_ISSUE=186`.
- **The issue-186 Codex session is recorded in issue 139.** That session is
  `01a121f6-82a4-7ff0-b94f-bd8c238a19fb`, and it is the `sessionId` in
  `coord-runtime/issue-139/agent-lifecycle.json` for codex. Today's Codex
  `agent-lifecycle` events (18:39–18:41Z) are in `issue-139/journal.jsonl`. Issue 186's
  Codex entry has `sessionId: null` and `hookReceipt: null`.
- **The shell snapshot is fresh, not stale.** The snapshot holding
  `declare -x COORD_ISSUE="139"` is
  `~/.codex/shell_snapshots/01a121f6-….1791571165907700000.sh`. It was created at
  2026-10-09 11:39, when issue 186 started. It is a new snapshot of the daemon's
  environment, not a stale file reused from an old session.
- **The flag exists.** `codex --help` (codex-cli 0.162.0) lists `--no-daemon`: "Run
  without the shared background server, even if it is already running".
- **Prelude typed as text.** The live issue-186 Codex pane shows a nudge submitted as
  `› iRead and execute coordinator action 4b16949a…` while the footer read
  `Vim: Insert`.

## Findings

### Cursor plan (`d076173d`)

**C1. Scope: item 3 and the stale-issue cause are missing.** The plan's file list
covers only `src/tmux.ts`, `src/setupWorkspace.ts`, `config.example.json`, docs and
`test/tmux.test.ts`.

- **Rule.** The plan must cover every symptom the owner put in the issue. That includes
  item 3: the shell guard names issue 139, and `containment-probe` fails with "session
  or installed policy unknown". It must also cover the shared cause behind items 1–3.
- **Failure if followed as written.** Codex hooks keep running in the daemon with
  `COORD_ISSUE=139`. In issue 186 they record no lifecycle, so `recordContainmentProbe`
  still throws at `src/shellGuard.ts:327` (`!entry?.sessionId`), and `git-guard` still
  says "issue 139". `RunLoop.deliver` still sees `execution: "unknown"`, not `working`,
  so it still types nudges into a running Codex turn whenever the `Working (…)` line is
  briefly hidden. That is exactly how the `delivery-uncertain` holds in issues 167, 176
  and 186 arose; every one has `sessionId: null`. Better submit keys cannot fix a
  nudge typed into a busy turn.
- **Smallest correction.** Add the launcher fix (`--no-daemon` in
  `scripts/lib/launcher.sh`, Codex `exec` line) and its argv test in
  `test/install.test.ts`.

**C2. Risk: Escape is not a safe fallback in Codex.** The plan changes Codex
`nudgeSubmit` to `["C-j", "C-m", "Escape", "Enter"]`, and the stale `["C-j","C-m"]` is
upgraded to it in `resolveNudgeKeys`.

- **Rule.** A fallback submit key must not interrupt or alter Codex state when the
  first keys did not submit. Codex binds Escape to "interrupt" during a turn: the live
  chrome is `• Working (12s • esc to interrupt)`. In the composer, Escape changes vim
  mode, and repeated Escape is the edit-previous-message gesture.
- **Failure if followed as written.**
  - Today's evidence shows the coordinator does reach a Codex that is mid-turn: the
    `iRead…` message was accepted as a steer during a live turn. Suppose `C-m` queued or
    steered the nudge, or the composer briefly re-rendered the nudge. The fallback
    `Escape` then interrupts the agent's running turn, which loses work and has no
    owner trace.
  - Or suppose Escape leaves INSERT. The plan offers no evidence that Enter submits in
    Codex vim NORMAL, so the nudge can still sit there, now in NORMAL mode, where the
    next coordinator prelude logic assumes otherwise.
  - The upgrade also rewrites every frozen issue config, since live `start.json` has
    `["C-j","C-m"]`, so the risk applies immediately to all running issues.
- **Smallest correction.** Re-press only `C-m`, bounded, and only while the composer
  provably still holds exactly the nudge. Never send Escape after text has been typed.

**C3. Tests: case 2 locks in vendor behavior that is not established.** Test 2 asserts
that `Escape` then `Enter` submits after `C-j` and `C-m` leave the nudge in the
composer.

- **Rule.** A unit test may pin coordinator key logic. It must not encode an
  unobserved vendor behavior as the expected outcome.
- **Failure.** The stub will "submit" on Enter because the test says so. It passes even
  if real Codex treats Enter in INSERT as a newline, which is the plan's own premise for
  adding Escape. The suite would then certify a fallback that does nothing, or does
  harm, in the real TUI.
- **Smallest correction.** Drop case 2, or reduce it to "fallback keys are sent only
  while the composer holds the nudge".

**C4. Correctness of the broadened proof: tool lines are not live chrome.** The plan
treats `Browsing the web` and `• Opened …` as live-turn evidence for
`codexNudgeSubmitted`.

- **Rule.** Submission proof must come from rendering that is new since the send.
  Scrollback does not count.
- **Failure.** The issue's own screenshot shows `• Browsing the web` and
  `• Opened https://cli.github.com/…` just above a nudge that was never submitted.
  Those lines persist after a turn ends. Suppose the transcript also holds an earlier
  `›` copy of the same message, which is likely when an action is re-nudged with
  identical text. Then the combination "matching `›` message + empty composer + tool
  line" can be met by old content, and the send ends `sent` without submitting.
- **Smallest correction.** Compare against the pre-send capture, as the codex plan
  proposes, rather than adding more chrome words.

### Codex plan (`9a7921a2`)

**X1. Correctness of the containment fix: the launch flags miss the process that runs
the hooks.** Under "Issue-scoped launch context", the plan adds
`--disable shell_snapshot` and `-c shell_environment_policy.set.COORD_ISSUE=<n>` to the
Codex launch, and treats the snapshot as the stale context.

- **Rule.** The fix must change the environment of the process that runs Codex's hook
  commands, because those hooks write lifecycle and run `git-guard`.
- **Failure if followed as written.** The hooks run in the shared daemon, whose own
  environment has `COORD_ISSUE=139` (pid 5269, above).
  - The snapshot is a symptom, not the cause: it was created fresh at 11:39 today from
    that daemon environment.
  - `shell_environment_policy` governs the shell the model's tools use. The plan does
    not show that it reaches `.codex/hooks.json` commands, and the plan itself admits
    this is unproven.
  - With the TUI still attached to the daemon, `agent-event` keeps resolving
    `COORD_ISSUE=139` (`src/agentEvent.ts:333-337`). Lifecycle stays in issue 139,
    `containment-probe` still fails, and `deliver` still nudges into busy turns.
  - So items 2 and 3 survive, and the new diagnostic only explains the failure.
- **Smallest correction.** Launch with `--no-daemon`, which is verified in the
  installed CLI, so hooks and tool shells inherit the pane's `COORD_ISSUE`. Then the
  snapshot and environment-policy flags are unnecessary.

**X2. Risk: ordinary delivery fails closed on an unrecognized composer, turning parser
drift into a full outage.** The plan wants to "Recognize an empty Codex composer before
*every* delivery path can type", and says unknown layouts "refuse safely".

- **Rule.** A new veto on the ordinary path must not block every Codex delivery
  whenever Codex chrome changes slightly. Issue 181 shows that drift happens.
- **Failure.** Today the ordinary path vetoes only on `codex-turn-chrome`. After this
  change, any pane that `codexTail` cannot parse defers as `codex-composer-not-ready`
  on every poll. That covers the `codex ready\n` panes used by the existing
  "Codex defaults" tests, a new footer line, a popup, or a status hint. Codex then never
  receives an action, and no hold fires, because a deferral is not a hold. The issue
  stalls silently.
- **Smallest correction.** Keep the strict composer check as a submission proof after
  typing, which the plan already adds. Do not make it a typing precondition on the
  ordinary path. Alternatively, raise a distinct owner hold after N consecutive
  unparseable deferrals.

**X3. Scope: the plan is broad for the issue.** It touches eleven files, including
`src/runLoop.ts`, `src/shellGuard.ts`, `test/runLoop.test.ts` and `test/cli.test.ts`.

- **Rule.** Make the smallest change that fully solves the issue, and justify each file.
- **Failure.** The run-loop acceptance plumbing and the probe diagnostics exist to work
  around lifecycle state that is missing because hooks are misrouted (X1). Once hooks
  reach the right issue, `UserPromptSubmit` already supplies acceptance to the override
  path, and `execution: "working"` already stops ordinary sends. The extra surface adds
  review and regression risk in reservation and hold semantics without fixing the
  cause.
- **Smallest correction.** Drop the `src/runLoop.ts`, `src/shellGuard.ts` and
  `test/cli.test.ts` items unless the fixed launch still leaves a reproduced gap.

**Retained strengths, not findings:**

- Pre-send capture comparison, so stale scrollback cannot prove submission.
- `i` sent only on positive NORMAL evidence.
- Exactly one bounded CR fallback with all gates rechecked.
- Insisting on a live smoke check before claiming item 3 is fixed.

These are sound and should carry into the selected plan.

### Claude plan (`25daecbd`, my own)

**L1. Correctness: a confirmed non-submission is reported as `sent`.** Under "Codex
submit confirmation", step (b) says "The outcome contract stays the same:
`sent`/`complete`" after at most two `C-m` re-presses.

- **Rule.** When coord has positively observed the composer still holding the
  unsubmitted nudge after the last allowed press, it must not report delivery.
- **Failure.** Suppose Codex treats `C-m` as a newline in some state. The composer then
  holds the nudge after both retries, yet `nudge()` returns `sent`. `deliver` calls
  `markActionInjected` and journals `nudged`. That is the reported stall (text sitting
  there) with the coordinator believing it delivered, and no hold for the owner.
- **Smallest correction.** After the retries run out with the composer still holding
  the nudge, return busy at stage `mid-send` with reason `codex-composer-not-ready`, so
  `deliver` raises the existing `delivery-uncertain` hold.

**L2. Correctness: the false hold after a successful first key remains.** The override
path is unchanged except for the settle wait.

- **Rule.** A nudge that Codex actually submitted must not produce a
  `delivery-uncertain` hold.
- **Failure.** `codexNudgeSubmitted` (`src/tmux.ts`) still requires
  `Working (… esc to interrupt)`. If `C-j` submits and Codex shows a tool line instead,
  or the composer is already empty before that line paints, the check before `C-m`
  refuses with `codex-composer-not-ready` at `mid-send`. The plan's own retry (b) is
  never reached, so a delivered nudge still holds. Correctly routed `UserPromptSubmit`
  hooks make this rarer, but only if the hook lands within the 150 ms gap.
- **Smallest correction.** Adopt the codex plan's proof: a `›` message equal to the
  nudge text, new relative to the pre-send capture, plus an empty composer. Do not
  require the word `Working`.

**L3. Tests: the `--no-daemon` fix has no runtime verification.** The only test is the
argv assertion in `test/install.test.ts`, and live checking is deferred to "after merge".

- **Rule.** A fix for a process-environment defect needs evidence from a real launch
  before acceptance. A stub binary cannot show where hooks run.
- **Failure.** The argv test passes even if `--no-daemon` Codex still routes hooks
  elsewhere, or does not load `.codex/hooks.json`. Item 3 would be declared fixed with
  no proof.
- **Smallest correction.** Before the implementation is accepted, run an
  owner-authorized fresh Codex launch through the regenerated launcher (codex X1 already
  requires one). Record the hook process's `COORD_ISSUE`, the lifecycle `sessionId` in
  the current issue, and a successful `containment-probe`.

### Cross-plan observations

- **Every Codex `delivery-uncertain` hold shares one cause.** Each recent hold has
  `sessionId: null`, so the misrouted lifecycle is part of every hold. Only the claude
  plan removes that cause, and of the three only cursor's ignores item 3.
- **All three plans agree the ordinary path sends `C-j`, `C-m` blind with no
  confirmation.** Both claude's and codex's bounded, proof-gated re-press of `C-m` fix
  that safely. Cursor's Escape fallback does not.
- **The plans disagree on whether to keep `C-j`.** The evidence available supports
  neither keeping nor removing it. A proof-gated `C-m` re-press works whichever way it
  goes, so the default key list should change only with observed vendor behavior.

## Conclusion

No plan is acceptable unchanged.

- **Cursor plan: revise.**
  - It omits the owner's item 3 and the stale-daemon cause (C1).
  - Its Escape fallback can interrupt a running Codex turn (C2).
  - Its tests and proof would certify unverified behavior or stale scrollback
    (C3, C4).
- **Codex plan: revise.**
  - Its launch change targets the tool shell, not the daemon that runs hooks, so items
    2 and 3 persist (X1).
  - Its ordinary-path composer precondition risks a silent delivery outage (X2).
  - Its scope can shrink once the cause is fixed (X3).
  - Its confirmation design (pre-send comparison, one bounded CR fallback, live smoke
    check) is the strongest part of any plan.
- **Claude plan: closest to correct, but revise.**
  - It is the only one fixing the verified cause (`--no-daemon`) with a small file
    footprint.
  - It must report exhausted retries as `mid-send` instead of `sent` (L1).
  - It must adopt pre-send-relative submission proof without requiring `Working` (L2).
  - It must require a live fresh-launch verification before acceptance (L3).

A merged plan should combine claude's `--no-daemon` launcher change and INSERT-aware
prelude with codex's confirmation semantics, without its ordinary-path precondition or
run-loop/probe expansion.
