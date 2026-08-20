# Issue 76 implementation plan — Cursor

## Scope and baseline

Implement [issue #76](https://github.com/gwhizoftv/coordination/issues/76),
“Manual coordination of agent supported,” from `origin/main` at
`f71a3f70961373a8cadfc2e601c9062b242bc4d2`.

Add an owner-driven launch path where installed agent harnesses stay open and
the owner tasks each agent directly in chat. The coordinator state machine must
not run, and no GitHub issue or `action.md` is required.

Daily command:

```sh
cd <onboarded-product>
coord manual
```

Manual mode is deliberately a **launch/attach lifecycle**, not a second
workflow profile. No schema, issue-runtime, evidence, state-machine, or
hook-policy change is in scope.

## Binding design decisions

### 1. Separate command, not a special issue number

`coord <issue>` / `coord start <issue>` stay issue-only. Manual mode is a new
top-level command `coord manual` (and teardown `coord detach manual`) that
resolves the onboarded workspace the same way as `coord N` (`--product`, or
`--config` + `--coord-root`), then launches/repairs owner UI and returns.

### 2. Workspace-scoped session identity

Manual tmux/Terminal identity is `coord-manual-<workspace-group>` (using the
existing `terminalGroup` fingerprint). Numeric issue naming
(`coord-<n>` / `coord-<n>-<group>`) stays unchanged. Repeated `coord manual` is
idempotent: reuse healthy panes, respawn dead panes, reopen only missing
Terminal windows.

### 3. No coordinator artifacts

This path must not fetch a GitHub issue, initialize the mirror, create
`issue-*` runtime directories, write `github-issue.json`, `start.json`,
`cursors.json`, `journal.jsonl`, `action.md`, or `complete`, invoke the run
loop, nudge agents, run consensus/finalization checks, or open a PR. Owner chat
is the only task source; publication remains an owner action.

### 4. Mutual exclusion with automated sessions

Manual and automated sessions must not run concurrently against the same
workspace (same agent clones). Startup of either mode fails clearly until the
other mode is detached for that workspace.

### 5. Instructions scoped by mode; hooks unchanged

Automated issue/action/evidence protocol applies only when an issue action
exists. In manual mode agents follow the owner's chat and use agent-owned
scratch branches (`<agent>/<name>`) unless the owner explicitly supplies an
issue branch. Identity, hook, verification, no-force, and no-main-commit rules
remain in force. Installed Git hooks are not disabled or weakened.

## Exact File List to be changed or deleted

### Command and owner-UI lifecycle

- `src/cli.ts` — add help/argument handling for `coord manual` and
  `coord detach manual`; resolve the workspace without an issue; launch/repair
  the manual agent UI; enforce manual-vs-automated session exclusion; bypass
  GitHub, runtime initialization, and the run loop.
- `src/tmux.ts` — generalize session/window/title helpers to support the
  workspace-scoped `manual` session key; preserve existing numeric issue names;
  make repeat manual launch reuse/repair panes and open only missing clients.
- `src/detachIssue.ts` — add exact manual-session/title teardown and include the
  workspace-scoped manual UI in bulk uninstall cleanup without reintroducing
  global unscoped tmux discovery.
- `src/install.ts` — advertise both issue-driven and manual next steps after
  install/onboard and ensure uninstall reports the manual UI teardown.

### Agent instructions and generated launch text

- `AGENTS.md` — scope the issue/action/evidence protocol to automated mode and
  document owner-chat manual mode plus agent-owned scratch branches.
- `templates/product/AGENTS.md` — add the manual-mode/scratch-branch contract to
  newly written product guidance.
- `templates/product/AGENTS.protocol.md` — state that `action.md` formats and
  coordinator artifacts apply only to automated issue actions; manual chat
  tasks do not fabricate coordinator evidence.
- `scripts/lib/launcher.sh` — make the generated startup banner describe both
  `coord next --issue <n>` and owner-driven manual operation.
- `scripts/setup_claude.sh` — Claude identity/session checklist accepts either
  an issue number or an owner-provided manual task.
- `scripts/setup_codex.sh` — Codex global identity block is manual-aware.
- `scripts/setup_cursor.sh` — Cursor rule is manual-aware.
- `scripts/setup_antigravity.sh` — Antigravity identity is manual-aware.

### Documentation and release metadata

- `README.md` — document `coord manual`, issue-free behavior, scratch branch
  convention, non-concurrency rule, and teardown.
- `docs/coord-driver.md` — document manual-mode authority, lifecycle, naming,
  exclusions, recovery, and absence of coordinator artifacts/publication.
- `docs/setup-workspace.md` — document manual use after onboarding and uninstall
  cleanup/isolation.
- `package.json` — bump pre-1.0 ship version from `0.0.11` to `0.0.12`.
- `config.product.example.json` — keep the example install stamp version aligned
  with the package version (`0.0.12`).

### Tests

- `test/cli.test.ts` — product/explicit resolution; no issue/GitHub/runtime or
  run-loop effects; idempotent launch; mode-conflict errors; `detach manual`;
  help text; version assertion.
- `test/tmux.test.ts` — workspace-isolated manual names/titles;
  create/reuse/respawn; missing-window reopen; unchanged numeric issue naming.
- `test/detachIssue.test.ts` — close-before-kill; exact manual workspace
  scoping; no cross-product kills; dry run; uninstall cleanup with no issue
  directories.
- `test/install.test.ts` — version/template/launcher expectations; generated
  instructions preserve hook rules while allowing manual scratch work.
- `test/onboard.test.ts` — onboarding output advertises `coord manual` from the
  registered product worktree.

### Intentionally unchanged (do not edit for this issue)

- `src/runLoop.ts`, `src/state.ts`, `src/action.ts`, `src/evidence.ts`,
  `src/finalization.ts` — manual mode must not enter or extend the automated
  workflow.
- `githooks/**` and `src/hookPolicy.ts` — existing agent-owned scratch branches
  and safety/verification gates are already the correct policy.
- `src/githubIssue.ts` and `src/mirror.ts` — manual mode bypasses them rather
  than adding optional/no-issue states.

### Files to delete

None.

## Exact file list to be created

None. Manual mode extends existing CLI/tmux/detach/install surfaces and
instruction templates; it does not add a second workflow profile module or
runtime schema.

## Tests

### Automated

| Area | Assertions |
| --- | --- |
| CLI `coord manual` | Resolves via onboarded product cwd, `--product`, or `--config`+`--coord-root`; validates configured launchers; does not call GitHub fetch, mirror init, issue runtime writers, or the run loop; returns after UI launch/repair. |
| Idempotency | Second `coord manual` reuses healthy panes, respawns dead panes, opens only missing Terminal titles. |
| Mode conflict | Starting `coord manual` while this workspace has an automated issue UI fails clearly; starting `coord N` while manual UI is up fails clearly until `coord detach manual` / `coord detach <n>`. |
| `coord detach manual` | Closes only this workspace's manual Terminal titles, then kills only this workspace's manual tmux sessions; dry-run reports without side effects. |
| Uninstall | With no `issue-*` dirs, uninstall still tears down workspace-scoped manual UI and does not kill other products' sessions. |
| tmux naming | Manual session/title uses `coord-manual-<group>`; numeric `coord-<n>[-<group>]` naming unchanged. |
| Instructions | Generated AGENTS/setup/launcher text distinguish automated vs manual; hook/no-main/no-force rules remain; no fabricated coordinator evidence in manual mode. |
| Version | `package.json` / example stamp at `0.0.12`. |

Commands:

- `pnpm check:fast` before commits on `issue-76/cursor`
- `pnpm check` for coordinator acceptance (build + check:fast + e2e)

### Manual smoke

From an onboarded product: `coord manual`, type independent tasks into the
opened agent windows, run `coord manual` again (no duplicate windows), then
`coord detach manual` and confirm only that workspace's manual UI is removed.

## Alternatives Rejected

- **Reuse `coord <issue>` / `coord start` with a sentinel issue.** Rejected:
  startup always fetches/snapshots a GitHub issue, creates `issue-*` runtime
  state, writes `action.md`, and enters the run loop. Manual mode must not
  touch that path.
- **Disable or weaken Git hooks for manual work.** Rejected: hooks already allow
  agent scratch branches (`<agent>/<name>`) while blocking `main`, peer
  branches, bad prefixes, force pushes, and failed declared checks.
- **Add a second workflow profile / schema / runtime state for manual mode.**
  Rejected: owner chat is the task source; inventing `action.md`/`complete`
  evidence would confuse agents and reviewers. Manual mode is launch-only.
- **Global or unscoped tmux discovery for teardown.** Rejected: would kill other
  products' sessions. Teardown must stay exact to `coord-manual-<workspace-group>`
  (and existing issue group scoping).
- **Allow concurrent manual and automated sessions on the same workspace.**
  Rejected: both share agent clones and would race working trees. Fail closed
  with a clear detach hint.
- **Change `runLoop` / evidence / finalization / GitHub modules to accept
  optional no-issue states.** Rejected: bypass is safer and keeps automated
  invariants intact.

## Risks and Mitigations

- **Session name collision across products.** Always embed `terminalGroup` in
  manual session and Terminal titles; tests assert cross-product isolation.
- **Numeric API drift when generalizing tmux helpers.** Keep issue paths
  behavior-identical; add manual-key helpers or a discriminated session key
  without changing `coord-N` string forms; cover both in `test/tmux.test.ts`.
- **Mode-conflict false positives/negatives.** Detect only this workspace's
  manual vs issue UI (exact names/titles), not bare agent names or other
  products; unit-test conflict and non-conflict cases.
- **Instruction templates still require an issue number.** Update AGENTS,
  protocol template, launcher banner, and all four setup scripts together so
  generated text explicitly branches on automated vs manual.
- **Uninstall misses manual UI when no issue dirs exist.** Include manual
  teardown in `detachAllOwnerUi` / uninstall regardless of `issue-*` presence;
  regression in `test/detachIssue.test.ts` and install uninstall coverage.
- **Agents invent coordinator artifacts in manual chat.** Protocol/docs state
  that `action.md`/join/plan evidence formats apply only when an issue action
  exists; manual tasks use owner chat + scratch branches only.

## Conclusion

Ship `coord manual` / `coord detach manual` as a workspace-scoped launch and
teardown path that opens agent harnesses without GitHub, runtime state, or the
coordinator loop. Preserve hook policy and numeric issue UI naming; enforce
mutual exclusion with automated sessions; scope agent instructions so automated
evidence formats do not apply to owner-chat work. No new files are required—
extend CLI, tmux, detach, install, docs, templates, setup scripts, and tests,
and bump the pre-1.0 version to `0.0.12`.
