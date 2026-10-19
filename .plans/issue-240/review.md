# Issue 240 plan review (claude)

Reviewed pins:

- muse `289ccb9f71ea759c72a8011fb9730e12c7b9df44`
- cursor `b6795003b1eb3501e214dfb40041a278983b69c2`
- codex `3926ba07d27b27512435ca07e4b0e87f6de18ff4`
- claude `998ee7f73d1fbc36b3f5c5b956052ed0ef804249` (my own; self-review included)

Source facts used below, read at the baseline:

- `scripts/lib/launcher.sh`: `launcher_environment` runs `nvm use` for a clone `.nvmrc`. `write_launcher` embeds it and ends with `exec claude …` / `exec codex …` / `exec agent …`.
- `src/cli.ts`: `updateAgentVersions` runs `bash -c '. launcher.sh; launcher_environment "$2"; shift 2; exec "$@"'`.
- `scripts/lib/node-runtime.sh`, header: "Select Node for coordination only; never change PATH for product subprocesses".
- `vitest.config.ts` **excludes** `test/cli.test.ts`, `test/install.test.ts` and `test/wrapper.test.ts`. They run only under `vitest.system.config.ts`.
- The issue's own sample shows both failures: `claude update`/`--version` failed, and then `the pane in coord-584:claude.0 has exited (status 1 …)`.

## Findings

### F1 — muse: the launched pane still execs the broken CLI

- **Plan claim:** "Out of scope, deliberately: generated launchers and the agent panes they start". `launcher_environment` and `write_launcher` stay byte-identical, and only maintenance gets `COORD_MAINTENANCE_NODE_BIN` prepended.
- **Rule:** the fix must remove the reported failure. `coord start` must leave a running claude pane, and the CLI that coord updates and records must be the one the pane runs. a342daa6 introduced the shared `launcher_environment` to keep that equality, and the existing test "updates and launches the same %s installation" asserts it.
- **Failure:** in the reported workspace, maintenance now finds a coord-Node `claude` and records its version. `start-claude.sh` still runs `nvm use` (v16) and then `exec claude`, which resolves `~/.nvm/versions/node/v16.18.0/bin/claude`. The pane exits with status 1 exactly as in the issue, and coord holds with "the agent terminal is unavailable". `agentVersions.claude` now names an installation that no pane runs. The plan's own risk section concedes this "version snapshot divergence".
- **Smallest correction:** resolve the vendor executable in the shared `launcher_environment`, before `nvm use`, and exec it by absolute path. Both callers then pick the same working install, while the product Node stays on `PATH`.

### F2 — muse: the existing real-bash test would run the host's real vendor CLI

- **Plan claim (Tests):** `test/cli.test.ts:348` "must pass unchanged". `coordNodeBin` falls back to `dirname(process.execPath)` whenever `io.env.COORD_NODE` is unset.
- **Rule:** fixture tests must never execute or update a real installed agent. They must also be deterministic across developer machines.
- **Failure:** that test passes `io.env` without `COORD_NODE` and runs the real maintenance bash through `runArgv`. `process.execPath` is vitest's Node, for example `~/.nvm/versions/node/v26.x/bin/node`. On any machine where `codex` is npm-installed under that Node, the prepended directory wins, so the test runs the host's real `codex update`. It then fails on the `pinned|update` assertion, after a real network update has already run.
- **Smallest correction:** every test that reaches the real maintenance shell must set `COORD_NODE` (or the plan's equivalent input) to a fixture Node in a fixture directory.

### F3 — cursor: the agent pane runs with coord's Node 26 first on `PATH`

- **Plan claim:** "after the optional product `.nvmrc` / `nvm use` block … it prepends the `bin` directory of **coord's** selected Node to `PATH`", inside the shared `launcher_environment` that generated launchers embed.
- **Rule:** product subprocesses keep the product's Node. This is the `node-runtime.sh` header invariant, also covered by `test/wrapper.test.ts` "product children keep their Node". The agent's shell and the hooks it triggers inherit the pane's `PATH`.
- **Failure:** in the Node 16 product, the `nvm use` output still prints `Node: v16.18.0`, and then coord's `…/v26/bin` is prepended. That directory also contains `node`, `npm` and `npx`. Every `node`/`pnpm` the agent runs, including the product's declared pre-commit check (`pnpm check:fast` or the product's equivalent), now runs on Node 26 instead of the pinned 16. Products whose tooling is incompatible with 26 fail their own hooks, and agents cannot commit. The plan's line "Keep product nvm use for any later product-oriented lines" does not help, because the prepend is exported to the exec'd agent process.
- **Smallest correction:** do not prepend a directory that contains `node`. Resolve only the vendor executable beside coord's Node, before `nvm use`, and exec it by absolute path. If it has a Node shebang, run it with coord's Node explicitly.

### F4 — cursor: the existing real-bash test can run the host's vendor CLI

- **Plan claim:** maintenance passes `COORD_NODE=process.execPath` "if `io.env` does not already define `COORD_NODE`". The existing test is kept green and adjusted "only if the new prepend legitimately changes which fixture label wins".
- **Rule:** same rule as F2.
- **Failure:** same mechanism as F2. The existing test sets no `COORD_NODE`, so vitest's own Node bin is prepended and any real `codex` installed there runs.
- **Smallest correction:** same as F2.

### F5 — codex: same pane failure as F1, by design

- **Plan claim:** maintenance gets a separate mode that skips `nvm` and prepends `process.execPath`'s directory. "Generated launchers still establish the product's development environment and can resolve a different installation". The plan also changes the equality test so that it no longer asserts equality.
- **Rule:** same rule as F1, including the issue's pane-exit failure.
- **Failure:** same as F1. `start-claude.sh` still execs the v16 `claude` and the pane exits with status 1. Removing the equality assertion takes away the only test that would catch this.
- **Smallest correction:** same as F1.
- Note: codex's handling of test isolation (substituting a fixture runtime for `process.execPath` at the runner boundary) and its focused commands under `vitest.system.config.ts` are correct.

### F6 — muse, cursor, claude (self): the focused test commands select no tests

- **Plan claims:**
  - muse: `pnpm vitest run --config vitest.config.ts test/cli.test.ts`
  - cursor: `pnpm vitest run test/cli.test.ts -t …`, which uses the default `vitest.config.ts`
  - claude: `pnpm exec vitest run --config vitest.config.ts test/cli.test.ts …` and the same form for `test/install.test.ts`
- **Rule:** plans must name real commands that run the proposed tests (AGENTS.md "name real commands").
- **Failure:** `vitest.config.ts` excludes `test/cli.test.ts` and `test/install.test.ts`. Each command reports "No test files found" and exits non-zero, or filters to nothing, so the regression is never run during development.
- **Smallest correction:** use `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts -t "after nvm setup"` (and likewise for `test/install.test.ts`).

### F7 — claude (self): no blocking design defect found

- The plan resolves the vendor CLI beside coord's Node through the existing `coord.cliEntry` → `node-runtime.sh --resolve` route, before `nvm use`. It execs the CLI by absolute path, and runs Node-shebang CLIs with coord's Node. It also sets `COORD_NODE` to a fixture in the extended test.
- That addresses F1–F5: update, version probe and launch all use the same working install, the product's Node stays on `PATH`, and no host vendor runs.
- Its only defect is F6.
- Scope is 2 product files, 2 existing test files and 1 doc, with no new files. The `install.test.ts` changes only update expectations for the changed exec line.

### Scope and reuse (all plans)

- All four plans stay within the issue and create no new product or test files.
- All four reuse the existing fixtures in `test/cli.test.ts`.
- muse and codex reuse `process.execPath`, following the `src/install.ts` bootstrap precedent. cursor and claude reuse `node-runtime.sh --resolve` from the clone's recorded install, which is the route hooks already use.
- cursor and codex also edit `docs/setup-workspace.md`. That is justified only if the edited behaviour is described there.

## Conclusion

- **muse** and **codex** fix only the update/version step. The issue's pane exit (status 1 from the Node 16 `claude`) still happens, so both fail to resolve the reported failure. They also break the update/launch equality on purpose.
- **cursor** fixes both steps, but puts Node 26 ahead of the product's pinned Node for all agent work and hooks, which violates the product-Node invariant.
- muse and cursor also leave the existing real-bash test able to run host vendor CLIs.
- **claude**'s plan (`998ee7f73d1fbc36b3f5c5b956052ed0ef804249`) is the only one that keeps update and launch on the same working CLI while preserving the product's Node. It is the recommended basis, with the F6 correction to run its tests under `vitest.system.config.ts`.
- From codex, the implementation should also adopt the explicit runner-boundary assertion that no host vendor is invoked.
