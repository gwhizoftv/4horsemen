# Agent workflow — coordination (workflow driver)

This repository implements the **coordination driver** only. It is separate from
the `testapp` app repo so hooks and tests stay decoupled.

- Design: `.plans/issue-1/workflow-algorithm.md`
- Plan: `.plans/issue-1/plan.md`
- GitHub issue **#1** on this repo (created by workspace scaffold)
- Owner-driven workflow; no `automation/` barriers.

Branches: `issue-<n>/<agent>`. Never commit on `main` or peer branches.
Run `pnpm check:fast` before commits. Runtime state lives outside all clones:
`/Volumes/4TB-SOURCE/REPOS/coord/coord-runtime` (`coord start --coord-root ...`).
