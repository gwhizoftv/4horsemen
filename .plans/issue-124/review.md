# Plan Review — Issue 124: Reduce Agent Git Waste (PATH wrapper + Materialized Inputs)

## Findings

### Finding 1: Global Git option handling in wrapper template
- **Plan claim or section**: Cursor and Antigravity wrapper sketches match on `${1:-}` to detect subcommands like `status`, `diff`, or `show`.
- **Rule that must hold**: The git PATH wrapper must reliably intercept blocked subcommands even when invocations include standard Git global options before the subcommand (e.g., `git -C <dir> status`, `git --no-pager diff`, `git --literal-pathspecs show`).
- **Concrete failure**: If an agent executes `git -C . status` or `git --no-pager diff`, `$1` evaluates to `-C` or `--no-pager`. The wrapper case statement fails to match `status` or `diff`, bypassing the block and executing `REAL_GIT`, defeating token waste reduction during automated issues.
- **Smallest correction**: In `scripts/lib/git-wrapper.sh` (or wrapper template generator), iterate through leading options with arguments (such as `-C`, `--git-dir`, `--work-tree`, `-c`) and flags until the first non-option token (the subcommand) is identified, then apply the `status`/`diff`/`show` rules.

### Finding 2: Harness grant stability across multiple issue rounds
- **Plan claim or section**: Cursor plan proposes per-action `read-grants.json` for dynamically discovered input directories.
- **Rule that must hold**: Persistent agent harnesses (such as Claude Code or Codex) spawned once at session start must be able to read materialized inputs and worktrees created on subsequent steps (e.g., during `R3.review`, `R5.compare`, or `R6.revise`) without process restart or losing conversation state.
- **Concrete failure**: Since CLI harnesses only parse `--add-dir` at launch time, dynamically adding grants to a new subfolder path in the middle of a session cannot expand the running harness sandbox. The harness will encounter sandbox access refusals when attempting to read newly materialized review inputs or compare worktrees.
- **Smallest correction**: Pre-create and grant the two dedicated per-issue parent directories (`issue-<n>/inputs` and `issue-<n>/worktrees`) in `scripts/lib/launcher.sh` at launch time. Make the coordinator-written child directories and files read-only (`0o500` / `0o400`), keeping coordinator authority files (`cursors.json`, `journal.jsonl`, peer mailboxes) outside these trees.

### Finding 3: Mirror worktree registration pruning on issue wipe
- **Plan claim or section**: `src/wipeIssue.ts` and `BareMirror.materializeWorktree` integration during issue teardown.
- **Rule that must hold**: Deleting the coordinator runtime directory (`issueRoot`) during `coord wipe` or issue finalization must not leave orphan git worktree entries in `mirror.git`.
- **Concrete failure**: If `rmSync(issueRoot, { recursive: true, force: true })` executes without first unregistering or pruning worktrees, `mirror.git` retains dangling pointers in `.git/worktrees/`. Subsequent worktree operations (such as running a new issue or final check worktrees) will fail with git errors stating that the worktree already exists or is locked.
- **Smallest correction**: Ensure `wipeIssue` and `removeIssueRuntime` invoke `BareMirror.removeWorktree` for active worktrees or execute `git worktree prune` against the mirror before recursive deletion of `issueRoot`.

## Conclusion

All four submitted plans (Antigravity, Claude, Codex, and Cursor) converge on the correct two-layer architecture: an untracked `.coord/bin/git` PATH wrapper gated strictly by `COORD_ISSUE` and guarded with `COORD_GIT_DELEGATE=1`, paired with coordinator-side input materialization for coordination markdown (`issue-<n>/inputs/<inputSetHash>/`) and full detached product worktrees (`issue-<n>/worktrees/<agent>-<sha8>/`).

The plans stay strictly within the issue scope, correctly reject the incomplete sparse-export alternative, reuse existing mirror and path containment logic, and establish clear test coverage. The Codex and Claude plans offer particularly precise guidance on launcher parent directory pre-granting and worktree lifecycle cleanup. With global option parsing in the wrapper and proper worktree pruning during wipe, the implementation will be robust and complete.
