# Issue 140 implementation comparison

Protocol version: 1. Bound implementation pins compared, each read from its exported worktree against baseline
`5b2c3050bdb11e112fa890b7d064c4c65f5d6eb4`:

| Agent | Pin | Size (src/test/README) |
| --- | --- | --- |
| claude | `2cfbcb43bcdfafb7ee2e44bbe6fcb94053b41ae6` | 25 files, +2269/−53. Every changed path is tested. |
| codex | `508562edaca337175e1d5c93bbb4672976f41f3d` | 24 files, +1263/−24. Every changed path is tested. |
| cursor | `49262150ce3084b564b82343e870d063f9bfaddf` | 15 files, +2064/−35. Tests exist only for the state, path, report and quota-adapter changes. |

Disclosure: I wrote the claude pin. Its findings below are held to the same standard as the others.

## Comparison

### Findings — cursor `49262150`

1. **`src/runLoop.ts:912` and `:2350`**
   - **Rule:** A Codex quota read must be triggerable by a #126 hold or by the initial binding check.
   - **Failure:** `hold()` creates every #126 hold with `recovery: null`. The only place that assigns
     `recovery.kind: "codex-probe"` is the ingestion of a `lastFailure` for the `codex` agent. The Codex normalizer
     in `src/agentEvent.ts` never emits a failure; only Claude and Cursor do. As a result, a bound Codex agent that
     hits `unobservable`, `harness-gone` or `nudge-loop` never gets a single `account/rateLimits/read`. The whole
     Codex adapter is unreachable in production. `initialBindingChecked` is declared in `src/state.ts:567` but
     nothing reads it.
   - **Test:** In the `safetyFixture`, set `ui.dead = true` for a bound Codex agent, inject a `codexLimits` reader,
     and advance 10 minutes. Expect at least one read. At this pin the count is 0.

2. **`src/runLoop.ts:2908` and `:2932`**
   - **Rule:** A held runner must stay alive until a scheduled deadline recheck has run.
   - **Failure:** `hasDueResourceObservation` counts only work whose `nextAt` is null or already due. A Claude hold
     whose `recovery.nextAt` is `resetsAt + 30 s`, five hours from now, therefore makes both `run()` branches return
     at once. The deadline recheck and any Codex deadline read never run, which is the failure described in plan
     review F1. The same loop also logs the full `renderIssueReport` on every poll iteration while held.
   - **Test:** Create a Claude hold with an exact `resetsAt` two hours ahead. Call
     `run()` with a sleep that advances the clock. Expect one `hold-updated` recheck row before `run()` returns.

3. **`src/runLoop.ts:2507` and `:2519`**
   - **Rule:** The binding exclusion must not leave a stranded reservation, and it must not block the event loop.
   - **Failure:** The start and `inFlightId` are persisted before the lock is acquired. The lock is then held
     across the awaited helper for up to 10 s. `acquireExclusiveLock` waits synchronously with `Atomics.wait` and
     throws after about 5 s. A second issue reading the same binding during that window therefore gets a
     non-`StateConflictError` exception out of `runTick`, which crashes that runner. Its own `inFlightId` stays
     set, so every later probe for that action goes owner-only ("Unreaped reservation"), even though no helper was
     ever started. Spacing is also checked only against this action's `lastStartAt`, not per binding.
   - **Test:** Two issue runtimes share one binding. One reader never resolves. Expect the second tick to defer
     without throwing and without setting `inFlightId`.

4. **`src/claudeStatusLine.ts:141–143` and `:94`**
   - **Rule:** The tee must not change the owner's output when telemetry fails, and the telemetry copy must be
     bounded. When precedence cannot be proven, the tee must be disabled.
   - **Failure:** `tee >(recv) | /bin/sh -c <owner>` has no size bound and no single-flight guard: every render
     starts a new background Node process. If the receiver exits before reading (for example, the coord `dist`
     entry is missing or Node fails to start), `tee` takes `SIGPIPE` and the owner's command gets truncated input.
     The owner's statusline then breaks because coord telemetry failed. Line 94 explicitly ignores managed settings,
     so a managed `statusLine` silently shadows the tee.
   - **Test:** Point `cliEntry` at a missing file, render the owner fixture from `test/agentHookSync.test.ts`, and
     expect identical stdout.

5. **Coverage**
   - `src/runLoop.ts` (+499), `src/agentEvent.ts`, `src/agentLifecycle.ts`, `src/claudeStatusLine.ts` and
     `src/install.ts` changed without any test in `test/runLoop.test.ts`, `test/agentEvent.test.ts`,
     `test/agentLifecycle.test.ts`, `test/agentHookSync.test.ts` or `test/install.test.ts`.
   - None of the plan's required cases is covered: fake-clock caps, `run()` versus `runTick()`, byte-exact tee,
     and the 1000-tick journal invariants. Findings 1–4 are exactly the defects those tests would have caught.

### Findings — codex `508562ed`

6. **`src/runLoop.ts:1019–1025`**
   - **Rule:** A resource observation for one issue must not fail because of another runtime's state.
   - **Failure:** The per-binding scan calls `readCursorsState` on every `issue-N` under the coord root while
     holding the binding lock. `assertRuntimeFormat` (`src/state.ts:723`) throws the wipe error for any legacy
     format 2/3 runtime, and the analytics command keeps completed format 2/3 state around read-only. That throw is
     not a `StateConflictError`, so `runTick` rethrows it and the held runner exits with an exception. This happens
     on the first due Codex probe in any workspace that still holds a legacy issue directory.
   - **Fix sketch:** Skip or catch unreadable sibling runtimes, and treat the binding as unknown only when a readable
     sibling reports `inFlight`. A test that writes `issue-9/cursors.json` with `formatVersion: 3` and then ticks a
     due probe would express this.

7. **`src/agentLifecycle.ts:407` and `:424`**
   - **Rule:** Adding evidence must not remove #126 lifecycle transitions.
   - **Failure (Cursor):** Cursor's `sessionEnd` now always carries `failure` (`src/agentEvent.ts:156`). When the
     observation is not correlated with an accepted action, line 407 returns the entry unchanged. That covers
     sessions that end while the action is only ordered or injected, and sessions after workflow completion. A
     session end that baseline recorded as `execution: "failed"` is now dropped.
   - **Failure (Claude):** For Claude, `confirmed` requires a matching turn id, because a StopFailure payload never
     carries the action id. When the payload has no `turn_id`/`prompt_id`, line 424 stores `lastFailure` and returns
     before `execution` becomes `failed`. The agent keeps looking busy, the #126 idle-transition re-send path never
     sees the failure, and the watchdog falls back to `unobservable`.
   - **Test:** Apply `{kind: "session-end", failure: {...}}` to an entry whose action is `injected`. Expect
     `execution: "failed"` as on baseline.

8. **`src/codexQuota.ts:103`**
   - **Note:** `readCodexQuota` always returns `recoveryProven: false`, so `clearsCodexResource` can never
     succeed. No Codex hold is released automatically; every deadline read only enriches the report and spends one
     of the six starts.
   - This matches the plan's validation boundary ("live recovery remains disabled for unproved combinations"). The
     README should say so plainly, and the scheduled deadline reads could be skipped until a validated gate exists.

9. **`src/claudeStatusLine.ts`**
   - **Note:** Each render runs `node … claude-statusline` and then waits up to 2 s for a second Node receiver.
     That puts two cold Node starts on the owner's display path for every render. The behavior is bounded and not
     a correctness failure. Separately, the existence of any managed-settings file disables telemetry even when
     that file has no `statusLine`, which is more conservative than required but safe.

### Findings — claude `2cfbcb43`

10. **`src/runLoop.ts:1315` (automatic Codex release)**
    - **Rule:** The plan's validation boundary says live recovery stays disabled for unproven version, auth and
      resource combinations, and that unit fixtures alone are not proof.
    - **Failure:** `applyCodexResult` releases a `usage-window` hold whenever `codexClearsBlockers` passes on a
      schema-valid read. It does not check the installed `codex` version or require an owner opt-in. On a CLI whose
      `ordinaryUsageAllowed` semantics differ from the 0.156.1 schema, a hold could be released on evidence that was
      never validated live. The damage is bounded: only that resource hold is released, the send budget is not
      refilled, and #126 holds and manual pause remain. Even so, this is looser than the plan.
    - **Smallest correction:** Gate the release on an explicit validated-version flag and default to
      enrichment-only, which is what codex did. Add a test that a clear read on an unvalidated version leaves the
      hold in place.

11. **`src/runLoop.ts` (`observeResources` before delivery)**
    - **Note:** The initial binding check runs on the tick after the first send rather than before it, because the
      action safety entry exists only once the action is prepared. An already exhausted account therefore receives
      one prompt before the hold. This does not bypass the budget.

### Scope, reuse and tests

- **claude.** All three new modules match the plan: pure evidence, the bounded adapter, and the tee. Existing files
  are extended, and the helpers exported from `agentHookSync.ts` are reused rather than copied. Tests cover:
  - the Claude, Codex and Cursor classification tables;
  - redaction;
  - byte-exact tee behavior (trailing newlines, `read`, exit status, stderr);
  - precedence refusal (managed settings, `--settings`) and owner-edit retention;
  - run-loop cases driven through both `runTick` and `run()`: 1000-tick invariants, deadline recheck, six-start
    cap, delayed retries, shifted deadlines, a missing prior window, manual pause during a read, identity gaps and
    unreaped helpers;
  - binding serialization across callers;
  - install, uninstall and doctor wiring, and the CLI input bound.

  Tradeoff: this is the largest diff. `docs/coord-driver.md` was not in the approved paths and was left stale.
- **codex.** Smallest diff. Its safety choices are conservative: no automatic Codex release, Claude recheck only,
  and a lifecycle-then-cursor fence. Tests are proportionate and extend existing files. Its defects (6, 7) are an
  operational crash and a #126 regression.
- **cursor.** Does not deliver the plan. The Codex path cannot run (1), held runners exit before deadlines (2),
  lock handling can crash and strand reservations (3), and the tee can break the owner display (4). The run-loop,
  event and hook changes have no tests (5).

Ranking for selection: **claude**, then **codex**, then **cursor**. Of the two fixable options, claude's remaining
deviation (10) is a single gate on an otherwise tested path, and it does not regress existing behavior. Codex's
findings 6 and 7 are a crash and a regression of #126 lifecycle transitions. Cursor needs its core run-loop paths
rewritten, with tests, before it could be accepted.
