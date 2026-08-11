# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## One repo, two modes

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

`coord install` therefore leaves the product's tracked tree byte-for-byte
unchanged by default: hooks, launchers, identity, and ignore rules land in each
agent clone's untracked per-clone state, and declared policy lands under
`--coord-root`. A human who clones the product normally gets no coordination
hooks, no Node requirement, and no new obligations. See
[`docs/setup-workspace.md`](docs/setup-workspace.md).

## Requirements

- Node 26 and pnpm 11
- Git
- tmux for interactive agent launch/delivery
- one existing clone and executable `start-<agent>.sh` launcher per configured
  agent
- an owner-controlled runtime directory outside every agent clone

## Install and verify

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

## Onboard a product

```bash
./coord install \
  --product /path/to/app \
  --coord-root /path/to/coord-runtime \
  --agents claude,codex,cursor,antigravity \
  --profile consensus

./coord doctor --coord-root /path/to/coord-runtime --product /path/to/app
```

The install emits a workspace config under `--coord-root` that `coord start`
accepts unchanged. What the hooks and the finalization checks run is whatever
the product declares as argument vectors (`verify` and `checks`), so a Rust, Go,
or Makefile product is verified exactly like a pnpm one — no hook branches on
`package.json`, a lockfile, or a script name. `coord uninstall` reverses it, and
is non-destructive unless you ask otherwise. See `config.product.example.json`.

## Quick start

Copy and edit `config.example.json`. In particular, set `origin`, clone roots,
launchers, issue-aware `digestPaths`, explicit final-check argument vectors,
and the PR policy. There is no default runtime root: `--coord-root` is always
required at start.

```bash
./coord start 1 \
  --profile consensus \
  --config ./config.json \
  --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime

export COORD_ISSUE=1
./coord run --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime
```

Pull-only agents can fetch their current action without seeing internal step,
gate, evidence, or global cursor state:

```bash
COORD_AGENT=codex ./coord next \
  --coord-root /Volumes/4TB-SOURCE/REPOS/coord/coord-runtime
```

The action names an absolute `complete` path. After pushing the commit that
contains the required artifact, the agent writes that exact lowercase 40-hex
SHA—or `commit <sha>`—to `complete`. Branch-tip movement alone never completes
an action.

See [`docs/coord-driver.md`](docs/coord-driver.md) for profiles, owner controls,
tmux behavior, recovery, finalization, and runtime topology.
