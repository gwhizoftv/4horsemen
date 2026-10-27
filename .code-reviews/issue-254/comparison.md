# Implementation Comparison

Bound implementation pins compared:
- `claude`: `d754062d6cb5625d85192bb08f4ebc15ee30fc1d` at `.signals/issue-254/implementation-ready-claude.json`
- `muse`: `8146353438a00ba7a5bd380db682d8ddba88776e` at `.signals/issue-254/implementation-ready-muse.json`
- `codex`: `1a454ab38abbf96baa19960dfd8938d0530165e8` at `.signals/issue-254/implementation-ready-codex.json`
- `antigravity`: `e94da6c745f4664780e16639d79a3d4ea7089f03` at `.signals/issue-254/implementation-ready-antigravity.json`

## Comparison

### Production Changes (`src/agentLifecycle.ts` and `src/issueReport.ts`)

All four implementations (`claude` `d754062d6cb5625d85192bb08f4ebc15ee30fc1d`, `muse` `8146353438a00ba7a5bd380db682d8ddba88776e`, `codex` `1a454ab38abbf96baa19960dfd8938d0530165e8`, and `antigravity` `e94da6c745f4664780e16639d79a3d4ea7089f03`) follow the selected plan (`claude` `46d506425be4ec2fb9ff6207fd7276c8e7c86e20`) and make the exact same three production logic changes:

1. `src/agentLifecycle.ts:567`: `containment: sessionChanged ? null : entry.containment,` preserves recorded containment across `session-end` observations for the same session while still clearing it when a replacement session starts (`sessionChanged === true`).
2. `src/issueReport.ts:94` (line 95 in `claude`): `const uncertain = !cursors.completed && lifecycle !== undefined && cursors.activeRoster.some((id) => {` prevents post-run agent health or containment state from downgrading a completed issue's top-level cue from `[OK]` to `[WARN]`, while preserving `needsAction` (`[ACTION]`) precedence.
3. `src/issueReport.ts:233` (line 235 in `claude`): `const coverage = containmentCoverage(entry, cursors.completed ? undefined : containmentPolicy(agent.root, agent.id)?.binding ?? null);` skips comparing `probe.binding` against the clone's live on-disk policy binding when `cursors.completed` is `true`, relying on the in-run corroboration check (`denial.binding === probe.binding`) inside `containmentCoverage`.

`muse`, `codex`, and `antigravity` are byte-identical in `src/agentLifecycle.ts` and `src/issueReport.ts`; `claude` is functionally identical and adds two concise explanatory comments in `src/issueReport.ts` (lines 94 and 234).

### Test Coverage and Isolation (`test/agentLifecycle.test.ts` and `test/issueReport.test.ts`)

All four implementations stay within the four approved product/test files, reuse existing fixtures (`entry`, `digest`, `now`, `later`, `start`, `complete`, `initialAgentLifecycle`), create no new files or helpers, and test both `sessionId: "s"` and omitted-`sessionId` `session-end` events in `test/agentLifecycle.test.ts` plus post-`SessionEnd` completed vs. live reports in `test/issueReport.test.ts`.

One non-blocking test-isolation difference in `test/issueReport.test.ts`:

- **File path and line number**: `test/issueReport.test.ts:251-255` in `muse` (`8146353438a00ba7a5bd380db682d8ddba88776e`) and `test/issueReport.test.ts:253-257` in `antigravity` (`e94da6c745f4664780e16639d79a3d4ea7089f03`).
- **Rule that must hold**: When testing that an in-progress (`completed: false`) issue still downgrades its top-level cue to `[WARN]` due to live containment binding mismatch (`src/issueReport.ts:98`), `entry.health` must be `"healthy"` so `entry.health !== "healthy"` (`src/issueReport.ts:97`) does not short-circuit `uncertain` to `true` first.
- **Concrete failure that follows from breaking it**: Because `muse` and `antigravity` set `health: "degraded"` for the preceding completed-issue check and do not reset `health: "healthy"` before rendering `{ ...complete(), completed: false }`, `entry.health !== "healthy"` short-circuits `uncertain` to `true`. If `src/issueReport.ts:98` accidentally stopped checking `containmentCoverage(...).hook !== "active"` on live issues, `expect(live).toContain("[WARN] Issue 1:")` would still pass because of `health: "degraded"` (though the per-agent `expect(live).toContain("containment hook=unverified")` assertion at line 255/257 still catches line 233).
- **Smallest illustrative test / fix**: `claude` (`test/issueReport.test.ts:252`: `lifecycle.agents.cursor = { ...lifecycle.agents.cursor!, health: "healthy" };`) and `codex` (`test/issueReport.test.ts:135`: `ended.health = "healthy";`) restore `health: "healthy"` before the `completed: false` assertion, cleanly isolating the `containmentCoverage` branch in `uncertain`.

### Ranking

1. **`claude` (`d754062d6cb5625d85192bb08f4ebc15ee30fc1d`)**: Cleanest overall implementation; faithfully implements its selected plan, includes concise intent comments at both `src/issueReport.ts` sites, and resets `health: "healthy"` via immutable spread before the live-issue regression check in `test/issueReport.test.ts`.
2. **`codex` (`1a454ab38abbf96baa19960dfd8938d0530165e8`)**: Identical production logic and also resets `ended.health = "healthy"` before the live-issue check in `test/issueReport.test.ts` (mutating `ended` in place).
3. **`antigravity` (`e94da6c745f4664780e16639d79a3d4ea7089f03`)** and **`muse` (`8146353438a00ba7a5bd380db682d8ddba88776e`)**: Identical production logic and passing tests, with the minor `health: "degraded"` carry-over in the `completed: false` assertion noted above.
