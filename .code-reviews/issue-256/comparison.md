# Implementation comparison — issue 256

Bound implementation pins compared:

- muse `4d1f81306a72f6629cfc05fdb86d5c969ec7a18e`
- claude `f768700b2183852d0606e0877675314ff04c1acc`
- codex `4a41284dacb1380fa4687ef0ed7479b38f85a815`

Selected plan: codex `0155280a858a776d3e8db3acc00c87f5bddcc6cc`. Baseline: `d646aedcc21a43dde942c86c65b64aba649c1964`.

**Method.**

- I diffed each bound worktree against the baseline blobs for the nine approved paths.
- I measured this repository's `git ls-files -z --cached --others --exclude-standard` output (4,432 bytes, 184 paths) to size the codex probe bound.
- I ran no product suite for this comparison.
  - The claude pin's own focused runs (action, tmux, runLoop and the hookSync binding describe) and its pre-commit `pnpm check:fast` passed when it was produced. No coordinator-recorded results for any pin appear in this action, so none are cited.

## Comparison

### Scope and reuse

All three pins change exactly the nine approved paths (`src/action.ts`, `src/cli.ts`, `src/hookPolicy.ts`, `src/runLoop.ts`, `src/tmux.ts` and their four test files). They create no product files and add no dependencies. All three:

- reuse `readAction`/`parseAction`, `agentRuntimePaths`, `issueRuntimePaths`, the `git()` helper, `inFlightStatusLine`, `codexTurnChrome` and `museTurnChrome`;
- reuse the existing `installed`/`activeRun`/`stageWork`/`tryGit` and `safetyFixture` fixtures.

How each pin handles that shared scope:

- **muse:** the smallest diff (+273/−13). It copies the branch, clone and start resolution instead of sharing it with `resolveHookBinding`.
- **claude:** the largest test diff. It extracts that resolution into `issueBranchContext`, which keeps `resolveHookBinding`'s reason strings byte-identical, so the guard and the binding cannot drift apart.
- **codex:** also copies the resolution inline. It adds an action-digest check and reuses `inspectOutgoingChanges`/`isCoordinationEvidencePath` for the R4/R6 exception.

How each pin follows the selected plan:

- **Terminal logs:** the plan requires `run-*.log` observation. muse and claude implement it. codex deliberately omits it (comment at `src/runLoop.ts:2142-2143`), which is the plan-review hazard but a deviation from the selected plan.
- **Unchanged busy line:** the plan says it "resets the quiet baseline on every observation". muse and claude implement that literally. codex adds a five-minute bound and a resend veto while busy.

### Guard behaviour

| Behaviour | muse | claude | codex |
| --- | --- | --- | --- |
| Blocking pre-push, both verification modes | yes | yes | yes |
| R4/R6 product-before-signal exception | yes | yes | yes, and requires non-evidence outgoing paths |
| Staged/working divergence and non-HEAD SHA | yes | yes | yes |
| Gated on the cursor owing the action | no status check | `ordered/intent/verifying/failed/paused` | no status check |
| Action identity | actionId and agent | actionId and agent | actionId, agent and file digest |
| Inspection failure after an action is established | silent pass (`catch { return null; }`, `src/hookPolicy.ts:266-267`) | refuse | refuse |
| Literal pathspecs | no | yes | yes |

### Watchdog behaviour

| Behaviour | muse | claude | codex |
| --- | --- | --- | --- |
| Clone probe | sync `spawnSync` git, no timeout | async `processRunner`, 10 s | async `processRunner`, 5 s |
| Enumerated set | modified and untracked | modified and untracked | **all tracked** and untracked |
| Output bound | none (git `maxBuffer`) | ≥ 32 KiB is unavailable | ≥ 32 KiB is unavailable |
| Unavailable sample | defers | defers (verbose diagnostic) | defers, one `[WARN]` |
| Terminal logs | yes | yes | no (deliberate) |
| Frozen busy chrome | never quiet | never quiet | quiet after 5 min, then `[WAIT]` without resend |

### Test coverage

- **muse:** one push test (coordinator mode only, R2.plan) covering missing, clean and dirty states. It has no R4/R6 exception test, no local-mode test, one clone-edit watchdog test, no busy or unavailable watchdog test, and a small tmux case.
- **claude:**
  - a seven-state push sequence in both verification modes, plus non-HEAD SHA and remote-ref invariance;
  - the R4 exception, an untracked signal and an amendment request;
  - isolation (manual branch, response action, settled action, completed run, mismatched action);
  - five parameterized watchdog activity kinds, the ignored/bookkeeping case, incomplete enumeration, busy-then-idle, and tmux positives and negatives.
- **codex:** a comparable push sequence in both modes, the exception for both R4 and R6, digest-stale and isolation cases, watchdog edits across restarts, truncated and failed enumeration, frozen busy chrome reporting `[WAIT]`, and tmux cases.
- **Overlap:** claude and codex overlap heavily. Neither suite is unfocused, but both are larger than muse's.

## Findings

### codex 4a41284d

**X1. Enumerating every tracked file disables stall detection on ordinary repositories**

- **Location:** `src/runLoop.ts:2072` together with `src/runLoop.ts:2068`, `src/runLoop.ts:2077` and `src/runLoop.ts:2134-2140`.
- **Rule:** the clone probe's bound must scale with what changed, not with repository size. An over-limit sample may defer one decision, but it must not permanently replace the existing transcript, pane and tool-hook recovery for every agent.
- **Failure:**
  1. The probe lists `--cached --others`, which is every tracked path, not just modified ones.
  2. It treats ≥ 32 KiB of output, or more than 4,096 files, as unavailable.
  3. A product clone with 1,100 tracked files whose paths average 30 bytes yields about 33,000 bytes, so every observation throws.
  4. On every minute, `cloneStamp === null` then writes `unavailable:${now}` and returns before the quiet test.
- **Effect:** a Claude or Codex agent whose prompt was lost is never resent and never reported `[WAIT]`; only one `[WARN]` is logged. That is a regression of baseline behaviour for exactly the agents the old fingerprint already handled.
- **Why it isn't visible yet:** this repository (184 paths, 4,432 bytes) is below the bound, which is why the suites pass.
- **Smallest test:** in `test/runLoop.test.ts`, give `editingFixture()` 1,200 committed files named `src/components/module-0000/index.ts` and onward, keep the pane static, and advance three minutes. Today `f.ui.sends` stays 1; a correct implementation reaches 2.
- **Fix sketch:** enumerate `--modified --others` (dirty set only), as muse and claude do. Unmodified tracked files cannot change without becoming modified.

**X2. Unreadable runtime state blocks every push with a generic error**

- **Location:** `src/hookPolicy.ts:198`.
- **Rule:** the guard must keep the hook's existing behaviour when runtime state cannot be read. `resolveHookBinding` maps that case to "runtime state unavailable" and continues with local checks.
- **Failure:**
  - `readStartState` and `readCursorsState` run outside the guarded `try`. For an issue whose `start.json` exists but whose `cursors.json` is unreadable (corrupt, or left from an interrupted owner edit), the parse error escapes `assertRequiredArtifact`, and `runCli` prints `coord: Cannot parse …`.
  - Every push of `issue-N/<agent>` is then refused, even though no Git action can be established. The message is not path-specific, as the plan requires for refusals.
- **Smallest test:** in `test/hookSync.test.ts`, run `activeRun`, write `"{ corrupt"` to `paths.cursors`, then push `issue-1/claude` with passing local checks. Expect exit 0, matching the existing precommit fallback test.

**X3. Terminal-log observation omitted**

- **Location:** `src/runLoop.ts:2142-2143`.
- **Rule:** the selected plan requires `run-*.log` observation.
- **Failure:** a hookless agent whose only visible progress is terminal output, with an unchanged pane digest, is treated as quiet.
- **Assessment:** this deviation matches the hazard raised in plan review: raw logs include the owner's drafts and footer repaints. It is reported as a plan-fidelity gap, not as a defect to restore.

### claude f768700b (self-comparison)

**C1. Frozen busy chrome suppresses resend and `[WAIT]` forever**

- **Location:** `src/runLoop.ts:2138-2139` (`&& !vendorBusyIndicator(pane, agent)`).
- **Rule:** a harness frozen mid-turn must still produce one `[WAIT]` report.
- **Failure:**
  - An Antigravity turn that hangs with `⠋ Thinking…` frozen above the composer is busy on every observation. `quiet` is never true, so the owner is never told for the rest of the issue.
  - codex's pin shows the bounded alternative: quiet after five unchanged minutes, `[WAIT]` without typing into the turn.
- **Smallest test:** codex's "waits through unchanged busy chrome, reports frozen work once, and recovers after idle". On the claude pin, `stalled` stays at 0 after eight frozen minutes.

**C2. Raw terminal logs count owner drafts and footer repaints as activity**

- **Location:** `src/runLoop.ts:2089-2100` and `src/runLoop.ts:2123`.
- **Rule:** watchdog evidence must exclude the composer and footer, which `paneActivityDigest` (`src/tmux.ts:264-270`) deliberately ignores.
- **Failure:** `pipe-pane` appends whatever the pane renders. A vendor footer that repaints while the agent is idle (a clock or a context percentage), or an owner typing into a stuck agent's composer, grows `run-*.log` every minute. A lost prompt is then never resent, and the stall never reported.
- **Smallest test:** a static pane, plus `run-1.log` appended with `"footer 12:01\n"` each minute. Expect `f.ui.sends` to reach 2; on this pin it stays 1.
- **Plan fidelity:** this follows the selected plan literally. muse shares the defect; codex avoids it by deviating.

### muse 4d1f8130

**M1. Synchronous, unbounded git on the coordinator's event loop**

- **Location:** `src/runLoop.ts:2067` (`git(root, "ls-files", …)` via `spawnSync`).
- **Rule:** run-loop observation of an agent clone must be asynchronous and time-bounded, because it runs inside the single tick that serves every agent.
- **Failure:** `spawnSync` has no timeout. A clone with `core.fsmonitor` set to a hook that stalls, or a slow network filesystem, blocks the whole coordinator tick. That stops delivery, ready handling and acceptance for every agent until git returns. An `ENOBUFS` on more than 1 MiB of output is caught as "unavailable", but a hang is not.
- **Fix sketch:** use `this.processRunner` with `timeoutMs` and the 32 KiB truncation check, as claude and codex do.

**M2. Busy detection scans the whole pane and matches unanchored "esc to cancel"**

- **Location:** `src/tmux.ts:281-300`.
- **Rule:** watchdog busy evidence must be live, anchored status chrome near the pane tail, which the selected plan requires. Prose must never keep an agent non-quiet.
- **Failure:**
  - `/esc to cancel/i` is tested against every non-fenced line on screen, for Cursor, Antigravity and Claude.
  - An idle pane that shows prose such as "Press esc to cancel the turn" anywhere (an agent's review quoting vendor chrome, or this issue's text) is busy on every observation. The lost prompt is never resent.
  - The `claude` case also lets such prose suppress recovery for Claude, which the previous transcript fingerprint handled.
- **Smallest test:** in `test/tmux.test.ts`, `paneBusyIndicator("Review: Cursor shows \"esc to cancel\" while running.\n❯ ", "claude")` returns `true`; it must be `false`.

**M3. Inspection failures pass silently once the action is established**

- **Location:** `src/hookPolicy.ts:266-267` (`catch { return null; }`).
- **Rule:** once an owed Git action is established, inspection failures must refuse the push (selected plan: "Inspection failures must be errors, not success").
- **Failure:** any exception after the action is resolved inside the per-ref loop returns `null`, and the push proceeds. The plan's guarantee is lost exactly when inspection is degraded. Examples:
  - `git()` throwing because the clone's cwd became inaccessible;
  - `localConfigGet` failing.
- **Fix sketch:** narrow the `try` to the pre-establishment reads, and return a refusal from the inner failures.

**M4. No test of the R4/R6 product-before-signal exception, and no local-mode coverage**

- **Location:** `test/hookSync.test.ts` (one case, coordinator mode, `R2.plan`).
- **Rule:** the exception that keeps implementers unblocked, and the local verification mode this issue itself runs in, must each have a regression test.
- **Failure:**
  - A regression in `absentEverywhere` (`src/hookPolicy.ts:239-241`) would refuse every intermediate implementation push, and nothing in the muse suite fails.
  - The guard is also untested in local mode.
- **Smallest test:** claude's or codex's R4 case: push a product commit with the signal absent and expect exit 0; then add an untracked signal and expect a refusal.

### Recommendation

The three pins agree on the action wording and the blocking guard shape. They differ in watchdog robustness.

- **codex** has the best-bounded busy handling (no frozen-chrome hang) and correctly avoids terminal logs. However, X1 can silently disable all stall recovery on any medium-sized product repository; it is a one-flag fix (`--cached` to `--modified`).
- **claude** has the most complete guard. It uses a shared resolver, gates on owed status and refuses on inspection errors, and its watchdog probe scales with the dirty set. It carries C1 and C2 straight from the selected plan's literal text.
- **muse** has the most serious structural problem (M1, synchronous unbounded git in the run loop), plus whole-pane prose matching (M2), a silent-pass catch (M3) and the thinnest tests (M4).

**Preference order:**

1. **codex 4a41284d**, conditional on fixing X1, because its remaining issues are minor (X2) or deliberate (X3).
2. **claude f768700b**, with C1 and C2 corrected by porting codex's five-minute busy bound and dropping terminal-log observation.
3. **muse 4d1f8130.**

If X1 cannot be fixed in revision, claude's pin is the safer base, because its defects need a frozen or repainting pane to trigger. X1 triggers on repository size alone.
