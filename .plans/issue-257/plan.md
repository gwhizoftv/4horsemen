# Issue 257 plan — OpenCode participant, with OpenRouter as its provider

Baseline: `ac57c3a543ff2c6f3f16e5bc3f46c61efb1c4d52` (v0.0.91).

## Scope decision

The issue offers two routes: a `model` in the runtime `config.json`, or running
OpenCode in our tmux pane and letting the owner `/connect` → OpenRouter →
`/models`. This plan takes the **second** route and makes OpenCode a supported
**opt-in, pull-delivery** participant: `coord onboard --agents …,opencode`
produces a working `start-opencode.sh`, records its version at `coord start`,
and does not promise unattended nudging. OpenRouter is not a separate agent; it
is a provider configured inside OpenCode, with credentials in OpenCode's own
credential store and never in coordinator artifacts.

This is the same staging Muse used: issue 230 added an opt-in Muse with pull
delivery, and a terminal adapter came later (issue 235) once a live pane had
been measured. No OpenCode binary is on this machine, so no OpenCode screen can
be measured here. Shipping `delivery: "both"` without an adapter is unsafe today:
`harnessPromptReadiness` returns ready for unknown ids (`src/tmux.ts:344`), and
`resolveNudgeKeys` sends a vim `a` prelude plus Escape/Enter (`src/tmux.ts:357`,
`src/setupWorkspace.ts:83`). That could type into OpenCode's provider menu or
interrupt a running turn.

Vendor facts this plan relies on (OpenCode docs, read 2026-10-29):

- The install script writes the binary to `$HOME/.opencode/bin` (`INSTALL_DIR=$HOME/.opencode/bin`, with no override). npm/Homebrew installs land on PATH.
- `OPENCODE_DISABLE_AUTOUPDATE` disables update checks.
- `OPENCODE_PERMISSION` takes an inline JSON permission config. `edit` and `bash` default to `allow`; `external_directory` and `doom_loop` default to `ask`. Directory grants are written `{"external_directory": {"<path>/**": "allow"}}`.
- There is no `--add-dir` flag. `--version` prints the version. `--model provider/model` selects a model, and so does a `model` key in OpenCode's own config.
- OpenCode reads `AGENTS.md` as project rules, so the existing protocol overlay is its instruction path.

## Exact File List to be changed or deleted

1. `scripts/lib/launcher.sh`
   - `launcher_environment`: when `$1 == opencode`, prepend `$HOME/.opencode/bin` to the vendor search path. This runs beside the existing `~/.local/bin` branch and before resolution, so an install-script binary is found under a login PATH. Also `export OPENCODE_DISABLE_AUTOUPDATE=1` for `opencode`, next to the existing `MUSE_NO_AUTO_UPDATE` line. That export applies to launches and to `coord start` version collection alike.
   - `launcher_executable`: add `opencode` to the `claude|codex|gemini|muse` identity case.
   - `launcher_command`: add an `opencode)` case. OpenCode has no `--add-dir`, so the generated lines convert the existing `coord_grant` pairs into an external-directory grant instead of passing flags. They skip each `--add-dir` element and escape `\` and `"` in each path, the same way the split-shebang branch already quotes the Node path. Each directory becomes `"<dir>/**":"allow"`. If at least one directory was granted, the lines export `OPENCODE_PERMISSION='{"external_directory":{…}}'`. They then run `exec "${coord_agent_cmd[@]}"` with no flags. With no current issue (manual mode) `coord_grant` is empty and `OPENCODE_PERMISSION` is left unset. The grant covers the same four directories other harnesses receive (completion drop, own responses directory, `inputs`, `worktrees`) and nothing wider. The case comment says, as the Muse case does, that native hooks and live containment are unverified and only the PATH Git shim applies.
2. `src/setupWorkspace.ts`
   - `buildWorkspaceConfig`: change `delivery: "both"` to `delivery: hasTerminalDeliveryAdapter(agent) ? "both" : "pull"`. Every id that currently has an adapter (claude, codex, cursor, antigravity, muse) keeps `"both"`. An id without one, now including `opencode`, is generated as pull, which is what the doctor remediation at `src/doctor.ts:367` already demands. No existing test installs an adapter-less id (checked: every `agents: [...]` fixture uses claude, codex, cursor or muse).
   - `KNOWN_AGENT_LABELS`: add `opencode: "OpenCode"`. Without it the launcher banner reads "Opencode" and so do the commit label and Terminal-window titles.
3. `src/cli.ts` — `agentExecutables`: add `["opencode", { executable: "opencode", update: false }]`. `coord start` then records `opencode --version` in `start.json` `agentVersions` instead of warning "update skipped: no known vendor command". `update: false` matches Muse: the validated version is not changed mid-run, and the owner upgrades OpenCode deliberately.
4. `src/productIgnore.ts` — add `".opencode/"` to `DEFAULT_CLONE_IGNORES` beside `".muse/"`. `.opencode/` is OpenCode's documented project config directory (agents, commands, plugins). Anything OpenCode or the owner places there is clone-local harness state and must not be offered for commit, which is the rule this list exists for.
5. `.gitignore` — add `.opencode/` to stay aligned with `DEFAULT_CLONE_IGNORES` (the existing install test asserts this alignment for `.muse/`).
6. `templates/product/gitignore.coordination.block` — add `.opencode/` for the same alignment.
7. `docs/setup-workspace.md` — add an "OpenCode (OpenRouter)" subsection after the Muse section. It covers:
   - Opt-in only: `--agents codex,claude,opencode`. The default roster is unchanged.
   - Pull delivery and why: no measured terminal adapter yet.
   - Install locations the launcher searches.
   - OpenRouter onboarding inside the pane: `/connect` → OpenRouter → key, then `/models`. Credentials stay in OpenCode's store.
   - A deterministic default model: run `opencode models openrouter` to get the exact id, then set `"model": "openrouter/<id>"` in OpenCode's own `~/.config/opencode/opencode.json`. Prefer a tool-capable model.
   - The `OPENCODE_PERMISSION` external-directory grant, and that it replaces any `OPENCODE_PERMISSION` the owner exported.
   - Fetching the action with `coord next --issue <n>` (the launcher banner already says this).
   - That hooks, telemetry and containment are unverified until measured, with the probe reported honestly as `unknown`/`executed`.

Unchanged on purpose:

- `src/state.ts`: no `model` field.
- `src/tmux.ts`: no adapter.
- `src/agentEvent.ts`: no lifecycle mapping.
- `src/install.ts`: `DEFAULT_AGENTS` stays as is.
- `src/doctor.ts`: its existing check already accepts pull and rejects `both` without an adapter.
- `githooks/`: post-merge reuses `write_launcher` unchanged.

## Exact file list to be created

None. All new behaviour joins the existing launcher template, vendor table, ignore list and docs. The new tests join existing test files (see Tests).

## Reuse and Scope

Reused:

- `write_launcher` / `launcher_environment` / `launcher_executable` / `launcher_command` in `scripts/lib/launcher.sh`. These are the single template that `coord install` (`writeAgentLauncher`, `src/setupWorkspace.ts`) and `githooks/post-merge` both render. Adding a case there automatically covers both callers.
- The existing `coord_grant` computation in `write_launcher`. The OpenCode case translates the same directory list rather than computing its own, so its grant scope cannot drift from the other harnesses'.
- The existing `.coord/bin/git` shim and PATH ordering in `write_launcher`, unchanged.
- `hasTerminalDeliveryAdapter` in `src/setupWorkspace.ts`, already the doctor's authority (`src/doctor.ts:360`), now also chooses the generated delivery mode.
- `agentExecutables` and `updateAgentVersions` in `src/cli.ts`, including the `update: false` path built for Muse ("has no update command; recording the installed version").
- `DEFAULT_CLONE_IGNORES` and the two mirrored ignore files.
- `inspectAgentLifecycleHooks` returns `unsupported` for an unknown vendor (`src/agentHookSync.ts:301`). Combined with pull delivery, doctor reports no lifecycle finding. No new vendor enum.

Test fixtures reused: `product`, `installOnce`, `readConfig` and `git` in `test/install.test.ts`. The Muse launch case there is the template for the new one. Also `setup`, `fakeLoop` and `successfulStartGit` in `test/cli.test.ts`, and `installed` and `report` in `test/doctor.test.ts`.

No new files, abstractions or dependencies. Out of scope, as follow-ups that need a live OpenCode:

- An OpenCode terminal adapter for `delivery: "both"`.
- A plugin or server-API lifecycle mapping. `session.idle` must never count as completion.
- A coordinator-side `model` field.

## Tests

The new cases join existing files and are run with `pnpm vitest run --config vitest.config.ts test/install.test.ts test/cli.test.ts test/doctor.test.ts` while developing. If any of them is in the system config, run the matching `vitest.system.config.ts` file. The pre-commit hook owns `pnpm check:fast`.

1. `test/install.test.ts` — new case beside "launches Muse unsandboxed…": **"launches OpenCode from ~/.opencode/bin with pull delivery, scoped directory grants and no self-update"**.
   - Install `agents: ["opencode"]` with a `completesRoot` and `home` containing spaces, and create the four issue-17 grant directories.
   - Put a stub `opencode` in `<home>/.opencode/bin`. It records `"$@"`, `$OPENCODE_DISABLE_AUTOUPDATE`, `$OPENCODE_PERMISSION`, `$(command -v git)` and `$COORD_ISSUE`.
   - Run `start-opencode.sh` with `PATH=/usr/bin:/bin` for `COORD_ISSUE=17` and for manual (`""`).
   - Assert:
     - no arguments are passed;
     - `OPENCODE_DISABLE_AUTOUPDATE=1`;
     - git resolves to `<clone>/.coord/bin/git`;
     - for issue 17, `JSON.parse(OPENCODE_PERMISSION)` equals `{ external_directory: { "<drop>/**": "allow", "<responses>/**": "allow", "<inputs>/**": "allow", "<worktrees>/**": "allow" } }`, which proves escaping survives spaces;
     - for manual mode, `OPENCODE_PERMISSION` is empty;
     - the config agent is `{ id: "opencode", delivery: "pull", harnessProcess: "opencode" }`;
     - `.opencode/` is in `DEFAULT_CLONE_IGNORES`, `.gitignore` and the template block, and `git check-ignore .opencode/x` matches.

   Before the change this fails: `launcher_command opencode` returns 1, so install throws "No launch command is defined for agent 'opencode'".
2. `test/cli.test.ts` — extend "records Muse's version without running an update command" so it also pushes an `opencode` agent (pull, stub launcher). Assert:
   - `"opencode --version"` follows `"muse --version"` in the maintenance calls;
   - `agentVersions.opencode` is recorded;
   - the output contains "opencode has no update command";
   - there is no `WARNING: opencode`.

   Before the change this fails: there is no `agentExecutables` entry, so a warning is printed and no version is recorded.
3. `test/doctor.test.ts` — new case beside the Muse doctor case: **"accepts OpenCode on pull delivery without lifecycle hooks or a terminal adapter"**. `installed(undefined, "go", ["opencode"])` produces `delivery: "pull"`, and `report(fixture)` returns `{ findings: [], exitCode: 0 }`. Before the change, install throws.

Live acceptance is owner-attended and not claimed by these tests. With a real OpenCode and an OpenRouter tool-capable model:

- start an issue with `--agents codex,opencode` (or `claude,opencode`);
- confirm `/connect` and `/models` work in the pane;
- run `coord next`, a Git-mode action through `complete`/`ready`, a response-mode ballot, and a second consecutive action;
- run the actual-tool containment probe;
- restart the pane;
- check the clone stays clean.

The documentation records the version used.

## Alternatives Rejected

- **A `model` field in `agentConfigSchema` passed as `--model`.** This needs a schema change, persistence across reinstall, and launcher propagation. `write_launcher` deliberately takes four arguments because `githooks/post-merge` cannot supply per-workspace values, and the launcher deliberately never parses the workspace JSON. OpenCode already persists a model in its own config, and the issue accepts in-pane selection. It can be a follow-up if owners need per-workspace models.
- **`delivery: "both"` now, with guessed OpenCode screen patterns.** These would be unmeasured patterns, and the fallback behaviour (ready by default, vim `a`, Escape) can corrupt a menu or interrupt a turn. Muse's history shows adapters need a measured pane.
- **`opencode --auto`, or `external_directory: "allow"` for everything.** This is wider than the grant every other harness receives. The scoped grant costs a few lines, and `edit`/`bash` already default to allow inside the clone.
- **A separate OpenRouter agent or direct API integration.** OpenCode is the harness and OpenRouter is its provider. A second agent duplicates launch, protocol and containment work for no gain.
- **Adding `opencode` to `DEFAULT_AGENTS`.** Every default onboarding would then create a clone for an unvalidated, pull-only harness. Opt-in matches the Muse first phase.
- **Special-casing `opencode` in `buildWorkspaceConfig` instead of keying delivery on `hasTerminalDeliveryAdapter`.** That would keep generating `both` for other adapter-less ids, which doctor then rejects. Using the existing predicate is one expression and makes install agree with doctor.

## Risks and Mitigations

- **OpenCode may ask before reading external paths outside the grant**, such as the agent's `action.md`, which is not granted to any harness. Mitigation: the docs direct OpenCode to `coord next --issue <n>`. That is a shell command with no external path, so `bash` (default allow) covers it, and pull mode is owner-attended, so a one-time approval does not stall unattended work.
- **`doom_loop` defaults to ask.** Pull mode is attended. This is documented as a known prompt and not overridden.
- **Glob metacharacters (`*`, `?`) in a granted path** would widen or break the pattern. Coordinator-created paths come from the owner's runtime and completes roots. The docs note the limitation; escaping `\` and `"` keeps the JSON valid, and the test proves it with spaced paths.
- **An owner-exported `OPENCODE_PERMISSION` is replaced during automated issues.** This is documented. The owner's config-file permissions still apply.
- **The `.opencode/` ignore may hide an owner's intended project config.** A clone is agent-local, and the product's tracked tree is untouched, so product-level `.opencode/` config in the product repo is unaffected by the clone exclude. The same applies to `.muse/` and `.cursor/`.
- **The npm `opencode-ai` install is a Node launcher script.** `launcher_environment`'s existing shebang handling runs it with coordination's Node, as it does for other Node-based CLIs.
- **Containment and telemetry are unverified.** `coord status` already reports unverified hook coverage for vendors without lifecycle mappings. The probe must report the observed result, never an assumed one.
- **The pull-delivery change for adapter-less ids** changes generated config only for ids without an adapter. Those were previously generated as `both` and then failed doctor, so this repairs an inconsistency rather than regressing a working path.

## Conclusion

Add OpenCode as an opt-in, pull-delivery coordination participant. OpenRouter is configured inside OpenCode (`/connect`, `/models`, or OpenCode's own `model` config), and credentials stay out of coordinator artifacts. The change touches:

- the shared launcher template: executable lookup in `~/.opencode/bin`, autoupdate off, and a scoped `OPENCODE_PERMISSION` grant built from the existing `coord_grant`;
- one vendor-table row for version recording;
- delivery generated from the existing adapter predicate;
- a label;
- a `.opencode/` clone ignore in its three aligned places;
- documentation.

Three focused test changes in existing files prove launcher behaviour, version recording, and a clean doctor report. Automatic terminal delivery, lifecycle events and a coordinator `model` field are deferred until a live OpenCode pane has been measured.
