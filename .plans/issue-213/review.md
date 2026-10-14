# Issue 213 plan review (claude)

Bound plans reviewed:
- cursor `f1b3bd9cb1dd3370444e4a124804a94d51ed9b1d`
- codex `72d0d35408bc60cf73a810bc6b6d66342305afc0`
- antigravity `4c307345adbe457cfc21510e62e12fafc8bac279`
- claude `a7a3dfd24fa79d2a7ce68003539116cb2114ef50`

All four are read from the bound input copies.

Vendor facts marked *probed* were checked on this machine on 2026-10-14 in
throwaway directories and private tmux sockets, not in any clone. Versions:
Claude Code 2.1.299, codex-cli 0.162.1, Cursor agent 2026.10.14-0f9edde, and
tmux with `/usr/bin/perl`.

## Findings

### F1. cursor and antigravity: writing `editor.vimMode` into the clone's `.cursor/cli.json` (blocking)

- **Plan claim.**
  - cursor: "Exact File List", `src/setupWorkspace.ts` adds
    `ensureCursorAgentVimOff`, which merges `editor.vimMode: false` into
    `<clone>/.cursor/cli.json`. `src/install.ts` calls it, and `src/tmux.ts`
    `launchAgent` calls it before every respawn. The plan states "Cursor's
    CLI merges that project file over `~/.cursor/cli-config.json`".
  - antigravity: `src/setupWorkspace.ts` "ensure Cursor's clone
    `.cursor/cli.json` specifies `{"editor": {"vimMode": false}}`".
- **Rule.** Coord must not write vendor configuration that the vendor
  rejects. A launch change must leave the harness able to start.
- **Failure.** *Probed:* with `{"editor":{"vimMode":false}}` in
  `<dir>/.cursor/cli.json`, `agent` printed `a/.cursor/cli.json: schema
  validation failed ... "Unrecognized key(s) in object: 'editor'"` and did not
  start. The project file accepts permissions only, as codex's plan also
  notes from Cursor's documentation.
  - Followed as written, every cursor pane fails to launch after install. With
    cursor's version, every relaunch fails too, because `launchAgent` rewrites
    the file each time.
  - cursor's `test/install.test.ts` assertion would still pass, because it
    checks the file contents, not a launch.
- **Smallest correction.** Drop the overlay. Leave Cursor's vim setting to the
  owner's `~/.cursor/cli-config.json`, which `readCursorVimMode` already reads.

### F2. cursor, codex and antigravity: Claude launcher gains `--settings '{"editorMode":"normal"}'`

- **Plan claim.**
  - cursor: `scripts/lib/launcher.sh` Claude line.
  - codex: "1. Make generated launchers...", Claude bullet.
  - antigravity: `scripts/lib/launcher.sh`, `claude` bullet.
- **Rule.** A launch change must not disable an existing coord capability.
  `src/claudeStatusLine.ts:106` returns `ambiguous` ("the launcher passes
  --settings, which outranks clone-local settings") whenever the launcher
  text matches `--settings`.
- **Failure.** Once the regenerated launcher is installed:
  - `syncClaudeStatusLine` disables the Claude quota status-line tee in every
    workspace (exercised by `test/agentHookSync.test.ts:322`).
  - `coord doctor` reports a `resourceTelemetry` finding for every Claude
    clone (`test/doctor.test.ts:121`).
  - Quota evidence for Claude resource holds disappears. None of the three
    plans lists `src/claudeStatusLine.ts` or these tests.
- **Smallest correction.** Put `"editorMode": "normal"` in the clone-local
  `.claude/settings.local.json` that `agentHookSync.ts` already owns.
  *Probed:* Claude honors it there (no vim indicator), while a control pane on
  the owner's settings shows `-- INSERT --`. That leaves the launcher without
  `--settings`.

### F3. antigravity: Claude and Codex preludes are not changed after vim is turned off (blocking)

- **Plan claim.** "Exact File List" changes only `agentOwnerUiDefaults`
  (Codex `nudgePrelude: []`) and does not touch the prelude logic in
  `src/tmux.ts`. "Risks" says clearing the Codex default prevents a stray
  `i`.
- **Rule.** After a launch change turns vim off, a nudge must not type a
  prelude key as literal text.
- **Failure, Claude.** `vimInsertPrelude` (`src/tmux.ts:306`) returns `["a"]`
  for Claude whenever `-- INSERT --` is absent. A vim-off Claude never shows
  it (*probed*), so every Claude nudge becomes `a Read and execute
  coordinator action …`. The leading space is from #206.
- **Failure, Codex.** The defaults change does not reach existing configs:
  `config.example.json` and this workspace's runtime config set codex
  `nudgePrelude: ["i"]` explicitly. `nudge()` (~L1283) drops the prelude only
  when `Vim: Insert` is visible, and a vim-off Codex shows no `Vim:` footer
  (*probed*). So those workspaces type `i Read and execute …`.
- **Smallest correction.**
  - Codex: send `i` only on positive `Vim: Normal` evidence, at both send
    sites (cursor's and claude's plans do this).
  - Claude: decide from the coord-written `editorMode`. *Probed:* Claude's
    vim NORMAL also shows no indicator, so pane text cannot tell NORMAL from
    vim-off.

### F4. antigravity, cursor and codex: tmux `%` expansion in the `pipe-pane` command is not handled

- **Plan claim.**
  - antigravity: `pipeToLog` runs
    `/usr/bin/perl -pe '... strftime("[%Y-%m-%dT%H:%M:%SZ] ", gmtime)'` "with
    `#` doubled".
  - cursor: a `perl` one-liner writing a timestamp sidecar. It names only `#`
    escaping.
  - codex: an inline Node recorder rendered with "tmux `#` escaping". It does
    not mention `%`.
- **Rule.** tmux runs the `pipe-pane` command through strftime, so every `%`
  in the rendered command must be doubled, alongside the existing `#`
  doubling (`src/tmux.ts:727`).
- **Failure.** *Probed* with real tmux: a perl stamp using
  `printf "%s.%03dZ ", strftime("%Y-…")` produced lines starting
  `1791997135.3dZ`. tmux had replaced `%s` with epoch seconds and eaten
  `%0`. With `%` doubled it produced `2026-10-14T16:59:11.715Z`.
  - antigravity's command, as written, produces corrupted stamps in every log.
  - cursor's sidecar timestamps are corrupted in the same way.
  - codex's recorder breaks if its source or arguments contain `%`.
- **antigravity only.** `perl -pe` buffers until newline, so a TUI prompt line
  without `\n` reaches the log late and is stamped at completion, not at
  first byte.
- **Smallest correction.** Double `%` together with `#`, and assert the stamp
  format in the existing isolated-tmux test (`test/tmux.test.ts` ~L1352),
  which runs real tmux and therefore catches this.

### F5. antigravity: an empty or "minimal" documentation check list without a schema change

- **Plan claim.** "Exact File List", `src/setupWorkspace.ts`: when there is
  no `check:docs`, `verify: { precommit: [], prepush: [] }` "and minimal
  check". `src/state.ts` is not in the file list.
- **Rule.** `documentationProfileSchema.checks` is `.min(1)`
  (`src/state.ts:146-150`), and `buildWorkspaceConfig` parses through
  `coordinatorConfigSchema`. A proposal must either satisfy the schema or
  change it in the file map.
- **Failure.** "Minimal check" names no command.
  - With `checks: []`, `buildWorkspaceConfig` throws and onboarding fails for
    every product without `check:docs`.
  - With an invented command, the final gate runs an undeclared dummy, which
    the issue asked to avoid.
- **Smallest correction.** Add `src/state.ts` to the file map and allow an
  empty documentation `checks` list. Empty lists already pass through hooks
  (`src/hookPolicy.ts:224`) and coordinator gates (`src/runLoop.ts:2916`).

### F6. antigravity: launcher tests placed in the wrong file, and the existing exact-argv test not updated

- **Plan claim.** "Tests": assert the launcher flags in `test/cli.test.ts`.
  `test/install.test.ts` is not in the file map.
- **Rule.** Tests must extend the existing file that owns the behavior. A
  change to launch argv must update the test that pins it.
- **Failure.** `test/install.test.ts` (~L794) executes the generated
  launchers and asserts the codex argv exactly
  (`["-c", "check_for_update_on_startup=false", "--ask-for-approval", ...]`).
  Adding `-c tui.vim_mode_default=false` makes it fail, and the hook's
  `check:fast` (system suite) blocks the product commit. `test/cli.test.ts`
  does not render launchers from `launcher_command`.
- **Smallest correction.** Update the exact-argv expectation in
  `test/install.test.ts`.

### F7. cursor and antigravity: onboarding defaults every product to `verification.mode: "coordinator"` with guessed caches

- **Plan claim.**
  - cursor: `proposeProjectPolicy` writes `mode: "coordinator"` for every
    recognized toolchain, and caches Node checks including `check` (which runs
    `pnpm build`) with `dependencies: ["node_modules"]`.
  - antigravity: the same mode, plus caches on the final `checks`.
- **Rule.** A cache receipt is safe only when every input the command reads is
  declared. `docs/setup-workspace.md` "Caching": "Never cache a command that
  reads Git history, commit identity, external services or undeclared
  environment". An opaque script cannot be shown to meet that. The issue asks
  how these blocks are created and whether onboarding should help; it does not
  ask for every product to change hook binding.
- **Failure.**
  - A product whose `check` script reads `git describe`, an env var or
    network state reuses a stale `tree-excluding-evidence` receipt, and the
    final gate passes on a cached success.
  - Every onboarded product's hooks switch to `coordinated` lists in
    automated runs, a behavior change that the issue-209 analysis rates as
    net-unknown for R4/R6.
  - cursor's own Risks note that a reinstall replaces a hand-edited block.
- **Smallest correction.** Keep `verification`/`cache` owner-declared, and
  let `coord onboard --declare` carry them (codex's and claude's plans).

### F8. cursor: a `documentation.prefixes` rule in the classifier

- **Plan claim.** `src/state.ts` adds `prefixes`, and
  `src/changeClassification.ts` treats any path under `docs/` as
  documentation.
- **Rule.** Existing policy is "Opt-in prose/image allowlist; never infer
  documentation" (`src/state.ts:145`). The shipped-examples test pins "a
  focused docs profile, not a Markdown-wide exemption"
  (`test/verify-config.test.ts:228`).
- **Failure.** A docs-site build script or config under `docs/` (for example
  `docs/conf.py` or `docs/build.mjs`) becomes exempt from product checks at
  commit, push and the final gate. A broken build is then merged on a
  "documentation" classification.
- **Smallest correction.** Propose exact tracked paths at onboarding and keep
  the classifier unchanged (codex's and claude's plans).

### F9. codex: Cursor configuration snapshot through `CURSOR_CONFIG_DIR`

- **Plan claim.** "1. Make generated launchers...", Cursor bullet: copy the
  owner's `cli-config.json` into `.coord/cursor-config/cli-config.json` with
  `editor.vimMode: false`, point `CURSOR_CONFIG_DIR` at it, and refresh it
  from the original on each launch.
- **Rule.** Coord must not duplicate vendor credentials into an agent clone,
  and must not silently discard state the vendor persists.
- **Failure.** On this machine, `~/.cursor/cli-config.json` contains an
  `authInfo` key along with `permissions`, `approvalMode`,
  `modelSelectionHistory` and caches. Cursor rewrites that file during
  sessions (its mtime matches today's session, and an atomic-write `.tmp`
  sibling is present).
  - The snapshot copies credentials into the agent's own workspace, where the
    agent can read them.
  - Approvals, model selections and any token refresh that Cursor writes
    during a run go to the snapshot and are overwritten at the next launch.
    The two copies diverge whenever tokens rotate.
  - The plan's claim that the env var leaves `chats/`, `projects/`, `plans/`
    and `skills-cursor/` in place is supported only by a fixture, not by a
    real Cursor launch.
- **Smallest correction.** Do not redirect Cursor's config. Document the
  owner's global `editor.vimMode` setting, which coord already honors.

### F10. codex: re-onboarding preserves the previous workspace policy

- **Plan claim.** "3. Give onboarding an explicit route...": "precedence is
  explicit declaration, then matching existing workspace policy, then
  generated proposal", preserving existing checks, verify lists, critical
  paths and docs.
- **Rule.** `src/install.ts:352-375` deliberately carries over only the stamp
  timestamp. `readPreviousConfig` tolerates an unparsable config because
  "regenerating is the repair". Policy that must persist belongs in a
  declaration.
- **Failure.** After a product renames or removes a script (for example
  `check:fast`), re-running onboard keeps the stale `verify` argv. Every agent
  commit then fails on a missing script, and the documented repair (re-run
  onboard) no longer repairs it unless the owner writes a declaration.
  - A generated docs allowlist frozen at first onboarding never picks up
    later documents.
  - The issue is already solved by `onboard --declare` in the same plan; the
    preservation layer is extra scope.
- **Smallest correction.** Keep regeneration. Add `--declare` to onboard and
  document that hand edits belong in the declaration.

### F11. claude (self-review): the docs allowlist is fixed at onboarding

- **Plan claim.** "Exact File List", `src/setupWorkspace.ts`: the
  documentation profile is the exact tracked root and `docs/` Markdown files
  at onboarding.
- **Rule.** The classifier only exempts exact listed paths.
- **Failure.** A docs-only issue that creates a new file (such as issue 209's
  `docs/issue-209-efficiency-analysis.md`) is classified as product and runs
  the full suite until the owner re-onboards. This narrows the benefit but is
  not unsafe.
- **Smallest correction.** None required. State in the docs that re-running
  onboard refreshes the allowlist, which the plan's regeneration model
  already provides.

### Scope, reuse, new files and tests

- **New files.** None of the plans adds a product source or test file.
- **cursor.** Reuse is good. Scope is too wide: default coordinator mode,
  guessed caches and classifier prefixes (F7, F8).
- **codex.** Reuse of the install/declaration path is strong, and the
  "validate the declaration before effects" point is good. Scope is wide:
  policy preservation, a setup summary, an explicit `{mode:"local"}` default,
  a migration whitelist recipe and the Cursor snapshot (F9, F10). The recorder
  tests are focused.
- **antigravity.** It misses the prelude, schema and test-ownership work that
  its own launch change requires (F3, F5, F6). Its test list is focused but
  aimed at the wrong file for launchers.
- **claude.** Seven focused cases, all in existing files, and the vendor
  behavior it relies on was probed. F11 is a minor limitation.

## Conclusion

The cursor and antigravity plans should not be selected as written:
- Each would stop every Cursor pane from launching (F1).
- Each would disable Claude quota telemetry (F2).
- antigravity's version would also type a stray `a`/`i` into every Claude
  nudge and into Codex nudges for workspaces with an explicit `i` prelude
  (F3). It produces corrupted log timestamps (F4) and leaves the docs profile
  either unspecified or rejected by the schema (F5).

The codex plan is closer and shares the right `onboard --declare` route, but
it needs these corrections:
- Remove the Claude `--settings` flag (F2).
- Add `%` escaping (F4).
- Drop the Cursor credential snapshot (F9).
- Drop policy preservation (F10).

The claude plan avoids F1–F10. Its only finding (F11) is a documented
limitation, not a defect. I recommend the claude plan. Either way, the
selected plan must not write Cursor `editor` keys, must not add `--settings`
to the Claude launcher, must double `%` in the `pipe-pane` command, and must
gate Claude and Codex preludes on a vim setting or visible vim evidence.
