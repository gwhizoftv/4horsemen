<p align="center">
  <img src="docs/images/coord-banner.jpg" alt="Open Source LLM Coordinator — multi-agent workflow from GitHub issue through planning, review, implementation, verification, and pull request" width="100%">
</p>

# coord

*Multi-agent consensus engine and workflow driver for autonomous software development.*

![Claude Code](https://img.shields.io/badge/Claude_Code-supported-1f6feb?style=flat-square)
![Codex](https://img.shields.io/badge/Codex-supported-1f6feb?style=flat-square)
![Cursor](https://img.shields.io/badge/Cursor-supported-1f6feb?style=flat-square)
![Antigravity](https://img.shields.io/badge/Antigravity-supported-1f6feb?style=flat-square)
![License: MIT](https://img.shields.io/badge/License-MIT-green?style=flat-square)

Instead of trusting a single AI model with your codebase, `coord` coordinates a
team of diverse coding agents across isolated Git clones. They plan, peer-review,
implement, and ballot on a GitHub issue; the driver mechanically verifies the
exact pushed commits and opens a pull request for the owner. It is the
standalone owner-side workflow driver for that loop—not a merge bot by default.

## How it works

<p align="center">
  <img src="docs/images/coord-workflow.jpg" alt="Consensus workflow: GitHub issue to isolated agent clones, independent planning, plan review and voting, implementation, peer code review with up to three revision rounds, toolchain checks, then pull request" width="100%">
</p>

1. **Issue snapshot** — `coord N` reads GitHub issue N, binds the title/body and
   workspace config into the run, and launches the configured agents.
2. **Independent plans** — each active agent publishes `.plans/issue-N/plan.md`
   on its own `issue-N/<agent>` branch.
3. **Plan review and ballot** — peers review plans; the coordinator tallies
   private ballots and selects a winning design.
4. **Implementation** — under the default `consensus` profile, every active
   agent implements the selected plan in its own clone (not a single selected
   implementer). Under `reviewed`, one designated implementer continues.
5. **Peer code review and revision** — agents compare implementations, ballot,
   and authorize one reviser for up to three revision rounds.
6. **Finalization checks** — configured toolchain checks run on a clean
   detached worktree at the cleanup pin; any failure blocks the PR.
7. **Pull request** — the driver publishes a ballot-free final branch and opens
   a PR. Default `coord-open-unmerged` leaves a draft for the owner;
   `coord-merged` marks it ready and merges.

Onboarding defaults to `consensus` with Claude Code, Codex, Cursor, and
Antigravity. Profiles also include `solo` and `reviewed`; see
[Profiles](docs/coord-driver.md#profiles).

## Why coord

- **Two-tier peer review** — agents review both high-level plans and concrete
  code diffs before work is finalized.
- **Multi-agent consensus** — Claude, Codex, Cursor, and Antigravity propose and
  ballot independently instead of trusting one model.
- **Product tree untouched** — onboard leaves the human product's tracked files
  unchanged; agents work in sibling clones, and runtime state lives outside
  every clone.
- **Mechanical verification** — the driver verifies the exact pushed commit and
  runs your project's configured checks before opening the PR.
- **Owner control plane** — live status, pause/resume, steering, hold recovery,
  and detach without handing the merge button to the agents by default.

## Requirements

- Node 26 and pnpm 11 to run coordination (independent of the product language)
- Git
- GitHub CLI (`gh`), authenticated for product issue/PR operations
- tmux for interactive agent launch and delivery
- The configured agent harnesses (Claude Code, Codex, Cursor, and/or Antigravity)
- The product's declared tools (for example Go, Cargo, or Python test tools)

## Quick start

1. **Install** (once per machine):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
   # Add ~/.local/bin to PATH if the script prints that hint.
   ```

2. **Onboard** a product (defaults: all four agents, `consensus` profile):

   ```sh
   coord onboard /path/to/app
   # Smaller setup:
   # coord onboard /path/to/app --agents codex --profile solo
   ```

3. **Run** an issue from the product directory:

   ```sh
   cd /path/to/app
   gh issue create --title "Describe the work" --body "Acceptance criteria…"
   coord 42
   ```

Inspect-first and private-fork install options are in
[Bootstrap once](docs/setup-workspace.md#bootstrap-once). For owner-driven work
without a GitHub issue, see
[Owner-driven manual lifecycle](docs/coord-driver.md#owner-driven-manual-lifecycle)
(`coord manual` / `coord detach manual`). Explicit `coord install`, `start`, and
`run` forms remain in the
[Advanced install](docs/setup-workspace.md#advanced-install) and
[Starting and running](docs/coord-driver.md#starting-and-running) guides.

## Supported languages

| Marker | Detection |
| --- | --- |
| Go (`go.mod`) | Auto-detected |
| Rust (`Cargo.toml`) | Auto-detected |
| Node (`pnpm` / `yarn` / `npm`) | Auto-detected |
| Make (`Makefile`) | Auto-detected (recognized targets) |
| Python | Explicit declaration via `coord install --declare` |

Detection proposes recorded checks; a marker does not guarantee a runnable
policy until those tools exist on the agent machine. Details:
[Product languages](docs/setup-workspace.md#product-languages).

## Platforms

The owner UI opens Terminal.app windows on macOS. Other platforms use tmux
without that Terminal integration. Native Windows operation is not promised.

## Documentation

- [Operator & driver guide](docs/coord-driver.md) — profiles, tmux, holds,
  recovery, runtime topology, vendor quota evidence
- [Workspace setup](docs/setup-workspace.md) — bootstrap, onboard, multi-product
  layouts, language declarations
- [Readiness policy](docs/readiness-policy.md)
- [Analytics](docs/analytics.md)
- [Repository map](docs/repo-map.md)
- [Contributing](CONTRIBUTING.md) — human contribution workflow
- [Security policy](SECURITY.md) — private vulnerability reporting

## Development

```sh
nvm use 26
pnpm install --frozen-lockfile
pnpm check:fast   # lint, typecheck, focused tests
pnpm check        # build + check:fast + e2e
./coord --help
```

## License

MIT — see [LICENSE](LICENSE). Distribution is through GitHub; the package is
not published to npm.
