# Issue 210: agent CLI integration inventory and Muse assessment

| Field | Value |
| --- | --- |
| Issue | [#210](https://github.com/gwhizoftv/4horsemen/issues/210) |
| Baseline | [`cb7ed092cb8a5d15f651387651df7c631e4596e6`](https://github.com/gwhizoftv/4horsemen/commit/cb7ed092cb8a5d15f651387651df7c631e4596e6) |
| Research date | 2026-10-15 |
| Scope | Documentation only — no runtime, schema, launcher, or test changes in this issue |
| Recommendation | **Keep per-vendor behaviour modules and the shared shell launcher.** When adding the next full harness (Muse or otherwise), introduce a small TypeScript **identity/capability table** for duplicated metadata only; do **not** build a plugin loader or second argv store. |

Source citations below use `path:line` at the baseline and GitHub blob links of the form
`…/blob/<baseline>/<path>#L…`. Do not paste machine-specific absolute paths into
this document (home directories appear as `~/…`).

## Recommendation (summary)

Coord already has one intentional single source for launch argv:
[`launcher_command`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46-L99)
in `scripts/lib/launcher.sh`. Hook document shapes, transcript parsers, pane
chrome, and quota readers are genuinely different per vendor; a plugin interface
would relocate that code without removing it.

What *is* duplicated is **identity metadata**: closed vendor enums, executable
names, update argv, harness process aliases, labels, nudge defaults, hook
settings paths, and ignore directories (~12 sites). Muse Code already breaks two
assumptions those sites encode (`update` as a universal subcommand; every vendor
accepts `--add-dir`). A small `Record<Vendor, …>` table pays for itself on the
next full harness; a broad rewrite does not.

| Design | One-time migration | Cost per new full harness | Verdict |
| --- | ---: | ---: | --- |
| Continue pure switches | 0 | Edit ~12 identity sites + all needed behaviour modules | Acceptable only if no fifth harness is planned |
| Identity/capability table + keep behaviour modules | ~12 TypeScript sites + tests that lock enums | Fill one table row + behaviour modules that Muse needs | **Recommended when Muse (or next harness) is implemented** |
| Plugin/adapter per vendor (launch, hooks, trust, TUI, telemetry) | Large | New adapter class + registration | Rejected — adds indirection without deleting vendor logic |

This issue does **not** implement Muse or the table. Follow-up work should use
the [Muse change map](#muse-change-map-current-architecture) and
[follow-up acceptance](#follow-up-acceptance-criteria).

## Method

1. Listed tracked paths with `git ls-files` (includes hidden tracked files under
   `githooks/`, `templates/`, `.github/` where present).
2. Searched with `rg -n` for whole vendor tokens `claude`, `codex`, `cursor`,
   `antigravity`, `agy`, `gemini`, and for concepts `launcher`, `harness`,
   `lifecycle`, `trust`, `hooks`, `nudge`, `sandbox`, `transcript`, `quota`.
3. Inspected matches and callers; verified named symbols at cited lines.
4. Excluded false positives: workflow `cursors.json` / `CursorsState` / generic
   “cursor” meaning the issue cursor; `test/vendor.test.ts` (product-tree hook
   *vendoring*, not CLI vendors); illustrative agent names in prose/fixtures
   that do not branch product behaviour.
5. Muse: primary Meta docs (below) plus read-only local `muse --version`,
   `muse --help`, and `muse export --help`. No install, login, live session, or
   credential work.

Evidence tiers for Muse claims:

| Tier | Meaning |
| --- | --- |
| **Observed** | Local read-only CLI output on 2026-10-15 |
| **Documented** | Primary vendor page; live behaviour not exercised here |
| **Open** | Absent from both help and primary docs, or docs/version mismatch |

## Current-vendor capability matrix

Participant ids (`agentIdSchema` at
[`src/protocol.ts:9`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/protocol.ts#L9))
are an open regex. Passing id validation is **not** full harness support.

| Capability | Claude | Codex | Cursor | Antigravity | Gemini |
| --- | --- | --- | --- | --- | --- |
| `launcher_command` case | yes | yes | yes (`agent`) | yes (`agy`) | yes (no mailbox grant) |
| Fresh-start `update` + `--version` (`agentExecutables`) | yes | yes | yes | yes | no |
| Install/onboard default roster | yes | yes | yes | yes | no |
| Folder trust (`syncAgentTrust`) | yes | yes | yes | yes | no |
| Lifecycle + shell-guard hooks | yes | yes | yes | yes | no |
| Automated nudge / readiness heuristics | yes | yes | yes | yes | no |
| Transcript / usage analytics | transcript | transcript | hook usage | no | no |
| Quota / rate-limit recovery | statusline path | `codexQuota` | status class | no | no |
| Legacy `scripts/setup_*.sh` | yes | yes | yes | yes | no |

Unsupported custom ids: install refuses unknown launcher cases; doctor warns when
lifecycle hooks are missing for nudge delivery; trust/hooks no-op outside the
four lifecycle vendors; update is skipped with a warning when the id is absent
from `agentExecutables`.

## Inventory of integration sites

Commit-pinned links use baseline `cb7ed092…`. “Edit?” = whether adding a **full**
coordination harness typically requires touching the site.

### Identity and closed unions

| Site | Symbol | Vendors / behaviour | Edit? | Kind |
| --- | --- | --- | --- | --- |
| [`src/agentEvent.ts:17`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L17) | `lifecycleVendorSchema` | `codex \| claude \| cursor \| antigravity` | yes | data |
| [`src/agentEvent.ts:61`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L61)–`:183` | `normalizeAgentEvent` | Per-vendor event/field mapping | yes | behaviour |
| [`src/agentEvent.ts:187`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentEvent.ts#L187)–`:233` | `normalizeCursorUsageEvent` | Cursor usage hooks | optional | behaviour |
| [`src/agentHookSync.ts:13`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L13)–`:14` | `vendorForAgent` | Id → lifecycle vendor or null | yes | data |
| [`src/agentHookSync.ts:16`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L16)–`:29` | `agentLifecycleHookPath` | Settings path per vendor | yes | data |
| [`src/agentHookSync.ts:106`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L106)–`:117` | event tables | Which events are installed | yes | data |
| [`src/agentHookSync.ts:48`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L48)–`:51`, [`:119`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L119)–`:196` | shell-guard allow JSON / `plannedDocument` | Document shapes | yes | behaviour |
| [`src/agentTrust.ts:54`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L54), [`:76`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L76)–`:128` | `syncAgentTrust` | Allowlist + per-vendor trust writers | yes | data+behaviour |
| [`src/cli.ts:135`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L135)–`:137`, [`:142`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L142)–`:183` | `agentExecutables` / `updateAgentVersions` | Binary + `update` / `--version` | yes | data+behaviour |
| [`src/cli.ts:306`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L306)–`:307` | CLI help | Documents closed `--vendor` set | yes | data |
| [`src/install.ts:873`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L873) | onboard defaults | Default four-agent roster | optional | data |
| [`src/transcriptRead.ts:12`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L12)–`:13` | `TranscriptVendor` / `UsageVendor` | claude/codex (+cursor usage) | optional | data |
| [`src/doctor.ts:357`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L357)–`:366`, [`:391`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L391)–`:405` | lifecycle / telemetry findings | Unsupported vendor + Claude/Codex checks | yes | behaviour |
| [`src/resourceEvidence.ts:26`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L26), [`:41`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts#L41) | evidence schemas | Claude/Codex/Cursor sources | optional | data |
| [`scripts/setup_common.sh:15`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L15)–`:16`, [`:118`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/setup_common.sh#L118) | allowed ids / clone regex | Includes gemini | yes (legacy) | data |

### Defaults derived from agent id

| Site | Symbol | Notes | Edit? |
| --- | --- | --- | --- |
| [`src/setupWorkspace.ts:30`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L30)–`:38` | `agentHarnessProcess` | `cursor`→`agent`, `antigravity`→`agy` | yes |
| [`src/setupWorkspace.ts:52`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L52)–`:66` | `agentOwnerUiDefaults` | Nudge keys + Terminal profile | yes |
| [`src/setupWorkspace.ts:108`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L108)–`:117` | `KNOWN_AGENT_LABELS` | Includes gemini | optional |
| [`src/setupWorkspace.ts:332`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L332)–`:358` | `buildWorkspaceConfig` agent scaffold | Uses helpers above | yes (via helpers) |
| `config.example.json`, `config.product.example.json` | example rosters | Operator examples | optional |

Config already carries per-agent `delivery`, `nudgePrelude`/`nudgeSubmit`,
`terminalProfile`, `launcher`, and `harnessProcess` without a source edit once
the agent is installable. There is **no** first-class model-selection field in
`agentConfigSchema` beyond vendor-specific optional blocks such as
`codexQuota` ([`src/state.ts:251`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/state.ts#L251)–`:318`).

### Launch, install, generated files

| Site | Symbol | Notes | Edit? |
| --- | --- | --- | --- |
| [`scripts/lib/launcher.sh:19`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L19)–`:32` | `launcher_environment` | PATH for antigravity | if needed |
| [`scripts/lib/launcher.sh:46`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L46)–`:99` | `launcher_command` | **Sole** argv/flag authority; comments claim every vendor accepts `--add-dir` | **yes** |
| [`scripts/lib/launcher.sh:336`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/scripts/lib/launcher.sh#L336) area | `write_launcher` | Renders `start-<agent>.sh` + grants | yes (via command case) |
| [`src/setupWorkspace.ts:548`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/setupWorkspace.ts#L548)–`:576` | `writeAgentLauncher` | Fails closed if no `launcher_command` case | yes |
| [`src/install.ts:197`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L197)–`:217` | `validateAgentIds` | Schema + launcher_command probe | yes |
| `githooks/post-merge` | regenerates launcher | Same library | yes (via library) |

### Legacy setup, instructions, ignores

| Site | Notes | Edit? |
| --- | --- | --- |
| `scripts/setup_{claude,codex,cursor,antigravity}.sh` + `setup_common.sh` | Active alternate setup paths; call into install trust where applicable | yes for legacy UX |
| [`src/agentsProtocol.ts:183`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentsProtocol.ts#L183)–`:209` | Claude `CLAUDE.md` → `@AGENTS.md` shim | if Muse needs an instruction bridge |
| [`src/productIgnore.ts:41`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/productIgnore.ts#L41)–`:46` | Vendor dirs in `DEFAULT_CLONE_IGNORES` | optional (add `.muse/`) |
| [`templates/product/gitignore.coordination.block:4`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/templates/product/gitignore.coordination.block#L4)–`:9` | Same dirs for `--write-product` | optional |
| `templates/product/AGENTS.md` | Product-facing agent rules template | optional |
| `githooks/lib/identity.sh` | Commit-message agent labels | optional |

### Trust, hooks, containment, doctor

| Site | Notes | Edit? |
| --- | --- | --- |
| [`src/agentTrust.ts:43`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentTrust.ts#L43)–`:128` | Codex TOML, Claude `.claude.json`, Cursor `.workspace-trusted`, Antigravity `trustedWorkspaces` | yes |
| [`src/agentHookSync.ts:205`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentHookSync.ts#L205)–`:319` | sync / remove / inspect | yes |
| Antigravity status-line helpers in `agentHookSync.ts` (~`:322`+) | User-global tee under `~/.gemini/antigravity-cli` | if analogous |
| [`src/shellGuard.ts:30`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L30)–`:51`, [`:280`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L280), [`:320`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/shellGuard.ts#L320) | Allow/deny envelopes + request normalization | yes |
| [`src/claudeStatusLine.ts`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/claudeStatusLine.ts) + install wiring [`src/install.ts:476`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/install.ts#L476)–`:481`, `:677` | Claude statusline | optional |
| Doctor checks after [`src/doctor.ts:354`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/doctor.ts#L354) | Hook presence ≠ harness enforcement | yes |

### Terminal delivery and run loop

| Site | Notes | Edit? |
| --- | --- | --- |
| [`src/tmux.ts:49`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L49)–`:60` | `harnessLooksReady` process aliases | yes |
| [`src/tmux.ts:217`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L217)–`:258` | `harnessPromptReadiness` | yes |
| [`src/tmux.ts:269`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L269)–`:368` | vim / `resolveNudgeKeys` | yes |
| [`src/tmux.ts:381`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/tmux.ts#L381)+, nudge path ~`:1171`–`:1268` | Composer empty, antigravity recapture | yes |
| `src/runLoop.ts` vendor branches (e.g. readiness ~`:925`, Claude wait ~`:1447`, Codex quota ~`:1462`–`:1702`, transcript roots ~`:1101`) | Holds, watchdogs, recovery | yes for automation |

See also `docs/readiness-policy.md` for hook-vs-pane precedence (prose; re-check against source if stale).

### Optional usage, quota, analytics

| Site | Vendors | Edit for minimum Muse? |
| --- | --- | --- |
| [`src/transcriptRead.ts:110`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/transcriptRead.ts#L110)+ | Claude, Codex | no |
| [`src/cursorHookUsage.ts:65`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cursorHookUsage.ts#L65)+, `:140` | Cursor | no |
| [`src/codexQuota.ts`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/codexQuota.ts), [`src/paths.ts:480`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/paths.ts#L480) | Codex | no |
| [`src/analytics.ts:509`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/analytics.ts#L509)+ | Routes by vendor | no |
| [`src/agentLifecycle.ts:154`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/agentLifecycle.ts#L154), `:472` | Claude/Cursor failures | no |
| [`src/resourceEvidence.ts`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/resourceEvidence.ts), `src/issueReport.ts` | Classification / operator copy | no |

### Tests and docs that encode vendors

Behaviour locks (extend when implementing Muse; **not** part of this issue):
`test/agentEvent.test.ts`, `test/agentHookSync.test.ts`, `test/shellGuard.test.ts`,
`test/tmux.test.ts`, `test/cli.test.ts`, `test/transcriptRead.test.ts`,
`test/cursorHookUsage.test.ts`, `test/codexQuota.test.ts`, `test/analytics.test.ts`,
`test/doctor.test.ts`, `test/onboard.test.ts`, `test/install.test.ts`,
`test/runLoop.test.ts`, `test/agentLifecycle.test.ts`, `test/state.test.ts`.
Fixtures: `test/support/workspaceFixture.ts`, transcript/analytics fixtures under
`test/support/fixtures/`.

Operator prose: `docs/setup-workspace.md`, `docs/coord-driver.md`,
`docs/readiness-policy.md`, `docs/analytics.md`, `docs/repo-map.md`, `README.md`.

### Excluded match categories

- Workflow state named “cursor” (`CursorsState`, `cursors.json`).
- `--vendor` hook delivery mode in install (copies hook bodies; not a CLI id).
- Comments/examples that mention agent names without branching.
- Unrelated GitHub Actions or dependency names.

Reproducible search (from repo root):

```sh
rg -n '\b(claude|codex|antigravity|agy|gemini)\b' src scripts githooks templates config*.json
rg -n '\bcursor\b' src scripts githooks templates config*.json
# Then drop CursorsState / cursors.json / vendor-hook-mode hits by inspection.
```

## Muse Code assessment

**Product:** Meta **Muse Code** (terminal/CI coding agent). Distinct from other
products named “Muse” and from the underlying Muse Spark model API.

### Sources and provenance

| Source | URL | Provenance recorded 2026-10-15 |
| --- | --- | --- |
| User manual | https://dev.meta.ai/docs/muse-code | Product overview; accessed 2026-10-15 |
| Versioned developer docs | https://meta-models.github.io/muse-code-sdk/1.4/ | URL segment “1.4”; treat per-page stated version as authoritative |
| Hooks reference | https://meta-models.github.io/muse-code-sdk/1.4/guides/extend/hooks/ | Page states samples are from **Muse Code 1.3.0** (mismatch with URL “1.4” and installed CLI) |
| SDK repository | https://github.com/meta-models/muse-code-sdk | Companion docs/SDK; not proof of tmux readiness |

**Observed local CLI (2026-10-15):** `muse --version` → `Muse Code 1.4.9
(1.4.9-R6297.1)`; binary on PATH at `~/.local/bin/muse` (wrapper). Flag and
subcommand claims below are from `muse --help` / `muse export --help` unless
marked documented.

Because the hooks page labels **1.3.0** while the installed binary is **1.4.9**,
treat hook JSON details as **documented; verify live before coding**.

### Muse capability facts

| Topic | Tier | Fact |
| --- | --- | --- |
| Interactive launch | Observed | `muse [OPTIONS] [PROMPT]` — bare word is a **prompt**, not a subcommand |
| Headless | Observed | `muse exec "…"` |
| Update | Observed | **No `update` subcommand.** Help lists `resume`, `exec`, `auth`, `login`, … — not `update`. Naive `agentExecutables` entry would make fresh-start run `muse update`, which starts a session with prompt `update` under the 180s timeout ([`src/cli.ts:150`](https://github.com/gwhizoftv/4horsemen/blob/cb7ed092cb8a5d15f651387651df7c631e4596e6/src/cli.ts#L150)–`:172`) |
| Version | Observed | `-V` / `--version` work |
| Writable roots | Observed | **No `--add-dir`.** Candidate: `--workspace <PATH>` (“policy-gated workspace tools”). Whether it grants mailbox writes is **open** |
| Approvals / sandbox | Observed | `--approval-mode never`, `--disable-approval`, `--disable-sandbox`, `--sandbox-network`, `--trust-workspace` (run-only trust; not persisted), `--yolo` (disables approval+sandbox and trusts) |
| Self-update | Documented / open | Background updater env (`MUSE_UPDATE_INTERVAL_SECONDS`) appears in vendor docs/community notes; **pin or disable for panes** is recommended by analogy with Codex’s no-self-update launcher flag — confirm on live Muse before coding |
| Auth | Documented | Browser login or `META_API_KEY` / `muse auth` — out of scope to exercise here |
| Project hooks | Documented (1.3.0 page) | `.muse/hooks.json`; requires trusted folder; events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `Stop`, `StopFailure`, `SessionEnd`, … |
| Hook deny shape | Documented (1.3.0 page) | Claude-like `hookSpecificOutput` / `permissionDecision`; exit 2 can block; shell tool matches `Bash` or `shell` |
| User hooks | Documented | `~/.config/muse/settings.json` `hooks` member (+ `schema_version`) |
| Sessions / export | Observed | `muse export` writes trajectory JSON; session store path for live analytics is **open** |
| Foreground process | Open | Wrapper execs a downloaded binary — measure `tmux` pane process name before setting `harnessProcess` |
| Composer / submit keys | Open | Needs live TUI observation before nudge defaults |
| AGENTS.md native load | Open | Confirm whether Muse loads `AGENTS.md` or needs a shim |
| MSP / `muse serve` | Documented | Separate transport; **not** a substitute for tmux delivery in this assessment |

### Muse change map (current architecture)

Hypothetical future edits only — **not** authorized by this issue’s file map.

#### Required for install + launch

| Future edit | Baseline anchor | Rationale | Test home |
| --- | --- | --- | --- |
| `launcher_command` `muse)` case | `scripts/lib/launcher.sh:46-99` | Argv, approval/sandbox, workspace grant experiment | `test/wrapper.test.ts` / install launcher tests |
| `launcher_environment` if PATH needed | `scripts/lib/launcher.sh:19-32` | Wrapper often under `~/.local/bin` | same |
| `agentExecutables` + **skip/no-op update** | `src/cli.ts:135-183` | Must not run `muse update` as a prompt | `test/cli.test.ts` |
| `agentHarnessProcess` | `src/setupWorkspace.ts:30-38` | After measuring pane process | `test/tmux.test.ts` |
| `validateAgentIds` / install path | `src/install.ts:197+` | Already probes launcher_command | `test/install.test.ts`, `test/onboard.test.ts` |
| Examples / labels (optional) | `config.example.json`, `KNOWN_AGENT_LABELS` | Operator discoverability | onboard tests |

#### Required for reliable automated participation

| Future edit | Baseline anchor | Rationale | Test home |
| --- | --- | --- | --- |
| Extend `LifecycleVendor` + `vendorForAgent` | `src/agentEvent.ts:17`, `src/agentHookSync.ts:13-14` | Closed enums today | `test/agentEvent.test.ts` |
| Hook path `.muse/hooks.json` + event table + `plannedDocument` | `src/agentHookSync.ts:16-29`, `:106-117`, `:119-196` | Documented project hooks; verify 1.3.0 shapes on 1.4.9 | `test/agentHookSync.test.ts` |
| `normalizeAgentEvent` + `shellGuardResponse` / `normalizeShellRequest` | `src/agentEvent.ts:61+`, `src/shellGuard.ts:30-51` | Map Muse payloads; do not assume Claude identity from similar names | `test/agentEvent.test.ts`, `test/shellGuard.test.ts` |
| Trust: prefer `--trust-workspace` and/or settings; may skip persistent writer | `src/agentTrust.ts:54-128` | Documented run-flag trust | `test/install.test.ts` / new cases |
| Ignore `.muse/` | `src/productIgnore.ts:41-46`, gitignore block | Project hook dir | install ignore tests |
| Nudge defaults + readiness | `src/setupWorkspace.ts:52-66`, `src/tmux.ts:217+` | After TUI observation | `test/tmux.test.ts` |
| Doctor unsupported-vendor copy | `src/doctor.ts:357-366` | Roster messaging | `test/doctor.test.ts` |
| Run-loop delivery / holds | `src/runLoop.ts` vendor branches | Correlate hooks; fallback `delivery: "pull"` if hooks unverified | `test/runLoop.test.ts` |

#### Optional analytics / quota

| Future work | Notes |
| --- | --- |
| Transcript reader | Possible via `muse export` / session.jsonl — store path **open** |
| Usage vendor union | Only after durable local metrics exist |
| Quota automation | No Muse equivalent identified; leave uncovered honestly |

#### Possible new files (future issue only)

| Path | Justification |
| --- | --- |
| `scripts/setup_muse.sh` | Legacy setup symmetry with other vendors — **new file; no baseline lines** |
| `src/vendors.ts` (name TBD) | Identity/capability table if that follow-up is chosen — **new file; no baseline lines** |

### Conditional impacts still open

1. Confirm whether `--workspace` grants writes to the completion mailbox comparable to `--add-dir`.
2. Confirm live hook payload fields on Muse 1.4.9 match the 1.3.0 documented shapes.
3. Measure foreground process name and idle-prompt chrome before enabling nudge delivery.
4. Decide persisted trust vs per-run `--trust-workspace` only.
5. Confirm instruction-file discovery (`AGENTS.md` vs Muse-specific rules).

Until (2)–(3) pass, Muse can be launched with **`delivery: "pull"`** and rely on
`.coord/bin/git` for clone-local Git refusal, at the cost of weaker hook-based
readiness and shell-guard JSON.

## Architecture decision (detail)

### Option A — continue as today

**Pros:** Zero migration; Gemini already shows partial (launcher-only) support is
possible. **Cons:** Each new full harness edits the same ~12 identity lists by
hand; Muse’s missing `update` and `--add-dir` show those lists encode false
universals.

**Status-quo checklist** to add a full harness without a table: edit every “yes”
row in the inventory (launcher, executables/update policy, lifecycle enum + hook
sync + event normalize + shell guard, trust, harness process, owner UI defaults,
tmux readiness, doctor, ignores), plus optional analytics modules, examples, and
`setup_*.sh`.

### Option B — small identity/capability table (recommended at Muse implementation)

Keep:

- `launcher_command` / `launcher_environment` as the **only** argv authority
  (no parallel TypeScript flag table).
- Per-vendor behaviour in `agentHookSync`, `agentEvent`, `shellGuard`, `tmux`,
  transcript/quota modules.

Add one TypeScript module (future) holding for each `Vendor`:

- executable name
- update argv **or explicit `none`**
- harness process + aliases
- label, default Terminal profile, default nudge keys
- lifecycle hook settings relative path key
- clone-ignore directory names
- optional capability flags (`hooks`, `transcripts`, `quota`, …)

Convert duplicated switches to `Record<Vendor, …>` or exhaustive `switch` so
`tsc` lists missing sites when `"muse"` is added to the union.

**Estimated touch list for introducing the table** (existing files only; lines at
baseline): `src/agentEvent.ts:17`, `src/agentHookSync.ts:13-29`,
`src/agentTrust.ts:54`, `src/cli.ts:135-137` (+ update loop `:165-172`),
`src/setupWorkspace.ts:30-66` and `:108-114`, `src/install.ts:873`,
`src/doctor.ts:357-366`, `src/productIgnore.ts:41-46`,
`scripts/setup_common.sh:15-16` (or leave shell lists manual), plus enum-locking
tests listed above. Shell launcher stays hand-written.

**Optional `vendor` field on agent config** (default `id`): only if two roster
entries must share one CLI with different models/profiles. Requires
backwards-compatible defaulting in `agentConfigSchema`, frozen start-state
copying, and tests — defer unless that product need appears.

### Option C — broad plugin / MSP rewrite

Rejected for this product stage: one vendor’s SDK (`muse serve` / MSP) does not
define a shared contract with Claude/Codex/Cursor/Antigravity, and would replace
working tmux delivery without reducing per-vendor parsing.

### Chosen course

Document now; when implementing Muse, do **Option B** (identity table) in the
same or immediately preceding issue as the Muse launcher case, and keep Option A
behaviour modules. Do **not** implement Option B in this documentation issue.

## Follow-up acceptance criteria

For a future Muse (or next CLI) integration issue:

1. **Install / doctor / uninstall** — hooks and trust idempotent; doctor names
   unsupported capabilities honestly; uninstall preserves owner settings outside
   managed markers (`test/install.test.ts`, `test/doctor.test.ts`,
   `test/agentHookSync.test.ts`).
2. **Launch / grants** — pane starts; mailbox grant strategy verified
   (`test/wrapper.test.ts` / tmux preflight).
3. **Event correlation** — SessionStart / submit / stop (or documented
   equivalents) normalize and bind actions (`test/agentEvent.test.ts`,
   `test/agentLifecycle.test.ts`).
4. **Shell refusal** — PreToolUse (or equivalent) deny path exercised in tests
   with Muse envelope (`test/shellGuard.test.ts`); installation ≠ enforcement.
5. **Prompt delivery** — nudge or pull path delivers without trust-dialog
   capture (`test/tmux.test.ts`, `test/runLoop.test.ts`).
6. **Completion / ready** — mailbox SHA + ready handshake unchanged.
7. **Restart / recovery** — dead pane respawn preserves holds
   (`test/runLoop.test.ts`).
8. **Telemetry** — if unimplemented, analytics must report unavailable coverage
   rather than inventing numbers (`test/analytics.test.ts`).

## Validation performed for this document

- Spot-checked inventory anchors against the working tree descended from
  baseline `cb7ed092…` (including `agentIdSchema` at `src/protocol.ts:9`).
- Re-ran vendor-token searches mentally against the explore pass; excluded
  categories listed above.
- Observed Muse 1.4.9 help/version; recorded hooks-page 1.3.0 provenance
  mismatch.
- README link target `docs/issue-210-agent-cli-analysis.md` added in the same
  change set.
- `pnpm check:docs` run on the draft (shipped-examples / agent-facing language);
  that script does **not** prove citation completeness.
- No product behaviour tests added; hooks will classify this new docs path
  (outside the frozen issue documentation allowlist) per repository policy.
