# Issue 98 — sibling `completes/` mailbox for agent completion SHAs

## Context

Agents must write a single pushed commit SHA to an out-of-clone file named in
`action.md`. Today that file lives beside `action.md` under
`coord-runtime/issue-N/agents/<agent>/complete`. Sandboxed harnesses often refuse
to write there because it sits under coordinator-owned runtime state, and broad
grants (`danger-full-access`, whole `coord-runtime`) compromise integrity.

Move only the **completion SHA file** to a sibling mailbox tree. Keep
`action.md` and `render.log` under `coord-root`. No backward compatibility: new
issues use the mailbox; stale `complete` files under `coord-runtime` are ignored.

Target topology (flat workspace):

```text
<workspace>/                     # e.g. /Volumes/4TB-SOURCE/REPOS/coord
  coordination-<agent>/          # agent clone cwd
  coord-runtime/                 # coordinator-only journals, cursors, action.md
  completes/issue-<n>/<agent>/complete
```

`action.md` must cite an **absolute** path under `completesRoot`. Agents must
never be told to write `../completes/...` — sandboxes treat `..` as escape.

## Exact File List to be changed or deleted

- `src/paths.ts` — add `resolveCompletesRoot()` (default
  `dirname(coordRoot)/completes`, optional override, overlap checks against
  `coordRoot` and every agent root, symlink rejection, optional mkdir `0o700`).
  Extend `IssueRuntimePaths` with `completesRoot`. Point
  `agentRuntimePaths().complete` at
  `completesRoot/issue-<n>/<agent>/complete`; keep `action` and `renderLog`
  under `coord-root/issue-N/agents/<agent>/`. Create per-agent mailbox dirs in
  `createIssueRuntime`. Roll failed `coord start` cleanup must remove
  `completes/issue-N/` as well as `issueRoot`.
- `src/state.ts` — bump `RUNTIME_FORMAT_VERSION` to **3**. Add required
  `completesRoot: string` to `startStateSchema`. Optionally accept
  `completesRoot` in `coordinatorConfigSchema` / workspace declaration for
  nested layouts whose sibling rule does not apply; persist the resolved absolute
  path in `start.json` so resume/restart-action use a stable mailbox root.
- `src/setupWorkspace.ts` — mkdir `completesRoot` during install/onboard.
  Extend `writeAgentLauncher` to accept each agent's mailbox drop directory and
  pass it into `write_launcher`. Re-run launcher generation from `coord start`
  (after `createIssueRuntime`) so issue-scoped prefixes
  (`completes/issue-N/<agent>`) are granted instead of the whole runtime.
- `src/install.ts` — resolve and create `completesRoot` on install; include it
  in containment checks. On `--wipe-runtime`, delete `completesRoot` when the
  outer root is wiped, or delete only this workspace's issue prefixes when
  siblings remain (mirror the existing scoped wipe logic for `coordRoot`).
- `src/wipeIssue.ts` — when wiping `paths.issueRoot`, also remove
  `completesRoot/issue-<n>/` so stale SHAs cannot resurrect a dropped issue.
- `src/cli.ts` — pass `completesRoot` into `issueRuntimePaths` / start
  initialization; extend startup rollback and any `rmSync(issueRoot)` paths to
  drop the matching completes prefix. Wire launcher refresh at start.
- `scripts/lib/launcher.sh` — extend `write_launcher` with a fifth argument:
  absolute mailbox drop dir for the current agent/issue. Vendor grants (narrow,
  not whole `coord-runtime`):
  - Claude: `--add-dir <abs>`
  - Codex: prefer a writable-root flag for that prefix over
    `danger-full-access` when the CLI supports it; keep unattended behavior
  - Antigravity: add only that path to `trustedWorkspaces` (via install/start
    hook), not the clone or full runtime
  - Cursor: pass the absolute drop dir using the CLI's extra-workspace /
    equivalent mechanism; document operator steps if the flag is IDE-side
- `scripts/setup_antigravity.sh` — when coord install/start passes a mailbox
  prefix, append it to `trustedWorkspaces` idempotently (same pattern as clone
  trust today).
- `scripts/setup_codex.sh` — if Codex project config needs an explicit
  additional writable root for the mailbox, add it beside existing
  `workspace-write` settings.
- `docs/coord-driver.md` — update runtime topology diagram: split
  `coord-runtime` and sibling `completes/`; state that `completePath` in the
  action body is absolute under `completesRoot`.
- `docs/repo-map.md` — invariant line: completion SHA lives in sibling
  `completes/`, not in the clone and not beside `cursors.json`.
- `docs/setup-workspace.md` — one paragraph on default `completesRoot` placement
  and optional override.
- `config.example.json` — document optional `completesRoot` (comment or field).
- `test/action.test.ts` — expect rendered `completePath` under `completesRoot`.
- `test/runLoop.test.ts` — read/write/clear completion via new path; drop and
  restart-action unchanged behavior.
- `test/integration.test.ts` — end-to-end tick with SHA written to mailbox.
- `test/wipeIssue.test.ts` — assert `completes/issue-N/` is removed on wipe.
- `test/install.test.ts` — launcher or vendor settings include the mailbox grant,
  not `coord-root` as a whole; codex no longer relies solely on
  `danger-full-access` for completion writes when a narrower grant suffices.
- `test/cli.test.ts`, `test/evidence.test.ts`, `test/state.test.ts`,
  `test/agentLifecycle.test.ts`, `test/agentEvent.test.ts`, `test/onboard.test.ts`
  — update fixtures/helpers that hardcode
  `coord-runtime/issue-N/agents/<agent>/complete`.

## Exact file list to be created

- `test/paths.test.ts` — unit tests for `resolveCompletesRoot`,
  `agentRuntimePaths().complete` vs `.action` separation, symlink/escape
  rejection, and overlap with agent roots.

## Tests

Run before commit:

```bash
pnpm check:fast
```

New/updated coverage:

- `test/paths.test.ts` — mailbox paths, containment, symlink rejection.
- `test/action.test.ts` — rendered action cites absolute mailbox `completePath`.
- `test/runLoop.test.ts` / `test/integration.test.ts` — write SHA to mailbox;
  `clearCompletion`, drop, restart-action, malformed SHA handling unchanged.
- `test/wipeIssue.test.ts` — wipe removes `completes/issue-N/`.
- `test/install.test.ts` — harness grant targets the agent drop prefix only.

Coordinator gate (not required on every commit):

```bash
pnpm check
```

## Alternatives Rejected

- **Leave `complete` under `coord-runtime` and grant agents the whole runtime**
  — exposes `cursors.json`, journals, and other agents' `action.md` files.
- **Single shared file (`completes/complete` or `cursor-complete`)** — peers
  overwrite each other's completion intent.
- **Tell agents to write `../completes/...` relative paths** — rejected by
  sandbox path-escape rules; `action.md` must carry the bound absolute path.
- **Move `action.md` into `completes/`** — coordinator/agent write boundaries
  stay split; only the SHA mailbox moves.
- **Backward-compatible dual-read of old and new complete locations** — issue
  explicitly requires no migration; bump runtime format version instead.

## Risks and Mitigations

- **Nested workspaces without a shared parent** — default sibling derivation
  fails; optional `completesRoot` in config plus docs for explicit absolute
  paths.
- **Install-time launcher cannot know issue number** — refresh launchers at
  `coord start` with `completes/issue-N/<agent>`; install grants only
  `completesRoot` mkdir and vendor hooks that accept runtime refresh.
- **Codex/Cursor sandbox APIs differ by version** — implement the narrowest grant
  each vendor supports; keep existing unattended behavior as fallback with a
  test asserting the mailbox path is listed in generated launcher/settings.
- **Failed start leaves orphan mailbox dirs** — mirror `issueRoot` rollback in
  `cli.ts` startup catch path.
- **Runtime format bump breaks old `start.json`** — acceptable per issue scope;
  abandoned issues are wiped or restarted under format 3.

## Conclusion

Relocate agent completion SHAs to a per-issue, per-agent sibling mailbox under
`completesRoot`, keep coordinator artifacts in `coord-runtime`, grant harnesses
only their drop prefix, and bump runtime format version 3. This removes the
sandbox deadlock without trusting agents with coordinator state.
