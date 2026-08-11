# @consensus-ai/coordination

Owner-side driver for agent coordination.

## Quick Start

The driver must be run with a strictly-contained runtime root that exists entirely outside of any agent worktree.

```sh
# Ensure you are on Node 26
nvm use 26
pnpm install --frozen-lockfile

# Start the workflow
./coord start 1 --profile consensus --coord-root /path/to/coord-runtime

# Run the long-lived orchestration loop
./coord run --coord-root /path/to/coord-runtime
```

See `docs/coord-driver.md` for more details.
