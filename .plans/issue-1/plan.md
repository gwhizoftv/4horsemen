# Issue 1 plan — Codex

## Context and binding decisions

Issue 1 implements the owner-side workflow driver in the dedicated
`coordination` repository. The driver gives each agent one concrete action,
accepts an exact pushed commit SHA as the agent's completion intent, verifies
the required artifact in that commit, and advances only after the corresponding
mechanical predicate passes.

This plan treats this repository's `.plans/issue-1/workflow-algorithm.md` at
baseline commit `9f918cd97ca8476593c3c831c52d2f51aaf9c563` as the accepted design for all
four implementations. The owner has fixed `maxRevisionRounds` at **3**,
removed amendments and signed owner-authority paperwork, allowed automatic
consensus declaration and creation of an unmerged PR, and retained merge as an
owner-only operation. This issue is coordinated manually without automation
barriers.

The legacy consensus-ai `automation/` suite is not part of this repository and
has no backward-compatibility contract with the new driver. It is frozen
reference material at consensus-ai commit
`01be9854919e1bf9a75f70ced7980d48d7150c28`. Selected self-contained files may
be copied from that immutable source once; this repository owns all subsequent
maintenance and may diverge without synchronization.

## Proposed architecture

Implement the driver at the root of the standalone repository located at
`/Volumes/4TB-SOURCE/REPOS/coord/coordination/`. Agent implementation work occurs
on the corresponding issue branch in each sibling agent clone, including
`coordination-codex`; it reaches the canonical `coordination/` checkout only
through the normal review/merge process. All paths below are relative to that
repository root—do **not** create a nested `coordination/coordination/`
directory. The package owns its protocol schemas, control loop,
operational-state model, Git snapshot logic, evidence evaluation, tmux
integration, and CLI.

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

### Production file map

The repository scaffold already supplies package infrastructure, a wrapper,
operator-documentation stubs, and placeholder source/tests. Retain or refine
those files rather than nesting another package inside this one.

1. **`.gitignore`** — retain the scaffold's package/build/tool ignores.
2. **`.nvmrc`** — retain the scaffold's Node 26 declaration.
3. **`package.json`** — refine the existing private Node 26 ESM package scripts
   so `check`, `check:fast`, `test:fast`, and `test:e2e` cover the complete
   driver and match the existing hook entry points.
4. **`pnpm-workspace.yaml`** — retain the existing one-package root workspace.
5. **`pnpm-lock.yaml`** — update from this repository's `package.json` only when
   dependencies change; do not copy the legacy automation lockfile.
6. **`tsconfig.json`** — refine the existing strict NodeNext TypeScript build
   from `src/` to `dist/` as needed.
7. **`test/tsconfig.json`** — add the standalone test typecheck configuration.
8. **`vitest.config.ts`** — refine the existing focused unit/integration test
   configuration.
9. **`eslint.config.mjs`** — refine the existing strict TypeScript lint config.
10. **`coord`** — retain/refine the executable wrapper that builds when needed
    and invokes `dist/main.js`.
11. **`src/paths.ts`** — resolve the external runtime
   `coord/issue-<n>/` tree, containment-check every derived path, reject
   symlinks, and refuse a runtime root inside any configured agent clone.
12. **`src/state.ts`** — strict Zod schemas and atomic I/O for
    `start.json`, `cursors.json`, and `journal.jsonl`; original and dropped
    roster state; runtime format version; pause state; and restart reconstruction.
13. **`src/action.ts`** — keep the internal order and rendered
    agent action as distinct types; render/parse the restricted `action.md`,
    parse and clear `complete`, and place exact expected input commits in the
    human task text without serializing internal step/gate/phase/evidence IDs.
14. **`src/protocol.ts`** — driver-owned Zod schemas and helpers for
    the published join, plan, ballot, implementation, comparison, revision,
    consensus, and finalization artifacts the evidence predicates consume.
    Selectively adapt the required primitives, envelope/citation rules, and
    artifact schemas from the pinned legacy `automation/src/schemas.ts`; do not
    import it. Omit its amendment, signed owner-override/drop, and escalation-ID
    types. These coordination schemas become the maintained definitions.
15. **`src/mirror.ts`** — owner-side bare-mirror setup, explicit
    origin ref fetching, transient-failure classification, submission-SHA
    reachability, exact-commit blob reads, ancestry, and changed paths.
16. **`src/steps.ts`** — coordinator-internal step, gate, and
    evidence identifiers; profile participants, step table, gate denominators,
    path templates, and defaults including `maxRevisionRounds: 3`. These IDs
    are never part of the agent-facing action schema.
17. **`src/evidence.ts`** — the
   `isSatisfied(action, submissionSha)` predicate registry. It checks the exact
   required path, required document sections, driver-owned protocol schemas,
   issue/session/agent/digest fields, bound inputs, citations, rounds, pin
   ancestry, signal-commit separation, and approved implementation file maps.
   Failures return concrete stable `outstanding[]` values rather than a generic
   missing-agent result.
18. **`src/machine.ts`** — pure observations-to-decisions reducer,
    intent/proof matrix, advisory attempt counts, gate advancement, owner drop
    handling, plan/reviser routing, revision accounting, and finalization
    policy. Attempt counts never cause an automatic drop or advance.
19. **`src/tmux.ts`** — tmux session/window creation,
   per-agent `start-<agent>.sh` launch, foreground-process and pane checks,
   `load-buffer`/`paste-buffer` delivery, harness disappearance detection, and
   the nudge policy. Automatic non-Claude nudging remains disabled until an
   explicitly supported idle fixture proves it safe.
20. **`src/runLoop.ts`** — effectful polling/orchestration loop:
    prepare actions, snapshot intent, fetch/verify, re-order with precise
    outstanding work, apply owner controls, recover pushed-then-died work, and
    wait without busy-spinning.
21. **`src/cli.ts`** — strict parsing and stdin/stdout handling
    for `start`, `run`, `next`, `answer`, `drop`, `pause`, `resume`,
    `restart-action`, and `abandon`. It defines a new testable CLI API and exit
    contract without preserving legacy automation command or export shapes.
22. **`src/main.ts`** — replace the scaffold stub with an import-safe process
    entry and exit-code mapping, separate from the testable CLI module.
23. **`src/hash.ts`** — add the copied SHA-256 helpers.
24. **`src/pinValidation.ts`** — add the copied NUL-safe Git range parsing,
    ancestry, pin immutability, and coordination-path checks.
25. **`src/finalization.ts`** — add the copied cleanup-only finalization
    verifier.
26. **`docs/coord-driver.md`** — expand the scaffold operator notes with owner
    operations, directory
    topology, command examples, profiles, tmux attachment,
    indefinite waiting, agent drop semantics, recovery, and explicit
    confirmation that the coordinator can never merge.
27. **`README.md`** — expand the scaffold quick start with the maintained CLI
    and required external runtime-root contract.
28. **`config.example.json`** — refine the scaffold's portable roster,
    clone-root, branch-template, harness, PR-policy, and argument-vector check
    configuration. Remove `defaultCoordRoot`: `--coord-root` is always required.

### New test files

1. **`test/action.test.ts`** — restricted front-matter round trips,
   opaque action IDs, expected-input rendering, proof that internal
   step/gate/phase/evidence fields are never emitted, and every malformed
   `complete` form.
2. **`test/state.test.ts`** — schema strictness, runtime format,
   default revision limit of 3, atomic writes, journal recovery, indefinite
   waiting, persisted dropped agents, and pause/resume.
3. **`test/protocol.test.ts`** — strict published-artifact schemas,
   cross-field/session validation, and rejection of unknown or stale inputs.
4. **`test/mirror.test.ts`** — external-root refusal, real bare
   origins, exact-SHA reads, wrong-branch SHAs, ancestry, changed paths, and
   transient fetch outage distinct from absence.
5. **`test/evidence.test.ts`** — positive and negative
   fixtures for every predicate in the accepted design, including missing or
   wrong paths, malformed documents, stale hashes, incorrect pins/rounds, and
   signal commits incorrectly used as product pins.
6. **`test/machine.test.ts`** — intent/proof matrix, profile
   denominators, four-agent ordering, indefinite wait and re-order after any
   number of failed submissions, immediate local drop, exact omission of all
   dropped-agent inputs, degradation to solo at one agent, refusal to drop the
   final agent, and rounds 1–3 with no round 4.
7. **`test/tmux.test.ts`** — fake-runner unit coverage
   plus a throwaway real tmux socket when tmux is available, covering launch
   targets, buffer-based insertion, busy panes, owner typing, missing harnesses,
   Claude nudge behavior, and non-Claude pull-only behavior.
8. **`test/runLoop.test.ts`** — poll/verify/reorder
   behavior, simultaneous agents, invalid and unpublished SHAs, transient fetch
   failures that preserve `complete` and emit no artifact verdict, crash
   boundaries, idempotent restart, ignored post-drop completions,
   pushed-then-died escape, wait/drop/pause/abandon semantics, and proof that a
   failed configured final check blocks PR creation.
9. **`test/cli.test.ts`** — every public command, stable exit
   codes, required `--coord-root`, `coord drop A`, refusal to drop the final
   active agent, agent identity for `next`, and proof that `next` exposes no
   peer, step, gate, evidence ID, or global phase state.
10. **`test/integration.test.ts`** — a four-agent
    temporary-origin canary with fake harnesses covering start, action delivery,
    exact-SHA completion, dropping one unavailable agent, action inputs that omit
    it, gate advancement, one revision, consensus declaration, and finalization
    without a merge.
11. **`test/hash.test.ts`** — copied unchanged from
    the pinned legacy `automation/test/hash.test.ts`.
12. **`test/finalization.test.ts`** — a new standalone adaptation
    of the pinned legacy `automation/test/finalization.test.ts`. Retain the
    useful cleanup, ancestry, rewrite, and changed-path cases, but replace the
    old CLI compatibility assertions with the new R7 coordinator behavior.
13. **`test/pinValidation.test.ts`** — a new standalone adaptation
    of the existing pin tests. It cannot be copied unchanged because the old
    test imports the legacy automation `git-fixture.ts` dependency graph.

Delete the scaffold-only **`test/stub.test.ts`** once real tests replace it.

### Byte-for-byte copies

The following destinations are created with contents exactly equal to blobs in
the frozen consensus-ai source commit
`01be9854919e1bf9a75f70ced7980d48d7150c28`. Compare each destination to
`git show <source-commit>:<source-path>` before the implementation commit. Any
necessary semantic change is an explicitly adapted coordination-owned file,
not a claimed copy. This equality claim applies only to the initial
implementation baseline; afterward the destinations may evolve independently.

| Existing source | New destination | Why it is safe to copy unchanged |
| --- | --- | --- |
| `automation/test/tsconfig.json` | `test/tsconfig.json` | Generic test typecheck config with the same relative layout |
| `automation/src/hash.ts` | `src/hash.ts` | Self-contained Node hashing helper |
| `automation/src/pinValidation.ts` | `src/pinValidation.ts` | Self-contained Git subprocess and path-policy helper |
| `automation/src/finalization.ts` | `src/finalization.ts` | Depends only on the copied sibling `pinValidation.ts` |
| `automation/test/hash.test.ts` | `test/hash.test.ts` | Depends only on the copied sibling hash module |

### Existing files modified

Modify the existing scaffold files **`package.json`**, **`pnpm-lock.yaml`** (only
if dependency metadata changes), **`tsconfig.json`**, **`vitest.config.ts`**,
**`eslint.config.mjs`**, **`coord`**, **`src/main.ts`**, **`README.md`**,
**`docs/coord-driver.md`**, and **`config.example.json`** as described above.
Delete only the placeholder **`test/stub.test.ts`**.

Keep **`AGENTS.md`**, **`.gitignore`**, **`.nvmrc`**,
**`pnpm-workspace.yaml`**, **`scripts/**`**, **`githooks/**`**, and agent-local
launcher/tool directories unchanged. There is no `automation/` directory and
no nested package. The owner-local control process is the authority boundary:
commands typed into `coord` take effect directly and are journaled for restart
and audit without signatures or approval files. The program exposes no merge
operation.

## Public commands and internal APIs

The supported external surface is the new `coord` executable:

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

These are implementation-level exports inside this package. The executable CLI
is the supported product boundary; no legacy package barrel is preserved.

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
    byte-for-byte local copy at `src/finalization.ts`, which calls
    the copied sibling `pinValidation.ts`; it neither imports automation nor
    shells out to the old automation CLI. R7 invokes the local verification
    function internally; no legacy `verify-finalization` CLI compatibility is
    exposed. After cleanup-only ancestry/path verification, the coordinator
    materializes a clean throwaway verification worktree at the exact final SHA
    under the external control root, runs the config's explicit argument-vector
    check commands there, and records their exit results. The consensus-ai
    config declares explicit install/check argv such as
    `pnpm install --frozen-lockfile` and `pnpm check`; placeholder expansion
    changes one argv element and never invokes a shell. A failed verifier or
    check blocks PR creation. It may open an unmerged PR when authorized and
    has no merge command or merge effect.

## Independence from existing automation

This repository does not import from the consensus-ai `automation/` source,
depend on its compiled output, or require that repository to build first. The
explicitly listed copy pairs are duplicated byte-for-byte from the pinned source
commit and become coordination-owned files. `protocol.ts` is an adapted,
reduced schema implementation rather than a copy of legacy `schemas.ts`. All
other Git, path, state-machine, CLI, and fixture code is implemented under
`src/` and `test/`. There is no dual-maintenance or compatibility promise: the
copy/adaptation is a one-time fork and all future maintenance occurs here.

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

- **Standalone dependencies.** Keep this repository's Zod 4, TypeScript,
  Vitest, ESLint, and Node type dependencies managed by its own `package.json`
  and lockfile. Do not inherit or copy the legacy automation dependency graph.
  Runtime behavior otherwise uses Node 26 built-ins and explicit Git/tmux
  subprocess adapters.
- **Repository-root package.** Build and test from this repository root with
  `pnpm ...`; the `coord` wrapper invokes `dist/main.js` directly.
- **Checks and hooks cover this package.** `package.json` supplies `check`,
  `check:fast`, `test:fast`, and `test:e2e`. The existing pre-commit hook runs
  `pnpm check:fast` for product commits. The existing pre-push hook treats
  `src/`, `test/`, package metadata, scripts, and hooks as workflow-critical and
  runs `pnpm test:e2e`. No Turbo, dependency-cruiser, or cross-repository
  changed-test wiring is needed.
- **No database or schema migration.** Operational state is new, versioned,
  untracked JSON/Markdown/JSONL under the owner-selected external `coord/`
  root. The driver refuses to place it inside any configured clone.
- The legacy automation repository remains only a pinned copy/reference source;
  this driver neither invokes nor preserves its interfaces. This repository is
  the forward path, entered through `coord start`, and supports manually
  coordinated and single-agent use.
- A runtime format version in `start.json` makes incompatible future changes
  fail closed rather than guessing how to resume.

## Alternatives rejected

1. **Continue development inside the legacy consensus-ai automation suite.**
   Rejected because it is frozen and its interfaces are phase-oriented and
   agent-invoked, while this repository owns the new owner-side driver.
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
6. **Vendor or rewrite the entire legacy automation package.** Rejected because
   a small standalone repository provides a clearer review boundary and can
   selectively reuse proven helpers without inheriting the old control loop.
7. **Store runtime data under this repository.** Rejected because that is still
   inside an agent clone. The control plane belongs in the required external
   owner folder and must not dirty or mutate an agent worktree.
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

This repository is the standalone package and root workspace. Run:

```sh
nvm use 26
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` builds, lints, typechecks, runs focused unit tests, and runs the
four-agent integration test. The pre-commit hook independently runs
`pnpm check:fast`; the pre-push hook runs `pnpm test:e2e` for workflow-critical
changes. Do not bypass either hook.

Before the implementation commit, also compare every claimed byte-for-byte copy
to its pinned `git show` source blob. Everything must pass under Node 26 with no
`any`, no unchecked unvalidated JSON, and no skipped hook.

## Conclusion

Build the standalone owner-side workflow driver directly at the root of the
dedicated `coordination` repository, with runtime state in the required external
owner control tree. The driver uses immutable origin commits for proof, a pure
state machine for ordering, attachable tmux sessions for intervention, and
direct owner-local commands for control. It supports single-agent operation,
waits indefinitely for unavailable agents unless the owner types `coord drop`,
omits amendments, caps revisions at three, may open only an unmerged PR when
selected by owner policy, and never merges.
