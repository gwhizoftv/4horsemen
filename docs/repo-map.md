# Coordination driver — repository map

Structural orientation for agents. Paths are module groups, not line numbers.
Named context files replace an initial find/grep sweep; they do not replace
bound pins, approved file maps, or independent judgment.

## Module groups

| Group | Owns |
| --- | --- |
| Protocol and evidence | `src/protocol.ts`, `src/evidence.ts`, `src/pinValidation.ts` |
| State machine and run loop | `src/machine.ts`, `src/runLoop.ts`, `src/steps.ts`, `src/state.ts` |
| Action rendering | `src/action.ts`, `src/orderScaffold.ts` |
| Workspace and install | `src/setupWorkspace.ts`, `src/install.ts`, `src/hookSync.ts`, `src/agentHookSync.ts` |
| Harness surface | `src/tmux.ts`, `src/agentEvent.ts`, `src/agentLifecycle.ts` |
| Analytics | `src/analytics.ts`, `src/transcriptRead.ts` |

## Invariants (do not rediscover)

- Runtime state lives under `--coord-root`, outside every agent clone.
- Clone-local `AGENTS.md` is skip-worktree; do not clear that bit or strip the
  coordination protocol overlay.
- Per-clone launchers (`start-<agent>.sh`) are generated and untracked.
- Do not edit product `githooks/` to satisfy verification; run the named
  commands in the action or plan.

## Commands and tests

- Before a commit on a non-`main` branch: `pnpm check:fast` (lint, typecheck,
  fast tests). Package version must be strictly greater than `origin/main`.
- Coordinator acceptance gate: `pnpm check` (build + check:fast + e2e).
- Fast tests live under `test/*.test.ts`; e2e uses `vitest.e2e.config.ts`.

## Start here by change kind

| Kind of change | Start in |
| --- | --- |
| New workflow step / gate | `src/steps.ts`, `src/machine.ts`, `src/runLoop.ts` |
| Artifact shape / evidence | `src/protocol.ts`, `src/evidence.ts`, `src/orderScaffold.ts` |
| What agents see in `action.md` | `src/action.ts`, `src/orderScaffold.ts` |
| Install / launcher / hooks | `scripts/lib/launcher.sh`, `src/install.ts`, `src/setupWorkspace.ts` |
| Metrics / analytics | `src/analytics.ts`, `docs/analytics.md` |
