# Issue 234 — Coord verifies and selects its own Node before running

`coord onboard` (and every other `coord` entry) currently ends with
`exec node "$ROOT/dist/main.js"`, using whatever `node` is first on the
caller's PATH. Product workspaces that pin an older Node (the report used
v16.18.0) therefore load `dist/main.js` under that runtime and crash at
import time on `node:readline/promises` (`ERR_UNKNOWN_BUILTIN_MODULE`)
before any TypeScript guard can run. This package already declares
`engines.node: ">=26.0.0"` and pins `.nvmrc` to `26`. The fix belongs in the
existing bash wrapper: select a Node that satisfies that floor from the
**install root**, fail with a clear message if none is available, and leave
the caller's shell / product development Node unchanged.

## Exact File List to be changed or deleted

- `coord` — After resolving `ROOT` (unchanged symlink walk) and **before**
  `pnpm build` or `exec node`:
  1. Read the required major from `$ROOT/.nvmrc` (trim whitespace; today
     `26`). Treat that major as the minimum; do not invent a looser floor
     than `package.json` `engines.node` (`>=26.0.0`).
  2. Probe the current PATH `node` with a version-only invocation that does
     not load `dist/main.js` (e.g. `node -p "process.versions.node"`).
  3. If the major is missing or below the required major, attempt the same
     install-root selection pattern already used by
     `scripts/setup_common.sh` `common_ensure_node_version` and
     `scripts/lib/launcher.sh` `launcher_environment`: if
     `${NVM_DIR:-$HOME/.nvm}/nvm.sh` exists, source it and run `nvm use`
     with cwd set to `$ROOT` only (subshell or explicit `cd` that does not
     persist as the caller's cwd). Do **not** read a product workspace
     `.nvmrc`, and do **not** `nvm install` as part of ordinary CLI
     invocation.
  4. Re-probe. If still unsatisfied, exit non-zero with stderr that names
     the required major, the found version (or that `node` was missing),
     and that the product workspace Node was not modified; suggest
     installing Node 26 / using nvm for the coord install root.
  5. Only then run the existing stale-build `pnpm build` gate and
     `exec node "$ROOT/dist/main.js" "$@"` so build and runtime share the
     selected Node. Keep build banners on stderr and preserve the caller's
     cwd for relative product paths (existing wrapper contracts).

- `test/wrapper.test.ts` — Update the stub `bin/node` so version probes
  report a satisfying Node 26.x string while preserving the existing
  stdout protocol fixture behavior for normal exec. Add focused cases for
  (a) PATH node below the required major with no usable nvm → non-zero
  exit, stderr mentions the requirement, and `dist/main.js` is not
  treated as a successful run; (b) PATH node already satisfying → current
  success behavior unchanged (cwd preservation / symlink resolution /
  stderr build banner).

## Exact file list to be created

None. The plan artifact itself is coordination-only. No new TypeScript
modules, no bundled Node runtime, and no product-tree files.

## Reuse and Scope

- Reuse the existing `coord` wrapper as the sole process boundary that runs
  before any `dist/*.js` import (required because `src/cli.ts` top-level
  `import { createInterface } from "node:readline/promises"` fails under
  Node 16 before `main`/`runCli` execute).
- Reuse `$ROOT/.nvmrc` and the documented Node 26 engine floor already
  enforced for development (`package.json` `engines`, `.nvmrc`,
  `CONTRIBUTING.md` / `docs/coord-driver.md` guidance). Do not add a
  second source of truth or loosen engines.
- Reuse the nvm-selection idea from `common_ensure_node_version` /
  `launcher_environment`, inlined in `coord` so the wrapper does not source
  `scripts/setup_common.sh` (that helper assumes agent-setup globals and
  can `nvm install`).
- Reuse `test/wrapper.test.ts` fixtures (`writeFixture`, PATH-scoped
  stub `bin/node` / `bin/pnpm`, symlink and cwd cases) rather than adding a
  new test file.
- Out of scope: changing product workspace Node managers; bundling Node;
  rewriting `cli.ts` imports; doctor/onboard feature work unrelated to the
  entry wrapper; auto-installing Node via nvm during `coord` invocation.

## Tests

Fewest focused cases, all in the existing `test/wrapper.test.ts`:

1. **Too-old PATH node, no nvm fallback** — Stub `node` answers the version
   probe with `16.18.0` (or equivalent) and would otherwise print the
   protocol fixture if exec reached `main.js`. Expect non-zero status,
   stderr containing the required major (26) and the found version, and
   stdout **not** containing the successful protocol fixture line. Fails
   today because the wrapper execs without checking.
2. **Satisfying PATH node** — Stub reports `26.x`; existing cases still
   pass (protocol stdout clean of build banners, symlink resolution to
   install root, caller cwd preserved for `onboard ./testapp`).
3. Optional only if cheap in-shell: when PATH node is too old but a stub
   `nvm.sh` can prepend a satisfying `node` after `nvm use` with cwd
   `$ROOT`, the wrapper succeeds. Skip inventing a full nvm harness if it
   forces a new file; the version-gate failure case plus satisfying-PATH
   success already pins the issue contract.

Commands while developing: `pnpm vitest run --config vitest.config.ts test/wrapper.test.ts`.
Publishing this plan is evidence-only (no product suite required for the
plan commit). Product implementation commits rely on the hook-owned
`pnpm check:fast` for the staged tree.

## Alternatives Rejected

- **Guard inside `src/main.ts` / `src/cli.ts`** — Top-level
  `node:readline/promises` import fails before any guard runs; matches the
  reported stack.
- **Lower `engines` / remove the modern readline import** — Contradicts the
  package's Node 26 pin and does not teach `coord` to ignore a product
  workspace's older PATH Node.
- **Ship or download a private Node binary with coord** — Large, platform-
  specific, and unnecessary when `.nvmrc` / engines already define the
  expected runtime.
- **`nvm use` against the caller's cwd / product `.nvmrc`** — Would change
  or depend on the product development Node; the issue requires coord to
  use **its** required Node without altering the workspace's.
- **`nvm install` on every mismatched invocation** — Surprising network and
  disk side effects for a CLI entry; fail with remediation instead.
- **New shared shell library file** — One wrapper is the only production
  caller; inlining avoids an unjustified new path.

## Risks and Mitigations

- **Wrapper tests break when stubs ignore version probes** — Update
  `writeFixture`'s `bin/node` to answer the probe; keep exec behavior for
  real argv.
- **nvm absent or broken on the machine** — Clear stderr exit is still a
  fix versus `ERR_UNKNOWN_BUILTIN_MODULE`; PATH Node 26 continues to work
  without nvm (fnm/volta/asdf users who already exposed Node 26).
- **Sourcing nvm mutates PATH only inside the wrapper process** — Acceptable
  and desired; `exec` replaces that process so the caller's interactive
  shell is unchanged.
- **Stale-build `pnpm build` under the wrong Node** — Selecting Node before
  the build gate avoids building with Node 16 when the wrapper refreshes
  `dist/`.
- **`.nvmrc` edited independently of `engines`** — Plan reads `.nvmrc` as
  the operational pin already used by setup/launchers; keep it aligned with
  `>=26.0.0` (no divergent constant in the wrapper).

## Conclusion

Extend the existing `coord` wrapper so it verifies Node against the install
root's `.nvmrc` major (26), optionally rebinds via nvm from that root when
PATH is too old, then builds and execs only under a satisfying runtime.
Extend `test/wrapper.test.ts` to prove too-old Node fails clearly and
satisfying Node keeps current wrapper contracts. No new product files; the
caller's workspace development Node is never modified.
