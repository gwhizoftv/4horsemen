# Issue 186 — bound plan review

Protocol version: 1. Action: `12623556-b6b8-48eb-a163-47b78b6e173a`.

Reviewed the directly exported plans at these exact pins:

- Cursor: `d076173d30216e31583862e01bd12f5478c8ce44`.
- Claude: `25daecbd4dae7694a80e30b3b7c285b11e40ee8d`.
- Codex: `9a7921a29926ccade26cd73512bfd3f35ef316fa`.

## Findings

### 1. [P1] Claude and Cursor: exhausted submit attempts must not fall through to success

**Plan claim/section:** Claude's file map, submit-confirmation step (b), retains
the existing `sent`/`complete` outcome and tests a permanently stuck composer
only for a bounded key count. Cursor's file map and Conclusion finish a finite
four-key sequence, but prescribe uncertainty only when the composer clears
without proof, not when it still holds the nudge after the final key.

**Rule:** Once the plan adds submission confirmation, a positively observed
unsubmitted nudge at exhaustion cannot count as a confirmed successful send.
Bounded retries must terminate with explicit success evidence or a non-success
outcome that preserves the existing durable charge.

**Concrete failure:** All configured/retry keys can be ignored while the exact
nudge remains visible. Following either plan's stated return contract then
reaches today's unconditional successful return in `TmuxController.nudge`.
`RunLoop.deliver` clears the reservation and marks the action injected; its
lost-delivery recovery requires the action UUID to be absent, but that UUID is
still in the composer. The original unsubmitted-prompt stall remains despite
the new retries. Require a final confirmation check and a mid-send uncertainty
outcome on exhaustion; assert both the outcome and retained reservation, not
only the number of keys.

### 2. [P1] Claude: ordinary-path retries do not inherit the override's safety proof

**Plan claim/section:** File map, submit-confirmation step (b), sends an extra
`C-m` through the existing `send()` closure while the composer holds the exact
nudge; Risks says this rechecks the gate and, **on overrides**, acceptance and
turn chrome.

**Rule:** Every newly introduced retry must stop on current work, owner edits,
changed lifecycle/authority or a changed composer, regardless of whether the
initial send used a ready-file/sentinel override.

**Concrete failure:** On the ordinary path, the existing `send()` checks pane
process/copy-mode/input-off but does not recapture Codex readiness or check
lifecycle acceptance/activity. A turn can become active while the nudge remains
in the composer during the new settle/retry waits; the plan then presses `C-m`
into that active turn. The initial run-loop lifecycle check occurred before
those waits and cannot protect this later key. Reuse equivalent current
composer/readiness checks on the ordinary path too, keeping observation of
acceptance separate from permission to override stale lifecycle state. Test a
turn becoming active between captures with the nudge still in the composer.

### 3. [P1] Cursor: the unchanged ordinary `i` prelude defeats exact-message proof

**Plan claim/section:** The proposed `src/tmux.ts` changes extend exact-nudge
submission recognition to every path but do not change ordinary-path prelude
selection; the new tests omit an ordinary send beginning in vim INSERT.

**Rule:** The submitted/composer message used as delivery proof must match the
actual intended nudge. A mode-entry key must not be inserted as message text
when the composer is already in INSERT.

**Concrete failure:** The existing ordinary path sends the configured `i` even
when the footer says `Vim: Insert`, producing `iRead and execute …`. The planned
proof compares against `Read and execute …`, so it cannot recognize either the
draft or its submitted transcript as the exact nudge. The expanded recognition
can therefore still stop with uncertainty or strand this initial send. Apply
mode-aware prelude handling to ordinary sends and cover the INSERT case with
the existing stateful Codex pane fixture.

### 4. [P1] Cursor: the file map does not address the owner's added stale-issue requirement

**Plan claim/section:** Goal and Conclusion solve only composer submission and
false holds; the exact file list contains no launcher or other mechanism to
correct the stale issue context.

**Rule:** The accepted scope includes the owner's item 3: hooks/tool commands
must target the current issue, rather than continuing to use issue 139.

**Concrete failure:** Even perfect terminal submission leaves the stale
`COORD_ISSUE` source unchanged. The shell guard still names 139 and lifecycle
events can still miss issue 186, leaving its session unknown and its
containment probe unable to record. Include an issue-scoped launch fix and its
focused launcher test, not merely broader terminal recognition.

### 5. [P1] Codex: shell isolation does not explicitly isolate the shared hook server

**Plan claim/section:** “Issue-scoped launch context and diagnosis” disables
shell snapshots and sets `shell_environment_policy.set.COORD_ISSUE`, then
requires a fresh TUI process. It does not bypass the already-running shared
app-server.

**Rule:** Isolation must cover the process executing lifecycle/guard hooks as
well as spawned tool shells; a new TUI is not sufficient evidence that the
hook server received the new issue environment.

**Concrete failure:** Claude's bound diagnostic reports a shared daemon with
issue 139 and an issue-186 TUI connected to it. With that daemon retained, the
Codex plan does not establish a new hook-server environment: changing shell
snapshot/tool-command settings can leave lifecycle hooks on the old runtime.
Its smoke-test escape clause would detect the failure only after implementing
a plan that lacks this root-cause fix. Explicitly isolate the managed launch
from the shared daemon. The installed CLI's `--no-daemon` help confirms this
capability without killing the shared server. Verify actual hook and tool
identity after relaunch; do not infer containment from the flag alone.

### 6. [P2] Claude: the focused command skips its launcher regression test

**Plan claim/section:** Tests names
`pnpm exec vitest run test/tmux.test.ts test/install.test.ts` as the command
that runs both changed test files.

**Rule:** A named development command must actually execute each regression
suite it claims to run.

**Concrete failure:** The default `vitest.config.ts` explicitly excludes
`test/install.test.ts`; specifying its path does not move it into that tier.
The command exercises the tmux tests but not the new `--no-daemon` launcher
assertion. Use separate commands:

```sh
pnpm exec vitest run --config vitest.config.ts test/tmux.test.ts
pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts
```

### Scope, reuse and verification assessment

All three plans reuse the existing tmux helpers and test support and justify
their lack of new product files/dependencies. Cursor's changes are narrowly
focused but incomplete for the updated issue. Claude has the smallest proposed
file map covering all three symptoms and the strongest daemon diagnosis, but
its ordinary-path and terminal-outcome contracts need the corrections above.
Codex includes appropriately adversarial delivery tests and explicit final
confirmation, but its launch mitigation should use the narrower daemon fix
before adding snapshot configuration and probe-diagnostic changes. Prefer that
smaller scope unless separate evidence justifies the additional settings.

Review validation consisted of reading the three bound plans, the existing
send/reservation code, launcher generation and test configurations, and checking
the installed CLI help for `--no-daemon`. An attempted independent process
inspection was sandbox-denied; Claude's daemon PID/environment observations
remain attributed peer evidence, not measurements I reproduced. No service was
restarted and no product tests were run. There are no implementation pins or
candidate verification results in this action to certify.

## Conclusion

Request revisions; none of the three plans should be implemented unchanged.
Prefer Claude's scoped `--no-daemon` launch fix as the base, combined with
mode-aware typing and the explicit final-confirmation/every-key safety
requirements above. Preserve genuine uncertainty holds and validate actual
current-issue hook/tool identity after an owner-controlled fresh launch. Do not
restart a shared server or rewrite old runtime evidence to conceal the fault.
