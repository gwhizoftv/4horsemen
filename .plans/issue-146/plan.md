# Issue 146 — keep the coordinator alive across holds and make restart short

The issue reports three obstacles, all visible in its transcript:

1. **The runner exits on a hold.** `RunLoop.run()` (`src/runLoop.ts:2741-2765`)
   treats `paused && !resourceWorkPending` as finished. Every automatic owner
   hold (`unobservable`, `nudge-loop`, a vendor failure with an unknown reset)
   sets `paused`, so `coord 139` returns as soon as a hold appears.
2. **Resuming needs the hold UUID.** Plain `coord resume --issue N`
   (`src/cli.ts:1583-1603`) clears only the manual pause, so the owner has to
   copy a UUID into `--hold`.
3. **Restart refuses on normal work in progress.** `prepareAgentIssueBranches`
   (`src/prepareAgentBranch.ts:203-214`) refuses when *any* agent clone has
   uncommitted changes. It runs this check before it looks at which branch each
   clone is on. A clone already on its own `issue-N/<agent>` branch needs no
   checkout, so its uncommitted plan or implementation work is in no danger.
   Yet that work blocks every `coord N` / `coord run` restart ("Refusing to
   check out issue branches: uncommitted changes in …coordination-claude,
   …coordination-codex").

Fix them in this order: 3, then 2, then 1. After the change the owner's recovery
is a single short command, `coord resume --issue N`, typed in another shell
while the original `coord N` keeps running. That runner then continues on its
own. If the runner was stopped anyway, a plain `coord N` restarts it without
tripping over in-progress agent work.

## Exact File List to be changed or deleted

- `src/prepareAgentBranch.ts` — in `prepareAgentIssueBranches`, the batch dirty
  preflight counts a clone as blocking only when its HEAD
  (`git rev-parse --abbrev-ref HEAD`) is not already the clone's
  `issueBranchFor(branchTemplate, issue, agent.id)`. A clone already on its
  issue branch takes the existing `already-on-branch` path, which never runs
  `checkout` or `liftCloneAgentsProtocol`. That path re-asserts the overlay and
  the bit through `restoreProtocol` and is still verified by
  `assertClonesReady`. Dirty clones that need a checkout are still refused, and
  the error message stays the same.
- `src/cli.ts` — `resume` without `--hold` releases every active hold except
  `nudge-loop` holds. It does this inside the existing `mutateCursorsState`
  callback by folding `releaseHold(state, hold.id, false, now)` over those
  holds, and it appends one `hold-released` journal event per hold, with the
  same `eventId: release:<id>` shape the scoped path uses. It also clears the
  manual pause through `setPaused`, as today. `nudge-loop` holds remain and are
  reported by the existing "N active hold(s)" suffix, because releasing one
  requires the explicit `--reset-nudge-budget` authorization. `--hold <id>`
  keeps its current scoped behaviour unchanged. Update the help text at line 239
  so `--hold <id>` is shown as optional.
- `src/runLoop.ts` —
  - `run()`'s `finished` predicate becomes
    `state.completed || state.abandoned || state.manualPaused`. A runner whose
    pause comes only from automatic holds stays alive. It polls at
    `pollIntervalMs`, and `runTick` is already observation-only while
    `cursors.paused` (`src/runLoop.ts:2532-2539`). Once an owner `resume` from
    another shell clears the holds, the existing lazy
    `if (!initialized && !paused) initializeEffects()` branch and the normal
    tick resume work, with no second command.
  - Log the issue report once when the runner first observes it is held, so
    the owner sees the recovery line without running `coord status`. To do
    this, track the last held state in a local boolean and log only on a
    transition.
  - The two hold log lines at `:919` and `:1161` print
    `coord resume --issue N` (plus `--hold <id> --reset-nudge-budget` only for
    `nudge-loop`).
- `src/issueReport.ts` — the `Recovery:` line (`:68`) prints
  `coord resume --issue N` for holds other than `nudge-loop`, and keeps
  `--hold <id> --reset-nudge-budget` for `nudge-loop`. The manual-pause line
  (`:55`) drops "clears only this pause" and instead says that plain resume
  also releases holds other than `nudge-loop`.
- `docs/coord-driver.md` — the recovery block (`:505-520`): the held runner
  stays alive; plain `coord resume --issue N` releases holds other than
  `nudge-loop` and the manual pause; `--hold` is for scoped release and for
  `nudge-loop`; a clone already on its issue branch may keep uncommitted work
  across a restart.
- `docs/readiness-policy.md` — line 104: legacy `unobservable` holds are
  released by plain `coord resume --issue N` (or scoped with `--hold`).
- `test/prepareAgentBranch.test.ts` — one new case (see Tests).
- `test/cli.test.ts` — one new case (see Tests).
- `test/runLoop.test.ts` — rework the existing
  `it.each(... "keeps %s at an unknown reset and lets run() return at once")`
  case (`:283-304`) to the new contract (see Tests).

## Exact file list to be created

None. `.plans/issue-146/plan.md` (this file) is the only new file and is the
planning artifact itself. Every code and test change goes into an existing
module or an existing test file.

## Reuse and Scope

Reused, unchanged:

- `issueBranchFor`, `blockingDirtyPaths`, `restoreProtocol`,
  `captureCloneAgentsProtocol`, and `assertClonesReady` / `readinessProblems`
  in `src/prepareAgentBranch.ts`. The fix only reorders the preflight to use
  the HEAD/branch comparison the loop body already does
  (`onBranch === branch`). The existing `already-on-branch` path and the
  readiness assertion remain the safety net.
- `releaseHold` and `setPaused` in `src/state.ts`, with all their guards
  (retired work, missing action safety, the nudge-loop rule). Plain resume
  calls `releaseHold` once per hold, so it gets every invariant the scoped path
  already has and adds no new state mutation code. No change to `state.ts`.
- `appendJournal` and the existing `hold-released`, `paused`, and `resumed`
  event shapes.
- `renderIssueReport` (`src/issueReport.ts`) for the one-time held log.
- `RunLoop.runTick`'s existing held branch (observation only) and `run()`'s
  existing lazy `initializeEffects` and `signal` abort handling.
- Test fixtures: `seedClone` / `git` / `skipWorktree` in
  `test/prepareAgentBranch.test.ts`; `setup`, `resolvableStartGit`, `fakeLoop`,
  `actionIdFor`, and `issueRuntimePaths` in `test/cli.test.ts`;
  `safetyFixture`, `claudeFailure`, and `makeLoop` in `test/runLoop.test.ts`.

Out of scope:

- Exceptions thrown from `runTick` (a separate "exits on error" path) are not
  changed. The transcript's exits are all hold-driven.
- `makeAgentClonesBaseReady` (completion and wipe) is not changed.
- Hold creation policy and nudge budgets are not changed.
- Typo-tolerant flag parsing (`--coor-root`) is not changed.

## Tests

Each case fails on `a792b19` and passes after the change. Run the suite with
`pnpm check:fast`.

1. `test/prepareAgentBranch.test.ts`, in `describe("prepareAgentIssueBranches")`,
   new case **"keeps uncommitted work in a clone already on its issue branch"**:
   - Set up the clone with `seedClone()`, call `prepareAgentIssueBranches` once
     so the clone is on `issue-9/claude`, then write `dirty.txt` and modify a
     tracked file.
   - Call `prepareAgentIssueBranches` again.
   - Expect it not to throw, `outcome[0].action === "already-on-branch"`, both
     changes still present, HEAD still `issue-9/claude`, and `skipWorktree(clone)`
     true.
   - Before the change this throws `/uncommitted changes/`. The existing
     "refuses a dirty clone" case (a dirty clone on `main`) still proves that a
     clone needing a checkout is refused.
2. `test/cli.test.ts`, next to "resumes only the selected hold…", new case
   **"plain resume releases every hold except nudge-loop and journals each
   release"**:
   - Seed two holds on the same fixture shape: one `unobservable` hold and one
     `nudge-loop` hold.
   - Run `runCli(["resume", "--issue", "1", "--coord-root", …])` and expect
     exit 0.
   - Expect the `unobservable` hold to be gone and the `nudge-loop` hold to
     remain with `paused: true`.
   - Expect output to contain "1 active hold" and the journal to contain
     exactly one `hold-released` event, for the `unobservable` id.
   - Before the change both holds remain and no event is journalled. The
     existing case still passes unchanged because its only hold is
     `nudge-loop`.
3. `test/runLoop.test.ts`, rework the `it.each` "…lets run() return at once"
   case into **"keeps the runner alive while %s holds the issue"**:
   - Pass an `AbortController` whose `sleep` aborts after 3 sleeps.
   - Expect `sleeps === 3`, the hold unchanged, `f.ui.sends` unchanged (no
     launch or delivery while held), and the journal byte-identical to its
     state before `run()`.
   - In the same case, add a manual-pause variant: `setPaused(…, true)` with no
     holds makes `run()` return with `sleeps === 0`. This shows that a manual
     pause still stops the runner.
   - Before the change `run()` returns at once (`sleeps === 0`), so the
     `sleeps === 3` assertion fails.

## Alternatives Rejected

- **Have `coord <issue>` auto-release holds on start.** This silently
  acknowledges conditions the owner never inspected, and a restart would
  become an implicit release. The owner releases explicitly with one short
  command instead.
- **Let plain `resume` also release `nudge-loop` holds.** That would
  reintroduce a fresh send budget without authorization, which
  `releaseHold`'s existing guard forbids on purpose.
- **Skip the dirty check entirely, or auto-stash.** Stashing or checking out
  over another branch's work can lose it. The only clones exempted are the
  ones that need no checkout at all.
- **Keep exiting on hold and print a one-line restart command.** This still
  needs two commands and a restart. The issue asks that coord not exit while
  it can still continue, and a held runner is already safe because ticks are
  observation-only.
- **Add a new `releaseOwnerHolds` helper in `state.ts`.** Folding the existing
  `releaseHold` keeps every guard without adding code to maintain.

## Risks and Mitigations

- **A held runner now occupies the terminal.** Ctrl-C still stops it, and a
  later `coord N` restarts it. `coord pause` still stops the runner because a
  manual pause remains a finish condition. Test 3 covers both behaviours.
- **The second runner check for a held issue.** `assertNoManualSession` and
  the state-revision authority checks are unchanged. A held runner performs no
  effects, so a concurrently started runner sees the same state as today.
- **Plain resume releasing a hold the owner meant to keep.** Each release is
  journalled per hold, as the scoped path does. `nudge-loop` holds remain
  scoped, and `--hold` stays available for targeted release.
- **Dirty work on the issue branch at restart.** The `already-on-branch` path
  changes no files: it skips checkout and lift and only re-asserts the overlay
  and the bit, which leaves the agent's edits intact (test 1). Clones that need
  a checkout are still refused in batch before anything changes.
- **Docs drift.** Both docs passages that describe `--hold`-only recovery are
  updated in the same change.

## Conclusion

Three small, local changes:

- Exempt clones already on their issue branch from the dirty preflight.
- Let plain `coord resume --issue N` release every hold except `nudge-loop`,
  through the existing `releaseHold`.
- Keep `run()` alive while only automatic holds pause the issue.

Together they turn the issue's four-step, UUID-dependent restart into one
`coord resume --issue N` while the runner keeps going. Hold guards, the
nudge-budget authorization, manual pause, and the refusal for clones that need
a checkout are all kept. Three focused tests, each in an existing test file,
prove the new behaviour. `pnpm check:fast` is the required check.
