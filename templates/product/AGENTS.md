# Agent workflow — {{PROJECT}}

Written once by `coord install --write-product`. It is opt-in: by default
coordination adds no tracked file to this repository, and a developer who
clones it normally has no coordination hooks, no Node requirement, and no new
git obligations. This file describes the rules that apply to **agent clones**
(`{{PROJECT}}-<agent>`) driven by the owner's coordination runtime.

## Modes of operation

- **Automated issue mode** (`coord <issue>`): The coordinator drives the workflow.
  Agents read actions from `action.md`, publish coordinator artifacts, and work
  on `issue-<n>/<agent>`.
- **Manual mode** (`coord manual`): The owner tasks agents directly in chat.
  No `action.md` is emitted and no coordinator state machine runs. Agents work
  on their own scratch branches (`<agent>/<name>`) unless the owner explicitly
  directs otherwise.

## Branch scheme

- `{{BASE_BRANCH}}` — shared truth. Agents never commit or push to it.
- `issue-<n>/<agent>` — an agent's working branch for automated issue n.
- `<agent>/<name>` — an agent's scratch branch for manual owner tasks.
- `issue-<n>/final` — the consensus branch, updated only by merging a reviewed
  pull request.

## Rules enforced in agent clones

- Commit only on branches carrying your own agent name.
- Commit messages start with your agent label, e.g. `Claude: fix login redirect`.
- No `--no-verify`, no force-push, no editing `core.hooksPath` to get around a
  hook. If a hook blocks you, fix the state it names.
- Do not clear `skip-worktree` on `AGENTS.md` or strip its protocol block to
  “fix” git status; coordination sets that bit on purpose. Escalate if the
  file looks wrong.

## Verification

Coordination adds no tests to this repository. It runs whatever this project
declares, as argument vectors, in the owner's workspace config:

- `verify.precommit` / `verify.prepush` — run in the agent's clone by its hooks.
- `checks` — run by the coordinator in a throwaway worktree at the exact
  approved commit, and they gate pull-request creation.

Toolchain: `{{TOOLCHAIN}}`.

## Transient evidence

While an automated issue is in flight, agent branches carry `.plans/issue-<n>/`,
`.signals/issue-<n>/`, and `.code-reviews/issue-<n>/`. They are the protocol's
evidence. R7 finalization is deletion-only cleanup of exactly those paths, so a
merge-ready pull request contains none of them and `{{BASE_BRANCH}}` never does.
Manual tasks do not fabricate coordinator artifacts.
