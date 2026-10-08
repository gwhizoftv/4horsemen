# Issue 161 implementation comparison

This compares the four bound implementation pins, read from their exported worktrees:

| Agent | Pin |
| --- | --- |
| cursor | `d76041e1beff91c677615f55c965db94dd1b1698` |
| codex | `46586e29f238f3b8d8de25b9e301a2e1648ed627` |
| claude | `25af4ef94486d3f8e9f123583b82f5464886a98e` |
| antigravity | `87a50cc979b861f3589123a0942d647a18845333` |

All four were diffed against the frozen baseline `2a3769ec059e0d7e24373e8708fb1e99c0920421`. That baseline was extracted read-only with `git archive` into a scratch directory, and each worktree was compared with plain `diff -ru`. Line numbers below refer to each pin's worktree.

Only source reading and diffing were done for this comparison. I ran no product suites at the peer pins. For my own pin, the results are those already reported with its readiness signal and are not re-claimed here.

The selected plan is codex's. Its hard requirements are:

- **`n` reminder:** binds to the current action, queues in the single runner, and executes through the existing delivery guards. For an already-acknowledged action with a stale `working` record, it may send only on current positive idle proof.
- **Status report:** framed by `----` with a severity label.
- **Missing-Stop warning:** based on Stop evidence, not on any-event timestamps.
- **`--coord-root`:** commands infer it from the current worktree, and printed recovery commands carry it quoted.
- **Help:** per-command help that has no side effects.

## Comparison

### Findings

#### C1 — cursor: `n` can never send for an already-acknowledged action

**Location.** `src/runLoop.ts:1225` together with `src/runLoop.ts:1201`.

**Rule.** Codex's plan says an owner reminder for the same, already-sent action may challenge a stale `working` record on current idle proof. Item 6's motivating case is the agent took the action, then stalled.

**Failure.** Cursor lets the owner path through the `working` gate (`ownerReminderWorking`). It keeps the unchanged override callback, which returns `"accepted"` whenever `latest.action.delivery === "accepted"`.

In the motivating state the prompt hook has already marked the action accepted. On the first key, `tmux.nudge` evaluates `lifecycle !== "unchanged"` and refuses with `lifecycle-changed`. So every `n` press for that case is refused, and nothing tells the owner why.

**Test sketch.**
1. Order and send an action, then observe `prompt-submitted` for it, so `delivery = accepted` and `execution = working`.
2. Put `COORD-IDLE` at the pane tail, queue a reminder, and tick.
3. Expect one literal send. Cursor sends zero and journals `lifecycle-changed`.

#### C2 — cursor: a queued reminder is sent even after the agent reported completion

**Location.** `src/runLoop.ts:2995` (the drain), which runs before `src/runLoop.ts:3014` (`completion.status === "missing"`).

**Rule.** Completion validation takes precedence over a reminder that has not run yet.

**Failure.** The drain only checks holds, action ID and digest, then calls `deliver(..., "owner-reminder")`. Take an agent that wrote `complete` between the key press and the next tick. It still gets the reminder typed into its terminal while coord is validating the submission. That interrupts an agent whose work is done and spends a send from its 4-send allowance.

**Test sketch.** Queue a reminder, write a valid `complete` marker, tick, and expect zero literal sends.

#### C3 — cursor: false missing-Stop warnings for healthy agents without turn IDs

**Location.** `src/agentLifecycle.ts:491`.

**Rule.** The warning must reflect Stop evidence that is actually missing.

**Failure.** A completed action is counted whenever `action.turnId === null`, and the count is cleared only by a later Stop.

Take a healthy agent whose Stop for action A arrives before coord accepts A. A is counted after its Stop. Then action B is accepted before B's Stop arrives, which is common because the agent writes `complete` mid-turn. The count reaches 2 and prints "No activity/Stop confirmation after 2 completed actions", although every Stop arrived.

By contrast, codex records `stoppedActionId` and claude records `lastStopAt` against the action's send time, so both exclude an action whose own turn stopped.

#### C4 — cursor: contradictory policy text and a near-permanent [WARN]

**Location.** `src/issueReport.ts:46` and `src/issueReport.ts:104`.

**Rule.**
- The PR-policy line must say who merges.
- The severity label must separate "working" from "needs you".

**Failure.**
- Under `coord-merged`, the report says "coordinator opens a draft; you review and merge (coord-merged: coordinator merges)", which contradicts itself.
- Severity becomes `WARN` whenever any agent's hook *or* shim coverage is `unverified`. Shim coverage is `unverified` in the issue's own example output for every agent, so a normally progressing issue reads `[WARN]` rather than `[WAIT]`. That defeats item 1's "is status good?" cue.

#### C5 — cursor: thin coverage and unrelated doctor churn

**Location.** `src/doctor.ts:130–260`.

**Rule.** Add focused coverage for each new behaviour, and avoid unrelated cleanup.

**Failure.**
- Cursor changed `agentLifecycle`, `doctor`, `tmux`, `verificationRunner` and `workspace`, but added no tests in their test files. The reminder queue, Stop counters, worktree resolution, tmux environment reader and progress events are all untested.
- The doctor refactor deletes explanatory comments and reorders doctor's findings.
- With no install stamp, doctor now emits an extra per-clone `installRoot` finding next to `checkInstallRoot`'s, duplicating output for one condition.

#### A1 — antigravity: the `----` frame does not enclose the snapshot

**Location.** `src/issueReport.ts:230` and `src/cli.ts:847–848`.

**Rule.** Item 9 asks for `----` at both the beginning and the end of the status output.

**Failure.** The report gets only a closing `----`. The interactive `s` command still appends `Active step:`, `Active roster:` and `Queued guidance:` after that closing line, so part of the snapshot prints outside the frame, and there is no opening delimiter at all.

**Test sketch.** In the `s` output, the first line must be `----` and the last non-empty line must be `----`.

#### A2 — antigravity: `n` runs delivery from the key press, for every agent, without the plan's guard

**Location.** `src/runLoop.ts:982–1019` and `src/interactive.ts:177`.

**Rule.** The reminder is queued and drained by the runner's own tick. It targets one selected action, and it reports sent, deferred or refused truthfully.

**Failure.**
- `commands.nudge()` is called with no agent, so one key press "reminds" every unfinished agent.
- `requestReminder` mutates `actionSafety` and calls `maybeLifecycleNudge(..., "idle")` directly from the key callback, concurrently with the running tick. A concurrent tick changes `stateRevision`, so the effect can throw `StateConflictError`, which reaches the owner as a raw `coord:` error. It can also rewrite `action.md`.
- In the motivating stale-working, accepted case, `decideLifecycleNudge` still waits on `working`, so nothing is sent. The owner is nonetheless told "Requested reminder for X".

#### A3 — antigravity: ✓ "progressing" while the issue waits for the owner

**Location.** `src/issueReport.ts:75–78`.

**Rule.** The status cue must say when the owner must act.

**Failure.** Only `abandoned`, holds or a manual pause produce ⚠. With a pending owner question, or a failed PR publication, the report shows "Status: ✓ progressing" while coord waits for the owner. The report also keeps "Policy:" and "Final pin (PR head)", which are among the cryptic terms the issue lists.

#### X1 — codex: `coord <command> --help` only works when it is the sole argument

**Location.** `src/cli.ts:936`.

**Rule.** Codex's plan requires side-effect-free per-command help before flag and context validation.

**Failure.** `helpTarget` requires `rest.length === 1`. So `coord resume --issue 161 --help`, the natural way to ask while composing a command, falls through to `parseArgs`. That fails with "Option --help requires a value." instead of printing help.

**Test sketch.** `runCli(["resume", "--issue", "1", "--help"])` should exit 0 and print the resume description.

#### X2 — codex: routine corrections labelled [ACTION]

**Location.** `src/runLoop.ts:2090`.

**Rule.** `[ACTION]` means the owner must act.

**Failure.** Every reissue, an automatic correction loop the owner need not touch, logs `[ACTION] <agent>: submission needs correction`. Owners are trained to react to non-events.

The same change also drops the outstanding text from the verbose `reissued …` diagnostic (it now prints only a count), which removes information an operator debugging a loop needs.

#### X3 — codex: startup diagnostics print twice on a fresh start

**Location.** `src/cli.ts:924` and `src/runLoop.ts:3182`.

**Rule.** The diagnostic should print once per runner start.

**Failure.** `startIssue` calls `initialLoop.reportStartup()`, then `runIssue` creates the runner, whose `run()` calls `reportStartup()` again. Every `coord N` that starts a new issue prints the whole block of per-agent `[WARN]`/`[OK]` lines twice.

#### S1 — claude (self-review)

No defect of the severity above was found in my pin. Two lesser points:

- **Noisy startup block.** The wiring diagnostic prints one line per active agent on every start or resume, including `[OK]` lines.
- **No `--repository` alias.** Following the selected plan's "no second flag alias", only `--product <repository-path>` exists. Antigravity's alias is a usability extra the plan declined.

### Scope, reuse and coverage

**codex** follows its own plan most literally:

- Advisory Stop observation scoped to the session, with a `stoppedActionId` guard.
- A reminder captured with action, digest, session and hook-sequence identity, drained in the tick and refused on any change.
- A completion marker that cancels a reminder.
- Quoted `--coord-root` in every printed command.
- Tests in all nine approved test files.

Its defects (X1–X3) are presentation-level. One judgement call: requiring an unchanged hook sequence makes a reminder for an agent with continuous status-line activity likely to be refused. That direction is safe.

**claude** implements the same contract with comparable coverage: nine test files, including a stale-working reminder test, completion precedence, pause discard, missing-Stop once-per-kind, and read-only held diagnostics. Differences from codex:

- It keeps doctor's finding order by splitting `checkClone` instead of filtering it.
- It reopens an acknowledged action only once the first key is reserved, so a refused reminder leaves lifecycle state untouched.
- Its user-visible change set is the largest: most status and log text was rewritten.

**cursor** covers every item on paper, but its central recovery control does not work in the issue's own scenario (C1), it can type into a completed agent (C2), and it ships most new mechanisms untested (C5).

**antigravity** is the smallest, but it misses item 9 (A1), implements `n` as an unqueued, roster-wide effect that cannot send in the stale-working case (A2), and leaves several of the issue's cryptic terms in place (A3).

### Ranking

1. **codex** `46586e29f238f3b8d8de25b9e301a2e1648ed627`
2. **claude** `25af4ef94486d3f8e9f123583b82f5464886a98e`. It is functionally equivalent on the hard requirements. My own pin, so I rank it below the selected plan's author by a small margin; X1–X3 are small fixes for a reviser.
3. **cursor** `d76041e1beff91c677615f55c965db94dd1b1698`
4. **antigravity** `87a50cc979b861f3589123a0942d647a18845333`
