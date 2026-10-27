# Issue 254 implementation comparison

Bound implementation pins compared (read from the coordinator-exported worktrees):

- claude `d754062d6cb5625d85192bb08f4ebc15ee30fc1d`
- muse `8146353438a00ba7a5bd380db682d8ddba88776e`
- codex `1a454ab38abbf96baa19960dfd8938d0530165e8`
- antigravity `e94da6c745f4664780e16639d79a3d4ea7089f03`

The coordinator blocks `git show` and `git diff` in this clone. I therefore
compared the pins with `diff -u` between the exported worktrees, using the
claude pin as the reference, and checked that pin against its known change
from baseline `7a8fc0272c80e364681d08437111f4534cd7a181`.

## Comparison

### Production code: identical behavior in all four pins

- **`src/agentLifecycle.ts`** is byte-identical across all four pins. Each
  changes only `applyLifecycleObservation` (line 567) to
  `containment: sessionChanged ? null : entry.containment,`.
  - A `session-end` for the same session, or with no session ID, keeps the
    recorded denial and probe.
  - A replacement `session-start`/`status` still clears them.
  - A delayed event from a retired or different session still returns early
    at lines 512 and 518.
- **`src/issueReport.ts`** has identical code in all four pins. The only
  difference is two explanatory comments in the claude pin, at lines 94 and
  233. Each pin:
  - gates `uncertain` with `!cursors.completed` (claude line 95; others
    line 94), so post-run health and containment state no longer turn a
    completed cue into `[WARN]`;
  - passes `cursors.completed ? undefined : containmentPolicy(agent.root, agent.id)?.binding ?? null`
    into `containmentCoverage` in the per-agent loop. Completed issues are
    judged by the in-run corroboration inside `containmentCoverage`, while
    running issues keep the live-binding comparison.
- **Unchanged in every pin:**
  - `needsAction` precedence, so a failed publication or hold on a
    completed issue still shows `[ACTION]`;
  - `containmentCoverage` and its corroboration rules;
  - `src/runLoop.ts` `reportStartup` and the `R1.join` journal;
  - probe ingestion in `src/shellGuard.ts`;
  - the containment schema.
- **Scope:** all four change exactly the four approved product paths. None
  adds a file, helper, dependency or schema field, and none does unrelated
  cleanup.

### Tests: same shape, differing in how well the running-issue control isolates the change

Every pin replaces the obsolete line-85 assertion in
`test/agentLifecycle.test.ts` and adds one case to the existing
`describe("issue report")` block in `test/issueReport.test.ts`. All reuse
`entry()`, `digest`, `later`, `start()`, `complete()` and
`initialAgentLifecycle`, and all rely on the missing `/c` fixture root as
the binding-drift condition.

**`test/agentLifecycle.test.ts`:**
- Every pin restores `vendorVersion = "1.2.3"` before asserting `hook: "active"`.
- Every pin covers the same-ID and the ID-less `session-end`.
- Every pin keeps the replacement-session clearing assertion.
- Differences:
  - claude checks replacement sessions while the version is still `unknown`.
  - muse and codex move that check after the preservation loop.
  - antigravity applies the replacement `session-start` to the already-ended
    entry, a slightly more realistic sequence. Its ID-less case checks only
    `containment`, not coverage.
  - None of these differences affects correctness.

**`test/issueReport.test.ts`:**
- Every pin applies `SessionEnd` through `applyLifecycleObservation` before
  rendering.
- Every pin asserts `[OK] Issue 1: complete`, `containment hook=active`, the
  absence of the runtime-trust warning, `[OK]` with degraded health, and a
  `completed: false` control.

### Finding C1 (muse and antigravity): the running-issue `[WARN]` control is confounded by degraded health

- **Location.**
  - muse `8146353438a00ba7a5bd380db682d8ddba88776e`: `test/issueReport.test.ts:251-255`.
  - antigravity `e94da6c745f4664780e16639d79a3d4ea7089f03`: `test/issueReport.test.ts:254-258`.
- **Rule.** The running-issue control must show that the live cue still
  enforces the live-binding containment check. `uncertain` in
  `src/issueReport.ts:97-98` is an OR of
  `entry.health !== "healthy"` and
  `containmentCoverage(entry, liveBinding).hook !== "active"`.
  The `[WARN] Issue 1:` assertion therefore proves the containment half only
  when health is `"healthy"`.
- **Failure.** Both pins set `health: "degraded"` for the completed-issue
  health check, then render the `completed: false` control without restoring
  `"healthy"`. Suppose a later change drops the live binding at line 98, for
  example by passing `undefined` there too. The live cue would then trust
  stale probes during a running issue, but `[WARN] Issue 1:` would still
  appear because of degraded health, so the header assertion would not
  catch it. The `containment hook=unverified` assertion guards only the
  per-agent call at line 233, not the cue.
- **Smallest test fix.** Restore health before the live render, as the
  claude (line 252) and codex (line 135) pins do:
  `lifecycle.agents.cursor = { ...lifecycle.agents.cursor!, health: "healthy" };`
- **Severity.** Non-blocking. The production code is correct and identical;
  this is guard strength only.

### Other observations (no defect)

- **muse** seeds `shim: "active"` and sets `degradedCause`. It has
  `as const` annotations that the other pins do not need, which makes it
  slightly noisier but correct.
- **codex** places the new report case first in the `describe` block and
  mutates the seeded entry in place (`current.sessionId = "s"`,
  `ended.health = ...`), matching the in-place style of the existing
  lifecycle test.
- **claude** adds two one-line comments at the changed `issueReport.ts`
  sites; the other pins add none. The file's comment density suits either
  choice.
- **Health seed:** `applyLifecycleObservation` already sets
  `health: "healthy"` on `session-end`, so every pin's explicit
  `health: "healthy"` seed is redundant but harmless.

### Verification

- **Checked by reading:** `diff -u` of all four product paths across the
  four exported worktrees, and the `uncertain` expression at
  `src/issueReport.ts:94-99` behind finding C1.
- **Ran for my own pin, during implementation:**
  - the focused `test/agentLifecycle.test.ts` and `test/issueReport.test.ts`
    (27/27 passed);
  - a baseline-revert run showing exactly the two new cases fail without
    the fix;
  - the commit hook's `check:fast` and the pre-push checks, which passed.
- **Not run:** peer test suites. The production code is identical across
  pins, and finding C1 follows from reading the code. Peer and final suites
  belong to the hooks and the coordinator.

### Recommendation

All four pins solve the issue with the same minimal production change and
stay within the approved scope. Of these, **claude**
`d754062d6cb5625d85192bb08f4ebc15ee30fc1d` and **codex**
`1a454ab38abbf96baa19960dfd8938d0530165e8` isolate the running-issue
containment control (C1), so I would pick one of them. muse
`8146353438a00ba7a5bd380db682d8ddba88776e` and antigravity
`e94da6c745f4664780e16639d79a3d4ea7089f03` are acceptable with the one-line
test fix above.
