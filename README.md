# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## The whole flow

```bash
# Once per machine
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh

# Once per product
coord onboard /path/to/app

# Each unit of work
gh issue create --title "…" --body "…"    # → e.g. #42
coord 42
```

You create the **GitHub issue**; that is the work statement, and `coord 42`
snapshots it and hashes it into the session. The **agents** create the plans, on
their own `issue-42/<agent>` branches, as the first step of the protocol. You
never hand-write a plan file before starting.

`coord 42` starts issue 42 if it has not been started and resumes it if it has,
then runs the driver — so it is also the command you re-run after `Ctrl-C`.

## One repo, two modes

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

`coord onboard` therefore leaves the product's tracked tree byte-for-byte
unchanged: hooks, launchers, identity, and ignore rules land in each agent
clone's untracked per-clone state, and declared policy lands under the
coord-root. The only thing written to your own product clone is one untracked
local git config key, `coord.ownerWorkspaceConfig`, which is how `coord 42`
finds the runtime without flags. A human who clones the product normally gets
no coordination hooks, no Node requirement, and no new obligations. See
[`docs/setup-workspace.md`](docs/setup-workspace.md).

## Requirements

- Node 26 and pnpm 11
- Git, and the GitHub CLI (`gh`), authenticated
- tmux for interactive agent launch/delivery
- an owner-controlled runtime directory outside every agent clone
  (`onboard` defaults it to `<parent-of-product>/coord-runtime`)

## What onboard does

```bash
coord onboard /path/to/app
```

Fills in the coord-root, the clone root, the agent roster
(`claude,codex,cursor,antigravity`), and the profile (`consensus`); creates and
wires the agent clones; writes one workspace config; then runs `coord doctor`
and exits non-zero if it finds anything. A workspace that would fail at an
agent's first commit fails here instead.

What the hooks and the finalization checks run is whatever the product declares
as argument vectors (`verify` and `checks`), so a Rust, Go, or Makefile product
is verified exactly like a pnpm one — no hook branches on `package.json`, a
lockfile, or a script name. See `config.product.example.json`.

Override any default, or reach the flags onboard does not expose
(`--declare`, `--write-product`, `--vendor`), with `coord install`. Both are
documented in [`docs/setup-workspace.md`](docs/setup-workspace.md), along with
`coord uninstall`, the multi-product layout, and `coord doctor`'s exit codes.

## Developing coordination itself

```bash
nvm use 26
pnpm install --frozen-lockfile
pnpm check
pnpm build
./coord --help
```

`pnpm check:fast` runs lint, source/test typechecking, and focused tests.
`pnpm test:e2e` runs the four-agent temporary-origin canary. `pnpm check` runs
both tiers.

To drive agents from a checkout you are developing rather than the installed
root, point `COORD_INSTALL_ROOT` at it before bootstrapping, or run `./coord`
from the checkout directly.

## Owner controls

Once a run is in flight, every control resolves the product the same way
`coord 42` does — from the cwd, or from `--product <path>`:

```bash
coord pause   --issue 42
coord resume  --issue 42
coord drop    codex --issue 42
coord abandon --issue 42
```

Pull-only agents fetch their current action without seeing internal step, gate,
evidence, or global cursor state:

```bash
COORD_AGENT=codex coord next --issue 42
```

The action names an absolute `complete` path. After pushing the commit that
contains the required artifact, the agent writes that exact lowercase 40-hex
SHA—or `commit <sha>`—to `complete`. Branch-tip movement alone never completes
an action.

See [`docs/coord-driver.md`](docs/coord-driver.md) for profiles, the digest
model, tmux behavior, recovery, finalization, and runtime topology.
