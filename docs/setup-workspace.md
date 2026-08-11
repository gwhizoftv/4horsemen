# Installing coordination against a product

## The rule everything else follows

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

|  | Human clone of the product | Agent clone (`<product>-<agent>`) |
| --- | --- | --- |
| Coordination hooks | **none added** | branch ownership, commit prefix, declared `verify` |
| Identity / install root | none | `consensus.agentId`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` |
| Launcher | none | `start-<agent>.sh` |
| Day-to-day git | exactly as before onboarding | gated |

A default `coord install` leaves the product's tracked tree byte-for-byte
unchanged: `git status` in the product master is empty afterwards. Everything
coordination adds lives in each agent clone's untracked per-clone state
(`.git/hooks/`, `.git/info/exclude`, local git config) or under `--coord-root`.

If the product already has its own hooks for its own humans, coordination leaves
them alone. "No hooks for humans" means none *from coordination*.

## Install

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

| Step | Default action |
| --- | --- |
| 0 | Optional bootstrap/build of the coordination install |
| 1 | Preflight and containment (product ⊄ coord-root, clone root ⊄ product, …) |
| 2 | Create `<product>-<agent>` clones that do not exist; **never reset one that does** |
| 3 | Write `start-<agent>.sh`; add the managed block to each clone's `.git/info/exclude` |
| 4 | Record `consensus.*`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` in each clone |
| 5 | Install fail-closed shims into each agent clone's `.git/hooks/` |
| 6 | Emit the workspace config under `--coord-root` |
| 7 | Print the `coord doctor` / `coord start` / `coord run` next steps — nothing is auto-started |

Not written by default: the product's `githooks/`, `.gitignore`, `package.json`,
`AGENTS.md`, or `scripts/setup_*`.

A second `coord install` with the same arguments makes no changes. `--dry-run`
prints what a run would do and touches nothing.

## Uninstall

```bash
coord uninstall --coord-root /path/to/coord-runtime --product /path/to/app
  # --delete-clones        # refuses a dirty clone unless --force
  # --force
  # --wipe-runtime
  # --delete-coordination  # only if this install recorded bootstrap ownership
  # --dry-run
```

By default it clears the agent-clone hook wiring, the managed exclude block, the
launchers, and the clone's coordination git config, then deletes the workspace
entry. It removes the managed `.gitignore` block from the product **only if the
install recorded writing it**, and it never touches unrelated ignore lines or a
human-authored `AGENTS.md`. A hook file edited after installation is left in
place and reported rather than deleted.

## Hook delivery

- **Canonical bodies:** `coordination/githooks/**` in the install, and nowhere
  else.
- **Agent clones:** `.git/hooks/<name>` is a shim that execs
  `$(git config --local coord.installRoot)/githooks/<name>`.
- **Missing or unset install root on an agent clone:** commit and push are
  **blocked**, with the remediation command printed.
- **Human product clone:** no coordination shims, so nothing changes for it.

`core.hooksPath` is deliberately unused. When it points at a directory that does
not exist, git runs no hooks and reports nothing — every gate silently off, with
successful commits and pushes as the only evidence. `.git/hooks/` is git's
default path, cannot be clobbered by a pull, and its contents' *presence* is the
signal that a clone is an agent clone. An install that finds `core.hooksPath`
set (a clone migrating off the old tracked-`githooks/` layout) unsets it, so the
shims it just wrote are the hooks git actually runs.

`--vendor` copies the bodies into the clone's `.git/hooks/` instead, for a clone
that must run them without resolving `coord.installRoot`. The manifest stamps
the source commit, and `coord doctor` reports copies that fell behind the
install. There is no configuration in which both delivery modes are live and no
fallback between them: exactly one copy is authoritative.

`--vendor` is not a way to make a product's default branch work for outside
contributors. Outside humans should use a normal product clone with no
coordination hooks at all.

## What runs, and whose it is

Coordination adds no tests to the product. It runs what the product declares, at
three tiers that are easy to conflate:

| Tier | Whose | Where | On failure |
| --- | --- | --- | --- |
| 1 | coordination's own | the coordination repo | blocks coordination development |
| 2 | product-declared `verify` | the agent's clone, via its hooks | blocks that agent's commit or push |
| 3 | product-declared `checks` | a throwaway worktree at the exact approved commit | blocks pull-request creation |

Tiers 2 and 3 run the product's own suite and answer different questions. Tier 2
is fast feedback in a dirty worktree; tier 3 is hermetic and is what gates
publication. The journal records which tier failed.

### Declaring verification

```jsonc
"verify": {
  "precommit": [{ "name": "vet",  "argv": ["go", "vet", "./..."] }],
  "prepush":   [{ "name": "test", "argv": ["go", "test", "./..."] }]
}
```

- No hook branches on `package.json`, a lockfile, or a script name. A project
  whose checks are `make test` or a bare binary is verified exactly like a pnpm
  one.
- **An absent `verify` blocks**, with the fix printed. Opting out must be
  explicit: `"verify": { "precommit": [], "prepush": [] }`. This applies only
  where coordination hooks are installed — that is, agent clones. A human clone
  has no coordination hooks and is unaffected whether or not `verify` exists.
- `coord doctor` fails when a declared `argv[0]` is not on PATH, at install time
  rather than at an agent's first commit.

`coord install` proposes a `verify` / `checks` / critical-path set from the
product's obvious ecosystem (cargo, go, pnpm/npm/yarn, make) and writes it into
the config for review. That detection happens once, in the installer, and is
recorded. Hooks never sniff.

### Scoping the pre-push checks

```jsonc
"workflowCriticalPrefixes": ["cmd/", "internal/", "pkg/"],
"workflowCriticalFiles": ["go.mod", "go.sum"]
```

The pre-push hook runs `verify.prepush` when a push touches these, and whenever
the changed-path set cannot be determined. Declaring neither list means no
narrowing was declared, so every push is in scope — absence never quietly
shrinks what gets gated. Two projects can legitimately declare different lists
without either editing a hook body.

## Where the config lives, and why

The workspace config is written to
`<coord-root>/workspaces/<project>/config.json`, not into the product tree.

`digestPaths` resolve relative to the config file, so the automation material
whose digest the coordinator records sits beside the config, in the
owner-controlled runtime. That is the point: a `verify` or digest input inside
the product tree would let an agent supply argument vectors the coordinator or
another agent's clone then executes.

Place each issue's owner-authored plan at
`<coord-root>/workspaces/<project>/.plans/issue-<n>/plan.md` before
`coord start <n>`.

## Doctor

```bash
coord doctor --coord-root /path/to/coord-runtime --product /path/to/app
```

Each class of drift has its own exit code, so a script can act on the answer.
The process exits with the lowest code among the findings and prints all of
them, since a missing install root usually explains the hook findings under it.

| Code | Class | Meaning |
| --- | --- | --- |
| 10 | `installRoot` | install root, CLI entry, or per-clone `coord.*` config missing |
| 11 | `hooks` | hooks absent, unmanaged, missing, edited, or shadowed by `core.hooksPath` |
| 12 | `vendorStamp` | vendored copies are behind the install |
| 13 | `launcher` | `start-<agent>.sh` missing or not executable |
| 14 | `identity` | `consensus.agentId` missing, malformed, or crossed with another clone |
| 15 | `startCompatibility` | the config is one `coord start` would refuse |
| 16 | `toolchain` | a declared `argv[0]` is not on PATH |
| 17 | `installDrift` | the install root moved to a commit this workspace was not installed against |
| 18 | `verifyUndeclared` | no `verify` declared, so every agent commit would block |

## Transient evidence on agent branches

While an issue is in flight, agent branches carry `.plans/issue-<n>/`,
`.signals/issue-<n>/`, and `.code-reviews/issue-<n>/`. They are the protocol's
evidence: agents publish artifacts at exact commits and the coordinator reads
blobs at those SHAs, so they must be committed and pushed.

They are transient by design. R7 finalization is deletion-only cleanup of
exactly those prefixes, enforced by `verifyFinalization`, which rejects any
change that is not a deletion under the current issue's coordination paths. A
maintainer on the base branch never sees them, and a merge-ready pull request
contains none of them.

## Migrating off `scripts/setup_*.sh`

The setup scripts no longer create clones, write launchers, write ignore rules,
or wire hooks; `coord install` owns all of that, sharing the driver's own
containment logic and covered by `pnpm check`. What remains in them is
vendor-specific harness configuration, and they now refuse to run it against a
clone the installer has not wired.

A clone that still has `core.hooksPath=githooks` from the old layout is migrated
by the next `coord install`, which unsets it.
