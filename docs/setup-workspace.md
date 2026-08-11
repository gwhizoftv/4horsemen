# Setup workspace (`coord install`)

## Two-mode rule

Coordination constrains **agents and the owner control plane**. It does not
constrain the product’s other developers. One person can use plain VS Code on
the product repo — no `coord`, no Node, no new git obligations — while another
drives agents against the same GitHub remote.

| | Human clone | Agent clone (`<product>-<agent>`) |
| --- | --- | --- |
| Coordination hooks | none | `.git/hooks/` shims → install-root bodies |
| Identity | none | `consensus.agentId`, `coord.installRoot` |
| Launcher | none | `start-<agent>.sh` (via clone exclude) |
| Day-to-day git | unchanged | gated |

Default install footprint on the **product master tracked tree is zero**.

Transient evidence (`.plans/`, `.signals/`, `.code-reviews/`) appears on agent
branches during a run and is removed by R7 cleanup before a merge-ready PR.

## Install

```bash
./coord install \
  --product /path/to/app \
  --coord-root /path/to/coord-runtime \
  --agents claude,codex,cursor,antigravity \
  --profile consensus \
  --config ./config.product.example.json
```

What it does by default:

1. Preflight containment (product ⊄ coord-root, clones ⊄ coord-root, …)
2. Create/sync `<product>-<agent>` clones beside the product (or `--clone-root`)
3. Write `start-<agent>.sh` and clone `.git/info/exclude` entries
4. Set clone `consensus.*`, `coord.installRoot`, `coord.workspaceConfig`
5. Install fail-closed shims into **agent clone `.git/hooks/`**
6. Emit workspace `config.json` under coord-root (including `verify`, `checks`,
   `workflowCritical*`, and the install stamp)
7. Print `coord start` / `coord run` next steps — does **not** auto-run

Opt-in:

- `--write-product` — additive managed `.gitignore` block / optional `AGENTS.md`
- `--vendor` — copy full hook bodies into the agent clone for offline use
- `--dry-run` — print actions without writing

## Uninstall

```bash
./coord uninstall --coord-root /path/to/coord-runtime
```

Conservative by default: clears agent-clone hook wiring, excludes, launchers,
and install config; removes the managed product ignore block only if install
recorded writing it; deletes the workspace config entry.

Opt-in: `--delete-clones` (refuses dirty clones unless `--force`),
`--wipe-runtime`, `--delete-coordination` (only if bootstrap ownership was
recorded).

## Doctor

```bash
./coord doctor --coord-root /path/to/coord-runtime
```

Reports distinct failures for missing install root, bad hooks, stale vendor
stamp, missing launcher, malformed agent identity, missing argv[0] on PATH, and
config incompatible with `coord start`.

## Verify vs checks

| Tier | Where | Source |
| --- | --- | --- |
| Agent `verify` | agent clone hooks | `verify.precommit` / `verify.prepush` argv |
| Finalization `checks` | throwaway worktree | `checks[].argv` |

Missing top-level `verify` fails closed **on agent clones**. Explicit empty
`verify` (`{ "precommit": [], "prepush": [] }`) allows commits without local
project checks. Human clones have no coordination hooks and are unaffected.

Hooks never sniff `package.json` / lockfiles / script-name greps.

## Migration from `scripts/setup_*.sh`

Those scripts are deprecated. Prefer `coord install`. They remain temporarily
for migration and print a warning when invoked.
