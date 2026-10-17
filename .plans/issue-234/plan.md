# Issue 234 — coord must run on the Node it needs, not the workspace's

## Problem

Every coordination entry point starts whatever `node` is first on the caller's
`PATH`:

- the `coord` launcher: `exec node "$ROOT/dist/main.js" "$@"` (`coord:19`), and
  its stale-build step runs `pnpm build` under that same Node;
- the Git hook bodies: `node "$entry" hook-verify|hook-scope`
  (`githooks/lib/policy.sh:51,60`);
- every command coord renders into an agent clone: lifecycle hooks and the shell
  guard (`src/agentHookSync.ts:40,50,377`), the Claude status-line tee
  (`src/claudeStatusLine.ts:130`) and the Git credential helper
  (`src/githubAuth.ts:37`), all `/usr/bin/env node <cliEntry> ...`;
- `coord install --bootstrap`, which spawns `pnpm install` / `pnpm build` with the
  caller's environment (`src/install.ts:245-260`).

The driver requires Node 26 (`.nvmrc` is `26`, `package.json` engines
`>=26.0.0`). In a workspace whose own development Node is older (the report:
v16.18.0), `src/cli.ts:4` imports `node:readline/promises`, which ESM linking
rejects before any coord code runs, so `coord onboard` dies with
`ERR_UNKNOWN_BUILTIN_MODULE`. The same thing would break every hook and the
credential helper inside that product's agent sessions, because the generated
launcher runs `nvm use` against the product's `.nvmrc` (`scripts/lib/launcher.sh:19-29`)
before starting the harness.

The fix: one resolver picks a Node that satisfies coord's own requirement, and
every coord entry point runs through it by absolute path. The caller's `PATH` is
never rewritten for the coord process, so product checks, product `pnpm`, and the
agent's own shell keep the workspace's Node.

## Design

New executable `scripts/coord-node` (bash, macOS `/bin/bash` 3.2 compatible):

1. Install root = the physical parent of the script's directory. Required major
   = the leading integer of `$root/.nvmrc` (`26`). An unreadable or non-numeric
   `.nvmrc` fails closed with a message naming the file.
2. Candidates, in order; each is probed with `"$candidate" --version` (no JS is
   evaluated, so any Node version answers) and parsed as `vMAJOR.MINOR.PATCH`:
   - `COORD_NODE`, if set: used if it qualifies; otherwise refuse. An explicit
     override never silently falls back.
   - `command -v node` on the caller's `PATH`: used if it qualifies. This is the
     common case and keeps today's behavior.
   - `${NVM_DIR:-$HOME/.nvm}/versions/node/v*/bin/node`: the highest qualifying
     version (numeric compare of major/minor/patch, no `sort -V`).
3. Found: `exec "$node" "$@"`. `PATH` and the rest of the environment are passed
   through unchanged.
4. Not found: exit 1 with stderr naming the required major, the `PATH` node's
   path and version (or "none"), the nvm directory searched, and both remedies:
   `nvm install 26` (which leaves the workspace's selected Node unchanged) or
   `COORD_NODE=/absolute/path/to/node`.

Callers:

- `coord`: resolve before anything else, so a too-old Node never reaches the
  build: `coord_node_bin="$("$ROOT/scripts/coord-node" -p process.execPath)" || exit 1`.
  The stale build runs as `(cd "$ROOT" && PATH="$(dirname "$coord_node_bin"):$PATH" pnpm build) >&2`.
  The `PATH` prefix applies only to coord's own build subshell, and it lets
  `pnpm`/`tsc` run under Node 26 (a `pnpm` installed into that Node's bin
  directory is found the same way). The final line becomes
  `exec "$coord_node_bin" "$ROOT/dist/main.js" "$@"`. Symlink resolution and
  cwd handling stay as they are.
- `githooks/lib/policy.sh`: the `command -v node` gate in `coord_cli_entry` is
  replaced by a check that `$install_root/scripts/coord-node` is executable, with
  the install root taken from the library's own location
  (`${BASH_SOURCE[0]}/../..`, the same install the hook body was reached
  through). `coord_verify` and `coord_scope` run `"$coord_node" "$entry" ...`.
  The resolver's own refusal message is what the owner sees, and the hook still
  fails closed.
- Rendered commands: a new `coordNodeCommand()` in `src/githubAuth.ts`, placed
  beside and built the same way as `coordCliEntry()` (resolved from
  `import.meta.url`, so it names the running install's `scripts/coord-node`),
  replaces `/usr/bin/env node` in the five renderers listed above. Existing
  managed entries are still recognized by `AGENT_LIFECYCLE_HOOK_MARKER` and
  `GITHUB_CREDENTIAL_HELPER_MARKER`, so the existing content-comparison sync
  rewrites old `/usr/bin/env node` entries as drift. No new migration code.
- `src/install.ts` `bootstrapCoordination`: spawn with
  `env: { ...process.env, PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}` }`.
  This is coord building itself, and `process.execPath` is already the resolved
  Node.
- `src/hookSync.ts` `canonicalSourceDigest`: add `scripts/coord-node`, because it
  now decides what a hook runs. The function's own contract is "every file that
  decides what a hook does".

## Exact File List to be changed or deleted

- `coord` — resolve Node through `scripts/coord-node`, prefix only the build
  subshell's `PATH`, exec the resolved absolute Node.
- `githooks/lib/policy.sh` — replace the bare `node` gate and the two `node "$entry"`
  calls with the install's `scripts/coord-node`.
- `src/githubAuth.ts` — add `coordNodeCommand()`; the credential helper uses it.
- `src/agentHookSync.ts` — lifecycle hook, shell guard and Antigravity status-line
  commands use `coordNodeCommand()` instead of `/usr/bin/env node`.
- `src/claudeStatusLine.ts` — status-line receiver uses `coordNodeCommand()`.
- `src/install.ts` — `bootstrapCoordination` prefixes `PATH` with
  `dirname(process.execPath)` for its own `pnpm` steps.
- `src/hookSync.ts` — include `scripts/coord-node` in `canonicalSourceDigest`.
- `README.md` — the Requirements bullet for Node 26 gains one sentence: coord
  finds Node 26 on `PATH`, then in nvm, or uses `COORD_NODE`, and the
  workspace's own Node may stay older.
- `test/wrapper.test.ts` — fixture copies `scripts/coord-node` and `.nvmrc`; fake
  Nodes answer `--version` and `-p`; new cases below.
- `test/hookSync.test.ts` — new hook-policy case below.
- `test/agentHookSync.test.ts` — assert the rendered commands use the resolver.
- `test/githubAuth.test.ts`, `test/install.test.ts`, `test/mirror.test.ts` —
  update the expected credential-helper strings (`githubAuth.test.ts:59`,
  `install.test.ts:339`, `mirror.test.ts:94`) to
  `!'<repo>/scripts/coord-node' '<cliEntry>' auth git-credential --account acct`.
  `install.test.ts` also gets the bootstrap case below.

`test/cli.test.ts:583` is deliberately not changed. It seeds a legacy
`/usr/bin/env node` helper, which must still be recognized and replaced.

Nothing is deleted.

## Exact file list to be created

- `scripts/coord-node` (mode 0755) — the single Node resolver described in
  Design. It has to be its own executable because three kinds of caller need it:
  the bash launcher, the bash hook library, and shell command strings that git
  and agent harnesses run with no coord shell library loaded.
- `.plans/issue-234/plan.md` — this plan (coordination artifact).

## Reuse and Scope

Reused, not reimplemented:

- `coordCliEntry()` (`src/githubAuth.ts:32`): `coordNodeCommand()` copies its
  `import.meta.url` resolution, so the resolver always belongs to the same
  install as the entry it runs.
- `shellQuote` (`src/agentHookSync.ts:32`) and the local `singleQuote`
  (`src/githubAuth.ts:34`) quote the new path in the rendered commands.
- `AGENT_LIFECYCLE_HOOK_MARKER` / `GITHUB_CREDENTIAL_HELPER_MARKER` and the
  existing sync/inspect paths (`syncAgentLifecycleHooks`,
  `configureCloneGitHubCredential`, `isCoordHelper`) migrate old commands as
  ordinary drift.
- `.nvmrc` is the single declaration of the required major. It is already what
  `CONTRIBUTING.md` and `launcher_environment` honor. A test pins it to
  `package.json` engines rather than adding a second source.
- The `coord` symlink resolution and cwd preservation are unchanged, and the
  existing `writeFixture` in `test/wrapper.test.ts` is extended, not duplicated.
- `canonicalSourceDigest`'s existing source list gains one entry.

Out of scope (unchanged): `scripts/bootstrap.sh`, which installs coord before
any coord file exists and already demands Node 26/pnpm 11; the legacy
`scripts/setup_*.sh`, which no coord code path invokes; the product launcher's
`nvm use`, which correctly selects the product's Node for the agent; and
version managers other than nvm, which `COORD_NODE` covers without speculative
probing.

## Tests

Every case below fails on the baseline, because coord execs `PATH` `node` and
renders `/usr/bin/env node`, and passes after the change.

`test/wrapper.test.ts` (existing file; fixture extended so the three current
cases keep passing with a v26 fake on `PATH`):

1. **Too-old PATH Node falls through to nvm without touching PATH.** `PATH` has a
   fake `node` that reports `v16.18.0` and prints `OLD_NODE_RAN` if run as the
   entry. `NVM_DIR` has fakes `v20.0.0` and `v26.1.0`, and the v26 fake prints
   the protocol marker plus `path=$PATH`. With `src` newer than `dist`, the fake
   `pnpm` reports `command -v node`. Expect exit 0; stdout has the marker and
   `path=` equal to the `PATH` given to the wrapper (unchanged); no
   `OLD_NODE_RAN`; and the build saw the v26 node.
2. **No qualifying Node refuses before building.** `PATH` node is v16 and
   `NVM_DIR` is empty. Expect exit 1; stderr contains `26`, `v16.18.0` and
   `COORD_NODE`; no `BUILD_BANNER`; no marker.
3. **`COORD_NODE` is authoritative.** One spawn sets a qualifying `COORD_NODE`
   with a v16 `PATH` node, and the `COORD_NODE` binary runs. A second sets a v16
   `COORD_NODE` with a v26 `PATH` node, and it refuses (exit 1) instead of falling
   back.
4. **Requirement has one source.** The leading integer of `.nvmrc` equals the
   major in `package.json` `engines.node`.

`test/hookSync.test.ts` (existing file):

5. **Hook policy runs the entry on coord's Node.** In a temporary Git repo whose
   local `coord.cliEntry` is a fixture script printing `process.version`, run
   `bash -c '. <repo>/githooks/lib/policy.sh; coord_verify precommit'`. `PATH`
   has a v16 fake `node` first, and `NVM_DIR` has
   `versions/node/v26.9.9/bin/node` symlinked to `process.execPath`. Expect
   stdout `process.version` and no fake output.

`test/agentHookSync.test.ts` (existing file):

6. In the existing per-agent "installs and removes only the managed definitions"
   loop, assert the written config contains `coordNodeCommand()` and not
   `/usr/bin/env node`. The existing shell-guard prefilter test already runs the
   rendered command end to end, so it now exercises the real `scripts/coord-node`
   under the suite's Node 26.

`test/install.test.ts` (existing file):

7. `bootstrap: true` with a fake `pnpm` on `PATH` that records its `PATH`. Its
   `build` creates `dist/main.js` if the fixture lacks it. Expect the first
   `PATH` entry of both recorded steps to be `dirname(process.execPath)`.

Expected-string updates in `githubAuth.test.ts`, `install.test.ts` and
`mirror.test.ts` cover the credential-helper rendering.

Commands while developing (focused):

- `pnpm exec vitest run --config vitest.system.config.ts test/wrapper.test.ts test/hookSync.test.ts test/agentHookSync.test.ts test/install.test.ts`
  (these four are in the system config)
- `pnpm exec vitest run --config vitest.config.ts test/githubAuth.test.ts test/mirror.test.ts`

The pre-commit hook owns `pnpm check:fast`, so it is not run manually before
committing. The coordinator owns the final `pnpm check` at the
approved pin.

## Alternatives Rejected

- **Prepend the resolved Node to `PATH` for the whole coord process.** It would
  fix coord's children, but coord runs product checks and launches agent
  sessions. Those would silently move to Node 26, which the issue forbids
  ("without changing the workspace's development version of node").
- **A JS preflight entry that checks `process.versions.node`.** On Node 16 it can
  only report the problem. It cannot run coord without re-spawning under another
  Node, which needs the same resolver anyway. Lowering the syntax and builtin
  floor of all of `src/` is far larger and still leaves Node 16 unsupported.
- **Bake `process.execPath` into rendered hooks at install time.** nvm paths are
  versioned (`.../v26.1.0/bin/node`), so a routine `nvm install 26`/uninstall of
  the old patch would break every hook and the credential helper until
  reinstall. Resolving at run time does not have that failure.
- **Route rendered hooks through the `coord` launcher instead of a resolver.**
  The launcher may run `pnpm build` when `src` is newer than `dist`. A build
  inside a 5–10 s hook timeout, possibly racing in several panes, is worse than
  the bug.
- **Sourcing `nvm.sh` / `nvm exec 26` in the resolver.** It is slow (hundreds of
  ms per hook), mutates shell state, and depends on nvm's shell functions. Probing
  the installed binaries directly is enough.
- **Probing fnm/volta/asdf/Homebrew paths.** Speculative. `COORD_NODE` covers any
  other manager explicitly.

## Risks and Mitigations

- **Hook latency:** each hook now pays one bash start and one `node --version`
  (tens of ms). The shell guard's no-Node fast path for unrelated payloads is
  preserved, because the resolver is only reached inside the `*git*` branch, and
  the Antigravity status line stays asynchronous. Timeouts (5–10 s) leave ample
  margin.
- **Existing clones keep `/usr/bin/env node` until resynced.** Marker-based
  inspection reports them as drift, and the existing install/start/doctor sync
  rewrites them. Nothing else changes for a clone whose `PATH` Node already
  qualifies.
- **`.nvmrc` and engines drift apart:** test 4 fails the suite.
- **macOS bash 3.2:** the resolver avoids `sort -V`, associative arrays, `mapfile`
  and `${var,,}`. The wrapper tests run it under `/bin/bash` via its shebang
  (`#!/usr/bin/env bash` with a `/usr/bin:/bin` `PATH`, as the existing wrapper
  tests already do).
- **Install moved or partial (`scripts/coord-node` missing):** the hook library
  blocks with the same "install was moved or is unbuilt" style message it uses
  for a missing entry, and `canonicalSourceDigest` makes doctor see the change.
- **Owner sets `COORD_NODE` in a shell profile only:** a harness that doesn't
  inherit it still falls back to `PATH`, then nvm. The refusal message names the
  variable, so the gap is visible rather than silent.

## Conclusion

Add one run-time resolver, `scripts/coord-node`, that selects a Node meeting the
major declared in coord's own `.nvmrc`: `COORD_NODE` first, then `PATH`, then
the newest qualifying nvm install. If none qualifies, it refuses with an
actionable message. Route every coord entry point through it: the `coord`
launcher (including its self-build), the Git hook policy, the rendered agent
lifecycle, shell-guard and status-line hooks, the credential helper, and
`install --bootstrap`. The caller's `PATH` is never changed for the coord
process, so the workspace keeps its own development Node. Seven focused cases
in existing test files fail on the baseline and pass after the change.
