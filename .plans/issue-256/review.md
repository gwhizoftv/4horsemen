# Plan review — issue 256

Bound plans reviewed:

- muse `46547e48ade505e871e4de91ceb06895151a4b1a` (`.plans/issue-256/plan.md`)
- claude `6630d4b4bd3ce2c16d578ee2a70bf356055d0637` (`.plans/issue-256/plan.md`)
- codex `0155280a858a776d3e8db3acc00c87f5bddcc6cc` (`.plans/issue-256/plan.md`)

All three plans were read from the bound input files. The facts below were checked against baseline `d646aedcc21a43dde942c86c65b64aba649c1964` in this clone:

- `src/runLoop.ts:2038-2095` (`transcriptStamp`, `watchOwedWork`) and `runArgv` at `src/runLoop.ts:124-150`. `runArgv` keeps only the last 32 KiB of stdout when `timeoutMs` is set.
- `src/tmux.ts:264-270` (`paneActivityDigest` deliberately ignores the composer and footer) and `src/tmux.ts:282-330`.
- `src/hookPolicy.ts:142-180`, `src/cli.ts:1593-1615` and `src/orderScaffold.ts:175-183`. A plan-amendment request is written "at the same required path".
- `src/steps.ts:137`. The R4 `requiredPath` is the `implementation-ready` signal.
- `vitest.config.ts` excludes `test/cli.test.ts` and `test/hookSync.test.ts`. I ran `vitest list --config vitest.config.ts test/hookSync.test.ts test/cli.test.ts`: it collected zero tests. The same listing with `vitest.system.config.ts` collected them.

No product suite was run for this review.

## Findings

### muse 46547e48

**M1. Blocking pre-commit and pre-push artifact guard**

- **Plan claim.** "Changed: `src/hookPolicy.ts`" and "`src/cli.ts`". The guard fails with exit 1 at pre-commit when `requiredPath` "is untracked or not in the staged index". At pre-push it fails when the outgoing tree lacks `requiredPath`, for any resolvable current Git action.
- **Rule.** The guard must not reject the documented workflows:
  - the R4.implement / R6.revise product-then-signal sequence, whose `requiredPath` is `.signals/issue-<n>/implementation-ready-<agent>.json` (`src/steps.ts:137`);
  - the amendment flow ("leave unfinished product edits unstaged").
- **Failure.** An implementer on R4 commits product files first, as the protocol and the hooks expect: product checks run on product commits, and the signal follows. The signal is not yet staged, so `git commit` exits 1 with HOOK BLOCKED. Every implementation would either be blocked, or be forced to fabricate the readiness signal before the product work exists. The pre-push half blocks the intermediate product push in the same way. The plan's Risks section names amendment and accepted-action shapes, but not this sequence.
- **Correction.** Drop the pre-commit guard. At pre-push, exempt R4/R6 pushes when the signal is absent from the worktree, the index and the tree (as codex specifies), or make the check non-blocking.

**M2. `git status --porcelain` in the watchdog**

- **Plan claim.** `src/runLoop.ts` (a): the worktree stamp hashes `git status --porcelain` output.
- **Rule.** A coordinator observation inside an agent's clone must be read-only. It must not take the clone's index lock while the agent may be running git.
- **Failure.** `git status` refreshes stat data and opportunistically writes `.git/index`, holding `.git/index.lock` while it does. The plan runs it once a minute in every owing agent's clone; `hermeticGitEnv` does not set `GIT_OPTIONAL_LOCKS=0`.
  - An agent's concurrent `git add` or `git commit` can then fail with `Unable to create '.git/index.lock': File exists`. That injects a spurious failure into exactly the commit/push step this issue is trying to make reliable.
  - The rewrite also changes the `.git/index` mtime the plan stamps, so the coordinator's own probe can register as agent activity.
- **Correction.** Use `git ls-files -z --modified --others --exclude-standard`, which does not write the index, and stat the listed paths. Or set `GIT_OPTIONAL_LOCKS=0`.

**M3. Error stamp of `unavailable:${now}`**

- **Plan claim.** `src/runLoop.ts` (a): "on git/stat error use a changing `unavailable:${now}`-style stamp so the observation is checked but never quiet". (c) says the existing quiet-agent tests "must stay green".
- **Rule.** A missing or unreadable clone must not permanently disable the watchdog's single resend and `[WAIT]`.
- **Failure.**
  - `safetyFixture` keeps `start.agents[].root` at `/clones/<vendor>` (`test/runLoop.test.ts:224`), which does not exist. Every observation would therefore be "unavailable" and never quiet. `resends a lost %s prompt once after a quiet minute` (`test/runLoop.test.ts:2812`) would see `sends === 1` instead of `2`, so the plan's own regression keepers fail.
  - In production, any clone where git errors for good (a corrupt index, `safe.directory`, a removed clone) would never be resent and never reported as stalled. That is the hung-agent case the watchdog exists for.
- **Correction.** Map clone-observation errors to a constant `"none"`, the same as `transcriptStamp` does. That leaves today's behaviour unchanged.

**M4. Busy readiness reasons count as activity**

- **Plan claim.** `src/runLoop.ts` (b): treat `harnessPromptReadiness` reasons `antigravity-turn-chrome`, `cursor-turn-chrome`, `codex-turn-chrome` and `claude-usage-wait` as activity "even if `paneActivityDigest` is unchanged".
- **Rule.** A harness frozen mid-turn must still reach the one resend and the `[WAIT]` report.
- **Failure.** A harness hangs with `• Working (3m 2s • esc to interrupt)` frozen on screen: the process is stuck, nothing repaints, and no transcript is written. Today the static pane is quiet and the owner gets `[WAIT]`. Under this plan the frozen chrome matches `codex-turn-chrome` on every observation, so the agent is never quiet, and the owner is never told for the rest of the issue. `claude-usage-wait` would also suppress `[WAIT]` for the length of a usage-limit wait, which is exactly when the owner needs to know.
  - A live spinner or elapsed timer already changes `paneActivityDigest`, because that chrome sits above the composer (`src/tmux.ts:264-268`). The added signal only changes the outcome when the chrome is static, which is the stuck case.
- **Correction.** Drop (b). If kept, the busy signal must expire, for example when unchanged for N observations.

**M5. Test command skips `test/cli.test.ts`**

- **Plan claim.** Tests: `pnpm vitest run --config vitest.config.ts test/action.test.ts test/runLoop.test.ts test/cli.test.ts`.
- **Rule.** A named development command must actually execute the tests the plan adds.
- **Failure.** `vitest.config.ts` excludes `test/cli.test.ts`. I verified with `vitest list` that zero tests are collected from it. Every new hook-verify case would silently not run during development, and the command would still exit 0.
- **Correction.** Use `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts` for that file.

**M6. Hook tests through `runCli`**

- **Plan claim.** The hook guard is tested in `test/cli.test.ts` through `runCli(["hook-verify", ...])`.
- **Rule.** The pre-push guard depends on Git's stdin ref lines and on the installed hook. It should be exercised through an actual push, as the existing binding tests do (`test/hookSync.test.ts:333-393`, `installed`, `activeRun`, `tryGit(clone, "push", ...)`).
- **Failure.** A `runCli` test must hand-forge the `refs` stdin. It cannot catch a regression in which `githooks/lib/policy.sh` stops forwarding stdin to `hook-verify`. In that case the guard never runs on real pushes while the CLI test passes.
- **Correction.** Put the case in `test/hookSync.test.ts`'s `coordinator verification binding` describe.

### claude 6630d4b4 (self-review)

**C1. Test command skips `test/hookSync.test.ts`**

- **Plan claim.** Tests: "`pnpm vitest run test/action.test.ts test/hookSync.test.ts test/runLoop.test.ts` while developing".
- **Rule.** The development command must execute the new `test/hookSync.test.ts` case.
- **Failure.** Without `--config`, vitest uses `vitest.config.ts`, which excludes `test/hookSync.test.ts`. I verified that zero tests are collected. The new pre-push warning test would never run locally, and the command would exit 0.
- **Correction.** Add `pnpm exec vitest run --config vitest.system.config.ts test/hookSync.test.ts`.

**C2. Running `ls-files` through `this.processRunner` with a timeout**

- **Plan claim.** `src/runLoop.ts`: `cloneActivityStamp` runs `git ls-files -z ...` "through `this.processRunner` with a timeout".
- **Rule.** The file enumeration must be complete, or it must be treated as unavailable. It must never be silently partial.
- **Failure.** With `timeoutMs` set, `runArgv` keeps only the last 32 KiB of stdout (`capture` at `src/runLoop.ts:145-148`).
  - A clone with a large dirty or untracked set, such as a generated tree that is not git-ignored, yields a list truncated from the front, with a broken first entry.
  - Edits to files in the dropped head never change the fingerprint, so an actively editing agent is falsely quiet. That is the issue's failure mode.
- **Correction.** Either run without `timeoutMs`, which keeps the full string, and cap the result after parsing; or treat stdout of 32 KiB or more as `"none"`.

**C3. Unconditional pre-push warning**

- **Plan claim.** `src/hookPolicy.ts`: `requiredArtifactWarning` warns whenever the pushed commit lacks `requiredPath`.
- **Rule.** A diagnostic must fire only on a real premature-completion risk, or agents learn to ignore it.
- **Failure.** On R4.implement and R6.revise, every intermediate product push legitimately lacks the `implementation-ready` signal (`src/steps.ts:137`). The warning ("do not write `complete` with this SHA") then prints on every correct implementation push. That trains agents to ignore it, or nudges them to write the readiness signal before the product is finished.
- **Correction.** Skip the missing-from-tree warning when `cursors.agents[agent].stepId` is R4.implement or R6.revise and the signal is absent from the worktree, the index and the outgoing tree. Still warn about a dirty or untracked signal.

**C4. Hard-coded `<root>/.git/index`**

- **Plan claim.** `src/runLoop.ts`: the stamp stats `<root>/.git/index`.
- **Rule.** The index location must come from git, as `gitDir` does (`src/gitExec.ts:92`).
- **Failure.** In a clone whose `.git` is a gitfile (a linked worktree or a separated git dir), `existsSync(<root>/.git)` is true but `<root>/.git/index` does not exist. The stamp must then either throw, collapsing the whole stamp to `"none"` and losing worktree detection, or record `gone` permanently, which misses `git add` activity.
- **Correction.** Resolve the index with `git rev-parse --git-path index`, run in the same probe.

### codex 0155280a

**X1. A live busy indicator counts as activity**

- **Plan claim.** Reuse and Scope › Watchdog activity: quiet "additionally requires no recognized live busy indicator. An unchanged busy line resets the quiet baseline on every observation."
- **Rule.** A harness frozen mid-turn must still reach the one resend and `[WAIT]`.
- **Failure.** This is the same failure as M4: a stuck turn leaves `• Working (…)` or `◈ Thinking (…)` frozen on screen, and the agent is never quiet for the rest of the issue.
  - The plan's tests only check "unchanged busy line, then idle", so they cannot detect this.
  - Live spinners and timers already change `paneActivityDigest`, so the new signal changes outcomes only in the frozen case.
- **Correction.** Drop the busy predicate. With it go the `src/tmux.ts` and `test/tmux.test.ts` changes, which removes two of the nine files.

**X2. `run-*.log` terminal logs in the fingerprint**

- **Plan claim.** "Also observe regular `run-*.log` files in this agent's terminal directory by path/size/modification metadata."
- **Rule.** Watchdog evidence must exclude the composer and footer region. `paneActivityDigest` excludes it on purpose: "The owner's draft and the vendor footer/status line below the composer are ignored" (`src/tmux.ts:264-268`).
- **Failure.** `pipe-pane` (`src/tmux.ts:1169`) appends every byte the harness renders, including the composer and footer. Two cases follow:
  - An owner typing a draft into a stuck agent's composer grows the log, so the stall is never reported.
  - A footer or status line that repaints while the agent is idle grows the log every minute. A lost prompt is then never resent.

  This re-admits exactly the signals the existing digest was written to ignore. The plan's mitigation ("exclude render logs, lifecycle/journal writes") does not cover bytes inside the pane log itself.
- **Correction.** Drop terminal-log observation. The pane digest already covers what the log can legitimately add.

**X3. Scope and test volume**

- **Plan claim.** Exact File List: nine files, including `src/tmux.ts` and `test/tmux.test.ts`. Tests: hookSync coverage of "missing, untracked, staged-only, unstaged-modified, staged-modified, deleted, and wrong-outgoing-SHA artifacts … Cover local and coordinator verification modes", plus many watchdog parameterizations.
- **Rule.** Implementation discipline: the smallest change that fully solves the issue, with the fewest focused tests.
- **Failure.**
  - The tmux files exist only for X1's busy predicate, which is itself unsafe.
  - The artifact-state matrix runs real `git push` in installed hook fixtures. At 7 states × 2 modes, plus the exception and amendment cases, that is roughly 18 system-tier push scenarios, so the issue adds heavyweight system tests with mostly overlapping coverage.
  - The same plumbing check, blob presence plus worktree hash equality, distinguishes these states. One missing-artifact push, one dirty-artifact push and one clean push exercise every branch.
- **Correction.** Keep the guard semantics, but cut the test matrix to one case per guard branch. Drop the tmux files with X1.

The codex plan gets the guard semantics right, and they should be kept:

- the R4/R6 absent-signal exception;
- amendment requests at the same required path;
- inspecting the pushed SHA rather than `HEAD`;
- incomplete Git output treated as unavailable (the issue behind C2).

## Conclusion

None of the three plans should be implemented exactly as written.

- **muse 46547e48.** Not acceptable as written.
  - M1 blocks every R4/R6 product commit.
  - M2 contends with agents for `.git/index.lock`.
  - M3 breaks its own regression tests and permanently disables stall reporting for an unreadable clone.
  - M4 hides frozen turns.
  - M5 leaves its hook tests unrun.
- **codex 0155280a.** The guard semantics are sound and the test commands are correct. However, X1 and X2 can each permanently suppress stall recovery, and X3 over-scopes the change to nine files and a large system-test matrix.
- **claude 6630d4b4.** The smallest plan: no new files, no tmux or hook-shell changes, and no index-writing probe. It needs four corrections:
  - C1: fix the hookSync test command.
  - C2: no truncated `ls-files` output.
  - C3: suppress the warning on legitimate R4/R6 intermediate pushes.
  - C4: resolve the index via git.

**Recommended basis:** the claude plan with C1–C4 applied. It may adopt codex's guard semantics (the R4/R6 exception, and the dirty-signal check against the pushed SHA). Whether to block is the remaining design choice. The issue asks for an "immediate local error", and a blocking pre-push becomes safe once the R4/R6 exception is in place. Either way, the watchdog must gain only clone file and index activity, with errors mapped to a constant `"none"`, and no busy-indicator or terminal-log signal.
