# Issue 210: where coord depends on each agent CLI

**Recommendation: keep the current integration boundaries for the next CLI.**
Extend the existing maintenance table to support an explicit update command or
no updater, and add Muse through the established launcher, hooks and readiness
functions. A general vendor registry would centralize some names but would not
remove the different JSON, trust, terminal and telemetry contracts. Do not
replace tmux with Muse's SDK as part of onboarding one agent.

This is an assessment, not a Muse integration. The source inventory is pinned to
**cb7ed092cb8a5d15f651387651df7c631e4596e6**, the issue baseline. All repository
links below point to that commit. Research date: **2026-10-15**. Local
help/version observations in this assessment are from **Muse Code 1.4.9
(1.4.9-R6297.1)**; the earlier planning observation of 1.4.7 is not the version
used here.

The largest Muse obstacles are not adding its name to a list:

- Fresh start assumes every known CLI accepts an update subcommand.
- Generated launchers encode every extra writable root as --add-dir.
- Muse documents a sandbox that keeps .git read-only, and hook processes that
  do not inherit arbitrary environment variables.
- Coord needs actual prompt, action/session and shell-refusal evidence before
  treating a new harness as ready for automated work.

The evidence and the unresolved compatibility checks are separated below.

## Scope and reproducible method

The inventory covers tracked runtime code, scripts, hooks, templates, example
configuration, tests, fixtures and maintained documentation. It also checks
hidden tracked files: .gitignore, .github workflows and .nvmrc. Generated
launchers and vendor settings are explained through their generators, rather
than treating one machine's generated files as canonical.

Run these searches from a baseline checkout to reproduce discovery:

~~~sh
git ls-files
git ls-files -z -- src scripts githooks templates test docs .github .gitignore .nvmrc coord README.md config.example.json config.product.example.json |
  xargs -0 rg -n -i 'claude|codex|cursor|antigravity|gemini|\bagy\b'
git ls-files -z -- src scripts githooks templates test docs .github coord |
  xargs -0 rg -n -i 'model|launcher|harness|lifecycle|settings|trust|permission|hook|agent\.id|switch.*agent'
~~~

These are discovery searches, not a count of extension points. I read the
matching branches and their callers, including installer validation, CLI
dispatch, prompt injection and telemetry routing. A table row below can cover
several branches in one module. Line links identify the start of the named
symbol or a concrete branch; additional anchors identify separate behavior.

Excluded matches are explicit:

- cursor/cursors/CursorsState in workflow state, ballots, owner controls and
  journal processing are coordinator cursors, not the Cursor CLI.
- Agent names in generic branch/path fixtures, issue examples and historical
  plans/reviews do not create supported-vendor restrictions.
- Historical issue analyses and their captured terminal output describe old
  runs; they are evidence, not launch or hook configuration.
- The AGENTS.md clone overlay is coordinator-managed. Its local contents are
  not a new vendor integration surface; the tracked templates and generators
  are covered below.
- The release workflow, .nvmrc, coord wrapper, package scripts, hookPolicy and
  generic Git hooks do not select an LLM vendor. “Vendor” in hook installation
  mode means copied hook bodies, not an AI provider.
- Binary illustrations, dependencies and generated dist/node_modules output
  are not independently maintained integration inputs.

## Identity, launch and configuration inventory

“Change?” refers to adding a fully supported CLI under today's design, not to
changes made by this documentation issue.

| Baseline location | Existing tailoring and why it matters | Change? |
| --- | --- | --- |
| [src/protocol.ts:9](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/protocol.ts#L9) and [src/state.ts:234](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L234) | agentIdSchema accepts a general lowercase ID; AgentConfig has root, launcher, delivery, process, nudge keys and Terminal profile. It has no separate vendor, model or arbitrary launch-argv field. | No new ID enum here for Muse; a separate vendor/model feature would change the schema. |
| [src/state.ts:251](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L251) and [src/state.ts:317](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L317) | codexQuota binds a canonical Codex home, account and optionally validated version; validation restricts it to id codex. | Only for a future quota feature or identity/vendor separation. |
| [src/setupWorkspace.ts:30](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L30), [src/setupWorkspace.ts:52](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L52), [src/setupWorkspace.ts:108](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L108) | agentHarnessProcess maps cursor to agent and antigravity to agy; owner UI defaults and labels cover the known IDs, with generic fallbacks. | Add measured Muse process/key defaults and label. |
| [src/setupWorkspace.ts:332](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L332) | buildWorkspaceConfig constructs start-ID.sh and delivery both for every requested agent, using those defaults. | A launch-only Muse must not silently inherit both before hooks/readiness work; generate pull or explicitly gate capability. |
| [src/setupWorkspace.ts:548](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L548) and [src/install.ts:197](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L197) | writeAgentLauncher renders the shell library; validateAgentIds requires each ID to have a launcher_command case. Arbitrary IDs passing the schema are not sufficient. | Shell case is required; the generic renderer/validator can stay. |
| [scripts/lib/launcher.sh:19](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L19) and [scripts/lib/launcher.sh:46](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46) | launcher_environment loads the clone's Node version and adds the Antigravity binary directory; launcher_command owns all five launch cases. | Add only a verified Muse launch case/environment. |
| [scripts/lib/launcher.sh:336](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L336) | write_launcher builds mailbox, private-response, inputs and worktrees grants as --add-dir pairs, then prepends the Git shim. | Required design change: resolve roots once and render vendor-specific grants, without granting the entire owner runtime. |
| [src/cli.ts:135](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135) and [src/cli.ts:142](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L142) | agentExecutables maps four IDs to binaries; updateAgentVersions runs binary update, then binary --version, with separate timeouts. Unknown IDs warn and skip both. | Required: separate executable/version lookup from optional updater argv. |
| [src/cli.ts:306](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L306), [src/cli.ts:1151](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1151) and [src/install.ts:873](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L873) | Help enumerates lifecycle vendors; install CLI and onboard have explicit default rosters. | Update help after support; changing the default roster is an optional product choice, not required for --agents muse. |
| [config.example.json:4](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/config.example.json#L4) and [config.product.example.json:5](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/config.product.example.json#L5) | Explicit agent IDs, clone roots, launchers, delivery, process and UI examples. | Add an opt-in Muse example only after the supported mode is established. |
| [scripts/setup_common.sh:118](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L118) and [scripts/setup_common.sh:279](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L279) | Legacy setup strips known vendor suffixes when identifying the product and delegates launcher generation; shared trust calls begin at [scripts/setup_common.sh:294](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L294). | Suffix recognition and an entry script only if legacy setup support is promised. |
| [scripts/setup_claude.sh:10](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_claude.sh#L10), [scripts/setup_claude.sh:35](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_claude.sh#L35), [scripts/setup_claude.sh:68](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_claude.sh#L68), [scripts/setup_claude.sh:106](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_claude.sh#L106), [scripts/setup_claude.sh:148](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_claude.sh#L148) | Claude-specific identity, CLAUDE.md import, shell guard, permissions JSON and optional MCP setup. | Existing behavior; do not copy all of it into a new vendor. |
| [scripts/setup_codex.sh:21](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_codex.sh#L21), [scripts/setup_codex.sh:48](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_codex.sh#L48), [scripts/setup_codex.sh:92](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_codex.sh#L92), [scripts/setup_codex.sh:102](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_codex.sh#L102), [scripts/setup_codex.sh:112](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_codex.sh#L112) | Codex global scoped identity, project TOML, Git rules and instructions. | Existing behavior; no Muse dependency. |
| [scripts/setup_cursor.sh:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_cursor.sh#L16), [scripts/setup_cursor.sh:46](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_cursor.sh#L46) and [scripts/setup_cursor.sh:74](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_cursor.sh#L74) | Cursor identity, coordination and working-style .mdc rules, scratch location. | Existing behavior; no Muse dependency. |
| [scripts/setup_antigravity.sh:24](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L24), [scripts/setup_antigravity.sh:54](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L54), [scripts/setup_antigravity.sh:83](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L83), [scripts/setup_antigravity.sh:107](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L107) and [scripts/setup_antigravity.sh:137](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L137) | Antigravity identity fallbacks, user settings, hard-coded peer clones and allowed commands. Default settings include model “Gemini 3.5 Flash (High)” at [scripts/setup_antigravity.sh:117](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L117). | This is an actual model-specific setting; changing the roster does not require rewriting its historical peer entries for basic Muse support. |
| [src/productIgnore.ts:35](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L35), [templates/product/gitignore.coordination.block:4](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/templates/product/gitignore.coordination.block#L4) and [.gitignore:6](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/.gitignore#L6) | Vendor dot-directories and instruction files are excluded at generated clone/template/self-host levels. | Add .muse/ where that integration generates local state. Keep these three representations aligned. |
| [src/agentsProtocol.ts:182](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentsProtocol.ts#L182) and [src/agentsProtocol.ts:199](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentsProtocol.ts#L199) | Claude alone gets a CLAUDE.md bridge to the managed AGENTS.md protocol, with removal ownership checks. | No Muse shim if documented native loading is confirmed after trust. |
| [githooks/post-merge:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/githooks/post-merge#L16) and [githooks/lib/identity.sh:39](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/githooks/lib/identity.sh#L39) | Post-merge uses the shared launcher library; identity and commit labels come from local Git config rather than vendor cases. | Reuse unchanged; do not create a new hook body for Muse. |
| [src/setupWorkspace.ts:287](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L287) and [templates/product/AGENTS.md:22](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/templates/product/AGENTS.md#L22) | Documentation classification recognizes instruction filenames; the template uses a Claude commit prefix only as an example. | No Muse-specific instruction filename is currently necessary. |

The exact current launch policy is:

| ID / executable | Flags emitted by launcher_command |
| --- | --- |
| claude / claude | --permission-mode auto plus coord grants |
| codex / codex | -c check_for_update_on_startup=false; -c tui.vim_mode_default=false; --ask-for-approval never; --sandbox workspace-write; --no-alt-screen; --no-daemon; coord grants |
| cursor / agent | --sandbox enabled plus grants when any exist; otherwise bare agent |
| antigravity / agy | --mode accept-edits; --dangerously-skip-permissions; coord grants; extra PATH setup |
| gemini / gemini | Bare gemini; the launcher deliberately omits mailbox grants |

These are repository policies, not claims about every current vendor release.
In particular the Antigravity launcher comments say its grants are advisory
until verified with a real sandboxed publishing run.

Model selection is mostly outside coord. The launcher does not choose a model
for Claude, Codex or Cursor, and AgentConfig does not expose a model selector.
The Antigravity legacy settings default is the explicit exception above.
Different models inside a CLI do not necessarily need a new coord vendor;
different *participants* using that same CLI do expose the ID/vendor coupling.

## Hooks, trust, delivery and evidence inventory

| Baseline location | Tailoring / contract | Extension consequence |
| --- | --- | --- |
| [src/agentTrust.ts:43](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L43) and [src/agentTrust.ts:76](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L76) | Four-ID allowlist and switch: Codex TOML trust; Claude projects.hasTrustDialogAccepted; Cursor encoded project markers and extra roots; Antigravity trustedWorkspaces. Vendor-home overrides differ. | Implement only the new vendor's supported trust mechanism; retain owner settings and idempotence. A run-local trust flag may avoid a new persisted trust writer. |
| [src/agentHookSync.ts:13](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13) and [src/agentHookSync.ts:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L16) | Four-ID vendor lookup; .codex/hooks.json, .claude/settings.local.json, .cursor/hooks.json, .agents/hooks.json. | New hook path and vendor mapping are required. |
| [src/agentHookSync.ts:34](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L34), [src/agentHookSync.ts:48](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L48), [src/agentHookSync.ts:106](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L106) and [src/agentHookSync.ts:119](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L119) | Rendered commands, event sets and JSON shapes. Claude/Codex use nested groups; Cursor uses flat command entries with version; Antigravity uses a named hook block. Claude editorMode is managed only when owned. | Extend render/merge semantics explicitly; do not route a new vendor into the final Antigravity fallback. |
| [src/agentHookSync.ts:205](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L205), [src/agentHookSync.ts:228](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L228) and [src/agentHookSync.ts:293](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L293) | Install, owner-preserving removal and inspection must agree on managed handlers, event lists and disabled hooks. | Add the same vendor to all three paths and their tests. |
| [src/agentHookSync.ts:325](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L325), [src/agentHookSync.ts:385](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L385) and [src/agentHookSync.ts:433](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L433) | Antigravity global status-line wrapper, manifest, downstream command and uninstall restoration. | Not a universal requirement; its status line supplies session identity. |
| [src/claudeStatusLine.ts:28](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts#L28), [src/claudeStatusLine.ts:96](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts#L96), [src/claudeStatusLine.ts:128](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts#L128), [src/claudeStatusLine.ts:202](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts#L202), [src/claudeStatusLine.ts:225](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts#L225) and [src/claudeStatusLine.ts:247](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts#L247) | Claude settings precedence, status-line tee, bounded payload, manifest and owner-edit preservation. | Optional telemetry pattern, not something to duplicate for Muse by default. |
| [src/install.ts:476](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L476), [src/install.ts:520](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L520), [src/install.ts:677](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L677) and [src/install.ts:707](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L707) | Claude per-clone and Antigravity home status-line installation/removal dispatch. | Only if adding a corresponding Muse side channel. Generic hook/trust install calls already exist. |
| [src/agentEvent.ts:17](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17), [src/agentEvent.ts:61](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L61) and [src/agentEvent.ts:187](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L187) | Closed lifecycle vendor enum and normalizers. Codex/Claude: session_id and turn_id; Cursor: conversation_id/generation_id; Antigravity: status/invocation events. Cursor usage has separate normalization. | Add and validate Muse event/session/turn mapping; avoid assuming same event name means same fields. |
| [src/agentEvent.ts:271](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L271) | handleAgentEvent binds configured clone/agent, resolves issue from explicit input/environment/payload or a unique active issue, and validates prompt action path. | Preserve that binding. Hook payloads are not trusted authority to redirect writes. |
| [src/cli.ts:1258](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1258) and [src/cli.ts:1291](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1291) | git-guard and agent-event dispatch validate vendors, bound stdin and emit vendor-compatible responses; Antigravity Stop has a special allow result. | Update help/enum use; inspect Muse stop behavior without copying the Antigravity exception. |
| [src/shellGuard.ts:21](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L21), [src/shellGuard.ts:30](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L30), [src/shellGuard.ts:39](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L39) and [src/shellGuard.ts:279](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L279) | Installed-policy binding, allow/deny envelopes and command extraction: tool_input.command versus Cursor command versus AGY toolCall.args.CommandLine/Cwd. Guard requires COORD_ISSUE. | A new tool payload needs a decoder and an actual harness refusal test. Environment delivery is part of the contract. |
| [scripts/lib/launcher.sh:129](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L129) and [src/shellGuard.ts:320](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L320) | Shared Git shim and actual-tool containment probe, including resolved Git, session, CLI version and installed policy. | Reuse scanner/policy; installation or printed deny JSON alone is not proof the harness enforces it. |
| [src/agentLifecycle.ts:30](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L30), [src/agentLifecycle.ts:44](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L44), [src/agentLifecycle.ts:102](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L102), [src/agentLifecycle.ts:154](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L154) and [src/agentLifecycle.ts:500](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L500) | Containment and normalized lifecycle are shared. Claude rate-limit state and Claude/Cursor failure variants are vendor-specific. | Basic normal events can reuse the reducer; new failure/telemetry variants need explicit schemas and migrations/defaults. |
| [src/tmux.ts:49](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49), [src/tmux.ts:64](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L64), [src/tmux.ts:107](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L107), [src/tmux.ts:151](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L151), [src/tmux.ts:175](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L175) and [src/tmux.ts:192](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L192) | Process aliases, blocked-reason union, Codex turn/composer parsing, Claude usage-wait parsing and queued-action matching. | Measure foreground names and idle/busy/composer behavior; process readiness alone is insufficient. |
| [src/tmux.ts:217](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L217), [src/tmux.ts:269](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L269), [src/tmux.ts:291](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L291), [src/tmux.ts:305](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L305) and [src/tmux.ts:327](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L327) | Vendor readiness, trust dialogs, vim/editor settings and stale nudge-key repairs. Unknown vendors fall through to ready and generic vim insertion. | Add an explicit Muse case: the fallback can prepend an unwanted “a” and use inappropriate submit keys. |
| [src/tmux.ts:381](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L381), [src/tmux.ts:430](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L430), [src/tmux.ts:438](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L438), [src/tmux.ts:1171](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1171), [src/tmux.ts:1213](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1213), [src/tmux.ts:1225](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1225), [src/tmux.ts:1243](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1243) and [src/tmux.ts:1268](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1268) | AGY delay/recapture/separate sends; Codex Normal-mode prelude, busy/composer checks; Claude/Codex mid-send recapture; mouse and scrollbar allowlists. | Decide each transport detail from observation. Optional scrolling is separate from correct submission. |
| [src/runLoop.ts:922](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L922), [src/runLoop.ts:1102](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1102), [src/runLoop.ts:1370](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1370), [src/runLoop.ts:1447](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1447) and [src/runLoop.ts:2029](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L2029) | Vendor reason descriptions, Claude usage-wait recovery, and Claude/Codex transcript watchdog roots/allowlist. | New readiness reasons need reporting; tool activity can support a new watchdog without inventing a transcript store. |
| [src/doctor.ts:354](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L354), [src/doctor.ts:391](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L391) and [src/doctor.ts:403](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L403) | Unknown lifecycle vendor with nudge/both is a finding; Claude status line and Codex home have additional checks. | Advertise only tested capabilities; an unsupported hook mapping cannot be made supported by setting harnessProcess. |

### Optional analytics and resource recovery

| Baseline location | Vendor-specific behavior | New-vendor requirement |
| --- | --- | --- |
| [src/transcriptRead.ts:12](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L12), [src/transcriptRead.ts:110](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L110), [src/transcriptRead.ts:124](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L124), [src/transcriptRead.ts:197](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L197), [src/transcriptRead.ts:320](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L320), [src/transcriptRead.ts:486](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L486) and [src/transcriptRead.ts:499](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L499) | TranscriptVendor is Claude/Codex; UsageVendor adds Cursor. Store discovery and record parsing differ. Claude message/parent chains and Codex token_count deltas are normalized without guessing missing turns. | Only extend after locating and validating a retained store and its accounting rules. |
| [src/cursorHookUsage.ts:65](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cursorHookUsage.ts#L65), [src/cursorHookUsage.ts:116](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cursorHookUsage.ts#L116) and [src/cursorHookUsage.ts:140](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cursorHookUsage.ts#L140) | Cursor token aliases, sanitized journal details, generation-ID aggregation. | Prefer a documented hook usage feed if one exists; preserve unavailable versus zero. |
| [src/analytics.ts:508](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L508) and [src/analytics.ts:596](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L596) | Usage vendor inferred from lifecycle journal or known ID; Cursor reads journal usage, Claude/Codex read transcripts. | Add routing only with a supported reader. Unknown vendor already yields unavailable coverage. |
| [src/cli.ts:1541](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1541) and [src/runLoop.ts:1102](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1102) | Default transcript roots are supplied for Claude/Codex. | New reader requires explicit root wiring in analytics and, if used, watchdog. |
| [src/resourceEvidence.ts:24](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L24), [src/resourceEvidence.ts:39](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L39), [src/resourceEvidence.ts:112](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L112), [src/resourceEvidence.ts:153](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L153), [src/resourceEvidence.ts:187](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L187), [src/resourceEvidence.ts:247](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L247) and [src/resourceEvidence.ts:331](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L331) | Closed evidence sources/vendors, Claude status-line windows and failure classification, Cursor status classification, Codex window parsing/clearance. | A Muse quota/failure feature must extend the typed evidence model; do not relabel its values as another vendor. |
| [src/codexQuota.ts:41](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/codexQuota.ts#L41), [src/codexQuota.ts:200](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/codexQuota.ts#L200), [src/codexQuota.ts:238](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/codexQuota.ts#L238) and [src/paths.ts:477](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/paths.ts#L477) | Codex app-server read-only exchange, bounded process lifetime and serialized account/home reservations. | Codex-specific; a new quota backend needs its own measured API and binding. |
| [src/runLoop.ts:1264](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1264), [src/runLoop.ts:1462](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1462), [src/runLoop.ts:1541](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1541), [src/runLoop.ts:1563](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1563) and [src/runLoop.ts:1668](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1668) | Codex binding, helper polling, account/version validation and automatic release; Claude failure reset handling. | Optional recovery work, not a prerequisite for receiving/completing actions. |
| [src/issueReport.ts:140](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/issueReport.ts#L140), [src/issueReport.ts:165](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/issueReport.ts#L165) and [src/issueReport.ts:230](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/issueReport.ts#L230) | Generic failure display plus Codex helper-cleanup guidance and containment reporting. | Keep generic reports; add only diagnostics justified by a new recovery implementation. |

### Current capability matrix

“Implemented” here describes repository code, not live containment attestation.

| Harness | Launcher / automatic delivery | Shell hook adapter | Usage analytics | Quota/recovery evidence |
| --- | --- | --- | --- | --- |
| Claude | Implemented; prompt-submit hook and TUI checks | Nested PreToolUse | Local transcript | Status-line windows, failures and reset handling |
| Codex | Implemented; prompt-submit hook and composer checks | Nested PreToolUse | Local transcript | Explicit account/home binding and version-gated helper recovery |
| Cursor | Implemented; beforeSubmitPrompt and TUI checks | beforeShellExecution | Journaled hooks; counters may be absent | Error/abort classification, no equivalent quota reader |
| Antigravity | Implemented; invocation/Stop/status-line plus watchdog; no prompt-submit callback | Named-block PreToolUse | Unsupported | No equivalent quota reader |
| Gemini | Bare launch case only; no equivalent automated lifecycle mapping | Unsupported | Unsupported | Unsupported |

A custom ID can be syntactically valid and still fail installer launcher
validation. A manually supplied launcher/config can enable pull participation,
but doctor flags unsupported nudge/both, and analytics remains unavailable.
Default readiness fallbacks are not evidence of a supported harness.
This also explains why naming two agents “codex-fast” and “codex-deep” does
not inherit all Codex integrations.

### Unknown-vendor nudge keys cannot be repaired by configuration alone

The baseline functions reproduce the following results for id muse and an
idle pane, both with omitted key overrides and with explicit
nudgePrelude: [] / nudgeSubmit: ["Enter"]:

~~~json
{"prelude":["a"],"submit":["Escape","Enter"]}
~~~

At [src/tmux.ts:341](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L341),
an empty configured prelude still reaches vimInsertPrelude and inserts “a”.
At [src/tmux.ts:362](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L362),
the stale-submit repair replaces the configured Enter with the unknown-id
default Escape/Enter. These are required source-edit sites before automated
nudge delivery; adding only process/UI defaults or changing config is not a
complete integration. Extend the existing test next to
[test/tmux.test.ts:346](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/tmux.test.ts#L346)
to assert empty prelude and Enter survive for the newly supported vendor.

Two additional baseline calls show why the terminal contract needs its own
adapter: harnessPromptReadiness("Thinking... esc to interrupt", "muse") returns
ready: true, while harnessLooksReady("muse-bin-1.4.7-R6101.1", "muse") returns
false. These are synthetic inputs to unchanged functions, not observations of
a running Muse pane. Measure the actual foreground name, including any OS
truncation, before selecting a process alias.

Muse's [interactive guide](https://dev.meta.ai/docs/muse-code/interactive)
documents Enter as steering text into an active turn and Esc as interrupting
that turn. Thus the key fallback can add unwanted prompt text or cancel work;
a false-ready result can steer a new action into an existing turn. The
documented key semantics are known; live chrome and send timing remain open.
Pull-only delivery avoids nudge injection but still needs the filesystem and
Git permissions described below.

Maintained documentation also carries supported-agent claims: [README.md:11](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/README.md#L11)
names the roster; [docs/setup-workspace.md:100](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/setup-workspace.md#L100) describes vendor trust
and editor settings; [docs/coord-driver.md:515](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/coord-driver.md#L515) explains lifecycle state;
[docs/readiness-policy.md:56](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/readiness-policy.md#L56) and [docs/analytics.md:140](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/analytics.md#L140)
state delivery/usage capabilities. [docs/repo-map.md:31](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/repo-map.md#L31) points to the
single launcher source. Update these claims only when the corresponding
capability is implemented; historical issue-analysis tables need no roster edits.

## Muse: observed facts, documented contracts and open checks

Muse **Code** is the terminal coding agent; its underlying Muse Spark model and
the consumer Muse product are not interchangeable integration targets.
Meta's [user manual](https://dev.meta.ai/docs/muse-code) supplies the installer
and describes interactive, headless and MSP entry points. The published
macOS/Linux [installer](https://dev.meta.ai/install.sh) is linked there; no installation,
login, model session or account operation was performed for this assessment.

Evidence classes below are **L** (local help or wrapper inspection), **D**
(primary documentation), **I** (inference/proposed coord mapping), and **O**
(unverified live compatibility). A documented feature is not a measured
refusal or successful coord run.

### Source provenance

| Source | Version/provenance recorded on 2026-10-15 | Limit |
| --- | --- | --- |
| muse --version; muse --help; muse exec --help; muse export --help | Local CLI 1.4.9 (1.4.9-R6297.1) | Only help/version paths were executed. |
| Local muse launcher, inspected as text | Bash wrapper; should_check_for_update/main and update_interval | Wrapper behavior is installation-specific; no update subcommand was invoked. |
| [Earlier developer docs route](https://meta-models.github.io/muse-code-sdk/1.4/) | The original /1.4 authoring snapshot is superseded for current provenance; its generator/fingerprint are not retained as a compatibility pin | This route could not be re-fetched during revision. Its path is not proof of current page content or local CLI compatibility. |
| [Current developer docs landing page](https://meta-models.github.io/muse-code-sdk/next/) | Retrieved 2026-10-15 at approximately 20:16 UTC: Developer Preview; generator commit 4c63a69364245c08e8dd81d6a865e57ef6f06c2d; schema fingerprint sha256:e8b3d24f3922af8e567838a9ebdf8a28b64e6e0ddb516689f1a760e46c2f7fa1 | A separate rolling route, not a verification of the unavailable /1.4 page or of local CLI 1.4.9. |
| [Original hooks reference](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/) and [available hooks reference](https://meta-models.github.io/muse-code-sdk/next/guides/extend/hooks/) | Both retrieved snapshots label their demonstrated runs 1.3.0; the next route was available during review | Recheck payloads and enforcement on 1.4.9 before integrating. |
| [Configuration](https://dev.meta.ai/docs/muse-code/configuration) and [permissions](https://dev.meta.ai/docs/muse-code/permissions) | Live user-manual pages without a pinned CLI build | Treat defaults as documented, not a measured local policy. |

The documentation generator and schema fingerprint describe the retrieved
documentation snapshot. They are not measurements of the installed Muse
binary. No MSP initialize exchange was performed; a future MSP integration
must compare its actual host response with the documentation it consumes.

### Compatibility assessment

| Layer | Evidence and conclusion |
| --- | --- |
| Update/version | **L:** help lists no update command and gives the grammar muse [OPTIONS] [PROMPT]. **I:** passing “update” is liable to start a prompted session, not an updater; do not run that experiment on an account. Coord's generic updater must skip it while still recording --version. |
| Wrapper updates | **L:** inspected wrapper defaults MUSE_UPDATE_INTERVAL_SECONDS to 3600 and gates automatic update checks with MUSE_NO_AUTO_UPDATE; it also has MUSE_SYNC_UPDATE. **I/O:** a future launcher can evaluate the observed MUSE_NO_AUTO_UPDATE=1 control for stable issue sessions, but must verify the installed wrapper/version and owner update policy. Setting the interval to zero would mean frequent checks, not disablement. |
| Model/effort | **L:** --model and --reasoning-effort are exposed by both TUI/headless help. **I:** model choices should be explicit owner configuration; do not hard-code a model from marketing or assume two model profiles are already two supported coord participants. |
| Approval/trust | **L:** --approval-mode never, --trust-workspace and --permission-profile are present; run-local trust is not persisted. **I:** these are candidates, not a complete production launch command. Trust and unattended approval do not prove filesystem permissions. |
| Writable roots and Git | **L:** no --add-dir; --workspace roots policy-gated tools. **D:** the [permissions page](https://dev.meta.ai/docs/muse-code/permissions) describes workspace/temp writes with .git, .muse and .agents protected. **I/O:** prove staged Git writes, commits, checks, push/network access and four external coord roots under an acceptable policy; --workspace is not proven equivalent to additive grants. Pull mode still needs these writes. Broad --yolo is not a substitute for a verified grant design. |
| Instructions/settings | **D:** [configuration](https://dev.meta.ai/docs/muse-code/configuration) places user JSON in ~/.config/muse/settings.json and loads project AGENTS.md only after trust, with documented precedence over alternative instruction files. **I/O:** reuse coord's overlay rather than run muse init; verify loading in the managed clone. No Claude-style shim is presently justified. |
| Hook installation | **D:** [hooks](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/) documents .muse/hooks.json in trusted projects, nested event/matcher/command groups, lifecycle events and Bash/shell matching. **I/O:** reuse managed-handler preservation patterns, verify exact live payloads and Stop behavior. |
| Hook environment/denial | **D:** the same [reference](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/) describes a cleared environment, managed-only env allowlisting and a PreToolUse permissionDecision deny response. **I:** current renderShellGuardHookCommand relies on inherited COORD_ISSUE, so a copied project hook would return allow at shellGuard.ts:283. **O:** establish an owner-bound issue-context channel and prove actual harness refusal, including restart and stale-session cases. |
| Terminal readiness | **D:** the [interactive guide](https://dev.meta.ai/docs/muse-code/interactive) defines Enter steering and Esc interruption. **I:** the reproduced unknown-id trace above proves config overrides do not prevent the unwanted vim prelude or submit repair. **O:** actual foreground process, idle/busy/trust text, editor mode, scrolling and send timing still need live measurement. |
| Retained usage | **L:** export help describes schema-versioned offline export from a session UUID or session.jsonl. **O:** this does not establish the store location, token accounting or turn correlation. No transcript/credential files were read. Start with unavailable analytics. |
| Headless / MSP | **L:** exec --json, --prompt-file, serve and schema are listed. **D:** the [official SDK](https://github.com/meta-models/muse-code-sdk) drives sessions over MSP. **I:** these are alternative transports requiring action identity, permission, restart and completion integration; they do not automatically replace the existing persistent tmux lifecycle. |

The hook environment mismatch is distinct from missing hook support. The
documented hooks exist; what remains unproved is that the observed CLI can
deliver coord's exact bindings and honor its denial response. A managed-hook
allowlist is one candidate. A project-hook wrapper would instead need a
validated owner-controlled binding source, never a guessed “latest issue.”
The existing unique-active-issue fallback for observational events does not
fix shellGuard's explicit environment requirement.

## Exact future Muse change map under the current architecture

This is a follow-up map, not permission to modify these files in issue 210.
**R** means required for an installed participant; **A** adds unattended
delivery; **C** is conditional on a measured contract; **O** is optional.
The locations link back to the baseline, so a future implementer can update
the relevant symbol after code moves.

| Stage | Existing file and exact starting locations | Smallest intended change / existing test home |
| --- | --- | --- |
| R | [scripts/lib/launcher.sh:19](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L19), [scripts/lib/launcher.sh:46](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46), [scripts/lib/launcher.sh:336](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L336) | Muse case, explicit wrapper update policy and per-vendor rendering of resolved extra roots, contingent on a working narrow-grant/Git design. Extend [test/install.test.ts:59](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L59) and [test/install.test.ts:241](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L241); reuse launcher-generation cases. |
| R | [src/cli.ts:135](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135) and [src/cli.ts:142](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L142) | Replace string executable values with a small maintenance record containing executable, version argv and nullable update argv; preserve existing vendors' commands. Test no prompted update and version recording in [test/cli.test.ts:221](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/cli.test.ts#L221). |
| R/A | [src/setupWorkspace.ts:30](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L30), [src/setupWorkspace.ts:52](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L52), [src/setupWorkspace.ts:108](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L108), [src/setupWorkspace.ts:332](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L332) | Measured process/UI defaults, display label and pull versus both capability choice. Test install defaults in [test/install.test.ts:59](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L59) and onboarding in [test/onboard.test.ts:68](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/onboard.test.ts#L68). |
| R | [src/productIgnore.ts:35](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L35), [templates/product/gitignore.coordination.block:4](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/templates/product/gitignore.coordination.block#L4), [.gitignore:6](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/.gitignore#L6) | Ignore generated .muse state consistently. Extend existing installer/template assertions in [test/install.test.ts:985](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L985). |
| A | [src/agentHookSync.ts:13](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13), [src/agentHookSync.ts:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L16), [src/agentHookSync.ts:34](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L34), [src/agentHookSync.ts:48](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L48), [src/agentHookSync.ts:106](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L106), [src/agentHookSync.ts:119](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L119), [src/agentHookSync.ts:228](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L228), [src/agentHookSync.ts:293](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L293) | Add supported vendor, path/events, merge/remove/inspect symmetry and binding-aware hook rendering. Reuse [test/agentHookSync.test.ts:41](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentHookSync.test.ts#L41) and [test/agentHookSync.test.ts:191](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentHookSync.test.ts#L191). |
| A | [src/agentEvent.ts:17](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17) and [src/agentEvent.ts:61](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L61); [src/cli.ts:306](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L306) and [src/cli.ts:1291](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1291) | Extend accepted lifecycle vendor and actual field mapping; update command help and response handling only as needed. Reuse [test/agentEvent.test.ts:85](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentEvent.test.ts#L85) and [test/agentEvent.test.ts:287](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentEvent.test.ts#L287). |
| A | [src/shellGuard.ts:30](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L30), [src/shellGuard.ts:39](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L39), [src/shellGuard.ts:279](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L279), [src/shellGuard.ts:320](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L320) | Validate actual Muse command/session envelope and denial; resolve cleared-env issue binding with the hook renderer. Extend [test/shellGuard.test.ts:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/shellGuard.test.ts#L16) and stale-binding case at [test/shellGuard.test.ts:107](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/shellGuard.test.ts#L107). |
| A | [src/tmux.ts:49](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49), [src/tmux.ts:64](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L64), [src/tmux.ts:192](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L192), [src/tmux.ts:217](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L217), [src/tmux.ts:269](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L269), [src/tmux.ts:327](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L327), [src/tmux.ts:341](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L341), [src/tmux.ts:362](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L362), [src/tmux.ts:1171](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1171), [src/tmux.ts:1213](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1213), [src/tmux.ts:1243](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1243), [src/tmux.ts:1268](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1268) | Explicit process/prompt/composer/key policy and measured send sequencing; fix empty-prelude fallback at 341 and bare-Enter repair at 362, which config alone cannot override. Review optional mouse allowlists separately. Reuse [test/tmux.test.ts:346](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/tmux.test.ts#L346), [test/tmux.test.ts:1260](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/tmux.test.ts#L1260) and current prompt/owner-draft fixtures. |
| A | [src/runLoop.ts:922](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L922) and [src/doctor.ts:354](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L354) | Report new prompt reasons and the supported vendor/capability truthfully; preserve no-silent-retry rules. Reuse [test/doctor.test.ts:138](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/doctor.test.ts#L138) and [test/runLoop.test.ts:1635](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/runLoop.test.ts#L1635). |
| C | [src/agentTrust.ts:54](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L54) and [src/agentTrust.ts:76](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L76) | Only if persisted trust is needed instead of the run-local flag; preserve settings and restrict roots. Existing home/dry-run/idempotence tests at [test/install.test.ts:59](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L59) and [test/install.test.ts:100](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L100). |
| C | [src/agentsProtocol.ts:182](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentsProtocol.ts#L182) | Only if live trusted-clone testing contradicts documented native AGENTS loading. Keep ownership-safe removal at [src/agentsProtocol.ts:199](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentsProtocol.ts#L199). Reuse [test/install.test.ts:241](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L241). |
| O | [src/install.ts:873](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L873); [src/cli.ts:1151](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1151); [config.example.json:4](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/config.example.json#L4); [config.product.example.json:5](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/config.product.example.json#L5) | Decide opt-in example/default roster policy. Generic --agents support does not require making Muse a default. Reuse CLI/onboard fixture rosters. |
| O | [src/transcriptRead.ts:12](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L12), [src/transcriptRead.ts:486](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L486), [src/transcriptRead.ts:499](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L499); [src/analytics.ts:508](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L508), [src/analytics.ts:596](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L596); [src/cli.ts:1541](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1541); [src/runLoop.ts:1102](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1102), [src/runLoop.ts:2029](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L2029) | Add a proven local usage reader and optionally watchdog; test attribution/partial/unavailable cases at [test/transcriptRead.test.ts:104](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/transcriptRead.test.ts#L104) and [test/analytics.test.ts:412](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/analytics.test.ts#L412). |
| O | [src/resourceEvidence.ts:24](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L24), [src/resourceEvidence.ts:39](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L39); [src/agentLifecycle.ts:154](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L154), [src/agentLifecycle.ts:472](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L472); [src/state.ts:251](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L251), [src/state.ts:317](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L317); [src/runLoop.ts:1462](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1462), [src/runLoop.ts:1563](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1563); [src/paths.ts:477](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/paths.ts#L477); [src/doctor.ts:391](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L391); [src/issueReport.ts:165](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/issueReport.ts#L165) | A separately designed Muse failure/quota feature, only after an API and account/version binding exist. Current Codex/Claude semantics must not be reused as if vendor-neutral. Reuse failure tests and fake-server patterns, not a live paid account. |
| C | [scripts/setup_common.sh:118](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L118), [scripts/setup_common.sh:294](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L294) | Only if supporting the legacy setup route. One proposed new file, scripts/setup_muse.sh (new file; no baseline lines), would be justified solely as that route's entry point. Prefer the existing installer initially; no new script is required by it. |
| A/docs | [README.md:11](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/README.md#L11); [docs/setup-workspace.md:100](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/setup-workspace.md#L100); [docs/coord-driver.md:515](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/coord-driver.md#L515); [docs/readiness-policy.md:56](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/readiness-policy.md#L56); [docs/analytics.md:140](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/docs/analytics.md#L140) | Update supported-vendor/setup/behavior claims when they become true; document explicitly unavailable usage. Existing documentation validation applies. |

The R/A rows name **12 distinct existing runtime/config-generation files**
(counting the shell launcher, .gitignore and ignore template, excluding tests
and user documentation). That is a bounded initial integration map, not a
promise that all compatibility questions are already resolved. The conditional
rows must be decided before implementing; optional quota support should be a
separate issue. No new runtime module is justified for the first Muse adapter
on current evidence. If the grant/context work requires additional files, a
future approved plan must name them before editing.

## Why not a general vendor registry now?

There is duplicated metadata, but there is not one universal “supported”
set. Five launch cases, four lifecycle vendors, two transcript readers, three
usage vendors and differing quota sources are intentionally different.
Replacing all of them with one exhaustive enum and empty methods could
accidentally promise capabilities that the current unavailable paths report
honestly.

| Option | Concrete cost and effect | Decision |
| --- | --- | --- |
| Existing boundaries, explicit maintenance record | Keeps the 12-file R/A map above; changes the already-existing CLI map to represent the one proven new exception (no update command). No new runtime file. | Recommended for the next harness. |
| Narrow identity/capability registry | At least one new module plus eight existing TypeScript consumer files below; removes repeated metadata definitions, but leaves vendor JSON, parsing, trust, lifecycle and TUI work in the integration map. Shell stays another integration surface. | Reconsider after Muse's live contracts are known or repeated same-CLI participants become a concrete requirement. |
| Full adapters/plugins or common SDK transport | Must still represent all listed behavior and optional capabilities, plus registration, settings ownership, transport lifecycle and migration. Muse MSP is not a transport contract implemented by every current CLI. | Not justified by one new vendor. |

Here is the precise migration footprint for the *registry candidate*, so the
cost comparison can be checked without assuming a free abstraction:

| Existing baseline consumer | Metadata that could move |
| --- | --- |
| [src/cli.ts:135](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135) | Executable and maintenance argv |
| [src/setupWorkspace.ts:30](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L30), [src/setupWorkspace.ts:52](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L52), [src/setupWorkspace.ts:108](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L108) | Process, UI defaults and labels |
| [src/agentEvent.ts:17](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17) | Lifecycle-capable vendor validation |
| [src/agentHookSync.ts:13](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13), [src/agentHookSync.ts:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L16), [src/agentHookSync.ts:106](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L106) | Hook capability, paths and supported event sets; document merge logic remains local |
| [src/agentTrust.ts:54](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L54) | Trust capability dispatch, while writers remain local |
| [src/tmux.ts:49](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49), [src/tmux.ts:430](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L430), [src/tmux.ts:438](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L438) | Process aliases and scroll policy; readiness parsing remains local |
| [src/doctor.ts:365](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L365) | Supported capability descriptions |
| [src/productIgnore.ts:35](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L35) | Vendor-generated directories |

The candidate new file would be src/vendors.ts (new file; no baseline lines),
with a narrow metadata type and optional capability tags, not callbacks for
every subsystem. Existing corresponding test files would need extension;
test/cli.test.ts and test/install.test.ts can check descriptor consumers
without a new test framework. Both example configs and the shell/template
ignore lists still need an explicit consistency decision. Turning every
transcript/quota union into the general Vendor type would be an additional,
unjustified migration, not a saving counted here.

Counting unique files rather than comparing “sites” to “lines,” the registry
requires **nine TypeScript files in its migration** (one new plus eight
consumers), while at least the hook, event, shell-guard and terminal behavior
still needs work for Muse. This is a lower bound, not an estimate of hours or
lines saved. The inventory establishes repeated metadata, but does not
establish enough reduction in the next vendor's change map to pay that
migration cost now.

Keep launcher_command as the authority for shell argv. The recommended small
maintenance-record change concerns owner-side update/version commands; it must
not duplicate launch flags. Both installer and post-merge continue rendering
the same shell template. A future registry must either keep that distinction
or define one source and prove both render paths consume it; merely copying
argv into TypeScript defeats the current single-source design.

### Several models from one CLI

The existing configured participant ID is also used as the vendor selector.
A separate vendor field defaulting to id is a plausible future design when
two Codex or Muse participants are required. A model option then belongs to
owner-controlled launch configuration, not branch identity.

That is larger than adding Muse: it touches AgentConfig and frozen StartState
serialization, install/default generation, hook vendor dispatch versus agent
identity, trust, tmux, analytics inference, Codex-only quota validation, and
backwards compatibility for old issue runtimes. It must preserve participant
IDs in branches, mailboxes, ballots and action correlation; it cannot infer a
vendor from a similarly named ID. Old configs need vendor=id behavior, and
new runtime fields must participate in automation identity and be frozen on
issue start. The relevant schema/dispatch sites are already in the tables;
this report does not recommend that migration as a prerequisite for one Muse
participant.

## Existing tests and fixtures to reuse

These are integration test homes for a future change, not new tests added by
this report. They also show why relocating metadata does not remove the
behavioral verification burden.

| Existing evidence | Useful extension |
| --- | --- |
| [test/cli.test.ts:221](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/cli.test.ts#L221), “fresh-start agent maintenance” | Nullable updater still collects a version, never runs a prompt accidentally, and preserves update-before-launch ordering. |
| [test/install.test.ts:59](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L59) and [test/install.test.ts:100](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/install.test.ts#L100) | Trust/launcher generation, preserved settings, alternate homes, repeated install and dry-run. |
| [test/agentHookSync.test.ts:41](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentHookSync.test.ts#L41) and [test/agentHookSync.test.ts:191](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentHookSync.test.ts#L191) | Disabled hooks stay disabled; managed nested handlers can be removed without deleting owner handlers. |
| [test/agentLifecycle.test.ts:65](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentLifecycle.test.ts#L65) and [test/agentLifecycle.test.ts:158](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentLifecycle.test.ts#L158) | Probe evidence and stale-session invalidation; reuse the normalized reducer tests for a new vendor. |
| [test/agentEvent.test.ts:85](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentEvent.test.ts#L85) and [test/agentEvent.test.ts:287](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/agentEvent.test.ts#L287) | Session/turn/action normalization and clone identity routing. |
| [test/shellGuard.test.ts:16](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/shellGuard.test.ts#L16) and [test/shellGuard.test.ts:107](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/shellGuard.test.ts#L107) | Vendor payload fixtures and stale/manual issue binding. Real-harness refusal is still a separate acceptance check. |
| [test/tmux.test.ts:1260](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/tmux.test.ts#L1260) and [test/tmux.test.ts:1501](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/tmux.test.ts#L1501) | Process alias and mode-aware key tests; extend current panes for Muse idle/busy/trust/draft states. |
| [test/doctor.test.ts:138](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/doctor.test.ts#L138) | Unsupported vendor cannot claim hook-gated nudge delivery. |
| [test/transcriptRead.test.ts:104](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/transcriptRead.test.ts#L104) and [test/analytics.test.ts:412](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/analytics.test.ts#L412) | Missing/unsupported stores remain unavailable rather than zero usage. |
| [test/cursorHookUsage.test.ts:128](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/cursorHookUsage.test.ts#L128) | Optional hook counters survive normalization and missing values remain honest. |
| [test/state.test.ts:245](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/state.test.ts#L245) | Codex-only binding validation; a future distinct vendor binding needs schema tests here. |
| [test/codexQuota.test.ts:99](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/codexQuota.test.ts#L99) and [test/codexQuota.test.ts:205](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/codexQuota.test.ts#L205) | Read-only fake server and evidence-based clearance patterns; they do not establish a Muse quota API. |
| [test/support/workspaceFixture.ts:89](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/support/workspaceFixture.ts#L89) | makeProduct creates isolated products/origins/runtime; reuse instead of writing new infrastructure. |
| [test/support/fixtures/transcript-claude.jsonl:1](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/support/fixtures/transcript-claude.jsonl#L1), [test/support/fixtures/transcript-codex.jsonl:1](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/support/fixtures/transcript-codex.jsonl#L1), [test/support/fixtures/transcript-codex-shared-turn.jsonl:1](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/support/fixtures/transcript-codex-shared-turn.jsonl#L1) and [test/support/fixtures/analytics-journal.jsonl:1](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/test/support/fixtures/analytics-journal.jsonl#L1) | Existing attribution fixtures; a future Muse fixture needs actual sanitized format evidence, not renamed Codex records. |

Generic evidence/machine/ballot/path tests use arbitrary participant IDs; their
sample roster strings are not all mandatory edits. Tests for a real changed
vendor list, parser or generated config are the ones to extend.

## Bounded follow-up and acceptance criteria

1. **Resolve the blocking compatibility questions first.** On an explicitly
   prepared disposable Muse workspace, establish narrow external-root access,
   Git staging/commit and push, shell-hook binding through the cleared
   environment, live payloads and actual refusal. Record exact CLI and wrapper
   versions and distinguish hook from shim coverage. Do not advertise
   unattended support until these pass.
2. **Add the minimum installed mode.** Use the R rows and a deliberate pull
   capability if automation remains unverified. Check version collection,
   deterministic launcher generation, settings ownership, instruction loading,
   doctor output and uninstall preservation. Pull mode is a delivery fallback,
   not a solution to blocked Git/mailbox writes.
3. **Add automatic delivery.** Complete A rows with measured pane fixtures,
   action ID/digest acknowledgement, busy/trust/owner-draft refusal, correct
   submit keys and restart behavior. Assert that explicit empty prelude and
   Enter survive key resolution for Muse, and that busy panes cannot receive
   a steered action or an interrupt from submission. Preserve the no-blind-resend
   policy. Demonstrate both Git-mode and private-response completion followed
   by ready and a subsequent action.
4. **Consider optional integrations separately.** Add token usage only with a
   verified store/feed and attribution fixtures. Add quota recovery only with
   fresh, account-bound, version-appropriate evidence. Default to unavailable
   analytics and owner recovery until then.
5. **Reassess a registry with measured costs.** Count the actual files/sites
   touched by the Muse integration, separate constants from behavior and
   compare the next concrete vendor's marginal work with the migration table.
   A smaller checklist is useful; a relocated switch is not itself a benefit.

For this documentation change, validation consists of checking cited baseline
paths/anchors, repeating the inventory searches, checking source provenance
and README discoverability, and running the existing pnpm check:docs script.
That script catches documentation regressions such as machine-specific paths;
it does not prove inventory completeness. No new executable behavior or
test fixture is introduced. Mandatory checks remain owned by the installed
hooks and coordinator under the issue's frozen policy.

Authoring validation: 192 distinct source anchors across 62 files were checked
against baseline file bytes and nonempty target lines; the README link resolves.
All 34 source/script/hook/template/CI files matching vendor searches were
accounted for, including the documented cursor-state exclusions. The focused
check passed: pnpm check:docs, 29 tests passed and 84 skipped. The unchanged
baseline functions were also exercised with synthetic unknown-vendor inputs
to confirm the key-override, ready-fallback and process-mismatch results above.
No live Muse session or integration test is claimed.
