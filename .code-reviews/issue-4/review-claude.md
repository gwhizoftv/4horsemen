# Code review: Claude implementation for issue 4

- Reviewed branch head: `d2e5226f82cc9c489a89556bddc27d8aca4fbf3d`
- Implementation under review: `72db53ab67d2ac788ea682302e6492e98c531d88` (the later commit adds review documents only)
- Baseline: `origin/main` at `a67338341d720160e7e30e8af2ea043d740564d4`
- Validation: `pnpm check` passed (168 focused tests and the four-agent E2E canary) under Node 23.11.0; the package declares Node 26. Reinstall transitions were also exercised directly: the hook manifest changed on an alleged no-op, and adding `--write-product` left `wroteProductIgnore: false`, causing uninstall to retain the managed block.

## Verdict

**Changes required.** This branch has the strongest issue-4 shape and test suite: config parsing is shared with the driver, absent scope gates every push, doctor has class-specific exits, and the default product footprint is clean. It is not ready to adopt because an installed agent clone deliberately fails open when identity disappears, several installer/uninstaller paths can overwrite or delete unrelated files, and the stamp/manifest checks do not yet establish what code Git is actually executing.

## Findings

### [P1] Fail closed when an installed agent loses its identity

**Path:** `githooks/lib/identity.sh:48-50`. **Rule:** The presence of coordination hooks in an agent clone means a missing or malformed `consensus.agentId` must block commit and push; human clones are protected by not receiving the hooks. **Failure:** deleting only `consensus.agentId` sets `CONSENSUS_AGENT_CLONE=false`, after which every hook exits 0 before branch, message, and verify checks, so an installed agent can commit and push completely ungated. **Test:** install an agent clone, unset `consensus.agentId`, and require both commit and push to fail with identity remediation.

### [P1] Validate agent IDs before deriving or writing paths

**Path:** `src/install.ts:120-129`. **Rule:** Every agent ID must pass the coordinator’s agent-ID schema, uniqueness check, and launcher support check before it participates in a filesystem path or any effect. **Failure:** only an empty list is rejected here; an ID such as `x/../../../outside` is normalized by `agentCloneDirectory` outside `--clone-root`, and the installer can clone there before the config schema or launcher eventually rejects it. **Test:** pass traversal, duplicate, and unsupported agent IDs and assert failure occurs with zero paths created outside or inside the workspace.

### [P1] Verify an existing clone belongs to the configured product

**Path:** `src/setupWorkspace.ts:285-287`. **Rule:** A reused agent path must be a Git worktree whose origin matches the configured product remote and whose shared-branch ancestry is usable; preserving in-flight work does not permit wiring an arbitrary repository. **Failure:** existence alone is accepted, so a clean clone of another repository at `<product>-<agent>` receives this product’s identity, policy, launcher, and hooks and can publish evidence to the wrong origin. **Test:** place an unrelated clean repository at the expected agent path and require install to refuse before modifying it.

### [P1] Chain existing agent-clone hooks instead of replacing them

**Path:** `src/hookSync.ts:118-128`. **Rule:** Coordination must preserve and chain any pre-existing product hook in an agent clone; adding coordination gates does not authorize deleting the product’s own gates. **Failure:** every differing hook is overwritten in place and its previous bytes are not recorded, so installation disables the prior hook and uninstall cannot restore it. **Test:** seed a sentinel pre-commit hook, install and uninstall coordination, and prove the sentinel still executes in both states.

### [P1] Keep opt-in product vendoring additive

**Path:** `src/hookSync.ts:235-244`. **Rule:** Even `--write-product --vendor` is additive and must never replace tracked product hooks wholesale. **Failure:** `vendorIntoProductTree` copies over any existing `githooks/<name>` with different bytes, silently destroying a product-maintained tracked hook. **Test:** commit a sentinel `githooks/pre-commit`, run the opt-in vendor install, and assert its behavior/content is preserved through an explicit chain or a refusal.

### [P1] Build and validate the workspace config before clone effects

**Path:** `src/install.ts:160-165`. **Rule:** All knowable declaration/schema/launcher failures belong to preflight and must happen before cloning or wiring anything. **Failure:** clones and hooks are created before `buildWorkspaceConfig` runs; for the already-tested plain product with no inferable final checks, install throws “Cannot infer finalization checks” only after leaving a wired agent clone and no workspace config. **Test:** run that refusal case and assert the clone, launcher, hooks, product tree, and runtime are all unchanged.

### [P1] Do not infer checkout ownership from running bootstrap commands

**Path:** `src/install.ts:254-255`. **Rule:** `bootstrapped` may authorize recursive deletion only when coordination actually created and owns the install checkout. **Failure:** `--bootstrap-coordination` merely runs `pnpm install` and `pnpm build` in the pre-existing checkout from which this CLI is executing, yet stamps it as owned; a later `uninstall --delete-coordination` can recursively delete that independently installed source repository. **Test:** bootstrap an existing checkout and require `--delete-coordination` to refuse unless a separate creation/ownership record proves the checkout was installer-created.

### [P1] Preflight uninstall refusals before removing any wiring

**Path:** `src/install.ts:397-405`. **Rule:** Dirty-clone and coordination-ownership refusals must be decided before hooks, identity, launchers, workspace state, or any clone are removed. **Failure:** the function unwires every clone at lines 366-385 before checking dirtiness here; a dirty clone is “refused” but remains with its coordination hooks and identity already deleted, and earlier clean clones may already be gone. **Test:** dirty one clone, request `--delete-clones` without force, and assert every clone and all workspace wiring remain byte-for-byte unchanged.

### [P1] Confine manifest-driven deletion to known hook files

**Path:** `src/hookSync.ts:162-171`. **Rule:** An agent-writable manifest must be schema-validated and may name only the fixed managed hook/lib paths beneath `.git/hooks`. **Failure:** uninstall trusts arbitrary `manifest.files` keys and joins them without containment; an edited entry such as `../../../victim` with the target’s digest makes owner-run uninstall delete a matching file outside the hook directory. **Test:** inject an escaping manifest key and require uninstall to reject it without deleting any file.

### [P1] Verify hooks against canonical bytes and executable modes

**Path:** `src/hookSync.ts:203-219`. **Rule:** Doctor must independently prove that the complete expected hook set is executable and matches the canonical install/vendor source; the clone-local manifest is evidence to verify, not authority. **Failure:** an agent can replace `pre-commit` with `exit 0` and update the manifest digest, or simply remove its execute bit, and `inspectCloneHooks` returns `ok` because it trusts the edited digest and never checks mode. **Test:** cover both mutations and require a `hooks` finding plus non-zero doctor exit.

### [P1] Cross-check each clone’s install paths against the stamp

**Path:** `src/doctor.ts:164-173`. **Rule:** In shim mode, `coord.installRoot` and `coord.cliEntry` must equal the stamped paths, not merely be non-empty. **Failure:** changing a clone’s `coord.installRoot` to a missing or older checkout still yields a healthy doctor report—the global stamped root exists and the shim bytes match—while real commits either block unexpectedly or execute a different hook implementation. **Test:** redirect those two local keys after install and require an `installRoot`/drift finding.

### [P1] Attest the working bytes used by shim installs

**Path:** `src/hookSync.ts:249-258`. **Rule:** The install stamp must identify the actual canonical hook/CLI bytes agents execute, so a shim install must reject a dirty install checkout or record and verify content digests. **Failure:** only `HEAD` is stamped; an uncommitted edit that changes `githooks/pre-commit` to `exit 0` leaves the same commit, and doctor verifies only the clone shim plus `HEAD`, reporting healthy while every clone executes the modified body. **Test:** dirty one canonical body without committing, then require install or doctor to fail with install drift.

### [P2] Refresh all option-dependent stamp fields on reinstall

**Path:** `src/install.ts:270-276`. **Rule:** A prior timestamp may be reused only when every stamped property is unchanged; delivery mode, bootstrap ownership, clone/product roots, and managed-product ownership must reflect the current install. **Failure:** reinstalling first without and then with `--write-product` reuses `wroteProductIgnore: false`; uninstall consequently leaves the newly managed `.gitignore` block behind. Switching to `--vendor` similarly leaves `vendored: false`. **Test:** exercise both mode transitions and assert the emitted stamp and uninstall behavior match the second invocation.

### [P2] Make a no-op reinstall leave the hook manifest untouched

**Path:** `src/hookSync.ts:131-143`. **Rule:** A second identical install reported with an empty change list must not mutate managed files. **Failure:** `writtenAt` is regenerated and `coord-hooks.json` is always rewritten even when every hook is classified unchanged; direct execution confirms the manifest digest changes while the API reports `changes: []`. **Test:** snapshot manifest bytes/mtime, rerun identical install, and require both to remain unchanged.

### [P2] Classify schema-incompatible configs through doctor

**Path:** `src/doctor.ts:305-310`. **Rule:** Doctor’s `startCompatibility` class must cover any workspace config that `coord start` would reject, including malformed JSON and schema failures. **Failure:** `readConfig` throws before a report is constructed, so the CLI falls back to generic exit 2 instead of the documented class-specific code 15/remediation. **Test:** remove a required config field and require a rendered `startCompatibility` finding with exit 15.

### [P2] Run installer Git commands with the existing hermetic environment

**Path:** `src/gitExec.ts:10-12`. **Rule:** Owner-side Git subprocesses must clear ambient repository/config redirectors just like the mirror and run loop do. **Failure:** inherited `GIT_DIR`, `GIT_WORK_TREE`, or `GIT_CONFIG_*` can redirect `requireWorktree`, remote discovery, and local-config writes away from the supplied product/clone paths, defeating containment and wiring the wrong repository. **Test:** set each redirector to a second repository during install and prove all operations still target only the explicit paths.

### [P2] Require command candidates to be executable

**Path:** `src/hookPolicy.ts:73-77`. **Rule:** Doctor may call an argv executable resolvable only when the exact file Git hooks will spawn exists and is executable. **Failure:** `existsSync` accepts directories and non-executable files on `PATH`, so doctor returns success but the first hook fails with `EACCES`/spawn error. **Test:** place a non-executable file with the declared name first on `PATH` and require a `toolchain` finding.
