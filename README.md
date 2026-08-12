# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## Happy path

```bash
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
coord onboard /path/to/app
gh issue create --title "…" --body "…"
coord 42
```

`coord onboard` wires four agent clones beside the product, writes
`<parent>/coord-runtime/config.json`, and records a product-local locator
(`coord.ownerWorkspaceConfig`). It does not add tracked files or hooks to the
product clone. Agents author `.plans/issue-N/plan.md` on their issue branches
after launch; owners do not pre-create an owner plan under the runtime.

## One repo, two modes

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

See [`docs/setup-workspace.md`](docs/setup-workspace.md) for layouts, advanced
`coord install` flags, doctor, and uninstall.

## Requirements

- Node 26 and pnpm 11
- Git and GitHub CLI (`gh`) authenticated for issue fetch / optional PR open
- tmux for interactive agent launch/delivery
- an owner-controlled runtime directory outside every agent clone

## Source checkout development

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

## Advanced install

```bash
./coord install \
  --product /path/to/app \
  --coord-root /path/to/coord-runtime \
  --agents claude,codex,cursor,antigravity \
  --profile consensus
```

`coord <issue>` starts (or resumes) and runs in one process. Explicit
`coord start` still refuses an existing runtime. See
[`docs/coord-driver.md`](docs/coord-driver.md) for profiles, digest sources
(config + GitHub issue snapshot + optional `digestPaths`), owner controls, and
runtime topology.
