# Implementation Plan — Issue 124: Reduce Agent Git Waste (PATH wrapper + Materialized Inputs)

## Exact File List to be changed or deleted

- `githooks/post-merge`
- `scripts/lib/launcher.sh`
- `scripts/setup_claude.sh`
- `scripts/setup_codex.sh`
- `src/action.ts`
- `src/doctor.ts`
- `src/hookSync.ts`
- `src/install.ts`
- `src/paths.ts`
- `src/productIgnore.ts`
- `src/runLoop.ts`
- `src/setupWorkspace.ts`
- `src/steps.ts`
- `templates/product/AGENTS.protocol.md`
- `test/action.test.ts`
- `test/doctor.test.ts`
- `test/install.test.ts`
- `test/runLoop.test.ts`

## Exact file list to be created

- `scripts/lib/git-wrapper.sh`
- `src/materializeInputs.ts`
- `test/gitWrapper.test.ts`
- `test/materializeInputs.test.ts`

## Reuse and Scope

### Existing functions, types, helpers, tests, and fixtures to reuse:
- `src/mirror.ts`: Reuse `BareMirror.readBlob` for reading bound coordination markdown/JSON blobs (`.plans/issue-N/plan.md`, `.plans/issue-N/review.md`, etc.), and `BareMirror.materializeWorktree` for creating detached worktrees for implementation pins at `issue-<n>/worktrees/<agent>-<sha8>/`.
- `src/paths.ts`: Reuse `containedPath`, `assertNoSymlink`, `isPathInside`, and `IssueRuntimePaths` topology for safe runtime path containment under `paths.issueRoot`.
- `src/hash.ts`: Reuse `sha256` for computing the deterministic `inputSetHash` across bound input entries and validating content digests.
- `src/state.ts` & `src/steps.ts`: Reuse `BoundInput`, `ChangeScopeEntry`, and `InternalOrder` data structures, extending them cleanly with materialized input mappings without breaking existing consumers.
- `src/action.ts`: Reuse `renderAction`, `parseAction`, and front-matter encoding logic, extending markdown generation with the `## Bound input files` section.
- `src/setupWorkspace.ts`: Reuse `act`, `effectOptions`, `spawnSync`, and template rendering patterns from `writeAgentLauncher` to implement `writeAgentGitWrapper`.
- `src/productIgnore.ts`: Reuse `writeManagedIgnoreFile` and `applyManagedBlock` with updated `DEFAULT_CLONE_IGNORES` to ignore `/.coord/`.
- `src/doctor.ts`: Reuse `DoctorFinding`, `DoctorFindingClass`, and clone inspection pipeline to verify the presence and executable bit of `.coord/bin/git`.
- `test/runLoop.test.ts`, `test/install.test.ts`, `test/doctor.test.ts`, `test/action.test.ts`: Reuse test fixtures (in-memory and temp directory coordinators, bare mirrors, mock git runners) to validate end-to-end functionality.

### Justification for new files:
- `scripts/lib/git-wrapper.sh`: The single source of truth for the `.coord/bin/git` wrapper template and emission logic, shared by `setupWorkspace.ts` during `coord install` and `githooks/post-merge` upon repository pull/merge, preventing template drift.
- `src/materializeInputs.ts`: Dedicated module encapsulating input set hashing, markdown artifact extraction from the mirror into immutable content-addressed directories (`issue-<n>/inputs/<inputSetHash>/`), manifest creation (`manifest.json`), and worktree materialization. Keeping this distinct keeps `runLoop.ts` and `mirror.ts` modular and maintainable.
- `test/gitWrapper.test.ts`: Focused unit and integration tests verifying the PATH wrapper behavior under automated (`COORD_ISSUE` set) vs manual mode, command blocking (`git status`, `git diff`, unauthorized `git show`), delegation re-entrancy (`COORD_GIT_DELEGATE=1`), and hook execution.
- `test/materializeInputs.test.ts`: Focused tests verifying input set hashing, manifest correctness, file writing, worktree materialization, and immutability.

## Tests

The implementation adds focused unit and integration tests to verify both Part A (Git PATH wrapper) and Part B (Coordinator Materialized Inputs).

### New test files and test cases:
1. `test/gitWrapper.test.ts`:
   - `blocks git status and git diff when COORD_ISSUE is active`: Fails before wrapper implementation, passes when wrapper exits with code 2 and informative stderr.
   - `allows git status and git diff in manual mode (COORD_ISSUE unset)`: Passes through to `REAL_GIT` without restriction.
   - `passes through allowed commands (add, commit, push, fetch, checkout, rev-parse)`: Verifies allowed git operations succeed.
   - `allows git show for <sha>:<path> or passes through when COORD_GIT_DELEGATE=1`: Ensures re-entrancy and internal hook checks succeed without blocking.
   - `embeds absolute REAL_GIT resolved at install time`: Verifies wrapper does not recurse into `.coord/bin/git`.

2. `test/materializeInputs.test.ts`:
   - `materializes markdown artifacts into content-addressed inputs directory`: Verifies `issue-<n>/inputs/<inputSetHash>/` contains the expected file structure and valid `manifest.json`.
   - `materializes detached worktree for implementation pins`: Verifies `BareMirror.materializeWorktree` is invoked at `issue-<n>/worktrees/<agent>-<sha8>/` and creates a full checkout.
   - `is idempotent and skips re-materializing existing inputs/worktrees`: Verifies duplicate prepare actions do not re-write or re-clone existing trees.

### Existing test files extended:
1. `test/install.test.ts`:
   - Extend `coord install — two-mode footprint` and clone wiring tests to verify `.coord/bin/git` is created, made executable, ignored in `.git/info/exclude`, and cleaned up on uninstall.
   - Verify launcher script prepends `.coord/bin` to `PATH` and includes `--add-dir` for inputs and worktrees.
2. `test/doctor.test.ts`:
   - Extend clone health checks to report missing or non-executable `.coord/bin/git` wrapper with appropriate remediation.
3. `test/action.test.ts`:
   - Verify `renderAction` renders the `## Bound input files` section with absolute read paths when materialized inputs are present.
4. `test/runLoop.test.ts`:
   - Verify `prepareAction` writes the input packet and populates `order.materializedInputs` before rendering `action.md`.

## Alternatives Rejected

1. **Partial sparse-file export for implementation pins**:
   - *Rejected*: Exporting only changed paths (from `changeScope`) creates an incomplete tree where cross-file references, type definitions, imports, configuration, and tests are missing. Agents reviewing or revising code would still need to execute git commands or search missing files. Materializing a full detached worktree via `BareMirror.materializeWorktree` provides complete context with zero agent-side git reconnaissance.
2. **Agent-side fetching and exporting into clone-local temp directories**:
   - *Rejected*: Having each agent run `git fetch` and export files into its own `.tmp/` duplicates work N times and burns tokens on repetitive git invocations. Storing materialized inputs centrally under `coord-runtime/issue-<n>/` allows one single write by the coordinator that is shared read-only across all agents.
3. **Granting the entire `issue-<n>` runtime directory to agent harnesses**:
   - *Rejected*: Exposing the full issue directory would allow harnesses to read `cursors.json`, `journal.jsonl`, other agents' private mailbox drops, and internal coordinator state. Granting only narrow subdirectories (`inputs/`, `worktrees/`, `agents/<agent>/responses`, and `completes/issue-<n>/<agent>`) maintains strict security boundaries.
4. **Dynamic PATH lookup in the git wrapper**:
   - *Rejected*: Using `which git` dynamically inside the wrapper could cause infinite recursion if `.coord/bin` precedes `/usr/bin` in `PATH`. Baking the absolute `REAL_GIT` path during install guarantees safety and deterministic execution.

## Risks and Mitigations

1. **Risk: Git hooks or internal coordination scripts fail due to wrapper command blocking.**
   - *Mitigation*: The wrapper includes a re-entrancy bypass check (`COORD_GIT_DELEGATE=1`). All internal hook executions and git scripts run with `COORD_GIT_DELEGATE=1` or invoke `REAL_GIT` directly. Essential commands (`rev-parse`, `diff --cached`, etc.) required by pre-commit and pre-push hooks remain allowed.
2. **Risk: Disk space consumption from multiple detached worktrees in large repositories.**
   - *Mitigation*: Detached worktrees are created only for active implementation pins (e.g. compare and revise phases) and are indexed by `<agent>-<sha8>`. Stale worktrees are pruned when superseded or when `coord wipe` / issue teardown runs via `git worktree remove` and `git worktree prune`.
3. **Risk: Launcher crashes on empty input or worktree directories.**
   - *Mitigation*: In `scripts/lib/launcher.sh`, existence checks (`[[ -d "$coord_inputs" ]]`) ensure `--add-dir` flags are appended only when the directories exist, matching the robust pattern used for response directories and mailboxes.
4. **Risk: Breakage of manual mode workflows for human operators or agent scratch work.**
   - *Mitigation*: The git wrapper checks `COORD_ISSUE` against `^[1-9][0-9]*$`. When `COORD_ISSUE` is unset, the wrapper immediately delegates all commands without restriction.

## Conclusion

This plan addresses token waste from redundant git commands by introducing a robust two-layer solution:
1. An untracked `.coord/bin/git` PATH wrapper that blocks wasteful git status, diff, and show calls during automated issues while safeguarding hook execution and manual mode.
2. Coordinator-side input materialization that extracts bound markdown artifacts and creates detached worktrees in runtime storage, exposing direct filesystem read paths in `action.md` and granting sandboxed harnesses read access via `--add-dir`.

The implementation reuses existing mirror, path containment, and template infrastructure to achieve minimal code footprint and high reliability.
