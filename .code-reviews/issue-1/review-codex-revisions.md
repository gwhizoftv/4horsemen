# Code review — Codex issue-1 revisions (`51caf7f`)

**Reviewer:** Cursor  
**Target:** `origin/issue-1/codex` @ `51caf7f` (PR [#3](https://github.com/gwhizoftv/coordination/pull/3))  
**Compared to:** merge-base with `main` (`14d052a`)  
**Authority:** `.plans/issue-1/plan.md`, `.plans/issue-1/workflow-algorithm.md`, `.code-reviews/issue-1/revise-requirements-codex.md`

## Findings

### [P1] Stop persisting a fabricated `trustedSourceCommit` — `src/cli.ts:336`

`coord start` always writes
`trustedSourceCommit: "01be9854919e1bf9a75f70ced7980d48d7150c28"` into
`start.json`. That object is not present in this repository (or reachable from
`51caf7f`), so every run records a provenance pin that cannot be audited or
reproduced. The field is required by `startStateSchema` and is part of the
session contract in the workflow algorithm; a hard-coded dead SHA makes the
durable baseline dishonest. Resolve it from a real source at start time (for
example `git rev-parse HEAD` of the coordination checkout that is running
`coord`, or another explicitly configured trusted commit) and fail closed if it
cannot be resolved.

### [P1] Do not wipe a committed start when the first `runTick` fails — `src/cli.ts:344`

After `initializeOperationalState` has already written `start.json` /
`cursors.json` / the journal, the same `try` still awaits `runTick()`. Any
throw from that tick hits `rmSync(paths.issueRoot)` and tmux cleanup. Startup
effects (mirror + agent launchers) have already succeeded by then; a transient
prepare/nudge/git failure therefore deletes a run that was durably started and
kills agent panes the operator just launched. R6 asked for no ambiguous
*partial* start, not for “first tick is part of the start transaction.” Keep
pre-state failures transactional; once operational state is committed, surface
the tick error and leave a resumable runtime (or use an explicit startup-status
record), instead of erasing it.

### [P2] Do not discard satisfied observations while an owner question is open — `src/machine.ts:63`

`decide` returns only `owner-action-required` whenever `ownerQuestion !== null`,
before it considers `observations`. `runTick` still marks agents `verifying` and
pushes evidence first (`src/runLoop.ts:811-838`), then calls `decide`, so a peer
completion that arrives during an escalation/limit wait is evaluated and
journaled as intent, then dropped on the floor. The agent stays `verifying`
with `complete` intact until `coord answer` clears it. Process observations
(or at least avoid the verifying transition) when a question is already open,
so in-flight work is either accepted or explicitly deferred without a stuck
cursor.

### [P2] Dropping the authorized reviser must not silently rebind R6/R7 — `src/cli.ts:221`

When drop clears `selection.reviser`, `rederiveAfterDrop` assigns
`implementationWinner` (possibly `null`) back into `cursors.reviser` without a
new reviser-authorization artifact. If that winner is missing, `decide` then
falls through to `planAgents[0]` / `activeRoster[0]` (`src/machine.ts:110-116`).
Either path can move revision/finalization onto an agent who was never
authorized. Fail closed (owner question / refuse the drop at R6+), or require
re-authorization, instead of inventing a successor reviser.

## Overall assessment

The revision pass lands the blocking revise-requirements set in substance: peer
acceptances survive `coord drop`, reviser identity is threaded through evidence
→ accept → R6/R7 routing, finalization checks no longer open PRs during
observation, publication is an accepted-state outbox, start preflights digest /
launcher / GitHub policy, `coord answer` is typed, digest paths are
issue-templated and config-relative, completion accepts `commit <sha>`, git
subprocesses are hermetic, launchers are contained, wrapper rebuild noise is on
stderr, and e2e has its own vitest config. Concurrency tests for pause / drop /
abandon mid-fetch are present and match the CAS + authority design.

The remaining defects are start-session honesty/transactionality and two
control-plane edge cases (owner-question vs in-flight evidence; reviser rebind
on drop). None look like the old class of “gate always stuck / PR during
verify” blockers.

## Material test gaps / residual risks

- No test that `trustedSourceCommit` equals a resolvable commit from the running
  coordination tree (or fails start when it cannot).
- No test that a failure in the post-state first `runTick` leaves
  `issue-<n>/start.json` intact and resumable.
- No test that a satisfied observation during an open `ownerQuestion` is
  accepted or explicitly deferred without leaving `verifying` + uncleared
  `complete`.
- No test that dropping the authorized reviser at R6/R7 refuses or re-auths
  rather than routing to roster/plan fallback.
- Shared `coord-root/mirror.git` across issues is still a single writer by
  convention only; concurrent issues on one runtime remain an operational risk
  outside this diff’s new locks.
