# Agent CLI integration analysis (issue 210)

| | |
| --- | --- |
| Baseline | `cb7ed092cb8a5d15f651387651df7c631e4596e6` (release 0.0.73). Every `path:line` below is at this commit and links to it. |
| Research date | 2026-10-15 |
| Scope | Every place coord tailors command-line options, configuration data, JSON, process names, key sequences or telemetry to one agent CLI; what Meta's Muse Code would need; and whether to keep adding vendors this way. No behaviour changes with this document. |
| Recommendation | **Keep the current architecture and add vendors to it, but first make vendor dispatch exhaustive and collect the per-vendor identity data in one table.** Do not build a plugin or adapter layer, and do not move to Muse's session protocol (MSP). Details and the exact edit list are in [§6](#6-architecture-options-and-recommendation). |

Summary of the evidence:

- **Where the tailoring lives.** The inventory in §2 has **68 sites in 35 tracked files**.
- **The data is duplicated.** The full four-vendor list alone is written out separately 11 times:
  - the `agent-event` enum;
  - `vendorForAgent`;
  - the trust list;
  - the executable table;
  - two usage lines;
  - two default rosters;
  - the doctor message;
  - two lines in `setup_common.sh`.
- **The behaviour is genuinely different per vendor.** It covers four hook-file formats, three shell-guard envelopes, four trust stores, pane heuristics, and two transcript formats.
- **Unknown vendors are mishandled silently.** Several dispatch points fall through to the Antigravity branch or to a default. A new vendor added without touching them is mishandled, and nothing fails to compile or test (§3.2).
- **Muse would hit those silent paths immediately.** A `muse` agent id at the baseline gets a literal `a` typed before every prompt. It gets Escape before Enter even when configured otherwise; in Muse, Escape cancels a running turn. Its pane process never matches, so nudges never deliver. And a busy pane counts as ready. All four were reproduced against the baseline build (§3.2).
- **Muse is closer to existing vendors than expected.** Its documented hook contract, file layout and deny envelope are close to Claude Code's (§4).

## 1. Method

Inventory scope was every tracked file (`git ls-files`, 177 files including `.github/` and `.gitignore`), then these searches at the baseline:

```sh
# vendor ids and executables as literals or words
git grep -nE '"(claude|codex|cursor|antigravity|agy|gemini|agent)"|\b(claude|codex|antigravity|agy|gemini)\b' -- . ':!test' ':!docs' ':!.plans' ':!.code-reviews'
# vendor-prefixed identifiers and vendor home/config directories
git grep -nE 'Claude|Codex|Antigravity|Gemini|Cursor[^sS]|\.claude/|\.codex/|\.cursor/|\.gemini/|\.agents/' -- src scripts githooks templates
# dispatch on an agent id or vendor
git grep -nE 'switch \((agent|input\.agent|vendor|agentId)\)|(agent|agentId|agent\.id|vendor) (===|!==) "' -- src
# configuration concepts that carry vendor data
git grep -nE 'harnessProcess|nudgePrelude|nudgeSubmit|terminalProfile|launcher_command|launcher_environment|--add-dir|trust|editorMode|vimMode|statusLine|codexQuota' -- src scripts
```

Every hit was read together with its callers.

**Excluded categories** (counted as not vendor behaviour):

- **The `cursor` state false positive.** `cursors.json`, `CursorsState`, `issueCursor`, `replaceCursor` and `AgentCursor` are coordinator state, not the Cursor vendor. Most raw `cursor` hits in `src/runLoop.ts`, `src/state.ts`, `src/machine.ts` and `src/ownerControls.ts` are this.
- **Illustrative agent names.** Examples in comments and prose, such as `issue-42/claude/complete` in `src/paths.ts` comments, the commit-label example in `templates/product/AGENTS.md`, and the history notes in `plan.md`.
- **Tests and fixtures.** They mirror the behaviour they test. They are listed as test homes in §5 and §6, not as integration sites.
- **Agent-neutral mechanisms.** `VENDOR_LIB_FILES` in `src/hookSync.ts` means "vendored hook library", not an agent vendor. The commit identity in `githooks/lib/identity.sh` is per-clone data, not per-vendor code. The `.github/workflows/version-bump-on-merge.yml` file has no vendor content.

## 2. Inventory of vendor tailoring sites

"Kind" is **data** (a per-vendor constant or list) or **behaviour** (vendor-specific parsing or logic). The last column says whether adding a CLI requires editing the site.

### 2.1 Identity and configuration

| Site | Symbol / key | Current vendor behaviour | Edit needed to add a CLI? |
| --- | --- | --- | --- |
| [`src/protocol.ts:9`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/protocol.ts#L9) | `agentIdSchema` | Any lowercase id is a valid agent. | No. This is why a custom id passes validation yet gets none of the vendor support (§3.2). |
| [`src/state.ts:234-262`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L234-L262) | `agentConfigSchema`: `harnessProcess`, `nudgePrelude`, `nudgeSubmit`, `terminalProfile`, `codexQuota` | Per-agent overrides of process name, keys and Terminal profile. There is no `model` and no `vendor` field. | No for config. A `vendor` field is optional, see §6.3. |
| [`src/state.ts:317-318`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L317-L318) | `codexQuota` refine | Quota binding is allowed only on agent id `codex`. | No, unless the new CLI gets a quota reader. |
| [`src/setupWorkspace.ts:29-38`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L29-L38) | `agentHarnessProcess` | `cursor` maps to `agent` and `antigravity` maps to `agy`; any other id is used as-is. | Yes, data. |
| [`src/setupWorkspace.ts:52-67`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L52-L67) | `agentOwnerUiDefaults` | Nudge prelude and submit keys plus a Terminal profile per vendor. The fallback is `Escape, Enter`. | Yes, data. The fallback is unsafe for Muse (§3.2). |
| [`src/setupWorkspace.ts:107-114`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L107-L114) | `KNOWN_AGENT_LABELS` | Display and commit labels; other ids are capitalized. | Optional, data. |
| [`src/setupWorkspace.ts:354-357`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L354-L357) | `buildWorkspaceConfig` | Writes `start-<id>.sh` and the harness process into `config.json`. | No. |
| [`src/setupWorkspace.ts:739-752`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L739-L752) | clone identity | `consensus.agentId` / `consensus.agentLabel` git config; the hooks read them. | No. Only needed if the vendor is split from the id (§6.3). |
| [`config.example.json:4-43`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/config.example.json#L4-L43) | example roster | One row per vendor with keys and profiles. | Optional example row. |
| [`config.product.example.json:6-7`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/config.product.example.json#L6-L7) | product example | Two vendor rows. | No. |

### 2.2 Launch, install and update

| Site | Symbol / key | Current vendor behaviour | Edit needed? |
| --- | --- | --- | --- |
| [`scripts/lib/launcher.sh:19-33`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L19-L33) | `launcher_environment` | Adds `~/.local/bin` to `PATH` for `antigravity`. | Yes, if the CLI needs environment setup (Muse: §5). |
| [`scripts/lib/launcher.sh:46-99`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46-L99) | `launcher_command` | The single source of launch argv. It has a case per vendor: Claude auto mode, Codex workspace-write with no daemon, the Antigravity skip-permissions grant, launcher-only `gemini`, and Cursor's sandbox toggle. | **Yes, required.** Install refuses an id without a case. |
| [`scripts/lib/launcher.sh:40-45`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L40-L45) | grant invariant | Assumes every vendor accepts `--add-dir`. | Yes, if the CLI lacks `--add-dir` (Muse does). |
| [`scripts/lib/launcher.sh:336-420`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L336-L420) | `write_launcher` | The generated launcher appends `--add-dir` grants for the mailbox, the responses folder and bound inputs. | Muse's `case` must not expand `coord_grant`. |
| [`githooks/post-merge:16-29`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/githooks/post-merge#L16-L29) | launcher regeneration | Rebuilds `start-<id>.sh` from the same library. | No. |
| [`src/install.ts:197-222`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L197-L222) | `validateAgentIds` | Runs `launcher_command` per id and refuses unknown ids. | No (it enforces the launcher edit). |
| [`src/setupWorkspace.ts:548-590`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L548-L590) | `writeAgentLauncher` | Renders the launcher through the shell library. | No. |
| [`src/cli.ts:135-137`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135-L137) | `agentExecutables` | A second executable table (`agent`, `agy`) that duplicates `launcher.sh` knowledge. | **Yes.** Muse must not get `muse update` (§4). |
| [`src/cli.ts:142-180`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L142-L180) | `updateAgentVersions` | Runs `<exe> update` then `<exe> --version` before a fresh start. | Yes, see above. |
| [`src/cli.ts:1151`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1151) | `onboard` default roster | Default `--agents`. | Product decision. |
| [`src/install.ts:873`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L873) | `install` default roster | Default agents. | Product decision. |
| [`scripts/setup_common.sh:15-17`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L15-L17), [`scripts/setup_common.sh:118`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L118) | legacy setup | Vendor list in comments and project-name suffix detection. | Yes, data (legacy path). |
| [`scripts/setup_claude.sh:10-12`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_claude.sh#L10-L12), [`scripts/setup_codex.sh:21-24`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_codex.sh#L21-L24), [`scripts/setup_cursor.sh:16-19`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_cursor.sh#L16-L19), [`scripts/setup_antigravity.sh:24-26`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_antigravity.sh#L24-L26) | per-vendor setup scripts | Vendor-only harness configuration. `LAUNCH_CMD` is set but never read (`cursor` even names the wrong executable). | Optional new `setup_<id>.sh`. These scripts are legacy (docs/setup-workspace.md, "Migrating off `scripts/setup_*.sh`"). |

### 2.3 Trust, instruction files and ignores

| Site | Symbol / key | Current vendor behaviour | Edit needed? |
| --- | --- | --- | --- |
| [`src/agentTrust.ts:54`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L54) | supported list | Only the four vendors get persisted folder trust. | Yes, data. |
| [`src/agentTrust.ts:76-129`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L76-L129) | `syncAgentTrust` | Codex `config.toml` project tables; Claude `.claude.json` `hasTrustDialogAccepted`; Cursor `projects/<key>/.workspace-trusted`; Antigravity `trustedWorkspaces`. | Yes, behaviour, if the CLI has a persistent trust store. |
| [`src/agentsProtocol.ts:182-210`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentsProtocol.ts#L182-L210) | `writeClaudeAgentsShim` | Claude needs a `CLAUDE.md` that imports `AGENTS.md`; the others read `AGENTS.md` natively. | Only if the CLI does not load `AGENTS.md`. |
| [`src/productIgnore.ts:35-46`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L35-L46) | `DEFAULT_CLONE_IGNORES` | Clone `.git/info/exclude` lines for vendor config directories. | Yes, data. |
| [`templates/product/gitignore.coordination.block:4-9`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/templates/product/gitignore.coordination.block#L4-L9) | template | The same directories as static text. No code reads this file at the baseline. | Consistency only. |
| [`.gitignore:6-10`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/.gitignore#L6-L10) | this repository | The same directories. | Consistency only. |

### 2.4 Lifecycle hooks and shell containment

| Site | Symbol / key | Current vendor behaviour | Edit needed? |
| --- | --- | --- | --- |
| [`src/agentEvent.ts:17-18`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17-L18) | `LifecycleVendor` | The closed vendor enum for `agent-event` and `git-guard`. | **Yes.** |
| [`src/agentHookSync.ts:13-14`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13-L14) | `vendorForAgent` | The vendor is the agent id (the fifth copy of the list). | Yes, data. |
| [`src/agentHookSync.ts:16-30`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L16-L30) | hook settings path | `.codex/hooks.json`, `.claude/settings.local.json`, `.cursor/hooks.json`, `.agents/hooks.json`. | Yes, data. |
| [`src/agentHookSync.ts:48-52`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L48-L52) | guard fast path | Allow output for unrelated commands: empty for Claude and Codex, `{"permission":"allow"}` for Cursor, `{"decision":"allow"}` for Antigravity. | Yes, if the allow form differs. |
| [`src/agentHookSync.ts:106-117`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L106-L117) | event tables | Codex and Claude nested events; Cursor's flat events; Antigravity's three events. | Yes, behaviour/data. |
| [`src/agentHookSync.ts:119-203`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L119-L203) | `plannedDocument` | Nested matcher groups (Codex/Claude, with Claude `editorMode`), flat Cursor list, and an Antigravity named hook. **Any vendor that is not Codex, Claude or Cursor falls through to the Antigravity layout** at line 176. | **Yes, behaviour.** |
| [`src/agentHookSync.ts:228-289`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L228-L289) | `removeAgentLifecycleHooks` | The same three layouts. The `else` at line 260 is the Antigravity fall-through. | Yes, behaviour. |
| [`src/agentHookSync.ts:293-320`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L293-L320) | `inspectAgentLifecycleHooks` | Doctor's `current`/`modified` check, with an Antigravity disable flag. | Yes, if the CLI has a disable flag. |
| [`src/agentHookSync.ts:324-333`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L324-L333) | Antigravity status line | A user-global status-line tee for session identity. | No (Antigravity only). |
| [`src/agentEvent.ts:61-183`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L61-L183) | `normalizeAgentEvent` | Per-vendor event names, session and turn keys, prompt identity and failure fields. **The final block (line 177) handles any vendor that is not Codex, Claude or Cursor as Antigravity.** | **Yes, behaviour.** |
| [`src/agentEvent.ts:187-230`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L187-L230) | Cursor usage | Cursor token and tool analytics from hooks. | No. |
| [`src/shellGuard.ts:30-37`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L30-L37) | guard envelope | Cursor `permission`, Antigravity `decision`, and the Claude/Codex `hookSpecificOutput` deny as the default branch. | Only if the envelope differs. |
| [`src/shellGuard.ts:39-51`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L39-L51) | `normalizeShellRequest` | Command field: Cursor `command`, Antigravity `toolCall.args.CommandLine`, and `tool_input.command` otherwise. | Only if the field differs. |
| [`src/cli.ts:306-307`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L306-L307) | usage text | Lists the vendor values. | Yes, data. |
| [`src/cli.ts:1258-1275`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1258-L1275) | `git-guard` | An invalid vendor fails open with the Codex (empty) response. | No. |
| [`src/cli.ts:1300-1303`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1300-L1303) | `agent-event` | Antigravity `Stop` must answer `{"decision":"allow"}`. | Only if the CLI requires a Stop reply. |
| [`src/doctor.ts:357-367`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L357-L367) | doctor | Warns that nudge delivery is set without hooks, naming the four vendors. | Yes, data (message). |

### 2.5 Terminal delivery, readiness and nudging

| Site | Symbol / key | Current vendor behaviour | Edit needed? |
| --- | --- | --- | --- |
| [`src/tmux.ts:49-60`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49-L60) | process aliases | Claude's version string, Cursor's `node`, and Antigravity's `agy`, `antigravity` or `node`. Otherwise the match must be exact. | **Yes** for any CLI whose process name differs (Muse: §4). |
| [`src/tmux.ts:64-75`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L64-L75) | `PromptBlockedReason` | A closed union of vendor-specific "not ready" reasons. | Yes, if new reasons are added. |
| [`src/tmux.ts:217-257`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L217-L257) | readiness | Claude usage-wait and prompt glyphs, Cursor and Codex turn chrome, and the Antigravity verify overlay. **The default is "ready".** | **Yes, behaviour.** Without a case, a busy pane is "ready". |
| [`src/tmux.ts:269-275`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L269-L275) | vim fallback | Every vendor except Antigravity and Codex gets a literal `a` unless `INSERT` is visible. | **Yes** for any non-vim CLI. |
| [`src/tmux.ts:291-312`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L291-L312) | editor mode | Claude `editorMode` and Cursor `editor.vimMode` settings. | No. |
| [`src/tmux.ts:327-370`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L327-L370) | `resolveNudgeKeys` | Per-vendor key fixes. **A configured bare `Enter` is "upgraded" to the default unless the id is `antigravity`** (lines 362-367). | **Yes**, or the operator cannot configure Enter. |
| [`src/tmux.ts:381`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L381) | pacing | An Antigravity-only pre-nudge delay. | Only if needed. |
| [`src/tmux.ts:430-439`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L430-L439) | scrolling | Mouse and scrollbar options for a vendor list. | Optional, data. |
| [`src/tmux.ts:1136-1138`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L1136-L1138) | gate | A mismatched process name keeps the pane "busy", so no nudge is delivered. | No (consumer). |
| [`src/runLoop.ts:919-930`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L919-L930) | reason text | Owner-facing wording per readiness reason. | Yes, with new reasons. |
| [`src/runLoop.ts:1447-1456`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1447-L1456), [`src/runLoop.ts:1370`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1370) | Claude usage wait | Claude's usage-limit pane becomes a `vendor-wait` hold. | No. |

### 2.6 Usage, transcripts, failures and quota (optional per vendor)

| Site | Symbol / key | Current vendor behaviour | Edit needed? |
| --- | --- | --- | --- |
| [`src/transcriptRead.ts:12-13`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L12-L13) | vendor unions | Transcripts for Claude and Codex; usage for those plus Cursor. | Only for token analytics. |
| [`src/transcriptRead.ts:110-122`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L110-L122), [`src/transcriptRead.ts:486-490`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L486-L490), [`src/transcriptRead.ts:530`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L530) | transcript readers | Claude `projects/*/<session>.jsonl`; Codex `sessions/Y/M/D`. | Only for token analytics. |
| [`src/runLoop.ts:1101-1103`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1101-L1103), [`src/cli.ts:1540-1543`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1540-L1543) | transcript roots | `~/.claude`, `~/.codex`. | Only for analytics. |
| [`src/runLoop.ts:2029`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L2029) | watchdog stamp | Transcript growth counts as activity only for Claude and Codex. | Optional. |
| [`src/analytics.ts:508-516`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L508-L516) | analytics vendor | Maps ids to usage sources; others report "no supported local usage store". | Only for analytics. |
| [`src/agentLifecycle.ts:154`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L154), [`src/agentLifecycle.ts:472-476`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L472-L476) | failure classification | Claude and Cursor failure fields. | Optional. |
| [`src/resourceEvidence.ts:41`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L41), [`src/resourceEvidence.ts:153-189`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L153-L189) | resource evidence | Claude rate-limit and Cursor status classifiers, and the Codex limits parser. | Optional. |
| `src/claudeStatusLine.ts`, `src/codexQuota.ts`, `src/cursorHookUsage.ts` | vendor modules | Claude status-line tee, Codex App Server quota read, Cursor hook usage. | No (vendor-only). |
| [`src/runLoop.ts:1462-1463`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1462-L1463), [`src/runLoop.ts:1538-1560`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1538-L1560), [`src/runLoop.ts:1563-1700`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1563-L1700) | resource holds | Codex quota polling and Claude deadline release. | No. |
| [`src/install.ts:456`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L456), [`src/install.ts:476-481`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L476-L481), [`src/install.ts:520-521`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L520-L521), [`src/install.ts:677`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L677), [`src/install.ts:707-709`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L707-L709), [`src/doctor.ts:391-405`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L391-L405) | install/doctor wiring | Vendor-specific extras installed, removed and inspected. | Only with new vendor extras. |
| [`src/paths.ts:472-480`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/paths.ts#L472-L480), [`src/issueReport.ts:165`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/issueReport.ts#L165) | Codex quota records | Binding records and recovery text. | No. |

### 2.7 Documentation

`README.md` (vendor badges and list, [`README.md:11-14`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/README.md#L11-L14)), `docs/setup-workspace.md`, `docs/readiness-policy.md`, `docs/coord-driver.md` and `docs/analytics.md` name the four vendors. A new CLI should update the README list and the readiness and analytics coverage statements.

## 3. Current capabilities

### 3.1 Capability matrix

Each column is an independent capability; launch support does not imply the rest.

| Capability | Claude | Codex | Cursor | Antigravity | Gemini (launcher only) |
| --- | --- | --- | --- | --- | --- |
| `install` accepts id (launcher case) | yes | yes | yes | yes | yes |
| Unattended launch flags | auto mode | `--ask-for-approval never`, workspace-write | `--sandbox enabled` | `--dangerously-skip-permissions` | none (bare `gemini`) |
| Completion-mailbox grant (`--add-dir`) | yes | yes | yes | advisory (not sandboxed) | no |
| Fresh-start update and version | yes | yes | yes (`agent`) | yes (`agy`) | skipped |
| Persisted folder trust | yes | yes | yes | yes | no |
| Lifecycle hooks (prompt and stop correlation) | yes | yes | yes | partial (invocations, status) | no |
| Native shell Git guard | yes (`Bash`) | yes (`Bash`) | yes (`beforeShellExecution`) | yes (`run_command`) | no (git shim only) |
| Vendor-aware readiness | yes | yes | yes | yes | no (default "ready") |
| Safe default nudge keys | yes | yes | yes | yes | no (vim `a`, Escape) |
| Token and tool analytics | transcripts | transcripts | hook usage | no | no |
| Failure classification | yes | via quota | status only | no | no |
| Quota or usage-window recovery | status-line deadline | App Server quota | no | no | no |

### 3.2 What happens to an unknown agent id today

The trace below uses `muse` as the id, against a build of the baseline (`pnpm build`, then the exported functions called with `{ id: "muse", … }`):

1. **Validation and install.** `agentIdSchema` accepts it. `install` refuses it until `launcher_command` has a case ([`src/install.ts:211-218`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L211-L218)).
2. **Config defaults.** `agentHarnessProcess("muse")` returns `muse`, `agentLabel` returns `Muse`, and `agentOwnerUiDefaults` returns `{"nudgePrelude":[],"nudgeSubmit":["Escape","Enter"],"terminalProfile":"Basic"}` (observed).
3. **Nudge keys.** `resolveNudgeKeys` returns `{"prelude":["a"],"submit":["Escape","Enter"]}` for an idle pane (observed). Configuring `nudgePrelude: []` and `nudgeSubmit: ["Enter"]` returns **the same value** (observed): the empty prelude still reaches the vim fallback, and the bare `Enter` is "upgraded". An operator therefore cannot configure safe keys for a new vendor.
4. **Readiness.** `harnessPromptReadiness("Thinking... esc to interrupt", "muse")` returns `{"ready":true}` (observed): no busy detection.
5. **Process gate.** `harnessLooksReady("muse-bin-1.4.7-R6101.1", "muse")` returns `false` (observed). The pane stays `foreground-mismatch` and no nudge is ever delivered.
6. **Hooks.** `vendorForAgent` returns `null`, so no hooks, no shell guard and no trust are installed. Doctor warns only if delivery is `nudge` or `both`. `coord agent-event --vendor muse` fails schema parsing and answers `{}`.
7. **Fresh start.** `updateAgentVersions` warns "no known vendor command" and records no version.
8. **Analytics.** "no supported local usage store for this agent".

Steps 3 to 5 are the silent paths: each one passes type checking and tests while doing the wrong thing.

## 4. Meta Muse Code assessment

**Product identification.** "Muse" here means **Muse Code**, Meta's terminal coding agent (the `muse` CLI). It is not the Muse Spark model it runs by default (`muse-spark-1.2`), and it is not any unrelated product named Muse.

### 4.1 Sources and provenance

| Source | States | Accessed |
| --- | --- | --- |
| [User manual](https://dev.meta.ai/docs/muse-code) with [configuration](https://dev.meta.ai/docs/muse-code/configuration), [permissions](https://dev.meta.ai/docs/muse-code/permissions), [interactive use](https://dev.meta.ai/docs/muse-code/interactive) and [changelog](https://dev.meta.ai/docs/muse-code/changelog) | No version stated on the pages; the changelog lists 1.4.2 to 1.4.9 without dates | 2026-10-15 |
| [Developer documentation](https://meta-models.github.io/muse-code-sdk/1.4/) | "Muse Code 1.4", generating commit `633e270c4b4c2e680c215786759c5cf6ba47513d` | 2026-10-15 |
| [Hooks guide](https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/), [hook events and payloads](https://meta-models.github.io/muse-code-sdk/1.4/guides/plugins/reference/hook-events/) | **Muse Code 1.3.0** (the page text, despite the `/1.4/` path) | 2026-10-15 |
| Local install, `~/.local/bin/muse` | `muse --version` reports `Muse Code 1.4.7 (1.4.7-R6101.1)`; launcher script `launcher_version="3"` | 2026-10-15 |

The hook contract is documented for 1.3.0, while the installed CLI is 1.4.7. Every hook fact below must therefore be verified live before code depends on it. Only read-only `--version`, `--help`, `export --help` and the launcher script text were inspected locally; no session, login or installation was performed.

### 4.2 Findings per integration seam

Status key: **D** = documented; **O** = locally observed; **P** = proposed mapping; **?** = open question.

| Seam | Finding | Status |
| --- | --- | --- |
| Install | `curl -fsSL https://dev.meta.ai/install.sh \| sh` installs a `muse` launcher on `PATH`. | D |
| Update | There is no `update` subcommand. `muse [OPTIONS] [PROMPT]` treats a bare word as a prompt, so `muse update` would **start a session** with the prompt "update". | O (`--help`) |
| Update | The launcher self-updates in the background at most hourly. `MUSE_NO_AUTO_UPDATE=1` disables this and `MUSE_SYNC_UPDATE=1` updates synchronously before running. | O (launcher script) |
| Version | `muse --version` prints `Muse Code 1.4.7 (1.4.7-R6101.1)`. | D, O |
| Process name | The launcher execs `<install dir>/muse-bin-<version>`, so the tmux foreground name is versioned (and may be truncated by the OS). | O (script), ? (tmux value) |
| Model | `--model` (default `muse-spark-1.2`) and `--reasoning-effort` (default `high`). | D, O |
| Unattended approval | `--approval-mode never` or `--disable-approval`. `--yolo` disables approval and sandbox and trusts the workspace for the run. | D, O |
| Sandbox | On by default. It allows writes to the workspace and temp only, **with `.git`, `.muse` and `.agents` read-only**, and network `proxy-only`. `--disable-sandbox` lifts this and lets file tools write anywhere. | D |
| Extra writable roots | There is **no `--add-dir`**. Permission profiles can add `workspace_roots`, but since 1.4.8 the CLI refuses profiles it cannot enforce. `--workspace <PATH>` registers "policy-gated workspace tools"; whether it grants writes is unknown. | D, O, ? |
| Trust | The TUI asks once per workspace root and remembers it; the store location is undocumented. `--trust-workspace` trusts for one run without saving (since 1.4.4 it "only decides whether the workspace's skills and rules load"). | D, ? (store, and whether TUI per-run trust enables project hooks) |
| Instructions | Muse reads `AGENTS.md`, then `CLAUDE.md`, `.agents/AGENTS.md`, `.claude/CLAUDE.md` per directory up to the `.git` boundary. **Project rules load only in a trusted workspace.** | D |
| Config | User settings are in `~/.config/muse/settings.json` (`schema_version: 1`); project hooks are in `<root>/.muse/hooks.json`. | D |
| Hook layout | `{"hooks": {"<Event>": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "…", "timeout": 30}]}]}}`. This is the nested layout coord already writes for Claude and Codex. Commands run through `$SHELL -c`. `Bash` or `shell` matches the shell tool. Untrusted projects contribute no handlers. | D (1.3.0) |
| Hook events | `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure`, `SessionEnd`, and others. | D (1.3.0) |
| Hook payload | Common keys are `hook_event_name`, `session_id`, `turn_id`, `cwd`, `transcript_path`, `model` and `permission_mode`. Per event: `prompt`, `tool_name`/`tool_input`, and `error`/`error_details`/`last_assistant_message` (StopFailure). These are the field names coord's Claude branch already reads. | D (1.3.0) |
| Hook command field | Shell `tool_input` content is parsed JSON, but the key holding the command string is not named. | ? |
| Hook output | The deny form is `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "…"}}`, identical to coord's default guard response. `allow` is valid only with `updatedInput`, so empty output is the correct no-objection. Failures and timeouts are fail-open. | D (1.3.0) |
| Hook environment | Hooks receive `MUSE_SESSION_ID` (1.4.4). | D |
| Submit keys | `Enter` submits. **`Enter` during a running turn "steers" text into that turn.** **`Esc` interrupts the current turn.** No vim mode is documented. | D |
| Busy chrome | A one-line reasoning summary appears in the status row while a turn runs; its exact text is undocumented. | D, ? |
| Transcripts | Per-session `session.jsonl` in a local store (`muse export`). `transcript_path` is in every hook payload. | O (`export --help`), D |
| Usage and quota | `/status` shows context usage; no rate-limit telemetry is documented (1.4.5 notes it does not appear). | D |
| Headless | `muse exec` runs one prompt; `muse serve` runs MSP over stdio; `@muse-code/sdk`. | D, O |

### 4.3 Consequences for coord

- **Hooks need almost no new code.** Muse's documented hook contract fits coord's existing Claude/Codex path almost unchanged:
  - the same nested hook-file layout;
  - the same payload keys;
  - the same deny envelope.
- **Launch is the hard part.** Unattended commits need `.git` writable, and the default sandbox blocks that. The mailbox grant cannot use `--add-dir`. The likely launch is `muse --approval-mode never --disable-sandbox --trust-workspace` with `MUSE_NO_AUTO_UPDATE=1`. That mirrors the Antigravity choice not to sandbox an agent that must push. It must be verified with a live run that commits, pushes and writes the completion receipt.
- **Nudging is unsafe without code changes.** Muse's Escape cancels a turn, its Enter steers a running turn, and it has no vim mode. Today's unknown-id defaults (§3.2) would type `a`, press Escape, and treat a busy pane as ready.

## 5. Muse change map under the current architecture

Nearest existing test homes are named; "new file" means no baseline lines exist.

### 5.1 Tier A: launch and pull-mode participation (required)

| # | Site | Change | Why | Test home |
| --- | --- | --- | --- | --- |
| A1 | [`scripts/lib/launcher.sh:46-99`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46-L99) | Add a `muse)` case, for example `exec muse --approval-mode never --disable-sandbox --trust-workspace`, **without** `coord_grant`. | `install` requires it. Muse rejects `--add-dir`, and the default sandbox keeps `.git` read-only. | `test/install.test.ts`, `test/wrapper.test.ts` |
| A2 | [`scripts/lib/launcher.sh:19-33`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L19-L33) | `export MUSE_NO_AUTO_UPDATE=1` for `muse`. | Coord updates CLIs before launch, never mid-issue ([`scripts/lib/launcher.sh:59`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L59)). | `test/cli.test.ts` ("fresh-start agent maintenance") |
| A3 | [`src/cli.ts:135-180`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135-L180) | Do **not** add `["muse","muse"]`. Either leave Muse unlisted (a warning, no version) or run `MUSE_SYNC_UPDATE=1 muse --version` (see §6.2, item 11). | `muse update` would start a session. | `test/cli.test.ts` |
| A4 | [`src/setupWorkspace.ts:29-38`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L29-L38), [`src/tmux.ts:49-60`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49-L60) | Accept a `muse-bin-` prefix (and any truncation, once measured). | Exact matching never succeeds (§3.2, step 5). | `test/tmux.test.ts` |
| A5 | [`src/setupWorkspace.ts:52-67`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L52-L67), [`src/tmux.ts:269-275`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L269-L275), [`src/tmux.ts:327-370`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L327-L370) | Default `submit: ["Enter"]` and `prelude: []`; exclude Muse from the vim fallback and from the bare-Enter upgrade. | Escape cancels a turn; the `a` lands in the prompt (§3.2, step 3). | `test/tmux.test.ts` (next to "honors explicit empty prelude over Codex defaults") |
| A6 | [`src/productIgnore.ts:35-46`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L35-L46) | Add `.muse/`. | The hook file must not be offered for commit. | `test/install.test.ts` |
| A7 | [`src/setupWorkspace.ts:107-114`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L107-L114) | Optional `muse: "Muse"` (the fallback already yields `Muse`). | Explicit label. | — |
| A8 | [`src/agentTrust.ts:54`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L54) | None while trust is passed per run. Add a writer only if the trust store becomes documented. | `AGENTS.md` and project hooks load only when trusted. | `test/install.test.ts` |
| A9 | `README.md`, `docs/setup-workspace.md`, `docs/readiness-policy.md` | Name Muse and its coverage. | Operator truth. | `pnpm check:docs` |

Muse needs no `CLAUDE.md`-style shim, because it reads `AGENTS.md` natively. The default rosters ([`src/cli.ts:1151`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1151), [`src/install.ts:873`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L873)) should stay unchanged until Muse is validated.

### 5.2 Tier B: nudge delivery, lifecycle and containment (for `delivery: both`)

| # | Site | Change | Why | Test home |
| --- | --- | --- | --- | --- |
| B1 | [`src/agentEvent.ts:17`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17) | Add `"muse"`. | Hook commands pass `--vendor muse`. | `test/agentEvent.test.ts` |
| B2 | [`src/agentEvent.ts:61-183`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L61-L183) | Add an explicit Muse branch (Claude's key set, plus `StopFailure`; no status line) **before** the Antigravity fall-through at line 177. | Otherwise Muse events are parsed as Antigravity's. | `test/agentEvent.test.ts` |
| B3 | [`src/agentHookSync.ts:13-30`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13-L30) | Map `muse` to `.muse/hooks.json`. | The documented project hook path. | `test/agentHookSync.test.ts` |
| B4 | [`src/agentHookSync.ts:106-109`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L106-L109), [`src/agentHookSync.ts:119-157`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L119-L157), [`src/agentHookSync.ts:228-289`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L228-L289) | Add a Muse event list and route Muse through the nested planner and remover (no `editorMode`). | Otherwise Muse falls through to the Antigravity layout (line 176) and remover (line 260). | `test/agentHookSync.test.ts` |
| B5 | [`src/shellGuard.ts:39-51`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L39-L51) | Confirm Muse's shell `tool_input` key. If it is `command`, no change; the envelope at [`src/shellGuard.ts:30-37`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L30-L37) already matches. | An unrecognized key makes the guard a no-op, so it fails open. | `test/shellGuard.test.ts` |
| B6 | [`src/tmux.ts:64-75`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L64-L75), [`src/tmux.ts:217-257`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L217-L257), [`src/runLoop.ts:919-930`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L919-L930) | Add a Muse turn-chrome check and reason text, measured from a live pane. | `Enter` mid-turn steers the action text into the running turn. | `test/tmux.test.ts`, `test/runLoop.test.ts` |
| B7 | [`src/cli.ts:306-307`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L306-L307), [`src/doctor.ts:357-367`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L357-L367) | Add Muse to the usage and doctor text. | Accurate diagnostics. | `test/doctor.test.ts` |

### 5.3 Tier C: optional telemetry

| # | Site | Change | Condition |
| --- | --- | --- | --- |
| C1 | [`src/transcriptRead.ts:12-13`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L12-L13), [`src/transcriptRead.ts:486-490`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L486-L490), [`src/transcriptRead.ts:530`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L530), [`src/analytics.ts:508-516`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L508-L516), [`src/runLoop.ts:1101-1103`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L1101-L1103), [`src/runLoop.ts:2029`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/runLoop.ts#L2029), [`src/cli.ts:1540-1543`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1540-L1543); new fixture `test/support/fixtures/transcript-muse.jsonl` (new file) | A Muse transcript reader. The hook `transcript_path` could be journaled instead of searching an undocumented store. | Only when token analytics for Muse are wanted; needs the session-log schema. |
| C2 | [`src/agentLifecycle.ts:154`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L154), [`src/agentLifecycle.ts:472-476`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L472-L476), [`src/resourceEvidence.ts:41`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L41) | Classify Muse `StopFailure` `error` values. | Only once Muse's error vocabulary is known. |
| C3 | none | No quota or usage-window recovery. | Muse documents no rate-limit telemetry. |

**Count.**
- **Tiers A and B together** make 16 changes across **10 existing source files**: `launcher.sh`, `cli.ts`, `setupWorkspace.ts`, `tmux.ts`, `productIgnore.ts`, `agentEvent.ts`, `agentHookSync.ts`, `runLoop.ts` and `doctor.ts`, plus `shellGuard.ts` only if Muse's command key differs. They cite 27 baseline sites, of which 4 need no edit (`agentTrust.ts`, the two default rosters, and the update table, which must stay unchanged).
- **Docs and tests.** Three docs change, and six existing test files are extended.
- **Tier C** touches 6 more files.

## 6. Architecture options and recommendation

### 6.1 Options

| Option | What it is | Cost | Benefit |
| --- | --- | --- | --- |
| **1. Continue as is** | Add a case to each list and switch per vendor. | About 23 edited sites in 10 files per vendor (§5). The silent fall-throughs (§3.2) remain, so every addition relies on reviewers finding all of them. | No migration. |
| **2. Exhaustive vendor table (recommended)** | One closed `Vendor` union with a table of identity data. Every vendor dispatch becomes exhaustive. Behaviour stays in today's functions. The shell launcher stays the only argv source. | A one-time change to 14 existing files plus one new file; no behaviour change except the unknown-id defaults. | Adding a vendor becomes one table row, one `launcher.sh` case, and whatever behaviour the compiler then flags. Silent fall-throughs become type errors. |
| **3. Plugin/adapter layer or MSP transport** | A vendor interface (launch, hooks, trust, readiness, telemetry) per CLI, or driving agents over a session protocol instead of tmux. | A rewrite of the harness surface and its tests. Optional seams (quota, status line, transcripts) become empty stubs. MSP is one vendor's protocol, not a common contract. | Uniformity that four or five vendors do not need. |

Option 1 is viable but carries the defects in §3.2. Option 3 relocates vendor logic without removing any: the behaviour sites in §2 are genuinely different per vendor (four hook formats, three guard envelopes, four trust stores). Option 2 removes the duplicated lists and, more importantly, makes the compiler enumerate the remaining sites for the next vendor. **Recommendation: option 2, done once, as the first step of the Muse integration.**

### 6.2 Exact edits for option 2

**New file `src/vendors.ts`** (no baseline lines). It exports:

- `VENDORS`: a `const` record keyed `claude | codex | cursor | antigravity`. Each entry holds `label`, `harnessProcess`, `processAliases` (exact or prefix), `nudgePrelude`, `nudgeSubmit`, `terminalProfile`, `vimFallback`, `mouseScrolling`, `scrollbars`, `hookSettingsPath`, `cloneIgnores`, and `persistentTrust`.
- `type Vendor`.
- `vendorOf(agentId): Vendor | null`.
- `assertNever`.

It is a new module because the data is consumed by install-time (`setupWorkspace`, `install`), hook-time (`agentEvent`, `agentHookSync`) and run-time (`tmux`) code. Placing it in any one of them would add an import cycle. It holds no argv.

| # | Existing site | Edit |
| --- | --- | --- |
| 1 | [`src/agentEvent.ts:17-18`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17-L18) | Derive the schema from `VENDORS` keys. |
| 2 | [`src/agentEvent.ts:61-183`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L61-L183) | Make the Antigravity block explicit (line 177) and end with `assertNever`. |
| 3 | [`src/agentHookSync.ts:13-30`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13-L30) | Use `vendorOf` and `VENDORS[v].hookSettingsPath`. |
| 4 | [`src/agentHookSync.ts:119-203`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L119-L203), [`src/agentHookSync.ts:228-289`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L228-L289) | Switch per vendor with explicit Antigravity cases (lines 176 and 260); no `else`. |
| 5 | [`src/shellGuard.ts:30-51`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L30-L51) | Exhaustive switch for the envelope and the command field. |
| 6 | [`src/agentTrust.ts:43-129`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L43-L129) | `vendorOf` plus an exhaustive switch; a vendor without persistent trust is an explicit no-op case. |
| 7 | [`src/setupWorkspace.ts:29-67`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L29-L67), [`src/setupWorkspace.ts:107-114`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L107-L114) | Read `VENDORS`. **Unknown ids default to `["Enter"]` with no prelude.** |
| 8 | [`src/tmux.ts:49-60`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49-L60), [`src/tmux.ts:269-275`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L269-L275), [`src/tmux.ts:327-370`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L327-L370), [`src/tmux.ts:430-439`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L430-L439) | Aliases, vim fallback, mouse and scrollbars from the table. A configured bare `Enter` is honoured for every vendor except those whose legacy upgrade is recorded in the table. |
| 9 | [`src/tmux.ts:217-257`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L217-L257) | Exhaustive switch; unknown ids keep "ready" (no vendor chrome is known). |
| 10 | [`src/productIgnore.ts:35-46`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L35-L46) | Spread `cloneIgnores` from the table in the same order. |
| 11 | [`src/cli.ts:135-180`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135-L180) | Replace the TypeScript executable table with a new `launcher_maintenance <agent> <update\|version>` function in [`scripts/lib/launcher.sh:46-99`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46-L99), called the way `launcher_environment` already is. Shell stays the single argv authority, and Muse can use `MUSE_SYNC_UPDATE=1 muse --version`. |
| 12 | [`src/cli.ts:306-307`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L306-L307), [`src/doctor.ts:357-367`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L357-L367) | Render the vendor lists from the table. |
| 13 | [`src/transcriptRead.ts:12-13`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L12-L13), [`src/resourceEvidence.ts:41`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L41), [`src/agentLifecycle.ts:154`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L154), [`src/analytics.ts:508-516`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L508-L516) | Type the capability subsets as `Extract<Vendor, …>`; no behaviour change. |

Left unchanged:

- the default rosters ([`src/cli.ts:1151`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L1151), [`src/install.ts:873`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L873)), which are a product choice, typed `Vendor[]`;
- the legacy setup scripts;
- the static templates (their lists are kept consistent by hand).

**Tests.** Existing files are extended; no new test file is needed:

- `test/agentHookSync.test.ts`, `test/agentEvent.test.ts`, `test/shellGuard.test.ts` and `test/install.test.ts` cover rows 1 to 6 and 10, and should keep their current outputs byte for byte.
- `test/tmux.test.ts` covers rows 7 to 9, with new unknown-id cases: no `a`, and a configured `Enter` honoured.
- `test/cli.test.ts` ("fresh-start agent maintenance") covers row 11.
- `test/doctor.test.ts` covers row 12.
- `pnpm typecheck` proves exhaustiveness.

### 6.3 Separating the vendor from the agent id (optional)

Today the agent id *is* the vendor. A second agent of the same CLI is therefore impossible; for example, two Muse agents on different `--model` values, or a Claude agent per model. Model selection has no plumbing at all: there is no `model` field, and the model comes from each vendor's launcher defaults. If "more model options" means that, the separation is needed:

- **Config.** Add an optional `vendor` field to [`src/state.ts:234-262`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L234-L262). It defaults to the id when the id is a known vendor. Frozen `start.json` files parse unchanged, because the field is optional. Every vendor dispatch would call `vendorOf(agent)`, the single function from §6.2; mailbox, branch and response paths keep the id.
- **Shell.** `write_launcher` ([`scripts/lib/launcher.sh:336-339`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L336-L339)) and the post-merge regeneration ([`githooks/post-merge:16-29`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/githooks/post-merge#L16-L29)) need the vendor. That means a `consensus.agentVendor` git config key beside [`githooks/lib/identity.sh:39-40`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/githooks/lib/identity.sh#L39-L40), written at [`src/setupWorkspace.ts:739-752`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L739-L752).
- **Model.** A per-agent model passes through as launcher argv (for example a `model` config value rendered by `launcher_command`), not as a second flag table.
- **Tests.** Add an install case for two agents sharing one vendor and a start-state parse of a pre-change `start.json` (`test/install.test.ts`, `test/state.test.ts`).

Do this only when a second agent of one CLI is actually wanted; it is not needed for Muse.

## 7. Follow-up sequence and acceptance criteria

1. **Unknown-id safety and exhaustive dispatch (§6.2).**
   - Acceptance: existing hook, guard, trust and install outputs are unchanged for the four vendors.
   - `tsc` fails if a `Vendor` key lacks a case.
   - An unknown id gets `["Enter"]`, no vim `a`, and an honoured configured `Enter`.
2. **Live Muse probe (no coord changes).** In a scratch clone:
   - record the tmux `pane_current_command`;
   - confirm `--approval-mode never --disable-sandbox --trust-workspace` can commit, push and write outside the workspace;
   - confirm `.muse/hooks.json` handlers run under per-run trust in the TUI;
   - capture a `PreToolUse` shell payload (its command key) and the busy and idle pane text;
   - record the trust store location if one appears.
   - Every **?** in §4.2 is then answered or carried forward explicitly.
3. **Muse Tier A** (pull delivery).
   - Acceptance: `install`, `doctor` and `uninstall` preserve owner settings.
   - The launcher starts Muse unattended and never self-updates mid-issue.
   - An issue completes with the `complete` and `ready` handshake.
   - Restart and recovery work.
4. **Muse Tier B** (`delivery: both`).
   - Acceptance: hook events correlate prompt and stop to the action.
   - The containment probe reports `hook-denied` for `git status`; doctor shows hooks `current`.
   - A nudge into a busy pane is deferred, never steered into the turn.
5. **Tier C, only if wanted.** Transcript and failure coverage is reported truthfully as available or unavailable.

Each step is its own issue, with its tests in the homes named above.
