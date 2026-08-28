## Comparison

### Bound Implementation Pins Reviewed

- **Antigravity**: `ec03d8e6a235294a16ef26cea55ee940d1ee1b73`
- **Claude**: `c2784bf31651db084f00eefeb103a4daa373d602`
- **Cursor**: `d89f2d6d61c268714e5a1065098dd235d284cc3e`
- **Codex**: `fb608c5a8022b2ed7b78def20ad468fc37dd31b1`

---

### 1. Architectural Scope and Selected Plan Fidelity

All four implementations followed the selected Claude plan (`3ac5aad5d214caea6298696a855d71a1b03d05bb`) faithfully, keeping edits strictly constrained to the approved file list and introducing no unnecessary abstractions or breaking changes:

- **Git Wrapper (`.coord/bin/git`) & Harness Integration**:
  - `scripts/lib/launcher.sh` defines `write_git_wrapper <path> <real_git> <clone>` and integrates `.coord/bin` into `PATH` immediately before invoking the harness command.
  - `src/setupWorkspace.ts` provides `writeGitWrapper` to safely render and write the wrapper without dirtying worktrees.
  - `src/install.ts` wires the wrapper during `coord install` and cleans it up during `coord uninstall`.
  - `src/productIgnore.ts` adds `.coord/` to `DEFAULT_CLONE_IGNORES`.
  - `githooks/post-merge` regenerates `.coord/bin/git` if missing.
  - `scripts/setup_claude.sh` and `scripts/setup_codex.sh` adjust guard hooks and rule configurations to prevent redundant git reads while guiding agents to read from `## Bound input files`.

- **Materialized Inputs System (`src/materializedInputs.ts`)**:
  - Exports `MATERIALIZED_MARKDOWN_KINDS`, `MATERIALIZED_PIN_KINDS`, `computeInputSetHash`, `materializeBoundInputs`, and `pruneSupersededWorktrees`.
  - Hashing over sorted markdown inputs content-addresses packets under `issue-<n>/inputs/<hash>/` with immutable `manifest.json`.
  - Detached worktrees are materialized under `issue-<n>/worktrees/<agent>-<sha8>/` and pruned during step transitions.
  - `src/paths.ts` safely validates and constructs containment paths (`issueInputsRoot`, `issueWorktreesRoot`, `inputPacketPath`, `inputWorktreePath`).
  - `src/action.ts` renders the `## Bound input files` section for Git and response actions.
  - `src/runLoop.ts` materializes inputs in `prepareAction` and `rewriteOrderedAction`, passing `materialized` metadata to `buildOrder`, and invokes `pruneSupersededWorktrees` upon `advance-step`.
  - `src/wipeIssue.ts` cleans up mirror worktree registrations during issue wipe.

---

### 2. Implementation Comparisons and Detailed Findings

#### A. Claude (`c2784bf31651db084f00eefeb103a4daa373d602`)
- **Strengths**:
  - Extremely thorough option parsing in `write_git_wrapper`, correctly distinguishing between operations targeting the local clone vs. foreign repositories/directories redirected via `-C`, `--git-dir`, or `--work-tree`.
  - Robust handling of directory permissions: keeps directories `0o700` while files are `0o400`, avoiding `ENOTEMPTY` deletion errors on POSIX systems during cleanup/wipe.
  - Comprehensive unit and integration test coverage across `test/install.test.ts`, `test/action.test.ts`, `test/runLoop.test.ts`, and `test/wipeIssue.test.ts`.
- **Verdict**: Complete, clean, and highly robust implementation.

#### B. Antigravity (`ec03d8e6a235294a16ef26cea55ee940d1ee1b73`)
- **Strengths**:
  - Clean modular architecture in `src/materializedInputs.ts` and precise integration with `src/runLoop.ts` and `src/paths.ts`.
  - Full test suite passing across all 40 test files (including 523 tests in `pnpm check:fast`).
  - Strict preservation of `0o700` directory handling with `0o400` blob permissions, ensuring clean issue wiping without permission leaks.
  - Robust `BareMirror` usage for worktree creation and pruning during wipe and run loop advancement.
- **Verdict**: Complete, clean, and fully passing all checks.

#### C. Codex (`fb608c5a8022b2ed7b78def20ad468fc37dd31b1`)
- **Strengths**:
  - Accurate implementation of `write_git_wrapper` and `materializeBoundInputs`.
  - Clear test extensions in `test/install.test.ts` and `test/runLoop.test.ts`.
  - Proper integration of worktree pruning and cleanup in `wipeIssue.ts`.
- **Verdict**: Solid and conforming implementation.

#### D. Cursor (`d89f2d6d61c268714e5a1065098dd235d284cc3e`)
- **Strengths**:
  - Well-structured implementation of `src/materializedInputs.ts` and `scripts/lib/launcher.sh`.
  - Good test additions covering action rendering and git wrapper execution.
- **Verdict**: Solid and conforming implementation.

---

### 3. Conclusion

All four implementations successfully solve Issue 124 in accordance with the selected plan. Claude (`c2784bf31651db084f00eefeb103a4daa373d602`) and Antigravity (`ec03d8e6a235294a16ef26cea55ee940d1ee1b73`) provide the most robust implementations with comprehensive test coverage and clean permission handling for POSIX file lifecycle operations.
