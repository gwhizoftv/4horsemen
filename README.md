# coordination

`coordination` is the standalone owner-side workflow driver. It gives each
agent one concrete action, verifies the exact pushed commit named by the agent,
and advances only when the required origin-backed evidence passes. It never
merges a pull request.

## Happy path

Install coordination once, onboard each product once, and then drive work from
GitHub issues. Install Node 26, pnpm 11 and Git first. The public install path
needs no GitHub CLI authentication to coordination:

```sh
# Once per machine, once the upstream repository is publicly accessible.
curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
# Add ~/.local/bin to PATH if the script prints that hint.

# Once per product (example: one installed Codex harness).
# Authenticate gh for your product repository before issue/PR operations.
coord onboard /path/to/app --agents codex --profile solo

# Each unit of work.
cd /path/to/app
gh issue create --title "Describe the work" --body "Acceptance criteria…"
coord 42
```

Bootstrap installs a complete checkout under `~/.local/share/coordination` and
links `~/.local/bin/coord`. To inspect the script before running it instead:

```sh
git clone https://github.com/gwhizoftv/coordination.git coordination-src
# Review coordination-src/scripts/bootstrap.sh first.
sh coordination-src/scripts/bootstrap.sh --source "$PWD/coordination-src"
```

`--source` (or `COORD_SOURCE`) accepts a Git URL or local clone. For a private
fork, authenticate Git, clone it, then pass `--source <local-clone>`.
Anonymous clone/raw access requires a public upstream; these preparation docs
do not mean that the release gates in [issue #139](https://github.com/gwhizoftv/coordination/issues/139)
have passed. Before publication the owner must audit content/history, verify
private security reporting, and neutralize the tracked machine-specific runtime
instruction in `AGENTS.md` from an owner checkout (not an agent's protected
overlay). After the authorized visibility change, verify the anonymous cold
install and sample-product doctor run before announcing the release.

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

- Node 26 and pnpm 11 to run coordination, regardless of the product language
- Git for bootstrap and product repositories
- GitHub CLI (`gh`), authenticated for product issue/PR operations, not for
  installing coordination from a public URL
- tmux for interactive agent launch and delivery
- the configured agent harnesses (Claude, Codex, Cursor, or Antigravity)
- the product's declared tools (for example Go, Cargo, or Python test tools)

The owner UI opens Terminal.app windows on macOS. Other platforms use tmux
without that Terminal integration; native Windows operation is not promised.
Install every harness selected by your configuration, or select only one as in
the example above; the unqualified onboarding default selects all four.

Bootstrap accepts `--root`, `COORD_INSTALL_ROOT`, and `--no-path`. It clones or
cleanly fast-forwards a complete install checkout, performs the locked build,
and refuses dirty or unrelated paths rather than resetting them.

## Product languages

Go (`go.mod`) and Rust (`Cargo.toml`) verification policies are proposed
automatically, as are Node (pnpm/yarn/npm) scripts and recognized Makefile
targets. **Python has no auto-detection yet**: use `coord install --declare`
with explicit checks. Any language works when its verification commands can be
expressed as argument arrays and its tools are installed on the agent machine.
Node/pnpm run the driver; they do not have to be the product's toolchain.

See [Product languages](docs/setup-workspace.md#product-languages) for detection
precedence, Go/Rust commands and a complete Python declaration. Agent coding
quality is independent of coordination's command execution and evidence gates.

## License

MIT is the planned license, but the owner has deferred adding `LICENSE` to a
follow-up. Licensing and public release remain incomplete until that file lands.
See [CONTRIBUTING.md](CONTRIBUTING.md) for human contribution guidance and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. Distribution
remains through GitHub; the package is not published to npm.

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

## Vendor quota evidence and resource holds

Holds carry vendor evidence when it is available. They report the failure
class (usage window, billing, throttling, context overflow, account,
cancellation, transport or unknown) separately from deadline confidence. A
reset time is shown only when the provider supplied an absolute epoch, and it
is the time of a recheck, not a promise that capacity will be back. Rendered
clock text such as "resets 3:45pm" is never parsed.

- **Claude.** `StopFailure` fields are kept as sanitized diagnostics
  (`error`, `error_details`, `last_assistant_message`). `coord install` adds a
  status-line tee to the clone's `.claude/settings.local.json`. The tee runs
  your effective status-line command on the original bytes and gives coord a
  bounded copy of `rate_limits.five_hour`/`seven_day`. It is installed only
  when precedence is provable. If managed settings or a launcher `--settings`
  outrank the clone, or the command shape is unsupported, telemetry is
  disabled and `coord doctor` says why. Uninstall restores the prior value
  while the tee is still coord's, and your later edits are preserved. A
  matching exhausted window gives an exact deadline. At that deadline plus 30
  seconds, coord re-evaluates the hold once without sending a prompt. It then
  leaves release to you, because a render is not a fresh capacity check.
  Model-family limits, stale telemetry and spend restrictions keep
  `reset unknown`. `autoContinueAtUsageLimit` and launcher arguments are never
  changed.
- **Codex.** Quota reads happen only with an explicit per-agent binding:
  `"codexQuota": { "codexHome": "/abs/path", "accountId": "..." }` on the
  `codex` agent. Each read is one `codex app-server --listen stdio://` helper
  that runs `account/read` and `account/rateLimits/read` and nothing else. It
  has a 10 s lifetime and a 256 KiB output cap, and it is always reaped.
  Reads are triggered only by the initial binding check, by a new hold for
  that agent, or by an exact deadline plus 30 seconds. Limits:
  - at most one helper runs per binding, across issues in this coord root;
  - starts are at least 5 minutes apart;
  - after a failed read there are two retries (at +5 then +10 minutes);
  - each action gets six starts in total, and neither restarts nor your
    acknowledgments replenish them.
  Automatic release is off unless the binding names the Codex CLI version you
  validated live: `"validatedVersion": "0.156.1"`. Even then, it needs a
  fresh read in which every bucket explicitly reports no restriction and every
  previously blocked window is back below its limit with the same duration.
  The helper must report that version and the bound home, and the account must
  be unchanged across the read. It removes only that resource hold. Without a
  validated version, quota reads only enrich the hold and you release it. A binding shared by two separately managed coord roots
  cannot be serialized and is unsupported.
- **Cursor** errors stay unknown and `aborted` is a cancellation. **Antigravity**
  keeps the vendor-independent protections only.

Manual pause, other holds, the nudge budget, roster, reviews and pins are never
changed by resource recovery. Whenever evidence is missing, the report says
`owner release required`.

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
