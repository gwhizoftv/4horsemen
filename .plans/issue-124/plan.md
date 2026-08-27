# Issue 124: Reduce agent git waste — PATH wrapper + coordinator materialized inputs

Two coordinated changes. **Part A** installs an untracked `git` wrapper in each
agent clone that refuses `git status` / `git diff` (and undisciplined `git show`)
during an automated issue. **Part B** makes the coordinator export the artifacts
an action binds — coordination markdown as files, product pins as full detached
worktrees — into read-only runtime storage, and lists those paths in `action.md`
so agents read the filesystem instead of fetching peer blobs.

They ship together: blocking a read is only safe once the filesystem
alternative exists.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh` — add `write_git_wrapper <path> <real_git> <clone>`
  emitting the wrapper body; in `write_launcher`, delete the startup
  `git status -sb || true` line, add the two Part B grants to `coord_grant`, and
  emit `export PATH="$(pwd)/.coord/bin:$PATH"` immediately before the `$command`
  exec so the launcher's own `git config` reads are unaffected.
- `src/setupWorkspace.ts` — add `writeGitWrapper({ installRoot, clone, options })`
  beside `writeAgentLauncher` (line 447): resolve `REAL_GIT` once with
  `spawnSync("bash", ["-lc", "command -v git"])` run with `.coord/bin` absent
  from `PATH`, render through `write_git_wrapper` in the shell library, stage
  outside the worktree and compare-before-write exactly as the launcher does.
- `src/install.ts` — call `writeGitWrapper` in the per-clone loop (after
  `writeAgentLauncher`, line 390) so `coord install` creates `.coord/bin/git`.
- `src/productIgnore.ts` — add `".coord/"` to `DEFAULT_CLONE_IGNORES` (line 35)
  so the wrapper never dirties a clone.
- `githooks/post-merge` — after the launcher block, regenerate `.coord/bin/git`
  from the same `$launcher_lib` when it is missing, using the same
  install-root-vs-vendored resolution already computed there.
- `coord` — export `COORD_GIT_DELEGATE=1` before the wrapper script execs the
  CLI, so coordination's own commands are never subject to the agent-facing
  block.
- `src/paths.ts` — add `issueInputsRoot` and `issueWorktreesRoot` to
  `IssueRuntimePaths`/`issueRuntimePaths`; add `inputPacketPath(paths, hash)`
  (validates `^[0-9a-f]{64}$`) and `inputWorktreePath(paths, agent, sha)`
  (`<agent>-<sha8>`), both via `containedPath`; create both roots in
  `createIssueRuntime`.
- `src/steps.ts` — add `MaterializedInputEntry`, `MaterializedWorktree`, and
  `MaterializedInputs` types beside `ChangeScopeEntry`, and an optional
  `materialized?: MaterializedInputs` field on `InternalOrder`. Types live here,
  next to `BoundInput`, so `steps.ts` stays free of a cycle back to the resolver.
- `src/action.ts` — add `boundInputFilesSection(materialized)` rendering a
  `## Bound input files` heading with JSON-encoded absolute paths via the
  existing `encodePath`; splice it into `renderGitAction` and
  `renderResponseAction` next to `changeScopeSection`; in `renderResponseAction`
  replace "Inspect the bound inputs with read-only Git commands only." with a
  sentence pointing at those paths.
- `src/runLoop.ts` — in `prepareAction` (line 865) and `rewriteOrderedAction`
  (line 979) call `materializeBoundInputs` on the same `deriveBoundInputs` result
  already computed for `resolveChangeScope`, thread the result through
  `buildOrder` (line 646) into `InternalOrder.materialized`; in the
  `advance-step` handler call `pruneSupersededWorktrees` with the pins the new
  step binds.
- `src/wipeIssue.ts` — before `rmSync(paths.issueRoot, …)` (line 433), run
  `git(paths.mirror, "worktree", "prune")` so a wiped issue leaves no stale
  worktree registration in the mirror.
- `scripts/setup_claude.sh` — drop `Bash(git status:*)` and `Bash(git diff:*)`
  from the `allow` list (lines 100-101); add a mode-aware block to the generated
  `.claude/hooks/git-guard.sh` that refuses `git status` / `git diff` only when
  `COORD_ISSUE` matches `^[1-9][0-9]*$`.
- `scripts/setup_codex.sh` — remove the `git diff`, `git status --short`, and
  bare `git show` `prefix_rule` lines from `.codex/rules/git.rules` (lines
  105-109); rewrite the `codex-instructions.md` paragraph that says "Read peer
  coordination files from fetched origin refs using `git show`" to point at the
  `## Bound input files` paths.
- `templates/product/AGENTS.protocol.md` — one paragraph: during an automated
  issue, read bound peer artifacts from the paths listed under
  `## Bound input files`; `git status` and `git diff` are refused by
  `.coord/bin/git`; do not re-derive checkout state.
- `docs/repo-map.md` — add `src/materializedInputs.ts` to the "Git access" row
  (line 29) and the wrapper's role to the `scripts/lib/launcher.sh` note at
  line 42.
- `test/runLoop.test.ts` — new cases beside the existing `resolveChangeScope`
  block (lines 1690-1760).
- `test/action.test.ts` — new cases beside the existing
  `## Changed paths for the bound pins` assertions (lines 181-245).
- `test/install.test.ts` — new cases in `describe("generated agent launchers")`
  (line 699) and one extension of the argv-equality launcher test (line 566).
- `test/wipeIssue.test.ts` — one case for the mirror worktree prune.

Nothing is deleted except the three `.codex/rules` lines, the two Claude allow
entries, and the launcher's `git status -sb` line.

## Exact file list to be created

- `src/materializedInputs.ts` — the only new source file. Exports
  `MATERIALIZED_MARKDOWN_KINDS` (`plan`, `review`, `selected-plan`),
  `MATERIALIZED_PIN_KINDS` (`implementation`, `revision`, `prior-revision`,
  `consensus`), `computeInputSetHash(inputs)`, `materializeBoundInputs({ mirror,
  paths, inputs })`, and `pruneSupersededWorktrees({ mirror, paths, keep })`.
  It is separate from `runLoop.ts` because that file is already 2369 lines and
  this is a self-contained resolver with a filesystem contract of its own — the
  same split `src/pinValidation.ts` and `src/finalization.ts` already use.
- `.plans/issue-124/plan.md` — this plan.

No new dependency, no new config key, no new CLI command.

### Wrapper body (rendered by `write_git_wrapper`)

```bash
#!/usr/bin/env bash
# Generated by `coord install`; never tracked. See scripts/lib/launcher.sh.
set -uo pipefail
REAL_GIT="<absolute path resolved at install>"
COORD_CLONE="<absolute clone root>"

[[ -x "$REAL_GIT" ]] || { echo "coord: $REAL_GIT is gone; re-run coord install." >&2; exit 127; }
[[ "${COORD_GIT_DELEGATE:-}" == 1 ]] && exec "$REAL_GIT" "$@"
[[ "${COORD_ISSUE:-}" =~ ^[1-9][0-9]*$ ]] || exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@"

# Skip leading global options to find the subcommand. Any option or environment
# variable that redirects the repository means this is not a read of the clone
# coordination owns, so it passes through untouched.
args=("$@"); sub=""; i=0
while (( i < ${#args[@]} )); do
  case "${args[$i]}" in
    -C|--git-dir|--git-dir=*|--work-tree|--work-tree=*|--namespace|--namespace=*)
      exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@" ;;
    -c) i=$(( i + 2 )) ;;
    -*) i=$(( i + 1 )) ;;
    *)  sub="${args[$i]}"; break ;;
  esac
done
[[ -n "${GIT_DIR:-}${GIT_WORK_TREE:-}" ]] && exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@"
case "$PWD/" in "$COORD_CLONE"/*) : ;; *) exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@" ;; esac

refuse() {
  echo "coord: git $1 is blocked during automated issue $COORD_ISSUE." >&2
  echo "  Coordination owns checkout state; read bound peer artifacts from the" >&2
  echo "  paths under '## Bound input files' in your action.md." >&2
  exit 2
}
case "$sub" in
  status|diff) refuse "$sub" ;;
  show)
    target="${args[$(( i + 1 ))]:-}"
    [[ "$target" =~ ^[0-9a-f]{40}: ]] || refuse "show"
    ;;
esac
exec env COORD_GIT_DELEGATE=1 "$REAL_GIT" "$@"
```

`add`, `commit`, `push`, `fetch`, `checkout`, `rev-parse`, `config`, `log`,
`merge-base` and everything else fall through to the final `exec`. Hooks that
the real git spawns inherit `COORD_GIT_DELEGATE=1` and are transparent.

### Materialized layout

```text
issue-<n>/inputs/<inputSetHash>/
  manifest.json
  plan-claude-<sha8>/.plans/issue-<n>/plan.md
  review-cursor-<sha8>/.plans/issue-<n>/review.md
issue-<n>/worktrees/<agent>-<sha8>/       # full detached tree at the pin
```

`inputSetHash` is `sha256` over the sorted `"<kind>\0<agent>\0<commitSha>\0<path>"`
lines of the markdown inputs only, so the packet is content-addressed and
immutable: if the directory already holds a `manifest.json`, materialization is
a no-op. `manifest.json` records `{ inputSetHash, entries: [{ kind, agent,
commitSha, path, sha256, localPath }] }`. Files are written `0o400` and packet
directories `0o500` after the last write, so the grant below cannot mutate them.

## Reuse and Scope

Reused without modification:

- `BareMirror.readBlob` (`src/mirror.ts:158`) for every markdown input, and
  `BareMirror.materializeWorktree` / `removeWorktree` (lines 179, 184) for every
  product pin — the same calls `verifyFinalizationChecks`
  (`src/runLoop.ts:1805`) and `ballotPublication.ts:480` already make. The
  resolver takes `Pick<BareMirror, "readBlob" | "materializeWorktree">`, matching
  the `Pick<EvidenceMirror, "readBlob">` style of `resolveApprovedPaths`
  (`src/runLoop.ts:585`) so tests pass a stub rather than a real mirror.
- `deriveBoundInputs` (`src/runLoop.ts:493`) and its `BoundInput.kind` values —
  the kind sets above are exactly the kinds it already emits. `PINNED_INPUT_KINDS`
  (line 602) is the existing precedent for splitting pins from markdown; the new
  set adds `consensus`, which is also a product pin.
- `sha256` / `sha256OfFile` (`src/hash.ts`) for the manifest and packet hash.
- `containedPath` and `assertNoSymlink` (`src/paths.ts`) for every write, and
  `createIssueRuntime`'s existing `mkdirSync(..., { mode: 0o700 })` pattern.
- `encodePath` and the `PATH_ENCODING_NOTE` constant (`src/action.ts:47,52`) so
  the new section escapes pathnames exactly as `repoContextSection` and
  `changeScopeSection` already do.
- `write_launcher`'s `coord_grant` array, the `COORD_ISSUE` regex, and the
  `coord.workspaceConfig` topology walk in `scripts/lib/launcher.sh` — the new
  grants are two more `--add-dir` entries computed by the same block, not a new
  mechanism.
- `writeAgentLauncher`'s render-to-staging-then-compare flow
  (`src/setupWorkspace.ts:447-489`) is copied structurally by `writeGitWrapper`
  for the same reason it exists: re-running the installer must not report a
  change, and rendering inside the worktree dirties the clone.
- `git` from `src/gitExec.ts` for the `worktree prune` in `wipeIssue.ts`, which
  already calls it against `paths.mirror` in `pruneIssueRefs` (line 413).
- Test fixtures: `test/support/workspaceFixture.ts` `product()` /
  `installOnce()` (used throughout `test/install.test.ts`), and the
  `resolveChangeScope` fixture mirror in `test/runLoop.test.ts:1690`.

Scope boundary: the coordinator's pin authority is untouched. `action.md` pins
remain the source of truth for verification; the materialized copy is a
convenience, and `git show <sha>:<path>` stays permitted as the fallback. No
step definition, gate, evidence schema, or accepted-submission shape changes.

Every path named above that will be edited is also listed in the file-list
sections.

## Tests

All new cases join existing files. Each fails before the change.

`test/install.test.ts` (extends `describe("generated agent launchers")` and the
argv-equality test at line 566):

1. *"installs an untracked git wrapper and puts it on the launcher's PATH"* —
   after `installOnce`, `.coord/bin/git` exists, is mode `0o755`, embeds an
   absolute `REAL_GIT` that is executable, `.git/info/exclude` contains
   `.coord/`, the clone reports no uncommitted changes, the launcher contains
   `export PATH=` with `.coord/bin` and no longer contains `git status -sb`.
   Fails today: the file is not written.
2. *"refuses status and diff during an automated issue and nothing else"* —
   executes the generated `.coord/bin/git` with `/bin/bash`,
   `COORD_ISSUE=42`, cwd = clone: `status` and `diff` exit `2` with stderr
   naming `Bound input files`; `rev-parse HEAD`, `add -A`, `fetch --help`,
   `commit --allow-empty -m "x"` (through the installed pre-commit hook) all
   exit `0`; `show <sha>:<path>` succeeds and bare `show HEAD` exits `2`.
3. *"stays transparent for manual mode and for repositories it does not own"* —
   same wrapper: `COORD_ISSUE` unset → `git status` exits `0`; with
   `COORD_ISSUE=42`, `git --git-dir <other>/.git status` and a `git diff` run
   with cwd outside the clone both exit `0`. This is the case that keeps a
   product's own test suite (`pnpm check:fast` here spawns `git status
   --porcelain` and `git diff` against tmpdir fixtures) working under the
   wrapper.
4. Extension of the existing argv test: with `issue-17/inputs` and
   `issue-17/worktrees` created, the captured argv equals
   `[…flags, --add-dir <drop>, --add-dir <responses>, --add-dir <inputs>,
   --add-dir <worktrees>]`, and still never contains the coord root, the whole
   mailbox, or a peer's drop.

`test/runLoop.test.ts` (beside the `resolveChangeScope` block):

5. *"materializes bound markdown into a content-addressed packet"* — two plan
   inputs and one review input produce `inputs/<hash>/manifest.json` whose
   `entries[].sha256` matches the file on disk at `localPath`, whose content
   equals `mirror.readBlob`, and a second call performs no further `readBlob`
   (spy count unchanged).
6. *"materializes a detached worktree per implementation pin and prunes
   superseded ones"* — an `implementation` input yields
   `worktrees/<agent>-<sha8>` containing the tree at that exact SHA;
   `pruneSupersededWorktrees` with a `keep` set excluding it removes the
   directory and calls `mirror.removeWorktree`.
7. *"prepareAction lists the materialized paths in action.md"* — one tick at
   `R3.review`; the written `action.md` contains `## Bound input files` and each
   listed path exists and is readable.

`test/action.test.ts`:

8. `renderAction` omits `## Bound input files` when `materialized` is absent or
   empty, emits it with JSON-encoded absolute paths when present, and the
   response-mode body no longer instructs read-only Git inspection.

`test/wipeIssue.test.ts`:

9. *"leaves no stale worktree registration behind"* — wipe an issue that has a
   materialized worktree; `git --git-dir <mirror> worktree list` lists only the
   bare mirror afterwards. Fails today: `rmSync` on `issueRoot` would orphan the
   registration.

Commands: `pnpm check:fast` (the declared `verify.precommit`: lint, typecheck,
`vitest run --config vitest.config.ts`) before every commit; `pnpm check` (build
+ `check:fast` + `vitest run --config vitest.e2e.config.ts`) is what the
coordinator runs on the approved commit.

## Alternatives Rejected

- **Sparse export of only the changed paths from `changeScope`.** The issue
  names this a non-goal: compare and revise need imports, tests, and config the
  diff does not contain, so agents would reach back for git anyway.
- **Blocking `git show` outright now.** The issue itself sequences Phase 1
  before full show-blocking. Keeping the `<sha>:<path>` form is the fallback
  when a packet is missing, which the "trust" design constraint asks for.
- **Hard `deny` of `Bash(git status:*)` in `.claude/settings.json`.**
  `settings.json` is static per clone and cannot see `COORD_ISSUE`, so a deny
  entry breaks owner-driven manual mode, which the safety rules require to stay
  unrestricted. The already-generated `git-guard.sh` PreToolUse hook is a shell
  script that reads the environment at call time, so the mode-aware rule belongs
  there and needs no new mechanism.
- **A git alias, a redirect of the hooks-path setting, or a shell function.**
  Aliases cannot shadow a built-in subcommand, git hook configuration is
  forbidden to touch, and a function is not inherited by the non-interactive
  shells the harnesses spawn. A PATH-shadowing executable is the only layer all
  four vendors share.
- **Granting each worktree individually in the launcher.** `write_launcher` is
  path-independent on purpose (documented at `scripts/lib/launcher.sh:88-100`):
  `githooks/post-merge` regenerates it with no issue number and no action id, so
  a baked-in per-action path would disagree with whichever writer ran last.
  Granting the two per-issue roots and making their contents `0o500`/`0o400`
  gives read-only access without re-rendering launchers per action.
- **Putting materialization in `runLoop.ts`.** It is already 2369 lines; a
  self-contained resolver with its own filesystem contract is what
  `pinValidation.ts` and `finalization.ts` are precedent for.
- **Reusing `computeDerivedInputSetHash` (`src/runLoop.ts:326`).** It hashes
  derivation *policy* inputs including the active roster and decision kind.
  Reusing it would tie packet identity to selection policy, so two identical
  input sets under different rosters would materialize twice.
- **Having agents copy peer artifacts into their own `tmp/`.** A Part B
  non-goal, and it puts unverified content inside a clone.

## Risks and Mitigations

- **The wrapper breaks a product's own test suite or tooling that shells out to
  git.** This repository's fast suite calls `git status --porcelain`
  (`src/gitExec.ts:71`) and `git diff` (`src/mirror.ts:165`). Mitigated by the
  redirect rules: any `-C`, `--git-dir`, `--work-tree`, `GIT_DIR`,
  `GIT_WORK_TREE`, or a cwd outside the clone delegates untouched, which covers
  every tmpdir fixture and every mirror call. Test 3 above is the guard.
- **`coord` CLI invocations from inside the clone hitting the block.** The
  repo-root `coord` wrapper script exports `COORD_GIT_DELEGATE=1` before it
  execs, so coordination's own CLI is never subject to the agent-facing block.
- **`REAL_GIT` baked at install becomes stale** (a toolchain upgrade, a PATH
  change). The wrapper checks `-x` and exits 127 with a message naming
  `coord install` rather than failing obscurely; `githooks/post-merge`
  regenerates the file when it is missing, the same lifecycle the launcher
  already has.
- **`--add-dir` is a writable grant, but materialized inputs must be
  immutable.** Files are `0o400` and packet/worktree directories `0o500` after
  write, so the filesystem refuses mutation regardless of the sandbox grant.
  `removeWorktree` runs before any prune so the coordinator can still clean up.
- **Stale worktree registrations in the mirror.** `wipeIssue` `rmSync`s the
  issue root, which would orphan `worktrees/*` registrations. Mitigated by
  `git worktree prune` against the mirror before the `rmSync` (test 9) and by
  `pruneSupersededWorktrees` at each step advance.
- **Disk growth from full trees.** One worktree per distinct pin, reused across
  the N agents on the same step; superseded pins pruned on advance; the whole
  issue root removed at wipe.
- **A missing mirror blob at prepare time.** `materializeBoundInputs` throws
  rather than silently omitting an entry, which is the loud failure the issue
  asks for — the pin was already verified when the submission was accepted, so a
  missing blob is real corruption, not a transient. The wrapper still permits
  `git show <sha>:<path>` so a stalled agent has a working fallback.
- **macOS `/bin/bash` 3.2.** The wrapper uses no associative arrays and no
  `${a[@]}` expansion of a possibly-empty array under `set -u`; the launcher's
  existing `${a[@]+"${a[@]}"}` idiom is kept for the grant array. Tests execute
  it with `/bin/bash` explicitly, as `test/install.test.ts:600` already does.
- **Protocol drift.** `AGENTS.protocol.md` is a managed block re-rendered by
  `writeCloneAgentsProtocol`; adding a paragraph reaches every clone on the next
  install, and `coord doctor`'s `agentsProtocol` finding already reports a clone
  that is behind.

## Conclusion

Install an untracked, mode-aware `.coord/bin/git` in every clone that refuses
`git status` and `git diff` — and undisciplined `git show` — only during an
automated issue and only for the clone coordination owns, and put it on the
launcher's `PATH`. In the same change, have `prepareAction` export the artifacts
it binds from the mirror it already reads: coordination markdown into an
immutable content-addressed packet under `issue-<n>/inputs/`, product pins into
full detached worktrees under `issue-<n>/worktrees/`, both listed in `action.md`
under `## Bound input files` and granted to the harness by the existing
`coord_grant` block. Agents then read peer work as ordinary files, and the reads
the wrapper refuses are ones they no longer need.
