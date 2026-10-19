# Issue 240: use coordination's Node for agent maintenance

Protocol version: 1. Planning baseline: a85a915722c3445299eea9d8d3eb5933267a7778.
Source: the coordinator's frozen issue-240 GitHub snapshot. The requested
behavior is that agent updates use the Node runtime required by coord, even
when the workspace selects an older Node.

## Exact File List to be changed or deleted

- `src/cli.ts`: pass the running coordinator's absolute Node executable to
  the maintenance shell invocation in updateAgentVersions, for both update
  and version collection. Keep the current argv execution, working directory,
  timeout, ordering, warning, and continuation behavior.
- `scripts/lib/launcher.sh`: add an explicit maintenance form of
  launcher_environment that accepts the coordinator Node executable, skips
  the clone's nvm setup, and puts that executable's directory first on PATH.
  Preserve the existing one-argument product-launcher behavior.
- `test/cli.test.ts`: extend the existing fresh-start agent-maintenance
  tests with the older-product-Node regression and environment-isolation
  assertions; update the existing shared-installation test to distinguish
  maintenance selection from product-launcher selection.
- `docs/coord-driver.md`: replace the claim that maintenance applies the
  product Node pin and necessarily selects the launcher's installation with
  the explicit maintenance-runtime behavior and the meaning of its version
  snapshot.
- `docs/setup-workspace.md`: include agent maintenance among the narrowly
  scoped coordination operations that prepend the selected Node directory.

No files will be deleted.

## Exact file list to be created

No product, test, configuration, or dependency files will be created. This
plan is the only new coordination artifact for the current action. Existing
shell helpers and the existing CLI test suite are sufficient.

## Reuse and Scope

The failure comes from `updateAgentVersions` in `src/cli.ts`: it sources
`scripts/lib/launcher.sh` and calls `launcher_environment(agent)`, which
sources nvm and applies the clone's `.nvmrc`. That can put a Node 16 global
Claude shim ahead of the working coordination installation. The `coord`
wrapper already selects Node >=26 through `scripts/lib/node-runtime.sh`,
but intentionally does not replace the driver's inherited product PATH.

Reuse the running process's `process.execPath`, which identifies the runtime
that already passed coordination startup. This follows the existing
child-environment isolation pattern in `bootstrapCoordination` in
`src/install.ts`; it does not introduce a second Node discovery algorithm,
duplicate the Node floor, download Node, or change nvm defaults.

Implementation sequence:

1. Extend `launcher_environment` with an optional second argument containing
   the selected coordination Node executable. A one-argument call retains
   the current product `.nvmrc` handling, including its failure when a pin
   cannot be honored. A maintenance call must not source nvm or call
   `nvm use`, including when the clone has a pin and nvm is absent.
2. Retain the vendor environment adjustments in this helper:
   Antigravity/Muse home-local-bin discovery and `MUSE_NO_AUTO_UPDATE=1`.
   For maintenance, prepend the selected Node directory after those
   adjustments so a different `node` in the inherited PATH or home-local
   directory cannot shadow it. The resulting maintenance precedence is
   selected Node bin, vendor home-local bin where applicable, then inherited
   PATH. Native commands elsewhere in PATH remain discoverable.
3. Pass `process.execPath` as a distinct positional shell argument from
   `updateAgentVersions`; consume it explicitly before `exec "$@"`.
   Quote path operations and arguments, including paths containing spaces.
   Use the same invocation for both update and `--version`, so both observe
   the same maintenance selection. Do not mutate `io.env`, `process.env`,
   or the environment used by other coordinator subprocesses.
4. Keep `agentExecutables`, `CoordinatorConfig["agents"]`, `CliIo`,
   `ProcessRunner`, `runArgv`, the three-minute/five-second deadlines,
   per-agent warnings, null versions, and fresh-start-only sequencing.
   Muse still receives no update command; unknown agents still warn and skip.
5. Update the two documented runtime contracts. `agentVersions` records the
   commands observed during maintenance. Generated launchers still establish
   the product's development environment and can resolve a different
   installation where owners have installed competing global CLIs.

Reuse `setup`, `successfulStartGit`, `fakeLoop`, `writeAgentLauncher`,
`runArgv`, and the stub-vendor log fixture in `test/cli.test.ts`. Reuse existing
coverage in `test/wrapper.test.ts` for compatible Node selection and unchanged
product PATH, and in `test/install.test.ts` for launcher arguments and grants.
These latter files are verification inputs, not files to edit.

The scope is maintenance environment selection. It does not add an agent
installer, migrate vendor installations, change launcher runtime policy,
alter tmux environments, change product checks, change hooks, or bump the
package version. No new abstraction or dependency is needed: the optional
helper argument expresses the two existing callers' different requirements.

## Tests

Extend the existing fresh-start agent-maintenance describe block in
`test/cli.test.ts` with the fewest focused regression cases:

1. A real shell fixture has an inherited Node 16 bin, a product .nvmrc, a
   fake nvm script that would select that old bin, and a separate coordination
   Node bin containing a healthy fake vendor command. Exercise both update
   and version collection and assert that the selected vendor and its
   `node` child come from the coordination bin, nvm was never sourced, and
   the observed version is the healthy fixture version. Parameterize the
   maintenance environment case for a missing nvm script as well: absence
   must not prevent maintenance. Include spaces in the runtime path.
   Before the change, maintenance selects the old vendor or fails on missing
   nvm. Afterward, both cases succeed under the supplied coordination Node.
2. Adapt the existing codex/antigravity launcher fixture to assert the two
   contracts independently: maintenance uses the supplied coordination
   runtime and retains native home-local command discovery, while a normal
   generated launcher still applies the product's pin. Assert the input
   environment is unchanged. Keep Muse's no-update and auto-update-suppression
   assertions, with its version command receiving the maintenance setup.

At the ProcessRunner boundary, assert the production command passes exactly
process.execPath. Execute shell-level selection tests only against fixture
Node/vendor directories. Where the real maintenance invocation is exercised
through `runCli`, substitute the asserted runtime argument with the fixture
runtime before executing it. Never place the host Node bin ahead of vendor
stubs and inadvertently invoke or update a real installed agent.

Preserve the existing assertions for update-before-launch ordering, timeouts,
missing commands, nonzero exits, empty versions, unknown agents, and no updates
on attach/resume/run/numeric continuation. These cases need no new duplicates.

Focused development commands:

- `bash -n scripts/lib/launcher.sh`
- `pnpm exec vitest run --config vitest.system.config.ts test/cli.test.ts -t 'fresh-start agent maintenance'`
- `pnpm exec vitest run --config vitest.system.config.ts test/wrapper.test.ts test/install.test.ts -t 'selects .* Node for the CLI and build|isolates its bootstrap Node PATH|passes each harness exactly its own current drop'`

The current workspace configuration declares `pnpm run check:fast` for the
product commit hook and `pnpm run test:e2e` for the push hook. Let those hooks
run their checks instead of immediately duplicating them manually. The
coordinator's final declared command is `pnpm run check`, which includes
build, lint, typechecking, fast/system tests, and e2e. Report these as
coordinator-owned results when provided. If a later action enables coordinator
verification mode, follow its supplied results and check ownership.

This planning action only validates the artifact headings, nonempty sections,
exact file map, cited source behavior, and real command names. It does not run
product tests or claim future results.

## Alternatives Rejected

- Prepending a Node directory to the coordinator's global PATH: that would
  change product subprocesses and defeat the existing runtime-isolation
  behavior.
- Prepending a compatible Node before calling the unchanged environment
  helper: `nvm use` can immediately put the old version first again.
- Applying the clone's pin and then overriding it: maintenance would still
  depend on nvm availability and execute unnecessary product initialization.
- Replacing the product's Node pin or making every generated launcher use
  Node 26: that changes the development runtime beyond the issue's requested
  updater fix.
- Adding a new Node selector, vendor registry, or installer: the running
  Node executable and existing vendor command table already supply the
  required information.

## Risks and Mitigations

- A working newer installation must exist or be discoverable. Prioritizing
  coordination's Node bin fixes shadowing when it does; it does not repair
  arbitrary broken vendor installations. Retain actionable vendor warnings
  and unknown versions rather than report success or automatically install
  new packages.
- Maintenance and product launch can now select different global CLI copies.
  Preserve the product's runtime contract, explicitly document that the
  snapshot is a maintenance observation, and test this distinction instead
  of retaining the old false equality assertion. Unifying all harness and
  product runtimes is a separate behavioral change.
- Shell positional-argument shifts or quoting errors could execute the wrong
  command. Test actual shell execution, paths with spaces, and exact vendor
  arguments; retain Bash 3.2-compatible constructs.
- A PATH change can accidentally leak into normal work or cause tests to
  invoke host vendors. Keep the override inside the maintenance child and
  assert environment immutability and fixture-only execution.

## Conclusion

Use the coordinator's already-selected Node runtime for update and version
maintenance, bypass product nvm setup for that operation, and keep product
launch environments intact. Five existing files are sufficient; focused
shell/process regression coverage demonstrates the old-Node failure and
guards environment isolation.
