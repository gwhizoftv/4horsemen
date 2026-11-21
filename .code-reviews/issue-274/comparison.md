## Comparison

Compared the three bound implementation pins against the selected plan (`8d35e7358c6950d37273bc0ff44c1d78db76fae9`) and issue #274 by inspecting their bound worktrees directly:

- **antigravity**: `76c894beac6c031d3b19ba299f38031df6323de9`
- **claude**: `c8e84f7dec019326ec15a8bc78e1e06cbe9b5e92`
- **codex**: `ff24cca4b8e2c496c0f7633004b264509b5d015d`

### Findings

1. **Claude (`c8e84f7dec019326ec15a8bc78e1e06cbe9b5e92`) — `src/cli.ts:557` and `src/cli.ts:1403-1406` (`assertResumeSelection` reads `readStartStateHeader` instead of `readStartState`)**
   - **Rule:** On numeric continuation with `--agents`, unsupported legacy format 2/3 runtimes must fail closed with the runtime-format wipe error before `assertNoManualSession` can prompt to close a live manual session or mislead the operator into running `coord <issue>`.
   - **Concrete failure:** Because `readStartStateHeader` accepts format 2 and 3 (`src/state.ts:491`), running `coord 1 --agents cursor,claude` against a legacy format-2 runtime passes `assertResumeSelection` and reaches `assertNoManualSession` (prompting to close the manual session and reset clones before `runIssue` fails on format 2); running `coord 1 --agents cursor` on that same legacy runtime tells the owner `Run \`coord 1\` to continue it.` instead of instructing `coord wipe-issue 1`. Both `codex` (`src/cli.ts:1372`) and `antigravity` (`src/cli.ts:1390`) call `readStartState(existing)`, which rejects format 2/3 immediately before `assertNoManualSession`.
   - **Illustrative test:** Seed a format-2 `start.json` with `originalRoster: ["cursor", "claude"]`, pass `sessionExists: async () => true` and a `confirm` spy, and assert `runCli(["1", "--agents", "cursor,claude", ...])` exits `2` with `/Runtime format versions 2 and 3 are no longer supported/` and `confirm` not called.

2. **Claude (`c8e84f7dec019326ec15a8bc78e1e06cbe9b5e92`) — `test/cli.test.ts:279-309` (missing drop and manual-session assertions on continuation)**
   - **Rule:** Continuation tests for `--agents` must verify that replaying the original list still works after `coord drop` (without reintroducing the dropped agent) and that mismatched continuation fails before `assertNoManualSession` can prompt/clean up a manual session.
   - **Concrete failure:** A regression that compared `--agents` against `cursors.activeRoster` instead of `start.originalRoster`, or that moved `assertNoManualSession` ahead of `assertResumeSelection`, would still pass Claude's continuation test at `test/cli.test.ts:279-309`. Both `codex` (`test/cli.test.ts:403, 414-426`) and `antigravity` (`test/cli.test.ts:2530, 2553-2569`) cover both invariants.
   - **Illustrative test:** After starting issue 1 with `--agents cursor,claude`, run `coord drop claude --issue 1`, verify `coord 1 --agents cursor,claude` exits `0` with `activeRoster` still `["cursor"]`, and pass `sessionExists: async () => true` with a `confirm` spy when testing mismatched `--agents cursor` to assert `confirm` is never called.

3. **Codex (`ff24cca4b8e2c496c0f7633004b264509b5d015d`) — `src/cli.ts:524` (non-blocking diagnostic omission)**
   - **Rule:** When an unknown agent ID is rejected, naming the configured agent IDs (or config path) makes the error immediately actionable without opening `config.json`.
   - **Concrete failure:** `Agent '${id}' is not configured for this workspace.` reports the bad ID accurately (satisfying issue #274) but omits the available configured IDs, whereas `claude` (`src/cli.ts:537-538`) and `antigravity` (`src/cli.ts:535-536`) include both `configPath` and the configured ID list.
   - **Illustrative test:** Assert `stderr` on `--agents cursor,missing` includes both `'missing'` and the configured IDs (`codex, claude, cursor`).

4. **Codex (`ff24cca4b8e2c496c0f7633004b264509b5d015d`) — `src/cli.ts:1368-1371` (minor check ordering on foreign workspace runtime)**
   - **Rule:** Syntax/config validation of `--agents` should run before workspace-ownership lookup on `existingIssueRuntime` so an obviously invalid `--agents` argument reports the argument error consistently.
   - **Concrete failure:** If `issue-1` exists under the runtime directory for a different workspace config, `coord 1 --agents typo` throws `belongs to a different workspace` instead of rejecting `'typo'`. Both `claude` (`src/cli.ts:1400-1402`) and `antigravity` (`src/cli.ts:1384-1387`) validate `--agents` before `existingIssueRuntime`. (Non-blocking; both fail closed with exit `2` before any side effect.)

### Scope, Reuse, Conciseness, and Test Focus

| Dimension | Antigravity (`76c894be`) | Claude (`c8e84f7d`) | Codex (`ff24cca4`) |
| --- | --- | --- | --- |
| Stays within approved 3 files (`src/cli.ts`, `test/cli.test.ts`, `docs/coord-driver.md`) | Yes | Yes | Yes |
| No new files, schemas, or unrelated refactors | Yes | Yes | Yes |
| `src/cli.ts` diff size & simplicity | Clean (`+63/-11`); keeps `assertNoManualSession` at both callers | Clean (`+61/-6`); keeps `assertNoManualSession` at both callers | Most minimal (`+31/-4`); folds fresh-start `assertNoManualSession` into `startIssue` right after roster validation |
| All validation (unknown, duplicate, empty, multi-agent solo, resume mismatch) runs before `assertNoManualSession` | Yes | Yes (except legacy format 2/3 via `readStartStateHeader`) | Yes |
| Preserves full `agents` for containment & orphan cleanup while narrowing `roster` | Yes | Yes | Yes |
| Continuation survives `coord drop` + default-profile change | Yes (and tested) | Yes (drop untested) | Yes (and tested) |
| Test focus & reuse in `test/cli.test.ts` | Standalone `describe` block (+148 lines); tests every invalid case on both `1` and `start 1`, plus drop + profile-change + live manual session | Standalone `describe` block (+88 lines); tests invalid cases on both entry points, misses drop and mismatch manual-session assertions | Most focused (+62 lines); reuses and extends the existing continuation test in place, tests drop + profile change + `sessionExists` non-call; splits invalid cases across `1` and `start 1` |
| `docs/coord-driver.md` | Clear and complete; adds example into the initial daily-command snippet | Very clear standalone block with all rules | Very concise and clear, directly follows the selected plan |

### Summary Ranking

1. **Codex (`ff24cca4b8e2c496c0f7633004b264509b5d015d`)** — Minimal, cleanest change in `src/cli.ts` (folding fresh-start `assertNoManualSession` into `startIssue` after validation avoids duplicating fresh-start guard wiring), extends the existing continuation test in place with full drop/profile-change/no-session-cleanup coverage, and has no functional defects. Adding configured agent IDs to the unknown-agent error message is a trivial optional polish.
2. **Antigravity (`76c894beac6c031d3b19ba299f38031df6323de9`)** — Functionally complete with no bugs, more informative unknown-agent diagnostics (`configPath` + configured IDs), and symmetric coverage of both `1` and `start 1` for every invalid case, at the cost of a slightly larger diff in `src/cli.ts` and `test/cli.test.ts`.
3. **Claude (`c8e84f7dec019326ec15a8bc78e1e06cbe9b5e92`)** — Well-structured with clear diagnostics and docs, but uses `readStartStateHeader` on continuation (allowing legacy format 2/3 runtimes to reach `assertNoManualSession` or emit a misleading `Run coord <n>` message) and omits `coord drop` and mismatch-no-cleanup assertions from its continuation test.

No tests were executed for this comparison; findings are drawn from direct inspection of the three bound worktrees.
