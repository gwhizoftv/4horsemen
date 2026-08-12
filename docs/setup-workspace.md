# Installing coordination against a product

## Bootstrap: the install root

```bash
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
```

This installs a **complete coordination checkout** at
`~/.local/share/coordination` and a `coord` wrapper at `~/.local/bin/coord`. A
complete checkout is required, not just a binary: each agent clone's hooks are
fail-closed shims that exec canonical hook bodies out of `githooks/**` in the
install root, and resolve declared verification through its built `dist/`.

| Flag | Effect |
| --- | --- |
| `--root <dir>` | install root; also `COORD_INSTALL_ROOT`, and `--root` wins |
| `--source <url\|dir>` | repository to clone; also `COORD_INSTALL_SOURCE` |
| `--ref <branch>` | branch to track (default `main`) |
| `--no-path` | do not install `~/.local/bin/coord` |
| `--no-build` | skip `pnpm install` / `pnpm build` |

Re-running is safe and is how you upgrade. A clean checkout is fetched and
**fast-forwarded only**; a dirty or diverged one is refused with its status
printed and nothing rewritten. Bootstrap never resets, cleans, or
force-checks-out, because the install root is frequently somebody's working
checkout of this repository.

Bootstrap records that it created a checkout in `<root>/.git/coord-bootstrap`,
inside `.git/` so the worktree stays clean. That note deliberately does **not**
authorize `coord uninstall --delete-coordination`: one install root serves every
onboarded product, so no single product's uninstall may remove it. Remove a
bootstrapped install by hand:

```bash
rm -rf ~/.local/share/coordination ~/.local/bin/coord
```

Already develop coordination in a checkout of your own? Point
`COORD_INSTALL_ROOT` at it, or just run `./coord` from that checkout. Bootstrap
touches no product repository and onboards nothing.

## Onboard: the whole product-wiring step, once

```bash
coord onboard /path/to/app
```

| Default | Value |
| --- | --- |
| `--coord-root` | `<parent-of-product>/coord-runtime`, created |
| `--clone-root` | the product's parent directory |
| `--agents` | `claude,codex,cursor,antigravity` |
| `--profile` | `consensus`, recorded in the config so `coord <n>` needs no flag |
| install root | the checkout containing the running `coord` |

Onboard is defaults plus composition, not a second installer: it calls the same
`install` below with `--write-product`, `--vendor`, and
`--bootstrap-coordination` all off, then runs `coord doctor` and **exits with
doctor's code**. A workspace that would fail at an agent's first commit fails
here, where it is one command to repair. The installed files stay in place on a
doctor failure — they are what the repair acts on.

Onboard also records `coord.ownerWorkspaceConfig` in your product clone's local
git config: the absolute path of its workspace config. That is what lets
`coord 42` work with no flags from the product or any of its agent clones. It is
untracked, per-clone, and never copied to anyone else's checkout, and
`coord uninstall` removes it. It is deliberately **not** one of the three keys
that mark an agent clone (`coord.installRoot`, `coord.cliEntry`,
`coord.workspaceConfig`), which the hooks treat as proof that a clone is an
agent clone.

Anything onboard does not expose — `--declare`, `--write-product`, `--vendor`,
`--origin`, `--base-branch` — stays on `coord install`.

## The rule everything else follows

> Coordination constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

|  | Human clone of the product | Agent clone (`<product>-<agent>`) |
| --- | --- | --- |
| Coordination hooks | **none added** | branch ownership, commit prefix, declared `verify` |
| Identity / install root | none | `consensus.agentId`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` |
| Owner locator | none | n/a — written only to *your own* product clone |
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
| 2 | Create missing `<product>-<agent>` clones; adopt only a worktree of this product; fast-forward a clean one; **never reset one** |
| 3 | Write `start-<agent>.sh`; add the managed block to each clone's `.git/info/exclude` |
| 4 | Record `consensus.*`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` in each clone |
| 5 | Install fail-closed shims into each agent clone's `.git/hooks/` |
| 6 | Emit the workspace config under `--coord-root` |
| 6b | Record `coord.ownerWorkspaceConfig` in the owner's product clone |
| 7 | Print the `coord doctor` / `gh issue create` / `coord <n>` next steps — nothing is auto-started |

Not written by default: the product's `githooks/`, `.gitignore`, `package.json`,
`AGENTS.md`, or `scripts/setup_*`.

A second `coord install` with the same arguments makes no changes. `--dry-run`
prints what a run would do and touches nothing — including inside the clones.

Everything knowable is decided before any effect: agent ids are validated
against the coordinator's own schema, checked for duplicates, and checked for a
launcher; the workspace config is built and validated. A product whose checks
cannot be inferred is refused before a clone exists, not after.

**Adoption.** An existing directory at the clone path is adopted only when it is
the root of a git worktree whose `origin` is this product. Anything else is
refused rather than wired, because coordination would otherwise write identity,
policy, hooks, and a launcher into an unrelated repository.

**Syncing.** A clone that is clean and on the base branch is fast-forwarded, so a
reinstall does not leave an agent working from a stale baseline. A dirty or
diverged clone is reported and left exactly as it is; coordination never rewrites
a clone.

## Uninstall

```bash
coord uninstall --coord-root /path/to/coord-runtime --product /path/to/app
  # --delete-clones        # refuses a dirty clone unless --force
  # --force
  # --wipe-runtime
  # --delete-coordination  # only if this install created the coordination checkout
  # --dry-run
```

By default it clears the agent-clone hook wiring, the managed exclude block, the
launchers, and the clone's coordination git config, restores any hook that was
displaced at install time, and deletes the workspace **config file**. It removes
the managed `.gitignore` block and the generated `AGENTS.md` from the product
**only if the install recorded writing them**, and it never touches unrelated
ignore lines or a human-authored `AGENTS.md`. A hook file edited after
installation is left in place and reported rather than deleted.

Four scoping rules matter:

- The workspace **directory** is not deleted. It is also where you keep this
  project's plan and digest material, so only the file coordination wrote goes.
- `--wipe-runtime` is scoped to this project's workspace and issue runtimes. If
  the runtime holds other products it refuses unless you add `--force`, because
  those products' in-flight issue state would otherwise go with it.
- Every refusal — dirty clones, checkout ownership — is decided before anything
  is unwired, so a refused uninstall leaves the workspace byte-for-byte intact.
- `--delete-coordination` requires that this install *created* the coordination
  checkout. Running bootstrap commands inside a checkout you already had is not
  ownership of it, so the flag refuses.

## Hook delivery

- **Canonical bodies:** `coordination/githooks/**` in the install, and nowhere
  else.
- **Agent clones:** `.git/hooks/<name>` is a shim that execs
  `$(git config --local coord.installRoot)/githooks/<name>`.
- **Missing or unset install root on an agent clone:** commit and push are
  **blocked**, with the remediation command printed.
- **Human product clone:** no coordination shims, so nothing changes for it.
- **A hook the clone already had** is renamed to `<hook>.coord-original` and
  chained by the shim, which runs coordination's body first and the original
  after. Uninstall puts it back. Adding coordination's gates never removes the
  product's own.
- **Identity resolution keys on coordination wiring**, not on the hooks' mere
  presence. A clone carrying `coord.installRoot`, `coord.cliEntry`,
  `coord.workspaceConfig`, or a hook manifest is an agent clone, so a missing or
  malformed `consensus.agentId` there **blocks**. Without any of that wiring the
  hooks pass through, which is what keeps a human clone usable.

`core.hooksPath` is deliberately unused. When it points at a directory that does
not exist, git runs no hooks and reports nothing — every gate silently off, with
successful commits and pushes as the only evidence. `.git/hooks/` is git's
default path and cannot be clobbered by a pull. An install that finds `core.hooksPath`
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

`--write-product --vendor` is the one path that puts hook bodies into a tracked
tree, and it is additive: it refuses to replace a hook the product already
maintains. The bodies it writes stay harmless to humans for the reason above —
they resolve identity from coordination wiring a human clone does not have — so
a developer who enables the committed hooks out of curiosity gets a
pass-through, not a blocked repository. There is a test for exactly that.

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
- The installer never writes that opt-out on your behalf. When its proposal
  finds no command to run, it omits `verify` entirely, so the hooks fail closed
  and name the fix rather than recording a decision nobody made.
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

Never in the product tree. A `verify` or digest input inside the product tree
would let an agent supply argument vectors the coordinator or another agent's
clone then executes.

A runtime serving **one** product is flat:

```text
/path/to/coord-runtime/
  config.json
  mirror.git
  issue-42/
```

A runtime serving **several** products nests every product after the first,
including its run state:

```text
/path/to/coord-runtime/
  config.json                     # the first product
  mirror.git
  issue-42/
  workspaces/other-app/
    config.json
    mirror.git
    issue-42/                     # a different issue 42, in a different repo
```

Run state follows the workspace root because GitHub issue numbers are
repository-local: two products can legitimately each have an issue 42, and they
must not share cursors, journal, digest, or mirror.

Resolution is flat-first and never relocates an existing install, so a workspace
installed at `workspaces/<project>/config.json` by an earlier version keeps
working exactly as it did — `start`, `doctor`, and `uninstall` all resolve both
layouts. There is no migration step and nothing is moved automatically.

### What binds a run

The work statement for issue N is **GitHub issue N**. At `coord start <n>` the
driver runs `gh issue view <n> --repo <owner/repo>` — with the repository taken
from the workspace's `origin`, never from your working directory — validates the
response, and writes the canonical snapshot to
`<workspace-root>/issue-<n>/github-issue.json`. Those exact bytes are hashed
into `automationDigest` alongside the config's, so re-hashing the persisted file
reproduces the digest, and an issue edited upstream later cannot silently rebind
a run in flight.

There is **no owner-authored plan file**. `digestPaths` still exists and is now
empty by default: declare paths in it only if you want some additional immutable
file pinned into the session hash. The agents' `.plans/issue-<n>/plan.md` files
are R2 protocol evidence on their own branches and are unrelated to the digest.

If issue N does not exist, or `gh` is missing or unauthenticated, start fails
before creating any runtime state or launching any tmux pane, and names both
remedies.

## Doctor

```bash
coord doctor --coord-root /path/to/coord-runtime --product /path/to/app
```

Each class of drift has its own exit code, so a script can act on the answer.
The process exits with the lowest code among the findings and prints all of
them, since a missing install root usually explains the hook findings under it.

What doctor compares hooks against is the **canonical source in the install**,
never the manifest in the clone. That manifest sits in an agent's own working
copy, so it is evidence to be checked rather than the authority — an agent that
rewrote a hook and restamped its digest would otherwise be certified healthy,
by the tool built to catch exactly that. For the same reason the stamp records a
digest of the hook bodies, shim, and launcher template, so an uncommitted edit
in the install root is reported even though the commit has not moved.

| Code | Class | Meaning |
| --- | --- | --- |
| 10 | `installRoot` | install root, CLI entry, or per-clone `coord.*` config missing |
| 11 | `hooks` | hooks absent, unmanaged, missing, edited, non-executable, shadowed, or described by an invalid manifest |
| 12 | `vendorStamp` | vendored copies are behind the install |
| 13 | `launcher` | `start-<agent>.sh` missing or not executable |
| 14 | `identity` | `consensus.agentId` missing, malformed, or crossed with another clone |
| 15 | `startCompatibility` | the config is one `coord start` would refuse |
| 16 | `toolchain` | a declared `argv[0]` is not on PATH |
| 17 | `installDrift` | the install root moved, its canonical hook bytes changed without a commit, or a clone points elsewhere |
| 18 | `verifyUndeclared` | no `verify` declared, so every agent commit would block |
| 19 | `cloneMissing` | an agent clone is absent, or is no longer a git worktree |

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
