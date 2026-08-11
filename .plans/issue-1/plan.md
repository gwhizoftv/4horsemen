# Issue 382 plan — Codex

## Context and binding decisions

Issue 382 replaces agent-driven phase interpretation with an owner-side workflow
driver. The driver gives each agent one concrete action, accepts an exact pushed
commit SHA as the agent's completion intent, verifies the required artifact in
that commit, and advances only after the corresponding mechanical predicate
passes.

This plan treats Cursor's `.plans/issue-382/workflow-algorithm.md` at commit
`c894fae9bd4068d2bf45bf6fd01a359801e9d137` as the accepted design for all four
implementations. The owner has also fixed `maxRevisionRounds` at **3**,
overriding the example value of 5 in that design. Amendments are removed: the
driver has no amendment step. Automatic consensus declaration and creation of
an unmerged PR are permitted by the owner-local coordinator policy; merging
remains owner-only. This issue is being
developed with automation off and no barriers; that affects only how this plan
is coordinated, not the workflow driver being built.

There is no backward-compatibility requirement between the new driver and the
legacy automation CLI, schemas, runtime state, or tests. `automation/` remains
unchanged as a frozen reference implementation. Selected self-contained files
may be copied at the implementation baseline, but `coordination/` becomes the
only version maintained going forward and may diverge without synchronization.

## Proposed architecture

Implement the driver as a new, standalone root-level package under
`coordination/`. Every tracked implementation, configuration, test, executable,
and operator-documentation file for the driver lives there. Do not extend or
import the existing phase-oriented `automation/` implementation; the new
package owns its protocol schemas, control loop, operational-state model, Git
snapshot logic, evidence evaluation, tmux integration, and CLI.

The coordinator owns a runtime `coord/` tree in the owner's control folder,
outside every configured repository clone. A required `--coord-root` is
containment-checked against all configured agent roots before anything is
written. Each action is materialized as `action.md`, with an absolute
completion-file path in its human instructions. The agent-facing file contains
the concrete task but no `stepId`, `gateId`, phase, evidence-predicate ID, or
global workflow status; those remain in owner-side coordinator state. No
`action.json` is introduced. An agent signals intent by writing one pushed
commit SHA to the `complete` file. The coordinator polls the file, proves that
the SHA is reachable from the expected origin issue branch, and evaluates blobs
at that exact SHA through its bare mirror. Branch-tip movement is liveness
information, not completion evidence.

The state machine is deterministic and separated from I/O. Git, filesystem,
clock, process, and tmux operations are injected boundaries so the main loop can
be tested without real agent harnesses. Runtime state is recoverable from
origin evidence plus `start.json`, `cursors.json`, `action.md`, `complete`, and
the append-only journal.

## Exact file map

### New production files

1. **`coordination/.gitignore`** — ignore this package's `node_modules/`,
   `dist/`, coverage, and temporary test output.
2. **`coordination/package.json`** — private Node 26 ESM package with build,
   typecheck, lint, test, and check scripts plus pinned Zod/tooling dependencies.
3. **`coordination/pnpm-workspace.yaml`** — make `coordination/` an independent
   one-package pnpm workspace without changing the repository root workspace.
4. **`coordination/pnpm-lock.yaml`** — standalone reproducible dependency lock.
5. **`coordination/tsconfig.json`** — strict NodeNext TypeScript build from
   `src/` to `dist/`.
6. **`coordination/vitest.config.ts`** — focused unit/integration test config.
7. **`coordination/eslint.config.mjs`** — standalone strict TypeScript lint
   configuration.
8. **`coordination/coord`** — executable wrapper that builds when needed and
   invokes `coordination/dist/main.js`, giving owner and agent panes a stable
   `coord` command.
9. **`coordination/src/paths.ts`** — resolve the external runtime
   `coord/issue-<n>/` tree, containment-check every derived path, reject
   symlinks, and refuse a runtime root inside any configured agent clone.
10. **`coordination/src/state.ts`** — strict Zod schemas and atomic I/O for
    `start.json`, `cursors.json`, and `journal.jsonl`; original and dropped
    roster state; runtime format version; pause state; and restart reconstruction.
11. **`coordination/src/action.ts`** — keep the internal order and rendered
    agent action as distinct types; render/parse the restricted `action.md`,
    parse and clear `complete`, and place exact expected input commits in the
    human task text without serializing internal step/gate/phase/evidence IDs.
12. **`coordination/src/protocol.ts`** — driver-owned Zod schemas and helpers for
    the published join, plan, ballot, implementation, comparison, revision,
    consensus, and finalization artifacts the evidence predicates consume.
    Selectively adapt the required primitives, envelope/citation rules, and
    artifact schemas from `automation/src/schemas.ts`; do not copy that file or
    import it. Omit its amendment, signed owner-override/drop, and escalation-ID
    types. The coordination schemas become the maintained definitions; changes
    are not backported to the frozen automation schemas.
13. **`coordination/src/mirror.ts`** — owner-side bare-mirror setup, explicit
    origin ref fetching, transient-failure classification, submission-SHA
    reachability, exact-commit blob reads, ancestry, and changed paths.
14. **`coordination/src/steps.ts`** — coordinator-internal step, gate, and
    evidence identifiers; profile participants, step table, gate denominators,
    path templates, and defaults including `maxRevisionRounds: 3`. These IDs
    are never part of the agent-facing action schema.
15. **`coordination/src/evidence.ts`** — the
   `isSatisfied(action, submissionSha)` predicate registry. It checks the exact
   required path, required document sections, driver-owned protocol schemas,
   issue/session/agent/digest fields, bound inputs, citations, rounds, pin
   ancestry, signal-commit separation, and approved implementation file maps.
   Failures return concrete stable `outstanding[]` values rather than a generic
   missing-agent result.
16. **`coordination/src/machine.ts`** — pure observations-to-decisions reducer,
    intent/proof matrix, advisory attempt counts, gate advancement, owner drop
    handling, plan/reviser routing, revision accounting, and finalization
    policy. Attempt counts never cause an automatic drop or advance.
17. **`coordination/src/tmux.ts`** — tmux session/window creation,
   per-agent `start-<agent>.sh` launch, foreground-process and pane checks,
   `load-buffer`/`paste-buffer` delivery, harness disappearance detection, and
   the nudge policy. Automatic non-Claude nudging remains disabled until an
   explicitly supported idle fixture proves it safe.
18. **`coordination/src/runLoop.ts`** — effectful polling/orchestration loop:
    prepare actions, snapshot intent, fetch/verify, re-order with precise
    outstanding work, apply owner controls, recover pushed-then-died work, and
    wait without busy-spinning.
19. **`coordination/src/cli.ts`** — strict parsing and stdin/stdout handling
    for `start`, `run`, `next`, `answer`, `drop`, `pause`, `resume`,
    `restart-action`, and `abandon`. It defines a new testable CLI API and exit
    contract without preserving legacy automation command or export shapes.
20. **`coordination/src/main.ts`** — import-safe process entry and exit-code
    mapping, separate from the testable CLI module.
21. **`coordination/docs/coord-driver.md`** — owner operations, directory
    topology, command examples, profiles, tmux attachment,
    indefinite waiting, agent drop semantics, recovery, and explicit
    confirmation that the coordinator can never merge.
22. **`coordination/config.example.json`** — documented portable roster,
    clone-root, branch-template, harness, and PR-policy configuration example.
23. **`coordination/config.consensus-ai.json`** — this project's four-agent
    coordinator configuration, without owner-signing keys, including explicit
    argument-vector check commands used before finalization/PR creation.
24. **`coordination/.nvmrc`** — Node major declaration, copied unchanged from
    the repository root `.nvmrc`.
25. **`coordination/test/tsconfig.json`** — test typecheck configuration, copied
    unchanged from `automation/test/tsconfig.json`.
26. **`coordination/src/hash.ts`** — SHA-256 helpers, copied unchanged from
    `automation/src/hash.ts`.
27. **`coordination/src/pinValidation.ts`** — NUL-safe Git range parsing,
    ancestry, pin immutability, and coordination-path checks, copied unchanged
    from `automation/src/pinValidation.ts`.
28. **`coordination/src/finalization.ts`** — cleanup-only finalization verifier,
    copied unchanged from `automation/src/finalization.ts`.

### New test files

1. **`coordination/test/action.test.ts`** — restricted front-matter round trips,
   opaque action IDs, expected-input rendering, proof that internal
   step/gate/phase/evidence fields are never emitted, and every malformed
   `complete` form.
2. **`coordination/test/state.test.ts`** — schema strictness, runtime format,
   default revision limit of 3, atomic writes, journal recovery, indefinite
   waiting, persisted dropped agents, and pause/resume.
3. **`coordination/test/protocol.test.ts`** — strict published-artifact schemas,
   cross-field/session validation, and rejection of unknown or stale inputs.
4. **`coordination/test/mirror.test.ts`** — external-root refusal, real bare
   origins, exact-SHA reads, wrong-branch SHAs, ancestry, changed paths, and
   transient fetch outage distinct from absence.
5. **`coordination/test/evidence.test.ts`** — positive and negative
   fixtures for every predicate in the accepted design, including missing or
   wrong paths, malformed documents, stale hashes, incorrect pins/rounds, and
   signal commits incorrectly used as product pins.
6. **`coordination/test/machine.test.ts`** — intent/proof matrix, profile
   denominators, four-agent ordering, indefinite wait and re-order after any
   number of failed submissions, immediate local drop, exact omission of all
   dropped-agent inputs, degradation to solo at one agent, refusal to drop the
   final agent, and rounds 1–3 with no round 4.
7. **`coordination/test/tmux.test.ts`** — fake-runner unit coverage
   plus a throwaway real tmux socket when tmux is available, covering launch
   targets, buffer-based insertion, busy panes, owner typing, missing harnesses,
   Claude nudge behavior, and non-Claude pull-only behavior.
8. **`coordination/test/runLoop.test.ts`** — poll/verify/reorder
   behavior, simultaneous agents, invalid and unpublished SHAs, transient fetch
   failures that preserve `complete` and emit no artifact verdict, crash
   boundaries, idempotent restart, ignored post-drop completions,
   pushed-then-died escape, wait/drop/pause/abandon semantics, and proof that a
   failed configured final check blocks PR creation.
9. **`coordination/test/cli.test.ts`** — every public command, stable exit
   codes, required `--coord-root`, `coord drop A`, refusal to drop the final
   active agent, agent identity for `next`, and proof that `next` exposes no
   peer, step, gate, evidence ID, or global phase state.
10. **`coordination/test/integration.test.ts`** — a four-agent
    temporary-origin canary with fake harnesses covering start, action delivery,
    exact-SHA completion, dropping one unavailable agent, action inputs that omit
    it, gate advancement, one revision, consensus declaration, and finalization
    without a merge.
11. **`coordination/test/hash.test.ts`** — copied unchanged from
    `automation/test/hash.test.ts`.
12. **`coordination/test/finalization.test.ts`** — a new standalone adaptation
    of `automation/test/finalization.test.ts`. Retain the useful cleanup,
    ancestry, rewrite, and changed-path cases, but replace the old CLI
    compatibility assertions with the new R7 coordinator behavior.
13. **`coordination/test/pinValidation.test.ts`** — a new standalone adaptation
    of the existing pin tests. It cannot be copied unchanged because the old
    test imports the legacy automation `git-fixture.ts` dependency graph.

### Byte-for-byte copies

The following destinations are created with contents exactly equal to their
sources at the issue baseline. Run `cmp -s <source> <destination>` for each pair
before the implementation commit; any necessary semantic change instead gets a
new coordination-owned module or test rather than silently altering a claimed
copy. This equality claim applies only to the initial implementation baseline;
afterward these coordination-owned copies may evolve independently while their
automation sources remain frozen.

| Existing source | New destination | Why it is safe to copy unchanged |
| --- | --- | --- |
| `.nvmrc` | `coordination/.nvmrc` | Declares Node 26 only |
| `automation/.gitignore` | `coordination/.gitignore` | Ignores only package build/runtime output |
| `automation/pnpm-lock.yaml` | `coordination/pnpm-lock.yaml` | New package declares the same dependency versions |
| `automation/tsconfig.json` | `coordination/tsconfig.json` | Generic strict `src` → `dist` NodeNext config |
| `automation/test/tsconfig.json` | `coordination/test/tsconfig.json` | Generic test typecheck config with the same relative layout |
| `automation/vitest.config.ts` | `coordination/vitest.config.ts` | Generic `test/**/*.test.ts` Node runner config |
| `automation/eslint.config.mjs` | `coordination/eslint.config.mjs` | Generic strict TypeScript flat config |
| `automation/src/hash.ts` | `coordination/src/hash.ts` | Self-contained Node hashing helper |
| `automation/src/pinValidation.ts` | `coordination/src/pinValidation.ts` | Self-contained Git subprocess and path-policy helper |
| `automation/src/finalization.ts` | `coordination/src/finalization.ts` | Depends only on the copied sibling `pinValidation.ts` |
| `automation/test/hash.test.ts` | `coordination/test/hash.test.ts` | Depends only on the copied sibling hash module |

### Existing files modified

**None.** The implementation is additive-only. The owner-local control process
is the authority boundary: commands typed into `coord` take effect directly and
are journaled for restart/audit, without signatures or approval files. The
program exposes no merge operation. Existing agent instructions, manual
automation-OFF behavior, and legacy automation behavior remain unchanged.

In particular, `AGENTS.md`, everything under `automation/`, the root
`pnpm-workspace.yaml`, current barriers, hooks, and launcher scripts remain
byte-for-byte unchanged. The standalone package supplies its own workspace,
lockfile, compiler, lint, and test configuration entirely under
`coordination/`.

## Public commands and internal APIs

The supported external surface is the new `coordination/coord` executable:

- `coord start <issue> --profile <solo|reviewed|consensus> --config <path> --coord-root <external-owner-path>`
- `coord run`
- `coord next`
- `coord answer ...`
- `coord drop <agent>`
- `coord pause`, `coord resume`, `coord restart-action`, and `coord abandon`

`start` requires the owner to name `--coord-root` explicitly and proves it is
outside every configured clone before writing. It then records the baseline,
original roster, branch template, digest, trusted source commit, PR policy, and
revision limit. For the consensus profile used by this project, the original
roster is the four configured agents. `run` is the long-lived owner
control-plane process. `next` exposes only the calling agent's current action or
“none yet,” never peer, step, gate, evidence-predicate, or global phase state.

The main typed seams are:

- state/action helpers for operational state and recovery;
- mirror helpers for origin-only immutable evidence;
- `evaluateEvidence(...) -> { ok, outstanding[] }`;
- `decide(...) -> readonly Decision[]` as the pure machine;
- tmux helpers for launch/liveness/nudge behavior;
- `runTick(...)` and `runLoop(...)` for effectful orchestration.

These are implementation-level exports inside the new directory. The public
package barrel is intentionally unchanged; the CLI is the supported product
boundary.

## Required behavior

1. `start` validates the external control root and configuration, creates the
   bare mirror and operational state, and launches
   attachable tmux agent sessions through each clone's existing
   `start-<agent>.sh`. A missing/non-executable launcher is a named startup
   failure, never a fallback to a bare shell.
2. Every order writes an `action.md` containing an opaque coordinator-generated
   `actionId`, `agent`, and `requiredPath`, plus only the concrete human task,
   exact input commits needed for that task, and the absolute completion path.
   The opaque ID does not encode a step, gate, or phase. `stepId`, `gateId`,
   phase, evidence ID, denominators, and global cursor state stay in
   `cursors.json`/the journal and are never rendered by `action.md` or `coord
   next`.
3. A parseable SHA in `complete` is intent. Empty/malformed completion files and
   incidental branch-tip changes never advance work.
4. Verification refreshes only origin refs, proves the SHA belongs to the
   submitting agent's issue branch, and reads evidence at that SHA. A mirror
   fetch failure retains the action and retries the fetch with bounded backoff;
   it preserves the submitted `complete` file and emits no missing-artifact or
   verification verdict. This does not claim to detect or retry a provider 529
   inside an agent harness.
5. Passing evidence clears completion, journals the result, advances the agent
   cursor, and derives new orders. Failing evidence clears completion and
   reissues the same action with concrete `outstanding[]` details. Attempt
   counts are diagnostic only: even repeated mechanical failures never drop the
   agent, advance the gate, or become a terminal escalation. The driver may
   notify the owner, but it continues waiting/re-ordering until valid evidence
   arrives or the owner explicitly uses `drop`, `pause`, or `abandon`.
6. The state machine covers the accepted R0–R7 behavior except amendments,
   which the owner removed, and supports all three profiles. An unavailable
   agent remains in the active roster indefinitely; shared gates wait, its
   action is preserved, and no elapsed-time rule removes it.
7. `coord drop A` is the owner's complete authorization to continue without A.
   It performs one local atomic state change: journal the command, add A to the
   persisted dropped-agent set, ignore/clear A's pending operational completion,
   and rederive the unresolved and future actions from the remaining agents.
   There is no proposal, approval, signature ceremony, roster epoch, or branch
   artifact. Other agents receive no drop announcement; any affected action is
   simply reissued with exact inputs that omit A (for example, “read plans from
   commits B, C, and D”). A's prior work becomes ineligible as an input to every
   unresolved or future gate: newly issued actions never cite A, even if A
   published usable work before being dropped. This differs deliberately from
   retaining a dropped agent's published evidence. Any later stale `complete`
   from A is ignored. Completed historical gates and immutable pins are not
   recomputed. When one active agent remains, subsequent work uses the accepted
   solo checks. The CLI refuses to drop the final active agent because a
   zero-agent workflow cannot continue; starting with a one-agent profile and
   continuing with one after drops are both supported.
8. `coord pause` journals a durable pause and allows the coordinator to shut
   down without deleting actions, cursors, mirror state, or tmux sessions.
   `coord resume` plus `coord run` reconstructs state and continues later.
9. Completion detection polls files at a bounded interval. It never uses
   `tmux wait-for`.
10. Automated nudging follows the accepted harness policy. Codex, Cursor, and
   Antigravity remain pull-only/owner-nudged until separately proven idle-safe.
11. Restart reconstructs the earliest unsatisfied gate from immutable origin
   evidence, re-verifies any pending completion SHA, retains the journal, and
   avoids duplicate actions/effects.
12. After three unsuccessful revision rounds, the driver requires owner action;
    it never enters round 4.
13. Finalization obeys the owner-selected `prPolicy`. The coordinator calls its
    byte-for-byte local copy at `coordination/src/finalization.ts`, which calls
    the copied sibling `pinValidation.ts`; it neither imports automation nor
    shells out to the old automation CLI. R7 invokes the local verification
    function internally; no legacy `verify-finalization` CLI compatibility is
    exposed. After cleanup-only ancestry/path verification, the coordinator
    materializes a clean throwaway verification worktree at the exact final SHA
    under the external control root, runs the config's explicit argument-vector
    check commands there, and records their exit results. The consensus-ai
    config declares install/check argv for both the root workspace and the
    standalone coordination package, including
    `scripts/test-changed.sh {baselineSha}`, `pnpm check:fast`, and
    `pnpm --dir coordination check`; placeholder expansion changes one argv
    element and never invokes a shell. A failed verifier or check blocks PR
    creation. It may open an unmerged PR when authorized and has no merge
    command or merge effect.

## Independence from existing automation

The new package does not import from `automation/src/`, depend on its compiled
output, or require its workspace to build first. The explicitly listed copy
pairs are duplicated byte-for-byte at the implementation baseline and thereafter
are coordination-owned source/config/test files. `protocol.ts` is an adapted,
reduced schema implementation rather than a copy of `automation/src/schemas.ts`.
All other Git, path, state-machine, CLI, and fixture code is newly implemented
under `coordination/src/` and `coordination/test/`. There is no dual-maintenance
or compatibility promise: the copied/adapted code is a one-time fork, all future
maintenance occurs in `coordination/`, and `automation/` stays frozen. This
reuses proven material without making the new driver depend at build or runtime
on the phase/barrier implementation it supersedes.

## Build order

1. **Stage A — verify without touching a pane:** implement paths through the
   pure machine and their tests. The owner can paste actions or agents can pull
   them with `next`; exact-SHA verification is useful before tmux delivery
   exists.
2. **Stage B — drive:** add tmux, run loop, CLI/main, wrapper, owner controls,
   and the integration canary. Run the coordinator in an attachable tmux
   control session, while Codex/Cursor/Antigravity remain pull-only.
3. **Stage C — enable nudges per harness:** retain the accepted default policy
   and enable any additional automatic nudge only after a harness-specific idle
   fixture proves safe insertion. This issue need not enable non-Claude nudges.

## Dependencies, configuration, and migration

- **Standalone dependencies.** Declare exactly the same Zod 4, TypeScript,
  Vitest, ESLint, and Node type dependency specifiers as the existing automation
  package so the copied lockfile remains valid byte-for-byte. The package name,
  entry points, and scripts are new and coordination-specific. Runtime behavior
  otherwise uses Node 26 built-ins and explicit Git/tmux subprocess adapters.
- **No root package/workspace change.** Build and test with
  `pnpm --dir coordination ...`; the new wrapper invokes `coordination/dist/`
  directly.
- **Repository check wiring is deliberately explicit.** Because the root
  `pnpm-workspace.yaml`, Turbo graph, dependency-cruiser glob, changed-test
  script, and hooks remain unchanged, none of them discovers the standalone
  package. Every agent implementing or revising `coordination/**` must run the
  standalone command sequence in Validation; the root pre-commit hook still
  runs its existing `pnpm check:fast`, and the pre-push hook applies its existing
  path policy independently.
- **No database or schema migration.** Operational state is new, versioned,
  untracked JSON/Markdown/JSONL under the owner-selected external `coord/`
  root. The driver refuses to place it inside any configured clone.
- The legacy automation commands remain independently runnable only because
  their directory is left untouched; the new driver neither integrates with
  nor preserves their interfaces. `coordination/` is the forward path, entered
  through `coord start`, and supports automation-OFF and single-agent use.
- A runtime format version in `start.json` makes incompatible future changes
  fail closed rather than guessing how to resume.

## Alternatives rejected

1. **Extend `automation/src/cli.ts` and `scripts/wait.sh`.** Rejected because
   those interfaces are phase-oriented and agent-invoked, while this issue
   requires owner-side action ordering and exact-submission verification.
2. **Treat a branch tip as completion.** Rejected because intermediate pushes
   race verification and do not express agent intent.
3. **Commit the completion receipt to the agent branch.** Rejected because the
   receipt then fails with the same push failure as the artifact it is meant to
   acknowledge.
4. **Use `tmux wait-for`, sockets, or a service database.** Rejected in favor of
   the accepted polled-file protocol: fewer delivery races, inspectable state,
   and simpler crash recovery.
5. **Automatically nudge every harness.** Rejected until idle fixtures prove
   mid-turn insertion safe for each non-Claude harness.
6. **Rewrite the existing automation package wholesale.** Rejected because a
   parallel directory provides a smaller review boundary, leaves proven manual
   workflows intact, and can reuse strict schemas without coupling control
   loops.
7. **Store runtime data under `automation/.runtime/`.** Rejected because that is
   still inside an agent clone. The control plane belongs in the owner's folder
   and must be unable to dirty or mutate an agent worktree.
8. **Require a signed answer, proposal/approval exchange, or roster epoch to
   drop an agent.** Rejected as owner-control-plane ceremony. `coord drop A` is
   the authority and persists one local dropped-agent fact; exact later actions
   communicate the reduced input set without a separate announcement.
9. **Stop, drop, or advance automatically after an action-attempt cap.**
   Rejected. There is no cap and no need to decide whether successive failures
   are “the same.” Attempt counts support diagnostics and owner notification
   only; they never override indefinite waiting or the exact-evidence gate.

## Risks and mitigations

- **Origin/network outages may resemble absent work.** Preserve mirror-fetch
  errors, retry that fetch with backoff, and never convert a failed refresh into
  `missing[]`.
- **A provider 529 is not mechanically visible to the coordinator.** Preserve
  the outstanding action and wait indefinitely; the owner may attach, pause the
  run, or use `coord drop A`. Do not invent a provider retry state from missing
  completion evidence.
- **A submitted SHA may exist but not belong to the expected branch.** Require
  reachability from the explicit fetched issue ref before reading evidence.
- **Operational writes may tear or be redirected.** Use root confinement,
  symlink rejection, write-and-rename, fsync where relevant, and journal before
  destructive acknowledgement.
- **The control root may accidentally point inside a clone.** Resolve real
  paths for every configured agent root and fail `start` before the first write
  when the requested control root overlaps one.
- **Crash recovery may double-deliver an action.** Action IDs and attempts are
  stable, effects are idempotent, and recovery re-evaluates evidence before
  advancing.
- **Repeated invalid submissions may continue indefinitely.** This is
  deliberate: attempts are reported to the owner, but only valid evidence or a
  direct owner control command changes the workflow.
- **A dropped agent may later write a stale completion.** The persisted dropped
  set is checked before every observation; its completion is ignored and cannot
  change a gate in this run.
- **tmux insertion can corrupt an active turn.** Check foreground processes and
  harness-specific policy; default Codex/Cursor/Antigravity to pull-only.
- **Mechanical validity can be mistaken for quality.** Keep the distinction
  explicit in output and require plan review, comparison, ballots, or owner
  decisions according to profile.
- **Automatic finalization could exceed authority.** Represent PR creation and
  merge as separate capabilities; implement only the former when owner policy
  permits and never implement the latter.

## Validation

The standalone package is intentionally outside the root workspace, so the
validation commands are explicit rather than implied by Turbo:

```sh
nvm use 26
pnpm --dir coordination install --frozen-lockfile
pnpm --dir coordination check
scripts/test-changed.sh origin/main
pnpm check:fast
```

`coordination check` builds, lints, typechecks, runs focused unit tests, and runs
the four-agent integration test. `scripts/test-changed.sh` currently checks the
root/Turbo workspaces and legacy `automation/`; it does **not** discover
`coordination/`, so it supplements rather than replaces `coordination check`.
Likewise, the existing pre-commit hook runs root `pnpm check:fast` for a
`coordination/**` product commit, but that root command does not include the new
package. The existing pre-push hook does not classify `coordination/**` as a
legacy-automation E2E trigger. Therefore the standalone check must be run and
pass before each implementation or revision code commit and again after the
last code change before push; the unchanged hooks then run whatever additional
root checks their existing policies require.

Before the implementation commit, also run `cmp -s` for every
source/destination pair in the byte-for-byte-copy table. Everything must pass
under Node 26 with no `any`, no unchecked unvalidated JSON, and no skipped hook.

## Conclusion

Build a new standalone owner-side workflow driver in root-level
`coordination/`, alongside rather than inside the current automation. The driver uses an external
owner control tree for the local action/submission channel, immutable origin
commits for proof, a pure state machine for ordering, attachable tmux sessions
for intervention, and direct owner-local commands for control. The proposed map
is additive-only, retains automation-OFF and single-agent operation, waits
indefinitely for unavailable agents unless the owner types `coord drop`, omits
amendments, caps revisions at three, may open only an unmerged PR when selected
by owner policy, and never merges.
