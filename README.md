# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

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

export COORD_ROOT=/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime
export COORD_ISSUE=1
./coord run
```

Pull-only agents can fetch their current action without seeing internal step,
gate, evidence, or global cursor state:

```bash
COORD_AGENT=codex ./coord next
```

The action names an absolute `complete` path. After pushing the commit that
contains the required artifact, the agent writes that exact lowercase 40-hex
SHA—or `commit <sha>`—to `complete`. Branch-tip movement alone never completes
an action.

See [`docs/coord-driver.md`](docs/coord-driver.md) for profiles, owner controls,
tmux behavior, recovery, finalization, and runtime topology.
