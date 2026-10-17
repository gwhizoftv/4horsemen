# Issue 234 Plan Review

Reviewed plans:
- cursor (`950af137fa180b8f0d8a5a8805c4b4a0ac836b0d`) at `.plans/issue-234/plan.md`
- codex (`f42cecbaffc98d1d980eef1294b803e6a16844dc`) at `.plans/issue-234/plan.md`
- claude (`b41d415ef1dadbd91982d4410e16a38e6f63af9c`) at `.plans/issue-234/plan.md`
- antigravity (`0802da2c9c4f98e5517c3fa55e14e73a1d443c3a`) at `.plans/issue-234/plan.md`

## Findings

### 1. Missing `coord/` scope token in `cursor`, `claude`, and `antigravity` file maps

- **Plan claim or section**: `## Exact File List to be changed or deleted` in `cursor` (`950af137fa180b8f0d8a5a8805c4b4a0ac836b0d`), `claude` (`b41d415ef1dadbd91982d4410e16a38e6f63af9c`), and `antigravity` (`0802da2c9c4f98e5517c3fa55e14e73a1d443c3a`) lists the root wrapper only as `` `coord` `` without `` `coord/` ``.
- **Rule that must hold**: Every repository path modified by the implementation must be extracted into `approvedPaths` by `extractApprovedPaths` in `src/evidence.ts` (`isFileMapPath` rejects single-segment tokens without a dot unless written with a trailing slash like `` `coord/` ``, which `approvedTreeRoot` then normalizes to `"coord"`).
- **Concrete failure if the plan is followed as written**: `extractApprovedPaths` omits `"coord"` from the approved file map for those three plans, so the coordinator rejects any implementation commit that edits the root `coord` script as modifying an unapproved path, forcing a plan-amendment round before implementation can complete.
- **Smallest correction**: Include `` `coord/` `` alongside `` `coord` `` in `## Exact File List to be changed or deleted`, as `codex` (`f42cecbaffc98d1d980eef1294b803e6a16844dc`) does.

### 2. `cursor` mutates `PATH` for the coordinator process via `nvm use`

- **Plan claim or section**: `cursor` (`950af137fa180b8f0d8a5a8805c4b4a0ac836b0d`), `## Exact File List to be changed or deleted` item 3 and `## Risks and Mitigations` ("Sourcing nvm mutates PATH only inside the wrapper process — Acceptable and desired").
- **Rule that must hold**: `coord` must run its own JavaScript and self-build under Node `>= 26` without altering `process.env.PATH` inherited by child processes that inspect or execute the product workspace's toolchain (`coord doctor` command checks, `verificationRunner` product checks, and launched sessions).
- **Concrete failure if the plan is followed as written**: Running `nvm use` in `coord` before `exec node "$ROOT/dist/main.js" "$@"` prepends Node 26's `bin` directory to `PATH` for `dist/main.js` and every subprocess it spawns, shadowing the product workspace's development Node (e.g., `v16.18.0`) during coordinator-spawned checks.
- **Smallest correction**: Scope the `PATH` prefix to the `(cd "$ROOT" && PATH="$(dirname "$NODE_BIN"):$PATH" pnpm build)` subshell only, and `exec "$NODE_BIN" "$ROOT/dist/main.js" "$@"` with the caller's original `PATH` unchanged.

### 3. `cursor` and `antigravity` leave secondary coordinator entry points on ambient `node`

- **Plan claim or section**: `cursor` (`950af137fa180b8f0d8a5a8805c4b4a0ac836b0d`) and `antigravity` (`0802da2c9c4f98e5517c3fa55e14e73a1d443c3a`), `## Exact File List to be changed or deleted` and `## Reuse and Scope` (scoping changes only to `coord` and `test/wrapper.test.ts`).
- **Rule that must hold**: All coordinator entry points that execute `dist/main.js` in a workspace or agent clone where `PATH` resolves `node` to an older product version — including `gitCredentialHelperCommand` in `src/githubAuth.ts` during `coord onboard`, `githooks/lib/policy.sh` (`hook-verify` / `hook-scope`), `src/agentHookSync.ts` (`agent-event` / `git-guard`), `src/claudeStatusLine.ts`, and `src/install.ts` (`bootstrapCoordination`) — must also execute under a compatible Node `>= 26`.
- **Concrete failure if the plan is followed as written**: In a Node 16 workspace (or inside an agent clone after `launcher_environment` runs `nvm use` on a Node 16 `.nvmrc`), `git` credential helpers (`!/usr/bin/env node`), git hooks (`node "$entry"`), and agent lifecycle/shell-guard hooks (`/usr/bin/env node`) still launch `dist/main.js` under Node 16 and fail with `ERR_UNKNOWN_BUILTIN_MODULE: node:readline/promises`.
- **Smallest correction**: Use the resolved coordinator Node (`process.execPath` for generated callbacks and the shared shell selector for shell/hook entry points) across those dispatch boundaries.

### 4. `claude` skips later `PATH` candidates when the first `PATH` `node` is older

- **Plan claim or section**: `claude` (`b41d415ef1dadbd91982d4410e16a38e6f63af9c`), `## Design` item 2 ("`command -v node` on the caller's `PATH`: used if it qualifies... `${NVM_DIR:-$HOME/.nvm}/versions/node/v*/bin/node`: the highest qualifying version").
- **Rule that must hold**: When an older workspace Node appears first on `PATH` ahead of another compatible `node` (`>= 26`) later on `PATH` (for example, a system or Homebrew Node 26 without `nvm`), runtime resolution must inspect remaining `PATH` entries before failing.
- **Concrete failure if the plan is followed as written**: Probing only the single `command -v node` result and then only `NVM_DIR` fails with exit code 1 whenever `PATH` contains an older `node` ahead of a valid `node` `>= 26` and `NVM_DIR` is not used.
- **Smallest correction**: Iterate all `node` executables in `PATH` order before falling back to `NVM_DIR/versions/node`.

### 5. `codex` pre-clone `node` check in `scripts/bootstrap.sh`

- **Plan claim or section**: `codex` (`f42cecbaffc98d1d980eef1294b803e6a16844dc`), `## Exact File List to be changed or deleted` (`scripts/bootstrap.sh`) and `## Reuse and Scope` item 4 ("Use the shared selector from the cloned/updated install before dependency installation or build... Its standalone curl-to-sh entry remains usable: it must not require a sibling helper before cloning").
- **Rule that must hold**: `scripts/bootstrap.sh` must not reject a shell before cloning/updating `$root` merely because `command -v node` is absent from `PATH` when a compatible Node 26 is installed under `NVM_DIR` and will be selected by `$root/scripts/lib/node-runtime.sh` immediately after checkout.
- **Concrete failure if the plan is followed as written**: If `scripts/bootstrap.sh` retains the pre-clone `if ! command -v node >/dev/null 2>&1` guard at line 58 before cloning `$root` and invoking `$root/scripts/lib/node-runtime.sh`, bootstrap aborts before the selector can locate Node 26 in `NVM_DIR`.
- **Smallest correction**: Check `git` and `pnpm` before checkout, then run `$root/scripts/lib/node-runtime.sh` immediately after the clone/fast-forward step to validate and select Node 26 before `pnpm install --frozen-lockfile` and `pnpm build`.

## Conclusion

**Select `codex`'s plan (`f42cecbaffc98d1d980eef1294b803e6a16844dc`)**. It is the only plan that includes the `` `coord/` `` scope token required by `src/evidence.ts` to approve edits to the extensionless root `coord` wrapper without a plan amendment, covers both the root wrapper and the secondary hook/credential/callback entry points that otherwise fail under a workspace's older Node, preserves the caller's and workspace's `PATH`, justifies its single new shared shell helper (`scripts/lib/node-runtime.sh`), and extends existing test files with focused, hermetic regressions.
