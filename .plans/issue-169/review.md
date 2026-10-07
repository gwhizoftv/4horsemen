# Issue 169 — plan review

Reviewed the exported bound plans, not moving peer branches:

- Cursor: `dc7e33a29aa9dba2b197e9570580d48a15bb1dd9`.
- Codex: `5ba6d9c400d7d87cbcc6d69f32a49dcf80af5cb9`.
- Claude: `6f52fe39843b95fa8a00309a701ff9a5d6993f5f`.

## Findings

### 1. [P1] Cursor consumes readiness before the next delivery

**Plan claim:** Cursor, Exact File List, `src/runLoop.ts` entry (plan lines 26–31), says to clear ready wherever completion is cleared, explicitly including acceptance.

**Rule:** A valid readiness receipt must survive acceptance of the action it names and remain available for the next action's send. The issue says to delete it once that nudge is sent, not when its preceding completion is accepted.

**Failure:** An agent writes complete A, rereads unchanged A, writes ready A, and ends its turn before the next coordinator poll. Accepting A clears complete in both Git acceptance (`src/runLoop.ts:1827–1829`) and response acceptance (`2100–2103`). The proposed extra cleanup therefore deletes ready A before B can use it. With the missing Stop and unrecognized sentinel that motivated the issue, B remains blocked exactly as before. The plan's warning that readiness can precede acceptance does not prevent this deletion.

**Smallest correction:** Preserve readiness through normal acceptance/preparation; consume the observed receipt after successful delivery. Add the full write-ready-before-acceptance ordering to the existing run-loop fixture rather than only seeding already-accepted state.

### 2. [P1] Claude's file-backed Codex path still requires a visible sentinel

**Plan claim:** Claude, Exact File List, `src/tmux.ts` entry (plan lines 64–70), removes only the two explicit sentinel requirements while keeping the Codex composer-holds and submit-acceptance checks unchanged; Tests item 4 only mechanically adapts the sentinel test.

**Rule:** File-backed readiness must work without a rendered sentinel while retaining empty-composer, vim-mode, exact-message, and per-key protections.

**Failure:** `codexComposerHolds` uses `codexTail`, which returns null without the sentinel (`src/tmux.ts:165–195`). A valid ready receipt with an otherwise idle Codex pane and no visible sentinel now passes the initial checks and pastes the message, but the unchanged check at line 1057 refuses before submission. The run loop treats that partial send as delivery-uncertain and holds the issue. `codexVimNormal` and `codexNudgeSubmitted` also depend on the sentinel. Moreover, dropping the pre-typing sentinel check without replacing its empty-composer check allows the initial paste into an owner's existing draft before the later check notices the mismatch.

**Smallest correction:** Factor the existing composer/vim/submission inspection so file proof does not require the sentinel boundary. Extend the per-key fixture with no-sentinel file proof, NORMAL/INSERT, and a pre-existing draft that must receive zero keys.

### 3. [P1] Cursor and Claude do not observe all hook arrivals used to invalidate readiness

**Plan claim:** Cursor, Reuse and Scope (plan lines 75–81), and Claude, the `readyReceiptProvesIdle` definition (plan lines 55–63), use only receipt mtime versus `lastEventAt`; both rely on the existing lifecycle snapshot for subsequent checks.

**Rule:** The requested receipt proof is invalid once a hook has arrived after the file was written. Semantic equality of two hook observations is not evidence that no later hook arrived.

**Failure:** `observeAgentLifecycleWithResult` deliberately suppresses semantically duplicate observations, including their new timestamp (`src/agentLifecycle.ts:675–700`); telemetry also does not advance `lastEventAt` (`461–478`). Arrange a working observation after the current action was ordered, write ready A, then receive another identical working observation before the first send. No heartbeat is needed and the duplicate leaves the persisted timestamp/snapshot unchanged. Both proposed predicates still authorize file-backed delivery despite the later hook, including during a per-key recheck. This can authorize typing while activity has resumed but terminal chrome has not yet reflected it.

**Smallest correction:** Preserve receipt freshness separately from semantic lifecycle deduplication, and include it in per-key validation. Test a later duplicate, not just a hook that changes execution or turn ID; do not change idle epochs or manufacture telemetry activity to solve this.

### 4. [P2] Cursor's approved file map omits code required by its delivery design

**Plan claim:** Cursor, Exact File List, proposes passing `readyPath` through built orders and adding an override that does not require the sentinel, but lists neither the order-type module nor the tmux implementation/test for modification. The tmux path occurs only in Reuse and Scope.

**Rule:** Every implementation change must be authorized by the exact file map; paths mentioned only for reuse do not grant modification authority. Reused APIs must actually support the proposed behavior.

**Failure:** `InternalOrder` has `completePath` but no `readyPath` (`src/steps.ts:316–330`). More importantly, the only existing `TmuxController.nudge` override input unconditionally requires the sentinel (`src/tmux.ts:1009–1010,1056`). Passing that callback leaves Cursor's principal regression failing; omitting it removes the promised lifecycle/per-key override protections. Implementing the described behavior thus requires unlisted API/code changes or a materially different design, not just the listed run-loop edits.

**Smallest correction:** List the necessary tmux implementation and focused test changes. Either derive the ready sibling from the existing completion path or explicitly include the order-type changes required by a new field.

### 5. [P2] Cursor and Claude omit accepted amendment requests from the readiness binding

**Plan claim:** Both plans update lastAcceptedActionId only in `markActionWorkflowComplete`; Claude specifically relies on its two existing Git/response acceptance call sites, and Cursor also clears readiness on action retirement.

**Rule:** An accepted amendment request completes the requesting agent's current action and advances it to a new ballot action. Its readiness marker must be able to authorize that next action under the same last-accepted-action contract.

**Failure:** `beginAmendment` records and transitions an accepted request without calling `markActionWorkflowComplete` (`src/runLoop.ts:1933–1951`). If the requester writes ready A for that request while its lifecycle remains working, the plans retain the ID of an earlier action. The amendment ballot cannot use ready A and again stalls when the sentinel is not usable; Cursor additionally deletes the receipt during retirement. This path is already part of the implementation/revision action protocol, not a new feature.

**Smallest correction:** Record the requester's accepted action identity at the accepted-request transition and preserve its receipt for the subsequent send. Do not treat unanswered peer actions retired by the same transition as accepted. Extend the existing amendment fixture.

### Scope, reuse, and verification assessment

All three plans keep the receipt inside the existing mailbox grant, reuse completion parsing and delivery infrastructure, and create no product modules or dependencies. All favor existing test files. Cursor's extra mailbox documentation and owner-recovery cleanup concern this feature, but its file map and acceptance cleanup need the corrections above. Claude's post-send diagnostic correction is relevant to the reported misleading messages; its new startup wording should remain conditional on what was actually observed, since a missing session ID alone does not prove that a launcher is still starting.

No blocking finding in the Codex plan at the cited pin: it explicitly preserves receipts through acceptance, records accepted requests, separates hook receipts from semantic lifecycle state, and decouples the Codex checks from the sentinel. Its additional state fields and focused tests are justified by those concrete gaps. It also preserves process mismatch as a veto rather than allowing delivery to a shell.

Verification performed: source inspection of the acceptance, amendment, lifecycle, and tmux paths; inspection of all three bound plans; and two existing focused tests confirming duplicate-status suppression and sentinel-backed per-key behavior. The attempted pnpm invocation aborted before tests because its dependency check wanted to remove the modules directory without a TTY; no reinstall was authorized or performed. Running the installed runner directly succeeded:

```sh
node node_modules/vitest/vitest.mjs run --config vitest.config.ts test/agentLifecycle.test.ts test/tmux.test.ts -t 'does not rewrite lifecycle state for duplicate status-line renders|sends a sentinel-required nudge only while the idle proof holds at each key'
```

Result: 2 tests passed, 66 skipped. These confirm existing behavior supporting the findings; they are not verification of an implementation of any plan. No full product suite or coordinator-owned check was run.

## Conclusion

Cursor and Claude require revision before implementation for the findings above. Codex is the implementable plan as written and the recommended selection. Preserve the shared narrow design: a durable readiness receipt supplements terminal evidence but never bypasses process/input vetoes, completion validation, or duplicate-send limits.
