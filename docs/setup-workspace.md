# Installing coordination against a product

## The rule everything else follows

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

|  | Human clone of the product | Agent clone (`<product>-<agent>`) |
| --- | --- | --- |
| Coordination hooks | **none added** | branch ownership, commit prefix, declared `verify` |
| Identity / install root | none (except optional owner locator) | `consensus.agentId`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` |
| Launcher | none | `start-<agent>.sh` |
| Day-to-day git | exactly as before onboarding | gated |

## Happy path

```bash
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
coord onboard /path/to/app
gh issue create --title "…" --body "…"
coord 42
```

`scripts/bootstrap.sh` installs a complete checkout under
`~/.local/share/coordination` (or `--root` / `COORD_INSTALL_ROOT`), builds it,
and links `~/.local/bin/coord` to that checkout's `coord` wrapper unless
`--no-path` is set. Re-runs only fast-forward a clean worktree; dirty checkouts
are refused. When bootstrap creates the checkout it records ownership under
`.git/coord-bootstrap-owner`.

`coord onboard <product>` is a thin preset over `coord install`:

| Default | Value |
| --- | --- |
| coord root | `<parent-of-product>/coord-runtime` |
| clone root | product parent |
| agents | `claude,codex,cursor,antigravity` |
| profile | `consensus` (persisted on the workspace config) |
| product writes / vendor / bootstrap | off |

It writes a **flat** `<coord-runtime>/config.json` for the first product, records
the absolute config path in the product's local git config as
`coord.ownerWorkspaceConfig` (not an agent-clone key), runs `coord doctor`, and
leaves `git status` empty in the product. A second product on the same runtime
gets a nested `workspaces/<project>/` without moving the first. Run state
(`issue-N`, `mirror.git`) lives under that product's `workspaceRoot`.

Agents author `.plans/issue-N/plan.md` on `issue-N/<agent>` after launch. Owners
do **not** pre-create an owner plan under the runtime. The automation digest
binds the workspace `config.json`, a mandatory GitHub issue snapshot
(`github-issue.json`), and any optional supplemental `digestPaths` (default `[]`).

## Advanced install

```bash
coord install \
  --product /path/to/app \
  --coord-root /path/to/coord-runtime \
  --agents claude,codex,cursor,antigravity \
  --profile consensus
  # --write-product            # opt-in tracked product changes (additive only)
  # --vendor                   # copy hook bodies into agent clones instead of exec'ing them
  # --bootstrap-coordination   # pnpm install + pnpm build in the coordination install first
  # --clone-root <dir>         # default: the product's parent directory
  # --declare <file.json>      # declare verify / checks / critical paths explicitly
  # --dry-run
```

Policy declarations, product writes, vendoring, origin/base overrides, and
dry-run stay on advanced `coord install`. Onboard remains the small happy-path
surface.

A second `coord install` with the same arguments makes no changes. `--dry-run`
prints what a run would do and touches nothing.

## Uninstall

```bash
coord uninstall --coord-root /path/to/coord-runtime --product /path/to/app
  # --delete-clones        # refuses a dirty clone unless --force
  # --force
  # --wipe-runtime         # scoped to this workspaceRoot's issue-N + mirror
  # --delete-coordination  # only if bootstrap ownership was recorded
  # --dry-run
```

Uninstall clears agent wiring, deletes the workspace config, and clears the
owner locator when it points at this workspace. It never deletes the outer
coord-root itself for a flat layout. `--wipe-runtime` removes only this
workspace's `issue-*` directories and `mirror.git`.

## Doctor

```bash
coord doctor --coord-root /path/to/coord-runtime --product /path/to/app
```

Resolves flat before nested, checks GitHub origin compatibility for start, and
does not require `github-issue.json` to exist offline. Supplemental `digestPaths`
are checked for `{issue}` only when non-empty.

See [`docs/coord-driver.md`](coord-driver.md) for `coord N`, start/run, digests,
and runtime topology.
