## Comparison

Recommend the Codex implementation. I found no blocking defect in that pin. Claude and Cursor implement the main owner-reminder path, but the focused reproductions below expose delivery and reporting defects that require revision.

Protocol version: 1. Action: `91c032b0-8bf1-4e59-9122-5562816b1f33`.

| Candidate | Exact product pin |
| --- | --- |
| Claude | `b5372125cab35e55f695faa274db2dca0ed2f30b` |
| Codex | `c42d14ec2da1860cc79be5e209d129025da143b7` |
| Cursor | `61b75918d3924970935c891e50517380795266d7` |

### Findings

1. **Claude `src/tmux.ts:1157`, `src/tmux.ts:1166`; Cursor `src/tmux.ts:1195`, `src/tmux.ts:1198` — P2: revalidate the assignment across separate transport operations.** The selected plan requires the task UUID/digest to remain current immediately before task-specific typing, with failed or uncertain reporting when the binding changes. Both implementations check the binding once, then await separate Antigravity prelude, payload, delay and submit operations without checking it again. If the action changes while the prelude is running, they still type the obsolete payload and return `sent`. Claude also awaits copy-mode cancellation after its only check. The reproduction configures Antigravity with `nudgePrelude: ["Escape"]`, changes the binding when that prelude returns, and expects no literal payload plus an uncertain outcome. Both candidates instead send the literal payload and report success; Codex stops before the payload and reports uncertainty.

2. **Cursor `src/runLoop.ts:1097`, `src/runLoop.ts:3133` — P2: do not silently discard an owner request on a concurrent pause.** Owner delivery must remain available during pause/holds, and every dequeued request must have an outcome. `ownerAuthority` rejects any cursor revision change, including a manual pause with the same assignment. `drainOwnerReminders` has already removed the request when it rethrows that conflict; `runTick` then catches it at line 3377 without recording a reminder result. The request disappears, with neither a send nor an explanation, and remaining selections wait for another tick. Reproduction: after the initial action, queue one reminder and call `setPaused(..., true)` from the pane-capture callback. Cursor produces zero owner journal records and no additional send. Claude and Codex deliver and record that request. A change after keys begin must likewise produce an uncertain outcome rather than disappear through the conflict handler.

3. **Cursor `src/runLoop.ts:3105` — P2: preserve a submit acknowledgement received during the send.** Injection bookkeeping must use the attempt's start time so `markActionInjected` can retain a matching hook received before tmux returns. This call passes `this.now()` after transport completion. The existing helper preserves acceptance only when `acceptedAt` is at least that argument, so a real callback arriving a millisecond before return is erased: delivery changes from `accepted` to `injected`, and the accepted timestamp/session/turn are cleared. Reproduction: in `safetyFixture("cursor")`, advance the clock, emit `working()` from `ui.onSend`, then advance it again before the fake runner returns. Cursor loses the acknowledgement; Codex retains `delivery: "accepted"`. Claude captures its timestamp before transport and does not have this specific defect.

4. **Claude `src/runLoop.ts:1295`; Cursor `src/runLoop.ts:1230`, `src/runLoop.ts:3193` — P2: suppress automatic delivery after any owner attempt in that tick.** Selected-plan behavior 2 explicitly applies suppression to the selected agent, including a neutral reminder. Claude suppresses only an equal action UUID; Cursor suppresses only the existing ordered-action idle path, leaving initial delivery unrestricted. Queue a reminder before the first assignment and run one tick: both send the neutral owner message, then immediately send and charge the newly prepared automatic action. The reproduction observes two literal sends instead of one. Claude's existing test at `test/runLoop.test.ts:281` even encodes this departure from the selected plan. Codex's guard at `src/runLoop.ts:1273` covers initial, idle and reissue delivery and the reproduction observes one send.

### Scope, reuse and coverage

All three candidates keep product changes within the nine approved existing files. None adds a product file, dependency, persistence schema or command. Their menu/help changes stay within issues 187/195, and all retain the existing completion-validation machinery and automatic readiness policy.

- **Codex:** reuses `renderNudgeText`, `resolveNudgeKeys`, `markActionInjected`, the existing journal and fixture helpers, and extracts the shared vendor key sequence into `typeAndSubmit`. Its owner authority checks session/target and current message binding without treating a pause or unrelated hook activity as a veto. Tests cover FIFO selections, generic/pending messages, transport failure, binding changes, all four vendors and the exhausted Cursor allowance. The additional coverage stays focused on owner behavior. Its incident account distinguishes established hold/acknowledgement history from unavailable historical pane evidence.
- **Claude:** likewise shares `typeAndSubmit` and extends existing fixtures, with no unrelated product refactor. Its smaller test set covers the main restrictions and message kinds, but omits revalidation after asynchronous transport steps and accepts an extra automatic send after a neutral owner message. Its main incident diagnosis correctly identifies the overnight hold and missing ballot response.
- **Cursor:** reuses message/key resolution and the existing fixtures, but copies the automatic payload/key batching and Antigravity loop into `deliverOwnerNudge` instead of sharing them as planned. This duplicates transport behavior that must remain consistent. Its tests cover the main bypass cases but miss concurrent pause, prompt-hook timing and automatic initial delivery after a neutral reminder. `docs/readiness-policy.md:229` also asserts that the same UUID remained in a captured pane, despite acknowledging at line 236 that historical captures are absent; that explanation should be qualified as an inference.

### Verification evidence

I read the existing issue-195 journal instead of rerunning the candidates' full suites. These are recorded **advisory hook observations**, not coordinator final-check results:

| Candidate | Passing `pnpm run check:fast` journal sequence | Passing `pnpm run test:e2e` journal sequence |
| --- | --- | --- |
| Claude | 493 | 497 |
| Codex | 502 | 511 |
| Cursor | 519 | 524 |

Codex's earlier typecheck failure at sequence 487 was corrected before its passing sequence 502 and product commit. The prepush observations cover the outgoing ranges through each implementation-ready signal. The bound pins were read directly from the supplied worktrees.

For this review I copied the exported source and existing tests into isolated `/private/tmp/issue-195-review-{agent}` directories, appended only investigation tests there, and ran the existing Vitest runner with `test/runLoop.test.ts -t 'review reproduction'`, followed by `-t 'review reproduction same tick'`. The pinned worktrees and product files were not edited.

| Investigation | Claude | Codex | Cursor |
| --- | --- | --- | --- |
| Concurrent pause preserves delivery and an owner outcome | Pass | Pass | Fail |
| Submit hook before transport return remains accepted | Not run; inspected timestamp placement | Pass | Fail |
| Binding changes after Antigravity prelude | Fail | Pass | Fail |
| Neutral owner reminder excludes automatic send that tick | Fail | Pass | Fail |

These controlled runner tests establish the reported races; they do not claim live vendor acceptance. No additional full product suite was run for this comparison. Select Codex `c42d14ec2da1860cc79be5e209d129025da143b7`.
