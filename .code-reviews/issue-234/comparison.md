# Issue 234: implementation comparison (claude)

Bound implementation pins compared:

| Agent | Pin |
| --- | --- |
| cursor | `f6449d44305990a3620d2805b73a06096e33d5da` |
| codex | `ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0` |
| claude | `5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215` |
| antigravity | `980e57bcfba8f909c137199f7814c5e1e09850af` |

## Method

I read each pin from its bound worktree; each worktree's `HEAD` matches its pin.
I diffed every changed product path against a `git archive` export of the
frozen baseline `f11d9e7c2023d294a63a3d380bd65844c2869906`.

To investigate findings, I also ran each pin's `scripts/lib/node-runtime.sh`
directly with `/bin/sh`, using this host's real Node binaries (v16.18.0 and
v26.7.0 under `~/.nvm`). I did not run any pin's product suite. The
coordinator owns those checks.

## Comparison

### What every pin gets right

All four implementations make the same change to coord's Node entry points:

- They add `scripts/lib/node-runtime.sh`.
- The `coord` wrapper resolves Node first. It prepends that Node's directory
  only to the stale-build subshell, then execs the absolute Node with the
  caller's `PATH` unchanged.
- `githooks/lib/policy.sh` finds the selector from `coord.cliEntry`, not from
  the library's own location, so vendored hooks keep working.
- `scripts/bootstrap.sh` selects Node after checkout.
- `bootstrapCoordination` gives only its own `pnpm` steps
  `dirname(process.execPath)` at the front of `PATH`.
- The selector is added to `canonicalSourceDigest`.
- The generated credential, lifecycle, shell-guard and status-line commands
  stop using `/usr/bin/env node`.

Each pin changes only paths in the approved map, plus its own coordination
artifacts. None adds a dependency or an unrelated refactor.

I ran each selector with PATH set to `<v16.18.0 bin>:/usr/bin:/bin` and
`NVM_DIR=~/.nvm`:

- **Selection:** all four choose `~/.nvm/versions/node/v26.7.0/bin/node`.
- **Exec mode:** all four pass stdin through to the selected Node, and a
  `node --version` started from that process still reports `v16.18.0`. The
  product's Node is preserved.
- **No supported Node** (`NVM_DIR=/nonexistent`): all four exit 1 with a
  diagnostic that names v16.18.0, and nothing reaches stdout.

For reference, the baseline `dist/main.js` loaded under the real v16.18.0
reproduces the reported `ERR_UNKNOWN_BUILTIN_MODULE: node:readline/promises`.

### Where they differ

| | cursor | codex | claude | antigravity |
| --- | --- | --- | --- | --- |
| Generated commands run | `process.execPath` | the selector, at run time | `process.execPath` | `process.execPath` |
| `setup_common.sh` trust step | through the selector | unchanged | through the selector | through the selector |
| Empty `COORD_NODE` | ignored | refused | ignored | ignored |
| Engines / `.nvmrc` consistency test | yes | yes | yes | no |
| `install --bootstrap` PATH test | none | `spawnSync` mocked, hermetic | none | real `pnpm` lookup (F2) |
| Hook test: old product Node, shim and vendor | no (F1) | yes | yes | yes |
| Rendered credential helper executed in a test | no (F3) | yes | yes | no |

Codex departs from the selected plan in two places:

- **Generated commands use the selector, not `process.execPath`**
  (`src/githubAuth.ts:36-41`). Every generated callback re-selects Node each
  time it runs. That removes the risk the plan accepted: after
  `nvm uninstall` or a Homebrew cleanup of the Node that ran
  `coord install`, the `process.execPath` callbacks in cursor, claude and
  antigravity point at a deleted file until reinstall. Codex documents the
  behavior (`docs/setup-workspace.md:55-70`). The cost: a `COORD_NODE` that was
  set only for `coord install` must also be present in agent panes.
- **`scripts/setup_common.sh` is left unchanged.** That departs from the plan
  text but has no observed effect. I loaded the baseline `dist/agentTrust.js`
  under the real v16.18.0 and it imported cleanly (`syncAgentTrust` resolved,
  exit 0).

### Overall

**Codex** is the strongest pin. Its callbacks survive Node upgrades, its
bootstrap test does not depend on the machine, it tests the hooks under an old
product Node in shim and vendor modes, and it runs the rendered helper.

**Claude** (my own pin) follows the selected plan most closely, with focused
tests. It accepts the plan's `process.execPath` durability trade-off, and it
does not test `bootstrapCoordination`.

**Antigravity and cursor** are functionally equivalent at runtime. Their tests
have the defects below.

## Findings

### F1: cursor's digest test rewrites the repository's tracked selector while the suite runs

- **Where:** `test/hookSync.test.ts:581` (cursor pin `f6449d44`).
- **Rule:** a test must not write tracked files in `repoRoot`. Other test files
  run in parallel workers and read that file. `test/wrapper.test.ts` and
  `test/bootstrap.test.ts` copy `scripts/lib/node-runtime.sh`. Every hook
  fixture that uses `repoRoot` as its install root runs it. Each `install()`
  stamps `canonicalSourceDigest(repoRoot)`.
- **Failure:** `writeFileSync(runtime, ...)` truncates and rewrites the live
  selector, and lines 581–586 restore it.
  - A worker that copies or execs the selector inside that window gets a
    partial script and fails at random.
  - An `install()` that stamps the digest inside the window records the
    `# digest-probe` bytes, so a later inspection in that test reports
    `install-modified`.
  - If the run is killed between the write and the restore, the developer's
    checkout is left with a modified tracked file.
  - The rest of the test sources the repository's own
    `githooks/lib/policy.sh` with no old Node on `PATH`. It therefore covers
    neither the vendored copy nor the product keeping its own Node.
- **Smallest test:** copy `githooks`, `templates/hooks` and `scripts/lib` into a
  temporary root, then assert the digest of that copy changes after editing
  the copy's selector (as codex and claude do). Add a commit in shim and
  vendor clones with a v16 stub first on `PATH`.

### F2: antigravity's bootstrap test runs whichever `pnpm` sits beside the running Node

- **Where:** `test/install.test.ts:423-449`, the test "prepends
  dirname(process.execPath)…", and its `installOnce(fixture, { bootstrap: true })`
  call at line 441 (antigravity pin `980e57bc`).
- **Rule:** tests must not resolve real tools from the host. The code under
  test prepends `dirname(process.execPath)` to `PATH`, so a `pnpm` in that
  directory shadows the fixture's fake `pnpm`.
- **Failure:** on a machine where `pnpm` is installed next to Node, the real
  `pnpm install --frozen-lockfile` and `pnpm build` run in the install root.
  That is `repoRoot` for `installOnce`, per lines 37–43. Examples are a
  corepack shim, which the generated launcher's `corepack enable pnpm` writes
  beside the active Node, or `npm i -g pnpm`.
  - The fake log is never written, so `readFileSync(pnpmLog)` throws `ENOENT`,
    after the real build has modified the checkout's `dist/` and `node_modules`.
  - On this host the running Node's bin directory holds only `node`, `npm` and
    `npx`, so the test passes here. The defect depends on the environment.
  - I rate this PLAUSIBLE: I did not reproduce it with a shim installed.
- **Smallest test:** intercept `childProcess.spawnSync` for `pnpm` and assert
  the `env.PATH` it receives, as codex's `test/install.test.ts:62-90` does.

### F3: cursor's credential-helper test never executes the rendered helper

- **Where:** `test/githubAuth.test.ts:101-122`, with the execution at line 112
  (cursor pin `f6449d44`).
- **Rule:** the test for the issue's credential-helper path must run the string
  `gitCredentialHelperCommand` returns, the way git does: `sh -c '<helper
  without !> get'`.
- **Failure:** line 112 runs `'<process.execPath>' -e "..."` directly.
  Breaking the helper's quoting or argument order would still pass. Examples:
  dropping the space before `cliEntry`, or quoting `cliEntry` and the marker
  together.
  - Only the `toContain(process.execPath)` assertion relates to the rendered
    string.
  - Antigravity updates only the expected strings (`test/githubAuth.test.ts`,
    3 changed lines) and does not run the helper at all.
- **Smallest test:** render `gitCredentialHelperCommand("acct", fixtureEntry)`,
  drop the leading `!`, and run `sh -c "<helper> get"` with a v16 stub first on
  `PATH`. Assert the fixture entry saw `process.version` and argv
  `auth git-credential --account acct get` (as claude's
  `test/githubAuth.test.ts` does).

### F4: antigravity hardcodes the minimum version and has no test tying it to engines

- **Where:** `scripts/lib/node-runtime.sh:6-8`, plus the literal `>=26.0.0`
  repeated in its diagnostics at lines 81–98 and 170–172 (antigravity pin
  `980e57bc`).
- **Rule:** the selected plan says the shell-side minimum must be checked
  against `package.json` `engines.node` by a test.
- **Failure:** antigravity's tests have no `.nvmrc`, `engines` or `MIN_MAJOR`
  assertion. If engines moves to `>=27.0.0` and the script still says 26, the
  selector accepts Node 26. Coord then runs on an unsupported Node with every
  test passing, and the diagnostics keep stating the wrong requirement.
- **Smallest test:** read `MIN_MAJOR` from the script and assert
  `engines.node === `>=${MIN_MAJOR}.0.0`` and `.nvmrc` equals it (as the
  claude, codex and cursor wrapper tests do).

### F5: codex refuses an empty `COORD_NODE` everywhere (minor)

- **Where:** `scripts/lib/node-runtime.sh:34` (codex pin `ec02c6fc`):
  `if [ "${COORD_NODE+x}" = x ]`.
- **Rule:** an empty variable should not disable every entry point. The other
  three pins treat an empty `COORD_NODE` as unset (`[ -n "${COORD_NODE:-}" ]`).
- **Failure:** `COORD_NODE= /bin/sh scripts/lib/node-runtime.sh --resolve`
  exits 1 with `COORD_NODE must name an absolute executable bin/node:` (an
  empty value), even though a supported Node exists. A shell or tmux environment that exports `COORD_NODE=` to "clear"
  it therefore blocks:
  - every `coord` command;
  - every git hook;
  - the generated callbacks, because codex routes those through the selector
    too: the credential helper, the shell guard and the lifecycle hooks.

  This is low severity and a deliberate reading of "set but invalid fails". If
  codex is selected, it should either be documented or the check changed to
  `-n`.

### Self-review: claude's two accepted gaps

- **`src/githubAuth.ts:41`:** like cursor and antigravity, the pin bakes in
  `process.execPath`, as the selected plan specifies. The plan's
  documentation mitigation is in `docs/setup-workspace.md`. The durability
  failure under codex's Overall note above applies.
- **`src/install.ts:249`:** the `bootstrapCoordination` PATH change has no
  test. A hermetic test needs the `spawnSync` interception codex uses.

## Verdict

Prefer **codex** `ec02c6fc8c8ad68b0fcf8691b1ff93751651d6c0`. It has the same
runtime behavior as the others on every path I exercised. Its run-time selector
in callbacks fixes the `process.execPath` durability gap that the plan reviews
flagged, and its tests are the most hermetic and complete. Its only defect is
F5 (minor).

- **claude** `5acf3a9d6666cf71a2bbc30e99ddbfd7f47eb215` is the plan-faithful
  alternative. It has no correctness defect, but it has the two accepted gaps
  above.
- **antigravity** `980e57bcfba8f909c137199f7814c5e1e09850af` needs F2 and F4
  fixed.
- **cursor** `f6449d44305990a3620d2805b73a06096e33d5da` needs F1 and F3 fixed
  before it is safe to merge.
