# Consolidated revision requirements — `issue-1/codex`

**Author:** Codex

**Target implementation:** `04445b43078a419ad1d7c1b6025d3394048fbea0`

**Verdict:** retain Codex as the revision base, conditional on the blocking and
required fixes below.

## Resolution status on the current branch

**Resolved.** The requirements below are the audit of the original target
commit `04445b4`; they no longer describe the current PR head. The revision
implements R1–R14, bumps incompatible runtime state to format version 2, and
adds focused regressions plus an expanded four-agent canary. Current validation
has 101 focused tests and the separate origin-backed E2E tier.

Highlights of the landed resolution include scoped drop rederivation;
deterministic plan/implementation/reviser state; exact revision lineage and
phase-pin checks; locked monotonic cursor updates; typed owner questions;
transactional startup preflight; durable post-acceptance publication;
issue-aware digest sources; strict optional `commit ` completion parsing;
hermetic Git; confined launchers; clean wrapper stdout; and separate Vitest
tiers. The detailed failure scenarios below are retained as regression rationale.

## Sources and audit method

This document reconciles:

- Claude's revised requirements at `816576b`;
- Cursor's revised requirements at `dcd67ac`;
- the Codex comparison/recommendation at `4fd6377`; and
- the adopted `.plans/issue-1/plan.md` and
  `.plans/issue-1/workflow-algorithm.md`.

Every proposed requirement was checked against the target source. The two peer
documents agree on most concrete defects, but this consolidation strengthens
the selection/reviser fix, adds pin-lineage enforcement, and corrects the claim
that re-reading `cursors.json` once per tick makes owner controls concurrency
safe. It does not.

`nvm use 26 && pnpm check` passes on the target (46 focused tests and one
origin-backed four-agent canary). The green suite does not cover the defects
below.

## Acceptance gate

| ID | Requirement | Class |
| --- | --- | --- |
| R1 | Drop must preserve valid peer evidence and pending peer intent | **Blocking** |
| R2 | Selection, implementation choice, and reviser routing must be recomputed and persisted | **Blocking** |
| R3 | Product/revision pins must enforce lineage, file maps, and phase immutability | **Blocking** |
| R4 | Owner controls need concurrency-safe state updates and effect-layer pause/abandon guards | **Blocking** |
| R5 | Finalization publication must follow durable R7 acceptance | **Blocking** |
| R6 | `start` must preflight all knowable failures and leave no ambiguous partial run | **Blocking** |
| R7 | `coord answer` must cause a typed, durable state transition | **Blocking** |
| R8 | Automation digest inputs must be explicit and issue-correct | Required |
| R9 | Completion parsing must accept the optional `commit ` prefix | Required |
| R10 | Git subprocesses must be hermetic | Required |
| R11 | Launcher paths must be confined to their agent clone | Required |
| R12 | Wrapper rebuild output must not contaminate protocol stdout | Required |
| R13 | E2E tests need a separate timeout/configuration tier | Required |
| R14 | Predicate and control-plane negative coverage must meet the plan | Required |

This table was the pre-revision acceptance gate. Every row is now implemented
and covered in the current branch.

---

## R1 — Drop must preserve valid peer evidence and pending peer intent

**Defective code:** `src/cli.ts:109-127,228-244`.

`resetUnresolvedActions` deletes every acceptance for the current step, clears
every remaining agent's `complete`, deletes every action, and resets every
cursor. `dropAgent` already removes the dropped agent's current-step acceptance;
the second broad reset destroys unrelated verified work and unseen intent.

**Failure scenario:** three agents have valid R2 plans and the fourth is stuck.
Dropping the fourth erases all three accepted plans. In a second case, an active
peer writes a valid SHA just before the drop; the CLI deletes that intent
without evaluating or journaling it.

**Plan contract:** a drop is one owner-local roster change. It omits the dropped
agent from unresolved/future inputs without recomputing historical work or
discarding proof already verified at immutable origin commits. Active peers get
concrete rejection feedback when their old action no longer matches; their
intent is not silently thrown away.

**Required patch shape:** replace `resetUnresolvedActions` with a scoped
`rederiveAfterDrop` operation:

1. Call `dropAgent`, clear/delete only the dropped agent's operational files,
   and retain every other agent's accepted row.
2. Leave `complete` untouched for active agents.
3. For each active agent that still owes the current `(stepId, round)`, delete
   only its stale `action.md`, clear `actionId`, and let the next tick derive a
   new action from the reduced roster. Do not reset an already-satisfied peer.
4. Persist the roster/cursor change once, then tick so a newly satisfied
   denominator can advance.

The next action may reject a preserved old completion because it cites the
dropped agent; that rejection must flow through normal `outstanding[]`, not an
unobservable file deletion.

**Required tests:**

- Three accepted R2 plans survive dropping the fourth agent and the gate closes
  on the reduced denominator.
- A non-dropped agent's pending `complete` survives and is then either accepted
  or mechanically rejected with concrete outstanding work.
- An affected unresolved action is rewritten without the dropped agent's input.
- The dropped agent's stale completion is ignored and the final active agent
  still cannot be dropped.

---

## R2 — Selection, implementation choice, and reviser routing must be recomputed and persisted

**Defective code:** `src/evidence.ts:205-223,249-265`,
`src/runLoop.ts:129-167,315-366`, and `src/state.ts:280,378`.

The peer documents correctly note that the `reviser` field is parsed and then
discarded. Merely threading that claimed field into `cursors.reviser` is not a
complete fix:

- plan/comparison ballot `choice` is never checked against eligible bound
  inputs;
- a selection artifact may claim arbitrary `selectedAgents` without agreeing
  with a deterministic tally;
- reviser authorization may name any implementation pin and any agent without
  proving that the comparison ballots selected that implementation;
- `cursors.reviser` remains the first original roster member; and
- round-1 R6 inputs are every R4 implementation (`runLoop.ts:153`), not the
  authorized comparison winner.

**Failure scenario:** ballots select Cursor's implementation, while the first
roster entry publishes an authorization naming itself. The artifact passes as
long as it names any bound pin. R6 is ordered to the first agent and asks it to
revise every implementation, so R6/R7 can carry forward a result the voters did
not select.

**Plan contract:** plan/reviser routing is coordinator state. Selection and
authorization artifacts must have automated authority and agree with
recomputation over the exact active-roster ballot set.

**Required patch shape:**

1. Persist separate deterministic results for selected plan(s), selected
   implementation pin/agent, and reviser; do not overload the initial
   `reviser` fallback.
2. Validate every ballot choice against its bound eligible inputs.
3. Implement one documented tally and tie-break rule based on active roster
   order. Recompute selection/authorization from exact accepted ballot blobs.
4. When an agent publishes selection, reviser-authorization, or consensus
   declaration evidence, require its claimed result to equal coordinator
   recomputation. Alternatively materialize the coordinator-owned result
   without adding an agent-facing choice.
5. Reject an inactive/dropped nominee. Persist the authorized reviser through
   observation → decision → acceptance.
6. Bind R6 round 1 to only the selected implementation pin; later rounds bind
   to only the previous accepted revision pin. Route R6.revise, R6.declare, and
   R7.finalize to the persisted active reviser.

**Required tests:**

- Plan winner differs from roster[0] and is persisted deterministically.
- Implementation winner differs from the plan winner and roster[0]; only that
  pin feeds round 1 and only the authorized agent gets the R6 action.
- A claimed selection/authorization that disagrees with the ballots is
  rejected.
- Unknown/dropped choices and revisers are rejected.
- Tie-breaking is deterministic across restart and after a drop.

---

## R3 — Product/revision pins must enforce lineage, file maps, and phase immutability

**Defective code:** `src/evidence.ts:133-146,225-246,267-280`.

`pinErrors` checks reachability and baseline ancestry but never invokes the
copied `validatePhasePin`. Implementation and revision signal commits may add
product changes after their declared product pins. More critically, a revision
artifact only lists `basedOn`; the revised pin is not required to descend from
the selected implementation/prior revision, and no approved-file-map check is
performed for revision changes.

**Failure scenario:** the authorized implementation changes only approved
files. A round-1 revision names that implementation in `basedOn` but pins an
unrelated baseline descendant that changes an unapproved workflow file. It
passes and can become the consensus/finalization base.

**Plan contract:** pins are immutable product boundaries; implementation
changes stay within the adopted file map, revision history extends the exact
selected/prior pin, and only current-issue coordination files may follow a
product pin before its signal.

**Required patch shape:**

1. Reuse/adapt `validatePhasePin` for implementation, revision, and finalization
   signal separation so `pin..submissionSha` contains only allowed
   current-issue coordination changes.
2. Require the revision product pin to descend from its one exact authorized
   input pin. Do not treat a matching `basedOn` string as ancestry proof.
3. Check `inputPin..revisionPin` changed paths against the selected plan's
   approved file map, with current-issue coordination paths handled by the
   explicit policy rather than silently broadening the product map.
4. Keep `pin !== signal commit`, expected-branch reachability, and baseline
   ancestry checks.

**Required tests:** unrelated baseline descendant, unapproved revision path,
product change after a pin, cross-issue coordination change after a pin, valid
approved revision, and valid signal-only coordination commit.

---

## R4 — Owner controls need concurrency-safe updates and effect-layer guards

**Defective code:** `src/runLoop.ts:507-593,596-603` and whole-state writes via
`persist`; owner mutations are in `src/cli.ts:228-285`.

The peer requirements suggest a concurrency test but state that re-reading
`cursors.json` at the beginning of every tick makes Codex correct. That is not
enough. A tick can read cursors, await a fetch/check, then overwrite a drop,
pause, or abandon written by another process during that await. There is no
lock, generation, or compare-and-swap.

Pause/abandon are also consulted only by `decide`. `runTick` performs intent
journaling, fetches, verification, cursor writes, final checks, and currently PR
effects before `decide` sees the flag. `run()` checks pause only after the tick.

**Failure scenario:** `coord run` awaits an origin fetch. The owner drops an
agent and writes the reduced roster. The old tick resumes and persists its
stale full-roster snapshot, resurrecting the dropped agent. Similarly, a pause
during finalization can still run checks/publication before the machine returns
`wait`.

**Plan contract:** direct owner controls are durable authority. Pause preserves
state without consuming work; drop/abandon cannot be lost to the long-lived
loop.

**Required patch shape:** choose and document a single-writer or optimistic
concurrency design. A practical implementation is:

- add a monotonically increasing state revision;
- have every CLI/control mutation update it atomically;
- compare-and-swap tick decisions against the revision observed at snapshot;
- on mismatch, discard/re-observe rather than overwrite; and
- short-circuit before any boundary effect when paused/abandoned/completed,
  with a second revision/authority check before applying observations or
  external publication.

Do not hold a filesystem lock across slow network/check commands unless the
owner-control blocking behavior is explicitly accepted.

**Required tests:** use a deferred fake fetch/check to interleave drop, pause,
and abandon in the middle of a tick. The control must survive, the stale tick
must not persist, no paused completion is cleared/accepted, and no final check
or PR effect runs after the control becomes authoritative.

---

## R5 — Finalization publication must follow durable R7 acceptance

**Defective code:** `src/runLoop.ts:437-490,493-503`.

`verifyFinalizationChecks` pushes a `*-final` branch and opens a draft PR while
it is still constructing an observation. R7 has not been accepted into
`cursors.json`. Crash, pause, abandon, or a state-revision conflict can leave a
remote branch/PR whose corresponding finalization is not accepted.

**Plan contract:** cleanup verification and configured checks gate PR creation;
PR creation is a separate authorized capability; merge never occurs.

**Required patch shape:**

1. Make `verifyFinalizationChecks` perform only cleanup verification and checks.
2. Persist accepted R7 evidence first, including exact consensus/final pins and
   check results.
3. Represent publication as durable `pending | completed | failed` state or an
   equivalent journal-backed outbox. Then idempotently publish the final ref and
   open/find the PR. A crash between push and PR must reconcile rather than
   duplicate or forget the effect.
4. Record publication failure as owner-visible/retryable without discarding the
   accepted finalization.
5. Validate `coord-open-unmerged` origin compatibility during start (R6) and
   document that this policy creates an owner-visible remote final head.

**Required tests:** no push/PR during observation; failed check produces no
publication; accepted R7 publishes exactly once; crash after branch push
reconciles to one PR; pause/abandon/state-conflict before acceptance publishes
nothing; owner-only policy never writes origin.

---

## R6 — `start` must preflight knowable failures and leave no ambiguous partial run

**Defective code:** `src/cli.ts:150-189`, `src/tmux.ts:48-55`.

The CLI creates the external root and issue runtime before digest reading,
mirror initialization, tmux availability/session creation, and launcher
validation. `coord-open-unmerged`/origin compatibility is not checked until R7.
A failure can leave `start.json`, cursors, and a `started` journal for a run that
never launched.

**Plan contract:** start validates the external root/configuration before
writing, prepares the mirror, and launches through executable in-clone
launchers. A startup failure is named, not a half-started run mistaken for a
resumable one.

**Required patch shape:** preflight before creating issue operational state:

- strict config/profile/roster and external-root proof;
- real origin baseline;
- R8 digest sources;
- for `coord-open-unmerged`, a supported GitHub origin;
- contained, non-symlink, executable launcher for every roster agent; and
- tmux/mirror prerequisites.

Then either commit startup state only after effects succeed, or persist an
explicit startup transaction/status that restart can safely resume. Never leave
an apparently active run after an error.

**Required tests:** bad origin-policy pairing, missing digest source, escaping
launcher, non-executable launcher, mirror failure, tmux failure, and partial
agent-launch failure. Each must leave no active run (or one explicit resumable
startup state) and must report the named failing prerequisite.

---

## R7 — `coord answer` must cause a typed, durable state transition

**Defective code:** `src/cli.ts:219-225`.

`answer` appends arbitrary text to the journal and changes no state. The machine
does not read the journal. After a ballot escalation or revision-round limit,
the same `owner-action-required` result repeats forever regardless of every
`coord answer` invocation.

**Plan contract:** `coord answer` is the owner decision path when automation
cannot proceed. Owner-local commands replace signed authority paperwork, but
they still must be mechanically applied and auditable.

**Required patch shape:** define a small typed answer grammar and the exact
allowed state transitions for each pending owner question. Persist a question
identifier/kind and consume exactly one compatible answer; reject free-form or
stale answers. No answer may enter revision round 4 or create a merge effect.
If the accepted workflow has no answerable question, remove the command and its
claim from the public contract rather than keeping a successful no-op.

**Required tests:** compatible answer advances/updates the intended state;
wrong/stale answer is refused; answer survives restart; repeated answer is
idempotent; round 4 and merge remain impossible.

---

## R8 — Automation digest inputs must be explicit and issue-correct

**Defective code:** `src/cli.ts:166-177` hard-codes
`.plans/issue-1/plan.md` relative to the caller's current directory.

Starting issue 7 either hashes issue 1's plan or fails on an irrelevant path.
Define strict config-owned digest input templates (or a stable protocol-source
set), expand `{issue}`, resolve relative to the config/repository rather than
`cwd`, confine every path, and fail with the exact missing source. Persist the
scheme and source identity needed for agents to reproduce it.

**Tests:** issues 1 and 7 use their own declared inputs; changing cwd does not
change the digest; traversal and missing inputs fail before startup state.

---

## R9 — Completion parsing must accept the optional `commit ` prefix

**Defective code:** `src/action.ts:88-99` accepts only a bare lowercase SHA.

The workflow algorithm explicitly permits `commit <sha>`. Accept the bare or
prefixed lowercase 40-hex form with the normal optional final newline. Keep the
protocol strict: do **not** silently normalize uppercase SHAs, BOMs, extra
non-empty lines, or padded content unless the owner separately changes the
accepted design.

**Tests:** bare, prefixed, and each malformed form (empty, prose, JSON,
abbreviated, uppercase, leading/trailing padding, and multiple lines).

---

## R10 — Git subprocesses must be hermetic

**Defective code:** `src/mirror.ts:7-14` inherits cwd and all `GIT_*`
environment variables.

Strip `GIT_DIR`, `GIT_WORK_TREE`, index/object/common-dir/namespace/prefix, and
Git config redirectors; retain `GIT_TERMINAL_PROMPT=0`; default cwd to a neutral
temporary directory. Explicit `--git-dir`/`-C` arguments remain authoritative.

**Tests:** poison each relevant environment variable with an unrelated repo and
prove mirror initialization, fetch, blob reads, and worktree materialization
still target the mirror.

---

## R11 — Launcher paths must be confined to their agent clone

**Defective code:** `src/tmux.ts:48-55` resolves `agent.launcher` without
containment or symlink checks.

Use the same contained-path/realpath policy as other controlled paths. Reject
absolute paths, `..` escapes, intermediate/final symlinks, and non-executable
files before tmux creation.

**Tests:** valid in-root executable succeeds; traversal, absolute escape,
symlink escape, and non-executable launcher fail by agent name.

---

## R12 — Wrapper rebuild output must not contaminate protocol stdout

**Defective code:** `coord:4-6` runs `pnpm build` on stdout before `coord next`.

Redirect build output to stderr while preserving the command's exit status, so
stdout is exactly action markdown or `none yet`.

**Test:** stale `dist/` plus `coord next` yields stdout that begins with valid
action front matter and contains no build banner.

---

## R13 — E2E tests need a separate timeout/configuration tier

**Defective code:** `vitest.config.ts` gives the Git-heavy canary the same
15-second timeout as focused tests; `package.json` also lets bare `pnpm test`
select both tiers implicitly.

Add `vitest.e2e.config.ts` with only `test/integration.test.ts` and realistic
120-second test/hook timeouts. Keep the fast config excluding the canary. Make
`test:fast`, `test:e2e`, `check:fast`, and `check` explicit; `pnpm test` may
compose the two named tiers but must not discover them accidentally.

**Tests/checks:** both tier commands fail when their suite is missing and the
full `pnpm check` remains build + fast + e2e.

---

## R14 — Predicate and control-plane negative coverage must meet the plan

The canary is useful but the focused suite is too small to protect the driver.
Before acceptance add:

1. At least one positive and multiple negative fixtures for every evidence id:
   missing/wrong path, malformed schema/document, stale session/hash, unbound
   citation/choice, wrong branch/round, bad lineage, signal-as-pin, and file-map
   escape as applicable.
2. Regression tests specified by R1–R13.
3. Pure-machine invariants for all profiles, drop-to-solo, dispositions across
   rounds 1–3, escalation, and no round 4.
4. Action leakage tests proving no step/gate/evidence/attempt/global state is
   rendered.
5. Real/fake tmux tests, restart recovery, transient-versus-missing fetch, and
   cleanup/final-check/PR failure paths.
6. The deferred-boundary concurrency tests from R4.
7. An expanded four-agent canary where plan winner, implementation winner, and
   roster[0] differ; a peer has accepted work and another has pending intent at
   drop; round 1 requests revision; and finalization publishes no merge.

---

## Peer suggestions not adopted as fixes

### `COORD_ROOT` environment fallback

No change is required for the plan's explicit-start rule. `coord start` already
uses `requireFlag("coord-root")` (`src/cli.ts:154-157`); only commands operating
on an existing runtime use `COORD_ROOT`. Retain the operational fallback unless
the owner chooses a stricter CLI policy. `COORD_ISSUE` and `COORD_AGENT` remain
useful for agent pull mode.

### Loose completion normalization

Cursor's proposal accepts/normalizes uppercase SHA, BOM, and padded input. The
accepted protocol requires one exact SHA line and the Codex plan specifies
lowercase. R9 adds only the documented optional `commit ` prefix.

### Treating one cursor read per tick as concurrency protection

Rejected for the R4 reasons. A read at tick start does not prevent a stale
whole-state write after an awaited boundary.

---

## What must remain intact

- `cursors.accepted` keyed by `(stepId, agent, round)`; do not flatten it to one
  status/SHA per agent.
- Opaque UUID actions with exactly `actionId`, `agent`, and `requiredPath` in
  front matter.
- Transient verification as `retry`, preserving `complete` and emitting no
  artifact verdict.
- Active-roster filtering of bound inputs and the hard no-round-4 machine rule.
- Exact origin reachability and exact-commit blob reads.
- Atomic confined operational writes, Claude-only automatic nudge, explicit
  argv checks, cleanup-only R7 verification, and no merge capability.

## Definition of done

- [x] R1–R7 implemented with the named regression coverage.
- [x] R8–R13 implemented and documented.
- [x] R14 coverage floor met.
- [x] `pnpm check` passes under Node 26.
- [x] The expanded four-agent canary passes from a cold temporary
      origin.
- [x] `coord-open-unmerged` documents and tests the final-ref push; owner-only
      mode performs no origin write.
- [x] No peer implementation is wholesale-merged over the accepted Codex state
      model or R7 path.
