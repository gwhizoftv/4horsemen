# Issue 213 plan: vim-off agents, timestamped terminal logs, onboarding policy defaults

Issue #213 asks five things. Each answer below is either a code change in this
plan or a documented fact. Facts marked *probed* were checked on this machine
on 2026-10-14 (Claude Code 2.1.299, codex-cli 0.162.1, Cursor agent
2026.10.14-0f9edde, tmux, `/usr/bin/perl`) in throwaway directories and tmux
sockets, not in any clone.

## Answers to the issue's questions

1. **Run each agent with vim mode off.**
   - **Claude.** Coord already owns the clone-local
     `.claude/settings.local.json`, which outranks the owner's
     `~/.claude/settings.json`. With `"editorMode": "normal"` in that file,
     Claude starts without vim; a control pane on the owner's settings shows
     `-- INSERT --` (*probed*). A `--settings` flag is rejected:
     `src/claudeStatusLine.ts:106` treats any launcher `--settings` as
     ambiguous and turns off quota telemetry.
   - **Codex.** `-c tui.vim_mode_default=false` on the launch line removes the
     `Vim: Insert` footer (*probed*). It is per process, and
     `~/.codex/config.toml` is not touched.
   - **Cursor.** There is no CLI flag. Project `.cursor/cli.json` with an
     `editor` key makes `agent` refuse to start ("Unrecognized key(s) in
     object: 'editor'", *probed*), so coord must never write it.
     `CURSOR_CONFIG_DIR` would move the owner's whole Cursor state. The owner
     sets `editor.vimMode: false` in `~/.cursor/cli-config.json` instead.
     `readCursorVimMode` already reads that file, so nudges switch to the
     non-vim keys on their own.
   - **Antigravity** has no vim mode.
   - **Prelude keys.** Turning vim off makes the current prelude keys type
     literal text. Claude would get `a` because no INSERT indicator is shown;
     Claude's vim NORMAL also shows no indicator (*probed*), so pane text
     cannot tell the two apart. Codex would get its configured `i`. The
     prelude rules change with the launch change (see the file list).
   - Escape followed by Enter still submits to a non-vim Claude: a single
     Escape keeps the typed text (*probed*).
2. **Terminal log timestamps.** No. Logs are raw `cat >>` streams
   (`src/tmux.ts:727`), and only the file name has the run start time. After
   this change every line starts with an ISO-8601 UTC millisecond stamp taken
   at the line's first byte. tmux applies strftime to the `pipe-pane` command:
   an unescaped `%s` came out as epoch seconds (*probed*). So `%` must be
   doubled, as `#` already is.
3. **How cache declarations and the `verification` block are created.**
   - They come only from the owner's declaration (`coord install --declare`).
     They are frozen into `start.json` at `coord start`.
   - `coord onboard` cannot take a declaration today. Re-running onboard or
     install regenerates `config.json` from the declaration plus the detected
     defaults (`src/install.ts:352-375`; only the stamp timestamp is carried
     over), so hand edits to the runtime config are lost.
   - Coord does not guess caches. A receipt is only safe when the owner names
     every input a command reads (`docs/setup-workspace.md` "Caching"), and
     the installer cannot know them.
   - Receipts live in `<coord-runtime>/verification/receipts/` and are shared
     by every issue and agent of that runtime.
   - Real reuse needs coordinator mode, where candidate checks share names and
     argv with final checks. With the local mode's single `pnpm run check`, a
     receipt only helps an identical re-run.
   - Fix: `coord onboard` accepts `--declare`. Docs state where the policy
     comes from and where receipts are shared. Adopting it for the 4horsemen
     workspace is an owner step, `coord onboard <product> --declare <file>`,
     with the policy fields of `config.example.json`. The implementation does
     not edit `coord-runtime`.
4. **No `documentation` profile in the runtime config.** The same cause as 3:
   onboard proposes none.
5. **Default policy that exempts documents.** Onboard and install propose a
   documentation profile from the product's tracked prose files. The profile
   has empty hook lists and no final checks. A declaration still replaces it.

## Exact File List to be changed or deleted

- `scripts/lib/launcher.sh`: add `-c tui.vim_mode_default=false` to the codex
  line in `launcher_command`.
- `src/agentHookSync.ts`:
  - In `plannedDocument` for vendor `claude`, return
    `{ ...existing, hooks, editorMode: existing.editorMode ?? "normal" }`. An
    owner's explicit value is kept, and `inspectAgentLifecycleHooks` stays
    consistent because it compares against the same planned document.
  - In `removeAgentLifecycleHooks`, inside the existing `found` path, delete
    `editorMode` for claude when its value is `"normal"`.
- `src/tmux.ts`:
  - Add `readClaudeEditorMode(agentRoot)`, which reads `editorMode` from
    `<agentRoot>/.claude/settings.local.json`. Unreadable input returns
    `undefined`, mirroring `readVimModeFlag`.
  - In `resolveNudgeKeys`, when the configured prelude is empty and the agent
    is claude with local `editorMode === "normal"`, use prelude `[]`.
    Otherwise use `vimInsertPrelude` as today.
  - At both codex send sites (`remind` ~L1206, `nudge` ~L1283), send the
    codex prelude only when `codexVimNormal(paneText, staleOverride !==
    undefined && requireSentinel)` is true. That means positive `Vim: Normal`
    evidence, where today the rule is "unless `Vim: Insert`".
  - Change `pipeToLog` to run
    `if command -v perl >/dev/null 2>&1; then exec perl -MPOSIX=strftime -MTime::HiRes=time -e '<stamp>'; else exec cat; fi >> <log>`.
    The stamp script was probed: `$|=1`, `sysread`, then split chunks after
    newline, and when at a line start print
    `strftime("%Y-%m-%dT%H:%M:%S", gmtime $t)` plus `.mmmZ `. Double both `#`
    and `%` in the whole command.
- `src/state.ts`: `documentationProfileSchema.checks` becomes
  `z.array(checkCommandSchema)`, so empty is allowed. Empty command lists
  already pass in hooks (`src/hookPolicy.ts:224`) and coordinator gates
  (`src/runLoop.ts:2916`, `src/verificationRunner.ts:83`).
- `src/setupWorkspace.ts`:
  - `ProjectPolicyProposal` gains
    `documentation?: CoordinatorConfig["documentation"]`.
  - `proposeProjectPolicy` wraps the existing ecosystem branches. It then adds
    a documentation profile when `git ls-files -z` (existing `git` helper) in
    `productRoot` lists tracked `.md` files that are either at the root or
    under `docs/`. It excludes root `AGENTS.md`, `CLAUDE.md` and `GEMINI.md`
    (agent instructions), the proposal's critical prefixes and files, and any
    path that fails `repositoryPathSchema`. The profile is
    `verify: { precommit: [], prepush: [] }, checks: []`. With no git
    worktree or no matching files there is no profile.
  - `buildWorkspaceConfig` uses
    `declared.documentation ?? input.proposal.documentation`.
- `src/install.ts`: `OnboardOptions.declarePath?: string`, passed through to
  `install`.
- `src/cli.ts`: `onboard` allows `--declare` and passes the resolved path; the
  help line is updated.
- `docs/setup-workspace.md`:
  - The onboard/install usage includes `--declare`.
  - Replace "Use `install`, not `onboard`, for `--declare`".
  - Under "Scoping verification", describe the default documentation proposal
    (prose files only, templates and agent-instruction files excluded) and how
    a declaration replaces it.
  - Under "Coordinator verification mode", add where `verification`/`cache`
    come from, that regeneration drops hand edits, and that receipts are
    shared across issues and agents of one runtime.
  - Add a short vim-mode subsection covering what coord sets for Claude and
    Codex and the owner step for Cursor.
- `docs/coord-driver.md`:
  - In the nudge-key paragraphs (~L404-473), say Claude/Codex launch without
    vim and preludes need visible vim evidence or a vim setting.
  - Correct the "clone `.cursor/cli.json`" remark: Cursor rejects `editor`
    there.
  - Near the tmux section (~L337), add that agent terminal logs are
    `agents/<agent>/terminal/run-<start>.log` with per-line UTC timestamps.

## Exact file list to be created

None. Every change extends an existing module, test file or document.

## Reuse and Scope

- **Reused.**
  - `agentLifecycleHookPath`, `plannedDocument`, `removeAgentLifecycleHooks`
    and `inspectAgentLifecycleHooks` already own Claude's
    `settings.local.json` and its drift report.
  - `readVimModeFlag`/`readCursorVimMode` provide the config-read pattern.
  - `codexVimNormal`, `vimInsertPrelude` and `resolveNudgeKeys` are reused.
  - `shellQuote`, `newTerminalLog` and `launchAgent` are reused.
  - `launcher_command` is the single launch-flag source.
  - `proposeProjectPolicy`, `buildWorkspaceConfig`, the `git` helper and
    `repositoryPathSchema` are reused.
  - `install`'s existing `declarePath`/`readDeclaration` handle declarations.
  - `selectVerification` and `selectCandidateVerification` need no change.
- **Tests and fixtures reused.** The `tmux.test.ts` vim and isolated-tmux
  cases, the `agentHookSync.test.ts` per-agent loop, the
  `verify-config.test.ts` "installer proposals", the `install.test.ts`
  exact-argv launcher test, and the `onboard.test.ts` happy-path fixture.
- **Out of scope.**
  - Coordinator mode is not turned on and caches are not guessed by default
    (see Alternatives).
  - The owner's home configs are not edited.
  - The runtime `config.json` is not changed.
  - The dead `.cursor/cli.json` overlay read in `readCursorVimMode` is left
    as is.
  - Analytics parsing of terminal logs is not added.
- **New files:** none.

## Tests

All cases extend existing files. Each fails before the change and passes after.

1. `test/tmux.test.ts`, "uses per-agent nudgePrelude and nudgeSubmit for Codex
   vim" (~L312): the pane `codex ready` has no vim footer. The expected batch
   drops `i`/`sleep 0.15` and the leading space. Today it sends `i`. The
   existing `Vim: Normal` cases (~L969, ~L990) still expect `i`.
2. `test/tmux.test.ts`, beside the Cursor vim case (~L263): a temp clone with
   `.claude/settings.local.json` `{"editorMode":"normal"}` gives
   `resolveNudgeKeys(claude, "❯").prelude` equal to `[]`. Without the file it
   is `["a"]`, as today.
3. `test/tmux.test.ts`, "keeps cleared startup output and exit details"
   (isolated tmux, ~L1352): assert every non-empty line of each run log matches
   `^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z `. The real tmux run also proves
   the `%` escaping; unescaped output would start with epoch digits.
4. `test/agentHookSync.test.ts`, per-agent loop: for claude, after sync
   `json(path).editorMode` is `"normal"`. After removal it is absent. A
   pre-set `"vim"` survives sync.
5. `test/verify-config.test.ts`, "installer proposals": a temp git repo with
   tracked `README.md`, `AGENTS.md`, `docs/guide.md`,
   `templates/product/AGENTS.md` and `src/notes.md` proposes `documentation`
   equal to
   `{ paths: ["README.md", "docs/guide.md"], verify: { precommit: [], prepush: [] }, checks: [] }`.
   `buildWorkspaceConfig` with that proposal parses and keeps it. An untracked
   or non-git directory proposes none.
6. `test/install.test.ts`, the exact-argv launcher test (~L794): the codex
   argv gains `"-c", "tui.vim_mode_default=false"` after
   `check_for_update_on_startup=false`.
7. `test/onboard.test.ts`, happy path: a third `runCli(["onboard", product,
   "--declare", file])`, with a declaration holding a coordinator
   `verification` block, writes `config.verification.mode === "coordinator"`.
   Today the flag is refused.

Checks: focused `pnpm vitest run --config vitest.config.ts test/tmux.test.ts
test/verify-config.test.ts` and `pnpm vitest run --config
vitest.system.config.ts test/agentHookSync.test.ts test/install.test.ts
test/onboard.test.ts` while developing. The pre-commit hook owns `pnpm
check:fast`, and the pre-push hook runs `pnpm test:e2e`. The coordinator owns
the final `pnpm run check`.

Manual live check before submitting: launch the regenerated Claude and Codex
launchers in a throwaway tmux socket and confirm there is no vim indicator,
then deliver one nudge to each and confirm the text has no stray `a`/`i`.

## Alternatives Rejected

- **`claude --settings '{"editorMode":"normal"}'`.** It disables Claude quota
  telemetry (`claudeStatusLine.ts:106`).
- **Editing and restoring the owner's `~/.claude/settings.json`,
  `~/.codex/config.toml` or `~/.cursor/cli-config.json`.** It changes every
  session the owner runs, and a crash leaves it changed. Per-process and
  clone-local settings do the same job for Claude and Codex.
- **Writing Cursor `.cursor/cli.json` or setting `CURSOR_CONFIG_DIR`.** The
  first stops Cursor from starting; the second relocates auth and state.
- **Detecting vim-off from pane text for Claude.** Claude's vim NORMAL and
  vim-off panes look the same.
- **Proposing `verification.mode: "coordinator"` or `cache` on onboard.** It
  changes hook binding for every product, and a cache key is only safe with
  owner-declared inputs. `--declare` on onboard makes the opt-in part of
  onboarding.
- **A `docs/` prefix or extension rule in the classifier.** It would turn
  templates and doc build scripts into exempt prose. Exact tracked paths,
  proposed once and recorded, keep the existing rule.
- **A raw log plus a separate timing sidecar.** It needs another file format
  and joiner. A per-line prefix keeps one log that can be grepped.

## Risks and Mitigations

- **A Claude pane launched before re-install still has vim on with no
  indicator.** No local `editorMode` means the current `a` prelude is kept.
  Doctor reports Claude lifecycle hooks as differing until `coord install` or
  `coord onboard` is re-run, which is the documented repair.
- **Codex vim is on but the footer isn't parsed, so the first character is
  lost.** Codex always shows its vim mode, and the launch flag turns vim off.
  The existing `Vim: Normal` tests guard the parse.
- **A docs-only change breaks a product test that reads docs** (as this
  repository's `check:docs` does). A declared documentation profile replaces
  the default; the docs say products with doc-content tests should declare
  their docs checks.
- **Clone-local `editorMode: "normal"` set by the owner is removed on
  uninstall.** It is clone-local and meaningful only to coord; the risk is
  accepted and documented.
- **`perl` is missing.** The filter falls back to plain `cat`, so logging
  continues without stamps.
- **The timestamp lands inside an escape sequence split across a newline.** Raw
  TUI streams are evidence, not replay input; stamps are written only after
  `\n`.
- **The proposal is run from a sub-directory.** Callers pass the product
  worktree root (`requireWorktree`).

## Conclusion

The launch path turns vim off per process for Claude (through the
clone-local settings coord already owns) and Codex (through a `-c` flag), and
makes nudge preludes depend on a vim setting or visible vim evidence. Cursor
stays an owner setting, now documented. Terminal logs get per-line UTC stamps
with tmux-safe escaping. Onboarding gets a default prose-only documentation
profile that exempts docs from code checks, and `--declare` keeps verification
and cache policy across re-onboards. The docs answer where receipts live and
who shares them. There are no new files and no change to the owner's home
configs or runtime config, and every behavior change has a focused test in an
existing file.
