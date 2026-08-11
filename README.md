# coordination

Standalone **workflow driver** for multi-agent coordination (issue 1).
This repo is separate from any app repo so hooks and tests stay decoupled.

## Quick start

```bash
pnpm install && pnpm check:fast
pnpm build && ./coord --help
```

## CLI contract

```
coord start <issue> --profile <p> --config <path> --coord-root <path>
coord run   --coord-root <path> --issue <n>
coord next  --coord-root <path> --issue <n> --agent <name>
coord drop  <agent> --coord-root <path> --issue <n>
coord pause / resume / restart-action / abandon
```

All commands require `--coord-root`, which points to an **external runtime
directory** that must live outside every agent clone. The coordinator refuses
to start if the root resolves inside any agent working tree.

Default runtime: `/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime`

## Runtime root layout

```
<coord-root>/
  mirror.git/          # bare mirror of origin
  issue-<n>/
    start.json         # immutable session config
    cursors.json       # current workflow state
    journal.jsonl      # append-only event log
    agents/<agent>/
      action.md        # current action
      complete         # agent writes submission SHA here
```

## Agent clones (siblings)

`coordination-claude`, `coordination-codex`, `coordination-cursor`, etc.

## Docs

See [`docs/coord-driver.md`](docs/coord-driver.md) for full driver documentation.
