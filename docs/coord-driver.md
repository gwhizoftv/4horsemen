# Coordination Driver

This is the owner-side driver that coordinates agents. It strictly enforces the protocol (R0-R7) using immutable Git origin evidence, separated from agent environments.

## Commands

- `coord start <issue> --profile <solo|reviewed|consensus> --coord-root <external-owner-path>`: Initializes a workflow.
- `coord run`: Runs the polling orchestration loop.
- `coord drop <agent>`: Drops an agent without requiring an epoch bump or signatures.
- `coord pause` / `coord resume`: Safely pauses and resumes the workflow.
- `coord abandon`: Abandons the workflow completely.

## Architecture

- **State Machine**: Pure, deterministic reducer (`src/machine.ts`).
- **Orchestration**: Effectful loop (`src/runLoop.ts`) interfacing with `tmux` and polling `complete` files.
- **Evidence**: Validates Git origin blobs for immutable proofs of completion.
- **Finalization**: Verifies that the PR only deletes coordination files for the current issue.
