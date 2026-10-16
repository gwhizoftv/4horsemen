# Issue 230 plan: add Muse to the normal agent configuration

## Scope decision

Issue #230 asks for Meta's Muse Code CLI to be added "to the config as part of
the normal config", using the task list in
`docs/issue-210-agent-cli-analysis.md`. That document's section **"Exact future
Muse change map under the current architecture"** stages the work as **R**
(required for an installed participant), **A** (unattended nudge delivery),
**C** (conditional) and **O** (optional). Its **"Bounded follow-up and
acceptance criteria"** step 2 says to "add the minimum installed mode. Use the R
rows and a deliberate pull capability". Step 3 (A rows: hook mapping,
lifecycle events, shell-guard payload decoding, pane readiness, automatic
sends) depends on live Muse payloads and a refusal that this issue cannot
measure. The same document says those must not be advertised until verified.

This plan therefore implements the **R rows plus pull delivery**. After the
change, `coord install --agents …,muse` (and `onboard --agents`) produces a
working Muse clone, launcher and config entry, just like the other agents, and
`coord start` records Muse's version. The A, C and O rows stay as follow-up
work, and the default roster is unchanged (see Alternatives Rejected).

Facts this plan relies on, observed locally in this session from Muse Code
**1.4.9 (1.4.9-R6297.1)** at `~/.local/bin/muse`. I ran only `--version` and
`--help` and read the wrapper as text. No session, login or update was run.

- `muse --help` has no `update` subcommand and no `--add-dir`. It exposes
  `--approval-mode untrusted|on-request|never`, `--disable-sandbox`,
  `--trust-workspace` ("does not save trust") and `--yolo`.
- Meta's permissions page: "Inside the writable workspace, the `.git`, `.muse`,
  and `.agents` directories stay read-only". The only documented ways out of
  that are `--yolo` or `--disable-sandbox`. A sandboxed Muse therefore cannot
  `git commit`, which every Git-mode action requires.
- The installed `muse` file is a Bash wrapper. It honours
  `MUSE_NO_AUTO_UPDATE=1` (skipping its hourly background self-update), then
  `exec`s `muse-bin-<version>` from its own directory (`~/.local/bin`).
- Meta's configuration page: project `AGENTS.md` loads only after the workspace
  is trusted, and `AGENTS.md` is checked before `CLAUDE.md`. Coord's existing
  clone overlay is therefore read without a Claude-style bridge, given
  run-local trust.

## Exact File List to be changed or deleted

Product code:

1. `scripts/lib/launcher.sh`
   - `launcher_environment` (lines 19–33): extend the existing
     `antigravity` PATH branch to `antigravity|muse`, because Muse's installer
     also writes to `~/.local/bin`. For `muse`, also
     `export MUSE_NO_AUTO_UPDATE=1`, so the fresh-start `--version` probe and
     the launched pane use the same binary.
   - `launcher_command` (lines 46–100): add a `muse)` case emitting
     `exec muse --approval-mode never --disable-sandbox --trust-workspace`,
     with a comment explaining why. Muse's sandbox keeps `.git` read-only and
     Muse has no `--add-dir`. An unsandboxed harness can already write the
     mailbox, so `coord_grant` is deliberately not passed (the same reasoning
     as the existing cursor comment, and the same unsandboxed posture as
     antigravity). Amend the header sentence "Every vendor below accepts
     --add-dir" so it names the exceptions.
2. `src/cli.ts`
   - `agentExecutables` (lines 155–157): change the value from a string to
     `{ executable, update }`, where `update` is `true` for codex, claude,
     cursor and antigravity (unchanged `update` step) and `false` for the new
     `muse → muse` entry.
   - `updateAgentVersions` (lines 162–205): in the update loop, a known agent
     whose record has `update: false` prints
     `"<id> has no update command; recording the installed version.\n"` to
     stdout and does not call `run(agent, "update")`. The version loop is
     unchanged, so `muse --version` is still collected. Unknown IDs keep the
     existing "update skipped" warning.
3. `src/setupWorkspace.ts`
   - `agentOwnerUiDefaults` (lines 58–73): add
     `case "muse": return { nudgePrelude: [], nudgeSubmit: ["Enter"], terminalProfile: "Basic" }`.
     Meta's interactive guide documents Enter as submit/steer and Esc as
     interrupting a turn, so the current unknown-ID default (`Escape, Enter`)
     is wrong for Muse. Update the JSDoc sentence.
   - `buildWorkspaceConfig` (lines 364–365): `delivery` becomes
     `agent === "muse" ? "pull" : "both"`, with the comment stating that Muse
     has no lifecycle-hook mapping yet. Doctor
     (`src/doctor.ts:356–368`) already reports nudge/both without a supported
     lifecycle vendor as a finding, and pull keeps it clean.
4. `src/tmux.ts`
   - `vimInsertPrelude` (lines 269–275): add `muse` to the IDs that never get
     a vim prelude (`agentId === "antigravity" || agentId === "codex" || agentId === "muse"`).
     This is the issue-210 "src/tmux.ts:341" site. Without it, an owner
     `coord remind` to a Muse pane types a stray `a` even with
     `nudgePrelude: []` configured. With the new defaults from item 3, the
     stale-bare-Enter repair in `resolveNudgeKeys` (issue-210 "src/tmux.ts:362")
     resolves to `["Enter"]` for Muse without further edits.
5. `src/productIgnore.ts` — `DEFAULT_CLONE_IGNORES` (lines 35–52): add
   `".muse/"` after `".agents/"`.
6. `templates/product/gitignore.coordination.block` — add `.muse/` after
   `.agents/` (line 9). Issue 210 requires these three ignore lists to stay
   aligned.
7. `.gitignore` — add `.muse/` after `.agents/` (line 10).

Example config and maintained documentation:

8. `config.example.json` — append a Muse entry to `agents` (after
   antigravity, line ~42):
   `{ "id": "muse", "root": "../4horsemen-muse", "launcher": "start-muse.sh", "delivery": "pull", "nudgePrelude": [], "nudgeSubmit": ["Enter"], "terminalProfile": "Basic" }`.
   This is the "normal config" example the issue title refers to. The
   existing `test/verify-config.test.ts` schema parse keeps it valid.
9. `README.md` — line 14 roster sentence: add Muse Code as an opt-in agent
   ("…Cursor, Antigravity, and optionally Meta's Muse Code…"). No new badge.
10. `docs/setup-workspace.md` — after the trust paragraph (ends line ~118),
    add one short paragraph:
    - Muse is installed with `--agents …,muse` and uses pull delivery.
    - Its launcher passes run-local `--trust-workspace`, so no persisted trust
      entry is written.
    - It runs `--disable-sandbox --approval-mode never`, because the Muse
      sandbox keeps `.git` read-only.
    - `MUSE_NO_AUTO_UPDATE=1` pins the binary for coord sessions; owners
      update Muse by running it outside coord.
    - Lifecycle hooks, nudges and usage analytics are not yet available for
      Muse.

Tests (extend existing files only):

11. `test/cli.test.ts`
12. `test/install.test.ts`
13. `test/tmux.test.ts`

Nothing is deleted.

## Exact file list to be created

None. No new runtime module, script, fixture or test file is needed. Every
change extends an existing switch, map, list or test (see Reuse and Scope).
Issue 210 also concluded that "no new runtime module is justified for the
first Muse adapter". `scripts/setup_muse.sh` (its conditional legacy-setup
row) is not created, because the supported `coord install` path does not use
it.

## Reuse and Scope

Reused unchanged:

- `write_launcher`, `write_git_wrapper` (`scripts/lib/launcher.sh`): mailbox
  and GitHub-account logic, the git shim, and the `.coord/bin` PATH prepend
  all apply to Muse as they are.
- `validateAgentIds` (`src/install.ts:204`): accepts `muse` once
  `launcher_command muse` succeeds. No TypeScript allowlist edit.
- `agentIdSchema`, `agentConfigSchema`, `deliverySchema`
  (`src/protocol.ts`, `src/state.ts:235`): `muse` and `delivery: "pull"` are
  already valid.
- `agentLabel` (`src/setupWorkspace.ts:123`): the capitalising fallback
  already yields `Muse`, so `KNOWN_AGENT_LABELS` is not edited.
- `agentHarnessProcess`: its default returns `muse`. It is only consulted by
  the nudge `injectionGate` (`src/tmux.ts:1136`), which pull delivery never
  reaches (`src/tmux.ts:1198`, `src/runLoop.ts:1345`, `src/runLoop.ts:2009`).
  The measured foreground name is A-row follow-up work.
- `syncAgentTrust` (`src/agentTrust.ts:54`) and `syncAgentLifecycleHooks` /
  `inspectAgentLifecycleHooks` (`src/agentHookSync.ts:205`, `:293`) already
  return early or report `unsupported` for IDs outside their allowlists. Run-local
  `--trust-workspace` replaces a persisted trust writer (issue-210 C row
  declined).
- `resolveNudgeKeys` (`src/tmux.ts:327`): unchanged. It picks up the new
  defaults and the `vimInsertPrelude` exclusion.
- `liftCloneAgentsProtocol` / the `AGENTS.md` overlay: Muse reads `AGENTS.md`
  natively after trust, so no bridge file like `CLAUDE.md` is needed.
- Test infrastructure: `product()` / `installOnce()` and the stub-harness
  launcher-execution pattern in `test/install.test.ts:857`; `setup()`,
  `fakeLoop`, `successfulStartGit` and the `coord-agent-maintenance` runner
  interception in `test/cli.test.ts:221–301`; the key-resolution assertions in
  `test/tmux.test.ts:265–310`.

Explicitly out of scope (issue-210 A/C/O rows): `src/agentHookSync.ts`,
`src/agentEvent.ts`, `src/shellGuard.ts`, readiness and send sequencing in
`src/tmux.ts`, `src/runLoop.ts` reasons and watchdog, `src/doctor.ts`
messaging, `src/agentTrust.ts`, `src/agentsProtocol.ts`, transcript/analytics
readers, quota evidence, legacy `scripts/setup_*.sh`, the default roster in
`src/install.ts:907`, and `config.product.example.json`.

## Tests

Focused cases, each failing on the baseline and passing after the change:

1. **`test/cli.test.ts`, `describe("fresh-start agent maintenance")`** — new
   `it("records Muse's version without running an update command")`. Add a
   `muse` agent to the fixture config, as the existing antigravity case does.
   The runner intercepts `coord-agent-maintenance`. Assert that:
   - `calls` contains `muse --version` and no `muse update`;
   - `readStartState(...).agentVersions.muse` equals the stub output;
   - stdout contains `muse has no update command`;
   - stderr contains no `WARNING: muse`.

   On the baseline, muse is unknown: it warns "update skipped", skips
   `--version` and records `null`.
2. **`test/install.test.ts`, `describe("generated agent launchers")`** — new
   `it("launches Muse unsandboxed with pull delivery and no self-update")`
   beside the Antigravity case at line 1220. Run
   `installOnce(fixture, { agents: ["muse"], completesRoot, home })` and
   create the issue-17 drop, responses, inputs and worktrees directories. Put
   a stub `muse` in `$HOME/.local/bin` that writes its argv and
   `$MUSE_NO_AUTO_UPDATE` to `$CAPTURE`. Execute `start-muse.sh` with
   `/bin/bash` and `COORD_ISSUE=17`. Assert that:
   - argv is exactly `["--approval-mode", "never", "--disable-sandbox", "--trust-workspace"]`
     (no `--add-dir`);
   - the captured env value is `1`;
   - the emitted config entry has `delivery: "pull"`, `nudgePrelude: []`,
     `nudgeSubmit: ["Enter"]`;
   - `DEFAULT_CLONE_IGNORES` and `templates/product/gitignore.coordination.block`
     both contain `.muse/`.

   On the baseline, install throws "No launch command is defined for agent 'muse'".
3. **`test/tmux.test.ts`, the existing
   `it("sends vim a for Cursor only when editor.vimMode is on and the pane is not INSERT")`
   block (line 265)** — add these assertions:
   - `vimInsertPrelude("> ", "muse")` is `[]`;
   - `resolveNudgeKeys({ id: "muse", root: "/m", launcher: "x", delivery: "pull" }, "> ")`
     equals `{ prelude: [], submit: ["Enter"] }`;
   - the same result with explicit `nudgePrelude: []` and `nudgeSubmit: ["Enter"]`.

   On the baseline, each yields `{ prelude: ["a"], submit: ["Escape", "Enter"] }`,
   the trace reproduced in issue 210.

Commands while developing:

- `pnpm vitest run --config vitest.system.config.ts test/cli.test.ts test/install.test.ts`
- `pnpm vitest run --config vitest.config.ts test/tmux.test.ts test/verify-config.test.ts`

The pre-commit hook owns `pnpm check:fast`, and the coordinator owns the final
`pnpm check` at the approved pin. Neither is duplicated or claimed by the
implementer.

Owner-side live acceptance cannot run in CI and is not claimed by this issue.
In a disposable Muse workspace, the owner confirms that:

- the launched pane loads `AGENTS.md`;
- `git commit`/`git push` succeed;
- the agent can write the mailbox `complete` file;
- the git shim refuses `git status` through Muse's shell tool, which proves
  `COORD_ISSUE` and PATH reach it.

## Alternatives Rejected

- **Full unattended integration now (issue-210 A rows):** Muse hook payloads,
  Stop behaviour, cleared-environment issue binding for the shell guard,
  foreground process name and pane chrome are all unmeasured. Issue 210 says
  not to advertise unattended support until they pass. Shipping guessed
  mappings would risk steering into or interrupting live turns. Pull delivery
  is the documented first step.
- **Keep Muse sandboxed and render vendor-specific grants (`--workspace`
  instead of `--add-dir`):** `--workspace` is not shown to be an additive
  writable grant. Even if it were, the sandbox keeps `.git` read-only, so
  commits fail. That makes grant rendering a design project with no
  functioning result.
- **`--yolo`:** it also withholds `request_user_input` and bundles several
  effects. Explicit `--approval-mode never --disable-sandbox --trust-workspace`
  states each needed property and matches how the codex and antigravity lines
  are written.
- **Generic "pull when no lifecycle mapping" rule in `buildWorkspaceConfig`:**
  it would also change the existing `gemini` default from `both` to `pull`,
  a behaviour change outside this issue.
- **Adding Muse to the default roster (`src/install.ts:907`, onboard help):**
  every default install would then require a Muse installation and account.
  Issue 210 lists this as an optional product choice. `--agents …,muse` is
  sufficient.
- **A vendor registry module (`src/vendors.ts`):** issue 210 rejected this for
  the next harness (nine-file migration with no reduction in behavioural
  work).
- **Letting coord update Muse (e.g. invoking the wrapper with
  `MUSE_SYNC_UPDATE=1`):** this relies on undocumented wrapper internals and
  network/auth during `coord start`. Recording the version and leaving updates
  to the owner is predictable.

## Risks and Mitigations

- **Unsandboxed agent.** Muse can write anywhere the owner can, which is the
  same posture as antigravity today. Mitigation: the git shim, hooks-installed
  product checks and coordinator pin verification are unchanged. The launcher
  comment and docs say why the sandbox is disabled.
- **Containment coverage is unverified for Muse.** No native shell hook is
  installed, so only the PATH shim applies, and only if Muse's shell inherits
  `COORD_ISSUE` and PATH. Mitigation: `coord status` already reports
  unverified coverage as a warning. The join-action containment probe records
  the actual result. Docs state hooks are not yet available.
- **Muse never self-updates under coord** (`MUSE_NO_AUTO_UPDATE=1`).
  Mitigation: the recorded version matches the launched binary for the whole
  issue. Owners update by running `muse` normally, outside coord. This is
  documented in `docs/setup-workspace.md`.
- **CLI flag drift.** A future Muse may rename the flags. Mitigation: the
  launcher test pins the exact argv. Live acceptance is listed separately
  rather than claimed.
- **Owner `coord remind` key semantics are documented, not measured** (Enter
  submits or steers into an active turn). Mitigation: no Escape is ever sent
  to Muse, avoiding the documented interrupt. Owners remind an idle pane, as
  with other pull agents.
- **Docs/example drift.** `config.example.json` is parsed by
  `test/verify-config.test.ts`, the three ignore lists are asserted together
  in test 2, and `pnpm check:docs` covers README and setup-workspace.

## Conclusion

Implement issue-210's minimum installed mode for Muse:

- a `muse` launcher case (unsandboxed, run-local trust, no self-update);
- a fresh-start maintenance record that records Muse's version without a
  nonexistent `update` command;
- pull delivery and Enter-only owner keys in the generated config, with the
  stray vim prelude removed for Muse;
- `.muse/` in all three ignore lists;
- an opt-in example config entry and two short docs updates.

This is 10 existing files plus 3 existing test files, with no new files.
Unattended nudge delivery, hooks, shell-guard decoding, analytics and quota
support stay as issue-210's measured follow-up work.
