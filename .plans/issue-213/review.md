# Plan Review: Issue 213 Peer Plans

Review of bound peer plans for Issue 213:
- Cursor: `f1b3bd9cb1dd3370444e4a124804a94d51ed9b1d`
- Codex: `72d0d35408bc60cf73a810bc6b6d66342305afc0`
- Antigravity: `4c307345adbe457cfc21510e62e12fafc8bac279`
- Claude: `a7a3dfd24fa79d2a7ce68003539116cb2114ef50`

## Findings

### Finding 1: Writing `editor` into `.cursor/cli.json` crashes Cursor Agent CLI on startup (Cursor and Antigravity plans)
- **Plan claim or section:** Cursor plan section "Exact File List to be changed or deleted" (`src/setupWorkspace.ts` / `src/install.ts`); Antigravity plan section "Exact File List to be changed or deleted" (`src/setupWorkspace.ts`). Both propose creating or merging `{"editor": {"vimMode": false}}` into `<clone>/.cursor/cli.json`.
- **Rule that must hold:** Configuration files created in agent clones must conform to the agent CLI's schema so the harness starts successfully.
- **Concrete failure:** The Cursor Agent CLI (`agent`) strictly validates project-level `.cursor/cli.json` for allowed permission keys only. If `editor` is present, the CLI refuses to start and terminates with schema validation failure:
  `Invalid project config at <clone>/.cursor/cli.json: schema validation failed. [{"code": "unrecognized_keys", "keys": ["editor"], "path": [], "message": "Unrecognized key(s) in object: 'editor'"}]`.
  Cursor panes will crash immediately upon launch.
- **Smallest correction:** Do not write `editor` into project `.cursor/cli.json`. Either isolate Cursor's CLI config via `CURSOR_CONFIG_DIR` pointing to a disposable `cli-config.json` snapshot, or leave `editor.vimMode` in the operator's home config `~/.cursor/cli-config.json` while ensuring coord's nudge prelude and submit key resolvers respect the effective mode.

### Finding 2: Launcher `--settings` flag disables Claude statusline quota telemetry (Cursor, Codex, and Antigravity plans)
- **Plan claim or section:** Cursor plan (`scripts/lib/launcher.sh`), Codex plan (`Reuse and Scope`, section 1), and Antigravity plan (`scripts/lib/launcher.sh`) all propose passing `--settings '{"editorMode":"normal"}'` on the Claude launch command line in `start-claude.sh`.
- **Rule that must hold:** Changes to launcher flags must not break existing coordinator telemetry and diagnostics contracts.
- **Concrete failure:** `src/claudeStatusLine.ts` (lines 106–108) explicitly checks whether `start-claude.sh` contains `--settings`:
  `if (context.launcher !== undefined && existsSync(context.launcher) && /--settings\b/.test(readFileSync(context.launcher, "utf8"))) { return { status: "ambiguous", reason: "the launcher passes --settings, which outranks clone-local settings" }; }`.
  Passing `--settings` in the launcher causes `resolveEffective` to flag the configuration as ambiguous and permanently turns off Claude's statusline integration and quota telemetry.
- **Smallest correction:** Set `"editorMode": "normal"` in the clone-local `.claude/settings.local.json` file managed by `src/agentHookSync.ts`, which outranks the owner's `~/.claude/settings.json` without modifying launcher flags.

### Finding 3: Prefix-based documentation classification allows non-prose files to bypass verification (Cursor plan)
- **Plan claim or section:** Cursor plan (`src/state.ts` and `src/changeClassification.ts`): Proposes adding `prefixes: z.array(pathTokenSchema)` to `documentationProfileSchema` and treating any path matching a prefix as documentation in `classifyChanges`.
- **Rule that must hold:** Documentation exemptions must be an opt-in, reviewable allowlist of exact repository paths (`paths: z.array(repositoryPathSchema).min(1)`), preventing non-prose scripts, configuration, or build artifacts placed inside a documentation directory from bypassing product checks.
- **Concrete failure:** With prefix matching on `docs/`, any executable script, build artifact, or configuration file placed under `docs/` (such as `docs/build.sh` or `docs/config.json`) is classified as `"documentation"`, exempting it from `pnpm check:fast` or other product verification checks unless manually identified and added to `workflowCriticalPrefixes`.
- **Smallest correction:** Retain exact path allowlists in `documentationProfileSchema.paths`, populated during onboarding with the concrete list of discovered tracked documentation files (e.g., `README.md`, `docs/setup-workspace.md`).

### Finding 4: Requiring manual `--declare` leaves default onboarding without verification blocks or cache receipts (Codex plan)
- **Plan claim or section:** Codex plan (`src/setupWorkspace.ts` and `src/install.ts`): Proposes writing `{ "mode": "local" }` with no candidate checks or cache declarations on onboarding unless the operator explicitly passes `--declare <file>`.
- **Rule that must hold:** The issue requires onboarding to provide a default policy that exempts documents from code checks and configures coordinator verification with cache declarations so workspaces do not remain unconfigured.
- **Concrete failure:** If onboarding defaults to `{ "mode": "local" }` without candidate checks or cache declarations, newly onboarded workspaces continue to suffer from the exact inefficiency reported in Issue 213: running single uncached `pnpm run check` commands without shared receipts between issues or agents.
- **Smallest correction:** Have `proposeProjectPolicy` propose coordinator verification and candidate cache declarations for detected package managers (e.g. Node/pnpm with `node_modules` dependencies and probes) as part of the default proposal, while still allowing `--declare` to override it.

### Finding 5: Doubling `%` in `pipeToLog` corrupts strftime format specifiers (Claude plan)
- **Plan claim or section:** Claude plan (`src/tmux.ts`): Proposes running `perl -MPOSIX=strftime ...` and doubling `%` (as well as `#`) across the command string passed to tmux `pipe-pane`.
- **Rule that must hold:** Escapes in shell commands passed to `pipe-pane` must match tmux's actual expansion rules so the invoked interpreter receives valid syntax.
- **Concrete failure:** tmux expands `#` formats in `pipe-pane` commands, but strftime `%` expansion is not performed on shell command arguments passed to `pipe-pane`. Passing doubled `%%` causes perl's `POSIX::strftime` to receive literal `%%`, which outputs literal `%` characters instead of formatted dates (e.g., `[%Y-%m-%dT%H:%M:%S.000Z]`), corrupting terminal log timestamps.
- **Smallest correction:** In the perl invocation, construct the ISO timestamp using `gmtime` and `sprintf` (or avoid doubling `%` where tmux does not expand it), ensuring valid timestamps are written.

## Conclusion

All four plans correctly identify the core requirements of Issue 213:
1. Disabling vim mode for Codex (`-c tui.vim_mode_default=false`) and clearing Codex's default `nudgePrelude`.
2. Adding timestamps to agent terminal logs.
3. Establishing documentation allowlists and coordinator verification with cache declarations during onboarding.
4. Keeping test coverage focused within existing test suites (`test/tmux.test.ts`, `test/verify-config.test.ts`, `test/onboard.test.ts`, `test/install.test.ts`).

However, the peer plans contain critical divergence points that must be reconciled:
- **Claude editor mode:** Setting `"editorMode": "normal"` in `.claude/settings.local.json` via `src/agentHookSync.ts` (as Claude's plan proposes) is strictly superior to `--settings` in `start-claude.sh`, because `src/claudeStatusLine.ts:106` disables telemetry whenever `--settings` is present in the launcher.
- **Cursor editor mode:** Modifying `.cursor/cli.json` crashes Cursor on startup due to strict unrecognized-key schema validation. Cursor's vim setting must not be written to project `.cursor/cli.json`.
- **Documentation profile:** Retaining exact path allowlists in `documentationProfileSchema.paths` (populated during onboard) preserves security against accidental script execution, avoiding broad prefix exemptions.
- **Onboarding defaults:** `proposeProjectPolicy` should proactively propose both the documentation allowlist and the coordinator verification block with cache declarations for recognized package managers, while `--declare` allows explicit operator overrides.
