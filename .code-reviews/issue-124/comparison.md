# Issue 124 implementation comparison

Bound implementation pins (protocolVersion 1):

- Antigravity: `ec03d8e6a235294a16ef26cea55ee940d1ee1b73` at `.signals/issue-124/implementation-ready-antigravity.json`
- Cursor: `d89f2d6d61c268714e5a1065098dd235d284cc3e` at `.signals/issue-124/implementation-ready-cursor.json`
- Claude: `c2784bf31651db084f00eefeb103a4daa373d602` at `.signals/issue-124/implementation-ready-claude.json`
- Codex: `fb608c5a8022b2ed7b78def20ad468fc37dd31b1` at `.signals/issue-124/implementation-ready-codex.json`

Selected plan: Claude `3ac5aad5d214caea6298696a855d71a1b03d05bb`. Every pin changes the same nineteen product paths (`docs/`, `githooks/`, `scripts/`, `src/`, `templates/`, `test/`) plus agent-local coordination artifacts on each issue branch.

## Comparison

### Shared behavior

All four pins deliver the issue-124 defense-in-depth stack on the same surfaces:

1. **PATH git wrapper** — untracked `.coord/bin/git` installed at clone setup; launcher prepends it; blocks indiscriminate `git status` / `git diff` and tightens `git show` during automated issues (`COORD_ISSUE` set).
2. **Coordinator materialization** — `src/materializedInputs.ts` copies bound markdown artifacts into `issue-<n>/inputs/<hash>/` and product pins into `issue-<n>/worktrees/<agent>-<sha8>/` via the existing bare mirror.
3. **Action rendering** — `src/action.ts` adds `## Bound input files` with absolute read paths; pin SHAs in the inputs list stay authoritative.
4. **Launcher grants** — `scripts/lib/launcher.sh` adds parent `--add-dir` grants for `issue-<n>/inputs` and `issue-<n>/worktrees` when those directories exist (alongside existing mailbox/response grants).
5. **Clone hygiene** — `src/productIgnore.ts` ignores `/.coord/`; `githooks/post-merge` regenerates a missing wrapper; setup scripts and `AGENTS.protocol.md` steer agents toward filesystem reads instead of mirror git reads.
6. **Run-loop integration** — `src/runLoop.ts` materializes during `prepareAction` / `rewriteOrderedAction` and passes `materialized` into `buildOrder`.

Product-only diff volume (paths under `docs/`, `githooks/`, `scripts/`, `src/`, `templates/`, `test/` at each pin):

| Pin | Approx. changed lines | Dedicated materialization tests |
|-----|----------------------:|--------------------------------:|
| Antigravity `ec03d8e6` | 825 | `describe("materialized bound inputs")` with 2 cases in `test/runLoop.test.ts` |
| Codex `fb608c5a` | 865 | `describe("materialized bound inputs")` with packet, worktree, and prune cases |
| Cursor `d89f2d6` | 994 | extends existing runLoop/wipe tests; no dedicated materialization describe block |
| Claude `c2784bf` | 2059 | largest suite: materialization unit block, prepareAction integration, wipe worktree unregister |

Codex and Claude are structurally the closest pair (manifest validation, read-only trees, `makeMaterializedRootsWritable`, rich install/runLoop coverage). Antigravity is the smallest product diff. Cursor reuses the selected Claude plan's architecture with a leaner test footprint and a TypeScript-rendered wrapper template.

### Mechanical differences (non-defect unless noted below)

- **Git wrapper source of truth:** Claude (`src/setupWorkspace.ts:528-576`) and Codex render through `write_git_wrapper` in `scripts/lib/launcher.sh` with a managed marker; post-merge uses the same function. Cursor (`src/setupWorkspace.ts:494-558`) also embeds an identical policy in `renderGitWrapperContent`, so two templates must stay in sync. Antigravity uses the bash template only via a per-clone staging spawn (like early Codex).
- **Missing mirror blobs:** Codex (`src/materializedInputs.ts:148-149`) and Cursor (`src/materializedInputs.ts:104-106`) throw at preparation time. Claude records failures in an `omitted` list and still publishes the action with pin authority. Antigravity skips silently (finding below).
- **Issue wipe teardown:** Cursor calls `removeIssueMaterialization` (mirror unregister + `unlockDirectoryTree`) before `rmSync`. Codex/Claude chmod trees writable and/or unregister worktrees explicitly. Antigravity deletes the runtime tree then runs `git worktree prune`, which cannot collect registrations whose directories still exist.
- **Install performance:** Cursor caches `resolveRealGit` once per install (`src/install.ts:381-402`) and renders the wrapper without a bash subprocess; Claude caches similarly. Antigravity resolves and spawns bash per clone.
- **Scope extras:** Antigravity alone extends `src/install.ts` uninstall to remove `.coord/bin/git` and empty parent dirs — useful hygiene, not required by the selected plan file map.

### Findings

#### Antigravity — `src/materializedInputs.ts:70` — missing mirror blobs are skipped silently

**Rule:** When a bound markdown input cannot be read from the coordinator mirror at preparation time, materialization must fail loudly so the run loop retries rather than publishing an action whose `## Bound input files` section omits a bound pin.

**Concrete failure:** `if (content === null) continue;` drops the input, may write a manifest with fewer entries than bound inputs, and still returns success. An agent ordered to read a plan that failed to materialize keeps the pin SHA in `action.md` but has no filesystem path, recreating the git-read waste the issue removes.

**Test:** Stub `readBlob` to return `null` for one bound plan input; expect `materializeBoundInputs` to throw (as Codex does at `src/materializedInputs.ts:148-149`).

#### Antigravity — `src/wipeIssue.ts:434-435` — worktree registrations outlive the runtime tree

**Rule:** Materialized product worktrees must be unregistered from the bare mirror before their directories are deleted; `git worktree prune` only collects entries whose paths are already gone.

**Concrete failure:** `rmSync(paths.issueRoot, …)` runs first; the subsequent `git worktree prune` on the mirror finds nothing to collect while stale registrations remain. A later issue that materializes the same pin can hit `worktree add` failures. Claude avoids this by calling `git worktree remove --force` on each path first (`src/wipeIssue.ts:433-441`).

**Test:** Materialize a worktree, wipe the issue, then assert the mirror has no `worktree` registration for that path before starting another issue.

#### Cursor — `src/setupWorkspace.ts:494-558` and `scripts/lib/launcher.sh:20-63` — two canonical wrapper templates

**Rule:** The git wrapper must have a single template source shared by install and `githooks/post-merge`, so policy changes cannot drift between render paths.

**Concrete failure:** `renderGitWrapperContent` duplicates the heredoc already maintained in `write_git_wrapper`. A post-merge regeneration or a manual edit to one copy can block `git show <sha>:path>` in one install path while the other still allows it, with no test catching the divergence. Claude's managed-marker approach (`GIT_WRAPPER_MARKER` at `src/setupWorkspace.ts:496`) keeps one bash source.

**Test:** Assert byte equality between `renderGitWrapperContent(realGit, cloneRoot)` output and `write_git_wrapper` staging output for the same inputs.

#### Cursor — `test/runLoop.test.ts` (pin `d89f2d6`) — thinner materialization coverage than peers

**Rule:** Implementations should add the fewest focused tests needed, but still prove manifest idempotency, missing-blob failure, worktree deduplication, and wipe teardown — the behaviors the selected plan names.

**Concrete failure:** Cursor extends existing effectful run-loop cases with mirror stubs and cleanup helpers but lacks the dedicated `describe("materialized bound inputs")` block present in Antigravity, Codex, and Claude. A regression in `computeMarkdownInputSetHash` collision handling or `pruneSupersededWorktrees` keep-set logic would not fail fast tests until e2e. (A follow-up commit on the branch fixes e2e fixture teardown in `test/integration.test.ts`; that path is outside this product pin.)

**Test:** Port Claude's "materializes one worktree per distinct pin and prunes superseded ones" case from `c2784bf31651db084f00eefeb103a4daa373d602:test/runLoop.test.ts`.

#### Claude — `src/wipeIssue.ts:433-445` — read-only input packets are deleted without chmod

**Rule:** Issue wipe must remove materialized trees even when packet files were written read-only.

**Concrete failure:** Claude unregisters worktrees but calls plain `rmSync(paths.issueRoot)` without making `issue-<n>/inputs/` writable first. Cursor's `unlockDirectoryTree` (`src/materializedInputs.ts:203-228`) and Codex's `makeMaterializedRootsWritable` avoid `ENOTEMPTY` on locked trees. With only `0o400` files and `0o700` directories Claude usually succeeds; Cursor's `0o555` packet directories would fail without an unlock step.

**Test:** Wipe an issue whose inputs directory contains `0o444` files and `0o555` directories; expect runtime removal without error.

#### Codex — `src/setupWorkspace.ts` (pin `fb608c5a`) — per-clone bash spawn for wrapper install

**Rule:** Install should reuse one resolved `REAL_GIT` and avoid redundant subprocess work across four default agents.

**Concrete failure:** Each clone still stages the wrapper through `write_git_wrapper` in a separate bash invocation while Claude/Cursor cache `resolveRealGit`. This is a performance/maintainability gap, not a functional defect; onboard happy-path tests flirt with the 15s vitest timeout under parallel load.

**Sketch:** Cache `resolveRealGit` and skip re-render when the managed file already matches (Claude's marker check at `src/setupWorkspace.ts:574-576`).

### Scope, reuse, and verdict

| Agent | Stays within issue | Reuse of mirror/runLoop/evidence | Unnecessary files | Test focus |
|-------|-------------------|----------------------------------|-------------------|------------|
| Antigravity `ec03d8e6` | Yes; smallest product diff | Strong reuse; omits wipe unregister | None | Good unit block; wipe gap |
| Cursor `d89f2d6` | Yes; implements selected Claude plan leanly | Strong reuse; adds unlock helper | None | Adequate extensions; dual wrapper template |
| Claude `c2784bf` | Yes | Strong reuse; `omitted` resilience | None | Best coverage |
| Codex `fb608c5a` | Yes | Near-Claude; strict manifest checks | None | Strong; near-parity with Claude |

**Summary:** All four pins implement the same approved product surface. Claude `c2784bf31651db084f00eefeb103a4daa373d602` is the most complete (tests, single wrapper template, worktree unregister, partial-failure reporting). Codex `fb608c5a8022b2ed7b78def20ad468fc37dd31b1` matches closely with strict mirror failures and writable teardown. Cursor `d89f2d6d61c268714e5a1065098dd235d284cc3e` is a lean execution of the selected plan with correct core behavior but template duplication and lighter fast tests. Antigravity `ec03d8e6a235294a16ef26cea55ee940d1ee1b73` is the smallest diff but has the only silent materialization skip and the weakest issue-wipe worktree hygiene among the four.
