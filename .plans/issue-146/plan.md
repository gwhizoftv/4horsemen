# Issue 146: rejoin after holds without fighting in-progress agent work

## Exact File List to be changed or deleted

- `src/prepareAgentBranch.ts` — in `prepareAgentIssueBranches`, treat dirty working trees as blocking only when HEAD is not already the target `issue-N/<agent>` branch; already-on-branch clones with WIP keep proceeding through protocol restore / readiness (no checkout). Off-branch dirt (including dirty `main` on first start) still refuses with the existing error and mutates nothing.
- `src/cli.ts` — (1) resolve `--hold latest` to the unique active hold (error with IDs if zero or many); (2) after `coord resume` leaves the issue fully unpaused (`paused === false`), continue into `makeRunLoop(paths).run()` in the same invocation so owners do not need a second `coord N` / `coord run`.
- `src/issueReport.ts` — recovery lines mention `coord resume --issue N --hold latest` (and keep the concrete hold id) so status/pause reports teach the short form.
- `src/runLoop.ts` — same recovery-log wording next to the existing `coord resume --issue … --hold <id>` lines in `hold` / `ingestFailure`.
- `docs/coord-driver.md` — document dirty-on-issue-branch rejoin, `--hold latest`, and resume-then-run in one command; keep the rule that plain `coord resume` still clears only the manual pause.
- `test/prepareAgentBranch.test.ts` — dirty already on `issue-N/<agent>` succeeds; dirty off-branch still refuses (existing case stays).
- `test/cli.test.ts` — `--hold latest` release; resume that clears the last pause enters the run loop; ambiguous/zero-hold `latest` fails; plain resume without `--hold` still does not release holds.
- `README.md` — short recovery snippet aligned with the driver doc (hold latest + single command).

## Exact file list to be created

- `.plans/issue-146/plan.md` — this plan (coordinator artifact).

## Reuse and Scope

Reuse `prepareAgentIssueBranches`, `blockingDirtyPaths`, `issueBranchFor`, `restoreProtocol` / `assertClonesReady`, `releaseHold`, `setPaused`, `mutateCursorsState`, `makeRunLoop` / `CoordinatorRunLoop.run`, `renderIssueReport`, and the existing prepare/CLI fixtures in `test/prepareAgentBranch.test.ts` and `test/cli.test.ts` (`fakeLoop`, `runCli`, hold fixtures).

No new modules or dependencies. The dirty gate change is a preflight filter inside the existing function: compare each clone's HEAD to `issueBranchFor(...)` before counting it in the refuse list; do not add a separate resume-mode flag or second prepare entry point. Hold resolution stays in the resume CLI path (small local helper or inline), not a new public API surface beyond accepting the literal selector `latest`.

Completion / wipe / `makeAgentClonesBaseReady` / `AgentCloneReadinessRefusal` paths stay unchanged — those still refuse ambiguous dirt when leaving or wiping an issue. This issue only unblocks rejoin while agents are mid-plan/implement on the correct issue branches.

Out of scope: auto-releasing holds without owner action; converting every `initializeEffects` / `runTick` throw into a durable hold; changing `coord-open-unmerged` PR policy; automatic vendor recovery (#140).

## Tests

- `pnpm check:fast` (lint, typecheck, fast tests) before commit; coordinator acceptance uses full `pnpm check`.
- Extend `test/prepareAgentBranch.test.ts`:
  - Clone already on `issue-9/claude` with an uncommitted work file → `prepareAgentIssueBranches` returns `already-on-branch`, keeps the file, restores overlay/skip-worktree.
  - Keep / tighten: dirty clone on `main` still throws `Refusing to check out issue branches: uncommitted changes…` and does not move HEAD.
  - Optional mixed case in the same file: one agent dirty on-branch + one dirty off-branch → still refuse (off-branch dirt remains blocking) and mutate nothing.
- Extend `test/cli.test.ts`:
  - Single active hold → `coord resume --issue N --hold latest` releases it (and with `--reset-nudge-budget` when reason is `nudge-loop`).
  - Zero or multiple holds → `--hold latest` exits non-zero with a clear message listing hold ids.
  - After a release that leaves `paused === false`, the resume path invokes `run()` (inject `makeRunLoop` / `fakeLoop` and assert it was called); when holds remain, do not start the run loop.
  - Plain `coord resume --issue N` without `--hold` still clears only `manualPaused` and never releases holds (preserve #126).

## Alternatives Rejected

- Keep refusing any dirty clone on resume — that is the bug in the issue report; plan/implement WIP on `issue-N/<agent>` is expected and must not block rejoin.
- Force owners to stash/commit peer WIP before every `coord N` — fights the workflow the coordinator itself asked agents to perform.
- Auto-clear holds when agents look healthy again — rejected in #126; owner inspection remains required; this issue only shortens the recovery command and removes the false dirty gate.
- New flag `--allow-dirty` / resume-only prepare mode — easy to omit and splits start vs resume semantics; HEAD-vs-target-branch is the precise condition both paths need.
- Merge hold release into bare `coord N` without an explicit resume — would silently clear owner-required holds; keep scoped release, add `latest` + continue-into-run instead.
- Convert all prepare/tmux failures into holds — broader than the reported failure mode; dirty-on-branch fix removes the common crash; other prepare failures should stay loud.

## Risks and Mitigations

- Allowing dirty on-branch clones means prepare no longer forces a clean tree before harness ensure — mitigation: readiness still asserts HEAD, overlay, and skip-worktree; no checkout/reset of existing issue-branch commits (already true).
- Off-branch dirt could be mistaken for “resume WIP” — mitigation: only exempt when HEAD equals the computed issue branch for this issue+agent; wrong-branch dirt still refuses before any mutation.
- Resume auto-running the loop may surprise owners who only wanted to clear state — mitigation: continue only when fully unpaused; if other holds or manual pause remain, keep today’s state-only behavior; docs state the new continue rule.
- `--hold latest` with multiple holds could pick the wrong one — mitigation: require exactly one active hold for `latest`; otherwise fail and list ids (owners fall back to the concrete UUID from status).
- CLI tests that assumed resume never calls `run` need updates — expected; inject `makeRunLoop` the same way start tests already do.

## Conclusion

After a hold, owners can `coord resume --issue N --hold latest` (or the concrete id) and, when that clears the last pause, the coordinator continues the run in the same command. Rejoin no longer dies on uncommitted plan/implement files in agent clones that are already on the correct `issue-N/<agent>` branches, while dirty off-branch clones and completion/wipe readiness refusals stay fail-closed.
