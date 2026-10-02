# Contributing

Human contributors can use an ordinary fork, topic branch and pull request into
`main`. Coordination's own multi-agent workflow is optional, not a prerequisite
for contributing. Keep changes focused on one issue and describe the behavior,
risks and verification in the PR. Maintainers review and merge; the driver does
not merge PRs automatically.

## Local development

Use Node 26, pnpm 11 and Git:

```sh
nvm use 26 # if you use nvm; otherwise select Node 26 with your usual tooling
pnpm install --frozen-lockfile
pnpm check:fast
pnpm check
```

Run `pnpm check:fast` before commits: lint, source/test typechecking and fast
tests. Run `pnpm check` for full acceptance: build, the fast suite and e2e.
Interactive product workflows also require tmux, authenticated `gh` access to
the product, the selected agent harnesses and product toolchains; see the
[requirements](README.md#requirements). No live agent accounts are needed for
the fixture-based tests.

Extend existing tests and fixtures before introducing new ones. Do not change
hooks or skip verification to make checks pass. Normal topic branches do not
need a version bump; the PR-into-main release workflow handles the pre-1.0
version advance. Keep `package.json` private: npm publishing is not part of
this contribution workflow.

## Humans and agents

[`AGENTS.md`](AGENTS.md) is the operating protocol for coordinated agents, not
the human contributor guide. Its agent branch names and commit prefixes apply
to those agents, not to ordinary contributors. An agent clone has additional
local wiring and hooks; a normal human clone of a product receives none of
those obligations. Never commit on another contributor's branch.

Keep generated builds, credentials, agent transcripts, runtime state and product
clones out of commits. Existing `.plans/` and `.code-reviews/` are historical
workflow evidence, not prerequisites for opening a normal PR. Review the staged
files before committing. Report security concerns privately as described in
[`SECURITY.md`](SECURITY.md), not in public issues or PRs.
