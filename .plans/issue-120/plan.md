# Issue 120: coordinator cleans agent worktrees after issue completion (reset/clean, never commit)

One shared "make this clone base-ready" function in `src/prepareAgentBranch.ts`,
called from the completion tear-down in `src/cli.ts` and (for the common
leftover-WIP case) from the dirty gate in `src/wipeIssue.ts`. Discard-only Git:
`reset --hard` + `clean -fd` + `checkout -B <base> origin/<base>`. No `commit`,
no `add`, no `push`, no ref deletes.

## Exact File List to be changed or deleted

- `src/prepareAgentBranch.ts` — add exported `makeAgentClonesBaseReady(input)` and
  its result type `CloneBaseReadyResult`. Reuses the module's existing
  `issueBranchFor`, `blockingDirtyPaths` (so an overlay-only `AGENTS.md` diff is
  not read as agent WIP), and `restoreProtocol` (overlay + skip-worktree bit).
  Per clone, in order:
  1. missing path or `!isGitWorktree` → `action: "skipped-missing"`, nothing run;
  2. `head = git rev-parse --abbrev-ref HEAD`, `dirty = blockingDirtyPaths(root)`;
  3. `dirty.length > 0 && head !== issueBranchFor(template, issue, agent)` →
     `action: "refused"` with `reason`, **nothing executed in that clone**;
  4. otherwise `captureCloneAgentsProtocol` → `liftCloneAgentsProtocol`, then in a
     `try`: when `dirty.length > 0` (HEAD is this issue's branch)
     `git reset --hard HEAD` and `git clean -fd`, recording the porcelain paths in
     `discardedPaths`; then `git fetch --quiet origin <base>` (best effort) and
     `git checkout -B <base> origin/<base>`, falling back to local `<base>` and,
     if neither resolves, `action: "refused"` with the resolution failure as
     `reason`;
  5. `finally` → `restoreProtocol(root, installRoot, captured, log)`, so the bit
     and overlay are re-asserted even when the checkout throws.
  Result fields: `{ agent, clone, branch, action: "checked-out" | "already-base" |
  "refused" | "skipped-missing", discardedPaths, protocol, reason? }`; `action`
  is `"already-base"` only when `head === base` before step 4. Every branch logs
  one line naming what was discarded, skipped, or refused. `prepareAgentIssueBranches`
  and its dirty refusal are not modified, so live `coord N` resumes still refuse.
- `src/cli.ts` — `detachCompletedIssue` (currently only `detachIssue`) also calls
  `makeAgentClonesBaseReady` **after** the UI tear-down, so agent CLIs are dead
  before their worktrees are touched. Inputs come from `readStartState(paths)`
  (`issue`, `agents` — roots are already absolute there, `branchTemplate`,
  `baseBranch`), `installRoot` from `readConfig(start.configPath).coordination
  ?.installRoot` inside a `try`/`catch` that falls back to `null` (same posture as
  `CoordinatorRunLoop.initializeEffects`). Adds one summary line after the existing
  "Issue N complete: killed …" line: cleaned / already-base / refused / skipped
  counts, and the refusal `reason` for each refused clone. Cleanup runs only under
  the existing `if (!cursors.completed) return` guard, which is the terminal-session
  gate required by the safety rules; both `coord <issue>` and `coord run` reach it.
- `src/wipeIssue.ts` — before the `dirty`/`force` refusal, when `!force`, call
  `makeAgentClonesBaseReady` for exactly those clones that are dirty **and** whose
  `HEAD` is `issue-<N>/<agent>` for the issue being wiped, then recompute
  `dirty` with `cloneIsDirty`. Clones still dirty (dirt on another branch, another
  issue's branch, detached HEAD) keep today's refusal text verbatim. `dryRun` skips
  the cleanup entirely. The existing reset loop below is unchanged: it re-lifts the
  overlay, deletes local `issue-N/*` refs, and re-checks out base, which is a no-op
  on an already-clean clone.
- `docs/coord-driver.md` — correct "The coordinator never writes agent clones."
  (Authority and safety model) to state the actual rule: the coordinator mutates
  clones for readiness only — checkout, reset, clean, protocol overlay — and never
  authors, stages, or pushes agent commits. Add an "end-of-issue clone readiness"
  paragraph to Owner controls describing the completion cleanup, its safety
  conditions, and the refusal remediation.
- `test/prepareAgentBranch.test.ts` — add a `describe("makeAgentClonesBaseReady")`
  block (cases listed under Tests).
- `test/cli.test.ts` — extend "detaches tmux/Terminal UI after a completed coord N
  run" to assert the readiness summary line is printed. That fixture's agent roots
  are plain directories, so the assertion is `skipped` counts, proving the wiring
  without a git fixture.
- `test/wipeIssue.test.ts` — add the two wipe cases listed under Tests.

No files are deleted.

## Exact file list to be created

None. The design constraint is small code size and one shared helper, and every
piece has an owning module already: the Git/protocol helper belongs beside
`prepareAgentIssueBranches` in `src/prepareAgentBranch.ts` (it reuses that file's
private `restoreProtocol` and `blockingDirtyPaths`, which a new module could not
import), the two call sites are existing functions, and both test targets already
have suites. Adding `src/cloneReadiness.ts` would force `restoreProtocol` and
`blockingDirtyPaths` to become exported API for one caller.

## Tests

Command: `pnpm check:fast` (lint, typecheck, `vitest run` fast suite) — this
repo's `verify.precommit`. `pnpm check` (build + `check:fast` + e2e) is the
coordinator's stricter list on the approved commit.

`test/prepareAgentBranch.test.ts`, on the real-git `seedClone()` fixture (bare
origin + clone + rendered overlay), covering the four acceptance cases:

- **dirty completed-issue branch → cleaned**: on `issue-9/claude`, modify a
  tracked file and create untracked `.plans/issue-9/plan.md` and
  `.signals/issue-9/x.json`; expect `action: "checked-out"`, `discardedPaths`
  naming both, `git status --porcelain` empty, HEAD on `main` at `origin/main`,
  the tracked file back to its committed bytes, both untracked dirs gone, and —
  for "no coordinator-created commits" — `git rev-list --count issue-9/claude`
  and `git log -1 --format=%H issue-9/claude` unchanged from before the call.
- **clean clone → checkout base only**: same fixture with a clean tree on
  `issue-9/claude`; expect `discardedPaths: []`, `action: "checked-out"`, HEAD on
  `main`, and the issue branch ref still present at its old tip.
- **wrong-branch dirty → refuse**: dirty while HEAD is `main` (and a second case,
  dirty on `issue-8/claude` while wiping/finishing issue 9); expect
  `action: "refused"`, `reason` naming the branch and the manual/`--force`
  remediation, HEAD unchanged, and `git status --porcelain` byte-identical to
  before the call.
- **missing clone → skip**: a path that does not exist and a path that exists but
  is not a worktree; expect `action: "skipped-missing"` and no git invocation
  effects.
- **protocol restored**: after a cleaned run, `AGENTS.md` contains the overlay and
  `git ls-files -v -- AGENTS.md` starts with `S`; and with a throwing base
  (`origin/<base>` and local `<base>` both absent) the bit is still set on return.
- **overlay-only dirt is not WIP**: a clone whose only diff is the managed
  `AGENTS.md` block is treated as clean and checked out, not refused.

`test/wipeIssue.test.ts`:

- leftover uncommitted edits on `issue-N/<agent>` → `wipeIssue` without `--force`
  succeeds, the clone ends clean on base, and `resetClones` includes it;
- uncommitted edits on a non-issue branch → still throws the existing
  "Refusing wipe-issue … Nothing has been changed." message, and the clone's
  status is unchanged.

`test/cli.test.ts`: the completed-`coord N` run prints both the detach line and
the readiness summary.

## Alternatives Rejected

- **A new `src/cloneReadiness.ts` subsystem** — rejected by the issue's small-code
  constraint; it would export `restoreProtocol` and `blockingDirtyPaths` purely to
  re-import them, and split one policy ("what counts as agent WIP") across two files.
- **Cleaning inside `CoordinatorRunLoop.runTick` when `completed` flips** —
  `runTick` is re-entrant, retried on `StateConflictError`, and runs while agent
  panes are alive; discarding a worktree under a live CLI is exactly the race the
  safety rules forbid. `detachCompletedIssue` is the single tear-down both
  `coord <issue>` and `coord run` reach, after the panes are killed.
- **Stashing instead of discarding** (`git stash -u`) — the issue names discard-only
  operations; a stash is coordinator-authored state in the agent's repo and would
  accumulate silently across issues.
- **Deleting the local `issue-N/<agent>` branch during cleanup** — non-goal; this is
  worktree readiness, not a wipe. `wipe-issue` owns ref deletion.
- **`git clean -fdx`** — would delete ignored build output (`node_modules`, `dist`)
  and make the next run pay a full reinstall; `-fd` matches the issue.
- **Relaxing `prepareAgentIssueBranches`'s dirty refusal to auto-discard** — that
  path also serves live resumes of an in-progress issue, where discarding destroys
  work the agent has not published. The issue explicitly keeps that refusal.
- **Cleaning every configured agent regardless of branch** — violates the safety
  rules; only a clone whose HEAD is this finished issue's branch is eligible.

## Risks and Mitigations

- **Discarding work an agent had not pushed.** Eligibility is the conjunction the
  issue names: terminal completion (or an explicit wipe of the same issue), clone
  is a worktree, and HEAD is exactly `issue-<N>/<agent>` from `branchTemplate` for
  that `N`. Any other shape refuses and executes nothing. Covered by the
  wrong-branch and other-issue tests.
- **Cleanup racing a live agent CLI.** Called only after `detachIssue` has killed
  the tmux sessions and Terminal windows.
- **A failed checkout leaving the skip-worktree bit clear** — the exact state that
  dead-ends every later `coord start`. The restore runs in `finally`, and the
  base-resolution failure path returns `refused` with the bit re-asserted; tested.
- **`origin/<base>` unresolvable (offline, pruned remote).** `fetch` is best-effort;
  resolution falls back to local `<base>`; if neither exists the clone is left as
  found with a logged reason rather than detached at an arbitrary commit.
- **Cleanup failure masking a completed run.** The summary is informational: a
  refusal is logged and counted, and `coord <issue>` still returns 0 for the
  completed issue. Only an unexpected throw from git propagates, and each clone is
  handled independently so one bad clone does not skip the others.
- **Extra Git work per completed run.** One `status --porcelain` plus, only when
  eligible, `reset`/`clean`/`fetch`/`checkout` per agent. No journal replay, no
  mirror I/O.
- **Wipe behaviour drift.** The pre-clean in `wipeIssue` runs only when `!force`
  and only on issue-branch dirt; the refusal message, `--force` semantics, and
  `dryRun` output are unchanged, and the existing wipe tests pin that.
- **Version bump.** None planned: per `AGENTS.md` the `0.0.N` advance is checked
  only on the PR into `main`, not on issue-branch commits.

## Conclusion

Add one discard-only `makeAgentClonesBaseReady` helper next to
`prepareAgentIssueBranches`, call it from the completed-issue tear-down in
`detachCompletedIssue` and from the non-`--force` dirty gate in `wipeIssue`, and
gate every discard on "this clone is a worktree, on this finished issue's branch".
Completed runs then leave every participating clone clean, on the base branch at
`origin/<base>`, with the AGENTS.md overlay and skip-worktree bit restored, so the
next `coord M` starts without an owner-run reset — and no coordinator-authored
commit ever appears in an agent's history.
