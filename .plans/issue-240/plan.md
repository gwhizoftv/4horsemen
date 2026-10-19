# Issue 240 — Use coord's required Node when updating agents

The workspace in the issue pins an older Node through nvm (the owner's shell
resolves `claude` to `~/.nvm/versions/node/v16.18.0/bin/claude`), so the
fresh-start agent update fails (`claude native binary not installed`) and the
recorded version is `unknown`. Coord itself already requires Node >= 26
(`package.json` `engines.node`, `coord_min_major=26` in
`scripts/lib/node-runtime.sh`, enforced by the `coord` wrapper), but the
maintenance path in `updateAgentVersions` (`src/cli.ts:166`) runs
`launcher_environment` (`scripts/lib/launcher.sh:19`) inside the agent clone,
whose `nvm use` (lines 20–29) puts the clone's pinned Node first on `PATH`.
Vendor `update`/`--version` commands and any `#!/usr/bin/env node` vendor shim
therefore run under the product's Node, not coord's. The fix is confined to
that maintenance path: after the existing launcher environment is applied,
coord's own Node bin directory is put first on `PATH` for the update and
version commands only. Generated agent launchers and all product subprocesses
keep the product's Node selection.

## Exact File List to be changed or deleted

- `src/cli.ts` — in `updateAgentVersions` (line 166) only:
  - Compute coord's Node bin directory once, before the `run` closure:
    `const coordNodeBin = io.env.COORD_NODE !== undefined && io.env.COORD_NODE.startsWith("/") ? dirname(io.env.COORD_NODE) : dirname(process.execPath);`
    (`dirname` is already imported at line 5; no new import is needed.
    `COORD_NODE` is the existing documented override that
    `scripts/lib/node-runtime.sh` already requires to be an absolute
    `bin/node` path; honoring only absolute values mirrors that contract, and
    `process.execPath` is the Node the coordinator is already running under,
    which the `coord` wrapper resolved through `node-runtime.sh`.)
  - Pass it to every maintenance invocation by changing the runner options at
    line 180 from `env: io.env` to
    `env: { ...io.env, COORD_MAINTENANCE_NODE_BIN: coordNodeBin }`.
  - Change the inline bash at line 178 to call
    `launcher_maintenance_environment "$2"` instead of
    `launcher_environment "$2"`, keeping the `>/dev/null` redirect, the
    `shift 2; exec "$@"` tail, both timeouts
    (`AGENT_UPDATE_TIMEOUT_MS`/`AGENT_VERSION_TIMEOUT_MS`), and the existing
    warn-and-continue behavior (lines 181–186) unchanged.
- `scripts/lib/launcher.sh` — add one function, `launcher_maintenance_environment`,
  immediately after `launcher_environment` (after line 36), with exactly this
  behavior: call `launcher_environment "$1"`, then, if
  `COORD_MAINTENANCE_NODE_BIN` is non-empty, `export PATH="$COORD_MAINTENANCE_NODE_BIN:$PATH"`.
  Nothing else in the file changes: `launcher_environment`, `launcher_command`,
  `write_git_wrapper`, and `write_launcher` are untouched, so generated
  launchers (which embed only `launcher_environment` via `declare -f` at
  line 367) are byte-identical to before.
- `test/cli.test.ts` — extend the `fresh-start agent maintenance` describe
  block (line 221): keep the existing test at line 348
  (`updates and launches the same %s installation after nvm setup`) passing
  unchanged, and add the one new test described under Tests.

No files are deleted.

## Exact file list to be created

- `.plans/issue-240/plan.md` (this plan).

No new source, script, or test files are created; the new test joins the
existing `test/cli.test.ts`.

## Reuse and Scope

- Reuses `launcher_environment` in `scripts/lib/launcher.sh` as the base of the
  new maintenance environment, so the clone's `.nvmrc` selection, the
  `$HOME/.local/bin` addition for antigravity/muse (lines 30–32), and
  `MUSE_NO_AUTO_UPDATE` for muse (lines 33–35) still apply during maintenance.
  Keeping the pinned bin directory on `PATH` (behind coord's) means a vendor
  executable installed only under the product's Node is still found — but its
  `#!/usr/bin/env node` interpreter and any `node` it spawns resolve to coord's
  Node, and a vendor executable installed under coord's Node shadows the
  pinned one. This preserves the same-installation contract asserted by
  `test/cli.test.ts:348` whenever no coord-Node installation exists.
- Reuses `process.execPath` as the source of coord's Node, the same precedent
  as `bootstrapCoordination` in `src/install.ts:261`
  (`PATH: ${dirname(process.execPath)}...` for coord's own `pnpm` steps) and
  the `--fallback-node '${process.execPath}'` callbacks in
  `src/githubAuth.ts:38`. No new resolution subprocess is introduced:
  `scripts/lib/node-runtime.sh` has already selected and validated this Node
  (floor 26) before `dist/main.js` starts, and its header states the
  invariant this plan respects — coord's Node selection must never change
  `PATH` for product subprocesses, which is why the prepend is scoped to the
  maintenance runner's `env` and shell function only.
- Reuses the existing maintenance plumbing in `src/cli.ts`: the
  `agentExecutables` map (line 155), `updateAgentVersions`'s sequential
  update-then-version order, its warning format, and the
  `agentVersions` snapshot written by the caller at line 1249. No state
  schema, config, or `src/state.ts` change is needed.
- Reuses the existing real-bash test fixture style of `test/cli.test.ts:348`
  (fake `nvm.sh`, labelled vendor executables in owner/pinned/home bin dirs,
  execution through `runArgv` from `src/runLoop.ts`, and a generated launcher
  via `writeAgentLauncher` from `src/setupWorkspace.ts`) for the new test.
- Out of scope, deliberately: generated launchers and the agent panes they
  start (they must keep the product's Node for product work, per
  `test/wrapper.test.ts:107`); the `coord` wrapper and
  `scripts/lib/node-runtime.sh` (the >= 26 floor and selection already work);
  the deprecated `scripts/setup_*.sh`/`scripts/setup_common.sh` (superseded by
  `coord install`, which installs no vendor CLI — the only agent
  install/update surface in `src/` is this fresh-start maintenance path);
  and any vendor-CLI installation step (coord has none; `update` remains the
  vendor's own command).

## Tests

- Existing, must pass unchanged: `test/cli.test.ts:348`
  (`updates and launches the same codex/antigravity installation after nvm setup`)
  — proves the pinned installation is still the one updated, versioned, and
  launched when coord's Node bin directory contains no vendor executable, and
  the other `fresh-start agent maintenance` tests (lines 222–346) proving
  ordering, timeouts, warn-and-continue, and no maintenance on
  attach/resume/run.
- New, in `test/cli.test.ts` inside the same describe block, modelled on the
  line-348 fixture and failing before the change: a clone whose `.nvmrc`
  selects a pinned bin directory containing a `claude` executable that is a
  shell script printing `node=$(node --version)`-style output derived from
  `command -v node`; `io.env.COORD_NODE` points at a fixture
  `<coordBin>/node` (a fake Node script) in a coord bin directory that
  contains no `claude`. Run `start` through the real maintenance bash via
  `runArgv` as at line 371. Assert (a) the recorded
  `agentVersions.claude` and the vendor log show the maintenance commands ran
  with `command -v node` resolving to the fixture coord Node, not the pinned
  Node — this assertion fails on the current code, which never sets
  `COORD_MAINTENANCE_NODE_BIN`; and (b) the subsequently executed generated
  launcher (`start-claude.sh`) still resolves the pinned installation,
  proving launch behavior is unchanged. Add a second fixture executable
  labelled `coord` in the coord bin directory in the same test (or a
  `claude`-only variant of it) to assert that when a vendor executable does
  exist under coord's Node, `update`/`--version` use that installation while
  the launcher still uses the pinned one.
- Commands while developing: `pnpm vitest run --config vitest.config.ts test/cli.test.ts`
  (focused on the touched file). Do not manually duplicate `pnpm check:fast`
  immediately before committing; the pre-commit hook owns it. Report only
  checks actually run; coordinator-owned final checks are not claimed.

## Alternatives Rejected

- **Change `launcher_environment` itself (or `write_launcher`) to put coord's
  Node first**: every generated agent launcher would then run the agent — and
  the product tooling it drives — under coord's Node instead of the product's
  pinned Node, breaking the invariant in `test/wrapper.test.ts:107`
  ("product children keep their Node") and `node-runtime.sh`'s own header.
- **Make `scripts/lib/node-runtime.sh` export its selection onto `PATH`**:
  same product-contamination problem at a lower layer, and it would affect
  every coord subprocess, not just agent maintenance.
- **Skip the clone's `.nvmrc`/`nvm use` entirely during maintenance**: a
  vendor executable installed only under the product's Node would no longer
  be found at all, regressing the same-installation behavior
  `test/cli.test.ts:348` exists to protect, when prepending coord's bin
  directory already fixes the interpreter while keeping that fallback.
- **Resolve coord's Node from TypeScript by shelling out to
  `node-runtime.sh --resolve` per agent or per start**: an extra subprocess
  and a second source of truth; the running process's `process.execPath`
  already is that resolved, floor-validated Node (precedent:
  `src/install.ts:261`, `src/githubAuth.ts:38`).
- **Warn, or refuse to start, when the clone's `.nvmrc` Node is below coord's
  floor**: the issue explicitly asks coord to use the Node version it
  requires when updating agents; a warning leaves the update broken and a
  refusal punishes a legitimate product pin.
- **Have coord install vendor CLIs under its own Node (`npm install -g`)**:
  coord has no vendor-install command today; this would add a new subsystem
  (and network installs at start) far beyond the smallest fix.

## Risks and Mitigations

- *Version snapshot divergence*: if a vendor executable exists under both
  coord's Node and the pinned Node, `update`/`--version` now act on coord's
  installation while the launched pane still starts the pinned one, so
  `agentVersions` can describe a different installation than the pane runs.
  This is the issue's requested behavior for the update step; it is bounded
  to fresh-start maintenance, the existing warning path still reports any
  failure instead of inventing a version, and changing pane Node selection
  is explicitly out of scope above.
- *`process.execPath` below the floor when the TypeScript is embedded or run
  directly, bypassing the `coord` wrapper*: production entry always goes
  through `coord`/`node-runtime.sh`, which rejects Node < 26 before
  `dist/main.js` loads; direct embedding already relies on the same
  assumption at `src/install.ts:261`. No new validation is added.
- *A malformed `COORD_NODE` in the environment*: the derivation honors only
  absolute values and otherwise falls back to `process.execPath`; the wrapper
  path has already validated `COORD_NODE` before this code runs.
- *Vendor update scripts that spawn `node` expecting the product's Node*:
  that is precisely the failure in the issue (vendor CLIs requiring a newer
  Node than the product's); maintenance is coord's own operation, runs
  before any pane starts (`src/cli.ts:1223–1225`), and cannot affect product
  commands the agent runs later from its launcher.
- *Shell portability*: the new function uses only `export PATH=...` and a
  `[[ -n ... ]]` test, matching the bash already used throughout
  `scripts/lib/launcher.sh` (sourced by the `bash -c` maintenance command and
  by generated bash launchers); it adds no new shell dependency.

## Conclusion

Add `launcher_maintenance_environment` to `scripts/lib/launcher.sh` (existing
launcher environment, then coord's Node bin first) and have
`updateAgentVersions` in `src/cli.ts` supply that bin directory via
`COORD_MAINTENANCE_NODE_BIN`, derived from `COORD_NODE` or `process.execPath`.
Agent `update` and `--version` then run under the Node >= 26 coord already
requires — fixing the failed update and `unknown` version on workspaces
pinned to an older Node — while generated launchers, product subprocesses,
state schemas, and all other start behavior remain unchanged. One new
real-bash test in `test/cli.test.ts` proves the maintenance interpreter, the
coord-Node shadowing, and the unchanged launch resolution; the existing
maintenance and wrapper suites prove nothing else moved.
