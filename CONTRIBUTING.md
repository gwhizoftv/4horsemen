# Contributing

Thanks for helping improve coordination. This file is for human contributors.
`AGENTS.md` is the agent operating protocol used when coordination drives
multi-agent work on a product; you do not need to run that loop to contribute
here.

## Prerequisites

- Node 26 (see `.nvmrc`; `nvm use 26` if you use nvm)
- pnpm 11 (see `packageManager` in `package.json`)
- Git

## Setup

```sh
nvm use 26
pnpm install --frozen-lockfile
```

## Checks

- Before every commit: `pnpm check:fast` (lint, typecheck, fast tests)
- Full acceptance before opening or updating a PR: `pnpm check`
  (build + check:fast + e2e)

## Pull requests

1. Fork the repository (or use a collaborator clone).
2. Create a topic branch off `main`.
3. Keep the change focused; add or extend tests when behavior changes.
4. Do not bump `package.json` `version` on ordinary branches — CI advances the
   pre-1.0 `0.0.N` on merge to `main`.
5. Open a PR into `main`.

Maintainers review and merge. You do not need to run coordination’s multi-agent
protocol against this repository unless a maintainer asks you to.
