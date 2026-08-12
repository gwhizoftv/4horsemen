# Code review: Antigravity plan for issue 6

- Reviewed head: `origin/issue-6/antigravity` @ `7ba010f4d68e652ed87b8c83f3ccfbf1653e20c9`
- Plan commit: `75ffc3a3480b54d278237d2171035111d9be3afc`
- Baseline: `origin/main` @ `f9d00841db8e5a95acb4e2956266825869e0758c`
- Scope: `.plans/issue-6/plan.md` and the post-plan review commit
- Reviewer: Codex

## Verdict

**Changes required.** The plan identifies the main user-facing commands, but it
is not mechanically acceptable as an R2 artifact and leaves several binding
choices unspecified. Implemented literally, it would overwrite or collide
multi-product state, fetch issues from the wrong repository, and allow the
issue snapshot to disappear from the digest. The branch's post-plan review path
also invalidates its immutable plan pin.

## Findings

### [P1] Move the post-pin review into the issue-scoped directory

**Path:** `.code-reviews/codex.md:1`. **Rule:** After an immutable issue-6 plan pin, the branch may advance only through `.plans/issue-6/**`, `.signals/issue-6/**`, or `.code-reviews/issue-6/**`. **Failure:** commit `7ba010f` adds `.code-reviews/codex.md` after plan pin `75ffc3a`; `validatePhasePin` returns `cross-issue-coordination-change`, so later evidence cannot bind this branch tip to the published plan. **Test:** call `validatePhasePin` for issue 6 with pin `75ffc3a` and tip `7ba010f` and require `{ ok: true }`.

### [P1] Add every section required by the R2 plan predicate

**Path:** `.plans/issue-6/plan.md:15`. **Rule:** `checkPlan` in `src/evidence.ts:60-70` accepts a plan only when it has exact non-empty File Map/Proposed Architecture, Tests/Validation, Alternatives, Risks, and Conclusion sections. **Failure:** `File Map & Proposed Changes`, `Tests & Documentation`, and `Simplifications & Edge Cases` match none of those exact headings, and Alternatives, Risks, and Conclusion are absent, so the plan produces all five section errors and cannot satisfy gate 2. **Test:** evaluate the exact plan blob as `plan-published` evidence and require a satisfied observation with no outstanding section errors.

### [P1] Specify the required bootstrap interface

**Path:** `.plans/issue-6/plan.md:17-23`. **Rule:** The shipped bootstrap must run under POSIX `sh`, honor both `--root` and `COORD_INSTALL_ROOT`, and skip launcher installation with `--no-path`. **Failure:** the plan names only the environment override and unconditional launcher installation, so an implementation following it cannot support the required `--root`/`--no-path` invocations and may introduce bash-only syntax that fails in the documented `curl | sh` path. **Test:** run the script with `dash` against a fixture source using `--root <tmp>/install --no-path`, then assert the custom root was built and no `~/.local/bin/coord` was created.

### [P1] Bind `gh issue view` to the configured origin repository

**Path:** `.plans/issue-6/plan.md:34-35`. **Rule:** Issue N must be fetched from the owner/repository derived from `config.origin` with an argv-safe explicit repository argument; process cwd must not select the issue source. **Failure:** `gh issue view N --json title,body` without `--repo` resolves from cwd, so `coord N --product /path/to/A` launched from product B can hash B's issue N while starting A's agents, or fail outside any GitHub checkout. **Test:** set cwd to repository B, resolve product A through `--product`, and require the injected runner argv to contain `--repo <A-owner/A-repo>` and the snapshot repository to identify A.

### [P1] Preserve an occupied flat config when onboarding another product

**Path:** `.plans/issue-6/plan.md:39-41`. **Rule:** Flat layout is only for an unoccupied runtime; if `<coord-root>/config.json` belongs to another project, a new product must use `workspaces/<project>/config.json`. **Failure:** changing `workspaceDirectory()` / `workspaceConfigPath()` to write directly under coord-root without an occupied-slot selector makes a second product overwrite the first product's flat config. **Test:** onboard two products into one coord-root and require the first config bytes to remain unchanged while the second resolves through a nested path.

### [P1] Namespace issue runtime paths by workspace

**Path:** `.plans/issue-6/plan.md:47-49`. **Rule:** Nested products sharing a coord-root need distinct mirror, snapshot, cursors, and journal paths for the same repository-local issue number. **Failure:** adding `issue-{issue}/snapshot.md` to the current outer-root `IssueRuntimePaths` leaves product A issue 42 and product B issue 42 on the same path; the second start overwrites A's snapshot or treats A's runtime as its own. **Test:** start issue 42 for two products sharing one outer root and assert every returned issue runtime path is contained by that product's resolved workspace root and differs from the other product's path.

### [P1] Keep the issue source outside optional `digestPaths`

**Path:** `.plans/issue-6/plan.md:43-45`. **Rule:** The fetched GitHub issue is mandatory digest material regardless of whether optional extra `digestPaths` are empty or customized. **Failure:** replacing the default path with `issue-{issue}/snapshot.md` still makes issue binding depend on a configurable list, so an explicit `digestPaths: []` removes the work statement and allows different issue bodies to share a config-only digest. **Test:** start with an explicit empty path list and require `automationDigestSources` to include the issue snapshot and the digest to change when only the issue body changes.

### [P1] Clean up a materialized snapshot after any start failure

**Path:** `.plans/issue-6/plan.md:49`. **Rule:** Every start-time file write must be inside the startup transaction and removed when any later preflight, mirror, tmux, or state initialization step fails. **Failure:** writing `issue-N/snapshot.md` before digest calculation creates `issue-N/`; if the subsequent baseline lookup or launcher preflight fails outside the current cleanup block, retry sees an existing runtime and refuses with "Runtime state already exists" even though no durable start was committed. **Test:** let issue fetch/write succeed, force the next baseline lookup to fail, and assert `issue-N/` is absent and an immediate retry can start normally.

### [P1] Persist the onboard-selected profile for numeric dispatch

**Path:** `.plans/issue-6/plan.md:28-33`. **Rule:** The profile selected during onboard must be persisted in workspace state so both `coord N` and `coord start N --product` can use it without a repeated flag. **Failure:** current `install --profile` only prints the profile in next-step text, and this plan adds no config or registry field; numeric dispatch therefore has no value for start's required `--profile` and either errors or silently hardcodes `consensus`, ignoring an onboard override. **Test:** onboard with `--profile reviewed`, invoke `coord N` without a profile flag, and require `start.json.profile` to equal `reviewed`.
