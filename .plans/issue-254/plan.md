# Issue 254 plan: keep verified containment on completed issues and after SessionEnd

## Problem summary

Two code paths make `coord status --issue <n>` print `[WARN] Issue <n>: complete`
and `runtime hook trust/activity not yet verified`, even when an agent's
`R1.join` probe was a corroborated `hook-denied`:

1. `src/agentLifecycle.ts:567`, in `applyLifecycleObservation`, sets
   `containment: sessionChanged || observation.kind === "session-end" ? null : entry.containment`.
   An agent exiting after `R7.finalize` fires `SessionEnd`, which erases the
   recorded `probe` and `hookDenial` for the session that produced them. The
   `sessionId` itself stays put, because `sessionId = incomingSession ?? entry.sessionId`.
2. `src/issueReport.ts:94-99` (top-level cue) and `src/issueReport.ts:233`
   (the per-agent line) call
   `containmentCoverage(entry, containmentPolicy(root, id)?.binding ?? null)`.
   That compares the historical probe with the clone's binding on disk today.
   After a later upgrade or hook change, the binding differs (or the clone is
   gone and the value is `null`), so a finished issue reports `hook=unverified`
   and its cue drops from `[OK]` to `[WARN]`. Lines 97-98 also let post-run
   `health` drift downgrade a finished issue.

## Exact File List to be changed or deleted

- `src/agentLifecycle.ts`: in `applyLifecycleObservation` (line 567), change
  the containment expression to `containment: sessionChanged ? null : entry.containment,`.
  Only a replacement session clears containment; `session-end` keeps it.
  Nothing else in this file changes. `containmentCoverage` keeps every check
  it has today: session match, the optional binding comparison, denial/probe
  corroboration on session, binding, policy revision and timestamp order, and
  rejection of an `unknown` vendor version.
- `src/issueReport.ts`: inside `renderIssueReport` only:
  - Line 94: gate `uncertain` on `!cursors.completed`. Agent health and
    containment readiness no longer affect a completed issue's cue.
    `needsAction` (holds, owner question, failed publication, pause) still
    outranks it, so a failed publication on a completed issue still shows
    `[ACTION]`.
  - Line 233: when `cursors.completed` is true, pass `undefined` as the
    binding: `containmentCoverage(entry, cursors.completed ? undefined : containmentPolicy(agent.root, agent.id)?.binding ?? null)`.
    `undefined` is the existing "no live comparison" mode of
    `containmentCoverage`. The recorded evidence is still judged by its own
    corroboration (`denial.binding === probe.binding`, same session and
    policy revision, denial no later than probe). Running issues keep the
    live-binding comparison unchanged.
- `test/agentLifecycle.test.ts`: in the existing case "requires a tool-result
  observation plus a probe denial, and invalidates session/config changes",
  line 85 now asserts the behavior the issue rejects
  (`session-end` → `containment` is `null`). Replace that assertion as
  described under Tests.
- `test/issueReport.test.ts`: add one case inside the existing
  `describe("issue report", ...)` block.

## Exact file list to be created

- `.plans/issue-254/plan.md` (this coordination artifact only).

The implementation creates no product, source or test files.

## Reuse and Scope

Reused without modification:
- `containmentCoverage` (`src/agentLifecycle.ts:44`). Its optional `binding`
  parameter already means "skip the live comparison" when `undefined`, so
  completed reports need no new helper, flag or "historical" variant.
- The corroboration logic inside `containmentCoverage`, which is the
  in-run evidence the issue's requirement 2 asks us to trust.
- `containmentPolicy` (`src/shellGuard.ts:21`), still used for running issues.
- Test fixtures: `entry()`, `digest`, `now` and `later` in
  `test/agentLifecycle.test.ts`. The `identity`/`denial`/probe objects built
  in that existing case are reused in place. In `test/issueReport.test.ts`:
  `start()`, `complete()` and `initialAgentLifecycle`. The agent root `/c` in
  `start()` does not exist, so `containmentPolicy` returns `null`. That
  already reproduces "the clone's on-disk binding no longer matches" without
  touching the filesystem.

Out of scope, deliberately unchanged:
- `src/runLoop.ts:1084` (`reportStartup`) and `src/runLoop.ts:2105`
  (`R1.join` acceptance journal). Both run only for live issues, where
  comparing with the live binding is correct.
- `src/shellGuard.ts` probe creation and ingestion (lines 339, 356-359).
  Ingestion still refuses probes whose binding differs from the live clone.
- `recordContainmentEvidence` and the containment schema. No state format
  change and no migration.
- The issue names a `renderAgentStatusLines`, but no function by that name
  exists in `src/` or `test/`. The per-agent status lines are rendered
  inline in `renderIssueReport` (lines 227-248), which is the site changed above.
- The per-agent `[WARN] ... runtime hook trust/activity not yet verified`
  line stays. On a completed issue it now prints only when the recorded,
  in-run evidence itself was never corroborated. That is still true and
  worth showing.
- Abandoned issues keep today's behavior; the issue asks only about completed ones.

No new file, abstraction or dependency is introduced, and no version bump is
planned.

## Tests

Focused run during development:
`pnpm vitest run --config vitest.config.ts test/agentLifecycle.test.ts test/issueReport.test.ts`.
The commit hook owns `pnpm check:fast`; it is not duplicated by hand.

1. `test/agentLifecycle.test.ts`, existing case "requires a tool-result
   observation plus a probe denial, and invalidates session/config changes".
   Replace line 85 with assertions on a corroborated `hook-denied` entry
   (`current` once `vendorVersion` is restored to `"1.2.3"`):
   - `applyLifecycleObservation(current, { kind: "session-end", eventName: "SessionEnd", sessionId: "s" }, later)`
     keeps `containment` equal to `current.containment`, and
     `containmentCoverage(ended, digest)` is `{ hook: "active", shim: "unverified" }`.
   - The same holds for a `session-end` with no `sessionId`, which is the
     shape line 85 used.
   - The existing `session-start` with `sessionId: "next"` assertions
     (lines 82-84) stay, proving that a replacement session still clears
     containment.
   Before the change, the `toEqual`/`active` assertions fail because
   `containment` is `null`. After the change they pass.

2. `test/issueReport.test.ts`, new case in `describe("issue report")`:
   "keeps a completed issue [OK] with in-run containment after session end
   and binding drift".
   - Build `lifecycle = initialAgentLifecycle(["cursor"], at)` and set
     `cursor` to `sessionId: "s"`, `health: "healthy"` and a corroborated
     containment (`hookDenial` with `probe: true` and `probe` with
     `toolResult: "hook-denied"`, `vendorVersion: "1.2.3"`, the same
     `sessionId`/`policyRevision`/`binding: "a".repeat(64)`, and denial `at`
     ≤ probe `at`).
   - With `complete()`: the output contains `[OK] Issue 1: complete` and
     `containment hook=active`, and does not contain
     `runtime hook trust/activity not yet verified`. The on-disk binding for
     `/c` is `null` ≠ the probe's binding, which is the "policy later
     changed" condition. Before the change this renders `[WARN]` and `hook=unverified`.
   - Same lifecycle with `health: "degraded"`: still
     `[OK] Issue 1: complete`. Before the change this is `[WARN]` because of
     line 97.
   - Regression guard on the live path: the same lifecycle with
     `{ ...complete(), completed: false }` still produces a `[WARN] Issue 1:`
     cue and `containment hook=unverified`. Running issues keep comparing
     with the live binding.

No end-to-end test is needed. Both changes are pure functions of
lifecycle/cursor state, and the existing `test/cli.test.ts` containment cases
(lines 614-622) cover probe ingestion, which does not change.

## Alternatives Rejected

- **Store a `completed` snapshot of coverage in cursors at R7.finalize and
  render that.** It would need a schema change, a migration for existing
  completed runtimes, and a new write path. Rendering with `binding: undefined`
  already reads the same recorded evidence, without new state.
- **Clear containment only on `session-end` events whose `sessionId`
  differs.** A different-session non-start event already returns early
  (`if (sessionChanged && !beginsSession) return entry;`), so this branch
  would never run. The issue's rule ("only `sessionChanged` clears") is the
  simpler, equivalent form.
- **Drop the live-binding comparison everywhere.** For a running issue, a
  changed hook file means the earlier probe no longer describes the guard
  that is in force. Weakening `runLoop.reportStartup`, the `R1.join` journal
  or shellGuard ingestion would hide a real regression.
- **Also suppress the per-agent `[WARN] ... not yet verified` line on
  completed issues.** Once the recorded evidence is judged without the live
  comparison, the line appears only when the run itself never produced
  corroborated evidence. Hiding it would erase that history.
- **Add a separate `historicalContainmentCoverage` helper.** The existing
  `undefined` binding mode already does this; a second function would
  duplicate the corroboration rules.

## Risks and Mitigations

- **A resumed process that keeps the same `sessionId` after `SessionEnd`
  would inherit the earlier containment.** For running issues, coverage is
  still compared with the clone's live binding (`issueReport` running path,
  `runLoop.reportStartup`, `R1.join` acceptance). A resume after a hook or
  policy change therefore still shows `unverified`. Only an unchanged policy
  in the same session carries over, and the same evidence describes it. A
  real replacement session (`session-start` with a new id) still clears
  containment, and the existing assertions at lines 82-84 pin that.
- **A completed issue could hide a real post-run problem.** After completion,
  no further actions are sent, so live containment no longer matters for that
  issue. `needsAction` still covers holds, owner questions, pauses and failed
  publication. The per-agent line still prints the observed health, the
  recorded coverage and the probe details.
- **A legacy runtime whose containment was already wiped by `SessionEnd`
  before this fix keeps `hook=unverified` on its per-agent line.** That
  evidence is gone and cannot be rebuilt honestly. The top-level cue is still
  `[OK]` because completed issues no longer compute `uncertain`.
- **Other readers might rely on `containment === null` after session end.**
  `grep` finds containment readers only in `issueReport.ts`, `runLoop.ts`
  and `shellGuard.ts`, and each goes through `containmentCoverage` or a
  session-matched probe check. None treats session end as a revocation signal.

## Conclusion

Make two one-line logic changes: keep containment across `SessionEnd` for the
same session in `applyLifecycleObservation`, and render completed issues from
their recorded, corroborated evidence without the live disk-binding comparison
or post-run health. Change one existing assertion and add one focused
report-test case. The live-issue containment checks and the state schema stay
the same. Product checks are owned by the commit hook (`pnpm check:fast`) and
the coordinator's final suite at the approved pin.
