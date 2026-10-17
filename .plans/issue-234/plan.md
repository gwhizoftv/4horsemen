# Issue 234 Implementation Plan — Verify and Resolve Node Version in `coord`

## Exact File List to be changed or deleted

- `coord`
- `test/wrapper.test.ts`

## Exact file list to be created

None. No new files will be created.

## Reuse and Scope

- **`coord`**:
  - Reuse the existing symlink-resolution loop (`SOURCE` -> `ROOT`), `.nvmrc` in `ROOT` (which pins `26`, matching `package.json` `"engines": { "node": ">=26.0.0" }`), and the stale-build check (`find "$ROOT/src" -type f -newer "$ROOT/dist/main.js"`).
  - Follow the `NVM_DIR="${NVM_DIR:-$HOME/.nvm}"` convention already used in `scripts/lib/launcher.sh` (`launcher_environment`) and `scripts/setup_common.sh` (`common_ensure_node_version`), adapted so `coord` resolves its own Node binary without changing the workspace's `.nvmrc` or mutating the `PATH` inherited by `dist/main.js`.
  - Specifically, `coord` will:
    1. Determine the required minimum major Node version from `$ROOT/.nvmrc` (defaulting to `26`).
    2. Define a Bash 3.2-compatible helper `node_is_compatible <bin>` that checks `[[ -x "$bin" ]]`, runs `"$bin" -v` (or `--version`), parses the major version via `^v?([0-9]+)\.`, and verifies `(( BASH_REMATCH[1] >= REQUIRED_MAJOR ))`.
    3. Resolve `NODE_BIN` in order:
       - `COORD_NODE` environment override (if set and compatible).
       - Any compatible `node` executable already on `PATH` (iterating `type -a -P node`, so if the workspace prepended an older Node like `v16.18.0` ahead of a system/user Node `>= 26`, or if the active `node` is already `>= 26`, it is found).
       - NVM under `NVM_ROOT="${NVM_DIR:-$HOME/.nvm}"`: first via a subshell sourcing `"$NVM_ROOT/nvm.sh" --no-use` and running `nvm which "$REQUIRED_MAJOR"`, and second by scanning `"$NVM_ROOT/versions/node"/v*/bin/node` sorted with `sort -Vr`.
       - `fnm` (if `fnm` is on `PATH`, via `fnm which "$REQUIRED_MAJOR"`).
    4. If no compatible Node binary is found, print an actionable diagnostic to `stderr` stating that `Node >= <REQUIRED_MAJOR>` is required (including the incompatible version and path found on `PATH`, if any) and exit `1` before attempting to build or execute `dist/main.js`.
    5. If a rebuild is needed, run `(cd "$ROOT" && PATH="$(dirname "$NODE_BIN"):$PATH" pnpm build) >&2` so `pnpm build` uses the resolved Node inside the subshell only.
    6. Execute `exec "$NODE_BIN" "$ROOT/dist/main.js" "$@"` without modifying `PATH`, preserving the caller's working directory and the workspace's development Node version on `PATH`.
- **`test/wrapper.test.ts`**:
  - Reuse the existing `writeFixture(root)` helper and `roots` temp-directory cleanup array.
  - No new files, dependencies, or abstractions are introduced.

## Tests

All tests will live in the existing `test/wrapper.test.ts` file:

1. **Existing fixture update (`writeFixture` in `test/wrapper.test.ts`)**:
   - Update the stub `bin/node` script in `writeFixture` to respond to `-v` / `--version` with `v26.0.0` and write `.nvmrc` (`26`) into the fixture root so the three existing wrapper tests (`keeps stale-build output off protocol stdout`, `resolves a PATH symlink to the install root before pnpm build`, and `preserves the caller cwd so relative product paths resolve there`) exercise the version check and continue to pass.
2. **New test case 1 (`uses a compatible Node from NVM_DIR when the workspace PATH has an older Node without changing the workspace PATH`)**:
   - Configure `bin/node` on `PATH` to report `v16.18.0` on `-v`/`--version` and exit `99` if used to run `dist/main.js`.
   - Create a mock `NVM_DIR` containing `versions/node/v26.7.0/bin/node` that reports `v26.7.0` on `-v`/`--version` and, when executing `dist/main.js`, prints `exec_node=$0`, `path_node=$(node -v)`, and `cwd=$(pwd)`.
   - Run `wrapper` from a caller workspace directory with `PATH="${bin}:/usr/bin:/bin"` and `NVM_DIR`.
   - Assert exit status `0`, stderr contains `BUILD_BANNER` (built using the compatible Node), stdout shows `exec_node` is the `v26.7.0` binary while `path_node=v16.18.0` (proving the workspace's development Node on `PATH` was not changed), and `cwd` is preserved.
3. **New test case 2 (`fails with a clear version error before loading dist/main.js when only an older Node is available`)**:
   - Configure `bin/node` on `PATH` to report `v16.18.0` on `-v`/`--version` and print `SHOULD_NOT_RUN` if invoked with `dist/main.js`, with an empty `NVM_DIR`.
   - Run `wrapper` and assert a non-zero exit status (`1`), stdout does not contain `SHOULD_NOT_RUN`, and stderr reports that `Node >= 26` is required and `v16.18.0` was found.

Focused verification command during implementation: `pnpm vitest run test/wrapper.test.ts`.

## Alternatives Rejected

- **Checking `process.versions.node` inside `src/main.ts` or `src/cli.ts`**: Rejected because `dist/main.js` uses static ESM `import` declarations (including modules that import `node:readline/promises`). Node's ESM loader resolves static module graphs before executing any top-level code in `dist/main.js`, so Node 16 crashes with `ERR_UNKNOWN_BUILTIN_MODULE` before any JavaScript version check can run. Furthermore, a check inside `dist/main.js` could not select a compatible Node binary when the workspace shell has Node 16 active.
- **Prepending `$(dirname "$NODE_BIN")` to `PATH` for the `exec`d coordinator process**: Rejected because child processes spawned by `coord` (such as `coord doctor` toolchain checks and product verification commands) inherit `process.env.PATH`. Prepending Node 26 to `PATH` outside the build subshell would shadow the workspace's own development version of Node. Invoking `exec "$NODE_BIN" "$ROOT/dist/main.js" "$@"` runs `coord` under Node 26 while leaving `PATH` untouched.

## Risks and Mitigations

- **Risk**: Host-installed Node binaries (e.g., in `/opt/homebrew/bin` or `$HOME/.nvm`) could leak into negative tests if fallback paths were hardcoded outside `PATH` and `NVM_DIR`.
  - **Mitigation**: Resolve Node strictly from `COORD_NODE`, `PATH` (`type -a -P node`), `NVM_DIR` (`${NVM_DIR:-$HOME/.nvm}`), and `fnm` on `PATH`. Tests control `PATH` and `NVM_DIR`, guaranteeing hermetic behavior across developer machines and CI.
- **Risk**: macOS `/bin/bash` is version 3.2, where Bash 4+ features fail.
  - **Mitigation**: Use only Bash 3.2-compatible regex matching (`[[ ... =~ ... ]]`), `BASH_REMATCH`, and arithmetic evaluation `(( ... ))` under `set -euo pipefail`.
- **Risk**: Existing tests in `test/wrapper.test.ts` use a minimal fake `bin/node` that previously ignored `-v` / `--version`.
  - **Mitigation**: Update `writeFixture` in `test/wrapper.test.ts` so the fake `bin/node` prints `v26.0.0` when called with `-v` or `--version`.

## Conclusion

Updating `coord` to verify and resolve a compatible Node (`>= 26`, per `.nvmrc`) for its own build and execution — while keeping `PATH` and the caller's working environment unchanged — directly fixes `coord onboard` (and all other `coord` commands) in workspaces that use an older Node version for development, with focused coverage in `test/wrapper.test.ts`.
