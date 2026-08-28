# Issue 130: coord run completion must leave agent clones base-ready or fail loudly

## Exact File List to be changed or deleted

- `src/prepareAgentBranch.ts` — when local base has commits not in `origin/<base>`, reset agent-clone base to origin on completion/reset (not refuse); keep force-wipe behavior
- `src/setupWorkspace.ts` — `ensureAgentClone` clones from the origin URL, not the local product worktree
- `src/cli.ts` — fail non-zero when readiness refuses; print per-clone reasons + `coord reset-clones` remediation; add `coord reset-clones`; journal `clone-readiness-refused`
- `src/state.ts` — add journal event type `clone-readiness-refused`
- `src/doctor.ts` — when overlay + skip-worktree sit on an issue branch, remediate with `coord reset-clones` (not raw `git checkout`)
- `docs/coord-driver.md` — document fail-loud completion, reset-to-origin, and `coord reset-clones`
- `test/prepareAgentBranch.test.ts` — diverged local base resets to origin on completion path
- `test/cli.test.ts` — refused readiness exits non-zero; cover `reset-clones`
- `test/doctor.test.ts` — remediation names `coord reset-clones`
- `test/install.test.ts` — new clones come from origin tip, not divergent local product `main`

## Exact file list to be created

- `.plans/issue-130/plan.md` — this plan (owner-requested)

## Tests

- `pnpm check:fast` (lint, typecheck, fast tests)
- Unit: diverged local `main` → completion/`reset-clones` checks out `origin/main` and restores overlay/skip-worktree
- Unit: `detachCompletedIssue` / `coord N` / `coord run` exit non-zero on any `refused`, print clone+reason, append journal event
- Unit: `coord reset-clones N` makes clones base-ready without deleting `coord-runtime/issue-N`
- Unit: `ensureAgentClone` seeds from origin URL (product-local-only commits do not appear in the new clone)
- Unit: doctor finding on issue-branch + overlay points at `coord reset-clones`

## Alternatives Rejected

- Keep refusing when local `main` diverges — that is the bug; agent clones must not carry unpushed owner history, and refuse left clones stuck while exiting 0
- Require `wipe-issue` for recovery — wipe deletes analytics runtime; owners need reset without losing `coord-runtime/issue-N`
- Tell owners to clear skip-worktree / `git checkout main` by hand — Git fails on the overlay without naming skip-worktree; remediation must be `coord reset-clones`
- Clone from product then rewrite remote — still seeds bad local `main`; clone from origin URL directly

## Risks and Mitigations

- Resetting diverged local `main` on an agent clone discards unpushed commits there — intentional for agent clones; product worktree is untouched; wipe `--force` already did this
- Fail-loud changes exit code of completed runs that previously printed `refused N` and exited 0 — desired; update CLI tests that asserted exit 0 on refuse
- Offline fetch failure still falls back to local base — unchanged; only a successful origin tip replaces diverged local history
- Journal schema adds a new event type — analytics consumers treat unknown types as opaque details already; add to the enum so writers validate

## Conclusion

After successful completion, every agent clone is on `origin/<base>` with protocol restored, or the command exits non-zero with explicit per-clone remediation and a journal event. Owners recover stuck clones with `coord reset-clones` without wiping analytics, and new installs seed from origin so bad local `main` is not copied into every clone.
