# Issue 140 plan review

Protocol version: 1. Bound inputs reviewed:

- cursor `76116be8f36c46d59c4558f704216bacb4e2b087` — `.plans/issue-140/plan.md`
- codex `834e74bf431c9b12adf5706233181eb8b47b0658` — `.plans/issue-140/plan.md`
- claude `301e148296e001b97191b7e3a97e5fc98a8323f4` — `.plans/issue-140/plan.md`

Claims were checked against baseline `5b2c305` (`src/runLoop.ts`, `src/state.ts`, `src/agentHookSync.ts`,
`docs/coord-driver.md`).

## Findings

### F1 — claude and cursor: the deadline recheck never runs because `run()` exits on any hold (blocking)

- **Plan claim.** claude § `src/runLoop.ts`: "`maintainResourceHolds()` runs at the top of `runTick`, … before
  the `paused` early return", and recovery "runs on the existing `runTick` cadence". cursor § `src/runLoop.ts`:
  "run due resource observations before pause return; schedule exact-deadline rechecks at epoch+30s".
- **Rule.** A scheduled recheck has to run in a process that is still alive when the deadline arrives.
- **Failure.** At baseline, `run()` (`src/runLoop.ts:2441-2458`) returns right after the first tick that ends
  `paused`, and it returns before `initializeEffects()` if the issue starts paused. Suppose a Claude
  `rate_limit` hold is created with `resetsAt` five hours away. The tick sets `paused: true`, `run()` logs the
  report and returns, and no later tick runs. The `resetsAt + 30 s` evaluation and every scheduled Codex
  `recovery.nextAt` read are never reached. Restarting `coord` does not help, because `run()` returns again on
  the paused precheck. So the automatic recovery both plans describe cannot happen. The test cases in claude
  tests 10/12 and cursor's run-loop cases call `runTick()` directly and would pass anyway.
- **Correction.** Adopt codex's paragraph. `run()` stays alive only while a resource hold has authorized, due
  or scheduled observation work. It sleeps on the existing clock and does not call `initializeEffects()` or
  attach or launch agents while held. Add one `run()`-level test with a fake clock: the hold is created, the
  deadline passes, and exactly one recheck happens.

### F2 — claude and cursor: the Claude tee inherits the Antigravity wrapper, which is not byte-exact and invents a display

- **Plan claim.** claude § `src/agentHookSync.ts`: "Generalize the Antigravity status-line multiplexer … pipes
  the same bytes to the downstream command, so stdout is exactly the owner's". Test 7 says stdout "matches the
  owner command byte for byte". cursor: "Claude statusline tee (mirror Antigravity pattern)".
- **Rule.** The tee must pass the owner's stdin bytes through unchanged. When the owner has no statusline, it
  must not add a display.
- **Failure.** `renderStatusLineWrapper` (`src/agentHookSync.ts:314-327`) captures `payload="$(cat)"`, which
  strips every trailing newline, and forwards it with `printf '%s'`. An owner script that reads a line (`read
  -r line`, `jq -R`) gets no terminating newline, so a `read` returns non-zero and the display breaks. When
  `downstream === null`, the wrapper prints `coord lifecycle`. Under claude's precedence (local → project →
  user), a Claude owner with no statusline would start seeing the text "coord lifecycle" in every clone. The
  byte-for-byte test as written runs `cat` or `printf` fixtures that do not depend on newlines, so it would
  miss this.
- **Correction.** Use codex's wrapper contract: forward the original bytes (for example, `tee` into the
  receiver instead of `$(cat)`), print nothing when there is no owner command, and test with a payload that
  ends in `\n` and an owner command that uses `read`.

### F3 — claude and cursor: resolving the effective statusline ignores managed and CLI layers, and cursor does not say where the tee is installed

- **Plan claim.** claude: precedence is "local `statusLine`, then `<clone>/.claude/settings.json`, then
  `~/.claude/settings.json`". cursor gives no install location. It says "mirror Antigravity", and that pattern
  writes a user-global settings file.
- **Rule.** The tee must record the command Claude actually runs. When precedence cannot be proven, it must
  disable telemetry instead of guessing.
- **Failure.** Managed settings, or a `--settings` flag from the launcher, can override `settings.local.json`.
  claude's plan then records a downstream command that Claude never runs. The tee may also be shadowed, so
  telemetry silently never arrives and every Claude hold stays `unknown`, while `inspect` reports `installed`.
  If cursor follows the Antigravity layout literally and writes `~/.claude/settings.json`, it changes the
  statusline of every Claude session the owner runs, including ones outside coordination.
- **Correction.** Adopt codex's rule: install a clone-local override only when precedence can be proven, and
  report a doctor diagnostic when it cannot. Name the clone-local target file explicitly.

### F4 — claude: a Claude hold is released on `prompt-submitted` before the retried turn has shown that capacity came back

- **Plan claim.** claude § step 2: release when "the same session later produced a non-failure lifecycle
  boundary (`stopped`/`prompt-submitted`) whose timestamp is after `resetsAt`" and "no `lastFailure` is newer
  than that boundary".
- **Rule.** Release evidence has to show that capacity is available. Seeing that a retry was attempted is not
  enough.
- **Failure.** Claude's native auto-continue submits a prompt at the reset. The evaluation runs on that
  `prompt-submitted` boundary before the turn's `StopFailure` arrives, sees no newer failure, and releases the
  hold. A second `rate_limit` a few seconds later needs a new hold, and the coordinator may send a nudge in
  between, racing native retry ownership. That is the case the issue forbids.
- **Correction.** Count only a same-session `stopped` (successful turn end) after `resetsAt` as a release
  boundary. Add a case to test 10: `prompt-submitted` followed by `StopFailure` never releases.

### F5 — cursor: per-binding Codex exclusion has no cross-issue store

- **Plan claim.** cursor § Behavioral scope 6: "Per account/home: one helper in flight, ≤1 start / 5 minutes".
  The only place it persists anything is `src/state.ts` (per-issue `cursors.json`).
- **Rule.** The one-in-flight and five-minute spacing caps apply to each binding, and a binding can be shared
  by several issues in the same owner runtime.
- **Failure.** Two issues whose Codex agents share one `CODEX_HOME`/`accountId` each keep their own
  `cursors.json` counters. Both reserve and spawn `codex app-server` at the same moment, which breaks "one
  helper in flight" and the spacing cap. Neither cursor's state tests nor its run-loop tests would detect this.
- **Correction.** Keep the reservation in a binding-keyed file under a lock: codex's `src/paths.ts` lock or
  claude's `<coordRoot>/codex-probes/<hash>.json`. Add that path to the file list.

### F6 — cursor: the plan never says what releases a Claude hold

- **Plan claim.** cursor § Behavioral scope 4: "Recheck once at exact epoch+30s; a new statusline render is not
  proof of newly fetched capacity". The run-loop tests list "deadline+30s once".
- **Rule.** Each automatic-release path needs a stated positive condition, or needs to be explicitly
  owner-only.
- **Failure.** The plan does not say what the recheck examines or what counts as a pass. One implementer could
  release on a later cached render, which the same sentence forbids. Another could never release. Reviewers
  would have no rule to check the result against.
- **Correction.** State one option. Either (a) codex's choice: Claude holds are always released by the owner,
  and the recheck only updates the report. Or (b) a same-session successful `stopped` after `resetsAt` (see
  F4).

### F7 — claude and codex: `docs/coord-driver.md` is left contradicting the shipped behavior

- **Plan claim.** claude does not change any documentation. codex changes `README.md` only.
- **Rule.** User-facing driver documentation must not describe removed limitations.
- **Failure.** `docs/coord-driver.md:525-534` says there is "no automatic recovery, vendor API polling,
  statusline installation" and that native completion-based recovery "belongs to #140". After either plan
  ships, this page says the opposite of what the code does, and it is where #126 users were pointed.
  `README.md` currently has no hold or quota section, so codex's README addition would be a second,
  disconnected description.
- **Correction.** Replace that `docs/coord-driver.md` section, as cursor's plan does. Change README only if a
  pointer is needed.

### F8 — codex: the episode budget cannot be renewed by an owner release

- **Plan claim.** codex § Durable scheduling: "Preserve counters across hold enrichment and owner
  acknowledgment of the same unresolved action; only genuinely new work starts a new episode."
- **Rule.** The budget cap stops probe storms inside one unresolved episode. An owner releasing the hold ends
  that episode, as `releaseHold` already does for `observationChecks` (`src/state.ts:1139`).
- **Failure.** Suppose a long Codex action hits its weekly limit on Monday and uses its six starts, and the
  owner releases the hold. On Thursday the same action hits the five-hour limit. No read is allowed, so the new
  hold stays `unknown` with no exact deadline, even though the owner explicitly acknowledged the first
  episode. This is conservative rather than unsafe, but the Codex recovery feature is lost for the rest of the
  action.
- **Correction.** Reset the probe episode inside owner `releaseHold`, as claude's plan does. Restarts, wording
  changes and shifted deadlines still never replenish it.

### F9 — scope notes (non-blocking)

- cursor offers an optional "banked-reset availability display". codex leaves it out to keep scope small.
  Drop it; nothing in the issue requires it.
- codex's Claude receiver ("bounded synchronous receiver or awaited child") puts a cold Node start on every
  statusline render. Claude's plan rejects that for latency. The implementation should keep the receiver
  asynchronous and bounded (one in flight, with drops) rather than awaited.
- claude adds `test/support/fixtures/codex-rate-limits-0.155.1.json`. An inline sanitized table in
  `test/codexLimits.test.ts` (codex's approach) avoids adding a fixture file.
- codex adds `src/doctor.ts`/`test/doctor.test.ts` diagnostics. They are justified by F3's
  "disable-on-ambiguity" rule, because otherwise an owner gets no signal that the tee is inert.

### Scope and reuse

All three plans stay within #140. None of them reopens #126 deferral, nudge spacing or the 4-send breaker. All
three reuse `hold()`, `actionSafety`, `appendJournal` idempotence and the lifecycle observation path, and all
three reject subscriptions, usage polling, reset-credit consumption and parsing of rendered clock text. Each
plan also:

- keeps classification confidence separate from deadline confidence;
- preserves every blocking window;
- refuses to map opaque Codex bucket IDs to models;
- adds a resource-only release that leaves the manual pause, other holds and the nudge budget alone. codex
  explicitly avoids the owner `releaseHold` side effects, and claude adds `releaseResourceHold`.

New-file justifications are adequate in all three plans. Each one splits out a pure classifier and an
isolated subprocess adapter. codex's separate `src/claudeStatusLine.ts` is justified by F2.

## Conclusion

No plan can be implemented as written. Four findings block: F1 (claude, cursor), F2 (claude, cursor), F4
(claude) and F5 (cursor). codex's plan is the strongest base. It is the only one that keeps `run()` alive for
authorized observation, requires a byte-exact tee with proven precedence, serializes per-binding reads across
issues, and fences results against pause, action changes and lifecycle races. Adopt codex's plan with these
corrections:

- replace the stale `docs/coord-driver.md` section (F7);
- reset the probe episode on owner release (F8);
- keep the statusline receiver asynchronous (F9);
- optionally, take claude's concrete Codex exhaustion and clearance predicates (`ordinaryUsageAllowed`,
  `spendControlReached`, latest-blocking-epoch scheduling) and its Claude `stopped`-after-reset release
  condition (with F4 applied), if the owner wants Claude recovery beyond owner release.
