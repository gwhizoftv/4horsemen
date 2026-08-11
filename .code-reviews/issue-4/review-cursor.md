# Code review: Cursor implementation for issue 4

- Reviewed head: `f0aa7fd5e288ee69665595ec7a0f64c4f9477a7d`
- Baseline: `origin/main` at `a67338341d720160e7e30e8af2ea043d740564d4`
- Validation: `pnpm check` passed (118 focused tests and the four-agent E2E canary) under Node 23.11.0; the package declares Node 26. A fresh-workspace dry-run was also exercised directly and failed as described below.

## Verdict

**Changes required.** The default placement is pointed in the right direction: the product checkout remains untouched, while agent-local shims and owner-controlled configuration carry the policy. The implementation still has several fail-open hook paths, can overwrite unrelated product hooks, accepts unrelated repositories as agent clones, and does not satisfy the dry-run/idempotence and conservative-uninstall contracts.

## Findings

### [P1] Fail closed when pre-push cannot load workspace policy

**Path:** `githooks/pre-push:21`. **Rule:** Every pre-push in an agent-wired clone must exit non-zero when `coord.workspaceConfig` is missing, unreadable, or malformed. **Failure:** `coord_load_workflow_critical` returns 1, but this hook deliberately runs without `set -e` and ignores that status; it continues with empty scope arrays, skips `verify.prepush` for an ordinary one-ref push, prints “pre-push checks passed,” and exits 0. **Test:** invoke the installed pre-push hook with a valid owned ref update after deleting `coord.workspaceConfig`, and require a non-zero result mentioning the missing config.

### [P1] Preserve missing `verify` instead of turning it into opt-out

**Path:** `src/setupWorkspace.ts:250`. **Rule:** A missing top-level `verify` declaration must remain different from the explicit `{ "precommit": [], "prepush": [] }` opt-out. **Failure:** the nullish fallback writes an explicit empty policy whenever a template omits `verify`, so an operator typo becomes successful commits with all product checks skipped rather than the required fail-closed remediation. **Test:** install from a valid template with no `verify` key, assert the emitted config still omits it, and assert an agent commit is blocked.

### [P1] Fail closed on malformed verify phases

**Path:** `githooks/lib/workspace-config.sh:39-43`. **Rule:** Only a structurally valid, explicitly empty phase array may disable a hook phase; malformed policy must block. **Failure:** a config such as `{"verify":{"precommit":"typo"}}` is converted to an empty list and reported as an explicit opt-out, so commits proceed even though the declaration is invalid. **Test:** point an agent clone at that config and require `git commit` to fail with a malformed-policy diagnostic.

### [P1] Run pre-push verification when no narrowing policy exists

**Path:** `githooks/lib/workspace-config.sh:102-104`. **Rule:** Omitting both `workflowCriticalPrefixes` and `workflowCriticalFiles` must not silently narrow a non-empty `verify.prepush` policy to no files; absent narrowing means run for every push or fail closed. **Failure:** both lists become empty, `is_workflow_critical` can never match, and even `verify.prepush = [{"argv":["false"]}]` is skipped for every normal push. **Test:** omit both scope fields, push one product-file change with a failing pre-push command, and require the push to be rejected.

### [P1] Preserve and chain pre-existing agent-clone hooks

**Path:** `src/hookSync.ts:33-36`. **Rule:** Coordination may add agent-clone gating, but it must wrap or chain existing product hooks rather than overwrite unrelated hook policy. **Failure:** default installation replaces every named `.git/hooks/*` file unconditionally, and uninstall later deletes the replacement; an existing product pre-commit hook stops running as soon as coordination is installed and is not restored. **Test:** seed an agent clone with a sentinel pre-commit hook, install and uninstall coordination, and prove the sentinel still runs in both states.

### [P1] Reject unrelated repositories at an existing clone path

**Path:** `src/setupWorkspace.ts:274-279`. **Rule:** Every reused agent root must be verified as a clone of the configured product origin and synchronized to the configured shared branch before it is wired. **Failure:** any clean Git repository at `<product>-<agent>` is accepted without checking its remote or HEAD; coordination then installs the product’s identity and hooks into the unrelated repository, and the agent can push evidence to the wrong origin. **Test:** pre-create a clean clone at the expected path with a different `origin`, run install, and require refusal before any wiring changes.

### [P1] Let dry-run plan a fresh workspace

**Path:** `src/install.ts:89-93`. **Rule:** `--dry-run` must succeed without creating the clones whose creation it is previewing, while still validating knowable inputs. **Failure:** missing fresh agent roots are emitted as `config-incompatible`, and the filter treats every such finding as hard, so a normal first `coord install --dry-run` exits 2 with “Configured agent root missing.” **Test:** run dry-run against a clean product and nonexistent clone/runtime paths; require exit 0, planned actions, and no filesystem writes.

### [P1] Do not default arbitrary products to pnpm checks

**Path:** `src/setupWorkspace.ts:157-160`. **Rule:** Installing without a declaration must either infer product-appropriate argv once or require the owner to declare it; it must not import the coordination package’s ecosystem into an arbitrary product. **Failure:** the optional `--config` path falls back to `config.product.example.json`, whose verify/check argv are pnpm-specific. A Go-only product therefore either fails installation when pnpm is absent or receives hooks that run nonexistent pnpm scripts when pnpm happens to be installed. **Test:** onboard the documented Go fixture without `--config` and assert the emitted argv contain no pnpm commands and a failing declared Go check blocks commit.

### [P1] Make doctor detect hook wiring that Git will skip

**Path:** `src/doctor.ts:160-172`. **Rule:** A successful `doctor` must establish that Git will execute the canonical managed hook, not merely that a marker-bearing file exists. **Failure:** setting `core.hooksPath` to an empty directory (or removing the shim’s execute bit) silently disables `.git/hooks`, while doctor still finds and reads those files and returns success. **Test:** install, set `core.hooksPath` to an empty directory, and require a `bad-hooks` error and non-zero doctor exit.

### [P2] Treat install-stamp drift as a doctor failure

**Path:** `src/doctor.ts:89-94`. **Rule:** When `installRoot` no longer matches the stamped commit, doctor must report non-zero drift because shims execute the current, unstamped hook bodies. **Failure:** the mismatch is only a warning, and `report.ok` ignores warnings, so automation receives exit 0 even though the code enforcing every agent gate has changed since installation. **Test:** install, advance the install checkout by one commit, and require doctor to return a drift-class error.

### [P2] Preflight all dirty clones before destructive uninstall

**Path:** `src/install.ts:148-157`. **Rule:** A `--delete-clones` refusal must occur before any clone is unwired or deleted. **Failure:** clones are processed destructively in order; with a clean first clone and dirty second clone, the first is deleted and the second is unwired before the dirty check throws, leaving a partially uninstalled workspace while the config remains. **Test:** install two agents, dirty the second clone, request deletion without `--force`, and assert both clones and all wiring remain unchanged.

### [P2] Preflight doctor failures before writing the installation

**Path:** `src/install.ts:104-111`. **Rule:** A knowable install validation failure, such as a missing declared `argv[0]`, must be detected before clones, hooks, and workspace state are committed. **Failure:** `setupWorkspace` performs all writes first and doctor runs afterward, so `coord install` exits as failed but leaves live agent wiring and `config.json` behind. **Test:** declare a nonexistent command, require install failure, and assert no clone/config/hook was created.

### [P2] Make a reported no-op byte-for-byte idempotent

**Path:** `src/setupWorkspace.ts:299-300`. **Rule:** A second identical install reported as a no-op must not rewrite managed state. **Failure:** even when `sameInstallPayload` sets `noop = true`, the implementation rewrites every launcher and hook plus a new `installedAt` value in `config.json`, so file watchers, backups, and drift tooling observe changes while the CLI claims none. **Test:** snapshot bytes and mtimes after install, rerun with identical arguments, and require both to remain unchanged.

### [P2] Report product status after opt-in product writes

**Path:** `src/install.ts:120-125`. **Rule:** Install’s cleanliness message must describe the product tree after every requested mutation. **Failure:** `productStatusClean` was captured before `--write-product` creates `.gitignore`/`AGENTS.md`, so the command can print “Product master git status is empty” while `git status --porcelain` is non-empty. **Test:** install with `--write-product` into a clean product and require the final message to acknowledge the tracked changes.
