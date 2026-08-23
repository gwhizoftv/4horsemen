# Issue 96 — make the `AGENTS.md` skip-worktree bit a non-problem at agent start

Issue 96 asks for two things:

1. the agent's issue branch is checked out **and the skip-worktree bit re-set**
   before the agent CLI is started;
2. the agent is told it does not need to create the branch, so it does not try.

Coordination already checks the branch out before start (`coord start` runs
`prepareAgentIssueBranches` at `src/cli.ts:707` before `startEffects` at
`src/cli.ts:746`; resume runs it at `src/runLoop.ts:466` inside
`initializeEffects`, before `tmux.ensureSession` at `src/runLoop.ts:479`). The
ordering is not the defect. The defect is that the **restore half is optional
and unguarded**, so the clone can be handed to the agent with the bit cleared
and the protocol overlay gone.

## The three concrete failures this plan fixes

**F1 — vendored workspaces never restore the bit.**
`prepareAgentIssueBranches` lifts the bit unconditionally
(`src/prepareAgentBranch.ts:85`) and then calls `restoreProtocol`
(`src/prepareAgentBranch.ts:33-38`), which resolves the install root as
`installRoot ?? localConfigGet(clone, INSTALL_ROOT_KEY)` and **returns silently
when that is null**. A vendored install deliberately writes
`coord.installRoot = null` (`src/install.ts:372`, and `coord doctor` excuses the
missing key at `src/doctor.ts:188`). So in every vendored workspace the lift
happens and the restore does not: the agent starts on the right branch with the
tracked product `AGENTS.md`, no protocol block, and no skip-worktree bit.

**F2 — resume loses the install root even when it is knowable.**
`src/runLoop.ts:458-465` reads it as
`readConfig(start.configPath).coordination?.installRoot ?? null` inside a
`try/catch` that swallows to `null`. `coordination` is the optional install
stamp (`src/state.ts:185`, `installStampSchema` at `src/state.ts:108-134`), and
its `installRoot` is a non-empty string even for vendored installs — so the
value the run loop needs is usually present, and is discarded on any read
error. `coord start` has a fallback (`?? coordinatorSourceRoot`,
`src/cli.ts:713`); `coord <issue>` has none.

**F3 — one failed restore bricks every later run.**
Once F1 or F2 has cleared the bit, the worktree `AGENTS.md` differs from `HEAD`
and is now visible. The next `prepareAgentIssueBranches` hits the dirty gate at
`src/prepareAgentBranch.ts:57-66` (`hasUncommittedChanges` is a bare
`git status --porcelain`, `src/gitExec.ts:71-72`) and throws
`Refusing to check out issue branches: uncommitted changes in <clone>`. Neither
`coord start` nor `coord <issue>` can proceed, and the only documented
instruction the agent has — "do not clear skip-worktree, escalate" — is exactly
what it must not act on. A `gitOrThrow(checkout)` failure at
`src/prepareAgentBranch.ts:88` or `:98` leaves the same wreckage, because the
lift is not wrapped in a `finally`.

For item 2, the "your branch already exists" sentence lives in exactly one
place: the `R1.join` task string (`src/steps.ts:65`). Every later action —
plan, review, ballot, implement, compare, revise, finalize — is rendered
without it (`task: ${definition.task}${binding}${scaffold}${correction}`,
`src/runLoop.ts:408`), and neither `templates/product/AGENTS.protocol.md` nor
`templates/product/AGENTS.md` says the branch is pre-made. An agent that
compacts, restarts, or reads only its current `action.md` sees a branch scheme
(`templates/product/AGENTS.md`, "Branch scheme") and no statement that the
branch is already there.

## Exact File List to be changed or deleted

Nothing is deleted.

**`src/agentsProtocol.ts`**
- Export the existing private `skipWorktreeAgentsMd` (line 48) as
  `ensureAgentsMdSkipWorktree(clone: string): void`, unchanged in behaviour
  (still a no-op when `AGENTS.md` is untracked). Keep the two internal call
  sites (lines 68, 74) pointing at it.
- Add
  `cloneAgentsProtocolState(clone: string): { tracked: boolean; overlayPresent: boolean; skipWorktree: boolean }`.
  `tracked` reuses the existing `agentsMdTracked` helper (line 39);
  `overlayPresent` tests the worktree file for `AGENTS_PROTOCOL_MARKERS.begin`;
  `skipWorktree` is `git ls-files -v -- AGENTS.md` with a leading `S`
  (the same predicate `test/prepareAgentBranch.test.ts:14` already uses).
  This is the post-condition oracle; it reads only, never writes.

**`src/prepareAgentBranch.ts`**
- Replace `restoreProtocol` with
  `restoreProtocol(clone, installRoot, log): "overlay" | "bit-only"`. Resolution
  order becomes: explicit `installRoot` → `localConfigGet(clone, INSTALL_ROOT_KEY)`
  → **the install stamp's root passed by the caller**. When no root resolves or
  the resolved root does not exist, it must still call
  `ensureAgentsMdSkipWorktree(clone)` and return `"bit-only"` — never return
  having done nothing. This is the F1 fix: the bit is re-set even when the
  overlay body cannot be re-rendered.
- Wrap the per-agent lift/checkout/restore in `try { … } finally { restoreProtocol(…) }`
  so a failing `gitOrThrow` at line 88 or 98 cannot leave the bit cleared (F3).
- Narrow the dirty gate (lines 57-66). Keep refusing genuinely dirty clones, but
  ignore a worktree `AGENTS.md` whose only difference from `HEAD` is the managed
  protocol block: compute `git status --porcelain`, and drop an entry whose path
  is exactly `AGENTS.md` when
  `removeManagedBlock(worktreeBytes, path, AGENTS_PROTOCOL_MARKERS).content`
  equals `git show HEAD:AGENTS.md`. Any other modification to `AGENTS.md`, and
  any other dirty path, still throws the existing message unchanged. This lets a
  workspace already wrecked by F1/F2 heal on the next run instead of dead-ending.
- After the loop, assert the post-condition for every result whose action is not
  `skipped-missing`: `cloneAgentsProtocolState(clone).skipWorktree` is `true`
  whenever `tracked` is `true`, and `git rev-parse --abbrev-ref HEAD` equals the
  computed branch. On failure throw
  `Agent clone <clone> is not ready for issue <n>: <reason>. Agents were not started.`
  Throwing here is what keeps the guarantee "before the agent is started": both
  callers launch CLIs only after this function returns
  (`src/cli.ts:746`, `src/runLoop.ts:479`).
- Extend `PrepareAgentIssueBranchResult` with `protocol: "overlay" | "bit-only" | "skipped"`
  so the outcome is assertable and the `coord start` log says which happened.
- Update the doc comment (lines 40-45) to state that restore is mandatory.

**`src/runLoop.ts`**
- `initializeEffects` (lines 454-473): resolve `installRoot` from the install
  stamp without swallowing to `null` — on a `readConfig` throw, log the reason
  through `this.log` instead of discarding it, and pass the resolved value
  through. This is the F2 fix; `prepareAgentIssueBranches` then has the same
  input on resume that `coord start` gives it.
- `buildOrder` (line 408): change the task composition to
  `` `${definition.task}${BRANCH_PREPARED_NOTE}${binding}${scaffold}${correction}` ``
  so the note reaches **every** action, not just `R1.join`.

**`src/steps.ts`**
- Add `export const BRANCH_PREPARED_NOTE` holding one paragraph: coordination has
  already checked this clone out on the issue branch named later in the action;
  do not create it, switch to it, or clear `skip-worktree` on `AGENTS.md` to make
  a checkout work; if the clone looks wrong, escalate.
- Remove that sentence from the `R1.join` task string (line 65) so the note is
  not printed twice on the join action. `R1.join.task` becomes just
  `"Publish the participation-readiness artifact for this issue."`.

**`src/doctor.ts`**
- Add one finding in the per-clone block that already checks identity keys
  (near line 188): when `cloneAgentsProtocolState(clone).tracked` is `true` and
  `skipWorktree` is `false`, emit
  `finding("agentsProtocol", clone, "AGENTS.md is tracked but skip-worktree is not set, so the coordination overlay shows as an uncommitted change.", "Re-run coord install, or start/resume the issue so branch preparation re-sets it.")`.
  This makes the wrecked state from F1/F2 diagnosable instead of surfacing only
  as a confusing "uncommitted changes" refusal.

**`test/prepareAgentBranch.test.ts`** — new cases (detailed under Tests).

**`test/runLoop.test.ts`** — assert the note reaches a non-join action.

**`test/doctor.test.ts`** — assert the new finding.

**`package.json`** — bump `version` from `0.0.16` to `0.0.17`. `origin/main` is
at `0.0.16` (`git show origin/main:package.json`), and on a non-`main` branch
`pnpm check:fast` enforces strictly-greater. The `cli.test.ts` version assertion
is rewritten in-flight by the `test:fast` script, so no test edit is needed.

**Not changed, deliberately:** `AGENTS.md` in this clone. It carries the
skip-worktree overlay this issue is about; editing it, or clearing the bit to
make it editable, is the exact prohibited act. The overlay body is regenerated
from `templates/product/AGENTS.protocol.md` by `coord install`.

## Exact file list to be created

No new source or test files. Every change lands beside the code that already
owns the behaviour, so nothing has to be re-wired:

- the two new helpers are `AGENTS.md`-overlay operations and belong in
  `src/agentsProtocol.ts`, next to `writeCloneAgentsProtocol` and
  `liftCloneAgentsProtocol`, which already own the bit;
- the branch-preparation contract changes are confined to
  `src/prepareAgentBranch.ts`, the single module both callers go through;
- `test/prepareAgentBranch.test.ts` already has a `seedClone` fixture that
  builds a real product repo, bare origin, and clone with the overlay applied —
  the new cases are three additions to it, and a fourth file would have to
  duplicate that fixture;
- `test/doctor.test.ts` and `test/runLoop.test.ts` already have the workspace
  fixtures the two smaller assertions need.

The only genuinely new artifacts are the prose paragraph added to
`templates/product/AGENTS.protocol.md` (an edit to a tracked template, not a new
file) and the `BRANCH_PREPARED_NOTE` constant in `src/steps.ts`.

## Tests

All of these run under `pnpm test:fast` (vitest, `vitest.config.ts`); none need
the e2e config.

In **`test/prepareAgentBranch.test.ts`**, extending the existing `seedClone`
fixture and its `skipWorktree(clone)` predicate:

1. `"re-sets skip-worktree even when no install root can be resolved"` — seed the
   clone, then `git config --unset coord.installRoot` (and pass no `installRoot`),
   reproducing the vendored case. Call `prepareAgentIssueBranches`. Assert
   `git rev-parse --abbrev-ref HEAD === "issue-9/claude"`, `skipWorktree(clone) === true`,
   and `outcome[0].protocol === "bit-only"`. **This test fails today**: the
   current `restoreProtocol` returns at line 34 and the bit stays cleared.
2. `"re-sets skip-worktree when the checkout fails"` — make the checkout throw by
   pointing `baselineSha` at a commit that does not exist and setting
   `baseBranch` to a branch with no local or remote ref, so `startPoint` throws
   after the lift. Assert the call rejects **and** `skipWorktree(clone) === true`
   afterwards. This pins the `finally`.
3. `"heals a clone whose only dirt is the lifted overlay"` — seed, lift the
   overlay by hand (`liftCloneAgentsProtocol`), write the overlay back into the
   worktree *without* re-setting the bit so `git status --porcelain` reports
   ` M AGENTS.md`, then call `prepareAgentIssueBranches`. Assert it does **not**
   throw, ends on the issue branch, and `skipWorktree(clone) === true`. Assert
   the sibling case still throws: with `dirty.txt` present as well, the existing
   `refuses a dirty clone` message is unchanged.
4. Strengthen the existing case at line 50: also assert
   `outcome[0].protocol === "overlay"`.

In **`test/runLoop.test.ts`**, reusing the `buildOrder(..., "R2.plan", null)`
call already at line 1204: assert the rendered `order.task` contains the
`BRANCH_PREPARED_NOTE` text. Today it does not — the sentence only exists on
`R1.join`. Add the mirror assertion on an `R4.implement` order (line 189 already
builds one).

In **`test/doctor.test.ts`**: build a clone with a tracked `AGENTS.md` and the
bit cleared, run the doctor entry point that the existing per-clone tests use,
and assert a finding with kind `agentsProtocol` naming that clone; assert it is
absent once the bit is set.

Commands, exactly as `AGENTS.md` names them:

- `pnpm check:fast` — lint, typecheck, `test:fast` — before every commit.
- `pnpm check` — build + `check:fast` + e2e — the coordinator's gate; run it
  once before publishing the implementation pin.

## Alternatives Rejected

**Stop lifting the bit at all; check out with `git checkout -m` or a stash.**
The lift exists because `git checkout <branch>` refuses to move when a
skip-worktree file differs between the two trees — the existing test at
`test/prepareAgentBranch.test.ts:53` asserts exactly that refusal. Removing the
lift reintroduces the failure the lift was written for, and merge-based
alternatives can leave conflict markers inside `AGENTS.md`, which is strictly
worse than a clean re-render.

**Make `installRoot` a required parameter and let a missing one throw.**
This turns F1 from a silent wreck into a hard start failure for every vendored
workspace — vendored clones legitimately have no `coord.installRoot`
(`src/install.ts:372`). The bit does not need the template; only the overlay
body does. Re-setting the bit unconditionally and downgrading to `"bit-only"`
keeps vendored workspaces starting while removing the silent-skip hazard.

**Set `coord.installRoot` in vendored clones so restore always finds a template.**
`src/setupWorkspace.ts:505-517` documents why that key is null there: a set key
would give `githooks/post-merge` two candidate launcher templates and no rule
for choosing. Fixing an `AGENTS.md` bug by reintroducing hook ambiguity is a bad
trade.

**Only widen the dirty gate and leave restore as-is.**
That hides F1 rather than fixing it: clones would start successfully with no
protocol block in `AGENTS.md`, so agents would work from the product's short
human note and would not see the format rules at all.

**Put the "branch already exists" note only in the protocol template.**
The template reaches the agent through `AGENTS.md`, which is precisely the file
that goes missing when this bug fires — the note would be absent exactly when it
is needed. It belongs in `action.md`, which is written fresh per step and read
directly. It goes in both, for the compaction case.

**Have `buildOrder` append the note only to the first action of a session.**
There is no per-session marker in `InternalOrder`, and the failure mode is an
agent that resumes mid-workflow with no memory. Every action is the cheap,
correct answer: one paragraph.

## Risks and Mitigations

**Widening the dirty gate could let real work be clobbered.** The exemption is
narrow by construction: path must be exactly `AGENTS.md`, and stripping the
managed block from the worktree bytes must reproduce `HEAD:AGENTS.md` byte for
byte. A human edit outside the block, or any second dirty path, still throws the
existing message. Test 3 asserts both directions.

**Editing `templates/product/AGENTS.protocol.md` could trip install drift.**
It does not: `canonicalSourceDigest` (`src/hookSync.ts:159-172`) digests the
hook bodies, `templates/hooks/shim.sh`, and `scripts/lib/launcher.sh` — not the
protocol template. `automationDigest` is derived from the config and issue
snapshot (`src/cli.ts:690`), also unaffected. Existing clones keep their older
overlay until the next `coord install` or the next branch preparation
re-renders it; the `action.md` copy of the note covers the gap in the meantime.

**Changing `R1.join.task` changes rendered action bytes.** Actions are rendered
per step and not content-addressed, and `automationDigest` does not cover the
task string, so no published digest moves. `test/action.test.ts` asserts
`renderAction` structure rather than the join wording; if any assertion pins the
old sentence it is updated in the same commit.

**Throwing on the post-condition could block a start that used to succeed.**
That is the intent: the alternative is starting an agent into a clone whose
protocol file is wrong. The throw fires only when `AGENTS.md` is tracked and the
bit is unset after the restore already tried, which the `finally` plus
unconditional `ensureAgentsMdSkipWorktree` make close to unreachable. The error
names the clone and states that agents were not started.

**The version bump can collide.** `package.json` moves `0.0.16` → `0.0.17`; if a
peer lands `0.0.17` on `main` first, `pnpm check:fast` fails loudly on the ship
gate rather than merging silently, and the fix is a re-bump.

**Scope.** No change to `githooks/`, to `verify.*`, to the workflow state
machine, to gates, or to the tmux/session ordering — the ordering is already
correct, and this plan only makes the restore that ordering depends on
unconditional.

## Conclusion

The branch is already checked out before agents start; what is missing is a
guarantee that the skip-worktree bit and the protocol overlay come back
afterwards. This plan makes that restore unconditional (`finally` plus a
bit-only fallback when no install root resolves), gives the resume path the same
install-root resolution `coord start` already has, asserts the ready state
before either caller launches a CLI, lets an already-wrecked clone heal instead
of dead-ending, and surfaces the bad state in `coord doctor`. For the second
half of the issue, the "your branch already exists, do not create or switch it"
note moves from the single join step into every rendered action and into the
protocol template, so an agent that resumes with no memory of the process still
reads it. Five source files, one template, three test files, and a version bump;
verified with `pnpm check:fast` per commit and `pnpm check` before the pin.
