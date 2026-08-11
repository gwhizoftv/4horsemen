# Installing a coordinated workspace

## One product repository, two modes

Coordination constrains dedicated agent clones and the owner's external control
plane. It does not constrain ordinary developers. The default installation
does not write the product's tracked tree, does not install hooks in the human
clone, and does not make the product depend on Node.

| | Human product clone | Agent clone |
| --- | --- | --- |
| Coordination hooks | none | fail-closed shims in `.git/hooks/` |
| Local identity | none | `consensus.*` and `coord.*` |
| Launcher | none | untracked `start-<agent>.sh` |
| Product verification | unchanged | declared `verify` argv |

Agents temporarily commit `.plans/issue-<n>/`, `.signals/issue-<n>/`, and
`.code-reviews/issue-<n>/` evidence on their branches. R7 removes only the
current issue's evidence before a merge-ready PR is opened, so those paths do
not become a permanent default-branch footprint.

## Install

Run the coordination checkout's wrapper against any Git product clone:

```bash
./coord install \
  --product /path/to/product \
  --coord-root /path/to/owner-runtime \
  --agents claude,codex,cursor,antigravity \
  --profile consensus
```

The command creates or reuses sibling `<product>-<agent>` clones, writes
agent-local excludes and launchers, records local identity/install config,
installs shims in each clone's real Git hook directory, and emits an owner-only
workspace config under `<coord-root>/workspaces/`. It prints the exact `coord
start` command but never starts a run automatically.

Use `--dry-run` to inspect the plan. A second identical install is a no-op.
`--clone-root` chooses another non-overlapping clone location. `--vendor` copies
the canonical bodies into the agent hook directories for offline use; it never
falls back between the install root and the copy. `--write-product` is an
explicit exception that adds a managed `.gitignore` block and creates the
coordination `AGENTS.md` template only when none exists. Combining it with
`--vendor` also writes inert, additive hook bodies into the product tree.

An optional existing config can supply product policy:

```bash
./coord install ... --config ./config.product.json
```

Hooks never inspect `package.json`, lockfiles, or script names. They execute
each declared argv directly, without a shell. Missing `verify` is an error in an
agent clone; explicit empty `precommit` and `prepush` arrays record an opt-out.
`checks` remains separate: it runs in the coordinator's clean final worktree
and blocks PR creation independently of local hook verification.

## Diagnose and remove

```bash
./coord doctor --product /path/to/product --coord-root /path/to/owner-runtime
./coord uninstall --product /path/to/product --coord-root /path/to/owner-runtime
```

Doctor reports configuration incompatibility, missing install roots, install
or vendor drift, missing hooks/launchers, bad identity, and declared commands
that are not executable on `PATH`. Uninstall removes only managed agent wiring,
launchers, excludes, and the workspace entry. It leaves clones and runtime
history by default. `--delete-clones` refuses dirty clones unless `--force` is
also explicit; `--wipe-runtime` removes issue/mirror state. Coordination itself
is deletable only when the install stamp records that the installer created it.
