# Plan: detect and stop actions an agent cannot complete

## Exact File List to be changed or deleted

- `src/paths.ts` — add the per-agent `blocked.json` receipt beside `complete` in the already isolated completion-mailbox directory, create it through `agentRuntimePaths`, and keep the existing containment and no-symlink guarantees.
- `src/steps.ts` — carry the absolute blocked-receipt path in `InternalOrder` so every Git- and response-mode action has the same failure channel.
- `src/action.ts` — render the blocked path and bounded failure-report scaffold into both action modes; add strict parsing, reading, and clearing helpers for the correlated blocked receipt without weakening the existing `complete` grammar.
- `src/state.ts` — add `blocked` and `stalled` agent cursor states, a defaulted nullable structured halt record, and `action-blocked` / `action-stall-suspected` journal event types without forcing existing format-4 runtimes to be rewritten.
- `src/agentLifecycle.ts` — stop treating lifecycle `failed` as an eligible idle transition for duplicate delivery and expose `failed` as a nudge wait reason.
- `src/tmux.ts` — recognize an exact, action-correlated `COORD-BLOCKED` tail sentinel as the fallback when the agent cannot write its mailbox receipt; keep it additive and unable to override pane safety checks.
- `src/runLoop.ts` — poll success and failure receipts with deterministic precedence, correlate reported and harness-observed failures to the current action, raise one advisory stall after a bounded accepted-turn attention window, persist the halt, and suppress all further nudges until success or explicit owner recovery.
- `src/issueReport.ts` — show each blocked or suspected-stalled agent's reason, summary, observation time, and concrete recovery commands in `coord status` without exposing private ballot contents.
- `src/cli.ts` — clear the blocked receipt and halt state through the existing `restart-action --agent`, drop, and cleanup paths so recovery always mints a new action UUID; update command help to describe blocked-action recovery.
- `templates/product/AGENTS.protocol.md` — require bounded retries, immediate reporting of deterministic blockers, atomic publication of `blocked.json`, and a terminal fallback; forbid restarting unchanged work after reporting the current action blocked.
- `README.md` — document the success-or-blocked outcome contract and the existing commands an owner uses to resolve a blocked action.
- `docs/coord-driver.md` — specify the blocked receipt schema, correlation and precedence rules, failure/stall state transitions, owner recovery, and the distinction between authoritative failure evidence and advisory timeout evidence.
- `docs/readiness-policy.md` — extend the signal-precedence model so an action outcome can stop delivery even when hooks say `working` or the pane looks ready, while elapsed time alone remains unable to authorize a resend or declare failure.
- `docs/repo-map.md` — describe `blocked.json` as the second permitted mailbox receipt and identify the existing modules that own it.
- `docs/setup-workspace.md` — update the completion-mailbox description to cover unsuccessful outcome receipts without broadening any harness grant.
- `test/paths.test.ts` — cover the new blocked path, containment, directory creation, and the fact that it shares only the existing per-agent mailbox grant.
- `test/action.test.ts` — cover action rendering plus strict valid, stale, oversized, malformed, and symlink-safe blocked-receipt reads while preserving all current completion parsing cases.
- `test/state.test.ts` — cover default adoption of the new halt field by existing format-4 state, blocked/stalled cursor validation, and the new journal events.
- `test/agentLifecycle.test.ts` — prove that `failed` never authorizes a duplicate nudge and that an unrelated/prior-turn failure does not become a current-action blocked report.
- `test/tmux.test.ts` — cover exact tail-only blocked sentinel parsing, action-ID correlation, ANSI handling, stale scrollback, quoted/prose lookalikes, and unsafe-pane vetoes.
- `test/runLoop.test.ts` — cover reported blocks, terminal fallback, correlated harness failure, advisory stall timing, precedence, deduplication, late success, and nudge suppression.
- `test/issueReport.test.ts` — cover concise blocked and stalled operator output and recovery commands.
- `test/cli.test.ts` — prove `restart-action --agent` clears the old failure receipt/halt, preserves unrelated agents, and prepares a replacement with a new action UUID; cover drop and abandon retention/cleanup rules.
- `test/install.test.ts` — prove the installed protocol contains the bounded-retry and blocked-report contract while the writable grant remains limited to the existing per-agent mailbox directory.

No tracked file will be deleted.

## Exact file list to be created

- `.plans/action-failure-detection/plan.md` — this owner-requested implementation plan. No new source or test module is needed because action receipts, lifecycle policy, run-loop decisions, status rendering, and their focused tests already have clear owners.

## Reuse and Scope

The implementation will reuse `agentRuntimePaths` and the existing `completeDir` grant rather than add another writable root. The new `blocked.json` path will be a sibling of `complete`; therefore `resolveSafeCompletesRoot`, `containedPath`, `assertNoSymlink`, `createIssueRuntime`, and the launcher grant in `scripts/lib/launcher.sh` retain the current security boundary. The configuration key remains `completesRoot` for compatibility even though the directory now carries both successful and unsuccessful outcome receipts.

`InternalOrder`, `buildOrder`, `renderGitAction`, and `renderResponseAction` will carry and render the blocked path. The public front matter remains restricted to its current fields: the failure path and JSON scaffold belong in the action body just as `completePath` does today. `parseCompletion`, `readCompletion`, and `clearCompletion` remain the sole success-receipt implementation and keep their exact SHA/response-marker grammar.

The failure receipt will use a strict, size-bounded JSON object containing the current `actionId`, a closed reason code (`sandbox-denied`, `resource-exhausted`, `path-invalid`, `command-unavailable`, `authentication`, `dependency-unavailable`, `repeated-failure`, or `unknown`), a short summary, a nonnegative attempt count, and a retryable boolean. The coordinator supplies the trusted observation timestamp; it does not trust an agent clock. No command lines, environment values, or raw logs are accepted, limiting secret leakage and unbounded journal/status output. Agents write a temporary file within their mailbox and rename it to `blocked.json`, so the coordinator never needs to interpret a partial ordinary write as a valid report.

`CoordinatorRunLoop.runTick` remains the authority that consumes outcomes. For a current action it will apply this order:

1. A syntactically valid `complete` receipt is evaluated first. Verifiable success remains workflow truth and can supersede a previously reported block if late work actually completed.
2. With no valid success, a valid `blocked.json` for the current action records an authoritative `blocked` halt and suppresses delivery.
3. A malformed current mailbox failure report also stops delivery as an owner-visible malformed-report block; it must not be converted into a correction nudge that repeats the original loop.
4. A stale failure report for another action UUID is journaled and cleared, then ignored.
5. Without a mailbox report, an exact current-action `COORD-BLOCKED: <actionId> <reason-code>` line at the terminal tail records a fallback block.
6. Without an agent report, a lifecycle failure correlated to the accepted current action records `harness-failed`. A session failure that is not correlated to the accepted current action remains lifecycle evidence only.
7. An accepted turn that remains unfinished past a separate action-attention watchdog records `stalled`, not `blocked`. This is an advisory operator intervention point, never proof that the action failed.

The existing `AgentCursor.status`, `attempt`, `outstanding`, and lifecycle action identity will be reused. A defaulted nullable halt record will retain the structured kind, reason code, summary, and coordinator timestamp needed by status and recovery. This avoids overloading `outstanding` with persistent control-plane state. The machine already waits when a participant has a current action UUID and no accepted evidence, so it needs no new decision type: `blocked` and `stalled` cursors simply remain at the current gate.

The existing `restart-action --agent <agent>`, `coord drop <agent>`, and `coord abandon` commands are the owner controls. No new `coord resolve` command is justified. Restart clears the old action, response, success receipt, failure receipt, lifecycle correlation, and halt record; the next tick uses `createActionId` to mint a new UUID. The coordinator will never auto-retry merely because an agent labels a failure retryable.

The agent protocol supplies the semantic circuit breaker unavailable to terminal scraping: a deterministic blocker is reported immediately, while the same operation and same failure may be attempted at most three consecutive times unless a concrete remediation changes the inputs or environment. After reporting, rereading an unchanged `action.md` produces only the blocked sentinel and stops; it never restarts the operation. This covers active retry loops that continue producing hook activity and therefore cannot be diagnosed from `working` alone.

`decideLifecycleNudge`, `harnessPromptReadiness`, `idleSentinelAfterAction`, and the existing observability watchdog remain responsible for safe delivery. The new attention watchdog is deliberately separate: observability degradation means hook correlation is late, whereas action stalling means an accepted action has exceeded the operator-attention window. Neither timer authorizes duplicate input. A valid later success receipt is still processed while an agent is blocked or stalled.

The terminal sentinel is a fallback, not the primary protocol. Like `COORD-IDLE`, it must be the last nonempty rendered line and contain the exact current action UUID; blockers such as a dead pane, input-off state, or unsafe foreground process are evaluated first. This prevents stale scrollback, example prose, or a previous action from becoming workflow truth.

Passive transcript parsing, command/error fingerprinting across vendors, provider-specific token prediction, automatic process interruption, and automatic privilege changes are out of scope. They can improve diagnostics later, but they are neither portable nor safe prerequisites for stopping the loop. No dependency or version bump is required.

## Tests

- Run `pnpm check:fast` before committing the implementation.
- Run the coordinator acceptance suite `pnpm check` before approval.
- Git-mode and response-mode rendered actions name the correct per-agent blocked path and provide the same bounded JSON contract.
- A valid current-action block moves only that agent to `blocked`, journals exactly one `action-blocked`, emits one normal operator message, and never nudges again on later ticks.
- Identical reports and repeated ticks are idempotent; a stale UUID cannot block a replacement action, and a malformed report stops for owner inspection rather than causing a corrective reissue loop.
- A valid success receipt is evaluated ahead of a block and a valid late success can still advance the gate; invalid success never masks a valid failure report.
- Correlated lifecycle failure after prompt acceptance blocks, while a failure from a prior turn, unmatched digest, queued prompt, or replaced session does not.
- `execution: failed` is a closed wait reason and no longer increments an idle epoch that authorizes another nudge.
- The blocked terminal sentinel must be current, exact, unquoted, and at the tail; stale, embedded, ANSI-spoofed, and unsafe-pane cases cannot block or authorize input.
- The attention watchdog raises one `stalled` advisory after its boundary, never before it, never labels the action definitively failed, and never uses time to resend.
- `coord status` distinguishes agent-reported block, harness-observed failure, and suspected stall, and prints `restart-action --agent`, `drop`, and `abandon` remedies without private response data.
- `coord restart-action --agent <agent>` clears only that agent's receipts and halt, invalidates the old correlation, and prepares a new UUID; drop and issue cleanup cannot leave a stale blocked receipt to affect a future action.
- Installation retains the narrow mailbox grant, and installed `AGENTS.md` tells every harness to stop after bounded repeated failures and report the block before exhausting its remaining turn budget.

## Alternatives Rejected

- **Treat a missing `complete` file after N minutes as failure.** A long implementation is indistinguishable from a dead turn by elapsed time alone. Time may raise `stalled` for owner attention, but cannot claim failure, resend, drop, or abandon.
- **Keep sending “re-read action.md” while hooks say idle or failed.** This is the loop being fixed. `failed` must not mean idle, and any blocked/stalled outcome opens a delivery circuit breaker until explicit recovery.
- **Trust lifecycle `working` as proof of progress.** A tight retry loop produces continuous activity. Lifecycle remains delivery-safety evidence; the agent's bounded-retry contract and outcome receipt carry semantic inability.
- **Infer every failure by scraping terminal prose or vendor transcripts.** Those formats are incomplete, mutable, and can contain the same text in plans or logs. The exact tail sentinel is only a fallback; transcript/error fingerprinting can be added later as advisory telemetry.
- **Overload `complete` with `blocked ...`.** `complete` currently has a deliberately strict success grammar. Mixing success and failure makes malformed-success correction behavior ambiguous and risks treating failure as publication intent.
- **Put failure state under the coordinator runtime.** Agents must not gain write access to `cursors.json`, the journal, peer orders, or accepted ballot material. Reusing the existing per-agent mailbox directory preserves the security boundary.
- **Create a new writable directory or widen sandbox permissions.** The current `completeDir` grant already supports a sibling receipt. Another grant increases setup and security surface without adding capability.
- **Automatically retry reports marked retryable.** The same environment normally produces the same denial, consumes more model budget, and can duplicate non-idempotent work. Only the owner-authorized `restart-action` opens a new attempt.
- **Add a new owner-resolution command.** Existing `restart-action --agent`, `drop`, and `abandon` already express the required decisions and preserve current workflow semantics.
- **Automatically kill or restart a long-running harness.** A slow valid action could lose completed but unpublished work. The attention watchdog is advisory and fail-closed instead.

## Risks and Mitigations

- **An agent can self-report a false block.** An agent can already decline to create `complete`; the new receipt makes that state observable rather than granting new authority. The coordinator never advances a gate from a block, and the owner chooses recovery.
- **A block and success can race.** Valid, verifiable success has deterministic precedence and remains pollable after a halt. Failure never counts as accepted evidence.
- **A partial or corrupt JSON write could itself cause a loop.** The protocol requires temp-plus-rename publication. If malformed bytes nevertheless appear, the coordinator halts for the owner instead of reissuing the action.
- **Stale mailbox or terminal content could affect a new action.** Exact action UUID correlation, tail-only sentinel matching, restart cleanup, and journaled clearing prevent cross-action reuse.
- **The attention watchdog can flag legitimate long work.** Its state and wording say `stalled` / suspected, not failed; it never resends or interrupts, and a later valid completion still wins. Keep the threshold independently injectable in tests and documented as an operator-attention policy rather than an execution deadline.
- **A hard token/time cutoff can occur before the model writes a receipt.** Correlated vendor failure, pane death, and the attention watchdog cover abrupt termination. Where the model still controls its last response, the protocol tells it to reserve enough budget to publish the small receipt before elaborating.
- **Lifecycle failures may describe an older turn.** Only an accepted current action with matching action UUID, digest, session, and turn may become a harness-observed block. All other failures remain non-authoritative lifecycle diagnostics.
- **The fallback sentinel may appear in ordinary prose.** Require the exact current UUID and reason token on the last nonempty line, reject quoting/prefixes/suffixes, and apply pane safety checks first.
- **Existing runtime schemas are strict.** Make the halt field default to null and add enum values without changing the runtime format; test reading a pre-change format-4 fixture. If Zod transforms cannot preserve round trips safely, bump the runtime format explicitly rather than silently rewriting state.
- **Failure summaries may contain secrets or flood logs.** Accept only a short bounded single-line summary and fixed reason codes; reject raw logs, environment dumps, and oversized payloads.
- **Blocked response actions may have partially written private responses.** They remain unaccepted and unpublished. Restart clears only that action's private response, while abandon retains runtime evidence for diagnosis under the existing owner-controlled permissions.

## Conclusion

Every automated action gains an explicit unsuccessful outcome beside its existing success receipt. A correlated agent report, exact terminal fallback, or accepted-turn harness failure stops delivery immediately; an overlong accepted turn produces a clearly labeled advisory stall rather than an unsafe inference. The coordinator persists and reports the condition, never advances from it, never blindly nudges it again, and reuses owner-authorized `restart-action`, drop, or abandon for recovery. Bounded agent retries break active tool-error loops, while UUID correlation, narrow mailbox permissions, deterministic success precedence, and late-success handling preserve the workflow's existing safety guarantees.
