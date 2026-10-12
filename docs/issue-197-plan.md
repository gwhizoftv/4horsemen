# Issue 197: setup trust and startup recovery

Owner-authorized implementation on `issue-197/codex`, based on `origin/main`.
No coordinator actions, ballots, signals, or completion markers.

## Exact File List to be changed or deleted

- `src/install.ts`: establish persistent vendor trust during install (and thus
  onboard), honoring the existing home override and dry-run behavior.
- `scripts/setup_common.sh`, `scripts/setup_claude.sh`,
  `scripts/setup_codex.sh`, `scripts/setup_cursor.sh`, and
  `scripts/setup_antigravity.sh`: share the installer's trust implementation;
  remove duplicate trust writes and obsolete trust guidance.
- `src/runLoop.ts`: separate terminal restoration from workflow initialization
  so a paused issue can reopen missing/dead agent terminals without sending
  tasks, clearing holds, or preparing branches.
- `src/cli.ts`: let the existing attach command repair missing/dead terminals
  for an unfinished issue, including while paused.
- `src/tmux.ts`: recognize Cursor's actual workspace-trust dialog before input.
- `test/install.test.ts`, `test/onboard.test.ts`, `test/runLoop.test.ts`,
  `test/cli.test.ts`, and `test/tmux.test.ts`: extend existing fixtures for trust
  persistence and paused terminal recovery.
- `test/doctor.test.ts`, `test/hookSync.test.ts`, `test/vendor.test.ts`: pass the
  existing `home: null` override in installer fixtures that do not test user
  settings. Required because installation now persists trust; these fixtures
  must never write to the real owner's home. No new product behavior.
- `docs/setup-workspace.md`, `docs/coord-driver.md`: document setup-time trust
  and owner recovery using existing commands.

## Exact file list to be created

- `src/agentTrust.ts`: one shared implementation for the four vendors' persistent
  trust formats, called by install and standalone setup scripts. A separate
  module avoids duplicating config mutation in four shell scripts and install.
- `docs/issue-197-plan.md`: this requested plan and verification evidence.

## Reuse and Scope

Reuse `EffectOptions`, JSON object validation and atomic JSON writes, the existing
home injection, installer/onboard fixtures, `TmuxController.ensureSession`,
`openOwnerAgentClients`, and issue state checks. No new dependencies,
launcher flags, CLI commands, state schemas, or automatic login/hold release.

Trust the product repository's parent once. Preserve explicit own-clone entries
for vendors whose repository/configuration lookup requires them. For Cursor,
also cover configured clone/runtime/mailbox roots outside that parent; its saved
parent trust covers future issue subfolders. Preserve unrelated user settings,
make repeated setup a no-op, and honor vendor home overrides. Do not change
tool permissions or sandbox grants.

Exclude home/ancestors of home and paths shallower than three components from
shared parent trust for all vendors; retain exact clone/root entries instead.
These are also the parents from which Cursor refuses inherited trust.

Keep terminal restoration independent of workflow authority: it may recreate
missing windows or respawn dead panes on owner startup/attach, but must preserve
live panes, current actions, send budgets and all pauses/holds. Fence restoration
against finished/abandoned issues and removal of agents being restored, allowing
routine state revisions from a live runner. Recognize
Cursor's trust screen so coordinator text cannot select Quit or dismiss it.

## Tests

Run focused Vitest cases in the existing fast/system configurations while
developing. Cover persistent parent trust, existing settings, idempotence,
dry-run/home isolation, malformed configuration, setup-script reuse, and
onboard integration. Cover manual pauses and holds with missing/dead/live panes,
no task delivery during recovery, and Cursor trust-screen input blocking.

Run `pnpm build` and `pnpm test:e2e`. The installed commit hook owns the mandatory
`pnpm check:fast`; do not duplicate that suite immediately before committing.
Inspect the final diff, push the issue branch, create a PR, and wait for review.

## Alternatives Rejected

Per-launch `--trust` and per-issue trust records are unnecessary when stable
parents are trusted. Calling entire legacy setup scripts from install would
also rewrite unrelated identity, MCP and permission settings. Automatically
resuming holds or restarting live agents would change workflow behavior beyond
startup recovery. No new recovery command is needed: reuse startup and attach.

## Risks and Mitigations

Vendor trust storage differs: retain exact clone entries where needed and test
each native format. Cursor's marker path follows the installed CLI's data-home
and path encoding. Config updates preserve other keys and refuse unsupported
or invalid structures instead of replacing them. Tests use disposable homes.
Terminal recovery must not grant workflow authority while paused; exercise that
boundary and concurrent changes through existing injected tmux/run-loop tests.

## Conclusion

Deliver only persistent setup trust and the startup/recovery behavior described
in #197. Login prompts remain owner interactions in the restored terminals.

## Verification evidence

- `pnpm build`: passed.
- Focused run-loop/tmux tests: 273 passed.
- Installer/onboard/CLI/hook system tests: 148 passed.
- `pnpm test:e2e`: 2 passed.
- `pnpm exec tsc -p test/tsconfig.json`, shell syntax, and `git diff --check`: passed.
- The commit hook will run the mandatory lint, typecheck, fast and system suites.

Cursor's marker format and parent exclusions were checked against installed CLI
`2026.10.01-e373342` (`src/workspace/approval.tsx` in its distribution).
Claude's config-directory override is described in the
[official config location documentation](https://code.claude.com/docs/en/mcp-quickstart#find-your-configuration-on-disk).
No live vendor login/model session is part of the automated validation.

## Review revision

Reviewed Claude's findings at `2970b6f`. Address the seven findings within the
existing file map: broad-parent fallback, accurate Antigravity comments,
actionable setup refusals, attach output, recovery during routine state updates,
dialog-only Cursor matching, and Codex conflicts limited to project definitions.
Keep the requested project-parent trust policy; no launcher or permission changes.
Extend the existing tests for the reported failures, including Cursor's rendered
box/icon and recovery aborts on completion, abandonment, or roster removal.

Revision checks: `pnpm build`, 13 focused trust/setup tests, 10 focused
recovery/prompt tests, test typecheck, targeted ESLint, and shell syntax passed.
The commit/push hooks own the full mandatory suites for the revision.
