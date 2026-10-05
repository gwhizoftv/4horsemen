# Issue 154 plan review

Bound plans reviewed:

- cursor `8c76de93d699e281c92b810d5b1f502d5a2acb45` — `.plans/issue-154/plan.md`
- claude `19b7ba5ca9d8e1b197497395d1c712eb235928cd` — `.plans/issue-154/plan.md`
- codex `131258cea58ee0c673ed9c4c0634c74deb8bcf09` — `.plans/issue-154/plan.md`

All three plans agree on these: TTY-only activation, a separate terminal module,
shared owner mutations through `mutateCursorsState`/`appendJournal`, an optional
`InternalOrder` field, and an advisory `## Owner guidance` section in both action
renderers. I checked the cited helpers against the baseline. `dropAgent`,
`holdRecoveryCommand`, `requireStateMutation`, `rederiveAfterDrop`, `setPaused`,
`releaseHold` and `renderIssueReport` all exist. `CoordinatorRunLoop.run(signal)`
already accepts a signal, but `runIssue` (`src/cli.ts:910`) calls `run()` without one.
`run` also waits in an `await this.sleep(pollIntervalMs)` that ignores any signal
(`src/runLoop.ts:2915`).

## Findings

### cursor

1. **Claim (Exact File List, `src/runLoop.ts`; Risks, "consume queue only inside `prepareAction`/`buildOrder` … clear atomically with the same mutation that records prepare").**
   **Rule:** Every agent ordered for a workflow step must receive the same guidance. Reissues, `rewriteOrderedAction` refreshes and restarts of that step must re-render that same guidance.
   **Failure:** `prepareAction` runs once per agent (`applyDecisions`, `prepare-action` branch). With roster `claude,codex,cursor` entering `R4.implement`:
   - The `claude` preparation drains the queue.
   - The `codex` and `cursor` actions have no `## Owner guidance`.
   - A malformed-completion `reissue` of `claude`'s action goes back through `buildOrder` and drops the guidance too. Its rewritten `action.md` loses the section mid-turn.

   This breaks the issue's "delivered consistently to all participants" requirement from the owner's scope comment.
   **Correction:** Snapshot pending guidance once per step into a durable bound/active field. `buildOrder` reads that field and never drains it.

2. **Claim (Exact File List, `src/runLoop.ts`: "gate interactive stdin only when TTY; integrate non-blocking key/command handling with `run()` sleep/poll"; Risks: "same discipline as Ctrl-C/`AbortSignal` handling today").**
   **Rule:** `q` stops only the foreground runner, promptly. Terminal I/O stays out of the workflow engine.
   **Failure:** No `AbortSignal` handling exists today on the CLI path, because `runIssue` passes none. The plan never wires one or changes the signal-blind `sleep`, so nothing implements `q`. Either the runner keeps ticking, or the CLI exits while the poll timer holds the process for up to `pollIntervalMs`.

   Putting stdin handling in `runLoop.ts` also duplicates the new `src/interactiveMode.ts`. Every `CoordinatorRunLoop` test would then need a stdin double.
   **Correction:** Create the controller in `runIssue`, pass `controller.signal` to `run`, and race the poll wait against `abort`. Keep stdin in `interactiveMode.ts`.

3. **Claim (`src/interactiveMode.ts`: raw-mode dispatch for `s p a d q ? h`; Risks only mention prompt interleaving).**
   **Rule:** Raw mode must not remove the owner's ability to interrupt the coordinator. The terminal must be restored on every exit.
   **Failure:** In raw mode, Ctrl-C arrives as byte `0x03` and raises no SIGINT. The plan maps neither Ctrl-C nor EOF, and it names no `setRawMode(false)` cleanup path. An owner pressing Ctrl-C gets no response. A thrown runner error leaves the shell in raw mode with no echo.
   **Correction:** Treat Ctrl-C, EOF and errors like `q`. Restore raw mode in an idempotent `finally`, and test each path.

4. **Claim (ownerControls "pause/resume (`setPaused` / hold release parity with CLI)"; `p`/Space toggle).**
   **Rule:** The `p` toggle changes only the manual pause. Releasing a hold requires an explicit hold selection and keeps the budget-reset rules.
   **Failure:** The plan does not say whether `p` inverts effective `paused` or `manualPaused`. When a `nudge-loop` hold is active, `paused` is true. A toggle based on `paused` calls the resume path, so either it resumes nothing visible or the "hold release parity" releases a safety hold with no selection. The issue's hold-release use case also has no UUID-free control.
   **Correction:** Toggle on `manualPaused` under the lock. Add a numbered hold menu bound to the hold ID it displays.

5. **Claim (`src/runLoop.ts`: "on `owner-action-required`, print numbered inline prompt using `ownerQuestion`").**
   **Rule:** An inline answer must name the question the owner actually saw. When a question was answered or replaced from another shell, a later keypress must be reported as stale.
   **Failure:** The prompt is printed from the runner's log path, and the selection is resolved against "`ownerQuestion` already in memory/on disk". Suppose the owner sees question A, a second shell answers A, and question B appears. Pressing `1` then applies B's first allowed answer to a question the owner never saw.
   **Correction:** Carry the displayed question ID into `applyOwnerAnswer`, and reuse the existing stale-ID check.

6. **Claim (Exact File List lists `src/tmux.ts` with "no behavior change expected … touch only if a tiny export is required"; Exact file list to be created includes `test/ownerControls.test.ts`).**
   **Rule:** The file map is exact, and every new test file needs a justification that an existing file cannot cover.
   **Failure:** A conditional entry gives the implementer no binding answer on whether `src/tmux.ts` is in scope. The answer-idempotency and drop-guard cases intended for `test/ownerControls.test.ts` are already exercised by `test/cli.test.ts` through the extracted helpers, so the new file duplicates coverage.
   **Correction:** Drop `src/tmux.ts`, because `openOwnerAgentClients` and `reportOwnerAgentClients` are already exported. Fold the guard tests into `test/cli.test.ts`.

7. **Claim (documentation: only `docs/coord-driver.md`).**
   **Rule:** The owner clarification requires both interaction paths to be preserved in the UI and docs: hotkeys or `/steer` in the coordinator, and direct typing into agent tmux panes.
   **Failure:** `README.md` is the owner-facing entry point. It already documents `coord <issue>` and the manual mode, and it stays silent about the hotkeys, `q` versus `coord detach`, and the direct-pane path.
   **Correction:** Add `README.md` to the file map.

### claude

8. **Claim (Guidance lifetime: binding is keyed by `(stepId, round)`; `bindOwnerGuidance` is a no-op when `bound` already has that key).**
   **Rule:** Guidance queued before a new whole-cohort set of actions must reach that cohort, even when the step label repeats.
   **Failure:** Consider an owner answering `retry` to a ballot-escalation question in round 2. The CLI handler resets every cursor to `R6.ballot` with round 2 (`src/cli.ts`, `answer` branch). Steering is most likely while the owner waits on that question. Because `R6.ballot` round 2 is already bound:
   - the retried ballot re-delivers the old snapshot;
   - the owner's new guidance stays pending until `R6.revise`.

   The same failure applies to `restart-action` of the whole roster and to the CLI reset helper. Separately, entering `R4.amend-ballot` binds the pending guidance to the ballot. When the workflow resumes `R4.implement`, it rebinds to an empty snapshot. The re-prepared implementation actions lose guidance the owner gave for implementation.
   **Correction:** Add a durable boundary generation. Bump it at whole-cohort resets: owner retry/revise, amendment entry and resume, and the drop rederive. Bind by generation, not by step name. Alternatively, state explicitly that amendment resume reuses the pre-amendment snapshot.

9. **Claim (Reuse: `s` reuses `renderIssueReport` unchanged; Out of scope: changes to `issueReport.ts`).**
   **Rule:** The issue specifies that `s` prints "active step, roster, pins, PR status, active holds".
   **Failure:** `renderIssueReport` replaces the phase with `"paused"` whenever `cursors.paused` is true (`src/issueReport.ts:51-57`), and it never prints `activeRoster`. During a hold, the owner needs to know which step and agents are affected. In that state, `s` shows neither, so the requested snapshot is not delivered.
   **Correction:** Add `src/issueReport.ts` and `test/issueReport.test.ts` to the file map. Print the step, round and roster together with the pause line.

10. **Claim (`d` numbered drop menu with no confirmation; key mode versus line mode only implied).**
    **Rule:** A single mistyped keystroke must not apply an irreversible roster change. Pasted text must not expand into a series of quick controls.
    **Failure:** Pressing `d` then `2` drops an agent immediately. A paste such as `pd1` while no line editor is open would pause and then drop agent 1.
    **Correction:** Require a confirmation step for drop. Ignore multi-character keypress chunks in quick-control mode.

### codex

11. **Claim (Exact File List 1, Durable guidance 2: add `coord steer <text> --issue N`).**
    **Rule:** The work stays within the issue. The issue and the owner clarification name `/steer` in the running coordinator as the steering path.
    **Failure:** An external `coord steer` command adds a public CLI surface, help text and path-resolution tests that the issue does not request. It also enlarges the review and regression surface of `src/cli.ts` and `test/cli.test.ts`. The plan does not show the interactive path failing without it.
    **Correction:** Drop `coord steer`. Use the shared enqueue helper in tests directly.

12. **Claim (Durable guidance 4: promote at `advance`, `amendmentTransition` entry and resume, owner retry/revise, and `rederiveAfterDrop` resets).**
    **Rule:** Guidance given for a step must survive an interruption of that same step that does not change the owner's intent. Every whole-cohort reset site must be wired consistently.
    **Failure:** Promotion at amendment entry moves pending guidance to the `R4.amend-ballot` cohort. Promotion at resume then replaces the active snapshot with an empty one. The re-prepared `R4.implement` actions therefore lose implementation guidance given before the amendment, which is the same defect as finding 8. The site list also omits the reset helper in `src/cli.ts`, around line 420, that rewrites `issueCursor` to an arbitrary step. Guidance active before that reset would keep rendering for the new cohort under a stale generation.
    **Correction:** Have amendment resume restore the snapshot saved at amendment entry. Wire the CLI reset helper and list it explicitly.

13. **Claim (Tests: CLI, state, run-loop, action and report matrices).**
    **Rule:** Propose the fewest focused tests that fail before the change.
    **Failure:** The run-loop list alone runs to roughly a dozen scenarios: normal and derived advance, retry, revise, amendment entry and resume, drop reset versus ordinary drop, conflict injection, restart after promotion, and completion retention. On top of that come CLI matrices for every exit path and every stale-selection type. This exceeds the focused-test rule. Running them against the existing heavy run-loop fixtures will also slow `test:fast`. `install.test.ts` already shows that slowdown can starve the worker RPC.
    **Correction:** Use one table-driven boundary test over the promotion sites, plus one test for consistency within a cohort. Use a single parameterized exit-path test.

## Conclusion

- **codex:** The most complete design. Its generation-based cohort boundary, `manualPaused`-scoped toggle, hold menu bound to the displayed hold ID, and status changes match the issue and the owner clarification. It needs findings 11–13 addressed: drop `coord steer`, fix snapshot handling on amendment resume and list the CLI reset site, and trim the test matrix.
- **claude:** Structurally sound: one binding site, durable snapshot, signal wiring, and terminal cleanup on every exit. However, binding by step key fails owner retry and amendment resume (finding 8). The status hotkey does not deliver the requested fields (finding 9). Destructive menus need confirmation (finding 10).
- **cursor:** Requires revision before implementation. Finding 1, draining the queue at the first `prepareAction`, breaks the core consistency requirement. Findings 2–5 leave `q`, Ctrl-C and terminal restore, scoped hold release, and stale-question safety unimplemented or unsafe.
