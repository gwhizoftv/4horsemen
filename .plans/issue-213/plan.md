# Plan: Efficiency improvements — Vim mode suppression, terminal timestamps, verification caching, and documentation policy

## Exact File List to be changed or deleted

- `src/setupWorkspace.ts`
  - Update `ProjectPolicyProposal` type to include optional `documentation?: DocumentationProfile` and `verification?: VerificationPolicy`.
  - In `proposeProjectPolicy(productRoot)`:
    - For `package.json` / Node projects (and other detected toolchains):
      - Discover existing documentation files (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/*.md`).
      - Propose a default `documentation` profile: allowlist discovered markdown paths; if `scripts.has("check:docs")`, set `verify: { precommit: [runScript("check:docs")], prepush: [runScript("check:docs")] }` and `checks: [runScript("check:docs")]`; otherwise set `verify: { precommit: [], prepush: [] }` (exempting documentation from running expensive code checks) and minimal check.
      - Propose a default `verification` policy: set `mode: "coordinator"`, `coordinated` verify checks, `candidate` checks with coverage rules, and `cache` declarations specifying `inputs: "tree-excluding-evidence"`, `probes: [["node", "--version"], [manager, "--version"]]`, `dependencies: ["node_modules"]`, and `dependencyExcludes: ["node_modules/.modules.yaml", "node_modules/.pnpm-workspace-state-v1.json", "node_modules/.vite", "node_modules/.vite-temp"]`.
      - Propose cache declarations on finalization `checks` as well.
    - In `buildWorkspaceConfig()`:
      - Inherit `proposal.documentation` when `declared.documentation` is undefined.
      - Inherit `proposal.verification` when `declared.verification` is undefined.
      - Default `codex` `nudgePrelude` in `agentOwnerUiDefaults` to `[]` when vim mode is disabled.
      - In per-clone wiring, ensure Cursor's clone `.cursor/cli.json` specifies `{"editor": {"vimMode": false}}`.
- `scripts/lib/launcher.sh`
  - In `launcher_command(agent)`:
    - For `codex`: add `-c tui.vim_mode_default=false` to launch flags.
    - For `claude`: add `--settings '{"editorMode":"normal"}'` to launch flags.
- `src/tmux.ts`
  - In `pipeToLog(log: string)`:
    - Update `pipe-pane` command to pipe through a streaming timestamper using `/usr/bin/perl -pe 'BEGIN { $|=1; use POSIX qw(strftime); } print strftime("[%Y-%m-%dT%H:%M:%SZ] ", gmtime)' >> ${shellQuote(log)}` (with `#` doubled for tmux format escaping).
- `test/verify-config.test.ts`
  - Add tests asserting that `proposeProjectPolicy` proposes default `documentation` profile and `verification` policy with cache declarations for `package.json` projects.
  - Add tests asserting that `buildWorkspaceConfig` incorporates proposed `documentation` and `verification` when omitted from `declared`.
- `test/onboard.test.ts`
  - Add tests verifying that `coord onboard` writes a workspace `config.json` with non-empty `documentation` profile and coordinator-owned `verification` block with cache declarations.
- `test/cli.test.ts`
  - Add assertions verifying that generated agent launchers disable vim mode (`-c tui.vim_mode_default=false` for Codex, `--settings` for Claude).
- `test/tmux.test.ts`
  - Add assertions that `pipeToLog` formats the pipe with a streaming ISO UTC timestamper, and verify isolated tmux exit logging captures timestamps.

## Exact file list to be created

- `.plans/issue-213/plan.md` (this plan).

No product files are created.

## Reuse and Scope

- Reuses existing configuration schemas in `src/state.ts`:
  - `documentationProfileSchema`: validates the generated `documentation` profile (`paths`, `verify`, `checks`).
  - `verificationPolicySchema`: validates coordinator verification (`mode`, `coordinated`, `candidate`, `maxConcurrentExpensive`).
  - `checkCacheSchema`: validates cache receipts (`inputs`, `probes`, `dependencies`, `dependencyExcludes`).
  - `checkCommandSchema` and `verifyConfigSchema`.
- Reuses `src/verificationReceipts.ts`:
  - Receipt storage and lookup under `<coordRoot>/verification/receipts/` across issues and agent worktrees.
- Reuses existing clone and workspace configuration helpers in `src/setupWorkspace.ts`:
  - `proposeProjectPolicy`, `buildWorkspaceConfig`, `agentOwnerUiDefaults`, `writeAgentLauncher`.
- Reuses launcher generator logic in `scripts/lib/launcher.sh`:
  - `launcher_command(agent)` and `write_launcher(path, agent, label, shared)`.
- Reuses `pipe-pane` mechanics and window option `@coord-log` in `src/tmux.ts`:
  - Continues piping per-run output to `<terminalLogDir>/run-<timestamp>.log`.
- Reuses test fixtures in `test/support/workspaceFixture.ts`, `test/onboard.test.ts`, `test/verify-config.test.ts`, `test/cli.test.ts`, and `test/tmux.test.ts`.
- Scope boundaries:
  - Does not mutate operator's global user configurations in `~/.codex/config.toml` or `~/.claude/settings.json`.
  - Does not introduce new external runtime dependencies or daemons; uses standard system Perl (`/usr/bin/perl`) present on macOS and Linux for pipe timestamping.

## Tests

- `test/verify-config.test.ts`
  - Test `proposeProjectPolicy`:
    - For a package.json project with markdown files and `check:docs`, asserts `proposal.documentation` allowlists the markdown paths and assigns `check:docs` to precommit/prepush and checks.
    - For a package.json project without `check:docs`, asserts `proposal.documentation` allowlists discovered markdown files and exempts them from code checks with `{ precommit: [], prepush: [] }`.
    - Asserts `proposal.verification` contains `mode: "coordinator"`, `candidate` check entries, and `cache` declarations for `node_modules`.
  - Test `buildWorkspaceConfig`:
    - Asserts that when `declared.documentation` and `declared.verification` are omitted, `buildWorkspaceConfig` applies the proposed documentation and verification blocks.
- `test/onboard.test.ts`
  - Extend happy-path onboard test to assert the resulting `config.json` includes `documentation` (with allowlisted documentation paths and exempted precommit/prepush or `check:docs`) and `verification` (with coordinator mode and cache declarations).
- `test/cli.test.ts`
  - In launcher generation tests, assert Codex launcher includes `-c tui.vim_mode_default=false` and Claude launcher includes `--settings '{"editorMode":"normal"}'`.
- `test/tmux.test.ts`
  - Assert `pipeToLog` produces the expected `/usr/bin/perl` timestamping command line with doubled `#`.
  - In `isolated tmux exit diagnostics`, assert the resulting log lines begin with timestamp brackets `^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z\]`.
- Verification check suite:
  - Focused tests: `pnpm vitest run test/verify-config.test.ts test/onboard.test.ts test/cli.test.ts test/tmux.test.ts`
  - Repository check: `pnpm check:fast`

## Alternatives Rejected

- **Disabling vim mode by modifying host configuration files (`~/.codex/config.toml`, `~/.claude/settings.json`)**:
  - Rejected because agent runs must not mutate the operator's personal environment outside the workspace. Using launch flags (`-c tui.vim_mode_default=false` for Codex, `--settings` for Claude, `.cursor/cli.json` inside the clone for Cursor) isolates vim mode suppression to coordination sessions.
- **Runtime keystroke injection to exit vim NORMAL mode (sending `Escape` or `i`/`a`)**:
  - Rejected because heuristic keystroke injection is timing-dependent, race-prone, and causes literal characters to be typed into input fields when the agent is already in insert mode.
- **Daemon-based or Node-based logging process for terminal timestamps**:
  - Rejected because spawning a persistent Node daemon for every tmux pane introduces significant memory and process overhead, and buffering in standard pipes could swallow or delay prompt characters on incomplete lines. A single `/usr/bin/perl` stream filter with unbuffered output (`$|=1`) is lightweight, portable, and zero-dependency.
- **Exempting all markdown files from checks globally without a documentation profile**:
  - Rejected because git hooks and change classification intentionally require an explicit, auditable allowlist in `config.json` (`documentationProfileSchema`). Proposing a populated `documentation` profile during onboard adheres to the strict security policy while eliminating unnecessary code checks on docs.
- **Leaving verification cache declarations undeclared during onboarding**:
  - Rejected because coordinator verification with cache receipts already exists in the runtime, but without onboard proposal support, workspaces default to uncached `pnpm run check` executions across all issues.

## Risks and Mitigations

- **Risk: Pre-existing workspaces or agent clones generated before this change still run without vim suppression or verification blocks.**
  - *Mitigation*: Re-running `coord install` or `coord onboard` regenerates launchers with the updated flags and populates missing `documentation` and `verification` policies in `config.json`.
- **Risk: Disabling vim mode in Codex might break nudge delivery if `nudgePrelude` still sends `"i"`.**
  - *Mitigation*: `agentOwnerUiDefaults` for Codex is updated to set `nudgePrelude: []` when vim mode is disabled, ensuring no rogue `"i"` characters are typed before prompts.
- **Risk: Terminal log timestamp prefix alters raw output lines for existing test assertions.**
  - *Mitigation*: Existing log tests check substring containment (`.includes(...)`) rather than line-anchored matches. The timestamper preserves all log content while prepending a standard ISO UTC timestamp prefix.
- **Risk: Repositories without `node_modules` or with non-standard package structures failing dependency hashing.**
  - *Mitigation*: `dependencyIdentity` in `verificationReceipts.ts` already handles missing declared paths cleanly. `proposeProjectPolicy` checks `has("package.json")` and `has("pnpm-lock.yaml")` before proposing Node-specific dependency cache entries.

## Conclusion

This plan addresses all five efficiency findings in Issue 213 by:
1. Disabling vim mode per agent at launch via hermetic command-line flags and clone-scoped config, and clearing Codex's `nudgePrelude`.
2. Adding stream timestamps to tmux `pipe-pane` terminal logging so all future runs record ISO UTC timestamps per line.
3. Proposing coordinator-owned verification policies and dependency cache declarations during `coord onboard` and `coord install`.
4. Generating a default `documentation` profile that allowlists project documentation and exempts documents from running expensive product code checks.
5. Providing focused Vitest test coverage across `verify-config`, `onboard`, `cli`, and `tmux`.
