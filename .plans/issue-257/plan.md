# Issue 257 — OpenCode with OpenRouter model selection

Protocol version: 1. Baseline: ac57c3a543ff2c6f3f16e5bc3f46c61efb1c4d52.
Scope comes from the coordinator's frozen issue snapshot, “Support for
OpenCode / OpenRouter.” No peer input is bound to this planning action.

Add an opt-in OpenCode participant that opens its interactive TUI in the existing
per-agent tmux window. An owner can either select a model in the runtime agent
configuration or leave it unset and use OpenCode's /connect and /models commands.
OpenRouter is a provider used through OpenCode, not a separate agent executable.
This plan implements the issue's interactive route with pull delivery and explicit
owner reminders. It does not advertise unattended delivery without a measured
OpenCode terminal adapter.

## Exact File List to be changed or deleted

No files will be deleted. Change exactly these existing files:

- `src/state.ts`: add an optional OpenCode-only agent `model` string; validate
  provider/model syntax while allowing further slashes in the model identifier.
  Reject empty strings, whitespace/control characters, malformed provider/model
  values, and a model on another agent id. Restrict OpenCode to `delivery: "pull"`
  with a useful validation message explaining that automatic delivery is not yet
  supported. Omitted delivery continues to default to pull. The shared agent
  schema carries the model into frozen start state without a format-version bump.
- `src/setupWorkspace.ts`: give `opencode` the display label OpenCode, process
  name opencode, empty nudge prelude, Enter submit, and Basic terminal profile.
  Generate pull delivery for this agent in `buildWorkspaceConfig`; retain a
  previously saved OpenCode model when rebuilding the same selected agent.
  Other agents' defaults and the default onboarding roster remain unchanged.
  Do not add OpenCode to `hasTerminalDeliveryAdapter`.
- `scripts/lib/launcher.sh`: recognize the executable and launch command for
  OpenCode so existing installer validation and launcher generation accept it.
  Resolve it through the shared environment logic and its standard installer
  location under the user's .opencode/bin, without replacing product Node/PATH
  behavior. Disable OpenCode's automatic updater for the launched process.
  Execute the interactive CLI with safely forwarded positional arguments, so
  a supplied --model value reaches the CLI unchanged. Do not pass another
  vendor's --add-dir, sandbox, trust, or approval flags. Keep OpenCode's owner
  permission policy intact; external-file and command prompts remain interactive.
- `src/tmux.ts`: use the existing `shellQuote` helper when constructing the
  OpenCode launcher command with optional --model and its single literal value.
  Apply this at `launchAgent`, shared by initial launch, manual sessions, missing
  panes, and dead-pane recovery. With no model, pass no model option. Existing
  issue launches use the frozen agent record rather than rereading live config.
  Handle OpenCode in `vimInsertPrelude`/`resolveNudgeKeys` so an explicit owner
  reminder adds no fallback letter or Escape and uses Enter by default; preserve
  intentional custom key settings. This is owner-send support, not a declaration
  that the TUI is safe for automatic injection.
- `src/cli.ts`: register opencode in `agentExecutables` for bounded --version
  collection, with automatic updating disabled. Report that update is skipped
  without claiming OpenCode has no updater. Do not invoke the generic update
  subcommand or silently upgrade a major version.
- `test/state.test.ts`: extend existing configuration/start-state tests with
  OpenCode model validation, pull-only validation, and backward compatibility.
- `test/install.test.ts`: extend the current generated-launcher and installer
  fixtures to cover opt-in installation, saved model preservation, idempotent
  reinstall, and execution of the generated launcher against a stub OpenCode.
- `test/tmux.test.ts`: extend launch/recovery and explicit-owner-reminder cases
  for OpenCode model argument transport and correct default submission keys.
- `test/cli.test.ts`: extend startup-maintenance tests for version-only OpenCode
  probing and preservation of its configured model in the issue snapshot.
- `test/runLoop.test.ts`: extend the pull-delivery/owner-reminder fixture for an
  OpenCode participant: publishing an action or consuming ready never calls
  automatic nudge, while an explicit owner reminder sends the owed action.
- `docs/setup-workspace.md`: document opt-in installation, a runtime agent entry
  with optional model, interactive OpenRouter authentication and model selection,
  model precedence and restart behavior, manual/pull operation, and limitations.

## Exact file list to be created

No new tracked product files, dependencies, fixtures, or standalone setup scripts
are needed. The installer will generate start-opencode.sh inside the selected
clone through its existing untracked launcher machinery; it is not a source file
to commit. The only artifact created by this action is the required plan.

## Reuse and Scope

Reuse `agentConfigSchema`, `coordinatorConfigSchema`, `startStateSchema`, and the
existing AgentConfig type in `src/state.ts`; the optional model belongs to the
same typed, frozen agent record as delivery and launch configuration. Keep old
configurations and start snapshots valid. Use a narrow conditional validation
for OpenCode, not a new generic vendor configuration framework.

Reuse `validateAgentIds`, `install`, and `readPreviousConfig` in `src/install.ts`,
plus `buildWorkspaceConfig`, `agentHarnessProcess`, `agentOwnerUiDefaults`,
`agentLabel`, and `writeLauncher` in `src/setupWorkspace.ts`. Supporting the
existing installer is sufficient; its selected roster already accepts arbitrary
valid ids when a launcher exists. Preserve only the added model setting from the
saved OpenCode record, without copying old clone paths or changing reinstall
policy for other agents. Omission of that setting in the saved config clears it.

Reuse `launcher_environment`, `launcher_executable`, `launcher_command`, and
`write_launcher`. They already supply clone cwd, issue identity, GitHub credential
wiring, toolchain selection, and the PATH Git shim. Do not create OpenCode
credentials, modify the owner's native configuration, or run /init over the
installed AGENTS.md overlay. The existing `syncAgentTrust` and
`syncAgentLifecycleHooks` safely do nothing for unsupported vendors; the existing
doctor permits unsupported lifecycle hooks with pull delivery. These modules
need no new mapping. Native containment remains unverified and the shim's actual
resolution must still be measured by the normal participation action.

Reuse `TmuxController.launchAgent`, `startSession`, `ensureSession`,
`resolveAgentLauncher`, `remind`, `resolveNudgeKeys`, and `shellQuote`. A configured
model is passed as data at the final command boundary, never interpolated as
executable shell syntax. Do not change session topology, completion validation,
ballot handling, ready receipts, or the stall watchdog. The existing pull branch
in `RunLoop.maybeLifecycleNudge` and explicit owner-reminder transport provide delivery.

Reuse `product`/`installOnce` and the stub executable style in
`test/install.test.ts`, `makeProduct`/`ensureBuilt` in
`test/support/workspaceFixture.ts`, the injected TmuxRunner and command inspection
helpers in `test/tmux.test.ts`, `setup`/`successfulStartGit`/`fakeLoop` in
`test/cli.test.ts`, and the existing run-loop fixture. No new reusable abstraction
is justified for a single optional model argument.

The operator flow is: explicitly include opencode in --agents; open its managed
window; connect OpenRouter and select a model if needed; then ask it to read the
current action using coord next --issue N, or select it with the coordinator's
existing owner reminder command after its normal prompt is ready. Further
actions also require owner delivery unless the agent sees a replacement action
during the mandated reread. `ready` alone does not enable automatic delivery in
pull mode. Keep permissions interactive; approve access to the completion mailbox,
response directory, bound inputs/worktrees, Git and checks as required by the
owner's OpenCode policy. No provider request or credentials are needed for tests.

A configured model wins at process launch via --model. An omitted model leaves
selection to OpenCode's own configuration/session UI. /models may change a live
session; restarting an issue reapplies its frozen configured model. A directly
invoked generated launcher may receive --model explicitly and does not secretly
read mutable runtime config. Documentation must distinguish that invocation from
the coordinator-managed launch.

The upstream contracts were checked on 2026-10-29:

- The [OpenCode CLI reference](https://opencode.ai/docs/cli/) documents interactive
  startup, --model in provider/model form, --version, an upgrade command, and
  OPENCODE_DISABLE_AUTOUPDATE. Use those interfaces, not guessed flags.
- The [OpenRouter provider instructions](https://opencode.ai/docs/providers/#openrouter)
  document /connect and /models. Provider credentials stay in OpenCode's own
  authentication storage rather than coordinator config or launch scripts.
- The [keybinding reference](https://opencode.ai/docs/keybinds/) identifies Return
  as submit and Escape as interrupt; this supports the owner-reminder defaults.
- The [rules reference](https://opencode.ai/docs/rules/) describes project
  AGENTS.md loading, so another instruction shim is unnecessary.
- The [upstream installer](https://github.com/anomalyco/opencode/blob/dev/install)
  uses the user's .opencode/bin directory; owner-selected PATH installations
  must also remain usable.

OpenCode is absent from this session's PATH. No live vendor version, prompt
capture, successful provider request, or native hook enforcement is claimed.
The docs describe interfaces, not measured terminal readiness. Full automatic
delivery, native plugins/hooks, usage accounting, quota recovery, aliases for
multiple OpenCode agents, and a direct OpenRouter HTTP client are outside this
interactive integration.

## Tests

Use the existing test files listed above; name the new focused cases OpenCode so
they can be selected without running unrelated suites during development.

1. In `test/state.test.ts`, use table-driven cases for an absent model, a normal
   provider/model, and an OpenRouter identifier containing an additional slash.
   Round-trip the value through config and start state. Reject malformed values,
   a model on other agent ids, and OpenCode nudge/both delivery with clear errors.
   Existing agent configurations without the new field must still parse.
2. In `test/install.test.ts`, install an explicit OpenCode roster using the
   existing local product fixture, save a model, and reinstall twice. Assert the
   model survives, delivery stays pull, no extra agent enters the roster, the
   second identical install is inert, and the product and owner OpenCode settings
   are untouched. Execute the generated launcher with a stub executable for both
   issue and manual mode, with/without --model; capture cwd, argv, updater setting,
   and Git-shim PATH. Use a home/clone path containing spaces and test both PATH
   discovery and the standard user install location. No unrelated vendor flags
   may reach OpenCode. Removing the saved model must not retain a stale value.
3. In `test/tmux.test.ts`, exercise the shared launch path on initial start and
   dead-pane/manual recovery with optional model. Execute the constructed shell
   command against a capture stub, including quotes/metacharacters in the model,
   and prove it is one literal argument with no side effect. Include a launcher
   path with spaces. Extend the explicit-owner-send test to assert the complete
   original action text and one Enter, with no inserted vim letter or Escape;
   automatic nudge remains disabled for the pull agent.
4. In `test/cli.test.ts`, extend the fake startup runner: OpenCode receives only
   --version, never update/upgrade, the observed version is recorded before
   panes start, and start state retains the configured model. Existing warning
   behavior for missing/failed version probes remains nonfatal.
5. In `test/runLoop.test.ts`, verify an OpenCode action remains published through
   JOIN and matching ready receipt without an automatic send. A selected owner
   reminder sends that exact owed action once through the existing authority
   checks. This protects the usable pull workflow and prevents accidental
   activation of the unknown-vendor terminal fallback.

The principal new cases fail on the baseline because the installer rejects
opencode, the strict schema rejects model, the launch path drops model, the
generic key fallback inserts a letter/Escape, and maintenance cannot identify
the executable. Pull-mode assertions also preserve existing behavior relied on
by this integration; they are not evidence of a new readiness adapter.

Focused development commands, verified against this repository's scripts and
Vitest include/exclude lists:

```sh
pnpm exec vitest run --config vitest.config.ts test/state.test.ts test/tmux.test.ts test/runLoop.test.ts -t OpenCode
pnpm exec vitest run --config vitest.system.config.ts test/install.test.ts test/cli.test.ts -t OpenCode
bash -n scripts/lib/launcher.sh
```

The declared product precommit command is `pnpm run check:fast`; it includes lint,
typechecking, fast tests and system tests. The declared prepush command is
`pnpm run test:e2e`. Let the installed hooks own those checks instead of duplicating
them immediately before publication. The coordinator's final check is
`pnpm run check`, including build and e2e. If a later implementation action puts
candidate verification under coordinator ownership, cite its recorded results
and follow that action's commands. Do not describe coordinator checks as local
runs or add a package version bump.

This planning action requires only Markdown heading/body validation, exact file
map validation, and source/evidence checks; it does not run product suites.
An interactive smoke check on an owner-installed OpenCode should record its
actual version and demonstrate /connect, /models, model selection at launch,
reading an action and writing its receipts. If unavailable, report that exact
limitation; stub tests do not establish live OpenRouter authentication or full
vendor compatibility.

## Alternatives Rejected

- Treating OpenRouter as another executable duplicates provider support already
  supplied by OpenCode and creates unnecessary credential and HTTP-client code.
- Enabling both delivery immediately would route OpenCode through the permissive
  unknown-agent prompt fallback before startup, dialogs, drafts, and running-turn
  behavior have been measured. Pull mode and explicit owner sends implement the
  issue's interactive route without inventing prompt heuristics.
- Adding OpenCode to the default roster would require an extra installed CLI and
  provider setup for every existing workspace. Explicit --agents selection keeps
  adoption intentional.
- Writing an OpenCode config file during setup would contend with owner/project
  settings. The optional launch argument and native /connect flow suffice.
- A generic launcher-argv framework, new plugin transport, provider SDK, or
  lifecycle-event schema would expand the issue beyond this integration.
- Invoking opencode update follows other vendors' grammar incorrectly; silently
  upgrading also changes an unmeasured CLI during issue startup. Record the
  installed version and leave upgrades owner-controlled.

## Risks and Mitigations

- **Manual delivery expectations:** call the feature interactive/pull support in
  setup instructions, reject automatic delivery in the schema, and explain that
  owner reminders bypass prompt-safety gates and should be sent at the normal
  OpenCode prompt after provider setup. Do not claim unattended workflow parity.
- **Model quoting and drift:** validate shape, shell-quote both executable path
  and model, forward argv without eval, and test through actual stub execution.
  Frozen agent records preserve issue settings on restart; saved config retains
  the model for future sessions. Provider/model existence is OpenCode's concern.
- **Version differences:** rely on documented common CLI interfaces, skip automatic
  upgrades, record the installed version, and disclose that live OpenCode is not
  present here. Do not add screen-pattern detection without measured evidence.
- **Permissions and credentials:** keep native provider and permission settings
  owner-controlled and document external artifact access. The existing PATH shim
  is a bounded policy mechanism, not a sandbox or proof of native enforcement.
  Neither credentials nor provider keys belong in the runtime model entry.
- **Scope growth:** implementation must stay within the eleven listed files.
  If a necessary path is discovered later, submit the coordinator's file-map
  amendment request before using it; do not silently add hooks or configuration
  writers. Existing lifecycle, doctor, trust, and ignored-launcher behavior are
  reused without product edits.

## Conclusion

Implement OpenCode as an explicitly selected, interactive participant with an
optional frozen model setting and native OpenRouter setup. Reuse the existing
installer, tmux launcher, pull/owner delivery, and completion protocol. Acceptance
requires safe model argument transport, correct owner-send keys, preserved
configuration, truthful version reporting, and focused regression coverage.
Automatic OpenCode delivery remains explicitly unsupported pending measured
terminal integration; this plan makes the issue's owner-operated route concrete.
