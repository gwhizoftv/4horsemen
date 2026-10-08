# Issue 161 — bound plan review

Reviewed the exported plan files listed by action
`ce2adaf4-7f07-4761-91c1-ba510ab2e5ff`, not moving branch heads:

- Cursor: `87653072adc2b4f5e944cc093c2fa73337745813`.
- Claude: `e635fae7af6dd6d07b3f3bd7c4ff6e2867149ae3`.
- Antigravity: `84dc2d37e099af6d8d58d069f33cc694c3f9f28d`.
- Codex: `b35d439ec356cee0158a59b8154b1c893ee2aa16`.

All four artifacts are `.plans/issue-161/plan.md` at their respective pins.
The frozen issue and existing source were used to check the proposed behavior.

## Findings

### 1. [P1] Claude: a reminder must not perform destructive action restart

**Plan claim:** Reuse and Scope, item 6, moves the `restart-action` mutation
verbatim into `restartOwnerAction` and calls it from `n`, including `null` for
“all agents with unfinished actions”. It claims delivery safety stays unchanged.

**Rule:** Reminding an agent about its current assignment must preserve that
assignment's identity, pending completion/response evidence and send allowance.
A reminder is not authorization to discard evidence or renew the retry budget.

**Concrete failure:** The existing mutation calls `clearAgentLocalWork`, which
deletes the completion marker, action file and private response
(`src/ownerControls.ts:29–33`), invalidates unpublished batches, and sets
`actionId` to null (`src/cli.ts:1425–1444`). If an agent finishes between opening
the menu and confirming, `n` erases its unconsumed submission instead of letting
the coordinator validate it. A replacement action also gets `sends: 0` and
`lastSendAt: null` from `ensureActionSafety` (`src/runLoop.ts:990–996`), so repeated
reminders renew the four-send allowance without the promised budget-reset flow.
Passing null additionally restarts the entire active roster, not just the
unfinished-action list advertised by the menu.

Keep `restart-action` separate. Queue a reminder bound to the selected current
action and process it through delivery safety without clearing its evidence or
changing its identity; give an arriving completion priority.

### 2. [P1] Claude: any-event timestamps cannot detect a missing Stop hook

**Plan claim:** Reuse and Scope, item 3, counts accepted actions only when
`lastEventAt` did not advance beyond `action.orderedAt`, and resets the count on
any hook event, to warn that no Stop/turn hook arrived.

**Rule:** The missing-Stop warning must detect absent Stop events even when
prompt/tool callbacks still work. Those callbacks are not evidence of a Stop.

**Concrete failure:** A functioning UserPromptSubmit callback advances
`lastEventAt` and sets execution to working (`src/agentLifecycle.ts:601–615`,
`:658–674`). If Stop is disabled or misrouted, every later action with a prompt
callback resets the proposed counter. The agent can repeatedly finish work
without delivering any Stop and the warning never fires—the precise partial-hook
failure in issue item 3. The planned test with no lifecycle events at all does
not exercise this case.

Track Stop-specific evidence scoped to the current session and distinguish
observed turns from completed actions. Add the prompt-present/Stop-absent case,
including duplicate prompts and an old-session Stop that must not clear it.

### 3. [P2] Cursor and Antigravity: re-arming delivery does not recover the stated stale-working case

**Plan claim:** Cursor's Reuse and Scope re-arms `decideLifecycleNudge` while
retaining the existing delivery path. Antigravity's Risks and Mitigations routes
`n` through `ensureActionSafety`/`paneObservations`, resetting deferral delays.
Both present this as recovery for an agent that drafted work but coord still
considers working.

**Rule:** The manual reminder must have a defined safe behavior for a previously
sent/acknowledged action with stale working telemetry. Retrying a timer cannot
substitute for either positive readiness evidence or explicit refusal guidance.

**Concrete failure:** With `execution = working`, `delivery = accepted`, one
prior send, no background work and a genuinely idle terminal,
`decideLifecycleNudge` still returns wait (`src/agentLifecycle.ts:761–763`).
Even calling the existing `deliver` directly returns before inspecting the pane:
its working-state exception applies only to never-sent actions
(`src/runLoop.ts:1117–1121`). Clearing observation/deferral delays does not change
either condition, so repeated `n` presses leave the motivating case stuck.
Neither plan's proposed `n` test goes beyond invocation of the UI callback.

Specify an action-bound owner-request path with current positive idle proof,
fresh per-key checks and unchanged budgets/reservations, or explicitly report
why a reminder was refused and direct the owner to the terminal. Test the
already-acknowledged stale-working case, not just command dispatch. Do not fix
this by fabricating idle state or silently restarting the action.

### 4. [P2] Peer startup checks leave runtime trust/current-issue binding unassessed

**Plan claim:** Cursor's startup paragraph and Antigravity's hook-preflight
section rely on `inspectAgentLifecycleHooks` (Cursor also suggests doctor) to
cover startup hook health. Claude's item 3 explicitly skips inspection without
an install stamp and leaves trust/issue binding to the existing join-time
containment warning and later stale-working message.

**Rule:** At startup, installation and actual runtime trust/current-issue
activity must be distinguished. If runtime evidence is unavailable, the operator
must see that it is unverified; a later accepted artifact must not be a
prerequisite for this diagnostic.

**Concrete failure:** `inspectAgentLifecycleHooks` compares local definitions
with generated definitions and checks disable flags; it takes no issue or live
session identity (`src/agentHookSync.ts:270–297`). Correct files in an untrusted
harness, or a reused child still running with an old issue environment, pass
that comparison. If the agent never completes join, the acceptance-time warning
never executes; if no override delivery occurs, the stale-working message also
never executes. The stated checks therefore leave the owner waiting without
the requested startup diagnosis despite “current” hook files. Silently skipping
an absent install stamp has the same observability gap.

Include an explicit runtime-unverified result with concrete recovery guidance,
and correlate current-issue/session observations when available. Doctor/file
inspection must not be described as proof of harness trust. Test current files
with missing/mismatched runtime evidence, not only missing files. Fixing vendor
routing itself need not be part of this issue.

### 5. [P2] Claude: inferred context alone does not make printed recovery commands complete

**Plan claim:** Reuse and Scope, item 4d, makes recovery commands work by
defaulting `existingContext` to an onboarded current directory; the expected
recovery string still omits a runtime or repository argument.

**Rule:** Recovery emitted for a known issue must identify its runtime even
when the supported explicit-config startup mode was used outside a repository.

**Concrete failure:** An owner starts from a nonrepository directory with
`coord start 161 --config /runtime/config.json --coord-root /runtime`.
When the plan's recovery line says only
`coord resume --issue 161 --agent codex --reset-nudge-budget`, running it in that
same directory still fails because current-worktree inference cannot resolve
a repository there. This is the incomplete-direction problem from item 4d,
not an invalid original invocation.

Use stored `start.coordRoot` in the emitted commands with proper shell quoting,
while keeping convenient inference for repository-local commands. Cover a
nonrepository caller and a runtime path containing spaces in the existing tests.

### 6. [P2] Claude: the focused command excludes the proposed CLI tests

**Plan claim:** Tests lists one development invocation with
`--config vitest.config.ts` including `test/cli.test.ts`.

**Rule:** Named validation commands must actually select the new regression
cases, rather than merely accepting a path argument while excluding that file.

**Concrete failure:** `vitest.config.ts` explicitly excludes
`test/cli.test.ts`; `vitest.system.config.ts` owns it. The listed mixed command
runs the other named suites but not the CLI alias/context/wiring cases, so those
changes are not exercised by the proposed focused validation. The later
hook-owned suite does not make the advertised focused coverage accurate.

Run the CLI file under `vitest.system.config.ts` separately. No extra test file
or configuration change is necessary.

### Scope, reuse and test assessment

- **Cursor:** The file map is mostly a suitably narrow UI/control change, with
  existing report, terminal and state helpers reused and no new product module.
  Repair findings 3–4 and add behavior-level reminder tests. Its conditional
  permission for new test files is not approved scope: any necessary new file
  must use a plan amendment. Give focused tests executable commands as well as
  case descriptions.
- **Claude:** Reuses concrete fixtures and has a small map, but reusing restart
  is the wrong behavior for a reminder (finding 1). Findings 2, 4–6 need repair.
  The repository alias is a small compatible extension, not required to fix the
  terminology complaint; preserving only the existing flag would be narrower.
- **Antigravity:** Existing modules and fixtures are appropriate, with no new
  product files/dependencies. Findings 3–4 need a defined runtime behavior and
  corresponding tests. Also spell out the `r` budget-reset path through
  `setOwnerPause` with confirmation and captured-hold revalidation; rejecting a
  CLI-only flag is not itself an implementation/test contract for safe reset.
  Name the actual fast/system test commands.
- **Codex:** No blocking plan finding. Its larger map has explicit ownership for
  runtime observation, progress, context and tests, with no new product files
  or dependencies. The advisory lifecycle fields and verification callback are
  tied to requested diagnostics rather than generic infrastructure. During
  implementation, specifically test that the existing `IdleOverride` callback's
  old `delivery = accepted` state is not confused with a fresh acknowledgment of
  an owner reminder (`src/runLoop.ts:1130–1136`, `src/tmux.ts:1068–1076`); the
  plan's action/session snapshot and per-key checks must apply to that case.

All plans correctly reject force-advancing unvalidated work. Their test cases
otherwise remain issue-focused and can use existing support; no product suite
was run for this artifact-only review. Source inspection and bound-artifact
validation are the review evidence, not a claim of implementation verification.

## Conclusion

Request changes to the Claude, Cursor and Antigravity plans for the findings
above. The Codex plan is acceptable as a plan, subject to its stated safety and
focused-test requirements; this is not approval of an implementation.

Prefer preserving the current action and evidence over restarting it for `n`,
Stop-specific diagnostics over any-event timestamps, and explicit runtime
uncertainty over installation-based trust claims.
