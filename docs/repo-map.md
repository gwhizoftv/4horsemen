# Repo map — coordination driver

Orientation for an agent starting work here. Read this instead of running a
repository-wide search to find where a change belongs.

This file is deliberately structural: module groups, invariants, and commands.
It names no line numbers and no function bodies, so ordinary commits do not
make it wrong.

## What this repository is

The **coordination driver**. It prepares actions for agents, verifies the
evidence they publish, and advances a workflow state machine. It is not the
product it coordinates — the product lives in its own repository, and hooks and
tests stay decoupled from it on purpose.

Runtime state lives **outside every clone**, under the `--coord-root` directory.
Nothing in this repository writes issue state into the working tree.

## Module groups

| Group | Files | Owns |
| --- | --- | --- |
| Protocol and evidence | `src/protocol.ts`, `src/evidence.ts`, `src/pinValidation.ts`, `src/ballotResponse.ts`, `src/ballotPublication.ts` | Artifact schemas, private ballot responses, evidence-branch batch publication, pin validation |
| State machine and run loop | `src/machine.ts`, `src/steps.ts`, `src/state.ts`, `src/runLoop.ts` | Step definitions, gate transitions, persisted start/cursor/journal state, the tick |
| Action rendering | `src/action.ts`, `src/orderScaffold.ts` | `action.md` front matter and body, per-step JSON and heading scaffolds |
| Workspace and install | `src/setupWorkspace.ts`, `src/install.ts`, `src/hookSync.ts`, `src/agentHookSync.ts`, `src/agentsProtocol.ts`, `src/productIgnore.ts` | Config generation, clone setup, git hooks, vendor lifecycle hooks, the AGENTS.md overlay |
| Harness surface | `src/tmux.ts`, `src/agentEvent.ts`, `src/agentLifecycle.ts` | Launching and nudging agent CLIs, readiness detection, lifecycle events (precedence rules: `docs/readiness-policy.md`) |
| Git access | `src/mirror.ts`, `src/gitExec.ts`, `src/prepareAgentBranch.ts`, `src/materializedInputs.ts` | The bare mirror, blob and diff reads, issue-branch preparation, exporting bound artifacts as files and worktrees so agents do not re-fetch them |
| Analytics | `src/analytics.ts`, `src/transcriptRead.ts` | Phase timing, agent wait, token and tool attribution with honest coverage |
| Entry points | `src/cli.ts`, `src/main.ts` | Command parsing, `start` / `next` / `resume` / `analytics` / `install` |

Vendor launch flags live in exactly one place: `launcher_command()` in
`scripts/lib/launcher.sh`. Both `coord install` and `githooks/post-merge` read
it, which is why neither has its own copy.

## Invariants worth knowing before you plan

- **Runtime state is outside the clone.** `action.md` lives under the coord
  root, never in the working tree. Agents write a mailbox `complete` marker and,
  for ballots, a private response under `agents/<agent>/responses/`.
  `src/paths.ts` owns that boundary; `scripts/lib/launcher.sh` owns the four
  per-issue harness grants (mailbox drop, response dir, and the two
  materialization roots `inputs/` and `worktrees/`). Those roots are created
  empty at issue start because the launcher resolves grants once, when the
  harness process starts.
- **`AGENTS.md` is skip-worktree in every agent clone.** It carries a managed
  protocol overlay. Editing it from a clone stages nothing, and clearing the bit
  is forbidden. See `src/agentsProtocol.ts`.
- **The launcher is generated per clone and never tracked.** A tracked copy
  guarantees a dirty worktree. `.coord/bin/git` is generated the same way from
  the same template, but it is *replaced* whenever it differs from the current
  render: it carries the rules deciding which reads are refused during an
  automated issue, so a stale copy keeps enforcing withdrawn policy.
- **`githooks/` is product code, not a way to satisfy checks.** Do not edit it
  to make a gate pass.
- **Approved paths are the authority.** An implementation may change only the
  paths named in the selected plan's file map, plus current-issue coordination
  paths. Everything else in an action is advisory.
- **The file map is extracted from backticked paths anywhere in the plan.** A
  path mentioned in prose becomes approved; an intended file left unquoted does
  not.

## Commands that actually run

- `pnpm check:fast` — lint, typecheck, fast tests. Required before every commit
  that touches product code. This is the declared `verify.precommit`.
- `pnpm check` — build plus `check:fast` plus e2e. The coordinator's gate.
- `pnpm test:e2e` — the declared `verify.prepush` for workflow-critical paths.
- `pnpm bump-version` — advances `package.json` by one patch. Run by the
  `version-bump-on-merge` workflow on a push to `main`; there is no reason to
  run it by hand.

Nothing on a branch checks or changes the version. `check:fast`, `check`, and
the PR workflows never compare `package.json` with `origin/main`, so an issue
branch sits at `main`'s version for the whole issue and a plan must not list
`package.json` for a bump. The `0.0.N` advance happens after the merge, as a
`chore: release 0.0.N` commit pushed to `main` by CI, atomically with its `v0.0.N`
tag. The same workflow publishes a GitHub Release for that tag with generated
notes; see [release recovery](coord-driver.md#starting-and-running) if publication
fails after the push rather than rerunning the bump job.
`test/versionBump.test.ts` covers the bump helpers against fixture manifests and
against this repository's own `package.json`, never writing either back.

Tests live in `test/`, one file per module, with shared fixtures under
`test/support/`.

## Start here for a change of kind X

| Change | Start in |
| --- | --- |
| A new or altered artifact requirement | `src/protocol.ts`, then `src/evidence.ts` |
| Wording or scaffolding of what an agent is asked to do | `src/orderScaffold.ts`, then `src/action.ts` |
| Step sequence, participants, or gates | `src/steps.ts`, then `src/machine.ts` |
| What the coordinator resolves and hands to agents | `src/runLoop.ts` |
| Persisted state or config shape | `src/state.ts` |
| Agent launch, nudging, or readiness | `scripts/lib/launcher.sh`, `src/tmux.ts`, `docs/readiness-policy.md` |
| Clone setup, hooks, ignore files | `src/setupWorkspace.ts`, `src/install.ts` |
| Reporting on a finished run | `src/analytics.ts` |
