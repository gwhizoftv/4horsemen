# Issue 120 plan review

Bound plans reviewed:

- cursor `d049e7b79662a59e717ff97c7fbc8d0274f3bc22`
- claude `6cf79d06be8623a8b264dd4345572e341a990bf0`
- codex `bd3231172e002b5e74823fbfc68fe17ea090fc60`

## Findings

1. **Cursor plan — Exact File List / Risks (`cli.ts` order: “before or immediately after UI detach”).** Discard must not race a live agent CLI still writing the worktree; completion tear-down already kills panes only inside `detachIssue`. If cleanup runs before detach while the agent is mid-edit, reset/clean can tear files out from under the process and the next `coord M` still sees a wrecked clone. Require cleanup **after** `detachIssue` returns (Claude’s order), not as an either/or.

2. **Cursor plan — Exact File List / Risks (batch refuse on “ambiguous dirt” without naming `blockingDirtyPaths`).** Start/resume already treat managed-overlay-only `AGENTS.md` deltas as non-blocking (`blockingDirtyPaths` in `prepareAgentBranch.ts`); completion readiness must use the same rule. If porcelain dirt including overlay-only `AGENTS.md` on any non-issue branch aborts the whole batch, one skip-worktree restore failure blocks discard of real leftover WIP on every matching `issue-N/<agent>` clone — the post-#110 failure mode this issue exists to fix. Classify dirt with `blockingDirtyPaths` (or equivalent), as Claude and Codex already specify.

3. **Claude plan — Exact File List (`wipeIssue.ts` pre-clean then recompute `dirty`).** The wipe dirty gate’s contract is all-or-nothing: on refuse, print remediation and leave trees unchanged (“Nothing has been changed”). Following the plan as written — run `makeAgentClonesBaseReady` on authorized dirty clones, then recompute `cloneIsDirty` and throw today’s refusal when another clone is still dirty on a wrong branch — mutates the authorized clones first, then claims nothing changed. Preflight every clone; if any dirt is unauthorized, refuse before the first lift/reset; only when every dirty clone is on this wipe’s `issue-N/<agent>` (or clean) run discard and continue wipe.

4. **Codex plan — Exact File List / Risks (`cli.ts`: cleanup before UI detach; safety refusal “returns a clear error”).** Completed `coord N` / `coord run` must still perform the documented automatic UI teardown and must not turn a finished workflow into a failed CLI exit solely because one clone has ambiguous dirt (issue acceptance: next issue can start in the common case; Cursor/Claude keep exit 0 and log refusals). If refusal throws/non-zeros and skips `detachIssue`, owners keep live panes after success and cannot rely on the existing completion path. Run cleanup after detach (or always detach even on readiness refuse), log refusals, and return 0 for a completed workflow unless Git itself throws unexpectedly.

5. **Codex plan — Exact File List / Alternatives Rejected (refuse local base that is ahead/diverged of `origin/<base>` on the normal path).** Acceptance requires each participating clone end clean on the configured base at `origin/<base>`; today’s `wipeIssue` already uses `checkout -B <base> origin/<base>` for that. Refusing diverged/ahead local base leaves the clone on the finished issue branch (often still dirty), so the next `coord M` still hits the dirty gate whenever an agent clone’s local `main` has unpushed commits — a common state. Bind checkout to fetched `origin/<base>` as wipe does; do not add a normal-path refuse that blocks base-ready on diverged local base history.

## Conclusion

Claude’s helper shape (shared `makeAgentClonesBaseReady` beside `prepareAgentIssueBranches`, `blockingDirtyPaths`, lift → conditional reset/clean → checkout base → `restoreProtocol` in `finally`, call from `detachCompletedIssue` after UI tear-down) is the strongest mechanical match to the issue. Do not ship Claude’s wipe pre-clean-then-re-refuse sequence, Cursor’s detach-order ambiguity or overlay-blind batch abort, or Codex’s fail-closed completion exit / diverged-base refuse. Consensus implementation: Claude’s helper + post-detach CLI wiring, with Cursor/Codex-style **all-clones preflight before any mutation** at both completion and wipe call sites, and wipe’s existing `checkout -B origin/<base>` base binding without an extra diverged-local-base gate on the normal path.
