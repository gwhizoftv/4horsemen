# Installing Four Horsemen against a product

## The rule everything else follows

> Four Horsemen constrains **agents and the owner control plane**. It does not
> constrain the product's other developers. One person must be able to use plain
> VS Code on the product repo — no `coord`, no Node, no new git obligations —
> while another drives agents against the same GitHub remote.

|  | Human clone of the product | Agent clone (`<product>-<agent>`) |
| --- | --- | --- |
| Coordination hooks | **none added** | branch ownership, commit prefix, declared `verify` |
| Identity / install root | none | `consensus.agentId`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` |
| Launcher | none | `start-<agent>.sh` |
| Day-to-day git | exactly as before onboarding | gated |

A default `coord onboard` or `coord install` leaves the product's tracked tree byte-for-byte
unchanged: `git status` in the product master is empty afterwards. Everything
coordination adds lives in each agent clone's untracked per-clone state
(`.git/hooks/`, `.git/info/exclude`, local git config) or under `--coord-runtime`.

If the product already has its own hooks for its own humans, coordination leaves
them alone. "No hooks for humans" means none *from coordination*.

## Bootstrap once

With Node 26, pnpm 11 and Git installed, bootstrap from the public URL without
GitHub CLI authentication to Four Horsemen:

```sh
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/4horsemen/main/scripts/bootstrap.sh | sh
```

Or clone and inspect the script before executing it:

```sh
git clone https://github.com/gwhizoftv/4horsemen.git 4horsemen-src
# Review 4horsemen-src/scripts/bootstrap.sh first.
sh 4horsemen-src/scripts/bootstrap.sh --source "$PWD/4horsemen-src"
```

The POSIX shell bootstrap clones or updates a complete install at
`${COORD_INSTALL_ROOT:-$HOME/.local/share/coordination}` (override with
`--root`), runs `pnpm install --frozen-lockfile` and `pnpm build`, and creates
the managed `$HOME/.local/bin/coord` symlink unless `--no-path` is set.
`--source` accepts a local path or git URL. A rerun fast-forwards a clean
`main` checkout; it refuses dirty, diverged, non-worktree, or foreign launcher
paths without resetting or deleting anything.

Only a checkout created by bootstrap receives ownership metadata under its
`.git/` directory. Building a developer checkout never makes uninstall the
owner of that checkout.

`COORD_SOURCE` supplies the default source; `--source` overrides it. For private
forks, authenticate Git and pass a local authenticated clone as `--source`.
The anonymous commands require a public upstream: release preparation does not
itself change repository visibility. Owner release gates remain in
[issue #139](https://github.com/gwhizoftv/4horsemen/issues/139).

GitHub CLI (`gh`) authentication is needed for product issue/PR operations, not
for public bootstrap. Interactive operation also needs tmux, the configured
harnesses and the product's own tools. Terminal.app windows are a macOS-only
integration; on other platforms use tmux without those windows.

## Onboard a product

```sh
coord onboard /path/to/app
```

The runtime directory defaults to `coord-runtime` beside the product checkout.
The four agent clones also sit beside that checkout:

```text
/path/to/app/
/path/to/app-claude/
/path/to/app-codex/
/path/to/app-cursor/
/path/to/app-antigravity/
/path/to/coord-runtime/config.json
/path/to/completes/coord-runtime/
```

Use `--coord-runtime` to choose a different runtime directory, for example:

```sh
coord onboard /path/to/app --coord-runtime /path/to/app-runtime
```

Its completion mailbox then defaults to `/path/to/completes/app-runtime/`.

Onboard is a preset over the same installer described below. It selects the
four standard agents and consensus profile, creates the agent wiring, runs
doctor, and returns doctor's class-specific non-zero status on any finding.
Only after doctor succeeds does it record `coord.ownerWorkspaceConfig` in the
product worktree's **local** Git config. It does not set the three agent-wiring
keys on that product. The locator is untracked and does not appear in a fresh
human clone.

Overrides kept on the simple command are `--coord-runtime`, `--clone-root`,
`--agents`, and `--profile`. Use advanced install for policy declarations,
vendoring, tracked product changes, origin/base overrides, or dry runs.

## Advanced install

```bash
coord install \
  --product /path/to/app \
  --coord-runtime /path/to/coord-runtime \
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
| 1 | Preflight and containment (product ⊄ coord-runtime, clone root ⊄ product, …) |
| 2 | Create missing `<product>-<agent>` clones from the product **origin** URL (not the local product worktree); adopt only a worktree of this product; fast-forward a clean one; **never reset one** |
| 3 | Write `start-<agent>.sh`; add the managed block to each clone's `.git/info/exclude` |
| 4 | Record `consensus.*`, `coord.installRoot`, `coord.cliEntry`, `coord.workspaceConfig` in each clone |
| 5 | Install fail-closed shims into each agent clone's `.git/hooks/` |
| 6 | Emit the selected flat or nested workspace config under `--coord-runtime` |
| 7 | Print explicit `coord doctor` / `coord manual` / `coord start` / `coord run` next steps — nothing is auto-started |

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
coord uninstall --coord-runtime /path/to/coord-runtime --product /path/to/app
  # --delete-clones        # refuses a dirty clone unless --force
  # --force
  # --wipe-runtime
  # --delete-coordination  # only if this install recorded bootstrap ownership
  # --dry-run
```

To reuse a GitHub issue number without closing it (reset clones + delete origin
`issue-N/<agent>` and `*-final` branches + leftover tracking refs, keeping
`issue-N/coordinator-evidence` unless `--delete-evidence`, and keeping any
product-local issue branch that has owner commits or uncommitted work + local
issue runtime + tmux/Terminals):

```bash
coord wipe-issue N --product /path/to/app
  # --force             # discard dirty clone worktrees
  # --delete-evidence   # also remove issue-N/coordinator-evidence
  # --dry-run
```

To close owner Terminal windows and kill issue tmux sessions without wiping
runtime or branches:

```bash
coord detach N --product /path/to/app
```

For owner-driven work with no GitHub issue or coordinator artifacts, run
`coord manual` from the onboarded product (or pass `--product`). It creates or
repairs the workspace-scoped `coord-manual-<group>` agent UI and returns; repeat
launches reuse healthy panes and open only missing Terminal clients. Agents
follow owner chat on `<agent>/<name>` scratch branches, with all installed git
safety and verification rules still active. Automated and manual sessions may
not share one workspace; detach the active mode first. Close manual UI with:

```bash
coord detach manual --product /path/to/app
```

Re-open Terminal views afterward with `coord N` (recreates tmux/agents and
missing windows) or `coord attach N` while the coordinator is already running.

By default uninstall clears the agent-clone hook wiring, the managed exclude block, the
launchers, and the clone's coordination git config, restores any hook that was
displaced at install time, and deletes the workspace **config file**. It removes
the managed `.gitignore` block and the generated `AGENTS.md` from the product
**only if the install recorded writing them**, and it never touches unrelated
ignore lines or a human-authored `AGENTS.md`. A hook file edited after
installation is left in place and reported rather than deleted.

The same conservative rule applies to CLI lifecycle hooks. Uninstall removes
only entries carrying coordination's lifecycle marker. Other Codex, Claude,
Cursor, and Antigravity hooks remain in their original arrays/objects. If the
owner replaces the managed Antigravity status-line command after installation,
uninstall leaves that new command and its recovery metadata in place rather
than guessing what to restore.

### The completion mailbox

Agents publish a completion marker to `complete`: either a pushed commit SHA
(Git-mode actions) or `response <actionId>` (ballot response-mode). That file
does not live under the runtime directory. It lives in a sibling tree so the harness
can be granted the single directory it must write without also being granted
`cursors.json`, the journal, or another agent's `action.md`:

```text
/path/to/completes/<coord-runtime-name>[/<project>]/issue-<n>/<agent>/complete
```

Ballot responses live under the issue runtime at
`issue-<n>/agents/<agent>/responses/<actionId>.json`. The launcher grants that
directory when it exists, in addition to the mailbox drop. It never grants the
issue root, peer paths, or the accepted-response archive.

`completesRoot` defaults to `<parent-of-coord-runtime>/completes/<coord-runtime-name>`
for a flat install, with the project appended for a nested one, and is created by
`coord install`. Those segments are what keep two products sharing an outer root
— or two outer roots sharing a parent — from resolving the same
`issue-42/claude/complete`. Pass `--completes-root <path>` to `coord install` or `coord onboard` when
neither derived location suits the layout; the resolved absolute value is
written to the workspace config. It must be outside the runtime directory and outside
every agent clone, or install refuses it.

Install also records a claim file at the mailbox root naming the workspace whose
receipts live there. A second workspace pointed at the same root is refused with
the path of the workspace that already owns it, because sharing one mailbox
means sharing `issue-<n>/<agent>/complete` — the last agent to write wins and
each coordinator reads the other product's SHA as its own agent's intent. A
claim whose workspace config no longer exists is stale and is taken over
silently, so uninstalling a product releases its mailbox.

Install records the resolved root in each clone as `coord.completesRoot`. The
generated `start-<agent>.sh` combines it with `coord.workspaceConfig` and
`COORD_ISSUE` at launch and passes up to two directories to the harness
(`--add-dir`): the mailbox drop and the agent's response directory. Nothing
issue-specific is written into the launcher, which is why `githooks/post-merge`
can still regenerate it. A harness started outside an automated issue gets no
grant and says so on stdout.

Five scoping rules matter:

- By default only the workspace config is deleted; an empty nested workspace
  directory may also be removed. Issue snapshots and run state stay unless
  `--wipe-runtime` is explicit.
- `--wipe-runtime` removes this product's issue state and, when no other
  workspace still uses the outer runtime directory, deletes that folder and the
  workspace's completion mailbox too (e.g. `./coord-runtime` and
  `./completes/coord-runtime`). If nested siblings share the root, wipe stays
  scoped to this product's targets and keeps the outer directory and every
  mailbox—even with `--force`.
  Without force, a shared flat runtime is still refused as an extra confirmation
  boundary.
- Owner tmux/Terminal teardown is limited to issue identities under this
  workspace plus its exact `coord-manual-<group>` identity. Manual cleanup runs
  even with no `issue-*` directories. Uninstall must not kill another product's
  numeric or manual sessions.
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

### Agent CLI lifecycle hooks

Git hooks enforce repository policy; CLI lifecycle hooks answer a different
question: whether an action was merely typed, accepted, queued, working, or
stopped. `coord install` adds a marked command entry to each agent clone's
local vendor configuration:

```text
<codex-clone>/.codex/hooks.json
<claude-clone>/.claude/settings.local.json
<cursor-clone>/.cursor/hooks.json
<antigravity-clone>/.agents/hooks.json
```

Existing documents and unrelated hook entries are merged, never replaced.
Invalid JSON and a third-party Antigravity hook already using coordination's
reserved name are refused. Reinstall repairs only marked entries; uninstall
removes only those entries. These clone-local directories are already excluded
from agent Git status and are never copied into a fresh human clone.

The commands pipe vendor JSON to the internal, fail-open `coord agent-event`
bridge. The callback validates the clone's `consensus.agentId` and
`coord.workspaceConfig`, the issue inherited from the tmux session, the runtime
roster, and the action path/UUID/digest before updating owner runtime. Hook
failures are diagnostic and do not block a prompt or prevent a CLI from
stopping.

Antigravity exposes `pending_input_count`, `agent_state`, and background task
count only through its user-global status line. Install therefore writes a
marked multiplexer under `~/.gemini/antigravity-cli/`: it forwards the payload
to `coord agent-event` asynchronously, then invokes the owner's previous
status-line command with the same payload and returns that command's display
output. With no previous command it prints a small `coord lifecycle` label.
The receiver routes the official payload's workspace `cwd` through clone-local
configuration; if the hook environment has no issue number, exactly one active
issue containing that agent may supply it, while an ambiguous match is ignored.
The previous setting is kept in coordinator-owned recovery metadata and
restored on uninstall only while the managed command is still selected.

Restart Codex/Claude after install if their current session predates the hook
file. Codex may also require reviewing the new project hook in `/hooks`.
`coord status` reports `degraded` when an injected action receives no lifecycle
observation, and the run loop prints the corresponding CLI-restart remedy on
normal output once per degradation; `coord doctor` reports missing or modified
static hook wiring. A custom agent id with nudge delivery is also a doctor
finding until it has a supported lifecycle-vendor mapping; use pull delivery
rather than promising hook-gated reinjection for an uninstrumented CLI.

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

### Product languages

The driver needs Node 26 and pnpm 11, but the product does not. Installation
uses `proposeProjectPolicy` in `src/setupWorkspace.ts` to propose the policy
below, in order: **first matching detector wins**. Review the generated config;
multi-language monorepos may need an explicit declaration instead.

| Marker | Toolchain | Precommit / prepush proposal | Finalization checks |
| --- | --- | --- | --- |
| `Cargo.toml` | `cargo` | `cargo check --all-targets` / `cargo test` | `cargo test` |
| `go.mod` | `go` | `go vet ./...` / `go test ./...` | `go build ./...`, `go test ./...` |
| `package.json` | `pnpm`, `yarn`, or `npm` (lockfile-selected) | first existing `check:fast`, `check`, `lint` / existing `test:e2e` | first existing `check`, `test` |
| recognized targets in `Makefile` | `make` | `make check` if present / none | `make test` if present |
| none of these | unspecified | no inference | no inference; supply `--declare` |

For Node, the entries name package scripts, not bare executables. A marker
alone does not guarantee usable checks: install refuses missing finalization
checks, and absent `verify` fails closed in agent hooks. Detection happens only
at install; hooks execute the recorded policy without inspecting language files.

Python works through an explicit declaration today; `pyproject.toml`, uv,
Poetry and Hatch are not auto-detected. Save this as `declaration.json` outside
the product's tracked tree, adjusting commands and critical paths to its layout:

```json
{
  "toolchain": "python",
  "verify": {
    "precommit": [{ "name": "lint", "argv": ["ruff", "check", "."] }],
    "prepush": [{ "name": "test", "argv": ["pytest", "-q"] }]
  },
  "checks": [{ "name": "test", "argv": ["pytest", "-q"] }],
  "workflowCriticalPrefixes": ["src/", "tests/"],
  "workflowCriticalFiles": ["pyproject.toml", "uv.lock"]
}
```

```sh
coord install --product /path/to/app --coord-runtime /path/to/coord-runtime \
  --agents codex --profile solo --declare /path/to/declaration.json
coord doctor --coord-runtime /path/to/coord-runtime --product /path/to/app
```

Use `install`, not `onboard`, for `--declare`. Install Ruff/pytest and expose
them on the PATH inherited by the agents and coordinator (including any virtual
environment); doctor reports a `toolchain` finding when an `argv[0]` cannot be
resolved. The same requirement applies to Go/Cargo and every declared tool.
Arguments are passed directly, not interpreted as shell syntax.

`config.product.example.json` illustrates a **full generated Go workspace
config**, not a file accepted by `--declare`: identity, agent roots and the
installation stamp are generated by install and are forbidden in declarations.
Reuse only its policy fields when writing a declaration. Its absolute example
paths are placeholders to replace, not shell variables or real install stamps.

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

### Scoping verification

```jsonc
"workflowCriticalPrefixes": ["cmd/", "internal/", "pkg/"],
"workflowCriticalFiles": ["go.mod", "go.sum"]
```

Critical paths always retain product checks, even if also listed as documentation.
Unknown paths and indeterminate diffs run product checks too: critical-path lists
are no longer an implicit exemption for every other path. To narrow prose/image
verification, explicitly declare exact repository-relative paths and commands:

```json
"documentation": {
  "paths": ["README.md", "docs/guide.md", "docs/diagram.png"],
  "verify": {
    "precommit": [{ "name": "docs", "argv": ["pnpm", "check:docs"] }],
    "prepush": [{ "name": "docs", "argv": ["pnpm", "check:docs"] }]
  },
  "checks": [
    { "name": "install", "argv": ["pnpm", "install", "--frozen-lockfile"] },
    { "name": "docs", "argv": ["pnpm", "check:docs"] }
  ]
}
```

No profile is inferred from `*.md`: executable templates such as
`templates/product/AGENTS.protocol.md` are product behavior, not prose.
The example config declares this repository's small `pnpm check:docs` profile,
which retains README/docs content and verification-instruction assertions without
running onboarding or the full suite. Review and install the declaration to opt
in; updating the example does not change an existing runtime's config.

The shared selector inspects only the staged index at commit time (unstaged edits
do not count), every actual outgoing ref range at push time, and the frozen issue
baseline through the approved product pin at finalization. Both rename paths are
included, and NUL-delimited paths preserve tabs/newlines. First pushes compare to
the merge base with the configured remote/base; missing history fails closed.
Deleting evidence in the last commit cannot hide earlier product changes.
Finalization uses the documentation profile and critical paths snapshotted at
issue start. Hooks, like their existing product `verify` commands, use the live
workspace declaration (outside coordinator verification mode, below). A mid-issue configuration change can therefore change
local checks without changing the frozen final gate; the shared classifier does
not imply a shared configuration snapshot.

Coordination-only changes under `.plans/`, `.signals/`, `.code-reviews/`,
`.amendments/`, and `.escalations/` launch no product suite. Identity, branch,
commit-message, no-rewrite, artifact, and pin gates remain intact. The same
classification applies on manual agent scratch branches. Mixed docs/product
changes use product checks; without a docs profile even a README uses them.

Agents validate evidence format rather than manually running a product suite to
publish a plan or review. Hooks own mandatory local checks; do not duplicate the
full hook command immediately before committing. Review unchanged implementations
using existing verification results, adding tests only to investigate findings.
Coordinator-owned final checks are not results an agent should claim to have run.
Response-mode ballots continue to avoid commits and pushes entirely.

### Coordinator verification mode

`verification` is an opt-in declaration. Absent, or `"mode": "local"`, keeps the
behavior above. `"mode": "coordinator"` moves the mandatory suites of automated
runs into coord (see `config.example.json`):

```jsonc
"verification": {
  "mode": "coordinator",
  "coordinated": { "precommit": [/* cheap checks */], "prepush": [] },
  "candidate": {
    "checks": [/* run at every implementation/revision pin */],
    "covers": { "prefixes": ["src/", "test/"], "files": [] },
    "rules": [
      { "prefixes": ["githooks/"], "add": ["test:e2e"] },
      { "files": ["package.json", "pnpm-lock.yaml"], "add": "all" }
    ]
  },
  "maxConcurrentExpensive": 1
}
```

- **Binding.** Hooks use `coordinated` only when the committed branch, or the
  single pushed branch, is this agent's `issue-<n>/<agent>` branch and that
  issue's `start.json` freezes coordinator mode for this clone, and the run is
  neither completed nor abandoned with the agent still on its active roster.
  Manual branches, multi-ref pushes, detached HEAD and missing, unreadable or
  mismatched runtime state all run the local `verify` lists and print why. An
  absent runtime never means "skip". Integrity gates are unchanged.
- **Candidate selection.** Coord classifies the frozen baseline through the
  submitted product pin with the shared classifier. Evidence-only changes run
  nothing; allowlisted documentation runs the docs checks. Product changes run
  `candidate.checks`, plus the final `checks` that matching rules name. A rule
  adding `"all"`, a path outside `covers` and every rule, an undecodable name,
  or missing history runs the full `checks`. Both rename paths count.
- **Names.** A check name identifies one command: a candidate check sharing a
  name with a final check must have the same `argv`, and rules may only add
  declared final checks.
- **Caching.** A command with `cache` may be satisfied by a coordinator receipt
  for equivalent inputs. `inputs: "tree"` keys on the pin's tree;
  `"tree-excluding-evidence"` ignores only coordination evidence paths and is
  appropriate only for commands that never read them. `probes` (argv run in the
  worktree, for example `["node", "--version"]`) and `env` (names whose value
  digests are keyed) declare toolchain and environment inputs; `dependencies`
  (worktree paths such as `node_modules/.pnpm`) declare untracked
  inputs, hashed when the command runs and re-checked afterwards. File bytes and
  link targets are hashed with the worktree's own path normalized out (package
  shims embed it); links are recorded, not followed, and must resolve inside the
  declared paths. Declare everything a command can execute or import (for pnpm,
  all of `node_modules`, including `.bin` shims and top-level links) and list
  tool state that changes on every install or run in `dependencyExcludes` (the
  example excludes `.modules.yaml`, `.pnpm-workspace-state-v1.json`, `.vite`
  and `.vite-temp`); otherwise leave the command uncached. Never cache a
  command that reads Git history, commit identity, external services or
  undeclared environment; setup commands such as `install` and `build` stay
  uncached so they always run.
- **Retries.** `retry` (0–2) re-runs a failed command for diagnosis only. The
  original failure remains the outcome.
- **Tracked files.** A command that leaves tracked files different from the pin
  fails the gate, even with exit 0, so every later command, receipt and result
  describes the pin's own bytes.
- **Expensive commands.** `expensive` commands share `maxConcurrentExpensive`
  slots across every issue runner in the workspace.

The policy and its digest are frozen into `start.json`, so changing the
declaration affects only issues started afterwards. Switch modes between
issues.

The unit suite (`test:fast`) excludes the filesystem/process suites now in
`test:system`. `pnpm check:fast` runs both, so existing local `verify` lists
that name it keep their full coverage; the example's coordinated pre-commit
list names `lint`, `typecheck` and `test:fast` directly to stay cheap while coord
owns the system suites.

## Workspace layouts and issue input

A fresh single-product runtime is flat:

```text
<coord-runtime>/
  config.json
  mirror.git/
  issue-42/
    github-issue.json
    start.json
    ...
```

If a different flat product already occupies that root, the next product uses
`<coord-runtime>/workspaces/<project>/`. Its config, mirror, issue directories,
and tmux namespace all stay inside that workspace, so the same issue number in
two repositories cannot collide. Flat resolution wins for a matching product;
existing nested installs remain supported by onboard/install, start, doctor,
and uninstall. The first flat product is never moved or overwritten merely
because a second product is added. Outer `issue-N` or `mirror.git` left by a
config-only flat uninstall also occupies the flat slot, so another product
cannot inherit the old control plane.

At every new start, coordination reads the requested issue with `gh issue view
--repo <owner/repo>` derived from the configured origin. The canonical
`github-issue.json` snapshot is mandatory digest material together with the
exact config bytes. `digestPaths` is only a list of optional additional,
config-relative inputs and may be empty. `contextPaths` is deliberately excluded
from digest material: those files are advisory reading named in every action,
not authority over a run, and folding them in would make correcting a stale
context note invalidate every artifact already published for the issue. The owner does **not** write a plan
before start. After launch, each agent creates `.plans/issue-<n>/plan.md` on its
own issue branch as R2 evidence. Coordination checks that clone out on
`issue-N/<agent>` at the issue baseline before JOIN (lifting skip-worktree on
`AGENTS.md` so the protocol overlay does not block the switch).

## Doctor

```bash
coord doctor --coord-runtime /path/to/coord-runtime --product /path/to/app
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
| 20 | `lifecycleHooks` | vendor lifecycle hooks are missing or differ from their managed definitions |

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
