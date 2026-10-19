# Issue 240 plan — resolve agent CLIs beside coord's Node, not the product's

## Problem

`coord start` updates, version-probes, and launches each vendor CLI through
`launcher_environment` in `scripts/lib/launcher.sh`
(`src/cli.ts` `updateAgentVersions` → `bash -c '. launcher.sh;
launcher_environment "$2"; exec "$@"'`, and the generated `start-<agent>.sh`
→ `launcher_environment "<agent>"; exec claude …`). That function runs
`nvm use` for the product's `.nvmrc` **before** the bare executable name is
looked up on `PATH`, and with no `.nvmrc` it uses whatever Node the owner's
shell has first on `PATH`. In the reported workspace this selected
`~/.nvm/versions/node/v16.18.0/bin/claude`, a global install that cannot work
on Node 16 ("claude native binary not installed"). So `claude update` failed,
`claude --version` failed (version recorded as `unknown`), and the launched
pane exited with status 1.

The vendor CLIs are coordination tooling. They must be resolved, and
Node-script CLIs interpreted, with the Node that coord itself requires (the
`scripts/lib/node-runtime.sh` selection, ≥ 26). The agent process must still
keep the product's Node on `PATH`, so that product commands and hooks the agent
runs (for example the product's `pnpm check:fast` under its own `.nvmrc`)
behave as they do today.

## Design

One shared function, used by both maintenance and the generated launcher, so
the CLI that gets updated and recorded is the one that gets launched (the
invariant a342daa6 established):

1. `launcher_environment <agent> <executable>` (in `scripts/lib/launcher.sh`)
   does the following, in this order and **before** `nvm use`:
   - Reads the clone's `coord.cliEntry` (`git config --local`). It then calls
     `"$(dirname "$entry")/../scripts/lib/node-runtime.sh" --resolve` to get
     coord's Node. This is the same selector and the same path derivation
     that `githooks/lib/policy.sh` `coord_cli_entry`/`coord_verify` already use.
     If there is no entry, or the selector fails, it falls back to the
     pre-`nvm` `PATH` (vendored clones) with a one-line stderr warning on
     selector failure.
   - Builds a search path: `$HOME/.local/bin` first for antigravity/muse
     (unchanged precedence, and the existing `export PATH=…/.local/bin` stays),
     then `dirname(coord node)`, then the pre-`nvm` owner `PATH`. It resolves
     `<executable>` there in a subshell (`$(PATH="$search"; command -v "$2")`).
     If the executable is not found it prints
     `ERROR: <executable> was not found beside coord's Node (<dir>) or on PATH`
     to stderr and returns 1.
   - Sets the array `coord_agent_cmd=("$bin")`. If coord's Node was resolved
     and the first line of `$bin` (at most 128 bytes, read with `head -c`) is a
     `#!` shebang naming `node`, it sets
     `coord_agent_cmd=("$coord_node" "$bin")` instead. A `#!/usr/bin/env node`
     global npm CLI then runs on coord's Node, not the product's.
   - Then runs the existing `.nvmrc`/`nvm use` block unchanged. That block only
     affects `PATH` for the agent's children.
2. A new `launcher_executable <agent>` case in `scripts/lib/launcher.sh` maps
   `cursor→agent` and `antigravity→agy`; every other known id maps to itself
   (`claude`, `codex`, `gemini`, `muse`). `write_launcher` computes it at
   generation time and emits `launcher_environment "<agent>" "<executable>"`,
   which is a literal in the generated file. The generated file therefore
   stays path-independent, and `write_launcher`'s 4-argument signature (used
   by `githooks/post-merge` and `src/setupWorkspace.ts`) is unchanged.
3. Every `exec <vendor> …` line in `launcher_command` becomes
   `exec "${coord_agent_cmd[@]}" …` with flags unchanged. That includes both
   cursor branches. Flags stay owned by `launcher_command`. The array is always
   non-empty after a successful `launcher_environment`, so bash 3.2 `set -u`
   is safe.
4. `src/cli.ts` `updateAgentVersions`: only the inline maintenance script
   changes, to
   `launcher_environment "$2" "$3" >/dev/null; shift 3; exec "${coord_agent_cmd[@]}" "$@"`.
   The argv shape `[bash, -c, script, "coord-agent-maintenance", lib, id,
   executable, step]` and the `agentExecutables` map stay as they are, so the
   existing maintenance tests keep their argv assertions.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh`: implements Design items 1–3. It changes
  `launcher_environment`, adds `launcher_executable`, rewrites the
  `launcher_command` exec lines, and changes the `launcher_environment` call
  that `write_launcher` emits.
- `src/cli.ts`: changes the maintenance `bash -c` script in
  `updateAgentVersions` (Design item 4). Nothing else in the file changes.
- `test/cli.test.ts`: extends the existing test
  `"updates and launches the same %s installation after nvm setup"`
  (see Tests).
- `test/install.test.ts`: updates the two generated-launcher text assertions
  at the `exec claude --permission-mode auto` and
  `exec agy --mode accept-edits --dangerously-skip-permissions` lines to the
  new `exec "${coord_agent_cmd[@]}" …` form.
- `docs/coord-driver.md`: rewrites the "Maintenance shares the generated
  launcher's nvm setup …" paragraph. The new text says vendor CLIs are
  resolved beside coord's Node before the clone's `.nvmrc` is applied, that
  Node-script CLIs run on coord's Node, and that the product's Node stays on
  `PATH` for the agent's commands.

Nothing is deleted.

## Exact file list to be created

None. The fix extends the existing shared launcher library and existing tests.

## Reuse and Scope

Reused:
- `scripts/lib/node-runtime.sh --resolve`: coord's own Node selection
  (`COORD_NODE`, then `PATH`, then the newest nvm install ≥ 26). No new Node
  discovery logic.
- The `coord.cliEntry` → `../scripts/lib/node-runtime.sh` derivation from
  `githooks/lib/policy.sh` (`coord_cli_entry`, `coord_verify`).
- `launcher_environment`, `launcher_command`, and `write_launcher` in
  `scripts/lib/launcher.sh`. The same function still serves both the
  generated launcher (embedded via `declare -f`) and coord's maintenance
  command. This keeps "update the installation you launch" true.
- `agentExecutables` and `updateAgentVersions` in `src/cli.ts`, unchanged
  except for the script string.
- Test fixtures: `setup()`, `writeAgentLauncher`, `effectOptions`, `runCli`,
  `runArgv`, `successfulStartGit`, `readStartState`, `issueRuntimePaths`, and
  the existing nvm stub pattern in `test/cli.test.ts`. Also `installOnce` and
  `product` in `test/install.test.ts`.

Scope: no change to the tmux session environment, `node-runtime.sh`, the
`coord` wrapper, hooks, the git shim, `setup_*.sh`, or `post-merge`. Existing
generated launchers pick up the change when they are regenerated (by
`coord install`/onboard, or by `githooks/post-merge`, which rewrites managed
launchers on pull).

## Tests

All tests extend the existing test in `test/cli.test.ts`
(`it.each(["codex", "antigravity"])("updates and launches the same %s installation after nvm setup")`).
That test exercises both real code paths: `coord start` maintenance through
`runArgv`, and the generated `start-<id>.sh` run with `/bin/bash`.

- Add `"claude"` and `"cursor"` to the `it.each` list. The cursor case
  exercises the `cursor→agent` executable mapping in both paths.
- Make the clone a git repo (`git init`) and set
  `coord.cliEntry=<repoRoot>/dist/main.js`, so the real
  `scripts/lib/node-runtime.sh` beside it is used.
- Add a `coord bin` directory holding a fake coord Node. It prints `v26.1.0`
  for `--version` and otherwise runs `exec /bin/sh "$@"`. `COORD_NODE` in the
  test env points at it. The directory also holds a vendor stub labelled
  `coord`, whose first line is `#!/usr/bin/env node`. The existing `owner`,
  `pinned` (nvm), and `home` stubs stay. The existing pinned
  `node` prints `fixture-node` and runs nothing. If the launcher let the
  product's Node interpret the CLI, no log line would be written and the
  test would fail.
- Expected label: `coord` for codex, claude, and cursor; `home` for
  antigravity (its `~/.local/bin` precedence is unchanged). The test asserts
  the update, `--version`, and launch log lines, plus the
  `agentVersions` snapshot. It also keeps the existing
  `check_for_update_on_startup=false` assertion for codex.
- Before the fix the codex/claude/cursor cases resolve to `pinned` (codex),
  and so fail. After the fix they pass.

Expectation-only updates in `test/install.test.ts` (claude and antigravity
launcher text) are needed because the exec line changes. Those tests still
assert that the vendor flags are present.

Development: run
`pnpm exec vitest run --config vitest.config.ts test/cli.test.ts -t "after nvm setup"`
and `pnpm exec vitest run --config vitest.config.ts test/install.test.ts`.
The commit hook runs `pnpm check:fast`. Coordinator checks at the approved pin
are coordinator-owned.

## Alternatives Rejected

- **Prepend coord's Node bin directory to the agent's whole `PATH`**: that
  directory also contains `node`/`npm`, so it would shadow the product's
  `.nvmrc` Node for every command the agent runs, including the product's
  declared hook checks.
- **Stop applying `.nvmrc` in the launcher/maintenance**: same defect. Product
  commands would run on the wrong Node.
- **Skip `nvm use` only during maintenance**: maintenance and launch would
  resolve different installations again, reintroducing the divergence
  a342daa6 removed. The pane would still exec the broken Node 16 CLI.
- **Export `process.execPath` into the tmux session (e.g.
  `COORD_AGENT_NODE`)**: this would need plumbing through `startSession`,
  manual sessions, and restarts. It would also not reach a launcher run by
  hand. `coord.cliEntry` + `node-runtime.sh` is already the clone's
  authority for coord's Node.
- **Prefer `~/.local/bin` native installs for every vendor**: vendor-specific
  guessing that does not follow coord's Node requirement.

## Risks and Mitigations

- **A stale npm-global CLI under coord's Node shadows a newer native install
  elsewhere on `PATH`.** Coord updates, records, and launches the same
  binary, so the recorded version stays truthful. The doc paragraph names the
  resolution order so an owner can remove the stale copy.
- **False-positive Node-shebang detection.** Detection only matches a `#!`
  first line naming `node`. Native binaries and shell wrappers (Cursor's
  `agent`) are exec'd directly. The test covers both a node-shebang stub and
  the existing shell stubs.
- **Clones without `coord.cliEntry` (vendored) or with an unresolvable
  selector.** These fall back to the pre-`nvm` owner `PATH`, which is still
  better than today's post-`nvm` lookup, with a stderr warning.
- **Launchers generated before this change keep the old behaviour.** They are
  regenerated by `githooks/post-merge` on pull and by `coord install`. The doc
  states this.
- **macOS bash 3.2.** No new bash ≥ 4 features are used. `coord_agent_cmd` is
  never empty when expanded, and `command -v` runs in a subshell with an
  explicit `PATH`.

## Conclusion

This fixes issue 240 by having the single shared `launcher_environment`
resolve each vendor CLI beside the Node coord requires (via the existing
`coord.cliEntry` → `node-runtime.sh --resolve` route), before the product's
`.nvmrc` is applied. Node-script CLIs are interpreted with that Node. The
product's Node remains on `PATH` for the agent's own commands. Update,
version probe, and launch therefore use the same working installation. The
change touches 2 product files, 2 existing test files, and 1 doc, with no new
files.
