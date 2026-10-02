# Contributing

Thanks for helping improve coordination.

## Set up

```sh
nvm use 26                       # Node 26; see .nvmrc
pnpm install --frozen-lockfile   # pnpm 11
```

## Before every commit

```sh
pnpm check:fast   # lint, source/test typecheck, fast tests
```

`pnpm check` (build, `check:fast`, and the end-to-end canary) is the full
acceptance run. Run it before asking for review.

## Pull requests

- Fork the repository, work on a topic branch, and open a pull request into
  `main`. Do not commit directly on `main`.
- Keep a change to one concern and add the fewest focused tests that prove it.
  Prefer extending an existing file under `test/`.
- Do not bump `package.json`'s version. The maintainer advances the `0.0.N`
  version when merging into `main`.
- Do not change `githooks/` to make a check pass.

## `AGENTS.md` is not for you

`AGENTS.md` is the operating protocol for AI agents that coordination drives.
It defines agent branch names, artifacts, and coordinator actions. Human
contributors follow this file instead. You do not need to run coordination's
multi-agent loop to contribute.

## Security

Report vulnerabilities privately as described in [`SECURITY.md`](SECURITY.md),
never in a public issue.
