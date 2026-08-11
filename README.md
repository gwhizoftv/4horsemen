# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## Two-mode rule

Coordination constrains **agents and the owner control plane**. It does not
constrain the product’s other developers. Default `coord install` leaves **zero
tracked footprint** on the product master: hooks and launchers live in agent
clones; workspace config and the install stamp live under `--coord-root`.

See [`docs/setup-workspace.md`](docs/setup-workspace.md).

## Requirements

- Node 26 and pnpm 11
- Git
- tmux for interactive agent launch/delivery
- an owner-controlled runtime directory outside every agent clone

## Install and verify

```bash
nvm use 26
pnpm install --frozen-lockfile
pnpm check
pnpm build
./coord --help
```

Onboard a product (does not auto-start a run):

```bash
./coord install \
  --product /path/to/app \
  --coord-root /path/to/coord-runtime \
  --agents claude,codex,cursor,antigravity \
  --profile consensus \
  --config ./config.product.example.json
./coord doctor --coord-root /path/to/coord-runtime
```

`pnpm check:fast` runs lint, source/test typechecking, and focused tests.
`pnpm test:e2e` runs the four-agent temporary-origin canary. `pnpm check` runs
both tiers.

## Quick start

Copy and edit `config.example.json` or use the config emitted by `coord install`.
In particular, set `origin`, clone roots, launchers, issue-aware `digestPaths`,
explicit `verify` / final-check argument vectors, and the PR policy. There is no
default runtime root: `--coord-root` is always required at start.

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
