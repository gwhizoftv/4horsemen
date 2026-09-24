# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## Vendor evidence and resource holds (#140)

The #126 pause/nudge safeguards remain authoritative. Matching accepted-action
Claude failures and Cursor diagnostics now enrich durable holds with separate
cause and deadline confidence, redacted bounded context, and all observed blocking
windows. Normal Stop, silence, generic 429s, token activity, or zero spend credits
are not proof of exhausted renewable capacity. Cancellation stays owner-only.
Hook failures without provable turn/action linkage remain advisory in the bounded
lifecycle cache; they cannot hold or release a possibly unrelated action.

Claude installation adds a clone-local statusline tee in
`.claude/settings.local.json` with an ownership manifest. It forwards the owner's
input bytes, output, errors and exit status without changing native auto-continue.
User/project/local command precedence is checked; detected managed settings,
unsupported command shapes and ownership drift disable telemetry rather than
replace owner configuration. Custom CLI `--settings` overrides are not a supported
telemetry configuration. Reinstall/uninstall preserves subsequent owner edits.
`coord doctor` reports modified or disabled installed integrations. There is no
new Antigravity classifier or change to its wrapper.

Only fresh correlated `five_hour`/`seven_day` Unix reset epochs can schedule a
Claude re-evaluation at deadline + 30 seconds. Re-rendered telemetry does not renew
its first-seen age. Clock strings, family limits, stale/absent windows, native Stop,
and native waiting do not prove fresh capacity: **Claude automatic release remains
disabled**, and no speculative continuation is sent.

An owner can opt into bounded Codex diagnostic queries by adding this optional
binding to the `codex` agent in the existing workspace configuration before
starting an issue:

```json
"codexQuota": { "codexHome": "/absolute/canonical/codex-home", "accountId": "expected-account-id" }
```

The owner confirms that this is the running agent's account/home and that it is
used by only this owner runtime. Sharing that binding across independent runtime
roots is unsupported: omit the binding until exclusive ownership is established.
The binding is copied into start state; the coordinator does not discover identity
from credentials, change the running agent's environment, or query its own default
account. Missing/changed/unsupported returned identity requires owner recovery.

Reads are one-shot initialized App Server `account/read` and
`account/rateLimits/read` calls triggered by a safety-hold episode or a pending
exact deadline, with at most one helper per binding, five-minute minimum spacing,
two failure retries (5 then 10 minutes), six starts per unresolved action, a
10-second total lifetime and 256 KiB combined output bound. Reservations and
cooldowns survive restart and action replacement; uncertain orphan processes
require owner intervention. Acknowledgment alone does not replenish the action's
probe budget. There is no periodic idle polling, subscription, model turn, login,
usage polling, or reset-credit consumption. Cross-issue exclusion uses existing
cursor state plus a binding-keyed lock, not a monitoring database.

**Live Codex automatic release also remains disabled until its version/auth/resource
combination is independently validated.** The bounded reader enriches owner holds;
the scoped clearance path is tested with sanitized injected results, not paid model
probes. During implementation Codex reported `0.156.1` and Claude `2.1.281`; local
App Server schema generation was filesystem-denied. Documentation and fake
fixtures are not live clearance proof. Partial buckets, unknown enum values,
missing windows, spend restrictions, or inconsistent compatibility views fail
closed. A quota result never clears a watchdog, native-ownership, manual, uncertain
delivery or nudge-loop hold, and never resets send counts or changes workflow pins.

Use the recovery command printed by `coord status`: `coord resume --issue N --hold ID`.
Only a nudge-loop hold permits `--reset-nudge-budget`. Deadlines promise a bounded
recheck, not availability. The older #126-only limitations in `docs/coord-driver.md`
describe the pre-enrichment baseline; this section describes #140 behavior.

Interfaces: [official OpenAI App Server documentation](https://learn.chatgpt.com/docs/app-server),
[Claude statusline](https://code.claude.com/docs/en/statusline),
[Claude failure hooks](https://code.claude.com/docs/en/hooks#stopfailure).

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
normal R2 evidence. Ballot steps use private response files; the coordinator
batches accepted responses onto `issue-N/coordinator-evidence` before deriving
the next decision. The product `-final` PR stays ballot-free.

## Owner-driven manual mode

For independent tasks assigned directly in agent chats, launch the installed
harnesses without creating a GitHub issue:

```sh
cd /path/to/onboarded/product
coord manual

# Later, close only this product's manual UI.
coord detach manual
```

`coord manual` resolves the registered workspace (or accepts `--product`, or
the explicit `--config` plus `--coord-root` pair), validates every configured
launcher, creates or repairs one tmux window per agent, opens only missing macOS
Terminal windows, and returns immediately. Repeating it reuses healthy panes,
respawns dead panes, and does not duplicate open Terminal clients. The manual
session and titles always use `coord-manual-<workspace-group>` so products are
isolated.

Manual mode does not read a GitHub issue, initialize a mirror, create an
`issue-*` runtime directory, write coordinator state or `action.md`, run the
state machine, nudge agents, perform consensus/finalization, publish a branch,
or open a PR. The owner's chat is the only task authority. Each agent uses its
own `<agent>/<name>` scratch branch unless the owner explicitly supplies an
issue branch; all installed hook, verification, commit-prefix, no-main, and
no-force rules remain active.

Manual and automated issue sessions are mutually exclusive for one workspace
because they share agent clones. Detach the active mode before starting the
other. `coord uninstall` also closes this workspace's exact manual tmux and
Terminal identities even when no issue runtime has ever existed.

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
