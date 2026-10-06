<p align="center">
  <img src="docs/images/coord-banner.jpg" alt="coord banner: four AI coding agents connected around a shared code editor — Open Source LLM Coordinator, collaborative, automated AI code generation" width="100%">
</p>

# coord

**Multi-agent consensus engine and workflow driver for autonomous software development.**

![Claude Code](https://img.shields.io/badge/agent-Claude%20Code-6b4fbb)
![Codex](https://img.shields.io/badge/agent-Codex-2f6feb)
![Cursor](https://img.shields.io/badge/agent-Cursor-1f2937)
![Antigravity](https://img.shields.io/badge/agent-Antigravity-0e8a6b)
![License: MIT](https://img.shields.io/badge/license-MIT-green)

Instead of trusting a single AI model with your codebase, `coord` turns a GitHub
issue into a team effort. It gives each coding agent (Claude Code, Codex,
Cursor, Antigravity) its own Git clone. The agents plan, review each other's
plans, implement, review each other's code, and ballot on the result. `coord`
mechanically verifies the exact commit every agent pushes, runs your project's
own checks on a clean worktree, and only then opens a pull request for you.

## How it works

<p align="center">
  <img src="docs/images/coord-workflow.jpg" alt="Workflow: a GitHub issue starts isolated agent clones; agents plan, review and ballot on plans, implement, peer-review code with up to three revision rounds, pass mechanical verification checks, and produce a pull request" width="100%">
</p>

1. **Start from an issue.** `coord 42` snapshots GitHub issue #42 and launches
   each configured agent in its own clone on its own `issue-42/<agent>` branch.
2. **Independent planning.** Every agent writes its own
   `.plans/issue-42/plan.md`.
3. **Plan review and ballot.** Agents review each other's plans and vote; the
   winning plan, with its exact file map, becomes the contract.
4. **Implementation.** The selected plan is implemented and pinned to an exact
   pushed commit.
5. **Peer code review.** Agents compare and review implementations, ballot, and
   one reviser addresses findings in up to three revision rounds.
6. **Verification.** The accepted commit is checked out into a clean detached
   worktree and every configured check (for example `go test`, `cargo test`,
   `pnpm check`) must pass. Any failure blocks the pull request.
7. **Pull request.** `coord` pushes a clean final branch and opens a PR. By
   default the PR is left as a draft for you to merge; a `coord-merged` policy
   merges it instead.

How many agents take part depends on the profile: `solo` (one agent),
`reviewed` (all agents select the plan, one implements), or `consensus` (every
agent plans, implements, reviews and ballots — the onboarding default). See
[Profiles](docs/coord-driver.md#profiles).

## Why coord

- **Two-tier peer review.** Agents review both the design plan and the
  concrete code before anything is accepted.
- **Multi-agent consensus.** Different models challenge and ballot on each
  other's work instead of one model grading itself.
- **Your product tree stays untouched.** Onboarding leaves the product's
  tracked files byte-for-byte unchanged. Agents work in their own sibling
  clones, and runtime state lives outside every clone.
- **Mechanical verification.** An agent's claim of completion counts only
  when the exact pushed commit passes the coordinator's checks and your
  project's own toolchain.
- **Owner control plane.** Live status, pause and resume, advisory steering,
  safety holds only you release, and `coord detach` teardown.

## Requirements

- Node 26 and pnpm 11 to run `coord`, whatever your product's language
- Git
- GitHub CLI (`gh`), authenticated for your product's issue and PR operations
- tmux for agent windows
- the agent harnesses you select (Claude Code, Codex, Cursor, Antigravity)
- your product's own toolchain (for example Go, Cargo, or Python test tools)

macOS gets Terminal.app window integration; other platforms use tmux alone.
Native Windows is not supported.

## Quick start

1. **Install** (once per machine):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/gwhizoftv/coordination/main/scripts/bootstrap.sh | sh
   ```

   Add `~/.local/bin` to `PATH` if the script prints that hint. To review the
   script first, or install from a fork, see
   [Bootstrap once](docs/setup-workspace.md#bootstrap-once).

2. **Onboard** your product (once per repository):

   ```sh
   coord onboard /path/to/app
   ```

   This selects all four agents and the `consensus` profile, detects your
   toolchain, and runs `coord doctor`. To start with one agent instead:
   `coord onboard /path/to/app --agents codex --profile solo`.

3. **Run** an issue:

   ```sh
   cd /path/to/app
   gh issue create --title "Describe the work" --body "Acceptance criteria…"
   coord 42   # the issue number
   ```

To give agents tasks directly in chat without an issue, use `coord manual`
([manual lifecycle](docs/coord-driver.md#owner-driven-manual-lifecycle)).
For custom policies and explicit `coord install` / `coord start` / `coord run`
forms, see [Advanced install](docs/setup-workspace.md#advanced-install) and
[Starting and running](docs/coord-driver.md#starting-and-running).

## Product languages

| Language | Detected from | Support |
|---|---|---|
| Go | `go.mod` | Auto-detected |
| Rust | `Cargo.toml` | Auto-detected |
| Node | `package.json` (pnpm, yarn, npm) | Auto-detected |
| Make | `Makefile` targets | Auto-detected |
| Python | — | Declare checks with `coord install --declare` |

Any language works when its checks can be expressed as commands and its tools
are installed. See [Product languages](docs/setup-workspace.md#product-languages)
for detection rules and a complete Python declaration.

## Documentation

- [Operator and driver guide](docs/coord-driver.md): profiles, owner
  controls, holds and recovery, tmux, finalization, runtime topology
- [Workspace setup guide](docs/setup-workspace.md): bootstrap, onboarding,
  advanced install, hooks, doctor, multi-product layouts
- [Readiness policy](docs/readiness-policy.md): which agent signal wins
  (terminal, hooks, workflow) and every refusal reason code
- [Analytics](docs/analytics.md): what run speed and token use can be measured
- [Repository map](docs/repo-map.md): where the code lives
- [Contributing](CONTRIBUTING.md): human contribution workflow
- [Security policy](SECURITY.md): private vulnerability reporting

## Development

```sh
nvm use 26
pnpm install --frozen-lockfile
pnpm check:fast   # lint, typecheck, fast tests
pnpm check        # build + check:fast + four-agent e2e canary
./coord --help
```

## License

MIT — see [LICENSE](LICENSE). `coord` is distributed through GitHub, not npm.
