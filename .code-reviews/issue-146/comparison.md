# Issue 146 — implementation comparison

Bound implementation pins compared (each against baseline `a792b19e8757c734c1c572b1c3fc1675a78d8bfc`):

- cursor `70a73f4cdb8bd595898c16eda169869294921edb`
- codex `7ecd02f2b22225a22c0e63eca2d03acf71946f6b`
- claude `c798f46594cf1192311ce3de044f6b555c2768ee`

## Comparison

All three implement the selected (codex) plan's three changes, and the
user-visible behaviour is the same:

1. **Dirty clones in `prepareAgentIssueBranches`.** Dirt blocks preparation only
   when the clone's HEAD differs from `issueBranchFor(...)`. The refusal is
   still batch-wide, and it happens before any clone is touched. All three
   reuse the existing `snapshotCloneReadiness`.
2. **`run()` keeps waiting.** It ends only on `completed`/`abandoned` (or an
   abort). It logs the paused report only when the report changes, catches
   `StateConflictError` from deferred initialization, and drops
   `resourceWorkPending`.
3. **Scoped resume.**
   - `resume --agent <id>` resolves exactly one hold under the cursor lock.
     `--agent` and `--hold` are mutually exclusive.
   - `--reset-nudge-budget` is accepted with either selector.
   - `--run` checks the manual-session exclusion before any mutation, then
     reuses `run()` plus `detachCompletedIssue`.
   - Plain `resume` still clears only the manual pause.

All three change the same ten approved paths. None adds a file or a
dependency, and all tests extend existing test files.

### Finding 1 — cursor: an initialization conflict falls through to an effectful tick before effects exist

- **Where:** `src/runLoop.ts:2764-2773` at `70a73f4c`.
- **Rule:** No delivering tick may run before `initializeEffects` has completed
  successfully. That function puts each clone on its issue branch, re-sets
  skip-worktree, initializes the mirror, and ensures the tmux sessions. Its
  readiness assertion exists because agents must not receive work before
  then.
- **Failure:** The `catch` swallows the `StateConflictError` and leaves
  `initialized = false`. Execution then reaches the unconditional
  `cursors = await this.runTick()` on line 2773. The scenario:
  1. A runner that was held is released.
  2. During its slow mirror or tmux initialization, the owner issues a second
     command, for example clearing a manual pause or releasing another hold.
  3. If the state is unpaused, this poll runs a full workflow tick while
     initialization is unfinished. It writes `action.md` and sends tmux
     prompts while the clone may still be on the wrong branch, with the bit
     clear or no session present.
- **Test:** add to `test/runLoop.test.ts`. Use a tmux `has-session` stub that
  bumps the cursor revision on its first call. Use a delivery-mode agent and
  count `send-keys -l`. Assert there are zero sends before the second,
  successful `has-session`.
- **Comparison:** codex nests `runTick()` inside the same `try` after
  initialization (`src/runLoop.ts:2742-2749`), so a conflict skips the tick.
  claude passes `observeOnly: !initialized` (`src/runLoop.ts:2761`), and
  `runTick` returns before any workflow work (`:2532`).
- **Coverage:** cursor has no test for an initialization conflict at all. codex
  and claude both have one.

### Finding 2 — cursor and codex: a release between the pause check and `runTick` advances an uninitialized runner

- **Where:** codex `src/runLoop.ts:2741-2748` at `7ecd02f2`; cursor
  `src/runLoop.ts:2764-2773` at `70a73f4c`.
- **Rule:** Same as Finding 1. A runner that has not initialized may only
  observe.
- **Failure:**
  1. A runner starts on a held issue. It reads `paused === true`, so it skips
     `initializeEffects`.
  2. Before `runTick` re-reads the cursors, the owner's `coord resume` lands.
  3. `runTick` sees an unpaused state and runs a full workflow tick without
     prepared clones or sessions.

  The window is milliseconds per poll. However, #146 makes "a held runner
  waits for exactly this owner release" the normal path, where previously
  the held runner exited. A narrow baseline race becomes the expected recovery
  sequence.
- **Fix:** claude's guard closes it: `runTick({ observeOnly: !initialized })`
  returns right after the paused branch. That is a one-line port to either
  implementation. A test cannot place the release deterministically between
  the two reads without an injected hook, so a fix is preferred here.

### Finding 3 — cursor: dangling doc comment and an unnecessary move

- **Where:** `src/runLoop.ts:1095` at `70a73f4c`.
- **Rule:** Doc comments describe the declaration they precede.
- **Failure:** cursor deletes `resourceWorkPending` but keeps its JSDoc
  ("Scheduled, still-authorized resource observation that justifies keeping a
  held runner alive"). That comment now sits directly before
  `observeResources`'s own JSDoc and misdescribes a runner policy that no
  longer exists.
- Separately, cursor relocates the 30-line `CloneReadinessSnapshot` /
  `snapshotCloneReadiness` block above `prepareAgentIssueBranches`. A
  module-level `const` is already callable at runtime from that position, so
  the move is churn only. codex and claude call it in place.
- **Fix:** delete the orphaned line and keep the helper where it was.

### Scope, reuse and coverage

- **codex.**
  - Smallest product diff in `prepareAgentBranch.ts`, which iterates the
    snapshot directly.
  - Implements the plan's "leave a healthy overlay alone" step on the
    already-on-branch path.
  - Adds a branch-change check against the snapshot.
  - Factors `assertIssueCanRun`/`runIssue` so `coord N`, `run`, and
    `resume --run` share one entry.
  - Broadest focused coverage:
    - same-branch preservation of commits, index, worktree and untracked
      files;
    - mixed-batch refusal for `main`, another issue branch, and a detached
      HEAD;
    - waiting through both a manual pause and a hold, then continuing in the
      same runner;
    - an initialization-conflict retry that does not hide other errors;
    - reattach with same-branch work in progress;
    - the CLI selector and `--run`;
    - report fallback.
  - Also adds help and README text.
- **claude.**
  - Same shape as codex, with an equivalent selector and `--run`.
  - The only implementation that guards the uninitialized tick (Finding 2).
  - The already-on-branch path still calls `restoreProtocol` unconditionally.
    This is pre-existing behaviour, but the plan asked to leave a healthy
    overlay alone.
  - Its run-loop liveness test covers a manual pause, not a released hold.
- **cursor.**
  - Equivalent CLI and report behaviour.
  - Its recovery string is reused through a `.replace(/^Recovery: /, "")`
    on the log path, which works but is fragile coupling.
  - Has Finding 1 and the Finding 3 churn.
  - Does not cover the initialization conflict.

Ranking:

1. **codex** is the best basis: plan fidelity, coverage, and a correct
   conflict path. It should take claude's one-line `observeOnly` guard to close
   Finding 2.
2. **claude** is correct but has thinner hold-path coverage.
3. **cursor** must fix Finding 1 before it is acceptable.
