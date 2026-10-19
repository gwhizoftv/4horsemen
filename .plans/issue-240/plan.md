# Issue 240 — Use coord’s required Node when updating and launching agents

Fresh-start maintenance and generated launchers currently call
`launcher_environment`, which runs `nvm use` from the **product clone’s**
`.nvmrc`. On a product pinned to Node 16, that puts
`…/nvm/versions/node/v16.18.0/bin` first on `PATH`, so `claude` resolves to the
broken install under that tree (`claude native binary not installed`), update
warns, version is `unknown`, and the Claude pane exits. Coord already requires
Node >=26 for its own process (`scripts/lib/node-runtime.sh`,
`package.json` `engines.node`). Agent vendor CLIs must be resolved and run from
that floor, not from the product pin.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh`
  - Extend `launcher_environment` so that after the optional product `.nvmrc` /
    `nvm use` block (and after the existing antigravity/muse `PATH` /
    `MUSE_NO_AUTO_UPDATE` rules), it prepends the `bin` directory of
    **coord’s** selected Node to `PATH`.
  - Resolution order for that Node (reuse existing policy; do not invent a
    second floor): explicit `COORD_NODE` when set; otherwise
    `"$installRoot/scripts/lib/node-runtime.sh" --resolve` when
    `git config --local --get coord.installRoot` names a usable selector;
    otherwise leave a clear stderr warning and do not pretend a product pin is
    coord-compatible. Do not download Node or change nvm defaults.
  - Keep product `nvm use` for any later product-oriented lines in the
    generated launcher; only vendor CLI resolution must prefer coord’s Node.
- `src/cli.ts`
  - In `updateAgentVersions`, when invoking the maintenance `bash -c` runner,
    if `io.env` does not already define `COORD_NODE`, pass
    `COORD_NODE` set to the absolute path of the running Node
    (`process.execPath`) so maintenance uses the Node coord already validated
    to load the driver, even before `launcher_environment` re-discovers via
    installRoot.
  - Keep sharing `launcher_environment` (do not fork a second ad-hoc PATH
    script): launch and update must keep selecting the same vendor installation.
- `docs/coord-driver.md`
  - Replace the claim that maintenance “shares the generated launcher’s nvm
    setup for the clone’s Node pin” with the corrected rule: optional product
    `.nvmrc` still runs, then coord’s required Node `bin` is prepended so
    update/`--version`/launch resolve the same vendor CLI; Antigravity/Muse
    home-local-bin precedence unchanged.
- `docs/setup-workspace.md`
  - One short note beside the existing `COORD_NODE` / Node >=26 selection text:
    agent update and launch PATH prepend that same selection so a product’s
    older `.nvmrc` cannot shadow vendor CLIs.
- `test/cli.test.ts`
  - Extend the existing fresh-start maintenance coverage (prefer the
    “updates and launches the same … after nvm setup” style fixture) with a
    case where the product `.nvmrc` selects an old Node whose `bin` holds a
    decoy vendor executable, while coord’s Node `bin` (via `COORD_NODE` /
    prepended path) holds the real one; assert update and `--version` hit the
    coord-side binary, and that a generated launcher exec uses the same one.

## Exact file list to be created

- None for the product fix. This plan file is the coordination artifact for the
  planning action only.

## Reuse and Scope

- Reuse `launcher_environment` and the maintenance `bash -c` wrapper in
  `updateAgentVersions` (`src/cli.ts`) so update and launch stay on one PATH
  policy.
- Reuse `scripts/lib/node-runtime.sh --resolve`, `COORD_NODE`, and
  `coord.installRoot` rather than copying probe logic into TypeScript or a new
  shell library.
- Reuse `agentExecutables`, update/version timeouts, warn-and-continue
  behavior, and Muse’s no-update path unchanged.
- Reuse `test/cli.test.ts` fresh-start fixtures (`setup`, `successfulStartGit`,
  `runArgv`, `writeAgentLauncher`, nvm/`VENDOR_LOG` patterns).
- Justify no new files: the bug is PATH precedence inside existing
  maintenance/launcher shared setup; a new module would duplicate
  `node-runtime.sh`.
- Out of scope: changing product check Node selection, downloading Node,
  altering vendor update argv, restart/hold policy, or forcing owners to
  reinstall agents outside coord’s update path.

## Tests

- `test/cli.test.ts` — new focused case under “fresh-start agent maintenance”:
  product `.nvmrc` + old nvm Node `bin` with a decoy `claude` (or parameterized
  vendor id); `COORD_NODE` (or pinned coord Node) with the real vendor binary
  that appends to `VENDOR_LOG`; run `coord start`; assert log shows
  `coord-side|update` then `coord-side|--version`, and
  `agentVersions` records the coord-side version string. Fails today because
  `launcher_environment` stops at product `nvm use`.
- Same file — after writing a launcher via the existing helper, exec
  `start-<id>.sh` under the same env and assert the launch line also uses the
  coord-side binary (matches the issue’s pane failure, not only update).
- Keep existing “updates and launches the same %s installation after nvm
  setup” green; adjust only if the new prepend legitimately changes which
  fixture label wins (document the expected label in the test).
- Commands while developing: `pnpm vitest run test/cli.test.ts -t "fresh-start agent maintenance"`.
  Product commits rely on the pre-commit hook’s `pnpm check:fast`; do not claim
  coordinator-owned final suites.

## Alternatives Rejected

- **Update-only PATH fix in `cli.ts`, leave launchers on product `nvm use`**:
  updates could succeed while the pane still execs the broken Node-16
  `claude` (the reported exit).
- **Drop product `nvm use` entirely from launchers**: breaks the deliberate
  product toolchain echo / Corepack path for Node products and is broader than
  the issue.
- **Document that owners must `nvm use 26` before `coord start`**: the wrapper
  already isolates coord’s Node; asking the product shell to match defeats that
  design.
- **New shell library duplicating `node-runtime.sh` probes**: drifts from the
  floor already locked to `engines.node` by wrapper tests.

## Risks and Mitigations

- *Existing generated `start-*.sh` copies*: they embed `launcher_environment`
  from install/post-merge time. Mitigation: change the template in
  `scripts/lib/launcher.sh`; next `coord install` / post-merge rewrite picks it
  up; mention in docs that a one-time install refresh repairs old clones.
- *Vendored installs without `coord.installRoot`*: discovery may lack
  `node-runtime.sh`. Mitigation: `COORD_NODE` from the running CLI covers
  maintenance; launch warns if neither `COORD_NODE` nor installRoot selector is
  available rather than silently using a too-old product pin as “coord Node”.
- *Agent binary only installed under the old nvm Node `bin`*: prepending coord
  Node may miss it until `claude update` (etc.) runs under the new PATH and
  repairs/installs into the compatible tree — which is the intended recovery
  for the reported failure mode.
- *Antigravity/Muse `~/.local/bin` precedence*: keep prepending that directory
  as today relative to other entries; only insert coord’s Node `bin` so it wins
  over the product nvm version `bin`, not over the documented home-local rule
  where that rule already applies.

## Conclusion

Prepend coord’s required Node (>=26 / `COORD_NODE` / `node-runtime.sh`) to
`PATH` inside the shared `launcher_environment` used by fresh-start agent
maintenance and generated launchers, and pass the running `process.execPath` as
`COORD_NODE` during maintenance when unset. That is the smallest change that
stops a product’s older `.nvmrc` from selecting a broken vendor CLI for both
update and launch, reuses the existing Node selector, and is proven by extending
the current maintenance fixtures in `test/cli.test.ts`.
