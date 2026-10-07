# Issue 169 — action-bound readiness receipt

Baseline: `cd2798983651198c865cd37c494e8ac38062c109`. This plan implements the issue's requested `ready <actionId>` handshake; it does not broaden which foreground processes may receive input.

## Exact File List to be changed or deleted

No product files will be deleted. Change only these existing files:

| File | Change |
| --- | --- |
| `src/paths.ts` | Add the `ready` sibling of `complete` to `AgentRuntimePaths` and `agentRuntimePaths`, within the existing per-agent mailbox grant. |
| `src/action.ts` | Render the ready-file instructions in both submission modes; add a strict, bounded readiness-receipt reader/parser and identity-checked cleanup beside the completion helpers. Derive the rendered sibling path from the existing `completePath`, without adding public front-matter fields. |
| `src/state.ts` | Add backward-compatible, nullable/defaulted `lastAcceptedActionId` to the agent cursor and initialize it. It survives ordering the next action and ordinary cursor transitions. |
| `src/agentLifecycle.ts` | Record per-agent hook-receipt time and sequence separately from semantic execution/activity state, so a duplicate hook cannot leave a readiness receipt falsely fresh. |
| `src/runLoop.ts` | Persist the accepted action identity on successful Git/response acceptance and accepted amendment requests; validate readiness, route it through the existing delivery path, revalidate during sending, and consume it on successful delivery. Update diagnostics to distinguish file readiness from terminal-sentinel readiness. |
| `src/tmux.ts` | Extend the existing override send path to accept file-backed readiness without demanding the terminal sentinel. Preserve every input veto and per-key race check; make the existing Codex composer/vim/submission checks usable without a visible sentinel. |
| `templates/product/AGENTS.protocol.md` | Instruct agents to write the ready marker after completion and an unchanged-action reread, then print the unchanged idle line and end the turn. |
| `docs/readiness-policy.md` | Explain the file-backed proof, freshness and consumption rules, fallback behavior, and why startup `foreground-mismatch (bash)` remains a separate veto. |
| `test/paths.test.ts` | Extend mailbox-path coverage to the ready sibling and isolation. |
| `test/action.test.ts` | Cover exact marker parsing/reading, cleanup, and ready instructions for Git and response actions. |
| `test/state.test.ts` | Cover legacy defaulting and preservation of the accepted action identity. |
| `test/agentLifecycle.test.ts` | Cover hook-receipt freshness, including duplicate observations, without changing semantic idle or telemetry behavior. |
| `test/runLoop.test.ts` | Extend existing delivery fixtures with accepted-action binding, freshness, successful consumption, restart, and refusal cases. |
| `test/tmux.test.ts` | Extend the scripted per-key override fixture to exercise file-backed readiness without a visible idle line and preserve its safety cases. |
| `test/agentLanguage.test.ts` | Extend the installed-protocol contract test to cover the ready-file instruction and unchanged final sentinel. |

## Exact file list to be created

No new product source, test, configuration, dependency, or documentation file is needed. This action creates only `.plans/issue-169/plan.md` as coordination evidence. The eventual `ready` file is an ephemeral per-agent runtime receipt next to `complete`, not a tracked repository file or a new runtime directory.

## Reuse and Scope

### Diagnosis grounded in the current implementation

- `TmuxController.capturePane` captures 40 lines. `harnessPromptReadiness`, `sentinelAtTail`, and the Codex-specific `codexTail` require particular visible line/footer arrangements before classifying the sentinel as idle proof. A line an agent printed can therefore be outside the capture, wrapped, or followed by unrecognized terminal presentation and fail this proof.
- `CoordinatorRunLoop.deliver` currently permits a never-sent action to override stale lifecycle `working` only through that sentinel. `markActionWorkflowComplete` records completion but deliberately does not pretend a Stop hook arrived. Thus accepted work followed by an unobserved Stop can leave the next action waiting on fragile terminal evidence.
- `injectionGate` rejects `bash` before inspecting the terminal text because it is not the configured harness. During startup this can simply be the launcher still running; if it persists, it can mean the harness failed to start or exited. The provided log alone cannot distinguish those cases. A ready file must not authorize typing into a shell.

### Handshake and mailbox contract

1. Both rendered action modes and the installed protocol instruct the agent to finish the existing completion procedure, reread `action.md`, and execute a changed action immediately. Only an unchanged `actionId` authorizes writing the sole line `ready <that actionId>` to the exact ready path. The agent then prints the existing `COORD-IDLE` line and ends its turn. No ready receipt is written before the final reread or while executing a replacement action; a missing/unreadable action is not proof of an unchanged action.
2. Keep the completion formats unchanged. A readiness receipt never counts as work completion, an accepted ballot, or permission to change files. A receipt may arrive before the coordinator accepts its completion; leave it available, but do not use it until acceptance supplies the binding.
3. Reuse `containedPath`, `assertNoSymlink`, the existing mailbox layout/grants, and the strict one-line style of `parseCompletion`. Accept only `ready ` plus a valid action UUID, with at most one trailing newline. Reject padding, extra lines, invalid identifiers, oversized content, directories, and symlinks. Read bounded bytes and file metadata consistently; missing, partial, replaced, or unreadable receipts produce no readiness proof and must not abort the run loop. Reuse the small-file safety pattern in `readAgentResponse`, not its ballot JSON schema or a new storage abstraction.
4. Retain an identity for the observed file (content plus relevant stat identity/timestamps). Cleanup must remove only that observed receipt, not a replacement written for another action while the send was in flight. Existing issue-mailbox removal already removes the ready sibling on wipe; no launcher grant or wipe implementation change is needed.

### Durable accepted identity and hook freshness

5. Store `lastAcceptedActionId` in the same cursor mutation that accepts a Git submission or private response. Also record the requester's ID when an amendment request is accepted before its action is retired. Failed validation, action preparation, and retirement of unanswered peer actions must not advance this field. Preserve it when a new action replaces the current lifecycle action. Legacy cursors default to null and use the existing delivery behavior until a new acceptance occurs; do not guess an acceptance from terminal text or a completion file.
6. Add a small defaulted hook-receipt record (receipt timestamp and monotonic per-agent sequence) to lifecycle state. Advance it under the existing lifecycle lock for normalized hook observations received by `observeAgentLifecycleWithResult`, including semantically duplicate observations and telemetry; delayed observations still must not rewrite current-session execution. This records receipt, not activity: retain semantic deduplication and the existing `changed` result for journalling, do not increment idle epochs for duplicates, and do not turn telemetry into execution evidence. Coordinator ordering/injection mutations must not advance the hook-receipt record.
7. A marker is eligible only when its ID exactly equals this agent's durable last accepted action, it is for a different action than the one being delivered, and its write time is strictly later than the recorded hook-receipt time (conservatively including existing `lastEventAt` for legacy state). Equal/ambiguous timestamps do not authorize an override. A future-dated receipt is not proof. Recheck the hook sequence as well as the file identity during the send so same-timestamp hook arrivals cannot pass unnoticed. Keep receipt time monotonic if the wall clock moves backward.

### One delivery path, unchanged safety boundaries

8. Use file readiness as a derived idle proof for the next action's first send, including a stale `working` or `unknown` lifecycle, without overwriting persisted execution with a fabricated idle event. Require a matching currently ordered action/digest, no prior charged send or injection, no reservation, no pending inputs, and no background work. Thread this proof through `maybeLifecycleNudge` and `deliver`, so the lifecycle decision cannot reject it before delivery checks run. Existing manual pause, holds, active-roster membership, pull-only behavior, send budget, and authority checks remain in force.
9. Extend the optional override input to `TmuxController.nudge` with an explicit proof source rather than creating a second send implementation. Sentinel-backed overrides continue to require the sentinel. File-backed overrides still require the normal prompt and process checks, but do not depend on the idle line appearing anywhere in the capture. Run the existing dead-pane, foreground, owner-typing/copy-mode, input-off, dialog, vendor-wait, and live-turn vetoes before every relevant key.
10. Factor only the existing Codex bottom-composer/footer inspection needed for the new proof: before typing require an empty composer; after typing require exactly the intended message; send vim `i` only when NORMAL is actually indicated. Retain the correlated acceptance/confirmed submitted-message handling so a successful first submit does not receive an unsafe fallback key. A new hook, changed receipt, owner draft, or blocking pane condition stops the override; a refusal before any key is free, while partial/ambiguous sends retain the existing durable charge and `delivery-uncertain` hold.
11. After a successful next-action delivery, consume the matching observed ready file, whether file proof was needed to override `working` or ordinary lifecycle readiness already sufficed. Do not consume it at acceptance, action preparation, or a pre-send refusal: startup `bash`, dialogs, and owner typing must be able to clear and retry. A failed cleanup cannot create a duplicate because the existing persisted send accounting already disables this proof after the first send. Do not blindly delete a newly replaced receipt. Reissued/rejected work cannot use a marker naming that same unaccepted action.
12. Use the existing `nudged`/`nudge-deferred` journal and deduplicated diagnostics to identify `readiness: ready-file` and the overridden lifecycle state. Do not emit the existing claim that the pane shows `COORD-IDLE` when it did not. Preserve the sentinel and ordinary vendor prompt as backward-compatible alternatives when no usable receipt exists, with their existing safety rules.

Reuse `AgentRuntimePaths`, `AgentCursor`, `agentLifecycleEntrySchema`, `replaceCursor`, `mutateAgentLifecycle`, `orderAgentAction`, `decideLifecycleNudge`, `ensureActionSafety`, `deliver`, `injectionGate`, `resolveNudgeKeys`, and the current override/acceptance machinery. Reuse `fixture`/`safetyFixture` and their fake clock and scripted `TmuxController` in run-loop tests, the Codex per-key fixture in tmux tests, and the existing mailbox and lifecycle fixtures. New fields are justified by facts currently lost or suppressed: the accepted action UUID is cleared/replaced, and `lastEventAt` need not advance for duplicate/telemetry callbacks. No broader hook routing, process detection, vendor policy, CLI, or lifecycle redesign is included.

## Tests

Extend existing tests rather than introducing a parallel fixture or test suite. The minimal regression groups are:

1. **Receipt/instruction contract** (`test/action.test.ts`, `test/paths.test.ts`, `test/agentLanguage.test.ts`): both action modes render the exact ready path and ID after the unchanged-action reread; front matter and completion formats stay unchanged. Parameterize valid/malformed/missing/oversized/nonregular/symlink reads; confirm identity-checked cleanup preserves a replacement. Extend mailbox assertions for agent/issue isolation and installed protocol text.
2. **Persistence/freshness** (`test/state.test.ts`, `test/agentLifecycle.test.ts`): legacy defaults fail closed, accepted identity survives ordering/restart, and later duplicate hooks advance receipt freshness without changing execution, idle epochs, semantic journal results, or telemetry semantics. Include equal-time receipt ordering and session replacement.
3. **End-to-end run-loop regression using the existing fake tmux** (`test/runLoop.test.ts`): accept action A, retain stale `working`, write `ready A`, publish B with no visible sentinel, and send B exactly once. Parameterize Git and response acceptance; cover the accepted amendment-request transition within the existing amendment fixture. Verify marker removal and ready-file diagnostics. Use a fresh run-loop instance across ticks to prove restart safety.
4. **Ineligible proof and blocked delivery** (table-driven additions to `test/runLoop.test.ts`): missing/malformed/wrong/older/unaccepted IDs, a hook after the write (including a duplicate), pending/background work, and a previously charged send must not gain authorization from the receipt. A valid marker survives a startup `bash` refusal and enables one send when the expected harness appears. Existing pause/hold and absent-receipt tests remain applicable; no resending is authorized by elapsed time alone.
5. **Key-by-key safety** (`test/tmux.test.ts`): run the existing override race scenarios with file readiness and no sentinel. Cover owner draft, live turn/dialog/foreground changes, hook/receipt changes before typing and after typing, Codex NORMAL versus INSERT, and acceptance after the first submit. Assert exact keys sent, no fallback after acceptance, and existing ambiguous-send behavior. Retain the sentinel-only cases.

Focused development command, verified against the actual Vitest include/exclude configuration:

```sh
pnpm exec vitest run --config vitest.config.ts test/action.test.ts test/paths.test.ts test/state.test.ts test/agentLifecycle.test.ts test/runLoop.test.ts test/tmux.test.ts test/agentLanguage.test.ts
```

The frozen issue configuration declares precommit `pnpm run check:fast` and prepush `pnpm run test:e2e`; allow their hooks to run rather than manually duplicating those commands immediately before committing. The frozen final check is `pnpm run check`, owned by the coordinator at the approved pin. The current package scripts make `check:fast` run lint, typecheck, fast tests, and system tests, and `check` additionally runs the build and e2e. No ordinary issue-branch version bump is planned. This planning action itself needs only artifact heading/body, exact-file-map, and scope/evidence validation, not product tests.

## Alternatives Rejected

- Merely loosening the sentinel regex or increasing scrollback: still depends on viewport layout and can mistake old output for present readiness; it does not implement the requested handshake.
- Allowing `bash` as a ready harness, bypassing dialog/input checks, or trusting the file as permission to paste anywhere: can execute a nudge as shell input or interfere with the owner. Startup process mismatch is not the missing-idle-line bug.
- Treating `complete` as idle or permanently rewriting lifecycle execution to idle: completion can be accepted while the agent is still rereading or rendering; a receipt must remain a revocable delivery proof, not fabricated hook truth.
- Using only the current lifecycle action UUID or an in-memory last-accepted cache: ordering replaces that UUID, and restart loses the cache. Use durable acceptance authority instead.
- Using only `lastEventAt` for freshness: current duplicate suppression and telemetry semantics omit some arrivals. Separate receipt bookkeeping preserves those existing semantics without accepting stale ready files.
- A new daemon, CLI command, sidecar service, generalized receipt framework, new dependency, or changes to launchers, installed clone overlays, or product hooks: the existing mailbox and delivery path are sufficient.

## Risks and Mitigations

- **Completion/ready/order races:** agents may write readiness before acceptance or after the next action is prepared. Bind against the persisted last accepted UUID, not whichever action currently occupies the action file; do not delete readiness during preparation. An agent that actually sees a replacement executes it instead of reporting ready for the old action.
- **Hook and owner-input races:** recheck receipt identity and hook sequence at the existing per-key boundaries, retain all pane vetoes and send reservations, and stop rather than guess after partial input. The file is agent-reported evidence, not tamper-proof attestation or an atomic lock on a terminal.
- **Filesystem timing and unsafe files:** reject invalid/nonregular/symlink receipts, bound reads, use consistent stat identity, treat timestamp ties/future dates conservatively, and catch missing/replacement races. Reuse existing mailbox containment rather than widening permissions.
- **Repeated sends or crash recovery:** readiness authorizes only a never-sent next action; durable reservations and charged sends already survive restart. Consume only after success and preserve replacement files; no missing cleanup can reopen a used send.
- **Compatibility and scope:** default new state fields, preserve legacy prompt/sentinel behavior, keep response ballots commit-free, and retain semantic hook deduplication. Do not edit the clone-local skip-worktree AGENTS overlay, package version, hooks, or unrelated runtime files.
- **Misdiagnosing startup:** document the observed gate ordering and add the bash-to-harness regression rather than claim the provided startup log proves a launcher defect. Persistent process mismatch continues to require inspection, not automatic relaxation.

## Conclusion

Implement a strict, durable, action-bound ready-file proof alongside the existing terminal sentinel. It lets the next action escape stale lifecycle state without trusting terminal rendering, while preserving completion validation, foreground/input safety, hook freshness, restart behavior, and duplicate-send limits. The file map contains only the existing protocol, mailbox, state, delivery, documentation, and focused tests needed for that contract.
