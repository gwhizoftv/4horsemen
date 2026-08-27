# Plan review — issue 124 (cursor)

Reviewed bound plans at pins `b173b8e`, `ae1b4285`, `3ac5aad5`, and `e2de333f`.

## Findings

### Cursor plan (`b173b8e`) — launcher grants via `read-grants.json`

**Claim:** `scripts/lib/launcher.sh` resolves read grants from coordinator-written `read-grants.json` and appends `--add-dir` entries; `prepareAction` writes that file per action.

**Rule:** A persistent harness started once per issue (`write_launcher` is intentionally path-independent and has no action id; see `scripts/lib/launcher.sh:85-94`) must expose materialized inputs without restarting the vendor CLI.

**Failure:** The launcher runs before the first `prepareAction` for that session, so `read-grants.json` does not exist at startup and later updates are invisible until the agent process exits. Compare/review agents on a long-lived tmux pane never receive `--add-dir` for the packet or worktrees, cannot read sandboxed paths, and fall back to blocked `git show`.

**Correction:** Follow the Claude/Codex pattern: create `issue-<n>/inputs/` and `issue-<n>/worktrees/` at issue start (`createIssueRuntime`), grant those two parent directories in the launcher when they exist, and list exact child paths in `## Bound input files`.

---

### Cursor plan (`b173b8e`) — Git wrapper scope

**Claim:** Part A wrapper blocks `status`/`diff` and tightens `show` when materialized inputs exist; Tests section does not require passthrough for `-C`/`--git-dir`, cwd outside the clone, or `GIT_DIR`.

**Rule:** Automated issues must not break the coordination package's own git usage or product checks that run from the clone cwd against other repositories (`src/gitExec.ts` uses bare `git`; `BareMirror` uses `git diff` with cwd in tmpdir/mirror paths).

**Failure:** A minimal wrapper that only checks the subcommand name blocks `git -C <mirror> …` and `git diff` invoked from Node/hooks while cwd stays in the agent clone, breaking `pnpm check:fast`, hook verification, and any `coord next` path that shells to git without setting `COORD_GIT_DELEGATE`.

**Correction:** Adopt Claude's wrapper sketch: delegate on `COORD_GIT_DELEGATE=1`, global `-C`/`--git-dir`/`--work-tree`, `GIT_DIR`/`GIT_WORK_TREE`, and cwd outside `COORD_CLONE` before applying blocks.

---

### Cursor plan (`b173b8e`) — `computeInputSetHash` for Phase 1 packet

**Claim (Reuse):** Reuse `computeInputSetHash` from `src/evidence.ts` for the manifest directory name.

**Rule:** Phase 1 stores coordination markdown/json only; Phase 3 stores product pins as worktrees under separate paths (issue spec Part B Phase 1 vs Phase 3).

**Failure:** `computeInputSetHash` hashes every `BoundInput`. On `R5.compare`/`R6.revise` steps the bound set is all product-pin kinds with no markdown blobs; materialization keyed that way either creates an empty `inputs/<hash>/` tree or mixes worktree identity into the packet hash.

**Correction:** Hash only markdown/json kinds (`plan`, `review`, `selected-plan`, ballot paths) for `inputs/<inputSetHash>/`, as Claude specifies; keep worktrees at `worktrees/<agent>-<sha8>/` independent of that hash.

---

### Cursor plan (`b173b8e`) — file list hygiene

**Claim:** `src/materializedInputs.ts` appears under both **Exact File List to be changed or deleted** and **Exact file list to be created**; `test/mirror.test.ts` is listed as changed with body "no change".

**Rule:** Plan file lists must name every path the implementation may touch and must not contradict themselves (AGENTS.md plan discipline).

**Failure:** A implementer following the changed list might edit a file that should be created, or skip mirror tests thinking the plan requires a change when it does not.

**Correction:** List `src/materializedInputs.ts` only under created; drop `test/mirror.test.ts` from the changed list or state a concrete assertion if one is needed.

---

### Antigravity plan (`ae1b4285`) — `src/hookSync.ts`

**Claim:** `src/hookSync.ts` is in the changed file list with no section explaining why.

**Rule:** Every path in the file-list sections must correspond to a described behavior change; scope stays within the issue.

**Failure:** Implementers edit hook delivery/shim logic without a requirement, risking unrelated regressions in product hook installation.

**Correction:** Remove `hookSync.ts` unless a concrete hook-template change is identified; the git wrapper is untracked under `.coord/`, not a `githooks/` product change.

---

### Antigravity plan (`ae1b4285`) — acceptance and vendor coverage gaps

**Claim:** Changed files cover core coordinator paths and four test files; setup scripts list only Claude and Codex.

**Rule:** GitHub issue acceptance includes setup scripts/protocol alignment for all configured harnesses and `pnpm check:fast` passing on the approved commit; this repo gates PRs on a coordination version bump (`package.json` / `config.product.example.json`).

**Failure:** Cursor and Antigravity agent clones keep vendor instructions that encourage `git status`/`git diff`/`git show` peer reads; the PR fails the version gate because no `0.0.27 → 0.0.28` bump is listed.

**Correction:** Add `scripts/setup_cursor.sh`, `scripts/setup_antigravity.sh`, `package.json`, and `config.product.example.json` to the changed list with the same posture as Claude/Codex.

---

### Claude plan (`3ac5aad5`) — created-file list includes the plan artifact

**Claim:** **Exact file list to be created** includes `.plans/issue-124/plan.md — this plan`.

**Rule:** Created lists name source/test files the implementation adds; the plan itself is evidence, not part of the product diff.

**Failure:** A mechanical file-map check treats the plan path as implementation scope and blocks or duplicates work already on the issue branch.

**Correction:** Remove `.plans/issue-124/plan.md` from the created list.

---

### Claude plan (`3ac5aad5`) — missing operator docs and doctor

**Claim:** Docs changes are limited to `docs/repo-map.md`; no `docs/coord-driver.md` / `docs/setup-workspace.md`; no `src/doctor.ts` entry.

**Rule:** Install-time artifacts (wrapper, grants, materialization layout) must be discoverable via existing operator docs and `coord doctor`, which already classifies launcher drift.

**Failure:** Owners with stale or missing `.coord/bin/git` get no doctor finding; setup docs still describe launchers without PATH wrapping or materialization roots.

**Correction:** Add `src/doctor.ts` and the two setup/coord-driver doc files Codex lists, reusing existing doctor clone-inspection patterns.

---

### Codex plan (`e2de333f`) — block all `git show` once bound files exist

**Claim (Reuse and Scope):** Wrapper rejects all show reconnaissance once `## Bound input files` exists; only `<sha>:<path>` is allowed before that section.

**Rule:** Issue design constraints state manifest + unchanged pin binding with **`git show` remaining fallback if packet missing**; pins in `action.md` stay authoritative.

**Failure:** An action lists materialized paths but a sandbox grant fails or a file is temporarily unreadable; blocking every `show` removes the documented fallback even though verification still accepts the pin citation.

**Correction:** Gate strict show blocking on successful materialization (manifest present and entries verified), not merely on the markdown heading; keep `<sha>:<path>` as fallback when materialization failed or a listed path is missing.

---

### Codex plan (`e2de333f`) — `coord.realGit` config key

**Claim:** `setupWorkspace.ts` records/clears clone-local `coord.realGit`; doctor validates it.

**Rule:** Smallest change that fully solves the issue; reuse existing install identity keys (`coord.installRoot`, `coord.workspaceConfig`, `consensus.agentId`).

**Failure:** A new config key expands install/uninstall/doctor surface without being required—the wrapper already embeds `REAL_GIT`, and doctor can check wrapper executability and embedded path directly.

**Correction:** Omit `coord.realGit` unless doctor cannot parse the wrapper; prefer doctor checks on `.coord/bin/git` content and `-x` like install tests.

---

### Cross-plan — `coord` CLI and Node-spawned git

**Claim:** Claude lists `coord` exporting `COORD_GIT_DELEGATE=1`; Cursor, Antigravity, and Codex omit any Node/CLI delegate story.

**Rule:** Wrapper must never block commit, push, fetch, checkout, or hook `rev-parse`; internal coordination git must keep working when agents invoke `coord next` from a clone whose `PATH` prefers `.coord/bin`.

**Failure:** `spawnSync("git", …)` in `src/gitExec.ts` and `spawn("git", …)` in `src/mirror.ts` inherit the agent's PATH; without `COORD_GIT_DELEGATE` on the `coord` entrypoint (or hermetic absolute git in Node), owner/agent CLI subprocesses hit the same blocks as the harness.

**Correction:** Export `COORD_GIT_DELEGATE=1` in the repo-root `coord` wrapper before `exec node`, and document that hooks already rely on the wrapper's delegate guard.

---

### Cross-plan — scope and reuse (positive)

All four plans stay within issue 124, reject sparse path export, reuse `BareMirror.readBlob` / `materializeWorktree`, extend existing test files rather than inventing broad new suites (Codex most aggressively), and name `pnpm check:fast` as the pre-commit gate. Claude and Codex best match launcher/grant timing and wrapper passthrough; Claude is the most test-complete; Codex best covers doctor/wipe/run-loop integration and idempotent install/uninstall.

## Conclusion

No bound plan is ready to implement verbatim. **Claude's plan** is the strongest base: correct grant model (persistent `inputs/` and `worktrees/` roots), detailed wrapper passthrough rules, markdown-only packet hashing, and the broadest focused tests—but it should drop the plan path from created files, add doctor/docs/version bumps, and keep `<sha>:<path>` show fallback after materialization failures. **Codex's plan** should be merged for doctor, wipe-time `removeWorktree`, install idempotence, and run-loop failure modes, while relaxing show blocking and dropping `coord.realGit`. **Cursor's plan** must replace `read-grants.json` with parent-dir grants and add wrapper passthrough tests. **Antigravity's plan** should drop unexplained files (`hookSync.ts`), add missing vendors and version bumps, and adopt the same grant and wrapper details.

Implement from a merged file map satisfying the issue acceptance criteria; run `pnpm check:fast` before commit and bump coordination to `0.0.28`.
