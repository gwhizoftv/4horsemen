# Issue 124 implementation plan

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh` — keep the generated launcher and Git-wrapper templates in the existing shared shell library; prepend `.coord/bin` to `PATH`, remove the startup `git status`, derive the dedicated runtime input/worktree roots, and grant only those roots plus the existing completion/response paths.
- `githooks/post-merge` — regenerate the coordinator-owned `.coord/bin/git` wrapper from the shared template and the installed absolute real-Git path, while retaining the existing launcher regeneration behavior.
- `src/setupWorkspace.ts` — resolve real Git once from a `PATH` with `.coord/bin` entries removed, render/update the wrapper idempotently, record/clear the new clone-local `coord.realGit` key, and remove only the managed wrapper during uninstall.
- `src/install.ts` — resolve real Git once per install, write the wrapper for every clone, pass the path into clone identity, include the wrapper in dry-run/idempotence reporting, and remove it conservatively on uninstall.
- `src/productIgnore.ts` — add `/.coord/` to the managed clone/product ignore block so the generated wrapper can never be swept into a product commit.
- `src/doctor.ts` — classify a missing, non-executable, or real-Git-mismatched wrapper/config key as launcher/install drift with a concrete reinstall remediation.
- `src/paths.ts` — add contained `inputs/` and `worktrees/` paths to `IssueRuntimePaths` and create their dedicated coordinator-owned roots before an issue harness starts.
- `src/steps.ts` — add the typed materialized-file/worktree descriptors carried by `InternalOrder` without changing the authoritative `BoundInput` citations.
- `src/action.ts` — render a `## Bound input files` section containing each exact pin/citation and absolute read path (plus the packet manifest), and replace the response-mode instruction to inspect inputs with Git when filesystem materializations exist.
- `src/runLoop.ts` — materialize derived inputs before writing, rewriting, or reissuing an action; attach the returned descriptors to the order; fail preparation before publishing an action when a bound blob/worktree cannot be produced; and unregister materialized worktrees when the issue completes.
- `src/wipeIssue.ts` — unregister any remaining issue materialization worktrees from the bare mirror before deleting the runtime tree during an abandoned/forced wipe.
- `scripts/setup_claude.sh` — stop allowlisting `git status`/`git diff` and make the existing PreToolUse guard reject them only when `COORD_ISSUE` is a positive issue number, leaving manual sessions unrestricted.
- `scripts/setup_codex.sh` — remove the project rules that pre-approve `git status`/`git diff`/unbounded `git show`, retain the mutating commands the workflow needs, and replace the peer-fetch/show instructions with direct reads from the action's materialized paths and a missing-packet escalation.
- `templates/product/AGENTS.protocol.md` — state that automated actions must use `## Bound input files`, must not re-derive checkout/change state with status/diff, and may use the exact pinned `git show <sha>:<path>` fallback only when the action reports that a packet is missing.
- `test/install.test.ts` — extend installation, launcher, wrapper, hook re-entrancy, manual-mode, post-merge regeneration, idempotence, setup-template, and uninstall coverage.
- `test/doctor.test.ts` — cover missing/modified wrapper and `coord.realGit` diagnostics separately from Git-hook diagnostics.
- `test/paths.test.ts` — cover contained input/worktree path derivation and creation.
- `test/action.test.ts` — cover deterministic rendering of file/worktree paths and the no-materialization fallback text.
- `test/runLoop.test.ts` — cover action-preparation integration, packet reuse, loud mirror failures, worktree pinning/supersession, reissue stability, and completion cleanup.
- `test/wipeIssue.test.ts` — cover mirror worktree cleanup before issue-runtime deletion.

No listed file will be deleted.

## Exact file list to be created

- `src/materializedInputs.ts` — one focused runtime-boundary module for classifying bound inputs, safely materializing immutable coordination packets and detached product worktrees, validating/reusing existing content-addressed outputs, and pruning registered worktrees. This file is justified because the filesystem safety, hashing, mirror I/O, and lifecycle logic is independently testable and would otherwise further enlarge `src/runLoop.ts`.

No dependency, standalone fixture, or new test file will be created; existing test suites will be extended.

## Reuse and Scope

- Reuse `deriveBoundInputs`, `inputFromSubmission`, and the existing product-pin kinds in `src/runLoop.ts`; `BoundInput` remains the citation authority and materialized paths remain convenience metadata only.
- Reuse `computeInputSetHash` from `src/evidence.ts` for a stable coordination-packet directory, `sha256`/`sha256OfFile` from `src/hash.ts` for manifest entries, and `atomicWriteJson` from `src/state.ts` for `manifest.json`.
- Reuse `containedPath`, `assertNoSymlink`, `issueRuntimePaths`, and `createIssueRuntime` from `src/paths.ts` for every runtime target. Coordination artifact files will be written beneath `inputs/<inputSetHash>/<kind>-<agent>-<sha8>/<repository path>` and described by `{kind, agent, commitSha, path, sha256, localPath}` entries. Existing packet bytes must hash exactly or preparation fails; completed packet files/directories become read-only and are never rewritten.
- Reuse `BareMirror.readBlob` for plan/review/selected-plan inputs and `BareMirror.materializeWorktree`/`removeWorktree` for unique product pins (`implementation`, `revision`, `prior-revision`, and `consensus`). Existing `<agent>-<sha8>` worktrees must resolve to the full bound SHA; a short-SHA collision or mismatched directory fails loudly rather than being reused.
- Reuse `buildOrder`, `writeAction`, `prepareAction`, `rewriteOrderedAction`, and `reissue` in `src/runLoop.ts`. The new helper returns descriptors only after all materializations succeed, so `action.md` is never published with unreadable paths. Reissues of the same pins reuse the same packet/worktrees; a newer action prunes obsolete registered worktrees only after its replacements are ready.
- Reuse `inputText`, `repoContextSection`, and `changeScopeSection` in `src/action.ts`; add one deterministic section rather than changing restricted front matter or replacing SHA authority.
- Reuse the existing `coord.workspaceConfig` topology logic in `scripts/lib/launcher.sh`. Because one persistent harness serves every action and later pins do not exist at launch, grant the two dedicated per-issue parent roots (`inputs/` and `worktrees/`) created before startup, never `issue-<n>/`; action text names the exact immutable child paths the agent may read. This avoids restarting agents and losing session context while still excluding `cursors.json`, journals, peer action/response directories, and mailboxes.
- Reuse `scripts/lib/launcher.sh` as the sole shell template source for both `coord install` and `githooks/post-merge`; no second wrapper template is introduced. The generated wrapper embeds the one absolute real-Git path resolved at install, recognizes Git global options before the subcommand, short-circuits on `COORD_GIT_DELEGATE=1`, and delegates with that guard so hooks' own Git reads cannot recurse.
- The wrapper is gated only by `COORD_ISSUE=^[1-9][0-9]*$`: it rejects status/diff with exit 2; permits only an exact forty-hex `<sha>:<path>` show fallback while the current action lacks `## Bound input files`; rejects all show reconnaissance once that section exists; and delegates add/commit/push/fetch/checkout/rev-parse and all other hook-required commands unchanged. Manual mode is transparent.
- Reuse `DEFAULT_CLONE_IGNORES`, clone identity helpers, existing launcher doctor classification, and the exact-file uninstall pattern. Do not modify product `githooks/`, action front-matter schema, evidence verification, pin validation, package dependencies, or unrelated workflow state.

## Tests

1. Extend `test/install.test.ts` with focused cases that fail before the change: install emits executable ignored `.coord/bin/git` containing an absolute non-wrapper `REAL_GIT`; launcher prepends it and no longer runs startup status; automated `git status`, `git -C . diff`, and unbounded show exit 2 with the materialized-path remediation; the exact pinned-show fallback works only before a bound-file section; rev-parse/add/commit/push plumbing still delegates; a real pre-commit hook completes under the delegate guard; unset `COORD_ISSUE` remains transparent; post-merge repairs the wrapper; second install is a no-op; uninstall removes only the managed wrapper; and generated Claude/Codex policy text no longer encourages status/diff/show reconnaissance.
2. Extend `test/paths.test.ts` to assert that `inputsRoot` and `worktreesRoot` are inside only the current issue runtime, are created before launch, and cannot escape through invalid issue/path data.
3. Extend `test/action.test.ts` to assert stable `## Bound input files` output for both artifact files and full worktrees, preservation of every authoritative pin/citation, manifest listing, JSON-safe hostile path rendering, and the legacy pinned-show fallback wording when no materialization exists.
4. Extend `test/runLoop.test.ts` using its existing fake mirror/state fixtures: plan/review bytes are written once to a hash-addressed packet with correct SHA-256 and absolute `localPath`; repeated agents/actions reuse it; implementation/revision inputs call `materializeWorktree` at the exact pin; newer pins remove obsolete worktrees only after replacement succeeds; reissues keep the same paths; missing blobs and worktree failures prevent action publication; and final completion unregisters all issue worktrees.
5. Extend `test/doctor.test.ts` for missing/non-executable wrappers, absent/non-absolute/non-executable `coord.realGit`, and healthy-install separation from hook findings.
6. Extend `test/wipeIssue.test.ts` to register a detached materialized worktree, wipe the issue, and prove both its directory and bare-mirror worktree registration are gone before the runtime is removed.
7. Run targeted validation first: `pnpm exec vitest run --config vitest.config.ts test/install.test.ts test/paths.test.ts test/action.test.ts test/runLoop.test.ts test/doctor.test.ts test/wipeIssue.test.ts`.
8. Run the required pre-commit suite: `pnpm check:fast`.
9. Run final acceptance: `pnpm check` (build, lint/typecheck/fast tests, and e2e).

## Alternatives Rejected

- Keep instructing every agent to fetch and `git show`: rejected because it preserves the measured repeated work and ignores blobs already verified in the coordinator mirror.
- Export only changed implementation paths: rejected because imports, tests, and configuration references routinely leave that sparse set; a complete detached pin is the existing trustworthy representation.
- Grant the whole issue runtime: rejected because it exposes `cursors.json`, journals, peer actions/responses, and other authority that the current mailbox design intentionally isolates.
- Restart each vendor harness for every newly known child path: rejected because the persistent session is part of the workflow and vendor-specific resume semantics would add more risk and scope than granting the two dedicated materialization-only roots.
- Track `.coord/bin/git` or put policy in product `githooks/`: rejected because the wrapper is clone-local installation state and human clones must remain unaffected.
- Resolve `git` through the already-prepended runtime `PATH`, or let the wrapper call itself: rejected because either can embed/re-enter the wrapper and break commits/hooks. Clean-PATH resolution plus `COORD_GIT_DELEGATE` is explicit and testable.
- Add a package dependency or a new persisted workflow-state schema: rejected because Node filesystem/crypto helpers, the existing mirror, and content-addressed directories are sufficient; materialized paths are derived cache state, not workflow authority.

## Risks and Mitigations

- A wrapper can misidentify a Git global option or recurse from a hook. Parse global options before selecting the subcommand, embed an absolute executable, set the delegate guard on every handoff, and exercise `-C`, `--no-pager`, commit-hook, and manual-mode cases.
- A packet could be partial, stale, symlinked, or mutated. Use contained/symlink-safe paths, temporary-plus-rename writes, canonical manifests with per-file SHA-256, read-only completed children, exact verification on reuse, and publish `action.md` only after success. Git pins remain the acceptance authority.
- Eight-character directory labels can collide. Verify the full forty-character HEAD/pin before reuse and fail preparation instead of silently sharing a path.
- Persistent harnesses cannot acquire a new exact child grant after launch. Pre-create and grant only the two per-issue materialization parents, make their coordinator-produced children read-only, list exact children in each action, and never place coordinator authority files under those parents.
- Removing a worktree directory without unregistering it poisons later mirror operations. Route supersession, normal completion, and wipe through `BareMirror.removeWorktree`, then verify cleanup in both run-loop and wipe tests.
- A mirror read may fail after inputs are bound. Treat missing blobs/worktree failures as action-preparation errors with no fallback action; the existing pin is not silently weakened or substituted.
- Vendor policy files could accidentally block owner-driven Git use. Keep hard enforcement in the `COORD_ISSUE`-gated wrapper (and Claude's similarly gated guard), remove unconditional Codex pre-approvals rather than adding a manual-mode-wide ban, and test with the variable unset.

## Conclusion

Implement one clone-local, automated-only Git gate and one coordinator-owned materialization boundary. Agents will receive exact filesystem copies/full worktrees backed by the unchanged bound SHAs, while hooks, publishing commands, manual sessions, human clones, and evidence verification retain their current behavior. The plan adds no dependency, no product hook, and only one narrowly justified source module.
