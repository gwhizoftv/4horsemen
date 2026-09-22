# Issue 126 — bounded nudges and safe holds

Manual implementation, authorized by the owner. This replaces the previous
combined plan; provider classification, statusline/App Server integration and
automatic recovery are deferred to #140. No automation or coordination artifacts.

## Exact File List to be changed or deleted

- `src/state.ts`, `src/runLoop.ts`: durable action-scoped deferral keys before
  `journalDeferral` append, journal idempotency, shared send reservations,
  manual pause ownership, holds and bounded local observation.
- `src/cli.ts`, `src/issueReport.ts`: explicit scoped hold release, audited
  nudge-budget reset, accurate pause status and recovery instructions.
- `src/tmux.ts`: Claude wait veto before positive readiness and before keys.
- `test/state.test.ts`, `test/runLoop.test.ts`, `test/cli.test.ts`,
  `test/issueReport.test.ts`, `test/tmux.test.ts`, `test/integration.test.ts`:
  regression tests and the existing end-to-end lifecycle canary.
- `docs/coord-driver.md`: behavior, limitations and owner recovery.
- Remove this issue's obsolete `.plans/issue-126/plan.md` in favor of this file.

## Exact file list to be created

Only root `plan.md` (this manual plan). No new source modules or dependencies.

## Reuse and Scope

Reuse cursor schemas/locks/revisions, `appendJournal` idempotent decision pattern,
`setPaused`, `replaceCursor`, lifecycle decisions and existing tmux authority
fences. Extend existing test fixtures and injected clock. No backward-compatibility
migration, vendor API calls, settings/launcher changes, roster reduction or handoff.

1. Deduplicate `(agent, actionId, code)` persistently before journal append; bound
   codes, ignore wording/digest changes, and use deterministic journal identity to
   survive append-before-state crashes. Repeated deferrals write nothing.
2. All vendors, including Antigravity, share initial delivery plus three repeats
   spaced at least 60/120/240 seconds. Reserve under cursor lock before effects;
   refund only definitely unsent outcomes. Ambiguous sends retain their charge
   and require owner review. Reissue/restarts/idle epochs do not replenish counts.
   Keep this delivery policy separate from the existing 45s observability knob.
3. Latch an unknown-cause hold before a fourth repeat, not while a turn is working.
   Aggregate pause = manual pause OR active holds. Plain resume clears only manual
   pause; `resume --hold <id>` clears only one current hold. A nudge-loop hold also
   requires `--reset-nudge-budget`. Audit owner release; suppress identical old
   evidence, never a new failure. Preserve actions, roster, pins and incoming work.
4. Claude active limit/wait/menu/cancelled-wait UI vetoes typing, including at the
   last send boundary, regardless of a visible prompt. No settings changes.
5. Missing/dead harness on unfinished work holds immediately. Unknown/stale
   correlation uses a bounded observation episode: at most three checks, at least
   60s apart; start after watchdog failure or five minutes without fresh activity,
   even if lifecycle is stuck working. Persist checks across restarts. No prompt
   liveness probes; uncertainty is not confirmed quota. Local observation uses
   existing lifecycle/pane facilities, never polls vendor APIs.
6. Held ticks do not advance workflow or discard incoming bytes. Reports show
   unknown cause/deadline and owner retry ownership; no automatic resume in #126.

## Tests

Extend state/run-loop/CLI/report/tmux tests for crash/restart dedupe, A→B→A,
shared spacing/count bounds, ambiguity, independent holds/manual pause, stale
working/no hooks, last-moment Claude veto, and retained workflow authority.
Run `pnpm check:fast` before commits and full `pnpm check` before PR submission.

## Alternatives Rejected

No provider adapters, subscription/reconnect manager, rendered-clock parsing,
native waiter disabling or automatic recovery; all unnecessary for this fix.
No new reusable framework or storage family; use the existing cursor state.

## Risks and Mitigations

Stale panes cannot prove activity or quota; conservative unknown holds preserve
processes and work. A long quiet operation may need owner release. Reservations
and revision fences prevent concurrent sends and stale effects. Owner recovery
is explicit, scoped and journaled. No periodic wait journals or repeated reports.

## Conclusion

Ship #126 independently; #140 enriches evidence and recovery later.

## Feedback not accepted as written

Do not derive 60/120/240 delivery minima from the 45s observability watchdog:
diagnostic overrides must not shorten send protection. Vendor-specific feedback
belongs to #140, not this implementation. Drop legacy paused-state migration per
the owner's instruction that prelaunch backward compatibility is unnecessary.
