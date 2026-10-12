# Issue 195 implementation plan

Issue 195 includes issue 187: the operator must be able to choose any agent and send an explicit reminder at any time. Make `n` a direct owner instruction, independent of the rules used to decide whether coordination should send an automatic reminder. Preserve evidence validation and workflow progression.

## Exact File List to be changed or deleted

Change these nine existing files; delete none:

1. `src/runLoop.ts` — enumerate every configured agent, dispatch explicit owner reminders independently of automatic readiness and holds, record each attempt's outcome, and make automatic idle deferral language accurately describe the recorded state.
2. `src/tmux.ts` — provide an explicit owner delivery mode that uses the existing message/key transport without automatic readiness vetoes; share the existing vendor key selection and batching.
3. `src/interactive.ts` — change the `n` menu, empty-menu message, and help to describe choosing any configured agent and sending an owner reminder. Retain the existing one-agent/All agents interaction.
4. `src/cli.ts` — update command help to match the owner reminder behavior and distinguish it from releasing automatic-delivery holds.
5. `test/runLoop.test.ts` — replace the owner-reminder expectations that enforce the superseded constraints and add focused coverage of unrestricted selection, dispatch, journal outcomes, and preserved workflow state.
6. `test/tmux.test.ts` — extend the existing fake-runner transport tests to cover owner delivery independently of prompt/pane readiness and verify real send failures are reported.
7. `test/interactive.test.ts` — extend the reminder menu/help tests, including All agents and independent results for each selection.
8. `docs/readiness-policy.md` — distinguish automatic delivery policy from owner instructions and document the incident evidence and its limits.
9. `docs/coord-driver.md` — update the interactive-controls and delivery-budget sections, including what is sent when an agent has no assigned action.

## Exact file list to be created

No new product, test, fixture, or configuration files. The current action publishes this coordination plan at `.plans/issue-195/plan.md`. Existing test fixtures and documentation have suitable homes for the implementation and incident explanation.

## Reuse and Scope

### Evidence and diagnosis

The frozen issue description is `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-195/github-issue.json`, at baseline `6a04d57e524ad53daa082568e146c5300e93dfeb`. Issue 187 was read with `gh issue view 187 --repo gwhizoftv/4horsemen --json number,title,body,url`; its requirement is selection of any agent rather than an algorithmically restricted list.

Read-only investigation of `/Volumes/4TB-SOURCE/REPOS/4horsemen/coord-runtime/issue-177/journal.jsonl`, `start.json`, and `agent-lifecycle.json` establishes the following. Times below are UTC, and sequence numbers are the journal's `sequence` fields, not line numbers.

- Cursor's implementation completion at action `096056dd-c46d-4c2a-9786-2677f11cf553` was validated at **2026-10-11 00:21:06.554** (sequence 2707). Its Stop was recorded as **idle** at **00:21:31.431** (2737). Coordination did recognize this idle transition.
- The next comparison action, `9f6923bb-5537-40e3-9a52-aa6f92ded7d2`, was prepared at **00:28:17.520** (2898). Sends were recorded at **00:28:18.076**, **00:29:19.673**, **00:31:20.302**, and **00:35:21.813** (2900, 2954, 2987, 2995). No matching prompt-submit acknowledgement appears between these sends. The intervening `prompt-ready-action-absent` events (2943, 2986, 2992, 2998) show that positive lost-delivery recovery was running.
- At **00:36:06.447** (2999–3000), the fourth send exhausted the automatic allowance and created the exact reported hold, `01edf7dd-e0b8-46d0-88b4-963dc4751100`. It persisted until the owner released it with a budget reset at **16:12:03.734** (3003–3004), approximately 15 hours 36 minutes later. This accounts for the overnight wait; the recorded cause was a hold, not an overnight spacing timer or failure to recognize the earlier Stop.
- After release, sends resumed at **16:12:06.114** and **16:13:07.161** (3006, 3009). A `beforeSubmitPrompt` callback at **16:13:28.235** (3010) set execution to working. The subsequent `working` deferral (3011) followed that callback; it was not inferred solely from elapsed time.
- The later comparison ballot, `ff2e6ee7-912f-43b4-bbb5-176c50e56283`, was delivered using ready-file proof at **16:19:01.110** (3121) and acknowledged at **16:19:01.292** (3123). At **16:19:17.186** (3145), validation explicitly failed because its private response file was missing. Cursor stopped at **16:19:27.034** (3158). A resend of the corrected action digest occurred at **16:20:02.415** (3180), followed by `idle-transition-already-used` at **16:20:03.561** (3181). The next prompt-submit was **16:22:52.519** (3182); the response was accepted at **16:23:51.203** (3195). The idle line alone could not satisfy the missing response.

`NUDGE_REPEAT_DELAYS_MS` supplies the 60/120/240-second spacing. `markActionInjected` consumes the current idle epoch, and `decideLifecycleNudge` then returns `idle-transition-already-used` until fresh evidence or the existing lost-delivery recovery permits another automatic attempt. Meanwhile, owner requests currently call the same `deliver` path and inherit its budget, spacing, pending/background checks, and terminal proof. `reminders()` also hides agents without an ordered action and refuses requests while paused. Those shared restrictions are the concrete owner-control defect.

The old owner request path does not journal the specific request and its early-return reason. Therefore the exact cause of the quoted owner's `n` refusal cannot be recovered from these artifacts; do not assert that spacing, readiness, or a hold was its particular cause. Likewise, journalled tmux success does not establish why Cursor did not accept those keystrokes. Historical pane/composer captures are not present in this runtime. Preserve these limits in the diagnosis; do not speculate about a broken Stop hook or change vendor keys without evidence.

### Implementation behavior

1. **Select agents, not algorithmically eligible tasks.** Build `CoordinatorRunLoop.reminders()` from `readStartState(...).agents`, including agents that are working, queued, held, complete for their current step, pull-configured, dropped, or presently without an action. Preserve configured order and the All agents option. A selection captures the agent identity. Resolve its current assignment when dispatching, so a menu opened before a phase transition still nudges the selected agent about its current work. Do not bind eligibility to hook sequences, health, idle epochs, or session activity.

2. **Dispatch explicit requests before automatic gating.** Keep owner requests in a small in-memory FIFO owned by the existing runner; each deliberate selection gets one attempt, including repeated selections before the next tick. Drain it before the pause/hold/observe-only returns and before resource observations or automatic nudging. The live coordinator can therefore service `n` during manual pause and every hold type. Skip automatic delivery for an agent already explicitly attempted in that tick. This does not release pauses or holds, reset the automatic budget, restart an action, remove completion/response files, or advance the machine. The running command's termination still ends its interactive controls.

3. **Use the message appropriate to the current assignment.** For an outstanding assigned action with a valid current file and no completion receipt, reuse `renderNudgeText` with its exact path, UUID, and current digest. If a completion is waiting for validation, send a reminder that submission is awaiting coordinator validation rather than instructing the agent to redo it. For an accepted/unassigned/dropped agent or absent action file, send a neutral owner nudge explaining that there is no current executable assignment and to remain available for operator guidance. Do not fabricate an action, resurrect a dropped task, replay an accepted order, or instruct an agent to execute a nonexistent file. Recheck the chosen action identity/digest immediately before sending a task-specific message; an actual concurrent assignment change must produce a precise outcome rather than send obsolete task text.

4. **Explicit owner transport bypasses the automatic policy.** Add a narrowly scoped owner mode to the existing `TmuxController` delivery path. It must not require idle proof, an empty composer, a lifecycle match, prompt recognition, capture success, foreground readiness, queue/background inactivity, an enabled automatic delivery mode, spacing, or unused send allowance. Do not route it through `injectionGate` or `IdleOverride` as if the owner supplied automatic idle evidence. Address only the configured agent's issue pane; absent targets and tmux failures are concrete transport failures. A best-effort pane capture may select vim keys, but a failed capture cannot veto the request. Reuse `resolveNudgeKeys`, literal `send-keys -l`, existing submit keys, batching, and the short text/key separation delays: those delays make keystrokes work and are unrelated to the 60/120/240-second reminder cooldown. Keep automatic calls on their existing guarded path.

5. **Keep owner authority and automatic accounting separate.** The current `authority()` rejects paused state; owner dispatch needs a narrow authority check that allows a still-running paused issue while validating the configured target and any task-specific binding. Do not weaken the authority used by automated effects. Successful task-specific owner injection may reuse `markActionInjected` for the still-current unfinished action so an automatic send does not immediately duplicate it; only real hooks establish acceptance. Preserve `actionSafety` send counts, timestamps, reservations, holds, and manual pause rather than consuming or resetting them for an owner attempt. A generic reminder has no action lifecycle to update. An ambiguous owner transport result is recorded as uncertain, without automatic retry or clearing a prior reservation. Subsequent explicit owner requests remain available.

6. **Report each attempt precisely.** Reuse `appendJournal` and the existing `nudged`/`nudge-deferred` event types with `owner: true`, a per-request identity, actual message kind, stage, and reason; omit `actionId` when there is no assigned action. Record sent/failed/uncertain outcomes with the request identity in journal detail fields, including exceptions from the transport. Use `nudged` only for successful injection so existing analytics do not count requests or failures as sends. Do not pass owner outcomes through the automatic per-action reason-code deduplication. Print one result for each selected agent and continue All agents after an individual failure. Remove the combined “readiness, send spacing or a hold” message. “Sent” means handed to tmux; do not claim vendor acceptance or workflow completion. Change the automatic `idle-transition-already-used` explanation to acknowledge that the activity report is idle and that automatic delivery has already used that observation; point to `n` for an explicit owner reminder. Describe `working` as a lifecycle report, allowing the owner to act on what their terminal shows.

Reuse the existing `AgentConfig`, `NudgeOutcome`, `CoordinatorRunLoop.reminders/runTick`, `agentRuntimePaths`, `readCompletion`, `readAgentLifecycle`, `renderNudgeText`, `resolveNudgeKeys`, lifecycle injection helper, journal API, and interactive menu callbacks. Extend their small types only where required for the explicit delivery mode or message/result. No new persistence schema, dependency, command, provider-specific key workaround, readiness framework, or general queue abstraction is needed. Automatic delivery constraints and completion validation remain covered by existing tests; the new owner mode does not redefine automatic idle detection.

## Tests

Extend existing fixtures rather than introducing captured private transcripts or another test harness:

- In `test/runLoop.test.ts`, reuse `fixture`, `safetyFixture`, its controllable clock/UI, `observeAgentLifecycle`, `mutateCursorsState`, and `readJournal`. Replace the owner cases that require fresh idle proof, spacing, a four-send ceiling, or pause rejection. A compact parameterized case must show a requested send without advancing the clock under working/queued/unknown state, pending input, background work, exhausted idle epoch, exhausted automatic budget, existing reservation, manual pause, and holds. Assert the request does not reset/change automatic counters or remove holds/completion evidence; each explicit request has a result and no automatic duplicate occurs in the same tick.
- In that file, extend the existing menu/assignment test to show every configured agent is listed regardless of cursor status or delivery mode. Cover no-action, accepted, dropped, and pending-completion message selection, as well as opening the menu before assignment replacement and an actual binding change during dispatch. Verify task-specific messages use the current UUID/digest; generic reminders neither fabricate work nor mutate accepted workflow state.
- Reproduce the issue-177 sequence in `safetyFixture("cursor")`: a recognized Stop, injection without acknowledgement, consumed idle epoch, exhausted allowance/hold, and then an explicit owner request. The request sends immediately, including while held; subsequent workflow advancement still requires the valid artifact/response. Include the existing response-validation fixture where needed to ensure a missing private response is not accepted merely because an agent is idle.
- In `test/tmux.test.ts`, reuse fake `TmuxRunner` calls and existing vendor key/batch assertions. Test an owner send with busy/no-prompt/composer text, unavailable capture, automatic delivery disabled, and pane-gate conditions that previously vetoed it. Assert the owner path actually attempts the configured target and preserves literal message/key boundaries. Test a missing target or failed send produces its actual failure; preserve existing automatic-veto tests unchanged.
- In `test/interactive.test.ts`, extend the captured reminder and All agents cases to assert the new help/menu text, dispatch of every row, and one failed target not preventing the next request. Existing TTY/paste handling and hold-release confirmation tests remain applicable.

During implementation, run the focused existing suites with:

```sh
pnpm exec vitest run --config vitest.config.ts test/runLoop.test.ts test/tmux.test.ts test/interactive.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts
```

The runtime's actual configuration declares product precommit `pnpm run check:fast` and prepush `pnpm run test:e2e`; let the hooks run them rather than manually duplicating them immediately before committing. Its final check is `pnpm run check` (build, lint/typechecking, fast/system tests, e2e). The coordinator owns final verification at the approved pin; cite its recorded results without claiming to have run them. If a later action enables coordinator verification mode, follow that action's division of responsibilities.

This plan-only action needs heading/body, file-map, command, and evidence validation. No product suite was run to publish the plan.

## Alternatives Rejected

- Merely increase the automatic allowance or shorten the cooldown: owner requests would still fail under readiness and pause checks, and issue 187's hidden agents would remain hidden.
- Remove safety checks for every automatic send: the requirement is unrestricted operator control; autonomous retries must not become an unbounded stream.
- Feed owner requests through a fabricated idle/Stop receipt or reset their action state: that falsifies observations and changes workflow or recovery semantics.
- Add a force flag or an extra confirmation menu: the existing explicit `n` selection supplies the requested owner direction; another prerequisite defeats the requirement.
- Change Cursor submit keys based on the incident: the available journal proves unacknowledged injection, not the precise TUI input failure. Reuse the already tested vim/non-vim key handling.
- Add a new CLI command, persistent reminder service, runtime format, or transcript fixture: the existing interactive control, journal detail fields, and injected fixtures are sufficient.

## Risks and Mitigations

- The owner can deliberately send while an agent is busy or has a draft. Document that `n` sends directly, without claiming automatic readiness; preserve literal payload and existing key semantics and do not add hidden vetoes.
- Shared transport code could accidentally relax automatic policy. Make owner mode explicit and preserve automatic-veto and budget tests. An owner send must not replenish or spend the automatic allowance.
- Task assignment or submission can change after the menu is shown. Bind selection to the agent, choose the message from current state at dispatch, and recheck a task-specific UUID/digest before transport. Never delete a completion or send old task instructions after replacement.
- Paused dispatch can accidentally authorize other coordinator effects. Run only the explicit owner request through the narrow paused-aware path; return to the existing observation-only behavior afterward. Test that holds/manual pause remain set and no gate advances.
- Tmux injection is not acknowledgement. Journal exact sent/failed/uncertain outcomes, retain existing lifecycle acceptance rules, and do not silently replay ambiguous owner sends. A missing pane gets a specific transport result rather than disappearing from the menu.
- Historical evidence cannot explain every terminal-side event or the exact old owner refusal. Include the sequence/timestamp table and explicitly bounded conclusions in existing readiness documentation; avoid presenting current local vim settings as historical proof.

## Conclusion

Implement issue 195 and issue 187 with an explicit owner reminder path across the existing nine files. The evidence shows recognized idle state, lost or unacknowledged deliveries, an exhausted automatic budget, and one invalid ballot submission. Unrestricted owner selection and dispatch, concrete per-request outcomes, and accurate automatic-wait language fix the controllable failure without treating idle text as completed work or speculating about missing terminal evidence.
