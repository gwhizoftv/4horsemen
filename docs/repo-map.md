# Coordination Repository Map

A structural overview of the coordination driver codebase for fast orientation and context.

## Module Layout

### Entry Points and CLI
- `src/main.ts` — CLI executable entry point.
- `src/cli.ts` — Command dispatcher, CLI argument parsing, subcommands (`start`, `run`, `next`, `doctor`, `install`, `analytics`, `manual`, etc.), environment and flag validation.

### State, Protocol, and Paths
- `src/protocol.ts` — Core Zod schemas for primitives: Git SHAs, issue IDs, session IDs, digests, agent IDs, and repository paths.
- `src/paths.ts` — Absolute and contained filesystem path resolvers for coordination runtime and workspaces; symlink assertion guards.
- `src/state.ts` — Runtime data schemas (`CoordinatorConfig`, `StartState`, `CursorsState`, `JournalEvent`, `AgentCursor`), atomic JSON writing, and journal append operations.

### Workflow Engine and Machine
- `src/steps.ts` — Workflow step definitions (`STEP_DEFINITIONS`), profile definitions (`solo`, `reviewed`, `consensus`), evidence IDs, and `InternalOrder` contracts.
- `src/machine.ts` — Pure transition function (`decide()`) determining next actions, approvals, reissues, retries, and gate advancements based on current state and observations.
- `src/runLoop.ts` — Stateful coordinator execution engine: action generation, bare mirror sync, evidence verification, lifecycle nudges, timeout watchdogs, and finalization.

### Actions and Scaffolding
- `src/action.ts` — Front-matter parsing, public order rendering (`action.md`), completion file parsing (`complete`), and file locking.
- `src/orderScaffold.ts` — JSON and Markdown prompt scaffolds for workflow steps.

### Evidence, Mirror, and Git
- `src/evidence.ts` — Signal validation, plan and comparison artifact extraction, and check verification.
- `src/mirror.ts` — Git bare mirror wrapper for fetching agent branches, checking ancestry/reachability, reading blobs, and inspecting changed paths.
- `src/gitExec.ts` — Hermetic Git execution wrappers.
- `src/pinValidation.ts` — Strict ancestry and post-pin change validation for immutable product commits.
- `src/finalization.ts` — Finalization verification, current-issue cleanup verification, and check validation.

### Workspace, Clones, and Toolchain
- `src/install.ts` — Product workspace onboarding, agent clone configuration, and hook installation.
- `src/setupWorkspace.ts` — Config generation, clone layout setup, and launcher script generation.
- `src/doctor.ts` — Comprehensive installation health checks and drift classification.
- `src/hookSync.ts`, `src/agentHookSync.ts`, `src/hookPolicy.ts` — Git hook shimming, attestation, and lifecycle synchronization.
- `src/productIgnore.ts` — Managed `.gitignore` block management.
- `src/agentsProtocol.ts` — Managed `AGENTS.md` protocol overlay management.

### Agent Lifecycle and Transcripts
- `src/agentLifecycle.ts` — State machine and timestamps for agent pane delivery and execution.
- `src/agentEvent.ts` — Hook payload normalization from vendor CLIs.
- `src/tmux.ts` — Tmux session management, pane readiness detection, and key injection.
- `src/analytics.ts` — Wall-clock, token, and tool-call reporting across issue phases.
- `src/transcriptRead.ts` — Vendor transcript parsing for token and tool metrics.

## Key Invariants
1. **Zero Product Intrusion**: Installing and running coordination against a product repository leaves human clones untouched. Coordination state lives strictly under `--coord-root` and in agent-local git config/hooks.
2. **Immutable Evidence Chain**: All phase transitions require valid Git commits fetched into the bare mirror. Agents never mutate peer branches or push directly to `main`.
3. **Approved Path Isolation**: Product changes in `R4.implement` and `R6.revise` are constrained strictly to the paths approved during the plan phase.

## Standard Verification Commands
- `pnpm check:fast` — Linting, TypeScript type checking, and fast unit test suite.
- `pnpm check` — Full build, fast checks, and end-to-end integration test suite.
