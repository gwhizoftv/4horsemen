# Issue 161 — actionable coordinator output and interactive recovery

Based on the frozen `github-issue.json` for issue 161 and baseline
`2a3769ec059e0d7e24373e8708fb1e99c0920421`. This is the plan artifact for action
`19bdc7fc-f48a-4942-acc4-7725ee757884`; it does not implement product changes.

## Exact File List to be changed or deleted

No files will be deleted. Change only these existing product/documentation/test files:

| File | Intended change |
| --- | --- |
| `src/issueReport.ts` | Plain-language status, severity labels, report delimiters, shared scoped recovery commands, readable agent delivery and hold descriptions. |
| `src/cli.ts` | Implicit current-worktree runtime resolution, descriptive command help, startup diagnostics, one shared foreground run-loop instance, interactive reminder and confirmed hold-release wiring. |
| `src/workspace.ts` | Reuse/extend validated workspace locator resolution for owner and registered agent worktrees; repository terminology in relevant errors. |
| `src/interactive.ts` | Descriptive help, `n` reminder menu, explicit reminder-limit reset confirmation, unknown-input feedback and Return liveness behavior. |
| `src/runLoop.ts` | Progress logs, understandable deferrals, startup/resume diagnostic integration, missing-Stop warnings, serialized owner-requested reminders through existing delivery guards. |
| `src/doctor.ts` | Extract a narrow reusable read-only agent hook/wiring inspection from existing checks for startup; preserve standalone doctor's behavior. |
| `src/agentLifecycle.ts` | Defaulted advisory Stop-observation bookkeeping and pure warning summary; retain all existing execution and readiness authority. |
| `src/tmux.ts` | Read-only issue-session environment diagnostic using the existing tmux runner; reuse, not weaken, pane/readiness and per-keystroke checks. |
| `src/verificationRunner.ts` | Optional progress callback for preparation, waiting, command start/result, reuse and failure, without changing verification outcomes. |
| `test/issueReport.test.ts` | Extend existing report fixtures for operator wording, delimiters, severity, scoped commands and ballot confidentiality. |
| `test/cli.test.ts` | Extend existing workspace/TTY fixtures for implicit resolution, help, startup diagnostics, interactive wiring and scoped recovery. |
| `test/workspace.test.ts` | Extend existing locator fixtures for owner/registered-clone resolution and invalid/crossed locators. |
| `test/interactive.test.ts` | Extend PassThrough terminal fixture for reminders, reset confirmation, unknown input, Return, paste safety and log redraw. |
| `test/runLoop.test.ts` | Extend `fixture`/`safetyFixture` for progress order, advisory warnings and owner reminder safety/races. |
| `test/doctor.test.ts` | Extend installed-workspace fixtures for shared startup hook/wiring inspection. |
| `test/agentLifecycle.test.ts` | Extend observation fixtures for Stop counters, deduplication, session isolation and old-state defaults. |
| `test/tmux.test.ts` | Extend injected runner and readiness fixtures for environment diagnostics and unchanged terminal vetoes. |
| `test/verificationRunner.test.ts` | Extend existing verification fixtures to assert progress before awaited work and truthful reused/waiting/failure outcomes. |
| `docs/coord-driver.md` | Document operator vocabulary, complete recovery commands, runtime inference, new controls and safety limits. |

## Exact file list to be created

Only `.plans/issue-161/plan.md`, the coordinator-requested plan artifact, is
created by this planning action. Implementation creates no new product modules,
test files, dependencies, configuration files or runtime sidecar files. Existing
modules already own each responsibility; their fixtures cover the necessary seams.

## Reuse and Scope

### 1. Explain the work, its status and the next operator action (issue items 1, 4, 9, 10)

Keep persisted enums, journal codes, workflow IDs, action IDs and artifact formats
unchanged. Translate them only at the operator-facing boundary. Use ASCII
`[OK]`, `[WAIT]`, `[WARN]`, `[ACTION]` labels rather than adding a color dependency;
the same meaning must survive redirected output. Normal ongoing work is `[WAIT]`,
not an error; unknown hook coverage is not `[OK]`.

Extend `renderIssueReport` as the single formatter for CLI, interactive, paused
and completed reports. Put an exact `----` line before and after the entire
snapshot. Move the interactive-only step/roster/guidance summary inside this
formatter so nothing belonging to the snapshot appears after its closing rule.
Reuse `describeWorkflowStep`, with a readable stage name before any diagnostic ID.

Use “Implementation commit”, “Final commit (PR head)” and “Pull request handling:
coordinator opens a draft; you review and merge” instead of “pin” and an unexplained
policy enum. Define an **action** as the assigned task in `action.md`; reserve
**turn** for one observed agent prompt/response cycle. Map delivery `ordered` to
“task file published; not yet sent”, `injected` to “task message sent; waiting for
acknowledgment”, and `accepted` to “agent acknowledged the task”, never “submission
accepted”. Render execution and validated artifact acceptance separately. Do not
claim reissue merely because delivery is `injected`; use actual reissue evidence.

Translate `DEFERRAL_RATIONALE`, immediate hold logs and status consistently:
an agent still working needs no intervention; a trust prompt needs inspection of
that terminal; unavailable activity signals mean coordinator cannot yet confirm
readiness. Include a concrete next step where actionable, retaining raw codes in
verbose logs/journal rather than requiring owners to understand “sentinel”,
“lifecycle”, “turn chrome”, or “correlation”. Preserve deferral deduplication.

Explain a `nudge-loop` as “automatic reminder limit reached (4/4)” and recovery as
inspection followed by explicit permission to reset that reminder allowance.
Distinguish provider-reported capacity recheck time from this local allowance:
the owner cannot reset a provider limit, unknown reset time is not proof of quota
exhaustion, and a deadline is not a promise of availability. Translate retry
ownership into “waiting for the agent application's own retry” or “your action is
required”. Preserve redacted details and the current limits on ballot disclosure.

Extend `holdRecoveryCommand` to take the stored runtime root and reuse the existing
`shellQuote` helper from `agentHookSync.ts`. Every printed recovery/control command
must contain the issue and a quoted `--coord-root` when available (including manual
pause, owner-answer and immediate hold messages). Keep unambiguous `--agent`
selection and fallback to `--hold`; explain `--run` is only for a stopped runner.

### 2. Resolve context and explain commands (items 4d, 11, 12)

Fix `existingContext`: explicit `--coord-root` remains authoritative; explicit
`--product` uses its existing path; with neither, resolve the current worktree's
installed workspace. Reuse `resolveWorkspaceFromProduct`,
`workspaceLocationFromConfig`, `existingIssueRuntime`, `withStoredMailbox` and
the registered-clone checks represented by `nextContext`. Owner locators must
match the repository; an agent locator must match a configured agent identity
and canonical clone root. Reject stale/crossed/ambiguous locators, and preserve
the existing nested-versus-legacy runtime ambiguity checks and frozen mailbox.
Do not scan unrelated directories or pick the first issue/workspace found.
Keep explicit conflicting flags invalid and `COORD_ISSUE` fallback intact.

Add side-effect-free `coord <command> --help` and `coord help <command>` handling
for supported commands before normal flag/context validation. Each command's
help states its purpose, accepted inputs, side effects and an example, especially
state-only resume versus `--run`, restart versus reminder, quit versus detach,
and destructive controls. Keep the existing flag spelling `--product` (and
`--write-product`) compatible, but describe it as the repository path; replace
human-facing “product” nouns/placeholders throughout the help and wrong-folder
errors with “repository”. Do not rename schemas or introduce a second flag alias.

### 3. Make foreground recovery explicit and safe (items 4b, 4e, 4f, 5–8)

Reuse `startInteractiveSession`'s menus, confirmation mode, serial dispatch,
StringDecoder, redraw and paste protections. `r` still captures one hold ID;
for a reminder-limit hold, ask a separate `y/N` question explaining that this
resets its four-send allowance. Pass the confirmed `resetBudget` value through
the existing `setOwnerPause`/`releaseHold` operation, which revalidates the live
hold and action under lock. Cancellation, stale selection and nonmatching hold
kinds never reset anything; other holds and manual pause remain unchanged.

Add `n` (“remind an agent to finish its current task”) with a numbered menu of
active agents with outstanding actions. Bind the request to the selected action
ID and digest. The CLI retains one `CoordinatorRunLoop` instance and queues at
most one request per agent/action in that instance; its existing tick drains
requests, rather than starting a concurrent tick or typing from the key callback.
The UI says “reminder requested”, not “sent”; execution reports sent, deferred,
or rejected with an explanation. Completion validation takes precedence if a
completion receipt arrives before execution. Expired action/digest/session,
dropped agent, pull-only delivery, pause/hold, completion and missing action are
revalidated at execution; stale requests are discarded, never rebound.

Reuse `deliver`, action-safety reservations, send budget/backoff,
`TmuxController.nudge`, `IdleOverride`, and their per-key authority/readiness
checks. An explicit owner reminder may request fresh positive terminal idle
proof for a stale `working` record on this same action (the existing automatic
override remains limited to never-sent actions). It may not manufacture idle
state. Require the existing current idle-marker proof and empty/expected composer;
queued input, background work, trust/verification dialogs, owner typing, wrong
foreground process, missing pane/capture and new lifecycle activity still veto
the send. Preserve all four-send accounting, increasing delays and ambiguous-send
holds; `n` neither clears a hold nor resets budget. If proof is unavailable,
direct the owner to inspect/type in the agent terminal rather than forcing keys.

Do **not** add a force-complete or force-next-stage control. A drafted plan or
an idle terminal does not satisfy evidence validation. Explain that distinction
in help and offer `n`, scoped `r`, or existing `restart-action` as appropriate.
Explain `/steer` precisely: queue guidance for every recipient of the next
assigned cohort; it does not immediately broadcast into every agent terminal.

Unknown printable input is visibly echoed as quoted text with “Unknown command”
and help. A multi-character plain paste in hotkey mode is reported as one inert
input, never expanded into commands. Continue ignoring terminal escape/control
sequences safely and preserving bracketed-paste isolation. Bare CR or LF in
hotkey mode writes a newline and redraws the prompt without changing state or
invoking help; CR/LF while composing guidance or choosing a menu retains its
current meaning. Logs must continue to preserve edits and selections.

### 4. Diagnose hooks without pretending installation proves trust (item 3)

Extract only the relevant read-only hook/identity/wiring inspection from doctor;
reuse `inspectAgentLifecycleHooks`, `inspectCloneHooks`, configuration keys,
launcher resolution and `containmentCoverage`. Do not run the whole doctor as
a startup gate: its issue-branch overlay advice is normal during an active issue.
Run the shared diagnostic on fresh start after branch/runtime preparation and
on run/resume initialization, including a read-only initial diagnostic when held.
Check each active agent's managed definitions, disabled/missing hooks, executable
Git hooks/shim, CLI entry, workspace locator, identity and intended issue branch.
Report missing installation stamps or unsupported vendors as unknown, not healthy.

Use the tmux runner to read the target session's `COORD_ISSUE` after launch or
reuse, and compare it with the requested issue. A matching session environment
does not prove an already-running child inherited it. Report that distinction,
and use issue-local session/action-correlated hook receipts and actual-tool
containment observations as runtime evidence. Installed files alone cannot prove
native trust/enforcement; absent evidence must say “runtime hook trust/activity
not yet verified”, with terminal trust/restart/doctor guidance. Do not auto-trust,
rewrite hook configuration, invent vendor versions or synthesize a probe result.

Extend the independent lifecycle entry with backward-defaulted, advisory
Stop-observation metadata, updated within `applyLifecycleObservation` and
`markActionWorkflowComplete`. Count only distinct observed turn IDs for the
current session; where turn IDs are unavailable, separately count distinct
completed action IDs and label those as actions, not turns. Exclude stale-session
callbacks, repeated events, telemetry and timer ticks. A second distinct prompt
without a matching intervening Stop gives a truthful “No Stop hook from codex
after N observed turns” warning. Missing prompt/turn identity instead produces
“No activity/Stop confirmation after N completed actions” or a startup
“not yet verified” message; never invent an N from elapsed time.

Derive warning text with a small pure helper in `agentLifecycle.ts`, render it
in status and emit on transition in the run loop, not every poll. A current
matching Stop/session replacement resets the observation episode; old sessions
cannot clear it. Publication does not falsely prove a Stop hook works. Keep
warnings advisory: do not resurrect the deprecated silence-based degraded-health
watchdog, create holds from missing hooks, advance work or authorize delivery.

### 5. Show actual progress without poll spam (item 2)

Reuse the run loop's `log`/`verbose` callbacks and the interactive `print` sink.
Announce once when an agent's completion marker is observed (“received; checking”),
then report validation acceptance or rejection distinctly for Git and private
response submissions. Deduplicate using action/receipt identity, without printing
ballot contents, choices or rationales.

Before awaiting expensive effects, announce verification preparation, each named
check, waiting for another verification/slot, evidence/final-branch push, PR
creation and merge when configured. Print actual result and available log path
after completion; label cached results as reused rather than “ran”. Add an
optional typed progress callback to `runVerification`, wired by
`runGateVerification`; it observes existing branches without changing receipts,
locks, retries or outcome semantics. Mirror and PR progress wraps the existing
call sites, including ballot evidence publication. Keep repetitive tick detail
verbose-only. No new spinner, subprocess runner or logging framework is needed.

## Tests

Extend the existing tests above; use table-driven cases for wording, invalid
contexts and event permutations rather than duplicating fixtures. The minimal
regression groups are:

1. Reports contain a single opening/closing rule, understandable action and
   submission states, correct severity, provider-versus-reminder recovery, and
   copyable commands with spaces/apostrophes in the runtime path. Preserve private
   ballot non-disclosure. These replace the assertions for cryptic output.
2. CLI context succeeds with no `--coord-root` from owner and registered clone
   subdirectories, preserving stored mailboxes; reject nonrepositories, crossed
   locators and dual legacy/current runtimes. Explicit flags retain precedence.
   Command help succeeds outside a repository without effects and describes
   recovery and repository terminology.
3. Interactive unknown key/chunk and Return visibly respond. Confirmed `r`
   resets only the selected reminder-limit hold; cancellation/stale selection
   leaves state intact. `n` targets one current action and reports queuing; test
   paste, Escape, non-TTY, shutdown and redraw through the existing fixture.
4. Run-loop reminders send only after current positive idle proof; working pane,
   queued/background work, changed action/session/digest, pause, existing hold,
   budget/backoff and mid-send authority change remain safe. Assert no second
   tick, no automatic stale-working resend expansion, no evidence acceptance
   from idle and no replacement-action reminder from a stale queued request.
5. Startup inspection distinguishes installed, missing, disabled, crossed and
   runtime-unverified hooks, including stale tmux issue environment. Stop warning
   tests cover two distinct turns, duplicate events, missing IDs/action fallback,
   old-state defaults, stale-session Stop, current Stop and reset on new session;
   prove warnings do not alter readiness/holds and are not printed every poll.
6. Deferred fake runners prove receipt/check/push progress appears **before**
   work resolves and acceptance only afterward. Exercise failure, cached success
   and verification wait using existing fixtures; ensure private response data
   never enters output.

Focused implementation commands (verified against the checked-in Vitest configs):

```sh
pnpm exec vitest run --config vitest.config.ts test/interactive.test.ts test/issueReport.test.ts test/agentLifecycle.test.ts test/doctor.test.ts test/tmux.test.ts test/runLoop.test.ts test/verificationRunner.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts test/workspace.test.ts
```

The product precommit hook owns `pnpm check:fast`; do not manually duplicate it
immediately before committing. The frozen issue final check is `pnpm run check`
(build, lint, typecheck, fast/system tests and e2e), owned by the coordinator at
the approved commit. If a later action explicitly requires other checks or
coordinator-mode verification, follow it and cite its recorded results separately.
Planning itself needs heading/file-map/evidence validation only: no product suite
was run or claimed for this plan.

## Alternatives Rejected

- Force advancing an idle agent: bypasses required submissions, checks and votes.
- Unconditional owner-triggered terminal typing or unlimited retries: risks
  interrupting work and recreating reminder loops; use positive proof and budgets.
- Resetting every hold from `r`/`n`: violates scoped recovery and manual pause.
- Treating installed hooks or a tmux environment value as proof of live trust:
  reproduces false confidence about stopped/misdirected callbacks.
- A timer that declares the agent failed: quiet work is normal; warning metadata
  is separate from workflow authority and must reflect observed evidence.
- Renaming `--product`, persisted enums or workflow stages: unnecessary migration
  risk when presentation and validated context resolution solve the problem.
- A generic command bus, log framework, TUI library, new docs tree or broad
  refactoring: existing modules and fixtures are sufficient.

## Risks and Mitigations

- **Concurrent owner actions:** queue reminders in the one foreground runner,
  capture action identity, revalidate before effects and retain per-key authority
  checks. Confirmation captures IDs; state mutation remains locked.
- **Misleading diagnostics:** distinguish task receipt from validated submission,
  observed turns from completed actions, installation from runtime verification,
  and provider recovery from local reminder allowance. Unknown stays unknown.
- **Noisy progress:** deduplicate stable receipt/warning identities, log starts
  and outcomes only, and retain existing verbose/debug paths for repetitive detail.
- **Runtime compatibility:** add only defaulted advisory fields to the independent
  lifecycle schema; do not bump/migrate workflow state or change evidence formats.
- **Terminal safety:** quote/sanitize diagnostic input rather than emitting raw
  control bytes; retain raw-mode cleanup, paste isolation and prompt redraw tests.
- **Wrong workspace or shell quoting:** reuse locator validation, legacy ambiguity
  checks and stored mailbox resolution; explicitly quote recovery paths.
- **Scope growth:** no changes to `githooks/`, hook installation policy, dependency
  manifests, version, voting rules or agent artifact protocol. If another file
  proves necessary, request a plan amendment instead of silently expanding this map.

## Conclusion

Address all twelve reported usability points through understandable status,
truthful progress/hook warnings, complete context-aware help and safe interactive
recovery. Keep evidence validation and delivery protection authoritative. The
owner gets visible feedback and specific recovery steps, not a force-complete
shortcut or a claim that installed hooks guarantee runtime enforcement.
