# Issue 120: Coordinator cleans agent worktrees after issue completion

## Exact File List to be changed or deleted

- `src/prepareAgentBranch.ts` — export a shared `readyAgentClonesAfterIssue` (name may be `makeAgentClonesBaseReady`) that implements the discard-only readiness sequence; reuse the existing private `restoreProtocol` / `issueBranchFor` helpers rather than duplicating them; keep `prepareAgentIssueBranches` dirty refusal for live start/resume unchanged
- `src/cli.ts` — after a completed `coord N` / `coord run` (same call site as today's `detachCompletedIssue`), invoke the shared readiness helper for every configured agent clone before or immediately after UI detach; log discarded vs skipped vs refused; do not fail the CLI exit code solely because one clone refused cleanup
- `src/wipeIssue.ts` — at the dirty gate, when every dirty clone is on exactly `issue-<N>/<agent>` for this wipe's issue, run the shared discard/checkout path (or equivalent lift → reset/clean → base checkout) so the common leftover-WIP case does not require `--force`; keep today's all-or-nothing refuse when dirt is on another branch / another issue / ambiguous; still never commit or push
- `docs/coord-driver.md` — document post-completion clone readiness (lift → conditional reset/clean → checkout base → restore overlay) and the wipe-issue safe-discard exception; state explicitly that bare `git reset --hard` / `git clean` / checkout without lifting `AGENTS.md` is insufficient
- `docs/repo-map.md` — note that `prepareAgentBranch.ts` also owns end-of-session base-ready cleanup (not only start/resume checkout)
- `test/prepareAgentBranch.test.ts` — extend with focused fixtures for the new helper (or add a sibling test file if the suite grows too large; prefer extending this file)
- `test/wipeIssue.test.ts` — cover dirty-on-matching-issue-branch without `--force` succeeds; dirty-on-wrong-branch still refuses with nothing changed

## Exact file list to be created

- `.plans/issue-120/plan.md` — this plan (published as R2 evidence)

No new source module: the issue asks to extend `prepareAgentBranch` / wipe helpers rather than add a subsystem. No `package.json` version bump (post-merge CI owns `0.0.N`).

## Tests

Commands (real, as declared in this repository):

- `pnpm check:fast` — `pnpm lint && pnpm typecheck && pnpm test:fast` (`verify.precommit`); run before each commit
- Coordinator acceptance still uses full `pnpm check` (`pnpm build && pnpm check:fast && pnpm test:e2e`) on the approved commit

Focused unit cases for `readyAgentClonesAfterIssue` (scratch repos with skip-worktree `AGENTS.md` overlay, matching `test/prepareAgentBranch.test.ts` fixtures):

1. **Dirty completed-issue branch → cleaned:** clone on `issue-N/<agent>` with tracked edits and untracked `.plans/` / `.signals/` paths; after the helper, worktree clean, `HEAD` is `baseBranch` at `origin/<base>`, protocol overlay + skip-worktree restored; no new commits in `git log`
2. **Clean clone → checkout base only:** already clean on the issue branch; helper checks out base without `reset`/`clean` side effects beyond the checkout; overlay restored
3. **Wrong-branch dirty → refuse:** dirty while on `main`, another issue's branch, or a non-matching branch; helper throws or returns a refused outcome **after a preflight that mutates nothing** (same "Nothing has been changed" posture as today's dirty gate); overlay/bit left as found
4. **Missing clone → skip:** absent path or non-worktree → `skipped-missing`, no throw
5. **Overlay blocks bare checkout:** reproduce the operator failure mode (skip-worktree overlay makes status look clean / checkout refuse on `AGENTS.md`); assert the helper's lift-first sequence succeeds where a bare `checkout` would fail

Wipe-issue cases:

6. Dirty only on matching `issue-N/<agent>` without `--force` → wipe proceeds (clones end on base)
7. Dirty on a non-matching branch without `--force` → still refuses; trees unchanged

## Alternatives Rejected

- **Ask agents to stash/reset before `COORD-IDLE`** — the protocol already does not require it, and agents are unreliable at housekeeping; this issue exists because that approach failed in practice
- **Coordinator invents WIP commits or stashes on the agent's behalf** — forbidden by the issue non-goals; discard-only Git ops only
- **Always `wipe-issue --force` semantics on completion** — wipe deletes origin `issue-N/*` refs and runtime; completion readiness must only make clones base-ready, not perform a full wipe
- **New standalone cleanup subsystem / CLI command** — issue design constraint is small code size via shared helper called from existing completion tear-down and optionally wipe
- **Document bare reset/clean/checkout for owners** — operator clarification: without `liftCloneAgentsProtocol`, checkout of `main` still fails on overlay `AGENTS.md`; any owner-facing text must describe the lift/restore path
- **Silent discard on live `coord N` resume / start** — keep `prepareAgentIssueBranches` refusal so in-progress work on the active issue is not destroyed

## Risks and Mitigations

- **Discarding the wrong worktree** — preflight requires finished issue `N` from runtime/CLI context and `HEAD === issue-N/<agent>` (via the configured branch template) before any reset/clean; otherwise refuse with remediation and change nothing
- **Partial batch mutation** — run an all-clones safety preflight before the first lift/reset; if any clone has ambiguous dirt, abort the whole readiness pass with nothing changed (mirrors wipe/start dirty gates)
- **Leaving skip-worktree clear after failure** — wrap per-clone Git ops in `try`/`finally` that always calls the existing `restoreProtocol` path (same invariant as `prepareAgentIssueBranches`)
- **Completion CLI failing after a successful run** — log refused cleanups loudly from `detachCompletedIssue`'s caller path; do not turn a finished workflow into a non-zero exit solely due to an ambiguous dirty clone
- **`wipe-issue` safe-discard too broad** — only auto-discard when dirt is confined to matching issue agent branches; any other dirty state still demands `--force` or manual remediation
- **Product / owner worktree** — helper iterates configured agent clones only; never touches `coordination.productRoot`

## Conclusion

Add one shared discard-only “make agent clone base-ready” helper next to branch preparation: lift the `AGENTS.md` protocol, conditionally `git reset --hard` + `git clean -fd` only on this issue’s `issue-N/<agent>` branch, check out `origin/<baseBranch>`, then restore the overlay and skip-worktree bit. Call it from the completed `coord N` / `coord run` tear-down path so the next issue can start without manual resets, and reuse the same safe discard at the start of `wipe-issue` so leftover WIP on the wiped issue no longer forces `--force`. Live start/resume dirty refusal stays intact.
