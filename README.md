# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## Happy path

Install coordination once, onboard each product once, and then drive work from
GitHub issues. **This repository is private** — do not use anonymous
`curl … raw.githubusercontent.com … | sh` (it 404s without a public raw URL).

```sh
# Once per machine (GitHub CLI must already reach this private repo).
gh auth login          # if needed
gh auth setup-git      # so git clone/https works for private remotes

gh repo clone gwhizoftv/coordination /tmp/coordination-src
sh /tmp/coordination-src/scripts/bootstrap.sh --source /tmp/coordination-src
# Optional: rm -rf /tmp/coordination-src
# Add ~/.local/bin to PATH if the script prints that hint.

# Once per product.
coord onboard /path/to/app

# Each unit of work.
cd /path/to/app
gh issue create --title "Describe the work" --body "Acceptance criteria…"
coord 42
```

Bootstrap installs a complete checkout under `~/.local/share/coordination` and
links `~/.local/bin/coord`. `--source` may be a local clone (as above) or any
git URL your credentials can read. Public forks may still use
`curl -fsSL <raw-bootstrap-url> | sh` if the raw file is world-readable.

`coord onboard` defaults to four agents (`claude,codex,cursor,antigravity`),
the consensus profile, sibling agent clones, and
`<parent-of-product>/coord-runtime`. A fresh runtime uses
`coord-runtime/config.json`. It runs `coord doctor` before registering the
workspace for `coord N`.

At start, `coord N` reads issue N from the GitHub repository configured as the
product origin, snapshots its title and body, binds that snapshot and the
workspace config into the automation digest, launches the agents, and runs the
driver. The owner does not create a plan file first. Each agent authors and
publishes `.plans/issue-N/plan.md` later on its own `issue-N/<agent>` branch as
normal R2 evidence.

## Manual mode — drive the agents yourself

`coord manual` opens the same agent harnesses with no coordinator behind them:

```sh
cd /path/to/app
coord manual          # open or repair one window per configured agent, then exit
coord detach manual   # close that workspace's manual windows and tmux session
```

It resolves the onboarded product exactly as `coord N` does (or takes
`--product`, or the explicit `--config` + `--coord-root` pair), validates every
configured launcher, and returns immediately. There is **no** long-running
process: it fetches no GitHub issue, initializes no mirror, creates no
`issue-*` runtime directory, writes no `start.json`, `cursors.json`,
`journal.jsonl`, `action.md`, or `complete`, never nudges an agent, runs no
consensus or finalization checks, and opens no pull request. Your chat message
in each window is the whole task, and publishing stays your call.

Agents work on their own scratch branch `<agent>/<name>` unless you name an
issue branch. That namespace is already what the installed hooks allow, so every
safety gate stays exactly as it is: no commits on the shared branch, no commits
to a peer's branch, no force-pushes, and declared checks still run.

`coord manual` is idempotent — run it as often as you like. It reuses panes
whose harness is still alive, relaunches dead ones, and opens only the Terminal
windows that are missing. Its tmux session and window titles are scoped to the
workspace (`coord-manual-<group>`), so two onboarded products never address one
another's agents. `coord uninstall` tears the manual UI down too, including for
a workspace that has only ever been used manually and has no `issue-*`
directories.

One workspace runs one mode at a time: both drive the same agent clones, so
starting `coord manual` while an issue session is live fails and names
`coord detach <n>`, and starting `coord N`, `coord start`, or `coord run` while
manual mode is live fails and names `coord detach manual`.

## Product isolation

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers.

Onboard leaves the product's tracked tree byte-for-byte unchanged. Hooks,
launchers, identities, and ignore rules live only in the agent clones; policy
and runtime state live under the external coord root. The selected workspace is
recorded only in the onboarded product worktree's local Git config. A fresh
human clone gets no coordination hooks, locator, Node requirement, or new Git
obligations.

Multiple products may share an outer coord root. The first product keeps the
flat layout; later products use `workspaces/<project>/`, including separate
mirrors and issue-number namespaces. Existing nested installs remain
discoverable. See [`docs/setup-workspace.md`](docs/setup-workspace.md).

## Requirements

- Node 26 and pnpm 11
- Git and GitHub CLI (`gh`), authenticated for the product repository
- tmux for interactive agent launch and delivery
- the configured agent harnesses (Claude, Codex, Cursor, or Antigravity)

Bootstrap accepts `--root`, `COORD_INSTALL_ROOT`, and `--no-path`. It clones or
cleanly fast-forwards a complete install checkout, performs the locked build,
and refuses dirty or unrelated paths rather than resetting them.

## Advanced install and explicit operation

`coord install` retains the complete explicit surface for custom policy,
vendoring, product writes, clone roots, or dry runs:

```sh
coord install \
  --product /path/to/app \
  --coord-root /path/to/coord-runtime \
  --agents claude,codex \
  --profile reviewed \
  --declare /path/to/workspace-declaration.json

coord doctor --coord-root /path/to/coord-runtime --product /path/to/app
```

Explicit start/run forms remain available for automation and recovery:

```sh
coord start 42 --product /path/to/app
coord run --issue 42 --product /path/to/app

# Manual configs can still supply both paths explicitly.
coord start 42 --config /path/to/config.json --coord-root /path/to/runtime
coord run --issue 42 --coord-root /path/to/runtime
```

See `config.product.example.json` for declared verification/check commands and
[`docs/coord-driver.md`](docs/coord-driver.md) for profiles, owner controls,
tmux behavior, recovery, finalization, and runtime topology.

## Development

```sh
nvm use 26
pnpm install --frozen-lockfile
pnpm check
pnpm build
./coord --help
```

`pnpm check:fast` runs lint, source/test typechecking, and focused tests.
`pnpm test:e2e` runs the four-agent temporary-origin canary. `pnpm check` runs
both tiers.

Pull-capable agents can fetch their current action without seeing internal step,
gate, evidence, or global cursor state. From an agent clone after onboard:

```sh
coord next --issue 42
```

`coord.workspaceConfig` and `consensus.agentId` supply the runtime and caller.
Explicit forms remain available:

```sh
COORD_AGENT=codex coord next --issue 42 --coord-root /path/to/runtime
```

The action names an absolute `complete` path. After pushing the commit that
contains the required artifact, the agent writes that exact lowercase 40-hex
SHA—or `commit <sha>`—to `complete`. Branch-tip movement alone never completes
an action.
