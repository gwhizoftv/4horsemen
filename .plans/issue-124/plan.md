# Issue 124: Reduce agent git waste — PATH wrapper + coordinator materialized inputs

## Exact File List to be changed or deleted

### Changed

- `scripts/lib/launcher.sh` — prepend `$(pwd)/.coord/bin` to `PATH` before harness `exec`; drop startup `git status -sb`; resolve read grants from coordinator-written grant file(s) and append `--add-dir` entries (inputs packet and/or implementation worktrees) alongside existing mailbox/response grants.
- `githooks/post-merge` — regenerate missing `.coord/bin/git` from the install-root template (same lifecycle as the launcher; never overwrite a customized wrapper).
- `src/productIgnore.ts` — add `/.coord/` to `DEFAULT_CLONE_IGNORES` so the untracked wrapper tree never appears in clone status.
- `src/setupWorkspace.ts` — call git-wrapper install/regeneration alongside `writeAgentLauncher`; export `writeGitWrapper` for install and post-merge.
- `src/install.ts` — invoke `writeGitWrapper` for each agent clone during install (after launcher write).
- `src/paths.ts` — add helpers for `issue-<n>/inputs/<inputSetHash>/`, `issue-<n>/worktrees/<agent>-<sha8>/`, and `agents/<agent>/read-grants.json` under the issue runtime.
- `src/materializedInputs.ts` *(new module listed in create section)* — imported from run loop, action renderer, and tests.
- `src/runLoop.ts` — in `prepareAction` / `rewriteOrderedAction`, after bound inputs are known: materialize Phase 1 blobs and Phase 3 worktrees via `mirror.readBlob` / `mirror.materializeWorktree`, write manifest + `read-grants.json`, attach materialized paths to the order passed to `buildOrder` / `writeAction`.
- `src/steps.ts` — extend `InternalOrder` with optional `materializedInputs` (manifest path, per-input local paths, worktree paths) consumed by `action.ts` and launcher grant writers.
- `src/action.ts` — add `## Bound input files` with absolute read paths; replace response-action guidance to read materialized files instead of “read-only Git commands”; keep pin SHAs in the existing inputs list as authority.
- `templates/product/AGENTS.protocol.md` — instruct agents to read bound inputs from filesystem paths in `action.md`; forbid `git status`, `git diff`, and undisciplined `git show` during automated issues (`COORD_ISSUE` set).
- `scripts/setup_claude.sh` — remove `git status` / `git diff` from allow list; add deny rules aligned with the PATH wrapper.
- `scripts/setup_codex.sh` — tighten `.codex/rules/git.rules` and `codex-instructions.md` to deny status/diff/show for peer artifacts and point at materialized paths.
- `scripts/setup_cursor.sh` — document the wrapper and materialized-input protocol (mirror Claude/Codex posture).
- `scripts/setup_antigravity.sh` — align git guard / permissions with status/diff/show restrictions where applicable.
- `src/wipeIssue.ts` — prune `issue-<n>/inputs/` and `issue-<n>/worktrees/` (and remove mirror worktrees via `mirror.removeWorktree`) during issue wipe.
- `src/agentLanguage.ts` — ban prose that tells agents to run `git status` / `git diff` / `git show` for peer coordination artifacts when materialized paths exist.
- `docs/coord-driver.md` — document wrapper gating, materialization layout, manifest schema, launcher grants, and ship order (Phase 1 before full `git show` block).
- `docs/setup-workspace.md` — note `.coord/bin/git`, clone exclude entry, and read-grant discovery at launcher startup.
- `package.json` — bump `0.0.27` → `0.0.28` for the PR version gate.
- `config.product.example.json` — bump installed coordination `version` to `0.0.28`.
- `test/install.test.ts` — assert wrapper exists, launcher prepends PATH, `REAL_GIT` is absolute, clone exclude lists `/.coord/`; extend grant tests when `read-grants.json` is present.
- `test/action.test.ts` — assert `## Bound input files` renders when materialized paths are bound.
- `test/runLoop.test.ts` — assert `prepareAction` writes manifest + grants and action lists filesystem paths; existing gate/verification behavior unchanged.
- `test/mirror.test.ts` — no change to mirror API; optional reuse only.
- `test/wipeIssue.test.ts` — assert inputs/worktrees directories are removed on wipe.
- `test/paths.test.ts` — cover new path helpers and containment.
- `test/cli.test.ts` — update version assertion to `0.0.28` if present.

### Deleted

- None.

## Exact file list to be created

- `scripts/lib/git-wrapper.sh` — canonical bash template; install substitutes `@REAL_GIT@` with `command -v git` from a PATH that excludes `.coord/bin`; implements `COORD_GIT_DELEGATE=1` re-entrancy, `COORD_ISSUE` gate, block rules from the issue spec, and stderr that cites materialized paths.
- `src/materializedInputs.ts` — classify bound inputs (Phase 1 coordination blob vs Phase 3 product pin via existing `inputFromSubmission` / `kind` conventions); compute content-addressed `inputSetHash`; write `manifest.json`; copy blobs from `EvidenceMirror.readBlob`; create persistent worktrees with `BareMirror.materializeWorktree`; write per-agent `read-grants.json`; expose `pruneSupersededInputs` for lifecycle cleanup.
- `test/gitWrapper.test.ts` — shell-level tests: blocked `status`/`diff`/`show` under `COORD_ISSUE`, allowed `rev-parse`/`commit` with hook delegate, transparent passthrough when `COORD_ISSUE` unset.
- `test/materializedInputs.test.ts` — unit tests for manifest entries (sha256, localPath, kind), missing mirror blob failure, and worktree path naming.

## Reuse and Scope

**Reuse**

- `BareMirror.readBlob` and `BareMirror.materializeWorktree` / `removeWorktree` (`src/mirror.ts`) — same trust boundary the coordinator already uses for verification and final checks (`runLoop.verifyFinalizationChecks` at the existing throwaway worktree path).
- `deriveBoundInputs`, `inputFromSubmission`, and `BoundInput` (`src/runLoop.ts`, `src/steps.ts`) — sole source of which pins bind an action; materialization is a side effect of the same list `buildOrder` already embeds in `action.md`.
- `computeInputSetHash` / canonical input serialization (`src/evidence.ts`) — derive `inputSetHash` for the manifest directory name so distinct bound sets do not collide.
- `writeAction` / `renderAction` (`src/action.ts`) — extend rendering only; parsing front matter stays unchanged.
- `writeAgentLauncher`, `writeCloneExclude`, post-merge launcher regeneration pattern (`src/setupWorkspace.ts`, `githooks/post-merge`) — mirror for git-wrapper install and template refresh.
- `containedPath`, `assertNoSymlink`, `issueRuntimePaths`, `agentRuntimePaths` (`src/paths.ts`) — all runtime writes stay inside the coord root with existing safety checks.
- `write_launcher` grant resolution (`scripts/lib/launcher.sh`) — same runtime discovery pattern as mailbox and ballot `responses/` (read `coord.workspaceConfig` + `COORD_ISSUE`, never grant `issue-<n>/` root or peer mailboxes).
- `pnpm check:fast` — lint, typecheck, and fast tests (`verify.precommit`); full `pnpm check` on approved commit.

**Scope**

- Part A (PATH wrapper) and Part B (Phase 1 markdown/json packet + Phase 3 full implementation worktrees) ship in this issue as defense in depth. No partial sparse export of changed paths only (explicitly out of scope per GitHub issue).
- Wrapper blocks `git show` for peer coordination reads only when Phase 1 materialization succeeded for that action; until then, allow narrowly scoped `git show <40-char-sha>:<path>` peer-pin reads as today.
- Manual mode (`COORD_ISSUE` unset): wrapper is transparent; materialization is skipped when no automated action binds inputs.
- Non-goals: agents copying peer artifacts into clone `tmp/`; mutating materialized content after write; replacing pin SHA authority in `action.md` or evidence verification.

**New files justified**

- `scripts/lib/git-wrapper.sh` — must live beside `launcher.sh` as the single template source for post-merge and install (same drift lesson as the launcher).
- `src/materializedInputs.ts` — isolates filesystem layout, manifest schema, and grant file writing from the already large `runLoop.ts`.
- Dedicated test files — wrapper behavior is shell-bound; manifest/worktree logic needs focused unit tests without bloating `install.test.ts`.

## Tests

Run before commit: `pnpm check:fast`.

| Area | Test file | What it proves |
| --- | --- | --- |
| Git wrapper | `test/gitWrapper.test.ts` | `.coord/bin/git` installed; `COORD_ISSUE=42` → `git status`/`git diff` exit 2; `git rev-parse HEAD` succeeds; `COORD_GIT_DELEGATE=1` allows hook subprocesses; unset `COORD_ISSUE` passthrough. |
| Install wiring | `test/install.test.ts` (extend) | Launcher contains `PATH=…/.coord/bin:…`; wrapper file executable; `REAL_GIT` not `.coord/bin/git`. |
| Materialization | `test/materializedInputs.test.ts` | Manifest records kind, agent, commitSha, path, sha256, localPath; duplicate pin deduped; missing blob throws at prep time. |
| Action render | `test/action.test.ts` (extend) | `## Bound input files` lists absolute paths; pin list unchanged. |
| Prepare loop | `test/runLoop.test.ts` (extend) | Review/compare prep writes `issue-<n>/inputs/<hash>/` and/or worktree; updates `read-grants.json`; journal/action-prepared unchanged semantics. |
| Wipe | `test/wipeIssue.test.ts` (extend) | Wipe removes inputs and worktrees under issue runtime. |
| Paths | `test/paths.test.ts` (extend) | New helpers reject traversal and symlinks. |

Prefer extending existing files where rows above say “extend”; add new files only for wrapper shell tests and materialization units.

## Alternatives Rejected

- **Sparse export of ~200 changed paths only** — compare/revise need full import/test context; agents would still run `git show`/`grep` to follow references. Full detached worktrees reuse proven final-check machinery.
- **Agents `git fetch` + read from origin refs** — current waste source; coordinator already holds blobs in the bare mirror.
- **Tracking `.coord/bin/git` in git** — pollutes product history; issue requires untracked generated wrapper like `start-<agent>.sh`.
- **Blocking all `git show` immediately** — breaks steps until Phase 1 materialization exists; ship Phase 1 first, then tighten show blocking when manifest is present.
- **Granting entire `issue-<n>/` via `--add-dir`** — exposes `cursors.json`, peer orders, and other coordinator-only state; grant only `inputs/<hash>/`, named worktrees, mailbox, and own `responses/`.

## Risks and Mitigations

- **Hook re-entrancy loops** — Mitigate with `exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@"` on every delegate path; test pre-commit still runs `git rev-parse` successfully.
- **False block of legitimate `git show`** — Mitigate by allowing `<sha>:<path>` form until materialized; after materialization, stderr cites exact filesystem paths from `action.md`.
- **Stale read grants if harness stays up across actions** — Mitigate by writing `read-grants.json` on every `prepareAction` and documenting that launcher reads grants at process start; nudge path already re-injects full `action.md` with paths.
- **Disk use from persistent worktrees** — Mitigate with `pruneSupersededInputs` when a newer pin supersedes the same agent/kind and full wipe on issue completion (`wipeIssue`).
- **Sandbox vendors and read-only trees** — Mitigate by listing absolute paths in `action.md` (unsandboxed agents) and `--add-dir` for sandboxed harnesses; Cursor already uses `--add-dir` for mailbox grants.
- **Wrong REAL_GIT after install on exotic PATH** — Mitigate by resolving once at install with `.coord/bin` stripped from PATH; post-merge regeneration re-resolves.

## Conclusion

Implement defense in depth: install an untracked `.coord/bin/git` wrapper (blocked `status`/`diff` and controlled `show` during automated issues), materialize bound coordination artifacts under `issue-<n>/inputs/<inputSetHash>/`, materialize bound product implementation pins as full read-only worktrees under `issue-<n>/worktrees/<agent>-<sha8>/`, expose both via `## Bound input files` and launcher `--add-dir` grants, and align setup scripts plus `AGENTS.protocol.md` so agents read the filesystem instead of repeating mirror git reads. Ship Phase 1 materialization before fully blocking undisciplined `git show`. Verify with `pnpm check:fast` and bump coordination to `0.0.28`.
