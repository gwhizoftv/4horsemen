## Comparison

Reviewed the exact coordinator-exported worktrees for:

- Cursor: `70a73f4cdb8bd595898c16eda169869294921edb`
- Codex: `7ecd02f2b22225a22c0e63eca2d03acf71946f6b`
- Claude: `c798f46594cf1192311ce3de044f6b555c2768ee`

**Recommend Claude**, then Codex, then Cursor. All three address ordinary hold
waiting, scoped recovery, and same-branch unfinished work. Claude additionally
keeps an uninitialized runner observation-only across both recovery races below.

### Findings

1. **Codex `src/runLoop.ts:2744-2748`; Cursor
   `src/runLoop.ts:2764-2773` — P2.** Normal workflow effects must not run until
   this runner has successfully initialized its clones, mirror, and sessions.
   When a restarted runner is paused, it skips initialization; if an owner
   releases the pause between that eligibility read and `runTick()`'s fresh
   state read, the tick sees an unpaused issue and publishes agent actions
   before initialization has even been attempted. An agent can therefore receive
   new work before branch/protocol readiness and session reattachment have been
   established. A deterministic probe against each exact tree cleared the pause
   immediately before delegating to the real first `runTick()`: Cursor and
   Codex each created two action files with zero initialization attempts;
   Claude created none. Smallest regression: start the existing two-agent
   fixture manually paused, inject that owner interleaving, and assert no action
   file exists at the first sleep and initialization precedes publication on the
   next poll. Claude's `runTick({ observeOnly: !initialized })` and the gate at
   `src/runLoop.ts:2532` already enforce this rule.

2. **Cursor `src/runLoop.ts:2768-2773` — P2.** Catching an initialization
   authority conflict must defer normal workflow work until a later successful
   initialization. This catch instead falls through to unrestricted `runTick()`.
   If an owner command changes the durable revision during mirror initialization
   without leaving the issue paused, the authority check aborts initialization
   before session setup, but the same iteration still publishes actions. A
   probe using the real `initializeEffects()` and a mirror stub that advances
   the revision produced two action files before initialization succeeded.
   Codex skipped that tick; Claude ran only its observation path. Smallest
   regression: mutate the cursor revision once from `mirror.initialize()`, keep
   the issue unpaused, and assert zero prepared actions at the first sleep,
   followed by a successful initialization retry and normal progress.

No blocking implementation finding was identified in Claude's reviewed scope.
Its initialization-conflict test checks retry, but asserting the absence of
premature action files would make that protection explicit.

### Scope, reuse, and coverage

- **All three** keep product changes to the ten approved files: the CLI,
  run loop, issue report, branch preparation, their four existing test files,
  README, and driver documentation. No new product file, dependency, schema,
  version bump, or unrelated cleanup is introduced. Existing cursor mutation,
  `releaseHold`, resource observation, mirror/tmux initialization, protocol
  restoration, and completed-issue cleanup remain the implementation primitives.
  Plain resume remains manual-pause-only; selecting a hold preserves other
  holds and manual pause. Documentation distinguishes a live waiting runner
  from explicit `--run` for a stopped one.
- **Cursor** reuses `snapshotCloneReadiness` but moves it earlier in the same
  file, and duplicates manual-session location resolution in the new CLI path.
  Its new wait-signature calculation is more machinery than comparing the
  already-rendered paused report, as the other two do. Tests cover staying alive,
  scoped CLI recovery, and staged/unstaged/untracked preservation, but do not
  exercise the initialization-conflict recovery path or release-and-continue
  transition that distinguish the candidates.
- **Codex** reuses the existing readiness snapshot without moving it, checks
  that the branch has not changed since preflight, and avoids rewriting a
  healthy same-branch protocol overlay. Its shared run helper preserves common
  cleanup. Coverage includes same-runner release of manual and legacy holds,
  genuine initialization errors, CLI refusal cases, and dirty main/wrong-issue/
  detached clones. Those strengths do not close finding 1's between-read race.
- **Claude** adds only a small observation-only option to the existing tick,
  rather than another polling subsystem. The local active-agent hold resolver
  runs inside the existing cursor mutation, preserving unique selection and
  auditing the actual hold ID. It reuses branch snapshots, checks eligible dirty
  clones have not left their issue branch, and extends existing fixtures for
  WIP preservation and mixed-batch rejection on main, another issue, and
  detached HEAD. Focused tests exercise manual-pause continuation, initialization
  retry, explicit `--run`, and scoped hold release. This is the best correctness
  tradeoff without broadening the issue.

### Verification

- Executed isolated deterministic probes directly against all three pinned
  source trees, using the existing state/paths/run-loop code and local dependency
  installation. The two readiness results above were reproduced, not inferred
  solely from source. Scratch loader, fixtures, and test configuration remain
  outside the submitted artifact under `.codex/tmp/`.
- `pnpm exec vitest run --config .codex/tmp/issue146-vitest.config.ts` ran the
  four touched test files from each exact worktree with local dependency
  aliases: **573 passed, 6 failed (579 total)**. All run-loop, branch-preparation,
  and issue-report tests passed. The same two CLI fixture/environment failures
  occurred for every candidate: a trusted-source assertion compared the caller
  clone's HEAD to the imported worktree's correct pin, and `ensureBuilt()` could
  not find Node type definitions because the exported worktrees have no
  `node_modules`. These are limitations of this cross-worktree invocation, not
  evidence that any candidate passed a full independent check suite.
- Local `pnpm check:fast`: lint, both typechecks, and **663 tests passed** on
  the standalone rerun. The earlier run overlapping cross-worktree tests had
  one 15-second onboarding-test timeout (662 passed); no product changes were
  needed for the successful rerun. This checks the submitting Codex clone,
  not Claude's full acceptance suite.
