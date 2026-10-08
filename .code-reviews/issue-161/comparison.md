# Issue 161 implementation comparison

Bound implementation pins:

- cursor `d76041e1beff91c677615f55c965db94dd1b1698`
- codex `46586e29f238f3b8d8de25b9e301a2e1648ed627`
- claude `25af4ef94486d3f8e9f123583b82f5464886a98e`
- antigravity `87a50cc979b861f3589123a0942d647a18845333`

Selected plan (Codex) requires a same-action owner reminder for interactive `n` that may request positive idle proof for stale `working` even when `sends > 0`, without resetting budget/holds or restarting the action.

## Comparison

### Approaches

| Pin | `n` mechanism | Status / recovery | Scope |
| --- | --- | --- | --- |
| **codex** `46586e29` | Queued same-action reminder drained as `deliver(..., "owner")` with owner bypass of the stale-working gate and idle-sentinel override (`runLoop.ts` ~1173–1186) | ASCII `[OK]`/`[WAIT]`/`[WARN]`/`[ACTION]`, leading+trailing `----`, Implementation/Final **commit**, quoted `--coord-root` recovery | Full planned map including doctor/tmux/verification/workspace tests (19 product/test/doc files) |
| **cursor** `d76041e1` | `queueOwnerReminder` → `deliver(..., "owner-reminder")`; `ownerReminderWorking` allows idle override when working even if `sends > 0` (`runLoop.ts` 1199–1221) | Same ASCII/`----`/commit wording; quoted recovery | Same core `src/` + docs as Codex; only four test files updated (missing lifecycle/doctor/tmux/verification/workspace suites) |
| **claude** `25af4ef9` | Same-action owner reminder with stale override, but `reopenActionForReminder` resets delivery to `ordered` and clears `acceptedAt`/`injectedAt` on reserve (`agentLifecycle.ts` 514–529; `runLoop.ts` 1336) | ASCII severity and `----`; quoted recovery | Full test map like Codex |
| **antigravity** `87a50cc9` | Clears deferrals then `maybeLifecycleNudge(..., "idle")` with **no** owner stale-working override (`runLoop.ts` 1017–1019, 1170–1174) | Unicode `✓`/`⚠`, still says “pin”, closing `----` only; immediate hold log omits `--coord-root` (`runLoop.ts` 1070–1071) | Narrowest (no `tmux.ts`); thinnest tests |

None of the four pins wires interactive `n` to `restart-action` / `restartOwnerAction`. Confirmed nudge-loop `r` with `resetBudget: true` is present on all four interactive paths. Cwd defaulting for `--coord-root`/`--product` is present on all four.

**Best plan fidelity for the stuck-agent `n` case:** codex `46586e29`, with cursor `d76041e1` a close second on the idle-override rule. Claude is strong UX but regresses acknowledgment. Antigravity fails the motivating stale-working case.

### Findings

1. **antigravity `87a50cc9` — `src/runLoop.ts:1170–1174` and `:1019`.** Rule: an owner reminder may request idle override for stale `working` on the same action even after prior sends; automatic override remains never-sent-only. Failure: after a draft with `sends > 0` and lifecycle still `working`, `requestReminder` → `maybeLifecycleNudge(..., "idle")` hits the working gate and returns without typing — interactive `n` is inert for the issue’s stuck case. Illustrative test: fixture with `execution: "working"`, `sends: 1`, COORD-IDLE pane; assert owner deliver path sends once (as codex/cursor).

2. **antigravity `87a50cc9` — `src/issueReport.ts:75–96` and `:230`.** Rule: status must use ASCII severity labels, an exact `----` before and after the snapshot, and “Implementation commit” / “Final commit (PR head)” without unexplained “pin.” Failure: redirected logs show `✓`/`⚠`; only a closing `----` appears; lines still say `Implementation commit (pin)` and `Final pin (PR head)`. Illustrative test: assert framed ASCII labels as in codex `test/issueReport.test.ts`.

3. **antigravity `87a50cc9` — `src/runLoop.ts:1070–1071`.** Rule: every printed recovery command includes quoted `--coord-root` when the runtime root is known. Failure: `holdRecoveryCommand(this.paths.issue, next, hold)` omits the root while status-path recovery includes it, so owners copying the hold log from a non-onboarded cwd still hit missing-root errors. Illustrative test: assert the hold-creation log contains `--coord-root` with a spaced path.

4. **claude `25af4ef9` — `src/agentLifecycle.ts:514–529` via `src/runLoop.ts:1336`.** Rule: a reminder reuses delivery guards and must not erase validated delivery state or manufacture a reissue. Failure: after `delivery === "accepted"`, reserving an owner send calls `reopenActionForReminder`, resetting to `ordered` and clearing `acceptedAt`/`injectedAt`; a failed mid-send leaves acknowledgment lost and status regresses. Prefer a test: accepted action + owner reminder that fails mid-send; assert delivery remains accepted (codex/cursor behavior).

5. **cursor `d76041e1` — changed-path / Tests gap.** Rule: the selected plan’s regression groups for Stop observation, startup wiring, tmux env diagnostics, verification progress, and cwd locator resolution must join the named existing suites. Failure: the pin updates only `test/cli.test.ts`, `test/interactive.test.ts`, `test/issueReport.test.ts`, and `test/runLoop.test.ts`, so `agentLifecycle` / `doctor` / `tmux` / `verificationRunner` / `workspace` behaviors lack the plan’s focused coverage even though the corresponding `src/` files changed. Smallest correction: extend those five test files as codex `46586e29` did (or amend if intentionally deferred).

### Scope and reuse

All pins reuse `startInteractiveSession`, `setOwnerPause`/`releaseHold`, `renderIssueReport`, and existing delivery/`IdleOverride` machinery rather than inventing a force-complete control. Codex and Claude match the plan’s file breadth most closely; cursor is slightly under-tested relative to that map; antigravity is too narrow on `n` and diagnostics despite the smallest diff.

No product suite was run for this comparison artifact; evidence is bound-worktree inspection of the cited pins.
